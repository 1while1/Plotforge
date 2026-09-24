// A-1（G5 审计 P1-1）：人物提案抽取「在途窗口」的来源守卫 —— 红测四条。
//
// 对应 13 号放行提示词 A-1 节：
//   ① 在途窗口内改稿 → 整批不创建 + 030 墓碑留痕 + 返回值带作废记录（llm-stub 挂起/放行）
//   ② 修复前遗留的旧来源待审提案 → 采纳 409、story_events 零新增、投影不变
//   ③ 对照组：来源未变时照常生成、照常可采纳（守卫不误伤）
//   ④ 回填路径逐章显式失败表示 + 覆盖率缺口可见
//
// 零真实渠道：① 在 fetch 边界挂起真实 llm 调用（端点占位 llm-stub.local、api_key=sk-test-xxx），
// ③④ 注入 modelClient 直接返回内容；另加只放行 stub 与本机的出网守卫，误触发即炸掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const proposals = require('../server/domain/proposals');
const { extractChapterProposals } = require('../server/domain/chapterSummaryProposals');
const { applyChapterMutation } = require('../server/domain/chapterMutations');
const { revision } = require('../server/evidence/draftLexical');
const backfill = require('../server/domain/backfill');
const { installFetchStub, jsonStub, chatPayload, waitUntil } = require('./helpers/llm-stub');

const OLD_CONTENT = '林野登上灰雁号，把扳手塞进背包。';
const NEW_CONTENT = '林野留在了白塔，把扳手交给了守门人。';

async function setupBook(title, content = OLD_CONTENT) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, summary, locked, sort_order) VALUES (?, '第一章', ?, '林野登船。', 1, 1)",
    [bookId, content]
  ).lastInsertRowid;
  return { location, bookId, characterId, chapterId };
}

function candidate(characterId, value = '灰雁号') {
  return {
    title: '林野登船',
    summary: '位置发生变化',
    source_quote: '林野登上灰雁号，把扳手塞进背包。',
    confidence: 0.9,
    changes: [{
      change_kind: 'character_state',
      subject_ref: String(characterId),
      field_key: 'location',
      old_value: null,
      new_value: value,
    }],
  };
}

function currentHash(chapterId) {
  return revision(db.get('SELECT content FROM chapters WHERE id = ?', [Number(chapterId)]).content);
}

// 待审提案里「指纹与当前正文不符」的条数（＝旧来源提案仍在待审的缺口计数）
function pendingWithOutdatedSource(bookId, chapterId) {
  const now = currentHash(chapterId);
  return db.all(
    "SELECT source_revision_hash FROM event_proposals WHERE book_id = ? AND chapter_id = ? AND status = 'pending'",
    [Number(bookId), Number(chapterId)]
  ).filter(row => row.source_revision_hash !== now).length;
}

