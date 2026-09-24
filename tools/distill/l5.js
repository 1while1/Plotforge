'use strict';
/**
 * L5 · 卡片产出：把 L3 的簇、L4 的范文、L1 的指纹装进一张 `kind='imprint'` 的作家卡。
 *
 * 四节与既有编译路径（`server/style/packs.js` 的 `compileCardsText`）一一对应，本步**不改编译路径**：
 *   ① 人设与指纹 —— `persona`（转译）+ `profile_json`（七行短标签）
 *   ② 硬线规则   —— `style_rules.severity='must'`（可量化 + 有可核对证据 + ≥2 作品复现）
 *   ③ 技法参考   —— `style_rules.severity='normal'|'hint'`（定性特质，未被计数核对）
 *   ④ 范文       —— `style_samples`（L4 已写；本步只补负向硬线，不动范文）
 *
 * —— 分档口径（都写在这里，免得日后靠猜）——
 * ① **conflict 簇不进卡**：同维度互相矛盾的说法必须人工裁决（设计 §3.3「冲突不取一」），
 *    本步只把它们列进 `conflicts.jsonl` 的引用清单，不塞给模型。
 * ② **硬线 = 可量化 + 可核对 + 跨作品**：`liftTier==='lift'`（率比达标）且 `checks.ok ≥ 1`
 *    且 `support.works ≥ 2`。硬线是「碰了就错」那一档，没有量化证据不配。
 * ③ **技法 = 定性但被大量观测**：其余 `mismatch === 0` 的簇；有可核对条目的给 `normal`，
 *    全定性（`ok === 0`）的给 `hint`（设计 §2 闸门 3：「可信度上限低于可核对条目，应分档标注」）。
 * ④ **正例（`good`）取可核对的证据原句**（掩码后）；**反例（`bad`）本步不生成**——
 *    反例要的是「对照作者表达**同一功能**的写法」，需要语义对齐，不是本步能可靠自动化的；
 *    设计也警示过题材不同时 `bad` 会退化成「题材反例」。已在报告「未做项」写明。
 *    替代做法：规则正文里带上**对照值**（本作者 X/万字 vs 同题材对照 Y/万字），
 *    这比一个来路不明的反例更可证伪（设计 §3.6「转译必须给对照值」同一条道理）。
 * ⑤ **条数上限**：硬线 ≤ 15、技法 ≤ 40，按 `support.items` 降序取。超出的**计数并报告**，
 *    不静默丢——因为编译时预算是共享的（12000 字符），规则太多会把范文挤没。
 * ⑥ **幂等**：本步写的规则 `source` 一律 `distill/<作者>/…`，重跑只替换这一批
 *    （卡上人工写的规则 `source=''` 不动）；provenance 记在 `profile_json.distill` 里
 *    （对象不是字符串，不会被 `profileLines` 注入提示词）。
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const mask = require('./mask');
const fp = require('./fingerprint');
const llm = require('./llm');
const map = require('./map');
const l3mod = require('./l3');

const REPO_ROOT = path.resolve(__dirname, '../..');
// 分档上限。**硬线 15 → 100（2026-09-14 委托方指示）**：15 那版是「一张卡塞不下太多硬约束」的
// 保守起手值，实测在白石/青崖上顶死了——各丢掉 41/26 条本该进卡的簇，且丢的原因是计数上限、
// 不是质量（闸门已全部通过）。抬到 100 后这两张卡的硬线 15→56 / 15→41。
// ⚠ 副作用（必须一起看）：卡一变长，`compileCardsText` 的 12000 字符预算（providers/style.js
// STYLE_BUDGET_CHARS）就会触发降级，先丢范文再丢技法——卡内内容与注入内容不是一回事。
const RULE_CAPS = { must: 100, technique: 40 };
const RULE_SOURCE_PREFIX = 'distill/';
const PROFILE_KEYS = ['stance', 'sentence', 'diction', 'psychology', 'dialogue', 'narrative', 'warning'];
const TITLE_MAX = 60;
const TRAIT_MAX = 80;
const MASK_ARTIFACT_RE = /占位符|方括号|〔|\〕/;

/** 人设节必须带的两条负向硬线（设计 §3.5，两条缺一不可）——由代码追加，不靠模型自觉。 */
const NEGATIVE_HARD_LINES = [
  '禁止使用参照作品中的任何人物名、地名、势力名、功法名。',
  '范文中的〔人名〕〔地名〕〔势力〕〔功法〕是占位符，写作时必须替换为本书的真实名称，不得原样输出。',
];

