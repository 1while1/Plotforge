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

function healthChange(characterId, value) {
  return { change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: value };
}

// P2d：提案治理——revision 乐观锁 + content_hash + proposal_revisions 留痕（评审 §3/§6）
test('createProposal 初始化 revision=1、content_hash 与首版快照', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理创建');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  assert.equal(Number(proposal.revision), 1);
  assert.match(proposal.content_hash, /^[a-f0-9]{64}$/);
  const revisions = proposals.listProposalRevisions(bookId, proposal.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 1);
  assert.deepEqual(revisions[0].changes[0].new_value, '重伤');
});

test('updateProposal 改动内容递增 revision 并留痕，原 changes 可从历史回溯', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理更新');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  const updated = proposals.updateProposal(bookId, proposal.id, {
    changes: [healthChange(characterId, '轻伤')],
  }, { edited_by: 'author', edit_note: '核对正文后下调' });

  assert.equal(Number(updated.revision), 2);
  assert.notEqual(updated.content_hash, proposal.content_hash);
  assert.deepEqual(updated.changes[0].new_value, '轻伤');
  // 留痕：rev1（原 changes 已被 DELETE 覆盖）仍可回溯
  const revisions = proposals.listProposalRevisions(bookId, proposal.id);
  assert.deepEqual(revisions.map(r => r.revision), [1, 2]);
  assert.deepEqual(revisions[0].changes[0].new_value, '重伤');
  assert.deepEqual(revisions[1].changes[0].new_value, '轻伤');
  assert.equal(revisions[1].edit_note, '核对正文后下调');
});

test('updateProposal 内容未变不递增 revision（不误伤待确认凭证）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理空更新');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  const touched = proposals.updateProposal(bookId, proposal.id, { title: '林野受伤' });
  assert.equal(Number(touched.revision), 1);
  assert.equal(touched.content_hash, proposal.content_hash);
  assert.equal(proposals.listProposalRevisions(bookId, proposal.id).length, 1);
});

test('updateProposal expected_revision 不符抛 PROPOSAL_VERSION_CONFLICT（options 与 patch 两路）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理乐观锁');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  assert.throws(
    () => proposals.updateProposal(bookId, proposal.id, { title: '改名' }, { expected_revision: 99 }),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT' && err.details.actual_revision === 1
  );
  assert.throws(
    () => proposals.updateProposal(bookId, proposal.id, { title: '改名', expected_revision: 99 }),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT'
  );
  // 匹配则成功
  const ok = proposals.updateProposal(bookId, proposal.id, { title: '林野重伤' }, { expected_revision: 1 });
  assert.equal(ok.title, '林野重伤');
  assert.equal(Number(ok.revision), 2);
});

test('acceptProposal expected_revision 不符则拒绝且不写正典', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理采纳锁');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  const before = db.get('SELECT COUNT(*) AS n FROM story_events').n;
  assert.throws(
    () => proposals.acceptProposal(bookId, proposal.id, { expected_revision: 99 }),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT'
  );
  // 拒绝后不写正典、提案仍 pending
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, before);
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'pending');
  // 匹配版本则采纳成功
  const accepted = proposals.acceptProposal(bookId, proposal.id, { expected_revision: 1 });
  assert.equal(accepted.event_id, accepted.event.id);
  assert.equal(ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'health').value, '重伤');
});

test('rejectProposal expected_revision 不符抛 PROPOSAL_VERSION_CONFLICT', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('治理驳回锁');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野受伤', source_type: 'manual', changes: [healthChange(characterId, '重伤')],
  });
  assert.throws(
    () => proposals.rejectProposal(bookId, proposal.id, { expected_revision: 99 }),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT'
  );
  const rejected = proposals.rejectProposal(bookId, proposal.id, { expected_revision: 1, review_note: '证据不足' });
  assert.equal(rejected.proposal.status, 'rejected');
});
