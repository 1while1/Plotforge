// 内置联网搜索：AnySearch JSON-RPC 2.0 原生客户端（无 key 可匿名访问，限速较低）
// 参考 skills/anysearch 的 CLI 实现，直接内嵌为模块，LLM 工具 web_search/web_extract 走这里
//
// A6（第二轮重审查）加固：
//   1. 端点只允许两处来源——编译期默认值或 ANYSEARCH_ENDPOINT 环境变量；LLM/请求参数
//      永远改变不了端点（extract 的 url 只是交给 AnySearch 服务端的抓取目标，不是我们的出网点）。
//   2. 密钥只进 Authorization 头；并在出网前检查密钥没有被拼进 url/query（防止任何路径
//      把 key 泄漏到目标地址或日志里）。
const DEFAULT_ENDPOINT = 'https://api.anysearch.com/mcp';

function endpoint() {
  const fromEnv = String(process.env.ANYSEARCH_ENDPOINT || '').trim();
  const url = fromEnv || DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('AnySearch 端点只允许 https');
    if (parsed.username || parsed.password || parsed.search) {
      throw new Error('AnySearch 端点不允许携带用户凭据或 query 参数');
    }
    return url;
  } catch (err) {
    throw new Error(`ANYSEARCH_ENDPOINT 配置无效: ${err.message}`);
  }
}

function apiKey() {
  try {
    const row = require('./db').get('SELECT value FROM settings WHERE key = ?', ['anysearch_api_key']);
    if (row && row.value) return row.value;
  } catch { /* db 未就绪（独立脚本场景）时走环境变量/匿名 */ }
  return process.env.ANYSEARCH_API_KEY || '';
}

// 生效端点（仅端点、绝不含 key）：供设置页只读展示。端点解析失败（非法环境变量）时
// 返回原始配置值供排查，不抛错——展示层不该炸。
function effectiveEndpoint() {
  try { return endpoint(); } catch { return String(process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT); }
}

// 设置页「搜索工具」卡片的默认参数（工具调用未显式传参时生效）。
// db 未就绪（独立脚本场景）时回退空值，行为与未设置一致。
function searchDefaults() {
  const map = {};
  try {
    for (const key of ['search_max_results', 'search_freshness', 'search_zone']) {
      const row = require('./db').get('SELECT value FROM settings WHERE key = ?', [key]);
      if (row && row.value !== '' && row.value !== undefined && row.value !== null) map[key] = row.value;
    }
  } catch { /* 忽略，走内置默认 */ }
  return map;
}

// 结果条数夹取：1~10；无有效值回退 fallback（fallback=0 表示「不发该参数」）
function clampMaxResults(v, fallback) {
  const n = Number(v);
  if (!n || n < 1) return fallback;
  return Math.min(Math.round(n), 10);
}

// AnySearch 的鉴权/配额类错误不走 HTTP 状态码或 JSON-RPC error，而是 HTTP 200 + 正文
// 返回「invalid_api_key Invalid API key.」这类短文本（2026-09-10 实测）。不识别的话，
// 错误会被当成搜索结果喂给模型（LLM 以为搜到了东西），设置页「测试搜索」也会误报成功。
// 识别规则：短文本 + 已知错误前缀。真实结果恒以 ## 或 { 开头且远超 200 字符，不会误伤。
const INLINE_ERROR_RE = /^(?:invalid_api_key|unauthorized|forbidden|rate_limited|quota_exceeded|insufficient_quota|payment_required|api_key_(?:invalid|expired|disabled))\b/i;

function throwIfInlineError(text) {
  const t = String(text || '');
  if (t.length < 200 && INLINE_ERROR_RE.test(t)) {
    throw new Error('AnySearch 调用失败：' + t.slice(0, 160));
  }
  return text;
}

// JSON-RPC tools/call；返回文本结果
async function callTool(name, args, timeoutMs = 30000) {
  const headers = { 'Content-Type': 'application/json' };
  const key = apiKey();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  // 密钥外带守卫：任何参数值都不允许内嵌密钥（args 全部来自 LLM 输出，不可信任）
  if (key) {
    const serialized = JSON.stringify(args);
    if (serialized.includes(key)) {
      throw new Error('请求参数中检测到 API Key，已拒绝调用（防止密钥经第三方服务外带）');
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`AnySearch HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const content = json.result && json.result.content;
    if (Array.isArray(content)) {
      const textItem = content.find(c => c.type === 'text');
      if (textItem) return throwIfInlineError(textItem.text);
    }
    return JSON.stringify(json.result || json, null, 2);
  } finally {
    clearTimeout(timer);
  }
}

// 网页搜索：query 必填；可选 maxResults/freshness(day|week|month|year)/zone(cn|intl)/domain。
// 未传的参数回退设置页默认值（search_max_results/search_freshness/search_zone）。
async function search({ query, maxResults, freshness, zone, domain } = {}) {
  const defaults = searchDefaults();
  const args = { query };
  const effMax = clampMaxResults(maxResults, clampMaxResults(defaults.search_max_results, 0));
  if (effMax) args.max_results = effMax;
  const effFreshness = freshness || defaults.search_freshness || '';
  if (effFreshness) args.freshness = effFreshness;
  const effZone = zone || defaults.search_zone || '';
  if (effZone) args.zone = effZone;
  if (domain) args.domain = domain;
  const text = await callTool('search', args);
  return text.slice(0, 6000);
}

// 批量搜索：一次并发查 1-5 个相互独立的问题（单条失败不阻塞其它，由 AnySearch 服务端保证）。
// 每条可为字符串或 { query, maxResults?, freshness?, zone?, domain? }；超 5 条截断，
// 缺非空 query 直接报错（避免整批静默少查）。批量结果更长，截断放宽到 12000。
async function batchSearch(queries) {
  const list = Array.isArray(queries) ? queries : [];
  if (list.length < 1) throw new Error('batch_search 至少需要 1 条查询');
  const defaults = searchDefaults();
  const shaped = list.slice(0, 5).map((raw) => {
    const item = typeof raw === 'string' ? { query: raw } : (raw || {});
    const q = String(item.query || '').trim();
    if (!q) throw new Error('batch_search 每条查询都必须包含非空 query');
    const out = { query: q };
    const effMax = clampMaxResults(item.maxResults, clampMaxResults(defaults.search_max_results, 0));
    if (effMax) out.max_results = effMax;
    const effFreshness = item.freshness || defaults.search_freshness || '';
    if (effFreshness) out.freshness = effFreshness;
    const effZone = item.zone || defaults.search_zone || '';
    if (effZone) out.zone = effZone;
    if (item.domain) out.domain = item.domain;
    return out;
  });
  const text = await callTool('batch_search', { queries: shaped });
  return text.slice(0, 12000);
}

// 抓取 URL 正文（url 只是转交给 AnySearch 服务端的抓取目标；仍校验协议防 file:// 等注入）
async function extract(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw new Error('extract 的 url 不是合法 URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('extract 只允许 http/https 地址');
  }
  const text = await callTool('extract', { url: parsed.href });
  return text.slice(0, 6000);
}

module.exports = { search, extract, batchSearch, effectiveEndpoint };
