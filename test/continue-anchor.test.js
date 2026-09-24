const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { assembleDetailed } = require('../server/context');
const { CONTINUE_RE, narrativeAnchors, buildRetrievalQuery } = require('../server/context/providers/retrieval')._internals;

// 续写锚点（方向报告 4.3）：低信息量续写指令（接着写/继续）此前检索完全空转——
// 全靠固定注入，上一章怎么收的、本章写到哪里没有任何定向召回。

test('续写指令识别：整句低信息量才命中，带具体要求的指令不命中', () => {
  assert.equal(CONTINUE_RE.test('接着写'), true);
  assert.equal(CONTINUE_RE.test('继续写'), true);
  assert.equal(CONTINUE_RE.test('继续'), true);
  assert.equal(CONTINUE_RE.test('往下写。'), true);
  assert.equal(CONTINUE_RE.test('接着往下写！'), true);
  // 自带信息量的指令不需要锚点补强
  assert.equal(CONTINUE_RE.test('继续写第二章，林野要反杀'), false);
  assert.equal(CONTINUE_RE.test('写一段追逐戏'), false);
  assert.equal(CONTINUE_RE.test('接着写林野和贝塔的对峙'), false);
});

test('叙事锚点：取上一章结尾与本章尾部，跨卷回退到上一卷最后一章', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['锚点书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));

  const v1 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order) VALUES (?, ?, ?, ?, 1)',
    [bookId, '第一章', '开篇铺垫。'.repeat(120) + '第一章收尾：灰雁号驶入北境冻港。', v1]);
  const ch2 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order) VALUES (?, ?, ?, ?, 2)',
    [bookId, '第二章', '中段发展。'.repeat(30) + '第二章写到：林野握紧了舵轮。', v1]).lastInsertRowid;

  const anchors = narrativeAnchors(bookId, ch2);
  assert.ok(anchors, '应取到锚点');
  assert.ok(anchors.prevTail.includes('灰雁号驶入北境冻港'), '上一章结尾应进锚点');
  assert.ok(anchors.curTail.includes('林野握紧了舵轮'), '本章尾部应进锚点');
  assert.ok(anchors.prevTail.length <= 300, '上一章锚点只取尾部（≤300 字）');
  assert.ok(anchors.prevTail.endsWith('灰雁号驶入北境冻港。'), '锚点以收尾句结束');

  // 拼装：锚点文本并入检索 query
  const q = buildRetrievalQuery('接着写', anchors);
  assert.ok(q.startsWith('接着写'));
  assert.ok(q.includes('上一章结尾：'));
  assert.ok(q.includes('本章已写到：'));

  // 当前章是第一卷首章：无上一章 → 只有本章尾部
  const ch1 = db.get('SELECT id FROM chapters WHERE book_id = ? AND sort_order = 1', [bookId]);
  const first = narrativeAnchors(bookId, ch1.id);
  assert.equal(first.prevTail, '');
  assert.ok(first.curTail.includes('灰雁号'), '首章仍有本章尾部锚点');
});

test('组装集成：续写指令触发锚点并入检索，普通指令不触发', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['集成书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const v1 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order) VALUES (?, ?, ?, ?, 1)',
    [bookId, '第一章', '第一章收尾：雪崩吞了隘口。', v1]);
  const ch2 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order) VALUES (?, ?, ?, ?, 2)',
    [bookId, '第二章', '发展。'.repeat(40) + '第二章写到：他回头望向隘口。', v1]).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const ctxContinue = { book, db, chapterId: ch2, query: '接着写', systemTokenBudget: 20000 };
  await assembleDetailed(ctxContinue);
  assert.ok(ctxContinue.retrievalAnchor && ctxContinue.retrievalAnchor.triggered, '续写指令应触发锚点');
  assert.ok(ctxContinue.retrievalAnchor.prev_tail.includes('雪崩'), '锚点摘要应含上一章结尾');

  const ctxNormal = { book, db, chapterId: ch2, query: '写一场雪原追逐战', systemTokenBudget: 20000 };
  await assembleDetailed(ctxNormal);
  assert.equal(ctxNormal.retrievalAnchor, undefined, '普通指令不应触发锚点');
});
