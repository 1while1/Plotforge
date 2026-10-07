// S4-04a / 契约 01 §6：规划笔记与显式交接（服务、迁移与 HTTP 契约）。
//   本切片只建存储与服务，不做页面（页面属 S4-04b）：
//   · 规划笔记只是草稿（status=draft）——没有正典效力，绝不写正文/大纲/故事事实；
//   · 交接是显式材料传递：作者选定消息 → 预览（可核对材料与来源）→ 采纳；
//   采纳只向指定 writing 会话追加一条注明来源的消息，不改大纲/正文/事实，
//   不是写权限后门（正式资料更新仍走领域确认与 diff）。
//   红测口径对齐 S4-01a/§11.2：能力在修复前不存在，断言以业务行为表达
//   （404 !== 201、表不存在、模块文件缺失），不用 import 崩溃冒充红测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { listen, json } = require('../helpers/http');

function buildApp() {
  try { return require('../../server/app').createApp(); } catch { return null; }
}

// 内部服务模块：单独以文件存在性断言（修复前缺文件时给出业务语义的失败信息，
// 而不是 require 抛 MODULE_NOT_FOUND 让整个用例炸掉）
function service() {
  const file = path.join(__dirname, '..', '..', 'server', 'conversations', 'handoffs.js');
  assert.ok(fs.existsSync(file), 'server/conversations/handoffs.js 必须存在（S4-04a 规划笔记与交接服务）');
  return require(file);
}

async function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const app = buildApp();
  assert.ok(app, 'server/app.js 必须能构建（并挂载 /api/planning-notes 与 /api/handoffs）');
  const server = await listen(app);
  t.after(() => server.close());
  return server;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 正典快照：正文、大纲（总纲+卷纲）、事件账本与提案。笔记/交接一律不得改动它们。
function canonSnapshot(bookId) {
  const events = db.all('SELECT id, title, summary FROM story_events WHERE book_id = ? ORDER BY id', [bookId]);
  const chapters = db.all('SELECT id, content FROM chapters WHERE book_id = ? ORDER BY id', [bookId]);
  const volumes = db.all('SELECT id, title, intro, outline FROM volumes WHERE book_id = ? ORDER BY id', [bookId]);
  const book = db.get('SELECT master_outline FROM books WHERE id = ?', [bookId]);
  return {
    eventCount: events.length,
    eventHash: sha256(JSON.stringify(events)),
    chapterHash: sha256(JSON.stringify(chapters)),
    outlineHash: sha256(JSON.stringify({ master: book.master_outline, volumes })),
    proposals: db.get('SELECT COUNT(*) AS n FROM event_proposals WHERE book_id = ?', [bookId]).n,
  };
}

function seedBook(title, outline) {
  const bookId = db.run(
    'INSERT INTO books (title, master_outline) VALUES (?, ?)',
    [title, outline === undefined ? '总纲：林野追查灰雁号。' : outline]
  ).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', ?, 1)",
    [bookId, '林野在废弃车站醒来，口袋里只剩半张地图。']
  ).lastInsertRowid;
  db.run(
    "INSERT INTO volumes (book_id, title, intro, outline, sort_order) VALUES (?, '第一卷', '开场', '卷纲：追查灰雁号。', 1)",
    [bookId]
  );
  return { bookId, chapterId };
}

function seedConversation(bookId, kind, scope, title) {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO conversations (id, kind, scope, book_id, title, status, context_policy_json)
     VALUES (?, ?, ?, ?, ?, 'active', '{}')`,
    [id, kind, scope, scope === 'book' ? bookId : null, title]
  );
  return id;
}

function addMessage(bookId, conversationId, role, content, source) {
  return db.run(
    `INSERT INTO messages (book_id, conversation_id, role, content, source, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [bookId, conversationId, role, content, source === undefined ? 'agent' : source]
  ).lastInsertRowid;
}

function countMessages(conversationId) {
  return db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [conversationId]).n;
}

// 一条完整的讨论现场：一本书 + 一个 Agent 讨论会话（4 条消息）+ 两个写作会话
function seedDiscussionScene(t) {
  const { bookId, chapterId } = seedBook('交接测试书');
  const agent = seedConversation(bookId, 'agent', 'book', '《交接测试书》· 叛变推演');
  const writing = seedConversation(bookId, 'writing', 'book', '正文写作');
  const writingOther = seedConversation(bookId, 'writing', 'book', '另一条写作会话');
  const msgAsk = addMessage(bookId, agent, 'user', '讨论：林野会不会叛变？');
  const msgOne = addMessage(bookId, agent, 'assistant', '结论一：林野不会主动叛变，但会在第 12 章被迫隐瞒。');
  const msgTwo = addMessage(bookId, agent, 'assistant', '结论二：副官会因为旧债倒向敌方。');
  const msgNoise = addMessage(bookId, agent, 'assistant', '（未选中的闲聊：今天天气不错）');
  return { bookId, chapterId, agentConvId: agent, writingConvId: writing, writingOtherConvId: writingOther, msgAsk, msgOne, msgTwo, msgNoise };
}

async function createHandoff(baseUrl, body) {
  return json(baseUrl, 'POST', '/api/handoffs', body);
}

// ---------------------------------------------------------------------------
// 迁移与存储
// ---------------------------------------------------------------------------

test('迁移 029：planning_notes / handoffs 表就位，笔记被 CHECK 锁死在 draft', async t => {
  const server = await setup(t);
  assert.ok(server.baseUrl);
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  assert.equal(tables.has('planning_notes'), true, '迁移 029 必须建立 planning_notes 表');
  assert.equal(tables.has('handoffs'), true, '迁移 029 必须建立 handoffs 表');
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'planning_handoffs_v1'").n, 1);

  const noteCols = new Set(db.all('PRAGMA table_info(planning_notes)').map(c => c.name));
  for (const col of ['id', 'conversation_id', 'book_id', 'title', 'text', 'selected_message_ids', 'revision', 'status', 'created_at', 'updated_at']) {
    assert.equal(noteCols.has(col), true, `planning_notes 缺列 ${col}`);
  }
  const handoffCols = new Set(db.all('PRAGMA table_info(handoffs)').map(c => c.name));
  for (const col of ['id', 'book_id', 'origin_conversation_id', 'target_conversation_id', 'selected_message_ids', 'text', 'source_refs', 'status', 'accepted_at', 'created_at']) {
    assert.equal(handoffCols.has(col), true, `handoffs 缺列 ${col}`);
  }
  // status 枚举在库层受限：不接受任意伪造状态
  const bookId = seedBook('约束测试书').bookId;
  const conv = seedConversation(bookId, 'agent', 'book', '约束会话');
  const noteId = crypto.randomUUID();
  db.run(
    "INSERT INTO planning_notes (id, conversation_id, book_id, title, text) VALUES (?, ?, ?, 'n', 't')",
    [noteId, conv, bookId]
  );
  assert.throws(
    () => db.run("UPDATE planning_notes SET status = 'accepted' WHERE id = ?", [noteId]),
    /CHECK|constraint/i,
    '规划笔记不得被标成 accepted（笔记没有正典效力）'
  );
  assert.throws(
    () => db.run(
      "INSERT INTO handoffs (id, book_id, origin_conversation_id, target_conversation_id, status) VALUES (?, ?, ?, ?, 'adopted')",
      [crypto.randomUUID(), bookId, conv, conv]
    ),
    /CHECK|constraint/i,
    'handoffs.status 只接受 draft/accepted/cancelled'
  );
});

