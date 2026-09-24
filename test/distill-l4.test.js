// L4 入库契约（第 4 步）：范文卫生 / 源集引用裁决 / 幂等替换 / 多卡隔离。
//
// 核心不变量：
//   ① 入卡的范文**只用四类占位符**、**专名 0 残留**、**块长在嵌入边界内**（第 4 步验收口径）；
//   ② 重跑幂等：只覆盖自己上次写的（`source` 带 `distill/` 前缀），人工范文不动；
//   ③ 多卡隔离：一张卡的范文只来自它自己的源集，检索按 pack_id 天然不串味；
//   ④ 边界可见：词表版本不符要告警并刷新，源集悬空要跳过并记日志（都不许静默全库检索）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const mask = require('../tools/distill/mask');
const l4 = require('../tools/distill/l4');
const select = require('../tools/distill/select');
const retrieve = require('../server/style/retrieve');

// ---------- 合成语料（不依赖真实语料，测试可秒级跑完） ----------

const LONG = [
  '山风从崖顶压下来，把整片松林压出一道又一道的弧线，像有人拿梳子理过整座山。',
  '他把手按在石壁上，指节扣进石缝，感受着那道沿着岩层爬下来的裂纹，比昨天更深了。',
  '远处的雾散得很慢，先是露出半截峰顶，再露出整条山脊，最后连山脚的石阶都看得清清楚楚。',
];
const SHORT = ['风停了。', '刀很快。', '没人动。', '他退了一步。', '血滴在石头上。'];
const DIALOG = ['「你确定要这么做？」', '「我确定。」', '「那就别回头。」', '「回头也没路。」'];

/** 确定性的合成文本（同一 seed 必然同一结果）。 */
function synth(name, chars, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const parts = [];
  let len = 0;
  while (len < chars) {
    const r = rnd();
    let add;
    if (r < 0.36) add = LONG[Math.floor(rnd() * LONG.length)].replace('他', name);
    else if (r < 0.68) add = DIALOG[Math.floor(rnd() * DIALOG.length)] + (rnd() < 0.5 ? name : '她') + DIALOG[Math.floor(rnd() * DIALOG.length)];
    else add = SHORT[Math.floor(rnd() * SHORT.length)];
    if (rnd() < 0.06) add = `第${Math.floor(len / 200) + 1}章 试炼`; // 章标题行应被剔掉
    parts.push(add);
    len += Array.from(add).length + 1;
  }
  return parts.join('\n');
}

