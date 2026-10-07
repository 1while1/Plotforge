// S2-01：共享运行记录与并发协调——run-service 单测 + 双入口 HTTP 集成。
// 单测：幂等占位、锁 owner 语义、占位落盘失败不调模型、事件顺序与脱敏、重启恢复。
// HTTP：同 requestId 重复请求只跑一次（202 JSON）、不同 requestId 忙 409、
// Agent execute 与该书写作冲突 409、discuss 不占写锁、runs API 归属/分页。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const runSvc = require('../server/runtime/run-service');

const enc = (s) => new TextEncoder().encode(s);

// ---------------- fetch 计数 mock（与 chat-abort 同款：只拦 /chat/completions） ----------------
function installFetchStub() {
  const orig = global.fetch;
  const calls = [];
  const responders = [];
  global.fetch = async (url, init) => {
    if (!String(url).includes('/chat/completions')) return orig(url, init);
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const respond = responders.shift();
    if (!respond) throw new Error('fetch stub exhausted: 意料之外的额外 LLM 调用');
    return respond(init);
  };
  return { calls, responders, restore: () => { global.fetch = orig; } };
}

function sseDone(text) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
      controller.enqueue(enc('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

// 悬挂 SSE：吐一帧后不 close（模拟生成中，让闸门保持占用）
function hangingSse() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { content: '正在写。' } }] })}\n\n`));
    },
  });
  return { ok: true, status: 200, body };
}

// 可控 SSE：立即给响应头（悬挂流），close() 时以 [DONE] 正常收尾（不触发服务端续写）
function controllableSse() {
  let ctl;
  const body = new ReadableStream({
    start(controller) {
      ctl = controller;
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { content: '正在写。' } }] })}\n\n`));
    },
  });
  return {
    response: { ok: true, status: 200, body },
    close: () => {
      try {
        ctl.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
        ctl.enqueue(enc('data: [DONE]\n\n'));
        ctl.close();
      } catch (_) {}
    },
  };
}

async function setupDb(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  // agent_runs.book_id 有外键——单测引用的书号必须真实存在（1..9）
  for (let i = 1; i <= 9; i++) db.run('INSERT INTO books (title) VALUES (?)', ['书' + i]);
  t.after(() => cleanup(location));
}

async function setupHttp(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('运行协调测试书')").lastInsertRowid;
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local/v1')");
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'agnes-2.5-flash')");
  const stub = installFetchStub();
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    await http.close();
    stub.restore();
    cleanup(location);
  });
  return { bookId, http, stub };
}

// 消费 SSE 流到结束，收集事件
async function consumeSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (line && line !== 'data: [DONE]') events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

// ---------------- 单元：run-service ----------------

