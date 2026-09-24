const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const backfill = require('../server/domain/backfill');
const registry = require('../server/tools/registry');
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
async function waitStop(bookId, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const s = backfill.getStatus(bookId);
    if (!s.running) return s;
    if (Date.now() - start > timeoutMs) throw new Error('回填未及时停止');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 确认闭环：首次返回 confirmation_required，带 confirmationId 再执行
async function confirmFlow(context, name, args) {
  const conf = await executeTool(context, name, args);
  assert.equal(conf.status, 'confirmation_required');
  const result = await executeTool(context, name, args, conf.confirmation.id);
  return { conf, result };
}

test.beforeEach(() => actionStore.clear());

// P5：start_ledger_backfill 走确认闭环并【立即返回 job_id】，不在同步调用里等待（用无定稿章的书避免真实 LLM 调用）
test('start_ledger_backfill 工具：确认后立即返回 job_id，不等待后台完成', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('回填启动');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  const { result } = await confirmFlow(context, 'start_ledger_backfill', {});
  assert.equal(result.started, true);
  assert.match(result.job_id, /^bf_/);
  assert.equal(result.total, 0); // 无定稿章 → 立即 done，未触发任何 LLM 调用
  assert.match(result.message, /get_ledger_backfill_status/);
});

// get_ledger_backfill_status 是只读工具（无需确认），未知 job_id 返回 unknown
test('get_ledger_backfill_status 工具：只读免确认，未知 job_id → phase=unknown', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('回填查询');
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', actor: 'author' };

  const status = await executeTool(context, 'get_ledger_backfill_status', { job_id: 'bf_does_not_exist' });
  assert.equal(status.phase, 'unknown');
  assert.equal(status.running, false);
});

// 重启语义：内存无任务但持久化有抽取记录 → lost（汇总记录）；完全无痕迹 → unknown；绝不伪装 idle
test('重启后按 job_id 查询：有持久化记录返回 lost，无记录返回 unknown', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('重启语义');
  const v1 = addVolume(bookId, '第一卷', 1);
  const c1 = addChapter(bookId, { title: '第一章', content: '正文。', locked: true, sort_order: 1, volume_id: v1 });

  // 模拟「曾运行过、进程已重启」：仅有 chapter_extraction_runs 持久化痕迹，内存 jobs 无此 job_id
  backfill.recordExtractionRun(bookId, c1, 'hash_a', 'history_backfill', 'bf_lostjob', { status: 'success', proposal_count: 2 });

  const lost = backfill.getStatus(bookId, 'bf_lostjob');
  assert.equal(lost.phase, 'lost');
  assert.equal(lost.running, false);
  assert.equal(lost.created, 2);
  assert.equal(lost.runs_by_status.success, 1);

  const unknown = backfill.getStatus(bookId, 'bf_neverseen');
  assert.equal(unknown.phase, 'unknown');
});

// 幂等：同章同正文修订第二次回填整章跳过、不产重复提案；force=true 绕过跳过重抽
test('chapter_extraction_runs 幂等：二次回填整章跳过，force 强制重抽', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('回填幂等');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '林野登上灰雁号。', locked: true, sort_order: 1, volume_id: v1 });
  const mockModel = async () => ({
    content: JSON.stringify({
      proposals: [{ title: '林野动身', source_quote: '林野登上灰雁号。', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', old_value: null, new_value: '灰雁号' }] }],
    }),
  });

  backfill.startBackfill(bookId, { modelClient: mockModel });
  const first = await waitStop(bookId);
  assert.equal(first.created, 1);
  assert.equal(first.skipped_chapters, 0);
  const runs = db.all("SELECT * FROM chapter_extraction_runs WHERE book_id = ? AND source_type = 'history_backfill'", [bookId]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'success');
  assert.equal(runs[0].job_id, first.job_id);
  const pendingAfterFirst = db.all("SELECT id FROM event_proposals WHERE book_id = ? AND status = 'pending'", [bookId]).length;
  assert.equal(pendingAfterFirst, 1);

  // 第二次：正文未变、已有 success 记录 → 整章跳过，不再产提案
  backfill.startBackfill(bookId, { modelClient: mockModel });
  const second = await waitStop(bookId);
  assert.equal(second.skipped_chapters, 1);
  assert.equal(second.created, 0);
  assert.equal(db.all("SELECT id FROM event_proposals WHERE book_id = ? AND status = 'pending'", [bookId]).length, pendingAfterFirst);

  // force：绕过整章跳过重新抽取（提案去重仍防止重复入库）
  backfill.startBackfill(bookId, { modelClient: mockModel, force: true });
  const third = await waitStop(bookId);
  assert.equal(third.skipped_chapters, 0);
  assert.equal(db.all("SELECT id FROM event_proposals WHERE book_id = ? AND status = 'pending'", [bookId]).length, pendingAfterFirst);
});

// AbortController：cancelBackfill 触发后台取消，任务在下一章之间停下，phase=aborted
test('cancelBackfill 后台取消：AbortController 生效，未处理完全部章节', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = createBook('回填取消');
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '正文一。', locked: true, sort_order: 1, volume_id: v1 });
  addChapter(bookId, { title: '第二章', content: '正文二。', locked: true, sort_order: 2, volume_id: v1 });
  addChapter(bookId, { title: '第三章', content: '正文三。', locked: true, sort_order: 3, volume_id: v1 });

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slowModel = async () => { await gate; return { content: JSON.stringify({ proposals: [] }) }; };

  const started = backfill.startBackfill(bookId, { modelClient: slowModel });
  assert.equal(started.started, true);
  assert.equal(started.status.running, true);

  const cancel = backfill.cancelBackfill(bookId);
  assert.equal(cancel.cancelled, true);
  release();

  const status = await waitStop(bookId);
  assert.equal(status.phase, 'aborted');
  assert.equal(status.processed, 1); // 第一章在取消前已进入抽取，完成后于第二章边界停下
  assert.ok(status.processed < status.total);
});

// 注册边界：start=写需确认、status=读免确认，均仅 agent profile
test('两工具注册边界：写需确认/读免确认、仅 agent profile、capability=ledger.backfill', () => {
  const start = registry.descriptor('start_ledger_backfill');
  assert.equal(start.confirmation, 'required');
  assert.equal(start.mutation, 'write');
  assert.equal(start.capability, 'ledger.backfill');
  const status = registry.descriptor('get_ledger_backfill_status');
  assert.equal(status.confirmation, 'none');
  assert.equal(status.mutation, 'read');
  assert.equal(status.capability, 'ledger.backfill');

  const agentTools = registry.listTools('agent').map(item => item.name);
  assert.ok(agentTools.includes('start_ledger_backfill'));
  assert.ok(agentTools.includes('get_ledger_backfill_status'));
  const writingTools = registry.listTools('writing').map(item => item.name);
  assert.ok(!writingTools.includes('start_ledger_backfill'));
  assert.ok(!writingTools.includes('get_ledger_backfill_status'));
});
