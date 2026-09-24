// L3 闸门的钉子测试（tools/distill/gates.js，纯函数零 LLM）。
// 每个用例钉的是一条**会造成实际误判**的语义，不是复述实现：
//  - 非重叠字面计数（「……」与「…」的计数差是闸门 3 的输入）
//  - marker 卫生四条判据（占位符会随掩码比例漂移，拿它算 lift 等于把掩码口径差当作者差异）
//  - 闸门 3 的三态（高频 marker 误杀 vs 幻觉放水，两侧都要防）
//  - 复现闸门的两条通过路径与「同块去重」「禁用书不计支撑」
//  - lift 必须按**每万字率**比，不能按原始次数比（两家语料体量不同）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const g = require('../tools/distill/gates');
const util = require('../tools/distill/util');

// ---------- 字面计数 ----------

test('countOccurrences：非重叠字面计数（marker 一律当字面串，不当正则）', () => {
  assert.equal(g.countOccurrences('啊……好……啊……', '……'), 3);
  assert.equal(g.countOccurrences('………', '……'), 1, '非重叠：3 个省略号字符只构成 1 个「……」');
  assert.equal(g.countOccurrences('a.b.c', '.'), 2);
  assert.equal(g.countOccurrences('a*b*c', '*'), 2, '正则元字符按字面处理：不得当通配符');
  assert.equal(g.countOccurrences('abc', 'x'), 0);
  assert.equal(g.countOccurrences('abc', ''), 0);
  assert.equal(g.countOccurrences(null, '…'), 0);
});

test('countOccurrencesInBuffer：与字符串版同结果（大语料走 Buffer）', () => {
  const s = '他说道：你好。她说道：再见。';
  const buf = Buffer.from(s, 'utf8');
  for (const m of ['说道', '：', '你好', '不存在']) {
    assert.equal(g.countOccurrencesInBuffer(buf, m), g.countOccurrences(s, m), `marker=${m}`);
  }
});

// ---------- marker 卫生 ----------

test('markerHygiene：四条判据各自的 kind 与 reason', () => {
  assert.deepEqual(g.markerHygiene('   '), { ok: false, kind: 'missing', reason: 'marker-missing' });
  assert.equal(g.markerHygiene('〔人名〕').reason, 'marker-placeholder');
  assert.equal(g.markerHygiene('〔人名〕：…').reason, 'marker-placeholder', '占位符混在更长的模式里也要拦');
  assert.equal(g.markerHygiene('〔功法〕').reason, 'marker-placeholder');
  assert.equal(g.markerHygiene('(本章完)').reason, 'marker-chapter-mark');
  assert.equal(g.markerHygiene('（本章完）').reason, 'marker-chapter-mark');
  // 长度按**码点**算：12 码点以内可用，13 起降档（白石 20.1% 的 marker 落在超长档）
  const cp12 = '一二三四五六七八九十十一';
  const cp13 = cp12 + '二';
  assert.equal(util.codePoints(cp12), 12);
  assert.equal(g.markerHygiene(cp12).ok, true);
  assert.equal(g.markerHygiene(cp13).reason, 'marker-too-long');
  assert.equal(g.markerHygiene('……').ok, true);
  assert.equal(g.markerHygiene('？！').ok, true);
});

// ---------- 闸门 3 · 计数交叉核对 ----------

test('countCrossCheck：真实频次与自报一致（或同量级）判 ok', () => {
  const block = '他说道：好。她说道：行。他又说道：走。';
  const r = g.countCrossCheck({ count: 3, marker: '说道' }, block);
  assert.equal(r.status, 'ok');
  assert.equal(r.real, 3);
});

test('countCrossCheck：marker 在自己块里一次都不出现 → mismatch（幻觉）', () => {
  const r = g.countCrossCheck({ count: 4, marker: '陡然' }, '他慢慢走过来，坐下。');
  assert.equal(r.status, 'mismatch');
  assert.equal(r.reason, 'marker-absent-in-block');
  assert.equal(r.real, 0);
});

test('countCrossCheck：差一个数量级以上 → mismatch', () => {
  const r = g.countCrossCheck({ count: 40, marker: '说道' }, '他说道：好。她说道：行。');
  assert.equal(r.status, 'mismatch');
  assert.equal(r.reason, 'count-off-by-order');
  assert.equal(r.real, 2);
});

