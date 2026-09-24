// 范文检索契约（第 4 步）：预算口径 / 直出优先级 / 向量索引与相似度检索 / 多卡隔离。
//
// 核心不变量：
//   ① 运行时只走表（方案 §3.4.0）：不传查询向量时**绝不**静默改行为，仍按 sort_order 直出；
//   ② 相似度检索只在**本卡已索引的范文**里找（按 pack_id 查，不跨卡、不扫全库）；
//   ③ 超 500 字的范文**不索引**（嵌入 510 字后静默截断）——宁可不索引，不写「半个」向量；
//   ④ 预算常量是设计 §3.5 的口径，改动必须是有意的（钉住 6000）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const cards = require('../server/style/cards');
const retrieve = require('../server/style/retrieve');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

/** 直接写向量（不走嵌入模型：检索数学要确定性可断言）。 */
function writeVector(sampleId, vec, model) {
  db.run('UPDATE style_samples SET vector = ?, vector_model = ?, indexed_at = ? WHERE id = ?',
    [Buffer.from(new Float32Array(vec).buffer), model || retrieve.VECTOR_MODEL, new Date().toISOString(), sampleId]);
}

test('预算口径：SAMPLE_BUDGET_CHARS = 16000（4000→6000→8000→16000），且不再恒返 null 的相似度函数已接线', () => {
  assert.equal(retrieve.SAMPLE_BUDGET_CHARS, 16000,
    '范文预算 16000：L4 扩样 k=16（35 候选）后四卡范文 13,600~14,400 字符，8000 会砍掉近半段（2026-09-19）');
  assert.equal(retrieve.SAMPLE_EMBED_MAX_CHARS, 500, '参与嵌入的范文 ≤500 字');
  assert.equal(typeof retrieve.selectBySimilarity, 'function');
  assert.equal(typeof retrieve.indexSamples, 'function');
  assert.equal(typeof retrieve.embedSampleQuery, 'function');
});

test('直出路径：按 sort_order 填充，整段进整段出；传字符串 query 只告警并回落直出（同步路径不能嵌入）', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '直出卡' });
  cards.addSample(pack.id, { title: 'A1', text: 'A一'.repeat(10) });
  cards.addSample(pack.id, { title: 'A2', text: 'A二'.repeat(10) });

  const picked = retrieve.selectSamples([pack.id], { maxChars: 30 });
  assert.deepEqual(picked.map((s) => s.title), ['A1'], '装不下第二段就停（不截半段）');

  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const withQuery = retrieve.selectSamples([pack.id], { maxChars: 30, query: '战斗场面' });
    assert.deepEqual(withQuery.map((s) => s.title), ['A1'], '字符串 query 不得改变行为（回落直出）');
  } finally { console.warn = origWarn; }
  assert.equal(warned.length, 1, '必须告警一次，不静默假装检索过');
  assert.match(warned[0], /queryVector/);
});

test('indexSamples：写入向量三列；超 500 字的范文跳过并计数（嵌入静默截断防线）', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '索引卡' });
  const a = cards.addSample(pack.id, { title: '短文', text: '风很大。刀很快。' });
  const b = cards.addSample(pack.id, { title: '超长文', text: '长'.repeat(retrieve.SAMPLE_EMBED_MAX_CHARS + 1) });
  // 空文本走不了 cards.addSample（正文必填），只能直插——这里测的是索引侧的兜底
  const c = db.run("INSERT INTO style_samples (pack_id, title, text, source, char_count, sort_order, enabled, content_hash) VALUES (?, '空文', '   ', '', 3, 9, 1, '')", [pack.id]).lastInsertRowid;

  const calls = [];
  const res = await retrieve.indexSamples(pack.id, {
    embedImpl: async (text) => { calls.push(text); return new Float32Array([1, 0, 0, 0]); },
  });

  assert.equal(res.indexed, 1, '只有合规短文被索引');
  assert.equal(res.skipped, 2);
  assert.equal(res.reasons.tooLong, 1);
  assert.equal(res.reasons.empty, 1);
  assert.deepEqual(calls, ['风很大。刀很快。'], '超长与空文本不得送进嵌入模型');

  if (res.indexed !== 1) console.error('indexSamples 结果异常', res, calls);
  const row = db.get('SELECT * FROM style_samples WHERE id = ?', [a.id]);
  assert.equal(row.vector_model, retrieve.VECTOR_MODEL);
  assert.ok(row.indexed_at, 'indexed_at 必须写');
  assert.equal(retrieve.toSample(row).indexed, true);
  assert.equal(db.get('SELECT vector FROM style_samples WHERE id = ?', [b.id]).vector, null, '超长范文不写向量');
  assert.equal(retrieve.toSample(db.get('SELECT * FROM style_samples WHERE id = ?', [b.id])).indexed, false);
  assert.equal(db.get('SELECT vector_model FROM style_samples WHERE id = ?', [c]).vector_model, '');
});

