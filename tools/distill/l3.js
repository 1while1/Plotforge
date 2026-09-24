'use strict';
/**
 * L3 驱动：`map-relaxed/` → 闸门 3/4（逐条精确）→ 树状 reduce（语义合并）→ 闸门 1/2（簇上）→ 产物。
 *
 * 为什么读 `map-relaxed/` 而不是 `map/`（委托方指令 + report 09 §6.9/§6.10）：
 * 严格口径把两类**渠道侧**误杀算成了内容缺陷——StepFun 归一化空白、Agnes 写英文维度标签。
 * 放宽口径按确定性规则把它们收回（留 `relaxed` 痕），证据量 19,928 → 26,462 条（+32.8%）。
 * 下游（L3/L4/L5）一律读放宽口径；严格口径只作对照。
 *
 * 为什么闸门 1（复现）在 reduce **之后**：见 reduce.js 头部——字面 marker 相等不是「同一特质」，
 * 先分组会 99.5% 全灭（晚棠未开实测 1,434 组只过 8 组）。顺序：闸门 3/4 → reduce → 闸门 1/2。
 *
 * 产物（`data/corpus/src-<author>/l3/`）：
 *   summary.json   —— 阈值、逐闸门计数、按维度分布、语料/词典版本锚点、reduce 逐层台账
 *   clusters.jsonl —— 通过全部闸门的候选特质簇（含代码算的支撑、lift 分档、证据条目）
 *   dropped.jsonl  —— 丢弃条目 + 机器可读 reason（验收要求：日志能列出丢弃条目与原因）
 *   conflicts.jsonl—— conflict 簇（同维度互相矛盾的说法），人工裁决量口径
 *
 * 口径纪律：
 *  - 块文本一律「逐作品重切」（与 map/revalidate 同源）：跨作品拼接会移动块边界 → sha 全不匹配。
 *  - sha 不一致的行**跳过并计数**（词典换代后老行不参与），不做静默降级。
 *  - 闸门 4（证据包含性）在入库时已做，这里只**复检计数**：非零即告警（防上游换数据源）。
 *  - 闸门 3 判 mismatch 的条目不进 reduce（已判 hallucination，不再花钱），但**逐条进 dropped.jsonl**。
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const mask = require('./mask');
const gates = require('./gates');
const reduce = require('./reduce');

const REPO_ROOT = path.resolve(__dirname, '../..');

const mapRelaxedPath = (dataRoot, author, work) =>
  path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'map-relaxed', `${work}.jsonl`);
const l3Dir = (dataRoot, author) => path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'l3');
const countsCachePath = (dataRoot, author) => path.join(dataRoot, 'data', 'corpus', 'dict', `marker-counts-${author}.json`);

/** reduce 单次调用的输出预算与超时（覆盖用入参；两渠道同值，2026-09-13 修正）。 */
const REDUCE_MAX_TOKENS = 32000;
const REDUCE_TIMEOUT_MS = 600000;

/**
 * reduce 层单次调用的预算/超时（`--max-tokens` / `--timeout` 可覆盖）。
 *
 * **教训（同一个坑的第二次）**：参数必须在**真实尺度**上验收。StepFun 的 16000 是 map 阶段
 * （8,000 字块 → 输出 1~3k）实测定稿的，却被原样搬给 reduce 叶层——而叶层一批 150 条观测、
 * 输出大一个数量级：溪上老翁 11 批实测均值 **12,687 output token**（139,541/11，且全部通过），
 * 白石这种「一个 trait 拖着上百个 id」的池子单批就要 19k+ → 75 个叶批成片撞
 * `finish_reason=length`，每个截断批白烧一次满额输出、再拆成 2 批（不够还要再拆）——
 * 同一批数据算 3~7 次，日志里 52 行「输出截断 → 一分为二重算」即此。
 *
 * 探针实测（2026-09-13，`data/tmp-p8/probe-stepfun-maxtokens.js`，机械型长输出指令）：
 *   · `max_tokens=16000` → `completion_tokens` 恰好 16000、`finish_reason=length`（撞的是**我们的**参数）；
 *   · `max_tokens=32000` → `completion_tokens` 29161、`finish_reason=stop`（渠道允许 >16k 输出）。
 * 即「StepFun 只有 16k 输出」是误记，16k 是我们自己设的；Agnes 侧同值本来就取 32k。
 * 超时同理从 300s（map 定稿）抬到 600s：单次输出从 1~3k 涨到 12~20k，延迟成比例上涨，
 * 300s 会把本可成功的调用判死（失败还要连累重算）。
 */
