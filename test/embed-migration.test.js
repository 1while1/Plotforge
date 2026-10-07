const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const migration = require('../server/migrations/033-embedding-runtime-q8');
const { applyPending } = require('../server/migrations');

test('embedding 升级只失效派生向量，保留章节/范文；迁移只执行一次', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run("INSERT INTO books (title) VALUES ('向量迁移测试')").lastInsertRowid;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, locked) VALUES (?, '钥匙', '林野在冻港找到银钥匙。', 1)", [bookId]).lastInsertRowid;
  const packId = db.run("INSERT INTO style_packs (name) VALUES ('迁移范文')").lastInsertRowid;
  const blob = Buffer.from(new Float32Array(512).fill(0.125).buffer);
  db.run('INSERT INTO embeddings (book_id, chapter_id, chunk_idx, text, vector) VALUES (?, ?, 0, ?, ?)', [bookId, chapterId, '旧索引', blob]);
  const sampleId = db.run("INSERT INTO style_samples (pack_id, title, text, vector, vector_model, indexed_at) VALUES (?, '保留标题', '保留范文正文', ?, '旧模型', '旧时间')", [packId, blob]).lastInsertRowid;
  const chapterBefore = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  db.run('DELETE FROM schema_versions WHERE version = ?', [migration.version]);
  applyPending(db, { filePath: location.filePath });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM embeddings').n, 0);
  assert.deepEqual(db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]), chapterBefore);
  assert.deepEqual(db.get('SELECT title, text, vector, vector_model, indexed_at FROM style_samples WHERE id = ?', [sampleId]), {
    title: '保留标题', text: '保留范文正文', vector: null, vector_model: '', indexed_at: null,
  });
  assert.ok(db.get('SELECT version FROM schema_versions WHERE version = ?', [migration.version]));
  // 新运行时重建后，下次启动不能再次清掉新向量。
  db.run('INSERT INTO embeddings (book_id, chapter_id, chunk_idx, text, vector) VALUES (?, ?, 0, ?, ?)', [bookId, chapterId, '新索引', blob]);
  db.run("UPDATE style_samples SET vector = ?, vector_model = '新模型', indexed_at = '新时间' WHERE id = ?", [blob, sampleId]);
  applyPending(db, { filePath: location.filePath });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM embeddings').n, 1);
  assert.equal(db.get('SELECT vector_model FROM style_samples WHERE id = ?', [sampleId]).vector_model, '新模型');
});
