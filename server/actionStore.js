const crypto = require('crypto');
const db = require('./db');
const runSvc = require('./runtime/run-service');

// 确认凭证与结算结果落库（方向报告 3.1）：此前是进程内存 Map——服务重启后
// 作者正要点的确认卡失效（「动作不存在」）、结算结果与续跑状态丢失。
// 本模块接口与内存版完全一致（create/get/authorize/reject/settle/clear +
// canonicalJson/argsHash），调用方零改动；新增 setResumeMessage/markResumeDone
// 供续跑路径显式更新（此前是裸属性赋值，DB 版必须走语句）。
// 过期语义照搬内存版：pending 过期 → expired；settled 超过 TTL 清行（惰性 sweep）。

const DEFAULT_TTL = 30 * 60 * 1000;
// F5a（2026-09-11 真实库取证）：settled 行此前 30 分钟即被 sweep 删除，作者刷新后连「已结算」痕迹
// 都没有（已结算卡从界面消失，无法回放）。改为 30 天保留，sweep 只删超期行；配合 GET /chat/actions
// 的全状态列表，前端可重建已结算卡。
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// F4 拒绝冷却窗口：作者刚拒绝过的写操作，模型换参数立刻重发——10 分钟内同类近重复直接拒收。
const REJECTED_COOLDOWN_MS = 10 * 60 * 1000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function argsHash(name, bookId, sessionId, args) {
  return crypto.createHash('sha256')
    .update(`${name}|${Number(bookId)}|${sessionId}|${canonicalJson(args)}`)
    .digest('hex');
}

function rowToAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: Number(row.book_id),
    name: row.name,
    args: JSON.parse(row.args_json || '{}'),
    argsHash: row.args_hash,
    sessionId: row.session_id,
    // 绑定触发本次确认的工具调用 id 与目标 revision：供审计复现与 resume 精确回放（评审 P1b/§3）
    toolCallId: row.tool_call_id || '',
    targetRevision: row.target_revision == null ? null : Number(row.target_revision),
    // 发起方（评审 §6）：区分「谁请求」（agent）与「谁确认」（author）——确认执行发生在另一条请求，
    // source 会变成 agent-confirm，故在创建时固化原始发起方，执行阶段据此写 requested_by。
    requestedBy: row.requested_by || '',
    status: row.status,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    settledAt: row.settled_at == null ? undefined : Number(row.settled_at),
    usedAt: row.used_at == null ? undefined : Number(row.used_at),
    summary: row.summary || '',
    impact: JSON.parse(row.impact_json || '[]'),
    result: row.result_json == null ? undefined : JSON.parse(row.result_json),
    resumeDone: !!row.resume_done,
    resumeMessageId: row.resume_message_id == null ? undefined : Number(row.resume_message_id),
    // F3：过期卡是否已作为系统事件回灌给模型（同一批只通知一次）
    expiryNotified: !!row.expiry_notified,
    // F2：取代本卡的更新请求 id（status='superseded' 时非空，供前端重建卡片链）
    supersededBy: row.superseded_by || null,
    // S2-02 / C07：执行中断可解释、不可盲重放——run_id 关联发起运行（创建时快照）；
    // settlement_ref 是 durable 结算凭据（settle 落盘时写入）；recovery_reason 记录
    // 中断原因（启动/备份恢复写入 interrupted 时），UI 据此展示「可能已部分生效」。
    runId: row.run_id || null,
    settlementRef: row.settlement_ref || null,
    recoveryReason: row.recovery_reason || null,
  };
}