test('规划笔记：选定两条结论存草稿后，正文/大纲/事件账本与提案逐位不变', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const before = canonSnapshot(scene.bookId);

  const created = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId,
    title: '叛变线两条结论',
    text: '林野不会主动叛变但会隐瞒；副官因旧债倒戈。',
    selectedMessageIds: [scene.msgOne, scene.msgTwo],
  });
  assert.equal(created.status, 201, 'POST /api/planning-notes 必须能创建草稿笔记');
  assert.equal(created.body.status, 'draft', '规划笔记只能是草稿');
  assert.equal(created.body.revision, 1, '新笔记 revision 从 1 起');
  assert.equal(created.body.bookId, scene.bookId);
  assert.deepEqual(created.body.selectedMessageIds, [scene.msgOne, scene.msgTwo]);

  const after = canonSnapshot(scene.bookId);
  const canonicalEventCountAfterNote = after.eventCount;
  const canonicalEventCountBeforeNote = before.eventCount;
  assert.equal(canonicalEventCountAfterNote, canonicalEventCountBeforeNote, '存笔记不得写入 story_events');
  assert.equal(after.eventHash, before.eventHash, '事件账本内容不得变化');
  assert.equal(after.chapterHash, before.chapterHash, '正文不得变化');
  assert.equal(after.outlineHash, before.outlineHash, '大纲不得变化');
  assert.equal(after.proposals, 0, '笔记不是提案：不得生成待审提案');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM story_events WHERE book_id = ?', [scene.bookId]).n, 0);
  // 未选中的讨论与笔记正文都不进正典
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM story_events WHERE summary LIKE '%叛变%' OR title LIKE '%叛变%'").n, 0);
  assert.equal(JSON.stringify(created.body).includes('今天天气不错'), false, '未选中的讨论不得进笔记');
});

test('规划笔记：乐观锁 revision 单调，428/409/400 语义与列表范围隔离', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherBook = seedBook('另一本书');
  const otherConv = seedConversation(otherBook.bookId, 'agent', 'book', '他书会话');

  const created = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, title: '草稿', text: '初稿', selectedMessageIds: [scene.msgOne],
  });
  assert.equal(created.status, 201);
  const noteId = created.body.id;

  const missing = await json(server.baseUrl, 'PUT', `/api/planning-notes/${noteId}`, { text: '改稿' });
  assert.equal(missing.status, 428, '缺 expectedRevision 必须 428');
  assert.equal(missing.body.error.code, 'NOTE_REVISION_REQUIRED');

  const conflict = await json(server.baseUrl, 'PUT', `/api/planning-notes/${noteId}`,
    { expectedRevision: 99, text: '改稿' });
  assert.equal(conflict.status, 409, '版本不符必须 409');
  assert.equal(conflict.body.error.code, 'NOTE_CONFLICT');
  assert.equal(conflict.body.error.details.currentRevision, 1);

  const updated = await json(server.baseUrl, 'PUT', `/api/planning-notes/${noteId}`,
    { expectedRevision: 1, title: '草稿二', text: '第二版' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.revision, 2, 'revision 必须单调递增');
  assert.equal(updated.body.text, '第二版');
  assert.equal(updated.body.status, 'draft');
  // 旧版本再提交一次仍冲突（不能回退版本）
  const stale = await json(server.baseUrl, 'PUT', `/api/planning-notes/${noteId}`,
    { expectedRevision: 1, text: '回退尝试' });
  assert.equal(stale.status, 409);
  assert.equal(db.get('SELECT revision, text FROM planning_notes WHERE id = ?', [noteId]).text, '第二版');

  // 列表：按书 / 按会话过滤，不串他书
  const byBook = await json(server.baseUrl, 'GET', `/api/planning-notes?bookId=${scene.bookId}`);
  assert.equal(byBook.status, 200);
  assert.deepEqual(byBook.body.notes.map(n => n.id), [noteId]);
  const byOtherBook = await json(server.baseUrl, 'GET', `/api/planning-notes?bookId=${otherBook.bookId}`);
  assert.equal(byOtherBook.body.notes.length, 0, '不得列出他书笔记');
  const byOtherConv = await json(server.baseUrl, 'GET', `/api/planning-notes?conversationId=${otherConv}`);
  assert.equal(byOtherConv.body.notes.length, 0, '不得列出他会话笔记');
  const noScope = await json(server.baseUrl, 'GET', '/api/planning-notes');
  assert.equal(noScope.status, 400, '无范围查询必须 400（不给全库笔记出口）');

  // 客户端不得伪造服务端字段（status/acceptedAt/revision 等一律 400）
  const forged = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, text: 'x', status: 'accepted',
  });
  assert.equal(forged.status, 400, '伪造 status 必须 400');
  const forgedPut = await json(server.baseUrl, 'PUT', `/api/planning-notes/${noteId}`,
    { expectedRevision: 2, status: 'accepted' });
  assert.equal(forgedPut.status, 400, 'PUT 伪造 status 必须 400');
  assert.equal(db.get('SELECT status FROM planning_notes WHERE id = ?', [noteId]).status, 'draft');
});

test('规划笔记：选定消息必须属于来源会话，他书消息一律拒绝', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherBook = seedBook('他书');
  const otherConv = seedConversation(otherBook.bookId, 'agent', 'book', '他书会话');
  const otherMsg = addMessage(otherBook.bookId, otherConv, 'assistant', '他书结论哨兵');

  const foreign = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, text: '夹带他书', selectedMessageIds: [otherMsg],
  });
  assert.equal(foreign.status, 400, '选中的消息必须属于来源会话');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM planning_notes').n, 0, '被拒请求不得留下笔记');

  const missingConv = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: crypto.randomUUID(), text: 'x',
  });
  assert.equal(missingConv.status, 404);
  const emptyText = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, text: '   ',
  });
  assert.equal(emptyText.status, 400, '空文本笔记必须 400');
});

