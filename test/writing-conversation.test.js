// S3-03 / 任务书 04：写作会话独立且与阅读页连续。
//   同一本书两个 writing 会话与一个 agent 会话互不串历史；共有大纲/正文仍按 provider 读取；
//   /:bookId/chat 列表、stream、compress/restore 都核对 conversationId 属于该书且 kind=writing；
//   旧调用过渡只映射该书 legacy-writing；待确认动作留在原会话；阅读页 source=read 只是来源标签。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const conversationSvc = require('../server/conversations/service');

const OUTLINE = 'SHAREDOUTLINE_共享总纲：主角要找回失落的星辰剑';

function createBook(title) {
  const id = db.run('INSERT INTO books (title, master_outline) VALUES (?, ?)', [title, OUTLINE]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

async function httpCtx(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook(title);
  const book2Id = createBook(title + '乙');
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, book2Id, http, stub };
}

function textSse(text) {
  const frames = [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

// 写工具调用 SSE（create_chapter → 确认卡）
function writeToolSse(bookId) {
  const frames = [
    { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'cw1', type: 'function', function: { name: 'create_chapter', arguments: JSON.stringify({ book_id: bookId, title: '会话归属章' }) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

async function drain(res) {
  if (!res || !res.body) return '';
  const text = await res.text();
  return text;
}

async function postStream(http, bookId, body) {
  return fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('同书两个写作会话互不串历史，agent 会话与共享资料各归其位', async t => {
  const { bookId, http, stub } = await httpCtx(t, '隔离写作');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '任务A' });
  const w2 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '任务B' });
  const agentConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: 'Agent台' });
  conversationSvc.appendMessage({ conversationId: w1.id, role: 'user', content: 'IDEA_W1_主角的师父其实是反派', source: 'writing' });
  conversationSvc.appendMessage({ conversationId: w2.id, role: 'user', content: 'IDEA_W2_第二章改成海上风暴', source: 'writing' });
  conversationSvc.appendMessage({ conversationId: agentConv.id, role: 'user', content: 'IDEA_AGENT_全书检索规划', source: 'agent' });

  stub.responders.push(() => textSse('好的，继续任务A。'));
  const res = await postStream(http, bookId, { conversationId: w1.id, content: '继续刚才的设想', source: 'writing' });
  assert.equal(res.status, 200);
  await drain(res);

  const writingRequestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.equal(writingRequestText.includes('IDEA_W1'), true, '本会话历史必须在场');
  assert.equal(writingRequestText.includes('IDEA_W2'), false, '另一写作任务的设想不得混入');
  assert.equal(writingRequestText.includes('IDEA_AGENT'), false, 'Agent 会话消息不得混入写作上下文');
  assert.equal(writingRequestText.includes(OUTLINE), true, '共享资料（大纲）仍按 provider 注入');

  // 列表同样隔离；新消息落 W1
  const w1List = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chat?conversationId=${w1.id}`);
  assert.equal(w1List.status, 200);
  assert.equal(w1List.body.conversationId, w1.id);
  assert.ok(w1List.body.messages.some(m => m.content === 'IDEA_W1_主角的师父其实是反派'));
  assert.ok(!w1List.body.messages.some(m => m.content.includes('IDEA_W2')));
  assert.ok(!w1List.body.messages.some(m => m.content.includes('IDEA_AGENT')));
  const rows = db.all('SELECT conversation_id FROM messages WHERE content = ?', ['继续刚才的设想']);
  assert.ok(rows.every(r => r.conversation_id === w1.id), 'stream 落库必须带会话归属');
});

test('他书会话 / agent 会话用于本书 → 404', async t => {
  const { bookId, book2Id, http, stub } = await httpCtx(t, '跨书拒绝');
  const otherBookConv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId: book2Id });
  const agentConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  stub.responders.push(() => textSse('x'));

  const crossBookConversationResponse = await postStream(http, bookId, { conversationId: otherBookConv.id, content: 'x' });
  assert.equal(crossBookConversationResponse.status, 404);
  const agentAsWriting = await postStream(http, bookId, { conversationId: agentConv.id, content: 'x' });
  assert.equal(agentAsWriting.status, 404);

  const crossList = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chat?conversationId=${otherBookConv.id}`);
  assert.equal(crossList.status, 404);
  const crossCompress = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat/compress`, { conversationId: otherBookConv.id });
  assert.equal(crossCompress.status, 404);
});

test('旧调用过渡：无 conversationId 只映射该书 legacy-writing，不拼 agent/他书消息', async t => {
  const { bookId, book2Id, http, stub } = await httpCtx(t, '过渡映射');
  // 旧形态消息：无会话归属（迁移后旧入口产生的）
  db.run("INSERT INTO messages (book_id, role, content, source) VALUES (?, 'user', 'OLD_BOOK1_旧入口消息', 'writing')", [bookId]);
  db.run("INSERT INTO messages (book_id, role, content, source) VALUES (?, 'user', 'OLD_BOOK2_乙书消息', 'writing')", [book2Id]);
  const agentConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  conversationSvc.appendMessage({ conversationId: agentConv.id, role: 'user', content: 'AGENT_ONLY_台面讨论', source: 'agent' });

  const list = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chat`);
  assert.equal(list.status, 200);
  assert.equal(list.body.conversationId, `legacy-writing-${bookId}`, '无会话参数必须落到该书 legacy 会话');
  assert.ok(list.body.messages.some(m => m.content === 'OLD_BOOK1_旧入口消息'));
  assert.ok(!list.body.messages.some(m => m.content.includes('OLD_BOOK2')));
  assert.ok(!list.body.messages.some(m => m.content.includes('AGENT_ONLY')));

  stub.responders.push(() => textSse('收到。'));
  const res = await postStream(http, bookId, { content: '继续', source: 'writing' });
  assert.equal(res.status, 200);
  await drain(res);
  const requestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.equal(requestText.includes('OLD_BOOK1'), true);
  assert.equal(requestText.includes('OLD_BOOK2'), false);
  assert.equal(requestText.includes('AGENT_ONLY'), false);
  const newRow = db.get("SELECT conversation_id FROM messages WHERE content = '继续'");
  assert.equal(newRow.conversation_id, `legacy-writing-${bookId}`, '旧调用的新消息也落 legacy 会话');
});

