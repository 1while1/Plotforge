'use strict';
/**
 * L3 闸门（纯函数、零 LLM 成本）—— 设计 §3.3 的四道闸门 + 05 报告 §5 的 5 条硬约束。
 *
 * 输入：`map-relaxed/<work>.jsonl` 的 kept 条目（放宽口径，见 report 09 §6.9/§6.10）
 *      + 掩码后块文本（闸门 3 逐块计数用）+ 语料级 marker 频率表（闸门 2 用）
 * 输出：保留分组 / 丢弃清单（每条带机器可读 reason，供报告与人工抽检消费）
 *
 * 闸门 4（证据包含性）不在这里：它已在 `map.js::validateObservations` 落库前执行
 * （`evidence` 必须是掩码块文本的逐字子串），到 L3 时条目已全部通过；L3 驱动会再抽检一次
 * 计数为 0 即告警（防上游换数据源）。
 *
 * —— 5 条硬约束的落地位置（05-块级归属噪声诊断.md §5，2026-09-12）——
 * ① 逐书先验裕度：`bookMarginGate`，裕度 < MARGIN_MIN 的书**不得用块级证据**（其块不计入任何
 *    分组的支撑计数，条目降级为 advisory 并全部留痕）。裕度由 L3 驱动在**掩码后 8,000 字域**实测。
 * ② 聚合到 map 块尺度：本模块的支撑单位就是 map 块（`util.MAP_CHUNK_SIZE` = 8,000 字），
 *    块内不再切小单元——这是可靠性口径，不是性能口径（400 字域蔽霄归属率仅 67.2%）。
 * ③ lift 按特征频率分层：`liftGate` 对 marker 的可核对性分档（`literal` 才进 lift；高频道
 *    marker 计数语义含混 → `unverifiable` 降档而非误杀），并用 `MIN_TARGET_COUNT` 挡住
 *    「目标侧只出现 1~2 次的偶发 marker 靠对照侧 0 次拿到 lift=∞」这条路。
 * ④ 「≥8 块」按块长重定：8,000 字域下 8 块 = 64,000 字（`REPRO_MIN_CHARS`），与
 *    「≥2 作品」二者取一即可（`reproduceGate`）。
 * ⑤ 卡片验收用更大单元：不在本模块（属第 5 步评价闭环）。
 */
const util = require('./util');

/** 设计 §3.3 定的 lift 下限（「< 1.3 直接丢弃」）。 */
const LIFT_MIN = 1.3;
/** 闸门 3 容差：一个数量级（设计 §3.3「偏差超过一个数量级即判幻觉」）。 */
const COUNT_ORDER_TOL = 10;
/** 复现闸门的两条通过路径（设计 §3.3 + 约束 ④）。 */
const REPRO_MIN_WORKS = 2;
const REPRO_MIN_BLOCKS = 8;
const REPRO_MIN_CHARS = REPRO_MIN_BLOCKS * util.MAP_CHUNK_SIZE; // 8,000 字域下 = 64,000 字
/** 约束 ①：裕度低于此值的书禁用块级证据。 */
const MARGIN_MIN = 0.05;
/** marker 长度上限（码点）：超过即视为「描述句」而非可计数模式（普查实证见 report 09 §7）。 */
const MARKER_MAX_CP = 12;
/** 闸门 2 的最小目标侧出现次数：低于此值的 marker 撑不起「率比」这个统计量。 */
const MIN_TARGET_COUNT = 8;
/**
 * 高频 marker 的**绝对**阈值（在**本块**内的字面出现次数）：≥ 此值则计数语义含混 → unverifiable。
 * 用绝对次数而不是「每万字率」：率在短块上会失控（13 字的块里出现 2 次 = 1,538/万字），
 * 而闸门 3 核对的是**单块**，所谓高频就是「这一块里到处都是它」（8,000 字块里 200 次 ≈ 每 40 字一次）。
 * 2026-09-13 由首轮单测暴露：原先按率判据，短块上任何 marker 都会免死。
 */
const HIGHFREQ_ABS_COUNT = 200;

