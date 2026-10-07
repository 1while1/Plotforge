// BYOK 服务商配置（model profiles）回归保护：
//   播种（命中内置 / 自定义）/ 掩码不回明文 / 创建与校验 / 编辑密钥清空规则 /
//   删除限制 / 激活写回四个活动设置键 + llmConfig 生效。
// 全程临时库 + 桩掉 modelInfo.scheduleRefresh，绝不打真实网络。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

const FAKE_KEY = 'sk-test-0123456789abcdef';
const AGNES_URL = 'https://apihub.agnes-ai.com/v1';
const ZEN_FREE_URL = 'https://opencode.ai/zen/v1';

// 激活/保存路径会触发官方模型信息重拉（真实出网）；测试里一律短路
const modelInfo = require('../server/modelInfo');
const origScheduleRefresh = modelInfo.scheduleRefresh;
modelInfo.scheduleRefresh = () => {};
after(() => { modelInfo.scheduleRefresh = origScheduleRefresh; });

async function apiSetup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { http };
}

function seedActive(baseUrl, apiKey, model, contextWindow) {
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?)", [baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', ?)", [apiKey]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?)", [model]);
  if (contextWindow !== undefined) db.run("INSERT INTO settings (key, value) VALUES ('context_window', ?)", [contextWindow]);
}

const GET = '/api/settings/model-profiles';
const put = (http, id, body) => json(http.baseUrl, 'PUT', `${GET}/${id}`, body);
const del = (http, id) => json(http.baseUrl, 'DELETE', `${GET}/${id}`);
const activate = (http, id, body) => json(http.baseUrl, 'POST', `${GET}/${id}/activate`, body);
const getSettings = http => json(http.baseUrl, 'GET', '/api/settings');
const find = (list, id) => list.profiles.find(p => p.id === id);

// ---------------- 播种 ----------------
test('播种：活动 base_url 命中内置渠道 → 灌入当前 key/model，并设为活动', async t => {
  const { http } = await apiSetup(t);
  seedActive(AGNES_URL, FAKE_KEY, 'agnes-brand-new', '128000');

  const r = await json(http.baseUrl, 'GET', GET);
  assert.equal(r.status, 200);
  assert.equal(r.body.profiles.length, 4, '四个内置渠道必须齐全');
  assert.ok(r.body.profiles.every(p => p.builtin === true), '播种后应只有内置渠道');
  assert.deepEqual(r.body.profiles.map(p => p.id), ['paid', 'free', 'agnes', 'stepfun'], '顺序：内置在前且固定');

  const agnes = find(r.body, 'agnes');
  assert.equal(agnes.api_key_set, true);
  assert.equal(agnes.api_key_masked, 'sk-tes…cdef');
  assert.ok(agnes.models.includes('agnes-brand-new'), '当前模型不在内置列表时应追加进去');
  assert.equal(agnes.context_window, '128000');
  assert.equal(r.body.active_profile_id, 'agnes');
  assert.equal(r.body.active_model, 'agnes-brand-new');

  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY), '响应任何位置不得含明文 key');

  // 二次读取应稳定（播种只发生一次，不能每次追加自定义）
  const again = await json(http.baseUrl, 'GET', GET);
  assert.equal(again.body.profiles.length, 4);
  assert.equal(again.body.active_profile_id, 'agnes');
});

test('播种：活动 base_url 非内置 → 建「当前自定义」并设为活动', async t => {
  const { http } = await apiSetup(t);
  seedActive('https://api.example.com/v1', FAKE_KEY, 'my-custom-model', '64000');

  const r = await json(http.baseUrl, 'GET', GET);
  assert.equal(r.body.profiles.length, 5);
  const custom = r.body.profiles[4];
  assert.equal(custom.builtin, false);
  assert.equal(custom.name, '当前自定义');
  assert.equal(custom.base_url, 'https://api.example.com/v1');
  assert.deepEqual(custom.models, ['my-custom-model']);
  assert.equal(custom.context_window, '64000');
  assert.equal(r.body.active_profile_id, custom.id);
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY));
});