/** 读 L3 产物（clusters / conflicts / summary）。 */
function readL3({ dataRoot, author }) {
  const dir = l3mod.l3Dir(dataRoot, author);
  const clusters = l3mod.readJsonl(path.join(dir, 'clusters.jsonl'));
  const conflicts = l3mod.readJsonl(path.join(dir, 'conflicts.jsonl'));
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch { /* 可缺 */ }
  return { dir: dir, clusters: clusters, conflicts: conflicts, summary: summary };
}

/**
 * 方向对立的量化词对：用于判断 conflict 标记是否**确有互相否定**。
 * 只用频度/密度类词——「多/少」「长/短」这类单字对在风格文本里太常见
 * （「多用长句」与「段落短」并不矛盾），会产生大量误判，故不收。
 */
const DIRECTION_PAIRS = [
  ['高频', '少量'], ['高频', '极少'], ['大量', '少量'], ['大量', '极少'],
  ['频繁', '罕见'], ['频繁', '极少'], ['常用', '极少'], ['常常', '偶尔'], ['经常', '偶尔'],
];

/** 簇的措辞里有没有「我在说两种说法打架」的自述词（有 → 天然不适合当规则正文）。 */
const CONFLICT_SELF_REPORT_RE = /冲突|矛盾|不一致|不统一|存在分歧|自相抵触/;

/**
 * 这条簇**像不像真的冲突**：跨变体方向对立，或某条措辞内部同时出现对立词。
 * 判据只看词面，不看语义——宁可判成冲突（不进卡、送人工）也不猜。
 */
function looksConflicting(g) {
  const variants = (g.variants || []).map((v) => String(v));
  const texts = [String(g.trait || '')].concat(variants);
  // 标了冲突却没给 variants：无从核对，按真冲突处理（保守方向 = 不进卡）
  if (!variants.length) return true;
  if (texts.some((t) => CONFLICT_SELF_REPORT_RE.test(t))) return true;
  if (texts.some((t) => DIRECTION_PAIRS.some(([a, b]) => t.includes(a) && t.includes(b)))) return true;
  return DIRECTION_PAIRS.some(([a, b]) =>
    variants.some((v) => v.includes(a)) && variants.some((v) => v.includes(b)));
}

/**
 * 分档：must / normal / hint，或 null（不进卡）。
 *
 * conflict 分两种处理（2026-09-13 实测补丁）：**真冲突**（措辞里确有方向对立或自述「冲突」）
 * 不进卡，只列人工裁决清单；但 reduce 会把「同维度的不同侧面」也标成 conflict
 * （实测：溪上老翁 3 个簇全被误标，L5 一路排除 → 整张卡 0 条规则，258 万字语料的产出被白白丢掉），
 * 故对「标了 conflict 但看不出对立」的簇**降档为技法（hint）**保留进卡，
 * 并在 provenance 里记 `conflictsDowngraded` 供人工复核——不选边，也不整簇丢证据。
 */
function classifyCluster(g) {
  if (!g || !g.trait) return { tier: null, why: 'empty-trait' };
  const checks = g.checks || {};
  const support = g.support || {};
  if (g.conflict) {
    if (looksConflicting(g)) return { tier: null, why: 'conflict' };
    if ((support.works || 0) < 2) return { tier: null, why: 'conflict-single-work' };
    return { tier: 'hint', why: 'conflict-downgraded' };
  }
  if ((checks.mismatch || 0) > 0) return { tier: null, why: 'count-mismatch' };
  if ((support.works || 0) < 2) return { tier: null, why: 'single-work' };
  if (g.liftTier === 'lift' && (checks.ok || 0) >= 1) return { tier: 'must', why: 'lift+checked' };
  if (g.liftTier === 'qualitative' || g.liftTier === 'lift') {
    return { tier: (checks.ok || 0) >= 1 ? 'normal' : 'hint', why: g.liftTier };
  }
  return { tier: null, why: 'weak-lift' };   // contrast-zero / below-min-count
}

/** 规则标题：维度 + 特质前段（注入时是「标题：正文」，标题必须自解释且不超 60 字）。 */
function ruleTitle(g) {
  const head = String(g.trait).split(/[，。；：、（]/)[0].trim();
  const base = `${g.dim}·${head}`;
  return Array.from(base).length <= TITLE_MAX ? base : Array.from(base).slice(0, TITLE_MAX - 1).join('') + '…';
}

/** 规则正文：特质 + 对照值（可证伪）+ 观察到的 marker。 */
function ruleText(g) {
  const parts = [String(g.trait).trim()];
  const rate = g.rate;
  if (rate && Number.isFinite(rate.targetRate) && Number.isFinite(rate.contrastRate)) {
    parts.push(`（每万汉字出现 ${rate.targetRate.toFixed(2)} 次，同题材对照作者 ${rate.contrastRate.toFixed(2)} 次——` +
      `${rate.targetCount} vs ${rate.contrastCount} 次）`);
  }
  const markers = (g.markers || []).filter((m) => m && String(m).trim()).slice(0, 3);
  if (markers.length) parts.push(`典型标记：${markers.join('、')}`);
  return parts.join(' ');
}

