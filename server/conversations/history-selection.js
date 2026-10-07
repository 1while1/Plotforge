// 压缩摘要是归档历史的唯一模型侧替身：不能依赖消息行在最近 N 条窗口内。
// 返回原始摘要文本和最近消息；调用方可再按自身预算裁剪普通历史。
const db = require('../db');

function selectHistory({ conversationId = null, bookId = null, limit = 12 }) {
  const cap = Math.max(1, Math.min(Number(limit) || 12, 200));
  const rows = conversationId
    ? db.all('SELECT id, role, content, source, tools_json, tool_facts_json FROM messages WHERE conversation_id = ? AND COALESCE(compressed, 0) = 0 ORDER BY id DESC LIMIT ?', [conversationId, cap]).reverse()
    : db.all('SELECT id, role, content, source, tools_json, tool_facts_json FROM messages WHERE book_id = ? AND COALESCE(compressed, 0) != 1 ORDER BY id DESC LIMIT ?', [bookId, cap]).reverse();
  const summaries = conversationId ? db.all(
    "SELECT content FROM conversation_summaries WHERE conversation_id = ? AND status = 'active' ORDER BY id ASC",
    [conversationId]
  ) : [];
  // 最近窗口可能切在 assistant 消息中间；从下一个 user 开始，避免非法首角色。
  while (rows.length && rows[0].role !== 'user') rows.shift();
  const messages = rows.map(row => ({ ...row }));
  if (summaries.length) messages.unshift({
    role: 'system', content: '【上下文压缩存档】\n' + summaries.map(row => row.content).join('\n\n【历史存档续段】\n'), summary: true,
  });
  return messages;
}

module.exports = { selectHistory };