test('播种：设置里没有任何渠道行 → 回落 llmConfig 默认（agnes）', async t => {
  const { http } = await apiSetup(t);
  const r = await json(http.baseUrl, 'GET', GET);
  assert.equal(r.body.profiles.length, 4);
  assert.equal(r.body.active_profile_id, 'agnes', 'base_url 缺省回落默认渠道，故活动态指向 agnes');
  assert.equal(find(r.body, 'agnes').api_key_set, false, '默认回落不携带密钥');
  assert.equal(r.body.active_model, 'agnes-2.5-flash');
});

// ---------------- 创建与校验 ----------------
test('POST 创建自定义渠道成功，返回掩码 profile 与完整列表', async t => {
  const { http } = await apiSetup(t);
  const r = await json(http.baseUrl, 'POST', GET, {
    name: '自建中转',
    base_url: 'https://api.example.com/v1/',
    api_key: FAKE_KEY,
    models: [' 模型A ', '模型A', '', '模型B'],
    context_window: '32000',
  });
  assert.equal(r.status, 200);
  assert.match(r.body.profile.id, /^p_[0-9a-f]{8}$/);
  assert.equal(r.body.profile.name, '自建中转');
  assert.equal(r.body.profile.builtin, false);
  assert.equal(r.body.profile.key_optional, false);
  assert.equal(r.body.profile.base_url, 'https://api.example.com/v1', '尾部斜杠应剥掉');
  assert.deepEqual(r.body.profile.models, ['模型A', '模型B'], '应去空去重保序');
  assert.equal(r.body.profile.context_window, '32000');
  assert.equal(r.body.profile.api_key_set, true);
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY), '创建响应不得回明文 key');
  assert.equal(r.body.profiles.length, 5);
});

test('POST 校验：空名称 / 私网 URL / 空模型列表 / 重名 各回 400', async t => {
  const { http } = await apiSetup(t);
  const base = { name: '渠道', base_url: 'https://api.example.com/v1', models: ['m1'] };

  const emptyName = await json(http.baseUrl, 'POST', GET, { ...base, name: '   ' });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.body.error, '名称不能为空（最多 40 字）');

  const longName = await json(http.baseUrl, 'POST', GET, { ...base, name: 'x'.repeat(41) });
  assert.equal(longName.status, 400);
  assert.equal(longName.body.error, '名称不能为空（最多 40 字）');

  const privateUrl = await json(http.baseUrl, 'POST', GET, { ...base, base_url: 'http://127.0.0.1:9/v1' });
  assert.equal(privateUrl.status, 400);
  assert.match(privateUrl.body.error, /回环|私网/);

  const emptyModels = await json(http.baseUrl, 'POST', GET, { ...base, models: [] });
  assert.equal(emptyModels.status, 400);
  assert.equal(emptyModels.body.error, '至少保留一个模型名');

  const badWindow = await json(http.baseUrl, 'POST', GET, { ...base, context_window: '100' });
  assert.equal(badWindow.status, 400);

  const ok = await json(http.baseUrl, 'POST', GET, base);
  assert.equal(ok.status, 200);
  const dup = await json(http.baseUrl, 'POST', GET, { ...base, name: '渠道' });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, '名称已存在，请换一个');
  const dupCase = await json(http.baseUrl, 'POST', GET, { ...base, name: ' 渠道 ' });
  assert.equal(dupCase.status, 400);
  const dupBuiltin = await json(http.baseUrl, 'POST', GET, { ...base, name: 'agnes（apihub）' });
  assert.equal(dupBuiltin.status, 400, '内置名也参与重名判定');

  assert.equal(db.get("SELECT COUNT(*) AS n FROM settings WHERE key = 'model_profiles'").n, 1, '校验失败不得污染存储');
});

