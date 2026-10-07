// M3：abort 贯穿全链路的单测——断连即停后续轮、闸门必释放、abort 台账、前置检查即刻终止。
// 全部走「计数 fetch mock」（只拦截 /chat/completions，其余 URL 透传原 fetch），
// key 用 sk-test-xxx，不真调外部网络（LLM 端点为不存在的 http://llm-stub.local，仅作占位）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const chatRouter = require('../server/routes/chat');

const enc = (s) => new TextEncoder().encode(s);

// ---------------- fetch 计数 mock（仅拦截 LLM 端点） ----------------
function installFetchStub() {
  const orig = global.fetch;
  const calls = [];
  const responders = []; // 队列：每个 () => Response | Promise；耗尽即抛错（不该发生）
  global.fetch = async (url, init) => {
    if (!String(url).includes('/chat/completions')) return orig(url, init);
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null, init });
    const respond = responders.shift();
    if (!respond) throw new Error('fetch stub exhausted: 意料之外的额外 LLM 调用');
    return respond(init);
  };
  return {
    calls,
    responders,
    restore: () => { global.fetch = orig; },
  };
}

// 脚本化 SSE 响应（web ReadableStream，与 undici res.body 同具 getReader/cancel）
function sseStub(frames) {
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc(`data: ${JSON.stringify(f)}\n\n`));
      controller.enqueue(enc('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

// 悬挂的非流式响应：永不 resolve，直到 init.signal abort 才 reject（模拟慢 LLM，尊重取消）
function hangingNonStream(init) {
  return new Promise((resolve, reject) => {
    const s = init && init.signal;
    const abortErr = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); };
    if (!s) return reject(new Error('stub: 无 signal，无法模拟慢流'));
    if (s.aborted) return abortErr();
    s.addEventListener('abort', abortErr, { once: true });
  });
}

