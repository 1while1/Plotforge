const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 台账 progress/issues 与旧状态簿的书籍存在性语义：不存在的书必须 404，而非 200 空数据 / 500
test('ledger progress/issues and legacy state return 404 for missing book', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['在库书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const progressGet = await json(http.baseUrl, 'GET', '/api/books/999999/ledger/progress');
  assert.equal(progressGet.status, 404);
  const progressPut = await json(http.baseUrl, 'PUT', '/api/books/999999/ledger/progress', { summary: 'x' });
  assert.equal(progressPut.status, 404);
  const issuesGet = await json(http.baseUrl, 'GET', '/api/books/999999/ledger/issues');
  assert.equal(issuesGet.status, 404);
  const stateGet = await json(http.baseUrl, 'GET', '/api/books/999999/state');
  assert.equal(stateGet.status, 404);
  const statePut = await json(http.baseUrl, 'PUT', '/api/books/999999/state', { characters: 'x' });
  assert.equal(statePut.status, 404);
  // 非数字 bookId 同样 404，而非把 NaN 传进 SQL
  const nanGet = await json(http.baseUrl, 'GET', '/api/books/abc/ledger/progress');
  assert.equal(nanGet.status, 404);

  // 存在的书行为不变
  const okProgress = await json(http.baseUrl, 'GET', `/api/books/${bookId}/ledger/progress`);
  assert.equal(okProgress.status, 200);
  const okState = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/state`, { characters: '主角在线' });
  assert.equal(okState.status, 200);
  // 状态簿非字符串字段 → 400 而非落库 "[object Object]"
  const badState = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/state`, { foreshadowing: { oops: 1 } });
  assert.equal(badState.status, 400);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM story_state WHERE content = '[object Object]'").n, 0);
});
