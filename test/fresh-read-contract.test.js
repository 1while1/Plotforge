// S5-02 / R01：明确重读必须有本轮真实读取证据。
//
// 缺陷本质（2026-09-21 全系统闭环审查 R01）：真实模型专项里「明确要求重读最新章」的三次
// 采样中有一次**没有工具事件**，回答却答对了口令——口令只可能来自上一轮的读取结果（历史
// tools_json / 助手复述）。所以「答对」不能证明重读，判断依据必须是**本轮真实读取凭据**
// （readReceipts：chapterId + 读取时的 revision + 内容哈希），且凭据只由共享工具执行器
// 在真实读取成后写入——模型自报「已读」、伪造 tool_result 都不产生凭据。
//
// 本文件为红测（先于实现运行）：断言全部落在 HTTP/SSE 公开面与运行状态上，不 import 新模块。
// mock 只替代「上游模型说什么」（test/helpers/llm-stub.js 的 fetch 边界剧本），
// 工具执行器、上下文组装、终态裁决都在真实管线内；key 一律 sk-test-xxx。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const {
  installFetchStub, sseStub, jsonStub, chatPayload, toolCall, readStreamEvents,
} = require('./helpers/llm-stub');
const { applyChapterMutation } = require('../server/domain/chapterMutations');

const OLD_SENTINEL = '口令是白塔落雪';
const NEW_SENTINEL = '口令是青鹭归帆';
const PADDING = '岸边灯火摇曳，潮水拍打石阶，他耐心观察过往的船只。'.repeat(40);

async function setup(t, { empty = false } = {}) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['重读契约']).lastInsertRowid;
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const oldId = empty ? null : db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, locked, sort_order) VALUES (?, ?, '第1章 白塔', '周宁清晨离开白塔，还没有人告诉他港口的事。', 0, 1)",
    [bookId, volumeId]
  ).lastInsertRowid;
  const latestId = empty ? null : db.run(
    'INSERT INTO chapters (book_id, volume_id, title, content, locked, sort_order) VALUES (?, ?, \'第2章 入港\', ?, 0, 2)',
    [bookId, volumeId, '周宁抵达青鹭港口。' + PADDING + '临别时，守门人低声说：' + OLD_SENTINEL + '。']
  ).lastInsertRowid;
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
  return { bookId, oldId, latestId, http, stub };
}

async function writing(http, bookId, body) {
  const response = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'writing', ...body }),
  });
  assert.equal(response.status, 200, 'SSE 入口应正常开工（' + response.status + '）');
  return readStreamEvents(response);
}

const doneOf = events => {
  const final = events.find(event => event.type === 'done');
  assert.ok(final, '缺少 done 事件');
  return final;
};

function chapterRow(bookId, chapterId) {
  return db.get('SELECT id, content, revision FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
}

// 改库：走领域入口（revision 单调递增），模拟作者在另一窗口改了正文
function editLatest(bookId, chapterId, newSentinel) {
  const before = chapterRow(bookId, chapterId);
  const result = applyChapterMutation({
    bookId, chapterId, expectedRevision: before.revision,
    patch: { content: '周宁抵达青鹭港口（改稿后）。' + PADDING + '临别时，守门人低声说：' + newSentinel + '。' },
    reason: 's5-02 测试改稿',
  });
  assert.equal(result.changed, true);
  return result.chapter.revision;
}

// 上一轮：模型真实读取最新章（走共享执行器），下一轮起它就可能凭历史作答
async function readOnceInPreviousTurn(t, fx) {
  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_old', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: fx.latestId, tail: true }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '这一章末尾的口令是：' + OLD_SENTINEL + '。' })),
  );
  const events = await writing(fx.http, fx.bookId, {
    chapterId: fx.oldId,
    content: '界面选中的不是最新章。请定位最新有正文的章节，实际调用read_chapter读取末尾，然后只回答口令。不要修改数据。',
  });
  const done = doneOf(events);
  assert.ok(done.content.includes('白塔落雪'), '上一轮应读出旧标记：' + done.content);
  const receipt = (done.run && done.run.readReceipts || []).find(item => item.chapterId === fx.latestId);
  assert.ok(receipt, '上一轮读取应产生读取凭据（readReceipts）');
  const run = db.get("SELECT id FROM agent_runs WHERE entry = 'chat' ORDER BY created_at DESC, id DESC LIMIT 1");
  assert.ok(run, '真实写作入口应关联运行');
  const stored = db.get('SELECT chapter_id, revision, content_hash FROM run_read_evidence WHERE run_id = ? AND chapter_id = ?', [run.id, fx.latestId]);
  assert.equal(stored?.revision, receipt.revision, '读取凭据应随运行持久化');
  assert.equal(stored?.content_hash, receipt.contentHash);
  return { events, done, receipt, calls: fx.stub.calls.length };
}

