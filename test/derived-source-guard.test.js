// S5-01 / C06：章/卷/全书总结按来源提交（01-架构与接口契约 §7）。
// 覆盖：来源指纹契约（输出字段不进长期指纹）、C06 章总结挂起改稿、并发两次总结、
// 卷总结生成期间底料变化（章总结变化/删章/换卷/调序/追加）、全书卷总结变化、
// 手改章总结直达书层、手改卷总结刷链、工具面确认绑定（卷/全书）、既有提案与
// 正文失效链保留回归。断言全部打在业务行为与库内取值上（不用 import 缺失冒充红测）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub, jsonStub, chatPayload, waitUntil } = require('./helpers/llm-stub');
const guard = require('../server/domain/sourceGuard');
const lifecycle = require('../server/domain/chapterLifecycle');
const { requestConfirmation, executeTool } = require('../server/tools/executor');
const actionStore = require('../server/actionStore');

const revisionOf = (chapterId) =>
  Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision);
const summaryOf = (chapterId) => db.get('SELECT summary FROM chapters WHERE id = ?', [chapterId]).summary;
const volumeRow = (volumeId) => db.get('SELECT summary, summary_based_on, summary_stale FROM volumes WHERE id = ?', [volumeId]);
const bookStale = (bookId) =>
  Number(db.get('SELECT stale FROM story_state WHERE book_id = ? AND kind = ?', [bookId, 'book_summary']).stale);

function withStub(t) {
  const stub = installFetchStub();
  t.after(() => stub.restore());
  return stub;
}

function settingsForStub() {
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'stub-model') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
}

// 两卷三章：第一卷 ch1/ch2（有总结），第二卷 ch3（有总结）。不 seed 总纲/卷纲，
// 使章总结路由只发生一次 LLM 调用（checkDrift 无大纲直接返回）。
function seedBookWithTwoVolumes() {
  const bookId = db.run("INSERT INTO books (title) VALUES ('来源守卫书')").lastInsertRowid;
  const volA = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const volB = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  const ch1 = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '第一章', '第一章正文：林野夺船北上。', '林野夺船北上。', 1)",
    [bookId, volA]
  ).lastInsertRowid;
  const ch2 = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '第二章', '第二章正文：北境冻港遇袭。', '北境冻港遇袭。', 2)",
    [bookId, volA]
  ).lastInsertRowid;
  const ch3 = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '第三章', '第三章正文：第二卷开篇。', '第二卷开篇。', 1)",
    [bookId, volB]
  ).lastInsertRowid;
  return { bookId, volA, volB, ch1, ch2, ch3 };
}

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const ids = seedBookWithTwoVolumes();
  settingsForStub();
  const stub = withStub(t);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { ...ids, stub, http };
}

// ---------------- 契约：来源指纹与来源核验 ----------------

