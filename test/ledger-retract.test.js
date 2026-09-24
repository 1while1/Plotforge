const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');
const registry = require('../server/tools/registry');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

// 事件撤销入口（方向报告 1.6）：retractEvent 内核 + 路由（D1-08）+ 本批补齐的
// Agent 工具与台账工作台入口。工具走确认卡；路由供作者界面直调，同一 append-only 语义。

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

function commitInjuryEvent(bookId, characterId) {
  return ledger.commitEvent(bookId, {
    title: '夺回灰雁号密钥',
    importance: 'high',
    changes: [
      { change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '轻伤' },
    ],
  });
}

// 工具确认闭环：首次返回 confirmation_required（附撤销快照），带 confirmationId 再调才落地
async function confirmRetract(context, args) {
  const conf = await executeTool(context, 'retract_event', args);
  assert.equal(conf.status, 'confirmation_required');
  const result = await executeTool(context, 'retract_event', args, conf.confirmation.id);
  return { conf, result };
}

const baseContext = bookId => ({ profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' });

test.beforeEach(() => actionStore.clear());

// ---------------- 工具面：确认卡 → 确认 → 退出有效重放 ----------------
test('retract_event 工具：确认卡展示撤销快照，确认后原事件退出有效重放且投影重建', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('工具撤销书');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const event = commitInjuryEvent(bookId, lin).event;

  // 工具在 agent profile 注册可达
  assert.ok(registry.listTools('agent').some(tool => tool.name === 'retract_event'),
    'retract_event 应注册在 agent profile');

  const { conf } = await confirmRetract(baseContext(bookId), {
    event_id: event.id,
    reason: '与正文不符，系误抽取',
  });

  // 确认卡快照：作者能独立核对待撤销的事件与理由
  const preview = conf.confirmation.preview;
  assert.equal(preview.action, 'retract_event');
  assert.equal(preview.event_id, event.id);
  assert.equal(preview.event_title, '夺回灰雁号密钥');
  assert.equal(preview.change_count, 1);
  assert.equal(preview.reason, '与正文不符，系误抽取');

  // 原事件被 retraction 取代，状态变化不再生效（health 回到 null）
  const retracted = ledger.getEvent(bookId, event.id);
  assert.ok(retracted.superseded_by_event_id, '原事件应标记被取代');
  const health = ledger.getCurrentStates(bookId, lin).find(item => item.field_key === 'health');
  assert.equal(health.value, null, '撤销后 health 应回到未设置');

  // retraction 事件落在时间线（append-only 留档），标题带「撤销：」前缀
  const timeline = ledger.getTimelinePage(bookId, {});
  const mark = timeline.items.find(item => item.id === retracted.superseded_by_event_id);
  assert.ok(mark, '撤销事件应在时间线可见');
  assert.equal(mark.title, '撤销：夺回灰雁号密钥');
  assert.equal(mark.supersedes_event_id, event.id);
  assert.equal(mark.changes.length, 0, '撤销事件零 changes');
});

// ---------------- 工具校验：确认前拦截 ----------------
test('retract_event 校验：缺 reason 拒绝（400），事件不存在在确认前暴露（404）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('工具校验书');
  const context = baseContext(bookId);

  await assert.rejects(
    executeTool(context, 'retract_event', { event_id: 1, reason: '  ' }),
    err => err.code === 'VALIDATION_ERROR' && err.status === 400,
    '缺 reason 应在确认前以 400 拒绝'
  );

  await assert.rejects(
    executeTool(context, 'retract_event', { event_id: 99999, reason: '理由充分' }),
    err => err.code === 'EVENT_NOT_FOUND' && err.status === 404,
    '事件不存在应在确认前以 404 暴露，不产生确认卡'
  );
});

// ---------------- 路由面：台账工作台人工入口 ----------------
test('retraction 路由：作者直调撤销成功，重复撤销 409，事件不存在 404', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook('路由撤销书');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const event = commitInjuryEvent(bookId, lin).event;
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const r1 = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/events/${event.id}/retraction`, { reason: '与正文不符' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.retracted_event_id, event.id);

  // 撤销生效：原事件被取代
  assert.ok(ledger.getEvent(bookId, event.id).superseded_by_event_id);

  const r2 = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/events/${event.id}/retraction`, { reason: '再撤一次' });
  assert.equal(r2.status, 409, '已被修正或撤销的事件不可重复撤销');
  assert.equal(r2.body.error.code, 'EVENT_ALREADY_SUPERSEDED');

  const r3 = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/events/99999/retraction`, { reason: 'x' });
  assert.equal(r3.status, 404);
  assert.equal(r3.body.error.code, 'EVENT_NOT_FOUND');
});
