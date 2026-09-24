// S2-02 / C07：执行中断的确认可解释、不可盲重放。
// 核心断言：重启后无结算凭据的 executing 标 interrupted（不盲重放、不谎称已结算）；
// 三个故障注入点（授权落盘前 / 领域变更后结算前 / 结算落盘后响应前）各自可解释；
// 有真实 durable 结算凭据的卡恢复为既有结果，重复确认返回同一结果而非 409。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const actionStore = require('../server/actionStore');

async function reopen(location) {
  db.saveNow();
  db.close();
  await db.init({ filePath: location.filePath });
}

function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  return location;
}

test('启动恢复：无结算凭据的 executing 标 interrupted，pending/approved 原样保留', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('恢复书')").lastInsertRowid;
  const pending = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'a' });
  const executing = actionStore.create(bookId, 'update_volume', { volumeId: 1, title: 'x' });
  db.run("UPDATE chat_actions SET status = 'executing', used_at = ? WHERE id = ?", [Date.now(), executing.id]);
  const approved = actionStore.create(bookId, 'set_master_outline', { outline: 'o' });
  actionStore.settle(approved.id, 'approved', { ok: true });

  await reopen(location);
  const recovered = actionStore.recoverInterruptedActions();

  assert.equal(actionStore.get(pending.id).status, 'pending', '未开始执行的不动');
  assert.equal(actionStore.get(approved.id).status, 'approved', '已结算的不动');
  const victim = actionStore.get(executing.id);
  assert.equal(victim.status, 'interrupted');
  assert.ok(victim.recoveryReason, '必须写明恢复原因（可解释）');
  assert.equal(recovered.interrupted, 1);
});

test('防御恢复：executing 带 durable 结算凭据时按凭据恢复，不凭空推断', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('凭据书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'b' });
  actionStore.settle(action.id, 'approved', { ok: true, chapterId: 9 });
  // 模拟状态字段损坏（settle 原子性下不会出现，防御深度）：status 被打回 executing，凭据仍在
  db.run("UPDATE chat_actions SET status = 'executing' WHERE id = ?", [action.id]);

  await reopen(location);
  const recovered = actionStore.recoverInterruptedActions();

  const restored = actionStore.get(action.id);
  assert.equal(restored.status, 'approved', '有真实 result+durable 凭据 → 恢复既有结果');
  assert.deepEqual(restored.result, { ok: true, chapterId: 9 });
  assert.equal(recovered.interrupted, 0);
  assert.equal(recovered.restored, 1);
});

test('S1 落盘 pending 不因 result 存在被转换成成功：无凭据 executing 一律 interrupted', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('落盘书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'c' });
  // 模拟损坏：executing + result 里有落盘 pending 标记但没有 durable 结算凭据
  db.run("UPDATE chat_actions SET status = 'executing', result_json = ? WHERE id = ?",
    [JSON.stringify({ ok: true, persistence: { durable: false } }), action.id]);

  await reopen(location);
  actionStore.recoverInterruptedActions();

  const restored = actionStore.get(action.id);
  assert.equal(restored.status, 'interrupted', '不得把落盘 pending 转换为成功声明');
});

test('interrupted 后 authorize 拒绝：不能再次执行业务', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('拒绝书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'update_volume', { volumeId: 1, title: 'x' }, { sessionId: 'writing:book:1' });
  db.run("UPDATE chat_actions SET status = 'interrupted', recovery_reason = 'restart_during_execution' WHERE id = ?", [action.id]);

  const auth = actionStore.authorize(action.id, {
    bookId, name: 'update_volume', args: { volumeId: 1, title: 'x' }, sessionId: 'writing:book:1',
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 'CONFIRMATION_INTERRUPTED');
});

test('注入点①：授权落盘前崩 → 重启后仍 pending，可正常确认且只执行一次', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('注入一')").lastInsertRowid;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '旧章', '旧文', 1)", [bookId]).lastInsertRowid;
  // 经真实创建路径（requestConfirmation 快照 target revision），崩在 authorize 持久化之前
  const { requestConfirmation, executeTool } = require('../server/tools/executor');
  const wrapped = requestConfirmation({ profile: 'writing', sessionId: 'writing:book:' + bookId, bookId, source: 'writing-chat' }, 'append_chapter', { chapterId, text: '追加段落' });
  assert.equal(wrapped.status, 'confirmation_required');

  await reopen(location);
  actionStore.recoverInterruptedActions();
  assert.equal(actionStore.get(wrapped.confirmation.id).status, 'pending', '未授权的不应被误标');

  const before = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  const restored = actionStore.get(wrapped.confirmation.id);
  // executeTool 内部走 authorize：成功即证明重启后确认链可用，且只执行一次
  await executeTool({ profile: 'writing', sessionId: 'writing:book:' + bookId, bookId }, 'append_chapter', restored.args, wrapped.confirmation.id);
  const after = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  assert.equal(after, before, '追加写的是既有章，不新建章节');
  assert.equal(actionStore.get(wrapped.confirmation.id).status, 'approved');
});