test('captureSource/assertSourceCurrent：输出字段不进长期指纹，输入字段变化抛 409 SOURCE_CHANGED', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, volA, ch1 } = seedBookWithTwoVolumes();
  t.after(() => cleanup(location));

  const chapterSnap = guard.captureSource({ bookId, kind: 'chapter', entityId: ch1 });
  assert.ok(chapterSnap.fingerprint, '章来源指纹必须存在');
  assert.equal(chapterSnap.refs[0].kind, 'chapter');
  assert.equal(chapterSnap.refs[0].id, ch1);
  assert.equal(chapterSnap.refs[0].revision, 1, 'refs 应记录读取时 revision 供提交 CAS');

  // 长期有效性指纹排除本次生成的输出字段：写总结（含 revision 自增）后重新捕获，指纹逐字相同
  db.run("UPDATE chapters SET summary = '写回的章总结', revision = revision + 1 WHERE id = ?", [ch1]);
  const afterSave = guard.captureSource({ bookId, kind: 'chapter', entityId: ch1 });
  assert.equal(afterSave.fingerprint, chapterSnap.fingerprint, '总结自身写入不得改变输入指纹（否则保存后立刻自判过期）');
  assert.doesNotThrow(() => guard.assertSourceCurrent(afterSave), '按当下来源重新捕获的快照必须当下有效');

  // 输入字段（正文）变化 → 409 SOURCE_CHANGED
  db.run("UPDATE chapters SET content = '完全不同的正文', revision = revision + 1 WHERE id = ?", [ch1]);
  assert.throws(() => guard.assertSourceCurrent(chapterSnap), (err) => {
    assert.equal(err.code, 'SOURCE_CHANGED');
    assert.equal(err.status, 409);
    return true;
  });

  // 卷来源指纹：卷标题与卷内章有序底料都是实际输入 → 都进指纹
  const volumeSnap = guard.captureSource({ bookId, kind: 'volume', entityId: volA });
  assert.ok(volumeSnap.refs.some(ref => ref.kind === 'chapter' && ref.id === ch1), '卷来源 refs 应含卷内章 revision');
  const parts = guard.sourceParts({ bookId, kind: 'volume', entityId: volA });
  assert.ok(parts.some(part => part.startsWith('config:')), '相关配置摘要必须进指纹');
  db.run("UPDATE volumes SET title = '第一卷·改名' WHERE id = ?", [volA]);
  assert.throws(() => guard.assertSourceCurrent(volumeSnap), (err) => err.code === 'SOURCE_CHANGED',
    '卷标题是生成时的实际输入，改名后旧结果不得提交');

  // 全书来源指纹 = 有序卷总结 + 章总结：卷改名不动书层底料，章总结变化才动
  const bookSnap = guard.captureSource({ bookId, kind: 'book' });
  assert.doesNotThrow(() => guard.assertSourceCurrent(bookSnap), '卷标题不是全书摘要的底料，改名不应使书层来源失效');
  db.run("UPDATE chapters SET summary = '被改写的章总结', revision = revision + 1 WHERE id = ?", [ch1]);
  assert.throws(() => guard.assertSourceCurrent(bookSnap), (err) => err.code === 'SOURCE_CHANGED',
    '章总结是全书摘要的底料，变化后旧书层快照必须失效');

  // 只写全书摘要自身不算来源变化（输出字段不进指纹）
  const freshBookSnap = guard.captureSource({ bookId, kind: 'book' });
  db.run(
    "INSERT INTO story_state (book_id, kind, content) VALUES (?, 'book_summary', '新的全书摘要') ON CONFLICT(book_id, kind) DO UPDATE SET content = excluded.content",
    [bookId]
  );
  assert.doesNotThrow(() => guard.assertSourceCurrent(freshBookSnap), '全书摘要自身写入不得使输入指纹过期');
});

// ---------------- C06：章总结（REST） ----------------

test('C06：挂起总结模型请求期间改正文并推进 revision，释放旧总结必须 409 且不覆盖', async t => {
  const { bookId, ch1, ch3, stub, http } = await setup(t);
  const editedContent = '正文已经改为完全不同的事件';

  let release;
  stub.responders.push(() => new Promise(resolve => { release = resolve; }));
  const pending = json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${ch1}/summary`, {});
  await waitUntil(() => typeof release === 'function');

  // 生成期间人工改正文（revision 前进，旧总结同时被失效清空）
  const edit = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { content: editedContent, expected_revision: revisionOf(ch1) });
  assert.equal(edit.status, 200);

  release(jsonStub(chatPayload({ content: '对旧版原始正文的总结' })));
  const staleSummaryResponse = await pending;

  const currentChapter = db.get('SELECT content, summary, revision FROM chapters WHERE id = ?', [ch1]);
  const oldGeneratedSummary = '对旧版原始正文的总结';
  assert.equal(staleSummaryResponse.status, 409, '旧总结必须被拒收（409）');
  assert.equal(staleSummaryResponse.body.code, 'SOURCE_CHANGED');
  assert.notEqual(currentChapter.summary, oldGeneratedSummary);
  assert.equal(currentChapter.content, editedContent);

  // 未受影响的来源：另一卷的章总结仍然有效（守卫不得误伤无关来源）
  const otherSnap = guard.captureSource({ bookId, kind: 'chapter', entityId: ch3 });
  let otherValid = true;
  try { guard.assertSourceCurrent(otherSnap); } catch (e) { otherValid = false; }
  const unchangedSourceSummaryStillValid = otherValid && summaryOf(ch3) === '第二卷开篇。';
  assert.equal(unchangedSourceSummaryStillValid, true);

  // 来源未变时总结正常提交，并记录 sourceFingerprint 与 committedRevision
  stub.responders.push(() => jsonStub(chatPayload({ content: '基于当前正文的总结' })));
  const ok = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${ch1}/summary`, {});
  assert.equal(ok.status, 200);
  assert.ok(ok.body.source_fingerprint, '结果必须记录 sourceFingerprint');
  assert.equal(ok.body.committed_revision, revisionOf(ch1), '结果必须记录 committedRevision');
  assert.equal(summaryOf(ch1), '基于当前正文的总结');
});

