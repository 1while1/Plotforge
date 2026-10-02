// LLM 调用与上下文组装入口
const db = require('./db');
const context = require('./context');
const modelInfo = require('./modelInfo');
const llmCallLog = require('./llmCallLog');
const contextBudget = require('./contextBudget');

// 默认渠道：Agnes（apihub，需在设置页填 API Key）。旧的 zen/go + deepseek-v4-flash 已欠费失效，
// 不再作为默认回落，避免全新数据库默认指向死渠道。
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_MODEL = 'agnes-2.5-flash';
const { DEFAULT_SYSTEM_PROMPT } = require('./context/providers/identity');

function getSetting(key, fallback = '') {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row && row.value !== '' ? row.value : fallback;
}

function llmConfig() {
  const baseUrl = getSetting('base_url', DEFAULT_BASE_URL).replace(/\/+$/, '');
  // api_key 只认 settings 里的显式配置：
  //   - 有 api_key 行：用其值（'' 即视为「免费/无 key」，不发 Authorization 头）
  //   - 无行：视为未配置，返回空
  // 不再按 base_url 子串回退到仓库内的密钥 txt：子串匹配可被任意自建端点触发
  // （只要路径里含 /zen/go/），等于把本地密钥外带给不可信服务。
  const keyRow = db.get('SELECT value FROM settings WHERE key = ?', ['api_key']);
  const apiKey = keyRow ? (keyRow.value || '') : '';
  return { baseUrl, apiKey, model: getSetting('model', DEFAULT_MODEL) };
}

// ---------------- 深度思考开关（2026-09-13 「写一篇文章直接卡死」诊断产物） ----------------
// 现象取证（报告 21-写文章卡死诊断.md，书#18 真实会话）：中转站 deepseek-v4-flash 默认把
// 2,000~11,000 token 花在 reasoning 上，单次调用 18~57 秒；一轮写作最多 4 次调用 → 作者等 60~77 秒。
// 同一批请求换 agnes 渠道平均推理 73~155 token、单次 3.5~8 秒——差距全在推理，不在正文。
//
// 该渠道参数实测（同题对照，4 组变体 + 3 组质量对照）：
//   · reasoning_effort: low / none  → 被**静默忽略**（思考量与耗时不变，12.3s→12.2s/11.9s）
//   · chat_template_kwargs          → HTTP 400「未知请求字段」
//   · enable_thinking: false        → **生效**：思考 0 字，6.8s→3.9s，工具调用与正文逐句可比
//   · thinking: {type:'disabled'}   → 同样生效（本文只用 enable_thinking，两者等效）
// Agnes 渠道对 enable_thinking 静默接受（不报错也不改变行为），故可安全下发。
//
// 但不同网关对未知字段的容忍度不同（本次已实测到一个会 400 的），所以开关默认**关闭**：
// 只有 settings.disable_thinking_models 点名的模型才带该字段，`*` 表示对所有模型生效。
// 空值 = 与历史行为逐位一致，不改变任何请求体。
//
// 实现已收敛到 server/runtime/thinking-mode.js（G2 审查 P2-3：与 model-options
// 不再各写一份名单匹配——两份漂移时两个入口会打出不同请求体）。
const { THINKING_OFF_FIELD, THINKING_OFF_SETTING, thinkingDisabledModel, applyThinkingMode } = require('./runtime/thinking-mode');

// ---------------- 韧性网关（重试 + 超时 + 退避） ----------------
// 对齐 pi：在 provider 层统一兜底传输抖动，所有 LLM 调用方（写作/润色/咨询/advisor/提案/压缩）共享。
const RETRY_MAX_ATTEMPTS = 5;          // 总尝试次数（含首次）；2026-09-30 委托方指令 3→5（扛渠道抖动）
const RETRY_BASE_DELAY_MS = 500;       // 退避基准
const RETRY_MAX_DELAY_MS = 8000;       // 退避上限
// M1（对齐 pi provider-retry.ts:1 的 maxRetryDelayMs=60s）：服务端经 retry-after 明示的等待超过 60s
// 时不再自动重试，直接把错误上抛交上层决策——避免被「等 10 分钟」式响应挂死，也避免掐头去尾
// 只睡 8s 就硬撞（旧实现把 retry-after 夹进 maxDelay，等于无视服务端节奏）。
const RETRY_AFTER_CEILING_MS = 60000;
const REQUEST_TIMEOUT_MS = 120000;     // 请求超时：覆盖到「响应头到达」（非流式此时响应体已就绪；流式随后由 stall 检测接管）
// A16（第二轮重审查）：流式请求的响应头必须很快到达（服务端只发 ack 不生成内容），
// 120s 的通用超时对流式首字节毫无意义。曾收紧到 20s，但会误杀推理模型
//（agnes-2.5-flash/deepseek-reasoner）的长思考期——首字节前模型在推理、不发任何数据。
// 取舍史：2026-09-09 放宽到 3 分钟（宁可等也不误杀慢思考）；2026-09-30 委托方指令放宽到 6 分钟；
// 代价是「上游完全无响应」的死连接最坏静默 ≈ 5×360s + 退避 ≈ 30 分钟（界面可手动停止）。
// 非流式 REQUEST_TIMEOUT_MS=120s 不动（非流式响应头到达即生成完成，收紧会杀掉慢生成）。
const STREAM_FIRST_BYTE_TIMEOUT_MS = 360000;
// 2026-09-30 抗短连：信号差的模型流内静默间隙长，45s 误杀率高；配合首字节 360s 口径。
const STREAM_STALL_TIMEOUT_MS = 90000; // 流式静默超时：两个数据块之间的最大间隔，超时视为断流

// 配额/账单类错误模式（对齐 pi ai/src/utils/retry.ts:7-24 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN）：
// 这类错误重试只会继续撞墙、白烧窗口时间，即便伴随 429/5xx 状态码也必须立即失败。
// 中文变体覆盖聚合渠道（apihub 系）常见的「余额不足/欠费/请充值」文案。
const NON_RETRYABLE_QUOTA_PATTERNS = [
  'insufficient_quota', 'quota exceeded', 'exceeded your current quota', 'out of budget',
  'billing', 'payment required', 'arrears', '余额不足', '欠费', '充值',
];

