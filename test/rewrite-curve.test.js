// 改写收益曲线（人改比例 → 检测分）回归：钉住比例口径、曲线几何与草稿持久化。
const test = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../public/rewrite-curve');

test('changed 判定：只去空白不算人改，字数或内容变了才算', () => {
  assert.equal(RC.createItem('他走进屋子。', '他走进屋子。').changed, false);
  assert.equal(RC.createItem('他走进屋子。', '他走进屋子。 ').changed, false, '尾部空格不算改动');
  assert.equal(RC.createItem('他走进屋子。', '他推门进屋。').changed, true);
  assert.equal(RC.createItem('他走进屋子。', '他进屋，目光扫过角落。').changed, true);
});

test('汇总按字数为准，同时给出段数口径', () => {
  const items = RC.normalizeItems(['一二三四五', '六七八九十', '甲乙丙丁戊己庚辛']);
  items[0].rewritten = '一二三四五六七八九十一二';
  items[0].changed = true;
  items[0].newChars = 14;
  const s = RC.summarize(items);
  assert.equal(s.totalCount, 3);
  assert.equal(s.changedCount, 1);
  assert.equal(s.changedChars, 14);
  assert.equal(s.ratioByChars, Math.round((14 / (14 + 5 + 8)) * 1000) / 1000);
  assert.equal(s.ratioByCount, Math.round((1 / 3) * 1000) / 1000);
});

test('拼回全文：已改用改写稿、未改用原文、空段丢弃', () => {
  const items = RC.normalizeItems(['甲', '乙', '']);
  items[1].rewritten = '乙改';
  items[1].changed = true;
  assert.equal(RC.assemble(items), '甲\n\n乙改');
});

test('测量点：连续重复（同比例同分数）只记次数，不刷屏', () => {
  let series = [];
  series = RC.addPoint(series, { ratio: 0.25, conf: 0.9999, chars: 3000, at: 't1' });
  series = RC.addPoint(series, { ratio: 0.25, conf: 0.9999, chars: 3000, at: 't2' });
  assert.equal(series.length, 1, '重复测量合并');
  assert.equal(series[0].n, 2);
  assert.equal(series[0].at, 't2');
  series = RC.addPoint(series, { ratio: 0.33, conf: 0.9999, chars: 3000, at: 't3' });
  assert.equal(series.length, 2, '比例变了就新起一点');
});

test('测量点：比例按 1% 粒度归并，分数保留 4 位', () => {
  const s = RC.addPoint([], { ratio: 0.2549, conf: 0.611111, chars: 10 });
  assert.equal(s[0].ratio, 0.25);
  assert.equal(s[0].conf, 0.6111);
});

test('测量点：无分数的点也允许记录（上游失败时留痕）', () => {
  const s = RC.addPoint([], { ratio: 0, conf: null });
  assert.equal(s[0].conf, null);
  assert.equal(s[0].n, 1);
});

test('曲线坐标：落在 padding 之内，越界被夹住，无分数的点被丢弃', () => {
  const pts = RC.plotPoints([
    { ratio: 0, conf: 0 }, { ratio: 1, conf: 1 }, { ratio: 1.4, conf: -0.2 }, { ratio: 0.5, conf: null },
  ], { width: 320, height: 160 });
  assert.equal(pts.length, 3, 'conf 为 null 的点不画');
  assert.ok(pts.every(p => p.x >= 34 && p.x <= 310 && p.y >= 10 && p.y <= 138), '全部落在绘图区内');
  assert.ok(pts[1].y < pts[0].y, '分数高 → y 更小（1 在顶端）');
  assert.equal(typeof pts[0].label, 'string');
  assert.ok(pts[0].label.includes('很像人写的'));
});

test('seriesPath 生成合法 SVG path', () => {
  const pts = RC.plotPoints([{ ratio: 0, conf: 0.1 }, { ratio: 0.5, conf: 0.4 }]);
  const d = RC.seriesPath(pts);
  assert.ok(d.startsWith('M'));
  assert.equal((d.match(/L/g) || []).length, pts.length - 1);
  assert.equal(RC.seriesPath([]), '');
});

