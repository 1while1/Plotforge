// StepFun LLM 渠道（作者印记蒸馏 · L2 map 专用，2026-09-12 实测定稿参数）。
//
// 踩坑记录（照抄自渠道说明，不要「优化」）：
//   base_url 结尾是 /v1（少写 /v1 会 404）
//   reasoning_effort 只接受 low/medium/high——传 "none" 会被静默忽略且 content 为空
//   max_tokens 必须覆盖思考+正文（思考在 message.reasoning_content、正文在 message.content，
//   finish_reason=length 而 content 为空 = 预算被思考吃光）
//
// 渠道第二条（2026-09-13 加）：Agnes 官方线（base https://apihub.agnes-ai.com/v1，模型 agnes-3.0-flash）。
//   与 StepFun 的差异（实测，见报告 09 §6.6）：
//   ① 开思考必须走 chat_template_kwargs.enable_thinking（默认不吐 reasoning_content，
//      且会概率性返回 {"observations": []} 空结果）；开关放在 map.js 组 body 处；
//   ② 没有 reasoning_effort 参数，传了会被忽略；
//   ③ 凭据文件里有**多把独立额度 key**（RPM 各 20）→ 本模块提供 resolveApiKeys + keyRotator
//      轮转，按请求换 key（并发 4/key 实测延迟不涨，见 §6.6）。
//
// key 安全铁律：key 只进 Authorization 头，绝不写进日志/异常消息/任何文件；
// 展示一律 masked()（前 8 后 4）。
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.stepfun.com/step_plan/v1';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// 匹配仓库根的 key 说明文件（如 StepFun蒸馏渠道apikey.txt）
const API_KEY_FILE_RE = /^stepfun.*apikey/i;

/**
 * 渠道注册表。name 是 CLI `--provider` 的取值；label 只用于错误文案；
 * keyEnv 是环境变量覆盖；keyFileRe 匹配仓库根的凭据文件；multiKey=true 表示
 * 「文件里有多把独立额度 key、按请求轮转」（单 key 的 StepFun 不用轮转）。
 */
const PROVIDERS = {
  stepfun: {
    name: 'stepfun', label: 'StepFun', baseUrl: BASE_URL,
    keyEnv: 'STEPFUN_API_KEY', keyFileRe: API_KEY_FILE_RE, multiKey: false,
    defaultModel: 'step-3.7-flash',
  },
  agnes: {
    name: 'agnes', label: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
    keyEnv: 'AGNES_API_KEY', keyFileRe: /^(agens|agnes).*key.*\.txt$/i, multiKey: true,
    defaultModel: 'agnes-3.0-flash',
  },
};

/** 取渠道描述；未知名字抛错（不静默回退，避免把请求打到错的渠道）。 */
function providerOf(name) {
  const key = String(name || 'stepfun').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) throw new Error(`未知渠道 provider=${name}（可选：${Object.keys(PROVIDERS).join(' / ')}）`);
  return p;
}

/** 从文本里抠出所有形如 sk-…/wk-… 的长 token（ASCII 限定：全角括号等不能混入）。 */
function extractKeyTokens(text) {
  return [...new Set(String(text || '').match(/[sw]k-[A-Za-z0-9_\-]{8,}/g) || [])];
}

/**
 * 解析渠道的多把 key（轮转用）：
 *  ① 环境变量（agnes 用 AGNES_API_KEY，支持逗号分隔多把）
 *  ② 仓库根匹配 keyFileRe 的 .txt 文件里**全部** sk-/wk- token
 * 无 → 抛错（提示该设哪个环境变量），错误消息不含 key 本身。
 */
function resolveApiKeys(name, { root } = {}) {
  const p = providerOf(name);
  const env = String(process.env[p.keyEnv] || '').trim();
  if (env) {
    const fromEnv = env.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (fromEnv.length) return fromEnv;
  }
  const base = root || REPO_ROOT;
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isFile() && p.keyFileRe.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch { /* 根目录不可读视同无凭据文件 */ }
  const keys = [];
  for (const n of names) {
    keys.push(...extractKeyTokens(fs.readFileSync(path.join(base, n), 'utf8')));
  }
  if (keys.length) return [...new Set(keys)];
  throw new Error(
    `未找到 ${p.label} API key：请设置环境变量 ${p.keyEnv}` +
    `（多把 key 用逗号分隔），或在仓库根目录放置文件名匹配 ${p.keyFileRe} 的 .txt。` +
    '（key 不会被写入日志或任何文件）'
  );
}

/** 按请求轮转多把 key（多渠道 key 池）；返回 () => key，环形复用。 */
function keyRotator(keys) {
  const list = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.trim());
  if (!list.length) throw new Error('keyRotator: 至少需要一把 key');
  let i = 0;
  const next = () => list[i++ % list.length];
  next.size = list.length;   // 供日志打印「keys=N」而不暴露内容（函数属性，无副作用）
  return next;
}

