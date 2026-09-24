const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const backfill = require('../server/domain/backfill');

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
async function waitDone(bookId, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const s = backfill.getStatus(bookId);
    if (s.phase === 'done' && !s.running) return s;
    if (Date.now() - start > timeoutMs) throw new Error('回填超时未完成');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('targetChapters 只选已定稿且有正文的章节，按卷序排列并支持收窄', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('回填范围');
  const v1 = addVolume(bookId, '第一卷', 1);
  const v2 = addVolume(bookId, '第二卷', 2);
  const c11 = addChapter(bookId, { title: 'v1c1', content: '正文一', locked: true, sort_order: 1, volume_id: v1 });
  const c12 = addChapter(bookId, { title: 'v1c2', content: '正文二', locked: true, sort_order: 2, volume_id: v1 });
  const c21 = addChapter(bookId, { title: 'v2c1', content: '正文三', locked: true, sort_order: 1, volume_id: v2 });
  addChapter(bookId, { title: '草稿', content: '未定稿正文', locked: false, sort_order: 3, volume_id: v1 }); // 未定稿 → 排除
  addChapter(bookId, { title: '空章', content: '   ', locked: true, sort_order: 4, volume_id: v1 });       // 定稿但空 → 排除

  assert.deepEqual(backfill.targetChapters(bookId), [c11, c12, c21]);
  assert.deepEqual(backfill.targetChapters(bookId, { limit: 2 }), [c11, c12]);
  assert.deepEqual(backfill.targetChapters(bookId, { chapterIds: [c21] }), [c21]);
});

test('一键回填生成 history_backfill 待审提案、跳过已入库字段、绝不直接写正典', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('回填正典');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const su = characters.createCharacter(bookId, { name: '苏婷' }).character.id;
  const v1 = addVolume(bookId, '第一卷', 1);
  const c11 = addChapter(bookId, { title: '第一章', content: '林野登上灰雁号。', locked: true, sort_order: 1, volume_id: v1 });
  const c12 = addChapter(bookId, { title: '第二章', content: '苏婷立誓复仇。', locked: true, sort_order: 2, volume_id: v1 });

  // 预置一条正典事件：c11 的林野 location 已入库 → 回填 c11 时应跳过该字段
  ledger.commitEvent(bookId, {
    title: '既有正典',
    chapter_id: c11,
    changes: [{ change_kind: 'character_state', subject_ref: lin, field_key: 'location', old_value: null, new_value: '旧地点' }],
  });
  const eventsBefore = db.get('SELECT COUNT(*) AS n FROM story_events').n;

  assert.equal(backfill.isChangeCanonized(bookId, c11, { change_kind: 'character_state', subject_ref: lin, field_key: 'location' }), true);
  assert.equal(backfill.isChangeCanonized(bookId, c12, { change_kind: 'character_state', subject_ref: lin, field_key: 'location' }), false);
  assert.equal(backfill.isChangeCanonized(bookId, c11, { change_kind: 'relation', subject_ref: lin, field_key: 'relation' }), false);

  let seenMessages = null;
  const mockModel = async messages => {
    seenMessages = messages;
    return {
      content: JSON.stringify({
        proposals: [
          { title: '林野动身', summary: '位置变化', source_quote: '林野登上灰雁号。', confidence: 0.9, changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', old_value: null, new_value: '灰雁号' }] },
          { title: '苏婷立誓', summary: '目标变化', source_quote: '苏婷立誓复仇。', confidence: 0.9, changes: [{ change_kind: 'character_state', subject_ref: String(su), field_key: 'goal', old_value: null, new_value: '复仇' }] },
        ],
      }),
    };
  };

  const started = backfill.startBackfill(bookId, { modelClient: mockModel });
  assert.equal(started.started, true);
  const status = await waitDone(bookId);

  // c11：林野 location 已入库被跳过 → 只剩苏婷 goal 1 条；c12：两条都新 → 2 条
  assert.equal(status.total, 2);
  assert.equal(status.processed, 2);
  assert.equal(status.created, 3);
  assert.equal(status.skipped_changes, 1);
  assert.equal(status.chapters_hit, 2);

  const pending = db.all("SELECT * FROM event_proposals WHERE book_id = ? AND status = 'pending'", [bookId]);
  assert.equal(pending.length, 3);
  assert.ok(pending.every(p => p.source_type === 'history_backfill'));

  // 抽取提示词必须带上人物表（id↔姓名），否则 subject_ref 落不到真实人物
  const userPayload = JSON.parse(seenMessages[1].content);
  assert.ok(Array.isArray(userPayload['人物表']));
  assert.ok(userPayload['人物表'].some(c => c.name === '林野' && c.id === lin));

  // 回填只产提案，绝不直接写正典
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, eventsBefore);
});