/** 正例：优先取「计数可核对」的那条证据原句（掩码后）。 */
function goodExample(g) {
  const items = g.items || [];
  const hit = items.find((it) => it.check === 'ok' && it.evidence) || items.find((it) => it.evidence);
  return hit ? String(hit.evidence).trim() : '';
}

/**
 * 簇 → 规则行（含上限与丢弃计数）。
 * @returns {{rules:Array, dropped:Array, excluded:Array, downgraded:Array}}
 *   downgraded = 被 reduce 误标 conflict、经复核看不出对立而降档进卡的簇（供人工复核）
 */
function buildRules(clusters, opts) {
  const o = opts || {};
  const caps = o.caps || RULE_CAPS;
  const sorted = [...clusters].sort((a, b) => ((b.support || {}).items || 0) - ((a.support || {}).items || 0));
  const rules = [];
  const dropped = [];
  const excluded = [];
  const downgraded = [];
  const used = { must: 0, technique: 0 };
  sorted.forEach((g, idx) => {
    const c = classifyCluster(g);
    if (!c.tier) { excluded.push({ dim: g.dim, why: c.why, trait: g.trait }); return; }
    const bucket = c.tier === 'must' ? 'must' : 'technique';
    if (used[bucket] >= (bucket === 'must' ? caps.must : caps.technique)) {
      dropped.push({ dim: g.dim, tier: c.tier, why: 'over-cap', trait: g.trait, items: (g.support || {}).items || 0 });
      return;
    }
    used[bucket]++;
    if (c.why === 'conflict-downgraded') {
      downgraded.push({ dim: g.dim, trait: g.trait, variants: g.variants || [], note: 'reduce 标记 conflict 但措辞看不出方向对立，按技法进卡待人工复核' });
    }
    rules.push({
      category: g.dim,
      title: ruleTitle(g),
      rule: ruleText(g),
      good: goodExample(g),
      severity: c.tier,
      source: `${RULE_SOURCE_PREFIX}${o.author || '?'}/${g.dim}#${idx}`,
      sortOrder: bucket === 'must' ? used.must - 1 : 100 + used.technique - 1,
      trait: String(g.trait).slice(0, TRAIT_MAX),
      liftTier: g.liftTier || '',
      support: g.support || {},
      checkOk: (g.checks || {}).ok || 0,
      rate: g.rate || null,
    });
  });
  return { rules: rules, dropped: dropped, excluded: excluded, downgraded: downgraded };
}

// ---------- 分布转译（§3.6：输入必须是分布，不是均值摘要） ----------

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * 目标作者的分布画像：句长 P25/P50/P75/P90（句级）、段长与单句成段（块级）、
 * 对话占比、标点谱（每万汉字）。
 */
function distributionProfile({ corpusRoot, author, dataRoot }) {
  const files = util.readCorpus(corpusRoot).filter((f) => f.author === author);
  if (!files.length) throw new Error(`L5：语料 ${corpusRoot} 下没有 author=${author} 的文件`);
  const dict = mask.loadDict(author, dataRoot);
  const byWork = new Map();
  for (const f of files) {
    if (!byWork.has(f.work)) byWork.set(f.work, []);
    byWork.get(f.work).push(f);
  }
  const sentLens = [];
  const blockSl = [];
  const blockPl = [];
  const punctCounts = new Array(fp.PUNCT_LABELS.length).fill(0);
  let blockSingle = [];
  let dialogHan = 0;
  let hanTotal = 0;
  let blocks = 0;
  for (const [, wf] of byWork) {
    const text = mask.maskText(wf.map((f) => util.stripChapterTitles(util.readUtf8(f.file))).join('\n'), dict);
    for (const s of fp.splitSentences(text)) {
      const n = util.han(s);
      if (n > 0) sentLens.push(n);
    }
    fp.PUNCTS.forEach((re, i) => { punctCounts[i] += (text.match(re) || []).length; });
    hanTotal += util.han(text);
    const paras = fp.validParagraphs(text);
    blocks += 1;
    // 块级特征（400 字块，与 L4 选样同尺度）
    for (const c of util.slidingChunks(text, { size: util.L1_CHUNK_SIZE, step: util.L1_CHUNK_SIZE })) {
      const f = fp.featOf(c.text);
      if (!f) continue;
      blockSl.push(f.sl);
      blockPl.push(f.pl);
      blockSingle.push(f.single);
    }
    const inQ = [...text.matchAll(/“([^”]{0,2000})”/g)].reduce((s, m) => s + util.han(m[1]), 0);
    dialogHan += inQ;
  }
  const sortedSent = [...sentLens].sort((a, b) => a - b);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  const spectrum = fp.PUNCT_LABELS.map((label, i) => ({
    label: label,
    per10k: hanTotal ? +(punctCounts[i] / hanTotal * 10000).toFixed(2) : 0,
  })).sort((a, b) => b.per10k - a.per10k);
  return {
    author: author,
    files: files.length,
    han: hanTotal,
    fileBlocks: blocks,
    sentences: sortedSent.length,
    sentenceLen: {
      p25: +percentile(sortedSent, 0.25).toFixed(2),
      p50: +percentile(sortedSent, 0.50).toFixed(2),
      p75: +percentile(sortedSent, 0.75).toFixed(2),
      p90: +percentile(sortedSent, 0.90).toFixed(2),
      mean: +mean(sortedSent).toFixed(2),
      sd: +sd(sortedSent).toFixed(2),
    },
    blockSentenceLen: { mean: +mean(blockSl).toFixed(2), sd: +sd(blockSl).toFixed(2) },
    paragraphLen: { p25: +percentile([...blockPl].sort((a, b) => a - b), 0.25).toFixed(2), p50: +percentile([...blockPl].sort((a, b) => a - b), 0.50).toFixed(2) },
    singleSentenceParagraphPct: +mean(blockSingle).toFixed(2),
    dialogPct: hanTotal ? +(dialogHan / hanTotal * 100).toFixed(2) : 0,
    punctTop5: spectrum.slice(0, 5),
    punctBottom3: spectrum.slice(-3),
    blocksSampled: blockSl.length,
  };
}

