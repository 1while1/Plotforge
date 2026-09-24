const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('character REST contract creates, finds, scopes, renames and archives', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const firstBook = createBook('第一本');
  const secondBook = createBook('第二本');
  const http = await listen(createApp());
  t.after(async () => {
    await http.close();
    cleanup(location);
  });

  const created = await json(http.baseUrl, 'POST', `/api/books/${firstBook}/characters`, {
    name: '林野',
    role: '主角',
    intro: '逃亡船长。',
    aliases: [{ alias: '林舰长', alias_type: 'title' }],
  });
  assert.equal(created.status, 201);
  const characterId = created.body.character.id;
  assert.equal(created.body.character.name, '林野');

  const found = await json(
    http.baseUrl,
    'GET',
    `/api/books/${firstBook}/characters?q=林舰长`
  );
  assert.equal(found.status, 200);
  assert.equal(found.body.items.length, 1);
  assert.equal(found.body.characters[0].id, characterId);

  const crossBook = await json(
    http.baseUrl,
    'PATCH',
    `/api/books/${secondBook}/characters/${characterId}`,
    { intro: '越权修改' }
  );
  assert.equal(crossBook.status, 404);
  assert.equal(crossBook.body.error.code, 'CHARACTER_NOT_FOUND');

  const renamed = await json(
    http.baseUrl,
    'PATCH',
    `/api/books/${firstBook}/characters/${characterId}`,
    { name: '林远' }
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.character.name, '林远');
  assert.ok(renamed.body.character.aliases.some(item => item.alias === '林野'));

  const removed = await json(
    http.baseUrl,
    'DELETE',
    `/api/books/${firstBook}/characters/${characterId}`
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.archived, true);

  const active = await json(http.baseUrl, 'GET', `/api/books/${firstBook}/characters`);
  assert.equal(active.body.items.length, 0);
  const archived = await json(
    http.baseUrl,
    'GET',
    `/api/books/${firstBook}/characters?archived=true`
  );
  assert.equal(archived.body.items.length, 1);
});
