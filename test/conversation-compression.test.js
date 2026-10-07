// S3-04 / 任务书 04：两个空间各自压缩、恢复与新开。
//   compressConversation({ conversationId, expectedLastMessageId }) 返回 summaryId/
//   coveredMessageIds/sourceFingerprint/usageEstimate；压缩只改组装方式不删原消息；
//   压缩 agent 不动 writing；恢复后原文与工具证据逐位可查；未采纳设想不被正典化；
//   活跃 run / 源版本变化拒绝；失败不留半更新；工具成功依据来自服务端事件而非摘要自述。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const conversationSvc = require('../server/conversations/service');

function loadCompression() {
  try { return require('../server/conversations/compression'); } catch { return null; }
}

function createBook(title) {
  return db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
}

async function httpCtx(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook(title);
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http, stub };
}

function hashOf(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows.map(r => ({
    id: r.id, role: r.role, content: r.content, compressed: 0, tools_json: r.tools_json || '',
  })))).digest('hex');
}

function summaryJson(text) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }) };
}

test('压缩 agent 会话后 writing 的历史/摘要完全不变；恢复后逐位还原', async t => {
  const compression = loadCompression();
  assert.ok(compression, '压缩模块 server/conversations/compression.js 必须存在');
  const { bookId, http, stub } = await httpCtx(t, '双空间压缩');
  const agentConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId, title: '台面' });
  const writingConv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId, title: '写作' });
  for (let i = 1; i <= 6; i++) {
    conversationSvc.appendMessage({ conversationId: agentConv.id, role: i % 2 ? 'user' : 'assistant', content: `台面第${i}轮：${'讨论剧情走向'.repeat(30)}`, source: 'agent' });
  }
  conversationSvc.appendMessage({ conversationId: writingConv.id, role: 'user', content: '写作侧自己的讨论', source: 'writing' });
  const originalAgentRows = db.all('SELECT id, role, content, tools_json FROM messages WHERE conversation_id = ? ORDER BY id', [agentConv.id]);
  const writingSummaryBefore = hashOf(db.all('SELECT id, role, content, tools_json FROM messages WHERE conversation_id = ? ORDER BY id', [writingConv.id]));

  stub.responders.push(() => summaryJson('【已确认的资料与设定】…\n【已执行的动作与结果】…\n【未决问题】…\n【作者尚未采纳的设想】主角可能离开师门（尚未采纳，不是事实）'));
  const lastId = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [agentConv.id]).m;
  const result = await compression.compressConversation({ conversationId: agentConv.id, expectedLastMessageId: lastId, targetTokens: 50 });
  assert.ok(result.summaryId > 0, '返回 summaryId');
  assert.ok(result.coveredMessageIds.length >= 2, '返回 coveredMessageIds');
  assert.ok(result.sourceFingerprint.length >= 16, '返回 sourceFingerprint');
  assert.ok(result.usageEstimate > 0, '返回 usageEstimate');

  // 压缩 agent 不动 writing；原消息不删（compressed 翻转，行仍在）
  const writingSummaryAfterAgentCompression = hashOf(db.all('SELECT id, role, content, tools_json FROM messages WHERE conversation_id = ? ORDER BY id', [writingConv.id]));
  assert.equal(writingSummaryAfterAgentCompression, writingSummaryBefore, '压缩 agent 不得影响 writing 会话');
  const stillThere = db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id IN (' + result.coveredMessageIds.map(() => '?').join(',') + ')', [agentConv.id, ...result.coveredMessageIds]).n;
  assert.equal(stillThere, result.coveredMessageIds.length, '压缩不删除原消息');
  const summaryRow = db.get('SELECT * FROM conversation_summaries WHERE id = ?', [result.summaryId]);
  assert.equal(summaryRow.conversation_id, agentConv.id);
  assert.equal(JSON.parse(summaryRow.covered_message_ids).length, result.coveredMessageIds.length);
  assert.equal(summaryRow.status, 'active');

  // 恢复：原文与工具证据逐位还原（covered 行复位、存档行删除）
  const restored = await compression.restoreConversation(agentConv.id);
  assert.ok(restored.restored >= result.coveredMessageIds.length);
  const restoredRows = db.all('SELECT id, role, content, tools_json FROM messages WHERE conversation_id = ? ORDER BY id', [agentConv.id]);
  assert.equal(hashOf(restoredRows), hashOf(originalAgentRows), '恢复后消息集合与压缩前逐位一致');
  assert.equal(db.get('SELECT status FROM conversation_summaries WHERE id = ?', [result.summaryId]).status, 'superseded', '恢复后摘要标记 superseded');
  void http;
});