// 判定是否配额/账户类错误（永不重试，纯函数）
function isNonRetryableLimitError(err) {
  if (!err || typeof err.message !== 'string') return false;
  const msg = err.message.toLowerCase();
  return NON_RETRYABLE_QUOTA_PATTERNS.some(p => msg.includes(p));
}

// 可重试错误分类（纯函数）：仅传输/瞬时类可重试；配额/鉴权/参数类 4xx 与用户主动取消一律不重试
// M1 对齐 pi retry.ts：①配额/账单类先于状态码判定（429+quota / 402 也不重试）；
// ②补「停滞流」传输类模式（与既有「过早断流」模式并列，无重复定义）
function isRetryableError(err) {
  if (!err) return false;
  if (err.__userAbort) return false;                 // 用户主动取消：永不重试
  if (isNonRetryableLimitError(err)) return false;   // 配额/账单类（含 429 quota）：永不重试
  if (err.__prematureStream) return true;            // 本模块标注的「过早断流」：传输类，可重试
  if (err.__timeout) return true;                    // 本模块超时触发的 abort：可重试
  if (err.__transport) return true;                  // postChatJson 标注的「响应体下载中断」：传输类，可重试（2026-09-30 抗短连）
  const status = err.status;
  if (status) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;                                    // 其它 4xx（400/401/402/403/404/422…）不可重试
  }
  const msg = String(err.message || '').toLowerCase();
  const patterns = [
    'fetch failed', 'econnreset', 'etimedout', 'epipe', 'econnrefused', 'eai_again',
    'socket hang up', 'terminated', 'other side closed', 'network',
    // 过早断流（pi retry.ts:26-90 的 'ended without' 系）+ 停滞流（本模块 stall 看门狗的输出）
    'stream ended without finish_reason', 'stream ended prematurely', 'premature end', 'no finish_reason',
    'stream stalled', 'stalled stream',
  ];
  if (patterns.some(p => msg.includes(p))) return true;
  // AbortError 但未标注为用户取消 → 视为超时/传输中断，可重试
  return err.name === 'AbortError';
}

// 退避时长（纯函数）：指数退避 + ±20% jitter；上游给了 retry-after（毫秒）则优先，且都夹在 maxDelay 内
function computeBackoff(attempt, { baseDelay = RETRY_BASE_DELAY_MS, maxDelay = RETRY_MAX_DELAY_MS, retryAfter } = {}) {
  if (retryAfter && retryAfter > 0) return Math.min(maxDelay, Math.round(retryAfter));
  const exp = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

// 解析服务端 retry-after 类响应头（对齐 pi provider-retry.ts:51-67）：
//  - 优先 retry-after-ms（毫秒，undici/部分网关在用）
//  - retry-after 兼容纯数字（秒）与 HTTP-date（如 'Fri, 11 Sep 2026 10:00:00 GMT'）两种形态
//  - 缺失/无法解析返回 null
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
  const at = Date.parse(raw); // HTTP-date 形态：换算成距现在的毫秒
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

// 默认可被中断的 sleep（signal abort 时提前 reject）
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
  });
}

// 通用重试包装：fn 抛出的错误经 isRetryableError 判定；sleep 可注入（单测免真实等待）
async function withRetry(fn, opts = {}) {
  const {
    retries = RETRY_MAX_ATTEMPTS - 1,
    baseDelay = RETRY_BASE_DELAY_MS,
    maxDelay = RETRY_MAX_DELAY_MS,
    signal,
    sleep = defaultSleep,
    onRetry,
  } = opts;
  let attempt = 0;
  for (;;) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < retries && isRetryableError(err) && !(signal && signal.aborted);
      if (!canRetry) throw err;
      // M1：服务端经 retry-after 明示的等待超过上限 → 不再自动重试，直接上抛交上层决策
      //（对齐 pi provider-retry.ts:37-49 的「Server requested Xs retry delay」fail-fast）
      if (err.retryAfter && err.retryAfter > RETRY_AFTER_CEILING_MS) {
        err.__retryDeferredByServer = err.retryAfter;
        throw err;
      }
      const delay = computeBackoff(attempt, { baseDelay, maxDelay, retryAfter: err.retryAfter });
      if (onRetry) onRetry({ attempt, delay, error: err });
      await sleep(delay, signal);
      attempt++;
    }
  }
}