// F2 近重复判据（边界写进报告 M7-确认卡生命周期/3-怎么优化的.md）：
//   同 session 同名工具下，参数字段**不完全相同**（完全相同的走精确去重或重新发起通道），
//   且键集合一致、每个字段「相等，或双方都是字符串且一方包含另一方」。
//   · 仅字符串包含式，不做模糊相似度（编辑距离/相似度阈值一律不引入）；
//   · 「第6章」vs「第7章」互不包含 ⇒ 不算近重复（合法创建多章，两张卡都保留）；
//   · 参数字段含数组/对象 ⇒ 直接不判（不猜嵌套结构）；
//   · 非字符串标量（number/boolean/null）必须严格相等。
function isNearDuplicateArgs(a, b) {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  if (canonicalJson(left) === canonicalJson(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const lv = left[key];
    const rv = right[key];
    if ((lv && typeof lv === 'object') || (rv && typeof rv === 'object')) return false;
    if (typeof lv === 'string' && typeof rv === 'string') {
      if (lv === rv) continue;
      if (!lv.includes(rv) && !rv.includes(lv)) return false;
      continue;
    }
    if (lv !== rv) return false;
  }
  return true;
}

function sweep() {
  const now = Date.now();
  // R1 / G6 审计 P2-1：超时过期的 pending 卡不再算「未结算」——先记下它们归属的运行行，
  // 过期后把仍停在 awaiting_confirmation 的运行行按契约 3.1 终态化（否则该会话永久 409）。
  const expiringRunIds = db.all(
    "SELECT DISTINCT run_id FROM chat_actions WHERE status = 'pending' AND expires_at <= ? AND run_id IS NOT NULL",
    [now]
  ).map(row => row.run_id);
  db.run("UPDATE chat_actions SET status = 'expired', settled_at = ? WHERE status = 'pending' AND expires_at <= ?", [now, now]);
  for (const runId of expiringRunIds) runSvc.settleRunAfterConfirmation(runId, 'action_settled');
  // F5a：只删超过保留期（30 天）的行——settled_at 覆盖 approved/rejected/failed/expired/superseded
  db.run('DELETE FROM chat_actions WHERE settled_at IS NOT NULL AND ? - settled_at > ?', [now, SETTLED_RETENTION_MS]);
}

// F2：近重复判定已存在时，把既有 pending 同类卡标记为 superseded（被更新的同类请求取代），
// 而不是让作者面对两张几乎一样的卡；同一 session 同名工具范围内查找。
// R1：同时收集被取代卡归属的运行行——新卡落库后调用方据此终态化（见 create 末尾注释）。
function supersedeNearDuplicates(bookId, name, sessionId, args, newActionId) {
  const rows = db.all(
    "SELECT * FROM chat_actions WHERE book_id = ? AND name = ? AND session_id = ? AND status = 'pending' ORDER BY created_at ASC",
    [Number(bookId), String(name), String(sessionId)]
  );
  const superseded = [];
  const runIds = [];
  for (const row of rows) {
    let priorArgs = {};
    try { priorArgs = JSON.parse(row.args_json || '{}'); } catch { priorArgs = {}; }
    if (!isNearDuplicateArgs(priorArgs, args)) continue;
    db.run("UPDATE chat_actions SET status = 'superseded', settled_at = ?, superseded_by = ? WHERE id = ?", [
      Date.now(), String(newActionId), row.id,
    ]);
    superseded.push(row.id);
    if (row.run_id) runIds.push(row.run_id);
  }
  return { ids: superseded, runIds };
}

// F4：拒绝冷却守卫——同名工具 + 同 session + 冷却窗口内存在 rejected 且参数近重复 → 拒收本次请求
function findRejectedNearDuplicate(bookId, name, sessionId, args) {
  const since = Date.now() - REJECTED_COOLDOWN_MS;
  const rows = db.all(
    `SELECT * FROM chat_actions
      WHERE book_id = ? AND name = ? AND session_id = ? AND status = 'rejected'
        AND settled_at IS NOT NULL AND settled_at >= ?
      ORDER BY settled_at DESC LIMIT 20`,
    [Number(bookId), String(name), String(sessionId), since]
  );
  for (const row of rows) {
    let priorArgs = {};
    try { priorArgs = JSON.parse(row.args_json || '{}'); } catch { priorArgs = {}; }
    if (isNearDuplicateArgs(priorArgs, args)) return row;
  }
  return null;
}

function create(bookId, name, args, options = {}) {
  sweep();
  const sessionId = String(options.sessionId || `book:${Number(bookId)}`);
  // 同参去重（2026-09-11 实测）：模型在并行流/多轮里会把同一个写动作重复提交，
  // 实测堆出 2 张同参 create_chapter、3 张同参 update_volume 确认卡——作者面对一堆
  // 一模一样的卡，点哪张都困惑。此前 args_hash 只用于 authorize 的签名校验，不参与去重。
  // 判据：同 session 同工具同参数且仍在 pending 窗口内 ⇒ 同一次授权意图，复用旧卡不新建。
  const hash = argsHash(name, bookId, sessionId, args);
  const existing = db.get(
    "SELECT * FROM chat_actions WHERE args_hash = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 1",
    [hash, Date.now()]
  );
  if (existing) return rowToAction(existing);
  // F4 拒绝冷却（2026-09-11 真实库取证：作者拒绝 create_character 后模型立刻换参数再发起同类操作）：
  // 不落库、无副作用地拒收，由 executor 抛 DomainError 作为「错误即粮食」回灌模型自纠。
  const priorRejected = findRejectedNearDuplicate(bookId, name, sessionId, args);
  if (priorRejected) {
    return { refused: true, reason: 'REJECTED_RETRY', priorActionId: priorRejected.id };
  }
  const id = `c_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = Date.now();
  const expiresAt = createdAt + Math.max(1, Number(options.ttlMs) || DEFAULT_TTL);
  // F2 近重复自动取代（2026-09-11 真实库取证：同一章连开 3 张 create_chapter 卡，参数只差标题
  // 「第6章」vs「第6章：书架间的猎物」——精确去重按设计不合并）。新卡落库前先把既有 pending 同类卡
  // 标记 superseded 并回填 superseded_by=新卡 id，作者只需裁决最新那张。
  const superseded = supersedeNearDuplicates(bookId, name, sessionId, args, id);
  db.run(
    `INSERT INTO chat_actions (id, book_id, name, args_json, args_hash, session_id, tool_call_id,
       target_revision, requested_by, status, summary, impact_json, created_at, expires_at, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [id, Number(bookId), String(name), canonicalJson(args || {}), hash,
      sessionId, options.toolCallId || '', options.targetRevision != null ? Number(options.targetRevision) : null,
      options.requestedBy || '', options.summary || '', JSON.stringify(Array.isArray(options.impact) ? options.impact : []),
      createdAt, expiresAt, options.runId || null]
  );
  // 确认卡是作者资产：创建即同步落盘，关掉「卡已显示但 1 秒窗口内断电即丢」的缝隙
  db.saveNow();
  // R1：被取代的旧卡离开了「未结算」集合。必须在新卡 INSERT 之后才判——若新卡仍归属同一
  // 运行行，它自己就是一张未结算卡，运行行不该被终态化。
  for (const runId of superseded.runIds) runSvc.settleRunAfterConfirmation(runId, 'action_settled');
  return rowToAction(db.get('SELECT * FROM chat_actions WHERE id = ?', [id]));
}

function get(id) {
  sweep();
  return rowToAction(db.get('SELECT * FROM chat_actions WHERE id = ?', [String(id)]));
}

function authorize(id, expected = {}) {
  sweep();
  const action = get(id);
  if (!action) return { ok: false, code: 'CONFIRMATION_NOT_FOUND' };
  if (action.status !== 'pending') {
    // F2：被更新的同类请求取代的卡不得再执行（作者应确认最新那张）
    if (action.status === 'superseded') return { ok: false, code: 'CONFIRMATION_SUPERSEDED' };
    // S2-02：执行中断的卡结果不确定（领域变更可能已部分生效），不得重放——
    // 唯一出路是作者核对实体后重新发起（新卡、新确认）
    if (action.status === 'interrupted') return { ok: false, code: 'CONFIRMATION_INTERRUPTED' };
    return { ok: false, code: action.status === 'expired' ? 'CONFIRMATION_EXPIRED' : 'CONFIRMATION_USED' };
  }
  const sessionId = String(expected.sessionId || action.sessionId);
  const name = String(expected.name || action.name);
  const bookId = Number(expected.bookId);
  const args = expected.args === undefined ? action.args : expected.args;
  if (action.bookId !== bookId || action.name !== name || action.sessionId !== sessionId) {
    return { ok: false, code: 'CONFIRMATION_MISMATCH' };
  }
  const digest = argsHash(name, bookId, sessionId, args);
  const left = Buffer.from(action.argsHash);
  const right = Buffer.from(digest);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, code: 'CONFIRMATION_MISMATCH' };
  }
  const usedAt = Date.now();
  db.run("UPDATE chat_actions SET status = 'executing', used_at = ? WHERE id = ?", [usedAt, action.id]);
  db.saveNow();
  return { ok: true, action: { ...action, status: 'executing', usedAt } };
}

