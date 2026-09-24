const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { searchDrafts } = require('../server/evidence/draftLexical');
const { searchEvidence } = require('../server/evidence/search');
const { assembleDetailed } = require('../server/context');
const ledger = require('../server/domain/storyLedger');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['叙事边界']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const ids = [];
  for (let index = 1; index <= 3; index++) ids.push(db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 1)',
    [bookId, volumeId, '第' + index + '章', '银钥匙在第' + index + '章']).lastInsertRowid);
  return { book: db.get('SELECT * FROM books WHERE id = ?', [bookId]), ids };
}

test('相同排序的未来草稿不参与旧章检索，全书查询仍可读', async t => {
  const { book, ids } = await setup(t);
  const historical = searchDrafts(book.id, '银钥匙', { chapterId: ids[1], excludeChapterId: ids[1] });
  assert.deepEqual(historical.map(hit => hit.location.chapterId), [ids[0]]);
  assert.equal(searchDrafts(book.id, '银钥匙').length, 3);
});

test('融合前过滤越界定稿，语义候选也收到同一叙事边界', async t => {
  const { book, ids } = await setup(t);
  let received;
  const result = await searchEvidence(book.id, '银钥匙', { chapterId: ids[1] }, {
    structured: () => [], draft: () => [],
    semantic: async (bookId, query, options) => {
      received = options;
      return ids.map(id => ({ chapter_id: id, chapter_title: '章', text: '银钥匙', score: 0.9 }));
    },
  });
  assert.ok(!result.hits.some(hit => hit.location.chapterId === ids[2]));
  assert.deepEqual(received.narrativeScope.allowedIds, ids.slice(0, 2));
});

test('旧章使用历史事件状态，不注入全书最新投影和未来滚动摘要', async t => {
  const { book, ids } = await setup(t);
  const characterId = db.run('INSERT INTO characters (book_id, name) VALUES (?, ?)', [book.id, '阿青']).lastInsertRowid;
  for (const [chapterId, value] of [[ids[0], '旧港口'], [ids[2], '未来月球']]) {
    ledger.commitEvent(book.id, { title: value, chapter_id: chapterId, changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'location', new_value: value }] });
  }
  db.run("INSERT INTO story_state (book_id,kind,content) VALUES (?, 'book_summary', '未来结局摘要')", [book.id]);
  db.run("INSERT INTO story_state (book_id,kind,content) VALUES (?, 'characters', '未来手工状态')", [book.id]);
  const output = await assembleDetailed({ book, db, chapterId: ids[1], query: '', systemTokenBudget: 20000 });
  assert.ok(output.text.includes('旧港口'));
  assert.ok(!output.text.includes('未来月球'));
  assert.ok(!output.text.includes('未来结局摘要'));
  assert.ok(!output.text.includes('未来手工状态'));
});

test('定稿向量在打分前排除未来章，结构化事件在limit前应用边界', async t => {
  const { book, ids } = await setup(t);
  const { narrativeScope } = require('../server/domain/narrativeScope');
  const scope = narrativeScope(book.id, ids[1]);
  const store = require('../server/vector/store');
  for (const chapterId of [ids[0], ids[2]]) store.saveChunks(book.id, chapterId, [{ idx: 0, text: '银钥匙', vector: new Float32Array([1, 0]) }]);
  const hits = await require('../server/vector/search').search(book.id, '银钥匙', { narrativeScope: scope, topK: 1 }, { embedQuery: async () => new Float32Array([1, 0]) });
  assert.deepEqual(hits.map(hit => hit.chapter_id), [ids[0]]);
  for (const chapterId of [ids[0], ids[2]]) db.run("INSERT INTO story_events (book_id, title, summary, chapter_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))", [book.id, '银钥匙事件', '银钥匙', chapterId]);
  const events = require('../server/evidence/structured').searchStructured(book.id, '银钥匙', { narrativeScope: scope, limit: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].location.chapterId, ids[0]);
});
