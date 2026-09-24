const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { executeForModel } = require('../server/tools/executor');
const { serializeToolError, toolErrorContent } = require('../server/tools/loop-helpers');
const { DomainError } = require('../server/domain/errors');

// P1a：统一 DomainError 序列化——两条模型路径（AI SDK / 传统 chat）共用 serializeToolError，
// 保留 code/message/status/details/retryable，隐藏堆栈与 SQL；软错误工具改 throw 后由 executeForModel 兜住。
async function agentCtx(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['错误序列化测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  return { profile: 'agent', sessionId: 'etest', bookId, source: 'test', actor: 'author' };
}

// ---------- serializeToolError 纯单元 ----------
test('serializeToolError 保留 DomainError 的 code/message/status/details', () => {
  const err = new DomainError('STALE_OLD_VALUE', '旧值不匹配', 409, {
    field_key: 'location', expected: 'A', actual: 'B',
  });
  const s = serializeToolError(err, 'x');
  assert.equal(s.code, 'STALE_OLD_VALUE');
  assert.equal(s.message, '旧值不匹配');
  assert.equal(s.status, 409);
  assert.deepEqual(s.details, { field_key: 'location', expected: 'A', actual: 'B' });
  assert.equal(s.retryable, true);
});

test('serializeToolError：PROPOSAL_VERSION_CONFLICT 可重试，CHAPTER_NOT_FOUND 不可', () => {
  assert.equal(serializeToolError(new DomainError('PROPOSAL_VERSION_CONFLICT', 'x', 409)).retryable, true);
  assert.equal(serializeToolError(new DomainError('CHAPTER_NOT_FOUND', 'x', 404)).retryable, false);
});

test('serializeToolError：非 DomainError 降级为 TOOL_EXECUTION_FAILED，不泄露堆栈/SQL', () => {
  const boom = new Error('SQLITE_CORRUPT: raw internal stack trace');
  const s = serializeToolError(boom, 'x');
  assert.equal(s.code, 'TOOL_EXECUTION_FAILED');
  assert.equal(s.message, '工具执行失败');
  assert.equal(s.status, 500);
  assert.equal(s.retryable, false);
  assert.equal(s.details, undefined);
  assert.ok(!JSON.stringify(s).includes('SQLITE_CORRUPT'));
});

test('toolErrorContent 渲染 code + details + 重试建议（传统 chat 字符串路径）', () => {
  const s = serializeToolError(new DomainError('STALE_OLD_VALUE', '旧值不匹配', 409, { field_key: 'location' }));
  const text = toolErrorContent(s);
  assert.ok(text.includes('STALE_OLD_VALUE'));
  assert.ok(text.includes('location'));
  assert.ok(text.includes('重试'));
});

// ---------- S4-05 / G3 边界 4：SDK 流出口的错误透传（toolErrorText）----------
// 背景：ai@6 的 toUIMessageStream 默认 onError 把所有错误压成 "An error occurred."，
// discuss 模式请求写工具时 TOOL_NOT_ALLOWED 到不了前端（G3-独立审查 P3-2）。
// 行为证据（真实 SSE + 本地 stub 上游）见台账 §11.7 的隔离实例冒烟。
const { toolErrorText } = require('../server/tools/adapters/ai-sdk');

test('toolErrorText：未知工具（discuss 请求写工具）带 TOOL_NOT_ALLOWED 码且不泄漏 SDK 细节', () => {
  const err = new Error("Model tried to call unavailable tool 'create_character'. Available tools: [list_books, ...]");
  err.name = 'AI_NoSuchToolError';
  err.toolName = 'create_character';
  const text = toolErrorText(err);
  assert.ok(text.startsWith('[TOOL_NOT_ALLOWED] '), text);
  assert.ok(text.includes('create_character'), text);
  assert.ok(text.includes('未执行任何写入'), text);
  assert.equal(text.includes('Available tools'), false, '不得回传 SDK 的可用工具列表：' + text);
  assert.equal(text.includes('\n'), false, '单行文案（SSE 分片与页面展示都按单行处理）');
});

test('toolErrorText：参数校验失败带 INVALID_ARGS，其余错误复用 serializeToolError 且掩码 sk-', () => {
  const invalid = new Error('Invalid input for tool append_chapter: chapter_id expected number');
  invalid.name = 'AI_InvalidToolInputError';
  invalid.toolName = 'append_chapter';
  const t1 = toolErrorText(invalid);
  assert.ok(t1.startsWith('[INVALID_ARGS] '), t1);
  assert.ok(t1.includes('append_chapter'), t1);

  const t2 = toolErrorText(new Error('SQLITE_CORRUPT: raw internal stack trace'));
  assert.equal(t2, '[TOOL_EXECUTION_FAILED] 工具执行失败');
  assert.equal(t2.includes('SQLITE_CORRUPT'), false);

  const t3 = toolErrorText(new Error('request failed with key sk-test-mock0123456789 rejected'));
  assert.equal(t3.includes('sk-test-mock'), false, '形状像密钥的串必须掩码：' + t3);

  const domain = new DomainError('TOOL_NOT_ALLOWED', '讨论模式为只读：写操作需要作者明确的执行请求（仍会走确认）', 403, { tool: 'create_character' });
  const t4 = toolErrorText(domain);
  assert.ok(t4.startsWith('[TOOL_NOT_ALLOWED] '), t4);
  assert.ok(t4.includes('讨论模式为只读'), t4);
});

test('Agent 流出口把 toolErrorText 接到 SDK 的 onError（结构断言；行为证据见台账 §11.7 冒烟）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/agent/agent.js'), 'utf8');
  assert.ok(/onError:\s*\(error\)\s*=>\s*toolErrorText\(error\)/.test(src),
    'server/agent/agent.js 必须把 toolErrorText 交给 pipeUIMessageStreamToResponse({ onError })');
});

// ---------- executeForModel 模型适配器边界 ----------
test('executeForModel：校验失败 → {ok:false,error.code=INVALID_ARGS}', async t => {
  const ctx = await agentCtx(t);
  const r = await executeForModel(ctx, 'create_character', {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
});

test('executeForModel：写工具确认信封原样保留在 data（不被 ok 包裹破坏）', async t => {
  const ctx = await agentCtx(t);
  const r = await executeForModel(ctx, 'create_character', { name: '林野' });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'confirmation_required');
  assert.ok(r.data.confirmation && r.data.confirmation.id);
});

test('executeForModel：软错误工具改 throw 后 → 结构化 CHAPTER_NOT_FOUND(404)', async t => {
  const ctx = await agentCtx(t);
  const r = await executeForModel(ctx, 'list_chapter_versions', { chapter_id: 999999 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CHAPTER_NOT_FOUND');
  assert.equal(r.error.status, 404);
  assert.deepEqual(r.error.details, { chapter_id: 999999 });
});
