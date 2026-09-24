const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const prefs = require('../server/domain/sidebarPreferences');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('sidebar defaults are compact and characters show name role intro', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('侧栏');
  const value = prefs.getPreferences(bookId);
  assert.deepEqual(value.moduleOrder, ['chapters', 'characters', 'outline', 'ledger', 'world']);
  assert.deepEqual(value.summaryFields.characters, ['name', 'role', 'intro']);
  assert.deepEqual(value.hiddenModules, []);
});

test('sidebar normalization removes invalid duplicates, caps fields and preserves chapters', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('设置');
  const saved = prefs.savePreferences(bookId, {
    moduleOrder: ['characters', 'characters', 'unknown', 'world'],
    hiddenModules: ['chapters', 'ledger', 'unknown'],
    summaryFields: {
      characters: ['name', 'role', 'intro', 'location', 'unknown'],
      world: ['name', 'unknown'],
    },
  });
  assert.equal(saved.moduleOrder[0], 'characters');
  assert.equal(saved.moduleOrder.length, 5);
  assert.deepEqual(saved.hiddenModules, ['ledger']);
  assert.deepEqual(saved.summaryFields.characters, ['name', 'role', 'intro']);
  assert.deepEqual(saved.summaryFields.world, ['name']);
  assert.deepEqual(prefs.getPreferences(bookId), saved);
});

test('sidebar preferences are isolated per book', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const first = createBook('一');
  const second = createBook('二');
  prefs.savePreferences(first, {
    moduleOrder: ['characters'],
    hiddenModules: ['ledger'],
    summaryFields: { characters: ['name', 'intro'] },
  });
  assert.deepEqual(prefs.getPreferences(first).hiddenModules, ['ledger']);
  assert.deepEqual(prefs.getPreferences(second).hiddenModules, []);
});
