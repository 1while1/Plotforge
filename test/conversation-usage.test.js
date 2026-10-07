const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const log = require('../server/llmCallLog');
const svc = require('../server/conversations/service');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

test('写作会话用量不读取同书其他会话或压缩调用', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['用量隔离']).lastInsertRowid;
  const a = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const b = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  log.record({ bookId, conversationId: a.id, scope: 'chat-stream', promptTokens: 321, status: 'ok' });
  log.record({ bookId, conversationId: b.id, scope: 'chat-stream', promptTokens: 999, status: 'ok' });
  log.record({ bookId, conversationId: a.id, scope: 'conversation-compact', promptTokens: 777, status: 'ok' });
  assert.equal(log.lastWithUsageForConversation(a.id).prompt_tokens, 321);
  assert.equal(log.lastWithUsageForConversation(b.id).prompt_tokens, 999);
  const status = await json(http.baseUrl, 'GET', '/api/books/' + bookId + '/context-status?conversationId=' + encodeURIComponent(a.id));
  assert.equal(status.status, 200);
  assert.equal(status.body.lastUsage.prompt_tokens, 321);
});
