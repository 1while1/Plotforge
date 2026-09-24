// A-5（G4 遗留·事项B）discuss 工具被拒后的纠正话注入。
// 设计事实源：13 号放行提示词 §A-5 与 g4-leftover-eval.md §3.2/§3.4（探针实测）：
//   · 执行层早已结构化返回错误（「返回 vs 抛出」在 `executor.js:414-420` 已是现状），缺口在它之前——
//     模型请求面外工具时 SDK 在 `execute` 之前就抛 NoSuchToolError，执行层没有介入点，
//     模型只收到 SDK 英文原文 + 全工具清单（会重试同一工具直到步数耗尽）；
//   · prepareStep 是唯一能在「被拒之后、下一步之前」补一句纠正话的落点（ai@6.0.253 正式选项名）。
// 断言口径＝**上游请求体**（test/helpers/llm-stub.js 的 fetch 边界剧本）：模型实际收到的 system 里
// 有没有那句纠正话——不看仓库里的常量，不问模型「是否照做」（后者只能真实渠道观察，留 S6-02）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const actionStore = require('../server/actionStore');

const NUDGE_MARK = '【系统纠正】';

// 上游 SSE 响应：Agent 运行走 SDK 的 openai-compatible provider，响应必须带 content-type 头
// （否则 SDK 读头就抛 `response.headers is not iterable`——那不是业务断言失败）
function sse(frames) {
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

function toolCallFrames(name, args) {
  return [
    { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-nudge-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 3 } },
  ];
}

function textFrames(text) {
  return [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } },
  ];
}

// 每个上游请求「模型看到的 system」——prepareStep 返回 { system } 是覆盖语义，
// 所以既要有纠正话，也不能把基础系统提示顶掉。
function systemTexts(stub) {
  return stub.calls.map(call => (Array.isArray(call.body && call.body.messages) ? call.body.messages : [])
    .filter(message => message && message.role === 'system')
    .map(message => String(message.content || '')).join('\n'));
}

async function setup(t, { title, book = false } = {}) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  actionStore.clear();
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });
  let bookId = null;
  if (book) {
    bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
    db.transaction(() => seedBook(db, bookId));
  }
  const conv = require('../server/conversations/service').createConversation({ kind: 'agent', scope: 'global', title });
  return { stub, http, conv, bookId };
}

async function post(http, conv, body) {
  const res = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.id, content: body.content || '请处理一下', ...body }),
  });
  return { status: res.status, text: await res.text() };
}

test('discuss 请求面外写工具：下一步上游请求体里出现中文纠正话（此前只有 SDK 英文原文）', async t => {
  const { stub, http, conv } = await setup(t, { title: '纠正话一' });
  // 第 1 步：模型调用写工具 replace_chapter（真实存在，但不属于只读讨论工具面）——SDK 在 execute 前拒答
  // 第 2 步：收尾
  stub.responders.push(() => sse(toolCallFrames('replace_chapter', { book_id: 1, chapterId: 1, content: '改写' })));
  stub.responders.push(() => sse(textFrames('明白，我不写了。')));

  const res = await post(http, conv, { content: '把第 1 章正文改写一下' });
  assert.equal(res.status, 200, 'Agent 入口应正常开工');

  const systems = systemTexts(stub);
  assert.equal(stub.calls.length, 2, '被拒工具调用 + 收尾＝两次上游请求');
  assert.equal(systems[0].includes(NUDGE_MARK), false, '第 1 步没有被拒调用 → 不得注入');
  assert.ok(systems[1].includes(NUDGE_MARK), '第 2 步 system 必须带纠正话（模型实际能看到的那一层）');
  assert.ok(systems[1].includes('没有执行') && systems[1].includes('请勿重复调用'), '纠正话必须说明「未执行」并禁止重试同一工具');
  assert.ok(systems[1].includes('只读'), '讨论模式的纠正话必须点明只读范围');
  assert.ok(systems[1].includes('墨砚 AI 小说工坊'), 'system 是覆盖语义：注入不得把基础系统提示顶掉');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters').n, 0, 'discuss 不得因写工具被拒而写入任何内容');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM chat_actions WHERE status = 'pending'").n, 0, '被拒的写工具不得创建确认卡');
});

