// lock_chapter 工具统一生命周期回归：
// 此前 Agent 的 lock_chapter 直接 UPDATE locked=1 + 建索引，绕过 chapterLifecycle.relockChapter——
// 不清除 relock_pending、不拒绝空章、不定稿不抽取事实，与页面定稿/确认卡重定稿三个入口三种后果。
// 修复后必须与统一定稿服务同走一条路。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');
const indexer = require('../server/vector/indexer');
const summaryProposals = require('../server/domain/chapterSummaryProposals');

test.beforeEach(() => actionStore.clear());

async function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['定稿工具统一']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const ctx = { profile: 'agent', sessionId: 'lock-test', bookId, source: 'agent', actor: 'author' };
  return { bookId, ctx };
}

test('lock_chapter 走统一定稿：清 relock_pending、建索引、调度事实抽取', async t => {
  const { bookId, ctx } = await setup(t);
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, sort_order, relock_pending) VALUES (?, '第一章', '正文内容。', 1, 1)",
    [bookId]
  ).lastInsertRowid;
  const indexMock = t.mock.method(indexer, 'indexChapter', async () => ({ indexed: 0 }));
  const extractMock = t.mock.method(summaryProposals, 'scheduleChapterExtraction', () => 'scheduled');

  const args = { chapter_id: chapterId };
  const conf = await executeTool(ctx, 'lock_chapter', args);
  assert.equal(conf.status, 'confirmation_required');
  const result = await executeTool(ctx, 'lock_chapter', args, conf.confirmation.id);

  assert.equal(result.locked, true);
  assert.equal(result.extraction, 'scheduled');
  const row = db.get('SELECT locked, relock_pending FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(row.locked, 1, '章节应被定稿');
  assert.equal(row.relock_pending, 0, '统一定稿必须清除待重新定稿标志（旧实现不清除）');
  assert.equal(indexMock.mock.callCount(), 1, '定稿应触发向量索引');
  assert.equal(extractMock.mock.callCount(), 1, '定稿应调度人物事实抽取（旧实现不抽取）');
});

test('lock_chapter 空章节被拒绝并结算 failed（旧实现允许空章定稿）', async t => {
  const { bookId, ctx } = await setup(t);
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '空章', '', 1)",
    [bookId]
  ).lastInsertRowid;
  const extractMock = t.mock.method(summaryProposals, 'scheduleChapterExtraction', () => 'scheduled');

  const args = { chapter_id: chapterId };
  const conf = await executeTool(ctx, 'lock_chapter', args);
  await assert.rejects(
    executeTool(ctx, 'lock_chapter', args, conf.confirmation.id),
    err => err.code === 'CHAPTER_EMPTY'
  );
  assert.equal(actionStore.get(conf.confirmation.id).status, 'failed');
  assert.equal(extractMock.mock.callCount(), 0);
  assert.equal(db.get('SELECT locked FROM chapters WHERE id = ?', [chapterId]).locked, 0);
});

test('lock_chapter 目标章节不属于本书 → CHAPTER_NOT_FOUND', async t => {
  const { ctx } = await setup(t);
  const args = { chapter_id: 999999 };
  const conf = await executeTool(ctx, 'lock_chapter', args);
  assert.equal(conf.status, 'confirmation_required');
  await assert.rejects(
    executeTool(ctx, 'lock_chapter', args, conf.confirmation.id),
    err => err.code === 'CHAPTER_NOT_FOUND'
  );
});
