// 开始界面后端（GET /api/start/worlds + POST /api/start/guide/stream）。
// 库隔离：临时 NOVEL_DB_FILE；模型侧只走 fetch 边界 stub（sk-test-xxx，不触网）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const { installFetchStub, sseStub, readStreamEvents, waitUntil } = require('../helpers/llm-stub');
const chapterRecycle = require('../../server/domain/chapterRecycle');
const { buildGuidePrompt } = require('../../server/routes/start');

const enc = (s) => new TextEncoder().encode(s);

// 可控 SSE：上游流由测试显式 push/close，用于把「单飞闸门被占用」的时间窗拉长
function controlledSse() {
  let controller = null;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return {
    response: { ok: true, status: 200, body },
    push: (obj) => controller.enqueue(enc(`data: ${JSON.stringify(obj)}\n\n`)),
    close: () => controller.close(),
  };
}

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
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
  return { http, stub };
}

function postGuide(baseUrl, body) {
  return fetch(`${baseUrl}/api/start/guide/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/start/worlds：逐岛统计与 /api/books 同书集同序，回收站章节不计', async t => {
  const { http } = await setup(t);
  const older = db.run(
    "INSERT INTO books (title, intro, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ['甲岛', '  一座漂浮的岛  ', '2026-01-01 10:00:00', '2026-01-01 10:00:00']
  ).lastInsertRowid;
  const newer = db.run(
    "INSERT INTO books (title, intro, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ['乙岛', '标'.repeat(200), '2026-02-01 10:00:00', '2026-02-01 10:00:00']
  ).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [older, '第一章', 'aaaa']);
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 2)', [older, '第二章', 'bbbbbb']);
  db.run("INSERT INTO characters (book_id, name) VALUES (?, '林野')", [older]);
  db.run("INSERT INTO world_entries (book_id, title, content) VALUES (?, '灰雁号', '')", [older]);
  db.run("INSERT INTO world_entries (book_id, title, content) VALUES (?, '雾港', '')", [older]);
  db.run("INSERT INTO volumes (book_id, title) VALUES (?, '第一卷')", [older]);
  // 被删章节进回收站：不该再计入章数与字数（与章节列表所见一致）
  const doomed = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 3)', [older, '被删章', 'cccccc']).lastInsertRowid;
  const removed = chapterRecycle.deleteChapterWithRecycle({ bookId: older, chapterId: doomed, reason: 'test' });
  assert.equal(removed.ok, true);

  const res = await json(http.baseUrl, 'GET', '/api/start/worlds');
  assert.equal(res.status, 200);
  const books = await json(http.baseUrl, 'GET', '/api/books');
  assert.deepEqual(
    res.body.worlds.map(w => w.id),
    books.body.books.map(b => b.id),
    '世界顺序必须与 GET /api/books 一致'
  );
  assert.deepEqual(res.body.worlds.map(w => w.id), [newer, older]);

  const [empty, full] = res.body.worlds;
  assert.equal(empty.title, '乙岛');
  assert.equal(empty.chapters, 0);
  assert.equal(empty.words, 0);
  assert.equal(empty.characters, 0);
  assert.equal(empty.worldEntries, 0);
  assert.equal(empty.volumes, 0);
  assert.equal(empty.lastChapterTitle, '');
  assert.equal(empty.intro.length, 140, 'intro 截断到 140 字');
  assert.equal(empty.updatedAt, '2026-02-01 10:00:00');

  assert.equal(full.title, '甲岛');
  assert.equal(full.intro, '一座漂浮的岛', 'intro 去空白');
  assert.equal(full.chapters, 2);
  assert.equal(full.words, 10);
  assert.equal(full.characters, 1);
  assert.equal(full.worldEntries, 2);
  assert.equal(full.volumes, 1);
  assert.equal(full.lastChapterTitle, '第二章');
  assert.deepEqual(full.regions, [{ title: '第一卷', chapters: 0, words: 0 }, { title: '未归卷', chapters: 2, words: 10 }]);
  assert.deepEqual(full.cast, [{ name: '林野', tier: 'minor' }]);
  assert.deepEqual(full.landmarks, ['灰雁号', '雾港']);
  assert.deepEqual(empty.regions, []);
  assert.deepEqual(empty.cast, []);
  assert.deepEqual(empty.landmarks, []);
});

test('GET /api/start/worlds：卷分区按卷计章、人物按 role 分级排序且不含归档、地标封顶 8', async t => {
  const { http } = await setup(t);
  const book = db.run("INSERT INTO books (title) VALUES ('群岛')").lastInsertRowid;
  const v1 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '雾海篇', 1)", [book]).lastInsertRowid;
  const v2 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '天城篇', 2)", [book]).lastInsertRowid;
  for (let i = 0; i < 3; i++) db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)', [book, v1, `c${i}`, 'ab', i]);
  db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 9)', [book, v2, 'c9', 'abcd']);
  db.run("INSERT INTO characters (book_id, name, role) VALUES (?, '路人甲', '群体龙套')", [book]);
  db.run("INSERT INTO characters (book_id, name, role) VALUES (?, '沈砚', '重要配角')", [book]);
  db.run("INSERT INTO characters (book_id, name, role) VALUES (?, '林野', '男主角，视点人物')", [book]);
  db.run("INSERT INTO characters (book_id, name, role, archived_at) VALUES (?, '旧人', '主角', '2026-01-01')", [book]);
  for (let i = 0; i < 10; i++) db.run('INSERT INTO world_entries (book_id, title) VALUES (?, ?)', [book, `地标${i}`]);

  const res = await json(http.baseUrl, 'GET', '/api/start/worlds');
  const w = res.body.worlds.find(x => x.id === book);
  assert.deepEqual(w.regions, [{ title: '雾海篇', chapters: 3, words: 6 }, { title: '天城篇', chapters: 1, words: 4 }]);
  assert.deepEqual(w.cast, [
    { name: '林野', tier: 'lead' },
    { name: '沈砚', tier: 'major' },
    { name: '路人甲', tier: 'minor' },
  ]);
  assert.equal(w.characters, 3, '人物计数与人物页默认列表一致，不含归档');
  assert.equal(w.landmarks.length, 8);
  assert.equal(w.worldEntries, 10);
});

test('POST /api/start/guide/stream：非法请求体一律 400 BAD_REQUEST', async t => {
  const { http } = await setup(t);
  const bad = [
    {},
    { messages: [] },
    { messages: '你好' },
    { messages: [{ role: 'assistant', content: '先说' }, { role: 'assistant', content: '又说' }] },
    { messages: [{ role: 'system', content: '越权' }, { role: 'user', content: '在吗' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: [{ role: 'user', content: 42 }] },
  ];
  for (const body of bad) {
    const res = await json(http.baseUrl, 'POST', '/api/start/guide/stream', body);
    assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  }
  assert.equal(db.get("SELECT COUNT(*) AS n FROM llm_calls WHERE scope = 'start-guide'").n, 0);
});

test('POST /api/start/guide/stream：逐增量下发 content、done 携带全文与 usage，并落台账', async t => {
  const { http, stub } = await setup(t);
  const bookId = db.run("INSERT INTO books (title, intro) VALUES ('甲岛', '岛简介')").lastInsertRowid;
  db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '上半段', 1)", [bookId]);

  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '沙盘' } }] },
    { choices: [{ delta: { content: '上只有' } }] },
    { choices: [{ delta: { reasoning_content: '先想一下' } }] },
    { choices: [{ delta: { content: '一座岛。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7 } },
  ]));

  const history = [];
  for (let i = 0; i < 14; i++) history.push({ role: 'user', content: `历史 ${i}` });
  history.push({ role: 'assistant', content: '在的' });
  history.push({ role: 'user', content: '墨'.repeat(2500) });
  const res = await postGuide(http.baseUrl, { messages: history, focusBookId: bookId });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = await readStreamEvents(res);

  assert.deepEqual(events.map(e => e.type), ['content', 'content', 'reasoning', 'content', 'done']);
  assert.equal(events[4].content, '沙盘上只有一座岛。');
  assert.equal(events[4].usage.completion_tokens, 7);

  const sent = stub.calls[0].body;
  assert.equal(sent.stream, true);
  assert.equal(sent.max_tokens, 900);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.tools, undefined, '砚灵不挂工具');
  assert.equal(sent.messages.length, 13, 'system + 最近 12 条');
  assert.equal(sent.messages[0].role, 'system');
  assert.ok(sent.messages[0].content.includes('砚灵'));
  assert.ok(sent.messages[0].content.includes('《甲岛》'), '系统提示带沙盘统计');
  assert.ok(sent.messages[0].content.includes('作者当前选中的岛：《甲岛》'));
  assert.equal(sent.messages[sent.messages.length - 1].content.length, 2000, '单条内容截断到 2000 字');
  assert.equal(sent.messages[1].content, '历史 4', '只保留最后 12 条');

  await waitUntil(() => db.get("SELECT COUNT(*) AS n FROM llm_calls WHERE scope = 'start-guide'").n === 1);
  const row = db.get("SELECT * FROM llm_calls WHERE scope = 'start-guide'");
  assert.equal(row.book_id, null);
  assert.equal(row.status, 'ok');
  assert.equal(row.model, 'agnes-2.5-flash');
  assert.equal(row.prompt_tokens, 42);
  assert.equal(row.completion_tokens, 7);
  assert.equal(row.finish_reason, 'stop');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM llm_calls WHERE scope = 'start-guide'").n, 1, '每次调用只落一行台账');
});

test('POST /api/start/guide/stream：单飞闸门 409，前一条结束后可再次发起', async t => {
  const { http, stub } = await setup(t);
  const held = controlledSse();
  stub.responders.push(() => held.response);

  const first = postGuide(http.baseUrl, { messages: [{ role: 'user', content: '先讲个开头' }] });
  const firstRes = await first; // 头已到 → 闸门已持有
  assert.equal(firstRes.status, 200);

  const busy = await json(http.baseUrl, 'POST', '/api/start/guide/stream', { messages: [{ role: 'user', content: '插一句' }] });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'CHAT_BUSY');
  assert.equal(stub.calls.length, 1, '被闸门拒绝的请求不得触达模型');

  held.push({ choices: [{ delta: { content: '很久很久以前。' } }] });
  held.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  held.close();
  const events = await readStreamEvents(firstRes);
  assert.deepEqual(events.map(e => e.type), ['content', 'done']);
  assert.equal(events[1].content, '很久很久以前。');

  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '接着上次。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const second = await postGuide(http.baseUrl, { messages: [{ role: 'user', content: '继续说' }] });
  assert.equal(second.status, 200, '闸门必须随上一条结束释放');
  const secondEvents = await readStreamEvents(second);
  assert.equal(secondEvents.find(e => e.type === 'done').content, '接着上次。');
});

test('POST /api/start/guide/stream：上游报错 → error 事件 + 台账 status=error + 闸门释放', async t => {
  const { http, stub } = await setup(t);
  stub.responders.push(() => ({ ok: false, status: 400, text: async () => 'bad request from upstream' }));

  const res = await postGuide(http.baseUrl, { messages: [{ role: 'user', content: '你好' }] });
  assert.equal(res.status, 200, '错误以流内 error 事件表达，HTTP 仍是 200');
  const events = await readStreamEvents(res);
  assert.deepEqual(events.map(e => e.type), ['error']);
  assert.equal(events[0].error.code, 'LLM_ERROR');
  assert.ok(events[0].error.message.length <= 300);
  assert.equal(events[0].error.message.includes('sk-test-xxx'), false, '事件不得带 key');
  assert.equal(events[0].error.message.includes('llm-stub.local'), false, '事件不得带上游地址');

  await waitUntil(() => db.get("SELECT COUNT(*) AS n FROM llm_calls WHERE scope = 'start-guide'").n === 1);
  const row = db.get("SELECT status, error FROM llm_calls WHERE scope = 'start-guide'");
  assert.equal(row.status, 'error');
  assert.ok(String(row.error).includes('400'));

  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '恢复了。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const again = await postGuide(http.baseUrl, { messages: [{ role: 'user', content: '再试一次' }] });
  assert.equal(again.status, 200, '报错路径也必须释放闸门');
  await readStreamEvents(again);
});

test('buildGuidePrompt：列沙盘统计、省略空最近章、空沙盘给鼓励语', () => {
  const prompt = buildGuidePrompt([
    { id: 1, title: '甲岛', chapters: 12, words: 12345, characters: 3, worldEntries: 5, lastChapterTitle: '第十二章' },
    { id: 2, title: '乙岛', chapters: 0, words: 0, characters: 0, worldEntries: 0, lastChapterTitle: '' },
  ], 1);
  assert.ok(prompt.includes('砚灵'));
  assert.ok(prompt.includes('《甲岛》：12 章，约 1.2万 字，人物 3 个，设定 5 条，最近一章「第十二章」'));
  assert.ok(prompt.includes('《乙岛》：0 章，约 0 字，人物 0 个，设定 0 条'));
  assert.equal(prompt.includes('最近一章「」'), false);
  assert.ok(prompt.includes('作者当前选中的岛：《甲岛》'));
  assert.equal(prompt.includes('作者当前选中的岛：《乙岛》'), false);

  const rich = buildGuidePrompt([{
    id: 3, title: '丙岛', chapters: 4, words: 10, characters: 2, worldEntries: 0, lastChapterTitle: '',
    regions: [{ title: '雾海篇', chapters: 3 }, { title: '天城篇', chapters: 1 }],
    cast: [{ name: '林野', tier: 'lead' }, { name: '沈砚', tier: 'major' }],
  }], null);
  assert.ok(rich.includes('；分卷：雾海篇（3 章）、天城篇（1 章）；主角：林野'));
  assert.equal(rich.includes('沈砚'), false, '只报主角名');

  const empty = buildGuidePrompt([], null);
  assert.ok(empty.includes('沙盘上还没有任何世界，鼓励作者进入书架新建第一本书。'));
  assert.equal(empty.includes('作者当前选中的岛'), false);
});
