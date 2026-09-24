const crypto = require('crypto');
const db = require('../db');
const { looksLikeWriteOutcomeClaim, looksLikeUnfulfilledWriteIntent } = require('../tools/loop-helpers');

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_RESULT_CHARS = 12000;
const DEFAULT_MAX_DURATION_MS = 180000;

function createBudget(options = {}) {
  return { steps: options.steps || 0, startedAt: options.now ?? Date.now(),
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    maxResultChars: options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS };
}

function stopReason(budget, options = {}) {
  if (options.aborted) return 'cancelled';
  if ((options.now ?? Date.now()) - budget.startedAt >= budget.maxDurationMs) return 'time_budget';
  if ((options.resultChars || 0) >= budget.maxResultChars) return 'result_budget';
  if (options.checkSteps !== false && budget.steps >= budget.maxSteps) return 'step_budget';
  return null;
}

function pausedState(reason, budget) {
  return { status: reason === 'cancelled' ? 'cancelled' : 'paused', reason, steps: budget.steps };
}

function stateText(state) {
  if (state.status === 'failed') return '本轮请求失败，不能据此认定任务已完成。';
  if (state.status === 'cancelled') return '本轮已取消，未继续执行后续操作。';
  if (state.status === 'awaiting_confirmation') return '已提交操作「' + state.tool + '」，等待作者确认，尚未生效。确认后将使用真实执行结果继续，不会猜测新实体ID。';
  if (state.reason === 'action_rejected') return '作者已拒绝操作，本次未执行新的写操作，也未重新提交确认。已暂停自动续跑；如需修改，请重新发起请求。';
  if (state.reason === 'unverified_write') return '系统核验：本轮未验证正文写入成功，模型的完成声明不能作为保存依据。请检查章节或继续请求实际写入。';
  // S5-02 / R01：明确重读未核验——本轮没有真实读取凭据，历史消息与模型自述都不算已读
  if (state.reason === 'read_not_verified') {
    const detail = {
      read_failed: '本轮对目标章节的读取尝试失败',
      read_target_missing: '目标章节已不存在，本轮无法读取',
      read_scope_ambiguous: '本轮未能定位到可读取的目标章节（范围不明确）',
      read_stale: '读取到的内容已不是当前版本（读取之后正文又被改动）',
    }[state.readCode] || '本轮没有检测到对目标章节的实际读取';
    return '系统核验：' + detail + '。系统不以历史消息或模型自述作为重读凭据，本轮任务未确认完成，请重新发起或先实际读取后再继续。';
  }
  return '本轮已暂停（' + ({ step_budget: '达到步骤上限', result_budget: '达到工具结果预算', time_budget: '达到运行时间上限', output_truncated: '工具参数输出被截断' }[state.reason] || state.reason) + '）。任务尚未确认完成，请检查已取得的结果后继续。';
}

function waitingState(name, confirmationId, budget) {
  return { status: 'awaiting_confirmation', tool: name, confirmationId, steps: budget.steps };
}

