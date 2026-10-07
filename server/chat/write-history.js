// 只用同一会话内已结算的服务端确认记录，判断模型是否可能在回顾历史写入。
const db = require('../db');

function approvedWrites(conversationId) {
  if (!conversationId) return [];
  return db.all(
    "SELECT a.name, a.args_json FROM chat_actions a JOIN agent_runs r ON r.id = a.run_id WHERE r.conversation_id = ? AND a.status = 'approved' AND a.name IN ('append_chapter', 'replace_chapter')",
    [conversationId]
  ).map(row => {
    let args = {};
    try { args = JSON.parse(row.args_json || '{}'); } catch (_) { /* 无法核对的记录不放行 */ }
    return { name: row.name, chapterId: Number(args.chapterId ?? args.chapter_id) };
  }).filter(row => Number.isInteger(row.chapterId) && row.chapterId > 0);
}

module.exports = { approvedWrites };
