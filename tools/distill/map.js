// L2 结构化 LLM map（作者印记蒸馏第 2 步 / 方案 §3.2 + §3.3 闸门 4）。
//
// 流水线：readCorpus 过滤作者/作品 → 逐文件剔章题 → 按作者词典掩码全文 →
// util.mapChunks 8,000 字滑窗（步长 7,800，含 200 重叠）→ 每块一次 StepFun chat 调用
// （runPool 5 并发池，失败原地重试不放大并发）→ 容错抽 JSON →
// validateObservations 逐条过闸（dim 白名单 / trait ≤80 码点 / evidence 逐字子串 /
// count 正整数 / 专名残留扫描）→ 每块完成后追加一行 JSONL（断点续跑）。
//
// 关键设计（契约，不得自行发挥）：
//  - 输入块是**掩码后**文本：evidence 的比对基准（闸门 4）、count 的统计基准都是掩码文本（§3.1.5）；
//  - 闸门 4 证据包含性检查：LLM 高频行为是微改写与跨段拼接，evidence 必须 indexOf 命中
//    掩码后块文本，不命中即丢该条——全方案性价比最高的一道闸（§3.3）；
//  - 专名残留扫描：掩码后的产出不应再含原作专名，trait/evidence/marker 命中词典即丢
//    （reason='name_leak'，防 LLM 从占位符上下文「复原」专名）；
//  - 续跑：JSONL 落 data/corpus/src-<author>/map/<work>.jsonl，一行一块
//    {chunkIndex, sha256, at, usage, kept, dropped}；启动时读已有行建 chunkIndex→sha256，
//    sha 一致跳过、不一致重跑（后行覆盖前行）；腐败行忽略——其块不在完成集，自动重跑自愈；
//  - 输出 JSONL 是过程文件（供续跑），meta.json 才是就绪标志（§4.1 时序，本层不写 meta）。
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util');
const mask = require('./mask');
const llm = require('./llm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 渠道参数（实测定稿，见 llm.js 头注释；不要改）
// max_tokens=16000：2026-09-12 蔽霄 20 块实测中 4000 全部被思考耗尽（finish_reason=length
// 且 content 空）——StepFun 的 max_tokens 必须覆盖思考+正文；抬到 12000 后 20 块全通过。
// 2026-09-13 全量真机复测「12000 仍不够」：太虚古界块 18 在 12000 下持续失败（思考吃光预算），
// 同一块在 16000 下成功且**思考实耗 12,050 output token**（正文仅 1,144 字）——即该块本就
// 需要 >12000，切分兜底也救不回（切半后单调用思考仍超）。故定稿 16000。
// 注：抬高上限不改变模型行为、不增加已通过块的成本（按实际用量计费），只减少「预算耗尽」失败。
const MODEL = 'step-3.7-flash';
const MAX_TOKENS = 16000;
const REASONING_EFFORT = 'low';
// 单次调用超时（2026-09-13 加）：原为 llm.js 的默认 120s，双线实测证明这个值过紧——
// Agnes 官方线延迟 P90 就有 124s、峰值 145s（见报告 09 §6.6），StepFun 侧也有长尾，
// 结果「请求超时/中止」成了两线合计第一大失败因（20 次）远超真正的内容审查 451（6 次）。
// 抬到 300s（≈2× 峰值延迟）：超时只影响单次尝试，重试仍由 runPool 承担，且槽位被
// 长尾请求占用的代价（c=24 时一个槽 5 分钟）小于整块失败的代价。
const DEFAULT_TIMEOUT_MS = 300000;

// 七维白名单（方案 §3.2 schema）
const DIMS = ['词汇', '句法', '标点', '对话', '描写', '叙事', '修辞'];
const DIM_SET = new Set(DIMS);

// 维度别名表（**离线复核用，生成侧不放宽**）：
// 2026-09-13 全量跑完统计发现，Agnes 官方线会把维度标签写英文（`vocabulary`/`syntax`/…），
// 被白名单判 dim_invalid 丢弃——4 个作者合计 5,406 条观测因此丢失（占总丢弃量约 23%，
// 其中白石 2,440 行、青崖 2,933 行受影响），而观测内容（trait/evidence/count）本身是好的、
// 证据也过闸门 4。这些标签与七个中文维度是**一一对应**的，故在复核阶段按表归一后回收，
// 零 LLM 成本（同 §6.5 的空白复核思路）。入库判据（生成侧）仍只认七个中文标签本身。
//
// 收录标准：该写法在七个维度里**只有一个可能读法**才收。故 `styl`（style？词汇/句法/修辞都能沾）
// 不收——宁可少回收 1 条，也不猜；`sent` 收（sentence 结构只对应「句法」，其余六维都不是它的读法）。
const DIM_ALIASES = {
  vocabulary: '词汇', vocab: '词汇',
  syntax: '句法', sent: '句法', 句式: '句法',
  punctuation: '标点', punc: '标点',
  dialogue: '对话', dial: '对话',
  description: '描写', desc: '描写',
  narrative: '叙事', narration: '叙事', 叙述: '叙事',
  rhetoric: '修辞', rhet: '修辞',
};

/** 归一维度标签：已是白名单原样返回；命中别名表返回中文标签；否则返回 null（仍判 dim_invalid）。 */
function normalizeDim(dim) {
  if (typeof dim !== 'string') return null;
  if (DIM_SET.has(dim)) return dim;
  const hit = DIM_ALIASES[dim.trim().toLowerCase()] || DIM_ALIASES[dim.trim()];
  return hit || null;
}

const TRAIT_MAX_CP = 80; // trait 上限（码点）

// 提示词两处硬约束（2026-09-13 全量跑后补，取证见报告 09 §6.10）：
//  ① dim 原样用七个中文标签——Agnes 渠道会把维度写成英文（vocabulary/syntax/…），
//     入库白名单只认中文标签，实测因此白丢 5,650 条观测（22.2% 的行 kept=0）；
//  ② JSON 字符串内不得出现未转义的双引号——模型引用原文标点/对白时写裸 ASCII 引号，
//     直接让整个响应无法解析（finish_reason=stop 而 content 非法），实测是 JSON 失败类的唯一根因
//     （已核失败块的原文里 ASCII 双引号数为 0，即引号是模型自己写的）。
// 两条都是「契约面」的约束，不改观测语义；离线别名归一（revalidate）仍作为兜底保留。
const SYSTEM_PROMPT = [
  '你是一位文体测量员。阅读给定的小说文本块（作者专名已掩码为占位符〔人名〕〔地名〕〔势力〕〔功法〕），',
  '从中提取可机器复核的写作风格观测。只观察七个维度：词汇、句法、标点、对话、描写、叙事、修辞。',
  '',
  '每条观测是一个 JSON 对象，字段：',
  '- dim：维度，必须原样使用上面七个中文标签之一（不要翻译成英文，不要写 vocabulary/syntax/punctuation 等）',
  `- trait：不超过 ${TRAIT_MAX_CP} 字的具体特质，必须可证伪——能被计数、统计或找到反例`,
  '- evidence：原文逐字引用——从给定文本块中连续复制一段原文（禁止改写、禁止跨段拼接、禁止增删或改写标点），比对基准就是给你的这份文本本身',
  '- count：该特质在本块中的出现次数（正整数）',
  '- marker：（可选）可用于机器计数的标记，如反复出现的词、标点或句式开头',
  '',
  '硬约束：',
  '1. evidence 必须逐字出自给定文本块，一字不差（含标点与占位符），提交前自行回查核对。',
  '2. 禁止情节摘要：只描述「怎么写」（用词、句式、节奏、标点习惯），不描述「写了什么」（人物、事件、设定）。',
  '3. 禁止「文笔优美」「语言生动」「描写细腻」这类不可证伪的空话表述。',
  '4. 每条必须给出 count；能给出机器可计数 marker 的尽量给 marker。',
  '5. 宁少勿凑：没有把握的维度返回空数组；本块无某维度特征时不要编造条目。',
  '6. 输出必须是合法 JSON：字符串内部**不得出现未转义的双引号**。需要引用原文里的标点或对白时，',
  '   要么整段抄进 evidence 字段（原文用的是中文引号「」“”，照抄即可），要么改用中文引号/去掉引号；',
  '   绝不要在 trait/marker 等字段里写 ASCII 直引号（如 "！" 或 "给我！"），否则整个响应会解析失败。',
  '',
  '输出格式：只输出一个 JSON 对象 {"observations":[...]}。',
  '不要 markdown 代码块，不要解释文字，不要输出任何其他内容。',
  '若本块没有任何维度特征，输出 {"observations":[]}。',
].join('\n');

/** 用户消息：块文本 + 简短任务说明（掩码契约提示在系统消息，这里只做框界）。 */
function buildUserPrompt(chunkText, author) {
  return [
    `【作者】${author}（文本中专名已掩码为占位符）`,
    '【任务】阅读下面的文本块，按系统指令提取写作风格观测。',
    '====== 文本块开始 ======',
    String(chunkText || ''),
    '====== 文本块结束 ======',
    '现在只输出 {"observations":[...]} 这一个 JSON 对象。',
  ].join('\n');
}

/** 容错提取 JSON：剥 ```json 围栏 → 截取首个 { 到最后一个 } → JSON.parse；失败返回 null。 */
function extractJson(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** 去净空白（含全角空格/换行/制表）：空白不敏感复核的比对基准。 */
function stripWhitespace(s) {
  return String(s == null ? '' : s).replace(/[\s\u3000]+/g, '');
}

/**
 * 逐条校验（闸门 4 + schema 约束 + 专名残留扫描）。
 * parsed 接受 {"observations":[...]} 或直接数组；chunkText 必须是**掩码后**块文本。
 * 返回 { kept: [...], dropped: [{item, reason}] }。
 * reason ∈ shape_invalid | dim_invalid | trait_invalid | evidence_not_substring(闸门4) |
 *          count_invalid | name_leak
 *
 * opts.ignoreWhitespace（默认 false，离线复核用）：evidence 命中判据放宽为「去净空白后子串」。
 *   动机（2026-09-13 实测，报告 09 §6.5）：闸门 4 的失配里有 30.6%~50.7%（逐作者不同）是
 *   **纯空白差异**——模型把原文的「。 」单空格与「\n　　」缩进规范化掉，内容逐字无误。
 *   放宽后仍拦得住跨段拼接/改写（其间隔含非空白字符）。命中的条目标 relaxed:'whitespace' 留痕，
 *   使严格口径可从数据重建（保留项是严格口径的真超集）。
 * opts.normalizeDims（默认 false，离线复核用）：维度标签先过 DIM_ALIASES 归一（英文/缩写/近义词
 *   → 七个中文标签）。动机见 DIM_ALIASES 注释。命中的条目标 relaxed:'dim'（两者都命中 = 'whitespace+dim'）。
 */
function validateObservations(parsed, chunkText, dict, opts = {}) {
  const src = String(chunkText == null ? '' : chunkText);
  const relaxedOn = opts.ignoreWhitespace === true;
  const dimsOn = opts.normalizeDims === true;
  const srcFlat = relaxedOn ? stripWhitespace(src) : null;
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.observations)) ? parsed.observations : [];
  const kept = [];
  const dropped = [];
  for (const raw of list) {
    let relaxed = false;      // 空白不敏感才命中的标记
    let dimNormalized = false; // 维度标签走了别名表的标记
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped.push({ item: raw, reason: 'shape_invalid' });
      continue;
    }
    const rawDim = raw.dim;
    // 归一必须先于白名单判定（否则英文标签的条目在这里就被丢了，后面的证据检查根本没机会跑）
    const dim = dimsOn ? normalizeDim(rawDim) : (DIM_SET.has(rawDim) ? rawDim : null);
    if (dim === null) {
      dropped.push({ item: raw, reason: 'dim_invalid' });
      continue;
    }
    dimNormalized = dim !== rawDim;
    const trait = typeof raw.trait === 'string' ? raw.trait.trim() : '';
    if (!trait || util.codePoints(trait) > TRAIT_MAX_CP) {
      dropped.push({ item: raw, reason: 'trait_invalid' });
      continue;
    }
    // 只剪首尾空白（引号外多余的换行/空格），内容本身必须逐字命中（闸门 4）
    const evidence = typeof raw.evidence === 'string'
      ? raw.evidence.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
      : '';
    if (!evidence || src.indexOf(evidence) === -1) {
      const wsHit = evidence && srcFlat !== null && srcFlat.indexOf(stripWhitespace(evidence)) !== -1;
      if (!wsHit) {
        dropped.push({ item: raw, reason: 'evidence_not_substring' });
        continue;
      }
      relaxed = true;   // 仅空白差异：放行但留痕
    }
    if (!Number.isInteger(raw.count) || raw.count < 1) {
      dropped.push({ item: raw, reason: 'count_invalid' });
      continue;
    }
    if (dict) {
      // 掩码后的产出不应再含原作专名（trait/marker 是模型自由书写面，evidence 理论上
      // 不可能泄漏——子串命中掩码文本即不可能含完整词条名——仍一并扫，防御调用方传错文本）
      const leak = ['trait', 'evidence', 'marker'].some(
        (f) => typeof raw[f] === 'string' && mask.maskTextByRanges(raw[f], dict).ranges.length > 0
      );
      if (leak) {
        dropped.push({ item: raw, reason: 'name_leak' });
        continue;
      }
    }
    const item = { dim, trait, evidence, count: raw.count };
    if (typeof raw.marker === 'string' && raw.marker.trim()) item.marker = raw.marker.trim();
    // 留痕：为什么这一条在严格口径里不在 kept 里（空白差异 / 维度标签别名 / 两者皆有）
    const tags = [];
    if (relaxed) tags.push('whitespace');
    if (dimNormalized) tags.push('dim');
    if (tags.length) item.relaxed = tags.join('+');
    kept.push(item);
  }
  return { kept, dropped };
}

