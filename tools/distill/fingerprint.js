// L1 量化指纹（作者印记蒸馏第 1 步，纯计算模块，零 LLM、不 require server/db）。
//
// 特征口径**逐字照抄**复现脚本
// docs/report/20260911_作家仓库/20-作家印记蒸馏/复现脚本/chunk-level-test.js
// （FUNC 单字 + BIGRAM 二字组 + PUNCT 12 标点 + 句段形态），方案 §3.1 定稿：
//   - 频率一律归一化为每万汉字（次数 / 汉字数 × 10000），跨长度可比；
//   - 统计前先剔章标题行（util.stripChapterTitles，§3.1 口径要点）；
//   - 段落过滤照复现脚本：trim 后长度 > 2 且非「第…/数字」开头；
//   - 禁用 TTR / hapax（强烈依赖文本长度，§3.1 明令）；
//   - 距离用 z-score 后平均绝对差（Burrows's Delta 口径）；
//   - 在复现脚本基础上新增 dlgmark（对话引号闭合后紧邻言说动词密度，网文强作者标记）。
//
// 本模块只算不读：读语料用 tools/distill/util.js 的 readCorpus/readUtf8。
'use strict';

const { han, stripChapterTitles } = require('./util');

// ---- 词表（照抄复现脚本；FUNC 原串含重复字，FUNC_SET 去重后 81 字）----
const FUNC = '的了着地得而过其之乎者也矣焉哉与及或且但却则因由于在从向对为被把将给让使令叫已曾未没不别莫勿很太更最都也又再还就才只仅皆尽所我吗呢吧啊呀哦嗯么啦嘛我你他她它们这那哪谁';
const FUNC_SET = [...new Set(FUNC.split(''))];
const BIGRAMS = ['因为', '所以', '但是', '可是', '然而', '如果', '虽然', '不过', '于是', '然后', '而且', '并且',
  '已经', '正在', '将要', '可以', '能够', '应该', '必须', '似乎', '仿佛', '好像', '依然', '仍然', '忽然', '突然',
  '终于', '竟然', '居然', '果然', '显然', '当然', '也许', '大概', '几乎', '甚至', '尤其', '特别', '十分', '非常'];
// 12 标点谱（顺序即特征下标 p0..p11，与复现脚本一致）
const PUNCTS = [/，/g, /。/g, /[？?]/g, /[！!]/g, /…{1,2}/g, /、/g, /[“”]/g, /——|—/g, /；/g, /：/g, /[《》]/g, /[「」]/g];
const PUNCT_LABELS = ['，', '。', '？', '！', '…', '、', '“”', '——', '；', '：', '《》', '「」'];

// 段落过滤：照复现脚本（第/数字开头的行视为章题类，剔出句段统计）
const DROP = /^(第|[0-9])/;

// 对话引号闭合后紧邻的言说动词（dlgmark 用；「等」表示可扩，先与方案 §3.1 列举一致）
const SPEECH_VERBS = '道|说|问|喊|叫|笑|答|叹|骂';

// 句切分：照抄复现脚本（。！？… 收尾含后引号；；亦断句）
function splitSentences(t) {
  const out = []; let last = 0;
  const re = /[。！？…]+[”』」]*|[；]/g;
  for (let m; (m = re.exec(t)); ) {
    const seg = t.slice(last, m.index + m[0].length).trim();
    if (seg) out.push(seg);
    last = m.index + m[0].length;
  }
  if (t.slice(last).trim()) out.push(t.slice(last).trim());
  return out;
}

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { const m = avg(a); return a.length ? Math.sqrt(avg(a.map(x => (x - m) ** 2))) : 0; };

function validParagraphs(cleaned) {
  return cleaned.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 2 && !DROP.test(s));
}

/**
 * L1 特征向量（键 f<字>/b<词>/p<i>/sl/slsd/pl/single/dlg/dlgmark）。
 * 频率类特征一律「次数 / 汉字数 × 10000」；sl/slsd/pl 以汉字数计；
 * single/dlg 为百分比（0~100）。汉字 < 300 返回 null（长度不足，频率不可比）。
 * @returns {Object<string, number>|null}
 */
