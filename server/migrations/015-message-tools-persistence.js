const version = 'message_tools_persistence_v1';
const checksum = 'sha256:message-tools-persistence-20260910-01';

// 工具事件随助手消息持久化（2026-09-10 用户反馈）：写作聊天的工具调用卡此前只存在于
// SSE 事件（前端实时渲染），刷新页面后 loadChat 从 messages 重建对话——工具卡全部消失，
// 作者无法回看「这轮 AI 查了什么」。本迁移为 messages 加 tools_json 列，流式/非流式
// 落库时把本轮工具事件（name/args/result 摘要）一并写入；GET /chat 解析回传前端渲染。
// 待确认写动作卡的刷新恢复是另一缺口（需要 chat_actions 列表端点），不在本迁移范围。
function up(db) {
  const cols = db.all('PRAGMA table_info(messages)').map(row => row.name);
  if (!cols.includes('tools_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN tools_json TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = { version, checksum, up };
