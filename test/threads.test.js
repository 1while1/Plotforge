const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const threads = require('../server/domain/threads');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('story threads validate book references and replace character links', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('线索');
  const otherBook = createBook('其他');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;
  const foreign = characters.createCharacter(otherBook, { name: '异书人物' }).character.id;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '第三章', 3)",
    [bookId]
  ).lastInsertRowid;

  const thread = threads.createThread(bookId, {
    type: 'mystery',
    title: '旧船牌的来源',
    summary: '编码与官方记录不一致。',
    status: 'progressing',
    importance: 'high',
    opened_chapter_id: chapterId,
    character_ids: [lin, su],
  });
  assert.deepEqual(thread.character_ids.sort((a, b) => a - b), [lin, su].sort((a, b) => a - b));
  assert.equal(threads.listThreads(bookId, { character_id: lin }).length, 1);

  const event = ledger.commitEvent(bookId, {
    title: '船牌被证实为伪造',
    changes: [{
      change_kind: 'character_state',
      subject_ref: lin,
      field_key: 'goal',
      old_value: null,
      new_value: '追查造假者',
    }],
  }).event;
  const resolved = threads.updateThread(bookId, thread.id, {
    status: 'resolved',
    resolved_event_id: event.id,
    character_ids: [lin],
  });
  assert.deepEqual(resolved.character_ids, [lin]);
  assert.equal(resolved.resolved_event_id, event.id);

  assert.throws(() => threads.createThread(bookId, {
    type: 'promise',
    title: '跨书人物',
    character_ids: [foreign],
  }), err => err.code === 'CROSS_BOOK_REFERENCE');
});