test('接受回填提案时 old_value 与当前投影不一致也能采纳；普通来源提案仍被一致性检查阻断', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const proposals = require('../server/domain/proposals');
  const bookId = createBook('回填采纳冲突');
  const lin = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const v1 = addVolume(bookId, '第一卷', 1);
  const c11 = addChapter(bookId, { title: '第一章', content: '林野登上灰雁号。', locked: true, sort_order: 1, volume_id: v1 });

  // 预置正典：location 已是「旧地点」
  ledger.commitEvent(bookId, {
    title: '既有正典',
    chapter_id: c11,
    changes: [{ change_kind: 'character_state', subject_ref: lin, field_key: 'location', old_value: null, new_value: '旧地点' }],
  });

  // 回填提案：LLM 猜的 old_value「猫咖」与当前投影「旧地点」不一致
  const backfillProposal = proposals.createProposal(bookId, {
    title: '林野改换地点', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', old_value: '猫咖', new_value: '灰雁号' }],
    source_type: 'history_backfill', chapter_id: c11,
  });
  const accepted = await proposals.acceptProposal(bookId, backfillProposal.id, {});
  assert.equal(accepted.proposal.status, 'accepted');
  const projAfterAccept = db.get('SELECT value_json FROM character_state_values WHERE book_id = ? AND character_id = ? AND field_key = ?', [bookId, lin, 'location']);
  assert.equal(JSON.parse(projAfterAccept.value_json), '灰雁号');

  // 普通来源（章总结）提案：同样冲突应被 STALE_OLD_VALUE 阻断，保护不被静默覆盖
  const summaryProposal = proposals.createProposal(bookId, {
    title: '林野再度移动', changes: [{ change_kind: 'character_state', subject_ref: String(lin), field_key: 'location', old_value: '猫咖', new_value: '海港' }],
    source_type: 'chapter_summary', chapter_id: c11,
  });
  await assert.rejects(
    async () => { proposals.acceptProposal(bookId, summaryProposal.id, {}); },
    err => err.code === 'STALE_OLD_VALUE'
  );
  const projAfterReject = db.get('SELECT value_json FROM character_state_values WHERE book_id = ? AND character_id = ? AND field_key = ?', [bookId, lin, 'location']);
  assert.equal(JSON.parse(projAfterReject.value_json), '灰雁号');
});

test('回填进行中再次触发返回 busy，不并发重跑', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('回填并发');
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '正文。', locked: true, sort_order: 1, volume_id: v1 });

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slowModel = async () => { await gate; return { content: JSON.stringify({ proposals: [] }) }; };

  const first = backfill.startBackfill(bookId, { modelClient: slowModel });
  assert.equal(first.started, true);
  assert.equal(first.status.running, true);

  const second = backfill.startBackfill(bookId, { modelClient: slowModel });
  assert.equal(second.started, false);
  assert.equal(second.reason, 'busy');

  release();
  await waitDone(bookId);
  assert.equal(backfill.getStatus(bookId).phase, 'done');
});

// ---------- 任务状态落库 + 断点续跑（方向报告 3.1 第二部分） ----------

test('任务进度逐章落库；完成后按 job_id 从表还原视图（模拟重启后查询）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('落库进度');
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '林野北上。', locked: true, sort_order: 1, volume_id: v1 });
  addChapter(bookId, { title: '第二章', content: '冻港遇袭。', locked: true, sort_order: 2, volume_id: v1 });

  // 门闩卡在两章之间不行（mock 按章调用），改为直查 DB：任务启动即应有 running 行
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const gatedModel = async () => { calls++; if (calls === 1) await gate; return { content: JSON.stringify({ proposals: [] }) }; };

  const started = backfill.startBackfill(bookId, { modelClient: gatedModel });
  assert.equal(started.started, true);
  let row = db.get('SELECT * FROM backfill_jobs WHERE job_id = ?', [started.status.job_id]);
  assert.ok(row, '任务创建即落库');
  assert.equal(row.phase, 'running');
  assert.equal(row.total, 2);

  release();
  const status = await waitDone(bookId);
  row = db.get('SELECT * FROM backfill_jobs WHERE job_id = ?', [status.job_id]);
  assert.equal(row.phase, 'done');
  assert.equal(row.processed, 2);
  assert.equal(row.done_at !== null, true);

  // 按本书查询（UI 轮询路径）：无内存活任务时从表还原最近一次任务（模拟重启后的新进程）
  const book2 = createBook('落库视图书');
  const seededJobId = 'bf_deadbeef00000000';
  db.run(
    `INSERT INTO backfill_jobs (job_id, book_id, phase, total, processed, created, errors, options, started_at, done_at, resume_count)
     VALUES (?, ?, 'interrupted', 5, 5, 2, '[]', '{}', ?, ?, 1)`,
    [seededJobId, book2, '2026-09-10T08:00:00.000Z', '2026-09-10T08:10:00.000Z']
  );
  const view = backfill.getStatus(book2);
  assert.equal(view.job_id, seededJobId);
  assert.equal(view.phase, 'interrupted');
  assert.equal(view.running, false);
  assert.ok(view.message && view.message.includes('重启'), '中断态应带说明');
  const byId = backfill.getStatus(book2, seededJobId);
  assert.equal(byId.phase, 'interrupted');
});