/** 建合成语料：<root>/<题材>/<作者>/<作品>.txt（3 层形态）。 */
function makeCorpus(root, layout) {
  for (const item of layout) {
    const dir = path.join(root, item.topic, item.author);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${item.work}.txt`), item.text, 'utf8');
  }
  return root;
}

/** 写一份最小可用词典（loadDict 从 dataRoot 下读，故必须落盘）。 */
function saveDict(dataRoot, author, entries, version) {
  mask.saveDict(author, { version: version, entries: entries, meta: {} }, dataRoot);
}

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-l4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setupDb(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

/** 注册源集（corpus_sources 行平时由 fingerprint 命令写；这里直接插，测试不跑全语料）。 */
function registerSource(author, dictVersion) {
  return db.run(
    'INSERT INTO corpus_sources (author, works_json, han_count, sha256, fingerprint_json, mask_dict_version, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [author, '[]', 0, 'test', '{}', dictVersion, `data/corpus/src-${author}`]
  ).lastInsertRowid;
}

// ---------- 卫生检查 ----------

test('sampleHygiene：四类占位符通过；非法占位符 / 括号不配对 / 专名残留 / 超长各自命中', () => {
  const names = new Set(['沈觉', '楚昭月']);

  const ok = l4.sampleHygiene('〔人名〕看着〔地名〕，〔势力〕的人来了，用的还是〔功法〕。', names);
  assert.equal(ok.ok, true, '四类占位符齐备且无专名 → 通过');
  assert.equal(ok.placeholders.length, 4);
  assert.equal(ok.chars, 29);

  const illegal = l4.sampleHygiene('〔动物园〕的门开了。', names);
  assert.equal(illegal.ok, false);
  assert.deepEqual(illegal.illegal, ['〔动物园〕'], '白名单外的占位符必须判非法');
  assert.ok(illegal.problems.includes('placeholder-illegal'));

  const unbalanced = l4.sampleHygiene('〔人名〕的剑掉了，〔地名 也碎了。', names);
  assert.equal(unbalanced.ok, false);
  assert.ok(unbalanced.problems.some((p) => p.startsWith('placeholder-unbalanced')), '被切坏的占位符要单独判');

  const leak = l4.sampleHygiene('〔人名〕转过身，沈觉站在原地没动。', names);
  assert.equal(leak.ok, false);
  assert.deepEqual(leak.nameHits, ['沈觉'], '专名残留必须被点名（这是验收项的反面证据）');
  assert.ok(leak.problems.includes('proper-name-leak'));

  const long = l4.sampleHygiene('字'.repeat(501), names);
  assert.equal(long.ok, false);
  assert.ok(long.problems.some((p) => p.startsWith('too-long')));
});

test('healPlaceholderEdges：左边界孤立〕砍到为止，右边界未闭合〔砍掉', () => {
  assert.deepEqual(l4.healPlaceholderEdges('〔人名〕走了。'), { text: '〔人名〕走了。', leftTrim: 0 });
  const left = l4.healPlaceholderEdges('名〕走了。');
  assert.equal(left.text, '走了。');
  assert.equal(left.leftTrim, 2, 'leftTrim 用于同步修正 charStart 溯源');
  const right = l4.healPlaceholderEdges('走了〔人');
  assert.equal(right.text, '走了');
  assert.equal(right.leftTrim, 0);
  // 中间完整的占位符不受影响
  assert.equal(l4.healPlaceholderEdges('他〔人名〕说〔地名〕。').text, '他〔人名〕说〔地名〕。');
});

// ---------- 源集引用裁决 ----------

test('resolveSourceRefs：可用 / 词表版本不符拒绝 / 源集不存在悬空 / 非法 id', () => {
  const sources = {
    3: { author: '白石', mask_dict_version: 'v2-abc', dir_path: 'data/corpus/src-白石' },
    7: { author: '晚棠未开', mask_dict_version: 'v1-xyz', dir_path: 'data/corpus/src-晚棠未开' },
  };
  const r = l4.resolveSourceRefs([
    { sourceId: 3, maskDictVersion: 'v2-abc', generation: 1 },   // 版本一致 → 可用
    { sourceId: 7, maskDictVersion: 'v0-old', generation: 2 },   // 版本不符 → 拒绝
    { sourceId: 99, maskDictVersion: 'v1' },                     // 源集不存在 → 悬空
    { maskDictVersion: 'v1' },                                   // 没有 sourceId → 悬空
  ], sources);

  assert.equal(r.usable.length, 1);
  assert.equal(r.usable[0].sourceId, 3);
  assert.equal(r.usable[0].author, '白石');
  assert.equal(r.usable[0].generation, 1);

  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].reason, 'mask-dict-mismatch');
  assert.equal(r.refused[0].refVersion, 'v0-old');
  assert.equal(r.refused[0].sourceVersion, 'v1-xyz');

  assert.equal(r.dangling.length, 2);
  assert.deepEqual(r.dangling.map((d) => d.reason), ['source-not-found', 'bad-source-id']);

  // 空输入：不抛错，三桶都空
  assert.deepEqual(l4.resolveSourceRefs(null, sources), { usable: [], refused: [], dangling: [] });
});

// ---------- 端到端：选样 → 卫生 → 建卡 → 写入 ----------

test('runL4：建印记卡 + 挂 source_refs + 范文入库（400 字内、四类占位符、专名 0 残留、带溯源）', async (t) => {
  await setupDb(t);
  const dataRoot = tmpRoot(t);
  const corpusRoot = tmpRoot(t);
  saveDict(dataRoot, '白石', [
    { name: '沈觉', type: 'person' }, { name: '楚昭月', type: 'person' },
    { name: '北斗', type: 'place' }, { name: '荒古禁地', type: 'place' },
  ], 'v1-test');
  makeCorpus(corpusRoot, [
    { topic: '玄幻', author: '白石', work: '蔽霄', text: synth('沈觉', 6000, 11) },
    { topic: '玄幻', author: '白石', work: '太虚古界', text: synth('楚昭月', 6000, 22) },
  ]);
  const sid = registerSource('白石', 'v1-test');

  const logs = [];
  const r = await l4.runL4({
    corpusRoot, author: '白石', dataRoot, db, k: 4, log: (m) => logs.push(m),
  });

  assert.equal(r.created, true, '首次应新建印记卡');
  assert.equal(r.packName, '白石', '卡名 = 作家名（一作家一卡）');
  assert.equal(r.dictVersion, 'v1-test');
  assert.equal(r.hygiene.candidates, r.rows.length + r.rejected.length);
  assert.ok(r.rows.length > 0, '应该选出范文');

  const packRow = db.get('SELECT * FROM style_packs WHERE id = ?', [r.packId]);
  assert.equal(packRow.kind, 'imprint');
  assert.deepEqual(JSON.parse(packRow.source_refs), [{ sourceId: sid, maskDictVersion: 'v1-test', generation: 1 }]);

  const rows = db.all('SELECT * FROM style_samples WHERE pack_id = ? ORDER BY sort_order', [r.packId]);
  assert.equal(rows.length, r.rows.length);
  assert.deepEqual(rows.map((x) => x.sort_order), rows.map((_, i) => i), 'sort_order 连续，注入顺序即优先级');
  for (const row of rows) {
    assert.ok(row.source.startsWith('distill/白石/'), `溯源前缀: ${row.source}`);
    assert.ok(Array.from(row.text).length <= 400, '范文 ≤400 字（嵌入边界内）');
    assert.equal(row.char_count, Array.from(row.text).length);
    assert.equal(row.content_hash.length, 64, 'content_hash 是 sha256');
    assert.ok(!/沈觉|楚昭月|北斗|荒古禁地/.test(row.text), `专名 0 残留: ${row.title}`);
    for (const ph of row.text.match(/〔[^〕]*〕/g) || []) {
      assert.ok(l4.PLACEHOLDER_SET.has(ph), `占位符必须四类之一，实际 ${ph}`);
    }
    assert.equal((row.text.match(/〔/g) || []).length, (row.text.match(/〕/g) || []).length, '括号配对');
  }
  // 有专名的块被掩码（说明掩码在位，不是「恰好没专名」）
  assert.ok(rows.some((x) => x.text.includes('〔人名〕')), '范文里应出现〔人名〕（范文一律用掩码后原句）');
  assert.ok(logs.some((m) => m.includes('选样')), '选样日志必须落下来');
});

test('runL4：重跑幂等（只覆盖 distill/ 前缀的范文，人工范文与 generation 语义正确）', async (t) => {
  await setupDb(t);
  const dataRoot = tmpRoot(t);
  const corpusRoot = tmpRoot(t);
  saveDict(dataRoot, '白石', [{ name: '沈觉', type: 'person' }], 'v1-test');
  makeCorpus(corpusRoot, [{ topic: '玄幻', author: '白石', work: '蔽霄', text: synth('沈觉', 6000, 7) }]);
  registerSource('白石', 'v1-test');

  const first = await l4.runL4({ corpusRoot, author: '白石', dataRoot, db, k: 3 });
  // 人工加一段范文（source 不带 distill/ 前缀，模拟作家卡页手工粘贴）
  db.run("INSERT INTO style_samples (pack_id, title, text, source, char_count, sort_order, enabled, content_hash) VALUES (?, '人工', '人工范文。', 'manual', 5, 99, 1, '')", [first.packId]);
  const manualBefore = db.get("SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ? AND source = 'manual'", [first.packId]).n;
  assert.equal(manualBefore, 1);

  const second = await l4.runL4({ corpusRoot, author: '白石', dataRoot, db, k: 3 });
  assert.equal(second.created, false, '第二次应复用同一张卡，不新建');
  assert.equal(second.packId, first.packId);
  assert.ok(second.deleted > 0, '应删掉自己上次写的范文');
  const total = db.get('SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ?', [first.packId]).n;
  assert.equal(total, second.rows.length + 1, '总行数 = 本次范文 + 人工范文（幂等，不堆积）');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ? AND source = 'manual'", [first.packId]).n, 1, '人工范文必须留下');
  const refs = JSON.parse(db.get('SELECT source_refs FROM style_packs WHERE id = ?', [first.packId]).source_refs);
  assert.equal(refs[0].generation, 2, '每入库一次 generation +1（第几代范文）');
});

test('runL4：词表版本不符要告警并按当前词表刷新；源集悬空要跳过并记日志；dry-run 不写库', async (t) => {
  await setupDb(t);
  const dataRoot = tmpRoot(t);
  const corpusRoot = tmpRoot(t);
  saveDict(dataRoot, '白石', [{ name: '沈觉', type: 'person' }], 'v2-new');
  makeCorpus(corpusRoot, [{ topic: '玄幻', author: '白石', work: '蔽霄', text: synth('沈觉', 6000, 3) }]);
  const sid = registerSource('白石', 'v2-new');

  // 预置一张旧卡：范文基于旧词表 v1-old，且引用了一个不存在的源集 999
  const packId = db.run(
    "INSERT INTO style_packs (name, kind, book_id, persona, profile_json, source_refs, note, builtin, enabled) VALUES ('白石', 'imprint', NULL, '', '{}', ?, '', 0, 1)",
    [JSON.stringify([{ sourceId: sid, maskDictVersion: 'v1-old', generation: 3 }, { sourceId: 999, maskDictVersion: 'v1-old' }])]
  ).lastInsertRowid;

  const logs = [];
  const dry = await l4.runL4({ corpusRoot, author: '白石', dataRoot, db, k: 3, log: (m) => logs.push(m), write: false });
  assert.equal(dry.rows.length > 0, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ?', [packId]).n, 0, 'dry-run 不写库');
  assert.equal(dry.refs.refused.length, 1, '版本不符 → 拒绝桶');
  assert.equal(dry.refs.refused[0].sourceVersion, 'v2-new');
  assert.equal(dry.refs.dangling.length, 1, '源集 999 不存在 → 悬空桶');

  const r = await l4.runL4({ corpusRoot, author: '白石', dataRoot, db, k: 3, log: (m) => logs.push(m) });
  assert.equal(r.packId, packId, '复用已有印记卡');
  assert.ok(logs.some((m) => m.includes('词表版本不符')), '版本不符必须告警（可见）');
  assert.ok(logs.some((m) => m.includes('不存在的源集')), '悬空源集必须记日志');
  const refs = JSON.parse(db.get('SELECT source_refs FROM style_packs WHERE id = ?', [packId]).source_refs);
  assert.deepEqual(refs, [
    { sourceId: 999, maskDictVersion: 'v1-old' },                              // 悬空：保留在卡上，不参与选样
    { sourceId: sid, maskDictVersion: 'v2-new', generation: 4 },               // 本作者：按当前词表刷新，generation 续上（3→4）
  ], '只替换本作者那一条引用；悬空引用保留下來供人工核查（不顺手删别人的记录）');
  assert.ok(db.get('SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ?', [packId]).n > 0, '已写入范文');
});

// ---------- 多卡隔离（第 4 步 ★ 验收项，离线） ----------

test('多卡隔离：两张卡各引用不同源集，各自 style_samples 只含本卡源集选出的范文', async (t) => {
  await setupDb(t);
  const dataRoot = tmpRoot(t);
  const corpusRoot = tmpRoot(t);
  saveDict(dataRoot, '白石', [{ name: '沈觉', type: 'person' }], 'v1-cd');
  saveDict(dataRoot, '晚棠未开', [{ name: '林野', type: 'person' }], 'v1-hh');
  makeCorpus(corpusRoot, [
    { topic: '玄幻', author: '白石', work: '蔽霄', text: synth('沈觉', 6000, 5) },
    { topic: '温馨言情', author: '晚棠未开', work: '老婆请安分', text: synth('林野', 6000, 9) },
  ]);
  registerSource('白石', 'v1-cd');
  registerSource('晚棠未开', 'v1-hh');

  const cd = await l4.runL4({ corpusRoot, author: '白石', dataRoot, db, k: 3 });
  const hh = await l4.runL4({ corpusRoot, author: '晚棠未开', dataRoot, db, k: 3 });
  assert.notEqual(cd.packId, hh.packId);

  const cdRows = db.all('SELECT * FROM style_samples WHERE pack_id = ?', [cd.packId]);
  const hhRows = db.all('SELECT * FROM style_samples WHERE pack_id = ?', [hh.packId]);
  assert.ok(cdRows.length && hhRows.length);
  assert.ok(cdRows.every((r2) => r2.source.includes('/蔽霄#')), '白石卡的范文只来自蔽霄的块');
  assert.ok(hhRows.every((r2) => r2.source.includes('/老婆请安分#')), '晚棠未开卡的范文只来自她的作品');

  // 检索侧：卡链就是检索范围，按 pack_id 天然隔离
  const cdPicked = retrieve.selectSamples([cd.packId], { maxChars: 100000 });
  const hhPicked = retrieve.selectSamples([hh.packId], { maxChars: 100000 });
  assert.ok(cdPicked.length === cdRows.length && hhPicked.length === hhRows.length);
  assert.ok(cdPicked.every((s) => s.packId === cd.packId));
  assert.ok(!cdPicked.some((s) => hhRows.some((r2) => r2.text === s.text)), '白石卡不得检到晚棠未开的范文');
  assert.ok(!hhPicked.some((s) => cdRows.some((r2) => r2.text === s.text)), '反向亦然');

  // 换卡 = 换检索范围：两卡同时挂到一本书时，按卡链顺序先填主卡
  const both = retrieve.selectSamples([hh.packId, cd.packId], { maxChars: 100000 });
  assert.ok(both.length === cdPicked.length + hhPicked.length, '卡链叠加：两卡的范文都在');
  assert.ok(both.slice(0, hhPicked.length).every((s) => s.packId === hh.packId), '主卡先填满');
});

// ---------- 选样口径钉子 ----------

test('选样口径：k 与种子上限受控，范文长度 ≤ 嵌入安全线', () => {
  assert.equal(select.SAMPLE_CHARS, 400);
  assert.equal(l4.EMBED_SAFE, 500, '范文块长必须 ≤500（510 字后嵌入静默截断）');
  assert.ok(select.SAMPLE_CHARS <= l4.EMBED_SAFE);
});
