// Agent 运行器：streamText 多步工具循环 + UI Message Stream（SSE）写入 Express 响应。
const { loadSDK } = require('./sdk');
const { getModel, PROVIDER_NAME } = require('./model');
const { buildTools } = require('./tools');
const { toolErrorText } = require('../tools/adapters/ai-sdk');
const runPolicy = require('../chat/run-policy');

// 台账修复守则（评审 §8）：提示词只负责「决策顺序」，权限、版本校验与正典顺序均由代码强制
// （投影不变量 P0、乐观锁 P2、确认闭环 P1、受限建字段 P7、审计 P6）。此处仅引导模型按正确顺序取证与修复。
const LEDGER_REPAIR_POLICY = `【台账修复守则】
1. 先审计和读取当前状态，再用 search_evidence/read_chapter 核对定稿正文；没有证据不得修改。
2. 修复必须给出 chapter_id 与逐字 source_quote。PROPOSAL_STALE 一律驳回并按当前正文重建，不得强行采纳。
3. 遇到 STALE_OLD_VALUE，不得直接把 old_value 改成 actual。先读取 actual_event_id：
   若候选事实在叙事顺序上更早，驳回；只有候选更晚且正文明确支持时才能更新提案。
4. 同一人物、field_key 存在多个互斥 pending 提案时，先比较叙事顺序和证据，只保留或合并一个；
   每次成功采纳后重新读取当前状态，再处理下一项。
5. STATE_FIELD_NOT_FOUND 通常表示字段名错误。优先映射现有字段；只有作者明确要求新增分类时才请求建字段。
6. 写工具返回 confirmation_required 后立即停止，等待作者确认。未收到确认后的成功结果，不得声称已经修复。
7. 汇报时列出：已检查范围、证据章节、已更新/采纳/驳回的提案 ID、未解决问题和失败错误码。`;

const AGENT_SYSTEM = `你是「墨砚 AI 小说工坊」的智能助手，一位专业的网络小说创作搭档。
你可以通过工具读写用户的书架数据，并调用工坊的 AI 能力（章节总结、状态簿、偏离检测、剧情参谋、文字润色）。

行为准则：
1. 用户提到某本书/某章时，先用 list_books / list_chapters 等工具定位 id，再操作，不要凭空猜测 id。
2. 需要多步完成的任务（如"续写第三章并生成总结"）按顺序调用工具：先读上下文（总纲/状态簿/前文），再写，最后总结。
3. 写正文前务必先了解：全书总纲、卷大纲、状态簿、前几章总结，保持剧情连贯。
4. 续写正文用 append_chapter 写入；写完主动调用 summarize_chapter 生成总结。
5. 回忆故事细节优先用 search_evidence；它会区分正典资料、定稿正文和草稿命中。用户明确说“定稿”才调用 lock_chapter。
6. 人物必须按稳定 character_id 维护；人物动态状态和关系通过故事事件提案表达，不能写入旧状态大文本。
7. 所有写入和归档工具都由系统返回真实确认卡；收到 confirmation_required 后停止本轮写入，等待作者确认。你可以用 review_event_proposal 发起采纳/驳回请求，但必须由作者在确认卡核对提案完整差异后放行才算生效——你不能自行批准提案，也没有永久删除、重建投影或迁移工具。
8. 写操作前系统自动备份章节版本，改坏了可用 list_chapter_versions + restore_chapter 回滚。
9. 修改数据前如果用户意图不明确，先说明你的计划再执行；做不到的操作直接说明，不要硬答。
10. 回答用中文，简洁；调工具时不需要向用户解释技术细节，报告结果即可。

${LEDGER_REPAIR_POLICY}`;

// A-5 / G4 遗留·事项B：被拒工具调用后的单轮纠正话。
// 缺口不在工具执行层——executeForModel 早已把异常收敛成结构化错误**返回**（不抛，
// server/tools/executor.js 的 executeForModel），而是它在之前：讨论模式的工具面里没有写工具
// （agent-discuss 全只读），模型一调写工具，SDK 在 parseToolCall 阶段就抛 NoSuchToolError，
// execute 一次都没被调用 → 模型只拿到 SDK 的英文原文 ＋ 全工具清单，没有「未执行任何写入／
// 请勿重试」的语义，实测会重试同一工具直到步数耗尽（g4-leftover-eval.md §3.2 探针实测）。
// prepareStep（ai@6.0.253 正式选项名）是唯一能在「被拒之后、下一步之前」补一句纠正话的落点。
const TOOL_FACE_NUDGE = '【系统纠正】上一轮你调用的工具没有执行，也没有任何写入发生：该工具不在本轮工具面内'
  + '（只读讨论模式只提供只读工具）。请勿重复调用同一个工具；需要写操作请让作者切到「执行操作」后再发起。';