// ---------------- 编辑 ----------------
test('PUT：密钥空串默认忽略，clear_api_key=true 才真的清空；缺席=不变', async t => {
  const { http } = await apiSetup(t);
  const created = await json(http.baseUrl, 'POST', GET, {
    name: '密钥渠道', base_url: 'https://api.example.com/v1', api_key: FAKE_KEY, models: ['m1'],
  });
  const id = created.body.profile.id;

  const ignored = await put(http, id, { api_key: '' });
  assert.equal(ignored.status, 200);
  assert.equal(find(ignored.body, id).api_key_set, true, '空串无清除标志应被忽略');
  assert.equal(find(ignored.body, id).api_key_masked, 'sk-tes…cdef');

  const cleared = await put(http, id, { api_key: '', clear_api_key: true });
  assert.equal(find(cleared.body, id).api_key_set, false);
  assert.equal(find(cleared.body, id).api_key_masked, '');

  const absent = await put(http, id, { name: '密钥渠道2' });
  assert.equal(find(absent.body, id).api_key_set, false, 'absent 不改动密钥');
  assert.equal(find(absent.body, id).name, '密钥渠道2');

  const reset = await put(http, id, { api_key: 'sk-test-zzzzzzzzzzzz' });
  assert.equal(find(reset.body, id).api_key_set, true);
  assert.equal(find(reset.body, id).api_key_masked, 'sk-tes…zzzz');
  assert.ok(!JSON.stringify(reset.body).includes('sk-test-zzzzzzzzzzzz'));
});

