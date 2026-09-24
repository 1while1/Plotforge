const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const actionStore = require('../../server/actionStore');
const { buildActionResumeMessages } = require('../../server/agent/agent');
const { executeTool } = require('../../server/tools/executor');

// P1b：确认结果作为「系统事件」重启 Agent（非伪装用户消息）+ actionStore 持久化 toolCallId/目标 revision
// + resume/confirm 路由守卫。LLM 续跑本身留待 dev 实跑冒烟，这里只锁契约与守卫。
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
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http };
}

// ---------- buildActionResumeMessages：系统事件（非用户消息）----------
test('resume 消息 approved：末尾追加 system 事件，携带可信结果，历史保留在前', () => {
  const history = [
    { role: 'user', content: '帮我创建林野' },
    { role: 'assistant', content: '已提交确认' },
  ];
  const action = {
    id: 'c_1', name: 'create_character', status: 'approved',
    args: { name: '林野' }, result: { character: { id: 7 } },
  };
  const msgs = buildActionResumeMessages(history, action);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'system'); // 关键：系统事件，绝不伪装成 user
  assert.ok(last.content.includes('系统事件'));
  assert.ok(last.content.includes('已真实执行成功'));
  assert.ok(last.content.includes('c_1'));
  assert.ok(last.content.includes('"id":7')); // 可信执行结果注入
});

test('resume 消息 rejected：system 事件说明被拒，不谎称成功', () => {
  const action = { id: 'c_2', name: 'archive_character', status: 'rejected', args: { character_id: 3 } };
  const last = buildActionResumeMessages([], action).pop();
  assert.equal(last.role, 'system');
  assert.ok(last.content.includes('拒绝'));
  assert.ok(!last.content.includes('执行成功'));
});

test('resume 消息 failed：system 事件携带失败详情，要求未成功前不得声称完成', () => {
  const action = {
    id: 'c_3', name: 'move_chapter', status: 'failed',
    args: { chapter_id: 9 }, result: { error: '章节不存在', code: 'CHAPTER_NOT_FOUND' },
  };
  const last = buildActionResumeMessages([], action).pop();
  assert.equal(last.role, 'system');
  assert.ok(last.content.includes('失败'));
  assert.ok(last.content.includes('CHAPTER_NOT_FOUND'));
  assert.ok(last.content.includes('不得声称'));
});

// ---------- actionStore 持久化 toolCallId / targetRevision ----------
test('actionStore.create 持久化 toolCallId 与 targetRevision', async t => {
  // 3.1 落库版需要 db：独立隔离库（不走 httpCtx，不建 HTTP 服务）
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  actionStore.clear();
  const a = actionStore.create(2, 'review_event_proposal', { proposal_id: 5, expected_revision: 3 }, {
    sessionId: 's', toolCallId: 'call_99', targetRevision: 3,
  });
  assert.equal(a.toolCallId, 'call_99');
  assert.equal(a.targetRevision, 3);
  const b = actionStore.create(2, 'create_character', { name: 'x' }, { sessionId: 's' });
  assert.equal(b.toolCallId, '');
  assert.equal(b.targetRevision, null);
});

test('requestConfirmation 把 toolCallId 绑定进确认动作', async t => {
  const { bookId } = await httpCtx(t, '确认绑定');
  const ctx = { profile: 'agent', sessionId: 'bind', bookId, source: 'test', actor: 'author' };
  const conf = await executeTool(ctx, 'create_character', { name: '林野' }, '', { toolCallId: 'call_x' });
  assert.equal(conf.status, 'confirmation_required');
  assert.equal(actionStore.get(conf.confirmation.id).toolCallId, 'call_x');
});