const UNKNOWN_TOOL_NUDGE = '【系统纠正】上一轮你调用的工具没有执行，也没有任何写入发生：本轮工具面里没有这个工具名。'
  + '请勿重复调用同一个工具名；请改用工具体系里真实存在的工具，或者直接向作者说明做不到。';
const INVALID_CALL_NUDGE = '【系统纠正】上一轮你调用的工具没有执行，也没有任何写入发生：这次调用的参数无法通过校验。'
  + '请勿原样重复同一个调用；请按该工具的 schema 修正参数后再试，或者直接向作者说明做不到。';

// 只看上一步（steps[last]）的 toolCalls：命中 invalid 调用才给纠正话，上一步干净就什么都不返回
// ——不会每步重复注入，也不改 toolChoice/messages/activeTools。不触碰预算与确认语义：待确认时
// gate.stop() 直接停轮、prepareStep 根本不会被调用（RUN_PAUSED 是返回不是抛出）。
// 参数 `readOnly` 与工具面选择同一个判定（server/agent/tools.js 按 context.mode 选 agent-discuss）。
function toolRefusalNudge(steps, options = {}) {
  const last = Array.isArray(steps) && steps.length ? steps[steps.length - 1] : null;
  const calls = last && Array.isArray(last.toolCalls) ? last.toolCalls : [];
  const rejected = calls.filter(call => call && call.invalid === true);
  if (!rejected.length) return null;
  if (rejected.some(call => call.error && call.error.name === 'AI_NoSuchToolError')) {
    return options.readOnly ? TOOL_FACE_NUDGE : UNKNOWN_TOOL_NUDGE;
  }
  return INVALID_CALL_NUDGE;
}

// S5-02 / R01：明确重读的 Agent 侧接入。SDK 流在收尾后无法再插入纠正轮，所以按任务书允许的
// 第一种入口处理：由服务端用**共享工具执行器**先做一次真实只读预备步骤（等价于 read_chapter），
// 把真实读取结果作为系统证据注入本轮上下文——不塞伪造 tool_result，凭据照常由执行器写入
// readReceipts；模型自己再读也会照常记凭据。判定与写作页共用 run-policy.verifyReads。
async function performRequiredReads({ bookId, requiredReads, readReceipts, readAttempts, toolContext }) {
  const evidence = [];
  for (const item of requiredReads) {
    const chapterId = Number(item && item.chapterId);
    if (!Number.isInteger(chapterId) || chapterId <= 0) continue;
    try {
      const out = await require('../tools/executor').executeForModel(
        { ...toolContext, bookId: Number(item.bookId) || bookId, readReceipts, readAttempts },
        'read_chapter', { chapterId, maxChars: 4000 },
        { toolCallId: 'server-read-' + chapterId }
      );
      if (!out || out.ok !== true || !out.data) continue;
      const page = out.data;
      const receipt = readReceipts.filter(entry => entry.chapterId === chapterId).pop();
      evidence.push({
        role: 'system',
        content: '【本轮实际读取·系统核验】第' + (page.title || chapterId) + '章 chapterId=' + chapterId
          + '（读取时 revision=' + (receipt ? receipt.revision : '?') + '，observedAt=' + (receipt ? receipt.observedAt : '?') + '）\n'
          + String(page.content || '').slice(0, 6000)
          + '\n（以上为服务端读取到的当前正文，可作为本轮依据；不足部分请自行调用 read_chapter_range 续读。）',
      });
    } catch (_) { /* 读取失败留空：收尾核验给出 read_not_verified/read_failed，不谎称已读 */ }
  }
  return evidence;
}

