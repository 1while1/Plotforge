// S3-01 / C10-A：服务端会话、消息与工具证据存储（01-架构与接口契约 §4/§5）。
//   会话按空间（agent/writing）与范围（book/global）隔离；消息保留在既有 messages 表、
//   按新 conversation_id 归属；工具事实（toolFacts）只能由服务端写入并跨轮可读；
//   旧消息按书归档进 legacy-writing 会话：主键/内容/关联不动、绝不伪造 bookId=0。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { MIGRATIONS } = require('../server/migrations');

// 接口缺失也是断言的一部分（红测阶段给出可读的失败原因，而非 import 崩溃）
function loadService() {
  try { return require('../server/conversations/service'); } catch { return null; }
}

function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const PRE_COLUMNS = 'id, book_id, role, content, reasoning, compressed, tools_json, source, created_at';

// —— 迁移前形态库：SCHEMA + 015/017 的消息列 + 028 之外全部版本已应用（真实 027 时代形态）——
async function createPreConversationsSeed() {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath, migrateVersions: false });
  // migrateVersions:false 不跑版本化迁移，015/017 的列需手工补齐（027 时代库均有）
  db.exec("ALTER TABLE messages ADD COLUMN tools_json TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  // ensureCriticalIndexes 还会触碰 003/004 建的表：补最小形态占位（只建索引需要）
  db.exec('CREATE TABLE IF NOT EXISTS story_events (id INTEGER PRIMARY KEY, book_id INTEGER, chapter_id INTEGER, narrative_sequence INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS llm_calls (id INTEGER PRIMARY KEY, book_id INTEGER)');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  const appliedAt = new Date().toISOString();
  for (const m of MIGRATIONS) {
    if (m.version === 'conversations_v1') continue;
    db.run('INSERT INTO schema_versions (version, applied_at, checksum) VALUES (?, ?, ?)',
      [m.version, appliedAt, m.contentChecksum || m.checksum || 'seed']);
  }
  const bookA = db.run("INSERT INTO books (title) VALUES ('甲书')").lastInsertRowid;
  const bookB = db.run("INSERT INTO books (title) VALUES ('乙书')").lastInsertRowid;
  const ins = (bookId, role, content, extra = {}) => db.run(
    `INSERT INTO messages (book_id, role, content, reasoning, compressed, tools_json, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [bookId, role, content, extra.reasoning || '', extra.compressed || 0, extra.tools_json || '', extra.source || '']
  ).lastInsertRowid;
  ins(bookA, 'user', '甲书写作提问', { source: 'writing' });
  ins(bookA, 'assistant', '甲书回答', { source: 'writing', tools_json: '[{"name":"read_chapter","kind":"tool"}]' });
  ins(bookA, 'tool', '{"chapterId":9}', { source: 'writing' });
  ins(bookA, 'user', '甲书阅读页留言', { source: 'read' });
  ins(bookA, 'assistant', '甲书已压缩旧轮', { compressed: 1 });
  ins(bookA, 'assistant', '甲书压缩存档', { compressed: 2, reasoning: '思考痕迹' });
  ins(bookB, 'user', '乙书写作提问', { source: 'writing' });
  ins(bookB, 'user', '乙书助手页消息', { source: 'agent' });
  const preRows = db.all(`SELECT ${PRE_COLUMNS} FROM messages ORDER BY id`);
  db.saveNow();
  db.close();
  return { ...location, bookA, bookB, preRows, preHash: hashRows(preRows) };
}

test('028 迁移：旧消息按书归入 legacy-writing 会话且逐行不动、二次迁移幂等', async t => {
  const seed = await createPreConversationsSeed();
  t.after(() => cleanup(seed));
  await db.init({ filePath: seed.filePath });

  const hasTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'");
  assert.ok(hasTable, '028 迁移必须建立 conversations 表');

  // 迁移前后逐行逐列对照（主键/内容/关联不变；条数与哈希）
  const postRows = db.all(`SELECT ${PRE_COLUMNS} FROM messages ORDER BY id`);
  assert.equal(postRows.length, seed.preRows.length, `消息条数必须不变（前 ${seed.preRows.length} 后 ${postRows.length}）`);
  assert.deepEqual(postRows, seed.preRows, '迁移后全部旧列必须逐行逐列原样');
  assert.equal(hashRows(postRows), seed.preHash);

  // 每书恰一个 legacy-writing 会话，全部该书消息（含 read 来源与已压缩行）归入其中
  const convA = db.get("SELECT * FROM conversations WHERE kind='writing' AND book_id=?", [seed.bookA]);
  assert.ok(convA, '甲书必须有 legacy-writing 会话');
  assert.equal(convA.scope, 'book');
  assert.equal(convA.status, 'active', 'legacy 会话必须可用（旧调用继续写入）');
  const convB = db.get("SELECT * FROM conversations WHERE kind='writing' AND book_id=?", [seed.bookB]);
  assert.ok(convB);
  assert.equal(db.get("SELECT COUNT(*) n FROM conversations WHERE kind='writing'").n, 2);
  for (const [bookId, convId] of [[seed.bookA, convA.id], [seed.bookB, convB.id]]) {
    const rows = db.all('SELECT conversation_id FROM messages WHERE book_id = ?', [bookId]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.conversation_id === convId), '该书全部消息（含 read 来源/压缩行）必须归入 legacy 会话');
  }

  // 新列就位；全局无伪造 bookId=0（此时还没有 global 会话，book_id IS NULL 的会话数为 0）
  const cols = db.all('PRAGMA table_info(messages)').map(c => c.name);
  assert.ok(cols.includes('conversation_id'));
  assert.ok(cols.includes('tool_facts_json'));
  assert.equal(db.get('SELECT COUNT(*) n FROM conversations WHERE book_id IS NOT NULL AND book_id = 0').n, 0);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), [], '外键完整性检查必须为空');

  // 二次 init：不重复创建会话、不动消息
  db.close();
  await db.init({ filePath: seed.filePath });
  assert.equal(db.get("SELECT COUNT(*) n FROM conversations WHERE kind='writing'").n, 2, '二次迁移不得重复创建 legacy 会话');
  assert.equal(db.get('SELECT COUNT(*) n FROM messages').n, postRows.length);
});

test('028 迁移：全新空库正常建立会话表且不产生 legacy 会话', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  assert.ok(tables.has('conversations'));
  assert.ok(tables.has('conversation_summaries'));
  assert.equal(db.get('SELECT COUNT(*) n FROM conversations').n, 0, '无旧消息的库不应创建 legacy 会话');
});

test('会话服务：创建校验（writing 必须挂书、global 不带书、书必须存在）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc, '会话服务模块 server/conversations/service.js 必须存在');
  const bookId = db.run("INSERT INTO books (title) VALUES ('服务校验书')").lastInsertRowid;

  const writing = svc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '写作一' });
  assert.equal(writing.kind, 'writing');
  assert.equal(writing.scope, 'book');
  assert.equal(writing.status, 'active');
  const globalAgent = svc.createConversation({ kind: 'agent', scope: 'global', title: '全局' });
  assert.equal(globalAgent.book_id, null);
  const bookAgent = svc.createConversation({ kind: 'agent', scope: 'book', bookId });
  assert.equal(bookAgent.book_id, bookId);

  assert.throws(() => svc.createConversation({ kind: 'writing', scope: 'global', title: 'x' }), e => e.status === 400);
  assert.throws(() => svc.createConversation({ kind: 'writing', scope: 'book' }), e => e.status === 400);
  assert.throws(() => svc.createConversation({ kind: 'agent', scope: 'global', bookId }), e => e.status === 400);
  assert.throws(() => svc.createConversation({ kind: 'agent', scope: 'book', bookId: 99999 }), e => e.status === 404);
  assert.throws(() => svc.createConversation({ kind: 'chat', scope: 'book', bookId }), e => e.status === 400);
});

test('会话服务：两本书 × agent/writing 各两会话 + 一个 global，历史与工具证据严格隔离', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookA = db.run("INSERT INTO books (title) VALUES ('隔离甲')").lastInsertRowid;
  const bookB = db.run("INSERT INTO books (title) VALUES ('隔离乙')").lastInsertRowid;

  const conv = {};
  for (const [bookId, label] of [[bookA, 'A'], [bookB, 'B']]) {
    conv[`${label}Agent1`] = svc.createConversation({ kind: 'agent', scope: 'book', bookId, title: `${label}A1` });
    conv[`${label}Agent2`] = svc.createConversation({ kind: 'agent', scope: 'book', bookId, title: `${label}A2` });
    conv[`${label}Writing1`] = svc.createConversation({ kind: 'writing', scope: 'book', bookId, title: `${label}W1` });
    conv[`${label}Writing2`] = svc.createConversation({ kind: 'writing', scope: 'book', bookId, title: `${label}W2` });
  }
  conv.global = svc.createConversation({ kind: 'agent', scope: 'global', title: '全局' });

  // 每个会话注入专属哨兵；工具事实挂服务端 appendMessage
  for (const [key, c] of Object.entries(conv)) {
    svc.appendMessage({ conversationId: c.id, role: 'user', content: `SENTINEL_${key}` });
  }
  svc.appendMessage({
    conversationId: conv.AWriting1.id, role: 'tool', content: '读取完成',
    toolFacts: { chapterId: 11, revision: 7, kind: 'chapter_read' },
  });
  svc.appendMessage({
    conversationId: conv.global.id, role: 'tool', content: '全局检索完成',
    toolFacts: { scope: 'global', kind: 'book_search', query: '隔离' },
  });

  const textOf = (ctx) => ctx.messages.map(m => m.content).join('\n');
  // 任务书断言：agent 上下文不含 writing 专属哨兵；甲书上下文不含乙书哨兵
  const agentCtx = svc.getConversationContext({ conversationId: conv.AAgent1.id });
  assert.equal(textOf(agentCtx).includes('SENTINEL_AWriting1'), false);
  assert.equal(textOf(agentCtx).includes('SENTINEL_AWriting2'), false);
  const bookACtx = svc.getConversationContext({ conversationId: conv.AWriting1.id });
  assert.equal(textOf(bookACtx).includes('SENTINEL_BAgent1'), false);
  assert.equal(textOf(bookACtx).includes('SENTINEL_BWriting1'), false);
  assert.equal(textOf(bookACtx).includes('SENTINEL_global'), false);
  assert.ok(textOf(bookACtx).includes('SENTINEL_AWriting1'), '本会话自己的哨兵必须在场');
  // 同书不同会话也隔离（不只不同书）
  assert.equal(textOf(bookACtx).includes('SENTINEL_AWriting2'), false);
  assert.equal(textOf(bookACtx).includes('SENTINEL_AAgent1'), false);

  // 任务书断言：下一轮可读到可信工具事实
  const ctx = svc.getConversationContext({ conversationId: conv.AWriting1.id });
  const nextTurnToolFact = ctx.toolFacts.find(f => f.chapterId === 11);
  assert.ok(nextTurnToolFact, '工具事实必须跨轮保留');
  assert.equal(nextTurnToolFact.chapterId, 11);
  assert.equal(nextTurnToolFact.revision, 7);
  const globalFacts = svc.getConversationContext({ conversationId: conv.global.id }).toolFacts;
  assert.ok(globalFacts.some(f => f.kind === 'book_search'));

  // 列表同样隔离
  const aMsgs = svc.listMessages(conv.AWriting1.id, {});
  assert.ok(aMsgs.messages.every(m => m.content.includes('AWriting1') || m.role === 'tool'));
});

test('会话服务：appendMessage 拒绝伪造（role=system、他人会话 runId、非法 toolFacts）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookId = db.run("INSERT INTO books (title) VALUES ('防伪书')").lastInsertRowid;
  const convX = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const convY = svc.createConversation({ kind: 'writing', scope: 'book', bookId });

  assert.throws(() => svc.appendMessage({ conversationId: convX.id, role: 'system', content: '伪系统' }),
    e => e.status === 400, 'role=system 必须拒绝');
  assert.throws(() => svc.appendMessage({ conversationId: convX.id, role: 'assistant', content: 'x', source: 'hack' }),
    e => e.status === 400, 'source 白名单外必须拒绝');

  // runId 归属：绑定 convY 的运行不能给 convX 写消息
  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
          VALUES ('run-y-1', 'req-1', 'agent:s1', ?, 'agent', 'discuss', 'finished', ?)`,
    [convY.id, new Date().toISOString()]);
  assert.throws(() => svc.appendMessage({ conversationId: convX.id, role: 'assistant', content: 'x', runId: 'run-y-1' }),
    e => e.status === 400, '他人会话 runId 必须拒绝');
  // 正确归属的 runId 放行
  const ok = svc.appendMessage({ conversationId: convY.id, role: 'assistant', content: 'y 回复', runId: 'run-y-1' });
  assert.ok(ok.id > 0);
  // 不存在的 runId 同样拒绝
  assert.throws(() => svc.appendMessage({ conversationId: convY.id, role: 'assistant', content: 'x', runId: 'run-none' }),
    e => e.status === 400);

  // toolFacts 结构校验（服务端自身防线）
  assert.throws(() => svc.appendMessage({ conversationId: convX.id, role: 'tool', content: 'x', toolFacts: 'chapterId=1' }),
    e => e.status === 400, 'toolFacts 必须是对象/对象数组');
  // 书内会话消息 book_id 落会话的书；写入后行带 toolFacts
  svc.appendMessage({ conversationId: convX.id, role: 'tool', content: '读', toolFacts: { chapterId: 3, revision: 2 } });
  const row = db.get('SELECT book_id, tool_facts_json FROM messages WHERE conversation_id = ? AND role = ?', [convX.id, 'tool']);
  assert.equal(row.book_id, bookId);
  assert.equal(JSON.parse(row.tool_facts_json).chapterId, 3);
});