// ---------- resume / confirm 路由守卫（不触发 LLM）----------
test('resume 未知确认 id → 404 CONFIRMATION_NOT_FOUND', async t => {
  const { http } = await httpCtx(t, 'resume未知');
  const r = await json(http.baseUrl, 'POST', '/api/agent/actions/c_unknown/resume', { request_id: 'rq-1' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'CONFIRMATION_NOT_FOUND');
});

test('resume 未结算(pending)动作 → 409 ACTION_NOT_SETTLED', async t => {
  const { bookId, http } = await httpCtx(t, 'resume未结算');
  const pending = actionStore.create(bookId, 'create_character', { name: '林野' }, { sessionId: 'agent:anonymous' });
  const r = await json(http.baseUrl, 'POST', `/api/agent/actions/${pending.id}/resume`, { request_id: 'rq-2' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ACTION_NOT_SETTLED');
});

test('confirm 拒绝 → 200 rejected，动作结算为 rejected，不执行工具', async t => {
  const { bookId, http } = await httpCtx(t, 'confirm拒绝');
  const pending = actionStore.create(bookId, 'create_character', { name: '林野' }, { sessionId: 'agent:anonymous' });
  const r = await json(http.baseUrl, 'POST', `/api/agent/actions/${pending.id}/confirm`, { approve: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'rejected');
  assert.equal(actionStore.get(pending.id).status, 'rejected');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM characters WHERE book_id = ? AND name = ?', [bookId, '林野']).n, 0);
});

test('confirm 同意 create_character → 200 approved，真实执行且结果持久化供 resume 读取', async t => {
  const { bookId, http } = await httpCtx(t, 'confirm同意');
  const ctx = { profile: 'agent', sessionId: 'agent:anonymous', bookId, source: 'test', actor: 'author' };
  const conf = await executeTool(ctx, 'create_character', { name: '林野' });
  const cid = conf.confirmation.id;
  const r = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'approved');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.confirmation_id, cid);
  // 动作结算为 approved 且可信结果已持久化（resume 依赖它构造系统事件）
  const settled = actionStore.get(cid);
  assert.equal(settled.status, 'approved');
  assert.ok(settled.result);
});

// ---------- S2-03 / C08：确认续跑服务端幂等 ----------
const { installFetchStub } = require('../helpers/llm-stub');

function enc(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(bytes);
}

// 一次性完整 SSE（resume 正常完成的响应）
function fullAgentSse(text) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n`));
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
      controller.enqueue(enc('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, headers: new Headers({ 'content-type': 'text/event-stream' }) };
}

// 读完一个 SSE 响应体（等价等待服务端流收尾）
async function drain(res) {
  if (!res || !res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// 悬挂 SSE（agent SDK 流式响应）：吐一帧后保持打开，resume 运行停留在进行中
function hangingAgentSse() {
  let ctl;
  const body = new ReadableStream({
    start(controller) {
      ctl = controller;
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '正在继续。' } }] })}\n\n`));
    },
  });
  return {
    response: {
      ok: true,
      status: 200,
      body,
      // SDK 的 openai-compatible provider 会读响应头判定流式
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    },
    close: () => {
      try {
        ctl.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
        ctl.enqueue(enc('data: [DONE]\n\n'));
        ctl.close();
      } catch (_) { /* 已关 */ }
    },
  };
}

