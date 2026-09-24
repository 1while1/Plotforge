// M5：核心循环剧本化 mock 流单测——chat.js 写作聊天工具循环/纠正轮/终局护栏的管线级覆盖。
//
// pi 依据（01-pi-ref精读/E-agent核心循环.md 第 5/7 条）：pi 用 MockAssistantStream +
// 剧本式 streamFn 零网络测核心循环；断言对象是「事件序列」与「模型实际看到的上下文」。
// 本文件同思路：mock 只替代「上游模型说什么」（fetch 边界剧本，见 helpers/llm-stub.js 决策记录），
// 真实管线全在环内——settleToolCalls 工具结算、followUpRounds 纠正轮、stream-guards 终局护栏、
// runAbort 扇出（M2/M3 成果由此获得管线级而非纯函数级的回归保护）。
//
// 剧本工具执行器=真实执行器+临时库（不碰真实库；写工具走确认卡不落盘），
// key 一律 sk-test-xxx，LLM 端点 http://llm-stub.local 仅占位。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const actionStore = require('../server/actionStore');
const chatRouter = require('../server/routes/chat');
const {
  installFetchStub, sseStub, jsonStub, chatPayload, toolCall,
  hangingNonStream, waitUntil, readStreamEvents,
} = require('./helpers/llm-stub');

const TEXT_460 = '她沿着河岸走了很久，芦苇在风里压得很低。远处的灯塔亮了，又灭了，像谁在数着她的脚步。'.repeat(12); // 468 字：满足重放折叠判据（分段 ≥400 字逐字节相同）

// 统一环境：临时库 + 一本书一章 + 占位 LLM 设置 + fetch 剧本 mock + 真实 HTTP 服务
async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第一章', '旧正文', 0, 1)",
    [bookId]
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
  return { bookId, chapterId, http, stub };
}

