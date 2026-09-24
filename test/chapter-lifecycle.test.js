const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const proposals = require('../server/domain/proposals');
const lifecycle = require('../server/domain/chapterLifecycle');
const versions = require('../server/versions');
const summaryProposals = require('../server/domain/chapterSummaryProposals');
const indexer = require('../server/vector/indexer');

async function setup() {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['生命周期测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野', intro: '船长' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第一章', '旧正文', 1, 1)", [bookId]).lastInsertRowid;
  db.run("INSERT INTO embeddings (book_id, chapter_id, chunk_idx, text, vector) VALUES (?, ?, 0, '旧正文', ?)", [bookId, chapterId, Buffer.from(new Float32Array([1]).buffer)]);
  const proposal = proposals.createProposal(bookId, { title: '位置变化', chapter_id: chapterId, source_type: 'chapter_summary', source_revision_hash: 'old', changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'location', old_value: null, new_value: '灰雁号' }] });
  const now = new Date().toISOString();
  const session = db.run("INSERT INTO advisor_sessions (book_id, character_id, focus, context_revision, created_at) VALUES (?, ?, '测试', 'r1', ?)", [bookId, characterId, now]).lastInsertRowid;
  const suggestion = db.run("INSERT INTO advisor_suggestions (session_id, book_id, character_id, suggestion_type, title, conclusion, fingerprint, evidence_revision, created_at, updated_at) VALUES (?, ?, ?, 'A', '建议', '结论', 'fp', 'er', ?, ?)", [session, bookId, characterId, now, now]).lastInsertRowid;
  db.run("INSERT INTO advisor_citations (suggestion_id, anchor, source_type, source_id, quote_snapshot, trust_class, canonical_status, chapter_id, revision_hash) VALUES (?, 'chapter:1:p0:rev:old', 'chapter_final', ?, '旧正文', 'final_text', 'canonical', ?, 'old')", [suggestion, String(chapterId), chapterId]);
  return { location, bookId, characterId, chapterId, proposal };
}

test('chapter edit invalidates vectors, proposals and citations while retaining citation snapshots', async t => {
  const env = await setup();
  t.after(() => cleanup(env.location));
  // A1 保护：先种一条章节总结，正文失效后它必须被清空（否则过期总结会继续注入误导 AI）
  db.run("UPDATE chapters SET summary = '旧总结' WHERE id = ?", [env.chapterId]);
  const result = lifecycle.unlockChapter(env.bookId, env.chapterId, '正文已变');
  assert.deepEqual(result.invalidated, { embeddingChunks: 1, proposals: 1, citations: 1, events: 0, summariesCleared: 1 });
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [env.chapterId]).summary, '');
  assert.equal(db.get('SELECT status FROM event_proposals WHERE id = ?', [env.proposal.id]).status, 'stale');
  const citation = db.get('SELECT stale, quote_snapshot FROM advisor_citations WHERE chapter_id = ?', [env.chapterId]);
  assert.equal(citation.stale, 1);
  assert.equal(citation.quote_snapshot, '旧正文');
  assert.equal(db.get('SELECT locked FROM chapters WHERE id = ?', [env.chapterId]).locked, 0);
});

test('version restore is book and chapter scoped, unlocks content and reports invalidation', async t => {
  const env = await setup();
  t.after(() => cleanup(env.location));
  const versionId = versions.snapshot(env.chapterId, 'checkpoint');
  db.run("UPDATE chapters SET content = '新正文' WHERE id = ?", [env.chapterId]);
  const denied = versions.restoreChapterVersion(env.bookId + 100, env.chapterId, versionId);
  assert.ok(denied.error);
  // S1-03：恢复必须携带当前 revision（缺失 428、不符 409），此处带当前值
  assert.throws(
    () => versions.restoreChapterVersion(env.bookId, env.chapterId, versionId),
    err => err.code === 'CHAPTER_REVISION_REQUIRED',
    '缺 expectedRevision 的恢复必须 428'
  );
  const revision = Number(db.get('SELECT revision FROM chapters WHERE id = ?', [env.chapterId]).revision);
  const restored = versions.restoreChapterVersion(env.bookId, env.chapterId, versionId, revision);
  assert.equal(restored.ok, true);
  assert.equal(restored.locked, false);
  assert.ok(restored.revision > revision, '恢复只前进：revision 递增');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [env.chapterId]).content, '旧正文');
});

// 定稿是事实抽取的唯一自动触发点：作者点「定稿」→ relockChapter → scheduleChapterExtraction(bookId, chapterId)
test('relockChapter triggers fact extraction for the finalized chapter', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['定稿抽取']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野登上灰雁号。', 1)",
    [bookId]
  ).lastInsertRowid;

  // 隔离外部副作用：向量索引与后台抽取都不真正执行，只验证「定稿触发抽取」这一契约
  const indexMock = t.mock.method(indexer, 'indexChapter', async () => ({ indexed: 0 }));
  const extractMock = t.mock.method(summaryProposals, 'scheduleChapterExtraction', () => 'scheduled');

  const result = lifecycle.relockChapter(bookId, chapterId);

  assert.equal(result.locked, true);
  assert.equal(result.extraction, 'scheduled');
  assert.equal(extractMock.mock.callCount(), 1);
  assert.deepEqual(extractMock.mock.calls[0].arguments, [Number(bookId), Number(chapterId)]);
  assert.equal(indexMock.mock.callCount(), 1);
  assert.equal(db.get('SELECT locked FROM chapters WHERE id = ?', [chapterId]).locked, 1);
});

// 空章节不能定稿，也就不会触发抽取
test('relockChapter refuses an empty chapter and skips extraction', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['空章定稿']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '', 1)",
    [bookId]
  ).lastInsertRowid;
  const extractMock = t.mock.method(summaryProposals, 'scheduleChapterExtraction', () => 'scheduled');

  assert.throws(() => lifecycle.relockChapter(bookId, chapterId), err => err.code === 'CHAPTER_EMPTY');
  assert.equal(extractMock.mock.callCount(), 0);
});
