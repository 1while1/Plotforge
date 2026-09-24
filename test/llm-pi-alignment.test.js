// M1：LLM 网关对齐 pi AI 层四点强化的单测（全部 mock，不真调网络；key 一律 sk-test-xxx）
//  ① usage 锚点估算（contextBudget.estimateContextUsage / llm.sessionUsageEstimate）
//  ② 流式 SSE finish_reason 终结校验（llm.readChatSSEStream → 过早断流错误）
//  ③ 错误分类表补强（停滞流可重试；配额/账单类永不重试）
//  ④ 重试循环：retry-after 三形态解析 + >60s 上抛 + 退避 sleep 可被 AbortSignal 中断
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRetryableError, isNonRetryableLimitError, withRetry, parseRetryAfterHeader,
  readChatSSEStream, sessionUsageEstimate, fetchChatCompletion,
  RETRY_AFTER_CEILING_MS,
} = require('../server/llm');
const {
  estimateContextUsage, estimateMessages, estimateMessagesTokens,
} = require('../server/contextBudget');
const llmCallLog = require('../server/llmCallLog');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');

function mkErr(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

const enc = (s) => new TextEncoder().encode(s);

// mock SSE Response：body 为 web ReadableStream（与 undici res.body 同具 getReader/cancel）
function sseRes(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

// 永不结束的流（测 stall 看门狗 / 外部 abort）
function hangingRes(firstChunk) {
  const body = new ReadableStream({
    start(controller) { if (firstChunk) controller.enqueue(enc(firstChunk)); /* 不 close */ },
  });
  return { ok: true, status: 200, body };
}

// ---------------- ① usage 锚点估算 ----------------
test('① estimateContextUsage：锚点前用真实计费，锚点后增量 chars/4', () => {
  const messages = [
    { role: 'system', content: '世界观设定'.repeat(400) },
    { role: 'user', content: '写第一章' },
    { role: 'assistant', content: '第一章正文……' },
    { role: 'user', content: '继续' }, // 尾部增量：2 字 → ceil(2/4) = 1
  ];
  const est = estimateContextUsage(messages, { promptTokens: 8000, completionTokens: 500 });
  assert.equal(est.anchored, true);
  assert.equal(est.anchorIndex, 2); // 锚点 = 最后一条 assistant
  assert.equal(est.usageTokens, 8500); // 8000 prompt + 500 completion（前段真实计费）
  assert.equal(est.trailingTokens, estimateMessages([{ role: 'user', content: '继续' }])); // 尾部 chars/4
  assert.equal(est.tokens, 8500 + est.trailingTokens);
});

test('① estimateContextUsage：无 usage / 无 assistant 锚点 → 退化为 CJK 全量估算（现状兜底）', () => {
  const messages = [
    { role: 'system', content: '一二三四五六七八九十' },
    { role: 'user', content: '你好世界' },
  ];
  for (const bad of [null, undefined, {}, { promptTokens: 0 }, { promptTokens: -5 }]) {
    const est = estimateContextUsage(messages, bad);
    assert.equal(est.anchored, false);
    assert.equal(est.tokens, estimateMessagesTokens(messages));
  }
  // 有 usage 但数组里没有 assistant 消息（无从锚定）→ 同样退化
  const est2 = estimateContextUsage([{ role: 'user', content: 'hi' }], { promptTokens: 100 });
  assert.equal(est2.anchored, false);
  assert.equal(est2.tokens, estimateMessagesTokens([{ role: 'user', content: 'hi' }]));
  // 空数组
  assert.equal(estimateContextUsage([], { promptTokens: 100 }).tokens, 0);
});

test('① estimateContextUsage：锚点即末尾时尾部为 0（最近一次调用刚完成）', () => {
  const messages = [
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: '第二章正文' },
  ];
  const est = estimateContextUsage(messages, { promptTokens: 12000, completionTokens: 800 });
  assert.equal(est.anchored, true);
  assert.equal(est.trailingTokens, 0);
  assert.equal(est.tokens, 12800);
});

test('① sessionUsageEstimate：台账锚点优先，无记录退化；读出行带 usage cause 打标（临时库）', async () => {
  const loc = createTempLocation();
  await db.init({ filePath: loc.filePath });
  try {
    const messages = [
      { role: 'system', content: '设定' },
      { role: 'user', content: '开写' },
      { role: 'assistant', content: '正文' },
      { role: 'user', content: '再来一段' },
    ];
    // 无台账记录 → 兜底（现状行为）
    const fb = sessionUsageEstimate(99001, messages);
    assert.equal(fb.anchored, false);
    assert.equal(fb.tokens, estimateMessagesTokens(messages));
    // 台账有真实 usage → 锚点估算（对齐 pi UsageRecord：读出行带 cause 归因）
    llmCallLog.record({ bookId: 99002, scope: 'chat', model: 'm', baseUrl: 'https://llm-test.local', promptTokens: 3000, completionTokens: 200, status: 'ok' });
    const est = sessionUsageEstimate(99002, messages);
    assert.equal(est.anchored, true);
    assert.equal(est.usageTokens, 3200);
    assert.ok(est.tokens >= 3200);
    const row = llmCallLog.lastWithUsage(99002);
    assert.equal(row.cause, 'assistant'); // JS 侧打标，未做表迁移
    assert.equal(row.scope, 'chat');      // 原字段不受影响
    assert.equal(llmCallLog.usageCause('compact'), 'compaction');
    assert.equal(llmCallLog.usageCause('summarize'), 'summary');
    assert.equal(llmCallLog.usageCause('polish'), 'tool');
    assert.equal(llmCallLog.usageCause('llm'), 'other');
  } finally { cleanup(loc); }
});

// ---------------- ② 流式 SSE finish_reason 终结校验 ----------------
test('② SSE 正常结束但无 finish_reason → 抛可重试的「过早断流」错误', async () => {
  const res = sseRes([
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = [];
  await assert.rejects(
    readChatSSEStream(res, (json, choice) => events.push([json, choice])),
    (err) => err.__prematureStream === true
      && /finish_reason/.test(err.message)
      && isRetryableError(err) === true // 归类为可重试传输类（对照现有错误分类表）
  );
  assert.equal(events.length, 2); // 事件回调在报错前正常工作
});

test('② SSE 带 finish_reason 与 usage → 正常返回捕获结果', async () => {
  const res = sseRes([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const r = await readChatSSEStream(res);
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.usage.prompt_tokens, 42);
});

test('② 分片 chunk 跨界拼接 + 末行无换行也能解析', async () => {
  const line = 'data: {"choices":[{"delta":{"content":"跨块"}}]}\n';
  const chunks = [];
  for (let i = 0; i < line.length; i += 5) chunks.push(line.slice(i, i + 5)); // 人为 5 字节一片
  chunks.push('data: {"choices":[{"finish_reason":"stop"}]}'); // 末行无换行
  const got = [];
  const r = await readChatSSEStream(sseRes(chunks), (json) => {
    if (json.choices && json.choices[0].delta && json.choices[0].delta.content) got.push(json.choices[0].delta.content);
  });
  assert.deepEqual(got, ['跨块']);
  assert.equal(r.finishReason, 'stop');
});

test('② stall（stallMs 内无数据）→ 抛可重试的「停滞流」错误', async () => {
  const res = hangingRes('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  const t0 = Date.now();
  await assert.rejects(
    readChatSSEStream(res, null, { stallMs: 30 }),
    (err) => /stream stalled/.test(err.message) && isRetryableError(err) === true
  );
  assert.ok(Date.now() - t0 < 5000, 'stall 看门狗应及时触发');
});

test('② 外部 signal 中止 → 抛带 __userAbort 的原因（不可重试）', async () => {
  const res = hangingRes('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('user stopped')), 20);
  await assert.rejects(
    readChatSSEStream(res, null, { stallMs: 0, signal: ac.signal }),
    (err) => err.__userAbort === true && isRetryableError(err) === false
  );
});

// ---------------- ③ 错误分类表补强 ----------------
test('③ 配额/账单类（429 quota / 402 / insufficient / 余额不足）永不重试', () => {
  assert.equal(isRetryableError(mkErr('Error 429: insufficient_quota, please check your plan', { status: 429 })), false);
  assert.equal(isRetryableError(mkErr('429 You exceeded your current quota', { status: 429 })), false);
  assert.equal(isRetryableError(mkErr('402 payment required: billing issue', { status: 402 })), false);
  assert.equal(isRetryableError(mkErr('账户余额不足，请充值')), false);
  assert.equal(isRetryableError(mkErr('out of budget')), false);
  assert.equal(isNonRetryableLimitError(mkErr('Quota Exceeded by provider')), true);
  assert.equal(isNonRetryableLimitError(mkErr('rate limit, retry later')), false);
});

test('③ 补强不误伤：普通限速 429 / 停滞流仍可重试', () => {
  assert.equal(isRetryableError(mkErr('rate limit exceeded, retry later', { status: 429 })), true);
  assert.equal(isRetryableError(mkErr('stream stalled: 45000ms 内无数据')), true);
  assert.equal(isRetryableError(mkErr('stalled stream from upstream')), true);
});

// ---------------- ④ 重试循环：retry-after + 可中断退避 ----------------
test('④ parseRetryAfterHeader：秒数 / retry-after-ms 优先 / HTTP-date / 垃圾值', () => {
  const h = (obj) => ({ get: (k) => (obj[k] != null ? obj[k] : null) });
  assert.equal(parseRetryAfterHeader(h({ 'retry-after': '2' })), 2000);
  assert.equal(parseRetryAfterHeader(h({ 'retry-after-ms': '150', 'retry-after': '9' })), 150); // ms 优先
  const future = new Date(Date.now() + 5000).toUTCString();
  const got = parseRetryAfterHeader(h({ 'retry-after': future }));
  assert.ok(got >= 3500 && got <= 5000, `HTTP-date 应换算为毫秒差，得到 ${got}`);
  assert.equal(parseRetryAfterHeader(h({ 'retry-after': new Date(Date.now() - 60000).toUTCString() })), 0); // 过去时间夹 0
  assert.equal(parseRetryAfterHeader(h({ 'retry-after': 'soon' })), null);
  assert.equal(parseRetryAfterHeader(h({})), null);
  assert.equal(parseRetryAfterHeader(null), null);
});

test('④ retry-after > 60s → 立即上抛不重试（标注 __retryDeferredByServer）', async () => {
  let calls = 0;
  const slept = [];
  const tooLong = RETRY_AFTER_CEILING_MS + 1000;
  const err = await withRetry(async () => { calls++; throw mkErr('rate limit', { status: 429, retryAfter: tooLong }); },
    { sleep: async (ms) => { slept.push(ms); } })
    .then(() => { throw new Error('应当立即上抛'); }, (e) => e);
  assert.equal(calls, 1);
  assert.equal(slept.length, 0);
  assert.equal(err.__retryDeferredByServer, tooLong);
});

test('④ retry-after ≤ 上限 → 退避取服务端值（不被指数退避覆盖）', async () => {
  const slept = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw mkErr('rate limit', { status: 429, retryAfter: 1500 });
    return 'ok';
  }, { sleep: async (ms) => { slept.push(ms); }, baseDelay: 100, maxDelay: 8000 });
  assert.equal(result, 'ok');
  assert.deepEqual(slept, [1500]); // retry-after 路径无 jitter，精确等于服务端要求
});

test('④ 退避 sleep 可被 AbortSignal 中断（真实定时器，不等满 5s）', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('user stopped')), 30);
  let calls = 0;
  const t0 = Date.now();
  await assert.rejects(
    withRetry(async () => { calls++; throw mkErr('fetch failed'); },
      { signal: ac.signal, baseDelay: 5000, maxDelay: 5000 }), // 用默认 defaultSleep（真实定时器）
    (err) => /user stopped/.test(err.message)
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 2000, 'abort 后应立即中断 5s 退避');
});

test('④ fetchChatCompletion：429 + retry-after 120s → 立即上抛（1 次调用，不重试）', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '120' : null) }, text: async () => 'rate limit (server busy)' };
  };
  try {
    await assert.rejects(
      fetchChatCompletion({ baseUrl: 'https://llm-test.local/v1', apiKey: 'sk-test-xxx', body: { model: 'm', messages: [] } }),
      (err) => err.status === 429 && err.retryAfter === 120000 && err.__retryDeferredByServer === 120000
    );
    assert.equal(calls, 1);
  } finally { global.fetch = orig; }
});

test('④ fetchChatCompletion：429 + retry-after-ms 短延迟 → 遵守后第 2 次成功', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after-ms' ? '1' : null) }, text: async () => 'busy' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  };
  try {
    const res = await fetchChatCompletion({ baseUrl: 'https://llm-test.local/v1', apiKey: 'sk-test-xxx', body: {} });
    assert.equal(res.ok, true);
    assert.equal(calls, 2);
  } finally { global.fetch = orig; }
});

test('④ fetchChatCompletion：429 + insufficient_quota → 不重试直接上抛', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: () => null }, text: async () => '{"error":{"message":"You exceeded your current quota"}}' };
  };
  try {
    await assert.rejects(
      fetchChatCompletion({ baseUrl: 'https://llm-test.local/v1', apiKey: 'sk-test-xxx', body: {} }),
      /quota/
    );
    assert.equal(calls, 1);
  } finally { global.fetch = orig; }
});