/** 掩码展示：前 8 后 4（短 key 也照此公式，不整体暴露）。 */
function masked(key) {
  const s = String(key || '');
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/** 解析 retry-after 类响应头（对齐 server/llm.js:105 的既有范式，缺 headers 时安全返回 null）：
 *  retry-after-ms（毫秒）优先 → retry-after（秒 或 HTTP-date）→ 无法解析返回 null。 */
function parseRetryAfterHeader(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const msRaw = headers.get('retry-after-ms');
  if (msRaw != null && msRaw !== '') {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headers.get('retry-after');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

/** 抛错时统一挂结构化字段，供上层 runPool 决定「是否重试 + 等多久」：
 *  e.status（HTTP 状态码，有则挂）· e.retryAfter（毫秒，服务端要求时）· e.nonRetryable（确定性错误）。 */
function httpError(status, message, { retryAfter = null, nonRetryable = false } = {}) {
  const e = new Error(message);
  e.status = status;
  if (retryAfter != null) e.retryAfter = retryAfter;
  if (nonRetryable || (status >= 400 && status < 500 && status !== 429 && status !== 408)) {
    e.nonRetryable = true; // 401/400 等确定性错误：重试纯浪费（空 content 时思考 token 已计费）
  }
  return e;
}

/**
 * key 解析（优先级）：
 *  ① process.env.STEPFUN_API_KEY（trim 后非空）
 *  ② 仓库根目录文件名匹配 /stepfun.*apikey/i 的 .txt 文件（utf-8）里
 *     「API Key：」行之后的第一个长度 ≥30 的非空行
 * 两者都没有 → 抛错并提示设置环境变量。错误消息绝不包含 key 本身。
 * @param {{root?: string}} [o] root 可注入（测试用临时目录；默认仓库根）
 */
function resolveApiKey({ root } = {}) {
  const env = (process.env.STEPFUN_API_KEY || '').trim();
  if (env) return env;
  const base = root || REPO_ROOT;
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isFile() && API_KEY_FILE_RE.test(e.name) && e.name.toLowerCase().endsWith('.txt'))
      .map((e) => e.name)
      .sort();
  } catch { /* 根目录不可读视同无 key 文件，走抛错分支 */ }
  for (const name of names) {
    const lines = fs.readFileSync(path.join(base, name), 'utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => /API\s*Key[：:]/.test(l));
    if (idx === -1) continue;
    for (let i = idx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.length >= 30) return t;
    }
  }
  throw new Error(
    '未找到 StepFun API key：请设置环境变量 STEPFUN_API_KEY，' +
    '或在仓库根目录放置文件名匹配 stepfun*apikey 的 .txt（「API Key：」行的下一行写 key）。' +
    '（key 不会被写入日志或任何文件）'
  );
}

/**
 * POST {provider.baseUrl}/chat/completions，返回 { content, finishReason, usage, reasoningLength }。
 *
 * - 超时（默认 120s）用 AbortController；网络失败/非 2xx 抛错（由上层 runPool 重试）。
 * - content 为空且 finish_reason='length' → 抛错并提示调大 max_tokens（预算被思考耗尽）。
 * - fetchImpl 可注入；默认 globalThis.fetch（测试在该边界 stub，零真实网络）。
 * - provider 省略 = StepFun（默认渠道，行为与此前完全一致）；可传渠道名或 providerOf() 的返回值。
 *
 * @param {{apiKey: string, body: object, fetchImpl?: Function, timeoutMs?: number, provider?: string|object}} o
 */
async function chatJson({ apiKey, body, fetchImpl, timeoutMs = 120000, provider }) {
  const p = (provider && typeof provider === 'object') ? provider : providerOf(provider);
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('chatJson: 无可用 fetch（需 Node 18+ 或注入 fetchImpl）');
  if (!apiKey) throw new Error('chatJson: 缺少 apiKey');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let raw;
  try {
    const res = await doFetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const retryAfter = parseRetryAfterHeader(res.headers);
      throw httpError(res.status,
        `${p.label} HTTP ${res.status}: ${String(errText).slice(0, 200)}`, { retryAfter });
    }
    raw = await res.text();
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(`${p.label} 请求超时/中止（${timeoutMs}ms，${(e && e.name) || 'AbortError'}）`);
    }
    throw e; // 网络失败等，由上层重试
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${p.label} 返回非 JSON 载荷: ${String(raw).slice(0, 120)}`);
  }
  const choice = (data.choices && data.choices[0]) || {};
  const message = choice.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
  const reasoningLength = typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0;
  const usage = data.usage || {};
  if (!content && finishReason === 'length') {
    // 确定性错误：同样的 body 重试必然同样耗尽预算 —— 标记 nonRetryable 让上层直接失败，
    // 避免为一次「必然失败」重复付思考 token 的钱。e.truncated 供上层走「切半分块」兜底
    // （2026-09-13 实测：8,000 字块在 12000 预算下会整块被思考吃光，非偶发）。
    const e = httpError(400,
      `${p.label} content 为空且 finish_reason=length：max_tokens=${(body && body.max_tokens) || '?'} ` +
      '预算被思考耗尽、未覆盖正文——请调大 max_tokens 后重试',
      { nonRetryable: true });
    e.truncated = true;
    // 这次调用已经计费（思考 token 真实消耗），把 usage 挂在错误上供上层记账——
    // 否则「预算耗尽重跑」的浪费会在成本报表里凭空消失（成本口径必须含失败调用）。
    e.usage = {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
    };
    throw e;
  }
  return {
    content,
    finishReason,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
    },
    reasoningLength,
  };
}

module.exports = {
  BASE_URL, PROVIDERS, providerOf, resolveApiKey, resolveApiKeys, keyRotator, extractKeyTokens,
  chatJson, masked, parseRetryAfterHeader, httpError,
};
