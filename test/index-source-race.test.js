// S5-04：向量索引的来源竞态（C06 同族——旧正文的向量不得在异步回写后复活）
//
// 反例形态（真实窗口＝indexer 里的 `await embed(...)`）：
//   1. 章已定稿、正文 A → 开始索引（每个分块的 embedding 调用挂起）
//   2. 索引进行中作者改稿为 B（真实领域入口：解除定稿、清空旧总结/旧向量、revision 前进）
//   3. 释放 A 的向量 → 旧实现无条件 saveChunks：A 的向量落库，并以「定稿 · 章名」进入语义检索
// 正确行为：写回前核验「章仍存在 / 仍定稿 / 正文·结构·版本与读取时一致」（复用 S5-01 的
// sourceGuard），不一致则整批丢弃并返回明确的过期状态；核验与整批替换在同一个同步事务内，
// 不得留下 A/B 混合或指向已删章节的孤儿向量。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { installEmbedGate, waitFor, guardOutboundFetch } = require('./helpers/vector-embed-gate');
const store = require('../server/vector/store');
const vectorSearch = require('../server/vector/search');
const lifecycle = require('../server/domain/chapterLifecycle');
const mutations = require('../server/domain/chapterMutations');
const catalog = require('../server/domain/chapterCatalog');
const recycle = require('../server/domain/chapterRecycle');
const { revision } = require('../server/evidence/draftLexical');
const summaryProposals = require('../server/domain/chapterSummaryProposals');
const autoHealthcheck = require('../server/style/autoHealthcheck');

// 本文件只验证索引竞态，禁止任何真实模型渠道调用：
//  · 定稿（relockChapter）会触发后台事实抽取与体检——两者都换成空实现（既有用例同口径）；
//  · 再兜一层出网守卫：只放行本机地址，万一还有别的路径试图打外部端点，立即失败而不是静静出网。
//    （首次红测未加这两层，6 秒延迟的后台抽取真的打了一次外部端点并拿回 401，已如实记录在台账。）
const originalExtraction = summaryProposals.scheduleChapterExtraction;
const originalHealthcheck = autoHealthcheck.maybeAutoCheck;
let restoreFetch = null;
test.before(() => {
  summaryProposals.scheduleChapterExtraction = () => 'mocked';
  autoHealthcheck.maybeAutoCheck = async () => ({ ran: false, reason: 'test' });
  restoreFetch = guardOutboundFetch();
});
test.after(() => {
  summaryProposals.scheduleChapterExtraction = originalExtraction;
  autoHealthcheck.maybeAutoCheck = originalHealthcheck;
  if (restoreFetch) restoreFetch();
});

const OLD_SENTINEL = 'OLD_SENTINEL_ALPHA';   // 旧正文独有
const NEW_SENTINEL = 'NEW_SENTINEL_BETA';    // 新正文独有
const OTHER_SENTINEL = 'OTHER_SENTINEL_GAMMA';

// 单块正文（> 30 字才成块）：一个段落，便于精确断言块数
function oneChunk(prefix, sentinel) {
  return `${prefix}${sentinel}。` + '灰雁号在浓雾里缓慢掉头，桅杆吱呀作响。'.repeat(3);
}

// 多块正文（7 段 × ~85 字 = 600+ 字 → 2 块）：用于验证「整批替换」不混合两个版本
function multiChunk(prefix, sentinel) {
  return Array.from({ length: 7 }, (_, i) =>
    `第${i + 1}段：${prefix}${sentinel}。` + '灰雁号在浓雾里缓慢掉头，桅杆吱呀作响。'.repeat(3)
  ).join('\n');
}

async function setupBook(t, content) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['索引竞态测试书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 1, 1)',
    [bookId, '第一章', content]
  ).lastInsertRowid;
  return { bookId, chapterId };
}

// 真实编辑入口：正文变化 → invalidateChapter（清空旧向量/旧总结）+ 自动解除定稿 + revision 前进
function editContent(bookId, chapterId, content) {
  const row = db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]);
  return mutations.applyChapterMutation({
    bookId,
    chapterId,
    expectedRevision: Number(row.revision),
    patch: { content },
    reason: 'test-edit',
  });
}