test('压缩隔离：压缩 W1 后 W2 的历史不变；restore 只恢复本会话', async t => {
  const { bookId, http, stub } = await httpCtx(t, '压缩隔离');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '压缩A' });
  const w2 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '压缩B' });
  for (let i = 1; i <= 6; i++) {
    conversationSvc.appendMessage({ conversationId: w1.id, role: i % 2 ? 'user' : 'assistant', content: `W1第${i}轮：${'很长的剧情讨论'.repeat(40)}`, source: 'writing' });
  }
  conversationSvc.appendMessage({ conversationId: w2.id, role: 'user', content: 'W2唯一消息', source: 'writing' });
  const w2Before = JSON.stringify(db.all('SELECT id, role, content, compressed FROM messages WHERE conversation_id = ?', [w2.id]));

  stub.responders.push(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '【剧情讨论要点】W1 前几轮概要' }, finish_reason: 'stop' }] }) }));
  const compacted = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat/compress`, { conversationId: w1.id, targetTokens: 50 });
  assert.equal(compacted.status, 200);
  assert.ok(compacted.body.archived > 0, 'W1 应有消息被归档');
  assert.equal(JSON.stringify(db.all('SELECT id, role, content, compressed FROM messages WHERE conversation_id = ?', [w2.id])), w2Before, '压缩 W1 不得动 W2');
  const summaryRow = db.get("SELECT conversation_id FROM messages WHERE compressed = 2");
  assert.equal(summaryRow.conversation_id, w1.id, '存档摘要行必须落本会话');

  const restored = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat/compress/restore`, { conversationId: w1.id });
  assert.equal(restored.status, 200);
  assert.ok(restored.body.restored > 0);
  const w1Active = db.get('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND compressed = 1', [w1.id]).n;
  assert.equal(w1Active, 0, 'restore 后 W1 无归档标记行');
});

