const express = require('express');
const router = express.Router();
const db = require('../db');
const { callLLM, llmConfig, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, resolveContextWindow, contextWindowInfo } = require('../llm');

function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return '';
  if (apiKey.length < 10) return '***';
  return apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
}

// 压缩率归一：0.5~0.95 之外回退 0.8
function normalizeRatio(v) {
  const n = Number(v);
  if (!n || n < 0.5 || n > 0.95) return 0.8;
  return n;
}

// 密钥类字段：需要显式清除标志才允许被空串覆盖，防止旧版前端缓存无条件发空串把已配置的密钥洗掉
const SECRET_KEYS = ['api_key', 'anysearch_api_key'];

// 布尔型设置解析：缺省/空值回退默认；'0'/'false' 视为关
function boolValue(v, dflt) {
  if (v === undefined || String(v).trim() === '') return dflt;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false');
}

// 默认结果条数：1~10 之外的值回退 5
function normMaxResults(v, dflt) {
  const n = Number(v);
  if (!n || n < 1 || n > 10) return dflt;
  return Math.round(n);
}

function getSettings(modelOverride) {
  const rows = db.all('SELECT key, value FROM settings') || [];
  const map = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  const llm = llmConfig();
  const effectiveModel = modelOverride || map.model || DEFAULT_MODEL;
  const cwi = contextWindowInfo(effectiveModel);
  // 密钥类字段只回掩码与「是否已配置」，绝不回明文：
  // 本接口无任何鉴权，回明文等于把 key 交给任何能访问该端口的人，并沉淀进浏览器缓存与日志。
  const rawApiKey = map.api_key !== undefined ? map.api_key : (llm.apiKey || '');
  const rawAnysearchKey = map.anysearch_api_key || '';
  const settings = {
    base_url: map.base_url !== undefined ? map.base_url : DEFAULT_BASE_URL,
    api_key_set: !!rawApiKey,
    api_key_masked: maskApiKey(rawApiKey),
    model: map.model !== undefined ? map.model : DEFAULT_MODEL,
    system_prompt: map.system_prompt || '',
    anysearch_api_key_set: !!rawAnysearchKey,
    anysearch_api_key_masked: maskApiKey(rawAnysearchKey),
    context_window: map.context_window || '',
    context_window_resolved: cwi.effective,
    context_window_auto: !(map.context_window && String(map.context_window).trim()),
    // 钳制透明化：手动值超过渠道官方报告上限时，前端需展示原因与解法（避免「设置了却不生效」的困惑）
    context_window_official: cwi.official,
    context_window_official_source: cwi.officialSource,
    context_window_official_fetched_at: cwi.fetchedAt,
    context_window_clamped: cwi.clamped,
    context_window_note: cwi.note,
    // 自动压缩线：占用达到 窗口×压缩率 时自动压缩对话（0.5~0.95，默认 0.8）
    compression_ratio: normalizeRatio(map.compression_ratio),
    // 深度思考开关：点名的模型不带 `enable_thinking: false` 之外的语义，空 = 现状不变。
    // 空值必须回 ''（而不是 undefined），前端才能把「清空输入框」显示成已关闭。
    disable_thinking_models: map.disable_thinking_models || '',
    // 搜索工具（AnySearch）卡片：开关 + 默认搜索参数 + 只读生效端点（绝不含 key）
    search_enabled: boolValue(map.search_enabled, true),
    search_max_results: normMaxResults(map.search_max_results, 5),
    search_freshness: map.search_freshness || '',
    search_zone: map.search_zone || '',
    anysearch_endpoint_effective: require('../websearch').effectiveEndpoint(),
  };

  settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT;
  return settings;
}

router.get('/', (req, res) => {
  // ?model=X 可临时覆盖（前端渠道切换后刷新窗口解析值用，不落库）
  res.json({ settings: getSettings(req.query.model) });
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const keys = ['base_url', 'api_key', 'model', 'system_prompt', 'anysearch_api_key', 'context_window', 'compression_ratio', 'search_enabled', 'search_max_results', 'search_freshness', 'search_zone', 'disable_thinking_models'];

  // A6：base_url 落库前先过出网校验——服务端会带着 API Key 请求该地址（refresh-models / test），
  // 指向回环/私网即构成 SSRF + 密钥外带。拒绝入库，而不是等请求发出时才失败。
  if (body.base_url !== undefined && String(body.base_url).trim() !== '') {
    try {
      require('../urlGuard').assertPublicBaseUrl(String(body.base_url).trim(), { label: 'base_url' });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }

  for (const key of keys) {
    // 字段缺席 = 不变更；密钥字段传空串 = 显式清空（免费渠道无需 key），但必须同时带
    // clear_<key>: true 才真的清。因为 GET 已不再回传明文，浏览器缓存的旧版前端
    // 会把空输入框无条件发过来，没这道护栏就会静默删掉用户的密钥。
    if (body[key] !== undefined) {
      if (SECRET_KEYS.includes(key) && String(body[key]).trim() === '' && body['clear_' + key] !== true) continue;
      db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, String(body[key])]
      );
    }
  }

  res.json({ settings: getSettings() });
  // 渠道/模型变更后后台静默重拉官方模型信息（去重，失败不影响保存）
  require('../modelInfo').scheduleRefresh();
});

router.post('/test', async (req, res) => {
  try {
    const reply = await callLLM(
      [{ role: 'user', content: '只回复两个字：在线' }],
      { maxTokens: 256, temperature: 0 }
    );
    const current = llmConfig();
    res.json({ ok: true, reply, model: current.model });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

// 用当前搜索配置真跑一次极小搜索（query 固定、maxResults=1），验证 Key/网络连通。
// 错误信息兜底脱敏：任何路径都不把明文 key 回给前端或写日志。
router.post('/test-search', async (req, res) => {
  try {
    const text = await require('../websearch').search({ query: '连接测试', maxResults: 1 });
    res.json({ ok: true, snippet: String(text || '').slice(0, 200) });
  } catch (err) {
    let message = err && err.message ? err.message : String(err);
    const rawKey = (db.get("SELECT value FROM settings WHERE key = 'anysearch_api_key'") || {}).value
      || process.env.ANYSEARCH_API_KEY || '';
    if (rawKey && message.includes(rawKey)) message = message.split(rawKey).join('***');
    res.status(502).json({ ok: false, error: message });
  }
});

// 手动刷新渠道官方模型信息（/models 报告的上下文上限，第一信息源）；
// 前端在「官方缺失/尚未拉取」时提供按钮主动拉取
router.post('/refresh-models', async (req, res) => {
  try {
    const modelInfo = require('../modelInfo');
    const { baseUrl, apiKey } = modelInfo.currentCfg();
    const r = await modelInfo.refreshModelInfo(baseUrl, apiKey);
    res.json({ ok: true, count: r.count, at: r.at, settings: getSettings() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;
