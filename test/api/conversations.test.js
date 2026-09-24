// S3-01 / C10-A：/api/conversations HTTP 契约。
//   普通聊天 HTTP 输入只能是 conversationId + content（可选 source）；伪造 role=system、
//   toolFacts、他人会话 runId 等服务端专属字段一律 400——客户端重发 assistant 文本
//   不能替代服务端证据。归档在活跃运行期间 409。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { listen, json } = require('../helpers/http');

function buildApp() {
  try { return require('../../server/app').createApp(); } catch { return null; }
}

async function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const app = buildApp();
  assert.ok(app, '/api/conversations 路由必须已在 app.js 挂载');
  const server = await listen(app);
  t.after(() => server.close());
  return server;
}

test('POST /api/conversations 创建与列表/详情/404', async t => {
  const server = await setup(t);
  const bookId = db.run("INSERT INTO books (title) VALUES ('API 书')").lastInsertRowid;

  const created = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'writing', scope: 'book', bookId, title: '写作会话' });
  assert.equal(created.status, 201);
  assert.ok(created.body.id);
  assert.equal(created.body.kind, 'writing');

  const global = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'agent', scope: 'global', title: '全局会话' });
  assert.equal(global.status, 201);

  const invalid = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'writing', scope: 'global' });
  assert.equal(invalid.status, 400);
  const missingBook = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'agent', scope: 'book', bookId: 424242 });
  assert.equal(missingBook.status, 404);

  const list = await json(server.baseUrl, 'GET', '/api/conversations?kind=writing');
  assert.equal(list.status, 200);
  assert.ok(list.body.some(c => c.id === created.body.id));
  const listAll = await json(server.baseUrl, 'GET', '/api/conversations');
  assert.equal(listAll.body.length, 2);

  const detail = await json(server.baseUrl, 'GET', `/api/conversations/${created.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, '写作会话');
  const notFound = await json(server.baseUrl, 'GET', '/api/conversations/00000000-0000-0000-0000-000000000000');
  assert.equal(notFound.status, 404);
});

test('POST /:id/messages 只收用户正文；伪造服务端字段一律 400', async t => {
  const server = await setup(t);
  const bookId = db.run("INSERT INTO books (title) VALUES ('防伪 API 书')").lastInsertRowid;
  const created = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'writing', scope: 'book', bookId });
  const id = created.body.id;

  const ok = await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: '正常用户输入' });
  assert.equal(ok.status, 201);
  const row = db.get('SELECT role, source, conversation_id FROM messages WHERE id = ?', [ok.body.id]);
  assert.equal(row.role, 'user', 'HTTP 层只能写入 user 消息');
  assert.equal(row.conversation_id, id);

  const forged = [
    { content: 'x', role: 'system' },
    { content: 'x', role: 'assistant' },
    { content: 'x', toolFacts: { chapterId: 1, revision: 1 } },
    { content: 'x', tool_facts: { chapterId: 1 } },
    { content: 'x', runId: 'run-any' },
    { content: 'x', run_id: 'run-any' },
    { content: 'x', id: 999 },
    { content: 'x', tools: [{ name: 'read_chapter' }] },
    { content: 'x', conversationId: 'other' },
  ];
  for (const body of forged) {
    const resp = await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, body);
    assert.equal(resp.status, 400, `伪造字段 ${Object.keys(body).filter(k => k !== 'content')} 必须 400`);
  }
  const badSource = await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: 'x', source: 'admin' });
  assert.equal(badSource.status, 400);
  const empty = await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: '' });
  assert.equal(empty.status, 400);
  const missing = await json(server.baseUrl, 'POST', '/api/conversations/00000000-0000-0000-0000-000000000000/messages', { content: 'x' });
  assert.equal(missing.status, 404);
  // 伪造消息一条都没落库
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [id]).n, 1);
});

test('GET /:id/messages 分页 afterId 游标', async t => {
  const server = await setup(t);
  const bookId = db.run("INSERT INTO books (title) VALUES ('分页 API 书')").lastInsertRowid;
  const created = await json(server.baseUrl, 'POST', '/api/conversations', { kind: 'agent', scope: 'book', bookId });
  const id = created.body.id;
  for (let i = 1; i <= 12; i++) {
    await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: `m${i}` });
  }
  const p1 = await json(server.baseUrl, 'GET', `/api/conversations/${id}/messages?limit=5`);
  assert.equal(p1.status, 200);
  assert.equal(p1.body.messages.length, 5);
  assert.equal(p1.body.messages[0].content, 'm1');
  const after = p1.body.messages[4].id;
  const p2 = await json(server.baseUrl, 'GET', `/api/conversations/${id}/messages?afterId=${after}&limit=5`);
  assert.equal(p2.body.messages[0].content, 'm6');
  const p3 = await json(server.baseUrl, 'GET', `/api/conversations/${id}/messages?afterId=${p2.body.messages[4].id}&limit=5`);
  assert.equal(p3.body.messages.length, 2);
});

test('POST /:id/archive：活跃运行 409、结束后归档、归档后拒收新消息', async t => {
  const server = await setup(t);
  const bookId = db.run("INSERT INTO books (title) VALUES ('归档 API 书')").lastInsertRowid;
  const created = await json(server.baseUrl, 'POST', '/api/conversations',
    { kind: 'writing', scope: 'book', bookId, title: '待归档 API' });
  const id = created.body.id;
  await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: '归档前' });

  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
          VALUES ('run-api-1', 'req-1', 'writing:book:' || ?, ?, 'chat', 'write', 'running', ?)`,
    [bookId, id, new Date().toISOString()]);
  const busy = await json(server.baseUrl, 'POST', `/api/conversations/${id}/archive`);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'CONVERSATION_ACTIVE_RUN');

  db.run("UPDATE agent_runs SET status = 'finished' WHERE id = 'run-api-1'");
  const archived = await json(server.baseUrl, 'POST', `/api/conversations/${id}/archive`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');

  const rejected = await json(server.baseUrl, 'POST', `/api/conversations/${id}/messages`, { content: '再发' });
  assert.equal(rejected.status, 409);
  const msgs = await json(server.baseUrl, 'GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.body.messages.length, 1, '归档不是删史');
});