function reject(id, sessionId) {
  sweep();
  const action = get(id);
  if (!action) return { ok: false, code: 'CONFIRMATION_NOT_FOUND' };
  if (action.status !== 'pending') return { ok: false, code: 'CONFIRMATION_USED' };
  if (sessionId && action.sessionId !== String(sessionId)) {
    return { ok: false, code: 'CONFIRMATION_MISMATCH' };
  }
  const settledAt = Date.now();
  db.run("UPDATE chat_actions SET status = 'rejected', settled_at = ? WHERE id = ?", [settledAt, action.id]);
  db.saveNow();
  // R1 / G6 审计 P2-1：卡落定后运行行不得再停在 awaiting_confirmation（契约 3.1：paused/action_rejected）
  runSvc.settleRunAfterConfirmation(action.runId, 'action_rejected');
  return { ok: true, action: get(action.id) };
}

function settle(id, status, result) {
  const settledAt = Date.now();
  // S2-02：结算落盘时写 durable 凭据——status 与 result_json 同一条 UPDATE 原子可见，
  // settlement_ref 再编码一份结算状态作为防御深度（状态字段损坏时可凭它恢复，
  // 见 recoverInterruptedActions；正常路径下三者一致）。
  const settlementRef = `v1:${status}:${settledAt}`;
  db.run('UPDATE chat_actions SET status = ?, result_json = ?, settled_at = ?, settlement_ref = ? WHERE id = ?', [
    status, result === undefined ? null : JSON.stringify(result), settledAt, settlementRef, String(id),
  ]);
  db.saveNow();
  const settled = get(id);
  // R1 / G6 审计 P2-1：结算后把发起该卡的运行行按契约 3.1 终态化（paused/action_settled）——
  // 「最后一张未结算卡」由 settleRunAfterConfirmation 内部判定。
  runSvc.settleRunAfterConfirmation(settled && settled.runId, 'action_settled');
  return settled;
}

