// 调用台账（对齐 Codex CLI 会话 JSONL 的 token_count 事件）：每次模型调用落库一条，
// 含真实 usage、请求组成估算、finish_reason、状态与耗时；上下文仪表/组成面板/统计的唯一数据源。
// 写入失败绝不影响主流程。
const db = require('./db');

function record(e) {
  try {
    db.run(
      `INSERT INTO llm_calls (book_id, conversation_id, scope, model, base_url, prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, reasoning_tokens, system_tokens, history_tokens, tool_tokens, schema_tokens, output_reserve, finish_reason, status, error, duration_ms, parts_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.bookId != null && e.bookId !== '' ? Number(e.bookId) : null,
        e.conversationId || null,
        e.scope || 'llm',
        e.model || '',
        e.baseUrl || '',
        e.promptTokens | 0,
        e.completionTokens | 0,
        e.cacheHitTokens | 0,
        e.cacheMissTokens | 0,
        e.reasoningTokens | 0,
        e.systemTokens | 0,
        e.historyTokens | 0,
        e.toolTokens | 0,
        e.schemaTokens | 0,
        e.outputReserve | 0,
        e.finishReason || '',
        e.status || 'ok',
        e.error || '',
        e.durationMs | 0,
        e.partsJson || '',
        e.createdAt || new Date().toISOString(),
      ]
    );
  } catch (err) { /* 台账写入失败绝不影响主流程 */ }
}

// usage 归因（对齐 pi UsageRecord.cause，agent/src/harness/session/types.ts:190-201）：
// 把 llm_calls.scope 归并为「为什么发起这次调用」的少数桶（主对话/压缩/摘要/工具派生），
// 供统计与预算分析统一口径。只在 JS 读出侧打标（withCause），不做表结构迁移——scope 原值完整保留在库里。
function usageCause(scope) {
  const s = String(scope || '');
  if (s === 'compact') return 'compaction';
  if (s.startsWith('chat')) return 'assistant';
  if (s === 'summarize' || s === 'story-state' || s === 'chapter-extract' || s === 'drift-check') return 'summary';
  if (s === 'polish' || s === 'consult' || s === 'advisor') return 'tool';
  return 'other';
}

// 行内补 cause 字段（不改库、不改既有字段）
function withCause(row) { return row ? { ...row, cause: usageCause(row.scope) } : row; }

// 最近一次带真实 usage 的调用（供仪表显示真实占用）
function lastWithUsage(bookId) {
  return withCause(db.get('SELECT * FROM llm_calls WHERE book_id = ? AND prompt_tokens > 0 ORDER BY id DESC LIMIT 1', [Number(bookId)]));
}

function lastWithUsageForConversation(conversationId) {
  if (!conversationId) return null;
  return withCause(db.get(
    "SELECT * FROM llm_calls WHERE conversation_id = ? AND scope IN ('chat', 'chat-stream', 'chat-continue', 'chat-stream-continue', 'chat-followup', 'chat-followup-retry', 'chat-readverify-retry', 'chat-stream-fallback', 'chat-regen') AND status = 'ok' AND prompt_tokens > 0 ORDER BY id DESC LIMIT 1",
    [conversationId]
  ));
}

// 最近一次带请求组成估算的调用（供组成面板；仅聊天主请求记录组成）
function lastComposition(bookId) {
  return withCause(db.get('SELECT * FROM llm_calls WHERE book_id = ? AND system_tokens > 0 ORDER BY id DESC LIMIT 1', [Number(bookId)]));
}

function lastCompositionForConversation(conversationId) {
  if (!conversationId) return null;
  return withCause(db.get(
    "SELECT * FROM llm_calls WHERE conversation_id = ? AND scope IN ('chat', 'chat-stream') AND status = 'ok' AND system_tokens > 0 ORDER BY id DESC LIMIT 1",
    [conversationId]
  ));
}

// 最近 limit 条调用（供组成面板的调用记录表）
function list(bookId, limit) {
  return db.all('SELECT * FROM llm_calls WHERE book_id = ? ORDER BY id DESC LIMIT ?', [Number(bookId), Number(limit) > 0 ? Number(limit) : 10]).map(withCause);
}

module.exports = { record, lastWithUsage, lastWithUsageForConversation, lastComposition, lastCompositionForConversation, list, usageCause };
