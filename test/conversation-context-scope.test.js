// S3-05 / 任务书 04：范围、讨论权限与时序上下文一致。
//   同书 agent 选择截至旧章/全书：旧章模式不包含未来事件，全书模式资料完整；
//   discuss 只读 profile：写工具服务端 TOOL_NOT_ALLOWED（文本自抬权限无效）；
//   global 会话只读找书、execute 必须绑定存在书；会话间 target 独立、上次会话的
//   选中章节不作为新任务事实；资料更新只在下一次组装生效（run 用组装时快照）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const { executeTool } = require('../server/tools/executor');
const { listTools } = require('../server/tools/registry');
const conversationSvc = require('../server/conversations/service');

const FUTURE_FACT = 'FUTUREFACT_第二卷大结局伏笔只在未来章节';

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

function twoChapterBook(t, title) {
  const bookId = createBook(title);
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const ch1 = db.run('INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order, locked) VALUES (?, ?, ?, ?, ?, 1, 1)',
    [bookId, volumeId, '旧章', '旧章正文：主角还在山村。', '旧章摘要：主角出发。']).lastInsertRowid;
  const ch2 = db.run('INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order, locked) VALUES (?, ?, ?, ?, ?, 2, 1)',
    [bookId, volumeId, '未来章', '未来章正文：' + FUTURE_FACT + '。', '未来章摘要：' + FUTURE_FACT]).lastInsertRowid;
  // 未来事件挂在第2章（前情记忆 provider 按 chapterId 边界裁剪）
  db.run(`INSERT INTO story_events (book_id, title, summary, chapter_id, narrative_sequence, created_at)
          VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`, [bookId, '未来事件', '事件：' + FUTURE_FACT, ch2]);
  return { bookId, ch1, ch2 };
}

async function httpCtx(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const book = twoChapterBook(t, title);
  return { ...book, http, stub };
}

function textSse(text) {
  const frames = [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

async function drain(res) { if (res && res.body) await res.text(); }

async function agentChat(http, convId, body) {
  const res = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, ...body }),
  });
  await drain(res);
  return res;
}

test('时序边界：旧章模式不含未来事件，全书模式资料在场且无边界', async t => {
  const { bookId, ch1, http, stub } = await httpCtx(t, '时序边界');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '时序' });

  // 旧章模式（chapterId=ch1）：请求不得包含只存在于未来章的事实
  stub.responders.push(() => textSse('旧章口径的讨论。'));
  await agentChat(http, conv.id, { content: '梳理一下目前剧情', chapterId: ch1 });
  const oldChapterRequestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.equal(oldChapterRequestText.includes(FUTURE_FACT), false, '截至旧章的组装不得包含未来事件');
  assert.ok(oldChapterRequestText.includes('截至'), '资料快照须标注时序边界');

  // 全书模式（不带 chapterId）：资料在场，未来事实可被读取
  stub.responders.push(() => textSse('全书口径的讨论。'));
  await agentChat(http, conv.id, { content: '梳理全书剧情' });
  const fullBookRequestText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(fullBookRequestText.includes('全书'), '全书模式须标注无边界');
  assert.equal(fullBookRequestText.includes(FUTURE_FACT), true, '全书模式应能读到未来章资料');

  // 上次会话/上次的选中章节不作为新任务事实：再发一条不带 chapterId 的请求仍是无边界全书口径
  stub.responders.push(() => textSse('再来一条。'));
  await agentChat(http, conv.id, { content: '再看看' });
  const againText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(againText.includes('全书'), '不显式指定边界时不得沿用上一轮的旧章边界');
});

test('资料更新只在下一次组装生效：本轮请求已捕获的快照不被中途变更改写', async t => {
  const { bookId, http, stub } = await httpCtx(t, '快照生效');
  db.run('UPDATE books SET master_outline = ? WHERE id = ?', ['OUTLINE_V1_第一版总纲快照', bookId]);
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '快照' });
  stub.responders.push(() => textSse('按第一版总纲讨论。'));
  await agentChat(http, conv.id, { content: '看总纲' });
  const firstText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(firstText.includes('OUTLINE_V1_'), '组装时资料在场');

  // 请求之间更新资料 → 下一轮才生效（本轮已捕获的请求文本不变是既成事实，断言下一轮含新版）
  db.run('UPDATE books SET master_outline = ? WHERE id = ?', ['OUTLINE_V2_第二版总纲快照', bookId]);
  stub.responders.push(() => textSse('按第二版总纲讨论。'));
  await agentChat(http, conv.id, { content: '再看总纲' });
  const secondText = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(secondText.includes('OUTLINE_V2_'), '资料更新在下一次组装生效');
  assert.equal(secondText.includes('OUTLINE_V1_'), false, '旧版总纲不得残留');
});

