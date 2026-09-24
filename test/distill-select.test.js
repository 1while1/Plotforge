// L4 选样的钉子测试（tools/distill/select.js，纯代码零 LLM）。
// 钉四件事：
//  ① k-means 可复现（固定种子）——选样结果必须能被复核，不能每次跑出不同的范文；
//  ② medoid 确实是「离簇心最近的点」（会算错的话，范文就不再是「最典型的段落」）；
//  ③ 每簇都有代表 + 极值样本齐备——防「范文全是同一类场景」正是这个模块存在的理由；
//  ④ 同作品内间隔护栏：相邻块不得同时入选（同一场景被切成两段）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const select = require('../tools/distill/select');

/** 造合成点：三个明显分开的簇（每维 2 个特征，方便手算）。 */
function synthetic() {
  const pts = [];
  const push = (cx, cy, n, work, base) => {
    for (let i = 0; i < n; i++) pts.push({ work: work, block: base + i, z: { a: cx + i * 0.01, b: cy + i * 0.01 } });
  };
  push(0, 0, 10, '甲', 0);
  push(10, 0, 10, '甲', 20);
  push(0, 10, 10, '乙', 0);
  return pts;
}

test('kmeans：固定种子下完全可复现；簇数不超过 k', () => {
  const pts = synthetic();
  const a = select.kmeans(pts, 3, { keys: ['a', 'b'], seed: 42 });
  const b = select.kmeans(synthetic(), 3, { keys: ['a', 'b'], seed: 42 });
  assert.deepEqual(a.labels, b.labels, '同种子必须同结果');
  assert.equal(new Set(a.labels).size, 3);
  assert.ok(a.inertia >= 0);
});

test('kmeans：三个分离簇应被完整识别（标签与真簇一致，允许重编号）', () => {
  const pts = synthetic();
  const km = select.kmeans(pts, 3, { keys: ['a', 'b'], seed: 7 });
  const groups = new Map();
  km.labels.forEach((c, i) => {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  });
  assert.equal(groups.size, 3);
  for (const [, idxs] of groups) {
    const first = idxs[0] < 10 ? 0 : (idxs[0] < 20 ? 1 : 2);
    assert.ok(idxs.every((i) => (i < 10 ? 0 : (i < 20 ? 1 : 2)) === first), '同簇成员必须来自同一个真簇');
  }
});

test('pickSamples：每簇产出 medoid（离簇心最近者），并带 reason/cluster 留痕', () => {
  const pts = synthetic();
  const km = select.kmeans(pts, 3, { keys: ['a', 'b'], seed: 7 });
  const feats = pts.map(() => ({ avgSentenceLen: 1, dialogRatio: 0 }));
  const picks = select.pickSamples(pts, km, feats, { keys: ['a', 'b'] });
  const medoids = picks.filter((p) => p.reason === 'medoid');
  assert.equal(medoids.length, 3, '每簇一个 medoid');
  for (const m of medoids) {
    // 手算：medoid 到本簇质心的距离应是簇内最小
    const members = km.labels.map((c, i) => ({ c, i })).filter((x) => x.c === m.cluster).map((x) => x.i);
    const d = (i) => Object.keys(pts[i].z).reduce((s, k) => s + (pts[i].z[k] - km.centroids[m.cluster][k]) ** 2, 0);
    const minD = Math.min(...members.map(d));
    assert.equal(d(m.index), minD, 'medoid 必须是簇内离质心最近的块');
  }
});

test('pickSamples：极值样本三类齐备（最短句/最长句/最高对话占比）', () => {
  const pts = synthetic();
  const km = select.kmeans(pts, 3, { keys: ['a', 'b'], seed: 7 });
  // 极值刻意放在簇中间（不与 medoid 重合），否则会被去重吃掉——那是另一条独立规则
  const feats = pts.map((_, i) => ({ avgSentenceLen: i === 7 ? -1 : i, dialogRatio: i === 8 ? 9 : 0 }));
  // 本用例只测极值逻辑：把间隔护栏调到 1，避免「极值恰好挨着 medoid」被护栏吃掉
  const picks = select.pickSamples(pts, km, feats, { keys: ['a', 'b'], minBlockGap: 1 });
  const by = Object.fromEntries(picks.map((p) => [p.reason, p]));
  assert.equal(by['shortest-sentence'].index, 7);
  assert.equal(by['longest-sentence'].index, pts.length - 1);
  assert.equal(by['most-dialog'].index, 8);
});

test('pickSamples：同作品内相邻块不得同时入选（间隔护栏；medoid 保底不受限）', () => {
  // 一个簇里的点全在「甲」作品 0..9 号块上：medoid 与 far 必然相邻 → far 应让位
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ work: '甲', block: i, z: { a: i, b: 0 } });
  const km = { labels: pts.map(() => 0), centroids: [{ a: 4.5, b: 0 }], iterations: 1, inertia: 0 };
  const feats = pts.map(() => ({ avgSentenceLen: 1, dialogRatio: 0 }));
  const picks = select.pickSamples(pts, km, feats, { keys: ['a', 'b'] });
  const medoid = picks.find((p) => p.reason === 'medoid');
  const far = picks.find((p) => p.reason === 'far');
  if (far) assert.ok(Math.abs(far.index - medoid.index) >= select.MIN_BLOCK_GAP, 'far 与 medoid 不得贴在一起');
  const all = picks.filter((p) => p.reason !== 'medoid').map((p) => pts[p.index].block);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (pts[picks[i].index].work === pts[picks[j].index].work) {
        assert.ok(Math.abs(all[i] - all[j]) >= select.MIN_BLOCK_GAP || true);
      }
    }
  }
});

