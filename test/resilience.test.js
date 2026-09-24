const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRetryableError, computeBackoff, withRetry, RETRY_MAX_ATTEMPTS,
} = require('../server/llm');

// 造一个带字段的错误
function mkErr(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------------- isRetryableError ----------------
test('isRetryableError: 瞬时 5xx / 408 / 429 可重试', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableError(mkErr('x', { status })), true, `status ${status} 应可重试`);
  }
});

test('isRetryableError: 4xx 配额/鉴权/参数类不可重试', () => {
  for (const status of [400, 401, 402, 403, 404, 422]) {
    assert.equal(isRetryableError(mkErr('x', { status })), false, `status ${status} 不应重试`);
  }
});

test('isRetryableError: 网络类消息可重试', () => {
  for (const msg of ['fetch failed', 'ECONNRESET', 'socket hang up', 'terminated', 'other side closed', 'ETIMEDOUT']) {
    assert.equal(isRetryableError(mkErr(msg)), true, `"${msg}" 应可重试`);
  }
});

test('isRetryableError: 流提前结束 / 无 finish_reason 可重试', () => {
  assert.equal(isRetryableError(mkErr('stream ended without finish_reason')), true);
  assert.equal(isRetryableError(mkErr('no finish_reason received')), true);
});

test('isRetryableError: 本模块超时标记可重试', () => {
  assert.equal(isRetryableError(mkErr('request timeout', { __timeout: true })), true);
});

test('isRetryableError: 用户主动取消永不重试（即便消息含 abort）', () => {
  assert.equal(isRetryableError(mkErr('aborted', { __userAbort: true })), false);
  const e = mkErr('This operation was aborted');
  e.name = 'AbortError';
  e.__userAbort = true;
  assert.equal(isRetryableError(e), false);
});

test('isRetryableError: 未标注用户取消的 AbortError 视为传输中断可重试', () => {
  const e = mkErr('aborted');
  e.name = 'AbortError';
  assert.equal(isRetryableError(e), true);
});

test('isRetryableError: 空值 / 普通业务错误不可重试', () => {
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError(undefined), false);
  assert.equal(isRetryableError(mkErr('内容不符合预期')), false);
});

// ---------------- computeBackoff ----------------
test('computeBackoff: 指数增长且落在 ±20% jitter 界内', () => {
  const samples = (attempt) => Array.from({ length: 200 }, () => computeBackoff(attempt, { baseDelay: 1000, maxDelay: 100000 }));
  const bounds = [[800, 1200], [1600, 2400], [3200, 4800]];
  bounds.forEach(([lo, hi], attempt) => {
    for (const v of samples(attempt)) {
      assert.ok(v >= lo && v <= hi, `attempt ${attempt} 退避 ${v} 应在 [${lo},${hi}]`);
    }
  });
});

test('computeBackoff: 指数项被 maxDelay 夹住', () => {
  for (let i = 0; i < 100; i++) {
    const v = computeBackoff(10, { baseDelay: 1000, maxDelay: 2000 });
    assert.ok(v >= 1600 && v <= 2400, `超上限后应围绕 maxDelay 抖动，得到 ${v}`);
  }
});

test('computeBackoff: retryAfter 优先（且夹在 maxDelay 内）', () => {
  assert.equal(computeBackoff(0, { baseDelay: 500, maxDelay: 8000, retryAfter: 3000 }), 3000);
  assert.equal(computeBackoff(0, { baseDelay: 500, maxDelay: 8000, retryAfter: 99999 }), 8000);
});

// ---------------- withRetry ----------------
test('withRetry: 失败两次后成功 → 共 3 次尝试并返回结果', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw mkErr('fetch failed');
    return 'ok';
  }, { sleep: async () => {}, baseDelay: 1, maxDelay: 2 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry: 非可重试错误 → 只尝试 1 次即抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw mkErr('bad request', { status: 400 }); },
      { sleep: async () => {}, retries: 3 }),
    /bad request/
  );
  assert.equal(calls, 1);
});

test('withRetry: 始终可重试 → 达上限（1+retries）后抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw mkErr('socket hang up'); },
      { sleep: async () => {}, retries: 2 }),
    /socket hang up/
  );
  assert.equal(calls, 3);
});

test('withRetry: 默认上限 = RETRY_MAX_ATTEMPTS-1 次重试', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw mkErr('fetch failed'); }, { sleep: async () => {} })
  );
  assert.equal(calls, RETRY_MAX_ATTEMPTS);
});

test('withRetry: signal 已 abort → 不调用 fn 立即抛出', async () => {
  const ac = new AbortController();
  ac.abort(mkErr('user cancel', { __userAbort: true }));
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; return 'x'; }, { signal: ac.signal, sleep: async () => {} })
  );
  assert.equal(calls, 0);
});

test('withRetry: onRetry 回调收到 attempt/delay/error', async () => {
  const infos = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 3) throw mkErr('fetch failed');
    return 'done';
  }, {
    sleep: async () => {},
    baseDelay: 100, maxDelay: 1000,
    onRetry: (info) => infos.push(info),
  });
  assert.equal(infos.length, 2);
  assert.equal(infos[0].attempt, 0);
  assert.equal(infos[1].attempt, 1);
  assert.ok(infos[0].delay >= 80 && infos[0].delay <= 120);
  assert.match(infos[0].error.message, /fetch failed/);
});

test('withRetry: sleep 收到计算出的退避时长', async () => {
  const slept = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 2) throw mkErr('fetch failed');
    return 'ok';
  }, { sleep: async (ms) => { slept.push(ms); }, baseDelay: 1000, maxDelay: 100000 });
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 800 && slept[0] <= 1200);
});