test('startRun 幂等：同 session+request 返回同一运行，不新插行', async t => {
  await setupDb(t);
  const first = runSvc.startRun({ sessionKey: 'writing:book:1', requestId: 'req-a', entry: 'chat', bookId: 1, mode: 'write' });
  assert.equal(first.duplicate, false);
  const dup = runSvc.startRun({ sessionKey: 'writing:book:1', requestId: 'req-a', entry: 'chat', bookId: 1, mode: 'write' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.run.id, first.run.id, '同 requestId 必须拿到同一 runId');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM agent_runs').n, 1, '不新插行');
  // 不同 session 同 requestId 是不同运行（会话隔离）
  const other = runSvc.startRun({ sessionKey: 'writing:book:2', requestId: 'req-a', entry: 'chat', bookId: 2, mode: 'write' });
  assert.equal(other.duplicate, false);
});

test('resume_action_id 库级唯一：换 requestId 也拿回既有续跑运行', async t => {
  await setupDb(t);
  const r1 = runSvc.startRun({ sessionKey: 'agent:s1', requestId: 'r1', entry: 'agent', mode: 'execute', bookId: 1, resumeActionId: 'act_1' });
  const r2 = runSvc.startRun({ sessionKey: 'agent:s1', requestId: 'r2-完全不同的请求', entry: 'agent', mode: 'execute', bookId: 1, resumeActionId: 'act_1' });
  assert.equal(r2.duplicate, true, '同一确认动作的续跑运行只能有一个');
  assert.equal(r2.run.id, r1.run.id);
});

test('锁 owner 语义：只有持有者能释放；异常路径 finally 释放', async t => {
  await setupDb(t);
  const scope = runSvc.bookWriteScope(9);
  assert.equal(runSvc.acquireScopes([scope], 'run_owner_1').ok, true);
  assert.equal(runSvc.acquireScopes([scope], 'run_owner_2').ok, false, '他人占用时不可得');
  runSvc.releaseScopes([scope], 'run_owner_2');
  assert.ok(runSvc.lockSnapshot().some(l => l.scope === scope && l.owner === 'run_owner_1'), '非持有者释放无效');
  runSvc.releaseScopes([scope], 'run_owner_1');
  assert.equal(runSvc.acquireScopes([scope], 'run_owner_2').ok, true, '持有者释放后可获取');
  runSvc.releaseScopes([scope], 'run_owner_2');
});

test('discuss 与写作可并行：discuss 不占书写锁，execute 占', async t => {
  await setupDb(t);
  const write = runSvc.bookWriteScope(5);
  const session = runSvc.sessionScope('agent:s');
  assert.equal(runSvc.acquireScopes([write], 'run_write').ok, true);
  assert.equal(runSvc.acquireScopes([session], 'run_discuss').ok, true, 'discuss 只占会话锁，与该书写作并行');
  assert.equal(runSvc.acquireScopes([session, write], 'run_execute').ok, false, 'execute 需要该书写锁 → 与写作冲突');
  runSvc.releaseScopes([session], 'run_discuss');
  runSvc.releaseScopes([write], 'run_write');
});

test('占位落盘失败：删除占位行并抛 503，不带「运行不存在」的假象继续', async t => {
  await setupDb(t);
  const orig = db.saveNow;
  db.saveNow = () => { throw new Error('EACCES: disk rejected'); };
  try {
    assert.throws(() => runSvc.startRun({ sessionKey: 'writing:book:3', requestId: 'req-pf', entry: 'chat', bookId: 3, mode: 'write' }),
      (e) => e.status === 503 && e.code === 'RUN_PERSIST_FAILED');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE request_id = 'req-pf'").n, 0, '失败占位必须删除');
  } finally {
    db.saveNow = orig;
  }
});

test('finishRun 终态幂等 + awaiting_confirmation 可被后续终态覆盖', async t => {
  await setupDb(t);
  const { run } = runSvc.startRun({ sessionKey: 'writing:book:4', requestId: 'req-fin', entry: 'chat', bookId: 4, mode: 'write' });
  runSvc.finishRun(run.id, { status: 'awaiting_confirmation', reason: 'pending_action' });
  assert.equal(runSvc.getRun(run.id).status, 'awaiting_confirmation');
  runSvc.finishRun(run.id, { status: 'paused', reason: 'action_settled' });
  assert.equal(runSvc.getRun(run.id).status, 'paused');
  runSvc.finishRun(run.id, { status: 'finished' });
  assert.equal(runSvc.getRun(run.id).status, 'paused', '真终态后不再改写');
});

test('事件顺序 seq 单调 + payload 脱敏截断', async t => {
  await setupDb(t);
  const { run } = runSvc.startRun({ sessionKey: 'writing:book:6', requestId: 'req-ev', entry: 'chat', bookId: 6, mode: 'write' });
  runSvc.appendRunEvent(run.id, { type: 'phase', payload: { kind: 'round', round: 1 } });
  runSvc.appendRunEvent(run.id, { type: 'tool_started', payload: { name: 'append_chapter' } });
  runSvc.appendRunEvent(run.id, { type: 'tool_result', payload: { name: 'append_chapter', result: { api_key: 'sk-real-secret', text: '长'.repeat(900) } } });
  runSvc.appendRunEvent(run.id, { type: 'not_a_known_type', payload: {} }); // 未知类型被拒
  runSvc.finishRun(run.id, { status: 'finished' });
  const events = runSvc.listRunEvents(run.id, {});
  assert.deepEqual(events.map(e => e.type), ['phase', 'tool_started', 'tool_result', 'run_finished'], '未知类型被拒（不占 seq）');
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4], 'seq 服务端顺序单调');
  const tr = events.find(e => e.type === 'tool_result');
  assert.equal(tr.payload.result.api_key, '[redacted]', '敏感键脱敏');
  assert.ok(tr.payload.result.text.length <= 510, '长文本截断');
  // 分页
  const page1 = runSvc.listRunEvents(run.id, { afterSeq: 0, limit: 2 });
  assert.equal(page1.length, 2);
  const page2 = runSvc.listRunEvents(run.id, { afterSeq: page1[1].seq });
  assert.ok(page2.length >= 1 && page2[0].seq > page1[1].seq);
});

