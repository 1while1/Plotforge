const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 卷接口类型守卫：非字符串 intro/outline 此前 POST 直接 500、PUT 落库 "[object Object]"
test('volume text fields reject non-string input with 400 instead of 500', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['卷校验书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const badPost = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes`, { title: 't', intro: 12345 });
  assert.equal(badPost.status, 400);
  assert.ok(String(badPost.body.error).includes('intro'));

  const badOutline = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes`, { outline: { a: 1 } });
  assert.equal(badOutline.status, 400);

  const missingBook = await json(http.baseUrl, 'POST', '/api/books/999999/volumes', { title: 't' });
  assert.equal(missingBook.status, 404);

  const vol = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes`, { title: '正常卷', intro: 'ok' });
  assert.equal(vol.status, 201);

  const badPut = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/volumes/${vol.body.volume.id}`, { intro: ['x'] });
  assert.equal(badPut.status, 400);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM volumes WHERE intro = \'[object Object]\'').n, 0);

  const okPut = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/volumes/${vol.body.volume.id}`, { intro: '改后的简介' });
  assert.equal(okPut.status, 200);
  assert.equal(okPut.body.volume.intro, '改后的简介');
});