/**
 * 通用并发池：固定 worker 数（默认 5，委托方硬要求），worker 循环领任务。
 * 单任务失败**原地重试**（重试等待期间持有同一槽位，不放大并发），
 * 默认最多重试 3 次（合计至多 4 次尝试）；等待时长由 nextRetryDelay 决定
 * （确定性错误不重试；服务端 Retry-After 优先；其余指数退避 + jitter）。
 * @param {Array<() => Promise>} tasks
 * @param {{concurrency?: number, retry?: number, baseDelayMs?: number,
 *          onDone?: (index: number, ok: boolean) => void}} [opts]
 * @returns {Promise<Array<{ok: boolean, index: number, value?: any, error?: Error}>>} 与 tasks 同序
 */

/** 重试决策（纯函数，单测免真实等待）：返回下次重试前的等待毫秒数；null = 不重试。
 *  - e.nonRetryable（401/400/length 耗尽等确定性错误）→ 不重试（省下必然失败的重复计费）
 *  - e.retryAfter（服务端 Retry-After，毫秒）→ 优先，夹在 MAX_RETRY_DELAY_MS 内（应对 429 限流）
 *  - 其余（网络/超时/5xx/无头的 429）→ 指数退避 + ±20% jitter（对齐 server/llm.js:94） */