// ---------------------------------------------------------------------------
// 交接草案、预览与采纳
// ---------------------------------------------------------------------------

test('交接草案：预览材料只含作者选定文本与来源，不含未选讨论与他书正文', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherBook = seedBook('他书正文');
  db.run("UPDATE chapters SET content = '另一本书的正文哨兵' WHERE book_id = ?", [otherBook.bookId]);

  const created = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne, scene.msgTwo],
    text: '把这两条结论带进正文写作。',
    sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(created.status, 201, 'POST /api/handoffs 必须能创建草案');
  const handoff = created.body;
  assert.equal(handoff.status, 'draft');
  assert.equal(handoff.bookId, scene.bookId);
  assert.equal(handoff.material.text, '把这两条结论带进正文写作。');
  assert.equal(handoff.material.excerpts.length, 2, '材料只含选定的两条消息');
  assert.ok(handoff.material.excerpts[0].excerpt.includes('林野不会主动叛变'));
  assert.ok(handoff.material.excerpts[1].excerpt.includes('副官会因为旧债'));
  assert.ok(handoff.sourceFingerprint, '草案必须带来源指纹');

  const raw = JSON.stringify(handoff);
  assert.equal(raw.includes('今天天气不错'), false, '未选中的讨论不得进交接材料');
  assert.equal(raw.includes('林野会不会叛变'), false, '未选中的消息不得进交接材料');
  assert.equal(raw.includes('另一本书的正文哨兵'), false, '不得夹带其他书正文');
  assert.equal(raw.includes('总纲：林野追查灰雁号'), false, '不得夹带整书资料');

  const preview = await json(server.baseUrl, 'GET', `/api/handoffs/${handoff.id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sourceFingerprint, handoff.sourceFingerprint, '未变更时指纹稳定');
  assert.equal(preview.body.material.excerpts.length, 2);
  assert.equal(preview.body.target.conversationId, scene.writingConvId);
  assert.equal(preview.body.target.title, '正文写作');

  const missing = await json(server.baseUrl, 'GET', `/api/handoffs/${crypto.randomUUID()}`);
  assert.equal(missing.status, 404);
});

test('跨书交接 409；错误目标与非写作目标分别拒绝', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherBook = seedBook('乙书');
  const otherWriting = seedConversation(otherBook.bookId, 'writing', 'book', '乙书写作用');

  const crossBookHandoffResponse = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: otherWriting,
    text: '跨书交接',
  });
  assert.equal(crossBookHandoffResponse.status, 409, '跨书交接必须 409');
  assert.equal(crossBookHandoffResponse.body.error.code, 'HANDOFF_CROSS_BOOK');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs').n, 0, '被拒草案不得落库');

  // 目标不存在 / 目标是 agent 会话
  const noTarget = await json(server.baseUrl, 'POST', '/api/handoffs', {
    originConversationId: scene.agentConvId, text: 'x',
  });
  assert.equal(noTarget.status, 400, '必须由作者明确选定目标会话');
  const badTarget = await json(server.baseUrl, 'POST', '/api/handoffs', {
    originConversationId: scene.agentConvId, targetConversationId: crypto.randomUUID(), text: 'x',
  });
  assert.equal(badTarget.status, 404);
  const agentTarget = await json(server.baseUrl, 'POST', '/api/handoffs', {
    originConversationId: scene.agentConvId, targetConversationId: scene.agentConvId, text: 'x',
  });
  assert.equal(agentTarget.status, 400, '交接目标必须是写作会话');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs').n, 0);
});

test('global→book：目标必须显式选定，来源只能属于目标或明确通用', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherBook = seedBook('丙书');
  const global = seedConversation(null, 'agent', 'global', '全局资源讨论');
  const globalMsg = addMessage(null, global, 'assistant', '全局讨论结论：副官线可以更早埋。');

  const created = await createHandoff(server.baseUrl, {
    originConversationId: global,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [globalMsg],
    text: '全局讨论的结论交给这本书的写作。',
    sourceRefs: [{ kind: 'general', label: '共享作家卡：去 AI 味·通用' }],
  });
  assert.equal(created.status, 201, 'global→book 必须由作者选定目标后成立');
  assert.equal(created.body.bookId, scene.bookId, '归属取目标会话所属书');
  assert.equal(created.body.material.sourceRefs[0].kind, 'general');

  // 他书章节作为来源引用：拒绝（只能属于目标或明确通用）
  const foreignRef = await createHandoff(server.baseUrl, {
    originConversationId: global,
    targetConversationId: scene.writingConvId,
    text: '夹带他书章节',
    sourceRefs: [{ kind: 'chapter', id: db.get('SELECT id FROM chapters WHERE book_id = ?', [otherBook.bookId]).id }],
  });
  assert.equal(foreignRef.status, 409, '他书章节引用必须 409');
  assert.equal(foreignRef.body.error.code, 'HANDOFF_SOURCE_FOREIGN_BOOK');

  // 未知来源类型 / 无材料的空草案
  const unknownRef = await createHandoff(server.baseUrl, {
    originConversationId: global, targetConversationId: scene.writingConvId,
    text: 'x', sourceRefs: [{ kind: 'sql', id: 1 }],
  });
  assert.equal(unknownRef.status, 400, '未知来源类型必须 400');
  const empty = await createHandoff(server.baseUrl, {
    originConversationId: global, targetConversationId: scene.writingConvId, text: '',
  });
  assert.equal(empty.status, 400, '无材料空草案必须 400');
});

test('采纳：只向指定写作会话追加一条注明来源的消息，重复点击仍一条', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const otherWritingBefore = countMessages(scene.writingOtherConvId);
  const before = canonSnapshot(scene.bookId);
  const msgCountBefore = countMessages(scene.writingConvId);

  const created = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne, scene.msgTwo],
    text: '把这两条结论带进正文写作。',
    sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(created.status, 201);
  const fingerprint = created.body.sourceFingerprint;

  const accepted = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/accept`,
    { expectedSourceFingerprint: fingerprint });
  assert.equal(accepted.status, 200, '采纳必须成功');
  assert.equal(accepted.body.status, 'accepted');
  assert.ok(accepted.body.acceptedAt, '采纳必须记录 acceptedAt');
  assert.equal(accepted.body.duplicate, false);
  const handoffMessagesAfterAccept = countMessages(scene.writingConvId) - msgCountBefore;
  assert.equal(handoffMessagesAfterAccept, 1, '采纳只追加一条交接消息');
  const row = db.get('SELECT id, conversation_id, role, content, source FROM messages WHERE id = ?', [accepted.body.messageId]);
  assert.equal(row.conversation_id, scene.writingConvId);
  assert.equal(row.role, 'user');
  assert.equal(row.source, 'system', '交接消息是服务端生成的入站材料');
  assert.ok(row.content.includes('把这两条结论带进正文写作。'), '消息必须含作者写下的摘要');
  assert.ok(row.content.includes('林野不会主动叛变'), '消息必须含选定结论');
  assert.ok(row.content.includes(scene.agentConvId), '消息必须注明来源会话');
  assert.ok(row.content.includes(`#${scene.msgOne}`) && row.content.includes(`#${scene.msgTwo}`), '消息必须注明选定消息');

  // 重复点击：同一 handoff 仍只有一条消息
  const again = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/accept`,
    { expectedSourceFingerprint: fingerprint });
  assert.equal(again.status, 200, '重复点击必须幂等返回而不是报错');
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.messageId, accepted.body.messageId, '重复采纳返回同一条消息');
  const handoffMessagesAfterDoubleAccept = countMessages(scene.writingConvId) - msgCountBefore;
  assert.equal(handoffMessagesAfterDoubleAccept, 1, '重复点击仍一条');
  const otherWritingConversationChanged = countMessages(scene.writingOtherConvId) !== otherWritingBefore;
  assert.equal(otherWritingConversationChanged, false, '其他写作会话不得被写入');

  const after = canonSnapshot(scene.bookId);
  assert.equal(after.eventCount, before.eventCount, '采纳不得写故事事实');
  assert.equal(after.chapterHash, before.chapterHash, '采纳不得改正文');
  assert.equal(after.outlineHash, before.outlineHash, '采纳不得改大纲');
  assert.equal(after.proposals, before.proposals, '采纳不得生成提案');

  // 缺指纹 / 错指纹（在**未采纳**的新草案上，已采纳的那张是幂等路径）
  const fresh = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId,
    text: '第二张草案', sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(fresh.status, 201);
  const noFingerprint = await json(server.baseUrl, 'POST', `/api/handoffs/${fresh.body.id}/accept`, {});
  assert.equal(noFingerprint.status, 428, '缺来源指纹必须 428');
  const badFingerprint = await json(server.baseUrl, 'POST', `/api/handoffs/${fresh.body.id}/accept`,
    { expectedSourceFingerprint: 'sha256:deadbeef' });
  assert.equal(badFingerprint.status, 409);
  assert.equal(badFingerprint.body.error.code, 'HANDOFF_SOURCE_CHANGED');
  assert.equal(countMessages(scene.writingConvId) - msgCountBefore, 1, '被拒的采纳不得追加消息');
});

test('源正文/笔记更新后旧预览过期 409，重新预览才可采纳', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const { applyChapterMutation } = require('../../server/domain/chapterMutations');

  const byChapter = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne],
    text: '按第一节的结论写。',
    sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(byChapter.status, 201);
  const staleFingerprint = byChapter.body.sourceFingerprint;

  // 源正文更新（走领域入口，revision 递增）
  applyChapterMutation({
    bookId: scene.bookId, chapterId: scene.chapterId, expectedRevision: 1,
    patch: { content: '林野在废弃车站醒来，口袋里只剩半张地图。他听见了脚步声。' },
    reason: 's4-04a-test',
  });

  const stale = await json(server.baseUrl, 'POST', `/api/handoffs/${byChapter.body.id}/accept`,
    { expectedSourceFingerprint: staleFingerprint });
  assert.equal(stale.status, 409, '源正文已更新，旧预览必须过期');
  assert.equal(stale.body.error.code, 'HANDOFF_SOURCE_CHANGED');
  assert.ok(stale.body.error.details.currentSourceFingerprint, '必须回传当前指纹供重新预览比对');
  assert.equal(countMessages(scene.writingConvId), 0, '过期采纳不得追加消息');

  const rePreview = await json(server.baseUrl, 'GET', `/api/handoffs/${byChapter.body.id}`);
  assert.equal(rePreview.status, 200);
  assert.notEqual(rePreview.body.sourceFingerprint, staleFingerprint, '重新预览必须给出新指纹');
  const accepted = await json(server.baseUrl, 'POST', `/api/handoffs/${byChapter.body.id}/accept`,
    { expectedSourceFingerprint: rePreview.body.sourceFingerprint });
  assert.equal(accepted.status, 200, '重新预览后可采纳');
  assert.equal(countMessages(scene.writingConvId), 1);

  // 规划笔记来源同理：笔记 revision 前进 → 旧预览过期
  const note = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, title: '线', text: '初版', selectedMessageIds: [scene.msgTwo],
  });
  const byNote = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingOtherConvId,
    selectedMessageIds: [scene.msgTwo],
    text: '按笔记写。',
    sourceRefs: [{ kind: 'planning_note', id: note.body.id }],
  });
  assert.equal(byNote.status, 201);
  const noteFingerprint = byNote.body.sourceFingerprint;
  // 来源引用必须逐字可核对（规划笔记 id 是 UUID 文本，不能被当数字渲染成 #NaN——冒烟实测抓过）
  assert.equal(byNote.body.material.sourceRefs.length, 1);
  assert.equal(byNote.body.material.sourceRefs[0].kind, 'planning_note');
  assert.equal(byNote.body.material.sourceRefs[0].id, note.body.id);
  assert.equal(byNote.body.material.sourceRefs[0].revision, 1);

  const noteUpdate = await json(server.baseUrl, 'PUT', `/api/planning-notes/${note.body.id}`,
    { expectedRevision: 1, text: '第二版：副官更早倒戈。' });
  assert.equal(noteUpdate.status, 200);

  const noteStale = await json(server.baseUrl, 'POST', `/api/handoffs/${byNote.body.id}/accept`,
    { expectedSourceFingerprint: noteFingerprint });
  assert.equal(noteStale.status, 409, '笔记已更新，旧预览必须过期');
  const notePreview = await json(server.baseUrl, 'GET', `/api/handoffs/${byNote.body.id}`);
  assert.equal(notePreview.body.material.sourceRefs[0].id, note.body.id, '预览里的来源引用带笔记 id');
  const noteAccepted = await json(server.baseUrl, 'POST', `/api/handoffs/${byNote.body.id}/accept`,
    { expectedSourceFingerprint: notePreview.body.sourceFingerprint });
  assert.equal(noteAccepted.status, 200);
  assert.equal(countMessages(scene.writingOtherConvId), 1);
  const noteMessage = db.get(
    'SELECT content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [scene.writingOtherConvId]);
  assert.ok(noteMessage.content.includes(`规划笔记 #${note.body.id}`),
    '交接消息必须逐字注明笔记来源（不能渲染成 #NaN）');
  assert.ok(noteMessage.content.includes('（revision 2）'), '交接消息注明来源版本');
  assert.equal(noteMessage.content.includes('NaN'), false, '来源引用不得出现 NaN');
});