// G2 审查 P3-3：超限事件此前字符串截断+省略号 → 读出端 safeParse 得到非法 JSON
// 静默返回 {}，超限事件不可解释。截断必须是合法 JSON 信封（truncated/originalChars/preview）。
test('P3-3：超限事件截断产出合法 JSON 信封（读出端不丢负载）', async t => {
  await setupDb(t);
  const { run } = runSvc.startRun({ sessionKey: 'writing:book:9', requestId: 'req-trunc', entry: 'chat', bookId: 9, mode: 'write' });
  // 构造脱敏后仍远超 4000 字符的 payload（单值超 500 会先被脱敏截断，
  // 用多个短值累加：数组最多保留 20 项，每项 500 字符 → 约 10000 字符）
  runSvc.appendRunEvent(run.id, { type: 'tool_result', payload: { name: 'append_chapter', result: { items: Array(30).fill('x'.repeat(500)) } } });
  const [ev] = runSvc.listRunEvents(run.id, {});
  assert.equal(ev.payload.truncated, true, '超限事件必须标记 truncated（而非静默空负载）');
  assert.ok(ev.payload.originalChars > 4000, '信封应带原始长度');
  assert.ok(typeof ev.payload.preview === 'string' && ev.payload.preview.length > 0, '信封应带开头预览');
  assert.ok(ev.payload.preview.length < 4000, '信封整体不得超限');
});

// G2 审查 P3-2：读取端键过滤兜底——routes/runs.js 注释承诺的「双层脱敏」此前只有写入端
// 一层。直接写库模拟「绕过写入端/存量脏数据」，读出必须仍被键过滤。
test('P3-2：读取端键过滤兜底——绕过写入端的脏 payload 读出仍脱敏', async t => {
  await setupDb(t);
  const { run } = runSvc.startRun({ sessionKey: 'writing:book:9', requestId: 'req-redact', entry: 'chat', bookId: 9, mode: 'write' });
  // 直接 INSERT 明文敏感键（绕开 appendRunEvent 的写入端脱敏，模拟脏数据）
  db.run(
    'INSERT INTO agent_run_events (run_id, seq, type, payload_json, created_at) VALUES (?, 1, ?, ?, ?)',
    [run.id, 'tool_result', JSON.stringify({ nested: { api_key: 'sk-test-should-not-leak', token: 'tok', note: 'ok' } }), new Date().toISOString()]
  );
  const [ev] = runSvc.listRunEvents(run.id, {});
  assert.equal(ev.payload.nested.api_key, '[redacted]', '读取端必须过滤敏感键（双层脱敏第二层）');
  assert.equal(ev.payload.nested.token, '[redacted]', 'token 同属敏感键');
  assert.equal(ev.payload.nested.note, 'ok', '非敏感字段原样保留');
});

test('recoverInterruptedRuns：running→interrupted，awaiting_confirmation 保留', async t => {
  await setupDb(t);
  const a = runSvc.startRun({ sessionKey: 'writing:book:7', requestId: 'r-a', entry: 'chat', bookId: 7, mode: 'write' });
  const b = runSvc.startRun({ sessionKey: 'writing:book:8', requestId: 'r-b', entry: 'chat', bookId: 8, mode: 'write' });
  runSvc.finishRun(b.run.id, { status: 'awaiting_confirmation' });
  const c = runSvc.startRun({ sessionKey: 'writing:book:9', requestId: 'r-c', entry: 'chat', bookId: 9, mode: 'write' });
  runSvc.finishRun(c.run.id, { status: 'finished' });
  const r = runSvc.recoverInterruptedRuns();
  assert.equal(r.interrupted, 1);
  assert.equal(runSvc.getRun(a.run.id).status, 'interrupted');
  assert.equal(runSvc.getRun(a.run.id).reason, 'server_restart');
  assert.equal(runSvc.getRun(b.run.id).status, 'awaiting_confirmation', '待确认不一律废弃（确认卡有效期自管）');
  assert.equal(runSvc.getRun(c.run.id).status, 'finished', '已终结不动');
});

