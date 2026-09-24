const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const proposals = require('../server/domain/proposals');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

function healthProposal(bookId, characterId, title, oldValue, newValue, extra = {}) {
  return proposals.createProposal(bookId, {
    title,
    source_type: extra.source_type || 'chapter_summary',
    source_revision_hash: extra.source_revision_hash || 'rev-1',
    chapter_id: extra.chapter_id,
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: oldValue,
      new_value: newValue,
    }],
  });
}

test('proposal stays noncanonical until accepted and acceptance is atomic and idempotent', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('提案');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = healthProposal(bookId, characterId, '林野左臂受伤', null, '轻伤');

  assert.equal(proposal.status, 'pending');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    null
  );
  const duplicate = healthProposal(bookId, characterId, '林野左臂受伤', null, '轻伤');
  assert.equal(duplicate.id, proposal.id);

  const accepted = proposals.acceptProposal(bookId, proposal.id);
  assert.equal(accepted.proposal.status, 'accepted');
  assert.equal(accepted.event.origin, 'proposal');
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    '轻伤'
  );
  const again = proposals.acceptProposal(bookId, proposal.id);
  assert.equal(again.idempotent, true);
  assert.equal(again.event_id, accepted.event_id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 1);
});

test('stale proposal requires override and batch review reports partial results', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('批量');
  const characterId = characters.createCharacter(bookId, { name: '苏晚' }).character.id;

  const first = healthProposal(bookId, characterId, '苏晚恢复', null, '正常', {
    source_revision_hash: 'rev-a',
  });
  const second = healthProposal(bookId, characterId, '苏晚再次受伤', '正常', '轻伤', {
    source_revision_hash: 'rev-b',
  });
  proposals.markStale(bookId, second.id, '正文已修改');

  const results = proposals.batchReview(bookId, {
    action: 'accept',
    proposal_ids: [first.id, second.id],
    allow_stale: false,
  });
  assert.deepEqual(results.map(item => item.ok), [true, false]);
  assert.equal(results[1].error.code, 'PROPOSAL_STALE');
  assert.equal(proposals.getProposal(bookId, second.id).status, 'stale');

  const accepted = proposals.acceptProposal(bookId, second.id, { allow_stale: true });
  assert.equal(accepted.proposal.status, 'accepted');
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    '轻伤'
  );
});

test('proposal merge keeps audit source and replaces target content', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('合并');
  const characterId = characters.createCharacter(bookId, { name: '钟离' }).character.id;
  const source = healthProposal(bookId, characterId, '提案一', null, '疲惫', {
    source_revision_hash: 'one',
  });
  const target = healthProposal(bookId, characterId, '提案二', null, '受伤', {
    source_revision_hash: 'two',
  });

  const merged = proposals.mergeProposal(bookId, source.id, target.id, {
    title: '钟离状态变化',
    summary: '合并为一次有意义的事件。',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '疲惫',
    }],
  });
  assert.equal(merged.source.status, 'merged');
  assert.equal(merged.source.merged_into_id, target.id);
  assert.equal(merged.target.title, '钟离状态变化');
  assert.equal(merged.target.changes.length, 1);
});
