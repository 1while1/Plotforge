// 旧工具失败语义统一（对齐 pi「错误即粮食」）：
// 此前 bookTools 以 {error:...} 普通返回值表达业务失败，统一执行器只认抛出的异常——
// 结果是确认动作被结算 approved、审计表记 success、独立 Agent 续跑系统事件谎称「已真实执行成功」。
// 本文件锁定三层语义：
//   1. 读路径：executeForModel 收到结构化失败（ok:false + code）
//   2. 写路径：确认执行失败 → 动作结算 failed + 审计 failed + 正确 error_code
//   3. registry 安全网：任何残留的 {error} 返回值被收敛为 DomainError（防未来回归）
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const actionStore = require('../server/actionStore');
const { executeTool, executeForModel } = require('../server/tools/executor');
const { descriptor } = require('../server/tools/registry');
const { DomainError } = require('../server/domain/errors');

test.beforeEach(() => actionStore.clear());

async function setup(t, title = '旧工具失败语义') {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  const ctx = {
    profile: 'writing',
    sessionId: `writing:book:${bookId}`,
    bookId,
    source: 'writing-chat',
    actor: 'author',
  };
  return { bookId, ctx };
}

test('读路径：read_chapter 目标不存在 → executeForModel 返回结构化失败', async t => {
  const { ctx } = await setup(t);
  const r = await executeForModel(ctx, 'read_chapter', { chapterId: 999999 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CHAPTER_NOT_FOUND');
  assert.equal(r.error.status, 404);
});

test('写路径：确认后目标卷不存在 → 抛错且动作结算 failed、审计 failed（不再假成功）', async t => {
  const { bookId, ctx } = await setup(t);
  const args = { volumeId: 999999, title: '改标题' };
  const conf = await executeTool(ctx, 'update_volume', args);
  assert.equal(conf.status, 'confirmation_required');
  const confirmationId = conf.confirmation.id;

  await assert.rejects(
    executeTool(ctx, 'update_volume', args, confirmationId),
    err => err instanceof DomainError && err.code === 'VOLUME_NOT_FOUND'
  );

  // 动作结算：failed（此前被误结算为 approved，Agent 续跑会谎报成功）
  const action = actionStore.get(confirmationId);
  assert.equal(action.status, 'failed');

  // 审计：failed + 正确 error_code（此前记 success）
  const rows = db.all(
    'SELECT status, error_code FROM tool_audit_logs WHERE confirmation_id = ? ORDER BY id',
    [confirmationId]
  );
  assert.ok(rows.length >= 2, '应有 requested + failed 两阶段审计');
  assert.equal(rows[0].status, 'requested');
  assert.equal(rows[rows.length - 1].status, 'failed');
  assert.equal(rows[rows.length - 1].error_code, 'VOLUME_NOT_FOUND');
});

test('写路径：版本锁冲突 → CHAPTER_CONFLICT 抛错且结算/审计 failed（S1-03 单调版本）', async t => {
  const { bookId, ctx } = await setup(t);
  const chId = db.run(
    "INSERT INTO chapters (book_id, title, content) VALUES (?, '第一章', '人工正文')", [bookId]
  ).lastInsertRowid;
  const args = { chapterId: chId, text: 'AI 追加' };
  const conf = await executeTool(ctx, 'append_chapter', args);
  const confirmationId = conf.confirmation.id;
  // 确认等待期间人工改章（revision 前进），绑定版本过期
  db.run('UPDATE chapters SET content = ?, revision = revision + 1 WHERE id = ?', ['人工改后的正文', chId]);

  await assert.rejects(
    executeTool(ctx, 'append_chapter', conf.confirmation && actionStore.get(confirmationId).args, confirmationId),
    err => err.code === 'CHAPTER_CONFLICT' && err.status === 409
  );
  assert.equal(actionStore.get(confirmationId).status, 'failed');
  const auditRow = db.get(
    "SELECT status, error_code FROM tool_audit_logs WHERE confirmation_id = ? ORDER BY id DESC LIMIT 1",
    [confirmationId]
  );
  assert.equal(auditRow.status, 'failed');
  assert.equal(auditRow.error_code, 'CHAPTER_CONFLICT');
  // 正文未被覆盖
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chId]).content, '人工改后的正文');
});

test('registry 安全网：残留的 {error} 普通返回值被收敛为 DomainError', async () => {
  const tool = descriptor('get_story_state');
  assert.ok(tool, 'get_story_state 应已注册');
  const fakeContext = { bookId: 1, args: {}, profile: 'writing', sessionId: 'x' };
  // 直接调用旧包装层：模拟未来回归——某个 legacy 工具返回 {error}
  const bookTools = require('../server/bookTools');
  const orig = bookTools.executeRead;
  bookTools.executeRead = async () => ({ error: '模拟的旧式失败返回' });
  try {
    await assert.rejects(
      tool.execute(fakeContext),
      err => err instanceof DomainError && err.code === 'TOOL_BUSINESS_ERROR'
        && /模拟的旧式失败返回/.test(err.message)
    );
  } finally {
    bookTools.executeRead = orig;
  }
});