// 降档/判死原因清单（l3 与报告的稳定枚举面）
const HYGIENE_REASONS = ['marker-missing', 'marker-placeholder', 'marker-chapter-mark', 'marker-too-long',
  'marker-descriptive', 'marker-halfwidth-punct', 'marker-wrapped'];

/** 掩码占位符样式：〔人名〕〔地名〕〔势力〕〔功法〕及任何〔…〕。 */
const PLACEHOLDER_RE = /\u3014[^\u3015]*\u3015/;
/** 章题残留（`stripChapterTitles` 漏网的「(本章完)」类尾标，普查实证两家言情作者 top-10 marker 里有它）。 */
const CHAPTER_MARK_RE = /[（(]\s*本章完\s*[)）]/;

/**
 * 描述型 marker（模型的「标记」不是可逐字匹配的模式，而是一句**模式描述**）。
 * **只在「本块零字面命中」之后启用**：先把字面匹配做完，再决定这次 0 命中该记成
 * 「模型在描述一个模式」（unverifiable，降档留痕）还是「计数为幻觉」（mismatch，判死）。
 * 顺序不能反——否则「数日后」这种真字面 marker 会被误降档（它的字面命中本来能判 ok）。
 *
 * 判据（字符类取自实测零命中 marker 的构词，见 12 报告「闸门 3 分型修复」）：
 *   · 结构名词：四字格 / 单句内逗号数≥4 / 引号内拟声词 / 独立成段
 *   · 标点**名称**：省略号 / 破折号 / 问号（模型报名字而不是字形）
 *   · 运算符与交替符：≥ ≤ + | / 与通配 *
 *   · 拉丁字母占位：第X更
 *   · 括号/方括号注释：（对话内）/[单字动词]
 *   · 模式省略号：省略号在中间（如…般）或出现两次以上（带着…，带着…）
 *   · 枚举列表：想、琢磨、寻思（模型列了几个候选 marker，不是字面串）
 * 实测分型（零命中条目）：84.4% / 81.4%（白石/青崖）、61% / 69%（溪上老翁/晚棠未开）属这一类。
 */
const DESCRIPTIVE_RE = new RegExp([
  '[格句式类型字]',                        // 结构名词：四字格 / 单句 / 句式 / 四字，四字
  '[独成对叙引]',                          // 独立/成段/成行/对白/叙述/引号
  '省略号|破折号|问号|叹号|感叹号|逗号|句号', // 标点名称（不是字形）
  '[≥≤＋+｜|／/*]',                        // 运算符 / 交替符 / 通配
  '[A-Za-z]',                              // 拉丁占位
  '[（(][^）)]{1,12}[）)]',                 // 括号注释
  '[\\[［][^\\]］]{1,12}[\\]］]',           // 方括号占位
  '…[\\s\\S]*…',                           // 两个以上省略号（重复模式）
  '[\\u4e00-\\u9fa5]…[\\u4e00-\\u9fa5]',   // 中间省略号（如…般 / 太…了）
  '[\\u4e00-\\u9fa5]、[\\u4e00-\\u9fa5]',   // 枚举列表
].join('|'));