async function postChat(http, bookId, body, signal) {
  return fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function llmRows(bookId) {
  return db.all('SELECT scope, status, finish_reason FROM llm_calls WHERE book_id = ? ORDER BY id', [bookId]);
}

// ---------------- 1. 正常单轮：纯文本回复直接入库 ----------------
test('M5 剧本·正常单轮：流式纯文本回复 → done 事件 + assistant 入库 + 台账恰一行', async t => {
  const { bookId, http, stub } = await setup(t, 'M5 正常单轮');
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '这是单轮回复的正文内容。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]));

  const res = await postChat(http, bookId, { content: '你好' });
  assert.equal(res.status, 200);
  const events = await readStreamEvents(res);

  assert.ok(events.some(e => e.type === 'done' && e.content === '这是单轮回复的正文内容。'), 'done 事件应带完整正文');
  assert.equal(stub.calls.length, 1, '无工具/无截断 → 恰一次 LLM 调用');
  assert.ok(stub.calls[0].body.stream === true && Array.isArray(stub.calls[0].body.tools), '首轮流式应带工具 schema');

  const rows = db.all('SELECT role, content, tools_json FROM messages WHERE book_id = ? ORDER BY id', [bookId]);
  assert.deepEqual(rows.map(r => r.role), ['user', 'assistant'], '用户消息与回复各一条');
  assert.equal(rows[1].content, '这是单轮回复的正文内容。');
  assert.deepEqual(JSON.parse(rows[1].tools_json).filter(entry => entry.kind !== 'run'), [], '无对外工具事件');

  const ledger = llmRows(bookId);
  assert.equal(ledger.length, 1, '不产生 followup/continue/retry 台账');
  assert.equal(ledger[0].scope, 'chat-stream');
  assert.equal(ledger[0].status, 'ok');
});

// ---------------- 2. 带工具调用轮：只读工具执行 + 结果回灌格式 ----------------
test('M5 剧本·工具轮走通：list_chapters 真实执行 → 下一轮请求里可见 assistant.tool_calls + role:tool 回灌', async t => {
  const { bookId, http, stub } = await setup(t, 'M5 工具轮');
  stub.responders.push(
    // 1) 首轮流式：发起只读工具调用
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮（非流式）：看到工具结果后正常收尾
    () => jsonStub(chatPayload({ content: '当前书里共有 1 章：第一章。', usage: { prompt_tokens: 20, completion_tokens: 8 } })),
  );

  const res = await postChat(http, bookId, { content: '看看目录' });
  const events = await readStreamEvents(res);

  assert.equal(stub.calls.length, 2, '首轮 + 后续轮恰两次调用');
  // 工具结果回灌格式（对齐 pi「断言第二次调用的 context」）：模型必须看到结构化的
  // assistant(tool_calls) + role:tool(tool_call_id 对应) 消息对，而不是拼进正文
  const msgs = stub.calls[1].body.messages;
  const asstMsg = msgs[msgs.length - 2];
  const toolMsg = msgs[msgs.length - 1];
  assert.equal(asstMsg.role, 'assistant');
  assert.equal(asstMsg.tool_calls[0].id, 'call_1');
  assert.equal(asstMsg.tool_calls[0].function.name, 'list_chapters');
  assert.equal(toolMsg.role, 'tool', '工具结果必须是 role:tool 消息');
  assert.equal(toolMsg.tool_call_id, 'call_1', 'tool_call_id 与调用 id 对应');
  assert.ok(toolMsg.content.includes('第一章'), '回灌内容含真实执行结果');
  assert.ok(Array.isArray(stub.calls[1].body.tools), 'round 0 后续轮仍带工具（允许链式调用）');

  assert.ok(events.some(e => e.type === 'tool' && e.name === 'list_chapters'), 'SSE 应推送工具事件');
  assert.ok(events.some(e => e.type === 'done' && e.content.includes('共有 1 章')), 'done 带收尾正文');
  const saved = db.get("SELECT content, tools_json FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]);
  assert.ok(saved.content.includes('共有 1 章'));
  assert.ok(saved.tools_json.includes('list_chapters'), '工具事件随消息持久化（tools_json）');
  const fact = JSON.parse(saved.tools_json).find(entry => entry.kind === 'run').facts[0];
  assert.equal(fact.name, 'list_chapters');
  assert.equal(fact.status, 'success');
  assert.ok(fact.result.includes('第一章'));
});

// ---------------- 3. 工具错误即粮食：未知工具 → 错误结构化回灌，模型可见可纠正 ----------------
test('M5 剧本·错误即粮食：调用不存在的工具 → [工具错误] 回灌给下一轮，循环不崩、正常收尾', async t => {
  const { bookId, http, stub } = await setup(t, 'M5 工具错误回灌');
  stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e', function: { name: 'definitely_not_a_tool', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: '抱歉，刚才的调用有误；本书目前没有可用数据。' })),
  );

  const res = await postChat(http, bookId, { content: '随便查点什么' });
  const events = await readStreamEvents(res);

  assert.equal(stub.calls.length, 2);
  const toolMsg = stub.calls[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_e');
  assert.ok(toolMsg.content.includes('[工具错误]'), '错误按 tool 消息回灌（pi：错误即结果）');
  assert.ok(toolMsg.content.includes('TOOL_NOT_FOUND'), '错误码保留，模型可据此纠正');

  assert.ok(!events.some(e => e.type === 'error'), '工具失败不升级为整轮失败');
  assert.ok(events.some(e => e.type === 'done'));
  const saved = db.get("SELECT tools_json FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]);
  assert.deepEqual(JSON.parse(saved.tools_json).filter(entry => entry.kind !== 'run'), [], '失败的工具不产生对外工具事件');
  assert.equal(JSON.parse(saved.tools_json).find(entry => entry.kind === 'run').facts[0].status, 'failed');
});

// ---------------- 4. 假收尾·谎称完成：writeclaim 纠正轮真提交写工具 ----------------
test('M5 剧本·谎称完成：「第1章已写入」但无提交 → 带工具纠正轮触发 replace_chapter 确认卡 + 诚实收尾', async t => {
  const { bookId, chapterId, http, stub } = await setup(t, 'M5 谎称完成');
  const claim = `第1章已写入，章节ID：${chapterId}，字数约1800字。`;
  stub.responders.push(
    // 1) 首轮流式：先查状态（进入工具循环，纠正轮才可达）
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮收尾正文=虚假完成声明（无工具调用）
    () => jsonStub(chatPayload({ content: claim })),
    // 3) writeclaim 纠正轮：模型改口，真正提交写工具
    () => jsonStub(chatPayload({ toolCalls: [toolCall('call_w', 'replace_chapter', { chapterId, content: '纠正轮提交的新正文。' })], finish: 'tool_calls' })),
    // 4) 提交后收尾话术（不带工具）
    () => jsonStub(chatPayload({ content: '第1章的修改已生成确认卡，等待作者点击同意后生效。' })),
  );

  const res = await postChat(http, bookId, { content: '把刚才那段写进第1章' });
  const events = await readStreamEvents(res);

  assert.equal(stub.calls.length, 3, '首轮+后续轮+纠正轮，提交确认后立即停止');
  // 纠正轮指令可见：第 3 次调用的上下文里带「系统没有收到任何写入提交」的纠正提示
  const fixBody = stub.calls[2].body;
  assert.ok(JSON.stringify(fixBody.messages).includes('系统没有收到任何写入提交'), '纠正轮 prompt 应点破虚假声明');
  assert.ok(Array.isArray(fixBody.tools), '纠正轮必须带工具（让它真的提交）');

  const actionEvents = events.filter(e => e.type === 'action');
  assert.equal(actionEvents.length, 1, 'SSE 应推送一张确认卡');
  assert.equal(actionEvents[0].name, 'replace_chapter');
  assert.equal(actionStore.listPending(bookId).length, 1, '写动作挂起待确认');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '旧正文', '作者确认前正文不得被写');

  const done = events.find(e => e.type === 'done');
  assert.ok(done.content.includes('等待作者确认'), '最终回复应是诚实的「待确认」而非「已写入」');
  assert.ok(!done.content.includes('已写入'), '谎称完成的正文不得原样交付');
  assert.ok(llmRows(bookId).some(r => r.scope === 'chat-writeclaim-retry' && r.status === 'ok'), '纠正轮入台账');
});

// ---------------- 5. 假收尾·悬空承诺：followup-retry 纠正轮补出真答复 ----------------
test('M5 剧本·悬空承诺：收尾停在「让我先查看…：」→ 无工具纠正重试，采纳补全后的正文', async t => {
  const { bookId, http, stub } = await setup(t, 'M5 悬空承诺');
  db.run("INSERT INTO chapters (book_id, title, sort_order) VALUES (?, '第2章', 2), (?, '第3章', 3)", [bookId, bookId]);
  stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 收尾轮只吐半句过渡语（冒号结尾=下文缺失）
    () => jsonStub(chatPayload({ content: '让我先查看一下第3章的人物设定：' })),
    // 3) 纠正重试：把最终答复完整写出来
    () => jsonStub(chatPayload({ content: '第3章的主角是林野，性格沉稳，目前与导师的关系有些紧张。' })),
  );

  const res = await postChat(http, bookId, { content: '第3章主角是谁' });
  const events = await readStreamEvents(res);

  assert.equal(stub.calls.length, 3, '首轮+后续轮+纠正重试恰三次');
  const retryBody = stub.calls[2].body;
  assert.ok(!retryBody.tools, '纯问答型悬空（无落地意图）→ 无工具重试，省工具面开销');
  assert.ok(JSON.stringify(retryBody.messages).includes('不要再宣告下一步动作'), '纠正 prompt 应禁止再吐过渡语');

  const done = events.find(e => e.type === 'done');
  assert.ok(done.content.includes('林野'), '最终交付的是补全后的正文');
  assert.ok(!done.content.trimEnd().endsWith('：'), '不得以悬空冒号收尾');
  const saved = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]);
  assert.ok(saved.content.includes('林野'), '入库同样采纳补全结果');
  assert.ok(llmRows(bookId).some(r => r.scope === 'chat-followup-retry' && r.status === 'ok'), '纠正重试入台账');
});

