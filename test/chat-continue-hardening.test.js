// 2026-09-30 抗短连加固包 B+C：
//   B. 续写链加固——CONTINUATION_MAX 2→4；零进展预算 CONTINUATION_ZERO_PROGRESS_MAX=2；
//      streamContinue/continueNonStream 直接导出（compactBook 先例），零进展轮不再两轮就放弃。
//   C. 首轮流「零外发」传输类失败带工具重试一次——shouldRetryFirstStream 纯函数表驱动单测。
//
// 测法：直接调用 router 导出的 streamContinue/continueNonStream（mock global.fetch 剧本 +
// send 事件计数，llm-stub 同习惯用法），不经过 HTTP 层；临时库落台账；key 一律 sk-test-xxx。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const chatRouter = require('../server/routes/chat');
const { installFetchStub, sseStub } = require('./helpers/llm-stub');

const enc = (s) => new TextEncoder().encode(s);

// 零进展的续写轮：正常结束但 finish_reason=length 且无任何 content delta（仍截断、零新增）
const zeroProgressSse = () => sseStub([{ choices: [{ delta: {}, finish_reason: 'length' }] }]);
// 有进展但仍截断的续写轮：吐正文后被 length 截断
const progressTruncatedSse = (text) => sseStub([
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'length' }] },
]);
// 有进展且收尾的续写轮
const successSse = (text) => sseStub([
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);

async function setupDb(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
}

function makeSendCollector() {
  const events = [];
  const send = (obj) => events.push(obj);
  send.events = events;
  return send;
}

// ---------------- B：streamContinue 零进展预算 ----------------

test('B① streamContinue：首两轮零进展、第三轮成功 → 不再两轮就放弃（3 次调用，正文拼接）', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  stub.responders.push(
    () => zeroProgressSse(),
    () => zeroProgressSse(),
    () => successSse('第三轮补齐。'),
  );
  const send = makeSendCollector();
  const r = await chatRouter.streamContinue(
    1, 'http://llm-stub.local/v1', 'sk-test-xxx', 'agnes-2.5-flash',
    [{ role: 'user', content: '写一章' }], '半截正文。', send, null,
  );
  assert.equal(stub.calls.length, 3, `两轮零进展后第三轮应成功（恰 3 次调用），实际 ${stub.calls.length}`);
  assert.equal(r.content, '半截正文。第三轮补齐。');
  assert.equal(r.stillTruncated, false);
  assert.equal(send.events.filter(e => e.type === 'recovering').length, 3, '每轮都应有 recovering 提示');
});

test('B② streamContinue：连续零进展超预算 → 退出、不抛未处理异常、预算外剧本未消费', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  stub.responders.push(
    () => zeroProgressSse(),
    () => zeroProgressSse(),
    () => zeroProgressSse(),
    () => zeroProgressSse(), // 预算外：不得被消费（消费即 stub 抛错→测试失败）
  );
  const send = makeSendCollector();
  const r = await chatRouter.streamContinue(
    1, 'http://llm-stub.local/v1', 'sk-test-xxx', 'agnes-2.5-flash',
    [{ role: 'user', content: '写一章' }], '半截正文。', send, null,
  );
  assert.equal(chatRouter.CONTINUATION_ZERO_PROGRESS_MAX, 2, '零进展预算常量应为 2（router 导出）');
  assert.equal(stub.calls.length, chatRouter.CONTINUATION_ZERO_PROGRESS_MAX + 1,
    `连续零进展超预算即退出（预算内 ${chatRouter.CONTINUATION_ZERO_PROGRESS_MAX} 轮之外的超预算轮执行完就停，`
    + `恰 ${chatRouter.CONTINUATION_ZERO_PROGRESS_MAX + 1} 次调用），实际 ${stub.calls.length}`);
  assert.equal(r.stillTruncated, true, '预算耗尽退出时仍视为截断（半句=部分结果）');
  assert.equal(r.content, '半截正文。', '零新增时正文不变');
});

test('B③ streamContinue：signal 已 abort → 立即退出（零 fetch、零 recovering）', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const ac = new AbortController();
  ac.abort(new Error('client disconnected'));
  const send = makeSendCollector();
  const r = await chatRouter.streamContinue(
    1, 'http://llm-stub.local/v1', 'sk-test-xxx', 'agnes-2.5-flash',
    [{ role: 'user', content: '写一章' }], '半截正文。', send, ac.signal,
  );
  assert.equal(stub.calls.length, 0, 'abort 后不得发出任何续写调用');
  assert.equal(send.events.filter(e => e.type === 'recovering').length, 0, 'abort 后不得发 recovering 提示');
  assert.equal(r.content, '半截正文。');
});

