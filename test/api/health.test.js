const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 单一健康视图（方向报告 3.3）：索引/抽取/摘要/台账/调用失败的聚合观察面。

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http };
}

test('health：空书全绿——各缺口计数为 0，正典规模为空', async t => {
  const { bookId, http } = await setup(t, '空书');
  const r = await json(http.baseUrl, 'GET', `/api/books/${bookId}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.canon, { chapters: 0, locked: 0, chars: 0 });
  assert.equal(r.body.index.locked_missing, 0);
  assert.equal(r.body.extraction.locked_pending, 0);
  assert.equal(r.body.summary.locked_without_summary, 0);
  assert.equal(r.body.summary.stale_volumes, 0);
  assert.equal(r.body.ledger.pending_proposals, 0);
  assert.equal(r.body.llm_recent.errors, 0);
});

test('health：定稿缺索引/缺总结/缺抽取、卷总结过期、台账问题、调用失败各自计数', async t => {
  const { bookId, http } = await setup(t, '缺口书');
  const volId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  // 定稿章：有内容、无索引（embeddings 空）、无总结、无抽取记录 → 三类缺口各 1
  const ch1 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, locked, summary) VALUES (?, ?, ?, ?, 1, 1, \'\')',
    [bookId, '第一章', '正文内容若干。', volId]).lastInsertRowid;
  // 定稿章 + 有总结 + 有向量块 + 有成功抽取 → 不进任何缺口
  const ch2 = db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, locked, summary) VALUES (?, ?, ?, ?, 2, 1, ?)',
    [bookId, '第二章', '正文内容若干。', volId, '已有总结。']).lastInsertRowid;
  db.run('INSERT INTO embeddings (book_id, chapter_id, chunk_idx, text, vector) VALUES (?, ?, 0, ?, ?)',
    [bookId, ch2, '块', Buffer.from(new Float32Array([0.1, 0.2]).buffer)]);
  db.run("INSERT INTO chapter_extraction_runs (book_id, chapter_id, revision_hash, source_type, status, created_at, updated_at) VALUES (?, ?, 'h2', 'backfill', 'success', datetime('now'), datetime('now'))", [bookId, ch2]);
  // 未定稿章：不进缺口口径（缺口只统计定稿）
  db.run('INSERT INTO chapters (book_id, title, content, volume_id, sort_order, locked, summary) VALUES (?, ?, ?, ?, 3, 0, \'\')',
    [bookId, '草稿章', '草稿。', volId]);
  // 卷总结过期（4.1）
  db.run('UPDATE volumes SET summary = ?, summary_based_on = ?, summary_stale = 1 WHERE id = ?', ['旧卷总结', 'hash', volId]);
  // 台账问题：一条 stale 提案 + 一条孤儿事件
  db.run("INSERT INTO event_proposals (book_id, title, status, source_type, dedupe_key, created_at) VALUES (?, ?, 'stale', 'manual', ?, datetime('now'))", [bookId, '过期提案', 'dk1']);
  db.run("INSERT INTO story_events (book_id, title, source_revision_hash, origin, created_by, created_at) VALUES (?, ?, 'rev', 'manual', 'test', datetime('now'))", [bookId, '孤儿事件']);
  // 最近调用失败
  db.run("INSERT INTO llm_calls (book_id, scope, status, created_at) VALUES (?, 'chat', 'error', datetime('now'))", [bookId]);

  const r = await json(http.baseUrl, 'GET', `/api/books/${bookId}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.body.canon.chapters, 3);
  assert.equal(r.body.canon.locked, 2);
  assert.equal(r.body.index.locked_missing, 1, '定稿无索引章应为 1');
  assert.equal(r.body.extraction.locked_pending, 1, '定稿无抽取章应为 1');
  assert.equal(r.body.summary.locked_without_summary, 1, '定稿无总结章应为 1');
  assert.equal(r.body.summary.stale_volumes, 1, '过期卷总结应为 1');
  assert.equal(r.body.ledger.stale_proposals, 1);
  assert.equal(r.body.ledger.orphan_events, 1);
  assert.equal(r.body.llm_recent.errors, 1);
});

test('health：书不存在 404', async t => {
  const { http } = await setup(t, '占位书');
  const r = await json(http.baseUrl, 'GET', '/api/books/999999/health');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'BOOK_NOT_FOUND');
});
