'use strict';
/**
 * L4 选样（纯代码、零 LLM）——设计 §3.4「选样」一节的落地。
 *
 * 目标：从一位作家的全部作品里挑出**风格上互相分散**的若干段，作为卡片范文
 * （few-shot 语感来源）。要防的不是「不好」，而是「**全是同一类场景**」——
 * 战斗高潮段落扎堆，日常对话一段没有，模型就只能学到一半语感。
 *
 * 做法（设计原文）：L1 特征 z-score → k-means → 每簇 medoid（最典型）
 * + 每簇一个远端样本（簇内最离散，负责多样性）+ 极值样本（最短句/最长句/最高对话占比）。
 *
 * —— 口径决定（都写在这里，免得日后靠猜）——
 * ① **块尺度 = 400 字（`util.L1_CHUNK_SIZE`）**：L1 特征与检索质量的证据全部在 400 字域实测
 *    （方案 §1.5），生产域与测量域重合；同时 400 < 嵌入静默截断边界 510 字，范文可安全嵌入
 *    （方案 §3.4 的硬约束：参与嵌入的范文必须 ≤500 字）。
 * ② **z-score 在作者内部做**：选样的目的是覆盖**这位作家自己的**风格范围，
 *    跨作者标准化会把「他相对别人突出的地方」放大成簇结构，反而挑出一堆同质段。
 * ③ **k = 8**：卡片范文预算 6,000 字（§3.5）÷ 400 字 ≈ 15 段；
 *    8 个簇 ×（1 medoid + 1 远端）+ 3 个极值 = 19 段候选，入库时略多于预算，
 *    留给「作家卡页人工增删改」的余地，注入时按预算裁剪。
 * ④ **可复现**：k-means++ 初始化用固定种子 LCG（不用 Math.random），同一输入必然同一结果。
 * ⑤ **相邻与重复护栏**：同作品内选中块的序号必须间隔 ≥ `MIN_BLOCK_GAP`（防同一场景被切成两段都选上）。
 */
const util = require('./util');
const fp = require('./fingerprint');

const K = 8;                 // 簇数
const KMEANS_ITERS = 40;     // 迭代上限
const MIN_BLOCK_GAP = 5;     // 同作品内选中块的最小序号间隔
const SAMPLE_CHARS = util.L1_CHUNK_SIZE;   // 400 字

/** 固定种子线性同余发生器（可复现的 k-means++ 初始化）。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 欧氏距离平方（139 维小向量，省一次开方）。 */
function dist2(a, b, keys) {
  let d = 0;
  for (const k of keys) {
    const x = a[k] - b[k];
    d += x * x;
  }
  return d;
}

/**
 * k-means（k-means++ 初始化 + Lloyd 迭代）。`points` 为 [{z:{…}}]（z 已标准化）。
 * @returns {{labels:number[], centroids:Object[], iterations:number, inertia:number}}
 */
function kmeans(points, k, opts = {}) {
  const keys = opts.keys || Object.keys(points[0].z);
  const iters = Number.isInteger(opts.iters) ? opts.iters : KMEANS_ITERS;
  const rand = lcg(Number.isInteger(opts.seed) ? opts.seed : 20260913);
  const n = points.length;
  if (!n) return { labels: [], centroids: [], iterations: 0, inertia: 0 };
  const kk = Math.max(1, Math.min(k, n));
  // k-means++：首点随机，其后按 D² 抽样
  const centroids = [Object.assign({}, points[Math.floor(rand() * n)].z)];
  const d2 = new Array(n).fill(Infinity);
  while (centroids.length < kk) {
    const last = centroids[centroids.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(points[i].z, last, keys);
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let target = rand() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) { pick = i; break; }
    }
    centroids.push(Object.assign({}, points[pick].z));
  }
  const labels = new Array(n).fill(0);
  let moved = true;
  let iter = 0;
  let inertia = 0;
  while (moved && iter < iters) {
    moved = false;
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = dist2(points[i].z, centroids[c], keys);
        if (d < bestD) { bestD = d; best = c; }
      }
      inertia += bestD;
      if (labels[i] !== best) { labels[i] = best; moved = true; }
    }
    const sums = Array.from({ length: kk }, () => {
      const o = {};
      for (const key of keys) o[key] = 0;
      return o;
    });
    const counts = new Array(kk).fill(0);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const s = sums[labels[i]];
      for (const key of keys) s[key] += points[i].z[key];
    }
    for (let c = 0; c < kk; c++) {
      if (!counts[c]) continue;   // 空簇保留原质心（不重置，避免抖动）
      for (const key of keys) centroids[c][key] = sums[c][key] / counts[c];
    }
    iter++;
  }
  return { labels, centroids, iterations: iter, inertia };
}

/**
 * 组内选样（纯函数，可单测）：
 *  ① 每簇 medoid（到本簇质心最近的点）
 *  ② 每簇远端样本（到本簇质心最远的点，即簇内最离散者——多样性来源）
 *  ③ 极值样本（最短句 / 最长句 / 最高对话占比）
 * 去重后按「簇序号 → 角色」返回，附带 reason 供人工检视与报告。
 * @returns {{index:number, reason:string, cluster:number|null, value?:number}[]}
 */
