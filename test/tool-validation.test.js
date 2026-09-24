const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { executeTool } = require('../server/tools/executor');

// create_character 的 inputSchema：required ['name']，additionalProperties:false，properties 非空
async function agentCtx(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['校验测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  return { profile: 'agent', sessionId: 'vtest', bookId, source: 'test', actor: 'author' };
}

test('P0 回归锁：缺必需参数被拒（validateArgs 已激活，读 inputSchema）', async t => {
  const context = await agentCtx(t);
  await assert.rejects(
    executeTool(context, 'create_character', { role: '主角' }),
    err => err.code === 'INVALID_ARGS' && /缺少必需参数/.test(err.message)
  );
});

test('参数类型错误被拒（name 应为 string）', async t => {
  const context = await agentCtx(t);
  await assert.rejects(
    executeTool(context, 'create_character', { name: 123 }),
    err => err.code === 'INVALID_ARGS' && /类型错误/.test(err.message)
  );
});

test('additionalProperties:false 拒绝未声明的多余键', async t => {
  const context = await agentCtx(t);
  await assert.rejects(
    executeTool(context, 'create_character', { name: '林野', hack: 1 }),
    err => err.code === 'INVALID_ARGS' && /不支持的参数/.test(err.message)
  );
});

test('合法参数通过校验（进入确认流，非 INVALID_ARGS）', async t => {
  const context = await agentCtx(t);
  const r = await executeTool(context, 'create_character', { name: '林野', role: '主角' });
  assert.equal(r.status, 'confirmation_required');
});

test('execute 契约：opts 的 signal/onUpdate/toolCallId 注入 normalized context', async t => {
  const context = await agentCtx(t);
  const ac = new AbortController();
  let seen = null;
  // 通过 requestConfirmation 路径无法直接观测，改为断言 normalizeContext 的字段透传
  const { normalizeContext } = require('../server/tools/executor');
  const tool = { scope: 'book', name: 'x' };
  // 需要真实存在的 book 才能通过 bookExists 校验
  seen = normalizeContext({ profile: 'agent', bookId: context.bookId }, tool, {}, {
    signal: ac.signal, toolCallId: 'call_42', onUpdate: () => {},
  });
  assert.equal(seen.signal, ac.signal);
  assert.equal(seen.toolCallId, 'call_42');
  assert.equal(typeof seen.onUpdate, 'function');
});