test('selectBySimilarity：按余弦排序、装满即止、只在本卡范围检索、无索引返回 null', async (t) => {
  await setup(t);
  const a = cards.createPack({ name: '卡A' });
  const b = cards.createPack({ name: '卡B' });
  const a1 = cards.addSample(a.id, { title: 'A·贴近', text: '贴近'.repeat(10) });
  const a2 = cards.addSample(a.id, { title: 'A·正交', text: '正交'.repeat(10) });
  const b1 = cards.addSample(b.id, { title: 'B·更贴近', text: '更贴近'.repeat(10) });
  writeVector(a1.id, [1, 0, 0, 0]);
  writeVector(a2.id, [0, 1, 0, 0]);
  writeVector(b1.id, [1, 0, 0, 0]);

  const query = new Float32Array([1, 0, 0, 0]);
  const onlyA = retrieve.selectBySimilarity([a.id], query, { maxChars: 1000 });
  assert.deepEqual(onlyA.map((s) => s.title), ['A·贴近', 'A·正交'], '按余弦降序，且只含 A 卡');
  assert.equal(onlyA[0].score, 1);
  assert.equal(onlyA[1].score, 0);

  const bothPacks = retrieve.selectBySimilarity([a.id, b.id], query, { maxChars: 1000 });
  assert.deepEqual(bothPacks.map((s) => s.packId).includes(b.id), true, '卡链包含 B 卡时才检到 B（检索范围 = 卡链）');

  const topK = retrieve.selectBySimilarity([a.id], query, { maxChars: 1000, topK: 1 });
  assert.deepEqual(topK.map((s) => s.title), ['A·贴近'], 'topK 截断');

  const filtered = retrieve.selectBySimilarity([a.id], query, { maxChars: 1000, minScore: 0.5 });
  assert.deepEqual(filtered.map((s) => s.title), ['A·贴近'], 'minScore 过滤掉不相关的段');

  // 预算装不下第二段 → 只返回第一段（与直出路径同契约）
  const tight = retrieve.selectBySimilarity([a.id], query, { maxChars: 24 });
  assert.deepEqual(tight.map((s) => s.title), ['A·贴近']);

  // 没索引 = 没有可用向量 → null，调用方回落直出
  const fresh = cards.createPack({ name: '未索引卡' });
  cards.addSample(fresh.id, { title: 'X', text: '未索引。' });
  assert.equal(retrieve.selectBySimilarity([fresh.id], query, {}), null);
  assert.equal(retrieve.selectBySimilarity([a.id], null, {}), null, '没有查询向量时不检索');
  assert.equal(retrieve.selectBySimilarity([], query, {}), null);
});

test('selectSamples 传 queryVector 时走相似度路径（离线接线点）；embedSampleQuery 用检索式前缀', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '离线卡' });
  // 刻意把「日常」放前面（sort_order 更小）：直出路径会先给日常，
  // 相似度路径必须先给「战斗」——两条路的输出顺序不同，才能证明走的是哪条
  const far = cards.addSample(pack.id, { title: '场景·日常', text: '喝茶。'.repeat(10) });
  const near = cards.addSample(pack.id, { title: '场景·战斗', text: '刀光。'.repeat(10) });
  writeVector(far.id, [0, 0, 0, 1]);
  writeVector(near.id, [0, 0, 1, 0]);

  const direct = retrieve.selectSamples([pack.id], { maxChars: 1000 });
  assert.deepEqual(direct.map((s) => s.title), ['场景·日常', '场景·战斗'], '不传向量 → 按 sort_order 直出');

  const bySim = retrieve.selectSamples([pack.id], { queryVector: new Float32Array([0, 0, 1, 0]), maxChars: 1000 });
  assert.deepEqual(bySim.map((s) => s.title), ['场景·战斗', '场景·日常'], '给了向量就走相似度路径（按余弦降序）');
  const tight = retrieve.selectSamples([pack.id], { queryVector: new Float32Array([0, 0, 1, 0]), maxChars: 31 });
  assert.deepEqual(tight.map((s) => s.title), ['场景·战斗'], '额度只装得下最相关的一段（30 字）');

  const seen = [];
  const vec = await retrieve.embedSampleQuery('战斗场面', { embedImpl: async (text) => { seen.push(text); return new Float32Array([1, 1, 1, 1]); } });
  assert.deepEqual(seen, ['战斗场面'], 'embedSampleQuery 只负责取向量（前缀由 embed.js 的 embedQuery 负责）');
  assert.equal(vec.length, 4);

  // 未索引的卡 + 给了向量 → 相似度返回 null → 回落直出（不是返回空）
  const plain = cards.createPack({ name: '纯直出卡' });
  cards.addSample(plain.id, { title: 'P1', text: 'P一'.repeat(10) });
  const fallback = retrieve.selectSamples([plain.id], { queryVector: new Float32Array([0, 0, 1, 0]), maxChars: 1000 });
  assert.deepEqual(fallback.map((s) => s.title), ['P1'], '无索引时回落到直出，不返回空数组');
});

test('改正文即作废旧向量：相似度路径不会拿旧向量匹配新文本', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '改文卡' });
  const s = cards.addSample(pack.id, { title: '旧文', text: '旧文。'.repeat(10) });
  writeVector(s.id, [1, 0, 0, 0]);
  assert.equal(retrieve.selectBySimilarity([pack.id], new Float32Array([1, 0, 0, 0]), {}).length, 1);

  cards.updateSample(s.id, { text: '新文。'.repeat(10) });
  const row = db.get('SELECT * FROM style_samples WHERE id = ?', [s.id]);
  assert.equal(row.vector, null, '改正文必须清空向量（既有语义）');
  assert.equal(retrieve.selectBySimilarity([pack.id], new Float32Array([1, 0, 0, 0]), {}), null,
    '清空后相似度返回 null → 调用方回落直出，不会拿旧向量匹配新文本');
});
