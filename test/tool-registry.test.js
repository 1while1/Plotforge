const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { listTools, listAllTools, profiles } = require('../server/tools/registry');
const { toOpenAITools } = require('../server/tools/adapters/openai');
const { descriptorSchemas } = require('../server/tools/adapters/ai-sdk');
const { executeTool } = require('../server/tools/executor');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

// 注册表「全部可达」不变量（方向报告 1.10）：每个注册工具必须至少进入一个
// profile 白名单。死工具不是无害的——模型工具目录、审查报告都会被它污染。
test('registry invariant: every registered tool is reachable from at least one profile', () => {
  const union = new Set();
  for (const profile of Object.keys(profiles)) {
    listTools(profile).forEach(tool => union.add(tool.name));
  }
  const dead = listAllTools().map(tool => tool.name).filter(name => !union.has(name));
  assert.deepEqual(dead, [], `不可达死工具：${dead.join(', ')}——删除它们或加入 profile 白名单`);
});

test('profiles resolve to unique registered tools and exclude forbidden capabilities', () => {
  const forbidden = new Set([
    'approve_event_proposal', 'batch_approve_event_proposals',
    'delete_character', 'delete_story_event', 'rebuild_projections',
    'run_migration', 'restore_backup', 'write_story_state', 'update_character',
  ]);
  for (const profile of Object.keys(profiles)) {
    const tools = listTools(profile);
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    for (const tool of tools) {
      assert.equal(tool.scope === 'book' || tool.scope === 'global', true);
      assert.equal(forbidden.has(tool.name), false, `forbidden ${tool.name} in ${profile}`);
      if (tool.mutation !== 'read') assert.equal(tool.confirmation, 'required');
    }
  }
  for (const required of [
    'search_evidence', 'find_characters', 'get_character_context',
    'get_character_relations', 'get_character_timeline', 'get_story_event',
    'get_story_threads', 'get_event_proposals', 'create_character',
    'update_character_profile', 'archive_character', 'propose_story_event',
    'correct_story_event', 'propose_relation_change', 'create_story_thread',
    'update_story_thread', 'update_book_progress',
  ]) {
    assert.ok(listTools('agent').some(tool => tool.name === required), `missing ${required}`);
  }
});

test('OpenAI and AI SDK adapters expose the same canonical schemas', () => {
  for (const profile of ['writing', 'agent', 'character']) {
    const openai = new Map(toOpenAITools(profile).map(tool => [
      tool.function.name, tool.function.parameters,
    ]));
    const ai = new Map(descriptorSchemas(profile).map(item => [item.name, item.schema]));
    assert.deepEqual([...openai.keys()].sort(), [...ai.keys()].sort());
    for (const [name, schema] of openai) assert.deepEqual(schema, ai.get(name), name);
  }
});

test('executor requires exact confirmation before a native mutation and audits success', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('工具');
  const context = {
    profile: 'agent',
    sessionId: 'agent-test',
    bookId,
    source: 'test',
    actor: 'author',
  };
  const args = { name: '林野', role: '主角', intro: '逃亡船长' };
  const pending = await executeTool(context, 'create_character', args);
  assert.equal(pending.status, 'confirmation_required');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM characters WHERE book_id = ?', [bookId]).n, 0);

  await assert.rejects(
    executeTool(context, 'create_character', { ...args, name: '苏晚' }, pending.confirmation.id),
    err => err.code === 'INVALID_CONFIRMATION'
  );
  const result = await executeTool(context, 'create_character', args, pending.confirmation.id);
  assert.equal(result.character.name, '林野');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM characters WHERE book_id = ?', [bookId]).n, 1);
  const audit = db.get("SELECT * FROM tool_audit_logs WHERE tool_name = ? AND status = 'success'", ['create_character']);
  assert.equal(audit.status, 'success');
  assert.equal(audit.book_id, bookId);
});

// 状态字段可见性（2026-09-10 十章实测）：模型提交 propose_story_event 时只能猜 field_key，
// 实测填了不存在的「status」→ 作者采纳时才 400 STATE_FIELD_NOT_FOUND。补只读工具暴露可用字段。
test('list_state_fields 在 writing/agent profile 可达，且是只读工具', () => {
  // 通过 profile 白名单验证可达性（本文件开头的「不可达死工具」不变量已覆盖反向）
  for (const profile of ['writing', 'agent']) {
    const names = toOpenAITools(profile).map(t => t.function.name);
    assert.ok(names.includes('list_state_fields'), `${profile} profile 应包含 list_state_fields`);
  }
  const desc = listAllTools().find(t => t.name === 'list_state_fields');
  assert.ok(desc, '工具应已注册');
  assert.equal(desc.mutation, 'read', '必须是只读工具');
  assert.equal(desc.confirmation, 'none', '只读工具不应需要确认');
});

