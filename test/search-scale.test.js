const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const store = require('../server/vector/store');
const { searchDrafts } = require('../server/evidence/draftLexical');
const { searchStructured } = require('../server/evidence/structured');
const characters = require('../server/domain/characters');

// 检索规模治理（方向报告 2.1）：向量读缓存、草稿扫描限域、结构化 SQL 预筛。
// 语义与正确性不得因优化改变。
test('vector cache invalidates on write and draft scoping bounds scan', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['检索规模书']).lastInsertRowid;

  // 1) 向量缓存：写入/删除后 getByBook 必须反映最新集合（缓存失效正确性）
  const fakeVec = () => new Float32Array([1, 0, 0]);
  const v1 = db.run('INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)', [bookId, 'c1', 'x']).lastInsertRowid;
  const v2 = db.run('INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)', [bookId, 'c2', 'y']).lastInsertRowid;
  store.saveChunks(bookId, v1, [{ idx: 0, text: '块1', vector: fakeVec() }]);
  assert.equal(store.getByBook(bookId).length, 1);
  store.saveChunks(bookId, v2, [{ idx: 0, text: '块2', vector: fakeVec() }]);
  assert.equal(store.getByBook(bookId).length, 2, 'saveChunks 后缓存必须失效');
  store.deleteChapter(v1);
  const afterDelete = store.getByBook(bookId);
  assert.equal(afterDelete.length, 1, 'deleteChapter 后缓存必须失效');
  assert.equal(afterDelete[0].chapter_id, v2);

  // 2) 草稿限域：其他卷草稿按最近编辑最多取 30 章；当前卷全扫
  const volA = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '卷A']).lastInsertRowid;
  const volB = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '卷B']).lastInsertRowid;
  for (let i = 0; i < 35; i++) {
    db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\', ?))',
      [bookId, volA, 'A' + i, '北境密令草稿' + i, i + 1, '-' + i + ' minutes']);
  }
  const inB = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 1)',
    [bookId, volB, 'B章', '北境密令在卷B']).lastInsertRowid;

  const scoped = searchDrafts(bookId, '北境密令', { chapterId: inB, limit: 100 });
  const fromA = new Set(scoped.filter(h => h.sourceId !== String(inB)).map(h => h.sourceId));
  assert.ok(fromA.size <= 30, `其他卷草稿扫描应 ≤30 章，实际 ${fromA.size}`);
  assert.ok(scoped.some(h => h.sourceId === String(inB)), '当前卷章节必须全扫命中');

  // 无上下文：最近 50 章兜底
  const noCtx = searchDrafts(bookId, '北境密令', { limit: 100 });
  assert.ok(new Set(noCtx.map(h => h.sourceId)).size <= 50);

  // 3) 结构化预筛：命中语义不变（含别名精确匹配）
  const charId = characters.createCharacter(bookId, { name: '林野', appearance: '左脸有旧疤' }).character.id;
  db.run("INSERT INTO character_aliases (book_id, character_id, alias, alias_normalized, created_at) VALUES (?, ?, ?, ?, datetime('now'))", [bookId, charId, '小野子', '小野子']);
  const byText = searchStructured(bookId, '旧疤');
  assert.ok(byText.some(h => h.sourceType === 'character' && h.title.includes('appearance')), '档案文本匹配应保留');
  const byAlias = searchStructured(bookId, '小野子');
  assert.ok(byAlias.some(h => h.relevance === 1 && h.matchReason.includes('别名')), '别名精确匹配应保留');
  const none = searchStructured(bookId, '不存在的词');
  assert.equal(none.filter(h => h.sourceType === 'character').length, 0, '不匹配人物不应返回');

  cleanup(location);
});