test('注入点②：领域变更后结算前崩 → interrupted，再次确认不再执行业务', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('注入二')").lastInsertRowid;
  const action = actionStore.create(bookId, 'create_chapter', { title: '中断章' });
  // 授权已持久化、领域变更（章已建）、结算未落——进程崩溃
  actionStore.authorize(action.id, { bookId, name: 'create_chapter', args: { title: '中断章' } });
  db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '中断章', '', 1)", [bookId]);

  await reopen(location);
  const recovered = actionStore.recoverInterruptedActions();
  assert.equal(recovered.interrupted, 1);
  assert.equal(actionStore.get(action.id).status, 'interrupted');
  const chaptersAfterCrash = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  assert.equal(chaptersAfterCrash, 1, '已生效的领域变更不被回滚（可能已部分生效，需作者核对）');

  // 作者再点同意：不得再次执行（authorize 拒绝 → executeTool 抛 INVALID_CONFIRMATION）
  const { executeTool } = require('../server/tools/executor');
  await assert.rejects(
    executeTool({ profile: 'writing', sessionId: 'writing:book:' + bookId, bookId }, 'create_chapter', { title: '中断章' }, action.id),
    (e) => e.code === 'INVALID_CONFIRMATION',
  );
  const chaptersAfterRetry = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  assert.equal(chaptersAfterRetry, chaptersAfterCrash, '重复确认不得再执行业务');
});

test('注入点③：结算落盘后响应前崩 → 重复确认返回同一已结算结果', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('注入三')").lastInsertRowid;
  const action = actionStore.create(bookId, 'create_chapter', { title: '已完成章' });
  // 结算已落盘（响应没发出就崩了）
  actionStore.authorize(action.id, { bookId, name: 'create_chapter', args: { title: '已完成章' } });
  actionStore.settle(action.id, 'approved', { ok: true, chapterId: 42 });

  await reopen(location);
  actionStore.recoverInterruptedActions();

  const { executeTool } = require('../server/tools/executor');
  // executeTool 侧：已结算卡不再执行，抛 INVALID_CONFIRMATION（由路由层转幂等回放）
  await assert.rejects(
    executeTool({ profile: 'writing', sessionId: 'writing:book:' + bookId, bookId }, 'create_chapter', { title: '已完成章' }, action.id),
    (e) => e.code === 'INVALID_CONFIRMATION',
  );
  const settled = actionStore.get(action.id);
  assert.equal(settled.status, 'approved');
  assert.deepEqual(settled.result, { ok: true, chapterId: 42 });
  assert.ok(settled.settlementRef, '结算必须留下 durable 凭据');
});