const MAX_RETRY_DELAY_MS = 60000;
function nextRetryDelay(err, attempt, baseDelayMs) {
  if (err && err.nonRetryable) return null;
  const ra = err && Number(err.retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(MAX_RETRY_DELAY_MS, Math.round(ra));
  const exp = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * Math.pow(2, attempt));
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

async function runPool(tasks, opts = {}) {
  const concurrency = Math.max(1, Number.isInteger(opts.concurrency) ? opts.concurrency : 5);
  const retry = Number.isInteger(opts.retry) && opts.retry >= 0 ? opts.retry : 3;
  const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 2000;
  const list = Array.isArray(tasks) ? tasks : [];
  const outcomes = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      let attempt = 0;
      for (;;) {
        try {
          const value = await list[i]();
          outcomes[i] = { ok: true, index: i, value };
          break;
        } catch (e) {
          const delay = attempt >= retry ? null : nextRetryDelay(e, attempt, baseDelayMs);
          if (delay === null) {
            outcomes[i] = { ok: false, index: i, error: e };
            break;
          }
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
        }
      }
      if (typeof opts.onDone === 'function') {
        try { opts.onDone(i, outcomes[i].ok); } catch { /* 进度回调不得中断池 */ }
      }
    }
  };
  const n = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return outcomes;
}