async function waitBackfillDone(bookId, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const status = backfill.getStatus(bookId);
    if (!status.running && (status.phase === 'done' || status.phase === 'aborted')) return status;
    if (Date.now() - start > timeoutMs) throw new Error('回填超时未完成');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 出网守卫：只放行占位 stub 端点与本机，其它地址立即失败（本切片真实渠道零调用）
function guardOutbound() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^https?:\/\/(llm-stub\.local|127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
      throw new Error(`A-1 单测禁止出网：${String(url).slice(0, 80)}`);
    }
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

test('A-1① 在途窗口：提取期间改稿 → 整批不创建、墓碑留痕、返回值显式作废', async t => {
  const env = await setupBook('在途窗口');
  const stub = installFetchStub();
  const unguard = guardOutbound();
  t.after(() => { unguard(); stub.restore(); cleanup(env.location); });
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local/v1')");
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'agnes-2.5-flash')");

  const book = db.get('SELECT * FROM books WHERE id = ?', [env.bookId]);
  const snapshot = db.get('SELECT * FROM chapters WHERE id = ?', [env.chapterId]); // 生成端 await 之前读到的快照
  let release;
  const gate = new Promise(resolve => {
    release = () => resolve(jsonStub(chatPayload({
      content: JSON.stringify({ proposals: [candidate(env.characterId)] }),
      usage: { prompt_tokens: 1234, completion_tokens: 88 },
    })));
  });
  stub.responders.push(() => gate);

  const inflight = extractChapterProposals(book, snapshot, '林野登船。');
  await waitUntil(() => stub.calls.length === 1); // 模型请求已发出（await 中）
  const edit = applyChapterMutation({
    bookId: env.bookId,
    chapterId: env.chapterId,
    expectedRevision: Number(snapshot.revision),
    patch: { content: NEW_CONTENT },
    reason: 'a1-window-edit',
  });
  assert.equal(edit.changed, true, '窗口内改稿必须真实生效');
  release();
  const result = await inflight;

  // ①1 旧来源提案不得以 pending 落库（修复前实测 1 条 pending、哈希指向旧正文）
  assert.equal(pendingWithOutdatedSource(env.bookId, env.chapterId), 0,
    '在途窗口捕获的旧来源提案不得落库为待审');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM event_proposals WHERE book_id = ?', [env.bookId]).n, 0,
    '来源不一致必须整批不创建');

  // ①2 返回值带显式作废记录（回传通道）
  assert.equal(result.proposals.length, 0);
  assert.equal((result.discarded || []).length, 1, '返回值必须带 discarded 作废记录');
  assert.equal(result.discarded[0].code, 'SOURCE_CHANGED');
  assert.equal(result.discarded[0].chapterId, env.chapterId);
  assert.equal(result.discarded[0].expectedHash, revision(OLD_CONTENT));
  assert.equal(result.discarded[0].currentHash, currentHash(env.chapterId));
  assert.equal(result.discarded[0].candidateCount, 1);

  // ①3 墓碑台账（030 全局表）：时间/书/章/路径/原因码/双哈希/候选数/模型
  const tomb = db.get('SELECT * FROM proposal_discards WHERE book_id = ? ORDER BY id DESC', [env.bookId]);
  assert.ok(tomb, '作废必须留墓碑行');
  assert.equal(tomb.chapter_id, env.chapterId);
  assert.equal(tomb.source_path, 'finalize');
  assert.equal(tomb.reason, 'SOURCE_CHANGED');
  assert.equal(tomb.expected_hash, revision(OLD_CONTENT));
  assert.equal(tomb.current_hash, currentHash(env.chapterId));
  assert.equal(tomb.candidate_count, 1);
  assert.equal(tomb.model, 'agnes-2.5-flash');
  assert.ok(tomb.created_at, '墓碑必须记时间');

  // ①4 llm_calls 互查：被作废的这次 AI 调用本身已在台账留行（时间/模型/用量）
  const call = db.get('SELECT * FROM llm_calls WHERE book_id = ? ORDER BY id DESC', [env.bookId]);
  assert.ok(call, '被作废的调用必须在 llm_calls 留行（可与墓碑互查）');
  assert.equal(call.status, 'ok');
  assert.equal(call.prompt_tokens, 1234);
});

test('A-1② 采纳兜底：修复前遗留的旧来源待审提案被 409 拒绝且不写正典', async t => {
  const env = await setupBook('旧来源哨兵', NEW_CONTENT);
  t.after(() => cleanup(env.location));
  // 模拟修复前落库的 pending 行：指纹指向已被替换的旧正文（无任何过期标记）
  const legacy = proposals.createProposal(env.bookId, {
    title: '旧来源提案',
    summary: '依据已被替换的正文',
    source_type: 'chapter_summary',
    chapter_id: env.chapterId,
    source_revision_hash: revision(OLD_CONTENT),
    created_by: 'extractor',
    created_via: 'chapter_extraction',
    changes: [{
      change_kind: 'character_state',
      subject_ref: String(env.characterId),
      field_key: 'location',
      old_value: null,
      new_value: '灰雁号',
    }],
  });
  assert.equal(legacy.status, 'pending');
  const eventsBefore = db.get('SELECT COUNT(*) AS n FROM story_events').n;

  assert.throws(
    () => proposals.acceptProposal(env.bookId, legacy.id, {}),
    err => err.code === 'SOURCE_CHANGED' && err.status === 409,
    '来源正文哈希不符的提案采纳必须 409 拒绝'
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, eventsBefore, '不写 story_event');
  assert.equal(proposals.getProposal(env.bookId, legacy.id).status, 'pending', '提案保持待审');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM character_state_values WHERE book_id = ?', [env.bookId]).n, 0,
    '不改正典投影'
  );
});

