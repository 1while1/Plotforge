// L1 量化指纹单测：全合成数据，不读真实语料、不碰数据库。
// 数值断言全部可手算（合成文本的已知频率 / 已知句长序列）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fp = require('../tools/distill/fingerprint');

// 「饭」不在 81 功能字表、不构成任何二字组、无标点——填充字，保证除目标特征外全为 0。
const FILLER = '饭';
assert.equal(fp.FUNC_SET.includes(FILLER), false, '填充字必须不在功能词表内');

// 维度数钉子（2026-09-12 核查补）：139 = 81 功能单字（去重）+ 40 二字组 + 12 标点
// + 6 句段形态（含 dlgmark，**无**段长标准差——方案文档的「140 维」多算了一个从未实现的维度）。
// 词表或形态集一旦漂移，跨源指纹就不可比（corpus_sources.fingerprint_json 已入库），
// 且不会有任何症状，所以必须在这里钉死。
assert.equal(fp.FUNC_SET.length, 81, '功能单字表去重后 81');
assert.equal(fp.BIGRAMS.length, 40, '二字组 40');
assert.equal(fp.PUNCTS.length, 12, '标点 12');
assert.equal(Object.keys(fp.featOf(FILLER.repeat(1000))).length, 139, '特征总维度 139');

function approx(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `期望 ${expected}，实得 ${actual}`);
}

test('featOf：频率数值正确性（每万汉字口径）与短文本拒算', () => {
  // f的：100 个「的」/ 1000 汉字 → 1000/万
  const t1 = FILLER.repeat(900) + '的'.repeat(100);
  const f1 = fp.featOf(t1);
  assert.ok(f1, '1000 汉字应产出特征');
  approx(f1['f的'], 1000);
  approx(f1['f了'], 0); // 填充文本不含「了」

  // b因为：50 次 / 1000 汉字 → 500/万
  const t2 = FILLER.repeat(900) + '因为'.repeat(50);
  approx(fp.featOf(t2)['b因为'], 500);

  // p0（，）：25 个 / 1000 汉字 → 250/万（逗号非汉字，填充字补足基数）
  const t3 = FILLER.repeat(1000) + '，'.repeat(25);
  approx(fp.featOf(t3)['p0'], 250);

  // dlgmark：75 个「“饭饭饭”道」→ 75 次闭合引号紧邻言说动词；每单元 4 汉字 → n=300 → 2500/万
  const t4 = '“饭饭饭”道'.repeat(75);
  const f4 = fp.featOf(t4);
  approx(f4['dlgmark'], 2500);
  // dlg：引号内 3×75=225 汉字 / 300 汉字 = 75%
  approx(f4['dlg'], 75, 1e-4);

  // 剔章标题：章题行（含 5 个汉字）剔除后基数回到 1000，f的 仍为 1000
  const t5 = '第一章 起点\n' + t1;
  approx(fp.featOf(t5)['f的'], 1000, 1e-4);

  // 汉字 < 300 → null
  assert.equal(fp.featOf(FILLER.repeat(299)), null);
  assert.equal(fp.featOf(''), null);
});

test('distributionOf：句长分位数 p50/p90（线性插值口径）与段长/单句成段', () => {
  // 10 段，每段 1 句，句长（汉字数）= 3..12
  const paras = [];
  for (let L = 3; L <= 12; L++) paras.push(FILLER.repeat(L) + '。');
  const d = fp.distributionOf(paras.join('\n'));

  assert.equal(d.hanCount, 75); // 3+4+…+12
  approx(d.sentenceLen.p50, 7.5);   // pos=4.5 → 7+0.5×(8−7)
  approx(d.sentenceLen.p90, 11.1);  // pos=8.1 → 11+0.1×(12−11)
  approx(d.sentenceLen.p25, 5.25);  // pos=2.25 → 5+0.25×(6−5)
  approx(d.sentenceLen.mean, 7.5);
  approx(d.sentenceLen.sd, Math.sqrt(8.25), 1e-9);
  approx(d.paragraphLen.p50, 7.5);
  approx(d.singleSentenceParaRate, 100, 1e-9); // 每段恰一句
  approx(d.dialogRate, 0, 1e-9);

  // 标点谱：全部为句号（p1），top5 首项是句号、频率 10/75×10000
  assert.equal(d.punctTop5[0].label, '。');
  approx(d.punctTop5[0].per10k, 10 / 75 * 10000, 1e-4);
  assert.equal(d.punctBottom3.length, 3);
});

