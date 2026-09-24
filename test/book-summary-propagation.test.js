const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const lifecycle = require('../server/domain/chapterLifecycle');
const registry = require('../server/tools/registry');
const memoryProvider = require('../server/context/providers/memory');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

// 全书摘要底料传播（方向报告 4.1 书层收尾）：卷层（012）已闭环「章总结变化 → 卷总结过期」，
// 书层此前缺失——story_state.book_summary 讲的还是旧故事时作者无从得知。
// 闭环：保存全书摘要（四个路径：PUT /ledger/progress、PUT /state、update_book_progress 工具、
// llm.js updateStoryState 预留）记录「全部卷总结 + 全部章总结」联合指纹；任一底料变化 → stale=1。
// 手写/自动一视同仁：底料变了就是过期；区别只在过期后由谁重生成。

async function initBook(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const volId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const ch1 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, summary) VALUES (?, ?, ?, ?, 1, ?)',
    [bookId, '第一章', '第一章正文。', volId, '林野夺船北上。']).lastInsertRowid;
  const ch2 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, summary) VALUES (?, ?, ?, ?, 2, ?)',
    [bookId, '第二章', '第二章正文。', volId, '北境冻港遇袭。']).lastInsertRowid;
  return { bookId, volId, ch1, ch2 };
}

test('保存全书摘要记录底料指纹；章总结变化 → 书摘要过期；重存恢复', async t => {
  const { bookId, ch1 } = await initBook(t, '书层传播');

  // 保存路径一：作者手写 PUT /ledger/progress
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '林野北上，冻港遇袭。' });
  assert.equal(put.status, 200);
  let row = db.get("SELECT based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.ok(row.based_on, '保存时应记录底料指纹');
  assert.equal(row.stale, 0);
  let view = await json(http.baseUrl, 'GET', `/api/books/${bookId}/ledger/progress`);
  assert.equal(view.body.stale, false, 'GET /progress 应回传 stale=false');

  // 底料未变的写入不误标：写入相同章总结
  const saveCh = registry.descriptor('save_chapter_summary');
  saveCh.execute({ bookId, args: { chapter_id: ch1, summary: '林野夺船北上。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) } });
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 0, '底料未变化不应标过期');

  // 章总结变化 → 书摘要过期（直达传播，不依赖卷总结先重生成）
  const toolResult = saveCh.execute({ bookId, args: { chapter_id: ch1, summary: '林野改走陆路。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) } });
  assert.equal(toolResult.book_summary_stale, true, 'save_chapter_summary 应回传书摘要已标过期');
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 1, '书摘要应处于过期态');
  view = await json(http.baseUrl, 'GET', `/api/books/${bookId}/ledger/progress`);
  assert.equal(view.body.stale, true);

  // 健康面板（3.3 观察面）：summary 块计入过期书摘要
  const health = await json(http.baseUrl, 'GET', `/api/books/${bookId}/health`);
  assert.equal(health.body.summary.stale_book_summary, 1);

  // 幂等：重复标记不再写
  assert.equal(lifecycle.markBookSummaryStale(bookId), false);

  // 重存（同一手写路径）→ 指针刷新、过期清除
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '林野走陆路北上。' });
  row = db.get("SELECT based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 0, '重存后应恢复不过期');
  assert.notEqual(row.based_on, '', '指纹应已刷新');
});

test('卷总结保存是书层底料 → 变化后书摘要过期；Agent 工具路径同样刷新指纹', async t => {
  const { bookId, volId, ch1 } = await initBook(t, '书层卷底料');

  // 保存路径二：Agent 工具 update_book_progress
  const updateProgress = registry.descriptor('update_book_progress');
  updateProgress.execute({ bookId, args: { summary: '卷一：林野北上。' } });
  let row = db.get("SELECT based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.ok(row.based_on, '工具路径也应记录底料指纹');
  assert.equal(row.stale, 0);

  // 卷总结保存 → 书层底料变化 → 过期
  const saveVol = registry.descriptor('save_volume_summary');
  saveVol.execute({ bookId, args: { volume_id: volId, summary: '林野北上遇袭。' } });
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 1, '卷总结变化应传播到书摘要');

  // 再存章总结（同内容，底料不变）+ 重新保存书摘要 → 恢复
  registry.descriptor('save_chapter_summary').execute({ bookId, args: { chapter_id: ch1, summary: '林野夺船北上。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) } });
  updateProgress.execute({ bookId, args: { summary: '卷一：林野北上，冻港遇袭。' } });
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 0, '工具重存后应恢复不过期');
});

test('正文变化清空章总结（解锁）也传播到书摘要；手写 PUT /state 路径刷新指纹', async t => {
  const { bookId, ch1 } = await initBook(t, '书层手写');
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });

  // 保存路径三：作者手写 PUT /state 的 book_summary
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/state`, { book_summary: '进展：两章。' });
  let row = db.get("SELECT based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.ok(row.based_on, 'PUT /state 的 book_summary 也应记录指纹');
  assert.equal(row.stale, 0);

  // 正文变化（解锁）→ 章总结被清空 → 书摘要过期
  lifecycle.unlockChapter(bookId, ch1, '测试解锁');
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 1, '章总结清空应传播到书摘要');
});

test('memory provider 注入：过期书摘要用「底料已变化」明确提示，未过期用时间提示', async t => {
  const { bookId, ch1 } = await initBook(t, '书层注入');

  registry.descriptor('update_book_progress').execute({ bookId, args: { summary: '林野北上。' } });
  let built = memoryProvider.build({ book: { id: bookId }, chapterId: ch1, db });
  assert.ok(built.includes('全书进展摘要'));
  assert.ok(!built.includes('底料已变化'), '未过期时不应出现过期提示');

  registry.descriptor('save_chapter_summary').execute({ bookId, args: { chapter_id: ch1, summary: '林野走陆路。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) } });
  built = memoryProvider.build({ book: { id: bookId }, chapterId: ch1, db });
  assert.ok(built.includes('底料已变化'), '过期后应以确定信号提示模型');
});
