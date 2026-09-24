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

// P2b：抽出共享 normalizeStateValue，提案创建/更新与事件提交共用，old_value 与 new_value 同归一（评审 §1 硬化A）
test('normalizeStateValue 归一 list 单值/数组/空值，非 list 原样透传', () => {
  const listDef = { value_type: 'list' };
  assert.deepEqual(ledger.normalizeStateValue(listDef, '罗盘'), ['罗盘']);
  assert.deepEqual(ledger.normalizeStateValue(listDef, ['罗盘', ' 海图 ', '']), ['罗盘', '海图']);
  assert.deepEqual(ledger.normalizeStateValue(listDef, null), null);
  assert.deepEqual(ledger.normalizeStateValue(listDef, undefined), null);
  const textDef = { value_type: 'text' };
  assert.equal(ledger.normalizeStateValue(textDef, '轻伤'), '轻伤');
  assert.equal(ledger.normalizeStateValue(textDef, undefined), null);
  // 未知字段（无 definition）不改变值形状
  assert.equal(ledger.normalizeStateValue(null, '任意'), '任意');
  assert.deepEqual(ledger.normalizeStateValue(null, ['原样']), ['原样']);
});

test('提案创建：list 型 old_value 与 new_value 同时归一为数组', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('归一提案');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '持有物变更',
    source_type: 'manual',
    changes: [{
      change_kind: 'character_state',
      subject_ref: String(characterId),
      field_key: 'possession',
      old_value: '罗盘',
      new_value: '海图',
    }],
  });
  assert.deepEqual(proposal.changes[0].old_value, ['罗盘']);
  assert.deepEqual(proposal.changes[0].new_value, ['海图']);
});

test('提案更新：patch.changes 走同一归一，list 单值包装为数组', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('归一更新');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '持有物变更',
    source_type: 'manual',
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'possession', old_value: null, new_value: '罗盘' }],
  });
  const updated = proposals.updateProposal(bookId, proposal.id, {
    changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'possession', old_value: '罗盘', new_value: ['罗盘', '海图'] }],
  });
  assert.deepEqual(updated.changes[0].old_value, ['罗盘']);
  assert.deepEqual(updated.changes[0].new_value, ['罗盘', '海图']);
});

test('事件提交：list 单值 new_value 归一为数组，单值 old_value 与当前数组不再误判 STALE', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('归一账本');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  ledger.commitEvent(bookId, {
    title: '获得罗盘',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'possession', old_value: null, new_value: '罗盘' }],
  });
  assert.deepEqual(
    ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'possession').value,
    ['罗盘']
  );
  // old_value 填单值 '罗盘'，归一后等于当前 ['罗盘'] → 不再误报 STALE_OLD_VALUE
  ledger.commitEvent(bookId, {
    title: '追加海图',
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'possession', old_value: '罗盘', new_value: ['罗盘', '海图'] }],
  });
  assert.deepEqual(
    ledger.getCurrentStates(bookId, characterId).find(i => i.field_key === 'possession').value,
    ['罗盘', '海图']
  );
});

test('STALE_OLD_VALUE 补 actual_event_id 与来源事件叙事位置（评审 §2）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('陈旧详情');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野持有罗盘。', 1)", [bookId]).lastInsertRowid;
  const first = ledger.commitEvent(bookId, {
    title: '获得罗盘',
    chapter_id: chapterId,
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'possession', old_value: null, new_value: '罗盘' }],
  });
  let caught = null;
  try {
    ledger.commitEvent(bookId, {
      title: '冲突变更',
      changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'possession', old_value: '错误旧值', new_value: ['海图'] }],
    });
  } catch (err) { caught = err; }
  assert.ok(caught, '应抛 STALE_OLD_VALUE');
  assert.equal(caught.code, 'STALE_OLD_VALUE');
  assert.equal(caught.details.actual_event_id, first.event.id);
  assert.deepEqual(caught.details.expected, ['错误旧值']);
  assert.deepEqual(caught.details.actual, ['罗盘']);
  assert.equal(caught.details.actual_event_ref.event_id, first.event.id);
  assert.equal(caught.details.actual_event_ref.chapter_id, chapterId);
});