async function setupResume(t, title) {
  const ctx = await httpCtx(t, title);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  // S3-02：确认卡通过 run 绑定会话（生产路径=会话运行内创建的卡自动快照 run_id；
  // run 行落 conversation_id）。这里直接造等价形态：会话 + 已结束的运行 + action 快照。
  const svc = require('../../server/conversations/service');
  const conv = svc.createConversation({ kind: 'agent', scope: 'global', title });
  svc.appendMessage({ conversationId: conv.id, role: 'user', content: '帮我创建角色', source: 'agent' });
  const iso = new Date().toISOString();
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at, finished_at)
     VALUES ('run_idem_1', 'req_idem_1', ?, ?, 'agent', 'execute', 'finished', ?, ?)`,
    ['agent:' + conv.id, conv.id, iso, iso]
  );
  const toolCtx = { profile: 'agent', sessionId: 'agent:' + conv.id, bookId: ctx.bookId, source: 'test', actor: 'author', runId: 'run_idem_1' };
  const conf = await executeTool(toolCtx, 'create_character', { name: '幂等角色' });
  const confirmResp = await json(ctx.http.baseUrl, 'POST', `/api/agent/actions/${conf.confirmation.id}/confirm`, { approve: true, conversation_id: conv.id });
  assert.equal(confirmResp.status, 200);
  return { ...ctx, stub, cid: conf.confirmation.id, conv };
}

function postResume(http, cid, body) {
  return fetch(`${http.baseUrl}/api/agent/actions/${cid}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('S2-03：同 confirmationId 同 requestId 并发续跑只开始一次，模型只调一次', async t => {
  const { http, stub, cid, conv } = await setupResume(t, '并发同id');
  const held = hangingAgentSse();
  stub.responders.push(() => held.response);
  const body = { conversation_id: conv.id, request_id: 'rr-same' };
  const [a, b] = await Promise.all([postResume(http, cid, body), postResume(http, cid, body)]);
  held.close();
  await drain(a); // 读完流释放锁，不污染后续测试
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200);
  assert.equal(statuses[1], 202, '第二个并发请求应幂等返回既有运行（202 duplicate）');
  const dup = await b.json();
  assert.equal(dup.duplicate, true);
  assert.equal(stub.calls.length, 1, '模型只调一次');
});

test('S2-03：换 requestId 换会话也绕不过——resume_action_id 库级唯一兜底', async t => {
  const { http, stub, cid, conv } = await setupResume(t, '绕过尝试');
  // 第一轮续跑正常完成（consume 完流，锁释放，run 终态 finished 仍占用 resume_action_id）
  stub.responders.push(() => fullAgentSse('续跑完成。'));
  const first = await postResume(http, cid, { conversation_id: conv.id, request_id: 'rr-1' });
  await drain(first);
  const afterFirst = stub.calls.length;
  assert.equal(afterFirst, 1);

  // 锁已释放、requestId 换新（会话不换——换会话已被 CONFIRMATION_MISMATCH 拦截）——
  // 唯一索引是最后的防线
  const second = await postResume(http, cid, { conversation_id: conv.id, request_id: 'rr-2' });
  assert.equal(second.status, 200, '既有运行已终结 → 200 duplicate');
  const dup = await second.json();
  assert.equal(dup.duplicate, true, '唯一索引兜底：换 requestId/会话返回既有运行');
  assert.equal(stub.calls.length, afterFirst, '不得再调模型');
});

test('S2-03：断连后重发续跑返回既有 cancelled 运行，不重放模型', async t => {
  const { http, stub, cid, conv } = await setupResume(t, '断连重发');
  const held = hangingAgentSse();
  stub.responders.push(() => held.response);
  const ac = new AbortController();
  const first = await postResumeWithSignal(http, cid, {
    conversation_id: conv.id, request_id: 'rr-disc',
  }, ac.signal);
  await new Promise(r => setTimeout(r, 300));
  ac.abort(); // 客户端断开
  await new Promise(r => setTimeout(r, 300));
  held.close();
  const before = stub.calls.length;

  const retry = await postResume(http, cid, { conversation_id: conv.id, request_id: 'rr-disc-new' });
  assert.equal(retry.status, 200, '既有 cancelled 运行已终结 → 200 duplicate');
  const dup = await retry.json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'cancelled');
  assert.equal(stub.calls.length, before, '断连后的重发不得再调模型');
  void first;
});