test('B④ CONTINUATION_MAX=4：有进展仍截断的轮最多续 4 轮（第 5 个剧本未消费）', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  for (let i = 0; i < 5; i++) stub.responders.push(() => progressTruncatedSse(`第${i + 1}段。`));
  const send = makeSendCollector();
  const r = await chatRouter.streamContinue(
    1, 'http://llm-stub.local/v1', 'sk-test-xxx', 'agnes-2.5-flash',
    [{ role: 'user', content: '写一章' }], '起笔。', send, null,
  );
  assert.equal(stub.calls.length, 4, `CONTINUATION_MAX 提到 4 后应恰 4 次续写调用，实际 ${stub.calls.length}`);
  assert.equal(r.stillTruncated, true);
});

// ---------------- B：continueNonStream 异常轮预算 ----------------

// 非 2xx（400：网关不重试，单轮立即失败）——用于廉价构造「单轮异常」
function status400() {
  return {
    ok: false, status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: { message: 'synthetic 400' } }),
    text: async () => JSON.stringify({ error: { message: 'synthetic 400' } }),
  };
}

test('B⑤ continueNonStream：单轮异常扣零进展预算后继续 → 第二轮成功（不炸穿调用方）', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  stub.responders.push(
    () => status400(),
    () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '续写补齐。' }, finish_reason: 'stop' }] }) }),
  );
  const r = await chatRouter.continueNonStream(
    1, [{ role: 'user', content: '写一章' }],
    { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
    '半截正文。', null,
  );
  assert.equal(stub.calls.length, 2, `异常轮后应继续（恰 2 次调用），实际 ${stub.calls.length}`);
  assert.equal(r.content, '半截正文。续写补齐。');
  // 异常轮必须落台账（scope=chat-continue, status=error）
  const rows = db.all("SELECT scope, status FROM llm_calls WHERE scope = 'chat-continue' ORDER BY id");
  assert.deepEqual(rows.map(x => x.status), ['error', 'ok'], '异常轮记 error 行、成功轮记 ok 行');
});

test('B⑥ continueNonStream：异常超零进展预算 → 退出返回半截、不抛；__userAbort 必须重抛', async (t) => {
  await setupDb(t);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  stub.responders.push(() => status400(), () => status400(), () => status400());
  const r = await chatRouter.continueNonStream(
    1, [{ role: 'user', content: '写一章' }],
    { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
    '半截正文。', null,
  );
  assert.equal(stub.calls.length, chatRouter.CONTINUATION_ZERO_PROGRESS_MAX + 1,
    `连续异常超预算即退出（恰 ${chatRouter.CONTINUATION_ZERO_PROGRESS_MAX + 1} 次调用），实际 ${stub.calls.length}`);
  assert.equal(r.content, '半截正文。', '预算耗尽返回已有半截');

  // __userAbort：必须原样重抛（不得吞掉当零进展）
  const ac = new AbortController();
  ac.abort(new Error('client disconnected'));
  stub.responders.push(() => status400());
  await assert.rejects(
    chatRouter.continueNonStream(
      1, [{ role: 'user', content: '写一章' }],
      { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
      '半截正文。', ac.signal,
    ),
  );
  assert.equal(stub.calls.length, chatRouter.CONTINUATION_ZERO_PROGRESS_MAX + 1,
    'abort 情形零 fetch（signal 起飞前即抛，总数不变）');
});

// ---------------- C：shouldRetryFirstStream 纯函数表驱动 ----------------

test('C① shouldRetryFirstStream 表驱动：传输类+零外发→true；有外发/4xx/clientGone/retried/用户取消→false', () => {
  const fn = chatRouter.shouldRetryFirstStream;
  assert.equal(typeof fn, 'function', 'chatRouter.shouldRetryFirstStream 应已导出');
  const mkErr = (message, extra) => Object.assign(new Error(message), extra || {});
  const base = { forwardedContent: '', forwardedReasoning: '', clientGone: false, retried: false };
  const cases = [
    // → true：传输类（含 A 新增的 __transport）且零外发
    [{ ...base, error: mkErr('fetch failed') }, true],
    [{ ...base, error: mkErr('request timeout', { __timeout: true }) }, true],
    [{ ...base, error: mkErr('stream ended without finish_reason（流已结束）', { __prematureStream: true }) }, true],
    [{ ...base, error: mkErr('terminated', { __transport: true }) }, true],
    [{ ...base, error: mkErr('This operation was aborted', { name: 'AbortError' }) }, true],
    // → false：有外发（正文/思考任一非空——重发会重复推送）
    [{ ...base, error: mkErr('fetch failed'), forwardedContent: '半截' }, false],
    [{ ...base, error: mkErr('fetch failed'), forwardedReasoning: '想了' }, false],
    // → false：非传输类
    [{ ...base, error: mkErr('LLM 请求失败 400: bad', { status: 400 }) }, false],
    [{ ...base, error: mkErr('aborted', { __userAbort: true }) }, false],
    // → false：客户端已断 / 已重试过
    [{ ...base, error: mkErr('fetch failed'), clientGone: true }, false],
    [{ ...base, error: mkErr('fetch failed'), retried: true }, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(fn(input), expected, `shouldRetryFirstStream(${JSON.stringify(input)}) 应为 ${expected}`);
  }
});