test('两次并发章总结：改稿后旧结果全部被拒，只有基于当前来源的新结果可提交', async t => {
  const { bookId, ch1, stub, http } = await setup(t);
  const route = `/api/books/${bookId}/chapters/${ch1}/summary`;

  let releaseA, releaseB;
  stub.responders.push(
    () => new Promise(resolve => { releaseA = resolve; }),
    () => new Promise(resolve => { releaseB = resolve; })
  );
  const first = json(http.baseUrl, 'POST', route, {});
  const second = json(http.baseUrl, 'POST', route, {});
  await waitUntil(() => typeof releaseA === 'function' && typeof releaseB === 'function');

  const editedContent = '并发生成期间改写的正文';
  const edit = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { content: editedContent, expected_revision: revisionOf(ch1) });
  assert.equal(edit.status, 200);

  releaseA(jsonStub(chatPayload({ content: 'A 的旧总结' })));
  releaseB(jsonStub(chatPayload({ content: 'B 的旧总结' })));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 409);
  assert.equal(b.status, 409);
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [ch1]).summary, '', '旧结果不得写入');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [ch1]).content, editedContent);

  // 基于当前来源重新生成 → 唯一可提交的结果
  stub.responders.push(() => jsonStub(chatPayload({ content: '改稿后的新总结' })));
  const fresh = await json(http.baseUrl, 'POST', route, {});
  assert.equal(fresh.status, 200);
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [ch1]).summary, '改稿后的新总结');
});

// ---------------- 卷总结（REST） ----------------

test('卷总结：生成期间章总结变化 → 409 SOURCE_CHANGED，旧卷总结与底料指纹不被覆盖', async t => {
  const { bookId, volA, ch1, stub, http } = await setup(t);
  const route = `/api/books/${bookId}/volumes/${volA}/summary`;

  // 先有一份基于当前底料的卷总结
  stub.responders.push(() => jsonStub(chatPayload({ content: '第一卷：林野北上，冻港遇袭。' })));
  const saved = await json(http.baseUrl, 'POST', route, {});
  assert.equal(saved.status, 200);
  const before = volumeRow(volA);
  assert.ok(before.summary_based_on);

  // 重新生成期间改章总结（底料变化）
  let release;
  stub.responders.push(() => new Promise(resolve => { release = resolve; }));
  const pending = json(http.baseUrl, 'POST', route, {});
  await waitUntil(() => typeof release === 'function');
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { summary: '林野夺船改走陆路。', expected_revision: revisionOf(ch1) });
  assert.equal(put.status, 200);
  release(jsonStub(chatPayload({ content: '基于旧章总结的卷总结' })));

  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SOURCE_CHANGED');
  const after = volumeRow(volA);
  assert.equal(after.summary, before.summary, '旧生成的卷总结不得覆盖已保存的卷总结');
  assert.equal(after.summary_based_on, before.summary_based_on, '指纹不得被旧结果洗白');
  assert.equal(after.summary_stale, 1, '底料已变化，卷总结应处于过期态');

  // 基于当前底料重新生成 → 唯一可提交的结果
  stub.responders.push(() => jsonStub(chatPayload({ content: '第一卷：林野改走陆路，冻港遇袭。' })));
  const regen = await json(http.baseUrl, 'POST', route, {});
  assert.equal(regen.status, 200);
  assert.ok(regen.body.source_fingerprint, '结果必须记录 sourceFingerprint');
  const finalRow = volumeRow(volA);
  assert.equal(finalRow.summary_stale, 0);
  assert.equal(finalRow.summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volA));
});