function postResumeWithSignal(http, cid, body, signal) {
  return fetch(`${http.baseUrl}/api/agent/actions/${cid}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).catch(() => null); // abort 导致的网络错误不算失败
}

test('S2-03：重启把中断运行标 interrupted 后，重发续跑仍不重放', async t => {
  const { http, stub, cid, bookId, conv } = await setupResume(t, '重启重发');
  const held = hangingAgentSse();
  stub.responders.push(() => held.response);
  const ac = new AbortController();
  const first = await postResumeWithSignal(http, cid, {
    conversation_id: conv.id, request_id: 'rr-restart',
  }, ac.signal);
  await new Promise(r => setTimeout(r, 300));
  ac.abort();
  await new Promise(r => setTimeout(r, 300));
  held.close();
  void first;

  // 模拟重启：把该续跑运行打回 running 再跑启动恢复
  db.run("UPDATE agent_runs SET status = 'running', finished_at = NULL WHERE resume_action_id = ?", [cid]);
  const runSvc = require('../../server/runtime/run-service');
  const recovered = runSvc.recoverInterruptedRuns();
  assert.equal(recovered.interrupted, 1);
  const before = stub.calls.length;

  const retry = await postResume(http, cid, { conversation_id: conv.id, request_id: 'rr-restart-2' });
  assert.equal(retry.status, 200);
  const dup = await retry.json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'interrupted', '重启中断的续跑保持 interrupted，不被新请求顶替');
  assert.equal(stub.calls.length, before, '不得重放模型');
  void bookId;
});

test('S2-03：错误会话的续跑请求被拒绝（确认凭证与发起会话绑定）', async t => {
  const { http, cid, conv } = await setupResume(t, '错误会话');
  const other = require('../../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title: '别人' });
  const r = await postResume(http, cid, { conversation_id: other.id, request_id: 'rr-x' });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error.code, 'CONFIRMATION_MISMATCH');
});

// ---------- S2-03 / G2 审查 P3-1：confirm 幂等回放必须先过会话归属校验 ----------
test('P3-1：已结算动作的幂等回放不得跨会话读取——错 session_id 403，正确/缺省仍回放', async t => {
  const { http, cid, conv } = await setupResume(t, '回放归属');
  // 第一次续跑正常完成（cid 已 approved 且 settled，confirm 进入幂等回放分支）
  // 错会话：不得回看别人的执行结果
  const other = require('../../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title: '回放别人' });
  const wrong = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true, conversation_id: other.id });
  assert.equal(wrong.status, 403, '回放分支必须先过会话归属校验（G2 审查 P3-1）');
  assert.equal(wrong.body.error.code, 'CONFIRMATION_MISMATCH');
  // 正确会话：幂等回放既有 approved 结果
  const ok = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true, conversation_id: conv.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.replayed, true);
  assert.equal(ok.body.status, 'approved');
  // 不带 session_id：回落到动作发起会话，仍然可回放（前端重试/刷新场景）
  const fallback = await json(http.baseUrl, 'POST', `/api/agent/actions/${cid}/confirm`, { approve: true });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.replayed, true);
});

// ---------- S2-04 / G2 审查 P2-2：watchdog 到期 → run 行落 failed/watchdog_timeout ----------
test('P2-2：Agent 挂起无事件 watchdog 到期 → agent_runs 行落 failed/watchdog_timeout（可解释）', async t => {
  const { http, stub, cid, conv } = await setupResume(t, 'watchdog落行');
  const runSvc = require('../../server/runtime/run-service');
  const original = runSvc.DEFAULT_MAX_DURATION_MS;
  runSvc.DEFAULT_MAX_DURATION_MS = 600; // 测试注入短硬超时（路由请求时求值，非编码期常量）
  t.after(() => { runSvc.DEFAULT_MAX_DURATION_MS = original; });
  const held = hangingAgentSse();
  stub.responders.push(() => held.response);
  const ac = new AbortController();
  const first = await postResumeWithSignal(http, cid, {
    conversation_id: conv.id, request_id: 'rr-watchdog',
  }, ac.signal);
  await new Promise(r => setTimeout(r, 2200)); // 等 watchdog 触发 + abort 传播 + 终态落库
  ac.abort(); // 客户端收工（此后 close 的 cancelled 不得覆盖已定格终态）
  await new Promise(r => setTimeout(r, 200));
  held.close();
  await drain(first).catch(() => {}); // 已断连，read 可能 reject

  const run = db.get('SELECT * FROM agent_runs WHERE resume_action_id = ?', [cid]);
  assert.ok(run, '续跑应产生 agent_runs 行');
  assert.equal(run.status, 'failed', 'watchdog 到期必须落 failed，不是 finished（原缺陷）');
  assert.equal(run.reason, 'watchdog_timeout', 'run 行 reason 必须可解释（G2 审查 P2-2）');
});
