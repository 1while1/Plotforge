const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const characters = require('../../server/domain/characters');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('ledger REST creates and filters narrative events with book-scoped chapters', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook('第一本');
  const otherBookId = createBook('第二本');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '港口来信', 12)",
    [bookId]
  ).lastInsertRowid;
  const foreignChapterId = db.run(
    "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '其他书章节', 1)",
    [otherBookId]
  ).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => {
    await http.close();
    cleanup(location);
  });

  const invalid = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/events`, {
    title: '跨书事件',
    chapter_id: foreignChapterId,
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '轻伤',
    }],
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'CROSS_BOOK_REFERENCE');

  const created = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/events`, {
    title: '港口交火',
    chapter_id: chapterId,
    paragraph_index: 7,
    narrative_sequence: 1,
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '轻伤',
    }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.chapter_title, '港口来信');

  const timeline = await json(
    http.baseUrl,
    'GET',
    `/api/books/${bookId}/ledger/events?character_id=${characterId}`
  );
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.items.length, 1);
  assert.equal(timeline.body.items[0].changes[0].new_value, '轻伤');

  const states = await json(
    http.baseUrl,
    'GET',
    `/api/books/${bookId}/characters/${characterId}/states`
  );
  assert.equal(states.status, 200);
  assert.equal(states.body.items.find(item => item.field_key === 'health').value, '轻伤');
});