// ---------------- 6. 上游重放折叠：同段 468 字正文投递两遍 → 入库/定稿只留一份 ----------------
test('M5 剧本·上游重放：流内同段正文吐两遍 → stream-guards 在真实管线折叠，done/入库恰一份', async t => {
  const { bookId, http, stub } = await setup(t, 'M5 重放折叠');
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: TEXT_460 } }] },
    { choices: [{ delta: { content: TEXT_460 } }] }, // 上游通道重放：逐字节同段再投一遍
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 30 } },
  ]));

  const res = await postChat(http, bookId, { content: '写一段' });
  const events = await readStreamEvents(res);

  // 流式事件忠实转发（两帧 content 都到了前端）——证明折叠发生在终局护栏而非 mock 只发一份
  const contentFrames = events.filter(e => e.type === 'content');
  assert.equal(contentFrames.length, 2, '上游确实投递了两遍');
  assert.ok(contentFrames.every(e => e.text === TEXT_460));

  const done = events.find(e => e.type === 'done');
  assert.equal(done.content, TEXT_460, 'done 定稿恰一份（M2 折叠护栏生效于真实管线）');
  assert.notEqual(done.content, TEXT_460 + TEXT_460);
  const saved = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]);
  assert.equal(saved.content, TEXT_460, '入库恰一份');
});