function profileBrief(p) {
  return [
    `句长（汉字/句）P25 ${p.sentenceLen.p25}｜P50 ${p.sentenceLen.p50}｜P75 ${p.sentenceLen.p75}｜P90 ${p.sentenceLen.p90}` +
      `｜均值 ${p.sentenceLen.mean}｜标准差 ${p.sentenceLen.sd}（共 ${p.sentences} 句）`,
    `单句成段占比 ${p.singleSentenceParagraphPct}%｜段长（汉字/段）P25 ${p.paragraphLen.p25}｜P50 ${p.paragraphLen.p50}`,
    `对话占比 ${p.dialogPct}%（引号内汉字 ÷ 全文汉字）`,
    `标点谱（每万汉字）由高到低前 5：${p.punctTop5.map((x) => `${x.label} ${x.per10k}`).join('｜')}`,
    `最低 3 项：${p.punctBottom3.map((x) => `${x.label} ${x.per10k}`).join('｜')}`,
  ].join('\n');
}

const PERSONA_SYSTEM_PROMPT = [
  '你在为写作模型准备一份「我该怎么写」的文风自述（persona）与七行文风标签（profile）。',
  '输入是一位作家与一位同题材对照作家在同一套口径下实测的统计分布，以及语料蒸馏出的可量化特质。',
  '',
  '写法要求（违反任一即不合格）：',
  '1. **以描述文风本身的口吻写**，不要元话语：禁止出现「分析师」「本次对比」「统计分布」「数据显示」',
  '   这类词；禁止出现任何作家名、书名、书名号《》，只描述文风。',
  '2. 只许使用给定的数字，**不得编造**任何数字、比例；每个数字都要能在输入里找到。',
  '2b. 引用数字必须连**它自己的标签**一起说（「省略号 77.82/万字」「句长中位 14 字」），',
  '    不得把某个指标的数字安到另一个指标上（那是错的，比编数字更糟）。',
  '3. 必须**可证伪**：说清「多长/多短/多密/有没有」，禁止「文笔优美」「引人入胜」这类空话。',
  '4. 用对照数值说明高低（同一单位）：如「句长中位 14 字，短于同题材对照的 12 字」。',
  '5. 写成**自我要求**的口吻（「我多用短句独立成段」），不要写成测量报告（「占比达 77.58%」）。',
  '6. 禁止复述情节、人物、设定；禁止出现具体人名/地名/功法名。',
  '7. 字符串里不得出现未转义的双引号（引用标点用中文引号「」“”）。',
  '',
  '字段要求：',
  '- persona：3~5 句，80~400 字，至少引用 3 个给定数字，覆盖句长/段落/标点/对话中的至少三项。',
  '- profile：七行短标签（stance 立场、sentence 句式、diction 用词、psychology 心理、dialogue 对话、',
  '  narrative 叙述、warning 警示），**每行不超过 40 字**，直接写成写作要求，不要写对比叙述。',
  '',
  '输出格式：只输出一个 JSON 对象：',
  '{"persona":"…","profile":{"stance":"…","sentence":"…","diction":"…","psychology":"…","dialogue":"…","narrative":"…","warning":"…"}}',
  '不要 markdown 代码块，不要解释文字。',
].join('\n');

