const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const lifecycle = require('../server/domain/chapterLifecycle');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

// W13 回归：REST 卷总结路径（POST /volumes/:id/summary）此前保存后不刷底料指纹，
// summary_based_on 恒为空 → markVolumeSummaryStale 的「无指纹不动」守卫使传播链在
// REST 路径断裂——章总结变化后卷/书总结永不失效（只有 Agent 工具路径正常）。
// 本用例走真实 REST 路由（LLM 接假上游，非流式 JSON 应答）证明闭环：
// REST 保存卷总结记录指纹 → 章总结变化（PUT /chapters/:id）→ 卷总结标过期
// （GET 卷详情可见）→ 重新生成后恢复；卷总结变化同时传播到全书摘要。

function fakeUpstream(reply) {
  const app = express();
  app.use(express.json());
  app.post('/chat/completions', (req, res) => {
    res.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] });
  });
  return app;
}

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const fake = await listen(fakeUpstream('卷概要：林野北上，冻港遇袭，卷末留下悬念。'));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [fake.baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['agnes-2.5-flash']);
  const volId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const ch1 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, summary) VALUES (?, ?, ?, ?, 1, ?)',
    [bookId, '第一章', '第一章正文。', volId, '林野夺船北上。']).lastInsertRowid;
  const ch2 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, summary) VALUES (?, ?, ?, ?, 2, ?)',
    [bookId, '第二章', '第二章正文。', volId, '北境冻港遇袭。']).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    if (fake.server.closeAllConnections) fake.server.closeAllConnections();
    await http.close();
    await fake.close();
    cleanup(location);
  });
  return { bookId, volId, ch1, ch2, http };
}

test('REST 卷总结保存刷底料指纹：章总结变化 → 卷标过期（GET 可见）→ 重新生成恢复', async t => {
  const { bookId, volId, ch1, http } = await setup(t, 'REST卷指纹');

  // REST 生成并保存卷总结（LLM 走假上游，非流式 JSON）
  const saved = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes/${volId}/summary`, {});
  assert.equal(saved.status, 200);
  assert.ok(saved.body.summary, '应返回生成的卷总结');

  let vol = db.get('SELECT summary, summary_based_on, summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.ok(vol.summary_based_on, 'REST 保存卷总结应记录底料指纹（修复点）');
  assert.equal(vol.summary_stale, 0, '新保存的卷总结不过期');
  assert.equal(vol.summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volId),
    '指纹应等于当前章总结联合指纹');

  // 章总结变化（真实 REST 路径 PUT /chapters/:id）→ 指纹不吻合 → 卷总结标过期
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { summary: '林野夺船改走陆路。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) });
  assert.equal(put.status, 200);
  vol = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 1, '章总结变化应使 REST 保存的卷总结过期（传播链闭环）');

  // 取卷总结（GET 卷详情）回传过期信号——作者/前端据此触发重算
  const view = await json(http.baseUrl, 'GET', `/api/books/${bookId}/volumes/${volId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.volume.summary_stale, 1, 'GET 卷详情应回传过期态');

  // 重新生成（REST）→ 基于新底料 → 恢复不过期
  const regen = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes/${volId}/summary`, {});
  assert.equal(regen.status, 200);
  vol = db.get('SELECT summary_based_on, summary_stale FROM volumes WHERE id = ?', [volId]);
  assert.equal(vol.summary_stale, 0, '重新生成应清除过期标记');
  assert.equal(vol.summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volId),
    '指纹应随新底料刷新');
});

test('REST 卷总结变化传播到全书摘要；底料未变时重存不误标', async t => {
  const { bookId, volId, ch1, http } = await setup(t, 'REST书层传播');

  // 先有全书摘要（带指纹）
  const prog = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '两章：北上与遇袭。' });
  assert.equal(prog.status, 200);
  let row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 0);

  // REST 保存卷总结 → 书摘要底料变化 → 过期（与 Agent 工具路径对齐）
  const saved = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes/${volId}/summary`, {});
  assert.equal(saved.status, 200);
  assert.equal(saved.body.book_summary_stale, true, 'REST 卷总结保存应回传书摘要已标过期');
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 1, '卷总结变化应传播到全书摘要');

  // 重新保存书摘要恢复后，底料未变的章总结写入（同内容）不误标
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '两章：北上与遇袭，卷一收官。' });
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { summary: '林野夺船北上。', expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch1]).revision) });
  assert.equal(put.status, 200);
  row = db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.equal(row.stale, 0, '底料未变化的章总结写入不应误标书摘要');
});