// ---------------- HTTP 集成：写作入口 ----------------

test('同 requestId 两次请求只开始一次（模型只调一次）；不同 requestId 忙 409', async t => {
  const { bookId, http, stub } = await setupHttp(t);
  // 第一条：可控悬挂 SSE——立即出响应头保持运行中，close() 时收尾
  const held = controllableSse();
  stub.responders.push(() => held.response);
  const first = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '写一段', request_id: 'req-http-1' }),
  });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(runSvc.lockSnapshot().some(l => l.scope === `book:write:${bookId}`), '写作锁已占用');

  // 同 requestId 重试 → 202 duplicate JSON，不消耗 fetch responder（模型不重复调）
  const dupRes = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '写一段', request_id: 'req-http-1' }),
  });
  assert.equal(dupRes.status, 202);
  assert.equal(dupRes.headers.get('content-type').includes('application/json'), true);
  const dupBody = await dupRes.json();
  assert.equal(dupBody.duplicate, true);
  assert.ok(dupBody.runId);

  // 不同 requestId → 409 CHAT_BUSY（前端排队语义）
  const busyRes = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '另一条', request_id: 'req-http-2' }),
  });
  assert.equal(busyRes.status, 409);
  assert.equal((await busyRes.json()).error.code, 'CHAT_BUSY');

  // 放行第一条并收尾
  held.close();
  const firstRes = await first;
  await consumeSse(firstRes).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(stub.calls.length, 1, '模型只被调用一次');
  assert.equal(runSvc.lockSnapshot().filter(l => l.scope === `book:write:${bookId}`).length, 0, '锁已释放');
  const runRow = db.get('SELECT * FROM agent_runs WHERE request_id = ?', ['req-http-1']);
  assert.ok(runRow, '运行已落库');
  assert.equal(['finished', 'cancelled', 'failed'].includes(runRow.status), true, '终态已落：' + runRow.status);
});

test('重试已终结运行 → 200 duplicate JSON；runs API 会话归属与分页', async t => {
  const { bookId, http, stub } = await setupHttp(t);
  stub.responders.push(() => sseDone('第一段完整回复。'));
  const res1 = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '你好', request_id: 'req-done-1' }),
  });
  const events = await consumeSse(res1);
  assert.ok(events.some(e => e.type === 'done'));
  await new Promise(r => setTimeout(r, 200));

  const dupRes = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '你好（重试）', request_id: 'req-done-1' }),
  });
  assert.equal(dupRes.status, 200, '已终结 → 200');
  const dupBody = await dupRes.json();
  assert.equal(dupBody.duplicate, true);
  const runId = dupBody.runId;

  // runs API：正确会话可读、错误会话 403、缺会话 403
  const okRes = await fetch(`${http.baseUrl}/api/runs/${runId}?session_key=${encodeURIComponent('writing:book:' + bookId)}`);
  assert.equal(okRes.status, 200);
  assert.equal((await okRes.json()).run.status, 'finished');
  const badRes = await fetch(`${http.baseUrl}/api/runs/${runId}?session_key=agent:someone_else`);
  assert.equal(badRes.status, 403);
  assert.equal((await badRes.json()).error.code, 'RUN_ACCESS_DENIED');
  const noKey = await fetch(`${http.baseUrl}/api/runs/${runId}`);
  assert.equal(noKey.status, 403);
  // 事件接口分页
  const evRes = await fetch(`${http.baseUrl}/api/runs/${runId}/events?afterSeq=0&session_key=${encodeURIComponent('writing:book:' + bookId)}`);
  assert.equal(evRes.status, 200);
  const evBody = await evRes.json();
  assert.ok(Array.isArray(evBody.events) && evBody.events.length >= 1);
  assert.ok(evBody.events.every(e => e.seq > 0));
  const pageRes = await fetch(`${http.baseUrl}/api/runs/${runId}/events?afterSeq=${evBody.nextAfterSeq - 1}&limit=1&session_key=${encodeURIComponent('writing:book:' + bookId)}`);
  const pageBody = await pageRes.json();
  assert.equal(pageBody.events.length, 1, 'limit 生效');
});