test('目标归档或有活跃运行：采纳拒绝，不混进正在发给模型的请求', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);

  const toArchived = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId, text: '发给已归档会话',
  });
  const archived = await json(server.baseUrl, 'POST', `/api/conversations/${scene.writingConvId}/archive`);
  assert.equal(archived.status, 200);
  const rejected = await json(server.baseUrl, 'POST', `/api/handoffs/${toArchived.body.id}/accept`,
    { expectedSourceFingerprint: toArchived.body.sourceFingerprint });
  assert.equal(rejected.status, 409, '归档会话必须拒绝');
  assert.equal(rejected.body.error.code, 'HANDOFF_TARGET_ARCHIVED');
  assert.equal(countMessages(scene.writingConvId), 0);

  const toBusy = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingOtherConvId, text: '发给运行中的会话',
  });
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
     VALUES ('run-handoff-busy', 'req-handoff-busy', 'writing:book:' || ?, ?, 'chat', 'write', 'running', ?)`,
    [scene.bookId, scene.writingOtherConvId, new Date().toISOString()]
  );
  const busyPreview = await json(server.baseUrl, 'GET', `/api/handoffs/${toBusy.body.id}`);
  assert.equal(busyPreview.body.target.busy, true, '预览必须让作者看见目标正在运行');
  const busy = await json(server.baseUrl, 'POST', `/api/handoffs/${toBusy.body.id}/accept`,
    { expectedSourceFingerprint: toBusy.body.sourceFingerprint });
  assert.equal(busy.status, 409, '目标有活跃运行必须 409（等这一轮结束后再来）');
  assert.equal(busy.body.error.code, 'HANDOFF_TARGET_BUSY');
  assert.equal(countMessages(scene.writingOtherConvId), 0, '不得混进正在发给模型的请求');

  // 运行结束后同一草案可以采纳（明确排队语义）
  db.run("UPDATE agent_runs SET status = 'finished' WHERE id = 'run-handoff-busy'");
  const queued = await json(server.baseUrl, 'POST', `/api/handoffs/${toBusy.body.id}/accept`,
    { expectedSourceFingerprint: busyPreview.body.sourceFingerprint });
  assert.equal(queued.status, 200, '运行结束后可采纳');
  assert.equal(countMessages(scene.writingOtherConvId), 1);
});

// S6-02 / L16 现场（真实模型 20 组；现场记录 系统临时证据目录 的
// staleBusyObservation）：忙判据必须看「有没有仍未结算的确认卡」，而不是「有没有历史
// awaiting_confirmation 运行行」。写作运行暂停等作者确认 → 作者在写作页结算（批准/拒绝）后
// 运行行仍停在 awaiting_confirmation（根因＝S2 域「action 结算后运行行未终态化」，见 08 台账 §13.2
// 与契约 01 §3.1），于是目标会话被永久判忙、交接采纳永远 409。本用例锁死四件事：
//   ① 历史滞留行（卡片已全部结算）不再阻塞：预览 busy=false、采纳 200 且只追加一条消息；
//   ② 对照组一：running 运行行 → 仍 409（不放松）；
//   ③ 对照组二：awaiting_confirmation 且其 run_id 关联卡仍 pending → 仍 409（不放松）；
//   ④ 对照组三：run_id 为空的 pending 卡（无法归属运行，按会话维度保守兜底）→ 仍 409（不放松）。
function seedRun({ id, requestId, sessionKey, conversationId, status }) {
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
     VALUES (?, ?, ?, ?, 'chat', 'write', ?, ?)`,
    [id, requestId, sessionKey, conversationId, status, new Date().toISOString()]
  );
}