// 悬挂的 SSE：吐一帧后保持打开（服务端 abort 时 readChatSSEStream 自会 cancel 读端）
function hangingSse() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { content: '正在写。' } }] })}\n\n`));
      /* 不 close：模拟生成中的慢流 */
    },
  });
  return { ok: true, status: 200, body };
}

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run("INSERT INTO books (title) VALUES (?)", [title]).lastInsertRowid;
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local/v1')");
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'agnes-2.5-flash')");
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    await http.close();
    stub.restore();
    cleanup(location);
  });
  return { bookId, http, stub };
}

async function waitUntil(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise(r => setTimeout(r, 25));
  }
}

async function readStreamEvents(res) {
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

test('非流式断连中止上游调用并释放写锁', async t => {
  const { bookId, http, stub } = await setup(t, '非流式断连');
  stub.responders.push(init => hangingNonStream(init));
  const clientAc = new AbortController();
  const pending = fetch(http.baseUrl + '/api/books/' + bookId + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '缓慢问题' }), signal: clientAc.signal,
  });
  await waitUntil(() => stub.calls.length === 1);
  clientAc.abort();
  await pending.catch(() => {});
  await waitUntil(() => db.get("SELECT status FROM agent_runs WHERE entry = 'chat' ORDER BY created_at DESC LIMIT 1")?.status === 'cancelled');
  assert.equal(stub.calls[0].init.signal.aborted, true);
  stub.responders.push(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '已经恢复。' }, finish_reason: 'stop' }] }) }));
  const next = await fetch(http.baseUrl + '/api/books/' + bookId + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '下一条' }),
  });
  assert.equal(next.status, 200);
});

test('M3 断连即停：followUp 悬挂中断开客户端 → 无后续 LLM 调用 + abort 台账 + 不落半截回复', async t => {
  const ctx = await setup(t, 'M3 断连即停');
  const { bookId, http, stub } = ctx;
  stub.responders.push(
    // 1) 首轮流式：返回一个只读工具调用（get_story_state），finish=tool_calls
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) followUp 首个后续轮（非流式）：悬挂慢流，abort 才结束——断连应在此打断
    (init) => hangingNonStream(init),
    // 3) 若 abort 未贯穿，模型会继续追加 markup-retry/收尾轮/regen——这些都不应发生
    () => { throw new Error('断连后不应有第三次 LLM 调用'); },
  );

  const clientAc = new AbortController();
  const resPromise = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '看看当前状态' }),
    signal: clientAc.signal,
  });
  const res = await resPromise; // 头已到，开始读流
  await waitUntil(() => stub.calls.length >= 2); // 等后续轮真正发出（token 已在烧的时点）
  clientAc.abort();                              // 客户端断连
  await res.text().catch(() => '');              // 客户端侧流随 abort 结束
  await new Promise(r => setTimeout(r, 500));    // 等服务端 settle（abort 扇出 + catch 路径）

  assert.equal(stub.calls.length, 2, `断连后不得再有 LLM 调用（实际 ${stub.calls.length} 次）`);
  const abortRow = db.get("SELECT status, error FROM llm_calls WHERE book_id = ? AND scope = 'chat-abort'", [bookId]);
  assert.ok(abortRow, 'llm_calls 应记录 chat-abort（abort 原因，复用 scope 体系）');
  assert.equal(abortRow.status, 'error');
  assert.ok(String(abortRow.error).includes('断连'), `abort 台账应含断连原因，实际：${abortRow.error}`);
  const followRow = db.get("SELECT id FROM llm_calls WHERE book_id = ? AND scope = 'chat-followup'", [bookId]);
  assert.ok(!followRow, '被打断的后续轮不应产生 ok 台账行（调用未完成即被 abort）');

  const rows = db.all('SELECT role FROM messages WHERE book_id = ? ORDER BY id', [bookId]);
  assert.deepEqual(rows.map(r => r.role), ['user'], '断连：用户消息保留（真实历史），不落未完成的 assistant');
});

test('M3 闸门必释放：断连中止后立即可发起新一轮，不被 409 卡死', async t => {
  const ctx = await setup(t, 'M3 闸门释放');
  const { bookId, http, stub } = ctx;
  stub.responders.push(
    // 1) 首轮流式：吐一帧后悬挂（生成中的慢流）
    () => hangingSse(),
    // 2) 断连后的新一轮：正常完成
    () => sseStub([
      { choices: [{ delta: { content: '恢复后的回复。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  );

  const clientAc = new AbortController();
  const resPromise = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '写一段长的' }),
    signal: clientAc.signal,
  });
  await resPromise;
  await waitUntil(() => stub.calls.length >= 1);
  await new Promise(r => setTimeout(r, 150)); // 确认进入流中（首帧已到）
  clientAc.abort();                           // 中途断开
  await new Promise(r => setTimeout(r, 400)); // 等 close → releaseRun + runAbort 扇出

  // 断连后立刻再发：闸门必须已释放（不被上一轮卡 409），且新一轮正常完成
  const second = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '再来一条' }),
  });
  assert.equal(second.status, 200, '断连中止后闸门必须释放，新请求不得 409');
  const events = await readStreamEvents(second);
  assert.ok(events.some(e => e.type === 'done' && e.content.includes('恢复后的回复')), '新一轮应正常产出 done');
  assert.equal(stub.calls.length, 2, '断连的那轮不应再补发任何 LLM 调用');

  // 闸门可重复使用：第三轮也不应被卡
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '第三条。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
  ]));
  const third = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '第三条' }),
  });
  assert.equal(third.status, 200);
  assert.ok((await readStreamEvents(third)).some(e => e.type === 'done'));
});

test('M3 前置检查：followUpRounds 收到已 abort 的 signal → 零 LLM 调用即刻返回', async t => {
  const ctx = await setup(t, 'M3 前置检查');
  const { bookId, stub } = ctx;
  stub.responders.push(() => { throw new Error('已 abort 的 signal 不应发起任何 LLM 调用'); });
  const ac = new AbortController();
  ac.abort(new Error('client disconnected'));
  const out = await chatRouter.followUpRounds(
    bookId,
    [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
    {},
    3,
    ac.signal,
  );
  assert.equal(stub.calls.length, 0, '每轮前置检查应即刻终止，零调用');
  assert.equal(out.content, '', '返回已累积产出（此处为空）');
});

test('M3 确认续跑边界：断连后的续跑不重放——唯一绑定保留，重试返回既有 cancelled 运行', async t => {
  const ctx = await setup(t, 'M3 续跑重试');
  const { bookId, http, stub } = ctx;
  const actionStore = require('../server/actionStore');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'x' });
  actionStore.settle(action.id, 'approved', { ok: true });

  stub.responders.push(() => hangingSse());
  const clientAc = new AbortController();
  const resPromise = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeActionId: action.id }),
    signal: clientAc.signal,
  });
  await resPromise;
  await waitUntil(() => stub.calls.length >= 1);
  await new Promise(r => setTimeout(r, 150));
  clientAc.abort();
  await new Promise(r => setTimeout(r, 400));
  assert.notEqual(actionStore.get(action.id).resumeDone, true, '断连的续跑不得置 resumeDone');

  // S2-03 / C08：断连后重发续跑（resume_action_id 唯一索引）返回既有 cancelled 运行，
  // 不重跑模型、不写信封——续跑运行可能已产生部分写副作用，重放会二次执行；
  // 继续任务的正确方式是发普通消息（模型在历史里看到上一次终态与真实结果）。
  const callsBeforeRetry = stub.calls.length;
  const second = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeActionId: action.id }),
  });
  assert.equal(second.status, 200, '既有 cancelled 运行已终结 → 200 duplicate');
  let dupBody = null;
  try { dupBody = await second.json(); } catch (e) { /* 不应是 SSE */ }
  assert.equal(dupBody && dupBody.duplicate, true);
  assert.equal(dupBody.status, 'cancelled');
  assert.equal(stub.calls.length, callsBeforeRetry, '重发续跑不得再调模型');
  assert.equal(actionStore.get(action.id).resumeDone !== true, true, '重放被拦截，resumeDone 仍未置位');
});
