// 模型官方信息源：只认渠道 /models 接口报告的上下文上限（第一信息源），DB 缓存 + 24h TTL；
// 渠道不报告上下文字段 → null（回退用户设置/系统默认，绝不猜测、不维护硬编码表）
const db = require('./db');

const TTL_MS = 24 * 3600 * 1000;
// 各家网关对上下文长度的字段名不统一，逐一兼容（OpenRouter 风格 context_length、vLLM 风格 max_model_len 等）
const CTX_FIELDS = ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'model_max_length', 'max_context'];

function currentCfg() {
  const get = (k, d) => {
    const r = db.get('SELECT value FROM settings WHERE key = ?', [k]);
    return r && r.value !== '' ? r.value : d;
  };
  return {
    baseUrl: String(get('base_url', 'https://apihub.agnes-ai.com/v1')).replace(/\/+$/, ''),
    apiKey: get('api_key', ''),
    model: get('model', ''),
  };
}

function pickContextLength(m) {
  if (!m || typeof m !== 'object') return null;
  const sources = [m, m.info, m.metadata];
  for (const s of sources) {
    if (!s) continue;
    for (const k of CTX_FIELDS) {
      const v = Number(s[k]);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

// 拉取渠道 /models 并 upsert 到 model_info（context_length 可能为 NULL = 渠道未报告）
async function refreshModelInfo(baseUrl, apiKey) {
  // A6 深度防御：即使 base_url 绕过设置页（历史遗留/直接写库），出网前仍再校验一次，
  // 绝不向回环/私网地址携带 Bearer key 发起请求。
  require('./urlGuard').assertPublicBaseUrl(baseUrl, { label: 'base_url' });
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const res = await fetch(baseUrl + '/models', { headers });
  if (!res.ok) throw new Error('GET /models 失败 ' + res.status);
  const j = await res.json();
  const list = Array.isArray(j.data) ? j.data : [];
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const m of list) {
      if (!m || !m.id) continue;
      db.run(
        `INSERT INTO model_info (base_url, model, context_length, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(base_url, model) DO UPDATE SET context_length = excluded.context_length, fetched_at = excluded.fetched_at`,
        [baseUrl, String(m.id), pickContextLength(m), now]
      );
    }
  });
  return { count: list.length, at: now };
}

let refreshing = false;
// 后台静默刷新（去重）；失败不影响主流程
function scheduleRefresh() {
  if (refreshing) return;
  refreshing = true;
  const { baseUrl, apiKey } = currentCfg();
  refreshModelInfo(baseUrl, apiKey).catch(() => {}).finally(() => { refreshing = false; });
}

// 官方上限：null = 渠道未报告或尚未拉取（绝不猜测）；未拉取/过期时触发后台拉取
function getOfficialContextWindow(model) {
  const { baseUrl } = currentCfg();
  const row = db.get('SELECT context_length, fetched_at FROM model_info WHERE base_url = ? AND model = ?', [baseUrl, String(model || '')]);
  if (!row) { scheduleRefresh(); return null; }
  if (Date.now() - Date.parse(row.fetched_at) > TTL_MS) scheduleRefresh();
  return row.context_length || null;
}

// 供 UI 展示：官方值 + 来源状态 + 拉取时间
function officialInfo(model) {
  const { baseUrl } = currentCfg();
  const row = db.get('SELECT context_length, fetched_at FROM model_info WHERE base_url = ? AND model = ?', [baseUrl, String(model || '')]);
  if (!row) return { official: null, source: 'not_fetched', fetchedAt: null };
  return {
    official: row.context_length || null,
    source: row.context_length ? 'channel_reported' : 'channel_not_reported',
    fetchedAt: row.fetched_at,
  };
}

module.exports = { refreshModelInfo, scheduleRefresh, getOfficialContextWindow, officialInfo, pickContextLength, currentCfg };
