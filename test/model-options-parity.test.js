// S2-05 / C11：模型选项单一权威构造器的双入口一致性。
// 断言同一模型同一 settings 下，写作（chat）与 Agent（agent）两个入口：
//   · disable_thinking_models 点名模型 → 两边都带 enable_thinking:false；
//   · 未配置 → 两边都不注入该字段（与历史行为逐位一致）；
//   · 输出预算由同一函数决定、按 operation 可不同但可解释；
//   · requestOverrides 只含允许字段（不泄漏 signal/内部字段）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { buildModelOptions } = require('../server/runtime/model-options');

function setSetting(key, value) {
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

test('未配置 disable_thinking_models → 两个入口都不注入 enable_thinking', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  for (const operation of ['chat', 'agent']) {
    const opts = buildModelOptions({ model: 'audit-model', settings: {}, operation });
    assert.equal(Object.hasOwn(opts.requestOverrides, 'enable_thinking'), false,
      operation + ' 入口在未配置时不得注入 enable_thinking');
  }
});

test('配置 disable_thinking_models=audit-model → 两个入口都下发 enable_thinking:false', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  setSetting('disable_thinking_models', 'audit-model');
  for (const operation of ['chat', 'agent']) {
    const opts = buildModelOptions({ model: 'audit-model', settings: {}, operation });
    assert.equal(opts.requestOverrides.enable_thinking, false, operation + ' 入口应下发思考关闭字段');
  }
  // 未点名模型不受影响
  const other = buildModelOptions({ model: 'agnes-2.5-flash', settings: {}, operation: 'chat' });
  assert.equal(Object.hasOwn(other.requestOverrides, 'enable_thinking'), false);
});

test('通配 * 对所有模型生效，空列表与空值一律不干预', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  setSetting('disable_thinking_models', '*');
  assert.equal(buildModelOptions({ model: 'any-model', settings: {}, operation: 'agent' }).requestOverrides.enable_thinking, false);
  setSetting('disable_thinking_models', '');
  assert.equal(Object.hasOwn(buildModelOptions({ model: 'any-model', settings: {}, operation: 'agent' }).requestOverrides, 'enable_thinking'), false);
  setSetting('disable_thinking_models', 'a-model, b-model');
  const opts = buildModelOptions({ model: 'B-MODEL', settings: {}, operation: 'chat' });
  assert.equal(opts.requestOverrides.enable_thinking, false, '大小写不敏感匹配');
});

test('settings 显式传入覆盖库读取（同一构造器两种来源同口径）', () => {
  const viaSettings = buildModelOptions({ model: 'm', settings: { disable_thinking_models: 'm' }, operation: 'chat' });
  assert.equal(viaSettings.requestOverrides.enable_thinking, false);
  const viaEmpty = buildModelOptions({ model: 'm', settings: {}, operation: 'chat' });
  assert.equal(Object.hasOwn(viaEmpty.requestOverrides, 'enable_thinking'), false);
});

test('输出预算按 operation 可不同、可解释：agent ≤ chat，且都夹在 [4096,16000]', () => {
  for (const model of ['agnes-2.5-flash', 'audit-model', '未知模型']) {
    const chat = buildModelOptions({ model, settings: {}, operation: 'chat' });
    const agent = buildModelOptions({ model, settings: {}, operation: 'agent' });
    assert.ok(chat.maxOutputTokens >= 4096 && chat.maxOutputTokens <= 16000, model + ' chat 预算越界');
    assert.ok(agent.maxOutputTokens >= 4096 && agent.maxOutputTokens <= 16000, model + ' agent 预算越界');
    assert.ok(agent.maxOutputTokens <= chat.maxOutputTokens, 'agent 单步预算不应超过整章 chat 预算');
  }
});

test('返回体只含允许字段：signal 透传、无内部字段泄漏', () => {
  const ac = new AbortController();
  const opts = buildModelOptions({ model: 'm', settings: {}, operation: 'chat', signal: ac.signal });
  assert.equal(opts.signal, ac.signal);
  assert.equal(typeof opts.timeoutMs, 'number');
  assert.deepEqual(Object.keys(opts).sort(), ['maxOutputTokens', 'requestOverrides', 'signal', 'timeoutMs']);
  // requestOverrides 只会有 enable_thinking 一个可能键
  for (const k of Object.keys(opts.requestOverrides)) {
    assert.equal(k, 'enable_thinking');
  }
});

// ---------- 双入口出网 JSON 一致性（真实出网路径，非仅构造器） ----------
const llm = require('../server/llm');