/** 半角标点 → 全角：marker 写成半角而正文是全角时字面匹配必然 0 命中，但计数未必是幻觉。 */
const ASCII_PUNCT_ONLY_RE = /^[\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+$/;
const HALF2FULL = { ',': '，', '.': '。', ';': '；', ':': '：', '!': '！', '?': '？', '(': '（', ')': '）', '"': '“', "'": '‘' };

/** 包裹对（模型给 marker 加了引号/书名号/括号）：剥掉一层再看字面——「"砰"」要按「砰」核对。 */
const WRAP_PAIRS = [['“', '”'], ['「', '」'], ['『', '』'], ['【', '】'], ['（', '）'], ['(', ')'], ['[', ']'], ['"', '"'], ["'", "'"]];
function unwrapMarker(marker) {
  const m = String(marker || '');
  if (util.codePoints(m) < 3) return null;
  for (const [a, b] of WRAP_PAIRS) {
    if (m.startsWith(a) && m.endsWith(b) && util.codePoints(m) > util.codePoints(a) + util.codePoints(b)) {
      return m.slice(a.length, m.length - b.length);
    }
  }
  return null;
}

/** 半角标点 marker 的全角形态（非 ASCII 标点原样保留）。 */
function toFullWidthPunct(marker) {
  return [...marker].map((ch) => HALF2FULL[ch] || ch).join('');
}

/**
 * 字面计数：非重叠出现次数。marker 一律当**字面串**处理，不做正则解释——
 * 模型的 marker 里出现 `.` `*` `(` 等字符是常态（如「“”」），当正则要么抛错要么语义漂移。
 */
function countOccurrences(text, needle) {
  if (typeof text !== 'string' || !needle) return 0;
  let n = 0;
  let pos = 0;
  for (;;) {
    const i = text.indexOf(needle, pos);
    if (i === -1) return n;
    n++;
    pos = i + needle.length;
  }
}

/** 大文本用 Buffer 版（UTF-8 字节串上做 indexOf，实测吞吐 ≈2.4 GB/s，见 report 09 §7）。 */
function countOccurrencesInBuffer(buf, needle) {
  if (!Buffer.isBuffer(buf) || !needle) return 0;
  const nbuf = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'utf8');
  if (!nbuf.length) return 0;
  let n = 0;
  let pos = 0;
  for (;;) {
    const i = buf.indexOf(nbuf, pos);
    if (i === -1) return n;
    n++;
    pos = i + nbuf.length;
  }
}

const normalizeMarker = (m) => (typeof m === 'string' ? m.trim() : '');

/**
 * marker 卫生（闸门 2/3 的前置）：判定这个 marker 能不能当「可核对的字面模式」用。
 * 判据全部来自普查实证（2026-09-13，26,462 条 kept 条目）：
 *  - 占位符：两家言情作者 top-10 marker 里就有〔人名〕（13/24 条）。占位符的密度是**掩码比例**的
 *    函数（白石 4.50% vs 溪上老翁 10.3%），拿它算 lift 会把「掩码口径差」当成作者差异。
 *  - 章题尾标：`(本章完)` 是清洗层残留，属书不是属人。
 *  - 超长：>12 码点的 marker 占白石 20.1%、溪上老翁 48.1%、晚棠未开 45.6%——它们是「描述句」，
 *    字面命中率极低，算率比会得到一堆 0/0 噪声。
 * 返回 kind='literal' 才可核对；其余一律降档为 unverifiable（**不丢**，交复现闸门兜底）。
 */
function markerHygiene(marker) {
  const m = normalizeMarker(marker);
  if (!m) return { ok: false, kind: 'missing', reason: 'marker-missing' };
  if (PLACEHOLDER_RE.test(m)) return { ok: false, kind: 'placeholder', reason: 'marker-placeholder' };
  if (CHAPTER_MARK_RE.test(m)) return { ok: false, kind: 'chapter-mark', reason: 'marker-chapter-mark' };
  if (util.codePoints(m) > MARKER_MAX_CP) return { ok: false, kind: 'too-long', reason: 'marker-too-long' };
  return { ok: true, kind: 'literal', reason: null };
}

/** 每万字出现次数（0 字语料返回 0，不返回 NaN/Infinity）。 */
function ratePer10k(count, chars) {
  if (!(chars > 0) || !(count > 0)) return 0;
  return (count / chars) * 10000;
}

/**
 * 闸门 3 · 计数交叉核对：模型自报 `count` vs marker 在本块掩码文本里的真实频次。
 * 三态（而不是二态）的理由：marker 高频时（如「的」「！」）「该特质的次数」与「marker 的字面
 * 次数」本就未必是同一个量——报 count=5 而字面出现 3,000 次，可能是「构成某句式的次数」。
 * 把它判成幻觉是误杀；判成 ok 是放水。故引入 unverifiable 档（降档 + 留痕，交复现闸门兜底）。
 */
