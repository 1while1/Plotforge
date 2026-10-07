// 已执行读取的运行级事实。历史证据只用于审计；本轮重读核验仍使用执行器内存凭据。
const db = require('../db');

function persistRead({ runId, bookId, chapterId, toolName, receipt }) {
  if (!runId) return null; // 不属于模型运行的内部读取没有跨重启审计承诺
  const run = db.get('SELECT id, conversation_id, book_id FROM agent_runs WHERE id = ?', [String(runId)]);
  if (!run || !run.conversation_id) throw Object.assign(new Error('读取证据缺少有效运行归属'), { code: 'READ_EVIDENCE_SCOPE_INVALID' });
  if (run.book_id != null && Number(run.book_id) !== Number(bookId)) {
    throw Object.assign(new Error('读取证据与运行书籍不符'), { code: 'READ_EVIDENCE_SCOPE_INVALID' });
  }
  const conv = db.get('SELECT book_id FROM conversations WHERE id = ?', [run.conversation_id]);
  if (!conv || (conv.book_id != null && Number(conv.book_id) !== Number(bookId))) {
    throw Object.assign(new Error('读取证据与会话书籍不符'), { code: 'READ_EVIDENCE_SCOPE_INVALID' });
  }
  try {
    db.run(
      `INSERT INTO run_read_evidence (run_id, book_id, chapter_id, tool_name, tool_call_id, revision, content_hash, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, tool_call_id, chapter_id, tool_name, revision, content_hash) DO NOTHING`,
      [run.id, Number(bookId), Number(chapterId), toolName, receipt.toolCallId || '',
        Number(receipt.revision), receipt.contentHash, receipt.observedAt]
    );
    if (!db.saveNow()) throw new Error('读取证据同步落盘失败');
  } catch (cause) {
    throw Object.assign(new Error('读取证据未持久化，本轮读取不能作为核验凭据'), {
      code: 'READ_EVIDENCE_PERSIST_FAILED', cause,
    });
  }
  return receipt;
}

function listForRun(runId) {
  return db.all(
    'SELECT id, run_id, book_id, chapter_id, tool_name, tool_call_id, revision, content_hash, observed_at FROM run_read_evidence WHERE run_id = ? ORDER BY id',
    [String(runId)]
  ).map(row => ({
    id: row.id, runId: row.run_id, bookId: row.book_id, chapterId: row.chapter_id,
    toolName: row.tool_name, toolCallId: row.tool_call_id, revision: row.revision,
    contentHash: row.content_hash, observedAt: row.observed_at,
  }));
}

module.exports = { persistRead, listForRun };