// S2-02 / C07 启动恢复：无结算凭据的 executing 标 interrupted（结果不确定：领域写是同步
// SQL，可能已应用甚至已随自动 flush 落盘——不能当「未执行」重放，也不能谎称已结算）。
// 有真实 result + durable 结算凭据的（settlement_ref 编码 approved/failed 且 result_json
// 非空——UPDATE 原子性下正常不会出现，属状态损坏防御）按凭据恢复，绝不凭模型摘要推断。
// S1 的落盘 pending（result 里带 persistence 标记）不构成 durable 凭据：无 settlement_ref
// 一律 interrupted，不转换成成功。
function recoverInterruptedActions() {
  const rows = db.all("SELECT * FROM chat_actions WHERE status = 'executing'");
  let interrupted = 0;
  let restored = 0;
  const touchedRunIds = new Set();
  for (const row of rows) {
    if (row.run_id) touchedRunIds.add(row.run_id);
    const ref = row.settlement_ref || '';
    const encoded = /^v1:(approved|failed):/.exec(ref);
    if (encoded && row.result_json != null) {
      db.run('UPDATE chat_actions SET status = ? WHERE id = ?', [encoded[1], row.id]);
      restored += 1;
      continue;
    }
    db.run("UPDATE chat_actions SET status = 'interrupted', settled_at = ?, recovery_reason = ? WHERE id = ?", [
      Date.now(), 'restart_during_execution', row.id,
    ]);
    interrupted += 1;
  }
  if (interrupted + restored > 0) db.saveNow();
  // R1 / G6 审计 P2-1：这些卡离开了「未结算」集合——其运行行若停在 awaiting_confirmation
  // （recoverInterruptedRuns 保留等待确认行），按契约 3.1 终态化，不再永久阻塞压缩/归档。
  for (const runId of touchedRunIds) runSvc.settleRunAfterConfirmation(runId, 'action_settled');
  return { interrupted, restored };
}

// 续跑幂等（方向报告 1.4）：记录信封消息行 id，重试时先删旧行再重建
function setResumeMessage(id, messageId) {
  db.run('UPDATE chat_actions SET resume_message_id = ? WHERE id = ?', [Number(messageId), String(id)]);
}

// 回复入库后的一次性标记：防同一确认结果重复续跑
function markResumeDone(id) {
  db.run('UPDATE chat_actions SET resume_done = 1 WHERE id = ?', [String(id)]);
  db.saveNow();
}