test('卷底料结构变化（调序/追加/删章/换卷）使挂起的卷总结失效', async t => {
  const { bookId, volA, volB, ch1, ch2, http } = await setup(t);
  // 各场景独立构造快照：只做结构改动，不动卷自身；顺序保证每个目标章在使用时仍存在
  const cases = [];

  // 调序：卷内章顺序变化
  cases.push({
    name: '调序',
    mutate: () => json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
      { sort_order: 9, expected_revision: revisionOf(ch1) }),
  });
  // 追加带总结的新章 → 底料多一项
  cases.push({
    name: '追加',
    mutate: () => Promise.resolve({
      status: 201,
      body: db.run(
        "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '新章', '新章正文。', '新章总结。', 5)",
        [bookId, volA]
      ),
    }),
  });
  // 删章：卷内有总结的章被删 → 底料少一项
  cases.push({
    name: '删章',
    mutate: () => json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${ch2}`, {}),
  });
  // 换卷：卷内最后一章挪到第二卷 → 第一卷底料少一项
  cases.push({
    name: '换卷',
    mutate: () => json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
      { volume_id: volB, expected_revision: revisionOf(ch1) }),
  });

  for (const item of cases) {
    const snap = guard.captureSource({ bookId, kind: 'volume', entityId: volA });
    const before = snap.fingerprint;
    const res = await item.mutate();
    assert.ok(res.status < 400, `${item.name} 变更应成功`);
    assert.throws(() => guard.assertSourceCurrent(snap), (err) => err.code === 'SOURCE_CHANGED',
      `${item.name} 后旧卷总结来源必须判为已变化`);
    assert.notEqual(guard.captureSource({ bookId, kind: 'volume', entityId: volA }).fingerprint, before,
      `${item.name} 后来源指纹必须变化`);
  }
});

// ---------------- 全书层：卷总结变化与手改链 ----------------

test('全书来源：卷总结变化使挂起的全书来源失效；保存后传播到 book_summary.stale', async t => {
  const { bookId, volA, ch1, stub, http } = await setup(t);
  // 先有全书摘要（带指纹）
  const prog = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '卷一开局。' });
  assert.equal(prog.status, 200);
  assert.equal(bookStale(bookId), 0);
  const bookSnap = guard.captureSource({ bookId, kind: 'book' });

  // 卷总结变化（真实 REST 保存路径）→ 书层底料变化
  stub.responders.push(() => jsonStub(chatPayload({ content: '第一卷：林野北上遇袭。' })));
  const saved = await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes/${volA}/summary`, {});
  assert.equal(saved.status, 200);
  assert.throws(() => guard.assertSourceCurrent(bookSnap), (err) => err.code === 'SOURCE_CHANGED',
    '卷总结变化后旧的全书来源快照必须失效');
  assert.equal(bookStale(bookId), 1, '卷总结变化应传播到全书摘要过期');

  // 手改章总结（REST PUT）与工具路径一致：直达书层过期
  const prog2 = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '卷一：林野北上遇袭。' });
  assert.equal(prog2.status, 200);
  assert.equal(bookStale(bookId), 0);
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { summary: '林野夺船改走陆路。', expected_revision: revisionOf(ch1) });
  assert.equal(put.status, 200);
  assert.equal(bookStale(bookId), 1, '手改章总结必须直达书摘要过期（与 save_chapter_summary 工具一致）');
});