function buildPersonaPrompt({ author, contrastAuthor, target, contrast, rules }) {
  const lines = [
    `【目标作家】${author}`,
    '【目标作家分布】',
    profileBrief(target),
    '',
    `【同题材对照作家】${contrastAuthor}`,
    '【对照作家分布】',
    contrast ? profileBrief(contrast) : '（无对照数据）',
    '',
    '【可量化特质（来自语料蒸馏，已过复现/率比/计数核对三道闸门）】',
  ];
  const quant = rules.filter((r) => r.liftTier === 'lift').slice(0, 12);
  if (!quant.length) lines.push('（无）');
  quant.forEach((r, i) => lines.push(`${i + 1}. [${r.category}] ${r.trait}${r.rate ? `（本作者 ${r.rate.targetRate.toFixed(2)}/万字 vs 对照 ${r.rate.contrastRate.toFixed(2)}/万字）` : ''}`));
  lines.push('');
  lines.push('现在只输出那一个 JSON 对象。');
  return lines.join('\n');
}

/** 兜底人设（LLM 两次都不合格时用代码生成，绝不让管线卡住）。 */
function fallbackPersona({ author, target }) {
  const t = target.sentenceLen;
  return {
    persona: `${author}的句子以${t.p50}字上下为主（P25 ${t.p25}／P75 ${t.p75}），标准差 ${t.sd} 说明长短交错；` +
      `单句成段占 ${target.singleSentenceParagraphPct}%，对话占比 ${target.dialogPct}%。` +
      '（本条为代码兜底描述：人设转译调用未通过校验，故只给可在分布里查到的数字。）',
    profile: {
      sentence: `句长中位 ${t.p50} 字，P90 ${t.p90} 字，标准差 ${t.sd}`,
      dialogue: `对话占全文 ${target.dialogPct}%`,
      narrative: `单句成段 ${target.singleSentenceParagraphPct}%`,
      warning: '仅按上方统计分布落笔，不得编造分布之外的比例。',
    },
  };
}

// 元话语与作品指向：persona 是「我该怎么写」，出现这些说明模型在写分析报告而不是文风自述
const META_VOICE_RE = /分析师|本次对比|统计分布|数据显示|对比《|《[^》]{1,20}》|数据来源/;
const PROFILE_LINE_MAX = 40;
const PERSONA_MIN = 80;
const PERSONA_MAX = 400;
const MIN_CITED_NUMBERS = 3;

/**
 * 输入里出现过的数字白名单，用于「不许编造数字」的自动核对：
 *  - `exact`：字符串集合，含 ±3 位舍入变体与 ×100 / ÷100 单位改写变体（0.29 ↔ 29%）；
 *  - `values`：输入原文的数值，供相对容差比对用。
 *
 * 为什么要留 `values` 而不是只查字符串集合：纯字符串查表会把「0.33」这类数字
 * 通过 `Math.round` 塌缩到 0 而误判为可溯源（2026-09-13 实测有一次真实产出
 * 把省略号的 77.82/万字写成了 0.33/万字，就是从这个洞漏过去的）。容差用
 * **相对值**（0.5%），不设绝对下限使得小数塌缩成 0。
 */
function allowedNumbers(texts) {
  const exact = new Set();
  const values = [];
  for (const t of texts) {
    for (const m of String(t).match(/\d+(?:\.\d+)?/g) || []) {
      const n = Number(m);
      if (!Number.isFinite(n)) continue;
      values.push(n);
      for (const v of [n, n * 100, n / 100]) {
        if (!Number.isFinite(v)) continue;
        exact.add(String(v));
        for (const d of [0, 1, 2, 3]) exact.add(v.toFixed(d));
      }
    }
  }
  return { exact: exact, values: values };
}

/** persona 里出现的、无法在输入中找到来源的数字（编造嫌疑）。 */
function untraceableNumbers(text, allowed) {
  const a = allowed || {};
  const exact = a.exact instanceof Set ? a.exact : (a instanceof Set ? a : new Set());
  const values = Array.isArray(a.values) ? a.values : [];
  const near = (n) => values.some((v) => {
    for (const cand of [v, v * 100, v / 100]) {
      if (!Number.isFinite(cand)) continue;
      const tol = Math.max(1e-9, Math.abs(cand) * 0.005);   // 相对 0.5%：够容忍改写，不致小数塌缩到 0
      if (Math.abs(cand - n) <= tol) return true;
    }
    return false;
  });
  const out = [];
  for (const m of String(text).match(/\d+(?:\.\d+)?/g) || []) {
    if (exact.has(m)) continue;
    const n = Number(m);
    if (Number.isInteger(n) && n >= 0 && n <= 12) continue;   // 「3 句」「5 类」这类结构计数不算编造
    if (near(n)) continue;
    out.push(m);
  }
  return out;
}

