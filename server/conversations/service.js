// S3-01 / C10-A：会话服务（契约 §4 内部服务签名的 S3-01 子集）。
//   appendMessage 仅供服务端调用：role 白名单不含 system；runId 必须归属本会话；
//   toolFacts 只经此口写入（HTTP 层不得透传，见 routes/conversations.js 的字段黑名单）。
//   compressConversation 属 S3-04，本文件不实现。
const crypto = require('crypto');
const db = require('../db');
const runSvc = require('../runtime/run-service');

const KINDS = new Set(['agent', 'writing']);
const SCOPES = new Set(['book', 'global']);
// role=system 一律拒绝：系统事件由服务端以 source='system' 的消息表达（017 迁移注释口径）。
// source='system' 仅服务端续跑路径使用——HTTP 层（routes/conversations.js）对客户端
// 提交的 source 单独用更窄的白名单，伪造系统事件在那层被拒。
const ROLES = new Set(['user', 'assistant', 'tool']);
const SOURCES = new Set(['', 'writing', 'read', 'agent', 'system']);
const CLIENT_SOURCES = new Set(['', 'writing', 'read', 'agent']);
const CONTEXT_MESSAGE_LIMIT = 40;
const CONTEXT_FACT_LIMIT = 12;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function getConversation(id) {
  if (typeof id !== 'string' || !id) return null;
  return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
}

function createConversation({ kind, scope, bookId, title }) {
  if (!KINDS.has(kind)) throw fail(400, 'INVALID_CONVERSATION_KIND', 'kind 只能是 agent 或 writing');
  if (!SCOPES.has(scope)) throw fail(400, 'INVALID_CONVERSATION_SCOPE', 'scope 只能是 book 或 global');
  if (kind === 'writing' && scope !== 'book') {
    throw fail(400, 'WRITING_REQUIRES_BOOK_SCOPE', '写作会话必须挂在一本书上');
  }
  const hasBookId = bookId !== undefined && bookId !== null && bookId !== '';
  if (scope === 'global' && hasBookId) {
    throw fail(400, 'GLOBAL_WITHOUT_BOOK', 'global 会话不能绑定书籍');
  }
  let bookIdNum = null;
  if (scope === 'book') {
    bookIdNum = Number(bookId);
    if (!Number.isInteger(bookIdNum) || bookIdNum <= 0) {
      throw fail(400, 'BOOK_REQUIRED', 'book 范围会话必须提供 bookId');
    }
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookIdNum])) {
      throw fail(404, 'BOOK_NOT_FOUND', '书籍不存在');
    }
  }
  const safeTitle = String(title === undefined || title === null ? '' : title).slice(0, 200);
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO conversations (id, kind, scope, book_id, title, status, context_policy_json)
     VALUES (?, ?, ?, ?, ?, 'active', '{}')`,
    [id, kind, scope, bookIdNum, safeTitle]
  );
  return getConversation(id);
}

function listConversations({ kind, scope, bookId, status } = {}) {
  const where = [];
  const params = [];
  if (kind !== undefined && kind !== null && kind !== '') { where.push('kind = ?'); params.push(kind); }
  if (scope !== undefined && scope !== null && scope !== '') { where.push('scope = ?'); params.push(scope); }
  if (bookId !== undefined && bookId !== null && bookId !== '') { where.push('book_id = ?'); params.push(Number(bookId)); }
  if (status !== undefined && status !== null && status !== '') { where.push('status = ?'); params.push(status); }
  const sql = `
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.updated_at DESC, c.id`;
  return db.all(sql, params);
}

function appendMessage({ conversationId, role, content, source, runId, toolFacts, tools }) {
  const conv = getConversation(conversationId);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  if (conv.status !== 'active') {
    throw fail(409, 'CONVERSATION_ARCHIVED', '会话已归档，不能追加消息');
  }
  if (!ROLES.has(role)) {
    throw fail(400, 'INVALID_MESSAGE_ROLE', `role 只能是 ${[...ROLES].join('/')}（system 一律拒绝）`);
  }
  if (typeof content !== 'string' || content.trim() === '') {
    throw fail(400, 'INVALID_MESSAGE_CONTENT', 'content 必须是非空字符串');
  }
  const safeSource = source === undefined || source === null ? '' : source;
  if (!SOURCES.has(safeSource)) {
    throw fail(400, 'INVALID_MESSAGE_SOURCE', "source 只能是 ''/writing/read/agent");
  }
  if (runId !== undefined && runId !== null && runId !== '') {
    const run = db.get('SELECT id, conversation_id FROM agent_runs WHERE id = ?', [String(runId)]);
    if (!run || run.conversation_id !== conversationId) {
      throw fail(400, 'RUN_CONVERSATION_MISMATCH', 'runId 不属于本会话，拒绝写入');
    }
  }
  let factsJson = '';
  if (toolFacts !== undefined && toolFacts !== null) {
    const valid = toolFacts !== null && typeof toolFacts === 'object'
      && (!Array.isArray(toolFacts) || toolFacts.every(x => x !== null && typeof x === 'object' && !Array.isArray(x)));
    if (!valid) throw fail(400, 'INVALID_TOOL_FACTS', 'toolFacts 必须是对象或对象数组');
    factsJson = JSON.stringify(toolFacts);
  }
  // tools：服务端工具事件（toolFact 形状）→ tools_json，供前端工具卡渲染与
  // historyFacts 证据回读；仅供服务端调用方（HTTP 层字段黑名单不含此口）
  let toolsJson = '';
  if (tools !== undefined && tools !== null) {
    const validTools = Array.isArray(tools) && tools.every(x => x !== null && typeof x === 'object' && !Array.isArray(x));
    if (!validTools) throw fail(400, 'INVALID_TOOLS', 'tools 必须是对象数组');
    toolsJson = JSON.stringify(tools);
  }
  const bookId = conv.scope === 'book' ? conv.book_id : null;
  const { lastInsertRowid } = db.run(
    `INSERT INTO messages (book_id, conversation_id, role, content, source, tools_json, tool_facts_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [bookId, conversationId, role, content, safeSource, toolsJson, factsJson]
  );
  db.run("UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?", [conversationId]);
  return { id: lastInsertRowid, conversationId, role, source: safeSource };
}

