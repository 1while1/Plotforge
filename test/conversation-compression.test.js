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