// ---------- runMap ----------

/** 读已有 JSONL 建 chunkIndex → {sha, kept, dropped}（后行覆盖前行；腐败行忽略→该块重跑）。 */
function readDoneMap(outFile) {
  const m = new Map();
  let raw;
  try {
    raw = fs.readFileSync(outFile, 'utf8');
  } catch {
    return m; // 文件不存在 = 全量跑
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || !Number.isInteger(obj.chunkIndex)) continue;
    m.set(obj.chunkIndex, {
      sha: typeof obj.sha256 === 'string' ? obj.sha256 : '',
      kept: Array.isArray(obj.kept) ? obj.kept.length : 0,
      dropped: Array.isArray(obj.dropped) ? obj.dropped.length : 0,
    });
  }
  return m;
}

/** 追加前保证文件以换行结尾（O(1)：只读末字节）。
 *  为什么需要：上次进程若在写一行的中途崩溃，文件尾会留无换行的残片，下次 append 会与残片
 *  拼成一行——该块本轮不在完成集（多一次重复计费），且残片永久留在 JSONL 里。
 *  补一个换行把残片隔离成独立腐败行（readDoneMap 对腐败行本就忽略），新记录完整落行。 */
function ensureTrailingNewline(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return; // 文件不存在 = 新建，无需处理
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    if (buf[0] !== 0x0a) fs.appendFileSync(file, '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function loadAuthorDict(author, dataRoot) {
  try {
    return mask.loadDict(author, dataRoot);
  } catch (e) {
    throw new Error(
      `作者「${author}」的掩码词典缺失或不可读（${mask.maskDictPath(author)}）：` +
      `请先运行 node tools/distill.js mask <语料根> --author ${author} 生成词典。（${e.message}）`
    );
  }
}

/** 单块任务：chatJson → extractJson → validateObservations → 追加一行 JSONL。
 *  预算耗尽（finish_reason=length）时不再当作「该块失败」，而是**切半重跑**：8,000 字块的
 *  输出预算会被思考吃掉并不罕见（2026-09-13 真机 12 块实测命中 2 块），整块丢弃等于
 *  永久缺数据；切成两半后每半正文量减半、预算立刻宽裕，观测合并落同一行。
 *  切分是「同一块的另一种问法」，仍在同一 worker 槽位内完成（不放大并发）。 */
const MAX_SPLIT_DEPTH = 2;      // 8,000 → 4,000 → 2,000 字，足够把病态块拆到能出结果
const MIN_SPLIT_CHARS = 2000;   // 低于此长度不再切（再切没有上下文，观测质量反而更差）

/** 在段落边界把块一分为二（优先取中点最近的换行，保证 evidence 仍是连续原文）。 */
function splitChunk(chunk) {
  const text = chunk.text;
  const mid = Math.floor(text.length / 2);
  let at = text.indexOf('\n', mid);
  if (at === -1) at = text.lastIndexOf('\n', mid);
  if (at <= 0 || at >= text.length - 1) at = mid;
  return [text.slice(0, at), text.slice(at).replace(/^\n/, '')]
    .filter((t) => t.length > 0)
    .map((t) => ({ ...chunk, text: t }));
}

/** 组请求体：渠道差异只在这里体现（StepFun 走 reasoning_effort；Agnes 走 chat_template_kwargs 开思考）。 */
function buildBody({ provider, model, maxTokens, messages }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (provider.name === 'agnes') {
    // 不开思考会概率性返回 {"observations": []} 空结果（2026-09-13 实测，报告 09 §6.4）
    body.chat_template_kwargs = { enable_thinking: true };
  } else {
    body.reasoning_effort = REASONING_EFFORT;
  }
  return body;
}

/** 调用 + 校验（不落盘）；错误带 e.truncated 时上层可切分。 */
async function computeChunk(chunk, dict, { apiKey, author, fetchImpl, timeoutMs, maxTokens, provider, model, nextKey }) {
  const p = provider || llm.providerOf();
  const body = buildBody({
    provider: p, model: model || MODEL, maxTokens,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(chunk.text, author) },
    ],
  });
  // nextKey 存在时按请求轮转多把 key（Agnes 官方线 6 把独立额度 key，PRM 20/把）
  const res = await llm.chatJson({ apiKey: nextKey ? nextKey() : apiKey, body, fetchImpl, timeoutMs, provider: p });
  const parsed = extractJson(res.content);
  if (parsed === null) {
    // 解析失败必须抛错走重试链（2026-09-12 核查修复）：若照常落一行 kept=0，
    // 该块在文件层面与「模型确实没给出观测」不可区分，续跑时 sha 命中被永久跳过、
    // 不再重试也不报错——最安静的失效。抛错后不落行 → 续跑天然重试；
    // 重试耗尽则计失败并由 CLI 以非零退出码暴露。
    const e = new Error(`内容无法解析为 JSON（finish_reason=${res.finishReason || '?'}，` +
      `content ${String(res.content || '').length} 字符）`);
    if (res.finishReason === 'length') e.truncated = true; // 截断导致 JSON 不完整 → 可切分
    throw e;
  }
  const { kept, dropped } = validateObservations(parsed, chunk.text, dict);
  return {
    kept,
    dropped,
    usage: { input: res.usage.prompt_tokens || 0, output: res.usage.completion_tokens || 0 },
    splits: 0,
  };
}

