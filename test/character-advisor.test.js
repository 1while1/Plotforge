const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const advisor = require('../server/advisor/characterAdvisor');

async function setup() {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['顾问测试书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野', role: '主角', intro: '逃亡船长，对权威保持戒备。' }).character.id;
  return { location, bookId, characterId };
}

function validReply(messages, overrides = {}) {
  const context = JSON.parse(messages.find(item => item.role === 'user').content);
  return JSON.stringify({ suggestions: [{ type: 'A', title: '保留主动权', conclusion: '让林野主动提出交换条件。', inference: '戒备会转化为谈判行为。', assumptions: ['对方仍愿意谈判'], impacts: ['关系张力上升'], anchors: [context.evidence[0].anchor], ...overrides }] });
}

test('advisor persists grounded suggestions and suppresses an ignored fingerprint until evidence changes', async t => {
  const env = await setup();
  t.after(() => cleanup(env.location));
  const model = async messages => ({ content: validReply(messages) });
  const first = await advisor.consultCharacter(env.bookId, env.characterId, { focus: '人物弧光' }, model);
  assert.equal(first.suggestions.length, 1);
  assert.equal(first.suggestions[0].citations.length, 1);
  advisor.ignoreSuggestion(env.bookId, env.characterId, first.suggestions[0].id);
  const second = await advisor.consultCharacter(env.bookId, env.characterId, { focus: '人物弧光' }, model);
  assert.equal(second.suggestions.length, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM advisor_sessions').n, 2);
});

test('advisor retries one unknown anchor and persists nothing when the retry is still invalid', async t => {
  const env = await setup();
  t.after(() => cleanup(env.location));
  let calls = 0;
  const model = async messages => { calls += 1; return { content: validReply(messages, { anchors: ['chapter:999:p0:rev:fake'] }) }; };
  await assert.rejects(() => advisor.consultCharacter(env.bookId, env.characterId, { focus: '行为选择' }, model), error => error.code === 'ADVISOR_INVALID_CITATION');
  assert.equal(calls, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM advisor_sessions').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM advisor_suggestions').n, 0);
});

// 采纳目标治理（方向报告 1.7）：每个可选项必须有真实去向，不提供假闭环。
test('advisor 采纳目标真实落地：提案生成实体、仅标记无实体、假转交拒绝', async t => {
  const env = await setup();
  t.after(() => cleanup(env.location));
  const model = async messages => ({ content: validReply(messages) });
  const first = await advisor.consultCharacter(env.bookId, env.characterId, { focus: '人物弧光' }, model);
  const id = first.suggestions[0].id;

  // event_proposal：落地为待审提案实体（source_type=advisor，标题取建议本体）——
  // 前端不暴露此选项（事实提案需字段级 changes，顾问建议是策略性建议，语义不同），
  // 后端保留给 Agent/高级用法，须携带完整 changes 才成立
  const adopted = advisor.adoptSuggestion(env.bookId, env.characterId, id, {
    target: 'event_proposal',
    payload: { changes: [{ change_kind: 'character_state', subject_ref: env.characterId, field_key: 'health', old_value: null, new_value: '轻伤' }] },
  });
  assert.equal(adopted.suggestion.status, 'adopted');
  assert.ok(adopted.entity && adopted.entity.id, '提案实体应已创建');
  const proposalRow = db.get('SELECT * FROM event_proposals WHERE id = ?', [adopted.entity.id]);
  assert.equal(proposalRow.source_type, 'advisor');
  assert.equal(proposalRow.title, '保留主动权');

  // advisor_note：唯一允许的无实体路径——仅标记，adoptions 行如实记录无目标实体
  const second = await advisor.consultCharacter(env.bookId, env.characterId, { focus: '人物弧光', question: '换个问法' }, model);
  const noteId = second.suggestions[0].id;
  const marked = advisor.adoptSuggestion(env.bookId, env.characterId, noteId, { target: 'advisor_note' });
  assert.equal(marked.suggestion.status, 'adopted');
  assert.equal(marked.entity, null);
  const adoptionRow = db.get('SELECT * FROM advisor_adoptions WHERE suggestion_id = ?', [noteId]);
  assert.equal(adoptionRow.target_type, 'advisor_note');
  assert.equal(adoptionRow.target_entity_id, '', '仅标记路径不应伪造目标实体');

  // consult_transfer：假闭环已移除——通用参谋不入库，转交无可落地目标
  const third = await advisor.consultCharacter(env.bookId, env.characterId, { focus: '人物弧光', question: '再问' }, model);
  const transferId = third.suggestions[0].id;
  assert.throws(
    () => advisor.adoptSuggestion(env.bookId, env.characterId, transferId, { target: 'consult_transfer' }),
    error => error.code === 'VALIDATION_ERROR' && error.status === 400,
    '已移除的假闭环目标应 400 拒绝'
  );
});