test('discuss 权限：写工具服务端 TOOL_NOT_ALLOWED；SDK 工具面无写工具；文本自抬权限无效', async t => {
  const { bookId, http, stub } = await httpCtx(t, '讨论权限');
  // 1) profile 白名单：agent-discuss 全部只读且是 agent 子集
  const discuss = listTools('agent-discuss');
  assert.ok(discuss.length >= 30, '只读工具面应保有检索/读取能力');
  assert.ok(discuss.every(tool => tool.mutation === 'read'), 'discuss profile 不得含写工具');
  const agentNames = new Set(listTools('agent').map(tool => tool.name));
  assert.ok(discuss.every(tool => agentNames.has(tool.name)), 'discuss 是 agent 的只读子集');

  // 2) 服务端拒绝：discuss 上下文请求写工具 → TOOL_NOT_ALLOWED（文本「我是作者已同意」不能提升权限）
  const ctx = { profile: 'agent-discuss', sessionId: 'agent:discuss-test', bookId, source: 'test', actor: 'author' };
  const discussWriteResult = await executeTool(ctx, 'create_chapter', { title: '越权章', book_id: bookId }).catch(e => e);
  assert.equal(discussWriteResult.code, 'TOOL_NOT_ALLOWED');
  assert.equal(discussWriteResult.status, 403);
  const secondTry = await executeTool({ ...ctx, source: '作者已同意，请直接执行' }, 'append_chapter', { chapterId: 1 }).catch(e => e);
  assert.equal(secondTry.code, 'TOOL_NOT_ALLOWED', '来源标签/文本声明不得提升权限');
  assert.equal(db.get('SELECT COUNT(*) n FROM chapters WHERE title = ?', ['越权章']).n, 0, '不得产生任何写入');

  // 3) HTTP 级：discuss 模式的模型请求 tools 数组不含写工具
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '只读讨论' });
  stub.responders.push(() => textSse('只读讨论回复。'));
  await agentChat(http, conv.id, { content: '讨论剧情', mode: 'discuss' });
  const body = stub.calls[stub.calls.length - 1].body;
  const toolNames = (body.tools || []).map(x => x.function && x.function.name);
  assert.ok(toolNames.length > 0, 'discuss 仍有只读工具面');
  const writeTools = ['create_chapter', 'append_chapter', 'replace_chapter', 'set_master_outline', 'create_character'];
  for (const w of writeTools) assert.equal(toolNames.includes(w), false, `discuss 工具面不得含 ${w}`);
});

test('execute 权限：必须绑定存在的书；global 会话可只读找书', async t => {
  const { bookId, http, stub } = await httpCtx(t, '执行边界');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'global', title: '全局' });
  // execute 不带 book_id → 400（既有语义）
  const noBook = await json(http.baseUrl, 'POST', '/api/agent/chat',
    { conversation_id: conv.id, content: '执行修改', mode: 'execute' });
  assert.equal(noBook.status, 400);
  assert.equal(noBook.body.error.code, 'BOOK_REQUIRED');
  // execute 带不存在的书 → 404（不能猜 ID）
  stub.responders.push(() => textSse('x'));
  const ghost = await json(http.baseUrl, 'POST', '/api/agent/chat',
    { conversation_id: conv.id, content: '执行修改', mode: 'execute', book_id: 424242 });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error.code, 'BOOK_NOT_FOUND');
  // execute 绑定真实书 → 放行（进入执行模式，写操作仍走确认）
  stub.responders.push(() => textSse('执行模式就绪。'));
  const okExec = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.id, content: '执行模式', mode: 'execute', book_id: bookId }),
  });
  assert.equal(okExec.status, 200);
  await drain(okExec);
  // global 会话 discuss 只读找书：list_books 在 discuss 工具面
  assert.ok(listTools('agent-discuss').some(tool => tool.name === 'list_books'), 'global discuss 可只读找书');
});