test('摘要结构约束：四节提示词 + 设想不被正典化 + 组装标注', async t => {
  const compression = loadCompression();
  assert.ok(compression);
  const { bookId, stub } = await httpCtx(t, '摘要结构');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  for (let i = 1; i <= 4; i++) {
    conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'user' : 'assistant', content: `第${i}轮：${'也许让角色离开师门（只是设想）'.repeat(20)}`, source: 'agent' });
  }
  stub.responders.push(() => summaryJson('四节摘要'));
  const lastId = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [conv.id]).m;
  await compression.compressConversation({ conversationId: conv.id, expectedLastMessageId: lastId, targetTokens: 30 });

  // 发给摘要 LLM 的指令必须含四节结构与「未采纳设想不得写成事实」的禁令
  const summaryPrompt = JSON.stringify(stub.calls[0].body);
  assert.ok(summaryPrompt.includes('已确认的资料与设定'), '摘要指令须含【已确认的资料与设定】');
  assert.ok(summaryPrompt.includes('已执行的动作与结果'), '摘要指令须含【已执行的动作与结果】');
  assert.ok(summaryPrompt.includes('未决问题'), '摘要指令须含【未决问题】');
  assert.ok(summaryPrompt.includes('作者尚未采纳的设想'), '摘要指令须含【作者尚未采纳的设想】');
  assert.ok(/不是事实|不得.*(事实|已定)/.test(summaryPrompt), '摘要指令须禁止把设想写成事实');

  // 未采纳设想未被正典化：正典表无任何新增（story_events/章节不动）
  const events = db.get('SELECT COUNT(*) AS n FROM story_events').n;
  const chapters = db.get('SELECT COUNT(*) AS n FROM chapters').n;
  assert.equal(events + chapters, 0, '压缩不得把设想写进任何正典表（unsavedIdeaCanonicalized=false）');

  // 组装口径：摘要行作为压缩存档进入下一轮上下文（带标注前缀，不冒充正典）
  const ctx = conversationSvc.getConversationContext({ conversationId: conv.id });
  const archiveMsg = ctx.messages.find(m => m.content.includes('【上下文压缩存档】'));
  assert.ok(archiveMsg, '存档摘要行必须进入下一轮组装');
});