test('separationReport：可分特征分离度 > 1，同分布 ≈ 1，文件对分组正确', () => {
  // 8 文件：甲（甲一×2 + 甲二×2）+ 乙（乙一×2 + 乙二×2）
  const offsets = [-1, 0, 1, -1]; // 甲的 4 个文件
  const offsetsB = [0, 1, -1, 0]; // 乙的 4 个文件（同分布用）
  const mkFiles = (author, works, base, offs, offsB) => [
    { author, work: works[0], feat: { f饭: base + offs[0] } },
    { author, work: works[0], feat: { f饭: base + offs[1] } },
    { author, work: works[1], feat: { f饭: base + offs[2] } },
    { author, work: works[1], feat: { f饭: base + offs[3] } },
    { author: '乙', work: '乙一', feat: { f饭: base + offsB[0] } },
    { author: '乙', work: '乙一', feat: { f饭: base + offsB[1] } },
    { author: '乙', work: '乙二', feat: { f饭: base + offsB[2] } },
    { author: '乙', work: '乙二', feat: { f饭: base + offsB[3] } },
  ];

  // 可分：甲基线 100、乙基线 200 → 跨作者 Δ 远大于同作者跨书 Δ
  const sep = fp.separationReport(mkFiles('甲', ['甲一', '甲二'], 100, offsets, offsetsB.map(x => x + 100)));
  assert.equal(sep.sameWork.pairs, 4);
  assert.equal(sep.sameAuthorCrossBook.pairs, 8);
  assert.equal(sep.crossAuthor.pairs, 16);
  assert.ok(sep.separation > 2, `可分特征分离度应远大于 1，实得 ${sep.separation}`);

  // 同分布：两组基线相同、扰动模式一致 → 分离度 ≈ 1（手算值 0.875）
  const same = fp.separationReport(mkFiles('甲', ['甲一', '甲二'], 100, offsets, offsetsB));
  approx(same.separation, 0.875, 1e-9);
  assert.ok(Math.abs(same.separation - 1) < 0.35, '同分布时分离度应接近 1');
});

test('leaveOneBookOut：线性可分块数据 4/4 正确、margin > 0、单作品作者跳折', () => {
  const blocks = [];
  const addWork = (author, work, base) => {
    for (let i = 0; i < 5; i++) blocks.push({ author, work, feat: { f饭: base + i * 0.1 } });
  };
  addWork('甲', '甲一', 100);
  addWork('甲', '甲二', 105);
  addWork('乙', '乙一', 200);
  addWork('乙', '乙二', 205);
  addWork('丙', '丙一', 300); // 单作品作者：无法建「其余作品」质心，应跳折

  fp.zscoreAll(blocks);
  const r = fp.leaveOneBookOut(blocks);
  assert.equal(r.totalN, 4, '丙一应被跳过，只折 4 部可验证书');
  assert.equal(r.correctN, 4, '线性可分数据应 4/4 全对');
  assert.ok(!r.folds.some(f => f.book === '丙一'), '单作品作者的书不得出现在折中');
  for (const fold of r.folds) {
    assert.equal(fold.correct, true, `${fold.book} 整书归属应正确`);
    assert.ok(fold.margin > 0, `${fold.book} 裕度应为正，实得 ${fold.margin}`);
    assert.equal(fold.blockVoteRate, 1, `${fold.book} 块级投票应全对`);
  }
  assert.ok(r.meanMargin > 0);
});

test('zscoreAll：sd=0 特征置 1（零向量不放大噪声），deltaZ 对称', () => {
  const items = [
    { feat: { a: 1, b: 5 } },
    { feat: { a: 1, b: 7 } },
    { feat: { a: 1, b: 9 } },
  ];
  const keys = fp.zscoreAll(items);
  assert.deepEqual(keys, ['a', 'b']);
  for (const it of items) approx(it.z.a, 0, 1e-12); // 恒定特征 → z 全 0
  approx(items[0].z.b, -1.224744871391589, 1e-12);  // (5−7)/sd, sd=√(8/3)
  // deltaZ：平均绝对差（Burrows's Delta 口径）
  approx(fp.deltaZ(items[0].z, items[2].z, keys), (Math.abs(-1.224744871391589 - 1.224744871391589) + 0) / 2, 1e-12);
  approx(fp.deltaZ(items[1].z, items[0].z, keys), fp.deltaZ(items[0].z, items[1].z, keys), 1e-15);
});

test('fingerprintOf：features + distribution + hanCount 三件套', () => {
  const text = ('“' + FILLER.repeat(30) + '”道' + FILLER.repeat(20) + '。').repeat(10);
  const f = fp.fingerprintOf(text);
  assert.ok(f.features, '合成文本 ≥300 汉字应有特征');
  assert.ok(typeof f.features['f的'] === 'number');
  assert.ok(f.distribution.sentenceLen.p50 > 0);
  assert.equal(f.hanCount, f.distribution.hanCount);
  assert.ok(f.hanCount >= 300);
  // 短文本：features 为 null，distribution 仍可算（分布形态不设下限）
  const short = fp.fingerprintOf(FILLER.repeat(10));
  assert.equal(short.features, null);
  assert.equal(short.hanCount, 10);
});
