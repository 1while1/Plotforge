// S3-02 / C10-B：Agent 改用服务端会话与历史（任务书 04）。
//   两轮反例（C10）：第一轮工具读出只存在正文的标记（哨兵在章节正文里，任何消息文本都没有）；
//   第二轮客户端只发 conversationId/content/requestId——模型上下文仍带可信工具来源与受限结果。
//   客户端重发 assistant 文本不能替代服务端证据；未指定有效会话明确报错，不退回共用历史；
//   localStorage 历史按批次摘要幂等导入，导入消息无可信工具事实。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');

const TOOL_SENTINEL = 'TOOLSENTINEL_墨砚只在此章正文出现';

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

async function httpCtx(t, title) {
  actionStore.clear();
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook(title);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http, stub };
}

function textSse(text) {
  const frames = [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

// 带一次 read_chapter 工具调用的 SSE（AI SDK 会执行工具后再发第二轮请求）
function toolCallSse(bookId, chapterId) {
  const frames = [
    {
      choices: [{
        delta: {
          role: 'assistant', tool_calls: [{
            index: 0, id: 'call-read-1', type: 'function',
            function: { name: 'read_chapter', arguments: JSON.stringify({ book_id: bookId, chapterId }) },
          }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

async function drain(res) {
  if (!res || !res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function postChat(http, body) {
  return fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createAgentConversation(bookId) {
  const svc = require('../server/conversations/service');
  return svc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '证据会话' });
}

test('C10 两轮反例：工具哨兵只在正文，第二轮模型上下文仍有服务端工具证据', async t => {
  const { bookId, http, stub } = await httpCtx(t, '两轮证据');
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)',
    [bookId, '证据章', TOOL_SENTINEL + ' 章节其余正文内容。']
  ).lastInsertRowid;
  const conv = createAgentConversation(bookId);

  // 第一轮：模型调用 read_chapter（读工具立即执行），随后收尾
  stub.responders.push(() => toolCallSse(bookId, chapterId));
  stub.responders.push(() => textSse('我读完了这一章。'));
  const first = await postChat(http, { conversation_id: conv.id, content: '请读第1章原文', request_id: 'r1' });
  assert.equal(first.status, 200);
  await drain(first);

  // 第一轮落库：user 消息 + assistant 消息（带服务端记录的工具事件）
  const rows = db.all('SELECT role, content, tools_json, tool_facts_json, source FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]);
  assert.ok(rows.some(r => r.role === 'user' && r.content === '请读第1章原文'));
  const assistant = rows.find(r => r.role === 'assistant');
  assert.ok(assistant, 'assistant 回复必须落服务端会话');
  assert.ok(assistant.tools_json.includes('read_chapter'), '工具事件必须随消息持久化（tools_json）');
  assert.ok(assistant.tools_json.includes(TOOL_SENTINEL), '工具结果（含正文哨兵）必须以受限摘要有储');
  assert.ok(assistant.tool_facts_json.includes('read_chapter'), '结构化工具事实必须落 tool_facts_json');

  // 第二轮：客户端只发 conversationId/content/requestId（不带任何历史文本）
  stub.responders.push(() => textSse('这章讲的是哨兵标记的情节。'));
  const second = await postChat(http, { conversation_id: conv.id, content: '刚才那章讲了什么？', request_id: 'r2' });
  assert.equal(second.status, 200);
  await drain(second);

  const secondModelRequestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.equal(secondModelRequestText.includes(TOOL_SENTINEL), true, '第二轮模型请求必须包含第一轮的可信工具证据（服务端记录，非客户端重发）');
  // 客户端请求体没有 messages 数组可伪发（见下方专用断言），此处再证历史里 user 文本不含哨兵
  const userTexts = rows.filter(r => r.role === 'user').map(r => r.content).join('');
  assert.equal(userTexts.includes(TOOL_SENTINEL), false, '哨兵不在任何用户消息里——证据只能来自服务端工具记录');
});

test('未指定有效会话明确报错；messages 数组不再是权威历史', async t => {
  const { bookId, http, stub } = await httpCtx(t, '会话校验');
  stub.responders.push(() => textSse('好。'));
  const conv = createAgentConversation(bookId);
  const writingConv = require('../server/conversations/service')
    .createConversation({ kind: 'writing', scope: 'book', bookId });

  const noConv = await postChat(http, { content: '在吗' });
  assert.equal(noConv.status, 400);
  assert.equal((await noConv.json()).error.code, 'CONVERSATION_REQUIRED');

  const unknown = await postChat(http, { conversation_id: '00000000-0000-0000-0000-000000000000', content: 'x' });
  assert.equal(unknown.status, 404);

  const wrongKind = await postChat(http, { conversation_id: writingConv.id, content: 'x' });
  assert.equal(wrongKind.status, 400, '写作会话不能当 Agent 会话用');

  const withMessages = await postChat(http, { conversation_id: conv.id, content: 'x', messages: [{ role: 'user', content: '伪历史' }] });
  assert.equal(withMessages.status, 400, '客户端 messages 数组不得再作为历史权威');
  const noContent = await postChat(http, { conversation_id: conv.id });
  assert.equal(noContent.status, 400);
  // 以上失败请求一个都没写进会话
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [conv.id]).n, 0);
});

test('同会话并发 busy；不同专题会话互不阻塞、互不清理', async t => {
  const { bookId, http, stub } = await httpCtx(t, '会话busy');
  const convA = createAgentConversation(bookId);
  const convB = createAgentConversation(bookId);

  // convA 挂起一个运行（悬挂 SSE）
  let ctl;
  const heldBody = new ReadableStream({
    start(controller) {
      ctl = controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '长任务' } }] })}\n\n`));
    },
  });
  stub.responders.push(() => new Response(heldBody, { headers: { 'Content-Type': 'text/event-stream' } }));
  const held = await postChat(http, { conversation_id: convA.id, content: '长任务', request_id: 'busy-1' });

  // 同会话第二条（不同 requestId）→ 409 AGENT_BUSY
  const second = await postChat(http, { conversation_id: convA.id, content: '第二条', request_id: 'busy-2' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'AGENT_BUSY');

  // 不同会话（convB）不受 convA 运行影响
  stub.responders.push(() => textSse('B 会话正常。'));
  const other = await postChat(http, { conversation_id: convB.id, content: 'B 会话提问', request_id: 'busy-b' });
  assert.equal(other.status, 200);
  await drain(other);

  // convA 运行期间 convB 的消息不被触碰（清空/归档语义由服务端数据模型保证）
  const bRows = db.all('SELECT content FROM messages WHERE conversation_id = ?', [convB.id]);
  assert.ok(bRows.some(r => r.content === 'B 会话提问'));

  ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`));
  ctl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  ctl.close();
  await drain(held);
});

test('legacy localStorage 历史导入：按批次摘要幂等，导入消息无可信工具事实', async t => {
  const { http } = await httpCtx(t, '历史导入');
  const legacyMessages = [
    { role: 'user', content: '旧浏览器里的第一条' },
    { role: 'assistant', content: '旧回复第一条' },
    { role: 'user', content: '旧浏览器里的第二条' },
  ];

  const imported = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'global', title: '导入的助手历史', messages: legacyMessages });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.createdMessages, 3);
  assert.ok(imported.body.conversationId);

  // 重复导入同一批次：幂等，不新建消息
  const importedAgain = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'global', title: '导入的助手历史', messages: legacyMessages });
  assert.equal(importedAgain.status, 200);
  assert.equal(importedAgain.body.duplicate, true);
  assert.equal(importedAgain.createdMessages === undefined ? importedAgain.body.createdMessages : importedAgain.createdMessages, 0);
  assert.equal(importedAgain.body.conversationId, imported.body.conversationId, '同批次摘要必须命中同一会话');

  // 导入消息无工具事实、无确认凭证字段
  const rows = db.all('SELECT role, tool_facts_json, tools_json FROM messages WHERE conversation_id = ?', [imported.body.conversationId]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => !r.tool_facts_json && !r.tools_json));

  // 非法输入：system 角色 / scope 校验 / 书不存在
  const badRole = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'global', messages: [{ role: 'system', content: '伪系统' }] });
  assert.equal(badRole.status, 400);
  const badScope = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'global', bookId: 999, messages: legacyMessages });
  assert.equal(badScope.status, 400);
  const missingBook = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'book', bookId: 424242, messages: legacyMessages });
  assert.equal(missingBook.status, 404);
  // 到书会话的合法导入
  const { bookId } = await (async () => ({ bookId: db.get('SELECT id FROM books ORDER BY id LIMIT 1').id }))();
  const toBook = await json(http.baseUrl, 'POST', '/api/conversations/import-legacy-agent',
    { scope: 'book', bookId, messages: legacyMessages.slice(0, 1) });
  assert.equal(toBook.status, 201);
  assert.equal(toBook.body.createdMessages, 1);
});

