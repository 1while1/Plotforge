const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');

// 2026-09-10 用户反馈「思考完卡住、工具卡消失」的回归保护：
// F1 无工具终轮整段正文都是 <tool_call> 标记（实测 agnes-2.5-flash 概率行为，finish=stop、
//    无结构化 tool_calls）——C6 清洗后为空，本轮只剩首轮过渡语 → followUpRounds 应带指令重试一次。
// F2 工具事件只存在于 SSE 事件，刷新即消失 → 应随助手消息落库（tools_json），GET /chat 回传。

// 假上游：按到达顺序派发脚本化应答（chat 路由的 LLM 调用串行，顺序确定）
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
  const upstream = scriptedUpstream(steps); // seen/count 供断言请求形态
  const fake = await listen(upstream.app);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
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

// 消费 SSE 流：返回按类型索引的事件序列
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

test('F1：无工具终轮整段为工具标记 → 清洗为空后带指令重试，产出真正文', async t => {
  const ctx = await setup(t, 'F1 标记重试');
  const chId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '正文。', 1)", [ctx.bookId]).lastInsertRowid;
  const markupOnly = '\n\n<tool_call>\n<function=create_story>\n<parameter=characters>王军</parameter>\n</function>\n</tool_call>';

  ctx.steps.push(
    // 1) 首轮流式：过渡语 + get_story_state 工具调用
    (req, res) => sse(res, [
      { choices: [{ delta: { content: '我来检索当前的故事状态。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮 round0（带工具）：再调一个读工具
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: chId }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    // 3) 终轮（无工具）：整段正文都是 <tool_call> 标记（实测概率行为）
    (req, res) => res.json({
      choices: [{ message: { content: markupOnly, reasoning_content: '（思考中……）' }, finish_reason: 'stop' }],
    }),
    // 4) 标记重试（无工具 + 系统提示）：给出真正文
    (req, res) => res.json({
      choices: [{ message: { content: '最终剧情建议：让王军调查母亲的皮衣来历。' }, finish_reason: 'stop' }],
    }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '接下来写什么剧情比较好' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应有 done 事件');
  assert.ok(done.content.includes('最终剧情建议'), `done 正文应含重试产出的建议，实际：${done.content.slice(0, 80)}`);

  // 助手消息入库为真正文（而非只剩过渡语）
  const row = db.get('SELECT role, content FROM messages WHERE book_id = ? ORDER BY id DESC LIMIT 1', [ctx.bookId]);
  assert.equal(row.role, 'assistant');
  assert.ok(row.content.includes('最终剧情建议'), '入库正文应为重试后的真正文');

  // 台账可见重试轮
  const retryRow = db.get("SELECT id FROM llm_calls WHERE book_id = ? AND scope = 'chat-followup-retry'", [ctx.bookId]);
  assert.ok(retryRow, 'llm_calls 应记录 chat-followup-retry');
});

test('F2：工具事件随助手消息落库，GET /chat 回传 tools（刷新后可回看）', async t => {
  const ctx = await setup(t, 'F2 工具持久化');

  ctx.steps.push(
    // 1) 首轮流式：一个读工具调用
    (req, res) => sse(res, [
      { choices: [{ delta: { content: '我来查一下故事状态。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮（带工具）：直接给出正文收尾
    (req, res) => res.json({
      choices: [{ message: { content: '检索完成。当前王军在安阳师范，建议下一步……' }, finish_reason: 'stop' }],
    }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '看看当前状态' });
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'get_story_state'), 'SSE 应推送工具事件');

  const row = db.get("SELECT tools_json FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  const tools = JSON.parse(row.tools_json || '[]').filter(entry => entry.kind !== 'run');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'get_story_state');

  const view = await fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat`).then(r => r.json());
  const last = view.messages[view.messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.ok(Array.isArray(last.tools) && last.tools[0].name === 'get_story_state', 'GET /chat 应回传解析后的 tools');
  assert.equal(last.tools_json, undefined, '原始列不应外泄');
});

test('P3：重试也塌缩时 regen 兜底必须携带工具结果上下文（convo 而非原始 messages）', async t => {
  const ctx = await setup(t, 'P3 regen 上下文');
  const NL = String.fromCharCode(10);
  const markupOnly = NL + NL + ['<tool_call>', '<function=create_story>', '<parameter=characters>王军</parameter>', '</function>', '</tool_call>'].join(NL);

  ctx.steps.push(
    // 1) 首轮流式：无正文，直接调工具（2026-09-10 13:54 实测形态）
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_story_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮 round0（带工具）：再调一次
    (req, res) => res.json({
      choices: [{
        message: { content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_story_state', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    // 3) 终轮（无工具）：整段标记
    (req, res) => res.json({ choices: [{ message: { content: markupOnly }, finish_reason: 'stop' }] }),
    // 4) 重试：仍然整段标记（双重塌缩）
    (req, res) => res.json({ choices: [{ message: { content: markupOnly }, finish_reason: 'stop' }] }),
    // 5) regen：给出真正文
    (req, res) => res.json({ choices: [{ message: { content: '基于检索结果的建议：王军的规则改写能力可作为主线推进。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '上网搜索一下' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done && done.content.includes('基于检索结果的建议'), 'done 正文应为 regen 产出的真正文');

  // 关键断言：regen 请求（第 5 次）携带工具结果上下文，而非无工具历史的原始 messages
  assert.equal(ctx.upstream.count(), 5);
  const regenBody = ctx.upstream.seen[4].body;
  const roles = regenBody.messages.map(m => m.role);
  assert.ok(roles.includes('tool'), 'regen 请求应包含工具结果消息（role=tool）');
  const regenRow = db.get("SELECT id FROM llm_calls WHERE book_id = ? AND scope = 'chat-regen'", [ctx.bookId]);
  assert.ok(regenRow, '应有 chat-regen 台账行');
  // 重试提示语不含「没有可用工具」类措辞（防模型向用户复述功能缺失）
  const retryBody = ctx.upstream.seen[3].body;
  const retryNudge = retryBody.messages[retryBody.messages.length - 1].content;
  assert.ok(!retryNudge.includes('没有可用工具') && !retryNudge.includes('没有工具'), '重试提示语不应声明无工具');
});

test('P1：工具指引明确「上网搜索」必须走 web_search，不得用内部检索替代或声称无功能', () => {
  const { TOOL_GUIDE } = require('../server/bookTools');
  assert.ok(TOOL_GUIDE.includes('web_search'), '指引应包含 web_search');
  assert.ok(/上网|联网/.test(TOOL_GUIDE), '指引应含联网触发词');
  assert.ok(TOOL_GUIDE.includes('不得声称没有联网功能'), '指引应禁止声称无联网功能');
});

// ---------------- 悬空承诺（2026-09-10 第三次反馈：问「第几卷第几章」思考完卡住） ----------------
const { looksLikeDanglingPromise, looksLikeSelfTruncationMarker, stripSelfTruncationMarker, collapseDuplicatedOutput } = require('../server/tools/loop-helpers');

test('looksLikeDanglingPromise：识别悬空过渡语，不误伤正常回复', () => {
  // 命中：实测原文（reasoning 已算出答案，正文停在这里）
  const NL = String.fromCharCode(10);
  assert.equal(looksLikeDanglingPromise('抱歉，我需要先确认当前进度。让我查看章节目录。' + NL + NL + '抱歉，我记错了进度。让我确认一下：'), true);
  assert.equal(looksLikeDanglingPromise('让我查看一下完整目录：'), true);
  assert.equal(looksLikeDanglingPromise('我来确认一下当前进度：'), true);
  // 不命中：正常短回复
  assert.equal(looksLikeDanglingPromise('当前是第3卷第4章。'), false);
  assert.equal(looksLikeDanglingPromise('好的。'), false);
  // 不命中：宣告后确有内容（冒号后接正文）
  assert.equal(looksLikeDanglingPromise('让我确认一下当前进度：' + NL + '第3卷《社会常识修改》· 第4章，王军刚完成午休时间的剧情。'), false);
  assert.equal(looksLikeDanglingPromise('我来解释一下写作思路：' + NL + '前情衔接方面，第1章已经引入了秦疏影，因此……'), false);
  // 不命中：长回复末尾出现同类措辞（正文已承载结论）
  assert.equal(looksLikeDanglingPromise('第3卷《社会常识修改》共6章。'.repeat(10) + '让我再确认一下章节标题的序号。'), false);
  // 空串不算悬空（由空正文兜底处理）
  assert.equal(looksLikeDanglingPromise(''), false);
  assert.equal(looksLikeDanglingPromise(null), false);
});

test('悬空承诺：终轮只吐过渡语 → 带指令重试并采纳完整答复', async t => {
  const ctx = await setup(t, '悬空重试');
  ctx.steps.push(
    // 1) 首轮流式：调工具
    (req, res) => sse(res, [
      { choices: [{ delta: { content: '让我查看一下当前进度。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{"limit":50}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 终轮（无工具）：悬空过渡语（复刻实测形态）
    (req, res) => res.json({
      choices: [{ message: { content: '抱歉，我记错了进度。让我确认一下：', reasoning_content: '当前进度是第3卷第4章……' }, finish_reason: 'stop' }],
    }),
    // 3) 重试：给出完整答复
    (req, res) => res.json({
      choices: [{ message: { content: '当前是第3卷《社会常识修改》，本章（第4章）已完成，下一章是第5章。' }, finish_reason: 'stop' }],
    }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '你知道现在是第几卷第几章吗' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应有 done 事件');
  assert.ok(done.content.includes('第3卷'), `done 正文应为完整答复，实际：${JSON.stringify(done.content)}`);
  assert.ok(!looksLikeDanglingPromise(done.content), '最终正文不应仍是悬空承诺');

  const row = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.ok(row.content.includes('第3卷'), '入库正文应为重试后的完整答复');
  const retryRow = db.get("SELECT id FROM llm_calls WHERE book_id = ? AND scope = 'chat-followup-retry'", [ctx.bookId]);
  assert.ok(retryRow, '应记录 chat-followup-retry 台账');

  // 重试请求携带半截正文（延续行文），且指令明令禁止再宣告动作
  const retryBody = ctx.upstream.seen[2].body;
  const lastTwo = retryBody.messages.slice(-2);
  assert.equal(lastTwo[0].role, 'assistant', '重试应回灌半截正文');
  assert.ok(lastTwo[1].content.includes('不要再宣告下一步动作'), '重试指令应禁止再宣告动作');
});

test('重试自身失败不毁整轮：保留已有产出并记 error 台账', async t => {
  const ctx = await setup(t, '重试失败兜底');
  ctx.steps.push(
    // 1) 首轮流式：调工具
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 终轮：悬空承诺
    (req, res) => res.json({ choices: [{ message: { content: '让我确认一下：' }, finish_reason: 'stop' }] }),
    // 3) 重试：上游 400（不可重试的硬错误，模拟网关拒绝/参数异常）
    (req, res) => res.status(400).json({ error: { message: 'bad request from upstream' } }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '问个问题' });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '上游重试失败时仍应有 done 事件（整轮不得陪葬）');
  assert.equal(done.content, '让我确认一下：', '应保留原产出而非空白/报错');

  const row = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.equal(row.content, '让我确认一下：', '入库应为原产出');

  const errRow = db.get("SELECT status, error FROM llm_calls WHERE book_id = ? AND scope = 'chat-followup-retry' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.ok(errRow, '重试失败也应入台账');
  assert.equal(errRow.status, 'error');
  assert.ok(String(errRow.error).length > 0, '应记录错误原因');
});

// ---------------- 虚假完成声明（2026-09-10 十章实测：第三个「假收尾」变体） ----------------
// 现场：作者说「把刚才这一章写进第1章」，模型需要「先查目录 → 再落笔」两步，但末轮强制
// 无工具收尾 → 它把没提交的写入说成既成事实（「第1章已写入，章节ID：113，字数约1800字」），
// reasoning 里还写着「我刚刚通过 update_chapter 调用了写入」（幻觉不存在的工具）。
// 实际 chapters.content 为 0、tool_audit_logs 无写工具记录 —— 作者把「已保存」当真即丢稿。
const { looksLikeWriteOutcomeClaim } = require('../server/tools/loop-helpers');

test('looksLikeWriteOutcomeClaim：识别虚假完成声明，不误伤讨论/否定/他类更新', () => {
  // 命中：实测原文形态
  assert.equal(looksLikeWriteOutcomeClaim('第1章《被粘回去的那一页》已写入，章节ID：113。字数约1800字，结尾悬念落在陈默写下"三班"二字。'), true);
  assert.equal(looksLikeWriteOutcomeClaim('已写入第1章。'), true);
  assert.equal(looksLikeWriteOutcomeClaim('正文已追加到当前章节，共 1800 字。'), true);
  assert.equal(looksLikeWriteOutcomeClaim('我把这一章保存到第3章了。'), true);
  // 不命中：否定/未完成
  assert.equal(looksLikeWriteOutcomeClaim('我还没有写入章节，需要你再确认一次。'), false);
  assert.equal(looksLikeWriteOutcomeClaim('本章尚未提交，正文如下：'), false);
  // 不命中：讨论与将来时（实测易误伤的形态）
  assert.equal(looksLikeWriteOutcomeClaim('第三章已经写完，接下来我打算写第四章。'), false);
  assert.equal(looksLikeWriteOutcomeClaim('好的，下面直接给出第1章正文：'), false);
  // 不命中：非章节正文的更新（大纲/设定）
  assert.equal(looksLikeWriteOutcomeClaim('已更新大纲，第2章改成了对峙。'), false);
  assert.equal(looksLikeWriteOutcomeClaim('当前是第3卷第4章。'), false);
  assert.equal(looksLikeWriteOutcomeClaim(''), false);
});

test('虚假完成声明：末轮谎称已写入且无待确认动作 → 带工具纠正轮真正提交写动作', async t => {
  const ctx = await setup(t, '虚假完成声明纠正');
  const bookId = ctx.bookId;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章：测试章', '']).lastInsertRowid;

  ctx.steps.push(
    // 1) 首轮流式：无正文，先调只读工具（实测形态：先查目录）
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮 round0（带工具）：直接宣称已写入（本轮不会真的提交）
    (req, res) => res.json({
      choices: [{ message: { content: '第1章已写入，章节ID：' + chapterId + '，字数约1800字。' }, finish_reason: 'stop' }],
    }),
    // 3) 纠正轮（应带工具）：真正调用 replace_chapter 提交整章
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_fix', type: 'function', function: { name: 'replace_chapter', arguments: JSON.stringify({ chapterId, content: '## 第1章：测试章\n\n正文内容。' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    // 4) 纠正后的收尾轮（无工具）：告知已提交待确认
    (req, res) => res.json({
      choices: [{ message: { content: '已完成提交，等待你点击确认后写入。' }, finish_reason: 'stop' }],
    }),
  );

  const events = await readStream(ctx.http, bookId, { content: '把刚才这一章写进第1章。', chapterId });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'replace_chapter'), '纠正轮应真正提交写动作（确认卡）');

  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应有 done 事件');
  assert.ok(!looksLikeWriteOutcomeClaim(done.content), `纠正后不得再是虚假完成声明，实际：${done.content.slice(0, 80)}`);

  // 纠正轮入台账，便于观察该分支触发频率
  const row = db.get("SELECT id, status FROM llm_calls WHERE book_id = ? AND scope = 'chat-writeclaim-retry' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(row, 'llm_calls 应记录 chat-writeclaim-retry');
  assert.equal(row.status, 'ok');
});

test('虚假完成声明：已有写动作提交时，末轮说「已提交」属实话，不再触发纠正轮', async t => {
  const ctx = await setup(t, '已提交不纠正');
  const bookId = ctx.bookId;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章：测试章', '']).lastInsertRowid;

  ctx.steps.push(
    // 1) 首轮流式：直接提交写动作（确认卡）
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'replace_chapter', arguments: JSON.stringify({ chapterId, content: '## 第1章\n\n正文。' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 后续轮 round0（带工具）：说「已提交待确认」——是实话
    (req, res) => res.json({
      choices: [{ message: { content: '第1章正文已提交，请在确认卡上点击同意。' }, finish_reason: 'stop' }],
    }),
  );

  const events = await readStream(ctx.http, bookId, { content: '把这一章写进第1章。', chapterId });
  assert.ok(events.some(e => e.type === 'action'), '应推送确认卡');

  const retryRow = db.get("SELECT id FROM llm_calls WHERE book_id = ? AND scope = 'chat-writeclaim-retry'", [bookId]);
  assert.ok(!retryRow, '已真实提交过写动作时不应触发纠正轮');
});

test('虚假完成声明：纠正轮失败保留审计但明确未验证写入', async t => {
  const ctx = await setup(t, '纠正轮失败兜底');
  const bookId = ctx.bookId;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章：测试章', '']).lastInsertRowid;

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({
      choices: [{ message: { content: '第1章已写入，章节ID：' + chapterId + '。' }, finish_reason: 'stop' }],
    }),
    // 纠正轮上游硬失败
    (req, res) => res.status(400).json({ error: { message: 'bad request from upstream' } }),
  );

  const events = await readStream(ctx.http, bookId, { content: '把这一章写进第1章。', chapterId });
  const done = events.find(e => e.type === 'done');
  assert.ok(done, '纠正轮失败时仍应有 done（整轮不得陪葬）');
  assert.equal(done.run.reason, 'unverified_write');
  assert.ok(done.content.includes('未验证'), '纠正失败不能保留虚假写入结论');

  const errRow = db.get("SELECT status, error FROM llm_calls WHERE book_id = ? AND scope = 'chat-writeclaim-retry' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(errRow, '纠正轮失败也应入台账');
  assert.equal(errRow.status, 'error');
});

test('工具指引单一来源：chat 路由的生效指引必须含联网规则与写正文规则', () => {
  // 回归保护：此前 chat.js 自带同名短版 TOOL_GUIDE，696d5cc 的联网规则改在 bookTools 那份上
  // 而生产路径用的是短版——测试断言 bookTools 绿灯，但规则从未到达模型。
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/TOOL_GUIDE[\s\S]{0,200}bookTools\.TOOL_GUIDE/.test(src), 'chat.js 的 TOOL_GUIDE 应直接引用 bookTools.TOOL_GUIDE，不得再自建副本');
  const { TOOL_GUIDE } = require('../server/bookTools');
  for (const kw of ['web_search', '不得声称没有联网功能', '一次交齐', '禁止谎报']) {
    assert.ok(TOOL_GUIDE.includes(kw), `生效指引应包含「${kw}」`);
  }
});

test('待确认动作列表：GET /chat/actions 返回未结算动作（刷新后可重建确认卡）', async t => {
  const ctx = await setup(t, '待确认动作列表');
  const bookId = ctx.bookId;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章：测试章', '']).lastInsertRowid;

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'replace_chapter', arguments: JSON.stringify({ chapterId, content: '## 第1章\n\n正文。' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '已提交，请确认。' }, finish_reason: 'stop' }] }),
  );

  await readStream(ctx.http, bookId, { content: '写进第1章', chapterId });

  const data = await fetch(`${ctx.http.baseUrl}/api/books/${bookId}/chat/actions`).then(r => r.json());
  assert.equal(data.actions.length, 1, '应返回一条待确认动作');
  const a = data.actions[0];
  assert.equal(a.name, 'replace_chapter');
  assert.equal(a.status, 'pending');
  assert.equal(a.args.chapterId, chapterId);
  assert.equal(a.chapterLocked, false, '章节未定稿时 chapterLocked 应为 false（与 SSE action 事件同口径）');

  // 他书不可见（作用域隔离）
  const other = db.run('INSERT INTO books (title) VALUES (?)', ['另一本']).lastInsertRowid;
  const otherData = await fetch(`${ctx.http.baseUrl}/api/books/${other}/chat/actions`).then(r => r.json());
  assert.equal(otherData.actions.length, 0, '不应泄露他书动作');
});

test('待确认动作列表：书不存在返回 404；已拒绝动作不再列出', async t => {
  const ctx = await setup(t, '动作列表边界');
  const bookId = ctx.bookId;

  const notFound = await fetch(`${ctx.http.baseUrl}/api/books/99999/chat/actions`);
  assert.equal(notFound.status, 404);

  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章：测试章', '']).lastInsertRowid;
  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'replace_chapter', arguments: JSON.stringify({ chapterId, content: '正文。' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '已提交。' }, finish_reason: 'stop' }] }),
  );
  await readStream(ctx.http, bookId, { content: '写进第1章', chapterId });

  const before = await fetch(`${ctx.http.baseUrl}/api/books/${bookId}/chat/actions`).then(r => r.json());
  assert.equal(before.actions.length, 1);

  const actionId = before.actions[0].id;
  const rejected = await fetch(`${ctx.http.baseUrl}/api/books/${bookId}/chat-actions/${actionId}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: false }),
  });
  assert.equal(rejected.status, 200);

  const after = await fetch(`${ctx.http.baseUrl}/api/books/${bookId}/chat/actions`).then(r => r.json());
  // 契约 2（F5a，2026-09-11）：actions 改为返回全部状态——已拒绝卡仍在列表里（供前端重建「已拒绝」卡），
  // 但不再是待确认（前端按 status 区分渲染）。
  assert.equal(after.actions.length, 1, '已拒绝的动作应作为已结算卡留在全状态列表');
  assert.equal(after.actions[0].status, 'rejected');
  assert.equal(after.actions[0].id, actionId);
  assert.deepEqual(after.expiredUnnotified, [], '无过期卡时 expiredUnnotified 为空数组');
});

test('后续轮泄漏的工具标记不得推给前端 content 事件（只推清洗后的文本）', async t => {
  const ctx = await setup(t, '流式清洗');
  const bookId = ctx.bookId;
  const NL = String.fromCharCode(10);
  const leak = NL + ['<tool_call>', '<function=replace_chapter>', '<parameter=chapterId>', '1', '</parameter>', '</function>', '</tool_call>'].join(NL);

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 后续轮（无工具收尾）：正文整段是泄漏标记 —— 实测形态
    (req, res) => res.json({ choices: [{ message: { content: '这一章就写到这里。' + leak }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '接着写' });
  const contentEvents = events.filter(e => e.type === 'content');
  for (const ev of contentEvents) {
    assert.ok(!/<\/?(tool_call|function|parameter)/.test(ev.text), `content 事件不应含泄漏标记，实际：${ev.text.slice(0, 120)}`);
  }
  const done = events.find(e => e.type === 'done');
  assert.ok(done.content.includes('这一章就写到这里'), '正文应保留');
  assert.ok(!/<\/?(tool_call|function|parameter)/.test(done.content), 'done 也不得含泄漏标记');
});

// ---------------- 未兑现的写入意图（2026-09-10 十章实测第4章现场） ----------------
// 实测原文：「第4章的chapterId是116，我直接用replace_chapter提交正文。」——回复到此为止，
// 没工具调用也没确认卡。既非「谎称已完成」（无「已/成功」），也不在悬空承诺动作词表
// （「我直接」不在 让我/我来/我先 之列），两种既有防护都漏掉，章节依旧为空。
const { looksLikeUnfulfilledWriteIntent } = require('../server/tools/loop-helpers');

test('looksLikeUnfulfilledWriteIntent：识别点名写工具却未提交的空头支票', () => {
  // 命中：实测原文
  assert.equal(looksLikeUnfulfilledWriteIntent('第4章的chapterId是116，我直接用replace_chapter提交正文。'), true);
  assert.equal(looksLikeUnfulfilledWriteIntent('我用写工具把这一章提交进去。'), true);
  assert.equal(looksLikeUnfulfilledWriteIntent('我需要append_chapter来追加这一章。'), true);
  // 不命中：普通回复与否定/讨论
  assert.equal(looksLikeUnfulfilledWriteIntent('正文已经写好了，你看这样行吗？'), false);
  assert.equal(looksLikeUnfulfilledWriteIntent('第4章的chapterId是116，但我不打算用replace_chapter。'), false);
  assert.equal(looksLikeUnfulfilledWriteIntent('这一章的内容如下：'), false);
  assert.equal(looksLikeUnfulfilledWriteIntent(''), false);
  // 两类判据互斥：同一句不得同时命中，避免重复纠正轮
  assert.equal(looksLikeWriteOutcomeClaim('第4章的chapterId是116，我直接用replace_chapter提交正文。'), false);
});

test('未兑现的写入意图：末轮点名写工具却未提交 → 纠正轮真正提交写动作', async t => {
  const ctx = await setup(t, '写入意图纠正');
  const bookId = ctx.bookId;
  for (let ordinal = 1; ordinal < 4; ordinal++) db.run('INSERT INTO chapters (book_id, title, sort_order) VALUES (?, ?, ?)', [bookId, '第' + ordinal + '章', ordinal - 4]);
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第4章：测试章', '']).lastInsertRowid;

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 末轮：点名写工具却收尾（实测形态）
    (req, res) => res.json({
      choices: [{ message: { content: '第4章的chapterId是' + chapterId + '，我直接用replace_chapter提交正文。' }, finish_reason: 'stop' }],
    }),
    // 纠正轮：真正提交
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_fix', type: 'function', function: { name: 'replace_chapter', arguments: JSON.stringify({ chapterId, content: '## 第4章\n\n正文。' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    (req, res) => res.json({ choices: [{ message: { content: '已提交，等待你确认。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '写第4章', chapterId });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'replace_chapter'), '纠正轮应真正提交写动作');

  const row = db.get("SELECT status FROM llm_calls WHERE book_id = ? AND scope = 'chat-writeclaim-retry' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(row, '应记录纠正轮台账');
  assert.equal(row.status, 'ok');
});

test('未兑现的写入意图：带【需要确认】的协议提问不算空头支票（不顶掉合法提问）', () => {
  // 实测第9章：模型发现 chapterId 与章序不符，先向作者提问再写——属协作模式的正确行为，
  // 强推纠正轮会把合法提问顶掉。协作协议标记是唯一的放行依据。
  const ask = '我来调用写工具提交第9章正文。\n\n【需要确认】\n1. 第9章对应的 chapterId 是 119 吗？';
  assert.equal(looksLikeUnfulfilledWriteIntent(ask), false);
  assert.equal(looksLikeUnfulfilledWriteIntent('我直接用replace_chapter提交正文。'), true);
  assert.equal(looksLikeUnfulfilledWriteIntent('我用写工具把这一章提交进去。'), true);
});

test('未兑现的写入意图·形态b：过渡语与正文粘连、明说提交却未提交（第10章现场）', () => {
  // 实测第10章：上一轮正文被截断，本轮模型把过渡语与整章正文粘在同一条回复里收尾——
  // 「我需要先确认第10章的完整正文是否存在，然后提交。…第10章还没有内容，我需要先写正文
  // 再提交。让我创作这一章：## 第10章…」。写工具名/「提交」出现在第 2、3 句，只看前两句会漏。
  const prose = '## 第10章：最后一页\n\n' + '陈默从河南回来后，没有直接回学校。他在火车站坐了很久。'.repeat(40);
  const glued = '我需要先确认第10章的完整正文是否存在，然后提交。让我先检查一下。\n\n'
    + '第10章还没有内容，我需要先写正文再提交。让我创作这一章：\n\n' + prose;
  assert.equal(looksLikeUnfulfilledWriteIntent(glued), true);
  // 反例：只说提交但正文太短（还没写）→ 不算，避免把正常说明误判
  assert.equal(looksLikeUnfulfilledWriteIntent('我需要提交第10章。让我先写。'), false);
  // 反例：对写入本身的否定
  assert.equal(looksLikeUnfulfilledWriteIntent('第4章的chapterId是116，但我不打算用replace_chapter。'), false);
  assert.equal(looksLikeUnfulfilledWriteIntent('这一章我不用写工具，直接输出。'), false);
});

test('悬空承诺：需要工具才能完成的意图（建人物）→ 重试轮必须带工具并真正结算工具调用', async t => {
  // 实测（2026-09-10 十章实测）：作者说「把陈默、老周、王教授建到人物中枢」，
  // 模型末轮只回「我先读取第1章正文，提取人物信息后再创建。」——它需要 create_character
  // 才能完成，而此前的无工具重试只能再吐一句过渡语，结果被「只采纳更好的结果」丢弃，
  // 作者最终拿到的仍是那句空话。修复：识别待落地动词 → 重试轮带工具 → 真结算。
  const ctx = await setup(t, '悬空需工具');
  const bookId = ctx.bookId;

  ctx.steps.push(
    // 1) 首轮流式：读工具
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 2) 终轮：悬空承诺（实测原文）
    (req, res) => res.json({
      choices: [{ message: { content: '我先读取第1章正文，提取人物信息后再创建。' }, finish_reason: 'stop' }],
    }),
    // 3) 重试轮（应带工具）：真正调用 create_character
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'create_character', arguments: JSON.stringify({ name: '陈默', role: '主角' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    // 4) 收尾话术
    (req, res) => res.json({ choices: [{ message: { content: '已提交创建人物，请确认。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '把陈默、老周、王教授建到人物中枢' });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'create_character'), '重试轮应真正提交 create_character（确认卡）');

  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应有 done');
  assert.ok(!looksLikeDanglingPromise(done.content), `最终答复不应仍是过渡语，实际：${done.content}`);
});

test('悬空承诺：纯问答型悬空保持无工具重试（不无谓放大工具面）', async t => {
  const ctx = await setup(t, '纯问答悬空');
  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '让我查看一下完整目录：' }, finish_reason: 'stop' }] }),
    (req, res) => res.json({ choices: [{ message: { content: '当前共 1 卷 1 章。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '现在有几卷几章' });
  const done = events.find(e => e.type === 'done');
  assert.equal(done.content, '当前共 1 卷 1 章。', '应采纳无工具重试的答复');
  assert.equal(ctx.upstream.count(), 3, '重试轮不应额外多调用（无工具路径只有一次重试）');
});

test('空白正文：末轮只回换行（"\n\n"）→ 视同空回复，带工具重试救回', async t => {
  // 实测（2026-09-10 十章实测建人物现场）：末轮 content="\n\n" finish=stop。
  // 旧判据两个分支都不进——`!sanitizedOut` 为假（"\n\n" 是真值）、悬空判据也不认
  // （没有冒号/过渡语），作者收到一条空白回复，任务静默失败。
  const ctx = await setup(t, '空白正文');
  const NL = String.fromCharCode(10);

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_chapters', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 末轮：只有换行
    (req, res) => res.json({ choices: [{ message: { content: NL + NL }, finish_reason: 'stop' }] }),
    // 重试轮（应带工具）：真正建人物
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'create_character', arguments: JSON.stringify({ name: '陈默' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    (req, res) => res.json({ choices: [{ message: { content: '已提交创建人物，请在确认卡确认。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '把陈默建到人物中枢' });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'create_character'), '空白末轮应带工具重试并真正提交');
  const done = events.find(e => e.type === 'done');
  assert.ok(done && done.content.length > 0, '最终不应是空白回复');
});

test('轮次预算：需要两步工具往返（读章节 → 建人物）时不被强制收尾打断', async t => {
  // 实测（2026-09-10 十章实测建人物）：maxRounds=2 = 「1 个带工具轮 + 1 个收尾轮」，
  // 模型第 1 轮只来得及读（list_chapters/read_chapter），第 2 轮被强制无工具，只能回
  // 「我先读取第1章正文，提取人物信息后创建。」任务静默失败。预算提到 3 后，
  // 「2 个带工具轮 + 1 个收尾轮」正好覆盖「先读 → 再建」两步。
  const ctx = await setup(t, '两步工具往返');
  const bookId = ctx.bookId;

  ctx.steps.push(
    // 第 1 轮（带工具）：先读章节
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: 1 }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 第 2 轮（带工具）：再建人物 —— 预算为 2 时这一轮会被强制无工具，任务失败
    (req, res) => res.json({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'create_character', arguments: JSON.stringify({ name: '陈默', role: '主角' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    // 第 3 轮（无工具收尾）：汇报结果
    (req, res) => res.json({ choices: [{ message: { content: '已提交陈默的人物档案，请在确认卡确认。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '把陈默建到人物中枢' });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'create_character'), '第 2 个带工具轮应能真正提交建人物');
  const done = events.find(e => e.type === 'done');
  assert.equal(done.run.status, 'awaiting_confirmation');
  assert.ok(done.content.includes('尚未生效'));
  assert.equal(ctx.upstream.count(), 2, '提交确认后不额外请求收尾');
});

// ---------------- 待办宣告（2026-09-10 十章实测建人物现场） ----------------
// 末轮只回一句「现在我根据第1章和第2章的内容，创建这三个人物档案。」——工具轮预算被读取
// 耗尽，收尾轮只剩宣告，X 从未发生。既非悬空承诺（无「让我查看…：」结构）也非虚假完成声明
// （无「已」），旧判据放行后作者收到一句空话。
const { looksLikePendingActionAnnouncement } = require('../server/tools/loop-helpers');

test('looksLikePendingActionAnnouncement：识别待办宣告，不误伤真内容', () => {
  assert.equal(looksLikePendingActionAnnouncement('现在我根据第1章和第2章的内容，创建这三个人物档案。'), true);
  assert.equal(looksLikePendingActionAnnouncement('接下来我来把这三个人物建档。'), true);
  // 不命中：普通叙述/结论/已完成
  assert.equal(looksLikePendingActionAnnouncement('下面我为你写一段分析。'), false);
  assert.equal(looksLikePendingActionAnnouncement('陈默是老周的徒弟，两人的关系在第三章有明显变化。'), false);
  assert.equal(looksLikePendingActionAnnouncement('已经创建好了这三个人物。'), false);
  assert.equal(looksLikePendingActionAnnouncement('当前共 1 卷 10 章。'), false);
  assert.equal(looksLikePendingActionAnnouncement(''), false);
});

test('待办宣告：末轮只宣告「创建这三个人物档案」→ 带工具重试并真正提交', async t => {
  const ctx = await setup(t, '待办宣告');
  const NL = String.fromCharCode(10);

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_chapter', arguments: JSON.stringify({ chapterId: 1 }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    // 带工具轮：只读，把预算花光
    (req, res) => res.json({
      choices: [{
        message: { content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'list_characters', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    // 收尾轮：只回一句宣告（实测原文）
    (req, res) => res.json({ choices: [{ message: { content: '现在我根据第1章和第2章的内容，创建这三个人物档案。' }, finish_reason: 'stop' }] }),
    // 重试轮（应带工具）：真正建人物
    (req, res) => res.json({
      choices: [{
        message: { content: '', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'create_character', arguments: JSON.stringify({ name: '陈默' }) } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    (req, res) => res.json({ choices: [{ message: { content: '已提交陈默的人物档案，请在确认卡确认。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '把陈默、老周、王教授建到人物中枢' });
  assert.ok(events.some(e => e.type === 'action' && e.name === 'create_character'), '待办宣告应触发带工具重试并真正建人物');
});

// ---------------- 写操作预检覆盖蛇形键与 subject_ref（2026-09-10 实测） ----------------
test('预检：chapter_id（蛇形）无效时当轮回打给模型，而不是等到作者点同意才报错', async t => {
  // 实测：模型把章节序号 1 当成 chapter_id 提交 propose_story_event，旧预检只认驼峰
  // chapterId → 直接挂成确认卡，作者点「同意」才收到 CROSS_BOOK_REFERENCE。
  const ctx = await setup(t, '蛇形键预检');
  const bookId = ctx.bookId;
  const chapterId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, NULL, ?, ?, 1)',
    [bookId, '第1章', '正文']).lastInsertRowid;
  const charId = require('../server/domain/characters').createCharacter(bookId, { name: '陈默' }).character.id;

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'propose_story_event', arguments: JSON.stringify({ title: '无效章节', chapter_id: 99999, changes: [{ change_kind: 'character_state', subject_ref: String(charId), field_key: 'location', new_value: '某地' }] }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '好的。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '提个提案' });
  assert.ok(!events.some(e => e.type === 'action' && e.name === 'propose_story_event'), '无效 chapter_id 不应挂成确认卡');

  const toolEv = events.find(e => e.type === 'tool' && e.name === 'propose_story_event');
  // 预检失败走的是 tool 消息回灌（模型可见），事件流里体现为该工具未被确认挂起
  const row = db.get("SELECT status FROM tool_audit_logs WHERE book_id = ? AND tool_name = 'propose_story_event' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(!row || row.status !== 'requested', '不应记录为 requested（说明被预检拦在前面）');

  // 合法 chapter_id 仍然放行
  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'propose_story_event', arguments: JSON.stringify({ title: '正确', chapter_id: chapterId, changes: [{ change_kind: 'character_state', subject_ref: String(charId), field_key: 'location', new_value: '某地' }] }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '已提交。' }, finish_reason: 'stop' }] }),
  );
  const events2 = await readStream(ctx.http, bookId, { content: '再提一个' });
  assert.ok(events2.some(e => e.type === 'action' && e.name === 'propose_story_event'), '合法 chapter_id 应正常挂确认卡');
});

test('预检：subject_ref 填人名时当轮回打给模型（不等到采纳才报错）', async t => {
  const ctx = await setup(t, 'subject_ref 预检');
  const bookId = ctx.bookId;

  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'propose_story_event', arguments: JSON.stringify({ title: '人名引用', changes: [{ change_kind: 'character_state', subject_ref: '陈默', field_key: 'location', new_value: '某地' }] }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    (req, res) => res.json({ choices: [{ message: { content: '好的。' }, finish_reason: 'stop' }] }),
  );

  const events = await readStream(ctx.http, bookId, { content: '提个提案' });
  assert.ok(!events.some(e => e.type === 'action'), 'subject_ref 为人名时不应挂确认卡');
});

// ---------------- 2026-09-10 用户反馈「最近一次输出截断了，写到一半就停下来」----------------
// 实测现场（book3 消息 465、llm_calls 277）：正文末尾「她发动汽车，然后……（较晚内容略）」
// ——「较晚内容略」全仓库 grep 不到，是模型自造的收尾，模仿自历史裁剪标记「……（较早内容略）」
// （该标记在同一次请求里出现 2 次）。finish_reason=stop 而非 length，故所有 length/断流兜底
// 都不触发；同一段 3204 字正文还被上游原样投递两遍，中间夹一个泄漏的 </think>。
test('looksLikeSelfTruncationMarker：识别结尾自造截断标记，不误伤正文中的「略」', () => {
  // 命中：结尾处的（……略）/（……省略）括注（实测原文与常见变体）
  assert.equal(looksLikeSelfTruncationMarker('她发动汽车，然后……（较晚内容略）'), true);
  assert.equal(looksLikeSelfTruncationMarker('正文到此为止。（后续内容略）'), true);
  assert.equal(looksLikeSelfTruncationMarker('他转身离开。（此处省略）'), true);
  assert.equal(looksLikeSelfTruncationMarker('（以下内容略）。'), true);
  // 不命中：正文中间提到「略」、无括注、其它结尾形态
  assert.equal(looksLikeSelfTruncationMarker('他略一沉吟，随即开口。'), false);
  assert.equal(looksLikeSelfTruncationMarker('前文（略）之后，他继续说着话，故事还没有结束。'), false);
  assert.equal(looksLikeSelfTruncationMarker('（此处内容略去不表，因为不便展开）'), false);
  assert.equal(looksLikeSelfTruncationMarker('欲知后事如何，且听下回分解。'), false);
  assert.equal(looksLikeSelfTruncationMarker(''), false);
});

test('机器历史省略标记是输入注记，不触发回答续写', () => {
  const { trimHistoryText, HISTORY_OLD_MAX_CHARS } = require('../server/llm');
  const clipped = trimHistoryText('甲'.repeat(HISTORY_OLD_MAX_CHARS + 20));
  assert.ok(clipped.endsWith('[... 前文另有 20 字已省略]'));
  assert.equal(looksLikeSelfTruncationMarker(clipped), false);
  assert.equal(looksLikeSelfTruncationMarker('作者引用了「[... 前文另有 20 字已省略]」'), false);
  assert.equal(looksLikeSelfTruncationMarker('这一段先（较晚内容略）再写下一段。'), false);
  assert.equal(stripSelfTruncationMarker(clipped), clipped);
});

test('stripSelfTruncationMarker：摘掉结尾标记，保留正文（续写回灌用）', () => {
  assert.equal(stripSelfTruncationMarker('她发动汽车，然后……（较晚内容略）'), '她发动汽车，然后……');
  assert.equal(stripSelfTruncationMarker('正文完整，没有标记。'), '正文完整，没有标记。');
});

test('collapseDuplicatedOutput：逐字节重复的长正文折叠为一段', () => {
  const half = '## 第六章：猎场\n\n' + '王军走出购物中心时，阳光正好。'.repeat(40); // 长于 400 字
  // 实测分隔片段：\n</think>\n\n（清洗后为空白），此处用等价空白分隔
  assert.equal(collapseDuplicatedOutput(half + '\n\n' + half), half);
  // 三次投递也收敛到一段
  assert.equal(collapseDuplicatedOutput(half + '\n' + half + '\n' + half), half);
  // 不命中：正常长篇（两段不同）原样返回
  const other = '## 第七章：另一个标题\n\n' + '李四推开门。'.repeat(40);
  assert.equal(collapseDuplicatedOutput(half + '\n\n' + other), half + '\n\n' + other);
  // 不命中：短文本重复（可能是刻意的排比/复沓，不折叠）
  assert.equal(collapseDuplicatedOutput('好的好的'), '好的好的');
});

test('自造截断标记：末轮正文停在「（较晚内容略）」→ 无缝续写补齐后再入库', async t => {
  const ctx = await setup(t, '自造截断标记');
  const chId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第五章', '正文。', 1)", [ctx.bookId]).lastInsertRowid;
  const half = '## 第六章：猎场\n\n王军走出购物中心时，阳光正好。';
  const tail = '女人的眼神突然变得空洞，规则覆盖了她。她发动汽车，然后……（较晚内容略）';

  ctx.steps.push(
    // 1) 首轮流式：整章正文，末尾是模型自造的截断标记，finish=stop（不是 length）
    (req, res) => sse(res, [
      { choices: [{ delta: { content: half + tail } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
    // 2) 无缝续写轮（回灌半截 + 续写提示，流式）：接着写剩下的正文
    (req, res) => sse(res, [
      { choices: [{ delta: { content: '她踩下油门，车子汇入车流。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '方向C' });
  assert.ok(events.some(e => e.type === 'recovering'), '截断标记应触发无缝续写提示');
  // 落库与终态（done 事件）都以「摘掉标记 + 续写补齐」后的完整正文为准；
  // 实时气泡里标记会一闪而过（流式内容已发出，无法未卜先知），但前端随后用 done 的
  // content 重建正式消息，作者最终看到的正文是干净的——与 length 续写的既有行为一致。
  const done = events.find(e => e.type === 'done');
  assert.ok(done && done.content.includes('她踩下油门'), 'done 应携带补齐后的完整正文');
  assert.equal(/（较晚内容略）/.test(done.content), false, '自造截断标记不得留在终态正文里');

  // 入库内容：已补齐、不含自造截断标记、且未把标记带进续写
  const msg = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.ok(msg.content.includes('她踩下油门'), '入库正文应含续写结果');
  assert.equal(/较晚内容略/.test(msg.content), false, '自造截断标记必须被摘掉');
  const audit = db.get("SELECT finish_reason FROM llm_calls WHERE book_id = ? ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.ok(audit, '续写轮应落调用台账');
  void chId;
});

test('上游重复投递 + </think> 泄漏：入库前折叠为一段并清掉思考标签', async t => {
  const ctx = await setup(t, '重复投递折叠');
  const half = '## 第六章：猎场\n\n' + '王军走出购物中心时，阳光正好。'.repeat(30);
  const closeThink = '<' + '/think' + '>';

  ctx.steps.push(
    // 首轮流式：同一段正文原样两遍，中间夹一个泄漏的思考标签（实测形态），finish=stop
    (req, res) => sse(res, [
      { choices: [{ delta: { content: half + '\n' + closeThink + '\n' + half } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  );

  const events = await readStream(ctx.http, ctx.bookId, { content: '方向C' });
  const msg = db.get("SELECT content FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [ctx.bookId]);
  assert.ok(msg && msg.content, '应有助手消息入库');
  assert.equal(/<\/?think/i.test(msg.content), false, '思考标签不得入库');
  const occurrences = msg.content.split('## 第六章：猎场').length - 1;
  assert.equal(occurrences, 1, '重复投递的正文应折叠为一段');
  void events;
});

// ---------------- 2026-09-11 用户反馈「聊天和工具全是乱的」----------------
// 实测根因：前后端都没有并发保护——确认卡续跑与手输消息可同时发出，两条流并行各跑一遍
// 完整工具循环。证据：llm_calls 315/316 相隔 1.4 秒同时启动、317/318 同样重叠；
// 落库出现连续两条 assistant（487/488 相隔 5 秒、491/492 相隔 2 秒，中间无用户消息）；
// 同一写动作被重复提交成 2 张 create_chapter、3 张 update_volume 同参确认卡。
// 对齐 pi：Agent.prompt 在 activeRun 期间直接抛错，由调用方改走 steer/followUp 队列。
test('单飞闸门：同一本书的流式请求进行中时，第二个请求返回 409 CHAT_BUSY', async t => {
  const ctx = await setup(t, '单飞闸门');
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });

  ctx.steps.push(
    // 第一条流：先吐一段正文，然后挂住（模拟长耗时回复），由测试显式放行
    async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一条回复正在写。' } }] })}\n\n`);
      await firstHeld;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    },
  );

  const first = fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '第一条' }),
  });

  // 等第一条真正进入在飞状态（首个 delta 已到达）
  await new Promise(r => setTimeout(r, 150));

  // 第二条并发请求：必须被闸门挡下，而不是并行跑第二遍工具循环
  const second = await fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '第二条（不应并发执行）' }),
  });
  assert.equal(second.status, 409, '并发流应被挡下');
  const body = await second.json();
  assert.equal(body.error.code, 'CHAT_BUSY', '应返回可识别的 CHAT_BUSY 码供前端排队');

  releaseFirst();
  const firstRes = await first;
  assert.equal(firstRes.status, 200, '第一条流应正常完成');
  await firstRes.text();

  // 闸门释放后可正常再发（不能被永久卡死）
  ctx.steps.push(
    (req, res) => sse(res, [
      { choices: [{ delta: { content: '第二条正常执行。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  );
  const third = await readStream(ctx.http, ctx.bookId, { content: '第三条' });
  assert.ok(third.some(e => e.type === 'done'), '前一条结束后应能正常发起新的流');

  // 全程只有一条并行流：两条消息各入库一次
  const assistants = db.all("SELECT id FROM messages WHERE book_id = ? AND role = 'assistant' ORDER BY id", [ctx.bookId]);
  assert.equal(assistants.length, 2, '应恰好两条助手消息（被挡下的并发请求不入库）');
});

test('单飞闸门：不同书互不影响（并发按书隔离）', async t => {
  const ctx = await setup(t, '跨书并发');
  const otherBookId = db.run("INSERT INTO books (title) VALUES ('另一本书')").lastInsertRowid;
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });

  ctx.steps.push(
    async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '书A正在写。' } }] })}\n\n`);
      await firstHeld;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}` + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    },
  );

  const first = fetch(`${ctx.http.baseUrl}/api/books/${ctx.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '书A' }),
  });
  await new Promise(r => setTimeout(r, 150));

  // 另一本书不应被 A 的在飞状态影响
  const otherStatus = await fetch(`${ctx.http.baseUrl}/api/books/${otherBookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '书B' }),
  }).then(r => r.status);
  // mock 上游脚本已耗尽 → 该请求自身可能失败，但绝不应是 409（说明闸门按书隔离）
  assert.notEqual(otherStatus, 409, '不同书之间不应互相阻塞');

  releaseFirst();
  await (await first).text();
});
