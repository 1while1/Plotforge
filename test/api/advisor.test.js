const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const characters = require('../../server/domain/characters');
const advisor = require('../../server/advisor/characterAdvisor');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

test('advisor history API is character scoped and adoption never creates a canonical event', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['人物顾问接口']).lastInsertRowid;
  const otherBook = db.run('INSERT INTO books (title) VALUES (?)', ['另一部书']).lastInsertRowid;
  db.transaction(() => { seedBook(db, bookId); seedBook(db, otherBook); });
  const characterId = characters.createCharacter(bookId, { name: '林野', intro: '逃亡船长' }).character.id;
  const result = await advisor.consultCharacter(bookId, characterId, { focus: '人物弧光' }, async messages => {
    const context = JSON.parse(messages.find(item => item.role === 'user').content);
    return { content: JSON.stringify({ suggestions: [{ type: 'D', title: '推进弧光', conclusion: '建立一个未完成的行动承诺。', inference: '', assumptions: [], impacts: [], anchors: [context.evidence[0].anchor] }] }) };
  });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const history = await json(http.baseUrl, 'GET', `/api/books/${bookId}/characters/${characterId}/advisor/sessions`);
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].suggestions[0].title, '推进弧光');
  const crossBook = await json(http.baseUrl, 'GET', `/api/books/${otherBook}/characters/${characterId}/advisor/sessions`);
  assert.equal(crossBook.status, 404);
  const adopted = await json(http.baseUrl, 'POST', `/api/books/${bookId}/characters/${characterId}/advisor/suggestions/${result.suggestions[0].id}/adopt`, { target: 'story_thread', payload: { title: '主动交付旧船牌', summary: '候选行动承诺' } });
  assert.equal(adopted.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_threads').n, 1);
});