function reduceBudget(overrides) {
  const o = overrides || {};
  return {
    maxTokens: Number.isInteger(o.maxTokens) && o.maxTokens > 0 ? o.maxTokens : REDUCE_MAX_TOKENS,
    timeoutMs: Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : REDUCE_TIMEOUT_MS,
  };
}

/** 读一层 JSONL（残行跳过；同 chunkIndex 后行覆盖前行，与 map.js::readDoneMap 同语义）。 */
function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 残行忽略 */ }
  }
  return out;
}

/**
 * 逐作品的「掩码文本 + 块」缓存。文本口径必须与 map.js/revalidateMap 逐字一致：
 * 同作品各分卷 stripChapterTitles 后以 '\n' 连接 → maskText → mapChunks。
 */
function buildWorkBlocks({ corpusRoot, author, dataRoot, log, corpus }) {
  const files = (corpus || util.readCorpus(corpusRoot)).filter((f) => f.author === author);
  if (!files.length) throw new Error(`L3：语料 ${corpusRoot} 下没有 author=${author} 的文件`);
  const dict = mask.loadDict(author, dataRoot);
  const byWork = new Map();
  for (const f of files) {
    if (!byWork.has(f.work)) byWork.set(f.work, []);
    byWork.get(f.work).push(f);
  }
  const out = new Map();
  for (const [work, wf] of byWork) {
    const t0 = Date.now();
    const text = wf.map((f) => util.stripChapterTitles(util.readUtf8(f.file))).join('\n');
    const masked = mask.maskText(text, dict);
    out.set(work, { work, topics: [...new Set(wf.map((f) => f.topic))], masked, chunks: util.mapChunks(masked) });
    if (log) log(`[l3] ${author}/${work} 掩码完成：${masked.length} 字 / ${out.get(work).chunks.length} 块（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
  return { dict, works: out };
}

/**
 * 闸门 3 + 闸门 4 复检：把一行的条目过一遍逐块核对。
 * 返回条目（带 countCheck / work / chunkIndex）与统计。
 */
function gateRowItems(row, chunkText, work) {
  const items = [];
  let evidenceMiss = 0;
  for (const raw of row.kept || []) {
    const it = {
      dim: raw.dim, trait: raw.trait, evidence: raw.evidence, count: raw.count,
      marker: gates.normalizeMarker(raw.marker),
      relaxed: raw.relaxed || null,
      work: work, chunkIndex: row.chunkIndex,
    };
    // 闸门 4 复检（入库时已过，这里只做「上游换过数据源」的 tripwire）
    if (it.evidence && chunkText.indexOf(it.evidence) === -1) evidenceMiss++;
    it.countCheck = gates.countCrossCheck(it, chunkText);
    items.push(it);
  }
  return { items, evidenceMiss };
}

/** 率表缓存键：语料文件清单 + 词典版本（两者任一变化都必须重算）。 */
function corpusKeyOf(files, dictVersion) {
  const parts = files.map((f) => `${f.rel}:${fs.statSync(f.file).size}`).sort();
  return util.sha256(`${dictVersion}\n${parts.join('\n')}`).slice(0, 16);
}

/**
 * marker 计数（目标语料 + 对照语料）。大文本用 Buffer.indexOf 逐 marker 扫，
 * 结果按 (语料 key, 词典版本) 缓存到 `data/corpus/dict/marker-counts-<author>.json`——
 * 首轮断点续算：缓存命中即复用，只补算缺失的 marker。
 * @returns {{chars:number, counts:Object, cacheHit:number, computed:number}}
 */
function markerCounts({ corpusText, corpusKey, cacheFile, markers, label, log }) {
  let cached = { key: null, chars: 0, counts: {} };
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.key === corpusKey && c.chars === corpusText.length) cached = c;
    } catch { /* 缓存坏了就当没有 */ }
  }
  const buf = Buffer.from(corpusText, 'utf8');
  const counts = cached.counts || {};
  let computed = 0;
  let cacheHit = 0;
  const t0 = Date.now();
  for (const m of markers) {
    if (Object.prototype.hasOwnProperty.call(counts, m)) { cacheHit++; continue; }
    counts[m] = gates.countOccurrencesInBuffer(buf, m);
    computed++;
    if (log && computed % 2000 === 0) log(`[l3] ${label} 计数中 ${computed}/${markers.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
  const out = { key: corpusKey, chars: corpusText.length, counts: counts };
  if (cacheFile && computed > 0) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out));
  }
  return { chars: corpusText.length, counts: counts, cacheHit: cacheHit, computed: computed };
}

