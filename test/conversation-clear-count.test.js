const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const svc = require('../server/conversations/service');

test('会话详情返回真实消息总数，清空只处理目标会话且摘要失效', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['清空测试']).lastInsertRowid;
  const target = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const other = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  for (let i = 0; i < 205; i++) svc.appendMessage({ conversationId: target.id, role: 'user', content: '消息' + i });
  svc.appendMessage({ conversationId: other.id, role: 'user', content: '其他会话' });
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)', [target.id, '旧摘要', '[]']);
  const detail = await json(http.baseUrl, 'GET', '/api/conversations/' + target.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.messageCount, 205);

  db.run("INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at) VALUES ('clear-run', 'clear-req', ?, ?, 'chat', 'execute', 'running', ?)", ['writing:book:' + bookId, target.id, new Date().toISOString()]);
  const path = '/api/books/' + bookId + '/chat?conversationId=' + encodeURIComponent(target.id);
  const busy = await json(http.baseUrl, 'DELETE', path);
  assert.equal(busy.status, 409);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [target.id]).n, 205);
  db.run("UPDATE agent_runs SET status = 'finished' WHERE id = 'clear-run'");
  const clear = await json(http.baseUrl, 'DELETE', path);
  assert.equal(clear.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [target.id]).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [other.id]).n, 1);
  assert.equal(db.get('SELECT status FROM conversation_summaries WHERE conversation_id = ?', [target.id]).status, 'superseded');
});