// 待确认动作列表（2026-09-10 十章实测）：确认卡此前只存在于 SSE 事件与当前 DOM 里——
// 作者一刷新页面，卡就永久消失（GET /chat 不返回动作），而动作仍以 pending 躺在库里
// 直到 30 分钟 TTL 过期；期间模型续跑还会说「已提交等待确认」，作者却再也找不到确认入口，
// 只能重说一遍让 AI 重新发起。补一个只读列举，供前端在加载会话时重建未结算的卡。
function listPending(bookId) {
  sweep();
  const rows = db.all(
    "SELECT * FROM chat_actions WHERE book_id = ? AND status = 'pending' ORDER BY created_at ASC",
    [Number(bookId)]
  );
  return rows.map(rowToAction);
}

// F5a + 契约 2（2026-09-11 前端统一消费器）：返回该书**全部状态**动作（pending/executing/approved/
// rejected/failed/expired/superseded），按 created_at 升序、最多 100 条——前端刷新后据此重建
// 已结算卡（settled 行保留 30 天）与「已被取代」卡；此前只有 listPending，已结算卡刷新即消失。
function listAll(bookId, limit = 100) {
  sweep();
  const rows = db.all(
    'SELECT * FROM chat_actions WHERE book_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
    [Number(bookId), Math.max(1, Number(limit) || 100)]
  );
  return rows.map(rowToAction);
}

// F3（2026-09-11 真实库取证：5 张卡 30 分钟 TTL 静默过期，其中「第三卷改名回常识修改」的
// update_volume 从未执行，模型却把它当既定事实继续写作）：列出尚未通知模型的过期卡。
function listExpiredUnnotified(bookId, limit = 5) {
  sweep();
  const rows = db.all(
    'SELECT * FROM chat_actions WHERE book_id = ? AND status = \'expired\' AND expiry_notified = 0 ORDER BY created_at ASC, rowid ASC LIMIT ?',
    [Number(bookId), Math.max(1, Number(limit) || 5)]
  );
  return rows.map(rowToAction);
}

// M9-A（F3 收口）：过期卡超过单批通知上限（5 张）时，模型与作者都不知道还有剩余——
// listExpiredUnnotified 的 LIMIT 会把余量截掉。本函数与它同口径（先 sweep、同一 WHERE），
// 但不带 LIMIT，返回「尚未通知的过期卡总数」，供 F3 溢出提示与 GET /chat 的
// expiredActionsOverflow 计算剩余数（调用方需在 markExpiredNotified 之前调用）。
function countExpiredUnnotified(bookId) {
  sweep();
  const row = db.get(
    "SELECT COUNT(*) AS n FROM chat_actions WHERE book_id = ? AND status = 'expired' AND expiry_notified = 0",
    [Number(bookId)]
  );
  return row ? Number(row.n) || 0 : 0;
}

// F3：把过期卡标记为已通知（落 messages 的系统事件后立即调用），保证同一批只通知一次。
function markExpiredNotified(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!list.length) return 0;
  let changed = 0;
  for (const id of list) {
    changed += db.run('UPDATE chat_actions SET expiry_notified = 1 WHERE id = ?', [id]).changes;
  }
  db.saveNow();
  return changed;
}

// F3 文案（逐字实现，勿改标点/换行）：过期卡作为 user 角色系统事件回灌本轮 history。
function expiredNoticeText(action) {
  return '[系统事件·操作超时未执行]\n'
    + `此前你请求执行的写工具 ${action.name}（参数：${JSON.stringify(action.args || {}).slice(0, 300)}）等待作者确认超过时限，从未执行。`
    + '请不要把它当作已完成的事实；如仍需执行，请重新发起并说明。';
}

function clear() {
  try { db.run('DELETE FROM chat_actions'); } catch (_) { /* db 未初始化（早期加载阶段）时忽略 */ }
}

module.exports = {
  create,
  get,
  listPending,
  listAll,
  listExpiredUnnotified,
  countExpiredUnnotified,
  markExpiredNotified,
  expiredNoticeText,
  isNearDuplicateArgs,
  authorize,
  reject,
  settle,
  recoverInterruptedActions,
  setResumeMessage,
  markResumeDone,
  clear,
  canonicalJson,
  argsHash,
  DEFAULT_TTL,
  SETTLED_RETENTION_MS,
  REJECTED_COOLDOWN_MS,
};