test('进度文案：未改 / 已改两种口径都读得出来', () => {
  assert.equal(RC.describeProgress(RC.summarize([])), '还没有载入段落');
  const empty = RC.normalizeItems(['甲', '乙']);
  assert.ok(RC.describeProgress(RC.summarize(empty)).includes('尚未改写'));
  empty[0].rewritten = '甲改'; empty[0].changed = true;
  const txt = RC.describeProgress(RC.summarize(empty));
  assert.ok(txt.includes('已改 1/2 段'));
  assert.ok(txt.includes('占'));
});

test('分档与 style-health 的展示分档同序（0.2/0.5/0.7/0.9）', () => {
  assert.equal(RC.bandOf(0.1).label, '很像人写的');
  assert.equal(RC.bandOf(0.3).label, '偏人工');
  assert.equal(RC.bandOf(0.6).label, '疑似 AI');
  assert.equal(RC.bandOf(0.8).label, 'AI 味较重');
  assert.equal(RC.bandOf(0.99).label, 'AI 味很重');
  assert.equal(RC.bandOf(null).label, '—');
});

// ---------------- 草稿持久化 ----------------
function fakeStorage(initial) {
  const data = { ...(initial || {}) };
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

test('草稿存留：按书+章取键，刷新（重建 store）后改写与曲线都在', () => {
  const storage = fakeStorage();
  const store = RC.createDraftStore({ storage });
  const items = RC.normalizeItems(['甲', '乙']);
  items[0].rewritten = '甲改成一段人写的字'; items[0].changed = true;
  const series = RC.addPoint([], { ratio: 0.5, conf: 0.62, chars: 12, at: 't1' });
  assert.equal(store.save(7, 3, { items, series }), true);

  const reloaded = RC.createDraftStore({ storage });
  const d = reloaded.load(7, 3);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].changed, true);
  assert.equal(d.items[0].rewritten, '甲改成一段人写的字');
  assert.equal(d.items[1].changed, false);
  assert.equal(d.series.length, 1);
  assert.equal(d.series[0].conf, 0.62);
  assert.equal(reloaded.load(7, 4), null, '别的章没有草稿');
  assert.equal(reloaded.load(8, 3), null, '别的书没有草稿');
});

test('草稿可清除；清掉后读回 null', () => {
  const storage = fakeStorage();
  const store = RC.createDraftStore({ storage });
  store.save(1, 1, { items: RC.normalizeItems(['甲']), series: [] });
  assert.ok(store.load(1, 1));
  store.clear(1, 1);
  assert.equal(store.load(1, 1), null);
});

test('坏数据/无存储/存储抛错一律退化为「没有草稿」，不炸', () => {
  const broken = RC.createDraftStore({ storage: fakeStorage({ 'novel-rewrite:1:1': '{不是 JSON' }) });
  assert.equal(broken.load(1, 1), null);
  const wrongShape = RC.createDraftStore({ storage: fakeStorage({ 'novel-rewrite:1:1': '{"items":"x"}' }) });
  assert.equal(wrongShape.load(1, 1), null);
  const none = RC.createDraftStore({ storage: null });
  assert.equal(none.load(1, 1), null);
  assert.equal(none.save(1, 1, { items: [], series: [] }), false);
  const throwing = RC.createDraftStore({
    storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } },
  });
  assert.equal(throwing.load(1, 1), null);
  assert.doesNotThrow(() => throwing.save(1, 1, { items: [], series: [] }));
  assert.doesNotThrow(() => throwing.clear(1, 1));
});

test('无效 id 不写不炸', () => {
  const store = RC.createDraftStore({ storage: fakeStorage() });
  assert.equal(store.load(null, 1), null);
  assert.equal(store.save(1, undefined, { items: [], series: [] }), false);
  assert.doesNotThrow(() => store.clear(null, null));
});