function rowsOf(chapterId) {
  return db.all(
    `SELECT chunk_idx, text, content_hash, source_revision_hash
     FROM embeddings WHERE chapter_id = ? ORDER BY chunk_idx`,
    [chapterId]
  );
}

function currentContentHash(chapterId) {
  const row = db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]);
  return row ? revision(row.content) : null;
}

function orphanEmbeddingCount() {
  return db.get(
    'SELECT COUNT(*) AS n FROM embeddings e LEFT JOIN chapters c ON c.id = e.chapter_id WHERE c.id IS NULL'
  ).n;
}

// 走真实检索路径（同一余弦 + topK 选择逻辑），embedding 换固定向量：只要库里有该块就能被取回
async function searchTexts(bookId) {
  const rows = await vectorSearch.search(
    bookId,
    '灰雁号在哪',
    { topK: 20, threshold: 0 },
    { embedQuery: async () => new Float32Array([1, 0, 0, 0]) }
  );
  return rows.map(row => row.text);
}

test('★ 索引进行中改稿解除定稿：旧正文向量整批丢弃、不可检索、无孤儿行', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('定稿正文 A：', OLD_SENTINEL));

  const indexing = gate.indexer.indexChapter(chapterId);
  assert.equal(gate.calls.length, 1, '索引应已进入 embed（挂起窗口）');

  // 索引期间改稿（真实入口）：解除定稿 + 正文变 B + revision 前进 + 旧向量被清空
  const applied = editContent(bookId, chapterId, oneChunk('改稿后的正文 B：', NEW_SENTINEL));
  assert.equal(applied.autoUnlocked, true, '改稿必须解除定稿（反例前提）');
  assert.equal(store.chapterChunkCount(chapterId), 0, '改稿时旧向量应已被清空');

  gate.releaseAll();
  const result = await indexing;

  assert.equal(result.indexed, 0, '旧正文的向量不得写入');
  assert.equal(result.stale, true, '必须返回明确的过期状态，而不是静默按新来源计入');
  assert.equal(rowsOf(chapterId).length, 0, '改稿后仍不得存在旧正文向量');
  const texts = await searchTexts(bookId);
  assert.equal(texts.some(text => text.includes(OLD_SENTINEL)), false, '旧正文哨兵不得被检索到');
  assert.equal(orphanEmbeddingCount(), 0);
});

test('重新定稿后索引照常写入：来源戳＝当前定稿正文哈希、可检索', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('定稿正文 A：', OLD_SENTINEL));
  editContent(bookId, chapterId, oneChunk('重定稿正文 B：', NEW_SENTINEL));

  const relocked = lifecycle.relockChapter(bookId, chapterId);
  assert.equal(relocked.locked, true);
  assert.equal(gate.calls.length, 1, '定稿应触发索引（embed 挂起）');
  gate.releaseAll();
  await waitFor(() => rowsOf(chapterId).length > 0, '定稿索引应落库');

  const rows = rowsOf(chapterId);
  assert.ok(rows.length >= 1, '定稿正文必须有向量');
  assert.equal(rows.every(row => row.source_revision_hash === currentContentHash(chapterId)), true,
    '每块都必须携带当前定稿正文的来源哈希（锚点 revisionHash 以此为准）');
  const texts = await searchTexts(bookId);
  assert.equal(texts.some(text => text.includes(OLD_SENTINEL)), false);
  assert.equal(texts.some(text => text.includes(NEW_SENTINEL)), true, '当前定稿正文必须可检索');
});

test('索引进行中删除章节：释放后不得复活向量、无孤儿行', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('待删正文：', OLD_SENTINEL));

  const indexing = gate.indexer.indexChapter(chapterId);
  const deleted = recycle.deleteChapterWithRecycle({ bookId, chapterId, reason: 'test-delete' });
  assert.equal(deleted.ok, true);
  assert.equal(db.get('SELECT id FROM chapters WHERE id = ?', [chapterId]), null, '章节必须已删除');

  gate.releaseAll();
  const result = await indexing;

  assert.equal(result.indexed, 0, '章节已删：向量不得写入');
  assert.equal(result.stale, true, '必须返回明确的过期状态');
  assert.equal(rowsOf(chapterId).length, 0, '不得留下已删章节的向量');
  assert.equal(orphanEmbeddingCount(), 0, '不得留下指向已删章节的孤儿向量');
  assert.equal((await searchTexts(bookId)).some(text => text.includes(OLD_SENTINEL)), false);
});

