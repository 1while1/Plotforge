const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { buildChatMessages } = require('../server/llm');
const { executeTool } = require('../server/tools/executor');
const {
  TOOL_FACT_RESULT_MAX_CHARS, TOOL_FACT_TOTAL_MAX_CHARS, TOOL_FACTS_PER_RUN,
} = require('../server/context/history-budget');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['工具记忆']).lastInsertRowid;
  return db.get('SELECT * FROM books WHERE id = ?', [bookId]);
}

test('旧tools_json工具读取证据在下一轮仍可见，消息序列不伪造tool调用', async t => {
  const book = await setup(t);
  db.run('INSERT INTO messages (book_id,role,content,tools_json) VALUES (?, ?, ?, ?)', [book.id, 'assistant', '看过了', JSON.stringify([{ name: 'read_chapter', args: { chapterId: 113 }, result: '线索是蓝色信封，chapterId=113' }])]);
  const result = await buildChatMessages(book, '刚才查到了什么', null);
  assert.ok(JSON.stringify(result.messages).includes('蓝色信封'));
  assert.ok(!result.messages.some(message => message.role === 'tool'));
});

test('待确认事实随真实确认记录更新为approved，拒绝不伪装成功', async t => {
  const book = await setup(t);
  const history = require('../server/chat/tool-history');
  const ctx = { bookId: book.id, profile: 'writing', sessionId: 'writing:history' };
  const args = { title: '新章' };
  const requested = await executeTool(ctx, 'create_chapter', args);
  const fact = history.toolFact('create_chapter', args, JSON.stringify({ status: 'confirmation_required', confirmation_id: requested.confirmation.id }));
  db.run('INSERT INTO messages (book_id,role,content,tools_json) VALUES (?, ?, ?, ?)', [book.id, 'assistant', '请确认', history.serializeHistory([], { _toolFacts: [fact] })]);
  let result = await buildChatMessages(book, '状态如何', null);
  assert.ok(result.messages[0].content.includes('pending'));
  await executeTool(ctx, 'create_chapter', args, requested.confirmation.id);
  result = await buildChatMessages(book, '状态如何', null);
  assert.ok(result.messages[0].content.includes('approved'));
  db.run("UPDATE chat_actions SET status = 'rejected' WHERE id = ?", [requested.confirmation.id]);
  result = await buildChatMessages(book, '状态如何', null);
  assert.ok(result.messages[0].content.includes('rejected'));
  assert.ok(!result.messages[0].content.includes('status=&quot;approved'));
});

test('长工具正文预算有界，失败事实保持失败，密钥字段不入记忆', async t => {
  const book = await setup(t);
  const history = require('../server/chat/tool-history');
  const facts = Array.from({ length: 20 }, () => history.toolFact('read_chapter', { chapterId: 113, api_key: 'sk-test-xxx' }, '[工具错误] CHAPTER_NOT_FOUND' + '超长'.repeat(5000)));
  const toolsJson = history.serializeHistory([], { _toolFacts: facts });
  const stored = JSON.parse(toolsJson).find(entry => entry.kind === 'run').facts;
  assert.equal(stored.length, TOOL_FACTS_PER_RUN);
  assert.equal(Array.from(stored[0].result).length, TOOL_FACT_RESULT_MAX_CHARS);
  assert.ok(!toolsJson.includes('sk-test-xxx'));
  const factText = history.historyFacts([{ tools_json: toolsJson }], book.id, null);
  const lines = factText.split(String.fromCharCode(10)).slice(1);
  assert.ok(lines.join(String.fromCharCode(10)).length <= TOOL_FACT_TOTAL_MAX_CHARS);
  assert.ok(lines.some(line => JSON.parse(line).status === 'failed'));
  db.run('INSERT INTO messages (book_id,role,content,tools_json) VALUES (?, ?, ?, ?)', [book.id, 'assistant', '读取失败', toolsJson]);
  const result = await buildChatMessages(book, '为什么没读到', null);
  assert.ok(result.messages[0].content.includes('failed'));
  assert.ok(result.messages[0].content.length < 14000);
});
