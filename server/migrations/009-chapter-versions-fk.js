const version = 'chapter_versions_fk_v1';
const checksum = 'sha256:chapter-versions-fk-v1-20260909-01';

// A11（第二轮重审查）：chapter_versions 此前无外键，删章/删书后版本行永久残留
//（实测删一册书留 2 行孤儿；上轮“删 628 行孤儿”只是一次性清创，产生路径未堵）。
// SQLite 无法直接给既有表补外键，按标准做法重建表：
//   新表带 REFERENCES chapters(id) ON DELETE CASCADE → 拷贝存活行 → 删旧表 → 改名。
// 旧表中的孤儿行（chapter 已不存在）不拷贝——它们正是本次要堵住的残留，顺带清创。
function up(db) {
  const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_versions'");
  if (!table) {
    // 全新库：直接建带外键的表
    db.exec(`
      CREATE TABLE chapter_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        title TEXT DEFAULT '',
        content TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_chapter_versions ON chapter_versions(chapter_id);
    `);
    return;
  }
  db.exec(`
    CREATE TABLE chapter_versions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO chapter_versions_new (id, chapter_id, title, content, reason, created_at)
      SELECT v.id, v.chapter_id, v.title, v.content, v.reason, v.created_at
      FROM chapter_versions v
      WHERE EXISTS (SELECT 1 FROM chapters c WHERE c.id = v.chapter_id);
    DROP TABLE chapter_versions;
    ALTER TABLE chapter_versions_new RENAME TO chapter_versions;
    CREATE INDEX IF NOT EXISTS idx_chapter_versions ON chapter_versions(chapter_id);
  `);
}

module.exports = { version, checksum, up };