function countCrossCheck(item, blockText, opts = {}) {
  const reported = item && item.count;
  const marker = normalizeMarker(item && item.marker);
  if (!Number.isInteger(reported) || reported < 1) {
    return { status: 'unverifiable', reason: 'count-invalid', reported: reported, real: null };
  }
  const hy = markerHygiene(marker);
  if (!hy.ok) return { status: 'unverifiable', reason: hy.reason, reported: reported, real: null };
  if (typeof blockText !== 'string' || !blockText) {
    return { status: 'unverifiable', reason: 'block-text-missing', reported: reported, real: null };
  }
  const real = countOccurrences(blockText, marker);
  const tol = Number.isFinite(opts.tol) ? opts.tol : COUNT_ORDER_TOL;
  const highFreq = Number.isFinite(opts.highFreqAbsCount) ? opts.highFreqAbsCount : HIGHFREQ_ABS_COUNT;
  if (real === 0) {
    // marker 在自己这块里一次都没字面出现。分三种情形（顺序有讲究：先字面、再描述、最后半角）：
    // ① 描述型模式（「四字格」「如…般」「单句内逗号数≥4」）——模型没在报字面串，无法核对，
    //    但也不是幻觉 → unverifiable 降档（实测：零命中项里 84.4%/81.4% 属此类，把它们判死
    //    等于按 26% 的比例丢观测，且丢得多寡随作者结构特征浮动 → 卡片间不可比）；
    // ② 半角标点（「,」而正文用「，」）——全角形态在块内存在即为拼写问题，非幻觉 → unverifiable；
    // ③ 其余：模型报了一个字面串而块里没有 → 判死（幻觉）。
    if (DESCRIPTIVE_RE.test(marker)) {
      return { status: 'unverifiable', reason: 'marker-descriptive', reported: reported, real: 0, per10k: 0 };
    }
    const inner = unwrapMarker(marker);
    if (inner) {
      const innerReal = countOccurrences(blockText, inner);
      if (innerReal > 0) {
        return { status: 'unverifiable', reason: 'marker-wrapped', reported: reported, real: innerReal, per10k: ratePer10k(innerReal, util.codePoints(blockText)) };
      }
    }
    if (ASCII_PUNCT_ONLY_RE.test(marker)) {
      const conv = toFullWidthPunct(marker);
      const convReal = countOccurrences(blockText, conv);
      if (convReal > 0) {
        return { status: 'unverifiable', reason: 'marker-halfwidth-punct', reported: reported, real: convReal, per10k: ratePer10k(convReal, util.codePoints(blockText)) };
      }
    }
    return { status: 'mismatch', reason: 'marker-absent-in-block', reported: reported, real: 0, per10k: 0 };
  }
  const ratio = reported > real ? reported / real : real / reported;
  const per10k = ratePer10k(real, util.codePoints(blockText));
  if (ratio <= tol) return { status: 'ok', reported: reported, real: real, ratio: ratio, per10k: per10k };
  // 只有「本块里真实频次极高」这一侧可以免死
  if (real >= highFreq) {
    return { status: 'unverifiable', reason: 'marker-highfreq', reported: reported, real: real, ratio: ratio, per10k: per10k };
  }
  return { status: 'mismatch', reason: 'count-off-by-order', reported: reported, real: real, ratio: ratio, per10k: per10k };
}

/** 观测分组的键：同维度 + 同一 marker（归一化后）视为**同一候选特质的重复观察**。 */
function groupKeyOf(item) {
  const m = normalizeMarker(item && item.marker);
  return `${item.dim}\u0000${m}`;
}

/**
 * 复现闸门（闸门 1）· 分组支撑统计。
 * 通过条件（约束 ④ 重定口径后）：**≥2 个不同作品** 或 **≥8 个不同块（=64,000 字）**。
 * 支撑单位是 map 块（约束 ②）：同一块里重复出现的同 marker 条目只算一块。
 * `opts.disabledWorks`（约束 ①）里的作品其块**不计入支撑**，条目转 advisory。
 */
