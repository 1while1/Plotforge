// S1-03 / C04-B：所有章节修改入口携带版本（REST 层契约）。
//   PUT/总结/版本恢复都必须携带 expected_revision；旧 revision 一律 409，缺失 428；
//   确认卡执行期间人工改章 → 执行返回冲突且不写旧参数；恢复只前进不回退。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const { requestConfirmation, executeTool } = require('../../server/tools/executor');
const actionStore = require('../../server/actionStore');
const bookTools = require('../../server/bookTools');

function seedChapter(content = '原始正文') {
  const bookId = db.run("INSERT INTO books (title) VALUES ('版本契约书')").lastInsertRowid;
  const volId = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第1章', ?, 1)",
    [bookId, volId, content]
  ).lastInsertRowid;
  return { bookId, volId, chapterId };
}

const revisionOf = (chapterId) =>
  Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision);

const versionCount = (chapterId) =>
  db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chapterId]).n;

test('REST PUT：同一秒两笔同 revision 提交只允许一笔，第二笔 409 不覆盖', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  db.run("UPDATE chapters SET updated_at = '2026-09-21 10:00:00' WHERE id = ?", [chapterId]);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const route = `/api/books/${bookId}/chapters/${chapterId}`;

  const first = await json(http.baseUrl, 'PUT', route, { content: '窗口A的新正文', expected_revision: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.chapter.revision, 2);
  assert.equal(first.body.persistence.durable, true);

  // 同一秒内（时间戳守卫失效场景）第二笔携带同一旧 revision
  db.run("UPDATE chapters SET updated_at = '2026-09-21 10:00:00' WHERE id = ?", [chapterId]);
  const second = await json(http.baseUrl, 'PUT', route, { content: '窗口B的旧正文覆盖', expected_revision: 1 });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'CHAPTER_CONFLICT');
  assert.equal(second.body.details.currentRevision, 2);

  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '窗口A的新正文');
});

test('REST PUT：缺失 expected_revision → 428；旧时间戳字段不再作为写入依据', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const route = `/api/books/${bookId}/chapters/${chapterId}`;

  const missing = await json(http.baseUrl, 'PUT', route, { content: '没有版本的提交' });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.code, 'CHAPTER_REVISION_REQUIRED');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '原始正文');

  // 只带旧的 expected_updated_at（无 revision）同样 428，不得无条件写入
  const legacy = await json(http.baseUrl, 'PUT', route, { content: '旧客户端提交', expected_updated_at: '2026-09-21 10:00:00' });
  assert.equal(legacy.status, 428);
});

test('版本恢复：携带当前 revision 才能恢复；恢复只前进不回退', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 造两个版本：先改一次（revision 2），再恢复到 seed 快照
  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, { content: '第二版正文', expected_revision: 1 });
  const versionId = db.get('SELECT id FROM chapter_versions WHERE chapter_id = ? ORDER BY id DESC LIMIT 1', [chapterId]).id;
  assert.equal(revisionOf(chapterId), 2);

  const route = `/api/books/${bookId}/chapters/${chapterId}/versions/${versionId}/restore`;
  const stale = await json(http.baseUrl, 'POST', route, { expected_revision: 1 });
  assert.equal(stale.status, 409, '旧 revision 恢复请求必须被拒');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '第二版正文');

  const missing = await json(http.baseUrl, 'POST', route, {});
  assert.equal(missing.status, 428);

  const fresh = await json(http.baseUrl, 'POST', route, { expected_revision: 2 });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.ok, true);
  const restored = db.get('SELECT content, revision FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(restored.content, '原始正文');
  assert.equal(restored.revision, 3, '恢复只前进：revision 递增而非回退到旧值');
});

