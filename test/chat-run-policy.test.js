const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const chatRouter = require('../server/routes/chat');
const { installFetchStub, jsonStub, chatPayload, toolCall } = require('./helpers/llm-stub');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['有界循环']).lastInsertRowid;
  t.after(() => { stub.restore(); cleanup(location); });
  return { bookId, stub };
}

const cfg = { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' };
const convo = () => [{ role: 'system', content: '系统' }, { role: 'user', content: '先查清再建章' }];

test('五步读取后仍能申请建章，每轮保留工具', async t => {
  const { bookId, stub } = await setup(t);
  for (let index = 0; index < 5; index++) stub.responders.push(() => jsonStub(chatPayload({ toolCalls: [toolCall('read-' + index, 'list_chapters', {})], finish: 'tool_calls' })));
  stub.responders.push(() => jsonStub(chatPayload({ toolCalls: [toolCall('create', 'create_chapter', {})], finish: 'tool_calls' })));
  stub.responders.push(() => jsonStub(chatPayload({ content: '已提交待作者确认，尚未写入。' })));
  const actions = [];
  await chatRouter.followUpRounds(bookId, convo(), cfg, { onAction: action => actions.push(action) });
  assert.equal(actions.length, 1);
  assert.ok(stub.calls.slice(0, 6).every(call => Array.isArray(call.body.tools)));
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?', [bookId]).count, 0);
});

test('最后预算轮仍带工具，耗尽明确paused而非假完成', async t => {
  const { bookId, stub } = await setup(t);
  for (let index = 0; index < 2; index++) stub.responders.push(() => jsonStub(chatPayload({ toolCalls: [toolCall('read-' + index, 'list_chapters', {})], finish: 'tool_calls' })));
  const hooks = {};
  const result = await chatRouter.followUpRounds(bookId, convo(), cfg, hooks, 2);
  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.every(call => Array.isArray(call.body.tools)));
  assert.equal(hooks._runState.status, 'paused');
  assert.match(result.content, /暂停/);
});

test('预算同时限制时间、结果与步骤，取消优先', () => {
  const policy = require('../server/chat/run-policy');
  const budget = policy.createBudget({ maxSteps: 2, maxResultChars: 50, maxDurationMs: 100, now: 0 });
  assert.equal(policy.stopReason(budget, { now: 99 }), null);
  assert.equal(policy.stopReason(budget, { now: 101 }), 'time_budget');
  assert.equal(policy.stopReason(budget, { now: 1, resultChars: 51 }), 'result_budget');
  budget.steps = 2;
  assert.equal(policy.stopReason(budget, { now: 1 }), 'step_budget');
  assert.equal(policy.stopReason(budget, { aborted: true }), 'cancelled');
});


test('截断的工具参数不执行，状态明确暂停', async t => {
  const { bookId, stub } = await setup(t);
  stub.responders.push(() => jsonStub(chatPayload({ toolCalls: [toolCall('cut', 'create_chapter', {})], finish: 'length' })));
  const hooks = {};
  await chatRouter.followUpRounds(bookId, convo(), cfg, hooks);
  assert.equal(hooks._runState.reason, 'output_truncated');
  assert.equal(stub.calls.length, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions').count, 0);
});

// S2-04 / C09：流式收尾——finish=length 的半句在续写补不齐时按 paused/output_truncated
// 落运行终态（不谎称 finished）；run 行与 done 事件都查（不只气泡文字）。
test('流式截断半句续写补不齐 → run 终态 paused/output_truncated，正文作为部分结果保留', async t => {
  const { bookId, stub, http } = await setupHttp(t);
  const { sseStub, readStreamEvents } = require('./helpers/llm-stub');
  // 首轮 length + 半句；续写轮同样 length 且不增长（补不齐）
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '他推开门，风' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]));
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '又停了' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]));
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '再停' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]));
  const events = await readStreamEvents(await postJson(http, '/api/books/' + bookId + '/chat/stream', { content: '写一句' }));
  const done = events.find(e => e.type === 'done');
  assert.equal(done.run.status, 'paused');
  assert.equal(done.run.reason, 'output_truncated');
  // 半句作为部分结果保留（任务书：不自动补写，但已产出的部分不丢）
  assert.ok(done.content.includes('他推开门'));
  const run = db.get("SELECT status, reason FROM agent_runs ORDER BY created_at DESC LIMIT 1");
  assert.equal(run.status, 'paused');
  assert.equal(run.reason, 'output_truncated');
  const saved = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(saved.content.includes('他推开门'), '部分输出入库');
});