/** 带切分兜底的计算：预算耗尽 → 一分为二各自再算（递归，深度上限 MAX_SPLIT_DEPTH）。 */
async function computeWithSplit(chunk, dict, ctx, depth) {
  try {
    return await computeChunk(chunk, dict, ctx);
  } catch (e) {
    const canSplit = e && e.truncated && depth < MAX_SPLIT_DEPTH && chunk.text.length >= MIN_SPLIT_CHARS * 2;
    if (!canSplit) throw e;
    // 初始 usage 计入「被放弃的那次调用」——预算是真花掉的，成本口径不能只算成功的分块。
    const wu = (e && e.usage) || {};
    const merged = { kept: [], dropped: [], usage: { input: wu.input || 0, output: wu.output || 0 }, splits: 1 };
    for (const part of splitChunk(chunk)) {
      const r = await computeWithSplit(part, dict, ctx, depth + 1);
      merged.kept.push(...r.kept);
      merged.dropped.push(...r.dropped);
      merged.usage.input += r.usage.input;
      merged.usage.output += r.usage.output;
      merged.splits += r.splits;
    }
    return merged;
  }
}

async function runChunk(item, ctx) {
  const res = await computeWithSplit(item.chunk, item.dict, ctx, 0);
  ensureTrailingNewline(item.outFile);
  fs.appendFileSync(item.outFile, JSON.stringify({
    chunkIndex: item.chunk.index,
    sha256: util.sha256(item.chunk.text),
    at: new Date().toISOString(),
    // 渠道溯源：一行自证「这块是谁产出的」。2026-09-13 之前的行没有这两个字段
    // （当时只有 StepFun 一条线，缺字段即 stepfun/step-3.7-flash）——报告 09 §6.6。
    provider: (ctx.provider && ctx.provider.name) || 'stepfun',
    model: ctx.model || MODEL,
    usage: res.usage,
    // splits > 0 = 该块因输出预算耗尽被切分重算过；落盘留痕，便于日后核对取证口径
    ...(res.splits ? { splits: res.splits } : {}),
    kept: res.kept,
    dropped: res.dropped,
  }) + '\n');
  return { keptCount: res.kept.length, droppedCount: res.dropped.length, usage: res.usage, splits: res.splits };
}