test('断连取消：客户端中途放弃 → 终态 cancelled、锁释放、台账留痕', async t => {
  const { bookId, http, stub } = await setupHttp(t);
  stub.responders.push(() => hangingSse());
  const res = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '写一段会被取消的', request_id: 'req-cancel-1' }),
  });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(runSvc.lockSnapshot().some(l => l.scope === `book:write:${bookId}`));
  await res.body.cancel(); // 模拟客户端断连
  await new Promise(r => setTimeout(r, 300));
  const run = db.get('SELECT * FROM agent_runs WHERE request_id = ?', ['req-cancel-1']);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.reason, 'client_disconnected');
  assert.equal(runSvc.lockSnapshot().filter(l => l.scope === `book:write:${bookId}`).length, 0);
});

// ---------------- HTTP 集成：Agent 入口（锁语义，不触发 SDK） ----------------

test('Agent execute 与该书写作冲突 409 BOOK_BUSY；discuss 不冲突；execute 无 book_id 400', async t => {
  const { bookId, http, stub } = await setupHttp(t);
  const held = controllableSse();
  stub.responders.push(() => held.response);
  const writeRes = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '写作中', request_id: 'req-w1' }),
  });
  await new Promise(r => setTimeout(r, 250));

  // execute 绑定该书 → 409（锁冲突发生在 runAgent 之前，不触碰 SDK）
  const conv1 = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'book', bookId });
  const execRes = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv1.id, content: '执行修改', mode: 'execute', book_id: bookId }),
  });
  assert.equal(execRes.status, 409);
  assert.equal((await execRes.json()).error.code, 'BOOK_BUSY');

  // execute 未绑书 → 400（执行书内变更前必须明确绑定一本书）
  const nobookRes = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv1.id, content: '执行', mode: 'execute' }),
  });
  assert.equal(nobookRes.status, 400);

  // discuss：不占书锁（协调器层面验证——写作锁仍被写作运行持有，discuss 的会话锁可独立获取）
  assert.equal(runSvc.acquireScopes([runSvc.sessionScope('agent:s9')], 'probe').ok, true, 'discuss 会话锁与该书写作不冲突');
  runSvc.releaseScopes([runSvc.sessionScope('agent:s9')], 'probe');

  held.close();
  await consumeSse(await writeRes).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
});

test('Agent 入口幂等：运行中的同 requestId 重试 → 202 duplicate JSON（不触碰 SDK）', async t => {
  const { http } = await setupHttp(t);
  // 预置一个运行中的 agent 运行（模拟另一标签页正在跑）
  db.run(`INSERT INTO conversations (id, kind, scope, title, status, context_policy_json) VALUES ('s2', 'agent', 'global', '幂等会话', 'active', '{}')`);
  runSvc.startRun({ sessionKey: 'agent:s2', requestId: 'agent-req-1', entry: 'agent', mode: 'discuss' });
  const res = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: 's2', content: '重试', request_id: 'agent-req-1' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.sessionKey, 'agent:s2');
  // 会话归属可用返回的 sessionKey 回读运行
  const runRes = await fetch(`${http.baseUrl}/api/runs/${body.runId}`, { headers: { 'x-session-key': 'agent:s2' } });
  assert.equal(runRes.status, 200);
});

test('同会话两个不同 requestId 的 agent 运行 → 第二个 409 AGENT_BUSY', async t => {
  const { http } = await setupHttp(t);
  // 模拟同会话运行中：直接持有该会话的协调器锁（DB 行不代表本进程内存锁——
  // 上个进程的运行行由 recoverInterruptedRuns 管，不占本进程锁）
  db.run(`INSERT INTO conversations (id, kind, scope, title, status, context_policy_json) VALUES ('s3', 'agent', 'global', '忙碌会话', 'active', '{}')`);
  const scope = runSvc.sessionScope('agent:s3');
  assert.equal(runSvc.acquireScopes([scope], 'probe-holder').ok, true);
  const res = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: 's3', content: '第二条', request_id: 'agent-r2' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'AGENT_BUSY');
  runSvc.releaseScopes([scope], 'probe-holder');
});