test('待确认动作留在原会话：跨会话续跑 403，resume 信封落原会话', async t => {
  const { bookId, http, stub } = await httpCtx(t, '动作归属');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '发起会话' });
  const w2 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '另一会话' });

  // W1 内发起写工具 → 确认卡（run 绑定 W1）
  stub.responders.push(() => writeToolSse(bookId));
  const first = await postStream(http, bookId, { conversationId: w1.id, content: '请新建一章', source: 'writing' });
  assert.equal(first.status, 200);
  await drain(first);
  const action = db.get("SELECT * FROM chat_actions WHERE name = 'create_chapter' ORDER BY created_at DESC LIMIT 1");
  assert.ok(action, '应产生确认卡');
  const run = db.get('SELECT * FROM agent_runs WHERE id = ?', [action.run_id]);
  assert.equal(run.conversation_id, w1.id, '运行必须绑定发起会话');

  const confirmed = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat-actions/${action.id}/confirm`, { approve: true });
  assert.equal(confirmed.status, 200);

  // 切到 W2 后偷偷续跑 → 403
  const crossResume = await postStream(http, bookId, { conversationId: w2.id, resumeActionId: action.id, source: 'writing' });
  assert.equal(crossResume.status, 403, '确认动作不得跨会话续跑');

  // 原会话续跑：信封落 W1（不是当前可能切到的其他会话）
  stub.responders.push(() => textSse('章节已建好。'));
  const resumed = await postStream(http, bookId, { resumeActionId: action.id, source: 'writing' });
  assert.equal(resumed.status, 200);
  await drain(resumed);
  const envelope = db.get("SELECT conversation_id FROM messages WHERE content LIKE '%确认执行结果·系统事件%' ORDER BY id DESC LIMIT 1");
  assert.ok(envelope);
  assert.equal(envelope.conversation_id, w1.id, 'resume 信封必须落原会话');
});

test('阅读页连续：source=read 消息进当前写作会话（不是第三套存储）', async t => {
  const { bookId, http, stub } = await httpCtx(t, '阅读页连续');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '阅读连续' });
  stub.responders.push(() => textSse('精修建议…'));
  const res = await postStream(http, bookId, { conversationId: w1.id, content: '这段能不能再紧凑些', source: 'read' });
  assert.equal(res.status, 200);
  await drain(res);
  const rows = db.all("SELECT source, conversation_id FROM messages WHERE content = '这段能不能再紧凑些' OR content = '精修建议…'");
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.conversation_id === w1.id), '阅读页消息必须进同一写作会话');
  assert.ok(rows.some(r => r.source === 'read'), '来源标签保留');
  const list = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chat?conversationId=${w1.id}`);
  assert.ok(list.body.messages.some(m => m.source === 'read'), '写作台列表可见阅读页消息（同一存储）');
});

test('新建会话不删旧对话；归档会话拒收 stream', async t => {
  const { bookId, http, stub } = await httpCtx(t, '新会话边界');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '旧任务' });
  conversationSvc.appendMessage({ conversationId: w1.id, role: 'user', content: '旧任务消息', source: 'writing' });
  const w2 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '新任务' });
  assert.ok(w2.id && w2.id !== w1.id);
  assert.ok(db.get("SELECT 1 FROM messages WHERE conversation_id = ? AND content = '旧任务消息'", [w1.id]), '新建会话不得删除旧对话');

  stub.responders.push(() => textSse('x'));
  conversationSvc.archiveConversation(w1.id);
  const archived = await postStream(http, bookId, { conversationId: w1.id, content: '再发一条', source: 'writing' });
  assert.equal(archived.status, 409, '归档会话拒收新消息');
  const fresh = await postStream(http, bookId, { conversationId: w2.id, content: '新会话第一条', source: 'writing' });
  assert.equal(fresh.status, 200);
  await drain(fresh);
});
