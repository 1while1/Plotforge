// 深度思考开关的单测（2026-09-13 「写一篇文章直接卡死」诊断产物）。
//
// 契约三条：
//   ① 默认（设置项为空）**不动请求体**——与历史请求逐位一致，这是「零回归」的保证；
//   ② 点名的模型才带 `enable_thinking:false`，未点名的模型不受影响（不同网关对未知字段容忍度不同，
//      本次实测已有一个渠道对未知字段直接 400，所以不能无脑全局下发）；
//   ③ 该字段真的到达 HTTP 请求体（经 fetchChatCompletion 的 mock 边界验证，含流式请求）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const llm = require('../server/llm');

function setSetting(key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

// 抓住 fetchChatCompletion 实际发出的请求体
async function captureBody(body) {
  const orig = global.fetch;
  let seen = null;
  global.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [], usage: {} }) };
  };
  try {
    await llm.fetchChatCompletion({ baseUrl: 'https://llm-test.local/v1', apiKey: 'sk-test-xxx', body });
  } finally { global.fetch = orig; }
  return seen;
}

test('默认：未配置禁用名单 → 请求体不带 enable_thinking（逐位不变）', async t => {
  await setup(t);
  const body = { model: 'deepseek-v4-flash', messages: [], max_tokens: 100 };
  assert.equal(llm.thinkingDisabledModel('deepseek-v4-flash'), false);
  const sent = await captureBody({ ...body });
  assert.deepEqual(sent, body, '默认请求体必须与调用方传入的完全一致');
  assert.ok(!('enable_thinking' in sent));
});

test('点名生效：命中的模型带 enable_thinking:false，未命中的不带', async t => {
  await setup(t);
  setSetting(llm.THINKING_OFF_SETTING, 'deepseek-v4-flash');

  assert.equal(llm.thinkingDisabledModel('deepseek-v4-flash'), true);
  assert.equal(llm.thinkingDisabledModel('agnes-3.0-flash'), false);

  const hit = await captureBody({ model: 'deepseek-v4-flash', messages: [], max_tokens: 100, stream: true });
  assert.equal(hit[llm.THINKING_OFF_FIELD], false, '点名的模型必须带 enable_thinking:false');
  assert.equal(hit.stream, true, '注入不得影响其它字段');

  const miss = await captureBody({ model: 'agnes-3.0-flash', messages: [], max_tokens: 100 });
  assert.ok(!('enable_thinking' in miss), '未点名的模型不得被注入');
});

test('名单解析：大小写、空格、中英文逗号、多个模型与 * 通配', async t => {
  await setup(t);
  setSetting(llm.THINKING_OFF_SETTING, ' DeepSeek-V4-Flash , kimi-k3，deepseek-v4-pro ');
  assert.equal(llm.thinkingDisabledModel('deepseek-v4-flash'), true, '大小写不敏感且要 trim');
  assert.equal(llm.thinkingDisabledModel('kimi-k3'), true);
  assert.equal(llm.thinkingDisabledModel('deepseek-v4-pro'), true);
  assert.equal(llm.thinkingDisabledModel('agnes-3.0-flash'), false);

  setSetting(llm.THINKING_OFF_SETTING, '*');
  assert.equal(llm.thinkingDisabledModel('任意模型'), true);
  assert.equal(llm.thinkingDisabledModel(''), false, '空模型名不得被通配匹配（避免误伤未带 model 的请求）');
});

test('applyThinkingMode 就地返回同一对象（调用方无需改写法）', async t => {
  await setup(t);
  setSetting(llm.THINKING_OFF_SETTING, 'deepseek-v4-flash');
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] };
  const out = llm.applyThinkingMode(body);
  assert.equal(out, body, '必须是同一个对象引用');
  assert.equal(body.enable_thinking, false);
  // 无 body / 无 model 的边界不得抛错
  assert.equal(llm.applyThinkingMode(null), null);
  const noModel = { messages: [] };
  assert.equal(llm.applyThinkingMode(noModel).enable_thinking, undefined);
});
