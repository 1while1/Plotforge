const test = require('node:test');
const assert = require('node:assert/strict');
const actionStore = require('../server/actionStore');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');

// 3.1 落库版 actionStore 需要 db：文件级共享一个隔离库，用例间仅清动作行
let location;
test.before(async () => {
  location = createTempLocation();
  await db.init({ filePath: location.filePath });
});
test.after(async () => { cleanup(location); });

test.beforeEach(() => actionStore.clear());

test('confirmation binds canonical arguments, book, tool and session', () => {
  const action = actionStore.create(2, 'update_character_profile', {
    character_id: 3,
    patch: { intro: '逃亡船长', role: '主角' },
  }, { sessionId: 'session-a' });

  const reordered = actionStore.authorize(action.id, {
    bookId: 2,
    name: 'update_character_profile',
    sessionId: 'session-a',
    args: {
      patch: { role: '主角', intro: '逃亡船长' },
      character_id: 3,
    },
  });
  assert.equal(reordered.ok, true);
});

test('changed parameters, cross-book and cross-session confirmations are rejected', () => {
  const changed = actionStore.create(2, 'archive_character', {
    character_id: 3,
  }, { sessionId: 'session-a' });
  assert.equal(actionStore.authorize(changed.id, {
    bookId: 2,
    name: 'archive_character',
    sessionId: 'session-a',
    args: { character_id: 4 },
  }).code, 'CONFIRMATION_MISMATCH');

  const crossBook = actionStore.create(2, 'archive_character', { character_id: 3 }, {
    sessionId: 'session-a',
  });
  assert.equal(actionStore.authorize(crossBook.id, {
    bookId: 9,
    name: 'archive_character',
    sessionId: 'session-a',
    args: { character_id: 3 },
  }).code, 'CONFIRMATION_MISMATCH');

  const crossSession = actionStore.create(2, 'archive_character', { character_id: 3 }, {
    sessionId: 'session-a',
  });
  assert.equal(actionStore.authorize(crossSession.id, {
    bookId: 2,
    name: 'archive_character',
    sessionId: 'session-b',
    args: { character_id: 3 },
  }).code, 'CONFIRMATION_MISMATCH');
});

test('confirmation is one-time and expires', async () => {
  const action = actionStore.create(2, 'archive_character', { character_id: 3 });
  assert.equal(actionStore.authorize(action.id, {
    bookId: 2,
    name: action.name,
    args: action.args,
    sessionId: action.sessionId,
  }).ok, true);
  assert.equal(actionStore.authorize(action.id, {
    bookId: 2,
    name: action.name,
    args: action.args,
    sessionId: action.sessionId,
  }).code, 'CONFIRMATION_USED');

  const expired = actionStore.create(2, 'archive_character', { character_id: 3 }, { ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(actionStore.authorize(expired.id, {
    bookId: 2,
    name: expired.name,
    args: expired.args,
    sessionId: expired.sessionId,
  }).code, 'CONFIRMATION_EXPIRED');
});