test('索引进行中移卷：结构/版本已变的批次整批丢弃，不留下过期来源戳', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('移卷前正文：', OLD_SENTINEL));
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '第二卷']).lastInsertRowid;

  const indexing = gate.indexer.indexChapter(chapterId);
  const moved = catalog.moveChapter(bookId, chapterId, {
    volume_id: volumeId,
    expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision),
  });
  assert.equal(moved.volume_id, volumeId, '章节必须已移入另一卷');

  gate.releaseAll();
  const result = await indexing;

  assert.equal(result.indexed, 0, '结构已变：批次不得写入');
  assert.equal(result.stale, true);
  assert.equal(rowsOf(chapterId).length, 0, '不得留下携带旧结构戳的向量');
  // 移卷不改正文：重新补索引（下一次索引任务/一键重建）必须能按当前来源落库
  const reindexed = gate.indexer.indexChapter(chapterId);
  gate.release(gate.calls.length - 1);
  const refill = await reindexed;
  assert.ok(refill.indexed >= 1, '按当前来源重新索引必须成功（丢弃不等于永久缺口）');
  assert.equal(rowsOf(chapterId).every(row => row.source_revision_hash === currentContentHash(chapterId)), true);
});

test('★ 两次索引乱序返回（新的先落库、旧的晚到）：旧任务不得清掉新任务的索引', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('旧正文 A：', OLD_SENTINEL));

  const oldIndexing = gate.indexer.indexChapter(chapterId);          // 任务 A：读到旧正文，embed 挂起
  editContent(bookId, chapterId, oneChunk('新正文 B：', NEW_SENTINEL));
  lifecycle.relockChapter(bookId, chapterId);                        // 任务 B：新正文，embed 挂起
  assert.equal(gate.calls.length, 2, '应有两次索引任务在飞');

  gate.release(1);                                                   // 新任务先返回
  await waitFor(() => rowsOf(chapterId).length > 0, '新任务的向量应先落库');
  const afterNew = rowsOf(chapterId);
  assert.equal(afterNew.every(row => row.source_revision_hash === currentContentHash(chapterId)), true);
  assert.equal(afterNew.some(row => row.text.includes(NEW_SENTINEL)), true);

  gate.release(0);                                                   // 旧任务晚到
  const oldResult = await oldIndexing;

  assert.equal(oldResult.indexed, 0, '旧任务的向量不得写入');
  assert.equal(oldResult.stale, true);
  assert.deepEqual(rowsOf(chapterId), afterNew, '旧任务完成不得清掉/覆盖新任务写入的索引');
  const texts = await searchTexts(bookId);
  assert.equal(texts.some(text => text.includes(OLD_SENTINEL)), false);
  assert.equal(texts.some(text => text.includes(NEW_SENTINEL)), true);
  assert.equal(orphanEmbeddingCount(), 0);
});

test('两次索引乱序返回（旧的先返回）：旧批次被拒，最终只剩新版本', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('旧正文 A：', OLD_SENTINEL));

  const oldIndexing = gate.indexer.indexChapter(chapterId);
  editContent(bookId, chapterId, oneChunk('新正文 B：', NEW_SENTINEL));
  lifecycle.relockChapter(bookId, chapterId);
  assert.equal(gate.calls.length, 2);

  gate.release(0);                                                   // 旧任务先返回 → 来源已变，整批丢弃
  const oldResult = await oldIndexing;
  assert.equal(oldResult.indexed, 0);
  assert.equal(oldResult.stale, true);
  assert.equal(rowsOf(chapterId).length, 0, '旧任务被拒后不得留下任何向量');

  gate.release(1);
  await waitFor(() => rowsOf(chapterId).length > 0, '新任务的向量应落库');
  const rows = rowsOf(chapterId);
  assert.equal(rows.length, 1, '同一章只应有一批（单块）向量，不得 A/B 混合');
  assert.equal(rows[0].source_revision_hash, currentContentHash(chapterId));
  assert.equal(rows[0].text.includes(NEW_SENTINEL), true);
  assert.equal((await searchTexts(bookId)).some(text => text.includes(OLD_SENTINEL)), false);
});