function featOf(text) {
  const cleaned = stripChapterTitles(text);
  const n = han(cleaned);
  if (n < 300) return null;
  const f = {};
  for (const c of FUNC_SET) f['f' + c] = (cleaned.split(c).length - 1) / n * 10000;
  for (const w of BIGRAMS) f['b' + w] = (cleaned.split(w).length - 1) / n * 10000;
  PUNCTS.forEach((re, i) => { f['p' + i] = ((cleaned.match(re) || []).length) / n * 10000; });
  const paras = validParagraphs(cleaned);
  const sents = splitSentences(cleaned).map(han).filter(x => x > 0);
  f.sl = avg(sents); f.slsd = sd(sents); f.pl = paras.length ? n / paras.length : 0;
  let single = 0; for (const p of paras) if (splitSentences(p).length === 1) single++;
  f.single = paras.length ? single / paras.length * 100 : 0;
  let inQ = 0; for (const m of cleaned.matchAll(/[“]([^”]{0,2000})[”]/g)) inQ += han(m[1]);
  f.dlg = inQ / n * 100;
  // dlgmark：对话引号（“…”）闭合后紧邻言说动词的出现密度（每万汉字）
  let mark = 0;
  for (const _m of cleaned.matchAll(new RegExp('[“]([^”]{0,2000})[”](' + SPEECH_VERBS + ')', 'g'))) mark++;
  f.dlgmark = mark / n * 10000;
  return f;
}

// 线性插值分位数（numpy 'linear' 口径：pos=(len-1)*q）
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

/**
 * 分布形态（§3.1/§3.6：句长方差本身就是风格——不能只给均值）。
 * 句长 {p25,p50,p75,p90,mean,sd}（汉字数）、段长 {p25,p50,p75,p90}（汉字数）、
 * 单句成段占比、对话占比（百分比）、标点谱 top5 与末 3 项（每万汉字）。
 */
function distributionOf(text) {
  const cleaned = stripChapterTitles(text);
  const n = han(cleaned);
  const sentLens = splitSentences(cleaned).map(han).filter(x => x > 0).sort((a, b) => a - b);
  const paraLens = validParagraphs(cleaned).map(han).filter(x => x > 0).sort((a, b) => a - b);
  const paras = validParagraphs(cleaned);
  let single = 0; for (const p of paras) if (splitSentences(p).length === 1) single++;
  let inQ = 0; for (const m of cleaned.matchAll(/[“]([^”]{0,2000})[”]/g)) inQ += han(m[1]);
  const punct = PUNCTS.map((re, i) => ({
    key: 'p' + i, label: PUNCT_LABELS[i], per10k: n ? ((cleaned.match(re) || []).length) / n * 10000 : 0,
  }));
  const byFreq = [...punct].sort((a, b) => b.per10k - a.per10k);
  return {
    hanCount: n,
    sentenceLen: {
      p25: quantile(sentLens, 0.25), p50: quantile(sentLens, 0.5),
      p75: quantile(sentLens, 0.75), p90: quantile(sentLens, 0.9),
      mean: avg(sentLens), sd: sd(sentLens),
    },
    paragraphLen: {
      p25: quantile(paraLens, 0.25), p50: quantile(paraLens, 0.5),
      p75: quantile(paraLens, 0.75), p90: quantile(paraLens, 0.9),
    },
    singleSentenceParaRate: paras.length ? single / paras.length * 100 : 0,
    dialogRate: n ? inQ / n * 100 : 0,
    punctTop5: byFreq.slice(0, 5),
    punctBottom3: byFreq.slice(-3),
  };
}

/**
 * 全体 z-score 标准化（Delta 口径的前置）：items = [{...,feat}]，每项挂 item.z；
 * sd = 0 的特征（全体恒定）置 1（零向量特征不参与区分，也不放大噪声）。
 * @returns {string[]} 特征键序（供 deltaZ 复用）
 */
function zscoreAll(items) {
  const keys = items.length ? Object.keys(items[0].feat) : [];
  const mu = {}, s = {};
  for (const k of keys) {
    const v = items.map(it => it.feat[k]);
    mu[k] = v.reduce((a, b) => a + b, 0) / v.length;
    s[k] = Math.sqrt(v.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / v.length) || 1;
  }
  for (const it of items) {
    it.z = {};
    for (const k of keys) it.z[k] = (it.feat[k] - mu[k]) / s[k];
  }
  return keys;
}

/** Burrows's Delta：z 向量平均绝对差（0 = 同分布，越大越远）。 */
function deltaZ(z1, z2, keys) {
  return keys.reduce((s, k) => s + Math.abs(z1[k] - z2[k]), 0) / keys.length;
}

/**
 * 分组分离度报告（方案 §1.4 口径，**文件级**整篇特征）。
 * fileItems = [{author, work, feat}]；文件对分三组：
 *   sameWork（同作品）/ sameAuthorCrossBook（同作者跨书）/ crossAuthor（跨作者）。
 * 分离度 = 跨作者平均 Δ ÷ 同作者跨书平均 Δ（>1 即作者信号强于书间差异）。
 * z-score 在文件级全体上算。
 */
