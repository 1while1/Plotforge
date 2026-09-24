const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../server/db');

function createTempLocation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-character-hub-'));
  return { dir, filePath: path.join(dir, 'novel.db') };
}

async function createLegacySeed() {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath, migrateVersions: false });
  const bookId = db.run(
    "INSERT INTO books (title, intro, created_at, updated_at) VALUES (?, '', ?, ?)",
    ['迁移测试书', new Date().toISOString(), new Date().toISOString()]
  ).lastInsertRowid;
  const characterId = db.run(
    "INSERT INTO characters (book_id, name, role, note) VALUES (?, ?, ?, ?)",
    [bookId, '林野', '主角', '旧人物备注']
  ).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 1, 1)",
    [bookId, '第一章', '林野登上灰雁号。']
  ).lastInsertRowid;
  db.run(
    "INSERT INTO embeddings (book_id, chapter_id, chunk_idx, text, vector) VALUES (?, ?, 0, ?, ?)",
    [bookId, chapterId, '旧向量块', Buffer.from(new Float32Array([1, 0]).buffer)]
  );
  db.save();
  db.close();
  return { ...location, bookId, characterId, chapterId };
}

function cleanup(location) {
  db.close();
  if (location && location.dir && fs.existsSync(location.dir)) {
    fs.rmSync(location.dir, { recursive: true, force: true });
  }
}

module.exports = { db, createTempLocation, createLegacySeed, cleanup };