function reproduceGate(items, opts = {}) {
  const disabled = opts.disabledWorks instanceof Set ? opts.disabledWorks : new Set(opts.disabledWorks || []);
  const minWorks = Number.isInteger(opts.minWorks) ? opts.minWorks : REPRO_MIN_WORKS;
  const minBlocks = Number.isInteger(opts.minBlocks) ? opts.minBlocks : REPRO_MIN_BLOCKS;
  const minChars = Number.isInteger(opts.minChars) ? opts.minChars : REPRO_MIN_CHARS;
  const groups = new Map();
  const advisory = [];
  for (const it of items) {
    const key = groupKeyOf(it);
    if (!groups.has(key)) {
      groups.set(key, {
        key: key, dim: it.dim, marker: normalizeMarker(it.marker),
        traits: new Set(), items: [],
        works: new Set(), blocks: new Set(), advisoryBlocks: 0,
        chars: 0, checks: { ok: 0, unverifiable: 0, mismatch: 0 },
      });
    }
    const g = groups.get(key);
    g.items.push(it);
    g.traits.add(it.trait);
    if (it.countCheck) g.checks[it.countCheck.status] = (g.checks[it.countCheck.status] || 0) + 1;
    if (it.countCheck && it.countCheck.status === 'mismatch') continue; // 闸门 3 已判死，不计支撑
    if (disabled.has(it.work)) { g.advisoryBlocks++; advisory.push(it); continue; }
    const blockId = `${it.work}#${it.chunkIndex}`;
    if (!g.blocks.has(blockId)) { g.blocks.add(blockId); g.chars += util.MAP_CHUNK_SIZE; }
    g.works.add(it.work);
  }
  const passed = [];
  const dropped = [];
  for (const g of groups.values()) {
    const support = { works: g.works.size, blocks: g.blocks.size, chars: g.chars, advisoryBlocks: g.advisoryBlocks };
    const byWorks = support.works >= minWorks;
    const byBlocks = support.blocks >= minBlocks && support.chars >= minChars;
    const rec = {
      key: g.key, dim: g.dim, marker: g.marker,
      traits: [...g.traits], items: g.items, support: support, checks: g.checks,
      // 单作品路径（byBlocks）支撑更弱：只能证明「这本书里反复出现」，不能证明跨书稳定
      tier: byWorks ? 'cross-work' : 'single-work',
    };
    if (byWorks || byBlocks) passed.push(rec);
    else dropped.push({ ...rec, reason: 'not-reproduced' });
  }
  return { passed, dropped, advisory };
}

/**
 * 闸门 2 · lift（治空话，零 LLM）：marker 在目标语料与**同题材对照语料**的每万字率之比。
 *
 * 为什么必须同题材对照（设计 §3.3 的已知缺陷修法）：白石在玄幻、晚棠未开在言情，
 * 跨题材的差别首先是**题材**差别（叹号密度、对话占比都是题材的函数）。同题材对照（白石 vs 青崖，
 * 均为玄幻）把题材作为常量消掉，剩下的差异才更可能属于作者。
 *
 * 三档结论：
 *  - `lift`：率比 < LIFT_MIN → 丢弃（不是这位作家的印记）。
 *  - `contrast-zero`：对照侧 0 次而目标侧 ≥ MIN_TARGET_COUNT → 保留但**单独标记**（这条通过路径
 *    最弱：可能只是对照语料不够大，也可能是题材词——台账 §4.6 的词典 lift 就栽在这上面）。
 *  - 目标侧次数 < MIN_TARGET_COUNT → 丢弃（偶发，撑不起率比）。
 */