test('写回中途失败：整批事务回滚，上一批完整向量原样保留（不留半批）', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, multiChunk('定稿正文 A：', OLD_SENTINEL));

  const first = gate.indexer.indexChapter(chapterId);
  gate.releaseAll();
  const firstResult = await first;
  assert.ok(firstResult.indexed >= 2, '多块正文应有至少两块（本用例前提）');
  const before = rowsOf(chapterId);
  assert.equal(before.length, firstResult.indexed);

  // 同一来源重建（一键重建/启动补索引的常态）：让第 2 条 INSERT 失败 —— 事务必须整体回滚。
  // 没有事务时 DELETE + 第 1 条 INSERT 已生效，库里会剩半批（本用例的第一条断言会红）。
  const dbModule = require('../server/db');
  const originalRun = dbModule.run;
  let embeddingInserts = 0;
  t.mock.method(dbModule, 'run', (sql, params) => {
    if (/INSERT INTO embeddings/i.test(sql)) {
      embeddingInserts += 1;
      if (embeddingInserts === 2) throw new Error('测试注入：第 2 条向量写入失败');
    }
    return originalRun(sql, params);
  });

  const writing = gate.indexer.indexChapter(chapterId);
  gate.releaseAll();
  await assert.rejects(writing, /测试注入/);

  assert.deepEqual(rowsOf(chapterId), before, '写回失败必须整体回滚：不得留半批，也不得清掉上一批完整向量');
});

test('后台补索引部分失败：过期章记为失败，其余章继续完成且缺口可见', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId: ch1 } = await setupBook(t, oneChunk('第一章正文：', OLD_SENTINEL));
  const ch2 = db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第二章', ?, 1, 2)",
    [bookId, oneChunk('第二章正文：', OTHER_SENTINEL)]
  ).lastInsertRowid;

  const backfill = gate.indexer.indexBookMissing(bookId);            // 逐章顺序索引：先第一本，embed 挂起
  assert.equal(gate.calls.length, 1);
  const firstChapterId = gate.calls[0].text.includes(OLD_SENTINEL) ? ch1 : ch2;
  const otherChapterId = firstChapterId === ch1 ? ch2 : ch1;
  editContent(bookId, firstChapterId, oneChunk('索引期间被改的正文：', NEW_SENTINEL));

  gate.release(0);                                                   // 过期章：整批丢弃
  await waitFor(() => gate.calls.length === 2, '其余章应继续索引（部分失败不打断整批）');
  gate.release(1);

  const result = await backfill;
  assert.equal(result.chapters, 2);
  assert.equal(result.stale, 1, '过期章必须计入显式失败表示');
  assert.equal(result.chunks, 1, '其余章照常完成');
  assert.equal(rowsOf(firstChapterId).length, 0, '索引期间被改的章不得留下旧正文向量');
  assert.equal(rowsOf(otherChapterId).length >= 1, true, '其余章必须照常索引');
  assert.equal(orphanEmbeddingCount(), 0);
});

test('已解锁/空正文的章：索引入口清空既有向量且不写新向量（既有行为保留）', async t => {
  const gate = installEmbedGate();
  t.after(() => gate.restore());
  const { bookId, chapterId } = await setupBook(t, oneChunk('定稿正文：', OLD_SENTINEL));

  const first = gate.indexer.indexChapter(chapterId);
  gate.releaseAll();
  assert.equal((await first).indexed, 1);

  lifecycle.unlockChapter(bookId, chapterId);
  db.run('UPDATE chapters SET content = ? WHERE id = ?', [oneChunk('解锁后的草稿：', NEW_SENTINEL), chapterId]);
  const result = await gate.indexer.indexChapter(chapterId);
  assert.equal(result.indexed, 0);
  assert.equal(store.chapterChunkCount(chapterId), 0, '未定稿章不得保留向量');
  assert.equal(orphanEmbeddingCount(), 0);
});