function separationReport(fileItems) {
  const keys = zscoreAll(fileItems);
  const g = {
    sameWork: { sum: 0, n: 0 },
    sameAuthorCrossBook: { sum: 0, n: 0 },
    crossAuthor: { sum: 0, n: 0 },
  };
  for (let i = 0; i < fileItems.length; i++) {
    for (let j = i + 1; j < fileItems.length; j++) {
      const a = fileItems[i], b = fileItems[j];
      const d = deltaZ(a.z, b.z, keys);
      let key;
      if (a.work === b.work) key = 'sameWork';
      else if (a.author === b.author) key = 'sameAuthorCrossBook';
      else key = 'crossAuthor';
      g[key].sum += d; g[key].n++;
    }
  }
  const out = {
    dimensions: keys.length,
    sameWork: { avgDelta: g.sameWork.n ? g.sameWork.sum / g.sameWork.n : 0, pairs: g.sameWork.n },
    sameAuthorCrossBook: { avgDelta: g.sameAuthorCrossBook.n ? g.sameAuthorCrossBook.sum / g.sameAuthorCrossBook.n : 0, pairs: g.sameAuthorCrossBook.n },
    crossAuthor: { avgDelta: g.crossAuthor.n ? g.crossAuthor.sum / g.crossAuthor.n : 0, pairs: g.crossAuthor.n },
  };
  out.separation = out.sameAuthorCrossBook.avgDelta > 0
    ? out.crossAuthor.avgDelta / out.sameAuthorCrossBook.avgDelta
    : null;
  return out;
}

function centroidOf(list, keys) {
  const c = {};
  for (const k of keys) c[k] = list.reduce((s, r) => s + r.z[k], 0) / list.length;
  return c;
}

/**
 * 留一整本书验证（方案 §1.4/§3.1 验证协议，**块级**）。
 * blockItems = [{author, work, z}]（z 由全体块标准化：先 zscoreAll 再传入）。
 * 每部书一折：
 *   正类质心 = 该书作者**其余作品**全部块的 z 均值；
 *   负类质心 = 对照作者（author 不同者）全部块的 z 均值；
 *   判定该书：整书聚合 z 的归属（correct）+ 块级投票准确率（blockVoteRate）；
 *   裕度 margin = 负类距离 − 正类距离（整书口径）。
 * 该作者仅一部作品时无法建「其余作品」质心，该折跳过（不计入 totalN）。
 */
function leaveOneBookOut(blockItems) {
  const keys = blockItems.length ? Object.keys(blockItems[0].z) : [];
  const bookAuthor = new Map();
  for (const b of blockItems) if (!bookAuthor.has(b.work)) bookAuthor.set(b.work, b.author);
  const folds = [];
  for (const [book, author] of bookAuthor) {
    const mine = blockItems.filter(b => b.work === book);
    const pos = blockItems.filter(b => b.author === author && b.work !== book);
    const neg = blockItems.filter(b => b.author !== author);
    if (!pos.length || !neg.length) continue;
    const cPos = centroidOf(pos, keys);
    const cNeg = centroidOf(neg, keys);
    // 整书聚合 z（本书全部块的平均）
    const agg = {};
    for (const k of keys) agg[k] = mine.reduce((s, r) => s + r.z[k], 0) / mine.length;
    const dPos = deltaZ(agg, cPos, keys);
    const dNeg = deltaZ(agg, cNeg, keys);
    let ok = 0;
    for (const r of mine) {
      if (deltaZ(r.z, cPos, keys) < deltaZ(r.z, cNeg, keys)) ok++;
    }
    folds.push({
      book, author,
      correct: dPos < dNeg,
      margin: dNeg - dPos,
      blockVoteRate: mine.length ? ok / mine.length : 0,
      blocks: mine.length,
    });
  }
  const correctN = folds.filter(f => f.correct).length;
  return {
    folds,
    correctN,
    totalN: folds.length,
    meanMargin: folds.length ? folds.reduce((s, f) => s + f.margin, 0) / folds.length : null,
  };
}

/** 一段文本的完整 L1 指纹：features（featOf，短文本为 null）+ distribution + hanCount。 */
function fingerprintOf(text) {
  const distribution = distributionOf(text);
  return { features: featOf(text), distribution, hanCount: distribution.hanCount };
}

module.exports = {
  FUNC_SET, BIGRAMS, PUNCTS, PUNCT_LABELS, SPEECH_VERBS,
  splitSentences, validParagraphs, featOf, distributionOf, quantile,
  zscoreAll, deltaZ, separationReport, leaveOneBookOut, fingerprintOf,
};