test('A-1③ 对照组：来源未变时提案照常生成、照常可采纳', async t => {
  const env = await setupBook('对照组');
  t.after(() => cleanup(env.location));
  const book = db.get('SELECT * FROM books WHERE id = ?', [env.bookId]);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [env.chapterId]);
  const result = await extractChapterProposals(book, chapter, '林野登船。', async () => ({
    content: JSON.stringify({ proposals: [candidate(env.characterId)] }),
  }));
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, 'pending');
  assert.equal(result.proposals[0].source_revision_hash, revision(OLD_CONTENT), '指纹＝捕获时正文哈希');
  const accepted = proposals.acceptProposal(env.bookId, result.proposals[0].id, {});
  assert.equal(accepted.proposal.status, 'accepted');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 1);
});

test('A-1④ 回填路径：窗口内改稿逐章作废并留显式失败表示', async t => {
  const env = await setupBook('回填作废');
  t.after(() => cleanup(env.location));
  let calls = 0;
  const model = async () => {
    calls += 1;
    // 模型调用期间作者改稿（真实领域入口）
    applyChapterMutation({
      bookId: env.bookId,
      chapterId: env.chapterId,
      expectedRevision: 1,
      patch: { content: NEW_CONTENT },
      reason: 'a1-backfill-window-edit',
    });
    return { content: JSON.stringify({ proposals: [candidate(env.characterId)] }) };
  };
  const started = backfill.startBackfill(env.bookId, { modelClient: model, chapterIds: [env.chapterId] });
  assert.equal(started.started, true);
  const status = await waitBackfillDone(env.bookId);
  assert.equal(calls, 1);
  assert.equal(status.created, 0, '作废批次不得计入创建数');
  assert.equal(pendingWithOutdatedSource(env.bookId, env.chapterId), 0);
  assert.ok(
    status.errors.some(item => String(item).includes('SOURCE_CHANGED') && String(item).includes(String(env.chapterId))),
    '回填必须逐章给出显式作废表示'
  );
  const run = db.get(
    'SELECT status, error, proposal_count FROM chapter_extraction_runs WHERE book_id = ? AND chapter_id = ? ORDER BY id DESC',
    [env.bookId, env.chapterId]
  );
  assert.notEqual(run.status, 'success', '作废不得记为成功抽取（覆盖率缺口可见）');
  assert.match(run.error, /SOURCE_CHANGED/);
  assert.equal(run.proposal_count, 0);
  const tomb = db.get('SELECT * FROM proposal_discards WHERE book_id = ? ORDER BY id DESC', [env.bookId]);
  assert.ok(tomb, '回填作废同样留墓碑');
  assert.equal(tomb.source_path, 'backfill');
  assert.equal(tomb.job_id, status.job_id);
});