// ---------- 闸门 3 · 零命中的分型（2026-09-13 修：描述型 marker 曾一律判死） ----------
// 实测背景：零命中条目里 84.4%（白石）/81.4%（青崖）的 marker 不是字面串而是**模式描述**
// （「四字格」「单句内逗号数≥4」「如…般」）。判死会把它们整条丢掉，而丢得多寡随作者的结构
// 特征浮动（26.1% vs 12.5%）→ 各作者进 reduce 的观测被不等地削掉，卡片之间不可比。

test('countCrossCheck：描述型 marker 零命中 → 降档 unverifiable（不是幻觉判死）', () => {
  const cases = [
    ['四字格', '连续四字短语'], ['单句内逗号数≥4', '短句'], ['如…般', '像风一样'],
    ['带着…，带着…，带着…', '无'], ['[单字动词]', '无'], ['第X更', '无'], ['（对话内）', '无'],
  ];
  for (const [marker, block] of cases) {
    const r = g.countCrossCheck({ count: 3, marker: marker }, block);
    assert.equal(r.status, 'unverifiable', `${marker} 应为降档`);
    assert.equal(r.reason, 'marker-descriptive', `${marker} 的降档原因`);
  }
});

test('countCrossCheck：先字面匹配再分型——字面存在的 marker 不受描述型判据影响', () => {
  // 「数日后」含结构名词「数」，但块里字面存在 → 仍要判 ok（判据顺序不能反）
  const r = g.countCrossCheck({ count: 2, marker: '数日后' }, '数日后他回来了。又过了一阵，数日后的事谁也说不清。');
  assert.equal(r.status, 'ok');
  assert.equal(r.real, 2);
});

test('countCrossCheck：真字面缺席仍判死（描述型判据不放过幻觉）', () => {
  const r = g.countCrossCheck({ count: 3, marker: '激灵灵打了个冷颤' }, '他慢慢走过来，坐下。');
  assert.equal(r.status, 'mismatch');
  assert.equal(r.reason, 'marker-absent-in-block');
});

test('countCrossCheck：半角标点 marker 而正文用全角 → 降档（拼写问题，非幻觉）', () => {
  const r = g.countCrossCheck({ count: 12, marker: ',' }, '他说道，好；她说道，行。');
  assert.equal(r.status, 'unverifiable');
  assert.equal(r.reason, 'marker-halfwidth-punct');
  assert.equal(r.real, 2, '全角形态的计数要报出来（供人工参考）');
  // 正文也是半角 → 正常走字面匹配
  const r2 = g.countCrossCheck({ count: 2, marker: ',' }, '他说道, 好.');
  assert.equal(r2.status, 'ok');
  // 全角形态也不存在 → 仍是幻觉判死
  const r3 = g.countCrossCheck({ count: 9, marker: ',' }, '他说道好她说道行');
  assert.equal(r3.status, 'mismatch');
});

test('countCrossCheck：高频 marker 的宽偏差判 unverifiable 而不是 mismatch（防误杀）', () => {
  // 8,000 字块里「！」真实出现 1,200 次（≥ HIGHFREQ_ABS_COUNT=200）→ 计数语义含混，降档不判死
  const block = '！'.repeat(1200) + '正文'.repeat(3400);
  const r = g.countCrossCheck({ count: 12, marker: '！' }, block);
  assert.equal(r.status, 'unverifiable');
  assert.equal(r.reason, 'marker-highfreq');
  assert.equal(r.real, 1200);
  // 同一块里中频 marker 的同样偏差就要判死——豁免只在「本块真实频次极高」这一侧成立
  const r2 = g.countCrossCheck({ count: 3, marker: '正文' }, '正文'.repeat(60) + '其它'.repeat(3940));
  assert.equal(r2.status, 'mismatch');
  assert.equal(r2.reason, 'count-off-by-order');
  // 短块上不得因为「每万字率虚高」而免死（单测暴露过的判据缺陷）
  const r3 = g.countCrossCheck({ count: 40, marker: '说道' }, '他说道：好。她说道：行。');
  assert.equal(r3.status, 'mismatch');
});

