const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const proposals = require('../server/domain/proposals');
const backfill = require('../server/domain/backfill');
const stateAudit = require('../server/domain/stateAudit');
const registry = require('../server/tools/registry');
const { executeTool } = require('../server/tools/executor');
const { revision } = require('../server/evidence/draftLexical');

function createBook(title) {
  // 体检已快照化（2026-09-10）：测试直接做 SQL 手术（改投影值等）不总落在
  // 数据指纹上，每个用例先清缓存，模拟新进程的即时重算语义。
  stateAudit.clearAuditCache();
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}
function addVolume(bookId, title, sort) {
  return db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, ?)', [bookId, title, sort]).lastInsertRowid;
}
function addChapter(bookId, { title, content, locked, sort_order, volume_id }) {
  return db.run(
    'INSERT INTO chapters (book_id, title, content, locked, sort_order, volume_id) VALUES (?, ?, ?, ?, ?, ?)',
    [bookId, title, content, locked ? 1 : 0, sort_order, volume_id == null ? null : volume_id]
  ).lastInsertRowid;
}
// 提交一个状态事件（省略 old_value → 跳过 STALE 校验，可重复更新同字段；默认 origin=manual 不产 stale_evidence 噪声）
function setState(bookId, charId, fieldKey, value, chapterId) {
  return ledger.commitEvent(bookId, {
    title: `${fieldKey}→${value}`,
    chapter_id: chapterId,
    changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: fieldKey, new_value: value }],
  }).event;
}
function seedProposal(bookId, charId, fieldKey, value, title) {
  return proposals.createProposal(bookId, {
    title,
    source_type: 'manual',
    created_by: 'agent',
    changes: [{ change_kind: 'character_state', subject_ref: String(charId), field_key: fieldKey, new_value: value }],
  });
}
const nowIso = () => new Date().toISOString();
// 直接插入一条投影行。造无效引用需临时关闭外键：
// db.save() 里的 db.export() 会重置 PRAGMA foreign_keys，修正后外键已真实生效，
// 指向不存在人物的 INSERT 会被外键拦下，而审计逻辑本身正是为了发现
// 外键失效期间已积累的历史孤儿行，所以测试需自己造出这种脏数据。
function insertProjection(bookId, charId, fieldKey, valueJson, eventId) {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.run(
      `INSERT INTO character_state_values
         (book_id, character_id, field_key, value_json, source_event_id, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bookId, charId, fieldKey, valueJson, eventId, eventId, nowIso()]
    );
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

// 健康台账：投影与叙事序重放一致，无投影完整性问题
test('健康台账：投影与叙事重放一致，投影完整性零问题', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('健康台账');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  setState(bookId, lin, 'location', '灰雁号');
  setState(bookId, lin, 'health', '轻伤');

  const res = stateAudit.auditCharacterStates(bookId, {
    issue_types: ['projection_mismatch', 'invalid_ref', 'stale_last_event'],
  });
  assert.equal(res.summary.total, 0);
  assert.equal(res.items.length, 0);
});

// 投影完整性：值漂移 / 缺失 / 残留三种 reason 都能定位
test('projection_mismatch：值漂移、缺失、残留分别报出并可定位', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('投影漂移');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;

  setState(bookId, lin, 'location', '灰雁号');
  db.run(
    `UPDATE character_state_values SET value_json = '"漂移"'
     WHERE book_id = ? AND character_id = ? AND field_key = 'location'`,
    [bookId, lin]
  );
  setState(bookId, lin, 'goal', '复仇');
  db.run(
    `DELETE FROM character_state_values
     WHERE book_id = ? AND character_id = ? AND field_key = 'goal'`,
    [bookId, lin]
  );
  const someEventId = db.get('SELECT id FROM story_events WHERE book_id = ? LIMIT 1', [bookId]).id;
  insertProjection(bookId, lin, 'camp', '"幽灵阵营"', someEventId);

  const res = stateAudit.auditCharacterStates(bookId, { issue_types: ['projection_mismatch'] });
  assert.equal(res.summary.by_type.projection_mismatch, 3);
  const reasons = res.items.map(item => item.details.reason).sort();
  assert.deepEqual(reasons, ['missing', 'orphan_value', 'value']);
  const drift = res.items.find(item => item.details.reason === 'value');
  assert.equal(drift.character_id, lin);
  assert.equal(drift.field_key, 'location');
  assert.equal(drift.details.expected, '灰雁号');
  assert.equal(drift.details.actual, '漂移');
});

// 投影值正确但 last_event_id 非叙事序最末有效事件
test('stale_last_event：值一致但 last_event_id 落后于叙事最末事件', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('末事件落后');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;

  const e1 = setState(bookId, lin, 'location', 'A');
  const e2 = setState(bookId, lin, 'location', 'B');
  // 保留正确值 B，但把 last_event_id 篡改为更早的 e1
  db.run(
    `UPDATE character_state_values SET last_event_id = ?
     WHERE book_id = ? AND character_id = ? AND field_key = 'location'`,
    [e1.id, bookId, lin]
  );

  const res = stateAudit.auditCharacterStates(bookId, { issue_types: ['stale_last_event'] });
  assert.equal(res.summary.by_type.stale_last_event, 1);
  assert.equal(res.items[0].severity, 'high');
  assert.equal(res.items[0].details.expected_event_id, e2.id);
  assert.equal(res.items[0].details.actual_event_id, e1.id);
});

// 引用完整性：投影指向不存在的人物 / 未定义字段
test('invalid_ref：投影指向不存在人物或未定义字段', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('无效引用');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const e = setState(bookId, lin, 'location', 'A');

  insertProjection(bookId, 999999, 'goal', '"越权目标"', e.id); // 不存在的人物
  insertProjection(bookId, lin, 'not_a_field', '"幽灵字段"', e.id); // 未定义字段

  const res = stateAudit.auditCharacterStates(bookId, { issue_types: ['invalid_ref'] });
  assert.equal(res.summary.by_type.invalid_ref, 2);
  const reasons = res.items.map(item => item.details.reason).sort();
  assert.deepEqual(reasons, ['orphan_character', 'unknown_field']);
});

// 抽取覆盖：定稿章当前修订无成功抽取记录 → gap；补成功记录后消失
test('extraction_gap：定稿章无成功抽取记录报出，补记录后消失', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('抽取覆盖');
  const v1 = addVolume(bookId, '第一卷', 1);
  const c1 = addChapter(bookId, { title: '第一章', content: '林野登船。', locked: true, sort_order: 1, volume_id: v1 });

  let res = stateAudit.auditCharacterStates(bookId, { issue_types: ['extraction_gap'] });
  assert.equal(res.summary.by_type.extraction_gap, 1);
  assert.equal(res.items[0].chapter_id, c1);
  assert.equal(res.items[0].severity, 'medium');

  backfill.recordExtractionRun(bookId, c1, revision('林野登船。'), 'history_backfill', 'bf_test', { status: 'success', proposal_count: 1 });
  res = stateAudit.auditCharacterStates(bookId, { issue_types: ['extraction_gap'] });
  assert.equal(res.summary.total, 0);
});

// 冲突候选：同角色同字段多条互斥（new_value 不同）待审提案
test('conflicting_proposals：同角色同字段多条互斥待审提案', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('互斥提案');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  seedProposal(bookId, lin, 'health', '轻伤', '提案甲');
  seedProposal(bookId, lin, 'health', '重伤', '提案乙');

  const res = stateAudit.auditCharacterStates(bookId, { issue_types: ['conflicting_proposals'] });
  assert.equal(res.summary.by_type.conflicting_proposals, 1);
  assert.equal(res.items[0].character_id, lin);
  assert.equal(res.items[0].field_key, 'health');
  assert.equal(res.items[0].severity, 'medium');
  assert.equal(res.items[0].details.proposal_ids.length, 2);
});

// 新鲜度弱提示：角色在「最后更新章」之后的定稿章仍出现 → 低 severity candidate（非必然陈旧）
test('freshness_candidate：角色在更晚定稿章出现，仅报低 severity 弱提示', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('新鲜度');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const v1 = addVolume(bookId, '第一卷', 1);
  const c1 = addChapter(bookId, { title: '第一章', content: '林野登船。', locked: true, sort_order: 1, volume_id: v1 });
  const c2 = addChapter(bookId, { title: '第二章', content: '林野抵达彼岸。', locked: true, sort_order: 2, volume_id: v1 });
  setState(bookId, lin, 'location', '船上', c1);
  // 消除抽取覆盖噪声，聚焦新鲜度
  backfill.recordExtractionRun(bookId, c1, revision('林野登船。'), 'history_backfill', 'bf_t', { status: 'success' });
  backfill.recordExtractionRun(bookId, c2, revision('林野抵达彼岸。'), 'history_backfill', 'bf_t', { status: 'success' });

  const res = stateAudit.auditCharacterStates(bookId, { issue_types: ['freshness_candidate'] });
  assert.equal(res.summary.by_type.freshness_candidate, 1);
  assert.equal(res.items[0].severity, 'low');
  assert.equal(res.items[0].character_id, lin);
  assert.equal(res.items[0].details.last_chapter_pos, 0);
  assert.equal(res.items[0].details.later_appearance_pos, 1);
});

// 过滤（issue_types/character_ids/field_keys/min_severity）+ 分页（limit/cursor）+ 摘要计数
test('过滤、分页与摘要计数协同工作', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('过滤分页');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏晚' }).character.id;

  setState(bookId, lin, 'location', 'A');
  db.run(`UPDATE character_state_values SET value_json = '"漂移"' WHERE book_id = ? AND character_id = ? AND field_key = 'location'`, [bookId, lin]);
  setState(bookId, su, 'location', 'B');
  db.run(`UPDATE character_state_values SET value_json = '"漂移2"' WHERE book_id = ? AND character_id = ? AND field_key = 'location'`, [bookId, su]);
  seedProposal(bookId, lin, 'health', '轻伤', '提案甲');
  seedProposal(bookId, lin, 'health', '重伤', '提案乙');
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '正文。', locked: true, sort_order: 1, volume_id: v1 });

  const all = stateAudit.auditCharacterStates(bookId);
  assert.equal(all.summary.total, all.summary.scanned); // 无过滤时二者相等
  assert.ok(all.summary.by_type.projection_mismatch >= 2);
  assert.equal(all.summary.by_type.conflicting_proposals, 1);
  assert.equal(all.summary.by_type.extraction_gap, 1);

  // 按角色过滤：extraction_gap（character_id=null）被排除，仅留该角色相关
  const linOnly = stateAudit.auditCharacterStates(bookId, { character_ids: [lin] });
  assert.ok(linOnly.items.every(item => item.character_id === lin));
  assert.ok(linOnly.summary.total < all.summary.total);

  // 按类型过滤
  const conflicts = stateAudit.auditCharacterStates(bookId, { issue_types: ['conflicting_proposals'] });
  assert.ok(conflicts.items.every(item => item.type === 'conflicting_proposals'));

  // 按字段过滤：extraction_gap（field_key=null）与 health 冲突被排除
  const locationOnly = stateAudit.auditCharacterStates(bookId, { field_keys: ['location'] });
  assert.ok(locationOnly.items.every(item => item.field_key === 'location'));

  // 按最低严重度过滤：只留 high
  const high = stateAudit.auditCharacterStates(bookId, { min_severity: 'high' });
  assert.ok(high.items.every(item => item.severity === 'high'));
  assert.equal(high.summary.by_severity.medium, 0);
  assert.equal(high.summary.by_severity.low, 0);
  assert.equal(high.summary.scanned, all.summary.scanned); // scanned 恒为全量采集数
  assert.ok(high.summary.total < all.summary.total);

  // 分页：limit=2，两页无重叠，summary.total 恒为过滤后全量
  const page1 = stateAudit.auditCharacterStates(bookId, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.limit, 2);
  assert.equal(page1.cursor, 0);
  assert.ok(page1.next_cursor != null);
  assert.equal(page1.truncated, true);
  assert.equal(page1.summary.total, all.summary.total);
  const page2 = stateAudit.auditCharacterStates(bookId, { limit: 2, cursor: page1.next_cursor });
  assert.equal(page2.cursor, page1.next_cursor);
  const key = item => `${item.type}:${item.character_id}:${item.field_key}:${item.chapter_id}:${item.event_id}`;
  const seen = new Set(page1.items.map(key));
  assert.ok(page2.items.every(item => !seen.has(key(item))));
});

// 工具注册边界 + 输出预算降级（大量 issue 时逐级降级，JSON 不被 3000 上限截断损坏）
test('audit_character_states 工具：只读免确认、仅 agent profile、输出降级且在预算内', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('工具预算');
  const v1 = addVolume(bookId, '第一卷', 1);
  for (let i = 1; i <= 50; i += 1) {
    addChapter(bookId, { title: `第${i}章`, content: `正文${i}。`, locked: true, sort_order: i, volume_id: v1 });
  }
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  // limit=50：即便精简掉 details 仍超预算 → 触发对半裁剪，确保 JSON 落在工具结果预算内
  const result = await executeTool(context, 'audit_character_states', { limit: 50 });
  // summary 始终携带全量计数（即使明细被裁剪）
  assert.equal(result.summary.total, 50);
  assert.equal(result.summary.by_type.extraction_gap, 50);
  // 输出必须落在工具结果预算内，避免被 capToolResult 裸切损坏 JSON
  const size = JSON.stringify(result).length;
  assert.ok(size <= 3000, `输出超预算：${size}`);
  // 触发降级：明细精简掉 details，条数被对半裁剪（< 请求的 50），并给出续翻游标
  assert.ok(result.items.length >= 1 && result.items.length < 50);
  assert.ok(result.items.every(item => !('details' in item)));
  assert.equal(result.truncated, true);
  assert.ok(result.next_cursor != null);
});

// 注册边界：只读免确认、capability=ledger.audit、在 agent 不在 writing
test('audit_character_states 注册边界：只读免确认、仅 agent profile', () => {
  const tool = registry.descriptor('audit_character_states');
  assert.ok(tool, '应已注册');
  assert.equal(tool.confirmation, 'none');
  assert.equal(tool.mutation, 'read');
  assert.equal(tool.capability, 'ledger.audit');

  const agentTools = registry.listTools('agent').map(item => item.name);
  assert.ok(agentTools.includes('audit_character_states'));
  const writingTools = registry.listTools('writing').map(item => item.name);
  assert.ok(!writingTools.includes('audit_character_states'));
});
