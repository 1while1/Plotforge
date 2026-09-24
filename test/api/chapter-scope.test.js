const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 章节作用域守卫：跨书挂卷与不存在书的错误语义
test('chapter volume_id must belong to the same book (cross-book attach rejected)', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookA = db.run('INSERT INTO books (title) VALUES (?)', ['书A']).lastInsertRowid;
  const bookB = db.run('INSERT INTO books (title) VALUES (?)', ['书B']).lastInsertRowid;
  db.transaction(() => { seedBook(db, bookA); seedBook(db, bookB); });
  const volB = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookB, 'B的卷']).lastInsertRowid;
  const chA = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)', [bookA, 'A的章', 'x']).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // POST 建章指定他书卷 → 400
  const created = await json(http.baseUrl, 'POST', `/api/books/${bookA}/chapters`, { title: '新章', volume_id: volB });
  assert.equal(created.status, 400);
  assert.equal(created.body.code, 'VOLUME_NOT_IN_BOOK');

  // PUT 改章挂他书卷 → 400，且章节未被改动
  const moved = await json(http.baseUrl, 'PUT', `/api/books/${bookA}/chapters/${chA}`, { volume_id: volB, expected_revision: 1 });
  assert.equal(moved.status, 400);
  assert.equal(moved.body.code, 'VOLUME_NOT_IN_BOOK');
  assert.equal(db.get('SELECT volume_id AS v FROM chapters WHERE id = ?', [chA]).v, null);

  // PUT 挂回本书自己的卷 → 200
  const volA = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookA, 'A的卷']).lastInsertRowid;
  const ok = await json(http.baseUrl, 'PUT', `/api/books/${bookA}/chapters/${chA}`, { volume_id: volA, expected_revision: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.chapter.volume_id, volA);
});

test('chapter endpoints return 404 for missing book instead of 500/200', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const created = await json(http.baseUrl, 'POST', '/api/books/999999/chapters', { title: 'x' });
  assert.equal(created.status, 404);
});