// ---------------- 内置渠道的默认值（只读事实源） ----------------
test('GET：四个内置渠道的 id/name/base_url/默认模型 与契约一致', async t => {
  const { http } = await apiSetup(t);
  const r = await json(http.baseUrl, 'GET', GET);
  const byId = Object.fromEntries(r.body.profiles.map(p => [p.id, p]));
  assert.deepEqual(Object.keys(byId), ['paid', 'free', 'agnes', 'stepfun']);
  assert.equal(byId.paid.name, '付费渠道（zen/go）');
  assert.equal(byId.paid.base_url, 'https://opencode.ai/zen/go/v1');
  assert.deepEqual(byId.paid.models, ['deepseek-v4-flash']);
  assert.equal(byId.paid.key_optional, false);
  assert.equal(byId.free.name, '免费渠道（zen）');
  assert.equal(byId.free.base_url, ZEN_FREE_URL);
  assert.equal(byId.free.key_optional, true);
  assert.deepEqual(byId.free.models, ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free', 'north-mini-code-free']);
  assert.equal(byId.agnes.name, 'Agnes（apihub）');
  assert.deepEqual(byId.agnes.models, ['agnes-2.5-flash', 'agnes-2.5-pro', 'agnes-2.0-flash', 'agnes-2.5-pro-alpha']);
  assert.equal(byId.stepfun.name, 'StepFun 官方（step_plan）');
  assert.equal(byId.stepfun.base_url, 'https://api.stepfun.com/step_plan/v1');
  assert.deepEqual(byId.stepfun.models, ['step-3.7-flash', 'step-3.5-flash']);
});

// ---------------- 存储自愈 ----------------
test('加载自愈：坏 JSON 视为缺失重播种；缺失内置渠道按默认重建且保持排序', async t => {
  const { http } = await apiSetup(t);
  seedActive(AGNES_URL, FAKE_KEY, 'agnes-2.5-pro');
  db.run("INSERT INTO settings (key, value) VALUES ('model_profiles', 'not-json{')");
  const repaired = await json(http.baseUrl, 'GET', GET);
  assert.equal(repaired.body.active_profile_id, 'agnes', '坏 JSON 应按当前设置重播种');

  const stored = db.get("SELECT value FROM settings WHERE key = 'model_profiles'").value;
  db.run("UPDATE settings SET value = ? WHERE key = 'model_profiles'", [
    JSON.stringify(JSON.parse(stored).filter(p => p.id !== 'agnes')),
  ]);
  const withGap = await json(http.baseUrl, 'GET', GET);
  assert.deepEqual(withGap.body.profiles.map(p => p.id), ['paid', 'free', 'agnes', 'stepfun'], '缺失内置应补齐并回到内置优先顺序');
});

test('PUT：内置渠道的 name/base_url 不可改，其他字段可改；未知 id 404', async t => {
  const { http } = await apiSetup(t);
  const r = await put(http, 'agnes', {
    name: '偷偷改名', base_url: 'https://evil.example.com/v1', models: ['agnes-2.5-flash'], context_window: '16000',
  });
  assert.equal(r.status, 200);
  const agnes = find(r.body, 'agnes');
  assert.equal(agnes.name, 'Agnes（apihub）');
  assert.equal(agnes.base_url, AGNES_URL);
  assert.equal(agnes.context_window, '16000');

  const missing = await put(http, 'nope', { name: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
});

test('PUT：编辑活动渠道会同步活动设置（模型已不在列表则回退首个）', async t => {
  const { http } = await apiSetup(t);
  seedActive(AGNES_URL, FAKE_KEY, 'agnes-2.5-pro', '128000');
  assert.equal((await json(http.baseUrl, 'GET', GET)).body.active_profile_id, 'agnes');

  const r = await put(http, 'agnes', { models: ['zzz-1', 'zzz-2'], context_window: '24000' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active_profile_id, 'agnes');

  const s = (await getSettings(http)).body.settings;
  assert.equal(s.base_url, AGNES_URL);
  assert.equal(s.api_key_set, true);
  assert.equal(s.context_window, '24000');
  assert.equal(s.model, 'zzz-1', '原模型已不在列表，应回退首个');
});

// ---------------- 删除 ----------------
test('DELETE：内置 400（优先于活动判定）、未知 404、自定义未活动可删', async t => {
  const { http } = await apiSetup(t);
  seedActive(AGNES_URL, FAKE_KEY, 'agnes-2.5-pro');

  // agnes 同时是内置与活动：内置规则先命中（内置永远删不掉）
  const builtin = await del(http, 'agnes');
  assert.equal(builtin.status, 400);
  assert.equal(builtin.body.error, '内置渠道不能删除');
  assert.equal((await del(http, 'paid')).body.error, '内置渠道不能删除');

  const missing = await del(http, 'nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);

  const created = await json(http.baseUrl, 'POST', GET, {
    name: '待删渠道', base_url: 'https://api.example.com/v1', models: ['m1'],
  });
  const id = created.body.profile.id;
  const removed = await del(http, id);
  assert.equal(removed.status, 200);
  assert.equal(find(removed.body, id), undefined);
  assert.equal(removed.body.profiles.length, 4);
});

test('DELETE：正在使用的自定义渠道被 400 拒绝，切换到内置后可删', async t => {
  const { http } = await apiSetup(t);
  const created = await json(http.baseUrl, 'POST', GET, {
    name: '活动自定义', base_url: 'https://api.example.com/v1', api_key: FAKE_KEY, models: ['m1'],
  });
  const id = created.body.profile.id;
  assert.equal((await activate(http, id, { model: 'm1' })).status, 200);

  const busy = await del(http, id);
  assert.equal(busy.status, 400);
  assert.equal(busy.body.error, '正在使用的服务商不能删除，请先切换');
  assert.ok(find((await json(http.baseUrl, 'GET', GET)).body, id), '拒绝后配置仍在');

  assert.equal((await activate(http, 'free', { model: 'mimo-v2.5-free' })).status, 200);
  const removed = await del(http, id);
  assert.equal(removed.status, 200);
  assert.equal(find(removed.body, id), undefined);
});

// ---------------- 激活 ----------------
test('activate：未知 id 404、模型不在列表 400、缺 key 400', async t => {
  const { http } = await apiSetup(t);

  const missing = await activate(http, 'nope', { model: 'm1' });
  assert.equal(missing.status, 404);

  const badModel = await activate(http, 'agnes', { model: '不存在的模型' });
  assert.equal(badModel.status, 400);
  assert.equal(badModel.body.error, '该服务商下没有这个模型');

  const noKey = await activate(http, 'paid', { model: 'deepseek-v4-flash' });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, '该服务商还没有配置 API Key');
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'base_url'"), null, '失败不得写活动设置');
});

test('activate：key_optional 的免费渠道允许空 key，活动设置为空串', async t => {
  const { http } = await apiSetup(t);
  const r = await activate(http, 'free', { model: 'mimo-v2.5-free' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active_profile_id, 'free');
  assert.equal(r.body.active_model, 'mimo-v2.5-free');
  assert.equal(r.body.settings.base_url, ZEN_FREE_URL);
  assert.equal(r.body.settings.model, 'mimo-v2.5-free');
  assert.equal(r.body.settings.api_key_set, false);

  const s = (await getSettings(http)).body.settings;
  assert.equal(s.base_url, ZEN_FREE_URL);
  assert.equal(s.api_key_set, false);
  assert.equal(require('../server/llm').llmConfig().model, 'mimo-v2.5-free');
  assert.equal(require('../server/llm').llmConfig().baseUrl, ZEN_FREE_URL);
});

test('activate：成功写回 base_url/model/api_key/context_window，llmConfig 立即生效', async t => {
  const { http } = await apiSetup(t);
  const created = await json(http.baseUrl, 'POST', GET, {
    name: '切换目标', base_url: 'https://api.example.com/v1', api_key: FAKE_KEY, models: ['m1', 'm2'], context_window: '16000',
  });
  const id = created.body.profile.id;

  const r = await activate(http, id, { model: 'm2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active_profile_id, id);
  assert.equal(r.body.active_model, 'm2');
  assert.equal(r.body.settings.base_url, 'https://api.example.com/v1');
  assert.equal(r.body.settings.api_key_set, true);
  assert.equal(r.body.settings.context_window, '16000');

  const s = (await getSettings(http)).body.settings;
  assert.equal(s.base_url, 'https://api.example.com/v1');
  assert.equal(s.context_window, '16000');
  assert.ok(!JSON.stringify(s).includes(FAKE_KEY), '设置响应不得含明文 key');

  const llm = require('../server/llm').llmConfig();
  assert.equal(llm.baseUrl, 'https://api.example.com/v1');
  assert.equal(llm.model, 'm2');

  // 切回免费渠道：api_key 必须被显式写空（不能残留上一个渠道的 key）
  const back = await activate(http, 'free', { model: 'deepseek-v4-flash-free' });
  assert.equal(back.status, 200);
  assert.equal((await getSettings(http)).body.settings.api_key_set, false);
  assert.equal(require('../server/llm').llmConfig().apiKey, '');
});

test('PUT /api/settings 改上下文窗口会同步进活动配置；Key 首尾空白被去掉', async t => {
  const { http } = await apiSetup(t);
  seedActive(AGNES_URL, FAKE_KEY, 'agnes-2.5-flash');
  await json(http.baseUrl, 'GET', GET);
  const r = await json(http.baseUrl, 'PUT', '/api/settings', { context_window: '200000' });
  assert.equal(r.status, 200);
  const list = await json(http.baseUrl, 'GET', GET);
  assert.equal(find(list.body, 'agnes').context_window, '200000');
  const sw = await activate(http, 'agnes', { model: 'agnes-2.5-pro' });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.settings.context_window, '200000', '同一服务商切模型不应把窗口打回旧值');

  const created = await json(http.baseUrl, 'POST', GET, {
    name: '空白测试', base_url: 'https://api.example.com/v1', api_key: `  ${FAKE_KEY}  `, models: ['m1'],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.profile.api_key_masked, 'sk-tes…cdef');
});