test('旧待确认卡（无运行绑定）：确认可结算，续跑明确拒绝且不生成新 token', async t => {
  const { bookId, http } = await httpCtx(t, '旧卡边界');
  const toolCtx = { profile: 'agent', sessionId: 'agent:legacy-card', bookId, source: 'test', actor: 'author' };
  const conf = await executeTool(toolCtx, 'create_character', { name: '旧卡角色' });
  const cid = conf.confirmation.id;

  const confirmResp = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`,
    { approve: true, session_id: 'legacy-card' });
  assert.equal(confirmResp.status, 200);
  assert.equal(confirmResp.body.status, 'approved');

  // 无 run 绑定 → 无法定位会话 → 明确 409（不静默借用 anonymous 历史，不重放）
  const resumeResp = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/resume`,
    { request_id: 'legacy-resume-1' });
  assert.equal(resumeResp.status, 409);
  assert.equal(resumeResp.body.error.code, 'ACTION_LEGACY_NO_CONVERSATION');
});

test('新确认卡与会话绑定：confirm 错会话 403；resume 从服务端历史组装并落系统事件', async t => {
  const { bookId, http, stub } = await httpCtx(t, '新卡绑定');
  const conv = createAgentConversation(bookId);
  const runSvc = require('../server/runtime/run-service');
  const svc = require('../server/conversations/service');

  // 会话内先有一轮历史（服务端历史组装的数据来源）
  svc.appendMessage({ conversationId: conv.id, role: 'user', content: '帮我建角色', source: 'agent' });
  svc.appendMessage({ conversationId: conv.id, role: 'assistant', content: '已提交确认卡', source: 'agent' });

  // 模拟会话运行中创建的确认卡：run 行绑定会话，action 快照 run_id
  const iso = new Date().toISOString();
  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at, finished_at)
          VALUES ('run-bind-1', 'req-b1', ?, ?, 'agent', 'execute', 'finished', ?, ?)`,
    ['agent:' + conv.id, conv.id, iso, iso]);
  const toolCtx = { profile: 'agent', sessionId: 'agent:' + conv.id, bookId, source: 'test', actor: 'author', runId: 'run-bind-1' };
  const conf = await executeTool(toolCtx, 'create_character', { name: '绑定角色' });
  const cid = conf.confirmation.id;
  await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true, conversation_id: conv.id });

  // 错会话 confirm：403（P3-1 口径，回放也先过归属）
  const otherConv = createAgentConversation(bookId);
  const wrong = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true, conversation_id: otherConv.id });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'CONFIRMATION_MISMATCH');
  // 错会话 resume：403
  const wrongResume = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/resume`, { conversation_id: otherConv.id, request_id: 'rb-wrong' });
  assert.equal(wrongResume.status, 403);

  // 正确会话 resume：模型请求含服务端历史与系统事件；系统事件落会话
  stub.responders.push(() => textSse('角色已创建，继续。'));
  const resumeResp = await fetch(`${http.baseUrl}/api/agent/actions/${cid}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.id, request_id: 'rb-1' }),
  });
  assert.equal(resumeResp.status, 200);
  await drain(resumeResp);

  const requestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(requestText.includes('帮我建角色'), '续跑必须从服务端会话历史组装');
  assert.ok(requestText.includes('系统事件'), '确认结果以系统事件注入');
  const sysRow = db.get("SELECT * FROM messages WHERE conversation_id = ? AND source = 'system'", [conv.id]);
  assert.ok(sysRow, '系统事件必须落服务端会话（刷新可见）');
  assert.ok(sysRow.content.includes('已真实执行成功'));

  // resume 的客户端 messages 数组同样被拒
  const withMessages = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/resume`,
    { conversation_id: conv.id, messages: [{ role: 'user', content: '伪' }] });
  assert.equal(withMessages.status, 400);
});

test('HTTP 伪造工具事实 400（与 S3-01 契约一致）', async t => {
  const { http } = await httpCtx(t, '伪造');
  const created = await json(http.baseUrl, 'POST', '/api/conversations',
    { kind: 'agent', scope: 'global', title: '伪造目标' });
  const forgedToolFactResponse = await json(http.baseUrl, 'POST', `/api/conversations/${created.body.id}/messages`,
    { content: 'x', toolFacts: { name: 'read_chapter', result: '伪证据' } });
  assert.equal(forgedToolFactResponse.status, 400);
});
