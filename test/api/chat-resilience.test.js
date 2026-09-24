const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// 续写提示的特征子串（chat.js 的 CONTINUE_NUDGE 未导出，用稳定关键词断言）
const NUDGE_MARK = '无缝续写';

// ---------------- 假 LLM 服务器 ----------------
// state.responder(body, idx) 返回：
//   { status, text } —— 非 200 响应（触发网关重试）
//   { json }         —— 非流式 completion
//   { sse: [...] }   —— 流式（逐块 SSE，末尾自动补 [DONE]）
function makeFakeApp(state) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.post('/chat/completions', (req, res) => {
    const idx = state.requests.length;
    state.requests.push(req.body);
    const out = state.responder(req.body, idx);
    if (out.status && out.status !== 200) return res.status(out.status).send(out.text || 'error');
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

const completion = (content, finish_reason) => ({ choices: [{ message: { content }, finish_reason }] });
const contentChunk = (text) => ({ choices: [{ delta: { content: text } }] });
const finishChunk = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const usageChunk = (u) => ({ choices: [], usage: u }); // 流式末尾的 usage 块（stream_options.include_usage）

// 读取被测应用的 SSE 流，解析为事件数组
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

let fake;       // 假 LLM 服务器（全程复用一个）
const state = { requests: [], responder: () => ({ json: completion('', 'stop') }) };

before(async () => { fake = await listen(makeFakeApp(state)); });
after(async () => { await fake.close(); });

// 每个用例：新建隔离库 + 建书 + 把 base_url 指向假服务器 + 起被测应用
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

// ---------------- 场景 1：网关重试（首次 500、二次 200） ----------------
test('网关重试：首次 500 后自动重试成功，/chat 返回正文', async t => {
  const { bookId, http } = await setup(t, '重试书');
  state.responder = (body, idx) => (idx === 0
    ? { status: 500, text: 'boom' }
    : { json: completion('重试后的正文。', 'stop') });

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: '写点什么' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, '重试后的正文。');
  assert.ok(state.requests.length >= 2, `应至少请求 2 次（含重试），实际 ${state.requests.length}`);
});

// ---------------- 场景 2：非流式 length → 回灌续写拼接 ----------------
test('length 续写：非流式半截被回灌续写，最终正文为拼接结果', async t => {
  const { bookId, http } = await setup(t, '续写书');
  state.responder = (body, idx) => (idx === 0
    ? { json: completion('第一章 上半段。', 'length') }
    : { json: completion('下半段结束。', 'stop') });

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: '写第一章' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, '第一章 上半段。下半段结束。');

  // 续写请求：无工具、末条为续写提示 user 消息、且回灌了半截 assistant
  const cont = state.requests[1];
  assert.equal(cont.tools, undefined, '续写轮不应带工具');
  const last = cont.messages[cont.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(String(last.content).includes(NUDGE_MARK), '末条应为续写提示');
  const assistantBack = cont.messages.find(m => m.role === 'assistant' && m.content === '第一章 上半段。');
  assert.ok(assistantBack, '应把半截正文回灌为 assistant 消息');
});

// ---------------- 场景 3：流式提前结束（无 finish_reason）→ 续传补齐 ----------------
test('流式续传：上游无 finish_reason 即结束，触发续传，done.content 完整', async t => {
  const { bookId, http } = await setup(t, '流式书');
  state.responder = (body, idx) => (idx === 0
    ? { sse: [contentChunk('流式上半段。')] } // 不发 finish_reason 直接结束
    : { sse: [contentChunk('流式下半段。'), finishChunk('stop')] });

  const events = await readStream(http.baseUrl, bookId, { content: '写第一章' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应收到 done 事件');
  assert.equal(done.content, '流式上半段。流式下半段。');
  assert.ok(events.some(e => e.type === 'recovering'), '应收到 recovering 轻提示事件');

  // 续传请求：流式、无工具
  const cont = state.requests[1];
  assert.equal(cont.stream, true, '续传应仍为流式');
  assert.equal(cont.tools, undefined, '续传轮不应带工具');

  // 拼接正文入库
  const row = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.equal(row.content, '流式上半段。流式下半段。');
});

// ---------------- 场景 4：泄漏工具标记 → 清洗（返回值 + 存库） ----------------
test('清洗：正文中的泄漏工具标记被删，正常正文保留（返回值与存库均清洗）', async t => {
  const { bookId, http } = await setup(t, '清洗书');
  // 用拼接构造泄漏块，避免测试源码出现字面开/闭合标记
  const leak = '正文开始。\n' + '<' + 'tool_response>\n{"ok":1}\n' + '<' + '/tool_response>\n正文结束。';
  state.responder = () => ({ json: completion(leak, 'stop') });

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: '写点什么' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply.includes('tool_response'), false, '返回值不应含泄漏标记');
  assert.ok(r.body.reply.includes('正文开始。'), '应保留前段正文');
  assert.ok(r.body.reply.includes('正文结束。'), '应保留后段正文');

  const row = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.equal(row.content.includes('tool_response'), false, '存库正文不应含泄漏标记');
});

// ---------------- 场景 5：续写轮 usage 计入 done.usage（修复前会拿首轮值而丢失续写轮） ----------------
test('续写轮 usage：流式续传后 done.usage 反映最后一轮用量（token 不丢失）', async t => {
  const { bookId, http } = await setup(t, 'usage书');
  state.responder = (body, idx) => (idx === 0
    // 首轮：有 content + usage，但不发 finish_reason → 提前结束
    ? { sse: [contentChunk('甲段。'), usageChunk({ prompt_tokens: 100, completion_tokens: 50 })] }
    // 续写轮：content + finish + 更大 prompt 的 usage
    : { sse: [contentChunk('乙段。'), finishChunk('stop'), usageChunk({ prompt_tokens: 220, completion_tokens: 80 })] });

  const events = await readStream(http.baseUrl, bookId, { content: '写第一章' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应收到 done 事件');
  assert.equal(done.content, '甲段。乙段。');
  assert.ok(events.some(e => e.type === 'recovering'), '应触发续传');
  // 续写轮（最后一轮）的 usage 应覆盖首轮，计入 done.usage
  assert.ok(done.usage, 'done 应带 usage');
  assert.equal(done.usage.completion_tokens, 80, 'completion_tokens 应为续写轮的值（非首轮 50）');
  assert.equal(done.usage.prompt_tokens, 220, 'prompt_tokens 应为续写轮的值（上下文更大）');
});

// ---------------- 场景 6：空输出（R02 同族）→ 不得当成功回复 ----------------
test('空输出：上游返回空正文时 run 终态为 paused/empty_output，不谎称完成', async t => {
  const { bookId, http } = await setup(t, '空输出书');
  state.responder = () => ({ json: completion('', 'stop') });

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: '写点什么' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, '', '空正文不得被包装成内容');
  assert.ok(r.body.run, `必须给出运行终态：${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.run.status, 'paused', `空输出不得判为 finished：${JSON.stringify(r.body.run)}`);
  assert.equal(r.body.run.reason, 'empty_output');
});
