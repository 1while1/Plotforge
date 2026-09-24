const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const { searchEvidence } = require('../../server/evidence/search');
const { installEmbedGate, guardOutboundFetch } = require('../helpers/vector-embed-gate');
const vectorSearch = require('../../server/vector/search');
const mutations = require('../../server/domain/chapterMutations');

// 索引缺口显性化（方向报告 3.2）：缺索引此前静默返回空数组连 degraded 都不标；
// 章节列表无标注、无重建入口。
test('missing vector index is visible in degraded flags, chapter list, and reindex endpoint', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['索引可见书']).lastInsertRowid;
  // 一个定稿有正文但没建向量（模拟索引失败被吞）；一个未定稿章
  db.run("INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 1, 1)", [bookId, '定稿章', '林野在钟楼顶层藏好了信物。']);
  db.run("INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 0, 2)", [bookId, '草稿章', '草稿内容']);

  // 1) 检索融合层：缺索引必须标 degraded + 覆盖数（无 embeddings 行时 semantic.search 提前返回，不触模型）
  const result = await searchEvidence(bookId, '信物在哪', { topK: 5 });
  assert.ok(result.degraded.includes('semantic'), '索引缺失应标 semantic 降级');
  assert.deepEqual(result.semantic_coverage, { indexed: 0, locked: 1 });

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 2) 章节列表：locked 且未索引的章带回 indexed:false（前端据此渲染「索引缺失」徽标）
  const list = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapters`);
  assert.equal(list.status, 200);
  const lockedCh = list.body.chapters.find(c => c.title === '定稿章');
  const draftCh = list.body.chapters.find(c => c.title === '草稿章');
  assert.equal(lockedCh.indexed, 0, '定稿未索引章应 indexed=0');
  assert.equal(draftCh.indexed, 0, '未定稿章无索引属正常');

  // 3) 一键重建端点：execute:false 只查缺口不跑模型（真实前端调用缺省执行）
  const dry = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/reindex`, { execute: false });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body, { started: false, missing: 1 });

  const missing404 = await json(http.baseUrl, 'POST', '/api/books/999999/chapters/reindex', { execute: false });
  assert.equal(missing404.status, 404);
});

// S5-04：被来源竞态丢弃的索引必须留下「明确且可见」的缺口状态——
// 章节列表 indexed:0、检索覆盖率标 degraded、一键重建能算出这章的缺口；
// 重建之后覆盖率回到真实值，既不虚报「已索引」，也不会把丢弃当成已覆盖。
test('index batch discarded by a source race stays visible as a gap and can be rebuilt', async t => {
  const gate = installEmbedGate();
  const restoreFetch = guardOutboundFetch();
  t.after(() => { gate.restore(); restoreFetch(); });

  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['竞态丢弃可见性']).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第一章', ?, 1, 1)",
    [bookId, '定稿正文：灰雁号在浓雾里缓慢掉头，桅杆吱呀作响。' + '雾很重。'.repeat(10)]
  ).lastInsertRowid;

  // 后台索引进行中（embed 挂起）→ 作者改名（真实领域入口；不改正文，章仍定稿）→ 释放旧的向量
  const indexing = gate.indexer.indexChapter(chapterId);
  const renamed = mutations.applyChapterMutation({
    bookId,
    chapterId,
    expectedRevision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision),
    patch: { title: '第一章 灰雁号' },
    reason: 'test-rename',
  });
  assert.equal(renamed.chapter.locked, 1, '改名不解除定稿（本用例前提）');
  gate.releaseAll();
  const discarded = await indexing;
  assert.equal(discarded.indexed, 0, '索引期间来源已变：本批必须整批丢弃');

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  // 真实检索融合层（只把本地 embedding 换成固定向量：本用例不跑模型）
  const semantic = (book, query, options) => vectorSearch.search(book, query, options, {
    embedQuery: async () => new Float32Array([1, 0, 0, 0]),
  });

  const gap = await searchEvidence(bookId, '灰雁号', { topK: 5 }, { semantic });
  assert.ok(gap.degraded.includes('semantic'), '竞态丢弃后必须标 semantic 降级（不得静默当已索引）');
  assert.deepEqual(gap.semantic_coverage, { indexed: 0, locked: 1 });

  const listGap = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapters`);
  assert.equal(listGap.status, 200);
  assert.equal(listGap.body.chapters.find(c => c.id === chapterId).indexed, 0, '丢弃的批次不得算作已索引');

  const dry = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/reindex`, { execute: false });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body, { started: false, missing: 1 }, '这章的缺口必须能被一键重建入口算出');

  // 重建（只验证覆盖状态，不跑模型）：缺口闭合、覆盖率回到真实值
  const rebuilt = await gate.indexer.indexBookMissing(bookId);
  assert.equal(rebuilt.chapters, 1);
  assert.ok(rebuilt.chunks >= 1);
  assert.equal(rebuilt.stale, 0, '按当前来源重建不得再被判过期');

  const healed = await searchEvidence(bookId, '灰雁号', { topK: 5 }, { semantic });
  assert.equal(healed.degraded.includes('semantic'), false, '重建后不得再标降级');
  assert.deepEqual(healed.semantic_coverage, { indexed: 1, locked: 1 });
  const listHealed = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapters`);
  assert.equal(listHealed.body.chapters.find(c => c.id === chapterId).indexed, 1);
  const dryHealed = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/reindex`, { execute: false });
  assert.deepEqual(dryHealed.body, { started: false, missing: 0 });
});
