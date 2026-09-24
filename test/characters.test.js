const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('character profiles keep aliases across rename and use note only as display fallback', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('灰雁号');

  const created = characters.createCharacter(bookId, {
    name: '林野',
    role: '主角',
    note: '逃亡船长，试图夺回灰雁号航线。',
    aliases: [{ alias: '林舰长', alias_type: 'title' }],
  });
  assert.equal(created.character.intro, '逃亡船长，试图夺回灰雁号航线。');
  assert.equal(created.character.intro_fallback, true);
  assert.deepEqual(
    created.character.aliases.map(item => item.alias),
    ['林野', '林舰长']
  );

  const updated = characters.updateCharacterProfile(bookId, created.character.id, {
    name: '林远',
    intro: '灰雁号的逃亡船长。',
  });
  assert.equal(updated.character.name, '林远');
  assert.equal(updated.character.intro_fallback, false);
  const aliases = new Map(updated.character.aliases.map(item => [item.alias, item]));
  assert.equal(aliases.get('林远').is_primary, true);
  assert.equal(aliases.get('林野').alias_type, 'former_name');
  assert.equal(aliases.get('林野').is_primary, false);
});

test('findCharacters returns ambiguous alias candidates and archive changes default visibility', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('双生');
  const first = characters.createCharacter(bookId, {
    name: '苏晚',
    aliases: [{ alias: '信使', alias_type: 'title' }],
  }).character;
  const second = characters.createCharacter(bookId, {
    name: '钟离',
    aliases: [{ alias: '信使', alias_type: 'title' }],
  }).character;

  assert.deepEqual(
    characters.findCharacters(bookId, { q: '信使' }).map(item => item.id).sort((a, b) => a - b),
    [first.id, second.id].sort((a, b) => a - b)
  );

  characters.archiveCharacter(bookId, first.id);
  assert.deepEqual(
    characters.findCharacters(bookId).map(item => item.id),
    [second.id]
  );
  assert.deepEqual(
    characters.findCharacters(bookId, { archived: true }).map(item => item.id),
    [first.id]
  );
  characters.unarchiveCharacter(bookId, first.id);
  assert.equal(characters.findCharacters(bookId).length, 2);
});

test('profile and alias updates are scoped by stable character id and book id', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const firstBook = createBook('第一本');
  const secondBook = createBook('第二本');
  const character = characters.createCharacter(firstBook, { name: '同名者' }).character;

  assert.throws(
    () => characters.updateCharacterProfile(secondBook, character.id, { intro: '越权修改' }),
    err => err.code === 'CHARACTER_NOT_FOUND' && err.status === 404
  );
  assert.throws(
    () => characters.setAliases(firstBook, character.id, [
      { alias: '错误主名', alias_type: 'primary', is_primary: true },
    ]),
    err => err.code === 'VALIDATION_ERROR'
  );
  assert.equal(
    characters.getCharacterContext(firstBook, character.id).character.intro,
    ''
  );
});