/** 不合格项 → 给模型看的中文说明（重试时反馈；英文 slug 模型不一定看得懂）。 */
const PROBLEM_HINTS = {
  'json-unparsable': '输出不是合法 JSON（只输出那一个 JSON 对象，不要代码块）',
  'persona-too-short': 'persona 太短（要 80~400 字）',
  'persona-too-long': 'persona 太长（要 80~400 字）',
  'persona-too-few-numbers': 'persona 引用的数字少于 3 个',
  'mask-artifact': '出现了〔方括号〕或「占位符」这类掩码残留，禁止出现',
  'chapter-mark': '出现了「第 X 章」「本章完」这类原文标记，禁止出现',
  'meta-voice': '出现了元话语（分析师/本次对比/统计分布/数据显示/书名号），要直接描述文风本身',
  'proper-name': '出现了具体专名（人名/地名/功法名），一律换成形态描述',
  'banned-word': '出现了作家名或书名，只描述文风，不许提是谁',
  'profile-empty': 'profile 七行不能全空',
};
function problemHint(p) {
  const s = String(p);
  if (PROBLEM_HINTS[s]) return PROBLEM_HINTS[s];
  const head = s.split(':')[0];
  if (head === 'invented-number') return `${s.slice(head.length + 1)} 里的数字不在给定数据中，只能用上面给出的数字`;
  if (head === 'profile-too-long') return `profile 的 ${s.split(':')[1]} 行超过 40 字，压缩到 40 字内`;
  if (head === 'profile-mask-artifact') return `profile 的 ${s.split(':')[1]} 行有掩码残留`;
  if (head === 'profile-meta-voice') return `profile 的 ${s.split(':')[1]} 行是元话语，改成直接的写法要求`;
  if (head === 'profile-invented-number') return `profile 的 ${s.split(':')[1]} 行有编造数字`;
  if (head === 'profile-banned-word') return `profile 的 ${s.split(':')[1]} 行出现了作家名/书名`;
  return s;
}

/**
 * 人设输出校验：可证伪、无掩码残留、无专名、无元话语、**数字可溯源**、长度合理。
 * @param {{persona:string, profile:Object}} parsed
 * @param {{names?:Array, allowedNumbers?:Set, banned?:Array<string>}} ctx
 *        allowedNumbers 由 allowedNumbers(输入全体) 生成；banned = 作家名/对照作家名
 */
function validatePersona(parsed, ctx) {
  const c = ctx || {};
  const problems = [];
  const persona = parsed && typeof parsed.persona === 'string' ? parsed.persona.trim() : '';
  if (persona.length < PERSONA_MIN) problems.push('persona-too-short');
  if (persona.length > PERSONA_MAX) problems.push('persona-too-long');
  if ((persona.match(/\d+(?:\.\d+)?/g) || []).length < MIN_CITED_NUMBERS) problems.push('persona-too-few-numbers');
  if (MASK_ARTIFACT_RE.test(persona)) problems.push('mask-artifact');
  if (/(第\s*\d+\s*章|本章完)/.test(persona)) problems.push('chapter-mark');
  if (META_VOICE_RE.test(persona)) problems.push('meta-voice');
  const untraceable = untraceableNumbers(persona, c.allowedNumbers);
  if (untraceable.length) problems.push('invented-number:' + untraceable.slice(0, 3).join('/'));
  for (const b of c.banned || []) if (b && persona.includes(b)) { problems.push('banned-word:' + b); break; }
  for (const n of c.names || []) if (persona.includes(n)) { problems.push('proper-name:' + n); break; }
  const prof = (parsed && parsed.profile) || {};
  const cleanProfile = {};
  for (const k of PROFILE_KEYS) {
    const v = typeof prof[k] === 'string' ? prof[k].trim() : '';
    if (!v) continue;   // 允许留空（人设节本来就短）
    if (Array.from(v).length > PROFILE_LINE_MAX) problems.push(`profile-too-long:${k}`);
    if (MASK_ARTIFACT_RE.test(v)) problems.push(`profile-mask-artifact:${k}`);
    if (META_VOICE_RE.test(v)) problems.push(`profile-meta-voice:${k}`);
    if (untraceableNumbers(v, c.allowedNumbers).length) problems.push(`profile-invented-number:${k}`);
    for (const b of c.banned || []) if (b && v.includes(b)) { problems.push(`profile-banned-word:${k}`); break; }
    cleanProfile[k] = v;
  }
  if (!Object.keys(cleanProfile).length) problems.push('profile-empty');
  return { ok: problems.length === 0, problems: problems, persona: persona, profile: cleanProfile };
}

