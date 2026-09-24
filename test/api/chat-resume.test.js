const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const actionStore = require('../../server/actionStore');
const { listen } = require('../helpers/http');

// 续跑信封特征子串（chat.js 的 confirmResumeEventText 未导出，用稳定关键词断言）
const ENVELOPE_MARK = '[确认执行结果·系统事件]';

// ---------------- 假 LLM 服务器（同 chat-resilience 模式） ----------------
function makeFakeApp(state) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.post('/chat/completions', (req, res) => {
    state.requests.push(req.body);
    const out = state.responder(req.body, state.requests.length - 1);
    if (out.status && out.status !== 200) return res.status(out.status).send(out.text || 'error');
    if (out.hang) {
      // S2-03：悬挂流——写头与一帧后不结束，模拟生成中（闸门保持占用）
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(contentChunk('正在写。'))}\n\n`);
      if (out.finish) out.finish();
      return;
    }
    if (out.sse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      for (const evt of out.sse) res.write(`data: ${JSON.stringify(evt)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.json(out.json);
  });
  return app;
}

const contentChunk = (text) => ({ choices: [{ delta: { content: text } }] });
const finishChunk = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const usageChunk = (u) => ({ choices: [], usage: u });

// 读取被测应用的 SSE 流，解析为事件数组（同 chat-resilience）
async function readStream(baseUrl, bookId, body) {
  const res = await fetch(`${baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { events.push(JSON.parse(t.slice(5).trim())); } catch { /* 半包 */ }
    }
  }
  return events;
}

// 404/409 预检失败在 SSE 握手前直接回 JSON，用普通 fetch 断言
async function postStreamJson(baseUrl, bookId, body) {
  const res = await fetch(`${baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* 非预检路径不会走到这 */ }
  return { status: res.status, body: payload };
}

let fake;
const state = { requests: [], responder: () => ({ json: { choices: [{ message: { content: '' } }] } }) };

before(async () => { fake = await listen(makeFakeApp(state)); });
after(async () => { await fake.close(); });

async function setup(t, title) {
  state.requests = [];
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [fake.baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['agnes-2.5-flash']);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http };
}

// 库里的续跑信封 user 行（同一 action 续跑应始终只有一行）
function envelopeUserRows(bookId) {
  return db.all(
    "SELECT id, content FROM messages WHERE book_id = ? AND role = 'user' AND content LIKE ?",
    [bookId, '%' + ENVELOPE_MARK + '%']
  );
}

// ---------------- 场景 1：approved 续跑——信封回灌 + 回复入库 + 一次性标记 ----------------
test('确认续跑：approved 结算后执行结果作为系统事件回灌，模型续跑并正常入库', async t => {
  const { bookId, http } = await setup(t, '续跑书');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: '新添的情节段。' });
  actionStore.settle(action.id, 'approved', { ok: true, appended_chars: 8 });

  state.responder = () => ({ sse: [
    contentChunk('收到追加结果，剧情已衔接完成。'),
    finishChunk('stop'),
    usageChunk({ prompt_tokens: 50, completion_tokens: 10 }),
  ] });

  const events = await readStream(http.baseUrl, bookId, { resumeActionId: action.id });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应收到 done 事件');
  assert.equal(done.content, '收到追加结果，剧情已衔接完成。');

  // 首轮 LLM 请求：末条 user 消息即续跑信封
  assert.equal(state.requests.length, 1, '仅应有一轮 LLM 请求');
  const last = state.requests[0].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes(ENVELOPE_MARK), '末条应为确认结果信封');
  assert.ok(last.content.includes('append_chapter'), '信封含工具名');
  assert.ok(last.content.includes('已执行成功'), 'approved 状态文案');
  assert.ok(last.content.includes('appended_chars'), '信封含执行结果摘要');
  assert.ok(last.content.includes('不要重复执行'), '信封含防重复执行指令');

  // 入库：1 条信封 user + 1 条 assistant 回复
  const users = envelopeUserRows(bookId);
  assert.equal(users.length, 1);
  assert.ok(users[0].content.includes(ENVELOPE_MARK));
  const assistant = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.equal(assistant.content, '收到追加结果，剧情已衔接完成。');

  // 一次性：回复入库后 resumeDone 置位
  assert.equal(actionStore.get(action.id).resumeDone, true);
});

// ---------------- 场景 2：rejected 续跑——信封明确告知被拒 ----------------
test('拒绝续跑：rejected 结算后信封告知被作者拒绝，模型可改道', async t => {
  const { bookId, http } = await setup(t, '拒绝续跑书');
  const action = actionStore.create(bookId, 'update_character', { characterId: 1, note: '新备注' });
  actionStore.settle(action.id, 'rejected', undefined);

  state.responder = () => ({ sse: [contentChunk('明白，作者否决了该修改，我改用叙述交代。'), finishChunk('stop')] });
  const events = await readStream(http.baseUrl, bookId, { resumeActionId: action.id });
  assert.ok(events.find(e => e.type === 'done'));

  const last = state.requests[0].messages.at(-1);
  assert.ok(last.content.includes('被作者拒绝'), 'rejected 状态文案');
  assert.ok(last.content.includes('update_character'), '信封含工具名');
  assert.ok(!last.content.includes('执行结果：'), '无 result 时信封不含结果摘要段');
});

// ---------------- 场景 3：未结算（pending）→ 409，且不落信封 ----------------
test('未结算禁续跑：pending 动作返回 409，不写入信封', async t => {
  const { bookId, http } = await setup(t, '未结算书');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'x' });

  const r = await postStreamJson(http.baseUrl, bookId, { resumeActionId: action.id });
  assert.equal(r.status, 409);
  assert.ok(r.body.error.includes('尚未结算'));
  assert.equal(envelopeUserRows(bookId).length, 0, '预检拒绝不应写信封');
});