function seedCard({ id, bookId, sessionId, status, runId }) {
  const now = Date.now();
  db.run(
    `INSERT INTO chat_actions (id, book_id, name, args_json, args_hash, session_id, tool_call_id,
       requested_by, status, summary, impact_json, created_at, expires_at, run_id)
     VALUES (?, ?, 'replace_chapter', '{}', ?, ?, '', 'writing-chat-confirm', ?, '替换章节', '["write"]', ?, ?, ?)`,
    [id, bookId, 'hash-' + id, sessionId, status, now, now + 600000, runId === undefined ? null : runId]
  );
}

async function previewAndAccept(server, handoffId) {
  const preview = await json(server.baseUrl, 'GET', `/api/handoffs/${handoffId}`);
  const accepted = await json(server.baseUrl, 'POST', `/api/handoffs/${handoffId}/accept`,
    { expectedSourceFingerprint: preview.body.sourceFingerprint });
  return { preview, accepted };
}

test('S6-02 交接忙判据：已结算的历史运行不阻塞，running 与未结算卡仍拒绝', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const writingKey = `writing:book:${scene.bookId}`;

  // ① 历史滞留现场：运行行停在 awaiting_confirmation，它发起的卡已全部结算（批准/拒绝）
  seedRun({
    id: 'run-stale-await', requestId: 'req-stale-await', sessionKey: writingKey,
    conversationId: scene.writingConvId, status: 'awaiting_confirmation',
  });
  seedCard({ id: 'c-stale-approved', bookId: scene.bookId, sessionId: writingKey, status: 'approved', runId: 'run-stale-await' });
  seedCard({ id: 'c-stale-rejected', bookId: scene.bookId, sessionId: writingKey, status: 'rejected', runId: 'run-stale-await' });
  const staleHandoff = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId, text: '历史滞留行不该阻塞采纳',
  });
  const staleScene = await previewAndAccept(server, staleHandoff.body.id);
  assert.equal(staleScene.preview.body.target.busy, false,
    '卡片已全部结算：预览不得再判目标忙碌（滞留运行行是历史事实，不是正在发给模型的请求）');
  assert.equal(staleScene.accepted.status, 200, '卡片已全部结算的滞留运行行不阻塞采纳');
  assert.equal(countMessages(scene.writingConvId), 1, '采纳只追加一条注明来源的消息');

  // ② 对照组一：真正 running → 仍拒绝
  const runningConv = seedConversation(scene.bookId, 'writing', 'book', '对照组·运行中');
  seedRun({
    id: 'run-underway', requestId: 'req-underway', sessionKey: `agent:${runningConv}`,
    conversationId: runningConv, status: 'running',
  });
  const runningHandoff = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: runningConv, text: '发给运行中的会话',
  });
  const runningScene = await previewAndAccept(server, runningHandoff.body.id);
  assert.equal(runningScene.preview.body.target.busy, true, 'running 运行行必须判忙');
  assert.equal(runningScene.accepted.status, 409, '目标运行中必须 409（不放松）');
  assert.equal(runningScene.accepted.body.error.code, 'HANDOFF_TARGET_BUSY');
  assert.equal(countMessages(runningConv), 0);

  // ③ 对照组二：awaiting_confirmation 且自身发起的卡仍 pending → 仍拒绝
  const pendingConv = seedConversation(scene.bookId, 'writing', 'book', '对照组·等待确认');
  seedRun({
    id: 'run-live-await', requestId: 'req-live-await', sessionKey: `agent:${pendingConv}`,
    conversationId: pendingConv, status: 'awaiting_confirmation',
  });
  seedCard({ id: 'c-live-pending', bookId: scene.bookId, sessionId: `agent:${pendingConv}`, status: 'pending', runId: 'run-live-await' });
  const pendingHandoff = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: pendingConv, text: '发给等待确认的会话',
  });
  const pendingScene = await previewAndAccept(server, pendingHandoff.body.id);
  assert.equal(pendingScene.preview.body.target.busy, true, '仍有未结算确认卡必须判忙');
  assert.equal(pendingScene.accepted.status, 409, '暂停等确认且卡未结算必须 409');
  assert.equal(pendingScene.accepted.body.error.code, 'HANDOFF_TARGET_BUSY');
  assert.equal(countMessages(pendingConv), 0);

  // ④ 对照组三：run_id 为空的 pending 卡（无法证明它不属于在飞运行，保守兜底）→ 仍拒绝
  const orphanConv = seedConversation(scene.bookId, 'writing', 'book', '对照组·无法归属的卡');
  seedRun({
    id: 'run-orphan-await', requestId: 'req-orphan-await', sessionKey: `agent:${orphanConv}`,
    conversationId: orphanConv, status: 'awaiting_confirmation',
  });
  seedCard({ id: 'c-orphan-pending', bookId: scene.bookId, sessionId: `agent:${orphanConv}`, status: 'pending', runId: null });
  const orphanHandoff = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: orphanConv, text: '发给无法归属确认卡的会话',
  });
  const orphanScene = await previewAndAccept(server, orphanHandoff.body.id);
  assert.equal(orphanScene.preview.body.target.busy, true, 'run_id 为空的未结算卡按会话维度保守判忙');
  assert.equal(orphanScene.accepted.status, 409, '无法归属运行的未结算卡必须保守拒绝');
  assert.equal(orphanScene.accepted.body.error.code, 'HANDOFF_TARGET_BUSY');
  assert.equal(countMessages(orphanConv), 0);
});