// 带重试+超时的 chat/completions 请求：返回原始 Response（供流式读 res.body）
// 超时只覆盖到「响应头到达」，拿到 res 即清除定时器；外部 signal（如流式 stall 检测）合并进内部 AbortController
async function fetchChatCompletion({ baseUrl, apiKey, body, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`; // 免费渠道（无 Key）不携带 Authorization 头
  return withRetry(async () => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; const e = new Error('request timeout'); e.__timeout = true; ac.abort(e); }, timeoutMs);
    // 外部 signal 全程桥接到内部 ac（含响应体消费阶段，供流式 stall abort 生效）；透传 reason
    const onExternalAbort = () => ac.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); const e = new Error('aborted by caller'); e.__userAbort = true; throw e; }
      signal.addEventListener('abort', onExternalAbort);
    }
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(applyThinkingMode(body)), signal: ac.signal,
      });
      clearTimeout(timer); // 响应头到达：清除超时（流式随后由 stall 接管）；外部 signal 桥接保留
      if (!res.ok) {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        const text = await res.text();
        const e = new Error(`LLM 请求失败 ${res.status}: ${text.slice(0, 300)}`);
        e.status = res.status;
        // M1：retry-after 解析升级（秒/HTTP-date/retry-after-ms 三形态，对齐 pi provider-retry.ts:51-67）
        const ra = parseRetryAfterHeader(res.headers);
        if (ra != null) e.retryAfter = ra;
        throw e;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (timedOut && err && typeof err === 'object') err.__timeout = true;
      else if (signal && signal.aborted && err && typeof err === 'object') err.__userAbort = true;
      throw err;
    }
  }, { retries: RETRY_MAX_ATTEMPTS - 1, baseDelay: RETRY_BASE_DELAY_MS, maxDelay: RETRY_MAX_DELAY_MS, signal });
}

// 非流式整体调用（2026-09-30 抗短连加固 A）：fetch 与 res.json() **整体**放进 withRetry 重试圈。
// 旧形态的缺口：fetchChatCompletion 只包到「响应头到达」，调用方随后的 res.json() 在圈外——
// 头 200 但响应体下载中断（TypeError: terminated / unexpected end of data 等）会直接炸穿调用方，
// 且这次失败不享受任何重试。本函数：非 2xx 处理沿用 fetchChatCompletion 的 !res.ok 分支（读 text、
// status、retryAfter、抛同款 Error）；res.json() 抛错（下载中断）打 e.__transport = true 再抛，
// 由 isRetryableError 的 __transport 分支判可重试。台账语义不变：网关内重试不加行（每次逻辑调用一行）。
async function postChatJson({ baseUrl, apiKey, body, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`; // 免费渠道（无 Key）不携带 Authorization 头
  return withRetry(async () => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; const e = new Error('request timeout'); e.__timeout = true; ac.abort(e); }, timeoutMs);
    // 外部 signal 全程桥接到内部 ac；透传 reason
    const onExternalAbort = () => ac.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); const e = new Error('aborted by caller'); e.__userAbort = true; throw e; }
      signal.addEventListener('abort', onExternalAbort);
    }
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(applyThinkingMode(body)), signal: ac.signal,
      });
      clearTimeout(timer); // 响应头到达：清除超时
      if (!res.ok) {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        const text = await res.text();
        const e = new Error(`LLM 请求失败 ${res.status}: ${text.slice(0, 300)}`);
        e.status = res.status;
        const ra = parseRetryAfterHeader(res.headers);
        if (ra != null) e.retryAfter = ra;
        throw e;
      }
      // 响应体读取也在重试圈内：下载中断（通常 TypeError）标注 __transport（传输类，可重试）
      let data;
      try {
        data = await res.json();
      } catch (e) {
        if (e && typeof e === 'object') e.__transport = true;
        throw e;
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (timedOut && err && typeof err === 'object') err.__timeout = true;
      else if (signal && signal.aborted && err && typeof err === 'object') err.__userAbort = true;
      throw err;
    }
  }, { retries: RETRY_MAX_ATTEMPTS - 1, baseDelay: RETRY_BASE_DELAY_MS, maxDelay: RETRY_MAX_DELAY_MS, signal });
}

// ---------------- 流式 SSE 终结校验（M1：对齐 pi openai-completions.ts:680-688） ----------------
// 构造「过早断流」错误：SSE 流自然读到底却从未收到 finish_reason。pi 把它归入可重试传输类
// （retry.ts:26-90 的 'ended without' 系正则）——上层可直接交给 withRetry 整轮重发。
function prematureStreamError(detail) {
  const e = new Error('stream ended without finish_reason' + (detail ? `（${detail}）` : ''));
  e.__prematureStream = true;
  return e;
}

// 读取 OpenAI 兼容 SSE 流并做 pi 式终结校验（chat.js readSseStream 的 llm.js 正典版，供流式管线接入）：
//  - 逐 data: 行解析 JSON，回调 onEvent(json, choice)；捕获最后一个 usage 与 finish_reason
//  - stall 看门狗：stallMs 内无新数据 → 主动 cancel 读端并抛「stream stalled」错误（可重试传输类）
//  - 外部 signal 中止 → 抛带 __userAbort 标注的原因（不可重试，语义与 fetchChatCompletion 一致）
//  - 正常读到底却没有 finish_reason → 抛 prematureStreamError（可重试，对齐 pi 断流检测）
// 返回 { finishReason, usage }。注意：本函数不做重试——重试决策统一在 withRetry 层（pi 分层同款）。
async function readChatSSEStream(res, onEvent, { stallMs = STREAM_STALL_TIMEOUT_MS, signal } = {}) {
  if (!res || !res.body || typeof res.body.getReader !== 'function') {
    throw prematureStreamError('响应没有可读的流式 body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let finishReason = '';
  let usage = null;
  let buffer = '';
  let stallTimer = null;
  let interrupted = null; // 非自然结束的原因（stall / 外部 abort），读循环退出后统一抛出
  const stopFor = (err) => {
    if (!interrupted) interrupted = err;
    // M3 加固：cancel() 返回的 promise 在「外部 abort 与流错误竞态」下会以流错误 reject
    //（undici body 实测），同步 try/catch 接不住——必须吞掉，否则产生未处理 rejection
    try { reader.cancel().catch(() => { /* abort 竞态：流已在关闭/出错，无需处理 */ }); } catch { /* 流已结束 */ }
  };
  const resetStall = () => {
    if (!stallMs) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stopFor(new Error(`stream stalled: ${stallMs}ms 内无数据`));
    }, stallMs);
  };
  const onExternalAbort = () => {
    let reason = (signal && signal.reason) || new Error('aborted by caller');
    if (reason && typeof reason === 'object') reason.__userAbort = true;
    stopFor(reason);
  };
  const handleLine = (t) => {
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      if (json.usage) usage = json.usage;
      const choice = (json.choices && json.choices[0]) || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (onEvent) onEvent(json, choice);
    } catch { /* 半包/非 JSON 行忽略（与 chat.js readSseStream 口径一致） */ }
  };
  if (signal && signal.aborted) onExternalAbort();
  else if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  try {
    resetStall();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line.trim()); // trim 兼容 CRLF 行尾
      }
    }
    buffer += decoder.decode();       // 冲洗 UTF-8 尾字节
    if (buffer.trim()) handleLine(buffer.trim()); // 上游最后一行可能不带换行
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
  if (interrupted) throw interrupted;
  if (!finishReason) throw prematureStreamError('流已结束');
  return { finishReason, usage };
}

