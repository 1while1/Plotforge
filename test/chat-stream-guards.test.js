// M2：聊天流管线统一的单测——共享护栏纯函数（server/chat/stream-guards）+ 双侧对齐 + 失败回滚统一
//  覆盖：
//   ① finalTextGuards 纯函数：首见（不折叠）/ 重复（两段重放折叠）/ 变体（三段+Markdown 分隔+泄漏 </think>）
//   ② detectSelfTruncation 纯函数：命中摘标记 / 未命中
//   ③ 失败回滚语义：流式整轮失败回滚（对齐 A15）；非流式 A15 回归；断连（clientGone）不回滚的边界
//   ④ 双侧对齐：非流式管线的重放折叠 + 自造截断标记续写补齐（此前只挂在流式侧）
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const streamGuards = require('../server/chat/stream-guards');

const NL = String.fromCharCode(10);
const halfText = () => '## 第六章：猎场' + NL + NL + '王军走出购物中心时，阳光正好。'.repeat(40); // > 400 字

// ---------------- ① 共享护栏纯函数 ----------------

test('finalTextGuards：首见正常文本原样通过（无折叠、清洗不动）', () => {
  const half = halfText();
  const other = '## 第七章：夜行' + NL + NL + '李四推开门，风灌了进来。'.repeat(40);
  assert.equal(streamGuards.finalTextGuards(half + NL + NL + other), half + NL + NL + other);
  assert.equal(streamGuards.finalTextGuards('当前是第3卷第4章。'), '当前是第3卷第4章。');
  assert.equal(streamGuards.finalTextGuards(''), '');
});

test('finalTextGuards：上游重放（两段逐字节相同长文本）折叠为一段', () => {
  const half = halfText();
  assert.equal(streamGuards.finalTextGuards(half + NL + NL + half), half);
});

test('finalTextGuards：变体——三段重放 + Markdown 分隔 + 泄漏 </think> 先清洗再折叠', () => {
  const half = halfText();
  const closeThink = '<' + '/think' + '>';
  // 2026-09-10 实测形态：重放段之间夹一个泄漏的 </think>——必须先清洗（否则段间出现非空白
  // 分隔符，重放判据不命中）再折叠，顺序不可换
  assert.equal(streamGuards.finalTextGuards(half + NL + closeThink + NL + half), half);
  // 三段重放、段间混用空白与星号分隔（总长 ≤ 8 字符），多轮折叠后收敛为一段
  assert.equal(streamGuards.finalTextGuards(half + NL + NL + half + NL + '***' + NL + half), half);
});

test('detectSelfTruncation：命中返回摘掉标记的半截；未命中 hit=false', () => {
  const st = streamGuards.detectSelfTruncation('她发动汽车，然后……（较晚内容略）');
  assert.equal(st.hit, true);
  assert.equal(st.cut, '她发动汽车，然后……');
  const no = streamGuards.detectSelfTruncation('正文完整结束。');
  assert.equal(no.hit, false);
  assert.equal(no.cut, null);
  assert.equal(streamGuards.detectSelfTruncation('').hit, false);
});

// ---------------- ③④ 管线集成（临时库 + 脚本化假上游） ----------------

function scriptedUpstream(stepsRef) {
  const app = express();
  app.use(express.json());
  const seen = [];
  let i = 0;
  app.post('/chat/completions', (req, res) => {
    seen.push({ index: i, body: req.body });
    const step = stepsRef[i];
    i += 1;
    if (!step) return res.status(500).json({ error: 'script exhausted' });
    step(req, res);
  });
  return { app, seen, count: () => i };
}

function sse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const steps = [];
  const upstream = scriptedUpstream(steps);
  const fake = await listen(upstream.app);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  for (let ordinal = 1; ordinal <= 6; ordinal++) db.run('INSERT INTO chapters (book_id, title, sort_order) VALUES (?, ?, ?)', [bookId, '第' + ordinal + '章', ordinal]);
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [fake.baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['agnes-2.5-flash']);
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    if (fake.server.closeAllConnections) fake.server.closeAllConnections();
    await http.close();
    await fake.close();
    cleanup(location);
  });
  return { bookId, steps, http, upstream };
}