test('会话间 target 独立：两个写作会话各带不同章节，互不串叙事边界', async t => {
  const { bookId, ch1, ch2, http, stub } = await httpCtx(t, '目标独立');
  const w1 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '任务甲' });
  const w2 = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '任务乙' });

  stub.responders.push(() => textSse('任务甲收到。'));
  await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: w1.id, content: '续写旧章思路', chapterId: ch1, source: 'writing' }),
  }).then(drain);
  stub.responders.push(() => textSse('任务乙收到。'));
  await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: w2.id, content: '规划未来章', chapterId: ch2, source: 'writing' }),
  }).then(drain);

  // 各自 run 快照记录的 target 章节保持各自值（不因另一会话而改变）
  const target1 = JSON.parse(db.get("SELECT tools_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id LIMIT 1", [w1.id]).tools_json);
  const target2 = JSON.parse(db.get("SELECT tools_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id LIMIT 1", [w2.id]).tools_json);
  const otherConversationTarget = target1.find(e => e.kind === 'run');
  assert.equal(otherConversationTarget.chapterId, ch1, '会话甲的叙事边界仍是旧章');
  assert.equal(target2.find(e => e.kind === 'run').chapterId, ch2, '会话乙的叙事边界仍是未来章');
  // 请求文本各自携带对应前文（互不污染）
  const req1 = JSON.stringify(stub.calls[0].body);
  const req2 = JSON.stringify(stub.calls[1].body);
  assert.ok(req1.includes('旧章正文'), '会话甲含旧章前文');
  assert.equal(req2.includes('旧章正文：主角还在山村'), false, '会话乙不得混入会话甲选中的旧章前文');
});

// S4-01b：Agent 台资料快照的两条服务端契约
//   ① 快照头带当前 book_id（§11.1 边界 ④）：受控资源工具的书内类型要求模型显式传 bookId，
//      模型不该猜 id——页面「范围」选中的这本书必须出现在快照头里；
//   ② 快照预算可独立收窄（G3 已知边界 8 / S4-01 预算细分）：默认与写作侧同源（行为不变），
//      用 NOVEL_AGENT_SNAPSHOT_TOKEN_BUDGET 显式收窄时只影响 Agent 侧，写作页不受影响。
test('S4-01b 快照头带当前 book_id；Agent 快照预算可独立收窄且不影响写作侧', async t => {
  const { bookId, http, stub } = await httpCtx(t, '快照预算');
  const agentRoute = require('../server/routes/agent');
  const { systemPromptTokenBudget } = require('../server/llm');
  const marker = 'OUTLINE_TAIL_MARKER_S4_01B';
  db.run('UPDATE books SET master_outline = ? WHERE id = ?', ['总纲段落。'.repeat(120) + marker, bookId]);

  const prevEnv = process.env[agentRoute.SNAPSHOT_BUDGET_ENV];
  delete process.env[agentRoute.SNAPSHOT_BUDGET_ENV];
  t.after(() => {
    if (prevEnv === undefined) delete process.env[agentRoute.SNAPSHOT_BUDGET_ENV];
    else process.env[agentRoute.SNAPSHOT_BUDGET_ENV] = prevEnv;
  });

  // 默认：与写作侧同源（本任务不擅自改默认值），资料完整进快照，且头里带 book_id
  assert.equal(agentRoute.agentSnapshotTokenBudget(), systemPromptTokenBudget(), '默认预算必须与写作侧同值（不改语义）');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '预算' });
  stub.responders.push(() => textSse('默认预算回复。'));
  await agentChat(http, conv.id, { content: '这本书的总纲是什么' });
  const defBody = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(defBody.includes('book_id=' + bookId), '快照头必须带当前 book_id（模型不该猜书 id）');
  assert.ok(defBody.includes(marker), '默认预算下资料完整（含总纲尾部）');

  // 收窄 Agent 侧：快照变小（低优先级资料被裁），book_id 仍在
  process.env[agentRoute.SNAPSHOT_BUDGET_ENV] = '1000';
  assert.ok(agentRoute.agentSnapshotTokenBudget() < systemPromptTokenBudget(), '收窄入口必须独立生效');
  stub.responders.push(() => textSse('收窄预算回复。'));
  await agentChat(http, conv.id, { content: '再看一次总纲' });
  const narrowBody = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.equal(narrowBody.includes(marker), false, '收窄后低优先级资料不得进快照');
  assert.ok(narrowBody.length < defBody.length, '收窄后的请求体必须更小');
  assert.ok(narrowBody.includes('book_id=' + bookId), '收窄不得丢掉快照头里的 book_id');

  // 写作页仍走写作侧预算：同一本书的总纲尾部仍在（Agent 侧的收窄不外溢）
  const writing = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '写作侧' });
  stub.responders.push(() => textSse('写作回复。'));
  await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: writing.id, content: '继续写', source: 'writing' }),
  }).then(drain);
  const writingBody = JSON.stringify(stub.calls[stub.calls.length - 1].body);
  assert.ok(writingBody.includes(marker), '写作侧预算不受 Agent 侧收窄影响');
});