test('纠正话只看上一步：被拒之后的正常工具轮不再重复注入', async t => {
  const { stub, http, conv } = await setup(t, { title: '只看上一步' });
  stub.responders.push(() => sse(toolCallFrames('replace_chapter', { book_id: 1, chapterId: 1, content: '改写' })));
  stub.responders.push(() => sse(toolCallFrames('list_books', {})));
  stub.responders.push(() => sse(textFrames('书架是空的。')));

  await post(http, conv, { content: '把第 1 章正文改写一下，再看下书架' });

  const systems = systemTexts(stub);
  assert.equal(stub.calls.length, 3, '被拒 + 只读工具执行 + 收尾＝三次上游请求');
  assert.ok(systems[1].includes(NUDGE_MARK), '被拒后的下一步必须注入');
  assert.equal(systems[2].includes(NUDGE_MARK), false, '上一步没有新被拒调用 → 不得每步重复注入');
});

test('面内工具参数不合法（SDK 在 execute 之前校验失败）同样注入，且与「工具不在面内」区分', async t => {
  const { stub, http, conv } = await setup(t, { title: '参数不合法' });
  // read_chapter 在只读讨论面内，但缺 chapterId → SDK 的 zod 校验失败（InvalidToolInputError）
  stub.responders.push(() => sse(toolCallFrames('read_chapter', { book_id: 1 })));
  stub.responders.push(() => sse(textFrames('我先确认要读哪一章。')));

  await post(http, conv, { content: '读一下第 1 章' });

  const systems = systemTexts(stub);
  assert.equal(stub.calls.length, 2);
  assert.ok(systems[1].includes(NUDGE_MARK), '参数校验失败同样要带纠正话');
  assert.ok(systems[1].includes('参数'), '纠正话必须说明是参数问题');
  assert.equal(systems[1].includes('不在本轮工具面内'), false, '面内工具的参数问题不得说成「不在工具面」');
});

test('对照：正常只读工具轮不注入（正常路径的上游请求体逐字不变）', async t => {
  const { stub, http, conv } = await setup(t, { title: '正常轮对照' });
  stub.responders.push(() => sse(toolCallFrames('list_books', {})));
  stub.responders.push(() => sse(textFrames('书架是空的。')));

  await post(http, conv, { content: '看看书架' });

  const systems = systemTexts(stub);
  assert.equal(stub.calls.length, 2);
  assert.equal(systems.some(text => text.includes(NUDGE_MARK)), false, '没有被拒调用 → 任何一步都不得注入');
  assert.equal(systems[1], systems[0], '正常路径的 system 逐字不变（不含额外注入）');
});

test('对照：execute 模式写工具仍走确认卡一步即停（不碰确认与预算语义）', async t => {
  const { stub, http, conv, bookId } = await setup(t, { title: '确认卡对照', book: true });
  // 只给一条剧本：若被拒注入改动了确认/停轮语义（多跑一步），桩耗尽会直接抛错
  stub.responders.push(() => sse(toolCallFrames('create_character', { book_id: bookId, name: '林野' })));

  const res = await post(http, conv, { content: '创建角色林野', mode: 'execute', book_id: bookId });

  assert.equal(res.status, 200);
  assert.equal(stub.calls.length, 1, '写工具进入确认卡即停轮：不因纠正话多跑一步');
  assert.equal(systemTexts(stub)[0].includes(NUDGE_MARK), false, '确认卡路径不得注入纠正话');
  assert.ok(res.text.includes('awaiting_confirmation'), '收尾状态仍是待确认');
  assert.equal(actionStore.listPending(bookId).length, 1, '确认卡照常创建（确认语义未被触碰）');
  assert.equal(db.all('SELECT COUNT(*) AS n FROM characters')[0].n, 0, '未确认前不得有任何写入');
});