// messages: [{ role: 'user'|'assistant', content: string }]（服务端会话组装，S3-02 起
// /api/agent 只发 conversation_id/content——客户端 messages 数组不再作为历史权威）
async function runAgent(messages, res, context = {}) {
  const { streamText } = await loadSDK();
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  const gate = runPolicy.createToolGate(runPolicy.createBudget(), { signal: controller.signal });
  const { model, modelName } = await getModel();
  // S3-02：服务端工具事件收集（onToolResult 观察钩子）——落会话的可信证据来源
  const toolEvents = [];
  // S5-02 / R01：本运行真实读取凭据/失败尝试（共享执行器唯一写入点）+ 服务端生成的重读要求
  const readReceipts = [];
  const readAttempts = [];
  let requiredReads = [];
  try {
    // 本轮输入＝最后一条消息（/chat 是用户消息；确认续跑是系统事件——两者都不会被误判成重读要求）
    const lastMessage = messages[messages.length - 1];
    const userText = lastMessage && typeof lastMessage.content === 'string' ? lastMessage.content : '';
    const target = context.bookId
      ? require('../context/writing-target').resolveWritingTarget(Number(context.bookId), context.chapterId ?? null, userText)
      : null;
    requiredReads = target
      ? require('../context/writing-target').requiredReadsFor(Number(context.bookId), userText, target)
      : [];
    if (requiredReads.length && !controller.signal.aborted) {
      const evidence = await performRequiredReads({
        bookId: Number(context.bookId), requiredReads, readReceipts, readAttempts,
        toolContext: {
          profile: 'agent', sessionId: context.sessionId, model: modelName, source: 'agent',
          actor: context.actor || 'author', runId: context.runId || null, signal: controller.signal,
        },
      });
      // 证据插在最后一条用户消息之前（不改变会话顺序语义，也不冒充模型自己的工具调用）
      if (evidence.length) messages = [...messages.slice(0, -1), ...evidence, messages[messages.length - 1]];
    }
  } catch (_) { /* 要求生成/预备读取失败不阻断运行：收尾核验会给出未核验状态 */ }
  const tools = await buildTools({
    ...context,
    model: modelName,
    runGate: gate,
    readReceipts,
    readAttempts,
    onToolResult: (name, args, out) => toolEvents.push({ name, args, out }),
  });

  let emittedText = '';
  // S2-05 / C11：模型选项走单一权威构造器（与写作网关同一函数）——
  // operation='agent' 的输出预算与思考开关字段都由 buildModelOptions 决定，不再裸写 8000。
  const modelOptions = require('../runtime/model-options').buildModelOptions({
    model: modelName, settings: {}, operation: 'agent', signal: controller.signal,
  });
  // S2-04：独立 watchdog 硬超时——SDK 的 stopWhen 只在工具边界检查，模型在第一步前
  // 挂起（无事件）时永远等不到边界。到期主动 abort 并定格 failed/interrupted，
  // 绝不回到 finished（底层传输若忽略 abort，后续工具由 gate 的 stopReason 拦下）。
  const watchdogMs = context.watchdogMs || runPolicy.DEFAULT_MAX_DURATION_MS;
  let watchdogFired = false;
  let watchdogTimer = null;
  // 终态裁决结果（normalizeFinish 唯一权威）：watchdog 触发即刻定格，finish/error 时刷新，
  // 供路由层落 agent_runs 行（S2-04：run 行终态与 SSE 裁决必须一致，G2 审查 P2-2）
  let runOutcome = null;
  const reportOutcome = (norm) => { if (norm) { runOutcome = norm; if (context.onOutcome) { try { context.onOutcome(norm); } catch (_) { /* 不阻断 */ } } } };
  watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    // 带 code 的 abort reason：SDK/路由层据此区分「系统硬超时」与「作者取消/上游故障」，
    // 不再落到不可解释的 abort 消息（run 行 reason 也来自同一常量）
    const err = new Error('watchdog_timeout');
    err.code = 'WATCHDOG_TIMEOUT';
    err.__watchdog = true;
    reportOutcome({ status: 'failed', reason: 'watchdog_timeout' });
    try { controller.abort(err); } catch (_) { /* 已结束 */ }
  }, watchdogMs);
  const clearWatchdog = () => { if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; } };

  let finishReason = '';
  const result = streamText({
    model,
    system: AGENT_SYSTEM,
    messages,
    tools,
    stopWhen: options => gate.stop(options),
    // A-5：上一步真被拒时，下一步带一句纠正话（命中 InvalidToolInputError 同族也给）。
    // system 在该步是**覆盖**语义，所以必须带上基础系统提示，不能只发纠正话。
    prepareStep: ({ steps }) => {
      const nudge = toolRefusalNudge(steps, { readOnly: context.mode === 'discuss' });
      return nudge ? { system: AGENT_SYSTEM + '\n\n' + nudge } : undefined;
    },
    abortSignal: controller.signal,
    // ai SDK v6 的输出上限参数名为 maxOutputTokens（v4 旧名 maxTokens 已移除，
    // 传旧名会被静默忽略——此前 8000 上限从未生效，长任务输出受渠道默认值摆布）
    maxOutputTokens: modelOptions.maxOutputTokens,
    temperature: 0.7,
    // 思考开关等渠道字段走 providerOptions 命名空间——键名必须是 SDK 实际读取的
    // providerOptionsName（本仓 'novel-agent'，由 model.js 导出同源派生）：SDK 只
    // 合并 providerOptions[name] / providerOptions[toCamelCase(name)]，写成
    // openaiCompatible 等名字会被静默丢弃、字段从未出网（G2 审查 P1 已实证+红测）。
    // 未配置时为空对象、整键省略，与历史行为逐位一致（不额外注入任何字段）。
    providerOptions: Object.keys(modelOptions.requestOverrides).length
      ? { [PROVIDER_NAME]: { ...modelOptions.requestOverrides } }
      : undefined,
    onChunk: ({ chunk }) => { if (chunk.type === 'text-delta') emittedText += chunk.text; },
    onFinish: ({ finishReason: reason }) => { finishReason = reason || ''; },
    onError: ({ error }) => {
      // 控制态定格 + 可解释 reason：watchdog 杀运行不冒充上游 5xx
      gate.state = { status: 'failed', reason: watchdogFired ? 'watchdog_timeout' : 'upstream_error', steps: gate.budget.steps };
      reportOutcome(runPolicy.normalizeFinish({ error: watchdogFired ? { code: 'WATCHDOG_TIMEOUT' } : error, state: gate.state }));
      console.error('[agent] 流式错误:', error && error.message);
    },
  });

  res.setHeader('X-Agent-Model', encodeURIComponent(modelName));
  try {
    await result.pipeUIMessageStreamToResponse(res, {
      // S4-05 / G3 已知边界 4：SDK 默认 onError 把一切错误压成「An error occurred.」，
      // 结构化码（TOOL_NOT_ALLOWED / INVALID_ARGS…）既到不了页面也看不清原因。这里交给工具
      // 适配器的同一份文案（`[CODE] 说明`），前端 chat-event-hub 再按约定拆回 code/message。
      onError: (error) => toolErrorText(error),
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined;
        // S5-02 / R01：收尾核验明确重读要求——没有本轮真实读取凭据就不判 finished，
        // 也不把「凭历史/自述作答」的内容当成交付物（内容换成系统说明）。
        let readUnmet = null;
        if (requiredReads.length) {
          const verdict = runPolicy.verifyReads({ requiredReads, readReceipts, readAttempts });
          if (verdict.ok) {
            gate.state = { ...(gate.state || { status: 'finished', steps: gate.budget.steps }), requiredReads: verdict.required, readReceipts: readReceipts.slice() };
          } else if (!gate.state || gate.state.status === 'finished') {
            readUnmet = verdict;
            gate.state = { ...runPolicy.pausedState('read_not_verified', gate.budget),
              readCode: verdict.code, requiredReads: verdict.required, readReceipts: readReceipts.slice() };
          }
        }
        const final = runPolicy.finalizeText(emittedText, gate.state || { status: 'finished', steps: gate.budget.steps }, {
          verifiedWrite: context.verifiedWrite,
          settledAction: context.settledAction,
          approvedWrites: require('../chat/write-history').approvedWrites(context.conversationId),
        });
        // S2-04：终态统一裁决——控制态定格（待确认/暂停/失败）保留，只复核将判 finished 的事实
        const norm = runPolicy.normalizeFinish({
          finishReason,
          emittedText: final.content,
          state: final.state,
          hasPendingAction: gate.state && gate.state.status === 'awaiting_confirmation',
          verifiedWrite: context.verifiedWrite,
          error: watchdogFired ? { code: 'WATCHDOG_TIMEOUT' } : null,
          readRequirement: readUnmet,
        });
        reportOutcome(norm);
        if (norm.status !== 'finished' && (!final.state || final.state.status === 'finished')) {
          final.state = { ...final.state, status: norm.status, reason: norm.reason };
        }
        return { run: final.state, finalContent: final.content };
      },
    });
  } finally {
    clearWatchdog();
    res.removeListener('close', onClose);
    // S3-02 / C10-B：本轮回复与服务端工具事件落会话（正典存储），刷新/下一轮可回读。
    // 断连/中止时的部分输出同样保留（对齐写作页口径）；持久化失败不阻断响应收尾。
    if (context.conversationId && (emittedText.trim() || toolEvents.length)) {
      try {
        persistConversationTurn(context.conversationId, context.runId, emittedText, toolEvents);
      } catch (e) {
        console.error('[agent] 会话消息持久化失败:', e.message);
      }
    }
  }
  // 终态交还路由层落 agent_runs 行（G2 审查 P2-2：此前一律写 finished，
  // watchdog/截断事实只活在 SSE 里，run 行与 SSE 裁决矛盾）
  return runOutcome;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