test('resumeInterrupted 自动续跑死在半路的任务一次：同 job_id、跳过已成功章节、计数延续', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('断点续跑');
  const v1 = addVolume(bookId, '第一卷', 1);
  const c1 = addChapter(bookId, { title: '第一章', content: '林野夺船。', locked: true, sort_order: 1, volume_id: v1 });
  const c2 = addChapter(bookId, { title: '第二章', content: '苏婷立誓。', locked: true, sort_order: 2, volume_id: v1 });
  const c3 = addChapter(bookId, { title: '第三章', content: '北境开战。', locked: true, sort_order: 3, volume_id: v1 });

  // 模拟上个进程死在半路：job 行 phase=running、processed=1（c1 已成功抽取，c2 进行中崩掉）
  const jobId = 'bf_crashed01000000';
  const { revision } = require('../server/evidence/draftLexical');
  const c1Row = db.get('SELECT content FROM chapters WHERE id = ?', [c1]);
  backfill.recordExtractionRun(bookId, c1, revision(c1Row.content), 'history_backfill', jobId, { status: 'success', proposal_count: 0 });
  db.run(
    `INSERT INTO backfill_jobs (job_id, book_id, phase, total, processed, created, errors, options, started_at, resume_count)
     VALUES (?, ?, 'running', 3, 1, 0, '[]', '{}', ?, 0)`,
    [jobId, bookId, '2026-09-10T09:00:00.000Z']
  );

  let modelCalls = 0;
  const mockModel = async () => {
    modelCalls++;
    return { content: JSON.stringify({ proposals: [] }) };
  };
  const result = await backfill.resumeInterrupted({ modelClient: mockModel });
  assert.deepEqual(result, { interrupted: 1, resumed: [jobId] });

  const status = await waitDone(bookId);
  assert.equal(status.job_id, jobId, '续跑沿用原 job_id');
  assert.equal(status.phase, 'done');
  assert.equal(status.total, 3);
  // processed = 上次已处理 1 + 本次续跑 2（c1 幂等跳过：无成功记录过滤）
  assert.equal(status.processed, 3);
  assert.equal(modelCalls, 2, '只续跑无成功抽取记录的章节');
  const row = db.get('SELECT phase, resume_count FROM backfill_jobs WHERE job_id = ?', [jobId]);
  assert.equal(row.phase, 'done');
  assert.equal(row.resume_count, 1, '自动续跑只允许一次');
});

test('resumeInterrupted 对已续跑过一次的中断任务不再自动续跑（防崩溃循环）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('续跑上限');
  const v1 = addVolume(bookId, '第一卷', 1);
  addChapter(bookId, { title: '第一章', content: '正文。', locked: true, sort_order: 1, volume_id: v1 });

  const jobId = 'bf_twice000000000';
  db.run(
    `INSERT INTO backfill_jobs (job_id, book_id, phase, total, processed, errors, options, started_at, resume_count)
     VALUES (?, ?, 'running', 1, 0, '[]', '{}', ?, 1)`,
    [jobId, bookId, '2026-09-10T09:30:00.000Z']
  );

  let modelCalled = false;
  const result = await backfill.resumeInterrupted({ modelClient: async () => { modelCalled = true; return { content: JSON.stringify({ proposals: [] }) }; } });
  assert.equal(result.interrupted, 1);
  assert.deepEqual(result.resumed, [], 'resume_count≥1 不再自动续跑');
  assert.equal(modelCalled, false);
  const row = db.get('SELECT phase FROM backfill_jobs WHERE job_id = ?', [jobId]);
  assert.equal(row.phase, 'interrupted');
});