function pickSamples(points, km, features, opts = {}) {
  const keys = opts.keys || Object.keys(points[0].z);
  const gap = Number.isInteger(opts.minBlockGap) ? opts.minBlockGap : MIN_BLOCK_GAP;
  const picked = [];
  const used = new Set();
  const byCluster = new Map();
  km.labels.forEach((c, i) => {
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(i);
  });
  for (const [c, idxs] of [...byCluster.entries()].sort((a, b) => a[0] - b[0])) {
    let medoid = idxs[0];
    let far = idxs[0];
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const i of idxs) {
      const d = dist2(points[i].z, km.centroids[c], keys);
      if (d < dMin) { dMin = d; medoid = i; }
      if (d > dMax) { dMax = d; far = i; }
    }
    picked.push({ index: medoid, reason: 'medoid', cluster: c, value: +Math.sqrt(dMin).toFixed(4) });
    if (far !== medoid) picked.push({ index: far, reason: 'far', cluster: c, value: +Math.sqrt(dMax).toFixed(4) });
  }
  // 极值样本：三条各取极值（features 由调用方按块算：avgSentenceLen / dialogRatio）。
  // 优先级排在 medoid 之后、far 之前：极值各只占 1 个名额，而 far 每簇一个（8 个），
  // 让 far 靠前会把「句长/对话占比的极端样本」挤掉——那恰恰是多样性最省成本的来源。
  const ext = [
    ['shortest-sentence', (f) => f.avgSentenceLen, true],
    ['longest-sentence', (f) => f.avgSentenceLen, false],
    ['most-dialog', (f) => f.dialogRatio, false],
  ];
  const extremes = [];
  for (const [reason, get, asc] of ext) {
    let best = -1;
    let bestV = asc ? Infinity : -Infinity;
    for (let i = 0; i < points.length; i++) {
      const v = get(features[i]) || 0;
      if (asc ? v < bestV : v > bestV) { bestV = v; best = i; }
    }
    if (best >= 0) extremes.push({ index: best, reason: reason, cluster: km.labels[best], value: +bestV.toFixed(4) });
  }
  // 去重 + 间隔护栏（同作品内序号过近的后来者让位）
  const out = [];
  const chosenBlocks = new Map();  // work → Set(blockIdx)
  const ordered = picked.filter((p) => p.reason === 'medoid')
    .concat(extremes, picked.filter((p) => p.reason !== 'medoid'));
  for (const p of ordered) {
    if (used.has(p.index)) continue;
    const pt = points[p.index];
    const set = chosenBlocks.get(pt.work) || new Set();
    let tooClose = false;
    for (const b of set) if (Math.abs(b - pt.block) < gap) { tooClose = true; break; }
    if (tooClose && p.reason !== 'medoid') continue;   // medoid 保底，不受间隔护栏影响
    set.add(pt.block);
    chosenBlocks.set(pt.work, set);
    used.add(p.index);
    out.push(p);
  }
  return out;
}

/** 计算每个块的极值特征（最短句/最长句/对话占比）——只用于极值选样。 */
function extremeFeatures(text) {
  const sents = String(text).split(/[。！？…]+/).filter((s) => s.trim());
  const avgSentenceLen = sents.length ? util.codePoints(text) / sents.length : util.codePoints(text);
  const dialogChars = (String(text).match(/[「“][^」”]{0,200}[」”]/g) || []).reduce((s, x) => s + util.codePoints(x), 0);
  return { avgSentenceLen: avgSentenceLen, dialogRatio: util.codePoints(text) ? dialogChars / util.codePoints(text) : 0 };
}

/**
 * 非正文块的黑名单（2026-09-13 实测补）：语料里混着**作者附言/求票/盗版站广告**，
 * 它们统计特征极端（短句多、口语化、无对话结构），恰恰容易被 k-means 选成簇代表
 * 或「远端样本」——实测 4 作者 71 段里有 6 段命中（完结感言、盟主致谢、
 * 「强烈推荐一本超级都市装x好书」的站内广告、正文中间的「手打更新！」水印）。
 * 范文是 few-shot 语感来源，混进这类文本会教出**错误语感**，故在选样前按块剔除。
 *
 * 口径：一个 400 字块里出现这些字样，几乎不可能是正文（正文写「求票」的概率≈0），
 * 而漏掉一块的代价是 23,000 分之 1——故宁可略激进，剔除数量会报告出来（不静默）。
 * 注意：**不动上游 clean/掩码**——语料一改所有下游 sha 全变；这里是选样侧的过滤。
 */