// 本轮 assistant 消息 + 工具事件落服务端会话：
//   tools_json 用与写作页相同的 toolFact 形状（前端工具卡渲染 + historyFacts 证据回读共用）；
//   toolFacts 存结构化摘要（name/status/受限摘录）。runId 经 appendMessage 归属校验。
function persistConversationTurn(conversationId, runId, emittedText, toolEvents) {
  const { toolFact } = require('../chat/tool-history');
  const svc = require('../conversations/service');
  const entries = toolEvents.map(ev => toolFact(ev.name, ev.args, ev.out));
  const facts = entries.map(e => ({
    name: e.name, status: e.status, confirmationId: e.confirmationId,
    excerpt: String(e.result || '').slice(0, 400),
  }));
  svc.appendMessage({
    conversationId,
    role: 'assistant',
    content: emittedText.trim() || '（本轮无文本输出）',
    source: 'agent',
    runId: runId || undefined,
    tools: entries,
    toolFacts: facts,
  });
}

// 确认执行结果 → 系统事件消息（可信、非用户消息）：把服务端真实执行/拒绝/失败结果注入对话，
// 让已结束的 Agent loop 据此续跑。评审 §2：确认发生在另一条 HTTP 请求，原 loop 已结束，
// 必须以系统事件重启，而不是伪装成用户消息。
function buildActionResumeMessages(history, action) {
  const argsText = safeJson(action.args);
  let content;
  if (action.status === 'rejected') {
    content = '[确认执行结果·系统事件] 作者拒绝了你请求的写操作「' + action.name + '」(confirmation_id=' + action.id + ')。'
      + '请求参数：' + argsText + '。请尊重该决定，不要重复请求同一操作；如仍需推进，先向作者说明理由并等待新指示。';
  } else if (action.status === 'failed') {
    content = '[确认执行结果·系统事件] 你请求的写操作「' + action.name + '」(confirmation_id=' + action.id + ') 已执行但失败。'
      + '请求参数：' + argsText + '。失败详情（可信，来自服务端真实执行，非模型推测）：' + safeJson(action.result || {}) + '。'
      + '请据错误码判断能否修正后重新请求；在未成功前，不得声称该操作已完成。';
  } else {
    content = '[确认执行结果·系统事件] 作者已确认，写操作「' + action.name + '」(confirmation_id=' + action.id + ') 已真实执行成功。'
      + '请求参数：' + argsText + '。执行结果（可信，来自服务端真实执行，非模型推测）：' + safeJson(action.result) + '。'
      + '请基于该真实结果继续任务，不要重复此写操作，也不要臆造未发生的动作。';
  }
  return [...(Array.isArray(history) ? history : []), { role: 'system', content }];
}

module.exports = { runAgent, buildActionResumeMessages };
