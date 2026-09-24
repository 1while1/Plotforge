// A-4（G4 遗留·事项A2）规划笔记只读查询工具。
// 设计事实源：13 号放行提示词 §A-4 与 g4-leftover-eval.md §1.3 建议 R1
// （§4 的「不做」清单照录：不新增 draft_planning_note 写工具、不新增任何交接写/采纳工具）。
// 本文件口径：
//   · 工具只读（mutation=read、confirmation=none），只进 agent 与 agent-discuss 白名单；
//   · 执行体与 /api/planning-notes 同源：同一个 listPlanningNotes / getPlanningNote，无第二份 SQL；
//   · 范围＝本会话（默认）或当前书（Agent 会话绑定的书；全局会话显式 bookId）——跨书不可见，
//     范围外笔记与不存在的笔记同码同文案（不借错误码确认别处有这条笔记），也没有全库出口；
//   · 笔记库层 status 恒为 draft：返回体自带 status:'draft'，工具描述写明「草稿、非故事事实」。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const { installFetchStub } = require('./helpers/llm-stub');
const { listTools, listAllTools } = require('../server/tools/registry');
const { executeTool } = require('../server/tools/executor');

// 内部服务模块：工具与 HTTP 同源的那一份实现（修复前缺 getPlanningNote 时给出业务语义的失败信息）
function service() {
  return require('../server/conversations/handoffs');
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

// 现场：甲书两个 Agent 讨论会话（各有笔记）+ 乙书一个会话（有笔记）
async function scene(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookA = db.run('INSERT INTO books (title) VALUES (?)', ['笔记书甲']).lastInsertRowid;
  const bookB = db.run('INSERT INTO books (title) VALUES (?)', ['笔记书乙']).lastInsertRowid;
  const convA = seedConversation(bookA, 'agent', 'book', '甲书讨论一');
  const convA2 = seedConversation(bookA, 'agent', 'book', '甲书讨论二');
  const convB = seedConversation(bookB, 'agent', 'book', '乙书讨论');
  const svc = service();
  const noteA1 = svc.createPlanningNote({ conversationId: convA, title: '结论一', text: '林野不会主动叛变，但会在第 12 章被迫隐瞒。' });
  const noteA2 = svc.createPlanningNote({ conversationId: convA2, title: '结论二', text: '副官会因为旧债倒向敌方。' });
  const noteB1 = svc.createPlanningNote({ conversationId: convB, title: '乙书结论', text: '乙书的走向另算。' });
  return { bookA, bookB, convA, convA2, convB, noteA1, noteA2, noteB1 };
}

// 运行上下文：bookId 模拟会话绑定/执行绑定书（null＝未绑书的运行），conversationId 由路由注入
function ctx(profile, { bookId = null, conversationId = null } = {}) {
  return { profile, sessionId: 'agent:notes-test', bookId, conversationId, source: 'test', actor: 'author' };
}

function fail(err) {
  return `${err && err.code ? err.code : '(无码)'} ${err && err.message ? err.message : JSON.stringify(err)}`;
}

test('规划笔记工具：已注册、只读、无确认，只进 agent 与 agent-discuss 白名单', () => {
  const names = profile => listTools(profile).map(tool => tool.name);
  const registered = new Map(listAllTools().map(tool => [tool.name, tool]));
  const noteTools = ['list_planning_notes', 'get_planning_note'];

  for (const name of noteTools) {
    const desc = registered.get(name);
    assert.ok(desc, `${name} 必须已注册（G4 评估 R1：此前笔记在模型侧完全不可见）`);
    assert.equal(desc.mutation, 'read', `${name} 必须是只读工具`);
    assert.equal(desc.confirmation, 'none', `${name} 不得要求确认`);
    assert.equal(desc.scope, 'global', `${name} 是全局工具（书范围由绑定的书或显式 bookId 限定）`);
    assert.equal(desc.capability, 'notes.read', `${name} 能力域`);
    assert.equal(desc.inputSchema.additionalProperties, false, `${name} 伪造字段由 schema 层兜底`);
    // 工具描述必须写明「草稿、非故事事实」（库层 status 锁死 draft：笔记没有正典效力）
    assert.match(desc.description, /草稿/, `${name} 描述必须写明是草稿`);
    assert.match(desc.description, /(不是|非)[^。]{0,8}事实|没有正典效力/, `${name} 描述必须写明不是故事事实`);
    assert.equal(typeof desc.snippet, 'string', `${name} 应有常驻工具面的短描述`);
  }
  assert.ok(registered.get('list_planning_notes').inputSchema.properties.bookId, 'list 工具须声明 bookId（书内笔记按参数限定）');
  assert.deepEqual(registered.get('get_planning_note').inputSchema.required, ['noteId'], 'get 工具须要求 noteId');

  for (const profile of ['agent', 'agent-discuss']) {
    for (const name of noteTools) {
      assert.ok(names(profile).includes(name), `${profile} 应可达 ${name}`);
    }
  }
  for (const profile of ['writing', 'character']) {
    for (const name of noteTools) {
      assert.equal(names(profile).includes(name), false, `${profile} 不得加载笔记工具（AGENTS.md 既有口径）`);
    }
  }
  // 明确不做（评估 §4 不做清单照录）：不新增笔记写工具，也不新增任何交接写/采纳工具
  for (const forbidden of ['draft_planning_note', 'create_planning_note', 'create_handoff', 'accept_handoff', 'cancel_handoff']) {
    assert.equal(registered.has(forbidden), false, `不得新增 ${forbidden}（越界即触碰「推测变事实」）`);
  }
});

test('本会话范围：只列本会话笔记；别会话/别书笔记按不存在处理（不确认存在性）', async t => {
  const f = await scene(t);
  const context = ctx('agent', { conversationId: f.convA });

  const listed = await executeTool(context, 'list_planning_notes', {});
  assert.deepEqual(listed.notes.map(n => n.id), [f.noteA1.id], '默认范围＝本会话的笔记');
  const listedJson = JSON.stringify(listed);
  assert.equal(listedJson.includes(f.noteA2.id), false, '同书其他会话的笔记不得出现在默认范围');
  assert.equal(listedJson.includes(f.noteB1.id), false, '别书笔记不得出现');
  assert.equal(listed.notes[0].status, 'draft', '笔记恒为草稿（草稿非事实）');

  const mine = await executeTool(context, 'get_planning_note', { noteId: f.noteA1.id });
  assert.equal(mine.note.id, f.noteA1.id);
  assert.equal(mine.note.status, 'draft', '返回体自带 status=draft');
  assert.equal(mine.note.text, '林野不会主动叛变，但会在第 12 章被迫隐瞒。');

  const sibling = await executeTool(context, 'get_planning_note', { noteId: f.noteA2.id }).catch(e => e);
  const foreignBook = await executeTool(context, 'get_planning_note', { noteId: f.noteB1.id }).catch(e => e);
  const ghost = await executeTool(context, 'get_planning_note', { noteId: crypto.randomUUID() }).catch(e => e);
  assert.equal(sibling.code, 'NOTE_NOT_FOUND', `跨会话笔记必须按不存在处理（实际：${fail(sibling)}）`);
  assert.equal(sibling.status, 404);
  assert.equal(foreignBook.code, 'NOTE_NOT_FOUND', `别书笔记必须按不存在处理（实际：${fail(foreignBook)}）`);
  // 与「真的不存在」同码同文案：不借错误码确认别处存在这条笔记
  assert.equal(sibling.message, ghost.message, '范围外与不存在必须同文案（不做存在性确认）');
  assert.equal(foreignBook.message, ghost.message);
});

test('书范围：会话绑定的书内笔记可见（同书跨会话），跨书一律不可见', async t => {
  const f = await scene(t);
  // 绑定甲书的 Agent 会话：列本书笔记（与 GET /api/planning-notes?bookId= 同口径）
  const bookBound = ctx('agent', { bookId: f.bookA, conversationId: f.convA });
  const byBook = await executeTool(bookBound, 'list_planning_notes', {});
  assert.deepEqual(byBook.notes.map(n => n.id).sort(), [f.noteA1.id, f.noteA2.id].sort(),
    '绑书会话列本书的笔记（含同书其他会话）');
  assert.equal(JSON.stringify(byBook).includes(f.noteB1.id), false, '别书笔记不得出现');
  const sibling = await executeTool(bookBound, 'get_planning_note', { noteId: f.noteA2.id });
  assert.equal(sibling.note.id, f.noteA2.id, '本书范围内的笔记可读取');
  const cross = await executeTool(bookBound, 'get_planning_note', { noteId: f.noteB1.id }).catch(e => e);
  assert.equal(cross.code, 'NOTE_NOT_FOUND', `跨书笔记必须按不存在处理（实际：${fail(cross)}）`);

  // 未绑书的运行：显式 bookId 才放宽到那本书（评估 §1.3「书内笔记由参数显式限定」）
  const unbound = ctx('agent-discuss', { conversationId: f.convA });
  const explicitA = await executeTool(unbound, 'list_planning_notes', { bookId: f.bookA });
  assert.deepEqual(explicitA.notes.map(n => n.id).sort(), [f.noteA1.id, f.noteA2.id].sort(),
    '显式 bookId 按书过滤');
  const explicitB = await executeTool(unbound, 'list_planning_notes', { bookId: f.bookB });
  assert.deepEqual(explicitB.notes.map(n => n.id), [f.noteB1.id], '显式 bookId 指向乙书时只回乙书笔记');
  const explicitGet = await executeTool(unbound, 'get_planning_note', { noteId: f.noteA2.id, bookId: f.bookA });
  assert.equal(explicitGet.note.id, f.noteA2.id, '显式书范围内可读取该会话外的笔记');
});

test('出口收窄：既无会话也无书 → 400（不提供全库笔记出口）', async t => {
  const f = await scene(t);
  const bare = ctx('agent', {});
  const noScope = await executeTool(bare, 'list_planning_notes', {}).catch(e => e);
  assert.equal(noScope.code, 'NOTE_SCOPE_REQUIRED', `无范围不得列出全库笔记（实际：${fail(noScope)}）`);
  assert.equal(noScope.status, 400);
  // 非法的书范围（0）经执行器折叠后等价于「没有书范围」：无会话时同样 400，不会退化成全库出口
  const badBook = await executeTool(bare, 'list_planning_notes', { bookId: 0 }).catch(e => e);
  assert.equal(badBook.status, 400, `非法 bookId 不得退化成全库出口（实际：${fail(badBook)}）`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM planning_notes').n, 3, '被拒请求不得影响既有笔记');
  // 服务层出口本身同口径：不传范围不给全库
  assert.throws(() => service().listPlanningNotes({}), err => err.code === 'NOTE_SCOPE_REQUIRED');
});

test('同源与只读：与 listPlanningNotes/getPlanningNote 逐位一致，读笔记不改任何数据', async t => {
  const f = await scene(t);
  const svc = service();
  assert.equal(typeof svc.getPlanningNote, 'function',
    '服务层必须提供 getPlanningNote（工具与页面共用同一实现，不写第二份 SQL）');
  const canon = () => JSON.stringify({
    events: db.all('SELECT id, title, summary FROM story_events ORDER BY id'),
    chapters: db.all('SELECT id, content FROM chapters ORDER BY id'),
    volumes: db.all('SELECT id, title, outline FROM volumes ORDER BY id'),
    proposals: db.get('SELECT COUNT(*) AS n FROM event_proposals').n,
  });
  const snap = {
    canon: canon(),
    notes: JSON.stringify(db.all('SELECT * FROM planning_notes ORDER BY id')),
  };

  const context = ctx('agent', { conversationId: f.convA });
  const listed = await executeTool(context, 'list_planning_notes', {});
  assert.deepEqual(listed.notes, svc.listPlanningNotes({ conversationId: f.convA }),
    '工具结果与 HTTP 侧同一服务函数逐位一致');
  const got = await executeTool(context, 'get_planning_note', { noteId: f.noteA1.id });
  assert.deepEqual(got.note, svc.getPlanningNote(f.noteA1.id), 'get 工具与 getPlanningNote 同一实现');

  assert.equal(canon(), snap.canon, '只读工具不得改动正典（事件账本/正文/大纲/提案）');
  assert.equal(JSON.stringify(db.all('SELECT * FROM planning_notes ORDER BY id')), snap.notes,
    '只读工具不得改动笔记');
  assert.equal(db.get('SELECT revision FROM planning_notes WHERE id = ?', [f.noteA1.id]).revision, 1,
    '读笔记不得递增 revision（乐观锁只由作者修改驱动）');
});

test('discuss 只读模式：笔记工具同样只能读，写工具仍被拒', async t => {
  const f = await scene(t);
  const discuss = ctx('agent-discuss', { conversationId: f.convA });
  const listed = await executeTool(discuss, 'list_planning_notes', {});
  assert.deepEqual(listed.notes.map(n => n.id), [f.noteA1.id], 'discuss 可只读本会话笔记');
  const write = await executeTool(discuss, 'create_character', { name: '越权人物' }).catch(e => e);
  assert.equal(write.code, 'TOOL_NOT_ALLOWED', `笔记工具是只读，不得改变 discuss 的只读不变量（实际：${fail(write)}）`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM characters').n, 0, 'discuss 不得产生任何写入');
});

test('伪造字段被拒：schema 层不接受未声明参数（先于执行）', async t => {
  const f = await scene(t);
  const context = ctx('agent', { conversationId: f.convA });
  const forged = await executeTool(context, 'list_planning_notes', { status: 'accepted' }).catch(e => e);
  assert.equal(forged.code, 'INVALID_ARGS', `未声明参数不得进入执行（实际：${fail(forged)}）`);
  assert.equal(forged.status, 400);
  const forgedGet = await executeTool(context, 'get_planning_note', { noteId: f.noteA1.id, status: 'accepted' }).catch(e => e);
  assert.equal(forgedGet.code, 'INVALID_ARGS');
  const missingId = await executeTool(context, 'get_planning_note', {}).catch(e => e);
  assert.equal(missingId.code, 'INVALID_ARGS', 'noteId 是必需参数');
  assert.equal(db.get('SELECT status FROM planning_notes WHERE id = ?', [f.noteA1.id]).status, 'draft',
    '伪造状态不得到达库层');
});

// 路由 → 运行上下文 → AI SDK 工具面 → 共享执行器 → 服务层 的整链核对：
// 设计前提是「routes/agent.js:197 已把 conversationId 传进 runAgent，只需 executor 放行」。
// 这里用 fetch 边界剧本让模型真的发起一次 list_planning_notes 调用，再读**第二次上游请求体**
// （即模型实际收到了什么）：笔记正文必须真实出现在里面——否则说明上下文在半路丢了，
// 功能在页面上等于不存在（直调执行器的用例证明不了这一段）。
const NOTE_SENTINEL = 'NOTESENTINEL_林野会在第 12 章被迫隐瞒';
const OTHER_NOTE_SENTINEL = 'OTHERSENTINEL_另一会话里作者写下的别样结论';

function toolCallSse(name, args) {
  const frames = [
    {
      choices: [{
        delta: {
          role: 'assistant', tool_calls: [{
            index: 0, id: 'call-notes-1', type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

function textSse(text) {
  const frames = [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

test('整链贯通：Agent 路由下模型真的读到本会话笔记（别会话笔记不进上下文）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  t.after(() => stub.restore());
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });

  const svc = require('../server/conversations/service');
  const conv = svc.createConversation({ kind: 'agent', scope: 'global', title: '全局讨论' });
  const other = svc.createConversation({ kind: 'agent', scope: 'global', title: '另一讨论' });
  service().createPlanningNote({ conversationId: conv.id, title: '结论', text: NOTE_SENTINEL });
  service().createPlanningNote({ conversationId: other.id, title: '别处结论', text: OTHER_NOTE_SENTINEL });

  // discuss 模式（默认）：只读工具面含笔记工具；第一轮模型调 list_planning_notes，第二轮收尾
  stub.responders.push(() => toolCallSse('list_planning_notes', {}));
  stub.responders.push(() => textSse('我看到了你留存的结论。'));
  const res = await fetch(`${http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.id, content: '先看看我留存的规划笔记' }),
  });
  assert.equal(res.status, 200, 'Agent 入口应正常开工');
  await res.text();

  assert.equal(stub.calls.length, 2, '第一轮工具调用 + 第二轮收尾＝两次上游请求（工具真的执行了）');
  const secondRequest = JSON.stringify(stub.calls[1].body);
  assert.ok(secondRequest.includes(NOTE_SENTINEL),
    `第二轮请求必须带上本会话笔记的真实工具结果（前提：conversationId 贯穿到执行器）`);
  // 工具结果是 role:"tool" 消息里的转义 JSON：数据字段 status 必须逐字是 draft（不是描述文案里的词）
  assert.ok(secondRequest.includes('\\"status\\":\\"draft\\"'), '工具结果数据自带 status=draft（草稿非事实）');
  assert.ok(secondRequest.includes('\\"scope\\":{\\"kind\\":\\"conversation\\"}'),
    '未绑书的运行按「本会话」范围返回（scope 可核对）');
  assert.equal(secondRequest.includes(OTHER_NOTE_SENTINEL), false, '别的会话的笔记不得进入本轮上下文');
});