test('新表纳入整书备份/恢复：状态保留、消息不重复插入，删书级联清空', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const global = seedConversation(null, 'agent', 'global', '全局讨论');
  const globalMsg = addMessage(null, global, 'assistant', '全局结论：伏笔提前到第 3 章。');
  const { exportBookBackup, restoreBookBackup } = require('../../server/bookBackup');

  const note = await json(server.baseUrl, 'POST', '/api/planning-notes', {
    conversationId: scene.agentConvId, title: '备份笔记', text: '笔记正文', selectedMessageIds: [scene.msgOne],
  });
  assert.equal(note.status, 201);
  const localHandoff = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne], text: '本书讨论交接', sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  const globalHandoff = await createHandoff(server.baseUrl, {
    originConversationId: global, targetConversationId: scene.writingOtherConvId,
    selectedMessageIds: [globalMsg], text: '全局讨论交接',
  });
  assert.equal(globalHandoff.status, 201, 'global→book 草案成立（目标显式选定）');
  for (const h of [localHandoff, globalHandoff]) {
    const accepted = await json(server.baseUrl, 'POST', `/api/handoffs/${h.body.id}/accept`,
      { expectedSourceFingerprint: h.body.sourceFingerprint });
    assert.equal(accepted.status, 200);
  }
  const writingBefore = countMessages(scene.writingConvId);
  const otherWritingBefore = countMessages(scene.writingOtherConvId);
  assert.equal(writingBefore, 1);
  assert.equal(otherWritingBefore, 1);

  const exported = exportBookBackup(scene.bookId);
  assert.ok(exported && exported.file, '整书备份必须生成文件');
  const backup = JSON.parse(fs.readFileSync(
    path.join(path.dirname(db.getFilePath()), 'backups', exported.file), 'utf8'));
  assert.equal(backup.tables.planning_notes.length, 1, '笔记随书导出');
  assert.equal(backup.tables.handoffs.length, 2, '交接草案随书导出');
  assert.equal(backup.tables.handoffs.every(h => h.book_id === scene.bookId), true, '备份只含本书交接');

  // 删书：两表随之级联清空（不留孤儿）
  db.run('DELETE FROM books WHERE id = ?', [scene.bookId]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM planning_notes WHERE book_id = ?', [scene.bookId]).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs WHERE book_id = ?', [scene.bookId]).n, 0);

  // 恢复：交接只保留状态，不重复插入消息（global 来源 id 保留但该会话不入本书备份）
  restoreBookBackup(exported.file, {});
  const restored = db.all('SELECT * FROM handoffs WHERE book_id = ? ORDER BY id', [scene.bookId]);
  assert.equal(restored.length, 2, '交接草案必须随书恢复');
  assert.equal(restored.every(h => h.status === 'accepted'), true, '恢复保留采纳状态');
  assert.equal(restored.every(h => !!h.accepted_at), true, '恢复保留 acceptedAt');
  assert.equal(
    restored.find(h => h.origin_conversation_id === global).target_conversation_id,
    scene.writingOtherConvId, 'global→book 草案的来源 id 原样保留');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM planning_notes WHERE book_id = ?', [scene.bookId]).n, 1);
  assert.equal(countMessages(scene.writingConvId), writingBefore, '恢复不得重复插入交接消息');
  assert.equal(countMessages(scene.writingOtherConvId), otherWritingBefore);
  assert.deepEqual(db.all('PRAGMA foreign_key_check').map(r => r.table), [], '恢复后不得有外键孤儿');

  // 恢复后再点采纳：仍幂等，不追加第二条
  const restoredLocal = restored.find(h => h.origin_conversation_id === scene.agentConvId);
  const again = await json(server.baseUrl, 'POST', `/api/handoffs/${restoredLocal.id}/accept`,
    { expectedSourceFingerprint: restoredLocal.source_fingerprint });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true, '恢复后的已采纳草案重复点击仍幂等');
  assert.equal(countMessages(scene.writingConvId), writingBefore, '恢复后重复点击仍只有一条');
});

