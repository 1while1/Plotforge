const version = 'relock_pending_v1';
const checksum = 'sha256:relock-pending-v1-20260902-01';

// 定稿后正文又被修改（AI 写入或手动编辑）时，章节会被自动解除定稿；
// relock_pending = 1 标记「本章曾定稿、现已改动、尚未重新定稿」，供前端警示与一键重定稿
function up(db) {
  const columns = db.all('PRAGMA table_info(chapters)').map(item => item.name);
  if (!columns.includes('relock_pending')) {
    db.run('ALTER TABLE chapters ADD COLUMN relock_pending INTEGER NOT NULL DEFAULT 0');
  }
}

module.exports = { version, checksum, up };
