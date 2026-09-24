const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const registry = require('../server/tools/registry');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}
function fieldOf(bookId, fieldKey) {
  return ledger.listStateFields(bookId).find(item => item.field_key === fieldKey);
}
// 走完整确认闭环：首次调用返回 confirmation_required（附带建字段快照），带 confirmationId 再调用才落地
async function confirmFlow(context, args) {
  const conf = await executeTool(context, 'create_state_field', args);
  assert.equal(conf.status, 'confirmation_required');
  const result = await executeTool(context, 'create_state_field', args, conf.confirmation.id);
  return { conf, result };
}
const baseContext = bookId => ({ profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' });

test.beforeEach(() => actionStore.clear());

// text 字段无需 options：确认后落地、进入投影定义、可用于事件（评审 §1）
test('create_state_field：text 字段确认后落地并可用于事件', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('建文本字段');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const context = baseContext(bookId);

  const { conf } = await confirmFlow(context, {
    field_key: 'mood', label: '情绪', value_type: 'text', sort_order: 90, reason: '现有字段无法表达角色即时情绪',
  });
  // 确认卡快照展示将创建的字段与理由，text 类型不带 options
  const preview = conf.confirmation.preview;
  assert.equal(preview.action, 'create_state_field');
  assert.equal(preview.field_key, 'mood');
  assert.equal(preview.value_type, 'text');
  assert.equal(preview.reason, '现有字段无法表达角色即时情绪');
  assert.equal(preview.options, undefined);

  const field = fieldOf(bookId, 'mood');
  assert.ok(field, '字段应已创建');
  assert.equal(field.value_type, 'text');
  assert.equal(field.sort_order, 90);
  // 新字段进入投影定义（enabled=1），当前值为 null
  const state = ledger.getCurrentStates(bookId, lin).find(item => item.field_key === 'mood');
  assert.ok(state, '新字段应出现在人物当前状态定义中');
  assert.equal(state.value, null);

  // 可用于正式事件
  ledger.commitEvent(bookId, {
    title: '林野冷静下来',
    changes: [{ change_kind: 'character_state', subject_ref: lin, field_key: 'mood', new_value: '冷静' }],
  });
  assert.equal(ledger.getCurrentStates(bookId, lin).find(item => item.field_key === 'mood').value, '冷静');
});

// enum 带 options：确认后 options 持久化并回显
test('create_state_field：enum 带 options 成功后候选项持久化', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('建枚举字段');
  const context = baseContext(bookId);

  const { conf } = await confirmFlow(context, {
    field_key: 'stance', label: '立场', value_type: 'enum',
    options: ['中立', '敌对', '盟友'], reason: '需要枚举角色对某势力的立场',
  });
  assert.deepEqual(conf.confirmation.preview.options, ['中立', '敌对', '盟友']);
  assert.deepEqual(fieldOf(bookId, 'stance').options, ['中立', '敌对', '盟友']);
});

// enum 缺 options：确认前（validate 钩子）即抛 VALIDATION_ERROR，字段未创建，不浪费作者一次确认
test('create_state_field：enum 缺 options 确认前抛 VALIDATION_ERROR', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('枚举缺候选');
  const context = baseContext(bookId);

  await assert.rejects(
    () => executeTool(context, 'create_state_field', {
      field_key: 'stance', label: '立场', value_type: 'enum', reason: '需要枚举立场',
    }),
    err => err.code === 'VALIDATION_ERROR' && err.details.field === 'options'
  );
  assert.equal(fieldOf(bookId, 'stance'), undefined);
});

// level 缺 options：同 enum，确认前拦截
test('create_state_field：level 缺 options 确认前抛 VALIDATION_ERROR', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('层级缺候选');
  const context = baseContext(bookId);

  await assert.rejects(
    () => executeTool(context, 'create_state_field', {
      field_key: 'rank', label: '阶位', value_type: 'level', reason: '需要阶位分级',
    }),
    err => err.code === 'VALIDATION_ERROR' && err.details.value_type === 'level'
  );
  assert.equal(fieldOf(bookId, 'rank'), undefined);
});

// 缺 reason：确认前抛 VALIDATION_ERROR（受限工具必须说明为何现有字段不足）
test('create_state_field：缺 reason 确认前抛 VALIDATION_ERROR', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('缺理由');
  const context = baseContext(bookId);

  await assert.rejects(
    () => executeTool(context, 'create_state_field', {
      field_key: 'mood', label: '情绪', value_type: 'text', reason: '   ',
    }),
    err => err.code === 'VALIDATION_ERROR' && err.details.field === 'reason'
  );
  assert.equal(fieldOf(bookId, 'mood'), undefined);
});

// 重复 field_key：validate 通过（不查存在性），执行阶段 domain 抛 STATE_FIELD_EXISTS
test('create_state_field：重复 field_key 执行阶段抛 STATE_FIELD_EXISTS', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('重复字段');
  const context = baseContext(bookId);
  // location 是种子字段，已存在
  const args = { field_key: 'location', label: '位置', value_type: 'text', reason: '重复测试' };

  const conf = await executeTool(context, 'create_state_field', args);
  assert.equal(conf.status, 'confirmation_required');
  await assert.rejects(
    () => executeTool(context, 'create_state_field', args, conf.confirmation.id),
    err => err.code === 'STATE_FIELD_EXISTS'
  );
});

// 保留/非法 field_key（relation 保留）：执行阶段 domain 抛 INVALID_STATE_FIELD
test('create_state_field：保留 field_key relation 执行阶段抛 INVALID_STATE_FIELD', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('保留字段');
  const context = baseContext(bookId);
  const args = { field_key: 'relation', label: '关系', value_type: 'text', reason: '保留字测试' };

  const conf = await executeTool(context, 'create_state_field', args);
  assert.equal(conf.status, 'confirmation_required');
  await assert.rejects(
    () => executeTool(context, 'create_state_field', args, conf.confirmation.id),
    err => err.code === 'INVALID_STATE_FIELD'
  );
});

// 注册边界：仅 agent profile、confirmation=required、mutation=write、capability=ledger.write，带 validate/confirmationPreview
test('create_state_field：注册边界（agent 有、writing 无、需确认）', () => {
  const tool = registry.descriptor('create_state_field');
  assert.ok(tool, 'create_state_field 应已注册');
  assert.equal(tool.confirmation, 'required');
  assert.equal(tool.mutation, 'write');
  assert.equal(tool.capability, 'ledger.write');
  assert.equal(typeof tool.validate, 'function');
  assert.equal(typeof tool.confirmationPreview, 'function');

  const agentTools = registry.listTools('agent').map(item => item.name);
  assert.ok(agentTools.includes('create_state_field'));
  const writingTools = registry.listTools('writing').map(item => item.name);
  assert.ok(!writingTools.includes('create_state_field'), '受限建字段不应开放给 writing profile');
});