const META_STRONG_RE = new RegExp([
  '求票|推荐票|月票|打赏|订阅|加更|催更',
  '完结感言|完本感言|上架感言|作者的话|作者感言|新书《',
  '感谢道友|成为《[^》]{1,40}》第\\d+位盟主|书友群|读者群',
  '手打更新|更新最快|最新章节|全文阅读|请记住本站|笔趣阁|强烈推荐一本',
].join('|'));

// 章末作者附言：**只认明确的「作者在说自己写字的事」词组**，不做「本章完 + 今天/恢复」这类模糊匹配。
// 踩过的坑（2026-09-13 实测）：先用「(本章完) && (谢谢|更新|明天|爆发|恢复|手机…)」两条同时命中，
// 结果 1,373 块里 751 块是**真正文**——「咱们今天再比一次」「一切都恢复正常」都能命中弱词，
// 而「(本章完)」几乎每 10 块出现一次。代价不只是少几块语料：章末钩子/悬念段的句法（本身就是
// 一种风格印记）会被**系统性**剔掉，等于给范文池做了偏样。故收紧为下面这些几乎只可能出现在
// 作者附言里的词组（问魔 501-1000 章的「—— 高速路上连夜赶路回家……把这章更新上来……谢谢总盟」
// 就被「更新上来」与「谢谢总盟」两条分别命中）。
const META_NOTE_RE = new RegExp([
  '更新上来|更新一章|这章更新|明天两更|明天三更|明天会更新|今天两更|今天三更',
  '请假条|请假一天|请个假|码字去|继续码字|求订阅|求收藏|新书上传|新书已经上传',
  '谢谢总盟|谢谢各位道友|谢谢道友|感谢各位道友|谢谢大家的支持|感谢大家支持|感谢书友|谢谢书友',
].join('|'));

/** 该块是否是正文（false = 作者附言/广告/水印，选样时剔除）。 */
function isNarrativeBlock(text) {
  const s = String(text || '');
  return !META_STRONG_RE.test(s) && !META_NOTE_RE.test(s);
}

/**
 * 从一位作家的掩码语料里选样：切 400 字块 → L1 特征 → 作者内 z-score → k-means → 三类选样。
 * @param {{files:Array<{work:string,text:string}>, k?:number, seed?:number,
 *          skipNonNarrative?:boolean}} o
 *        files 里每项的 text 必须是**掩码后**文本（范文一律用掩码原句，设计 §3.1.5 措施 4）
 * @returns {{samples:Array, clusters:number, blocks:number, k:number, skippedNonNarrative:number}}
 */
function selectForAuthor(o) {
  const k = Number.isInteger(o.k) ? o.k : K;
  const points = [];
  let skippedNonNarrative = 0;
  const skip = o.skipNonNarrative !== false;
  for (const f of o.files) {
    let block = 0;
    for (const c of util.slidingChunks(f.text, { size: SAMPLE_CHARS, step: SAMPLE_CHARS })) {
      const feat = fp.featOf(c.text);
      if (!feat) { block++; continue; }
      if (skip && !isNarrativeBlock(c.text)) { skippedNonNarrative++; block++; continue; }
      points.push({ work: f.work, block: block, charStart: c.charStart, text: c.text, feat: feat, z: null });
      block++;
    }
  }
  if (!points.length) return { samples: [], clusters: 0, blocks: 0, k: k, skippedNonNarrative: skippedNonNarrative };
  // 作者内 z-score
  const keys = Object.keys(points[0].feat);
  const mean = {};
  const sd = {};
  for (const key of keys) {
    let s = 0;
    for (const p of points) s += p.feat[key];
    mean[key] = s / points.length;
    let v = 0;
    for (const p of points) v += (p.feat[key] - mean[key]) ** 2;
    sd[key] = Math.sqrt(v / points.length) || 1;
  }
  for (const p of points) {
    const z = {};
    for (const key of keys) z[key] = (p.feat[key] - mean[key]) / sd[key];
    p.z = z;
  }
  const km = kmeans(points, k, { keys: keys, seed: o.seed });
  const feats = points.map((p) => extremeFeatures(p.text));
  const picks = pickSamples(points, km, feats, { keys: keys });
  const samples = picks.map((p) => {
    const pt = points[p.index];
    return {
      work: pt.work, block: pt.block, charStart: pt.charStart,
      reason: p.reason, cluster: p.cluster, distance: p.value == null ? null : p.value,
      chars: util.codePoints(pt.text), text: pt.text,
      textHash: util.sha256(pt.text),
    };
  });
  return {
    samples: samples, clusters: new Set(km.labels).size, blocks: points.length, k: k,
    iterations: km.iterations, inertia: km.inertia, skippedNonNarrative: skippedNonNarrative,
    clusterSizes: [...new Set(km.labels)].sort((a, b) => a - b).map((c) => km.labels.filter((x) => x === c).length),
  };
}

module.exports = {
  K, KMEANS_ITERS, MIN_BLOCK_GAP, SAMPLE_CHARS, META_STRONG_RE, META_NOTE_RE,
  lcg, kmeans, pickSamples, extremeFeatures, isNarrativeBlock, selectForAuthor,
};