// ---------------- 空输出契约（S5-03 / R02） ----------------
// 事实源：docs/report/20260921_全系统闭环审查/00-系统稳定性结论.md:149-156 ——原 E2E 记录
//   「[drift] 检查失败: LLM 返回内容为空（可能是 max_tokens 被推理占用，请重试）」
// 并明确：空输出确实发生；「推理吃完预算」只是那句错误提示里的**假设**。旧实现把空正文硬编码成
// 一条无 code、无 usage、无 finish_reason 的通用 Error，于是调用点分不清「上游失败」与
// 「无偏离/无结果」，台账也无法事后定性。
// 本契约（两侧同源）：
//   · 空正文 = 去空白后为空（含全空白、仅 reasoning 的响应），一律抛 code=LLM_EMPTY_OUTPUT；
//   · 错误携带上游原样证据（finish_reason / usage），随 llm_calls 一并落台账，供报告区分成因；
//   · 绝不记录凭证（证据只含 token 数与 finish_reason，不含 headers/key/base_url 之外的任何凭据）；
//   · 「推理占用预算」只在 finish_reason=length 且有 reasoning_tokens 证据时作为 hypothesis 暴露，
//     永不当成已确认根因；没有证据就不给成因定性。
const EMPTY_OUTPUT_CODE = 'LLM_EMPTY_OUTPUT';

function isEmptyModelOutput(content) {
  return !String(content == null ? '' : content).trim();
}

// 上游证据（原样，不含凭证）
function collectOutputEvidence({ content, reasoning, finishReason, usage }) {
  const u = usage || {};
  const details = u.completion_tokens_details || {};
  return {
    finishReason: finishReason || '',
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    reasoningTokens: Number(details.reasoning_tokens) || 0,
    contentChars: String(content == null ? '' : content).length,
    reasoningChars: String(reasoning == null ? '' : reasoning).length,
  };
}

// 成因**假设**（不是根因）：只有拿到上游证据才给，供作者与报告区分「同样报空输出」的不同情况
function emptyOutputHypothesis(evidence) {
  const ev = evidence || {};
  return ev.finishReason === 'length' && Number(ev.reasoningTokens) > 0
    ? 'budget_consumed_by_reasoning'
    : null;
}

function emptyOutputError(evidence) {
  const ev = evidence;
  const err = new Error(
    `LLM 返回空正文（${EMPTY_OUTPUT_CODE}：finish_reason=${ev.finishReason || '未提供'}，`
    + `completion_tokens=${ev.completionTokens}，reasoning_tokens=${ev.reasoningTokens}）`
  );
  err.code = EMPTY_OUTPUT_CODE;
  err.evidence = ev;
  return err;
}

// ---------------- usage 锚点估算（M1：收敛 W17 双轨制） ----------------
// 会话占用的 usage 锚点估算（DB 感知包装）：优先取台账中该书最近一次带真实 usage 的调用做锚点
//（pi estimate.ts:63-103——前段用 provider 真实计费，仅锚点后增量走 chars/4）；
// 无台账记录 / 无有效 usage 时 anchored:false，由 contextBudget 退化为 CJK 全量估算（现状兜底行为）。
function sessionUsageEstimate(bookId, messages) {
  const row = llmCallLog.lastWithUsage(bookId);
  return contextBudget.estimateContextUsage(messages, row && {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
  });
}