test('HTTP：写作页重复确认已结算卡返回同一结果而非 409', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const bookId = db.run("INSERT INTO books (title) VALUES ('HTTP幂等')").lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, "旧章", "旧文", 1)', [bookId]);
  const chapterId = db.get('SELECT id FROM chapters WHERE book_id = ?', [bookId]).id;
  // 经真实创建路径（requestConfirmation 绑定 expected_revision），与流内行为一致
  const { requestConfirmation } = require('../server/tools/executor');
  const wrapped = requestConfirmation({ profile: 'writing', sessionId: 'writing:book:' + bookId, bookId, source: 'writing-chat' }, 'append_chapter', { chapterId, text: '幂等段落' });
  const actionId = wrapped.confirmation.id;
  const http = await listen(createApp());
  t.after(() => http.close());

  const first = await fetch(http.baseUrl + '/api/books/' + bookId + '/chat-actions/' + actionId + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  // 结算已落盘、响应没送达（网络断）→ 客户端重发同一次确认
  const retry = await fetch(http.baseUrl + '/api/books/' + bookId + '/chat-actions/' + actionId + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true }),
  });
  assert.equal(retry.status, 200, '重复确认应幂等返回既有结果，而不是 409 已结算');
  const retryBody = await retry.json();
  assert.equal(retryBody.status, 'approved');
  assert.deepEqual(retryBody.result, firstBody.result, '返回同一已结算结果');
  const text = db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content;
  assert.equal((text.match(/幂等段落/g) || []).length, 1, '正文只追加一次');
});

test('HTTP：写作页/Agent 对 interrupted 卡的确认与续跑都明确拒绝', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const bookId = db.run("INSERT INTO books (title) VALUES ('HTTP中断')").lastInsertRowid;
  const action = actionStore.create(bookId, 'create_chapter', { title: '中断章' }, { sessionId: 'agent:smoke' });
  db.run("UPDATE chat_actions SET status = 'interrupted', recovery_reason = 'restart_during_execution' WHERE id = ?", [action.id]);
  const chaptersBefore = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  const http = await listen(createApp());
  t.after(() => http.close());

  const confirmChat = await fetch(http.baseUrl + '/api/books/' + bookId + '/chat-actions/' + action.id + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true }),
  });
  assert.equal(confirmChat.status, 409);
  assert.equal((await confirmChat.json()).code, 'ACTION_REQUIRES_REVIEW');

  const confirmAgent = await fetch(http.baseUrl + '/api/agent/actions/' + action.id + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true, session_id: 'smoke' }),
  });
  assert.equal(confirmAgent.status, 409);
  assert.equal((await confirmAgent.json()).error.code, 'ACTION_REQUIRES_REVIEW');

  const resumeAgent = await fetch(http.baseUrl + '/api/agent/actions/' + action.id + '/resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '继续' }], session_id: 'smoke' }),
  });
  assert.equal(resumeAgent.status, 409);
  assert.equal((await resumeAgent.json()).error.code, 'ACTION_REQUIRES_REVIEW');

  const chaptersAfter = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n;
  assert.equal(chaptersAfter, chaptersBefore, '任何入口都不得执行业务');
});

test('HTTP：Agent 重复确认已结算卡返回同一结果', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const { createApp } = require('../server/app');
  const { listen } = require('./helpers/http');
  const { installFetchStub } = require('./helpers/llm-stub');
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const bookId = db.run("INSERT INTO books (title) VALUES ('Agent幂等')").lastInsertRowid;
  const action = actionStore.create(bookId, 'set_master_outline', { outline: '新大纲' }, { sessionId: 'agent:idem' });
  const http = await listen(createApp());
  t.after(() => http.close());

  const first = await fetch(http.baseUrl + '/api/agent/actions/' + action.id + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true, session_id: 'idem' }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, 'approved');

  const retry = await fetch(http.baseUrl + '/api/agent/actions/' + action.id + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true, session_id: 'idem' }),
  });
  assert.equal(retry.status, 200);
  const retryBody = await retry.json();
  assert.equal(retryBody.status, 'approved');
  assert.deepEqual(retryBody.result, firstBody.result);
});

test('确认卡记录发起运行 run_id（创建时快照）', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('run书')").lastInsertRowid;
  const { requestConfirmation } = require('../server/tools/executor');
  const wrapped = requestConfirmation({
    profile: 'writing', sessionId: 'writing:book:' + bookId, bookId, source: 'writing-chat', runId: 'run_test_abc',
  }, 'create_chapter', { title: '带运行章' });
  assert.equal(wrapped.status, 'confirmation_required');
  const action = actionStore.get(wrapped.confirmation.id);
  assert.equal(action.runId, 'run_test_abc');
});