async function captureGatewayBody(body) {
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

test('出网一致性：点名模型时写作网关与 Agent 出网体都带 enable_thinking:false', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  setSetting('disable_thinking_models', 'audit-model');
  setSetting('model', 'audit-model');

  // 写作网关侧：真实出网体（经 fetchChatCompletion）
  const writingBody = await captureGatewayBody({ model: 'audit-model', messages: [], max_tokens: 100 });
  assert.equal(writingBody.enable_thinking, false, '写作网关应下发 enable_thinking:false');
  // 未点名模型：不注入
  const missBody = await captureGatewayBody({ model: 'agnes-2.5-flash', messages: [], max_tokens: 100 });
  assert.equal(Object.hasOwn(missBody, 'enable_thinking'), false, '未点名模型不得注入');

  // Agent 侧：真实出网体（SDK providerOptions 通道）——G2 独立审查 P1：
  // 命名空间必须用 SDK 实际读取的 providerOptionsName（'novel-agent'/novelAgent），
  // 写成 openaiCompatible 会被静默丢弃（字段从未出网而构造器测试全绿）。
  const agentBody = await captureAgentBody();
  assert.equal(agentBody.enable_thinking, false, 'Agent 出网体应带 enable_thinking:false（审查 P1 红测）');
});

test('出网一致性：未配置时 Agent 出网体不注入 enable_thinking（逐位历史行为）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  setSetting('model', 'audit-model');
  // disable_thinking_models 不配置（空）
  const agentBody = await captureAgentBody();
  assert.equal(Object.hasOwn(agentBody, 'enable_thinking'), false, '未配置时 Agent 不得注入');
});

// 经真实 HTTP 栈跑 Agent 入口，捕获 SDK 实际出网体（installFetchStub 拦 /chat/completions）
async function captureAgentBody() {
  const { installFetchStub } = require('./helpers/llm-stub');
  const stub = installFetchStub();
  const { seedBook } = require('../server/migrations/001-character-hub');
  const bookId = db.run("INSERT INTO books (title) VALUES ('出网体书')").lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const http = await listen(createApp());
  try {
    const body = new ReadableStream({
      start(controller) {
        const enc = (s) => new Uint8Array(new TextEncoder().encode(s));
        controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '好。' } }] })}\n\n`));
        controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`));
        controller.enqueue(enc('data: [DONE]\n\n'));
        controller.close();
      },
    });
    stub.responders.push(() => ({ ok: true, status: 200, body, headers: new Headers({ 'content-type': 'text/event-stream' }) }));
    const conv = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title: '出网探针' });
    const res = await fetch(http.baseUrl + '/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conv.id, content: '在吗', request_id: 'wire-probe-1' }),
    });
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    assert.ok(stub.calls.length >= 1, 'Agent 入口应真实调用模型');
    return stub.calls[0].body;
  } finally {
    await http.close();
    stub.restore();
  }
}

test('出网一致性：未配置时写作网关请求体逐位不变（历史行为保持）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const body = { model: 'deepseek-v4-flash', messages: [], max_tokens: 100 };
  const sent = await captureGatewayBody({ ...body });
  assert.deepEqual(sent, body, '默认请求体必须与调用方传入的完全一致');
});

// G2 审查 P2-3：思考开关名单匹配此前在 llm.js 与 model-options.js 各写一份——
// 「单一权威构造器」名不副实，两份漂移时两个入口对同一 settings 打出不同请求体。
// 现收敛到 server/runtime/thinking-mode.js，此测试钉住同源。
test('P2-3：思考开关单一实现——llm 网关与构造器引用同一函数且结论一致', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  setSetting('disable_thinking_models', 'audit-model');
  const shared = require('../server/runtime/thinking-mode');
  assert.equal(llm.thinkingDisabledModel, shared.thinkingDisabledModel,
    'llm.thinkingDisabledModel 必须与共享实现是同一函数（G2 审查 P2-3）');
  assert.equal(llm.applyThinkingMode, shared.applyThinkingMode, 'applyThinkingMode 同源');
  // 行为一致：同一模型同一 settings，两个入口结论相同
  assert.equal(llm.thinkingDisabledModel('audit-model'), true);
  assert.equal(buildModelOptions({ model: 'audit-model', settings: {}, operation: 'agent' }).requestOverrides.enable_thinking, false);
  assert.equal(llm.thinkingDisabledModel('agnes-2.5-flash'), false);
  assert.equal(
    Object.hasOwn(buildModelOptions({ model: 'agnes-2.5-flash', settings: {}, operation: 'agent' }).requestOverrides, 'enable_thinking'),
    false
  );
  // settings 显式传入与库读取两条路径也走同一名单匹配（matchesList 同源）
  const viaSettings = buildModelOptions({ model: 'audit-model', settings: { disable_thinking_models: 'audit-model' }, operation: 'chat' });
  assert.equal(viaSettings.requestOverrides.enable_thinking, false);
  assert.equal(shared.matchesList('AUDIT-MODEL', shared.listFromRaw('audit-model')), true, '大小写不敏感');
});