async function readStream(http, bookId, body) {
  const res = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

test('M2 回滚：流式首轮+兜底全部失败 → error 事件 + 用户消息回滚（对齐 A15 非流式语义）', async t => {
  const ctx = await setup(t, 'M2 流式回滚');
  // 不提供任何 step：假上游对所有请求回 500，网关重试 3 次后失败 → 首轮与兜底都失败
  const events = await readStream(ctx.http, ctx.bookId, { content: '写一段' });
  assert.ok(events.some(e => e.type === 'error'), '整轮失败应有 error 事件');
  const rows = db.all('SELECT role FROM messages WHERE book_id = ?', [ctx.bookId]);
  assert.equal(rows.length, 0, '失败轮的用户消息必须回滚，不留无回复的孤儿消息');
  const errScopes = db.all("SELECT scope FROM llm_calls WHERE book_id = ? AND status = 'error'", [ctx.bookId]).map(r => r.scope);
  assert.ok(errScopes.includes('chat-stream') && errScopes.includes('chat-stream-fallback'),
    `首轮与兜底失败都应入台账，实际：${errScopes.join(',')}`);
});

test('M2 回滚：非流式失败回滚语义保持（A15 回归，不因本次改造退化）', async t => {
  const ctx = await setup(t, 'M2 非流式回滚');
  const res = await fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '写一段' }),
  });
  assert.equal(res.status, 502);
  const rows = db.all('SELECT role FROM messages WHERE book_id = ?', [ctx.bookId]);
  assert.equal(rows.length, 0, '非流式失败轮用户消息回滚（既有 A15 行为）');
});

test('M2 回滚边界：客户端断连不回滚用户消息（断连≠失败，消息是真实历史）', async t => {
  const ctx = await setup(t, 'M2 断连边界');
  let release;
  const held = new Promise(r => { release = r; });
  ctx.steps.push((req, res) => {
    // 首轮流式：吐一段正文后挂住；服务端 abort 上游 fetch 时本连接关闭 → 放行
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '正在写。' } }] })}\n\n`);
    res.on('close', release);
  });

  const clientAc = new AbortController();
  const p = fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '写一段长的' }),
    signal: clientAc.signal,
  }).catch(() => null);
  await new Promise(r => setTimeout(r, 400)); // 等服务端真正进入在飞状态
  clientAc.abort();                            // 客户端断连
  await Promise.race([held, new Promise(r => setTimeout(r, 3000))]);
  await new Promise(r => setTimeout(r, 300)); // 等服务端 settle（断连路径 return res.end()）
  await p;

  const rows = db.all('SELECT role FROM messages WHERE book_id = ? ORDER BY id', [ctx.bookId]);
  assert.deepEqual(rows.map(r => r.role), ['user'],
    '断连路径用户消息保留（与既有阶段边界行为一致），且不落未完成的 assistant');
});

test('M2 对齐：非流式上游重放 → 终局护栏折叠后入库为一段（此前只挂在流式侧）', async t => {
  const ctx = await setup(t, 'M2 非流式折叠');
  const half = halfText();
  ctx.steps.push((req, res) => res.json({
    choices: [{ message: { content: half + NL + NL + half }, finish_reason: 'stop' }],
  }));
  const data = await fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '写第六章' }),
  }).then(r => r.json());
  assert.equal(data.reply, half, '回复应为折叠后的单段正文');
  const row = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.equal((row.content.split('## 第六章：猎场').length - 1), 1, '入库正文只应有一段（重放已折叠）');
});

test('M2 对齐：非流式自造截断标记 → continueNonStream 补齐后入库（与流式同判据）', async t => {
  const ctx = await setup(t, 'M2 非流式截断标记');
  const head = '## 第六章：猎场' + NL + NL + '王军走出购物中心。';
  ctx.steps.push(
    (req, res) => res.json({
      choices: [{ message: { content: head + '她发动汽车，然后……（较晚内容略）' }, finish_reason: 'stop' }],
    }),
    (req, res) => res.json({
      choices: [{ message: { content: '她踩下油门，车子汇入车流。' }, finish_reason: 'stop' }],
    }),
  );
  const data = await fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '写第六章' }),
  }).then(r => r.json());
  assert.ok(data.reply.includes('她踩下油门'), `续写结果应并入回复，实际：${data.reply.slice(0, 80)}`);
  assert.ok(!data.reply.includes('较晚内容略'), '自造截断标记不得留在终态正文');
  assert.equal(ctx.upstream.count(), 2, '恰好两次 LLM 调用（首轮 + 续写）');
  // 续写请求回灌的是摘掉标记后的半截（与流式 streamContinue 同口径）
  const contBody = ctx.upstream.seen[1].body;
  const asst = contBody.messages.find(m => m.role === 'assistant');
  assert.ok(asst.content.endsWith('她发动汽车，然后……'), '续写回灌应停在自然的半句上');
});

test('M2 对齐：流式管线的重放折叠经共享模块不回归', async t => {
  const ctx = await setup(t, 'M2 流式防线回归');
  const half = halfText();
  ctx.steps.push(
    (req, res) => sse(res, [
      // 2026-09-10 实测形态：同一段正文原样两遍，中间夹一个泄漏的 </think>，finish=stop
      { choices: [{ delta: { content: half + NL + '<' + '/think' + '>' + NL + half } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  );
  const events = await readStream(ctx.http, ctx.bookId, { content: '写第六章' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应有 done 事件');
  assert.equal(done.content.split('## 第六章：猎场').length - 1, 1, '流式侧重放折叠仍生效（经共享模块）');
});