function liftGate(groups, rateLookup, opts = {}) {
  const liftMin = Number.isFinite(opts.liftMin) ? opts.liftMin : LIFT_MIN;
  const minCount = Number.isInteger(opts.minTargetCount) ? opts.minTargetCount : MIN_TARGET_COUNT;
  const passed = [];
  const dropped = [];
  for (const g of groups) {
    const hy = markerHygiene(g.marker);
    if (!hy.ok) {
      // 不可核对（无 marker / 占位符 / 超长）：不适用 lift，降档保留
      passed.push({ ...g, lift: null, liftTier: 'qualitative', liftReason: hy.reason, rate: null });
      continue;
    }
    const r = rateLookup(g.marker) || {};
    const targetRate = ratePer10k(r.targetCount, r.targetChars);
    const contrastRate = ratePer10k(r.contrastCount, r.contrastChars);
    const rec = {
      ...g,
      rate: { targetCount: r.targetCount || 0, targetChars: r.targetChars || 0, targetRate: targetRate,
        contrastCount: r.contrastCount || 0, contrastChars: r.contrastChars || 0, contrastRate: contrastRate },
    };
    if (!(targetRate > 0) || (r.targetCount || 0) < minCount) {
      dropped.push({ ...rec, lift: 0, liftTier: 'below-min-count', reason: 'marker-too-rare' });
      continue;
    }
    if (contrastRate === 0) {
      rec.lift = Infinity;
      rec.liftTier = 'contrast-zero';
      rec.liftReason = 'contrast-zero';
      passed.push(rec);
      continue;
    }
    const lift = targetRate / contrastRate;
    rec.lift = lift;
    if (lift >= liftMin) { rec.liftTier = 'lift'; passed.push(rec); }
    else dropped.push({ ...rec, liftTier: 'below-lift', reason: 'lift-below-threshold' });
  }
  return { passed, dropped };
}

/**
 * 约束 ①· 每书先验裕度闸门：`margin` = 该书块「到本作者质心平均 Δ」与「到最近他作者质心平均 Δ」之差。
 * 裕度 < MARGIN_MIN 的书，其块级证据不可用（05 报告实测：400 字域蔽霄 0.014、言情三部 0.019~0.047，
 * 这些书在小块域里块归属基本是噪声）。返回禁用书名集合 + 逐书留痕。
 */
function bookMarginGate(margins, opts = {}) {
  const min = Number.isFinite(opts.marginMin) ? opts.marginMin : MARGIN_MIN;
  const disabled = new Set();
  const rows = [];
  for (const m of margins || []) {
    const margin = Number.isFinite(m.margin) ? m.margin : null;
    const bad = margin === null || margin < min;
    if (bad) disabled.add(m.work);
    rows.push({ work: m.work, margin: margin, blocks: m.blocks || 0, attribution: m.attribution == null ? null : m.attribution,
      disabled: bad, reason: bad ? (margin === null ? 'margin-unavailable' : 'margin-below-min') : null });
  }
  return { disabled: disabled, rows: rows, marginMin: min };
}

/**
 * 闸门 1+2 在**合并簇**上的判定（树状 reduce 之后；2026-09-13 定的顺序）。
 *
 * 为什么闸门 1 不在 reduce 之前做：首版把「同 marker 分组」直接当复现单元，晚棠未开 1,611 条
 * 观测切出 1,434 个分组、只有 8 组通过——模型的 marker 大多一次一写，字面相等不是「同一特质」。
 * 设计 §3.3 的本意是语义同一，故顺序定为：闸门 3/4（逐条精确）→ reduce（语义合并）→ 闸门 1/2（簇上）。
 *
 * 簇的支撑统计由 reduce 侧**按 id 回溯代码算**（`support.works/blocks/chars`），本函数只读不算。
 * lift 取「簇内所有可核对 marker 里最大的那个」：一条簇常有好几种可计数的标记方式，
 * 任意一种能撑起率比即说明这条簇是这位作家特有的；同时记下中标的 marker，供卡片硬线引用
 * （卡片硬线必须可计数，所以要知道「用哪个 marker 数」）。
 */
