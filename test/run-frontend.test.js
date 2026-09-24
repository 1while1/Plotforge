// S2-01 提交 B：前端幂等消费公共件的 VM 回归。
// 载入真实 public/chat-event-hub.js，钉住 isJsonResponse / isActiveStatus /
// newRequestId / waitRunEvents（轮询续读、网络抖动重试、abort 传播、404/403 抛错）。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function loadHub(fetchStub) {
  const context = { window: {}, console, TextDecoder, setTimeout, fetch: fetchStub || (function () { throw new Error('unexpected fetch'); }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/chat-event-hub.js'), 'utf8'), context);
  return context.window.ChatEventHub;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

test('isJsonResponse 区分幂等 JSON 与 SSE 流', () => {
  const hub = loadHub();
  assert.equal(hub.isJsonResponse(new Response('{}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } })), true);
  assert.equal(hub.isJsonResponse(new Response('data: hi\n\n', { headers: { 'Content-Type': 'text/event-stream' } })), false);
  assert.equal(hub.isJsonResponse(new Response('', { status: 503, headers: { 'Content-Type': 'text/plain' } })), false);
});

test('isActiveStatus 只认 running 与 awaiting_confirmation', () => {
  const hub = loadHub();
  assert.equal(hub.isActiveStatus('running'), true);
  assert.equal(hub.isActiveStatus('awaiting_confirmation'), true);
  for (const s of ['finished', 'failed', 'cancelled', 'interrupted', null, undefined, '']) {
    assert.equal(hub.isActiveStatus(s), false);
  }
});

test('newRequestId 带前缀且不重复', () => {
  const hub = loadHub();
  const a = hub.newRequestId('write');
  const b = hub.newRequestId('write');
  assert.ok(a.startsWith('write_'));
  assert.notEqual(a, b);
  assert.match(hub.newRequestId(), /^req_/);
});

test('waitRunEvents 轮询到终态：事件按序回调、afterSeq 续读、返回终态', async () => {
  const calls = [];
  let round = 0;
  const hub = loadHub(async (url) => {
    calls.push(url);
    round += 1;
    if (round === 1) {
      return jsonResponse({ runId: 'r1', status: 'running', events: [{ runId: 'r1', seq: 1, type: 'phase', payload: { kind: 'tool' } }], nextAfterSeq: 1 });
    }
    return jsonResponse({ runId: 'r1', status: 'finished', events: [{ runId: 'r1', seq: 2, type: 'done', payload: {} }], nextAfterSeq: 2 });
  });
  const seen = [];
  const fin = await hub.waitRunEvents({ runId: 'r1', sessionKey: 'writing:book:1', intervalMs: 1, onEvent: (ev) => seen.push(ev.seq + ':' + ev.type) });
  assert.equal(fin.status, 'finished');
  assert.deepEqual(seen, ['1:phase', '2:done']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('afterSeq=1'), calls[1]); // 下一轮从 nextAfterSeq 续读，不重复拉旧事件
});

test('waitRunEvents 网络抖动重试而非失败', async () => {
  let round = 0;
  const hub = loadHub(async () => {
    round += 1;
    if (round === 1) throw new TypeError('fetch failed'); // 模拟轮询请求网络中断
    return jsonResponse({ runId: 'r2', status: 'cancelled', events: [], nextAfterSeq: 0 });
  });
  const fin = await hub.waitRunEvents({ runId: 'r2', sessionKey: 'agent:x', intervalMs: 1 });
  assert.equal(fin.status, 'cancelled');
  assert.equal(round, 2);
});

test('waitRunEvents abort 以 AbortError 形态抛出', async () => {
  const hub = loadHub(async () => jsonResponse({ runId: 'r3', status: 'running', events: [], nextAfterSeq: 0 }));
  const controller = new AbortController();
  const p = hub.waitRunEvents({ runId: 'r3', sessionKey: 's', intervalMs: 1, signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (e) => hub.isAbortError(e));
});

test('waitRunEvents 404/403 抛可读错误（不无限轮询）', async () => {
  for (const status of [404, 403]) {
    let round = 0;
    const hub = loadHub(async () => { round += 1; return jsonResponse({ error: { message: 'no access' } }, status); });
    await assert.rejects(
      hub.waitRunEvents({ runId: 'r4', sessionKey: 's', intervalMs: 1 }),
      (e) => { assert.match(e.message, /no access|无法读取运行结果/); return true; },
    );
    assert.equal(round, 1);
  }
});

test('waitRunEvents 携带会话归属头', async () => {
  let header = null;
  const hub = loadHub(async (url, opts) => {
    header = opts && opts.headers && opts.headers['x-session-key'];
    return jsonResponse({ runId: 'r5', status: 'finished', events: [], nextAfterSeq: 0 });
  });
  await hub.waitRunEvents({ runId: 'r5', sessionKey: 'agent:abc', intervalMs: 1 });
  assert.equal(header, 'agent:abc');
});
