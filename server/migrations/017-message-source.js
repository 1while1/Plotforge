const version = 'message_source_v1';
const checksum = 'sha256:message-source-20260911-01';

// 消息来源页落库（2026-09-11 前端统一消费器契约）：三页（写作台 writing / 阅读页 read / 助手页 agent）
// 共用 POST /:bookId/chat/stream，但 messages 此前没有来源字段——作者事后无法分辨「这条是哪个页面
// 说的」，前端也无法按来源页区分渲染。本迁移为 messages 加 source 列（默认空串，历史行保持 ''）。
// 续跑信封等系统事件由调用方显式写 'system'。
// 幂等：先 PRAGMA 检查列是否存在（照 015 的写法），重复执行不报错。
function up(db) {
  const cols = db.all('PRAGMA table_info(messages)').map(row => row.name);
  if (!cols.includes('source')) {
    db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = { version, checksum, up };