/**
 * L3 主流程（async：中间有 LLM 合并）。
 * @param {{corpusRoot:string, author:string, dataRoot?:string, log?:Function, write?:boolean,
 *          useReduce?:boolean, reduceOpts?:Object, fetchImpl?:Function}} o
 */
async function runL3(o) {
  // 参数形状守卫：调用方若按 (root, opts) 传参会静默得到 author=undefined，
  // 报错现场落在「语料里没有这个作者」上（2026-09-13 CLI 接线时真的踩过），这里直接点名。
  if (typeof o === 'string' || !o || typeof o !== 'object') {
    throw new Error('runL3: 参数必须是选项对象 { corpusRoot, author, ... }（不是 (root, opts) 两参形式）');
  }
  const author = o.author;
  const dataRoot = o.dataRoot || REPO_ROOT;
  const log = o.log || (() => {});
  const write = o.write !== false;
  const useReduce = o.useReduce !== false;
  const corpusRoot = o.corpusRoot || path.join(dataRoot, 'data/corpus/clean/小说作品');
  const corpus = util.readCorpus(corpusRoot);
  const { dict, works } = buildWorkBlocks({ corpusRoot, author, dataRoot, log, corpus });

  // ---- 读行 + 闸门 3 ----
  const allItems = [];
  const rowStat = { rows: 0, stale: 0, worksWithoutMap: 0, evidenceMiss: 0 };
  const checks = { ok: 0, unverifiable: 0, mismatch: 0 };
  const hygiene = {};
  for (const [work, w] of works) {
    const rows = readJsonl(mapRelaxedPath(dataRoot, author, work));
    if (!rows.length) { rowStat.worksWithoutMap++; log(`[l3] ${author}/${work} 无 map-relaxed 行`); continue; }
    for (const row of rows) {
      const c = w.chunks[row.chunkIndex];
      if (!c || util.sha256(c.text) !== row.sha256) { rowStat.stale++; continue; }
      rowStat.rows++;
      const g = gateRowItems(row, c.text, work);
      rowStat.evidenceMiss += g.evidenceMiss;
      for (const it of g.items) {
        checks[it.countCheck.status] = (checks[it.countCheck.status] || 0) + 1;
        if (it.countCheck.reason && it.countCheck.status !== 'ok') hygiene[it.countCheck.reason] = (hygiene[it.countCheck.reason] || 0) + 1;
        allItems.push(it);
      }
    }
  }
  const mismatchItems = allItems.filter((it) => it.countCheck.status === 'mismatch');
  const feedItems = allItems.filter((it) => it.countCheck.status !== 'mismatch');
  log(`[l3] ${author} 闸门3：可核对 ok ${checks.ok}｜降档 ${checks.unverifiable}｜判死 ${checks.mismatch}（判死条目不进 reduce，逐条进 dropped）`);

  // ---- 约束 ①：每书先验裕度（由 block-margin-masked.js 产出；缺失即整作者禁用块级证据并告警） ----
  const marginFile = path.join(l3Dir(dataRoot, author), 'margins.json');
  let marginRows = [];
  let marginNote = null;
  if (fs.existsSync(marginFile)) {
    try { marginRows = JSON.parse(fs.readFileSync(marginFile, 'utf8')).works || []; } catch { marginNote = 'margins.json 解析失败'; }
  } else {
    marginNote = '未测（先跑 复现脚本/block-margin-masked.js）；按约束①保守处理：全部禁用块级证据';
  }
  const marginGate = gates.bookMarginGate(marginRows);
  const disabledWorks = marginNote ? new Set([...works.keys()]) : marginGate.disabled;

  // ---- 对照集（按题材分层：同题材作者用于闸门判定，跨题材只作诊断参考） ----
  const topicOf = new Map();
  for (const f of corpus) {
    if (!topicOf.has(f.author)) topicOf.set(f.author, new Set());
    topicOf.get(f.author).add(f.topic);
  }
  const myTopics = topicOf.get(author) || new Set();
  const others = [...topicOf.keys()].filter((a) => a !== author);
  const sameTopic = others.filter((a) => [...topicOf.get(a)].some((t) => myTopics.has(t)));
  const crossTopic = others.filter((a) => !sameTopic.includes(a));

  // ---- 树状 reduce（语义合并；支撑由代码按 id 回溯算） ----
  let red = null;
  let passed;
  let droppedRepro;
  let droppedLift;
  if (useReduce) {
    const t0 = Date.now();
    const budget = reduceBudget(o.reduceOpts);
    red = await reduce.reduceAuthor({
      items: feedItems, author: author, log: log,
      opts: Object.assign({ write: write, fetchImpl: o.fetchImpl, disabledWorks: disabledWorks,
        maxTokens: budget.maxTokens, timeoutMs: budget.timeoutMs }, o.reduceOpts || {}),
    });
    log(`[l3] ${author} reduce：叶 ${red.leafNodes} 批 → 簇 ${red.clusters.length}（${((Date.now() - t0) / 1000).toFixed(0)}s，token ${red.usage.input}/${red.usage.output}）`);
    if (red.failedCalls) log(`[l3] ⚠ ${author} reduce 有 ${red.failedCalls} 次调用失败（这些节点的条目已登记为 reduce-call-failed）`);
    // 降级（整层全败 → 用上一层的结果当簇集）必须显眼：这不是「跑完了」，是「跑残了但没丢作者」
    if (red.degradedAt != null) log(`[l3] ⚠⚠ ${author} reduce **降级**：L${red.degradedAt} 整层失败 → 簇集取自 L${red.degradedAt - 1}（summary.reduce.degradedAt=${red.degradedAt}）`);
    if (!red.clusters.length) log(`[l3] ⚠⚠ ${author} reduce 产出 0 簇——这是失败，不是「没有风格特征」（CLI 会以非零退出码暴露）`);
    // reduce 丢弃的条目（模型申报 + 代码补登）逐条进 dropped
    droppedRepro = red.dropped.map((d) => ({ stage: 'reduce', reason: d.reason, ids: d.ids, dim: null, marker: null }));
  } else {
    const repro = gates.reproduceGate(feedItems, { disabledWorks: disabledWorks });
    log(`[l3] ${author} 闸门1（无 reduce 的对照路径）：分组 ${repro.passed.length + repro.dropped.length}，通过 ${repro.passed.length}，丢弃 ${repro.dropped.length}`);
    passed = repro.passed;
    droppedRepro = repro.dropped.map((g) => ({ stage: 'reproduce', reason: g.reason, dim: g.dim, marker: g.marker, support: g.support, traits: g.traits }));
    droppedLift = [];
  }

  // ---- 闸门 2：lift（同题材对照）----
  const clusters = useReduce ? red.clusters : passed.map((g) => ({
    dim: g.dim, trait: (g.traits || [])[0], markers: [g.marker], support: g.support, checks: g.checks,
    items: g.items.map((it) => ({ trait: it.trait, marker: it.marker, evidence: it.evidence, count: it.count,
      work: it.work, chunkIndex: it.chunkIndex, relaxed: it.relaxed, check: it.countCheck.status })),
  }));
  const markerSet = [...new Set(clusters.flatMap((c) => (c.markers || []).filter((m) => gates.markerHygiene(m).ok)))].sort();
  log(`[l3] ${author} 需计数 marker ${markerSet.length} 个；同题材对照 [${sameTopic.join(',')}]，跨题材对照 [${crossTopic.join(',')}]`);

  const targetText = [...works.values()].map((w) => w.masked).join('\n');
  const targetKey = corpusKeyOf(corpus.filter((f) => f.author === author), dict.version);
  const tCounts = markerCounts({
    corpusText: targetText, corpusKey: targetKey, cacheFile: countsCachePath(dataRoot, author),
    markers: markerSet, label: `${author}(目标)`, log: log,
  });

  /** 把若干作者的掩码文本并起来计数（各自用己方词典掩码 —— 台账 §4.7 口径）。 */
  const contrastCounts = (authors, tag) => {
    const parts = [];
    const keyOf = {};
    for (const a of authors) {
      const af = corpus.filter((f) => f.author === a);
      const { dict: adict, works: aworks } = buildWorkBlocks({ corpusRoot, author: a, dataRoot, corpus: corpus, log: null });
      for (const w of aworks.values()) parts.push(w.masked);
      keyOf[a] = { key: corpusKeyOf(af, adict.version), file: countsCachePath(dataRoot, a) };
    }
    const text = parts.join('\n');
    const key = util.sha256(`${tag}|${authors.map((a) => keyOf[a].key).join('|')}`).slice(0, 16);
    const cacheFile = authors.length === 1 ? keyOf[authors[0]].file : null;
    return markerCounts({
      corpusText: text, corpusKey: authors.length === 1 ? keyOf[authors[0]].key : key,
      cacheFile: cacheFile, markers: markerSet, label: `${author}(对照 ${tag})`, log: log,
    });
  };
  const sameCounts = contrastCounts(sameTopic, '同题材');
  const crossCounts = contrastCounts(crossTopic, '跨题材');

  // 约束 ①（每书裕度）已在 reduce 侧剔除禁用书的支撑，这里不再重复传
  const finalGate = gates.clusterGate(clusters, (m) => ({
    targetCount: tCounts.counts[m] || 0, targetChars: tCounts.chars,
    contrastCount: sameCounts.counts[m] || 0, contrastChars: sameCounts.chars,
  }));
  if (useReduce) droppedLift = finalGate.dropped;
  else passed = finalGate.passed;

  // 参考口径：跨题材率比（不参与判定，只用于「是不是题材差异」的诊断）
  const crossTopicLift = {};
  for (const c of finalGate.passed) {
    const m = c.liftMarker;
    if (!m) continue;
    const t = gates.ratePer10k(tCounts.counts[m] || 0, tCounts.chars);
    const cc = gates.ratePer10k(crossCounts.counts[m] || 0, crossCounts.chars);
    crossTopicLift[m] = cc > 0 ? t / cc : null;
  }
  const conflicts = finalGate.passed.filter((c) => c.conflict);

  const summary = {
    author: author, generatedAt: new Date().toISOString(),
    corpusRoot: corpusRoot, dictVersion: dict.version, useReduce: useReduce,
    thresholds: {
      LIFT_MIN: gates.LIFT_MIN, COUNT_ORDER_TOL: gates.COUNT_ORDER_TOL,
      REPRO_MIN_WORKS: gates.REPRO_MIN_WORKS, REPRO_MIN_BLOCKS: gates.REPRO_MIN_BLOCKS,
      REPRO_MIN_CHARS: gates.REPRO_MIN_CHARS, MARGIN_MIN: gates.MARGIN_MIN,
      MARKER_MAX_CP: gates.MARKER_MAX_CP, MIN_TARGET_COUNT: gates.MIN_TARGET_COUNT,
      HIGHFREQ_ABS_COUNT: gates.HIGHFREQ_ABS_COUNT, FAN_IN: reduce.FAN_IN,
      LEAF_MAX_ITEMS: reduce.LEAF_MAX_ITEMS, LEAF_MAX_TOKENS: reduce.LEAF_MAX_TOKENS,
      NODE_MAX_TOKENS_IN: reduce.NODE_MAX_TOKENS_IN, MIN_COVERAGE: reduce.MIN_COVERAGE,
    },
    blocks: rowStat,
    evidence: { gate4RecheckMisses: rowStat.evidenceMiss },
    countCheck: Object.assign({ fedToReduce: feedItems.length, droppedBeforeReduce: mismatchItems.length }, checks),
    hygieneReasons: hygiene,
    marginGate: { min: marginGate.marginMin, rows: marginGate.rows, disabled: [...disabledWorks], note: marginNote },
    reduce: red ? {
      leafNodes: red.leafNodes, clusters: red.clusters.length, levels: red.levels, failedCalls: red.failedCalls || 0,
      degradedAt: red.degradedAt == null ? null : red.degradedAt,
      degradedGroups: red.degradedGroups || 0,
      wallMsReduce: red.wallMs,
      usage: red.usage, wallMs: red.wallMs, problems: red.problems,
      droppedReasons: gates.reasonTally(red.dropped),
      conflictTraits: red.clusters.filter((c) => c.conflict).length,
    } : null,
    gate: {
      clustersOut: finalGate.passed.length, dropped: finalGate.dropped.length,
      droppedReasons: gates.reasonTally(finalGate.dropped),
      byTier: finalGate.passed.reduce((acc, g) => { acc[g.liftTier] = (acc[g.liftTier] || 0) + 1; return acc; }, {}),
      conflicts: conflicts.length,
      conflictsSupport: conflicts.reduce((s, c) => s + c.support.blocks, 0),
    },
    // 空产出必须能被上层判定（不许静默成功）。
    // 注意「有失败调用」**不再**等于 ok=false（2026-09-13 单组降级上线后）：失败的那一组改用它的
    // 输入节点继续上走，id 一个不丢，只是少合并一层——那是「跑得碎」不是「跑挂了」。
    // 真正判死的条件是**0 簇**（作者被丢掉）。失败/降级的规模另行登记：
    // summary.reduce.failedCalls / levels[].degradedGroups / degradedAt（汇总表会标 ⚠降级）。
    ok: !(useReduce && red && !red.clusters.length),
    degraded: !!(useReduce && red && (red.degradedAt != null || (red.degradedGroups || 0) > 0)),
    lift: {
      contrastSameTopic: sameTopic, contrastCrossTopic: crossTopic,
      contrastChars: { sameTopic: sameCounts.chars, crossTopic: crossCounts.chars },
      targetChars: tCounts.chars,
      countsCache: { hit: tCounts.cacheHit, computed: tCounts.computed, markers: markerSet.length },
    },
    dims: finalGate.passed.reduce((acc, g) => { acc[g.dim] = (acc[g.dim] || 0) + 1; return acc; }, {}),
  };

  if (write) {
    const dir = l3Dir(dataRoot, author);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const slim = (c) => ({
      dim: c.dim, trait: c.trait, markers: c.markers, support: c.support, checks: c.checks,
      lift: c.lift, liftMarker: c.liftMarker, liftTier: c.liftTier, rate: c.rate || null,
      conflict: c.conflict === true, variants: c.variants || [],
      items: c.items || [],
    });
    fs.writeFileSync(path.join(dir, 'clusters.jsonl'), finalGate.passed.map((c) => JSON.stringify(slim(c))).join('\n') + '\n');
    const droppedRows = [
      ...mismatchItems.map((it) => ({ stage: 'count-check', reason: it.countCheck.reason, dim: it.dim, marker: it.marker,
        reported: it.countCheck.reported, real: it.countCheck.real, trait: it.trait, work: it.work, chunkIndex: it.chunkIndex })),
      ...(droppedRepro || []),
      ...(droppedLift || []).map((c) => ({ stage: 'cluster-gate', reason: c.reason, dim: c.dim, marker: c.liftMarker,
        lift: c.lift, trait: c.trait, support: c.support, rate: c.rate })),
    ];
    fs.writeFileSync(path.join(dir, 'dropped.jsonl'), droppedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'conflicts.jsonl'),
      conflicts.map((c) => JSON.stringify({ dim: c.dim, trait: c.trait, variants: c.variants, support: c.support, items: c.items })).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'lift-cross-topic.json'), JSON.stringify(crossTopicLift, null, 2));
    log(`[l3] ${author} 产物 → ${dir}`);
  }
  return {
    summary: summary, clusters: finalGate.passed, conflicts: conflicts,
    dropped: { mismatch: mismatchItems, reduce: droppedRepro, gate: droppedLift },
    crossTopicLift: crossTopicLift, reduce: red,
  };
}

module.exports = {
  REPO_ROOT, readJsonl, buildWorkBlocks, gateRowItems, corpusKeyOf, markerCounts, runL3,
  mapRelaxedPath, l3Dir, countsCachePath, reduceBudget, REDUCE_MAX_TOKENS, REDUCE_TIMEOUT_MS,
};