function parseFacts(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function listMessages(conversationId, { afterId = 0, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const conv = getConversation(conversationId);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  const after = Number(afterId) > 0 ? Number(afterId) : 0;
  const cap = Math.min(Math.max(1, Number(limit) || DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
  const rows = db.all(
    `SELECT id, role, content, reasoning, compressed, tools_json, source, tool_facts_json, created_at
     FROM messages WHERE conversation_id = ? AND id > ?
     ORDER BY id ASC LIMIT ?`,
    [conversationId, after, cap]
  );
  const messages = rows.map(m => {
    let tools = [];
    let run = null;
    try {
      const parsed = JSON.parse(m.tools_json || '[]');
      if (Array.isArray(parsed)) {
        tools = parsed.filter(tool => tool?.kind !== 'run');
        run = parsed.find(tool => tool?.kind === 'run')?.state || null;
      }
    } catch { /* 与 GET /chat 同口径：坏数据不炸列表 */ }
    return {
      id: m.id, role: m.role, content: m.content, reasoning: m.reasoning,
      compressed: m.compressed, source: m.source || '', created_at: m.created_at,
      tools, run, toolFacts: parseFacts(m.tool_facts_json),
    };
  });
  return { conversationId, messages };
}

// 组装下一轮上下文：活跃消息（压缩归档行不进组装）+ 最近可信工具事实。
// S3-02/S3-03 的模型历史组装由此取数；target/budget 深化属后续任务。
function getConversationContext({ conversationId, limit = CONTEXT_MESSAGE_LIMIT }) {
  const conv = getConversation(conversationId);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  const cap = Math.min(Math.max(1, Number(limit) || CONTEXT_MESSAGE_LIMIT), 200);
  const rows = db.all(
    `SELECT id, role, content, source, tools_json, tool_facts_json FROM messages
     WHERE conversation_id = ? AND COALESCE(compressed, 0) != 1
     ORDER BY id DESC LIMIT ?`,
    [conversationId, cap]
  ).reverse();
  const toolFacts = [];
  for (const row of rows) {
    const facts = parseFacts(row.tool_facts_json);
    if (!facts) continue;
    const list = Array.isArray(facts) ? facts : [facts];
    for (const fact of list) {
      if (toolFacts.length >= CONTEXT_FACT_LIMIT) break;
      toolFacts.push(fact);
    }
  }
  return {
    conversation: { id: conv.id, kind: conv.kind, scope: conv.scope, book_id: conv.book_id, status: conv.status },
    messages: rows.map(r => ({ id: r.id, role: r.role, content: r.content, source: r.source || '', tools_json: r.tools_json || '' })),
    toolFacts,
  };
}

// legacy localStorage Agent 历史导入（契约 §5）：只收 user/assistant 纯文本，无可信工具
// 事实、无有效确认凭证；按批次摘要（scope+bookId+消息内容哈希）幂等——重复导入同一
// 批次命中同一会话、不新建消息。不能自动猜书名归属，scope=book 必须显式给 bookId。
function importLegacyAgent({ scope, bookId, title, messages }) {
  if (scope !== 'global' && scope !== 'book') {
    throw fail(400, 'INVALID_IMPORT_SCOPE', 'scope 只能是 global 或 book');
  }
  const hasBookId = bookId !== undefined && bookId !== null && bookId !== '';
  if (scope === 'global' && hasBookId) {
    throw fail(400, 'GLOBAL_WITHOUT_BOOK', 'global 导入不能绑定书籍');
  }
  let bookIdNum = null;
  if (scope === 'book') {
    bookIdNum = Number(bookId);
    if (!Number.isInteger(bookIdNum) || bookIdNum <= 0) {
      throw fail(400, 'BOOK_REQUIRED', 'book 导入必须提供 bookId');
    }
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookIdNum])) {
      throw fail(404, 'BOOK_NOT_FOUND', '书籍不存在');
    }
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw fail(400, 'IMPORT_MESSAGES_REQUIRED', 'messages 必须是非空数组');
  }
  if (messages.length > 200) {
    throw fail(400, 'IMPORT_TOO_LARGE', '单批导入最多 200 条');
  }
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw fail(400, 'INVALID_IMPORT_MESSAGE', '消息必须是对象');
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw fail(400, 'INVALID_IMPORT_MESSAGE', '只允许导入 user/assistant 消息（system/工具消息一律拒绝）');
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      throw fail(400, 'INVALID_IMPORT_MESSAGE', '消息 content 必须是非空字符串');
    }
    clean.push({ role: m.role, content: m.content });
  }
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ scope, bookId: bookIdNum, messages: clean }))
    .digest('hex');
  // 批次摘要幂等查重：同摘要的导入会话已存在则直接返回（单用户规模下 LIKE 扫描足够）
  const existing = db.get(
    "SELECT * FROM conversations WHERE context_policy_json LIKE ? LIMIT 1",
    [`%"${digest}"%`]
  );
  if (existing) {
    return { conversationId: existing.id, createdMessages: 0, duplicate: true, digest };
  }
  const conv = createConversation({
    kind: 'agent', scope, bookId: bookIdNum,
    title: String(title === undefined || title === null ? '导入的助手历史' : title).slice(0, 200),
  });
  db.run(
    "UPDATE conversations SET context_policy_json = ? WHERE id = ?",
    [JSON.stringify({ legacyImport: { digest, count: clean.length, importedAt: new Date().toISOString() } }), conv.id]
  );
  for (const m of clean) {
    db.run(
      `INSERT INTO messages (book_id, conversation_id, role, content, source, created_at)
       VALUES (?, ?, ?, ?, 'agent', datetime('now','localtime'))`,
      [bookIdNum, conv.id, m.role, m.content]
    );
  }
  return { conversationId: conv.id, createdMessages: clean.length, duplicate: false, digest };
}