// ---------------- 1. 凭历史作答：本轮没有真实读取 → 不得宣称完成 ----------------
test('R01 改库后本轮凭历史作答 → paused/read_not_verified，无本轮凭据，不交付未核验回答', async t => {
  const fx = await setup(t);
  const first = await readOnceInPreviousTurn(t, fx);
  const latestRevision = editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);
  assert.equal(latestRevision, first.receipt.revision + 1, '改稿后 revision 必须前进');
  fx.stub.responders.push(
    // 本轮：模型没有调用任何工具，直接凭上一轮的读取结果作答（R01 现场）
    () => sseStub([
      { choices: [{ delta: { content: '我已重新读取最新章：这一章末尾的口令是' + OLD_SENTINEL + '。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 12 } },
    ]),
    // 一次有预算的纠正轮：模型仍不读
    () => jsonStub(chatPayload({ content: '口令是' + OLD_SENTINEL + '。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.equal(first.calls !== undefined, true);
  assert.equal(fx.stub.calls.length - first.calls, 2, '最多一次纠正轮：不得无限重发（本轮 ' + (fx.stub.calls.length - first.calls) + ' 次）');
  // 失败本质（R01 的「三次中一次没有工具事件但答对密码」）：上一轮的读取/答复仍在模型上下文里，
  // 「答对」完全可能来自历史，不能证明本轮重读——所以判据必须是本轮读取凭据。
  assert.ok(JSON.stringify(fx.stub.calls[first.calls].body.messages).includes(OLD_SENTINEL),
    '失败本质：上一轮内容仍在上下文中，答对不能作为重读证据');
  assert.equal(done.run.status, 'paused', '未核验到本轮实际读取必须暂停，不能 finished：' + JSON.stringify(done.run));
  assert.equal(done.run.reason, 'read_not_verified', JSON.stringify(done.run));
  const required = done.run.requiredReads || [];
  assert.ok(required.some(item => item.chapterId === fx.latestId), '重读要求由服务端生成并指向最新章：' + JSON.stringify(done.run));
  assert.deepEqual(done.run.readReceipts || [], [], '本轮没有真实读取，不得有任何凭据');
  assert.ok(!done.content.includes('白塔落雪'), '未核验的回答不得原样交付：' + done.content);
  assert.ok(!done.content.includes('青鹭归帆'), '未读取到新正文，不得声称新口令');
  assert.match(done.content, /实际读取|未核验/, '应如实说明未核验到本轮实际读取：' + done.content);
});

// ---------------- 2. 本轮真实读取：凭据与新 revision / 新标记一致 ----------------
test('R01 本轮真实读取新版本 → receipt.chapterId/revision 与最新章一致，回答含新哨兵，finished', async t => {
  const fx = await setup(t);
  const first = await readOnceInPreviousTurn(t, fx);
  const latestRevision = editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);
  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_new', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: fx.latestId, tail: true }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '读完最新章：末尾的口令是' + NEW_SENTINEL + '。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  const receipt = (done.run.readReceipts || []).find(item => item.chapterId === fx.latestId);
  assert.ok(receipt, '本轮实际读取必须留下凭据：' + JSON.stringify(done.run));
  assert.equal(receipt.chapterId, fx.latestId);
  assert.equal(receipt.revision, latestRevision, '凭据必须记录读取时的真实 revision（改稿后的新版本）');
  assert.notEqual(receipt.revision, first.receipt.revision, '凭据不得沿用上一轮读取的版本');
  assert.equal(String(receipt.contentHash).length, 64, '凭据必须带正文内容哈希');
  assert.ok(receipt.toolCallId, '凭据必须绑定真实工具调用 id');
  assert.equal(done.run.status, 'finished', JSON.stringify(done.run));
  assert.ok(done.content.includes(NEW_SENTINEL), '回答必须反映本轮读到的正文：' + done.content);
  assert.ok(JSON.stringify(fx.stub.calls.at(-1).body.messages).includes(NEW_SENTINEL), '模型上下文里必须有本轮读取到的新正文');
  assert.ok(JSON.stringify(fx.stub.calls.at(-1).body.messages).includes('read_chapter'), '读取结果必须以真实工具结果回灌');
});

// ---------------- 3. 一次有预算的纠正：纠正轮真读后收尾 ----------------
test('R01 首答未读 → 恰一次纠正轮真的读取 → finished（不是无限重试）', async t => {
  const fx = await setup(t);
  const first = await readOnceInPreviousTurn(t, fx);
  const latestRevision = editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);

  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { content: '这一章末尾的口令是' + OLD_SENTINEL + '。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
    // 纠正轮：模型真的去读了
    () => jsonStub(chatPayload({ toolCalls: [toolCall('call_fix', 'read_chapter', { chapterId: fx.latestId, tail: true })], finish: 'tool_calls' })),
    // 读取后收尾
    () => jsonStub(chatPayload({ content: '重新读取后确认：末尾口令是' + NEW_SENTINEL + '。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.equal(fx.stub.calls.length - first.calls, 3, '首答 + 一次纠正 + 收尾：本轮 ' + (fx.stub.calls.length - first.calls) + ' 次调用');
  assert.match(JSON.stringify(fx.stub.calls[first.calls + 1].body.messages), /实际读取|read_chapter/, '纠正轮必须点名「实际读取」而不是泛泛重试');
  const receipt = (done.run.readReceipts || []).find(item => item.chapterId === fx.latestId);
  assert.ok(receipt, '纠正轮的真实读取必须留下凭据');
  assert.equal(receipt.revision, latestRevision);
  assert.equal(done.run.status, 'finished', JSON.stringify(done.run));
  assert.ok(done.content.includes(NEW_SENTINEL), done.content);
});

// ---------------- 4. 读取尝试失败：明确状态，不宣称完成 ----------------
test('R01 本轮对目标的读取尝试失败 → paused + readCode=read_failed', async t => {
  const fx = await setup(t);
  await readOnceInPreviousTurn(t, fx);
  editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);

  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'read_chapter_range', arguments: JSON.stringify({ chapterId: fx.latestId, start: -5 }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '这一章的口令是' + OLD_SENTINEL + '。' })),
    () => jsonStub(chatPayload({ content: '读取失败，我按记忆回答：' + OLD_SENTINEL + '。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.equal(done.run.status, 'paused', JSON.stringify(done.run));
  assert.equal(done.run.reason, 'read_not_verified', JSON.stringify(done.run));
  assert.equal(done.run.readCode, 'read_failed', '读取失败要有独立状态：' + JSON.stringify(done.run));
  assert.deepEqual(done.run.readReceipts || [], [], '失败的读取不得产生凭据');
  assert.ok(!done.content.includes('白塔落雪'), '不得交付未核验回答：' + done.content);
});

// ---------------- 5. 目标章在运行中被删除：明确状态 ----------------
test('R01 目标章在本轮运行中被删除 → paused + readCode=read_target_missing', async t => {
  const fx = await setup(t);
  await readOnceInPreviousTurn(t, fx);
  editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);

  fx.stub.responders.push(
    // 运行期间（模型请求发出时）目标章被删除
    () => { db.run('DELETE FROM chapters WHERE id = ?', [fx.latestId]); return sseStub([
      { choices: [{ delta: { content: '最新章的口令是' + NEW_SENTINEL + '。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]); },
    () => jsonStub(chatPayload({ content: '无法读取，我按记忆回答。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.equal(done.run.status, 'paused', JSON.stringify(done.run));
  assert.equal(done.run.readCode, 'read_target_missing', '目标已删要有独立状态：' + JSON.stringify(done.run));
});

// ---------------- 6. 范围歧义：无法定位可读章节 ─---------------
test('R01 要求重读但无法定位章节（空书）→ paused + readCode=read_scope_ambiguous', async t => {
  const fx = await setup(t, { empty: true });
  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { content: '最新章的口令是青鹭归帆。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
    () => jsonStub(chatPayload({ content: '无法确定要读哪一章。' })),
  );
  const events = await writing(fx.http, fx.bookId, { content: '请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.equal(done.run.status, 'paused', JSON.stringify(done.run));
  assert.equal(done.run.readCode, 'read_scope_ambiguous', '范围歧义要有独立状态：' + JSON.stringify(done.run));
});

// ---------------- 6b. 判据反例：一般讨论/历史回指/负向指令不得误判成重读要求 ----------------
test('R01 重读判据反例：只认「明确要求本轮真读」，不误伤一般讨论与历史回指', () => {
  const { hasFreshReadDemand } = require('../server/context/writing-target');
  const cases = [
    // 明确要求本轮真读
    ['请定位最新有正文的章节，实际调用read_chapter读取末尾，然后只回答口令。', true],
    ['不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。', true],
    ['请重新阅读一下最新章的正文再回答。', true],
    ['再读一遍第2章的正文，确认改写后的衔接。', true],
    // 一般讨论 / 历史回指 / 负向指令 / 非章节资料
    ['只复述刚才实际读取到的港口口令和章节ID，不要重新调用工具，也不要写入。', false],
    ['只根据当前选中章及其之前的正文回答，未交代就回答尚未得知，不要透露或查询后续章节。', false],
    ['不要重新读取任何章节，直接按记忆回答。', false],
    ['这一章的主角是谁？简单说说。', false],
    ['根据最近的章节继续写下一章。', false],
    ['重写第一卷第一章，把节奏放慢。', false],
    ['请重新读取我的大纲，再判断卷结构。', false],
    ['读完最新章后告诉我它的字数。', false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(hasFreshReadDemand(text), expected, '判据不符：' + text);
  }
});

// ---------------- 7. 一般讨论不强制重读 ----------------
test('R01 一般讨论不强制每轮重读：无要求、零工具事件仍 finished', async t => {
  const fx = await setup(t);
  fx.stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '主角叫周宁，故事从白塔出发。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 9 } },
  ]));
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '这一章的主角是谁？简单说说。' });
  const done = doneOf(events);

  assert.deepEqual(done.run.requiredReads || [], [], '一般讨论不得生成重读要求');
  assert.equal(done.run.status, 'finished', JSON.stringify(done.run));
  assert.equal(events.filter(event => event.type === 'tool').length, 0, '一般讨论不额外读库');
  assert.equal(fx.stub.calls.length, 1);
});

// ---------------- 8. 历史回顾遵守作者指定的过去边界 ----------------
test('R01 明确重读旧章时目标是该旧章，不越过作者指定的过去边界去读最新章', async t => {
  const fx = await setup(t);
  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_old_chapter', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: fx.oldId }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '按当前选中的这一章回答：周宁离开了白塔。' })),
  );
  const events = await writing(fx.http, fx.bookId, {
    chapterId: fx.oldId,
    content: '只根据当前选中的这一章回答。请重新实际读取当前这一章正文，再回答周宁这一章在哪里。',
  });
  const done = doneOf(events);

  const required = done.run.requiredReads || [];
  assert.ok(required.length >= 1, '明确重读应生成要求');
  assert.ok(required.every(item => item.chapterId === fx.oldId), '要求必须指向作者指定的旧章：' + JSON.stringify(required));
  const receipt = (done.run.readReceipts || []).find(item => item.chapterId === fx.oldId);
  assert.ok(receipt, '旧章读取凭据缺失：' + JSON.stringify(done.run));
  assert.equal(receipt.revision, chapterRow(fx.bookId, fx.oldId).revision);
  assert.equal(done.run.status, 'finished', JSON.stringify(done.run));
  assert.ok(!done.content.includes('青鹭归帆'), '不得越过边界提前透露未来章节');
});

// ---------------- 9. 其它工具/自报已读不产生凭据 ----------------
test('R01 调用其它只读工具后自称已读 → 不产生读取凭据，仍 paused', async t => {
  const fx = await setup(t);
  await readOnceInPreviousTurn(t, fx);
  editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);

  fx.stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_grep', function: { name: 'grep_chapters', arguments: JSON.stringify({ keyword: '口令' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '检索后我确认：口令是' + NEW_SENTINEL + '。' })),
    () => jsonStub(chatPayload({ content: '我确实已经读取过最新章了。' })),
  );
  const events = await writing(fx.http, fx.bookId, { chapterId: fx.oldId, content: '请重新实际读取最新章正文，然后回答它末尾的口令。' });
  const done = doneOf(events);

  assert.deepEqual(done.run.readReceipts || [], [], '非章节读取工具不得冒充读取凭据');
  assert.equal(done.run.status, 'paused', '模型自报已读不能作为凭据：' + JSON.stringify(done.run));
  assert.equal(done.run.reason, 'read_not_verified');
});

// ---------------- 9b. 非流式写作入口使用同一判定 ----------------
test('R01 非流式写作入口同一判定：未读 → run= paused/read_not_verified', async t => {
  const fx = await setup(t);
  await readOnceInPreviousTurn(t, fx);
  editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);

  fx.stub.responders.push(
    () => jsonStub(chatPayload({ content: '最新章的口令是' + OLD_SENTINEL + '。' })),
    () => jsonStub(chatPayload({ content: '我按记忆回答：' + OLD_SENTINEL + '。' })),
  );
  const response = await fetch(`${fx.http.baseUrl}/api/books/${fx.bookId}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapterId: fx.oldId, content: '不要看历史，请重新实际读取最新章正文，然后回答它末尾的口令。' }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.run.status, 'paused', JSON.stringify(payload.run));
  assert.equal(payload.run.reason, 'read_not_verified', JSON.stringify(payload.run));
  assert.deepEqual(payload.run.readReceipts || [], [], '未读不得有凭据');
  assert.ok(!String(payload.reply).includes('白塔落雪'), '不得交付未核验回答：' + payload.reply);
});

// ---------------- 10. Agent 入口：真实只读预备步骤 + 同一判定 ----------------// Agent 侧是 SDK 流（无法在收尾后再插入修正轮），按任务书允许的第二种入口处理：
// 由服务端用共享工具执行器先做一次**真实只读预备步骤**，把真实读取结果作为系统证据注入，
// 凭据照常记入 readReceipts；判定仍走同一函数（requiredReads × readReceipts）。
function agentSse(text) {
  const enc = s => new TextEncoder().encode(s);
  const frame = obj => enc(`data: ${JSON.stringify(obj)}\n\n`);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }));
      controller.enqueue(frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 12 } }));
      controller.enqueue(enc('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
}

function captureResponse() {
  const chunks = [];
  const decoder = new TextDecoder();
  return {
    chunks,
    setHeader() {}, writeHead() {}, flushHeaders() {}, once() {}, removeListener() {}, on() {},
    writableEnded: false, writableFinished: false, statusCode: 200,
    write(chunk) { chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk)); return true; },
    end() { this.writableFinished = true; },
  };
}

function metadataOf(res) {
  const parts = [];
  for (const line of res.chunks.join('').split('\n')) {
    const text = line.trim();
    if (!text.startsWith('data:')) continue;
    const payload = text.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { parts.push(JSON.parse(payload)); } catch { /* 非 JSON 帧 */ }
  }
  return parts.map(part => part.messageMetadata).filter(Boolean).pop() || null;
}

test('R01 Agent 入口：服务端真实只读预备步骤产生凭据，同一判定通过（非伪造 tool_result）', async t => {
  const fx = await setup(t);
  const latestRevision = editLatest(fx.bookId, fx.latestId, NEW_SENTINEL);
  const { runAgent } = require('../server/agent/agent');
  fx.stub.responders.push(() => agentSse('最新章末尾的口令是' + NEW_SENTINEL + '。'));

  const res = captureResponse();
  const outcome = await runAgent(
    [{ role: 'user', content: '请重新实际读取最新章正文，然后回答它末尾的口令。' }],
    res,
    { sessionId: 'agent:s5-02', bookId: fx.bookId, chapterId: fx.latestId, actor: 'author', watchdogMs: 20000 },
  ).catch(error => ({ thrown: error && error.message }));

  const metadata = metadataOf(res);
  assert.ok(metadata, '缺少 finish 元数据：' + JSON.stringify(res.chunks).slice(0, 300));
  const run = metadata.run || {};
  const required = run.requiredReads || [];
  assert.ok(required.some(item => item.chapterId === fx.latestId), 'Agent 入口同样要有服务端重读要求：' + JSON.stringify(run));
  const receipt = (run.readReceipts || []).find(item => item.chapterId === fx.latestId);
  assert.ok(receipt, '真实只读预备步骤必须留下凭据：' + JSON.stringify(run));
  assert.equal(receipt.revision, latestRevision, '凭据 revision 必须是当前版本');
  assert.equal(String(receipt.contentHash).length, 64);
  assert.equal(run.status, 'finished', JSON.stringify(run));
  assert.equal(outcome && outcome.status, 'finished', JSON.stringify(outcome));
  const modelContext = JSON.stringify(fx.stub.calls[0].body.messages);
  assert.ok(modelContext.includes(NEW_SENTINEL), '模型上下文必须含本轮真实读取到的新正文');
  assert.ok(!modelContext.includes(OLD_SENTINEL), '不得把旧正文当作本轮读取结果注入');
});

test('R01 Agent HTTP 入口：预备读取证据绑定运行并可按会话回读', async t => {
  const fx = await setup(t);
  const conv = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'book', bookId: fx.bookId });
  fx.stub.responders.push(() => agentSse('已读取并完成回答。'));
  const response = await fetch(fx.http.baseUrl + '/api/agent/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.id, book_id: fx.bookId, chapterId: fx.latestId,
      content: '请重新实际读取最新章正文，然后回答它末尾的口令。' }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const run = db.get('SELECT id FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [conv.id]);
  assert.ok(run);
  const receipt = db.get('SELECT chapter_id, content_hash FROM run_read_evidence WHERE run_id = ?', [run.id]);
  assert.equal(receipt?.chapter_id, fx.latestId);
  assert.equal(receipt?.content_hash.length, 64);
  const visible = await fetch(fx.http.baseUrl + '/api/runs/' + run.id + '/read-evidence', { headers: { 'x-session-key': 'agent:' + conv.id } });
  assert.equal(visible.status, 200);
  assert.equal((await visible.json()).evidence.length, 1);
});
