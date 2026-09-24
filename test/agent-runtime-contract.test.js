// S2-04 / C09：终态、截断、取消与硬超时一致。
// 单测钉 normalizeFinish 的完整矩阵；HTTP 层钉 Agent 挂起无事件时 watchdog 到期取消、
// finally 清理（timer/listener/锁），以及「底层忽略 abort 也不谎称 finished」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const runPolicy = require('../server/chat/run-policy');

function enc(text) {
  return new Uint8Array(new TextEncoder().encode(text));
}

// ---------- normalizeFinish：单测矩阵 ----------
test('截断：finish=length + 半句 → paused/output_truncated，不是 finished', () => {
  assert.deepEqual(
    runPolicy.normalizeFinish({ finishReason: 'length', emittedText: '旅人推开门', state: {}, hasPendingAction: false, verifiedWrite: false }),
    { status: 'paused', reason: 'output_truncated' },
  );
  assert.deepEqual(
    runPolicy.normalizeFinish({ finishReason: 'premature', emittedText: '旅人推开门', state: {} }),
    { status: 'paused', reason: 'output_truncated' },
  );
});

test('空输出：finish=length/stop 无正文 → paused/empty_output，不谎称完成', () => {
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'length', emittedText: '', state: {} }), { status: 'paused', reason: 'empty_output' });
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '   \n ', state: {} }), { status: 'paused', reason: 'empty_output' });
});

test('正常 stop + 有正文 → finished', () => {
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '门后的世界豁然开朗。', state: {} }), { status: 'finished', reason: null });
});

test('写已核实：正文为空也按 finished（工具产出即交付物）', () => {
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '', state: {}, verifiedWrite: true }), { status: 'finished', reason: 'verified_write_only' });
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '已写入。', state: {}, verifiedWrite: true }), { status: 'finished', reason: null });
  // 但截断仍不放过已核实的写（半句=部分结果）
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'length', emittedText: '半句', state: {}, verifiedWrite: true }), { status: 'paused', reason: 'output_truncated' });
});

test('有待确认动作 → awaiting_confirmation（空正文也不例外）', () => {
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '', state: {}, hasPendingAction: true }), { status: 'awaiting_confirmation', reason: null });
});

test('上游 error → failed/upstream_error；abort 错误 → cancelled/user_abort；watchdog → failed/watchdog_timeout', () => {
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: '', emittedText: '半句', state: {}, error: new Error('502 gateway') }), { status: 'failed', reason: 'upstream_error' });
  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: '', emittedText: '', state: {}, error: abortErr }), { status: 'cancelled', reason: 'user_abort' });
  // G2 审查 P2-2：watchdog 是系统硬超时，不冒充上游故障、也不落不可解释的 abort 消息
  const wd = new Error('watchdog_timeout');
  wd.code = 'WATCHDOG_TIMEOUT';
  assert.deepEqual(runPolicy.normalizeFinish({ finishReason: '', emittedText: '半句', state: {}, error: wd }), { status: 'failed', reason: 'watchdog_timeout' });
});

test('控制态定格优先：cancelled/paused/awaiting_confirmation/failed 原样保留', () => {
  for (const [status, reason] of [['cancelled', 'client_disconnected'], ['paused', 'step_budget'], ['awaiting_confirmation', null], ['failed', 'llm_error']]) {
    const out = runPolicy.normalizeFinish({ finishReason: 'stop', emittedText: '正文', state: { status, reason }, verifiedWrite: true });
    assert.equal(out.status, status);
    assert.equal(out.reason, reason);
  }
});

// ---------- Agent watchdog：无事件挂起到期取消 ----------
// 悬挂 SSE 且暴露控制器：watchdog 触发后可主动收尾（关闭流），
// 避免等待 SDK pipe 自行退出（node --test runner 下 abort 传播不到悬挂 reader，实测悬挂）
function hangingAgentSse() {
  let ctl;
  const body = new ReadableStream({
    start(controller) {
      ctl = controller;
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '正在继续。' } }] })}\n\n`));
    },
  });
  return {
    response: { ok: true, status: 200, body, headers: new Headers({ 'content-type': 'text/event-stream' }) },
    close: () => {
      try {
        ctl.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
        ctl.enqueue(enc('data: [DONE]\n\n'));
        ctl.close();
      } catch (_) { /* 已关 */ }
    },
  };
}

test('Agent 无事件挂起：watchdog 到期取消，运行终态 failed/watchdog_timeout 且锁释放', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const { installFetchStub } = require('./helpers/llm-stub');
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const { seedBook } = require('../server/migrations/001-character-hub');
  const bookId = db.run("INSERT INTO books (title) VALUES ('watchdog书')").lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const actionStore = require('../server/actionStore');
  actionStore.clear();
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const http = await listen(createApp());
  t.after(() => http.close());

  // 已结算动作 + resume 路由进入 runAgentCoordinated（拿书锁）+ runAgent（挂起流）
  const action = actionStore.create(bookId, 'create_character', { name: '看门狗' }, { sessionId: 'agent:watch' });
  actionStore.settle(action.id, 'approved', { ok: true });
  const runSvc = require('../server/runtime/run-service');
  const scopesBefore = runSvc.lockSnapshot();

  // 悬挂流：watchdog 到期 abort 后主动收尾（node --test 下 SDK 的 abort 传播不到
  // 悬挂 reader，pipe 悬挂；裸 node 正常——runner 兼容性边界，见台账已知边界）
  const held = hangingAgentSse();
  stub.responders.push(() => held.response);
  // watchdog 默认 180s 太长为测试不可用——用内部 runAgent 接口直接验证取消语义；
  // run 行落终态由 api/agent-resume.test.js 的 HTTP 级 watchdog 场景断言。
  const { runAgent } = require('../server/agent/agent');
  // SDK pipe 需要的响应面：早期版本缺 writeHead 导致 pipe 在 watchdog 前就抛——
  // 「应抛出」断言一直在假绿（抛的是桩缺失，不是 abort 语义）
  const fakeRes = {
    setHeader() {}, writeHead() {}, flushHeaders() {}, once() {}, removeListener() {},
    writableEnded: false, writableFinished: false, statusCode: 200,
    async write() {}, end() {}, on() {},
  };
  // P2-2：onOutcome 在 watchdog 触发即刻定格 failed/watchdog_timeout（run 行 reason 的来源）
  const outcomes = [];
  const p = runAgent([{ role: 'user', content: '继续' }], fakeRes, {
    sessionId: 'agent:watch', actor: 'author', watchdogMs: 800, onOutcome: (n) => outcomes.push(n),
  }).catch(e => ({ thrown: e && e.message }));
  // 等 watchdog 触发（onOutcome 即刻定格），再主动收尾悬挂流让 pipe 退出
  await new Promise(r => setTimeout(r, 1500));
  assert.deepEqual(outcomes[outcomes.length - 1], { status: 'failed', reason: 'watchdog_timeout' },
    'watchdog 触发必须即刻定格可解释终态（G2 审查 P2-2）');
  held.close();
  const settled = await Promise.race([
    p, new Promise(r => setTimeout(() => r({ timeout: true }), 8000)),
  ]);
  assert.ok(!settled.timeout, '流收尾后 runAgent 必须退出（不得无限悬挂）');
  // 无残留锁（watchdog 运行未走路由层，不应泄漏协调器锁）
  const scopesAfter = runSvc.lockSnapshot();
  assert.deepEqual(scopesAfter, scopesBefore, '不应残留协调器锁');
});