test('countCrossCheck：不可核对的三种情形都归 unverifiable 并带原因', () => {
  assert.equal(g.countCrossCheck({ count: 2 }, '文本').reason, 'marker-missing');
  assert.equal(g.countCrossCheck({ count: 2, marker: '〔人名〕' }, '〔人名〕说').reason, 'marker-placeholder');
  assert.equal(g.countCrossCheck({ count: 2, marker: '……' }, '').reason, 'block-text-missing');
  assert.equal(g.countCrossCheck({ count: 0, marker: '……' }, '……').reason, 'count-invalid');
  assert.equal(g.countCrossCheck({ count: 2, marker: '……' }, '……').status, 'ok');
});

// ---------- 闸门 1 · 复现 ----------

/** 造一条 kept 条目（默认 marker=「……」、count 与真实一致，避免闸门 3 干扰）。 */
function item(work, chunkIndex, over = {}) {
  return {
    dim: over.dim || '标点', trait: over.trait || '爱用省略号', evidence: '……', count: 2,
    marker: over.marker === undefined ? '……' : over.marker,
    work: work, chunkIndex: chunkIndex,
    countCheck: over.countCheck || { status: 'ok' },
  };
}

test('reproduceGate：≥2 作品通过，tier=cross-work', () => {
  const r = g.reproduceGate([item('甲书', 1), item('乙书', 5)]);
  assert.equal(r.passed.length, 1);
  assert.equal(r.dropped.length, 0);
  assert.deepEqual(r.passed[0].support, { works: 2, blocks: 2, chars: 2 * util.MAP_CHUNK_SIZE, advisoryBlocks: 0 });
  assert.equal(r.passed[0].tier, 'cross-work');
});

test('reproduceGate：单作品 8 块通过（=64,000 字硬线），7 块不过', () => {
  const eight = g.reproduceGate(Array.from({ length: 8 }, (_, i) => item('甲书', i)));
  assert.equal(eight.passed.length, 1);
  assert.equal(eight.passed[0].tier, 'single-work', '单作品路径支撑更弱，必须可区分');
  assert.equal(eight.passed[0].support.chars, g.REPRO_MIN_CHARS);
  const seven = g.reproduceGate(Array.from({ length: 7 }, (_, i) => item('甲书', i)));
  assert.equal(seven.passed.length, 0);
  assert.equal(seven.dropped[0].reason, 'not-reproduced');
});

test('reproduceGate：同一块里的重复条目只算一块', () => {
  const r = g.reproduceGate([
    item('甲书', 3), item('甲书', 3), item('甲书', 3), item('甲书', 3),
    item('甲书', 4), item('甲书', 4), item('甲书', 5), item('甲书', 6),
  ]);
  assert.equal(r.passed.length, 0);
  assert.equal(r.dropped[0].support.blocks, 4, '8 条条目只落在 4 个块上 → 不该冒充 8 块');
  assert.equal(r.dropped[0].reason, 'not-reproduced');
});

test('reproduceGate：被闸门 3 判死的条目不计支撑，也不能把组抬过线', () => {
  const items = Array.from({ length: 8 }, (_, i) => item('甲书', i));
  items[0].countCheck = { status: 'mismatch' };
  const r = g.reproduceGate(items);
  assert.equal(r.passed.length, 0);
  assert.equal(r.dropped[0].support.blocks, 7);
  assert.equal(r.dropped[0].checks.mismatch, 1, '档位计数要留痕');
  assert.equal(r.dropped[0].reason, 'not-reproduced');
});

test('reproduceGate：裕度不足的书（disabledWorks）不计支撑，条目降 advisory 并留痕', () => {
  const items = [item('蔽霄', 0), item('太虚古界', 1), item('太虚古界', 2)];
  const r = g.reproduceGate(items, { disabledWorks: new Set(['蔽霄']) });
  assert.equal(r.passed.length, 0, '蔽霄被禁用后只剩 2 块，两条通过路径都不满足');
  assert.equal(r.dropped[0].support.advisoryBlocks, 1);
  assert.equal(r.advisory.length, 1, 'advisory 条目必须能被报告消费，不许静默丢');
  assert.equal(r.advisory[0].work, '蔽霄');
});

test('reproduceGate：不同 marker 或不同维度不得并组', () => {
  const r = g.reproduceGate([
    item('甲书', 1), item('甲书', 2),
    item('乙书', 1, { marker: '！' }), item('乙书', 2, { marker: '！' }),
    item('甲书', 3, { dim: '句法' }), item('乙书', 3, { dim: '句法' }),
  ]);
  assert.equal(r.passed.length + r.dropped.length, 3, '同 marker 不同 dim、同 dim 不同 marker 都是不同的组');
});

