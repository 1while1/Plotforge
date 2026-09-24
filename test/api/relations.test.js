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

test('relation REST creates via story event and filters secret relations', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook('关系 API');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;
  const ally = db.get(
    "SELECT id FROM relation_type_definitions WHERE book_id = ? AND type_key = 'ally'",
    [bookId]
  );
  const http = await listen(createApp());
  t.after(async () => {
    await http.close();
    cleanup(location);
  });

  const created = await json(http.baseUrl, 'POST', `/api/books/${bookId}/relations/changes`, {
    event: { title: '秘密合作' },
    relation: {
      character_a_id: lin,
      character_b_id: su,
      relation_type_id: ally.id,
      direction: 'both',
      strength: 4,
      polarity: 'mixed',
      lifecycle: 'active',
      secrecy: 'secret',
      note: '尚未公开。',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.changes[0].change_kind, 'relation');

  const publicOnly = await json(
    http.baseUrl,
    'GET',
    `/api/books/${bookId}/characters/${lin}/relations?secrecy=public`
  );
  assert.equal(publicOnly.body.items.length, 0);
  const all = await json(
    http.baseUrl,
    'GET',
    `/api/books/${bookId}/characters/${lin}/relations?secrecy=all`
  );
  assert.equal(all.body.items.length, 1);
  assert.equal(all.body.items[0].polarity, 'mixed');
  assert.equal(all.body.items[0].relation_type.key, 'ally');
});
