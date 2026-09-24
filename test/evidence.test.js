const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const { searchDrafts } = require('../server/evidence/draftLexical');
const { searchEvidence } = require('../server/evidence/search');
const { parseAnchor, chapterAnchor } = require('../server/evidence/anchors');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('anchors parse stable ids and draft lexical search returns paragraph offsets', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('证据');
  characters.createCharacter(bookId, {
    name: '林野',
    aliases: [{ alias: '林舰长', alias_type: 'title' }],
  });
  const chapterId = db.run(
    `INSERT INTO chapters (book_id, title, content, sort_order, locked)
     VALUES (?, '港口来信', ?, 1, 0)`,
    [bookId, '苏晚站在港口。\n\n林舰长把旧船牌交给她。\n\n两人仍互不信任。']
  ).lastInsertRowid;
  const hits = searchDrafts(bookId, '林舰长');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceType, 'chapter_draft');
  assert.equal(hits[0].trustClass, 'draft');
  assert.equal(hits[0].canonicalStatus, 'noncanonical');
  assert.equal(hits[0].location.chapterId, chapterId);
  assert.equal(hits[0].location.paragraphIndex, 1);
  assert.ok(hits[0].location.charEnd > hits[0].location.charStart);
  assert.deepEqual(parseAnchor(hits[0].anchor), {
    type: 'chapter',
    id: chapterId,
    paragraphIndex: 1,
    hashPrefix: hits[0].location.revisionHash.slice(0, 8),
  });
  assert.equal(parseAnchor(chapterAnchor(chapterId, 1, hits[0].location.revisionHash)).id, chapterId);
});

test('evidence search degrades to structured and lexical without changing trust classes', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('降级');
  const character = characters.createCharacter(bookId, {
    name: '林野',
    intro: '灰雁号的逃亡船长。',
  }).character;
  db.run(
    `INSERT INTO chapters (book_id, title, content, sort_order, locked)
     VALUES (?, '草稿章', '林野仍然不信任苏晚。', 1, 0)`,
    [bookId]
  );

  const result = await searchEvidence(bookId, '林野', { topK: 8 }, {
    semantic: async () => { throw new Error('model unavailable'); },
  });
  assert.deepEqual(result.degraded, ['semantic']);
  assert.ok(result.hits.some(hit => hit.sourceType === 'character' && hit.sourceId === String(character.id)));
  assert.ok(result.hits.some(hit => hit.sourceType === 'chapter_draft'));
  assert.equal(result.hits.find(hit => hit.sourceType === 'character').trustClass, 'canon');
  assert.equal(result.hits.find(hit => hit.sourceType === 'chapter_draft').trustClass, 'draft');
  assert.equal(new Set(result.hits.map(hit => hit.anchor)).size, result.hits.length);
});

test('fusion preserves source diversity and semantic final-text shape', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('融合');
  characters.createCharacter(bookId, { name: '林野', intro: '船长' });
  const result = await searchEvidence(bookId, '林野', { topK: 4 }, {
    semantic: async () => [{
      chapter_id: 10,
      chapter_title: '定稿章',
      paragraph_start: 2,
      char_start: 20,
      char_end: 80,
      source_revision_hash: 'abcdef012345',
      text: '林野在定稿章中作出决定。',
      score: 0.91,
    }],
    draft: () => [],
  });
  const finalHit = result.hits.find(hit => hit.sourceType === 'chapter_final');
  assert.equal(finalHit.trustClass, 'final_text');
  assert.equal(finalHit.canonicalStatus, 'canonical');
  assert.equal(finalHit.location.paragraphIndex, 2);
});