test('会话服务：归档不是删史、不丢待确认动作归属；活跃运行期间 409', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookId = db.run("INSERT INTO books (title) VALUES ('归档书')").lastInsertRowid;
  const conv = svc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '待归档' });
  svc.appendMessage({ conversationId: conv.id, role: 'user', content: '归档前消息' });

  // 待确认动作挂在书的会话键上：归档不得影响其归属
  const now = Date.now();
  db.run(`INSERT INTO chat_actions (id, book_id, name, args_json, args_hash, session_id, status, summary, impact_json, created_at, expires_at)
          VALUES ('act-arch-1', ?, 'append_chapter', '{}', 'h', 'writing:book:' || ?, 'pending', '待确认', '[]', ?, ?)`,
    [bookId, bookId, now, now + 3600_000]);

  // 活跃运行：归档 409
  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
          VALUES ('run-arch-1', 'req-a', 'writing:book:' || ?, ?, 'chat', 'write', 'running', ?)`,
    [bookId, conv.id, new Date().toISOString()]);
  assert.throws(() => svc.archiveConversation(conv.id), e => e.status === 409, '活跃运行期间归档必须 409');

  // 运行结束后归档成功；历史可查、动作不动、新消息拒绝
  db.run("UPDATE agent_runs SET status = 'finished' WHERE id = 'run-arch-1'");
  const archived = svc.archiveConversation(conv.id);
  assert.equal(archived.status, 'archived');
  const after = svc.listMessages(conv.id, {});
  assert.ok(after.messages.some(m => m.content === '归档前消息'), '归档不是删史：消息必须仍在');
  const actRow = db.get('SELECT * FROM chat_actions WHERE id = ?', ['act-arch-1']);
  assert.equal(actRow.status, 'pending');
  assert.equal(actRow.session_id, `writing:book:${bookId}`, '待确认动作不得失去归属');
  assert.throws(() => svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'x' }),
    e => e.status === 409, '已归档会话必须拒绝追加');
});

test('会话服务：global 消息不伪造 bookId、删书后 global 会话存活', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookId = db.run("INSERT INTO books (title) VALUES ('将被删的书')").lastInsertRowid;
  const bookConv = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const globalConv = svc.createConversation({ kind: 'agent', scope: 'global', title: '全局' });
  svc.appendMessage({ conversationId: bookConv.id, role: 'user', content: '书内消息' });
  svc.appendMessage({ conversationId: globalConv.id, role: 'user', content: '全局消息' });

  const globalRow = db.get('SELECT book_id FROM messages WHERE conversation_id = ?', [globalConv.id]);
  assert.equal(globalRow.book_id, null, 'global 会话消息 book_id 必须为 NULL，不得伪造 bookId=0');

  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  assert.ok(svc.getConversation(globalConv.id), '删书不得级联删 global 会话');
  const msgs = svc.listMessages(globalConv.id, {});
  assert.equal(msgs.messages.length, 1, 'global 消息必须存活');
  assert.equal(svc.getConversation(bookConv.id), null, '书内会话随书级联删除');
});

test('会话服务：消息分页游标稳定排序', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookId = db.run("INSERT INTO books (title) VALUES ('分页书')").lastInsertRowid;
  const conv = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  for (let i = 1; i <= 25; i++) {
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: `第${i}条` });
  }
  const page1 = svc.listMessages(conv.id, { afterId: 0, limit: 10 });
  assert.equal(page1.messages.length, 10);
  assert.equal(page1.messages[0].content, '第1条');
  assert.equal(page1.messages[9].content, '第10条');
  const page2 = svc.listMessages(conv.id, { afterId: page1.messages[9].id, limit: 10 });
  assert.equal(page2.messages[0].content, '第11条');
  const page3 = svc.listMessages(conv.id, { afterId: page2.messages[9].id, limit: 10 });
  assert.equal(page3.messages.length, 5);
  assert.equal(page3.messages[4].content, '第25条');
});

test('整册备份：包含书内会话/消息/摘要，global 不入书备份，旧版备份恢复不孤儿', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const svc = loadService();
  assert.ok(svc);
  const bookBackup = require('../server/bookBackup');
  const bookId = db.run("INSERT INTO books (title) VALUES ('备份书')").lastInsertRowid;
  const conv = svc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '备份会话' });
  svc.appendMessage({ conversationId: conv.id, role: 'user', content: '备份消息一' });
  svc.appendMessage({ conversationId: conv.id, role: 'tool', content: '读', toolFacts: { chapterId: 5, revision: 3 } });
  const globalConv = svc.createConversation({ kind: 'agent', scope: 'global', title: '不进书备份' });
  svc.appendMessage({ conversationId: globalConv.id, role: 'user', content: '全局不应入书备份' });

  const exported = bookBackup.exportBookBackup(bookId);
  assert.ok(exported.file);
  const data = JSON.parse(fs.readFileSync(path.join(path.dirname(db.getFilePath()), 'backups', exported.file), 'utf8'));
  const convIds = (data.tables.conversations || []).map(c => c.id);
  assert.ok(convIds.includes(conv.id), '书备份必须包含书内会话');
  assert.ok(!convIds.includes(globalConv.id), 'global 会话不得级联进书备份');
  const backupMsgs = data.tables.messages || [];
  assert.ok(backupMsgs.every(m => m.conversation_id === conv.id));
  assert.ok(backupMsgs.some(m => m.tool_facts_json && JSON.parse(m.tool_facts_json).chapterId === 5), '工具事实随备份保留');

  // 删书（级联清空）→ 恢复 → 会话与消息原样回来
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  assert.equal(svc.getConversation(conv.id), null);
  const restored = bookBackup.restoreBookBackup(exported.file);
  assert.equal(restored.book.id, bookId);
  const msgs = svc.listMessages(conv.id, {});
  assert.equal(msgs.messages.length, 2, '恢复后消息数量一致');
  const ctx = svc.getConversationContext({ conversationId: conv.id });
  assert.ok(ctx.toolFacts.some(f => f.chapterId === 5), '恢复后工具事实可查');
  assert.ok(svc.getConversation(globalConv.id), 'global 会话不受书删除/恢复影响');

  // 旧版（028 前）备份：messages 无 conversation_id 节 → 恢复时孤儿消息归入重建的 legacy 会话
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  const legacy = JSON.parse(JSON.stringify(data));
  delete legacy.tables.conversations;
  delete legacy.tables.conversation_summaries;
  for (const m of legacy.tables.messages || []) delete m.conversation_id;
  const dir = path.join(path.dirname(db.getFilePath()), 'backups');
  const legacyName = `book-${bookId}-legacytest-20260922-000000.json`;
  fs.writeFileSync(path.join(dir, legacyName), JSON.stringify(legacy));
  bookBackup.restoreBookBackup(legacyName);
  const legacyConv = db.get("SELECT * FROM conversations WHERE kind='writing' AND book_id=?", [bookId]);
  assert.ok(legacyConv, '旧版备份恢复必须补建该书 legacy 会话');
  const orphanCount = db.get('SELECT COUNT(*) n FROM messages WHERE book_id = ? AND conversation_id IS NULL', [bookId]).n;
  assert.equal(orphanCount, 0, '旧版备份恢复后不得留下无归属消息');
});
