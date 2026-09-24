// 朱雀 AI 文本检测客户端（作家仓库的「度量」入口）。
//
// 安全设计照 server/websearch.js 的范式（A6 加固）：
//   1. 端点只允许两处来源——编译期默认值或 ZHUQUE_ENDPOINT 环境变量；请求参数永远改不了端点；
//   2. 密钥只进 Authorization 头；出网前检查密钥没有被拼进 url（防泄漏到目标地址或日志）；
//   3. 错误信息兜底脱敏：任何路径都不把明文 key 回给前端或写日志。
//
// 关键契约（2026-09-11 实测校准，详见 docs/report/20260911_作家仓库/00-勘察与实测/01-朱雀检测器校准实验.md）：
//   - softmax_confidence 越大越像 AI（人类样本 0.0182 / AI 仿写 0.91 / 口语化改写 0.5179）；
//   - labels_ratio 是 [人工, AI, 疑似] 三元组比例；
//   - segment_labels[] 逐段给出 text/label/conf/position —— 这就是错题库的入库粒度；
//   - **分段阈值由长度决定**：短文本（<200 字）即便 is_merge=false 也只回 1 段，长章节才分多段。
//     因此不要指望逐句粒度，也不要自己去切句——用服务端返回的段。
const DEFAULT_ENDPOINT = 'https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify';
const TIMEOUT_MS = 60000;

function endpoint() {
  const fromEnv = String(process.env.ZHUQUE_ENDPOINT || '').trim();
  const url = fromEnv || DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('朱雀端点只允许 https');
    if (parsed.username || parsed.password || parsed.search) {
      throw new Error('朱雀端点不允许携带用户凭据或 query 参数');
    }
    return url;
  } catch (err) {
    throw new Error(`ZHUQUE_ENDPOINT 配置无效: ${err.message}`);
  }
}

// 生效端点（仅端点、绝不含 key）：供设置页只读展示；解析失败返回原始配置值，展示层不该炸。
function effectiveEndpoint() {
  try { return endpoint(); } catch { return String(process.env.ZHUQUE_ENDPOINT || DEFAULT_ENDPOINT); }
}

// 密钥来源：settings.zhuque_api_key 优先，其次环境变量。db 未就绪（独立脚本场景）时走环境变量。
function apiKey() {
  try {
    const row = require('../db').get('SELECT value FROM settings WHERE key = ?', ['zhuque_api_key']);
    if (row && row.value) return row.value;
  } catch { /* db 未就绪 */ }
  return process.env.ZHUQUE_API_KEY || '';
}

function hasKey() {
  return Boolean(apiKey());
}

// 错误脱敏：任何路径都不把明文 key 回给前端或写日志
function sanitize(message, key) {
  let out = String(message == null ? '' : message);
  if (key && out.includes(key)) out = out.split(key).join('***');
  return out;
}

// labels_ratio 归一：上游可能给数组或 JSON 字符串，统一成 [人工, AI, 疑似] 三元组
function normalizeRatio(raw) {
  let arr = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(n => Number(n)).filter(n => Number.isFinite(n));
}

function labelOf(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= 0 && v <= 2 ? v : null;
}

/**
 * 检测一段文本的 AI 成分。
 * @param {string} text 待检测文本（非空）
 * @param {{isMerge?: boolean}} [options] isMerge 默认 false（不合并分段，保留逐段粒度供入库）
 * @returns {Promise<{conf:number|null, labelsRatio:number[], segments:Array<{index:number,text:string,label:number|null,conf:number|null,position:string}>, usageTokens:number|null, raw:object}>}
 *   上游返回结构变化时宁可字段为 null，也不抛解析错——检测失败不该炸掉调用方。
 */
async function detect(text, options) {
  const key = apiKey();
  if (!key) {
    const err = new Error('未配置朱雀检测密钥：请在设置页填写「朱雀检测 Key」，或设环境变量 ZHUQUE_API_KEY');
    err.code = 'ZHUQUE_NO_KEY';
    err.status = 400;
    throw err;
  }
  const body = String(text == null ? '' : text);
  if (!body.trim()) {
    const err = new Error('待检测文本为空');
    err.code = 'ZHUQUE_EMPTY_TEXT';
    err.status = 400;
    throw err;
  }

  const url = endpoint();
  if (url.includes(key)) throw new Error('朱雀密钥出现在端点 URL 中，已拒绝出网');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  let payload;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: body, is_merge: Boolean(options && options.isMerge) }),
      signal: ctl.signal,
    });
    payload = await res.json().catch(() => null);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    const e = new Error(aborted
      ? `朱雀检测超时（${TIMEOUT_MS / 1000}s）：文本较长或网络不畅，可稍后重试`
      : `朱雀检测请求失败：${sanitize(err && err.message, key)}`);
    e.code = aborted ? 'ZHUQUE_TIMEOUT' : 'ZHUQUE_NETWORK';
    e.status = 502;
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = payload && (payload.error || payload.message || payload.detail);
    const e = new Error(sanitize(
      `朱雀检测返回 ${res.status}${detail ? '：' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`,
      key
    ));
    e.code = 'ZHUQUE_UPSTREAM';
    e.status = 502;
    throw e;
  }

  // 上游可能的包裹层：{data:{...}} / 直接平铺；两种都吃
  const root = (payload && payload.data && typeof payload.data === 'object') ? payload.data : (payload || {});

  const rawSegments = Array.isArray(root.segment_labels) ? root.segment_labels
    : (Array.isArray(root.segments) ? root.segments : []);
  const segments = rawSegments.map((s, i) => {
    const item = s && typeof s === 'object' ? s : {};
    return {
      index: Number.isInteger(item.index) ? item.index : i,
      text: typeof item.text === 'string' ? item.text : '',
      label: labelOf(item.label),
      conf: Number.isFinite(Number(item.conf)) ? Number(item.conf) : null,
      position: item.position == null ? '' : String(item.position),
    };
  }).filter(s => s.text);

  const confRaw = root.softmax_confidence;
  return {
    conf: Number.isFinite(Number(confRaw)) ? Number(confRaw) : null,
    labelsRatio: normalizeRatio(root.labels_ratio),
    segments,
    usageTokens: Number.isFinite(Number(root.usage && root.usage.total_tokens))
      ? Number(root.usage.total_tokens)
      : null,
    raw: root,
  };
}

module.exports = { detect, hasKey, apiKey, endpoint, effectiveEndpoint, DEFAULT_ENDPOINT };