test('reproduceGate：无 marker 的定性条目按 trait 文本并组（降档兜底路径）', () => {
  const a = item('甲书', 1, { marker: '' });
  const b = item('甲书', 2, { marker: '' });
  const r = g.reproduceGate([a, b]);
  assert.equal(r.passed.length + r.dropped.length, 1, '无 marker 时以 trait 文本为键，同文本可并组');
  assert.equal(r.dropped.length, 1, '只有 1 本书 2 块 → 仍不达复现线');
  assert.equal(r.dropped[0].reason, 'not-reproduced');
});

// ---------- 闸门 2 · lift ----------

/** 造一个率表查询：返回固定次数（Chars 用常量，便于按率手算）。 */
function lookup(tCount, cCount, tChars = 1000000, cChars = 1000000) {
  return () => ({ targetCount: tCount, targetChars: tChars, contrastCount: cCount, contrastChars: cChars });
}

const group = (marker) => ({ key: `标点\u0000${marker}`, dim: '标点', marker, traits: [], items: [], support: {} });

test('liftGate：率比 ≥1.3 通过，<1.3 丢弃', () => {
  const hi = g.liftGate([group('……')], lookup(200, 100)).passed[0];
  assert.equal(hi.lift, 2);
  assert.equal(hi.liftTier, 'lift');
  const lo = g.liftGate([group('……')], lookup(120, 100)).dropped[0];
  assert.ok(Math.abs(lo.lift - 1.2) < 1e-9);
  assert.equal(lo.reason, 'lift-below-threshold');
});

test('liftGate：按每万字率比，不按原始次数比（两家语料体量不同）', () => {
  // 目标 8.9M 字出现 400 次（0.449/万字）vs 对照 2.5M 字出现 100 次（0.4/万字）→ 1.12 → 丢弃
  const r = g.liftGate([group('缓缓')], lookup(400, 100, 8900000, 2500000));
  assert.ok(Math.abs(r.dropped[0].lift - 1.1236) < 0.001, `实得 ${r.dropped[0].lift}`);
});

test('liftGate：对照侧 0 次单独标记 contrast-zero（最弱的通过路径，不许混进 lift 档）', () => {
  const r = g.liftGate([group('蓦然')], lookup(300, 0)).passed[0];
  assert.equal(r.liftTier, 'contrast-zero');
  assert.equal(r.lift, Infinity);
  assert.equal(r.liftReason, 'contrast-zero');
});

test('liftGate：目标侧次数不足 MIN_TARGET_COUNT 判偶发（挡住 lift=∞ 的噪声）', () => {
  const r = g.liftGate([group('陡然间'),], lookup(3, 0));
  assert.equal(r.dropped[0].reason, 'marker-too-rare');
  assert.equal(r.dropped[0].liftTier, 'below-min-count');
});

test('liftGate：不可核对的 marker 不适用 lift，降档保留而不是丢弃', () => {
  // 占位符 marker 在有足够支撑时能过复现闸门（8 块），到 lift 这一步因不可核对而降档
  const items = Array.from({ length: 8 }, (_, i) => item('甲书', i, { marker: '〔人名〕' }));
  const rec = g.reproduceGate(items).passed[0];
  const r = g.liftGate([rec], lookup(999, 0));
  assert.equal(r.dropped.length, 0);
  assert.equal(r.passed[0].liftTier, 'qualitative');
  assert.equal(r.passed[0].liftReason, 'marker-placeholder');
});

// ---------- 约束 ① · 每书先验裕度 ----------

test('bookMarginGate：裕度 <0.05 或缺失 → 禁用块级证据并留痕', () => {
  const r = g.bookMarginGate([
    { work: '蔽霄', margin: 0.014, blocks: 904, attribution: 0.672 },
    { work: '逆仙', margin: 0.103, blocks: 927, attribution: 0.998 },
    { work: '问魔', margin: null, blocks: 655 },
  ]);
  assert.deepEqual([...r.disabled].sort(), ['蔽霄', '问魔']);
  assert.equal(r.rows.find((x) => x.work === '逆仙').disabled, false);
  assert.equal(r.rows.find((x) => x.work === '问魔').reason, 'margin-unavailable', '没测到裕度 ≠ 裕度合格');
  assert.equal(r.marginMin, g.MARGIN_MIN);
});

// ---------- 闸门 1+2 在合并簇上的判定（reduce 之后） ----------

