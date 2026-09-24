const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const relations = require('../server/domain/relations');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

function relationType(bookId, key) {
  return relations.listRelationTypes(bookId).find(item => item.type_key === key);
}

test('relation snapshot separates all dimensions and keeps stable public id', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('关系');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;
  const ally = relationType(bookId, 'ally');

  const created = relations.recordRelationChange(bookId, {
    event: { title: '达成秘密合作' },
    relation: {
      character_a_id: su,
      character_b_id: lin,
      relation_type_id: ally.id,
      direction: 'a_to_b',
      strength: 4,
      polarity: 'mixed',
      lifecycle: 'active',
      secrecy: 'secret',
      note: '双方合作但仍互不信任。',
    },
  });
  const publicId = created.event.changes[0].subject_ref;
  assert.match(publicId, /^rel_/);

  const fromLin = relations.getRelations(bookId, lin, { secrecy: 'all' })[0];
  assert.equal(fromLin.public_id, publicId);
  assert.equal(fromLin.endpoint_a.id, Math.min(lin, su));
  assert.equal(fromLin.endpoint_b.id, Math.max(lin, su));
  assert.equal(fromLin.direction, 'b_to_a');
  assert.equal(fromLin.strength, 4);
  assert.equal(fromLin.polarity, 'mixed');
  assert.equal(fromLin.lifecycle, 'active');
  assert.equal(fromLin.secrecy, 'secret');

  const ended = ledger.commitEvent(bookId, {
    title: '合作结束',
    changes: [{
      change_kind: 'relation',
      subject_ref: publicId,
      field_key: 'lifecycle',
      old_value: 'active',
      new_value: 'ended',
    }],
  });
  assert.equal(ended.event.changes[0].subject_ref, publicId);
  assert.equal(relations.getRelations(bookId, lin, { lifecycle: 'ended', secrecy: 'all' })[0].public_id, publicId);
  assert.equal(relations.getRelations(bookId, lin, { lifecycle: 'active', secrecy: 'all' }).length, 0);
});

test('same pair supports different types and rejects duplicate same type', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('多关系');
  const first = characters.createCharacter(bookId, { name: '甲' }).character.id;
  const second = characters.createCharacter(bookId, { name: '乙' }).character.id;
  const ally = relationType(bookId, 'ally');
  const rival = relationType(bookId, 'rival');

  for (const type of [ally, rival]) {
    relations.recordRelationChange(bookId, {
      event: { title: type.forward_label },
      relation: {
        character_a_id: first,
        character_b_id: second,
        relation_type_id: type.id,
        direction: type.default_direction,
        strength: 3,
        polarity: type.default_polarity,
        lifecycle: 'active',
        secrecy: 'public',
      },
    });
  }
  assert.equal(relations.getRelations(bookId, first).length, 2);
  assert.throws(() => relations.recordRelationChange(bookId, {
    event: { title: '重复盟友' },
    relation: {
      character_a_id: first,
      character_b_id: second,
      relation_type_id: ally.id,
      strength: 2,
    },
  }), err => err.code === 'RELATION_EXISTS');
});

test('one event atomically commits state and relation projections', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('跨投影事务');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;
  const ally = relationType(bookId, 'ally');
  const publicId = relations.generatePublicId();

  const result = ledger.commitEvent(bookId, {
    title: '苏晚救下林野',
    changes: [
      {
        change_kind: 'character_state',
        subject_ref: lin,
        field_key: 'health',
        old_value: null,
        new_value: '轻伤',
      },
      {
        change_kind: 'relation',
        subject_ref: publicId,
        field_key: 'snapshot',
        old_value: null,
        new_value: {
          endpoint_a: lin,
          endpoint_b: su,
          relation_type_id: ally.id,
          direction: 'both',
          strength: 4,
          polarity: 'positive',
          lifecycle: 'active',
          secrecy: 'public',
          note: '共同脱险。',
        },
      },
    ],
  });
  assert.equal(result.event.changes.length, 2);
  assert.equal(
    ledger.getCurrentStates(bookId, lin).find(item => item.field_key === 'health').value,
    '轻伤'
  );
  assert.equal(relations.getRelations(bookId, lin)[0].public_id, publicId);

  assert.throws(() => ledger.commitEvent(bookId, {
    title: '原子回滚',
    changes: [
      {
        change_kind: 'character_state',
        subject_ref: lin,
        field_key: 'health',
        old_value: '轻伤',
        new_value: '重伤',
      },
      {
        change_kind: 'relation',
        subject_ref: publicId,
        field_key: 'strength',
        old_value: 4,
        new_value: 9,
      },
    ],
  }), err => err.code === 'VALIDATION_ERROR');
  assert.equal(
    ledger.getCurrentStates(bookId, lin).find(item => item.field_key === 'health').value,
    '轻伤'
  );
  assert.equal(relations.getRelations(bookId, lin)[0].strength, 4);
});

test('as-of chapter relation read replays narrative history without unanchored events', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('关系历史');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;
  const ally = relationType(bookId, 'ally');
  const chapterOne = db.run(
    "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '第一章', 1)",
    [bookId]
  ).lastInsertRowid;
  const chapterTwo = db.run(
    "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '第二章', 2)",
    [bookId]
  ).lastInsertRowid;

  const created = relations.recordRelationChange(bookId, {
    event: { title: '合作', chapter_id: chapterOne },
    relation: {
      character_a_id: lin,
      character_b_id: su,
      relation_type_id: ally.id,
      strength: 2,
      polarity: 'neutral',
      lifecycle: 'active',
      secrecy: 'public',
    },
  });
  const publicId = created.event.changes[0].subject_ref;
  ledger.commitEvent(bookId, {
    title: '信任加深',
    chapter_id: chapterTwo,
    changes: [{
      change_kind: 'relation',
      subject_ref: publicId,
      field_key: 'strength',
      old_value: 2,
      new_value: 5,
    }],
  });

  assert.equal(relations.getRelations(bookId, lin, { as_of_chapter: chapterOne })[0].strength, 2);
  assert.equal(relations.getRelations(bookId, lin, { as_of_chapter: chapterTwo })[0].strength, 5);
  assert.equal(relations.getRelations(bookId, lin)[0].strength, 5);
});