/**
 * L2 map 完整流程（CLI: node tools/distill.js map <语料根> --author X [--work W] [--limit N]）。
 *
 * - 词典从 dataRoot（默认仓库根）下 data/corpus/dict/<author>/mask-dict.json 读取；
 * - 输出追加到 dataRoot 下 data/corpus/src-<author>/map/<work>.jsonl（断点续跑）；
 * - limit 按**每作品**截取前 N 块（验证成本用，常配合 --work 单作品使用）；
 * - 返回 { total, done, failed, skipped, keptObservations, droppedObservations,
 *          usageTokens: {input, output}, wallMs }。
 *   failed = 重试耗尽仍失败的块数（CLI 据此设非零退出码）；done + failed + skipped = total；
 *   keptObservations/droppedObservations 是本轮结束后全部在档块（新完成+续跑跳过）的累计；
 *   usageTokens 只计本轮实际 LLM 调用（跳过块的历史 usage 在其 JSONL 行内可查）。
 *
 * @param {string} root 语料根目录
 * @param {{author: string, work?: string, limit?: number, concurrency?: number,
 *          retry?: number, baseDelayMs?: number, apiKey?: string, fetchImpl?: Function,
 *          timeoutMs?: number, dataRoot?: string}} opts
 */
async function runMap(root, opts = {}) {
  const t0 = Date.now();
  const author = opts.author;
  if (!author) throw new Error('runMap: 缺少 opts.author（map 按作者词典掩码，必须指定 --author）');
  const dataRoot = opts.dataRoot || REPO_ROOT;
  const files = util.readCorpus(root)
    .filter((f) => f.author === author && (opts.work ? f.work === opts.work : true));
  if (!files.length) {
    throw new Error(`runMap: 语料 ${root} 下没有匹配 author=${author}${opts.work ? ` work=${opts.work}` : ''} 的文件`);
  }
  const dict = loadAuthorDict(author, dataRoot);

  // 按作品聚合：多卷文件合并为一篇（剔章题 → 掩码 → 8000 字滑窗）
  const byWork = new Map();
  for (const f of files) {
    if (!byWork.has(f.work)) byWork.set(f.work, []);
    byWork.get(f.work).push(f);
  }
  const workPlans = [];
  for (const [work, wf] of byWork) {
    const text = wf.map((f) => util.stripChapterTitles(util.readUtf8(f.file))).join('\n');
    const masked = mask.maskText(text, dict);
    let chunks = util.mapChunks(masked);
    if (opts.limit) chunks = chunks.slice(0, opts.limit);
    const outFile = path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'map', `${work}.jsonl`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    workPlans.push({ work, chunks, outFile });
  }

  // 续跑判定 + 组任务
  let total = 0;
  let skipped = 0;
  let keptObservations = 0;
  let droppedObservations = 0;
  const pending = [];
  for (const plan of workPlans) {
    total += plan.chunks.length;
    const done = readDoneMap(plan.outFile);
    for (const c of plan.chunks) {
      const prev = done.get(c.index);
      if (prev && prev.sha === util.sha256(c.text)) {
        skipped++;
        keptObservations += prev.kept;
        droppedObservations += prev.dropped;
        continue;
      }
      pending.push({ work: plan.work, outFile: plan.outFile, chunk: c, dict });
    }
  }

  // 渠道与 key：provider 省略 = StepFun（既有行为）；Agnes 官方线按请求在多把 key 间轮转。
  // 单 key 渠道仍走原 resolveApiKey（严格解析「API Key：」下一行），不因多 key 解析放宽口径。
  const provider = llm.providerOf(opts.provider);
  const model = opts.model || provider.defaultModel;
  const keys = (Array.isArray(opts.apiKeys) && opts.apiKeys.length)
    ? opts.apiKeys
    : (opts.apiKey ? [opts.apiKey]
      : (provider.multiKey ? llm.resolveApiKeys(provider.name) : [llm.resolveApiKey()]));
  const nextKey = llm.keyRotator(keys);
  const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 5;
  const maxTokens = Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : MAX_TOKENS;
  console.log(`[map] ${author} 渠道: provider=${provider.name} model=${model} keys=${nextKey.size} ` +
    `concurrency=${concurrency} maxTokens=${maxTokens} 续跑待跑 ${pending.length} 块（已完成跳过 ${skipped}）`);
  let completed = 0;
  let failedSoFar = 0;
  // 心跳：长跑里「静默卡住」与「正常推进」在日志上原本不可区分（2026-09-13 主代理据此误判过一次
  //   「卡了 35 分钟」，实际只是在正常推进——每块 8k 字 + 低思考约 30s，25 块的进度行隔 12 分钟才出现）。
  //  失败逐条即时打印（原先只在全部跑完后的汇总里出现，长跑期间完全不可见）。
  const t0Heartbeat = Date.now();
  let lastDoneAt = t0Heartbeat;
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : 120000;
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
      console.log(`[map] ${author} 心跳: 完成 ${completed}/${pending.length}` +
        `${failedSoFar ? `、失败 ${failedSoFar}` : ''}` +
        `（已跑 ${((Date.now() - t0Heartbeat) / 60000).toFixed(1)} 分钟，最后完成于 ` +
        `${((Date.now() - lastDoneAt) / 1000).toFixed(0)} 秒前）`);
    }, heartbeatMs)
    : null;
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  const outcomes = await runPool(
    pending.map((it) => () => runChunk(it, {
      apiKey: keys[0], nextKey, provider, model,
      author, fetchImpl: opts.fetchImpl,
      timeoutMs: Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      maxTokens,
    })),
    {
      concurrency,
      retry: opts.retry,
      baseDelayMs: opts.baseDelayMs,
      onDone: (i, ok) => {
        const it = pending[i];
        lastDoneAt = Date.now();
        if (!ok) {
          failedSoFar++;
          console.error(`[map] 块 ${it.chunk.index}（${it.work}）本轮重试耗尽`);
          return;
        }
        completed++;
        if (completed % 25 === 0 || completed === pending.length) {
          console.log(`[map] ${author} 进度: ${completed}/${pending.length} 块（失败 ${failedSoFar}）`);
        }
      },
    }
  );
  if (heartbeat) clearInterval(heartbeat);

  let done = 0;
  let failed = 0;
  let splitBlocks = 0;
  const usageTokens = { input: 0, output: 0 };
  for (const o of outcomes) {
    if (!o.ok) {
      const it = pending[o.index];
      failed++;
      console.error(`[map] 块 ${it.chunk.index}（${it.work}）重试后仍失败: ${o.error && o.error.message}`);
      continue;
    }
    done++;
    if (o.value.splits) splitBlocks++;
    keptObservations += o.value.keptCount;
    droppedObservations += o.value.droppedCount;
    usageTokens.input += o.value.usage.input;
    usageTokens.output += o.value.usage.output;
  }

  const summary = {
    total, done, failed, skipped, splitBlocks, keptObservations, droppedObservations, usageTokens,
    wallMs: Date.now() - t0,
  };
  console.log(
    `[map] ${author}: 新完成 ${done}/${total} 块、续跑跳过 ${skipped} 块` +
    `${failed ? `、**失败 ${failed} 块**` : ''}` +
    `${splitBlocks ? `、其中 ${splitBlocks} 块因预算耗尽被切分重算` : ''}  ` +
    `观测保留 ${keptObservations} 条 / 闸门丢弃 ${droppedObservations} 条  ` +
    `token 输入 ${usageTokens.input} / 输出 ${usageTokens.output}  耗时 ${(summary.wallMs / 1000).toFixed(1)}s`
  );
  return summary;
}

