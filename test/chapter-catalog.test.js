const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const bookTools = require('../server/bookTools');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['建章回归']).lastInsertRowid;
  const firstVolume = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '前卷']).lastInsertRowid;
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '当前卷']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 13)', [bookId, firstVolume, '第13章']);
  db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 1)', [bookId, volumeId, '第一章']);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, volumeId, http };
}

test('REST与AI共用卷内排序，模型重复编号由服务端分配，原章不变', async t => {
  const { bookId, volumeId, http } = await setup(t);
  const before = db.all('SELECT * FROM chapters ORDER BY id');
  const manual = await json(http.baseUrl, 'POST', '/api/books/' + bookId + '/chapters', { volume_id: volumeId });
  assert.equal(manual.body.chapter.sort_order, 2);
  const ai = await bookTools.executeWrite(bookId, 'create_chapter', { volumeId, title: '第一章：夜航', beat: '抵达港口' });
  const created = db.get('SELECT * FROM chapters WHERE id = ?', [ai.chapter.id]);
  assert.equal(created.sort_order, 3);
  assert.equal(created.title, '第3章：夜航');
  assert.equal(created.beat, '抵达港口');
  assert.deepEqual(db.all('SELECT * FROM chapters WHERE id <= ? ORDER BY id', [before.at(-1).id]), before);
});

test('删除中间章后默认标题不与现有第3章重复', async t => {
  const { bookId, volumeId, http } = await setup(t);
  db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 3)', [bookId, volumeId, '第3章']);
  const result = await json(http.baseUrl, 'POST', '/api/books/' + bookId + '/chapters', { volume_id: volumeId });
  assert.equal(result.body.chapter.title, '第4章');
  assert.equal(result.body.chapter.sort_order, 4);
});

test('AI无卷建章自动创建分卷且无标题时使用服务端编号', async t => {
  const { http } = await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['空书']).lastInsertRowid;
  const result = await bookTools.executeWrite(bookId, 'create_chapter', {});
  assert.equal(result.chapter.title, '第1章');
  assert.ok(result.chapter.volume_id);
  const list = await json(http.baseUrl, 'GET', '/api/books/' + bookId + '/chapters');
  assert.equal(list.body.chapters.length, 1);
});

test('AI直接业务入口也拒绝跨书卷与不存在的书', async t => {
  const { bookId } = await setup(t);
  const otherBook = db.run('INSERT INTO books (title) VALUES (?)', ['另一书']).lastInsertRowid;
  const otherVolume = db.run('INSERT INTO volumes (book_id, title) VALUES (?, ?)', [otherBook, '其他卷']).lastInsertRowid;
  await assert.rejects(bookTools.executeWrite(bookId, 'create_chapter', { volumeId: otherVolume, title: '新章' }), { code: 'VOLUME_NOT_IN_BOOK' });
  await assert.rejects(bookTools.executeWrite(999999, 'create_chapter', { title: '新章' }), { code: 'BOOK_NOT_FOUND' });
});