// ---------------- 7. abort·函数级：followUpRounds 轮间断连 → 零后续 LLM 调用 ----------------
test('M5 剧本·abort轮间检查：首轮带工具返回后 signal 才 abort → 第二轮前置检查即刻终止，零额外调用', async t => {
  const { bookId, stub } = await setup(t, 'M5 abort轮间');
  const ac = new AbortController();
  stub.responders.push(async () => {
    const resp = jsonStub(chatPayload({ toolCalls: [toolCall('call_a', 'get_story_state', {})], finish: 'tool_calls' }));
    ac.abort(new Error('client disconnected')); // 首轮响应已交付，此后断连
    return resp;
  });
  stub.responders.push(() => { throw new Error('abort 后不应有第二次 LLM 调用'); });

  const out = await chatRouter.followUpRounds(
    bookId,
    [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    { baseUrl: 'http://llm-stub.local/v1', apiKey: 'sk-test-xxx', model: 'agnes-2.5-flash' },
    {},
    3,
    ac.signal,
  );
  assert.equal(stub.calls.length, 1, '轮间 abort：只发生已交付的那一次调用');
  assert.equal(out.content, '', '返回已累积产出（首轮无正文）');
});

// ---------------- 8. abort·管线级：纠正轮慢响应中客户端断连 → 无后续调用/无写执行/闸门释放 ----------------
test('M5 剧本·abort纠正轮：谎称完成触发 writeclaim 纠正轮后断连 → 不再调用、确认卡不产生、闸门可复用', async t => {
  const { bookId, chapterId, http, stub } = await setup(t, 'M5 abort纠正轮');
  stub.responders.push(
    () => sseStub([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    () => jsonStub(chatPayload({ content: `第1章已写入，章节ID：${chapterId}，字数约1800字。` })),
    (init) => hangingNonStream(init), // 纠正轮慢响应：abort 才结束——断连应在此打断
    () => { throw new Error('断连后不应有第四次 LLM 调用'); },
  );

  const clientAc = new AbortController();
  const res = await postChat(http, bookId, { content: '把刚才那段写进第1章' }, clientAc.signal);
  await waitUntil(() => stub.calls.length >= 3); // 纠正轮请求已发出（token 已在烧的时点）
  clientAc.abort();
  await res.text().catch(() => '');
  await new Promise(r => setTimeout(r, 500)); // 等 close → runAbort 扇出 + 各 catch 路径 settle

  assert.equal(stub.calls.length, 3, '断连后不得再有 LLM 调用（含重试）');
  assert.ok(db.get("SELECT status FROM llm_calls WHERE book_id = ? AND scope = 'chat-abort'", [bookId]), 'abort 台账在');
  assert.equal(actionStore.listPending(bookId).length, 0, '被打断的纠正轮不得留下确认卡');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '旧正文', '正文未被写');
  const roles = db.all('SELECT role FROM messages WHERE book_id = ? ORDER BY id', [bookId]).map(r => r.role);
  assert.deepEqual(roles, ['user'], '断连保留用户消息（真实历史），不落未完成的 assistant');

  // 闸门必释放：断连后立即再发一条，正常完成且不被 409 卡死
  stub.responders.length = 0; // 撤掉「不应有第四次调用」哨兵：新一轮从这里重新起剧本
  stub.responders.push(() => sseStub([
    { choices: [{ delta: { content: '恢复后的回复。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ]));
  const second = await postChat(http, bookId, { content: '再来一条' });
  assert.equal(second.status, 200, '闸门必须已释放');
  assert.ok((await readStreamEvents(second)).some(e => e.type === 'done' && e.content === '恢复后的回复。'));
  assert.equal(stub.calls.length, 4, '断连那轮不补发，新轮恰一次');
});
