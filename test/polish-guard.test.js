// 润色数据安全护栏（百万字评估 P0）：
// 此前输入超过 6000 字符只截前段发给模型，但前端「采纳」会用返回内容替换完整选区/整章——
// 超出部分被静默删除。修复：服务端拒绝超限输入（400 + 引导分次润色），绝不静默截断。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['润色护栏']).lastInsertRowid;
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)',
    [bookId, '长章', '字'.repeat(6500)]
  ).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, chapterId, http };
}

test('选区润色超 6000 字 → 400 拒绝并引导分段，不静默截断', async t => {
  const { bookId, chapterId, http } = await setup(t);
  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/polish`, {
    scope: 'selection',
    selected_text: '选'.repeat(6001),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /6000/);
  assert.match(r.body.error, /分次|分段/);
});

test('整章润色超 6000 字 → 400 拒绝（此前采纳会静默删除 6000 字后内容）', async t => {
  const { bookId, chapterId, http } = await setup(t);
  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/polish`, {
    scope: 'chapter',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /6000/);
  // 章节正文未受影响
  assert.equal(db.get('SELECT LENGTH(content) AS n FROM chapters WHERE id = ?', [chapterId]).n, 6500);
});
