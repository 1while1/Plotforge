// run-service（S2-01 / 契约 3.1、3.3）：双入口共享的运行协调器。
//
// 职责边界：本模块不是第三个模型循环——它只做三件事：
//   ① 运行占位与真相：startRun 同步落盘占位（status=running），同 session+request
//      幂等返回既有运行；finishRun 落终态；重启时 recoverInterruptedRuns 把
//      残留 running 标 interrupted（不暗中续写）。
//   ② 并发所有权：内存协调器按 scope 持锁（book:write:<id> / session:<key>），
//      owner=runId、只有持有者能释放；写作页按书单飞语义原样迁入（替换 chat.js
//      私有的 activeChatRuns，不留两把互不知情的写锁）。
//   ③ 事件顺序：appendRunEvent 服务端 seq 单调，payload 落库前脱敏截断。
//
// 两种模型传输（llm.js fetch 网关与 Agent SDK streamText）保持不变；
// 统一的是运行/权限/确认/结果真相这些业务规则。
const db = require('../db');

const TERMINAL_STATUSES = ['finished', 'paused', 'failed', 'cancelled', 'interrupted'];
const ACTIVE_STATUSES = ['running', 'awaiting_confirmation'];
// awaiting_confirmation 不是真终态（action 结算后仍可推进/由关联续跑接棒），但流式
// 出口会以它收尾——finishRun 允许写入，且不阻塞之后的再次落终态。
const FINALIZABLE_STATUSES = [...TERMINAL_STATUSES, 'awaiting_confirmation'];
const EVENT_TYPES = ['phase', 'tool_started', 'tool_result', 'confirmation_required', 'resource_changed', 'run_finished', 'error'];
const MAX_PAYLOAD_CHARS = 4000;

// ---- 并发协调器（内存；重启即清空——运行占位在库里，重启后本就没有活跃运行）----
const locks = new Map(); // scope -> ownerRunId

/** 原子获取一组 scope（全拿或全不拿，排序防死锁）。忙时返回占用明细。 */
function acquireScopes(scopes, owner) {
  const sorted = [...new Set(scopes)].sort();
  const busy = sorted.filter(s => locks.has(s)).map(s => ({ scope: s, owner: locks.get(s) }));
  if (busy.length) return { ok: false, busy };
  for (const s of sorted) locks.set(s, owner);
  return { ok: true };
}

/** 释放：只有持有者能释放（owner 比对），避免晚到的 finally 误删后来者的锁。 */
function releaseScopes(scopes, owner) {
  for (const s of new Set(scopes)) {
    if (locks.get(s) === owner) locks.delete(s);
  }
}

function releaseByOwner(owner) {
  for (const [s, o] of locks) if (o === owner) locks.delete(s);
}

function lockSnapshot() {
  return [...locks.entries()].map(([scope, owner]) => ({ scope, owner }));
}

const bookWriteScope = (bookId) => `book:write:${Number(bookId)}`;
const sessionScope = (sessionKey) => `session:${String(sessionKey)}`;

// ---- 运行记录 ----

function newRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanText(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

// Number(null)=0 会被 Number.isFinite 误判为有效书号——空值必须先显式排除（实测踩过：FK 拒绝）
function numericOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    sessionKey: row.session_key,
    conversationId: row.conversation_id,
    entry: row.entry,
    bookId: row.book_id,
    mode: row.mode,
    status: row.status,
    reason: row.reason,
    resumeActionId: row.resume_action_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function findRunByRequest(sessionKey, requestId) {
  return rowToRun(db.get(
    'SELECT * FROM agent_runs WHERE session_key = ? AND request_id = ? ORDER BY created_at DESC LIMIT 1',
    [String(sessionKey), String(requestId)]
  ));
}

/**
 * 创建运行占位。同 session+request 已存在 → 返回 { run, duplicate: true }（不新插行、
 * 不调用模型的承诺由调用方遵守：拿到 duplicate 就短路返回 JSON）。
 * 占位 INSERT 后立即 saveNow——落盘失败必须停（不带着「运行不存在」的假象去调模型），
 * 此时删除占位行并抛 RunPersistError（status 503）。
 */
function startRun({ runId, requestId, conversationId, sessionKey, entry, bookId, mode, resumeActionId }) {
  const id = cleanText(runId || newRunId(), 64) || newRunId();
  const existing = findRunByRequest(sessionKey, requestId);
  if (existing) return { run: existing, duplicate: true };
  try {
    db.run(
      `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, book_id, mode, status, resume_action_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      [id, cleanText(requestId, 128), cleanText(sessionKey, 128), cleanText(conversationId || null, 64) || null,
        cleanText(entry, 16), numericOrNull(bookId),
        cleanText(mode, 16), cleanText(resumeActionId || null, 64) || null,
        new Date().toISOString()]
    );
  } catch (e) {
    // 同一确认动作的续跑运行已存在（换 requestId 也绕不过库级唯一索引）→ 幂等返回既有运行
    if (resumeActionId && /UNIQUE constraint failed.*resume_action_id/.test(String(e && e.message || e))) {
      const prior = rowToRun(db.get('SELECT * FROM agent_runs WHERE resume_action_id = ?', [String(resumeActionId)]));
      if (prior) return { run: prior, duplicate: true };
    }
    throw e;
  }
  try {
    db.saveNow();
  } catch (e) {
    try { db.run('DELETE FROM agent_runs WHERE id = ?', [id]); } catch (_) { /* 占位回滚失败：唯一索引兜底 */ }
    const err = new Error('运行记录落盘失败：' + String(e && e.message || e).slice(0, 200));
    err.status = 503; err.code = 'RUN_PERSIST_FAILED';
    throw err;
  }
  return { run: rowToRun(db.get('SELECT * FROM agent_runs WHERE id = ?', [id])), duplicate: false };
}

// ---- 事件：脱敏 + 服务端顺序 ----

const SENSITIVE_KEY = /api[-_]?key|authorization|^token$|password|secret|cookie|bearer/i;

function redactValue(value, depth) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redactValue(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

// G2 审查 P3-2：读取端键过滤兜底——routes/runs.js 注释承诺的「双层脱敏」此前只有
// 写入端一层（appendRunEvent 的 redactValue），读取端 listRunEvents 原样返回。
// 防御未来写入路径绕过或存量脏数据（如直接写库/迁移带入的明文键）。
// 只过滤键、不做长度截断：截断是写入端职责，截断信封的 preview 要保持可读。
function redactKeys(value, depth) {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redactKeys(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = redactKeys(v, depth + 1);
  }
  return out;
}

function appendRunEvent(runId, { type, payload }) {
  if (!EVENT_TYPES.includes(type)) return null;
  let json = '{}';
  try {
    json = JSON.stringify(redactValue(payload || {}, 0));
  } catch (_) { /* 循环引用等异常：存空对象 */ }
  // G2 审查 P3-3：超限截断此前是字符串截断+省略号 → 读出端 safeParse 得到非法 JSON
  // 静默返回 {}，超限事件不可解释。改为合法 JSON 信封：调用方能看到「被截断+原始
  // 长度+开头预览」，而不是空负载。
  if (json.length > MAX_PAYLOAD_CHARS) {
    json = JSON.stringify({
      truncated: true,
      originalChars: json.length,
      preview: json.slice(0, Math.max(0, MAX_PAYLOAD_CHARS - 96)) + '…',
    });
  }
  const seq = db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM agent_run_events WHERE run_id = ?', [runId]).n;
  db.run(
    'INSERT INTO agent_run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [runId, seq, type, json, new Date().toISOString()]
  );
  return seq;
}

// ---- 终态与恢复 ----

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** 落终态（幂等：首个终态生效，之后的调用不再改写）。saveNow 失败不抛——行保持
 * running，重启恢复会把它标 interrupted，方向安全（不会把失败谎报成成功）。 */
function finishRun(runId, { status, reason, actionId, resultRefs } = {}) {
  if (!FINALIZABLE_STATUSES.includes(status)) throw new Error('非法终态: ' + status);
  const row = db.get('SELECT status FROM agent_runs WHERE id = ?', [runId]);
  if (!row) return null;
  if (isTerminal(row.status)) return rowToRun({ ...row });
  const refs = Array.isArray(resultRefs) && resultRefs.length
    ? JSON.stringify(resultRefs.slice(0, 20)) : null;
  db.run(
    "UPDATE agent_runs SET status = ?, reason = ?, finished_at = ?, resume_action_id = COALESCE(?, resume_action_id) WHERE id = ?",
    [status, cleanText(reason || null, 200) || null, new Date().toISOString(),
      cleanText(actionId || null, 64) || null, runId]
  );
  if (refs) {
    appendRunEvent(runId, { type: 'run_finished', payload: { status, reason: reason || null, resultRefs: JSON.parse(refs) } });
  } else {
    appendRunEvent(runId, { type: 'run_finished', payload: { status, reason: reason || null } });
  }
  try { db.saveNow(); } catch (e) { console.error('[run-service] 终态落盘失败（重启将按 interrupted 恢复）:', e.message); }
  return rowToRun(db.get('SELECT * FROM agent_runs WHERE id = ?', [runId]));
}

function getRun(runId) {
  return rowToRun(db.get('SELECT * FROM agent_runs WHERE id = ?', [String(runId)]));
}

function listRunEvents(runId, { afterSeq = 0, limit = 200 } = {}) {
  const rows = db.all(
    'SELECT * FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    [String(runId), Number(afterSeq) || 0, Math.min(Math.max(Number(limit) || 200, 1), 500)]
  );
  return rows.map(r => ({
    runId: r.run_id,
    seq: r.seq,
    type: r.type,
    // G2 审查 P3-2：读取端键过滤兜底（双层脱敏的第二层）
    payload: redactKeys(safeParse(r.payload_json), 0),
    createdAt: r.created_at,
  }));
}

function safeParse(json) {
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

/** 重启恢复：残留 running → interrupted（不暗中续写）。awaiting_confirmation 保留——
 * 确认卡的有效期由 actionStore 自己管（契约 3.1「不一律废弃」）。 */
function recoverInterruptedRuns() {
  const stale = db.all("SELECT id, entry FROM agent_runs WHERE status = 'running'");
  if (!stale.length) return { interrupted: 0 };
  db.run(
    "UPDATE agent_runs SET status = 'interrupted', reason = 'server_restart', finished_at = ? WHERE status = 'running'",
    [new Date().toISOString()]
  );
  try { db.saveNow(); } catch (e) { console.error('[run-service] 恢复标记落盘失败:', e.message); }
  for (const r of stale) appendRunEvent(r.id, { type: 'error', payload: { code: 'RUN_INTERRUPTED', message: '服务重启，运行未正常结算' } });
  return { interrupted: stale.length };
}

// ---- 确认卡与运行行的关系（R1 / G6 审计 P2-1）----
// 背景：结算路径（批准/拒绝/过期/取代/中断恢复）此前只改 chat_actions 的状态，agent_runs 行
// 留在 awaiting_confirmation；压缩与归档却把它无条件当活跃运行 → 该会话永久 409
// CONVERSATION_ACTIVE_RUN。契约 3.1 的语义是「awaiting_confirmation 在 action 结算后标为
// paused/action_settled（拒绝为 action_rejected）」，因此：读侧按「是否仍有未结算卡」判活跃，
// 写侧在最后一张未结算卡落定时把运行行转终态。存量滞留行由读侧兜住（无需迁移/回填）。
// 「未结算」＝作者还没裁决（pending）或正在执行（executing）——与 handoffs.js（a27898c）同口径。
const UNRESOLVED_CONFIRMATION_STATUSES = ['pending', 'executing'];

/** 该运行名下是否还有未结算的确认卡（有＝这一轮随时会被作者裁决后继续推进）。 */
function hasUnresolvedConfirmation(runId) {
  if (!runId) return false;
  const marks = UNRESOLVED_CONFIRMATION_STATUSES.map(() => '?').join(', ');
  const row = db.get(
    `SELECT id FROM chat_actions WHERE run_id = ? AND status IN (${marks}) LIMIT 1`,
    [String(runId), ...UNRESOLVED_CONFIRMATION_STATUSES]
  );
  return Boolean(row);
}

/** 会话的活跃运行（压缩/归档守卫）：running 无条件算；awaiting_confirmation 只在它自己发起的
 *  确认卡仍未结算时算。excludeRunId：流末自动压缩豁免发起压缩的运行自身（原语义保留）。 */
function findActiveRun(conversationId, { excludeRunId = null } = {}) {
  const rows = db.all(
    `SELECT id, status FROM agent_runs
      WHERE conversation_id = ? AND status IN ('running', 'awaiting_confirmation')
      ${excludeRunId ? 'AND id != ?' : ''}
      ORDER BY created_at ASC, id ASC`,
    excludeRunId ? [String(conversationId), String(excludeRunId)] : [String(conversationId)]
  );
  for (const row of rows) {
    if (row.status === 'running') return row;
    if (hasUnresolvedConfirmation(row.id)) return row;
  }
  return null;
}

/** 结算一张卡之后调用：该运行已无未结算卡、且正停在 awaiting_confirmation 时，按契约 3.1 落
 *  paused/action_settled（拒绝为 action_rejected）。幂等：仍有卡 / 不在等待态 / 已是终态时不改写。 */
function settleRunAfterConfirmation(runId, reason) {
  if (!runId) return null;
  if (hasUnresolvedConfirmation(runId)) return null;
  const row = db.get('SELECT status FROM agent_runs WHERE id = ?', [String(runId)]);
  if (!row || row.status !== 'awaiting_confirmation') return null;
  return finishRun(runId, { status: 'paused', reason: reason || 'action_settled' });
}

module.exports = {
  TERMINAL_STATUSES, ACTIVE_STATUSES, FINALIZABLE_STATUSES, EVENT_TYPES,
  acquireScopes, releaseScopes, releaseByOwner, lockSnapshot,
  bookWriteScope, sessionScope,
  newRunId, startRun, findRunByRequest, getRun, finishRun,
  appendRunEvent, listRunEvents, recoverInterruptedRuns,
  hasUnresolvedConfirmation, findActiveRun, settleRunAfterConfirmation,
  // S2-04：watchdog 默认硬超时（与 run-policy 同一常量，Agent 路由透传给运行器）
  DEFAULT_MAX_DURATION_MS: require('../chat/run-policy').DEFAULT_MAX_DURATION_MS,
};