// ---------------- 场景 4：重复续跑 → 409，信封不重复 ----------------
test('重复续跑禁止：成功续跑后同一动作再续跑返回 409，信封不重复', async t => {
  const { bookId, http } = await setup(t, '重复续跑书');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'y' });
  actionStore.settle(action.id, 'approved', { ok: true });

  state.responder = () => ({ sse: [contentChunk('首次续跑完成。'), finishChunk('stop')] });
  await readStream(http.baseUrl, bookId, { resumeActionId: action.id });
  assert.equal(envelopeUserRows(bookId).length, 1);

  const r = await postStreamJson(http.baseUrl, bookId, { resumeActionId: action.id });
  assert.equal(r.status, 409);
  assert.ok(r.body.error.includes('已续跑过'));
  assert.equal(envelopeUserRows(bookId).length, 1, '重复续跑不应再写信封');
});

// ---------------- 场景 5：动作不存在 / 跨书 → 404 ----------------
test('动作不存在：无效 resumeActionId 返回 404', async t => {
  const { bookId, http } = await setup(t, '四零四书');
  const r = await postStreamJson(http.baseUrl, bookId, { resumeActionId: 'c_000000000000000000000000ff' });
  assert.equal(r.status, 404);
});

test('跨书动作：他书的确认动作不可用于本书续跑（404）', async t => {
  const { http } = await setup(t, '甲书');
  const other = actionStore.create(999999, 'append_chapter', { chapterId: 1, text: '别家' });
  actionStore.settle(other.id, 'approved', { ok: true });
  // setup 返回的 bookId 与 999999 不同即可
  const r = await postStreamJson(http.baseUrl, 999999, { resumeActionId: other.id });
  assert.equal(r.status, 404, '书籍不存在时也应 404');
});

// ---------------- 场景 6：续跑失败后不重放——唯一绑定保留，继续任务走普通请求 ----------------
test('续跑失败不重放：首次续跑 LLM 全程失败后，同动作再续跑返回既有 failed 运行，不重跑模型', async t => {
  const { bookId, http } = await setup(t, '幂等书');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'z' });
  actionStore.settle(action.id, 'approved', { ok: true });

  // 第一遍：LLM 全程 500（首轮建连失败 + 无半截 → 兜底也失败）→ error 事件。
  // M2（失败回滚统一）：流式整轮失败时用户消息（含续跑信封）随 A15 语义回滚删除——
  // 孤儿信封会污染后续上下文。
  state.responder = () => ({ status: 500, text: 'gateway down' });
  const events1 = await readStream(http.baseUrl, bookId, { resumeActionId: action.id });
  assert.ok(events1.some(e => e.type === 'error'), '应收到 error 事件');
  const afterFail = envelopeUserRows(bookId);
  assert.equal(afterFail.length, 0, 'M2：失败轮信封行已回滚，不留孤儿');
  assert.ok(!actionStore.get(action.id).resumeDone, '失败不应置 resumeDone');

  // S2-03 / C08：服务恢复后重发同一动作的续跑（换不换 requestId 都一样）——
  // resume_action_id 唯一索引返回既有 failed 运行（duplicate），不再调模型；
  // 继续任务的正确方式是发普通消息（模型在历史里看到上一次终态与真实结果）。
  state.requests = [];
  state.responder = () => ({ sse: [contentChunk('不该被调用的重放。'), finishChunk('stop')] });
  const r = await postStreamJson(http.baseUrl, bookId, { resumeActionId: action.id, request_id: 'retry-after-fail' });
  assert.equal(r.status, 200, '既有 failed 运行已终结 → 200 duplicate');
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.status, 'failed');
  assert.equal(state.requests.length, 0, '重发续跑不得再调模型');
  assert.equal(envelopeUserRows(bookId).length, 0, '不得再写信封');
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND role = 'assistant'", [bookId]).n,
    0,
    'assistant 回复仍为零'
  );
});

// ---------------- 场景 7：S2-03 并发续跑——同书并发 409，断连后重发 duplicate 不重放 ----------------
test('S2-03 并发续跑：生成中第二个续跑 409 CHAT_BUSY，断连后重发返回既有 cancelled 不重放', async t => {
  const { bookId, http } = await setup(t, '并发续跑书');
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'w' });
  actionStore.settle(action.id, 'approved', { ok: true });

  // 悬挂流：第一个续跑生成中（闸门占用）
  state.responder = () => ({ hang: true });
  const ac = new AbortController();
  const first = fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeActionId: action.id, request_id: 'cc-1' }),
    signal: ac.signal,
  }).catch(() => null);
  await new Promise(r => setTimeout(r, 300));

  // 并发第二个（同书不同 requestId）→ 单飞闸门 409
  const concurrent = await postStreamJson(http.baseUrl, bookId, { resumeActionId: action.id, request_id: 'cc-2' });
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.error.code, 'CHAT_BUSY');

  // 客户端断开 → 运行 cancelled、锁释放、resumeDone 未标
  ac.abort();
  await new Promise(r => setTimeout(r, 300));
  const runs = db.all("SELECT status FROM agent_runs WHERE resume_action_id = ?", [action.id]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'cancelled');
  assert.equal(state.requests.length, 1, '断连前只有一次 LLM 调用');
  await first; void first;

  // 断连后重发（新 requestId）→ 唯一索引返回既有 cancelled 运行，不重放
  state.requests = [];
  const retry = await postStreamJson(http.baseUrl, bookId, { resumeActionId: action.id, request_id: 'cc-3' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.status, 'cancelled');
  assert.equal(state.requests.length, 0, '重发不得再调模型');
});