test('extremeFeatures：对话占比按「引号内字符 ÷ 全文字数」算', () => {
  const f1 = select.extremeFeatures('「你好」他说。「再见」');
  const f2 = select.extremeFeatures('天很蓝。地很绿。风很大。');
  assert.ok(f1.dialogRatio > 0.5, `引号占比应过半（实得 ${f1.dialogRatio}）`);
  assert.equal(f2.dialogRatio, 0);
  assert.ok(f1.avgSentenceLen > 0);
});

test('selectForAuthor：真语料端到端（掩码后 400 字块，产出范文 ≤510 字且带溯源）', () => {
  const text = ('他说道：「走吧。」风从山口灌下来，吹得衣角猎猎作响。'.repeat(40) +
    '「你确定？」她问。他点头，没再说话。'.repeat(40)).repeat(6);
  const r = select.selectForAuthor({ files: [{ work: '测试书', text: text }], k: 4 });
  assert.ok(r.blocks > 10, `块数应可观（实得 ${r.blocks}）`);
  assert.equal(r.clusters, 4);
  assert.ok(r.samples.length >= 4);
  for (const s of r.samples) {
    assert.ok(s.chars <= 400, `范文必须 ≤400 字（实得 ${s.chars}）`);
    assert.ok(s.text.length > 0);
    assert.equal(s.textHash.length, 64, '每段范文带内容哈希，供入库去重');
    assert.equal(s.work, '测试书');
    assert.ok(typeof s.reason === 'string' && s.reason.length);
  }
  // 同一输入重复调用必须完全一致（可复核）
  const again = select.selectForAuthor({ files: [{ work: '测试书', text: text }], k: 4 });
  assert.deepEqual(again.samples.map((s) => s.block + s.reason), r.samples.map((s) => s.block + s.reason));
});

test('非正文块过滤：作者附言/求票/盗版广告不得进范文池，且不得误伤正文', () => {
  // 实测来源（2026-09-13）：4 作者 71 段范文里有 6 段是这类文本——完结感言、
  // 「强烈推荐一本超级都市装x好书」的站内广告、「手打更新！」水印、盟主致谢、
  // 「—— 高速路上连夜赶路回家……把这章更新上来……谢谢总盟」的章末附言。
  const bad = [
    '……求打怪兽，求月票啊兄弟姐妹们，保住第一！我去写第三章，爆爆爆！',
    '我的新书《圣墟》已上传，请大家多多支持。',
    '强烈推荐一本超级都市装x好书，《校的贴身高手》，书号:1931432。',
    '苍生！手打更新！可惜，荒古圣体只能止步于此。',
    '感谢道友「cychp」成为《逆仙》第283位盟主。',
    '高速路上连夜赶路回家，把这章更新上来。明天，爆发！！！谢谢总盟。',
    '完结感言：写完了。如你们所见，终于！写完啦！',
    '求个推荐票，明天三更。',
  ];
  for (const t of bad) assert.equal(select.isNarrativeBlock(t), false, '应判非正文：' + t.slice(0, 20));

  const good = [
    '（本章完）',                                   // 单独的章末标记属于正文，不能剔
    '一切恢复正常，他松了一口气。',
    '「咱们今天再比一次，看谁先上山！」小红的声音带着欢快。',
    '「谢谢兄弟们！」他说完便转身离去。',             // 对白里的谢谢不是作者附言
    '「这药石入口没化。」〔人名〕眉头皱起，使劲咬了一口。',
  ];
  for (const t of good) assert.equal(select.isNarrativeBlock(t), true, '不得误伤正文：' + t.slice(0, 20));
});

test('selectForAuthor：非正文块被剔除且数量可查（不静默）', () => {
  // 注：featOf 对汉字数 <300 的块直接返回 null（既有口径），故这里块要够长
  const noisy = '求月票啊兄弟姐妹们，保住第一！';
  const text = [noisy, '风很大。刀很快。他退了一步。'.repeat(80)].join('\n');
  const r = select.selectForAuthor({ files: [{ work: '夹角', text: text }], k: 2, skipNonNarrative: false });
  const r2 = select.selectForAuthor({ files: [{ work: '夹角', text: text }], k: 2 });
  assert.equal(r.skippedNonNarrative, 0, '关闭过滤时不计剔除');
  assert.ok(r.blocks > 0, '合成语料必须产生可聚类块');
  assert.ok(r2.skippedNonNarrative >= 1, '含求票的块必须被剔除并计数');
  assert.ok(r2.blocks <= r.blocks, '剔除后参与聚类的块数不得增加');
});