test('A-1⑤ 在途窗口内章被回收：同样整批不创建，墓碑记 CHAPTER_MISSING', async t => {
  const env = await setupBook('在途删章');
  t.after(() => cleanup(env.location));
  const book = db.get('SELECT * FROM books WHERE id = ?', [env.bookId]);
  const snapshot = db.get('SELECT * FROM chapters WHERE id = ?', [env.chapterId]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let called = false;
  const model = async () => {
    called = true;
    await gate;
    return { content: JSON.stringify({ proposals: [candidate(env.characterId)] }) };
  };
  const inflight = extractChapterProposals(book, snapshot, '林野登船。', model);
  await waitUntil(() => called, 1000); // 模型调用已发出（await 中）
  // 窗口内走真实回收入口删章（不是直接 DELETE）
  const recycle = require('../server/domain/chapterRecycle');
  recycle.deleteChapterWithRecycle({ bookId: env.bookId, chapterId: env.chapterId, reason: 'a1-window-recycle' });
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM chapters WHERE id = ?', [env.chapterId]).n, 0,
    '窗口内章必须真的被回收'
  );
  release();
  const result = await inflight;

  assert.equal(db.get('SELECT COUNT(*) AS n FROM event_proposals WHERE book_id = ?', [env.bookId]).n, 0, '整批不创建');
  assert.equal((result.discarded || []).length, 1);
  assert.equal(result.discarded[0].code, 'CHAPTER_MISSING');
  const tomb = db.get('SELECT * FROM proposal_discards WHERE book_id = ? ORDER BY id DESC', [env.bookId]);
  assert.ok(tomb, '章被删同样留墓碑（否则作废不可溯源）');
  assert.equal(tomb.reason, 'CHAPTER_MISSING');
  assert.equal(tomb.current_hash, '');
});

test('A-1⑥ 030 口径：墓碑不进书备份、删书留痕（全局台账）', async t => {
  const env = await setupBook('墓碑口径');
  t.after(() => cleanup(env.location));
  const book = db.get('SELECT * FROM books WHERE id = ?', [env.bookId]);
  const snapshot = db.get('SELECT * FROM chapters WHERE id = ?', [env.chapterId]);
  // 用注入模型制造一次真实作废（模型调用期间改稿）
  const model = async () => {
    applyChapterMutation({
      bookId: env.bookId, chapterId: env.chapterId, expectedRevision: 1,
      patch: { content: NEW_CONTENT }, reason: 'a1-tombstone-scope',
    });
    return { content: JSON.stringify({ proposals: [candidate(env.characterId)] }) };
  };
  const result = await extractChapterProposals(book, snapshot, '林野登船。', model);
  assert.equal(result.discarded.length, 1, '先造出一条墓碑');

  const bookBackup = require('../server/bookBackup');
  const exported = bookBackup.exportBookBackup(env.bookId);
  const data = JSON.parse(fs.readFileSync(path.join(path.dirname(db.getFilePath()), 'backups', exported.file), 'utf8'));
  assert.equal(Object.hasOwn(data.tables, 'proposal_discards'), false,
    '墓碑是运行留痕，不得进书备份（书级导出/恢复只搬书内创作资产）');

  // 删书（级联清空书内表）→ 墓碑行保留（无书级外键，作废痕迹跨删书可查）
  db.run('DELETE FROM books WHERE id = ?', [env.bookId]);
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM proposal_discards WHERE book_id = ?', [env.bookId]).n, 1,
    '删书后墓碑必须保留作痕'
  );
});

test('A-1⑦ 空候选批次不写墓碑：没有 AI 结果被丢弃时不留噪声', async t => {
  const env = await setupBook('空候选窗口');
  t.after(() => cleanup(env.location));
  const book = db.get('SELECT * FROM books WHERE id = ?', [env.bookId]);
  const snapshot = db.get('SELECT * FROM chapters WHERE id = ?', [env.chapterId]);
  // 模型调用期间改稿，且本轮没有任何候选（模型判定本章无状态变化）
  const model = async () => {
    applyChapterMutation({
      bookId: env.bookId, chapterId: env.chapterId, expectedRevision: 1,
      patch: { content: NEW_CONTENT }, reason: 'a1-empty-candidates',
    });
    return { content: JSON.stringify({ proposals: [] }) };
  };
  const result = await extractChapterProposals(book, snapshot, '林野登船。', model);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.discarded, [], '空候选批次没有结果可作废，不得报作废');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM proposal_discards WHERE book_id = ?', [env.bookId]).n, 0,
    '空批次不得在全局墓碑表留噪声行'
  );
});