test('手改卷总结（PUT /volumes/:id）：刷新底料指纹、清除过期标记并传播书层', async t => {
  const { bookId, volA, ch1, stub, http } = await setup(t);
  // 先有卷总结（REST 生成）+ 全书摘要
  stub.responders.push(() => jsonStub(chatPayload({ content: '第一卷：初版。' })));
  await json(http.baseUrl, 'POST', `/api/books/${bookId}/volumes/${volA}/summary`, {});
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '卷一初版。' });

  // 底料变化 → 卷标过期
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch1}`,
    { summary: '林野改走陆路。', expected_revision: revisionOf(ch1) });
  assert.equal(volumeRow(volA).summary_stale, 1);

  // 作者手改卷总结 → 指纹随当前底料刷新、过期清除、书层底料变化标过期
  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/volumes/${volA}`,
    { summary: '第一卷：作者手改的卷总结。' });
  assert.equal(put.status, 200);
  const row = volumeRow(volA);
  assert.equal(row.summary, '第一卷：作者手改的卷总结。');
  assert.equal(row.summary_stale, 0, '手改后不得继续显示过期');
  assert.equal(row.summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volA),
    '手改卷总结应记录当前底料指纹');
  assert.equal(bookStale(bookId), 1, '手改卷总结应传播到全书摘要过期');
});

// ---------------- 工具面：确认信封绑定来源 ----------------

test('工具面：save_volume_summary 确认时绑定来源指纹，等待期间底料变化 → 409 不写库', async t => {
  const { bookId, volA, ch1 } = await setup(t);
  const ctx = { profile: 'agent', bookId, sessionId: 's5-01-volume-tool', source: 'agent', actor: 'author' };
  const args = { volume_id: volA, summary: '工具生成的卷总结。' };
  const conf = requestConfirmation(ctx, 'save_volume_summary', args);
  assert.equal(conf.status, 'confirmation_required');
  const bound = actionStore.get(conf.confirmation.id).args.source_fingerprint;
  assert.equal(typeof bound, 'string', '确认信封必须由服务端绑定来源指纹');

  // 等待确认期间底料变化
  db.run("UPDATE chapters SET summary = '等待期改写的章总结', revision = revision + 1 WHERE id = ?", [ch1]);
  await assert.rejects(
    executeTool(ctx, 'save_volume_summary', actionStore.get(conf.confirmation.id).args, conf.confirmation.id),
    (err) => {
      assert.equal(err.code, 'SOURCE_CHANGED');
      assert.equal(err.status, 409);
      return true;
    }
  );
  assert.equal(volumeRow(volA).summary, '', '过期卷总结不得写入');

  // 底料未变时（新确认）正常落库并记录来源指纹
  const conf2 = requestConfirmation(ctx, 'save_volume_summary', { volume_id: volA, summary: '工具生成的卷总结。' });
  const out = await executeTool(ctx, 'save_volume_summary', actionStore.get(conf2.confirmation.id).args, conf2.confirmation.id);
  assert.equal(out.saved, true);
  assert.ok(out.source_fingerprint, '工具结果必须记录来源指纹');
  assert.equal(volumeRow(volA).summary, '工具生成的卷总结。');
});

