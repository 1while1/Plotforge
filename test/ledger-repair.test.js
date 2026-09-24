const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const proposals = require('../server/domain/proposals');
const backfill = require('../server/domain/backfill');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');

function createBook(title) {
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
function setState(bookId, charId, fieldKey, value, chapterId) {
  return ledger.commitEvent(bookId, {
    title: `${fieldKey}→${value}`,
    chapter_id: chapterId,
    changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: fieldKey, new_value: value }],
  }).event;
}
function stateOf(bookId, charId, fieldKey) {
  const row = ledger.getCurrentStates(bookId, charId).find(item => item.field_key === fieldKey);
  return row ? row.value : undefined;
}
function auditRows(toolName) {
  return db.all('SELECT * FROM tool_audit_logs WHERE tool_name = ? ORDER BY id', [toolName]);
}
function seedProposal(bookId, charId, value) {
  return proposals.createProposal(bookId, {
    title: '林野状态更新',
    source_type: 'manual',
    created_by: 'agent',
    changes: [{ change_kind: 'character_state', subject_ref: String(charId), field_key: 'health', new_value: value }],
  });
}
async function waitStop(bookId, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const s = backfill.getStatus(bookId);
    if (!s.running) return s;
    if (Date.now() - start > timeoutMs) throw new Error('回填未及时停止');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test.beforeEach(() => actionStore.clear());

// ---- P6-A：append-only retractEvent ----

// 撤销唯一事件：状态变化退出重放，原事件记录保留，撤销事件零 changes 且 supersedes 原事件
test('retractEvent：撤销后状态变化退出重放，原事件 append-only 保留', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('撤销唯一事件');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const e1 = setState(bookId, lin, 'location', '灰雁号');
  assert.equal(stateOf(bookId, lin, 'location'), '灰雁号');

  const before = db.get('SELECT COUNT(*) AS n FROM story_events').n;
  const r = ledger.retractEvent(bookId, e1.id, { reason: '此事件系误记，从未发生' });
  assert.equal(r.retracted_event_id, e1.id);
  assert.equal(r.event.supersedes_event_id, e1.id);
  assert.equal(r.event.changes.length, 0); // 零 changes

  // 状态被撤销：投影不再有 location
  assert.equal(stateOf(bookId, lin, 'location'), null);
  // append-only：原事件仍在库，且被标记为已由撤销事件取代
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, before + 1);
  assert.equal(ledger.getEvent(bookId, e1.id).superseded_by_event_id, r.event.id);
  // 时间线：默认只显示撤销事件（原事件被取代而隐藏）；include_superseded 显示两条
  assert.equal(ledger.getTimeline(bookId).length, 1);
  assert.equal(ledger.getTimeline(bookId, { include_superseded: true }).length, 2);
});

// 撤销较晚事件：投影回退到较早事件的值（重放排除被撤销事件）
test('retractEvent：撤销较晚事件后投影回退到较早事件的值', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('撤销较晚事件');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  setState(bookId, lin, 'location', 'A');
  const e2 = setState(bookId, lin, 'location', 'B');
  assert.equal(stateOf(bookId, lin, 'location'), 'B');

  ledger.retractEvent(bookId, e2.id);
  assert.equal(stateOf(bookId, lin, 'location'), 'A');
});

// 幂等/防重：对已被取代的事件再次撤销 → EVENT_ALREADY_SUPERSEDED
test('retractEvent：对已被取代事件再撤销抛 EVENT_ALREADY_SUPERSEDED', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('重复撤销');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const e1 = setState(bookId, lin, 'location', 'A');
  ledger.retractEvent(bookId, e1.id);
  assert.throws(
    () => ledger.retractEvent(bookId, e1.id),
    err => err.code === 'EVENT_ALREADY_SUPERSEDED'
  );
});

// ---- P6-B：审计增强 ----

// requested→success 分离记录 requested_by（agent，与执行时 source 解耦）/confirmed_by（author）+ args_json + target_revision + result_entity_ids
test('审计增强：requested/success 分离记录发起方与确认方及快照字段', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('审计增强');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, lin, '康复');
  const reqContext = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' };
  const args = { proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision };

  const conf = await executeTool(reqContext, 'review_event_proposal', args);
  assert.equal(conf.status, 'confirmation_required');
  const requested = auditRows('review_event_proposal').find(row => row.status === 'requested');
  assert.ok(requested, '应有 requested 阶段审计行');
  assert.equal(requested.requested_by, 'agent');
  assert.equal(requested.confirmed_by, ''); // 请求阶段尚无确认方
  assert.ok(requested.args_json.includes(String(proposal.id)));

  // 执行阶段用不同 source（模拟确认路由的 agent-confirm），requested_by 仍应固化为 agent
  const execContext = { ...reqContext, source: 'agent-confirm' };
  await executeTool(execContext, 'review_event_proposal', args, conf.confirmation.id);
  const success = auditRows('review_event_proposal').find(row => row.status === 'success');
  assert.ok(success, '应有 success 阶段审计行');
  assert.equal(success.requested_by, 'agent'); // 与执行时 source 解耦
  assert.equal(success.confirmed_by, 'author'); // 作者确认
  assert.equal(success.source, 'agent-confirm');
  assert.equal(success.target_revision, proposal.revision);
  const entityIds = JSON.parse(success.result_entity_ids);
  assert.ok(entityIds.some(id => id.startsWith('event:')));
  assert.ok(entityIds.some(id => id.startsWith('proposal:')));
});

