const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { installFetchStub, jsonStub, chatPayload } = require('./helpers/llm-stub');
const { checkDrift } = require('../server/llm');

async function fixture(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  t.after(() => { stub.restore(); cleanup(location); });
  db.run("INSERT INTO settings (key,value) VALUES ('base_url', ?), ('api_key', ?), ('model', ?)", ['http://llm-stub.local/v1', 'sk-test-xxx', 'test-model']);
  const bookId = db.run('INSERT INTO books (title,master_outline) VALUES (?,?)', ['偏离测试', '主角寻找失踪的父亲']).lastInsertRowid;
  return { stub, book: db.get('SELECT * FROM books WHERE id = ?', [bookId]), chapter: { title: '第一章', summary: '踏上旅程', content: '主角离开家乡。' } };
}

for (const [verdict, status] of [['符合', 'ok'], ['轻度偏离', 'minor'], ['严重偏离', 'major']]) {
  test('偏离检查精确接受：' + verdict, async t => {
    const { stub, book, chapter } = await fixture(t);
    stub.responders.push(() => jsonStub(chatPayload({ content: verdict + '\r\n理由和建议' })));
    assert.deepEqual(await checkDrift(book, chapter), { status, note: '理由和建议' });
  });
}

for (const content of ['不符合\n本章违背大纲', '本章不符合本卷大纲。', '没有严重偏离', '{"status":"unknown","note":"不确定"}', '判断困难，建议补充大纲']) {
  test('偏离检查拒绝未分类输出：' + content, async t => {
    const { stub, book, chapter } = await fixture(t);
    stub.responders.push(() => jsonStub(chatPayload({ content })));
    await assert.rejects(checkDrift(book, chapter), { code: 'DRIFT_VERDICT_INVALID' });
    assert.equal(stub.calls.length, 1);
  });
}

test('无大纲时不调用模型、不生成通过结论', async t => {
  const { stub, book, chapter } = await fixture(t);
  assert.equal(await checkDrift({ ...book, master_outline: '' }, chapter), null);
  assert.equal(stub.calls.length, 0);
});