test('服务层契约：直接调用与伪造字段的边界', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const svc = service();

  const note = svc.createPlanningNote({
    conversationId: scene.agentConvId, title: '直接调用', text: '草稿', selectedMessageIds: [scene.msgOne],
  });
  assert.equal(note.status, 'draft');
  assert.equal(note.revision, 1);
  assert.deepEqual(svc.listPlanningNotes({ conversationId: scene.agentConvId }).map(n => n.id), [note.id]);
  assert.throws(() => svc.updatePlanningNote({ noteId: note.id, text: 'x' }),
    err => err.status === 428 && err.code === 'NOTE_REVISION_REQUIRED', '服务层同样要求 expectedRevision');
  const bumped = svc.updatePlanningNote({ noteId: note.id, expectedRevision: 1, text: '第二版' });
  assert.equal(bumped.revision, 2);
  assert.equal(svc.listPlanningNotes({ bookId: scene.bookId }).length, 1);

  const handoff = svc.createHandoff({
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgTwo], text: '服务层交接',
  });
  assert.equal(handoff.status, 'draft');
  assert.throws(() => svc.acceptHandoff({ handoffId: handoff.id }),
    err => err.status === 428, '服务层同样要求来源指纹');
  const accepted = svc.acceptHandoff({
    handoffId: handoff.id, expectedSourceFingerprint: handoff.sourceFingerprint,
  });
  assert.equal(accepted.duplicate, false);
  const replay = svc.acceptHandoff({
    handoffId: handoff.id, expectedSourceFingerprint: handoff.sourceFingerprint,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.messageId, accepted.messageId);
  assert.equal(countMessages(scene.writingConvId), 1);
  assert.throws(() => svc.acceptHandoff({ handoffId: crypto.randomUUID(), expectedSourceFingerprint: 'x' }),
    err => err.status === 404, '未知交接必须 404');

  // 客户端不能伪造状态/指纹：HTTP 层白名单拒绝未知字段
  const forged = await json(server.baseUrl, 'POST', '/api/handoffs', {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId,
    text: 'x', status: 'accepted', acceptedAt: '2026-09-22T00:00:00Z', sourceFingerprint: 'sha256:fake',
  });
  assert.equal(forged.status, 400, '伪造 status/acceptedAt/sourceFingerprint 必须 400');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'accepted'").n, 1);
});

// ---------------------------------------------------------------------------
// G4 遗留·事项A1（13 号提示词 A-3）：交接草案作废端点
//   设计事实源：G4 遗留评估「事项A1」（13 号放行提示词 §A-3；落地记录见 08 台账 §12.6.1）。
//   核心语义：作废**只对 draft 生效**——已采纳的交接消息已经写进写作会话
//   （acceptHandoff 的 appendMessage 不可撤回），对它必须 409 而不是静默成功，
//   否则作者会把「作废」读成「那条消息被撤回」。
// ---------------------------------------------------------------------------

test('作废草案：draft 可作废（只改状态、不删行、不写任何消息），作废后不可采纳', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const before = canonSnapshot(scene.bookId);
  const messagesBefore = countMessages(scene.writingConvId);

  const created = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne],
    text: '还没来得及交接的草案。',
    sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(created.status, 201);
  // 对照组：同期另一张草案不受影响
  const kept = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingOtherConvId,
    text: '仍然保留的草案。',
  });
  assert.equal(kept.status, 201);

  const cancelled = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200, 'POST /api/handoffs/:id/cancel 必须能作废草案');
  assert.equal(cancelled.body.status, 'cancelled', '作废后状态必须是 cancelled');
  assert.equal(cancelled.body.id, created.body.id);
  assert.equal(cancelled.body.bookId, scene.bookId);
  // 作废是留痕的状态变化，不是删除
  const row = db.get('SELECT status, accepted_message_id, accepted_at FROM handoffs WHERE id = ?', [created.body.id]);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.accepted_message_id, null, '作废不得写 accepted_message_id');
  assert.equal(row.accepted_at, null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs').n, 2, '作废不得删除行（「选过又放弃」要留痕）');
  assert.equal(db.get('SELECT status FROM handoffs WHERE id = ?', [kept.body.id]).status, 'draft', '其他草案不受影响');
  // 作废不写任何内容：目标会话消息数不变、正典逐位不变
  assert.equal(countMessages(scene.writingConvId), messagesBefore, '作废不得向写作会话写入任何内容');
  const after = canonSnapshot(scene.bookId);
  assert.equal(after.eventHash, before.eventHash, '作废不得写故事事实');
  assert.equal(after.chapterHash, before.chapterHash, '作废不得改正文');
  assert.equal(after.outlineHash, before.outlineHash, '作废不得改大纲');
  assert.equal(after.proposals, before.proposals, '作废不得生成提案');

  // 作废后的采纳分支（此前不可达）：明确拒绝
  const acceptAfterCancel = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/accept`,
    { expectedSourceFingerprint: created.body.sourceFingerprint });
  assert.equal(acceptAfterCancel.status, 409, '已作废的草案不得被采纳');
  assert.equal(acceptAfterCancel.body.error.code, 'HANDOFF_CANCELLED');
  assert.equal(countMessages(scene.writingConvId), messagesBefore, '被拒的采纳不得追加消息');
  // 预览仍可读：作废状态对作者可见
  const preview = await json(server.baseUrl, 'GET', `/api/handoffs/${created.body.id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.status, 'cancelled');

  // 对照组：未被作废的草案照常可采纳
  const keptAccepted = await json(server.baseUrl, 'POST', `/api/handoffs/${kept.body.id}/accept`,
    { expectedSourceFingerprint: kept.body.sourceFingerprint });
  assert.equal(keptAccepted.status, 200, '未作废的草案不受影响');
  assert.equal(countMessages(scene.writingOtherConvId), 1);

  // 未知草案 404；空字段白名单：带任何字段一律 400（客户端不能伪造状态）
  const unknown = await json(server.baseUrl, 'POST', `/api/handoffs/${crypto.randomUUID()}/cancel`, {});
  assert.equal(unknown.status, 404, '未知草案必须 404');
  assert.equal(unknown.body.error.code, 'HANDOFF_NOT_FOUND');
  const forged = await json(server.baseUrl, 'POST', `/api/handoffs/${kept.body.id}/cancel`,
    { status: 'cancelled' });
  assert.equal(forged.status, 400, '作废端点只接受空体：客户端不得伪造状态');
  assert.equal(forged.body.error.code, 'HANDOFF_FIELD_FORBIDDEN');
  assert.equal(db.get('SELECT status FROM handoffs WHERE id = ?', [kept.body.id]).status, 'accepted',
    '被拒的作废请求不得改状态');
});

