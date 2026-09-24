const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 台账工作台「新建故事线」表单契约（方向报告 1.8）：
// 后端 domain/threads.js 只认 type（枚举）与 summary；旧表单发 thread_type:'plot' + description，
// 必 400「线索类型无效」——即页面新建从未成功过。锁定：旧载荷必败、现表单载荷必成。
test('thread create rejects legacy form payload and accepts current contract', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['线索表单契约书']).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const legacy = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/threads`, {
    title: '旧表单载荷',
    description: '旧字段',
    thread_type: 'plot',
    status: 'open',
  });
  assert.equal(legacy.status, 400);
  assert.ok(String(legacy.body.error.message || legacy.body.error).includes('线索类型无效'));

  const current = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/threads`, {
    title: '找回师父的剑',
    summary: '第一卷埋下的执念',
    type: 'foreshadow',
    status: 'open',
  });
  assert.equal(current.status, 201);
  assert.equal(current.body.thread.type, 'foreshadow');
  assert.equal(current.body.thread.summary, '第一卷埋下的执念');
});