function archiveConversation(id) {
  const conv = getConversation(id);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  // R1 / G6 审计 P2-1：awaiting_confirmation 只在它自己发起的确认卡仍未结算时才算活跃运行
  // （契约 3.1：结算后转 paused/action_settled）——卡已全部结算的存量滞留行不再永久阻塞归档。
  const activeRun = runSvc.findActiveRun(id);
  if (activeRun) {
    throw fail(409, 'CONVERSATION_ACTIVE_RUN', '会话存在活跃运行，归档须等运行结束');
  }
  db.run("UPDATE conversations SET status = 'archived', updated_at = datetime('now','localtime') WHERE id = ?", [id]);
  return getConversation(id);
}

// S3-03：写作入口会话解析。
//   显式指定：必须存在、kind=writing、scope=book 且属于该书——否则 404（任务书：跨书/
//   agent 会话用于本书一律 404，不静默回落）。
//   未指定（旧调用过渡）：映射该书 legacy-writing 会话（确定性 id，惰性创建并归拢
//   迁移后旧入口产生的无归属消息）——绝不等同于「整书全部消息拼入」，agent 会话/
//   他书消息天然不在其中。
function resolveWritingConversation(bookId, conversationId) {
  const bookIdNum = Number(bookId);
  if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
    const conv = getConversation(String(conversationId));
    if (!conv || conv.kind !== 'writing' || conv.scope !== 'book' || Number(conv.book_id) !== bookIdNum) {
      throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在或不属于该书');
    }
    return conv;
  }
  if (!Number.isInteger(bookIdNum) || !db.get('SELECT id FROM books WHERE id = ?', [bookIdNum])) {
    throw fail(404, 'BOOK_NOT_FOUND', '书籍不存在');
  }
  const { assignOrphanMessages, legacyConversationId, LEGACY_TITLE } = require('../migrations/028-conversations');
  const id = legacyConversationId(bookIdNum);
  db.run(
    `INSERT OR IGNORE INTO conversations
       (id, kind, scope, book_id, title, status, context_policy_json)
     VALUES (?, 'writing', 'book', ?, ?, 'active', '{"legacy":true}')`,
    [id, bookIdNum, LEGACY_TITLE]
  );
  assignOrphanMessages(db, bookIdNum);
  return getConversation(id);
}

module.exports = {
  createConversation,
  listConversations,
  getConversation,
  appendMessage,
  listMessages,
  getConversationContext,
  archiveConversation,
  importLegacyAgent,
  resolveWritingConversation,
  CLIENT_SOURCES,
};
