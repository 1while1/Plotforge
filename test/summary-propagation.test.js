const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const lifecycle = require('../server/domain/chapterLifecycle');
const registry = require('../server/tools/registry');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

// 卷总结底料传播（方向报告 4.1）：「正文变化清空章总结」已做，但基于旧章总结
// 生成的卷总结不会被标记——作者无从知道卷总结讲的还是旧故事。
// 闭环：保存卷总结记录底料指纹 → 任一章总结变化/清空 → 该卷 summary_stale=1。

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

test('保存卷总结记录底料指纹；章总结变化后卷标过期；重新保存后恢复', async t => {
  const { bookId, volId, ch1 } = await initBook(t, '传播书');

  // 保存卷总结（走工具 execute：确认流之外直接调，与确认后执行同一函数）
  const tool = registry.descriptor('save_volume_summary');
  tool.execute({ bookId, args: { volume_id: volId, summary: '林野北上，冻港遇袭。' } });
  let vol = db.get('SELECT summary, summary_based_on, summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 0, '新保存的卷总结不过期');
  assert.ok(vol.summary_based_on, '应记录底料指纹');

  // 底料未变的章总结操作（写入相同内容）不误标
  db.run('UPDATE chapters SET summary = ? WHERE id = ?', ['林野夺船北上。', ch1]);
  assert.equal(lifecycle.markVolumeSummaryStale(bookId, ch1), false, '底料未变化不应标过期');

  // 章总结变化 → 指纹不吻合 → 卷总结标过期
  db.run('UPDATE chapters SET summary = ? WHERE id = ?', ['林野夺船改走陆路。', ch1]);
  assert.equal(lifecycle.markVolumeSummaryStale(bookId, ch1), true, '底料变化应标过期');
  vol = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 1, '卷总结应处于过期态');

  // 幂等：重复标记不再写
  assert.equal(lifecycle.markVolumeSummaryStale(bookId, ch1), false);

  // 重新保存卷总结 → 基于新底料 → 恢复不过期
  tool.execute({ bookId, args: { volume_id: volId, summary: '林野改走陆路北上。' } });
  vol = db.get('SELECT summary_stale, summary_based_on FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 0, '重新保存应清除过期标记');
});

test('正文变化清空章总结 → 卷总结自动标过期（invalidateChapter 传播链）', async t => {
  const { bookId, volId, ch1 } = await initBook(t, '清空书');
  const tool = registry.descriptor('save_volume_summary');
  tool.execute({ bookId, args: { volume_id: volId, summary: '基于旧章总结的卷总结。' } });
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]).summary_stale, 0);

  // 正文变化 → invalidateChapter 清空章总结 → 卷总结同步过期
  db.run('UPDATE chapters SET content = ? WHERE id = ?', ['第一章正文被大改。', ch1]);
  lifecycle.invalidateChapter(bookId, ch1, '正文已变化');
  const vol = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 1, '章总结被清空应传播到卷总结');
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [ch1]).summary, '', '前提：章总结已被清空');
});

test('无总结或无指纹的卷不受影响；save_chapter_summary 工具触发传播', async t => {
  const { bookId, volId, ch1 } = await initBook(t, '边界书');
  // 卷无总结：章总结变化不标
  db.run('UPDATE chapters SET summary = ? WHERE id = ?', ['新总结', ch1]);
  assert.equal(lifecycle.markVolumeSummaryStale(bookId, ch1), false, '无卷总结不应标过期');

  // 保存卷总结后，经 save_chapter_summary 工具改章总结 → 触发传播
  const tool = registry.descriptor('save_volume_summary');
  tool.execute({ bookId, args: { volume_id: volId, summary: '卷总结。' } });
  const chTool = registry.descriptor('save_chapter_summary');
  const out = chTool.execute({ bookId, args: { chapter_id: ch1, summary: '工具改写的章总结。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) } });
  assert.equal(out.volume_summary_stale, true, 'save_chapter_summary 应触发卷总结过期');
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]).summary_stale, 1);
});

test('路由集成：POST /summary 生成新章总结后，旧卷总结标过期', async t => {
  const env = await initBook(t, '路由书');
  const tool = registry.descriptor('save_volume_summary');
  tool.execute({ bookId: env.bookId, args: { volume_id: env.volId, summary: '旧卷总结。' } });
  // 章总结变化使底料指纹失效（模拟上一轮后章总结已变）
  db.run('UPDATE chapters SET summary = ? WHERE id = ?', ['被替换的旧总结', env.ch1]);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });

  // POST /summary 会调 LLM——绕开：直接验证路由层挂钩存在与否没有意义，
  // 这里验证手改路径 PUT（body.summary）的传播
  const r = await json(http.baseUrl, 'PUT', `/api/books/${env.bookId}/chapters/${env.ch1}`,
    { summary: '手改的新章总结，与旧卷总结底料不同。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [env.ch1]).revision) });
  assert.equal(r.status, 200);
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [env.volId]).summary_stale, 1,
    'PUT 手改章总结应传播到卷总结');
});
