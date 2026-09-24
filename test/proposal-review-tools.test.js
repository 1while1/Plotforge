const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const proposals = require('../server/domain/proposals');
const registry = require('../server/tools/registry');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

// 走完整确认闭环：首次调用返回 confirmation_required（附带提案差异快照），带 confirmationId 再调用才落地
async function confirmFlow(context, name, args) {
  const conf = await executeTool(context, name, args);
  assert.equal(conf.status, 'confirmation_required');
  const result = await executeTool(context, name, args, conf.confirmation.id);
  return { conf, result };
}

function seedProposal(bookId, characterId, value) {
  return proposals.createProposal(bookId, {
    title: '林野状态更新',
    source_type: 'manual',
    created_by: 'agent',
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: value }],
  });
}

test.beforeEach(() => actionStore.clear());

// P3：review_event_proposal 采纳——确认卡展示完整差异，作者确认后写正典（评审 §1）
test('review accept：确认信封带提案差异快照，确认后提案 accepted 且投影落地', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('评审采纳');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, characterId, '康复');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  const { conf, result } = await confirmFlow(context, 'review_event_proposal', {
    proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision,
  });

  const preview = conf.confirmation.preview;
  assert.equal(preview.kind, 'event_proposal');
  assert.equal(preview.proposal_id, proposal.id);
  assert.equal(preview.version_match, true);
  assert.equal(preview.created_by, 'agent');
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].field_key, 'health');
  assert.equal(preview.changes[0].new_value, '康复');

  assert.equal(result.proposal.status, 'accepted');
  assert.ok(result.event && result.event.id);
  assert.equal(ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'health').value, '康复');
});

// reject 缺 review_note：在请求确认前（validate 钩子）即抛错，不浪费作者的一次确认
test('review reject 无 review_note：确认前抛 VALIDATION_ERROR', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('驳回无理由');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, characterId, '康复');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  await assert.rejects(
    () => executeTool(context, 'review_event_proposal', {
      proposal_id: proposal.id, action: 'reject', expected_revision: proposal.revision,
    }),
    err => err.code === 'VALIDATION_ERROR'
  );
  // 提案仍未被驳回
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'pending');
});

test('review reject 带 review_note：确认后提案 rejected，不写正典', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('驳回有理由');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, characterId, '康复');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  const { result } = await confirmFlow(context, 'review_event_proposal', {
    proposal_id: proposal.id, action: 'reject', expected_revision: proposal.revision, review_note: '证据不足，正文未提及康复',
  });

  assert.equal(result.proposal.status, 'rejected');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
});

// 乐观锁：expected_revision 与提案当前 revision 不符——preview 标记 version_match=false，执行抛 PROPOSAL_VERSION_CONFLICT
test('review 版本不符：preview.version_match=false 且执行抛 PROPOSAL_VERSION_CONFLICT', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('版本冲突');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, characterId, '康复');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };
  const args = { proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision + 5 };

  const conf = await executeTool(context, 'review_event_proposal', args);
  assert.equal(conf.status, 'confirmation_required');
  assert.equal(conf.confirmation.preview.version_match, false);
  assert.equal(conf.confirmation.preview.expected_revision, proposal.revision + 5);

  await assert.rejects(
    () => executeTool(context, 'review_event_proposal', args, conf.confirmation.id),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT'
  );
  // 冲突未落地：提案仍 pending
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'pending');
});

// update_event_proposal：changes 全量替换 + 乐观锁递增 revision + 留痕；preview 展示更新前基线供核对
test('update：changes 全量替换、revision 递增、proposal_revisions 留痕，preview 显示更新前基线', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('更新提案');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, characterId, '轻伤');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };
  const args = {
    proposal_id: proposal.id,
    expected_revision: proposal.revision,
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: '重伤' }],
  };

  const conf = await executeTool(context, 'update_event_proposal', args);
  assert.equal(conf.status, 'confirmation_required');
  // preview 是更新前基线（轻伤），作者据此核对将要被替换的内容
  assert.equal(conf.confirmation.preview.revision, 1);
  assert.equal(conf.confirmation.preview.version_match, true);
  assert.equal(conf.confirmation.preview.changes[0].new_value, '轻伤');

  const updated = await executeTool(context, 'update_event_proposal', args, conf.confirmation.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.changes.length, 1);
  assert.equal(updated.changes[0].new_value, '重伤');

  const revisions = proposals.listProposalRevisions(bookId, proposal.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].revision, 1);
  assert.equal(revisions[0].changes[0].new_value, '轻伤');
  assert.equal(revisions[1].revision, 2);
  assert.equal(revisions[1].changes[0].new_value, '重伤');
});

// 注册边界：两工具仅 agent profile、confirmation=required、capability=proposals.write
test('两工具在 agent profile、confirmation=required，且不在 writing profile', () => {
  for (const name of ['update_event_proposal', 'review_event_proposal']) {
    const tool = registry.descriptor(name);
    assert.ok(tool, `${name} 应已注册`);
    assert.equal(tool.confirmation, 'required');
    assert.equal(tool.mutation, 'write');
    assert.equal(tool.capability, 'proposals.write');
    assert.equal(typeof tool.confirmationPreview, 'function');
  }
  const agentTools = registry.listTools('agent').map(item => item.name);
  assert.ok(agentTools.includes('update_event_proposal'));
  assert.ok(agentTools.includes('review_event_proposal'));
  const writingTools = registry.listTools('writing').map(item => item.name);
  assert.ok(!writingTools.includes('review_event_proposal'));
  assert.ok(!writingTools.includes('update_event_proposal'));
});