test('活跃运行与源版本变化拒绝压缩；压缩失败无半更新', async t => {
  const compression = loadCompression();
  assert.ok(compression);
  const { bookId, stub } = await httpCtx(t, '压缩守卫');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  for (let i = 1; i <= 4; i++) {
    conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'user' : 'assistant', content: `第${i}轮：${'内容'.repeat(40)}`, source: 'agent' });
  }
  // 活跃运行 → 409
  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
          VALUES ('run-cp-1', 'rq', 'agent:x', ?, 'agent', 'discuss', 'running', ?)`, [conv.id, new Date().toISOString()]);
  const lastId = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [conv.id]).m;
  await assert.rejects(
    () => compression.compressConversation({ conversationId: conv.id, expectedLastMessageId: lastId, targetTokens: 30 }),
    e => e.status === 409 && e.code === 'CONVERSATION_ACTIVE_RUN'
  );
  db.run("UPDATE agent_runs SET status = 'finished' WHERE id = 'run-cp-1'");
  // 源版本变化（expectedLastMessageId 过期）→ 409 SOURCE_CHANGED
  await assert.rejects(
    () => compression.compressConversation({ conversationId: conv.id, expectedLastMessageId: lastId - 1, targetTokens: 30 }),
    e => e.status === 409 && e.code === 'SOURCE_CHANGED'
  );
  // LLM 失败 → 无半更新（无 compressed=1、无 summary 行、无存档行）
  stub.responders.push(() => new Response('upstream down', { status: 400 }));
  await assert.rejects(
    () => compression.compressConversation({ conversationId: conv.id, expectedLastMessageId: lastId, targetTokens: 30 }),
    /upstream down|500|失败| aborted/
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND compressed = 1', [conv.id]).n, 0, '失败不得留下归档标记');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ?', [conv.id]).n, 0, '失败不得留下摘要行');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND compressed = 2', [conv.id]).n, 0, '失败不得留下存档行');
});

test('超长单条保尾、归档会话拒绝、导入历史会话可压缩、保留区保住最新请求与工具证据', async t => {
  const compression = loadCompression();
  assert.ok(compression);
  const { bookId, stub } = await httpCtx(t, '压缩边界');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: '更早的一条较长历史'.repeat(60), source: 'agent' });
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'assistant', content: '超长单条'.repeat(2000), source: 'agent' });
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'assistant', content: '早回复', source: 'agent' });
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: '近期讨论', source: 'agent' });
  conversationSvc.appendMessage({
    conversationId: conv.id, role: 'assistant', content: '工具结论',
    tools: [{ name: 'read_chapter', args: { chapterId: 9 }, status: 'success', result: 'TOOLEVIDENCE_服务端工具结果' }],
    toolFacts: [{ name: 'read_chapter', status: 'success', excerpt: 'TOOLEVIDENCE_服务端工具结果' }],
  });
  stub.responders.push(() => summaryJson('边界摘要'));
  const lastId = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [conv.id]).m;
  const result = await compression.compressConversation({ conversationId: conv.id, expectedLastMessageId: lastId, targetTokens: 40 });
  assert.ok(result.summaryId > 0);
  // 保留区保住最新请求与工具证据（不在 covered 内的最新两条：工具行+近期讨论）
  const ctx = conversationSvc.getConversationContext({ conversationId: conv.id });
  assert.ok(ctx.messages.some(m => m.content === '近期讨论'), '预算必须保留最近的用户请求');
  assert.ok(ctx.messages.some(m => m.content === '工具结论'), '保留区工具行不丢');
  assert.ok(ctx.toolFacts.some(f => f.excerpt && f.excerpt.includes('TOOLEVIDENCE')), '工具证据仍来自服务端记录');
  // 压缩期间发给摘要的 transcript 保尾（超长单条不炸）
  assert.ok(stub.calls[0].body.messages.some(m => (m.content || '').length > 0));

  // 归档会话拒绝压缩
  conversationSvc.archiveConversation(conv.id);
  await assert.rejects(
    () => compression.compressConversation({ conversationId: conv.id }),
    e => e.status === 409
  );
  // 导入历史会话可压缩（legacy 资料进会话后同样可归档）
  const imported = conversationSvc.importLegacyAgent({
    scope: 'global',
    messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `导入第${i}条较长的历史内容${'填充'.repeat(30)}` })),
  });
  stub.responders.push(() => summaryJson('导入压缩'));
  const lastImported = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [imported.conversationId]).m;
  const r2 = await compression.compressConversation({ conversationId: imported.conversationId, expectedLastMessageId: lastImported, targetTokens: 30 });
  assert.ok(r2.summaryId > 0, '导入历史会话可压缩');
});

test('HTTP 契约：/api/conversations/:id/compress 与 restore；活跃 run 409', async t => {
  const { bookId, http, stub } = await httpCtx(t, '压缩HTTP');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'global', title: '压缩入口' });
  for (let i = 1; i <= 4; i++) {
    conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'user' : 'assistant', content: `第${i}轮：${'内容'.repeat(40)}`, source: 'agent' });
  }
  const lastId = db.get('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?', [conv.id]).m;
  stub.responders.push(() => summaryJson('HTTP摘要'));
  const ok = await json(http.baseUrl, 'POST', `/api/conversations/${conv.id}/compress`, { expectedLastMessageId: lastId, targetTokens: 30 });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.summaryId > 0);
  assert.ok(Array.isArray(ok.body.coveredMessageIds));

  const stale = await json(http.baseUrl, 'POST', `/api/conversations/${conv.id}/compress`, { expectedLastMessageId: lastId, targetTokens: 30 });
  assert.equal(stale.status, 409, '首次压缩已改变会话最后消息，同请求重试被源版本守卫拒绝');
  assert.equal(stale.body.error.code, 'SOURCE_CHANGED');

  const restored = await json(http.baseUrl, 'POST', `/api/conversations/${conv.id}/compress/restore`);
  assert.equal(restored.status, 200);
  assert.ok(restored.body.restored > 0);

  db.run(`INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
          VALUES ('run-cp-2', 'rq2', 'agent:y', ?, 'agent', 'discuss', 'running', ?)`, [conv.id, new Date().toISOString()]);
  stub.responders.push(() => summaryJson('x'));
  const busy = await json(http.baseUrl, 'POST', `/api/conversations/${conv.id}/compress`, { targetTokens: 10 });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'CONVERSATION_ACTIVE_RUN');
});

test('极小压缩预算仍保留最新 user 与 assistant 配对', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '极小预算');
  const conv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId });
  for (let i = 0; i < 4; i++) {
    conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: '旧请求' + i + '内容'.repeat(40) });
    conversationSvc.appendMessage({ conversationId: conv.id, role: 'assistant', content: '旧回答' + i + '内容'.repeat(40) });
  }
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: 'LATEST_USER_REQUEST_' + '长'.repeat(50) });
  conversationSvc.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'LATEST_ASSISTANT_REPLY' });
  stub.responders.push(() => summaryJson('极小预算摘要'));
  const result = await compression.compressConversation({ conversationId: conv.id, targetTokens: 1 });
  const active = db.all('SELECT content FROM messages WHERE conversation_id = ? AND compressed = 0 ORDER BY id', [conv.id]);
  assert.ok(active.some(row => row.content.includes('LATEST_USER_REQUEST_')));
  assert.ok(active.some(row => row.content === 'LATEST_ASSISTANT_REPLY'));
  assert.ok(result.coveredMessageIds.length >= 2);
});

test('连续压缩继承旧摘要，存量多 active 在下一版合并并退役', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '连续压缩');
  const conv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId });
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '初轮' + i + '甲'.repeat(100) });
  stub.responders.push(() => summaryJson('旧摘要唯一线索 BLUE-731'));
  await compression.compressConversation({ conversationId: conv.id, targetTokens: 1 });
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)',
    [conv.id, '更旧摘要唯一线索 GREEN-842', '[]']);
  const selected = conversationSvc.getConversationContext({ conversationId: conv.id });
  assert.ok(JSON.stringify(selected.messages).includes('BLUE-731'));
  assert.ok(JSON.stringify(selected.messages).includes('GREEN-842'));
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '新轮' + i + '乙'.repeat(100) });
  stub.responders.push(() => summaryJson('合并摘要 BLUE-731 GREEN-842 新轮'));
  await compression.compressConversation({ conversationId: conv.id, targetTokens: 1 });
  const prompt = JSON.stringify(stub.calls[1].body);
  assert.ok(prompt.includes('BLUE-731') && prompt.includes('GREEN-842') && prompt.includes('新轮0'));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ? AND status = 'active'", [conv.id]).n, 1);
  const current = conversationSvc.getConversationContext({ conversationId: conv.id });
  assert.ok(JSON.stringify(current.messages).includes('合并摘要'));
  compression.restoreConversation(conv.id);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ? AND status = 'active'", [conv.id]).n, 0);
});

test('二次压缩失败与超预算均不改变旧摘要和消息归档状态', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '压缩原子性');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '旧轮' + i + '甲'.repeat(100) });
  stub.responders.push(() => summaryJson('上一版存档'));
  await compression.compressConversation({ conversationId: conv.id, targetTokens: 1 });
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({ conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '新轮' + i + '乙'.repeat(100) });
  const before = JSON.stringify({
    messages: db.all('SELECT id, compressed FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]),
    summaries: db.all('SELECT id, status FROM conversation_summaries WHERE conversation_id = ? ORDER BY id', [conv.id]),
  });
  stub.responders.push(() => { throw new Error('synthetic LLM failure'); });
  await assert.rejects(compression.compressConversation({ conversationId: conv.id, targetTokens: 1 }));
  assert.equal(JSON.stringify({
    messages: db.all('SELECT id, compressed FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]),
    summaries: db.all('SELECT id, status FROM conversation_summaries WHERE conversation_id = ? ORDER BY id', [conv.id]),
  }), before);
  db.run('UPDATE conversation_summaries SET content = ? WHERE conversation_id = ? AND status = ?', ['巨'.repeat(13000), conv.id, 'active']);
  await assert.rejects(compression.compressConversation({ conversationId: conv.id, targetTokens: 1 }), { code: 'SUMMARY_INPUT_TOO_LARGE' });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ? AND status = 'active'", [conv.id]).n, 1);
});

test('旧摘要占用输入预算时仍保尾压缩新对话', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '摘要预算');
  const conv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId });
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)',
    [conv.id, 'OLD_SUMMARY_ANCHOR_' + '旧'.repeat(3000), '[]']);
  for (let i = 0; i < 35; i++) conversationSvc.appendMessage({
    conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '历史_' + i + '_' + '甲'.repeat(450),
  });
  stub.responders.push(() => summaryJson('新摘要保留旧线索和近期对话'));
  const result = await compression.compressConversation({ conversationId: conv.id, targetTokens: 1 });
  const input = stub.calls[0].body.messages[1].content;
  assert.ok(input.includes('OLD_SUMMARY_ANCHOR_'));
  assert.ok(input.includes('历史_32_'));
  assert.ok(input.length <= 12000);
  assert.ok(result.coveredMessageIds.length >= 30);
});

test('摘要模型调用期间来源变化则整笔回滚', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '摘要版本锁');
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId });
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({
    conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '原始_' + i + '乙'.repeat(100),
  });
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)',
    [conv.id, '原摘要', '[]']);
  stub.responders.push(() => {
    db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)',
      [conv.id, '模型等待时新增摘要', '[]']);
    return summaryJson('旧快照的生成结果');
  });
  await assert.rejects(compression.compressConversation({ conversationId: conv.id, targetTokens: 1 }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(db.all("SELECT content FROM conversation_summaries WHERE conversation_id = ? AND status = 'active' ORDER BY id", [conv.id]).map(r => r.content),
    ['原摘要', '模型等待时新增摘要']);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND compressed != 0', [conv.id]).n, 0);
});

test('摘要模型调用期间新增消息则拒绝旧快照', async t => {
  const compression = loadCompression();
  const { bookId, stub } = await httpCtx(t, '消息版本锁');
  const conv = conversationSvc.createConversation({ kind: 'writing', scope: 'book', bookId });
  for (let i = 0; i < 4; i++) conversationSvc.appendMessage({
    conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: '旧轮_' + i + '丙'.repeat(100),
  });
  stub.responders.push(() => {
    conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: '模型等待时新增消息' });
    return summaryJson('旧快照摘要');
  });
  await assert.rejects(compression.compressConversation({ conversationId: conv.id, targetTokens: 1 }), { code: 'SOURCE_CHANGED' });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND compressed = 1', [conv.id]).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ?', [conv.id]).n, 0);
});

test('运行中禁止从 Agent 与写作入口还原，结束后可以还原', async t => {
  const { bookId, http } = await httpCtx(t, '还原守卫');
  for (const kind of ['agent', 'writing']) {
    const conv = conversationSvc.createConversation({ kind, scope: 'book', bookId });
    conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content: '已归档原文' });
    db.run('UPDATE messages SET compressed = 1 WHERE conversation_id = ?', [conv.id]);
    db.run("INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, '既有摘要', '[]')", [conv.id]);
    db.run("INSERT INTO messages (book_id, conversation_id, role, content, compressed) VALUES (?, ?, 'assistant', '【上下文压缩存档】既有摘要', 2)", [bookId, conv.id]);
    const runId = 'restore-' + kind;
    db.run(
      "INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at) VALUES (?, ?, ?, ?, ?, 'discuss', 'running', ?)",
      [runId, 'request-' + kind, 'session-' + kind, conv.id, kind === 'writing' ? 'chat' : 'agent', new Date().toISOString()]
    );
    const path = kind === 'agent'
      ? "/api/conversations/" + conv.id + "/compress/restore"
      : "/api/books/" + bookId + "/chat/compress/restore";
    const body = kind === 'writing' ? { conversationId: conv.id } : undefined;
    const before = JSON.stringify({
      messages: db.all('SELECT id, compressed FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]),
      summaries: db.all('SELECT id, status FROM conversation_summaries WHERE conversation_id = ? ORDER BY id', [conv.id]),
    });
    const busy = await json(http.baseUrl, 'POST', path, body);
    assert.equal(busy.status, 409, kind);
    assert.equal(busy.body.error.code, 'CONVERSATION_ACTIVE_RUN');
    assert.equal(JSON.stringify({
      messages: db.all('SELECT id, compressed FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]),
      summaries: db.all('SELECT id, status FROM conversation_summaries WHERE conversation_id = ? ORDER BY id', [conv.id]),
    }), before, kind + ' must stay unchanged');
    db.run('UPDATE agent_runs SET status = ? WHERE id = ?', ['finished', runId]);
    const restored = await json(http.baseUrl, 'POST', path, body);
    assert.equal(restored.status, 200, kind);
    assert.equal(restored.body.restored, 1, kind);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ? AND status = 'active'", [conv.id]).n, 0);
  }
});
