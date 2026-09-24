// 错题库域模块契约（作家仓库第一步）：
// 入库去重 / 人工复核优先 / 快照溯源 / 统计 / 导出过滤 —— 这五条语义必须被钉住。
// 其中「复核结论不被机器覆盖」是防 Goodhart 的关键，任何"顺手统一 upsert"的改动都会破坏它。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const samples = require('../server/style/samples');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['错题库测试书']).lastInsertRowid;
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)',
    [bookId, '第一章', '正文']
  ).lastInsertRowid;
  return { bookId, chapterId };
}

function seg(text, conf, label, index) {
  return { text, conf, label, index, position: String(index) };
}

test('入库：分段落库、过短碎片被跳过、字段完整', async t => {
  const { bookId, chapterId } = await setup(t);
  const saved = samples.saveSegments(
    [seg('这是一段被判为 AI 的完整句子，长度足够。', 0.93, 1, 0), seg('太短', 0.9, 1, 1)],
    { bookId, chapterId, chapterTitle: '第一章', chapterRevision: 12345 }
  );
  assert.equal(saved.inserted, 1, '过短碎片应被跳过');
  assert.equal(saved.skipped, 1);

  const row = db.get('SELECT * FROM ai_style_samples');
  assert.equal(row.verdict, 'pending', '机器判定后默认待复核');
  assert.equal(row.detector, 'zhuque');
  assert.equal(row.detector_conf, 0.93);
  assert.equal(row.chapter_title_snapshot, '第一章');
  assert.equal(row.chapter_revision, '12345', '必须记录送检时的章节版本（updated_at 是 TEXT 时间戳，原样存）');
  assert.equal(row.seen_count, 1);
  assert.ok(row.text_hash && row.text_hash.length === 64, 'text_hash 应为 sha256');
});

test('去重：同句再入库不新增行、seen_count 累加、conf 刷新', async t => {
  const { bookId, chapterId } = await setup(t);
  const text = '同一句话重复被检出时不该堆成重复行，这是去重键存在的理由。';
  samples.saveSegments([seg(text, 0.8, 2, 0)], { bookId, chapterId });
  const again = samples.saveSegments([seg(text, 0.95, 1, 3)], { bookId, chapterId });

  assert.equal(again.inserted, 0);
  assert.equal(again.merged, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 1);
  const row = db.get('SELECT * FROM ai_style_samples');
  assert.equal(row.seen_count, 2, '重复检出次数是最强的特征证据，必须累加');
  assert.equal(row.detector_conf, 0.95, '机器侧字段刷新为最新');
});

test('★ 复核结论不被机器覆盖：再入库保持人工 verdict/备注/标签', async t => {
  const { bookId, chapterId } = await setup(t);
  const text = '作者确认为人写的句子，朱雀误判为 AI —— 这是检测器的盲区样本。';
  samples.saveSegments([seg(text, 0.91, 1, 0)], { bookId, chapterId });
  const id = db.get('SELECT id FROM ai_style_samples').id;

  samples.reviewSample(id, { verdict: 'human', reviewNote: '这是我自己写的', tags: ['误判', '民国腔'] });
  const reviewed = db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id]);
  assert.equal(reviewed.verdict, 'human');
  assert.ok(reviewed.reviewed_at, '复核后应有时间戳');

  // 机器再次检出同句（conf 更新）——人工结论必须原样保留
  samples.saveSegments([seg(text, 0.97, 1, 0)], { bookId, chapterId });
  const after = db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id]);
  assert.equal(after.verdict, 'human', '人工判定永远优先于机器判定');
  assert.equal(after.review_note, '这是我自己写的');
  assert.deepEqual(JSON.parse(after.tags), ['误判', '民国腔']);
  assert.equal(after.seen_count, 2);
});

test('复核：四态校验、pending 撤回清除时间戳、标签覆盖写', async t => {
  const { bookId, chapterId } = await setup(t);
  samples.saveSegments([seg('这是一句用于复核校验的标本内容。', 0.88, 1, 0)], { bookId, chapterId });
  const id = db.get('SELECT id FROM ai_style_samples').id;

  assert.throws(
    () => samples.reviewSample(id, { verdict: 'maybe' }),
    /verdict 必须是/,
    '非法状态必须被拒绝，否则统计口径全乱'
  );

  samples.reviewSample(id, { verdict: 'ai' });
  assert.ok(samples.toSample(db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id])).reviewedAt);
  samples.reviewSample(id, { verdict: 'pending' });
  const withdrawn = samples.toSample(db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id]));
  assert.equal(withdrawn.verdict, 'pending');
  assert.equal(withdrawn.reviewedAt, null, '撤回待复核应清除时间戳');

  assert.equal(samples.reviewSample(999999, { verdict: 'ai' }), null, '不存在的标本返回 null 而非抛错');
});

