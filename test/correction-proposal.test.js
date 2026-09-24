const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const proposals = require('../server/domain/proposals');
const registry = require('../server/tools/registry');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

// P2c：correct_story_event 不再直接写正典，而是创建 supersedes 修正提案；采纳时才走修正事务（评审 §1 正典政策）
test('修正提案创建：带 supersedes_event_id/created_by，pending 且不改动正典', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('修正提案');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '林野受伤',
    importance: 'high',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '重伤' }],
  }).event;
  const before = db.get('SELECT COUNT(*) AS n FROM story_events').n;

  const proposal = proposals.createProposal(bookId, {
    title: '修正：林野避开了攻击',
    source_type: 'manual',
    supersedes_event_id: original.id,
    created_by: 'agent',
    created_via: 'correct_story_event',
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: '健康' }],
  });

  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.supersedes_event_id, original.id);
  assert.equal(proposal.created_by, 'agent');
  // 创建提案不写正典：事件数不变，投影仍是原值
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, before);
  assert.equal(ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'health').value, '重伤');
});

test('采纳修正提案：走修正事务，生成替代事件 + 原事件被取代 + 投影重建', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('采纳修正');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '林野受伤',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '重伤' }],
  }).event;
  const proposal = proposals.createProposal(bookId, {
    title: '修正：林野避开攻击',
    source_type: 'manual',
    supersedes_event_id: original.id,
    created_by: 'agent',
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: '健康' }],
  });

  const accepted = proposals.acceptProposal(bookId, proposal.id, { actor: 'author' });
  assert.equal(accepted.proposal.status, 'accepted');
  assert.equal(accepted.event.supersedes_event_id, original.id);
  assert.equal(accepted.event.origin, 'proposal');
  assert.equal(accepted.proposal.accepted_event_id, accepted.event.id);
  // 原事件被取代：superseded_by 指向替代事件
  assert.equal(ledger.getEvent(bookId, original.id).superseded_by_event_id, accepted.event.id);
  // 投影重建为修正后的值
  assert.equal(ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'health').value, '健康');
});

test('重复修正同一事件：第二次采纳抛 EVENT_ALREADY_SUPERSEDED', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('重复修正');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '林野受伤',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '重伤' }],
  }).event;
  const mk = title => proposals.createProposal(bookId, {
    title, source_type: 'manual', supersedes_event_id: original.id, created_by: 'agent',
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: '健康' }],
  });
  const first = mk('修正一');
  const second = mk('修正二');
  proposals.acceptProposal(bookId, first.id, { actor: 'author' });
  assert.throws(
    () => proposals.acceptProposal(bookId, second.id, { actor: 'author' }),
    err => err.code === 'EVENT_ALREADY_SUPERSEDED'
  );
});

test('correct_story_event 工具 execute 生成修正提案而非直接改正典，并标记 created_by=agent', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('工具修正');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '林野受伤',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '重伤' }],
  }).event;
  const before = db.get('SELECT COUNT(*) AS n FROM story_events').n;

  const tool = registry.descriptor('correct_story_event');
  assert.equal(tool.capability, 'proposals.write');
  const proposal = await tool.execute({
    bookId,
    profile: 'agent',
    sessionId: 'agent:test-session',
    model: 'test-model',
    args: {
      event_id: original.id,
      replacement: {
        title: '修正：林野避开攻击',
        changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'health', old_value: null, new_value: '健康' }],
      },
    },
  });
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.supersedes_event_id, original.id);
  assert.equal(proposal.created_by, 'agent');
  assert.equal(proposal.created_via, 'correct_story_event');
  assert.equal(proposal.created_session_id, 'agent:test-session');
  // 工具只提案，不直接生成正典事件
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, before);
  assert.equal(ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'health').value, '重伤');
});

test('修正提案 supersedes_event_id 跨书/不存在被拒（EVENT_NOT_FOUND）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookA = createBook('书A');
  const bookB = createBook('书B');
  const charB = characters.createCharacter(bookB, { name: '沈舟' }).character.id;
  const eventB = ledger.commitEvent(bookB, {
    title: '书B事件',
    changes: [{ change_kind: 'character_state', subject_ref: charB, field_key: 'health', old_value: null, new_value: '轻伤' }],
  }).event;
  const charA = characters.createCharacter(bookA, { name: '林野' }).character.id;
  const baseChanges = [{ change_kind: 'character_state', subject_ref: String(charA), field_key: 'health', old_value: null, new_value: '健康' }];
  assert.throws(
    () => proposals.createProposal(bookA, { title: '跨书修正', source_type: 'manual', supersedes_event_id: eventB.id, changes: baseChanges }),
    err => err.code === 'EVENT_NOT_FOUND'
  );
  assert.throws(
    () => proposals.createProposal(bookA, { title: '空修正', source_type: 'manual', supersedes_event_id: 999999, changes: baseChanges }),
    err => err.code === 'EVENT_NOT_FOUND'
  );
});

// 死信提案防护（2026-09-10 十章实测）：创建侧与采纳侧口径必须一致
test('提案 subject_ref 必须是本书人物数字 id：人名/不存在 id 在创建侧即被拒', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));

  const bookId = createBook('死信提案');
  const chen = characters.createCharacter(bookId, { name: '陈默' }).character.id;

  // 人名：实测模型把 subject_ref 填成「陈默」，提案照样落库、采纳时才报错 → 永远无法采纳
  assert.throws(() => proposals.createProposal(bookId, {
    title: '人名引用', chapter_id: null, changes: [
      { change_kind: 'character_state', subject_ref: '陈默', field_key: 'location', new_value: '图书馆' },
    ],
  }), (err) => {
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.details.field, 'subject_ref');
    assert.ok(err.message.includes('list_characters'), `提示应指路查 id，实际：${err.message}`);
    return true;
  });

  // 不存在/他书的数字 id 同样拒绝
  assert.throws(() => proposals.createProposal(bookId, {
    title: '不存在的人', chapter_id: null, changes: [
      { change_kind: 'character_state', subject_ref: '999999', field_key: 'location', new_value: '图书馆' },
    ],
  }), err => err.code === 'VALIDATION_ERROR' && err.details.field === 'subject_ref');

  // 合法数字 id：正常创建，且采纳侧校验也能通过（两侧口径一致）
  const ok = proposals.createProposal(bookId, {
    title: '合法引用', chapter_id: null, changes: [
      { change_kind: 'character_state', subject_ref: String(chen), field_key: 'location', new_value: '图书馆旧书库' },
    ],
  });
  assert.ok(ok.id, '合法人物 id 应能创建提案');
  const accepted = proposals.acceptProposal(bookId, ok.id);
  assert.ok(accepted.event_id, '合法提案应能采纳（不再出现创建成功但采纳被拒的死信）');
});
