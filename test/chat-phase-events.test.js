// 阶段事件（2026-09-13 「写一篇文章直接卡死」诊断产物）：
// 后续轮是非流式的，首轮正文流完之后最多还有 3 轮 LLM 调用不产生任何事件
// （书#18 真实会话实测：首轮 25s 结束后还有 7s + 18.6s + 8.4s 完全静默，作者观感＝死机）。
// 契约：
//   ① 每轮后续轮起飞前推一条 phase（kind=followup-round，带 round/total）；
//   ② 每次工具执行前推一条 phase（kind=tool，带工具名）；
//   ③ phase 是纯提示：不进入 done.content、不落库、不影响轮次与正文（事件序列里正交）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const chatRouter = require('../server/routes/chat');
const {
  installFetchStub, sseStub, jsonStub, chatPayload, toolCall, readStreamEvents,
} = require('./helpers/llm-stub');

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第一章', '旧正文', 0, 1)",
    [bookId]
  );
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local/v1')");
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'agnes-2.5-flash')");
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    await http.close();
    stub.restore();
    cleanup(location);
  });
  return { bookId, http, stub };
}

function postChat(http, bookId, body) {
  return fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('管线级：带工具轮 → 工具执行前与后续轮起飞前各有 phase 事件；正文与入库不受影响', async t => {
  const { bookId, http, stub } = await setup(t, 'phase 事件');
  stub.responders.push(
    // 首轮（流式）：请求一个只读工具
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 第 1 个后续轮（非流式）：直接收尾
    () => jsonStub(chatPayload({ content: '本书目前只有第一章。' })),
  );

  const events = await readStreamEvents(await postChat(http, bookId, { content: '看看目录' }));
  const phases = events.filter((e) => e.type === 'phase');

  assert.ok(
    phases.some((p) => p.kind === 'tool' && p.name === 'list_chapters'),
    '工具执行前应推 phase(kind=tool)，实际：' + JSON.stringify(phases)
  );
  assert.ok(
    phases.some((p) => p.kind === 'followup-round' && p.round === 1 && p.total === 9),
    '后续轮起飞前应推 phase(kind=followup-round, round=1, total=9)，实际：' + JSON.stringify(phases)
  );

  // phase 不得污染正文：done 的 content 与入库内容仍只有模型正文
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.content, '本书目前只有第一章。');
  const assistant = db.get(
    "SELECT content FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]
  );
  assert.equal(assistant.content, '本书目前只有第一章。', 'phase 提示绝不入库');
  assert.ok(!JSON.stringify(assistant).includes('已等待'), '入库正文里不得出现阶段提示');
});

test('全静默轮：不请求工具时零 phase（无静默期就不打扰作者）', async t => {
  const { bookId, http, stub } = await setup(t, 'phase 静默');
  stub.responders.push(() => jsonStub(chatPayload({ content: '直接回答。' })));
  const events = await readStreamEvents(await postChat(http, bookId, { content: '你好' }));
  assert.equal(events.filter((e) => e.type === 'phase').length, 0, '纯聊天轮不应有 phase 事件');
});

test('管线级：首轮流式正文仍在（phase 不顶替 content 事件）', async t => {
  const { bookId, http, stub } = await setup(t, 'phase 与正文并存');
  stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { content: '先给你一段正文。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '收尾一句。' })),
  );
  const events = await readStreamEvents(await postChat(http, bookId, { content: '写一段' }));
  const content = events.filter((e) => e.type === 'content').map((e) => e.text).join('');
  assert.ok(content.includes('先给你一段正文。'), '首轮 content 事件必须保留');
  assert.ok(events.some((e) => e.type === 'phase' && e.kind === 'tool'), '工具阶段提示同样要在');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.content.includes('先给你一段正文。') && done.content.includes('收尾一句。'));
});

test('函数级：followUpRounds 每轮都回调 onPhase，轮次与总数如实', async t => {
  const { bookId, stub } = await setup(t, 'phase 函数级');
  stub.responders.push(
    () => jsonStub(chatPayload({ toolCalls: [toolCall('call_a', 'get_story_state', {})], finish: 'tool_calls' })),
    () => jsonStub(chatPayload({ toolCalls: [toolCall('call_b', 'get_story_state', {})], finish: 'tool_calls' })),
    () => jsonStub(chatPayload({ content: '结束。' })),
  );
  const seen = [];
  await chatRouter.followUpRounds(
    bookId,
    [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
    { onPhase: (kind, info) => seen.push({ kind, ...info }) },
    3,
    null,
  );
  assert.deepEqual(seen, [
    { kind: 'followup-round', round: 1, total: 3 },
    { kind: 'followup-round', round: 2, total: 3 },
    { kind: 'followup-round', round: 3, total: 3 },
  ]);
});