test('查询：按状态/置信度/书/关键词过滤，默认高置信度优先', async t => {
  const { bookId, chapterId } = await setup(t);
  const other = db.run('INSERT INTO books (title) VALUES (?)', ['别的书']).lastInsertRowid;
  samples.saveSegments([
    seg('低置信度的标本句子，用于排序校验。', 0.51, 2, 0),
    seg('高置信度的标本句子，用于排序校验。', 0.99, 1, 1),
  ], { bookId, chapterId });
  samples.saveSegments([seg('另一本书里的标本句子，用于隔离校验。', 0.88, 1, 0)], { bookId: other });

  const all = samples.listSamples({});
  assert.equal(all.total, 3);
  assert.equal(all.samples[0].detectorConf, 0.99, '默认按置信度降序：最像 AI 的先复核');

  const scoped = samples.listSamples({ bookId });
  assert.equal(scoped.total, 2, '按书过滤必须生效');

  assert.equal(samples.listSamples({ minConf: 0.8 }).total, 2);
  assert.equal(samples.listSamples({ q: '隔离' }).total, 1);
  assert.equal(samples.listSamples({ verdict: 'pending' }).total, 3);
  assert.equal(samples.listSamples({ verdict: 'ai' }).total, 0);
});

test('统计：按状态分桶 + 置信度分桶 + 重复句排行', async t => {
  const { bookId, chapterId } = await setup(t);
  samples.saveSegments([
    seg('第一句用于统计校验的高分标本。', 0.95, 1, 0),
    seg('第二句用于统计校验的中分标本。', 0.75, 1, 1),
    seg('第三句用于统计校验的低分标本。', 0.4, 2, 2),
  ], { bookId, chapterId });
  const id = db.get('SELECT id FROM ai_style_samples ORDER BY detector_conf DESC LIMIT 1').id;
  samples.reviewSample(id, { verdict: 'ai' });
  // 制造一条重复句
  samples.saveSegments([seg('第一句用于统计校验的高分标本。', 0.95, 1, 0)], { bookId, chapterId });

  const s = samples.stats(bookId);
  assert.equal(s.total, 3);
  assert.equal(s.byVerdict.ai, 1);
  assert.equal(s.byVerdict.pending, 2);
  assert.equal(s.byConfidence.veryHigh, 1);
  assert.equal(s.byConfidence.high, 1);
  assert.equal(s.byConfidence.low, 1);
  assert.equal(s.topRepeated.length, 1, '重复句排行只列 seen_count > 1 的');
  assert.equal(s.topRepeated[0].seenCount, 2);
});

test('导出：默认只给已复核语料（防污染），includePending 才带待复核', async t => {
  const { bookId, chapterId } = await setup(t);
  samples.saveSegments([
    seg('已复核确认为 AI 的句子，应进导出口。', 0.94, 1, 0),
    seg('待复核的句子，默认不该进导出口。', 0.66, 2, 1),
  ], { bookId, chapterId });
  const aiId = db.get("SELECT id FROM ai_style_samples WHERE detector_conf > 0.9").id;
  samples.reviewSample(aiId, { verdict: 'ai' });

  const defaultExport = samples.exportSamples({ format: 'json' });
  assert.equal(defaultExport.samples.length, 1, '未复核语料不得进分析（防污染第一道闸门）');
  assert.equal(defaultExport.samples[0].verdict, 'ai');

  const withPending = samples.exportSamples({ format: 'json', includePending: true });
  assert.equal(withPending.samples.length, 2);

  // rejected 标本永不导出（标本本身无效）
  const pendingId = db.get("SELECT id FROM ai_style_samples WHERE detector_conf < 0.7").id;
  samples.reviewSample(pendingId, { verdict: 'rejected' });
  assert.equal(samples.exportSamples({ format: 'json', includePending: true }).samples.length, 1);

  const jsonl = samples.exportSamples({});
  assert.equal(jsonl.format, 'jsonl');
  const lines = jsonl.content.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.verdict, 'ai');
  assert.ok(Array.isArray(parsed.labelsRatio), 'JSON 列应已解析为数组');
});

test('归一化：空白差异视为同一句，实义字符差异不合并', async t => {
  const { bookId, chapterId } = await setup(t);
  samples.saveSegments([seg('这一句里  有  多余空白，应当与规整版本视为同一句。', 0.8, 1, 0)], { bookId, chapterId });
  const merged = samples.saveSegments([seg('这一句里 有 多余空白，应当与规整版本视为同一句。', 0.8, 1, 0)], { bookId, chapterId });
  assert.equal(merged.merged, 1, '空白差异应归一为同一句');

  const distinct = samples.saveSegments([seg('这一句里 有 多余空白，应当与规整版本视为同一句话。', 0.8, 1, 0)], { bookId, chapterId });
  assert.equal(distinct.inserted, 1, '实义字符不同就是两句，不得误合并');
});

test('删除：存在才删，返回值反映真实结果', async t => {
  const { bookId, chapterId } = await setup(t);
  samples.saveSegments([seg('待删除的标本句子，用于校验删除语义。', 0.7, 1, 0)], { bookId, chapterId });
  const id = db.get('SELECT id FROM ai_style_samples').id;
  assert.equal(samples.deleteSample(id), true);
  assert.equal(samples.deleteSample(id), false, '重复删除应返回 false');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 0);
});
