const version = 'messages_book_index_v1';
const checksum = 'sha256:messages-book-index-v1-20260909-01';

// D4-11：messages 表此前无任何二级索引。按书取对话历史
//（routes/chat.js 的 context-breakdown 与 buildChatMessages：WHERE book_id=? [AND compressed!=1] ORDER BY id DESC LIMIT N）
// 在消息量增大后每次都要全表扫描 + 按 id 排序。建 (book_id, id) 复合索引：
// 定位到某书后可直接沿 id 序（DESC 反向扫描）取最近 N 条，免排序、LIMIT 可提前终止。
//
// 落盘路径：走迁移而非 SCHEMA。db.js init 在 db.exec(SCHEMA) 后置 dirty=false
//（SCHEMA 全 IF NOT EXISTS，对已存在库是幂等 no-op，不该仅因跑它就全量重写库文件），
// 故只把索引加进 SCHEMA 的话，已存在库的索引会建在内存却不落盘、每次重启重建。
// 迁移经 applyPending 会置 migrated=true 触发 save()，且版本化(schema_versions)+首次自动备份+幂等(IF NOT EXISTS)。
function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_book ON messages(book_id, id);
  `);
}

module.exports = { version, checksum, up };