const cluster = (o = {}) => Object.assign({
  dim: '标点', trait: '爱用省略号', markers: ['……'],
  support: { works: 2, blocks: 9, chars: 72000, items: 9 },
  checks: { ok: 9 }, items: [{}],
}, o);

test('clusterGate：簇的 lift 取所有可核对 marker 里的最大值，并记下中标 marker', () => {
  // 「……」与对照侧同率（1.5 倍，勉强达线），「立刻」是 8 倍——应取 8 倍并记下标的是「立刻」
  const rates = (m) => (m === '立刻'
    ? { targetCount: 80, targetChars: 1000000, contrastCount: 10, contrastChars: 1000000 }
    : { targetCount: 15, targetChars: 1000000, contrastCount: 10, contrastChars: 1000000 });
  const r = g.clusterGate([cluster({ markers: ['……', '立刻'] })], rates);
  assert.equal(r.passed.length, 1);
  assert.equal(r.passed[0].lift, 8);
  assert.equal(r.passed[0].liftMarker, '立刻');
  assert.equal(r.passed[0].liftTier, 'lift');
  // 单个 marker 时同样要能通过（max 的退化情形）
  const one = g.clusterGate([cluster({ markers: ['立刻'] })], rates);
  assert.equal(one.passed[0].liftMarker, '立刻');
});

test('clusterGate：支撑不足先判死（闸门 1 优先于闸门 2）', () => {
  const r = g.clusterGate([cluster({ support: { works: 1, blocks: 5, chars: 40000, items: 5 } })], () => ({ targetCount: 999, targetChars: 1e6, contrastCount: 0, contrastChars: 1e6 }));
  assert.equal(r.passed.length, 0);
  assert.equal(r.dropped[0].reason, 'not-reproduced');
});

test('clusterGate：不可核对 marker 的簇降档保留；可核对但全不达线的簇按原因丢', () => {
  const qual = g.clusterGate([cluster({ markers: ['〔人名〕'] })], () => ({ targetCount: 999, targetChars: 1e6, contrastCount: 0, contrastChars: 1e6 }));
  assert.equal(qual.passed[0].liftTier, 'qualitative');
  const rare = g.clusterGate([cluster()], () => ({ targetCount: 3, targetChars: 1e6, contrastCount: 0, contrastChars: 1e6 }));
  assert.equal(rare.dropped[0].reason, 'marker-too-rare');
  const low = g.clusterGate([cluster()], () => ({ targetCount: 120, targetChars: 1e6, contrastCount: 100, contrastChars: 1e6 }));
  assert.equal(low.dropped[0].reason, 'lift-below-threshold');
});

test('clusterGate：冲突簇与 variants 原样带出（人工裁决要靠它）', () => {
  const r = g.clusterGate([cluster({ conflict: true, variants: ['大量用省略号', '极少用省略号'] })], () => ({ targetCount: 200, targetChars: 1e6, contrastCount: 100, contrastChars: 1e6 }));
  assert.equal(r.passed[0].conflict, true);
  assert.equal(r.passed[0].variants.length, 2);
});

// ---------- 5 条硬约束的常量钉子（防有人「顺手」改阈值而不改报告） ----------

test('5 条硬约束的常量与报告口径一致（改常量必须同时改报告）', () => {
  assert.equal(g.LIFT_MIN, 1.3, '设计 §3.3 定的 lift 下限');
  assert.equal(g.REPRO_MIN_WORKS, 2);
  assert.equal(g.REPRO_MIN_BLOCKS, 8);
  assert.equal(g.REPRO_MIN_CHARS, 8 * util.MAP_CHUNK_SIZE, '约束 ④：8 块 = 8,000 字 × 8');
  assert.equal(g.MARGIN_MIN, 0.05, '约束 ①：05 报告 §5 的裕度硬线');
  assert.equal(util.MAP_CHUNK_SIZE, 8000, '约束 ②：块级单元硬线 ≥8,000 字');
  assert.equal(g.COUNT_ORDER_TOL, 10, '闸门 3：一个数量级');
});

test('reasonTally：按 reason 汇总丢弃条目', () => {
  const t = g.reasonTally([{ reason: 'a' }, { reason: 'a' }, { reason: 'b' }]);
  assert.deepEqual(t, { a: 2, b: 1 });
  assert.deepEqual(g.reasonTally(null), {});
});