/**
 * 离线复核（第 2.5 步，零 LLM 调用）：把已落盘 JSONL 里的 kept + dropped 条目**重新过一遍闸门**，
 * 这次带 opts.ignoreWhitespace（见 validateObservations 注释）。产物写 `map-relaxed/<work>.jsonl`，
 * **原 JSONL 一字不改**（严格口径的记录必须保留，派生集只增不改）。
 *
 * 为什么需要它在离线做而不是改在线判据：全量跑中途改判据会在同一作者内造成两套口径
 * （与「同一作者不混跑」同一条理由）；而 dropped 条目完整留档，任何口径都能事后重放。
 *
 * sha 纪律：只处理 `util.sha256(重建块文本) === row.sha256` 的行——词表重建后掩码文本已变的
 * 旧行不能拿今天的文本去复核（会在统计里混进假失配）。
 *
 * @param {string} root 语料根
 * @param {{author: string, work?: string, dataRoot?: string, ignoreWhitespace?: boolean}} opts
 * @returns {{works: Array<{work: string, rows: number, stale: number, keptBefore: number, keptAfter: number,
 *            recovered: number, droppedAfter: number, outFile: string}>, totals: object}}
 */
function revalidateMap(root, opts = {}) {
  const author = opts.author;
  if (!author) throw new Error('revalidateMap: 缺少 opts.author');
  const dataRoot = opts.dataRoot || REPO_ROOT;
  const ignoreWhitespace = opts.ignoreWhitespace !== false;   // 本命令存在的意义就是开这个开关
  const normalizeDims = opts.normalizeDims !== false;         // 同上（维度标签别名归一）
  const files = util.readCorpus(root)
    .filter((f) => f.author === author && (opts.work ? f.work === opts.work : true));
  if (!files.length) throw new Error(`revalidateMap: 语料 ${root} 下没有匹配 author=${author} 的文件`);
  const dict = loadAuthorDict(author, dataRoot);
  const byWork = new Map();
  for (const f of files) {
    if (!byWork.has(f.work)) byWork.set(f.work, []);
    byWork.get(f.work).push(f);
  }
  const works = [];
  const totals = { rows: 0, stale: 0, keptBefore: 0, keptAfter: 0, recovered: 0, droppedAfter: 0, recoveredBy: {} };
  for (const [work, wf] of byWork) {
    const srcFile = path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'map', `${work}.jsonl`);
    const raw = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, 'utf8') : '';
    if (!raw.trim()) { works.push({ work, rows: 0, stale: 0, keptBefore: 0, keptAfter: 0, recovered: 0, droppedAfter: 0, outFile: null, note: '无产物，跳过' }); continue; }
    const text = wf.map((f) => util.stripChapterTitles(util.readUtf8(f.file))).join('\n');
    const chunks = util.mapChunks(mask.maskText(text, dict));
    const last = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      last.set(r.chunkIndex, r);          // 后行覆盖前行（与 readDoneMap 同语义）
    }
    const outFile = path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'map-relaxed', `${work}.jsonl`);
    const out = [];
    const stat = { work, rows: 0, stale: 0, keptBefore: 0, keptAfter: 0, recovered: 0, droppedAfter: 0, recoveredBy: {}, outFile };
    for (const r of last.values()) {
      const c = chunks[r.chunkIndex];
      if (!c || util.sha256(c.text) !== r.sha256) { stat.stale++; continue; }
      stat.rows++;
      stat.keptBefore += (r.kept || []).length;
      const items = [...(r.kept || []), ...((r.dropped || []).map((d) => d.item).filter(Boolean))];
      const v = validateObservations(items, c.text, dict, { ignoreWhitespace, normalizeDims });
      if (v.kept.length < (r.kept || []).length) {
        // 不变量：严格口径的保留项在放宽口径下必然仍保留（否则说明判据写反了）
        throw new Error(`revalidateMap: 不变量被破坏——${author}/${work} 块 ${r.chunkIndex} ` +
          `严格保留 ${(r.kept || []).length} 条 > 放宽后 ${v.kept.length} 条`);
      }
      stat.keptAfter += v.kept.length;
      const newKept = v.kept.length - (r.kept || []).length;
      stat.recovered += newKept;
      // 补回构成：条目上的 relaxed 标签（whitespace / dim / whitespace+dim）就是「为什么放宽才进来」。
      // 严格口径的保留项绝不带标签（生成侧只认七个中文标签 + 逐字子串），故有标签 = 本次补回。
      let tagged = 0;
      for (const it of v.kept) {
        if (!it.relaxed) continue;
        tagged++;
        stat.recoveredBy[it.relaxed] = (stat.recoveredBy[it.relaxed] || 0) + 1;
      }
      if (tagged !== newKept) {
        throw new Error(`revalidateMap: 补回数与留痕数不一致——${author}/${work} 块 ${r.chunkIndex} ` +
          `补回 ${newKept} 但有标签的只有 ${tagged}（标签语义被改坏了）`);
      }
      stat.droppedAfter += v.dropped.length;
      out.push({
        chunkIndex: r.chunkIndex, sha256: r.sha256, at: r.at,
        ...(r.provider ? { provider: r.provider } : {}),
        ...(r.model ? { model: r.model } : {}),
        usage: r.usage,
        ...(r.splits ? { splits: r.splits } : {}),
        policy: [ignoreWhitespace ? 'ws-insensitive' : 'ws-strict', normalizeDims ? 'dims-normalized' : 'dims-strict'].join('+'),
        kept: v.kept, dropped: v.dropped,
      });
    }
    if (out.length) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, out.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    }
    works.push(stat);
    totals.rows += stat.rows; totals.stale += stat.stale;
    totals.keptBefore += stat.keptBefore; totals.keptAfter += stat.keptAfter;
    totals.recovered += stat.recovered; totals.droppedAfter += stat.droppedAfter;
    for (const [k, v] of Object.entries(stat.recoveredBy)) totals.recoveredBy[k] = (totals.recoveredBy[k] || 0) + v;
  }
  return {
    author,
    policy: [ignoreWhitespace ? 'ws-insensitive' : 'ws-strict', normalizeDims ? 'dims-normalized' : 'dims-strict'].join('+'),
    works, totals,
  };
}

module.exports = {
  SYSTEM_PROMPT, DIMS,
  MODEL, MAX_TOKENS, REASONING_EFFORT, DEFAULT_TIMEOUT_MS,
  buildUserPrompt, buildBody, extractJson, validateObservations, stripWhitespace,
  DIM_ALIASES, normalizeDim,
  runPool, runMap, revalidateMap, nextRetryDelay,
};
