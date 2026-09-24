const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { assembleDetailed } = require('../server/context');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['任务目标']).lastInsertRowid;
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '当前卷']).lastInsertRowid;
  const ids = [];
  for (let index = 1; index <= 4; index++) {
    ids.push(db.run('INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [bookId, volumeId, '第' + index + '章', index === 4 ? '' : '连续正文衔接' + index, index === 1 ? '第一章摘要' : '', index]).lastInsertRowid);
  }
  return { book: db.get('SELECT * FROM books WHERE id = ?', [bookId]), ids };
}

test('选择旧章但要求最近前文时定位最新正文，不把旧章当最新进度', async t => {
  const { book, ids } = await setup(t);
  const ctx = { book, db, chapterId: ids[0], query: '根据最近的章节继续写', systemTokenBudget: 20000 };
  const result = await assembleDetailed(ctx);
  assert.equal(ctx.writingTarget.selectedChapterId, ids[0]);
  assert.equal(ctx.writingTarget.targetChapterId, ids[2]);
  assert.ok(result.text.includes('界面选中'));
  assert.ok(result.text.includes('连续正文衔接3'));
});

test('明确改写旧章保留该目标，空章前文缺摘要时仍连续可见', async t => {
  const { book, ids } = await setup(t);
  const old = { book, db, chapterId: ids[2], query: '重写第一卷第一章', systemTokenBudget: 20000 };
  await assembleDetailed(old);
  assert.equal(old.writingTarget.targetChapterId, ids[0]);
  const empty = { book, db, chapterId: ids[3], query: '', systemTokenBudget: 20000 };
  const result = await assembleDetailed(empty);
  assert.ok(result.text.includes('连续正文衔接2'));
  assert.ok(result.text.includes('连续正文衔接3'));
  assert.ok(result.text.includes('暂无摘要'));
  assert.ok(result.text.includes('chapterId=' + ids[3]));
});

test('无效选中章不默默回退，多卷第1章歧义要求指定卷', async t => {
  const { book, ids } = await setup(t);
  const { resolveWritingTarget } = require('../server/context/writing-target');
  assert.throws(() => resolveWritingTarget(book.id, 999999, ''), { code: 'CHAPTER_NOT_FOUND' });
  const volume = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [book.id, '第二卷']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 1)', [book.id, volume, '新卷第一章']);
  assert.throws(() => resolveWritingTarget(book.id, ids[0], '改写第1章'), { code: 'AMBIGUOUS_CHAPTER' });
});

test('写尚未创建的紧邻下一章保留明确待建位置，不猜新ID', async t => {
  const { book, ids } = await setup(t);
  const { resolveWritingTarget } = require('../server/context/writing-target');
  const target = resolveWritingTarget(book.id, ids[0], '新建第一卷第5章');
  assert.equal(target.targetChapterId, null);
  assert.equal(target.plannedChapterOrdinal, 5);
  assert.equal(target.anchorChapterId, ids[2]);
});

test('S3-05：会话间叙事边界独立——两次组装互不污染（无共享 target 状态）', async t => {
  const { book, ids } = await setup(t);
  const ctxA = { book, db, chapterId: ids[0], query: '按旧章写', systemTokenBudget: 20000 };
  const ctxB = { book, db, chapterId: ids[2], query: '按新章写', systemTokenBudget: 20000 };
  await assembleDetailed(ctxA);
  await assembleDetailed(ctxB);
  // B 组装后 A 的目标不受影响（writingTarget 是请求级 ctx 字段，不是共享会话状态）
  assert.equal(ctxA.writingTarget.selectedChapterId, ids[0], '会话 A 的选中章不被 B 改写');
  assert.equal(ctxB.writingTarget.selectedChapterId, ids[2], '会话 B 的选中章独立保持');
  // 再组装一次 A 仍回到 A 的边界（上次会话的选中章不作为新任务事实）
  const ctxA2 = { book, db, chapterId: ids[1], query: '换一章', systemTokenBudget: 20000 };
  await assembleDetailed(ctxA2);
  assert.equal(ctxA2.writingTarget.selectedChapterId, ids[1], '新请求按显式指定，不沿用旧边界');
});