// 完整调用：返回 { content, reasoning }；opts.meta = { bookId, scope } 供调用台账落库（对齐 Codex CLI 每次调用记 token_count 事件）
async function callLLMFull(messages, { maxTokens = 4000, temperature = 0.7, signal, meta } = {}) {
  const { baseUrl, apiKey, model } = llmConfig();
  const t0 = Date.now();
  const logBase = { bookId: meta && meta.bookId, scope: (meta && meta.scope) || 'llm', model, baseUrl, outputReserve: maxTokens };
  try {
    // 传输抖动/超时由 postChatJson 统一重试（2026-09-30 抗短连：res.json() 响应体读取一并入圈）；
    // 空正文按 R02 空输出契约显式失败（不在这里重发）
    const data = await postChatJson({
      baseUrl, apiKey, signal, timeoutMs: REQUEST_TIMEOUT_MS,
      body: { model, messages, max_tokens: maxTokens, temperature },
    });
    const choice = (data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const usage = data.usage || {};
    if (isEmptyModelOutput(msg.content)) {
      throw emptyOutputError(collectOutputEvidence({
        content: msg.content, reasoning: msg.reasoning_content, finishReason: choice.finish_reason, usage,
      }));
    }
    llmCallLog.record({
      ...logBase,
      promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
      cacheHitTokens: usage.prompt_cache_hit_tokens, cacheMissTokens: usage.prompt_cache_miss_tokens,
      reasoningTokens: usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens,
      finishReason: choice.finish_reason, status: 'ok', durationMs: Date.now() - t0,
    });
    return { content: msg.content, reasoning: msg.reasoning_content || '' };
  } catch (e) {
    // 失败也落台账：空输出带上游证据（旧实现只记错误文本，事后无法区分成因）
    const ev = (e && e.evidence) || null;
    llmCallLog.record({
      ...logBase,
      promptTokens: ev && ev.promptTokens, completionTokens: ev && ev.completionTokens,
      reasoningTokens: ev && ev.reasoningTokens, finishReason: ev && ev.finishReason,
      status: 'error', error: String((e && e.message) || e).slice(0, 300), durationMs: Date.now() - t0,
    });
    throw e;
  }
}

// 兼容调用：只返回正文字符串
async function callLLM(messages, opts) {
  const { content } = await callLLMFull(messages, opts);
  return content;
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n……（后文略）' : text;
}

// 默认上下文窗口 256K：仅当「渠道官方报告」与「用户设置」都缺失时作为系统默认值（UI 明示为默认，绝不冒充官方）
const DEFAULT_CONTEXT_WINDOW = 256000;

// A7（第二轮重审查）：手动 context_window 钳制区间。
// 此前无上界：1e9 会被算出近 10 亿 systemBudget 全量注入；无下界：100 必然上游报错且面板无告警。
// 越界值统一夹进区间并打日志（设置页经 contextWindowInfo 的 note 告知用户）。
const CONTEXT_WINDOW_MIN = 4096;
const CONTEXT_WINDOW_MAX = 2000000;
function clampContextWindow(value, { log = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < CONTEXT_WINDOW_MIN) {
    if (log) console.warn(`[llm] context_window=${n} 低于下限，钳制为 ${CONTEXT_WINDOW_MIN}`);
    return CONTEXT_WINDOW_MIN;
  }
  if (n > CONTEXT_WINDOW_MAX) {
    if (log) console.warn(`[llm] context_window=${n} 超过上限，钳制为 ${CONTEXT_WINDOW_MAX}`);
    return CONTEXT_WINDOW_MAX;
  }
  return Math.floor(n);
}

// 解析上下文窗口（信息源优先级：渠道 /models 官方报告 → 用户手动设置 → 系统默认）：
//   - 官方有且手动有 → min(手动, 官方)（官方上限是硬约束）
//   - 官方无（渠道未报告）且手动有 → 手动（用户设置是第二信息源，原样生效）
//   - 官方有且无手动 → 官方
//   - 都无 → DEFAULT_CONTEXT_WINDOW
function resolveContextWindow(model) {
  const official = modelInfo.getOfficialContextWindow(model);
  const row = db.get('SELECT value FROM settings WHERE key = ?', ['context_window']);
  const manualRaw = row && String(row.value).trim();
  const manual = clampContextWindow(manualRaw); // A7：越界夹取 + 日志
  const officialClamped = official ? clampContextWindow(official, { log: false }) : null;
  if (officialClamped && manual) return Math.min(manual, officialClamped);
  if (manual) return manual;
  if (officialClamped) return officialClamped;
  return DEFAULT_CONTEXT_WINDOW;
}

// 上下文窗口透明化信息（设置页/仪表面板用）：显式给出「用户设置值 / 渠道官方报告 / 来源状态 / 是否被钳制」，
// 避免「设置里改了却不生效」的困惑——被钳制或官方缺失时 UI 必须说明原因
function contextWindowInfo(model) {
  const oi = modelInfo.officialInfo(model);
  const row = db.get('SELECT value FROM settings WHERE key = ?', ['context_window']);
  const manualRaw = row && String(row.value).trim();
  const manual = manualRaw && Number(manualRaw) > 0 ? Number(manualRaw) : null;
  const effective = resolveContextWindow(model);
  const clamped = !!(manual && oi.official && manual > oi.official);
  const clampedByLimit = !!(manual && ((manual < CONTEXT_WINDOW_MIN && effective === CONTEXT_WINDOW_MIN) || (manual > CONTEXT_WINDOW_MAX && effective === CONTEXT_WINDOW_MAX)));
  const manualAuthoritative = !!(manual && !oi.official && !clampedByLimit);
  let note = '';
  if (clamped) {
    note = '你设置的 ' + manual + ' 超过渠道 /models 报告的上限 ' + oi.official + '，生效值被钳制为 ' + oi.official;
  } else if (clampedByLimit) {
    note = manual < CONTEXT_WINDOW_MIN
      ? '你设置的 ' + manual + ' 低于下限 ' + CONTEXT_WINDOW_MIN + '（必然超出窗口报错），生效值被抬升为 ' + CONTEXT_WINDOW_MIN
      : '你设置的 ' + manual + ' 超过系统上限 ' + CONTEXT_WINDOW_MAX + '，生效值被钳制为 ' + CONTEXT_WINDOW_MAX;
  } else if (manualAuthoritative) {
    note = oi.source === 'not_fetched'
      ? '渠道上下文上限尚未拉取（后台自动拉取中），暂按你设置的 ' + manual + ' 生效'
      : '渠道 /models 未报告上下文上限（官方缺失），按你设置的 ' + manual + ' 原样生效';
  }
  return { effective, manual, official: oi.official, officialSource: oi.source, fetchedAt: oi.fetchedAt, clamped, manualAuthoritative, note };
}

// 系统提示整体 token 预算：模型窗口 − 预留（给历史+用户输入+输出留空间）。
//
// 2026-09-11 对齐 pi 的取舍（pi-ref packages/agent/src/harness/compaction/compaction.ts:147-162）：
// pi 给系统提示词**不设任何预算、永不裁剪**，溢出压力全部交给可再生的部分（历史消息压缩）承担。
// 本项目照此方向修正——系统提示词是作者最重的表达载体（完整风格手册级别），
// 不该是预算紧张时最先被牺牲掉的一节。
//
// 下限 FLOOR 的取法（不是拍脑袋）：委托方要求「系统提示词必须容纳 15000 汉字」。
// 本项目 estimateTokens 对 CJK 按 0.7 token/字估，15000 汉字 ≈ 10500 token，
// 取 12000 留出其余 provider（世界观/人物/前情记忆等）的余量。
// 但下限永不越过窗口本身——外面套 min(win − 1024, ...) 兜住：窗口只有 8000 时，
// 谎报 12000 的预算会让超窗的提示词真发出去，那是把「写不进去」换成「上游直接报错」，更糟。
const SYSTEM_PROMPT_RESERVE_TOKENS = 4096;
const SYSTEM_PROMPT_BUDGET_FLOOR = 12000;
const SYSTEM_PROMPT_WINDOW_GUARD = 1024;
function systemPromptTokenBudget() {
  const win = resolveContextWindow(llmConfig().model);
  return Math.min(
    win - SYSTEM_PROMPT_WINDOW_GUARD,
    Math.max(SYSTEM_PROMPT_BUDGET_FLOOR, win - SYSTEM_PROMPT_RESERVE_TOKENS)
  );
}

// 单次回复的输出 token 上限（max_tokens）：
// 推理模型（如 agnes-2.5-flash）的 max_tokens 需同时覆盖 reasoning_content + content，
// 写「3000 字章节」时正文(≈2.3k tokens)+推理(可达数千)会突破旧的固定 4000 上限而被 length 截断。
// 按模型窗口给足输出空间，夹在 [4096, 16000]（16000 为各网关普遍接受的安全输出上限）。
const OUTPUT_TOKEN_FLOOR = 4096;
const OUTPUT_TOKEN_CEIL = 16000;
function outputTokenBudget(model) {
  const win = resolveContextWindow(model);
  return Math.min(OUTPUT_TOKEN_CEIL, Math.max(OUTPUT_TOKEN_FLOOR, Math.floor(win / 8)));
}

// 组装防漂移系统提示词（管道式 Provider 架构）；query 供语义召回 Provider 使用
async function buildSystemPrompt(book, chapterId, query) {
  return context.assemble({ book, chapterId, db, query, systemTokenBudget: systemPromptTokenBudget() });
}

// 组装完整消息列表：系统提示 + 最近对话历史 + 本次用户输入
// 返回 { messages, retrieval }：retrieval 为本次语义召回的旧文片段（供 UI 展示 AI 参考了什么）
//
// 长对话防「遗忘系统提示词」三件套：
// 1. 历史限量：只带最近 12 条（原 20 条，长正文回复会把系统提示淹没）
// 2. 历史瘦身：较早的长回复截断到 300 字（正文已入章节，全文留在历史里只会稀释指令权重）
// 3. 尾部提醒：重申核心准则的短提醒**并入 user 消息末尾**（近因效应）。
//    注意：绝不作为独立 system 消息插在 user 之后——那会在工具循环中产生
//    [.. user, system, assistant(tool_calls), tool ..] 的非法序列，上游可能 400，
//    且会把模型注意力从用户请求上拉走（对齐 pi：system 只在首条）
// 历史瘦身的截断标记（对齐 pi：截断必须显式标注剩余量，且标记要用**机器样式**）。
// 2026-09-10 实测教训：旧标记「……（较早内容略）」是正文句式，同一次请求里出现 2 次后，
// 模型照着造了镜像版「（较晚内容略）」当作自己正文的收尾——写出 3204 字就停笔，
// finish_reason=stop，续写兜底不触发，那一章一个字都没落库。
// 现改为带方括号与字数的机器文本，模型不会把它当成叙事句式模仿。
// 注意：llm.js 与 routes/chat.js 的估算口径必须一致（A-13），两边共用本函数，勿各写各的。
const HISTORY_OLD_MAX_CHARS = 300;
function trimHistoryText(text, maxChars = HISTORY_OLD_MAX_CHARS) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n[... 前文另有 ${s.length - maxChars} 字已省略]`;
}

// S3-03：历史与工具事实按会话取（conversationId 由 chat 路由解析后传入）；null 为
// 防御兜底（按书取，等价旧行为）——生产路径的列表/stream/压缩估算全部先解析会话再进来，
// 避免「压缩估算与实际发送用两份历史口径」（A-13 原则在会话维度延续）。
async function buildChatMessages(book, userContent, chapterId, historyLimit = 12, conversationId = null) {
  const history = conversationId
    ? db.all(
        'SELECT role, content FROM messages WHERE conversation_id = ? AND COALESCE(compressed, 0) != 1 ORDER BY id DESC LIMIT ?',
        [conversationId, historyLimit]
      ).reverse()
    : db.all(
        'SELECT role, content FROM messages WHERE book_id = ? AND COALESCE(compressed, 0) != 1 ORDER BY id DESC LIMIT ?',
        [book.id, historyLimit]
      ).reverse();
  const ctx = { book, chapterId, db, query: userContent, systemTokenBudget: systemPromptTokenBudget() };
  // 用 assembleDetailed：逐 Provider 组装层计量随请求返回，供调用台账落库（parts_json）与校准细分
  const assembled = await context.assembleDetailed(ctx);
  const factRows = conversationId
    ? db.all('SELECT tools_json FROM messages WHERE conversation_id = ? AND tools_json IS NOT NULL ORDER BY id DESC LIMIT 12', [conversationId]).reverse()
    : db.all('SELECT tools_json FROM messages WHERE book_id = ? AND tools_json IS NOT NULL ORDER BY id DESC LIMIT 12', [book.id]).reverse();
  const toolHistory = require('./chat/tool-history').historyFacts(factRows, book.id, ctx.narrativeScope);
  const system = assembled.text + (toolHistory ? '\n<tool_history>\n' + context.escapeXml(toolHistory) + '\n</tool_history>' : '');

  // 最近 4 条保留全文，更早的长消息截断（标记样式见 trimHistoryText）
  const trimmed = history.map((m, i) => {
    const isRecent = i >= history.length - 4;
    const content = isRecent ? m.content : trimHistoryText(m.content);
    return { role: m.role, content };
  });

  const reminder = '\n\n（创作提醒：严格遵守最上方系统提示的全部准则——遵循世界观与人物卡设定、与前情记忆保持连贯、文风统一；'
    + (book.mode === 'direct'
      ? '作者要求续写时直接输出正文，不要附加解释。）'
      : '拿不准的地方必须按【需要确认】格式停下询问；作者要求续写时直接输出正文，不要附加解释。）');

  return {
    messages: [
      { role: 'system', content: system },
      ...trimmed,
      { role: 'user', content: userContent + reminder },
    ],
    retrieval: ctx.retrievalHits || [],
    parts: assembled.parts || [],
    writingTarget: ctx.writingTarget,
  };
}

// 生成章节总结
async function summarizeChapter(chapter) {
  return callLLM([
    { role: 'system', content: '你是小说编辑。为给定章节写剧情总结，要求：150字以内，涵盖关键事件、人物状态变化、未解决的悬念；只输出总结正文。' },
    { role: 'user', content: `章节标题：《${chapter.title}》\n\n章节内容：\n${truncate(chapter.content, 8000)}` },
  ], { maxTokens: 1000, temperature: 0.3, meta: { bookId: chapter.book_id, scope: 'summarize' } });
}

// 章总结后自动维护状态簿：人物状态 / 未回收伏笔 / 全书进展摘要
function parseSections(text) {
  const out = {};
  const re = /【(人物状态|未回收伏笔|全书进展摘要)】\s*([\s\S]*?)(?=【(?:人物状态|未回收伏笔|全书进展摘要)】|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = m[2].trim();
  return out;
}

async function updateStoryState(book, chapter, summary) {
  const prev = {};
  for (const row of db.all('SELECT kind, content FROM story_state WHERE book_id = ?', [book.id])) {
    prev[row.kind] = row.content;
  }
  const reply = await callLLM([
    { role: 'system', content: `你是长篇小说的设定管理员。根据旧状态簿和最新章节，输出更新后的状态簿。严格按以下三个板块输出（每个板块单独一段，标题用【】括起）：
【人物状态】主要人物的当前位置/身体状态/关系变化/关键持有物，每人一行；无变化的人物保留原描述。
【未回收伏笔】已埋下但尚未回收的伏笔/悬念列表，每条一行；本章已回收的删除，新增的补上。
【全书进展摘要】用不超过300字概括故事到目前为止的整体进展（滚动更新，不是本章总结）。
只输出这三个板块，不要其他内容。` },
    { role: 'user', content:
      `【旧·人物状态】\n${prev.characters || '（空）'}\n\n【旧·未回收伏笔】\n${prev.foreshadowing || '（空）'}\n\n【旧·全书进展摘要】\n${prev.book_summary || '（空）'}\n\n【最新章节】\n《${chapter.title}》\n总结：${summary}\n\n章节内容（节选）：\n${truncate(chapter.content, 3000)}` },
  ], { maxTokens: 3000, temperature: 0.3, meta: { bookId: book.id, scope: 'story-state' } });

  const sections = parseSections(reply);
  const KIND_MAP = { '人物状态': 'characters', '未回收伏笔': 'foreshadowing', '全书进展摘要': 'book_summary' };
  // A10：story_state.updated_at 用 SQL localtime（与 DDL 默认、chapters/books 同格式），
  // 不再用 toISOString()（UTC 带 T/Z），避免同列混排两种格式导致字符串排序错序。
  for (const [label, kind] of Object.entries(KIND_MAP)) {
    if (!sections[label]) continue;
    db.run(
      'INSERT INTO story_state (book_id, kind, content, updated_at) VALUES (?, ?, ?, datetime(\'now\',\'localtime\')) ON CONFLICT(book_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
      [book.id, kind, sections[label]]
    );
  }
  // 自动路径写入的 book_summary 同样刷新底料指纹（4.1 书层传播；此函数当前无调用方，属预留路径）
  if (sections['全书进展摘要']) {
    require('./domain/chapterLifecycle').refreshBookSummaryFingerprint(book.id);
  }
}

// 偏离检测：章节总结 vs 大纲 → { status: 'ok'|'minor'|'major', note }
// 无大纲返回 null（未检测）；失败抛错（由 checkDriftResult 分类，见下）。
//
// S5-03 / R02：空输出允许**最多一次**受控重试——唯一的策略变化是把分析输出预算加倍
// （800 → 1600；非思考设置在 settings.disable_thinking_models 命中时由 applyThinkingMode
// 对两次调用一致下发）。不换模型、不改温度与提示词、不无上限重发；解析类失败与传输类
// 失败（后者已由 fetchChatCompletion 的网关重试覆盖）都不在这里再发。重试还受两层约束：
//   · 调用方 signal（run 取消/断连）——透传到 fetchChatCompletion，取消后一次都不发；
//   · maxDurationMs 单次分析总时限——首次调用耗时已超上限就不再重试。
const DRIFT_OUTPUT_BUDGET = 800;
const DRIFT_RETRY_OUTPUT_BUDGET = 1600;
const DRIFT_MAX_DURATION_MS = 120000;

function attachAttempts(err, attempts) {
  if (err && typeof err === 'object' && err.attempts === undefined) err.attempts = attempts;
  return err;
}

async function checkDrift(book, chapter, opts = {}) {
  const { signal = null, maxDurationMs = DRIFT_MAX_DURATION_MS } = opts || {};
  const vol = chapter.volume_id
    ? db.get('SELECT * FROM volumes WHERE id = ?', [chapter.volume_id])
    : null;
  const outlines = [];
  if (book.master_outline && book.master_outline.trim()) outlines.push('【全书总纲】\n' + book.master_outline.trim());
  if (vol && vol.outline && vol.outline.trim()) outlines.push(`【本卷《${vol.title}》大纲】\n` + vol.outline.trim());
  if (!outlines.length) return null; // 没有大纲不检测

  const messages = [
    { role: 'system', content: `你是小说大纲监督员。对照大纲检查章节剧情是否偏离。
只判断当前章节是否与大纲已有约束冲突；尚未发生的后续卷内事件不等于偏离。
第一行必须精确输出以下三个词之一：符合 / 轻度偏离 / 严重偏离，不要使用“不符合”或其他说法。
第二行起输出100字以内说明：偏离点+修正建议；若符合则简述与大纲的对应关系。` },
    { role: 'user', content: `${outlines.join('\n\n')}\n\n【待检章节】\n《${chapter.title}》\n总结：${chapter.summary}\n\n内容节选：\n${truncate(chapter.content, 2000)}` },
  ];

  const t0 = Date.now();
  const attempts = [];   // 每次调用的原始证据（含受控重试的预算变化），随失败结果一并暴露
  let attempt = 0;
  let reply = '';
  for (;;) {
    attempt++;
    const maxTokens = attempt === 1 ? DRIFT_OUTPUT_BUDGET : DRIFT_RETRY_OUTPUT_BUDGET;
    try {
      reply = await callLLM(messages, { maxTokens, temperature: 0.2, signal, meta: { bookId: book.id, scope: 'drift-check' } });
      break;
    } catch (err) {
      const ev = (err && err.evidence) || null;
      attempts.push({
        attempt,
        maxTokens,
        finishReason: (ev && ev.finishReason) || '',
        usage: {
          promptTokens: Number(ev && ev.promptTokens) || 0,
          completionTokens: Number(ev && ev.completionTokens) || 0,
          reasoningTokens: Number(ev && ev.reasoningTokens) || 0,
        },
        hypothesis: emptyOutputHypothesis(ev),
      });
      const canRetry = attempt === 1
        && err && err.code === EMPTY_OUTPUT_CODE
        && !(signal && signal.aborted)
        && (Date.now() - t0) < maxDurationMs;
      if (!canRetry) throw attachAttempts(err, attempts);
    }
  }

  const firstLine = reply.split('\n')[0].trim();
  const status = new Map([['符合', 'ok'], ['轻度偏离', 'minor'], ['严重偏离', 'major']]).get(firstLine);
  if (!status) {
    const error = new Error('偏离检测未返回有效结论，不能判定为符合，请重试');
    error.code = 'DRIFT_VERDICT_INVALID';
    throw attachAttempts(error, attempts);
  }
  const note = reply.split('\n').slice(1).join('\n').trim() || firstLine;
  return { status, note };
}

// 偏离检查结果分类（REST 与工具同源的唯一出口）：
//   · 成功 → { status: ok|minor|major, note }
//   · 无大纲 → null（未检测，不写任何偏离状态）
//   · 失败 → status:'failed' + code + 上游证据（finishReason/usage/attempts/hypothesis）
// 空输出与解析失败都走 failed——不返回 null、不抛通用异常给模型、也不写成「无偏离」。
function driftFailureOutcome(err) {
  const list = (err && Array.isArray(err.attempts) && err.attempts.length)
    ? err.attempts
    : [{
      attempt: 1, maxTokens: null, finishReason: '',
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, hypothesis: null,
    }];
  const last = list[list.length - 1];
  return {
    status: 'failed',
    code: (err && err.code) || 'DRIFT_CHECK_FAILED',
    note: String((err && err.message) || err),
    finishReason: last.finishReason,
    usage: last.usage,
    hypothesis: last.hypothesis,
    attempts: list,
  };
}

async function checkDriftResult(book, chapter, opts = {}) {
  try {
    return await checkDrift(book, chapter, opts);
  } catch (err) {
    return driftFailureOutcome(err);
  }
}

// 参谋模式：只出方案不写正文；返回附带 retrieval（本次召回的旧文片段）
async function consult(book, question, chapterId) {
  const ctx = { book, chapterId, db, query: question, systemTokenBudget: systemPromptTokenBudget() };
  const systemContext = await context.assemble(ctx);
  const result = await callLLMFull([
    { role: 'system', content: `${systemContext}

【参谋职责】你是作者的剧情参谋，只出方案和建议，绝不直接输出小说正文。
- 建议剧情走向时：给出2-3个走向方案，每个方案必须包含：核心冲突 / 看点（爽点）/ 风险 / 与大纲的关系。最后给出你的推荐及理由。
- 建议人物行为时：给出2-3个行为选项，每个选项标注人设符合度（高/中/低）及理由，指出哪个最符合人设、哪个最有戏剧性。
- 发现与大纲、设定或前文总结冲突时，必须明确指出。` },
    { role: 'user', content: question },
  ], { maxTokens: 3000, temperature: 0.7, meta: { bookId: book.id, scope: 'consult' } });
  result.retrieval = ctx.retrievalHits || [];
  return result;
}

module.exports = {
  callLLM, callLLMFull, buildChatMessages, buildSystemPrompt, summarizeChapter, updateStoryState,
  checkDrift, checkDriftResult, consult,
  // S5-03/R02：空输出契约（code 单一事实源；调用方/测试按此断言，不另写字面量）
  EMPTY_OUTPUT_CODE, DRIFT_OUTPUT_BUDGET, DRIFT_RETRY_OUTPUT_BUDGET, DRIFT_MAX_DURATION_MS,
  // 历史裁剪口径（chat.js 的 token 估算与真实发送必须同源）
  trimHistoryText, HISTORY_OLD_MAX_CHARS,
  llmConfig, DEFAULT_SYSTEM_PROMPT, DEFAULT_BASE_URL, DEFAULT_MODEL, contextWindowInfo,
  resolveContextWindow, DEFAULT_CONTEXT_WINDOW, outputTokenBudget, systemPromptTokenBudget,
  // 韧性网关（供 chat.js 与测试复用）
  isRetryableError, isNonRetryableLimitError, computeBackoff, withRetry, fetchChatCompletion,
  postChatJson, // A（抗短连 2026-09-30）：非流式 fetch+res.json() 整体重试（调用方：callLLMFull/续写链/followUp 后续轮）
  RETRY_MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS, STREAM_FIRST_BYTE_TIMEOUT_MS,
  // M1：对齐 pi AI 层的四点强化
  parseRetryAfterHeader, RETRY_AFTER_CEILING_MS,   // ④ retry-after 三形态解析 + >60s 上抛
  prematureStreamError, readChatSSEStream,         // ② SSE finish_reason 终结校验（过早断流）
  sessionUsageEstimate,                            // ① usage 锚点估算（DB 包装，纯函数在 contextBudget）
  // A7：窗口钳制
  clampContextWindow, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX,
  // 深度思考开关（默认关闭；单测与设置页共用同一实现）
  applyThinkingMode, thinkingDisabledModel, THINKING_OFF_FIELD, THINKING_OFF_SETTING,
};