test('工具面：update_book_progress 同样绑定全书来源指纹；save_chapter_summary 版本绑定保留', async t => {
  const { bookId, volA, ch1, ch2 } = await setup(t);
  const ctx = { profile: 'agent', bookId, sessionId: 's5-01-book-tool', source: 'agent', actor: 'author' };

  const conf = requestConfirmation(ctx, 'update_book_progress', { summary: '全书：卷一开局。' });
  assert.equal(typeof actionStore.get(conf.confirmation.id).args.source_fingerprint, 'string',
    '全书摘要工具确认时必须绑定全书来源指纹');
  // 等待确认期间卷总结变化 → 旧全书摘要不得落库
  db.run("UPDATE volumes SET summary = '等待期写入的卷总结' WHERE id = ?", [volA]);
  await assert.rejects(
    executeTool(ctx, 'update_book_progress', actionStore.get(conf.confirmation.id).args, conf.confirmation.id),
    (err) => err.code === 'SOURCE_CHANGED' && err.status === 409
  );
  assert.ok(!db.get("SELECT content FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]),
    '过期全书摘要不得落库');

  // save_chapter_summary：确认信封绑定章节 revision（S1-03b 语义保留），等待期改章 → 409
  const sumArgs = { chapter_id: ch2, summary: '第二章的 AI 总结。' };
  const conf2 = requestConfirmation(ctx, 'save_chapter_summary', sumArgs);
  assert.equal(actionStore.get(conf2.confirmation.id).args.expected_revision, revisionOf(ch2));
  // 等待确认期间作者改正文（真实领域入口：revision 前进 + 旧总结被失效清空）
  require('../server/domain/chapterMutations').applyChapterMutation({
    bookId, chapterId: ch2, expectedRevision: revisionOf(ch2),
    patch: { content: '等待期被改的正文' }, reason: 'test-edit',
  });
  await assert.rejects(
    executeTool(ctx, 'save_chapter_summary', actionStore.get(conf2.confirmation.id).args, conf2.confirmation.id),
    (err) => err.status === 409
  );
  assert.equal(summaryOf(ch2), '', '等待期改章后旧总结不得写入');

  // 来源未变：正常写入并记录来源指纹与提交版本
  const conf3 = requestConfirmation(ctx, 'save_chapter_summary', { chapter_id: ch1, summary: '第一章的 AI 总结。' });
  const out = await executeTool(ctx, 'save_chapter_summary', actionStore.get(conf3.confirmation.id).args, conf3.confirmation.id);
  assert.equal(out.saved, true);
  assert.ok(out.source_fingerprint, '章总结工具结果必须记录来源指纹');
  assert.equal(out.committed_revision, revisionOf(ch1));
});

// ---------------- 既有守卫回归（提案抽取与正文失效链保留） ----------------

test('既有来源守卫保留：正文变化清空旧总结、待审提案置 stale、相关卷/书标过期', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, volA, ch1 } = seedBookWithTwoVolumes();
  t.after(() => cleanup(location));

  // 既有提案来源守卫：source_revision_hash 记录读取时正文哈希
  db.run(
    `INSERT INTO event_proposals (book_id, chapter_id, title, summary, status, source_type, source_revision_hash, dedupe_key, created_at)
     VALUES (?, ?, '待审提案', '提案内容', 'pending', 'chapter_summary', 'hash-before', 's5-01-proposal', datetime('now','localtime'))`,
    [bookId, ch1]
  );
  db.run("INSERT INTO story_state (book_id, kind, content, based_on, stale) VALUES (?, 'book_summary', '旧全书摘要', 'old-fp', 0) ON CONFLICT(book_id, kind) DO UPDATE SET content = excluded.content, stale = 0", [bookId]);
  db.run("UPDATE volumes SET summary = '旧卷总结', summary_based_on = 'old-fp', summary_stale = 0 WHERE id = ?", [volA]);

  // 正文变化（领域入口）→ 清空章总结、提案 stale、卷/书总结标过期
  const applied = require('../server/domain/chapterMutations').applyChapterMutation({
    bookId, chapterId: ch1, expectedRevision: revisionOf(ch1),
    patch: { content: '被大改的正文' }, reason: 'test-edit',
  });
  assert.equal(applied.changed, true);
  assert.equal(summaryOf(ch1), '');
  assert.equal(
    db.get("SELECT status FROM event_proposals WHERE book_id = ? AND chapter_id = ?", [bookId, ch1]).status,
    'stale', '待审提案必须随正文变化置 stale（既有守卫保留）'
  );
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volA]).summary_stale, 1);
  assert.equal(bookStale(bookId), 1);
  assert.equal(lifecycle.markBookSummaryStale(bookId), false, '已过期时重复标记应幂等不写');
});
