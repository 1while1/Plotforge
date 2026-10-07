const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const svc = require('../server/conversations/service');
const { buildChatMessages } = require('../server/llm');
const { HISTORY_MESSAGE_LIMIT, HISTORY_RECENT_FULL_COUNT, HISTORY_OLD_MAX_CHARS } = require('../server/context/history-budget');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['摘要窗口']).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const writing = svc.createConversation({ kind: 'writing', scope: 'book', bookId });
  const agent = svc.createConversation({ kind: 'agent', scope: 'book', bookId });
  return { book, writing, agent };
}

function append(conversationId, role, content) {
  svc.appendMessage({ conversationId, role, content });
}

test('写作摘要超过十二条后仍完整进入模型历史，且历史从 user 开始', async t => {
  const { book, writing, agent } = await setup(t);
  const summary = 'SUMMARY_ANCHOR_' + '摘要要保留完整'.repeat(80);
  append(writing.id, 'user', '待归档原话');
  db.run('UPDATE messages SET compressed = 1 WHERE conversation_id = ?', [writing.id]);
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)', [writing.id, summary, '[]']);
  for (let i = 0; i < 16; i++) append(writing.id, i % 2 ? 'assistant' : 'user', 'HISTORY_' + i);
  append(agent.id, 'user', 'OTHER_CONVERSATION_MARKER');

  const result = await buildChatMessages(book, '当前问题', null, 12, writing.id);
  const text = JSON.stringify(result.messages);
  assert.ok(text.includes(summary), '摘要要完整保留，不受 300 字裁剪');
  assert.ok(text.includes('HISTORY_15'), '近期消息仍要保留');
  assert.ok(!text.includes('OTHER_CONVERSATION_MARKER'), '不得串会话');
  assert.equal(result.messages.find(m => m.role !== 'system').role, 'user');
});

test('Agent 历史超过四十条仍包含本会话摘要；恢复后摘要退出', async t => {
  const { agent } = await setup(t);
  append(agent.id, 'user', '旧消息');
  db.run('UPDATE messages SET compressed = 1 WHERE conversation_id = ?', [agent.id]);
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)', [agent.id, 'AGENT_SUMMARY_ANCHOR', '[]']);
  for (let i = 0; i < 44; i++) append(agent.id, i % 2 ? 'assistant' : 'user', 'AGENT_HISTORY_' + i);
  let context = svc.getConversationContext({ conversationId: agent.id });
  assert.ok(context.messages.some(m => m.content.includes('AGENT_SUMMARY_ANCHOR')));
  assert.equal(context.messages.find(m => m.role !== 'system').role, 'user');
  require('../server/conversations/compression').restoreConversation(agent.id);
  context = svc.getConversationContext({ conversationId: agent.id });
  assert.ok(!context.messages.some(m => m.content.includes('AGENT_SUMMARY_ANCHOR')));
});

test('组成估算按完整摘要和同一历史窗口计数', async t => {
  const { book, writing } = await setup(t);
  const http = await listen(createApp());
  t.after(() => http.close());
  const summary = 'SUMMARY_BUDGET_' + '预算摘要'.repeat(100);
  db.run('INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids) VALUES (?, ?, ?)', [writing.id, summary, '[]']);
  for (let i = 0; i < 16; i++) append(writing.id, i % 2 ? 'assistant' : 'user', 'HISTORY_' + i);
  const sent = await buildChatMessages(book, '当前问题', null, 12, writing.id);
  const detail = await json(http.baseUrl, 'GET', '/api/books/' + book.id + '/context-breakdown?conversationId=' + encodeURIComponent(writing.id));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.history.chatTokens, sent.messages.slice(1)
    .reduce((sum, m) => sum + require('../server/contextBudget').estimateTokens(m.content), 0));
});

test('旧消息裁剪与最近全文窗口在模型请求和组成估算中保持同一口径', async t => {
  const { book, writing } = await setup(t);
  const http = await listen(createApp());
  t.after(() => http.close());
  for (let i = 0; i < HISTORY_MESSAGE_LIMIT + 3; i++) {
    append(writing.id, i % 2 ? 'assistant' : 'user', 'ROW_' + i + ':' + '长'.repeat(HISTORY_OLD_MAX_CHARS + 30));
  }
  const sent = await buildChatMessages(book, '当前问题', null, HISTORY_MESSAGE_LIMIT, writing.id);
  const history = sent.messages.slice(1, -1);
  assert.ok(history.length <= HISTORY_MESSAGE_LIMIT);
  assert.ok(history.length >= HISTORY_MESSAGE_LIMIT - 1, '历史选择可剔除开头孤立的 assistant');
  assert.ok(!JSON.stringify(history).includes('ROW_0:'));
  assert.equal(history.filter(m => m.content.includes('[... 前文另有')).length,
    history.length - HISTORY_RECENT_FULL_COUNT);
  assert.ok(history.slice(-HISTORY_RECENT_FULL_COUNT).every(m => m.content.length > HISTORY_OLD_MAX_CHARS));
  const detail = await json(http.baseUrl, 'GET', '/api/books/' + book.id + '/context-breakdown?conversationId=' + encodeURIComponent(writing.id));
  assert.equal(detail.status, 200);
  const lastUser = db.get('SELECT content FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [writing.id, 'user']);
  const preview = await buildChatMessages(book, lastUser.content, null, HISTORY_MESSAGE_LIMIT, writing.id);
  assert.equal(detail.body.history.chatTokens, preview.messages.slice(1).reduce((sum, m) => sum + require('../server/contextBudget').estimateTokens(m.content), 0));
});

test('组成估算计入实际 system 工具历史与指南、末尾用户提醒', async t => {
  const { book, writing } = await setup(t);
  const http = await listen(createApp());
  t.after(() => http.close());
  append(writing.id, 'user', '上一轮讨论');
  const { toolFact, serializeHistory } = require('../server/chat/tool-history');
  const fact = toolFact('read_chapter', { chapterId: 7 }, 'TOOL_HISTORY_BLUE_731');
  db.run('INSERT INTO messages (book_id, conversation_id, role, content, tools_json) VALUES (?, ?, ?, ?, ?)',
    [book.id, writing.id, 'assistant', '查到了', serializeHistory([], { _toolFacts: [fact] })]);
  const sent = await buildChatMessages(book, '上一轮讨论', null, undefined, writing.id);
  const detail = await json(http.baseUrl, 'GET', '/api/books/' + book.id + '/context-breakdown?conversationId=' + encodeURIComponent(writing.id));
  assert.equal(detail.status, 200);
  const { estimateTokens } = require('../server/contextBudget');
  const actualSystem = sent.messages[0].content + String.fromCharCode(10) + '【工具规则】人物更新必须使用稳定人物 ID；动态状态和关系通过事件提案表达。' + String.fromCharCode(10) + require('../server/bookTools').TOOL_GUIDE;
  const actualHistory = sent.messages.slice(1).reduce((sum, m) => sum + estimateTokens(m.content), 0);
  assert.ok(actualSystem.includes('TOOL_HISTORY_BLUE_731'));
  assert.equal(detail.body.system.total, estimateTokens(actualSystem));
  assert.equal(detail.body.history.chatTokens, actualHistory);
  assert.equal(detail.body.estimatedPrompt, estimateTokens(actualSystem) + actualHistory + detail.body.schema);
});