// S5-02 / R01：明确重读的核验（写作页与独立 Agent 两个传输入口共用同一判定）。
// 输入：requiredReads＝服务器依据作者明确请求/写作目标生成的要求（不接受模型自报），
//       readReceipts＝共享工具执行器在**本轮真实读取成后**写入的凭据，
//       readAttempts＝本轮失败的读取尝试（用于区分「读取失败」与「根本没读」）。
// 判定：需要「凭据的 chapterId 命中要求」且「凭据记录的 revision/contentHash 仍是当前版本」；
// 读取之后正文又被改动（revision/内容哈希不符）按未读处理，不能拿旧内容充当本轮见证。
function hashText(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function verifyReads({ requiredReads, readReceipts, readAttempts } = {}) {
  const required = (Array.isArray(requiredReads) ? requiredReads : []).filter(Boolean);
  const receipts = Array.isArray(readReceipts) ? readReceipts : [];
  const attempts = Array.isArray(readAttempts) ? readAttempts : [];
  if (!required.length) return { ok: true, code: null, unmet: [], required: [], receipts: [] };
  const unmet = [];
  for (const item of required) {
    const bookId = Number(item.bookId);
    const chapterId = Number(item.chapterId);
    if (!Number.isInteger(bookId) || bookId <= 0 || !Number.isInteger(chapterId) || chapterId <= 0) {
      unmet.push({ ...item, code: 'read_scope_ambiguous' });
      continue;
    }
    const row = db.get('SELECT revision, content FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
    if (!row) { unmet.push({ ...item, code: 'read_target_missing' }); continue; }
    const contentHash = hashText(row.content);
    const hit = receipts.some(receipt => Number(receipt.chapterId) === chapterId && Number(receipt.bookId) === bookId
      && Number(receipt.revision) === Number(row.revision) && receipt.contentHash === contentHash);
    if (hit) continue;
    const stale = receipts.some(receipt => Number(receipt.chapterId) === chapterId && Number(receipt.bookId) === bookId);
    const failed = attempts.some(attempt => Number(attempt.chapterId) === chapterId && Number(attempt.bookId) === bookId);
    unmet.push({ ...item, code: stale ? 'read_stale' : failed ? 'read_failed' : 'read_not_verified' });
  }
  return { ok: unmet.length === 0, code: unmet.length ? unmet[0].code : null, unmet, required, receipts };
}

// 明确重读未满足时的一次有预算纠正文案（两个入口共用；只说「去实际读取」，不伪造读取结果）
function freshReadNudge(requiredReads) {
  const ids = (Array.isArray(requiredReads) ? requiredReads : [])
    .filter(item => Number(item.chapterId) > 0).map(item => 'chapterId=' + Number(item.chapterId));
  return '（系统核验）本轮没有检测到对目标章节的实际读取'
    + (ids.length ? '（' + ids.join('、') + '）' : '')
    + '。请现在调用 read_chapter 真实读取该章正文，再基于读取到的内容回答；不要凭历史消息或记忆作答，也不要声称已经读过。';
}

// S2-04 / C09：终态统一裁决（写作页与 Agent 两个适配器调同一函数，不各写 switch）。
// 输入是「收尾时刻的事实」：上游 finish_reason、已发出文本、控制状态（gate/runState）、
// 是否有待确认动作、写是否已核实、错误。输出 { status, reason } 只做分类——
// 不补写、不重试：截断的半句是部分结果（paused/output_truncated），空输出不谎称完成，
// 上游错误不回到 finished。优先序（按实现顺序）：错误（watchdog/上游）> 作者取消 >
// 控制态定格（待确认/暂停/失败）> 有待确认动作 > 事实复核（截断/空输出/写已核实）。
// 注：watchdog 路径下 error 与 gate.state=failed 同时满足，两者结论一致（failed），
// 当前无实际分叉；G2 审查 P3-3 曾指出原注释与控制态优先的描述不符实现，已更正。
function normalizeFinish({ finishReason, emittedText, state, hasPendingAction, verifiedWrite, error, readRequirement } = {}) {
  if (error) {
    // 硬超时（watchdog）与上游故障分开：系统杀运行不冒充上游 5xx，也不落不可解释的
    // abort 消息（G2 审查 P2-2：run 行 reason 必须能区分 watchdog_timeout）
    if (error.code === 'WATCHDOG_TIMEOUT' || error.__watchdog === true) {
      return { status: 'failed', reason: 'watchdog_timeout' };
    }
    const aborted = error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 20;
    return aborted ? { status: 'cancelled', reason: 'user_abort' } : { status: 'failed', reason: 'upstream_error' };
  }
  if (state && state.status === 'cancelled') return { status: 'cancelled', reason: state.reason || 'user_abort' };
  if (state && state.status === 'awaiting_confirmation') return { status: 'awaiting_confirmation', reason: state.reason || null };
  if (state && state.status === 'paused') return { status: 'paused', reason: state.reason || 'budget' };
  if (state && state.status === 'failed') return { status: 'failed', reason: state.reason || 'upstream_error' };
  if (hasPendingAction) return { status: 'awaiting_confirmation', reason: null };
  // S5-02 / R01：明确重读要求未核验通过 —— 绝不判 finished（控制态定格与待确认仍按原优先序）
  if (readRequirement) return { status: 'paused', reason: 'read_not_verified' };
  const text = String(emittedText || '').trim();
  // 写已核实（正文确已落库）：实质完成，正文为空也按 finished（工具产出的结果即交付物）
  if (verifiedWrite && finishReason !== 'length' && finishReason !== 'premature') {
    return text ? { status: 'finished', reason: null } : { status: 'finished', reason: 'verified_write_only' };
  }
  if (finishReason === 'length' || finishReason === 'premature') {
    return text ? { status: 'paused', reason: 'output_truncated' } : { status: 'paused', reason: 'empty_output' };
  }
  if (!text) return { status: 'paused', reason: 'empty_output' };
  return { status: 'finished', reason: null };
}

function claimsPendingConfirmation(content) {
  const text = String(content || '')
    .replace(/(?:无需|不需要|不必|不再|不用)(?:再)?(?:等待|等候|等|请求|进行)?[^。！？\n]{0,12}确认/g, '')
    .replace(/(?:没有|尚未|未曾|并未)(?:发起|提交|生成)[^。！？\n]{0,20}确认/g, '');
  return /(?:等待|等候|待您|待你|待作者)[^。！？\n]{0,16}确认|(?:(?<!申)请(?:您|你|作者)?|需要您|需要你)[^。！？\n]{0,12}确认|(?:处于|仍是|状态为)待确认|确认(?:后|之后)(?:将|会|即可|才能)|(?:本轮|重新|再次|系统已自动)[^。！？\n]{0,12}(?:发起|提交|生成)[^。！？\n]{0,20}确认|(?:awaiting|waiting for|pending)\s+(?:your\s+)?(?:confirmation|approval)/i.test(text);
}

function settledConfirmationText(action) {
  const outcome = {
    rejected: '作者已拒绝该操作，本次未执行。',
    failed: '该操作执行失败，不能视为已完成；原确认请求已结算。',
    approved: '该操作已获批准并执行，原确认请求已结算。',
    expired: '该确认请求已过期，不能继续使用。',
  }[action.status];
  return '系统核验：确认请求 ' + action.id + '（' + action.name + '）：' + outcome + ' 本轮没有新提交的待确认操作。';
}

function finalizeText(content, state, options = {}) {
  let current = state || { status: 'finished' };
  if (['awaiting_confirmation', 'paused', 'failed', 'cancelled'].includes(current.status)) return { content: stateText(current), state: current };
  const action = options.settledAction;
  const unverifiedWrite = !options.verifiedWrite && (looksLikeWriteOutcomeClaim(content) || looksLikeUnfulfilledWriteIntent(content));
  if (action && ['rejected', 'failed', 'approved', 'expired'].includes(action.status)
    && (claimsPendingConfirmation(content) || (action.status === 'rejected' && unverifiedWrite))) {
    current = { ...current, reason: 'settled_confirmation_corrected', settledConfirmation: { id: action.id, status: action.status } };
    return { content: settledConfirmationText(action), state: current };
  }
  if (unverifiedWrite) {
    current = { ...current, status: 'paused', reason: 'unverified_write' };
    return { content: stateText(current), state: current };
  }
  return { content, state: current };
}

function createToolGate(budget, options = {}) {
  let queue = Promise.resolve();
  const gate = { state: null, resultChars: 0, budget,
    execute(name, task, signal) {
      const operation = queue.then(async () => {
        const reason = stopReason(budget, { aborted: signal?.aborted || options.signal?.aborted, resultChars: gate.resultChars, checkSteps: false });
        if (reason && !gate.state) gate.state = pausedState(reason, budget);
        if (gate.state) return { ok: false, error: { code: 'RUN_PAUSED', message: stateText(gate.state) } };
        const result = await task();
        gate.resultChars += JSON.stringify(result).length;
        if (result?.error?.code === 'ACTION_REJECTED') gate.state = pausedState('action_rejected', budget);
        if (result?.data?.status === 'confirmation_required') gate.state = waitingState(name, result.data.confirmation.id, budget);
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    stop({ steps }) {
      budget.steps = steps.length;
      const reason = stopReason(budget, { aborted: options.signal?.aborted, resultChars: gate.resultChars });
      if (reason && !gate.state) gate.state = pausedState(reason, budget);
      return !!gate.state;
    },
  };
  return gate;
}

module.exports = { DEFAULT_MAX_STEPS, DEFAULT_MAX_RESULT_CHARS, DEFAULT_MAX_DURATION_MS, createBudget, stopReason, pausedState, stateText, waitingState, normalizeFinish, finalizeText, createToolGate, verifyReads, freshReadNudge };