test('总结路由版本守卫：LLM 生成期间正文被改，旧总结被 409 拒收', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  const { installFetchStub, jsonStub, chatPayload } = require('../helpers/llm-stub');
  const stub = installFetchStub();
  t.after(() => stub.restore());
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'stub-model') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 挂起总结（复刻审查反例 C06 的场景，此处断言 S1-03 的版本守卫行为）
  let release;
  stub.responders.push(() => new Promise(resolve => { release = resolve; }));
  const pending = json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/summary`, {});
  const deadline = Date.now() + 3000;
  while (typeof release !== 'function' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(typeof release, 'function', '总结 LLM 调用应已发出');

  // 生成期间人工改正文（revision 前进）
  const edit = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, { content: '生成期间被改的正文', expected_revision: 1 });
  assert.equal(edit.status, 200);

  release(jsonStub(chatPayload({ content: '对旧版原始正文的总结' })));
  const result = await pending;
  assert.equal(result.status, 409, '总结写入必须以请求开始时的来源（revision/指纹）比对');
  // S5-01：总结路由改用通用来源守卫（01 契约 §7），正文变化属来源变化 → SOURCE_CHANGED；
  // 拒收语义与 S1-03 相同（409 + 不写库），错误码按新契约收敛
  assert.equal(result.body.code, 'SOURCE_CHANGED');
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [chapterId]).summary, '', '旧总结不得写到新正文上');
});

// ---------------- S1-03b：工具面与确认信封 ----------------

test('确认信封绑定章节 revision：append_chapter 创建时快照，等待期间人工改章 → 执行 409 不写旧参数', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const ctx = { profile: 'writing', bookId, sessionId: 'revision-contract', source: 'agent', actor: 'author' };
  const args = { chapterId, text: '\nAI 要追加的正文' };
  const conf = requestConfirmation(ctx, 'append_chapter', args);
  assert.equal(conf.status, 'confirmation_required');
  const action = actionStore.get(conf.confirmation.id);
  assert.equal(action.args.expected_revision, 1, '确认信封必须绑定创建时的章节 revision（模型无需提供）');

  // 等待确认期间作者人工编辑同一章（revision 前进）
  db.run("UPDATE chapters SET content = '人工改后的正文', revision = revision + 1 WHERE id = ?", [chapterId]);

  await assert.rejects(
    executeTool(ctx, 'append_chapter', action.args, conf.confirmation.id),
    err => err.code === 'CHAPTER_CONFLICT' && err.status === 409,
    '确认执行必须以绑定 revision 比对，冲突拒绝而不是写旧参数'
  );
  assert.equal(actionStore.get(conf.confirmation.id).status, 'failed');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '人工改后的正文',
    'AI 追加文本不得写入');
});

test('bookTools 直调同样守卫：缺 expected_revision 428，过期 409，当前值成功并递增', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  t.after(() => cleanup(location));
  const bookTools = require('../../server/bookTools');

  await assert.rejects(
    bookTools.executeWrite(bookId, 'append_chapter', { chapterId, text: '无版本追加' }),
    err => err.code === 'CHAPTER_REVISION_REQUIRED' && err.status === 428
  );
  db.run('UPDATE chapters SET revision = revision + 1 WHERE id = ?', [chapterId]);
  await assert.rejects(
    bookTools.executeWrite(bookId, 'append_chapter', { chapterId, text: '过期追加', expected_revision: 1 }),
    err => err.code === 'CHAPTER_CONFLICT' && err.status === 409
  );
  const ok = await bookTools.executeWrite(bookId, 'append_chapter', { chapterId, text: 'AI 追加正文', expected_revision: 2 });
  assert.equal(ok.ok, true);
  const after = db.get('SELECT content, revision FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(after.content, '原始正文\nAI 追加正文');
  assert.equal(after.revision, 3, 'AI 写入同样推进 revision');
});

test('set_chapter_meta 与 save_chapter_summary 走版本守卫；move_chapter 信封绑定并冲突拒绝', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, volId, chapterId } = seedChapter();
  const volB = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const ctx = { profile: 'agent', bookId, sessionId: 'revision-contract-tools', source: 'agent', actor: 'author' };

  // set_chapter_meta：过期 revision 拒绝，当前值改名成功
  db.run('UPDATE chapters SET revision = revision + 1 WHERE id = ?', [chapterId]);
  await assert.rejects(
    bookTools.executeWrite(bookId, 'set_chapter_meta', { chapterId, title: '新标题', expected_revision: 1 }),
    err => err.code === 'CHAPTER_CONFLICT'
  );
  const meta = await bookTools.executeWrite(bookId, 'set_chapter_meta', { chapterId, title: '新标题', expected_revision: 2 });
  assert.equal(meta.ok, true);
  assert.equal(db.get('SELECT title FROM chapters WHERE id = ?', [chapterId]).title, '新标题');

  // save_chapter_summary：信封绑定 revision；等待期间正文被改 → 执行 409，总结不写入
  const summaryArgs = { chapter_id: chapterId, summary: 'AI 生成的总结' };
  const sumConf = requestConfirmation(ctx, 'save_chapter_summary', summaryArgs);
  const sumAction = actionStore.get(sumConf.confirmation.id);
  assert.equal(sumAction.args.expected_revision, Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision));
  db.run('UPDATE chapters SET content = ? , revision = revision + 1 WHERE id = ?', ['改动后的正文', chapterId]);
  await assert.rejects(
    executeTool(ctx, 'save_chapter_summary', sumAction.args, sumConf.confirmation.id),
    err => err.code === 'CHAPTER_CONFLICT'
  );
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [chapterId]).summary, '', '过期总结不得写入');

  // move_chapter：信封绑定 revision，正常执行推进版本并重建投影
  const moveConf = requestConfirmation(ctx, 'move_chapter', { chapter_id: chapterId, volume_id: volB });
  const moveAction = actionStore.get(moveConf.confirmation.id);
  const currentRevision = Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision);
  assert.equal(moveAction.args.expected_revision, currentRevision);
  const moved = await executeTool(ctx, 'move_chapter', moveAction.args, moveConf.confirmation.id);
  assert.equal(moved.volume_id, volB);
  assert.ok(moved.revision > currentRevision, '移章推进 revision');
  assert.equal(moved.projection_rebuilt, true);
});