function clusterGate(clusters, rateLookup, opts = {}) {
  const minWorks = Number.isInteger(opts.minWorks) ? opts.minWorks : REPRO_MIN_WORKS;
  const minBlocks = Number.isInteger(opts.minBlocks) ? opts.minBlocks : REPRO_MIN_BLOCKS;
  const minChars = Number.isInteger(opts.minChars) ? opts.minChars : REPRO_MIN_CHARS;
  const liftMin = Number.isFinite(opts.liftMin) ? opts.liftMin : LIFT_MIN;
  const minCount = Number.isInteger(opts.minTargetCount) ? opts.minTargetCount : MIN_TARGET_COUNT;
  const TIER_RANK = { lift: 3, 'contrast-zero': 2, 'below-min-count': 1 };
  const passed = [];
  const dropped = [];
  for (const c of clusters) {
    const support = c.support || { works: 0, blocks: 0, chars: 0, items: 0 };
    const byWorks = support.works >= minWorks;
    const byBlocks = support.blocks >= minBlocks && support.chars >= minChars;
    const markers = Array.isArray(c.markers) ? c.markers : [];
    const countable = markers.filter((m) => markerHygiene(m).ok);
    let best = null;
    for (const m of countable) {
      const r = rateLookup(m) || {};
      const targetCount = r.targetCount || 0;
      const targetRate = ratePer10k(targetCount, r.targetChars);
      const contrastRate = ratePer10k(r.contrastCount, r.contrastChars);
      let cand;
      if (!(targetRate > 0) || targetCount < minCount) {
        cand = { marker: m, tier: 'below-min-count', lift: null, targetCount: targetCount,
          targetRate: targetRate, contrastRate: contrastRate, contrastCount: r.contrastCount || 0 };
      } else {
        const lift = contrastRate === 0 ? Infinity : targetRate / contrastRate;
        cand = { marker: m, tier: contrastRate === 0 ? 'contrast-zero' : 'lift', lift: lift, targetCount: targetCount,
          targetRate: targetRate, contrastRate: contrastRate, contrastCount: r.contrastCount || 0 };
      }
      const better = !best
        || TIER_RANK[cand.tier] > TIER_RANK[best.tier]
        || (TIER_RANK[cand.tier] === TIER_RANK[best.tier] && cand.lift !== null && best.lift !== null
          && (cand.lift === Infinity || (best.lift !== Infinity && cand.lift > best.lift)))
        || (TIER_RANK[cand.tier] === TIER_RANK[best.tier] && cand.lift === null && cand.targetCount > (best.targetCount || 0));
      if (better) best = cand;
    }
    const rec = {
      dim: c.dim, trait: c.trait, markers: markers, support: support, checks: c.checks,
      conflict: c.conflict === true, variants: c.variants || [], itemCount: (c.items || []).length,
      lift: best ? best.lift : null,
      liftMarker: best ? best.marker : null,
      liftTier: best ? best.tier : 'qualitative',
      rate: best ? { targetRate: best.targetRate, contrastRate: best.contrastRate,
        targetCount: best.targetCount, contrastCount: best.contrastCount } : null,
      items: c.items || [],
    };
    if (!(byWorks || byBlocks)) { dropped.push({ ...rec, reason: 'not-reproduced' }); continue; }
    if (best && best.tier === 'lift' && best.lift < liftMin) { dropped.push({ ...rec, reason: 'lift-below-threshold' }); continue; }
    if (best && best.tier === 'below-min-count') { dropped.push({ ...rec, reason: 'marker-too-rare' }); continue; }
    // 到这里：lift 达标 / 对照侧零次 / 不可核对（qualitative，降档保留）
    passed.push(rec);
  }
  return { passed, dropped };
}

/** 丢弃原因汇总（报告与断言用）。 */
function reasonTally(rows) {
  const t = {};
  for (const r of rows || []) t[r.reason] = (t[r.reason] || 0) + 1;
  return t;
}

module.exports = {
  // 常量
  LIFT_MIN, COUNT_ORDER_TOL, REPRO_MIN_WORKS, REPRO_MIN_BLOCKS, REPRO_MIN_CHARS,
  MARGIN_MIN, MARKER_MAX_CP, MIN_TARGET_COUNT, HIGHFREQ_ABS_COUNT, HYGIENE_REASONS,
  DESCRIPTIVE_RE, ASCII_PUNCT_ONLY_RE, toFullWidthPunct, unwrapMarker,
  PLACEHOLDER_RE, CHAPTER_MARK_RE,
  // 工具
  countOccurrences, countOccurrencesInBuffer, normalizeMarker, markerHygiene,
  ratePer10k, countCrossCheck, groupKeyOf,
  // 闸门
  reproduceGate, liftGate, bookMarginGate, clusterGate, reasonTally,
};