test('已采纳后作废：409 HANDOFF_ALREADY_ACCEPTED，已写进写作会话的那条消息不被撤回', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const before = canonSnapshot(scene.bookId);

  const created = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId,
    targetConversationId: scene.writingConvId,
    selectedMessageIds: [scene.msgOne, scene.msgTwo],
    text: '已经交接过的那条。',
    sourceRefs: [{ kind: 'chapter', id: scene.chapterId }],
  });
  assert.equal(created.status, 201);
  const accepted = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/accept`,
    { expectedSourceFingerprint: created.body.sourceFingerprint });
  assert.equal(accepted.status, 200, '前置：草案可正常采纳');
  const messageId = accepted.body.messageId;
  const messageBefore = db.get('SELECT conversation_id, role, content, source FROM messages WHERE id = ?', [messageId]);
  assert.ok(messageBefore, '采纳必须落一条消息');

  const cancelled = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/cancel`, {});
  assert.equal(cancelled.status, 409, '已采纳的交接不得被作废（作废不是撤回）');
  assert.equal(cancelled.body.error.code, 'HANDOFF_ALREADY_ACCEPTED');
  // 行与消息逐位不变
  const row = db.get('SELECT status, accepted_at, accepted_message_id FROM handoffs WHERE id = ?', [created.body.id]);
  assert.equal(row.status, 'accepted', '被拒的作废不得改状态');
  assert.equal(Number(row.accepted_message_id), Number(messageId));
  assert.equal(row.accepted_at, accepted.body.acceptedAt);
  const messageAfter = db.get('SELECT conversation_id, role, content, source FROM messages WHERE id = ?', [messageId]);
  assert.deepEqual(messageAfter, messageBefore, '作废不得撤回/改动那条交接消息');
  assert.equal(countMessages(scene.writingConvId), 1, '写作会话里的交接消息仍在');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?', ['%已经交接过的那条。%']).n, 1,
    '交接消息仍带作者写下的摘要');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'accepted'").n, 1);

  // 服务层直接调用同样 409（守卫不只在路由上）
  const svc = service();
  assert.equal(typeof svc.cancelHandoff, 'function', '服务层必须导出 cancelHandoff（作废入口）');
  assert.throws(() => svc.cancelHandoff({ handoffId: created.body.id }),
    err => err.status === 409 && err.code === 'HANDOFF_ALREADY_ACCEPTED',
    '服务层同样拒绝已采纳的交接');
  // 正典不变
  const after = canonSnapshot(scene.bookId);
  assert.equal(after.eventHash, before.eventHash);
  assert.equal(after.chapterHash, before.chapterHash);
  assert.equal(after.outlineHash, before.outlineHash);
});

test('重复作废幂等；并发作废只有一个赢家（条件更新，不覆盖已落定状态）', async t => {
  const server = await setup(t);
  const scene = seedDiscussionScene(t);
  const created = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId,
    text: '会被点两次的草案。',
  });
  assert.equal(created.status, 201);

  const first = await json(server.baseUrl, 'POST', `/api/handoffs/${created.body.id}/cancel`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false, '第一次作废不是重复');

  // 重复作废：幂等返回，且**不再发生第二次状态迁移**（第二次调用连一条 UPDATE 都不发）
  const svc = service();
  const originalRun = db.run;
  let updates = 0;
  db.run = function (sql, params) {
    if (/UPDATE handoffs SET status/.test(String(sql))) updates += 1;
    return originalRun.call(db, sql, params);
  };
  let replay;
  try {
    replay = svc.cancelHandoff({ handoffId: created.body.id });
  } finally {
    db.run = originalRun;
  }
  assert.equal(replay.status, 'cancelled');
  assert.equal(replay.duplicate, true, '重复作废必须幂等返回（duplicate 标记），不报错也不再写一次');
  assert.equal(updates, 0, '重复作废不得再执行任何状态更新');
  assert.equal(db.get('SELECT status FROM handoffs WHERE id = ?', [created.body.id]).status, 'cancelled');

  // 并发：两个标签页同时作废同一张草案 —— 一个赢家，另一次或幂等返回或被条件更新拦下
  const race = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId, text: '并发作废。',
  });
  assert.equal(race.status, 201);
  const [a, b] = await Promise.all([
    json(server.baseUrl, 'POST', `/api/handoffs/${race.body.id}/cancel`, {}),
    json(server.baseUrl, 'POST', `/api/handoffs/${race.body.id}/cancel`, {}),
  ]);
  const winners = [a, b].filter(r => r.status === 200 && r.body.duplicate === false);
  assert.equal(winners.length, 1,
    `并发作废只能有一个赢家，实际 ${JSON.stringify([a, b].map(r => [r.status, r.body.duplicate]))}`);
  for (const loser of [a, b].filter(r => r !== winners[0])) {
    assert.ok(
      (loser.status === 200 && loser.body.duplicate === true)
        || (loser.status === 409 && loser.body.error && loser.body.error.code === 'HANDOFF_ALREADY_SETTLED'),
      `落败的一次必须是幂等返回或条件更新 409，实际 ${loser.status} ${JSON.stringify(loser.body)}`
    );
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs WHERE id = ?', [race.body.id]).n, 1, '并发作废不得产生第二行');
  assert.equal(db.get('SELECT status FROM handoffs WHERE id = ?', [race.body.id]).status, 'cancelled');

  // 条件更新的兜底分支：读到 draft 之后、写入之前被另一处先行落定 → changes=0 → 409，且绝不覆盖赢家状态
  const raced = await createHandoff(server.baseUrl, {
    originConversationId: scene.agentConvId, targetConversationId: scene.writingConvId, text: '写入窗口内的竞态。',
  });
  assert.equal(raced.status, 201);
  const origRun2 = db.run;
  let settled = 0;
  db.run = function (sql, params) {
    if (!settled && /UPDATE handoffs SET status = 'cancelled'/.test(String(sql))) {
      settled += 1; // 模拟另一个标签页在「读取 draft」与「条件更新」之间先落定（采纳）
      origRun2.call(db,
        `UPDATE handoffs SET status = 'accepted', accepted_at = datetime('now','localtime'),
           accepted_message_id = 9999 WHERE id = ?`, params);
    }
    return origRun2.call(db, sql, params);
  };
  let raceErr = null;
  try {
    svc.cancelHandoff({ handoffId: raced.body.id });
  } catch (e) {
    raceErr = e;
  } finally {
    db.run = origRun2;
  }
  assert.equal(settled, 1, '前置：注入的竞态写入必须真的发生（否则本断言没测到条件更新分支）');
  assert.ok(raceErr, '读后写窗口内被抢先落定：作废必须失败而不是覆盖赢家状态');
  assert.equal(raceErr.status, 409);
  assert.equal(raceErr.code, 'HANDOFF_ALREADY_SETTLED');
  assert.equal(db.get('SELECT status FROM handoffs WHERE id = ?', [raced.body.id]).status, 'accepted',
    '条件更新 changes=0 时不得覆盖已落定的状态');
});