test('确认请求立即暂停，同批后续工具不执行不猜ID', async t => {
  const { bookId, stub } = await setup(t);
  const chapterId = db.run('INSERT INTO chapters (book_id,title) VALUES (?, ?)', [bookId, '原章']).lastInsertRowid;
  stub.responders.push(() => jsonStub(chatPayload({ toolCalls: [toolCall('new', 'create_chapter', {}), toolCall('guess', 'replace_chapter', { chapterId, content: '不能写到旧章' })], finish: 'tool_calls' })));
  const hooks = {};
  const result = await chatRouter.followUpRounds(bookId, convo(), cfg, hooks, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions').count, 1);
  assert.equal(hooks._runState.status, 'awaiting_confirmation');
  assert.match(result.content, /尚未生效/);
  assert.equal(stub.calls.length, 1);
});

test('首轮虚报写入被系统校正，正文和目录未改变', async t => {
  const { bookId, stub } = await setup(t);
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const { sseStub, readStreamEvents } = require('./helpers/llm-stub');
  db.run("INSERT INTO settings (key,value) VALUES ('base_url', ?), ('api_key', ?), ('model', ?)", [cfg.baseUrl, cfg.apiKey, cfg.model]);
  const http = await listen(createApp());
  t.after(() => http.close());
  stub.responders.push(() => sseStub([{ choices: [{ delta: { content: '第1章正文已写入。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  const response = await fetch(http.baseUrl + '/api/books/' + bookId + '/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '保存正文' }) });
  const events = await readStreamEvents(response);
  const done = events.find(event => event.type === 'done');
  assert.equal(done.run.status, 'paused');
  assert.equal(done.run.reason, 'unverified_write');
  assert.match(done.content, /未验证/);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chapters').count, 0);
});

test('独立Agent串行结算同批工具，确认后不执行依赖工具', async t => {
  const { bookId } = await setup(t);
  const policy = require('../server/chat/run-policy');
  const gate = policy.createToolGate(policy.createBudget());
  const { buildTools } = require('../server/agent/tools');
  const tools = await buildTools({ sessionId: 'agent:test-gate', runGate: gate });
  const results = await Promise.all([tools.create_chapter.execute({ bookId }), tools.create_chapter.execute({ bookId, title: '不应创建第二张卡' })]);
  assert.equal(results[0].data.status, 'confirmation_required');
  assert.equal(results[1].ok, false);
  assert.equal(gate.state.status, 'awaiting_confirmation');
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions').count, 1);
});


async function setupHttp(t) {
  const fixture = await setup(t);
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  db.run("INSERT INTO settings (key,value) VALUES ('base_url', ?), ('api_key', ?), ('model', ?)", [cfg.baseUrl, cfg.apiKey, cfg.model]);
  fixture.http = await listen(createApp());
  t.after(() => fixture.http.close());
  return fixture;
}

function postJson(http, path, body) {
  return fetch(http.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('首轮正文与工具共存且finish=stop仍执行，确认续跑采用新章真实ID', async t => {
  const { bookId, stub, http } = await setupHttp(t);
  const { sseStub, readStreamEvents } = require('./helpers/llm-stub');
  const oldChapterId = db.run('INSERT INTO chapters (book_id,title,content) VALUES (?, ?, ?)', [bookId, '旧章', '旧文']).lastInsertRowid;
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '我来新建章节。', tool_calls: [{ index: 0, ...toolCall('create', 'create_chapter', {}) }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const events = await readStreamEvents(await postJson(http, '/api/books/' + bookId + '/chat/stream', { content: '新建下一章', chapterId: oldChapterId }));
  const action = events.find(event => event.type === 'action');
  assert.ok(action);
  assert.equal(events.find(event => event.type === 'done').run.status, 'awaiting_confirmation');
  assert.equal(stub.calls.length, 1);
  const confirmed = await postJson(http, '/api/books/' + bookId + '/chat-actions/' + action.id + '/confirm', { approve: true });
  assert.equal(confirmed.status, 200);
  const newChapter = db.get('SELECT id FROM chapters WHERE book_id = ? ORDER BY id DESC LIMIT 1', [bookId]);
  assert.notEqual(newChapter.id, oldChapterId);
  stub.responders.push(() => sseStub([{ choices: [{ delta: { content: '可以继续写新章。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  const resumed = await readStreamEvents(await postJson(http, '/api/books/' + bookId + '/chat/stream', { resumeActionId: action.id, chapterId: oldChapterId }));
  assert.equal(resumed.find(event => event.type === 'done').run.status, 'finished');
  const context = stub.calls[1].body.messages[0].content;
  assert.ok(context.includes('本轮任务目标：'));
  assert.match(context, new RegExp('本轮任务目标：[^\\n]*chapterId=' + newChapter.id));
});

test('真实SDK入口确认即停，并输出与写作页相同的运行状态', async t => {
  const { bookId, stub, http } = await setupHttp(t);
  const { readStreamEvents } = require('./helpers/llm-stub');
  const frames = [
    { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: cfg.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall('sdk-new', 'create_chapter', { book_id: bookId }) }, { index: 1, ...toolCall('sdk-next', 'create_chapter', { book_id: bookId }) }] }, finish_reason: null }] },
    { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: cfg.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  stub.responders.push(() => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const conv1 = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title: 'sdk工具' });
  const events = await readStreamEvents(await postJson(http, '/api/agent/chat', { conversation_id: conv1.id, content: '创建章节', mode: 'execute', book_id: bookId }));
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
  const finish = events.find(event => event.type === 'finish');
  assert.equal(finish.messageMetadata.run.status, 'awaiting_confirmation');
  assert.match(finish.messageMetadata.finalContent, /尚未生效/);
  assert.equal(stub.calls.length, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions').count, 1);
});


test('独立SDK首轮虚报保存也被统一核验', async t => {
  const { stub, http } = await setupHttp(t);
  const { readStreamEvents } = require('./helpers/llm-stub');
  const frames = [
    { id: 'chat-text', created: 1, model: cfg.model, choices: [{ index: 0, delta: { role: 'assistant', content: '第1章正文已写入。' }, finish_reason: null }] },
    { id: 'chat-text', created: 1, model: cfg.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  stub.responders.push(() => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const conv2 = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title: 'sdk虚报' });
  const events = await readStreamEvents(await postJson(http, '/api/agent/chat', { conversation_id: conv2.id, content: '保存正文' }));
  const finish = events.find(event => event.type === 'finish');
  assert.equal(finish.messageMetadata.run.reason, 'unverified_write');
  assert.match(finish.messageMetadata.finalContent, /未验证/);
  assert.equal(stub.calls.length, 1);
});

test('SSE消费者保留书聊运行状态，SDK最终核验覆盖流中虚报', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = { window: {}, console, TextDecoder };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/legacy/chat-event-hub.js'), 'utf8'), context);
  const hub = context.window.ChatEventHub;
  const state = hub.createTranscript();
  hub.foldEvent(state, { type: 'done', content: '等确认', run: { status: 'awaiting_confirmation' } });
  assert.equal(state.run.status, 'awaiting_confirmation');
  const frames = [ { type: 'text-delta', delta: '第1章正文已写入。' }, { type: 'finish', messageMetadata: { run: { status: 'paused' }, finalContent: '未验证写入' } } ];
  const response = new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  const result = await hub.consumeAgentStream(response, {});
  assert.equal(result.text, '未验证写入');
  assert.equal(result.run.status, 'paused');
});

for (const status of ['rejected', 'failed', 'approved', 'expired']) {
  test('已结算确认不再虚报等待：' + status, () => {
    const policy = require('../server/chat/run-policy');
    const result = policy.finalizeText('系统已自动发起创建章节的确认请求，等待您的确认。确认后将新建一章。', { status: 'finished' }, { settledAction: { id: 'settled', name: 'create_chapter', status } });
    assert.doesNotMatch(result.content, /等待您的确认|确认后将/);
    assert.equal(result.state.settledConfirmation.status, status);
    assert.equal(result.state.reason, 'settled_confirmation_corrected');
  });
}

test('确认核验保留真实新卡、诚实拒绝与普通讨论', () => {
  const policy = require('../server/chat/run-policy');
  const settledAction = { id: 'old', name: 'create_chapter', status: 'rejected' };
  for (const content of ['您已拒绝，本次未执行。', '此前已提交确认请求，但您已拒绝，本次未执行。', '已经拒绝，无需再等待您的确认。', '如果以后想重试，可以重新申请确认。', '可以先讨论下一章的冲突。']) {
    assert.equal(policy.finalizeText(content, { status: 'finished' }, { settledAction }).content, content);
  }
  const pending = policy.waitingState('create_chapter', 'new', policy.createBudget());
  const result = policy.finalizeText('旧请求被拒绝', pending, { settledAction });
  assert.equal(result.state.confirmationId, 'new');
  assert.match(result.content, /等待作者确认/);
});

for (const entry of ['agent', 'chat']) {
  test(entry + '拒绝续跑纠正模型虚报并保留未写入事实', async t => {
    const { bookId, stub, http } = await setupHttp(t);
    const actionStore = require('../server/actionStore');
    const { sseStub, readStreamEvents } = require('./helpers/llm-stub');
    let convId = null;
    if (entry === 'agent') {
      const svc = require('../server/conversations/service');
      const conv = svc.createConversation({ kind: 'agent', scope: 'global', title: '续跑纠正' });
      const iso = new Date().toISOString();
      db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at, finished_at) VALUES ('run_rc_1', 'rq_rc_1', ?, ?, 'agent', 'execute', 'finished', ?, ?)`, ['agent:' + conv.id, conv.id, iso, iso]);
      convId = conv.id;
    }
    const action = actionStore.create(bookId, 'create_chapter', {}, { sessionId: entry === 'agent' ? 'agent:' + convId : 'agent:anonymous', runId: entry === 'agent' ? 'run_rc_1' : null });
    actionStore.settle(action.id, 'rejected');
    const frames = [
      { id: 'chat-rejected', created: 1, model: cfg.model, choices: [{ index: 0, delta: { role: 'assistant', content: '系统已自动发起创建章节的确认请求，等待您的确认。确认后将为您新建一章。' }, finish_reason: null }] },
      { id: 'chat-rejected', created: 1, model: cfg.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    stub.responders.push(() => entry === 'agent'
      ? new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : sseStub(frames));
    const path = entry === 'agent' ? '/api/agent/actions/' + action.id + '/resume' : '/api/books/' + bookId + '/chat/stream';
    const body = entry === 'agent' ? { conversation_id: convId } : { resumeActionId: action.id };
    const events = await readStreamEvents(await postJson(http, path, body));
    const final = entry === 'agent' ? events.find(event => event.type === 'finish')?.messageMetadata : events.find(event => event.type === 'done');
    assert.ok(final, JSON.stringify(events));
    const content = final.finalContent ?? final.content;
    assert.match(content, /拒绝/);
    assert.doesNotMatch(content, /等待您的确认|确认后将/);
    assert.equal(final.run.settledConfirmation.status, 'rejected');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?', [bookId]).count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions WHERE book_id = ?', [bookId]).count, 1);
    if (entry === 'chat') assert.equal(db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [bookId]).content, content);
  });
}


for (const entry of ['agent', 'chat']) {
  test(entry + '拒绝续跑中的重复写调用不得产生新确认卡', async t => {
    const { bookId, stub, http } = await setupHttp(t);
    const actionStore = require('../server/actionStore');
    const { sseStub, readStreamEvents } = require('./helpers/llm-stub');
    let convId = null;
    if (entry === 'agent') {
      const svc = require('../server/conversations/service');
      const conv = svc.createConversation({ kind: 'agent', scope: 'global', title: '续跑重复写' });
      const iso = new Date().toISOString();
      db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at, finished_at) VALUES ('run_rc_2', 'rq_rc_2', ?, ?, 'agent', 'execute', 'finished', ?, ?)`, ['agent:' + conv.id, conv.id, iso, iso]);
      convId = conv.id;
    }
    const action = actionStore.create(bookId, 'create_chapter', {}, { sessionId: entry === 'agent' ? 'agent:' + convId : 'agent:anonymous', runId: entry === 'agent' ? 'run_rc_2' : null });
    actionStore.settle(action.id, 'rejected');
    const frames = [
      { id: 'chat-repeat', created: 1, model: cfg.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall('retry', 'create_chapter', { book_id: bookId }) }, { index: 1, ...toolCall('retry-next', 'create_chapter', { book_id: bookId }) }] }, finish_reason: null }] },
      { id: 'chat-repeat', created: 1, model: cfg.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    stub.responders.push(() => entry === 'agent'
      ? new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : sseStub(frames));
    const path = entry === 'agent' ? '/api/agent/actions/' + action.id + '/resume' : '/api/books/' + bookId + '/chat/stream';
    const body = entry === 'agent' ? { conversation_id: convId } : { resumeActionId: action.id };
    const events = await readStreamEvents(await postJson(http, path, body));
    const final = entry === 'agent' ? events.find(event => event.type === 'finish')?.messageMetadata : events.find(event => event.type === 'done');
    assert.ok(final, JSON.stringify(events));
    assert.equal(db.get('SELECT COUNT(*) AS count FROM chat_actions WHERE book_id = ?', [bookId]).count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?', [bookId]).count, 0);
    assert.equal(final.run.reason, 'action_rejected');
    assert.match(final.finalContent ?? final.content, /拒绝/);
    assert.equal(stub.calls.length, 1);
  });
}

test('拒绝续跑只读权限不污染下一用户轮，获批和失败后仍可申请新卡', async t => {
  const { bookId } = await setup(t);
  const { executeTool } = require('../server/tools/executor');
  const actionStore = require('../server/actionStore');
  const action = actionStore.create(bookId, 'create_chapter', {});
  actionStore.settle(action.id, 'rejected');
  const context = { profile: 'writing', bookId, settledAction: actionStore.get(action.id) };
  await assert.rejects(executeTool(context, 'create_chapter', {}), { code: 'ACTION_REJECTED' });
  assert.ok(await executeTool(context, 'list_chapters', {}));
  for (const status of [null, 'approved', 'failed']) {
    const next = { ...context, settledAction: status ? { ...context.settledAction, status } : null };
    assert.equal((await executeTool(next, 'create_chapter', {})).status, 'confirmation_required');
  }
});

test('拒绝说明提及工具名时不被未保存提示覆盖', () => {
  const policy = require('../server/chat/run-policy');
  const settledAction = { id: 'rejected', name: 'create_chapter', status: 'rejected' };
  for (const content of ['已查看书籍状态。\n书名：测试书。\n当前章节数：5。\n系统已返回作者拒绝确认，create_chapter 操作未执行。', '第1章正文已写入。']) {
    const final = policy.finalizeText(content, { status: 'finished' }, { settledAction });
    assert.match(final.content, /作者已拒绝/);
    assert.doesNotMatch(final.content, /请检查章节或继续请求实际写入|正文已写入/);
    assert.equal(final.state.settledConfirmation.status, 'rejected');
  }
});

test('确认等待变体受结算约束，暂停与取消优先', () => {
  const policy = require('../server/chat/run-policy');
  const settledAction = { id: 'settled', name: 'create_chapter', status: 'rejected' };
  for (const content of ['请确认创建章节。', '该操作仍处于待确认状态。', '确认后即可继续。', 'Waiting for your confirmation.']) {
    const final = policy.finalizeText(content, { status: 'finished' }, { settledAction });
    assert.match(final.content, /作者已拒绝/);
  }
  for (const status of ['paused', 'cancelled', 'failed']) {
    const final = policy.finalizeText('等待您的确认', { status, reason: 'step_budget' }, { settledAction });
    assert.equal(final.state.status, status);
    assert.notEqual(final.state.reason, 'settled_confirmation_corrected');
  }
  assert.equal(policy.finalizeText('正文已写入。', { status: 'finished' }, { verifiedWrite: true, settledAction: { ...settledAction, status: 'approved' } }).content, '正文已写入。');
});