/** 一次人设转译调用（含一次纠错重试）。 */
async function translatePersona({ author, contrastAuthor, target, contrast, rules, names, provider, model, timeoutMs, fetchImpl, log, apiKey }) {
  const p = llm.providerOf(provider || 'stepfun');
  const key = apiKey || (p.multiKey ? llm.resolveApiKeys(p.name)[0] : llm.resolveApiKey());
  const mdl = model || p.defaultModel;   // 不传 model 时必须落到渠道默认模型（否则 HTTP 404 model_invalid）
  const prompt = buildPersonaPrompt({ author, contrastAuthor, target, contrast, rules });
  // 数字可溯源核对：白名单只由**输入**生成（含分布行与特质里的每万汉字率）；
  // 作家名/对照作家名一律禁出现在 persona（防止「像某作家」式元话语）。
  const allowed = allowedNumbers([prompt]);
  const banned = [author, contrastAuthor].filter(Boolean);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent = attempt === 0 ? prompt
      : prompt + `\n\n【上一次不合格，逐条改掉后重新输出那一个 JSON 对象】\n`
        + (last && last.problems || []).map((x) => '- ' + problemHint(x)).join('\n');
    const b = map.buildBody({
      provider: p, model: mdl, maxTokens: map.MAX_TOKENS,
      messages: [{ role: 'system', content: PERSONA_SYSTEM_PROMPT }, { role: 'user', content: userContent }],
    });
    const res = await llm.chatJson({ apiKey: key, body: b, fetchImpl: fetchImpl, timeoutMs: timeoutMs, provider: p });
    const parsed = map.extractJson(res.content);
    if (!parsed) {
      last = { problems: ['json-unparsable'], raw: String(res.content || '').slice(0, 400) };
      if (log) log(`[l5] 人设转译第 ${attempt + 1} 次 JSON 不可解析，原文前 200 字：${last.raw.slice(0, 200)}`);
      continue;
    }
    const v = validatePersona(parsed, { names: names, allowedNumbers: allowed, banned: banned });
    if (v.ok) {
      return {
        persona: v.persona + '\n' + NEGATIVE_HARD_LINES.join('\n'),
        profile: v.profile, problems: [], usage: res.usage || null, attempts: attempt + 1,
      };
    }
    last = { problems: v.problems, raw: String(res.content || '').slice(0, 400) };
    if (log) {
      log(`[l5] 人设转译第 ${attempt + 1} 次不合格：${v.problems.join(',')}`);
      log(`[l5]   原文前 200 字：${String(res.content || '').replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  if (log) log(`[l5] ⚠ 人设转译两次不合格（${(last && last.problems || []).join(',')}）→ 用代码兜底描述`);
  const fb = fallbackPersona({ author: author, target: target, contrastAuthor: contrastAuthor });
  return {
    persona: fb.persona + '\n' + NEGATIVE_HARD_LINES.join('\n'),
    profile: fb.profile, problems: (last && last.problems) || ['unknown'], usage: null, attempts: 2, fallback: true,
  };
}

/**
 * 跑一位作者的 L5：读 L3 簇 → 分档 → 分布转译 → 写卡（人设/指纹/规则）。
 * 范文由 L4 负责（本步不动 `style_samples`）。
 */
async function runL5(o) {
  if (!o || typeof o !== 'object' || !o.author || !o.db) {
    throw new Error('runL5: 参数必须是选项对象 { corpusRoot, author, db, ... }');
  }
  const dataRoot = o.dataRoot || REPO_ROOT;
  const log = o.log || (() => {});
  const write = o.write !== false;
  const author = o.author;
  const built = readL3({ dataRoot: dataRoot, author: author });
  const dir = built.dir;
  if (!fs.existsSync(path.join(dir, 'clusters.jsonl'))) {
    throw new Error(`L5：找不到 ${path.join(dir, 'clusters.jsonl')}（先跑 l3）`);
  }
  const ruleset = buildRules(built.clusters, { author: author });
  log(`[l5] ${author} L3 簇 ${built.clusters.length} → 硬线 ${ruleset.rules.filter((r) => r.severity === 'must').length} 条` +
    ` / 技法 ${ruleset.rules.filter((r) => r.severity !== 'must').length} 条` +
    `｜超上限丢弃 ${ruleset.dropped.length}｜不达标排除 ${ruleset.excluded.length}` +
    `（冲突 ${built.conflicts.length} 条待人工裁决）`);

  const target = distributionProfile({ corpusRoot: o.corpusRoot, author: author, dataRoot: dataRoot });
  const contrastAuthor = o.contrastAuthor || null;
  const contrast = contrastAuthor ? distributionProfile({ corpusRoot: o.corpusRoot, author: contrastAuthor, dataRoot: dataRoot }) : null;

  const dict = mask.loadDict(author, dataRoot);
  const names = [...new Set(((dict.entries) || []).map((e) => e.name))];
  const personaRes = (await translatePersona({
    author: author, contrastAuthor: contrastAuthor, target: target, contrast: contrast, rules: ruleset.rules,
    names: names, provider: o.provider, model: o.model, timeoutMs: o.timeoutMs, fetchImpl: o.fetchImpl, log: log,
    apiKey: o.apiKey,
  }));

  const packName = o.packName || author;
  const pack = o.db.get("SELECT * FROM style_packs WHERE name = ? AND kind = 'imprint' ORDER BY id LIMIT 1", [packName]);
  if (!pack) throw new Error(`L5：找不到印记卡「${packName}」（先跑 samples 建卡与范文）`);

  const profileJson = Object.assign({}, personaRes.profile, {
    distill: {
      generatedAt: new Date().toISOString(),
      maskDictVersion: dict.version || '',
      clustersIn: built.clusters.length,
      rules: { must: ruleset.rules.filter((r) => r.severity === 'must').length, technique: ruleset.rules.filter((r) => r.severity !== 'must').length },
      droppedOverCap: ruleset.dropped.length,
      excluded: ruleset.excluded.length,
      conflicts: built.conflicts.length,
      conflictsDowngraded: ruleset.downgraded.length,
      conflictDowngrades: ruleset.downgraded.map((d) => ({ dim: d.dim, trait: d.trait, variants: d.variants })),
      personaFallback: Boolean(personaRes.fallback),
      distribution: {
        sentenceLen: target.sentenceLen, singleSentenceParagraphPct: target.singleSentenceParagraphPct,
        dialogPct: target.dialogPct, punctTop5: target.punctTop5,
      },
      contrastAuthor: contrastAuthor,
    },
  });
  const result = {
    author: author, packId: pack.id, packName: packName,
    rules: ruleset.rules, dropped: ruleset.dropped, excluded: ruleset.excluded,
    downgraded: ruleset.downgraded,
    conflicts: built.conflicts, persona: personaRes.persona, profile: personaRes.profile,
    personaProblems: personaRes.problems, personaFallback: Boolean(personaRes.fallback),
    personaAttempts: personaRes.attempts, target: target, contrast: contrast,
  };
  if (!write) return result;

  const note = `P8 蒸馏生成：L3 簇 ${built.clusters.length} → 硬线 ${result.rules.filter((r) => r.severity === 'must').length}` +
    ` / 技法 ${result.rules.filter((r) => r.severity !== 'must').length}；冲突 ${built.conflicts.length} 条待人工裁决` +
    (result.downgraded.length ? `（其中 ${result.downgraded.length} 条经复核看不出对立，已按技法进卡待复核）` : '') +
    `；词表 ${dict.version || '?'}；重跑会覆盖 source 以 ${RULE_SOURCE_PREFIX} 开头的规则`;
  o.db.run("UPDATE style_packs SET persona = ?, profile_json = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [personaRes.persona, JSON.stringify(profileJson), note.slice(0, 500), pack.id]);
  const deleted = o.db.run('DELETE FROM style_rules WHERE pack_id = ? AND source LIKE ?', [pack.id, RULE_SOURCE_PREFIX + '%']).changes;
  for (const r of ruleset.rules) {
    o.db.run(
      `INSERT INTO style_rules (pack_id, category, title, trigger, rule, good, bad, severity, source, sort_order, enabled)
       VALUES (?, ?, ?, '', ?, ?, '', ?, ?, ?, 1)`,
      [pack.id, r.category, r.title, r.rule, r.good, r.severity, r.source, r.sortOrder]
    );
  }
  result.deletedRules = deleted;
  result.writtenRules = ruleset.rules.length;
  log(`[l5] ${author} → 卡 #${pack.id}「${packName}」写入人设（${result.personaFallback ? '代码兜底' : 'LLM 转译'}，${personaRes.attempts} 次尝试）` +
    `与规则 ${ruleset.rules.length} 条（覆盖旧 ${deleted} 条）`);
  return result;
}

module.exports = {
  REPO_ROOT, RULE_CAPS, RULE_SOURCE_PREFIX, PROFILE_KEYS, NEGATIVE_HARD_LINES, PERSONA_SYSTEM_PROMPT,
  PROFILE_LINE_MAX, PERSONA_MIN, PERSONA_MAX, MIN_CITED_NUMBERS,
  readL3, classifyCluster, looksConflicting, DIRECTION_PAIRS, ruleTitle, ruleText, goodExample, buildRules,
  percentile, distributionProfile, profileBrief, fallbackPersona,
  allowedNumbers, untraceableNumbers, validatePersona,
  translatePersona, runL5,
};
