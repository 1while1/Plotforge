const version = 'polish_history_fk_v1';
const checksum = 'sha256:polish-history-fk-v1-20260909-01';

// 与 chapter_versions 同病（§6.9 遗留 3）：polish_history.chapter_id 无外键，
// 删章/删书后精修历史行永久残留成孤儿（写入点 routes/polish.js、查询点按 chapter_id）。
// 镜像 009 的标准重建：新表带 REFERENCES chapters(id) ON DELETE CASCADE →
// 只拷贝存活行（顺带清历史孤儿）→ 删旧表 → 改名 → 补索引。
function up(db) {
  const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'polish_history'");
  if (!table) {
    // 全新库：直接建带外键的表
    db.exec(`
      CREATE TABLE polish_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        scope TEXT DEFAULT 'chapter',
        original TEXT DEFAULT '',
        polished TEXT DEFAULT '',
        requirement TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_polish_history ON polish_history(chapter_id);
    `);
    return;
  }
  db.exec(`
    CREATE TABLE polish_history_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      scope TEXT DEFAULT 'chapter',
      original TEXT DEFAULT '',
      polished TEXT DEFAULT '',
      requirement TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO polish_history_new (id, chapter_id, scope, original, polished, requirement, created_at)
      SELECT v.id, v.chapter_id, v.scope, v.original, v.polished, v.requirement, v.created_at
      FROM polish_history v
      WHERE EXISTS (SELECT 1 FROM chapters c WHERE c.id = v.chapter_id);
    DROP TABLE polish_history;
    ALTER TABLE polish_history_new RENAME TO polish_history;
    CREATE INDEX IF NOT EXISTS idx_polish_history ON polish_history(chapter_id);
  `);
}

module.exports = { version, checksum, up };
