const version = 'chapter_recycle_v1';
const checksum = 'sha256:chapter_recycle_v1-20260921-01';

// S1-06/C05：单章删除此前只有整书级回收保护——删章级联清空 chapter_versions，
// 正文与历史版本不可恢复。本迁移建立独立回收表（不挂 chapters 外键，删章不级联），
// 删除事务先把原章节字段、历史版本快照（versions_json）、来源关联清单
//（references_json）与级联丢失项计数（lossy_json）一并落回收记录，再删章。
// 默认不自动清理（无 TTL），首次实现不引入永久销毁恢复材料的路径。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chapter_recycle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL,
      volume_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      beat TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      locked_at TEXT,
      relock_pending INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      drift_status TEXT,
      drift_note TEXT,
      updated_at_src TEXT,
      versions_json TEXT NOT NULL DEFAULT '[]',
      references_json TEXT NOT NULL DEFAULT '[]',
      lossy_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      deleted_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_recycle_book
      ON chapter_recycle(book_id, deleted_at);
  `);
}

module.exports = { version, checksum, up };
