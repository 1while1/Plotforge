const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const svc = require('../server/conversations/service');
const runSvc = require('../server/runtime/run-service');
const evidence = require('../server/runtime/read-evidence');
const { executeTool } = require('../server/tools/executor');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');

test('读取证据按运行持久化，重启可回读且不能跨会话查看', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['证据书']).lastInsertRowid;
  const chapterId = db.run('INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)', [bookId, '一', '原文']).lastInsertRowid;
  const conv = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const other = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const runId = runSvc.newRunId();
  runSvc.startRun({ runId, requestId: 'read-1', sessionKey: 'writing:book:' + bookId, conversationId: conv.id, entry: 'chat', bookId, mode: 'write' });
  const receipts = [];
  const ctx = { bookId, profile: 'writing', sessionId: 'writing:book:' + bookId, runId, readReceipts: receipts };
  await executeTool(ctx, 'read_chapter', { chapterId }, '', { toolCallId: 'call-1' });
  assert.equal(receipts.length, 1);
  assert.equal(evidence.listForRun(runId).length, 1);
  assert.equal(evidence.listForRun(runId)[0].contentHash, receipts[0].contentHash);
  await executeTool(ctx, 'read_chapter', { chapterId }, '', { toolCallId: 'call-1' });
  assert.equal(evidence.listForRun(runId).length, 1, '同版本重试不重复写');
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const url = http.baseUrl + '/api/runs/' + runId + '/read-evidence';
  const ok = await fetch(url, { headers: { 'x-session-key': 'writing:book:' + bookId } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).evidence.length, 1);
  const denied = await fetch(url, { headers: { 'x-session-key': 'agent:' + other.id } });
  assert.equal(denied.status, 403);
  db.saveNow();
  db.close();
  await db.init({ filePath: location.filePath });
  assert.equal(evidence.listForRun(runId).length, 1, '重启后仍可查');
  db.run('UPDATE chapters SET content = ? WHERE id = ?', ['新版正文', chapterId]);
  assert.notEqual(evidence.listForRun(runId)[0].contentHash,
    require('node:crypto').createHash('sha256').update('新版正文').digest('hex'));
  db.run('DELETE FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(evidence.listForRun(runId).length, 1, '章节删除后历史读取证据仍可审计');
  const backup = require('../server/bookBackup');
  const snapshot = backup.exportBookBackup(bookId);
  const fs = require('node:fs');
  const path = require('node:path');
  const data = JSON.parse(fs.readFileSync(path.join(location.dir, 'backups', snapshot.file), 'utf8'));
  assert.equal(data.tables.run_read_evidence.length, 1, '整书备份包含运行读取证据');
});

test('证据落盘失败不得加入本轮核验凭据', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['落盘故障']).lastInsertRowid;
  const chapterId = db.run('INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)', [bookId, '一', '内容']).lastInsertRowid;
  const conv = svc.createConversation({ kind: 'agent', scope: 'book', bookId });
  const runId = runSvc.newRunId();
  runSvc.startRun({ runId, requestId: 'read-fail', sessionKey: 'agent:' + conv.id, conversationId: conv.id, entry: 'agent', bookId, mode: 'execute' });
  const receipts = [];
  const original = db.saveNow;
  db.saveNow = () => false;
  try {
    await assert.rejects(executeTool({ bookId, profile: 'agent', sessionId: 'agent:' + conv.id, runId, readReceipts: receipts },
      'read_chapter', { chapterId }, '', { toolCallId: 'call-fail' }), { code: 'READ_EVIDENCE_PERSIST_FAILED' });
  } finally { db.saveNow = original; }
  assert.deepEqual(receipts, []);
});