// S3-05：agent-discuss 只读 profile 不变量——全 read、agent 子集、非空、保有找书与读取能力
test('agent-discuss profile：全部只读且是 agent 子集，保留 list_books/读取能力', () => {
  const discuss = listTools('agent-discuss');
  assert.ok(discuss.length >= 30, '只读工具面非空且保有检索/读取能力');
  assert.ok(discuss.every(tool => tool.mutation === 'read'), 'discuss 不得含写工具');
  const agentNames = new Set(listTools('agent').map(tool => tool.name));
  assert.ok(discuss.every(tool => agentNames.has(tool.name)), 'discuss 是 agent 的只读子集');
  for (const must of ['list_books', 'read_chapter', 'search_evidence', 'get_story_state']) {
    assert.ok(discuss.some(tool => tool.name === must), `discuss 须保留 ${must}`);
  }
  for (const forbidden of ['create_chapter', 'append_chapter', 'set_master_outline', 'create_character', 'propose_story_event']) {
    assert.equal(discuss.some(tool => tool.name === forbidden), false, `discuss 不得含 ${forbidden}`);
  }
});

// S4-01a：受控资源目录工具（list_resources / get_resource_summary）——与 GET /api/resources
// 同源（类型枚举取自同一 catalog），agent 与 agent-discuss 可达、写作与人物 profile 不加载。
// 写作页讨论默认只看本书资料，不打开全局资源面；资源工具本身只读、无确认、全局范围
// （书内类型由参数 bookId 显式限定，跨书一律 404）。
test('资源目录工具：agent/agent-discuss 可达、writing/character 不加载，类型枚举与 catalog 同源', () => {
  const catalog = require('../server/resources/catalog');
  const names = profile => listTools(profile).map(tool => tool.name);
  const resourceTools = ['list_resources', 'get_resource_summary'];

  for (const name of resourceTools) {
    const desc = listAllTools().find(tool => tool.name === name);
    assert.ok(desc, `${name} 必须已注册`);
    assert.equal(desc.mutation, 'read', `${name} 必须是只读工具`);
    assert.equal(desc.confirmation, 'none', `${name} 不得要求确认`);
    assert.equal(desc.capability, 'resources.read');
    assert.equal(desc.scope, 'global');
    assert.deepEqual(desc.inputSchema.properties.type.enum, [...catalog.RESOURCE_TYPES],
      `${name} 的类型枚举必须与 HTTP 路由同源`);
    assert.ok(desc.inputSchema.properties.bookId, `${name} 必须声明 bookId（书内类型显式限定）`);
  }
  for (const profile of ['agent', 'agent-discuss']) {
    assert.ok(names(profile).includes('list_resources'), `${profile} 应可达 list_resources`);
    assert.ok(names(profile).includes('get_resource_summary'), `${profile} 应可达 get_resource_summary`);
  }
  for (const profile of ['writing', 'character']) {
    for (const name of resourceTools) {
      assert.equal(names(profile).includes(name), false, `${profile} 不得加载全局资源工具 ${name}`);
    }
  }
});

// A-4：规划笔记只读工具（list_planning_notes / get_planning_note）——执行体与 /api/planning-notes
// 同源（同一个 listPlanningNotes / getPlanningNote，不写第二份 SQL），与资源目录同款边界：
// 只进 agent 与 agent-discuss 白名单，writing/character 不加载；只读、无确认。
// 笔记库层 status 被 CHECK 锁死在 draft（草稿非事实），本切片不新增任何笔记/交接写工具
// （评估结论：写笔记要每张确认卡且价值边际低；交接采纳必须保持作者手动）。
// 范围行为（本会话/本书、范围外 404、无全库出口）见 test/planning-note-tools.test.js。
test('规划笔记工具：agent/agent-discuss 可达、writing/character 不加载，且只读无确认', () => {
  const names = profile => listTools(profile).map(tool => tool.name);
  const noteTools = ['list_planning_notes', 'get_planning_note'];

  for (const name of noteTools) {
    const desc = listAllTools().find(tool => tool.name === name);
    assert.ok(desc, `${name} 必须已注册`);
    assert.equal(desc.mutation, 'read', `${name} 必须是只读工具`);
    assert.equal(desc.confirmation, 'none', `${name} 不得要求确认`);
    assert.equal(desc.capability, 'notes.read');
    assert.equal(desc.scope, 'global', `${name} 是全局工具（范围由会话绑定或 bookId 限定）`);
  }
  for (const profile of ['agent', 'agent-discuss']) {
    for (const name of noteTools) assert.ok(names(profile).includes(name), `${profile} 应可达 ${name}`);
  }
  for (const profile of ['writing', 'character']) {
    for (const name of noteTools) {
      assert.equal(names(profile).includes(name), false, `${profile} 不得加载笔记工具 ${name}`);
    }
  }
  for (const forbidden of ['draft_planning_note', 'create_planning_note', 'create_handoff', 'accept_handoff']) {
    assert.equal(listAllTools().some(tool => tool.name === forbidden), false,
      `不得新增 ${forbidden}（写笔记/交接写或采纳都必须留在作者手里）`);
  }
});
