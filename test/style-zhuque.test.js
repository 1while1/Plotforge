// 朱雀检测器的安全与容错契约：
// 端点锁定（请求参数改不了端点）/ 密钥只进 Authorization 头且绝不回显 / 无 key 明确报错 /
// 上游返回结构变化时不抛解析错（宁可字段为 null）。这些是「体检查不到不影响写作」的底座。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const zhuque = require('../server/detectors/zhuque');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

function stubFetch(impl) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

test('端点：默认值固定为朱雀官方地址，环境变量可覆盖，非 https 拒绝', () => {
  assert.equal(zhuque.endpoint(), zhuque.DEFAULT_ENDPOINT);
  const orig = process.env.ZHUQUE_ENDPOINT;
  try {
    process.env.ZHUQUE_ENDPOINT = 'http://insecure.example.com/classify';
    assert.throws(() => zhuque.endpoint(), /只允许 https/);
    process.env.ZHUQUE_ENDPOINT = 'https://custom.example.com/classify?x=1';
    assert.throws(() => zhuque.endpoint(), /不允许携带用户凭据或 query 参数/);
    process.env.ZHUQUE_ENDPOINT = 'https://custom.example.com/classify';
    assert.equal(zhuque.endpoint(), 'https://custom.example.com/classify');
  } finally {
    if (orig === undefined) delete process.env.ZHUQUE_ENDPOINT; else process.env.ZHUQUE_ENDPOINT = orig;
  }
  // 展示层兜底：非法配置也不炸，回原始值供排查
  assert.equal(typeof zhuque.effectiveEndpoint(), 'string');
});

test('无 key：明确报错且给出可行动指引，不发任何网络请求', async t => {
  await setup(t);
  const stub = stubFetch(() => { throw new Error('不该发出请求'); });
  try {
    await assert.rejects(
      () => zhuque.detect('随便一段文本'),
      (err) => {
        assert.equal(err.code, 'ZHUQUE_NO_KEY');
        assert.equal(err.status, 400);
        assert.ok(/未配置朱雀检测密钥/.test(err.message));
        return true;
      }
    );
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('空文本：拒绝且不发请求', async t => {
  await setup(t);
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', 'sk-test-zhuque-key')");
  const stub = stubFetch(() => { throw new Error('不该发出请求'); });
  try {
    await assert.rejects(() => zhuque.detect('   '), (err) => err.code === 'ZHUQUE_EMPTY_TEXT');
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('鉴权：key 只进 Authorization 头，绝不出现在 URL 或请求体里', async t => {
  await setup(t);
  const key = 'sk-test-zhuque-key';
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', ?)", [key]);
  const stub = stubFetch(() => jsonResponse({
    softmax_confidence: 0.9,
    labels_ratio: [0, 1, 0],
    segment_labels: [{ text: '被测文本内容', label: 1, conf: 0.9, position: '0' }],
    usage: { total_tokens: 12 },
  }));
  try {
    await zhuque.detect('被测文本内容');
    const call = stub.calls[0];
    assert.ok(call.init.headers.Authorization === `Bearer ${key}`);
    assert.ok(!call.url.includes(key), 'key 绝不能出现在 URL 里');
    assert.ok(!String(call.init.body).includes(key), 'key 绝不能出现在请求体里');
    assert.equal(JSON.parse(call.init.body).is_merge, false, '默认不合并分段，保留逐段粒度供入库');
  } finally { stub.restore(); }
});

test('解析：字段齐全时正确映射；上游结构变化时不抛错，字段退化为 null', async t => {
  await setup(t);
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', 'sk-test-zhuque-key')");

  const good = stubFetch(() => jsonResponse({
    softmax_confidence: 0.8688,
    labels_ratio: [0.0911, 0, 0.9089],
    segment_labels: [
      { text: '第一段被判定的内容', label: 2, conf: 0.93, position: '0' },
      { text: '第二段被判定的内容', label: 0, conf: 0.21, position: '1' },
    ],
    usage: { total_tokens: 6200 },
  }));
  try {
    const r = await zhuque.detect('长文本');
    assert.equal(r.conf, 0.8688);
    assert.deepEqual(r.labelsRatio, [0.0911, 0, 0.9089]);
    assert.equal(r.segments.length, 2);
    assert.equal(r.segments[0].text, '第一段被判定的内容');
    assert.equal(r.segments[0].label, 2);
    assert.equal(r.usageTokens, 6200);
  } finally { good.restore(); }

  // 上游改结构（字段全缺）——不抛错，退化 null/空
  const weird = stubFetch(() => jsonResponse({ unexpected: true }));
  try {
    const r = await zhuque.detect('长文本');
    assert.equal(r.conf, null);
    assert.deepEqual(r.labelsRatio, []);
    assert.deepEqual(r.segments, []);
    assert.equal(r.usageTokens, null);
  } finally { weird.restore(); }

  // data 包裹层也能吃
  const wrapped = stubFetch(() => jsonResponse({ data: { softmax_confidence: 0.5, segment_labels: [] } }));
  try {
    assert.equal((await zhuque.detect('x')).conf, 0.5);
  } finally { wrapped.restore(); }
});

test('错误脱敏：上游报错回显 key 时，错误信息里必须已被打码', async t => {
  await setup(t);
  const key = 'sk-test-zhuque-key';
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', ?)", [key]);
  const stub = stubFetch(() => jsonResponse({ error: `invalid key: ${key}` }, 401));
  try {
    await assert.rejects(
      () => zhuque.detect('文本'),
      (err) => {
        assert.ok(!err.message.includes(key), '错误信息绝不能带明文 key');
        assert.ok(err.message.includes('***'), '应替换为掩码');
        assert.equal(err.code, 'ZHUQUE_UPSTREAM');
        assert.equal(err.status, 502);
        return true;
      }
    );
  } finally { stub.restore(); }
});

test('网络失败：归类为 ZHUQUE_NETWORK 且脱敏；超时单独归类', async t => {
  await setup(t);
  const key = 'sk-test-zhuque-key';
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', ?)", [key]);

  const failing = stubFetch(() => { const e = new Error(`connect ECONNREFUSED for ${key}`); throw e; });
  try {
    await assert.rejects(() => zhuque.detect('文本'), (err) => {
      assert.equal(err.code, 'ZHUQUE_NETWORK');
      assert.ok(!err.message.includes(key));
      return true;
    });
  } finally { failing.restore(); }

  const aborting = stubFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  try {
    await assert.rejects(() => zhuque.detect('文本'), (err) => err.code === 'ZHUQUE_TIMEOUT');
  } finally { aborting.restore(); }
});