// denied（凭证无效）与 failed（执行失败带 error_details）阶段审计
test('审计增强：凭证无效记 denied，执行失败记 failed + error_details', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('审计失败态');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, lin, '康复');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' };

  // denied：凭证有效但参数被篡改（expected_revision 改变，仍通过 accept 的业务校验）→ authorize 的 argsHash 不匹配
  const confA = await executeTool(context, 'review_event_proposal', { proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision });
  await assert.rejects(
    () => executeTool(context, 'review_event_proposal', { proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision + 1 }, confA.confirmation.id),
    err => err.code === 'INVALID_CONFIRMATION'
  );
  const denied = auditRows('review_event_proposal').find(row => row.status === 'denied');
  assert.ok(denied, '应有 denied 阶段审计行');
  assert.equal(denied.error_code, 'INVALID_CONFIRMATION');
  assert.equal(denied.requested_by, 'agent');

  // failed：确认通过后执行抛 PROPOSAL_VERSION_CONFLICT（expected_revision 不符）
  actionStore.clear();
  const badArgs = { proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision + 5 };
  const confB = await executeTool(context, 'review_event_proposal', badArgs);
  await assert.rejects(
    () => executeTool(context, 'review_event_proposal', badArgs, confB.confirmation.id),
    err => err.code === 'PROPOSAL_VERSION_CONFLICT'
  );
  const failed = auditRows('review_event_proposal').find(row => row.status === 'failed');
  assert.ok(failed, '应有 failed 阶段审计行');
  assert.equal(failed.error_code, 'PROPOSAL_VERSION_CONFLICT');
  assert.equal(failed.confirmed_by, 'author'); // 作者已确认，只是执行失败
  const details = JSON.parse(failed.error_details);
  assert.equal(details.expected_revision, proposal.revision + 5);
});

// 作者拒绝：auditRejection 记 rejected 行，confirmed_by=author、requested_by=agent
test('审计增强：作者拒绝记 rejected 行，分离发起方与确认方', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('审计拒绝');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = seedProposal(bookId, lin, '康复');
  const { auditRejection } = require('../server/tools/executor');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' };

  const conf = await executeTool(context, 'review_event_proposal', { proposal_id: proposal.id, action: 'reject', expected_revision: proposal.revision, review_note: '证据不足' });
  const action = actionStore.get(conf.confirmation.id);
  const rejected = actionStore.reject(action.id, action.sessionId);
  assert.equal(rejected.ok, true);
  auditRejection(action, action.sessionId);

  const row = auditRows('review_event_proposal').find(r => r.status === 'rejected');
  assert.ok(row, '应有 rejected 阶段审计行');
  assert.equal(row.requested_by, 'agent');
  assert.equal(row.confirmed_by, 'author');
  // 提案仍未被驳回（auditRejection 只记审计，不执行工具）
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'pending');
});

// ---- P6-C：回填提案记 job_id + rejectProposalsByJob ----

test('回填提案记 job_id；rejectProposalsByJob 整批驳回该任务 pending 提案', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('回填撤销');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '林野登上灰雁号。', locked: true, sort_order: 1, volume_id: v1 });
  const mockModel = async () => ({
    content: JSON.stringify({
      proposals: [{ title: '林野动身', source_quote: '林野登上灰雁号。', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', new_value: '灰雁号' }] }],
    }),
  });

  const started = backfill.startBackfill(bookId, { modelClient: mockModel });
  const status = await waitStop(bookId);
  assert.equal(status.created, 1);
  const jobId = started.status.job_id;
  assert.match(jobId, /^bf_/);

  // 回填提案带上本次任务 job_id
  const backfillProposal = db.get("SELECT * FROM event_proposals WHERE book_id = ? AND source_type = 'history_backfill'", [bookId]);
  assert.equal(backfillProposal.job_id, jobId);

  // 另一条不同 job_id 的手工提案不受影响
  const manual = proposals.createProposal(bookId, {
    title: '手工提案', source_type: 'manual', created_by: 'author', job_id: '',
    changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'health', new_value: '康复' }],
  });

  const result = proposals.rejectProposalsByJob(bookId, jobId, { review_note: '回跑出错，整批撤销' });
  assert.equal(result.count, 1);
  assert.deepEqual(result.rejected_proposal_ids, [backfillProposal.id]);
  assert.equal(proposals.getProposal(bookId, backfillProposal.id).status, 'rejected');
  assert.equal(proposals.getProposal(bookId, manual.id).status, 'pending'); // 手工提案未被波及
});

// rejectProposalsByJob 只动 pending/stale，不碰已 accepted；空 job_id 报错
test('rejectProposalsByJob：不碰已采纳提案，空 job_id 报 VALIDATION_ERROR', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('批量驳回边界');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const p1 = proposals.createProposal(bookId, { title: '甲', source_type: 'manual', created_by: 'author', job_id: 'bf_x', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', new_value: 'A' }] });
  const p2 = proposals.createProposal(bookId, { title: '乙', source_type: 'manual', created_by: 'author', job_id: 'bf_x', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'health', new_value: '轻伤' }] });
  // 先采纳 p1，使其退出 pending
  proposals.acceptProposal(bookId, p1.id, { actor: 'author' });

  const result = proposals.rejectProposalsByJob(bookId, 'bf_x');
  assert.deepEqual(result.rejected_proposal_ids, [p2.id]); // 仅 p2 被驳回
  assert.equal(proposals.getProposal(bookId, p1.id).status, 'accepted');
  assert.equal(proposals.getProposal(bookId, p2.id).status, 'rejected');

  assert.throws(() => proposals.rejectProposalsByJob(bookId, ''), err => err.code === 'VALIDATION_ERROR');
});
