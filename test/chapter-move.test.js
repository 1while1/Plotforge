const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { executeTool } = require('../server/tools/executor');
const ledger = require('../server/domain/storyLedger');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['移动回归']).lastInsertRowid;
  const otherBookId = db.run('INSERT INTO books (title) VALUES (?)', ['其他书']).lastInsertRowid;
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '原卷']).lastInsertRowid;
  const targetId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '目标卷']).lastInsertRowid;
  const foreignId = db.run('INSERT INTO volumes (book_id, title) VALUES (?, ?)', [otherBookId, '他书卷']).lastInsertRowid;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 1)', [bookId, volumeId, '原章']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, volume_id, title, sort_order) VALUES (?, ?, ?, 8)', [bookId, targetId, '目标已有章']);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, chapterId, targetId, foreignId, http, ctx: { profile: 'agent', bookId, sessionId: 'agent:move', source: 'agent' } };
}

test('AI移章在确认之前拒绝跨书卷，原目录不变', async t => {
  const { chapterId, foreignId, ctx } = await setup(t);
  const before = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  await assert.rejects(executeTool(ctx, 'move_chapter', { chapter_id: chapterId, volume_id: foreignId }), { code: 'VOLUME_NOT_IN_BOOK' });
  assert.deepEqual(db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]), before);
});

test('REST与AI拒绝非整数或负排序，拒绝时不能改正文', async t => {
  const { bookId, chapterId, ctx, http } = await setup(t);
  for (const sortOrder of [-1, 1.5, '2']) {
    const result = await json(http.baseUrl, 'PUT', '/api/books/' + bookId + '/chapters/' + chapterId, { sort_order: sortOrder, content: '不应写入', expected_revision: 1 });
    assert.equal(result.status, 400);
    await assert.rejects(executeTool(ctx, 'move_chapter', { chapter_id: chapterId, sort_order: sortOrder }));
    assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '');
  }
});

test('AI确认移章默认追加目标卷并重建投影，重建失败回滚章节', async t => {
  const { chapterId, targetId, ctx } = await setup(t);
  const actionStore = require('../server/actionStore');
  const args = { chapter_id: chapterId, volume_id: targetId };
  const confirmation = await executeTool(ctx, 'move_chapter', args);
  // S1-03：确认执行必须用信封绑定的 args（含系统注入的 expected_revision），与生产确认路由一致
  const result = await executeTool(ctx, 'move_chapter', actionStore.get(confirmation.confirmation.id).args, confirmation.confirmation.id);
  assert.equal(result.sort_order, 9);
  assert.equal(result.projection_rebuilt, true);
  const original = ledger.rebuildProjectionsInTransaction;
  ledger.rebuildProjectionsInTransaction = () => { throw new Error('projection failed'); };
  try {
    const pending = await executeTool(ctx, 'move_chapter', { chapter_id: chapterId, sort_order: 0 });
    await assert.rejects(
      executeTool(ctx, 'move_chapter', actionStore.get(pending.confirmation.id).args, pending.confirmation.id),
      /projection failed/
    );
    assert.equal(db.get('SELECT sort_order FROM chapters WHERE id = ?', [chapterId]).sort_order, 9);
  } finally { ledger.rebuildProjectionsInTransaction = original; }
});
