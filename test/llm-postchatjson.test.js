// 2026-09-30 抗短连加固包 A：postChatJson —— 非流式响应体读取纳入网关重试圈。
//
// 背景（实施前取证）：fetchChatCompletion 的 withRetry 只包到「响应头到达」，调用方随后的
// res.json() 在重试圈外——响应头 200 但响应体下载中断（TypeError: terminated / unexpected end
// of data 等）会直接炸穿调用方（callLLMFull / 续写链 / followUp 后续轮），且这次失败不享受重试。
//
// 本文件钉四件事：
//   ① 首次「头 200 体断」→ 打 __transport 标注 → 整体重试，第二次成功（恰 2 次调用）；
//   ② __transport 错误 isRetryableError 判 true（isRetryableError 新增分支）；
//   ③ 连续「体断」耗尽重试 → 抛出且错误带 __transport（恰 2 次…即 1+RETRY_MAX_ATTEMPTS-1 内耗尽计数）；
//   ④ signal 已 abort（用户取消）→ 不发请求、不重试；非 2xx 语义与 fetchChatCompletion 同款
//     （500 重试 / 400 不重试）。
// key 一律 sk-test-xxx；端点为占位 http://llm-stub.local，零真实网络。
const test = require('node:test');
const assert = require('node:assert/strict');
const { postChatJson, isRetryableError, RETRY_MAX_ATTEMPTS } = require('../server/llm');

const OK_JSON = {
  choices: [{ message: { role: 'assistant', content: '正文' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

// fetch 剧本 mock（llm-stub 同习惯用法：calls 计数 + responders 按序消费）
function installFetchScript(script) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    const respond = script.shift();
    if (!respond) throw new Error('fetch script exhausted: 意料之外的额外 LLM 调用');
    return respond();
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

// 头 200 但响应体读取抛错（下载中断的典型形态：TypeError）
function brokenBody() {
  return { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } };
}
function okBody(data) {
  return { ok: true, status: 200, json: async () => data };
}
function statusBody(status) {
  return {
    ok: false, status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: { message: `synthetic ${status}` } }),
  };
}

function mkErr(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

test('A① 头 200 体断 → __transport 标注 → 整体重试一次后成功（恰 2 次调用，返回数据）', async () => {
  const fx = installFetchScript([() => brokenBody(), () => okBody(OK_JSON)]);
  try {
    const data = await postChatJson({
      baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx',
      body: { model: 'agnes-2.5-flash', messages: [{ role: 'user', content: '写一句' }] },
    });
    assert.deepEqual(data, OK_JSON);
    assert.equal(fx.calls.length, 2, `应恰 2 次 fetch（1 次体断 + 1 次成功），实际 ${fx.calls.length}`);
  } finally { fx.restore(); }
});

test('A② isRetryableError：__transport 标注判 true（传输类）', () => {
  assert.equal(isRetryableError(mkErr('terminated', { __transport: true })), true);
  const e = mkErr('Failed to parse response body');
  e.__transport = true;
  assert.equal(isRetryableError(e), true);
});

test('A③ 连续体断耗尽重试 → 抛出且错误带 __transport', async () => {
  const script = [];
  for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) script.push(() => brokenBody());
  const fx = installFetchScript(script);
  try {
    await assert.rejects(
      postChatJson({ baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', body: { model: 'm', messages: [] } }),
      (e) => {
        assert.equal(e.__transport, true, '耗尽后上抛的错误必须带 __transport 标注');
        assert.match(e.message, /terminated/);
        return true;
      },
    );
    assert.equal(fx.calls.length, RETRY_MAX_ATTEMPTS, '总尝试次数应等于 RETRY_MAX_ATTEMPTS');
  } finally { fx.restore(); }
});

test('A④ signal 已 abort（用户取消）→ 不发请求、不重试', async () => {
  const ac = new AbortController();
  ac.abort(mkErr('user cancel', { __userAbort: true }));
  const fx = installFetchScript([() => okBody(OK_JSON)]);
  try {
    await assert.rejects(
      postChatJson({ baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', body: { model: 'm', messages: [] }, signal: ac.signal }),
    );
    assert.equal(fx.calls.length, 0, 'abort 后不得发出任何 fetch');
  } finally { fx.restore(); }
});

test('A⑤ 非 2xx 同款语义：500 重试成功 / 400 不重试', async () => {
  const fx = installFetchScript([() => statusBody(500), () => okBody(OK_JSON)]);
  try {
    const data = await postChatJson({ baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', body: { model: 'm', messages: [] } });
    assert.deepEqual(data, OK_JSON);
    assert.equal(fx.calls.length, 2);
  } finally { fx.restore(); }

  const fx2 = installFetchScript([() => statusBody(400)]);
  try {
    await assert.rejects(
      postChatJson({ baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', body: { model: 'm', messages: [] } }),
      (e) => {
        assert.equal(e.status, 400);
        assert.equal(isRetryableError(e), false);
        return true;
      },
    );
    assert.equal(fx2.calls.length, 1, '400 不得重试');
  } finally { fx2.restore(); }
});
