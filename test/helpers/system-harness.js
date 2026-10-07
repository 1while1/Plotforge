// S6-01 系统验收共享设施：合成书 + 真实路由驱动 + 故障注入 + 安全不变量计数器。
//
// 设计口径（对齐 07-阶段六-整体验收.md §S6-01）：
//  1. 动作链全部走真实 HTTP 路由（写作 `/api/books/:id/chat/stream`、Agent `/api/agent/chat`），
//     不直调领域函数替代全链；断言侧才直接读库/读磁盘（「重读实际库」本身就是断言动作）。
//  2. 上游模型一律走 fetch 边界剧本（helpers/llm-stub）：每轮剧本步数与实际请求数双向核对，
//     多调一次即抛「剧本耗尽」，少调一次记 unusedScriptSteps——不靠 sleep 猜时序。
//  3. 合成书至少两卷、每卷章号从「第1章」重新起算（真实存在重复展示章号），
//     并且每轮以**旧章**为选中目标（不是最新章），验证定位与写入不串目标。
//  4. 故障为真实注入：断连用真实 AbortController、磁盘失败拦真实 fs.writeFileSync、
//     重复请求用同 request_id/同确认 id 真实重发、隔离进程重启用 child_process 真起真杀。
//  5. 五条安全不变量由真实检测计数（不是常量 0）：未授权写＝「预期不写却出现行」的实测增量；
//     重复生效＝同一次确认的真实副作用 > 1；串会话＝上游请求体里出现别会话哨兵；
//     假保存＝宣称成功但实际库/磁盘对不上；清理后活跃运行＝锁表 + 运行行 + 未结算卡实测。
//
// 临时库路径由 helpers/temp-db 创建（os.tmpdir），不接触仓库 data/。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { db, createTempLocation, cleanup } = require('./temp-db');
const { createApp } = require('../../server/app');
const { listen } = require('./http');
const actionStore = require('../../server/actionStore');
const runSvc = require('../../server/runtime/run-service');
const summaryProposals = require('../../server/domain/chapterSummaryProposals');
const autoHealthcheck = require('../../server/style/autoHealthcheck');
const { revision } = require('../../server/evidence/draftLexical');
const {
  installFetchStub, sseStub, jsonStub, chatPayload, toolCall, readStreamEvents, waitUntil,
} = require('./llm-stub');
const { installEmbedGate, waitFor, guardOutboundFetch } = require('./vector-embed-gate');
const { RETRY_MAX_ATTEMPTS } = require('../../server/llm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STUB_BASE_URL = 'http://llm-stub.local/v1';

// ---------------------------------------------------------------- 系统上下文

// 打开一套隔离系统：临时库 + 占位模型配置 + fetch 剧本桩 + 可控 embedding + 真实 HTTP 服务。
// 调用方负责 dispose（测试里用 t.after，长跑驱动里 try/finally）。
// filePath（S6-03 追加，默认 null 保持原语义）：显式临时库路径——长跑驱动要求库落在
// 任务卡指定目录（系统临时证据目录/），此时不建临时目录、dispose 也不删该文件。
async function openSystem({ label = 's6-01', filePath = null } = {}) {
  const location = filePath
    ? { dir: null, filePath: path.resolve(filePath), external: true }
    : createTempLocation();
  await db.init({ filePath: location.filePath });
  actionStore.clear();
  // 顺序要紧：先装出网守卫，再装 fetch 剧本桩，桩的 orig 才是守卫（非 /chat/completions 一律只放行本机）
  const restoreOutbound = guardOutboundFetch();
  const stub = installFetchStub();
  const embedGate = installEmbedGate();
  const originalExtraction = summaryProposals.scheduleChapterExtraction;
  const originalHealthcheck = autoHealthcheck.maybeAutoCheck;
  // 定稿会调度 6 秒延迟的后台抽取（真实 LLM）与作家卡体检——本套验收按 S5-04 既有口径换空实现，
  // 保证「模型请求次数」只由本轮剧本产生（没有任何后台偷跑的调用混进来）。
  summaryProposals.scheduleChapterExtraction = () => 's6-01-mocked';
  autoHealthcheck.maybeAutoCheck = async () => ({ ran: false, reason: 's6-01' });
  // 占位渠道配置（与 M5 核心循环单测同口径：端点为不可路由占位域名，key 为 sk-test-xxx）
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?)", [STUB_BASE_URL]);
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'synthetic-flash')");
  const http = await listen(createApp());
  const ctx = {
    label,
    location,
    filePath: location.filePath,
    http,
    stub,
    embedGate,
    async dispose() {
      if (http.server.closeAllConnections) http.server.closeAllConnections();
      await http.close();
      stub.restore();
      embedGate.restore();
      summaryProposals.scheduleChapterExtraction = originalExtraction;
      autoHealthcheck.maybeAutoCheck = originalHealthcheck;
      restoreOutbound();
      if (location.external) db.close(); else cleanup(location);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- HTTP 基础

async function api(ctx, method, pathname, body) {
  const res = await fetch(ctx.http.baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  return { status: res.status, body: payload, text };
}

// 写作页 SSE：返回 {status, events}；非 SSE（幂等 JSON / 409 / 404）回 {status, json}
async function writingStream(ctx, bookId, body, { signal } = {}) {
  const res = await fetch(`${ctx.http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null);
    return { status: res.status, json, events: [] };
  }
  // 故障注入下（客户端断连 / 服务端 watchdog abort）流读取可能以「terminated」收场——
  // 那正是被观测的故障本身，如实记进 readError，而不是让整轮验收崩掉。
  try {
    const events = await readStreamEvents(res);
    return { status: res.status, events, json: null, readError: null };
  } catch (err) {
    return { status: res.status, events: [], json: null, readError: String((err && err.message) || err) };
  }
}

// Agent 页 SSE（SDK UI Message Stream）：返回 {status, parts}；非 SSE 回 {status, json}
async function agentStream(ctx, body, { signal } = {}) {
  const res = await fetch(`${ctx.http.baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null);
    return { status: res.status, json, parts: [] };
  }
  let text = '';
  let readError = null;
  try {
    text = await res.text();
  } catch (err) {
    readError = String((err && err.message) || err);  // watchdog/断连：连接被系统中止（故障本身）
  }
  const parts = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { parts.push(JSON.parse(payload)); } catch { /* 半包 */ }
  }
  return { status: res.status, parts, json: null, readError };
}

// 读一个 SSE 响应体直到结束（用于断连场景把连接彻底放掉）
async function drainResponse(res) {
  if (!res || !res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// ---------------------------------------------------------------- 剧本（fetch 边界）

// 开始一轮：清空残留剧本，按序登记本轮的每一步上游响应。
// 返回的 finish() 给出「模型请求次数 / 未消费的剧本步数」——两个方向都留证据。
function beginScript(ctx, steps) {
  ctx.stub.responders.length = 0;
  const startCalls = ctx.stub.calls.length;
  steps.forEach(step => {
    ctx.stub.responders.push(init => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      return step(body);
    });
  });
  return {
    finish() {
      const llmRequests = ctx.stub.calls.length - startCalls;
      const unusedScriptSteps = ctx.stub.responders.length;
      ctx.stub.responders.length = 0;
      return { llmRequests, unusedScriptSteps };
    },
  };
}

// 上游错误响应（429/5xx）：llm.js 网关读 res.ok/status/text/headers
function httpErrorStub(status, message) {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: { message: message || `synthetic ${status}` } }),
  };
}

// 悬挂的流式响应：吐一帧后不结束（真实「生成中」形态；断连/重启场景用）。
// 注意：普通 web ReadableStream 的 cancel 不会让 SDK 的读循环自己结束——真挂到天荒地老会把
// 验收拖成分钟级（实测 307s）。所以给它一个自终止上限（默认 2s，调用方要更长窗口就显式传），
// 语义等价于「上游静默一段后断流」，且不改变被观测的故障时序（断言都在窗口内完成）。
function hangingStream(firstText = '正在写。', autoCloseMs = 2000) {
  let ctl = null;
  let timer = null;
  const body = new ReadableStream({
    start(controller) {
      ctl = controller;
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: firstText } }] })}\n\n`
      ));
      if (autoCloseMs > 0) {
        timer = setTimeout(() => { try { controller.close(); } catch { /* 已关 */ } }, autoCloseMs);
        if (timer.unref) timer.unref();
      }
    },
  });
  return {
    response: { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body },
    close() { if (timer) clearTimeout(timer); try { ctl.close(); } catch { /* 已关 */ } },
  };
}

// AI SDK 的 provider 会读 response.headers（extractResponseHeaders 要求可迭代），
// 而 llm-stub 的 sseStub/jsonStub 不带 headers——Agent 面剧本一律补上响应头。
// 写作面（chat.js 直接读 res.body/res.json）两者都吃，统一补头不改变写入面行为。
function withHeaders(response, contentType) {
  return { ...response, headers: new Headers({ 'content-type': contentType }) };
}
const sseHeaders = response => withHeaders(response, 'text/event-stream; charset=utf-8');
const jsonHeaders = response => withHeaders(response, 'application/json');

// 剧本步（写作首轮是流式，后续轮与 Agent 面都是非流式 postChat + SDK 流式，两者都给）：
const step = {
  // 流式：纯文本收尾
  text: (text, usage = { prompt_tokens: 11, completion_tokens: 7 }) => () => sseHeaders(sseStub([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ])),
  // 流式：发工具调用（同一轮可多个）
  tools: (calls, usage) => () => sseHeaders(sseStub([
    ...calls.map((c, i) => ({
      choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] } }],
    })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], ...(usage ? { usage } : {}) },
  ])),
  // 流式：length 截断（半截正文）
  truncated: (text, usage) => () => sseHeaders(sseStub([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], ...(usage ? { usage } : {}) },
  ])),
  // 流式：空输出（正常 stop 但一个字都没有）
  empty: (usage) => () => sseHeaders(sseStub([
    { choices: [{ delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
  ])),
  // 非流式：工具调用
  toolsJson: (calls, usage) => () => jsonHeaders(jsonStub(chatPayload({
    toolCalls: calls.map(c => toolCall(c.id, c.name, c.args || {})),
    finish: 'tool_calls',
    usage,
  }))),
  // 非流式：纯文本
  textJson: (text, usage) => () => jsonHeaders(jsonStub(chatPayload({ content: text, finish: 'stop', usage }))),
  // 上游故障
  status: (code, message) => () => httpErrorStub(code, message),
  hang: (firstText) => () => sseHeaders(hangingStream(firstText).response),
};

// ---------------------------------------------------------------- 合成书

// 合成书：两卷（可扩），每卷 chaptersPerVolume 章，正文带唯一哨兵（检索/串目标断言用）。
// 章号由服务端按卷内序分配（createChapter）——两卷各自从「第1章」起算，
// 即「重复展示章号」是真实数据形态，不是造出来的字符串。
async function seedSyntheticBook(ctx, {
  title = 'S6-01 合成书',
  volumeTitles = ['第一卷 起源', '第二卷 远征'],
  chaptersPerVolume = 2,
  chapterChars = 220,
} = {}) {
  const created = await api(ctx, 'POST', '/api/books', {
    title,
    intro: 'S6-01 合成用途，非真实稿件。',
    master_outline: '合成总纲：主角沿灰河上行，两卷结构。',
  });
  if (created.status !== 201) throw new Error(`建书失败：${created.status} ${created.text.slice(0, 200)}`);
  const bookId = created.body.book.id;
  // POST /api/books 不落 master_outline（路由只收 title/intro/system_prompt）——大纲要走 PUT，
  // 否则偏离检查会因「没有大纲不检测」而整条跳过（S5-03 口径），本套验收需要真实走该分支。
  const outlined = await api(ctx, 'PUT', `/api/books/${bookId}`, {
    master_outline: '合成总纲：主角沿灰河上行，两卷结构，第二卷抵达绿洲。',
  });
  if (outlined.status !== 200) throw new Error(`写总纲失败：${outlined.status} ${outlined.text.slice(0, 200)}`);
  const volumes = [];
  for (const volumeTitle of volumeTitles) {
    const r = await api(ctx, 'POST', `/api/books/${bookId}/volumes`, { title: volumeTitle });
    if (!(r.status === 200 || r.status === 201)) throw new Error(`建卷失败：${r.status} ${r.text.slice(0, 200)}`);
    const vol = r.body.volume;
    const volOutline = await api(ctx, 'PUT', `/api/books/${bookId}/volumes/${vol.id}`, {
      outline: `${volumeTitle} 合成卷纲：沿灰河上行，遇险并解决。`,
    });
    if (volOutline.status !== 200) throw new Error(`写卷纲失败：${volOutline.status} ${volOutline.text.slice(0, 200)}`);
    volumes.push(vol);
  }
  const chapters = [];
  for (let vi = 0; vi < volumes.length; vi += 1) {
    for (let ci = 0; ci < chaptersPerVolume; ci += 1) {
      const volumeOrdinal = vi + 1;
      const chapterOrdinal = ci + 1;
      const sentinel = `S6VOL${volumeOrdinal}CH${chapterOrdinal}`;
      const r = await api(ctx, 'POST', `/api/books/${bookId}/chapters`, {
        title: `第${chapterOrdinal}章 合成节点`,
        volume_id: volumes[vi].id,
        beat: `合成节拍 ${sentinel}`,
      });
      if (!(r.status === 200 || r.status === 201)) throw new Error(`建章失败：${r.status} ${r.text.slice(0, 200)}`);
      const chapterId = r.body.chapter.id;
      const content = `${sentinel}。` + `灰河在雾里缓慢抬升，岸边的芦苇压向同一侧。`.repeat(Math.ceil(chapterChars / 24));
      const saved = await api(ctx, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, {
        content,
        expected_revision: r.body.chapter.revision,
      });
      if (saved.status !== 200) throw new Error(`写正文失败：${saved.status} ${saved.text.slice(0, 200)}`);
      chapters.push({
        id: chapterId,
        volume_id: volumes[vi].id,
        volume_ordinal: volumeOrdinal,
        chapter_ordinal: chapterOrdinal,
        title: r.body.chapter.title,
        sentinel,
        revision: saved.body.chapter.revision,
        content,
      });
    }
  }
  // 选中「旧章」＝第一卷第一章（不是最新章）；写作/Agent 均以它为时序边界与近邻目标
  const selected = chapters[0];
  const latest = chapters[chapters.length - 1];
  return { bookId, volumes, chapters, selected, latest };
}

async function createAgentConversation(ctx, { scope = 'book', bookId = null, title = 'S6-01 会话' } = {}) {
  const r = await api(ctx, 'POST', '/api/conversations', { kind: 'agent', scope, bookId, title });
  if (r.status !== 201) throw new Error(`建会话失败：${r.status} ${r.text.slice(0, 200)}`);
  return r.body;
}

// ---------------------------------------------------------------- 真实库读取

function dbCount(table, where = '', params = []) {
  return db.get(`SELECT COUNT(*) AS n FROM ${table} ${where}`, params).n;
}

function chapterRow(chapterId) {
  return db.get('SELECT id, book_id, volume_id, title, content, summary, locked, revision, sort_order FROM chapters WHERE id = ?', [chapterId]);
}

function fileRead(filePath, sql, params = []) {
  const initSqlJs = require('sql.js');
  return require('sql.js')({
    locateFile: f => path.join(REPO_ROOT, 'node_modules', 'sql.js', 'dist', f),
  }).then(SQL => {
    const database = new SQL.Database(fs.readFileSync(filePath));
    const stmt = database.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    database.close();
    return rows;
  });
}

// ---------------------------------------------------------------- 安全不变量

// 一次「预期不写」的真实检测：比对前后行数，出现增量即记未授权写。
function makeInvariants() {
  return {
    unauthorizedWrites: 0,
    duplicateAppliedActions: 0,
    crossConversationLeaks: 0,
    falseDurableSuccesses: 0,
    activeRunsAfterCleanup: 0,
    // 证据明细（失败时定位用）
    evidence: [],
  };
}

function markUnauthorized(inv, where, detail) {
  inv.unauthorizedWrites += 1;
  inv.evidence.push({ kind: 'unauthorizedWrite', where, detail });
}

function markDuplicate(inv, where, detail) {
  inv.duplicateAppliedActions += 1;
  inv.evidence.push({ kind: 'duplicateAppliedAction', where, detail });
}

function markLeak(inv, where, detail) {
  inv.crossConversationLeaks += 1;
  inv.evidence.push({ kind: 'crossConversationLeak', where, detail });
}

function markFalseDurable(inv, where, detail) {
  inv.falseDurableSuccesses += 1;
  inv.evidence.push({ kind: 'falseDurableSuccess', where, detail });
}

// 清理后活跃运行：内存写锁 + 库里 running 运行 + 未结算确认卡，三者都必须是 0。
// 「awaiting_confirmation 的运行行」本来允许存在（作者还没点确认），所以判定用「未结算卡」，
// 由调用方在结算完全部卡之后再取这份快照。
function activeRunsSnapshot() {
  return {
    locks: runSvc.lockSnapshot().length,
    runningRuns: dbCount('agent_runs', "WHERE status = 'running'"),
    pendingCards: actionStore.listAll
      ? dbCount('chat_actions', "WHERE status = 'pending'")
      : 0,
  };
}

function markActiveRuns(inv, where, snapshot) {
  const total = snapshot.locks + snapshot.runningRuns + snapshot.pendingCards;
  if (total === 0) return 0;
  inv.activeRunsAfterCleanup += total;
  inv.evidence.push({ kind: 'activeRunAfterCleanup', where, detail: snapshot });
  return total;
}

// 「宣称成功但实际没有」检测：成功响应里的关键实体必须在库里真的可读。
function assertDurableWrite(inv, where, { claimed, actual }) {
  const hasClaim = claimed !== null && claimed !== undefined;
  const hasActual = actual !== null && actual !== undefined;
  if (hasClaim && !hasActual) markFalseDurable(inv, where, { claimed, actual });
  return { claimed, actual };
}

// 串会话检测：本轮所有上游请求体里不得出现别会话的哨兵。
function scanLeaks(inv, where, bodies, foreignSentinels) {
  for (const body of bodies) {
    const text = JSON.stringify(body || {});
    for (const sentinel of foreignSentinels) {
      if (text.includes(sentinel)) markLeak(inv, where, { sentinel, excerpt: text.slice(0, 160) });
    }
  }
}

// ---------------------------------------------------------------- 轮次记录

function newRecord(seed, scenario, group) {
  return {
    seed,
    scenario,
    group: group === undefined ? null : group,
    runId: null,
    revisionBefore: null,
    revisionAfter: null,
    llmRequests: 0,
    executions: 0,
    persisted: null,
    notes: [],
    startedAt: new Date().toISOString(),
  };
}

function executionsByTool() {
  return db.all("SELECT tool_name, COUNT(*) AS n FROM tool_audit_logs WHERE status = 'success' GROUP BY tool_name")
    .reduce((acc, row) => { acc[row.tool_name] = row.n; return acc; }, {});
}

function executionDelta(before, after) {
  let total = 0;
  for (const [name, n] of Object.entries(after)) total += n - (before[name] || 0);
  return total;
}

// 等待异步副作用（索引回写 / 运行终态）落到可观察状态：有界轮询，不猜时序
async function waitForCondition(fn, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

// 宽容版：超时返回 null（用于「可能不发生」的异步副作用，如实记录而不假装成功）
async function waitForConditionSafe(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------- 路由动作封装

function writingActionId(events) {
  const action = events.find(e => e && e.type === 'action');
  return action ? action.id : null;
}

function agentConfirmationId(parts) {
  for (const part of parts) {
    if (!part || part.type !== 'tool-output-available') continue;
    const out = part.output;
    if (!out) continue;
    const envelope = out.confirmation ? out : (out.data && out.data.confirmation ? out.data : null);
    if (envelope && envelope.status === 'confirmation_required' && envelope.confirmation) {
      return { id: envelope.confirmation.id, tool: envelope.confirmation.tool };
    }
  }
  return null;
}

async function confirmWritingAction(ctx, bookId, actionId, body = { approve: true }) {
  return api(ctx, 'POST', `/api/books/${bookId}/chat-actions/${actionId}/confirm`, body);
}

async function confirmAgentAction(ctx, confirmationId, conversationId, body = {}) {
  return api(ctx, 'POST', `/api/agent/actions/${confirmationId}/confirm`, {
    approve: true,
    conversation_id: conversationId,
    ...body,
  });
}

async function resumeAgentAction(ctx, confirmationId, conversationId, requestId, steps) {
  const script = beginScript(ctx, steps);
  const res = await fetch(`${ctx.http.baseUrl}/api/agent/actions/${confirmationId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, request_id: requestId }),
  });
  const contentType = res.headers.get('content-type') || '';
  let parts = [];
  let json = null;
  if (contentType.includes('application/json')) {
    json = await res.json().catch(() => null);
  } else {
    const text = await res.text();
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { parts.push(JSON.parse(payload)); } catch { /* 半包 */ }
    }
  }
  return { status: res.status, parts, json, script: script.finish() };
}

// 定稿后的异步索引：放行 embed 桩并等真实回写（等待失败返回 null，不假装成功）
async function settleIndex(ctx, { expectChunks = true, timeoutMs = 5000 } = {}) {
  ctx.embedGate.releaseAll();
  if (!expectChunks) {
    await new Promise(r => setTimeout(r, 50));
    return { chunks: dbCount('embeddings') };
  }
  await waitForConditionSafe(() => dbCount('embeddings') >= 1, timeoutMs);
  return { chunks: dbCount('embeddings'), embedCalls: ctx.embedGate.calls.length };
}

// ---------------------------------------------------------------- 完整动作链（S6-01 §范围）

// 一轮完整动作链，全部经真实路由：
//   写作页：定位正确范围 → 读取最新允许前文 → 建章（确认卡→作者确认）→ 写入（确认卡→作者确认）
//          → 确认续跑（系统事件）→ 重读实际库
//   Agent 页：生成总结（写作页 REST）→ 定稿/索引（Agent 工具+确认）→ 提案审阅（Agent 工具+确认）
// 断言侧直接读库/读文件——这正是「重读实际库」。合成书两卷同号章、选中旧章为范围。
async function runLoopRound(ctx, { seed, book, conversation, inv = makeInvariants(), capture = false }) {
  const record = newRecord(seed, 'deterministic-loop', 0);
  const target = book.selected;                     // 旧章（第一卷第一章），不是最新章
  const targetBefore = chapterRow(target.id);
  const execBefore = executionsByTool();
  const llmBefore = ctx.stub.calls.length;
  const volumeOther = book.volumes.find(v => v.id !== target.volume_id);
  const otherVolumeBefore = dbCount('chapters', 'WHERE book_id = ? AND volume_id = ?', [book.bookId, volumeOther.id]);
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const targetVolumeBefore = dbCount('chapters', 'WHERE volume_id = ?', [target.volume_id]);
  const notices = [];

  // ---- ① 定位（卷内同号章必须消歧）+ ② 读取最新允许前文 + ③ 建章（确认卡） ----
  const r1Id = `s${seed}-r1`;
  const r2Id = `s${seed}-r2`;
  const r3Id = `s${seed}-r3`;
  const w1Script = beginScript(ctx, [
    step.tools([{ id: r1Id, name: 'resolve_chapter', args: { volumeOrdinal: 1, chapterOrdinal: 1 } }]),
    // 注意：写作面（chat.js）的后续轮是非流式 postChat
    step.toolsJson([{ id: r2Id, name: 'read_chapter_range', args: { chapterId: target.id, start: 0, length: 400 } }]),
    step.toolsJson([{ id: r3Id, name: 'create_chapter', args: { volumeId: target.volume_id, title: `合成续章 ${seed}` } }]),
  ]);
  const w1 = await writingStream(ctx, book.bookId, {
    content: `先定位第一卷第1章并读取前文，再在第一卷新建一章（验收种子 ${seed}）`,
    chapterId: target.id,
    source: 'writing',
    request_id: `seed${seed}-w1`,
  });
  const w1Calls = w1Script.finish();
  record.llmRequests += w1Calls.llmRequests;
  if (w1Calls.unusedScriptSteps) notices.push(`写作第 1 轮有 ${w1Calls.unusedScriptSteps} 步剧本未被消费`);
  if (w1.status !== 200) throw new Error(`写作第 1 轮非 200：${w1.status}`);

  const toolEvents = w1.events.filter(e => e && e.type === 'tool');
  const resolved = toolEvents.find(e => e.name === 'resolve_chapter');
  if (!resolved) throw new Error('写作第 1 轮没有 resolve_chapter 工具事件');
  const resolvedId = JSON.parse(resolved.result).id;
  const readEvent = toolEvents.find(e => e.name === 'read_chapter_range');
  if (!readEvent) throw new Error('写作第 1 轮没有 read_chapter_range 工具事件');
  const createActionId = writingActionId(w1.events);
  if (!createActionId) throw new Error('写作第 1 轮没有建章确认卡');

  // ④ 确认前：待确认不得已生效（真实库零新增章）
  const chaptersAtPending = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const createConfirm = await confirmWritingAction(ctx, book.bookId, createActionId);
  if (createConfirm.status !== 200 || !createConfirm.body || createConfirm.body.status !== 'approved') {
    throw new Error(`建章确认失败：${createConfirm.status} ${createConfirm.text.slice(0, 200)}`);
  }
  const newChapterId = createConfirm.body.result.chapter.id;
  const createdRow = chapterRow(newChapterId);
  // 「唯一顺序」走真实目录路由：目录序号按位置重算，章号在两卷各自起算（重复展示章号）
  const directoryAfterCreate = await api(ctx, 'GET', `/api/books/${book.bookId}/chapters`);
  const createdEntry = (directoryAfterCreate.body.chapters || []).find(c => c.id === newChapterId);
  const createdOrdinal = createdEntry ? createdEntry.chapter_ordinal : null;

  // ---- ⑤ 写入：append_chapter（确认卡 → 作者确认 → 续跑） ----
  const writeText = `S6SEED${seed}WRITE：合成写入第一段，两卷同号章不得串目标。`;
  const writeActionScript = beginScript(ctx, [
    step.tools([{ id: `s${seed}-a1`, name: 'append_chapter', args: { chapterId: newChapterId, text: writeText } }]),
  ]);
  const w2 = await writingStream(ctx, book.bookId, {
    content: '把这段正文写进刚建的新章',
    chapterId: newChapterId,
    source: 'writing',
    request_id: `seed${seed}-w2`,
  });
  const w2Calls = writeActionScript.finish();
  record.llmRequests += w2Calls.llmRequests;
  if (w2Calls.unusedScriptSteps) notices.push(`写作第 2 轮有 ${w2Calls.unusedScriptSteps} 步剧本未被消费`);
  const beforeWrite = chapterRow(newChapterId);
  const appendActionId = writingActionId(w2.events);
  if (!appendActionId) throw new Error('写作第 2 轮没有写入确认卡');
  const appendConfirm = await confirmWritingAction(ctx, book.bookId, appendActionId);
  if (appendConfirm.status !== 200 || appendConfirm.body.status !== 'approved') {
    throw new Error(`写入确认失败：${appendConfirm.status} ${appendConfirm.text.slice(0, 200)}`);
  }

  // ⑥ 重读实际库：REST 读取 + 磁盘复核
  const reread = await api(ctx, 'GET', `/api/books/${book.bookId}/chapters/${newChapterId}`);
  const afterWriteRow = chapterRow(newChapterId);
  const diskRows = await fileRead(ctx.filePath, 'SELECT content, revision FROM chapters WHERE id = ?', [newChapterId]);

  // ⑦ 确认续跑（写作页）：系统事件驱动模型收尾
  const resumeScript = beginScript(ctx, [step.text('已按真实执行结果核对写入。')]);
  const w3 = await writingStream(ctx, book.bookId, {
    resumeActionId: appendActionId,
    source: 'writing',
    request_id: `seed${seed}-w3`,
  });
  const w3Calls = resumeScript.finish();
  record.llmRequests += w3Calls.llmRequests;
  if (w3Calls.unusedScriptSteps) notices.push(`写作续跑有 ${w3Calls.unusedScriptSteps} 步剧本未被消费`);

  // ---- ⑧ 生成总结（写作页 REST：总结 + 偏离检查各一次上游调用） ----
  const summaryText = `第${seed}号合成总结：本章沿灰河上行。`;
  const summaryScript = beginScript(ctx, [
    step.textJson(summaryText, { prompt_tokens: 30, completion_tokens: 12 }),
    step.textJson('符合\n与总纲一致，无偏离。', { prompt_tokens: 20, completion_tokens: 8 }),
  ]);
  const summaryRes = await api(ctx, 'POST', `/api/books/${book.bookId}/chapters/${newChapterId}/summary`);
  const summaryCalls = summaryScript.finish();
  record.llmRequests += summaryCalls.llmRequests;
  if (summaryCalls.unusedScriptSteps) notices.push(`总结轮有 ${summaryCalls.unusedScriptSteps} 步剧本未被消费`);
  const summaryRevision = chapterRow(newChapterId).revision; // 总结提交后即刻读，勿与后续定稿混用

  // ---- ⑨ 定稿/索引（Agent 工具 + 确认 + 续跑） ----
  const lockScript = beginScript(ctx, [
    step.tools([{ id: `s${seed}-l1`, name: 'lock_chapter', args: { book_id: book.bookId, chapter_id: newChapterId } }]),
  ]);
  const a1 = await agentStream(ctx, {
    conversation_id: conversation.id,
    content: '把这一章定稿并建立索引',
    mode: 'execute',
    book_id: book.bookId,
    request_id: `seed${seed}-a1`,
  });
  const lockCalls = lockScript.finish();
  record.llmRequests += lockCalls.llmRequests;
  if (lockCalls.unusedScriptSteps) notices.push(`Agent 定稿轮有 ${lockCalls.unusedScriptSteps} 步剧本未被消费`);
  const lockConfirmEnvelope = agentConfirmationId(a1.parts);
  if (!lockConfirmEnvelope) throw new Error('Agent 定稿轮没有确认卡');
  const lockConfirm = await confirmAgentAction(ctx, lockConfirmEnvelope.id, conversation.id);
  if (lockConfirm.status !== 200 || lockConfirm.body.status !== 'approved') {
    throw new Error(`定稿确认失败：${lockConfirm.status} ${lockConfirm.text.slice(0, 200)}`);
  }
  const indexState = await settleIndex(ctx, { expectChunks: true });
  const lockedRow = chapterRow(newChapterId);
  const lockResume = await resumeAgentAction(ctx, lockConfirmEnvelope.id, conversation.id, `seed${seed}-a1r`, [
    step.text('已定稿并建立索引。'),
  ]);
  record.llmRequests += lockResume.script.llmRequests;

  // ---- ⑩ 提案审阅（作者建提案 → Agent 读取 → 采纳确认 → 续跑） ----
  const character = (await api(ctx, 'POST', `/api/books/${book.bookId}/characters`, {
    name: `合成角色${seed}`, role: '配角', note: 'S6-01 合成',
  })).body.character;
  const proposalContent = chapterRow(newChapterId).content; // 提案来源＝当前正文（哈希必须与当前一致）
  const proposalRes = await api(ctx, 'POST', `/api/books/${book.bookId}/ledger/proposals`, {
    title: `合成提案 ${seed}：目标更新`,
    summary: '章节总结产生的合成提案。',
    chapter_id: newChapterId,
    source_type: 'chapter_summary',
    source_revision_hash: revision(proposalContent),
    source_quote: writeText,
    changes: [{
      change_kind: 'character_state',
      subject_ref: character.id,
      field_key: 'goal',
      old_value: null,
      new_value: `沿灰河上行（种子 ${seed}）`,
    }],
  });
  if (proposalRes.status !== 201) throw new Error(`建提案失败：${proposalRes.status} ${proposalRes.text.slice(0, 200)}`);
  const proposal = proposalRes.body.proposal;
  const eventsBefore = dbCount('story_events');

  const reviewScript = beginScript(ctx, [
    step.tools([{ id: `s${seed}-p1`, name: 'get_event_proposals', args: { book_id: book.bookId, status: 'pending' } }]),
    step.tools([{
      id: `s${seed}-p2`,
      name: 'review_event_proposal',
      args: {
        book_id: book.bookId, proposal_id: proposal.id, action: 'accept', expected_revision: proposal.revision,
      },
    }]),
  ]);
  const a2 = await agentStream(ctx, {
    conversation_id: conversation.id,
    content: '审阅待确认提案',
    mode: 'execute',
    book_id: book.bookId,
    request_id: `seed${seed}-a2`,
  });
  const reviewCalls = reviewScript.finish();
  record.llmRequests += reviewCalls.llmRequests;
  if (reviewCalls.unusedScriptSteps) notices.push(`Agent 提案轮有 ${reviewCalls.unusedScriptSteps} 步剧本未被消费`);
  const proposalOutput = a2.parts
    .filter(p => p.type === 'tool-output-available')
    .find(p => p.output && p.output.data && Array.isArray(p.output.data.items));
  const reviewEnvelope = agentConfirmationId(a2.parts);
  if (!reviewEnvelope) throw new Error('Agent 提案审阅轮没有确认卡');
  const reviewConfirm = await confirmAgentAction(ctx, reviewEnvelope.id, conversation.id);
  if (reviewConfirm.status !== 200 || reviewConfirm.body.status !== 'approved') {
    throw new Error(`提案采纳确认失败：${reviewConfirm.status} ${reviewConfirm.text.slice(0, 200)}`);
  }
  const reviewResume = await resumeAgentAction(ctx, reviewEnvelope.id, conversation.id, `seed${seed}-a2r`, [
    step.text('提案已按作者确认采纳。'),
  ]);
  record.llmRequests += reviewResume.script.llmRequests;

  // ---- 记录 + 真实库/不变量核对 ----
  const eventsAfter = dbCount('story_events');
  const execAfter = executionsByTool();
  record.executions = executionDelta(execBefore, execAfter);
  record.revisionBefore = beforeWrite.revision;
  record.revisionAfter = chapterRow(newChapterId).revision;
  record.runId = (function () {
    const row = db.get('SELECT id FROM agent_runs WHERE request_id = ?', [`seed${seed}-a1`]);
    return row ? row.id : null;
  })();
  record.persisted = {
    createConfirmDurability: createConfirm.body.persistence || null,
    writeConfirmDurability: appendConfirm.body.persistence || null,
    chapterInDb: afterWriteRow.content,
    chapterOnDisk: diskRows.length ? diskRows[0].content : null,
    rereadContentMatches: !!(reread.body && reread.body.chapter && reread.body.chapter.content === writeText),
    diskRevision: diskRows.length ? diskRows[0].revision : null,
    embeddings: indexState.chunks,
  };
  record.checks = {
    resolveIdMatchesSelected: resolvedId === target.id,
    resolveIdIsRealChapter: !!db.get('SELECT id FROM chapters WHERE id = ?', [resolvedId]),
    readHasTargetSentinel: String(readEvent.result || '').includes(target.sentinel),
    readExcludesFutureSentinels: book.chapters
      .filter(c => c.id !== target.id)
      .every(c => !String(readEvent.result || '').includes(c.sentinel)),
    pendingDidNotCreate: chaptersAtPending === chaptersBefore,
    createdVolumeMatchesSelection: createdRow.volume_id === target.volume_id,
    createdOrdinalSequential: createdOrdinal === targetVolumeBefore + 1,
    createdSortOrderUnique: dbCount(
      'chapters', 'WHERE book_id = ? AND volume_id = ? AND sort_order = ?',
      [book.bookId, createdRow.volume_id, createdRow.sort_order]
    ) === 1,
    volumeSortOrdersUnique: (() => {
      const row = db.get(
        'SELECT COUNT(*) AS total, COUNT(DISTINCT sort_order) AS distinct_orders FROM chapters WHERE book_id = ? AND volume_id = ?',
        [book.bookId, target.volume_id]
      );
      return row.total === row.distinct_orders;
    })(),
    otherVolumeUntouched: dbCount('chapters', 'WHERE book_id = ? AND volume_id = ?', [book.bookId, volumeOther.id]) === otherVolumeBefore,
    writeLandedBeforeConfirmOnlyAfter: beforeWrite.content === '',
    writeContentExact: afterWriteRow.content === writeText,
    writeRevisionAdvanced: afterWriteRow.revision === beforeWrite.revision + 1,
    rereadMatches: record.persisted.rereadContentMatches,
    summaryCommitted: summaryRes.status === 200 && summaryRes.body && summaryRes.body.summary === summaryText,
    summaryRevisionRecorded: !!(summaryRes.body && summaryRes.body.committed_revision === summaryRevision),
    summaryFingerprintPresent: !!(summaryRes.body && summaryRes.body.source_fingerprint),
    driftVerdict: summaryRes.body && summaryRes.body.drift && summaryRes.body.drift.status,
    locked: lockedRow.locked === 1,
    indexed: indexState.chunks >= 1,
    lockResumedTerminal: lockResume.status === 200,
    proposalListedBeforeReview: !!(proposalOutput),
    reviewWroteCanonical: eventsAfter === eventsBefore + 1,
    reviewResumeStatus: reviewResume.status,
    proposalStatus: db.get('SELECT status FROM event_proposals WHERE id = ?', [proposal.id]).status,
  };
  // 未授权写：待确认期间与拒绝路径都必须零新增（这里是「待确认期间」这一半的实测）
  if (!record.checks.pendingDidNotCreate) markUnauthorized(inv, `seed${seed}:建章待确认期间已生效`, { chaptersAtPending, chaptersBefore });
  if (!record.checks.otherVolumeUntouched) markUnauthorized(inv, `seed${seed}:未选中的卷被写入`, { otherVolumeBefore });
  if (chapterRow(target.id).content !== targetBefore.content) markUnauthorized(inv, `seed${seed}:选中旧章正文被改`, {});
  // 重复生效：一次确认只允许一次副作用（新章恰 +1、写入恰 +1）
  if (chaptersAtPending + 1 !== chaptersBefore + 1) markDuplicate(inv, `seed${seed}:建章副作用次数异常`, {});
  if (afterWriteRow.content.split(writeText).length - 1 !== 1) markDuplicate(inv, `seed${seed}:append 生效次数异常`, {});
  // 假保存：响应宣称成功但库里/磁盘上没有
  if (!record.checks.writeContentExact || record.persisted.chapterOnDisk !== writeText) {
    markFalseDurable(inv, `seed${seed}:写入宣称成功但库/磁盘不一致`, record.persisted);
  }
  if (record.persisted.rereadContentMatches !== true) markFalseDurable(inv, `seed${seed}:重读实际库不一致`, record.persisted);
  // 串会话：本轮上游请求体不得出现别会话内容的哨兵（写作面会话为 per-book legacy，不存在跨会话；Agent 会话独立）
  scanLeaks(inv, `seed${seed}:写作轮`, ctx.stub.calls.slice(llmBefore).map(c => c.body), []);
  record.notices = notices;
  record.invariants = { ...inv };
  return record;
}

// 延迟放行的非流式响应：HTTP 请求先发出、正文稍后才给（用于「生成期间改稿」这类竞态注入）
function deferredJson(value) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {
    step: () => jsonHeaders({ ok: true, status: 200, json: () => promise }),
    release: (next) => release(next === undefined ? value : next),
  };
}

// 磁盘拒写注入（复刻 persistence-contract 既有反例）：只拦目标临时库文件的写入
function installDiskFault(filePath) {
  const original = fs.writeFileSync;
  const state = { blocked: false };
  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (state.blocked && String(file).startsWith(String(filePath))) {
      throw Object.assign(new Error('S6-01 合成磁盘拒写'), { code: 'EPERM' });
    }
    return original.call(this, file, ...args);
  };
  return {
    state,
    block() { state.blocked = true; },
    restore() { state.blocked = false; },
    uninstall() { fs.writeFileSync = original; state.blocked = false; },
  };
}

// ---------------------------------------------------------------- 故障矩阵（十组，真实注入）

const FAULT_GROUPS = [
  { group: 1, key: 'normal-multi-volume', name: '正常与多卷同号章' },
  { group: 2, key: 'duplicate-confirm-resume-request', name: '重复 confirm/resume/requestId' },
  { group: 3, key: 'reject-and-wrong-credentials', name: '拒绝与错误会话凭证' },
  { group: 4, key: 'two-tabs-two-entries', name: '双标签页/两入口同书写' },
  { group: 5, key: 'input-during-save', name: '保存期间输入/失败离开' },
  { group: 6, key: 'disk-failure-recovery', name: '磁盘失败与恢复' },
  { group: 7, key: 'disconnect-cancel-timeout', name: '断连/取消/无事件超时' },
  { group: 8, key: 'length-empty-429-5xx', name: 'length/空输出/429/5xx' },
  { group: 9, key: 'source-change-async', name: '正文变更与异步总结/向量' },
  { group: 10, key: 'process-restart', name: '隔离进程重启/恢复' },
];

// 各组的「判据清单」：只有列在这里的 checks 才必须为 true（其余是证据字段，数值/文本原样保留）。
// 这样测试文件与长跑驱动用同一份判据，不靠「把所有字段都当布尔」误伤证据行。
const REQUIRED_CHECKS = {
  1: ['duplicateDisplayNumbersExist', 'volumeOrdersUnique', 'ambiguousRejected', 'ambiguousNoModelCall',
    'ambiguousNoWrite', 'resolvedRealId', 'resolvedRowMatchesVolume', 'readContentCorrect'],
  2: ['duplicateRequestResponded', 'duplicateRequestMarked', 'duplicateRequestNoModelCall',
    'duplicateRequestSharesRun', 'singleRunRow', 'lockReleasedAfterDuplicate', 'confirmFirstApproved',
    'confirmSecondReplayed', 'concurrentConfirmsDidNotDoubleApply', 'versionsNotDoubled',
    'resumeFirstOk', 'resumeSecondRejected', 'resumeSecondNoModelCall'],
  3: ['rejectSettled', 'rejectNoWrite', 'rejectNoPendingRetry', 'rejectResumeBounded',
    'wrongConversationRejected', 'wrongConversationNoWrite', 'unknownConfirmation404', 'unknownResume404',
    'wrongBookConfirm404', 'canonicalUntouched', 'correctCredentialWorks'],
  4: ['tabBConflictVisible', 'tabBNoModelCall', 'agentEntryConflictVisible', 'agentEntryNoModelCall',
    'targetContentUnchanged', 'noChapterSilentlyAdded', 'pendingCardStillPending',
    'lockReleasedAfterConflict', 'requestSucceedsAfterRelease'],
  5: ['firstSaveOk', 'staleRejected', 'newerContentKept', 'staleTextNotAnywhere', 'otherTargetUntouched'],
  6: ['blockedNotSuccessful', 'blockedAppliedInMemory', 'blockedNotDurable', 'blockedDiskStillOld',
    'toolResultPendingFlagged', 'recoveryLandedOnDisk', 'flushDurable', 'flushDidNotReplayBusiness',
    'diskHasInMemoryContent'],
  7: ['callsStoppedAfterAbort', 'lockReleasedAfterAbort', 'userMessageQueryable',
    'runQueryableWithTerminalStatus', 'watchdogTerminal', 'lockReleasedAfterWatchdog', 'watchdogNoFurtherCalls'],
  // 组 8 的清单由 runFaultRound 按种子奇偶注入（见 faultUpstreamFinishes 里的 requiredChecksOverride）
  8: [],
  9: ['summaryChangeApplied', 'summaryRejected409', 'staleSummaryNotCommitted', 'newSourcePresent',
    'lockApproved', 'embedInFlight', 'changeDuringIndexApplied', 'unlockedAfterChange', 'staleVectorsRejected'],
  10: ['beforeWriteOk', 'pendingCardCreatedBefore', 'inflightRunDurableBeforeKill', 'killedHard',
    'chapterSurvived', 'revisionSurvived', 'conversationEvidenceSurvived', 'inflightInterrupted',
    'replayDuplicate', 'replayNoNewUpstreamCall', 'cardWrongConversation403', 'cardStillPending',
    'noAutoExecution', 'versionsSurvived'],
};

// 每轮统一留痕（任务书要求的逐轮字段：种子/场景/runId/前后 revision/模型请求/执行/持久化结果）。
// 与 runLoopRound 的字段同名同义；故障轮走拒绝或冲突路径时 runIds 为空数组、changedChapters 为空，
// 那是**实测结果**而不是漏记（恰好证明「该拒的拒了、没写」）。
function roundEvidenceSnapshot(book) {
  const revisions = {};
  for (const row of db.all('SELECT id, revision FROM chapters WHERE book_id = ? ORDER BY id', [book.bookId])) {
    revisions[String(row.id)] = row.revision;
  }
  // 运行留痕不分入口：写作面（entry='chat'，会话在 session_key）与 Agent 面（entry='agent'）都写同一张
  // agent_runs，按 created_at 前后差取「本轮新建」的那几条。
  const runIds = db.all('SELECT id FROM agent_runs ORDER BY created_at, id').map(row => row.id);
  return { revisions, runIds };
}

// 持久化结果：真实落盘一次，再把内存态与**库文件**逐章比（revision + 正文），不一致的章逐个列出。
async function applyRoundEvidence(ctx, book, record, before, after) {
  const newRuns = after.runIds.filter(id => !before.runIds.includes(id));
  record.runIds = newRuns;
  record.runId = newRuns.length ? newRuns[newRuns.length - 1] : null;
  record.revisionBefore = before.revisions;
  record.revisionAfter = after.revisions;
  record.changedChapters = Object.keys(after.revisions).filter(id => before.revisions[id] !== after.revisions[id]);
  let flushStatus = null;
  let flushOk = null;
  try {
    const flush = await api(ctx, 'POST', '/api/persistence/flush');
    flushStatus = flush.status;
    flushOk = !!(flush.body && flush.body.ok === true);
  } catch (error) {
    flushStatus = `error:${error.message}`;
  }
  let mismatched = null;
  try {
    const memory = db.all('SELECT id, revision, content FROM chapters WHERE book_id = ?', [book.bookId]);
    const diskRows = await fileRead(ctx.filePath, 'SELECT id, revision, content FROM chapters WHERE book_id = ?', [book.bookId]);
    const diskById = new Map(diskRows.map(row => [String(row.id), row]));
    mismatched = memory.filter((row) => {
      const disk = diskById.get(String(row.id));
      return !disk || Number(disk.revision) !== Number(row.revision) || String(disk.content) !== String(row.content);
    }).map(row => String(row.id));
  } catch (error) {
    mismatched = `read_error:${error.message}`;
  }
  record.persisted = {
    flushStatus,
    flushOk,
    changedChapters: record.changedChapters,
    chaptersCompared: Object.keys(after.revisions).length,
    diskMismatched: mismatched,
    durable: Array.isArray(mismatched) && mismatched.length === 0 && flushOk === true,
  };
  return record;
}

// 每组一轮故障：返回本轮记录（checks 为实测值，失败由调用方断言并计入不变量）。
async function runFaultRound(ctx, group, seed, { book, conversation, inv, diskFault }) {
  const execBefore = executionsByTool();
  const llmBefore = ctx.stub.calls.length;
  const record = newRecord(seed, FAULT_GROUPS.find(g => g.group === group).key, group);
  const snapshotBefore = roundEvidenceSnapshot(book);
  const runner = {
    1: faultNormalMultiVolume,
    2: faultDuplicate,
    3: faultRejectAndCredentials,
    4: faultTwoTabs,
    5: faultInputDuringSave,
    6: faultDiskFailure,
    7: faultDisconnect,
    8: faultUpstreamFinishes,
    9: faultSourceChangeAsync,
  }[group];
  if (!runner) throw new Error(`未知故障组：${group}`);
  await runner(ctx, seed, { book, conversation, inv, record, diskFault });
  record.requiredChecks = record.requiredChecksOverride || REQUIRED_CHECKS[group];
  record.llmRequests = ctx.stub.calls.length - llmBefore;
  record.executions = executionDelta(execBefore, executionsByTool());
  await applyRoundEvidence(ctx, book, record, snapshotBefore, roundEvidenceSnapshot(book));
  record.invariants = { ...inv };
  return record;
}

function checks(record) {
  record.checks = record.checks || {};
  return record.checks;
}

// —— 组 1：正常与多卷同号章（真实 id、唯一顺序、正文正确）——
async function faultNormalMultiVolume(ctx, seed, { book, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  const duplicateNumberChapters = book.chapters.filter(ch => /^第\s*1\s*章/u.test(String(ch.title || '')));
  c.duplicateDisplayNumbersExist = duplicateNumberChapters.length >= 2
    && new Set(duplicateNumberChapters.map(ch => ch.volume_id)).size >= 2;
  c.volumeOrdersUnique = book.volumes.every((vol) => {
    const row = db.get(
      'SELECT COUNT(*) AS total, COUNT(DISTINCT sort_order) AS distinct_orders FROM chapters WHERE book_id = ? AND volume_id = ?',
      [book.bookId, vol.id]
    );
    return row.total === row.distinct_orders;
  });
  // 真实注入：不加卷限定地引用「第1章」——两卷同号，解析必须拒绝而不是猜一章
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const callsBefore = ctx.stub.calls.length;
  const ambiguous = await writingStream(ctx, book.bookId, {
    content: '按第1章正文继续',
    chapterId: target.id,
    request_id: `f1-${seed}-amb`,
  });
  // 冲突可见的两种真实形态：写作面在上下文装配期把歧义作为 SSE error 事件推送（HTTP 已发头），
  // Agent 面在路由前置校验阶段直接回 400 JSON。两边都必须给出「位置不唯一」的可读原因。
  const ambiguousErrorEvent = ambiguous.events.find(e => e && e.type === 'error');
  c.ambiguousRejected = ambiguous.status === 400
    || (!!ambiguousErrorEvent && /章节位置不唯一/.test(String(ambiguousErrorEvent.error || '')));
  c.ambiguousSurface = ambiguous.status === 400 ? 'json400' : 'sse_error';
  c.ambiguousMessage = String((ambiguousErrorEvent && ambiguousErrorEvent.error) || '').slice(0, 120);
  c.ambiguousNoModelCall = ctx.stub.calls.length === callsBefore;
  c.ambiguousNoWrite = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]) === chaptersBefore;
  if (!c.ambiguousRejected) markUnauthorized(inv, `f1-${seed}:多卷同号章引用未被拒绝`, { status: ambiguous.status, events: ambiguous.events.slice(0, 2) });
  // 消歧后：必须拿到真实 id（与库里「第1卷第1章」一致），不是猜出来的序号
  const script = beginScript(ctx, [
    step.tools([{ id: `f1-${seed}-r`, name: 'resolve_chapter', args: { volumeOrdinal: 1, chapterOrdinal: 1 } }]),
    step.toolsJson([{ id: `f1-${seed}-read`, name: 'read_chapter', args: { chapterId: target.id, maxChars: 400 } }]),
    step.textJson('已核对。'),
  ]);
  const resolved = await writingStream(ctx, book.bookId, {
    content: '定位第一卷第1章并读取正文',
    chapterId: target.id,
    request_id: `f1-${seed}-ok`,
  });
  script.finish();
  const resolveEvent = resolved.events.find(e => e && e.type === 'tool' && e.name === 'resolve_chapter');
  const readEvent = resolved.events.find(e => e && e.type === 'tool' && e.name === 'read_chapter');
  const resolvedId = resolveEvent ? JSON.parse(resolveEvent.result).id : null;
  c.resolvedRealId = resolvedId === target.id;
  c.resolvedRowMatchesVolume = (() => {
    const row = db.get('SELECT volume_id FROM chapters WHERE id = ?', [resolvedId]);
    return !!row && row.volume_id === target.volume_id;
  })();
  c.readContentCorrect = !!readEvent
    && String(readEvent.result).includes(target.sentinel)
    && !String(readEvent.result).includes(book.latest.sentinel);
  if (!c.resolvedRealId) markUnauthorized(inv, `f1-${seed}:定位未拿到真实 id`, { resolvedId, expect: target.id });
}

// —— 组 2：重复 confirm/resume/requestId（执行次数不增加、运行唯一）——
async function faultDuplicate(ctx, seed, { book, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  // (a) 同 request_id 并发：第二个必须拿到同一条运行的 duplicate 响应，且不再调模型
  const held = hangingStream('正在写。');
  const scriptA = beginScript(ctx, [() => held.response]);
  const requestId = `f2-${seed}-dup`;
  await waitForConditionSafe(() => ctx.stub.calls.length > 0, 5000).then(() => {});
  // 先把第一条请求发出去（占住锁与运行占位）
  const firstPromise = writingStream(ctx, book.bookId, {
    content: '重复请求注入：第一条', chapterId: target.id, request_id: requestId,
  }).catch(() => null);
  await waitForConditionSafe(() => ctx.stub.calls.length > 0 || runSvc.lockSnapshot().length > 0, 5000);
  const callsBeforeSecond = ctx.stub.calls.length;
  const second = await writingStream(ctx, book.bookId, {
    content: '重复请求注入：第二条', chapterId: target.id, request_id: requestId,
  });
  // 「第二个请求没有打到模型」按内容精确计数：并发中的第一条自己可能因流结束进入恢复路径
  // 再发一次上游调用（那是第一条的恢复，不是第二条绕过幂等），不能用全局计数误判。
  const callsCarryingSecond = ctx.stub.calls
    .filter(call => JSON.stringify(call.body || {}).includes('重复请求注入：第二条')).length;
  const duplicateRunRow = db.get('SELECT id FROM agent_runs WHERE request_id = ?', [requestId]);
  c.duplicateRequestResponded = second.status === 200 || second.status === 202;
  c.duplicateRequestMarked = !!(second.json && second.json.duplicate === true);
  c.duplicateRequestNoModelCall = callsCarryingSecond === 0;
  c.duplicateRequestGlobalCallDelta = ctx.stub.calls.length - callsBeforeSecond;
  c.duplicateRequestSharesRun = !!(second.json && second.json.runId && duplicateRunRow && second.json.runId === duplicateRunRow.id);
  c.duplicateRunRows = dbCount('agent_runs', 'WHERE request_id = ?', [requestId]);
  held.close();
  await firstPromise;
  scriptA.finish();
  await waitForConditionSafe(() => runSvc.lockSnapshot().length === 0, 8000);
  c.lockReleasedAfterDuplicate = runSvc.lockSnapshot().length === 0;
  if (!c.duplicateRequestNoModelCall) markDuplicate(inv, `f2-${seed}:重复 requestId 仍调模型`, {});
  if (c.duplicateRunRows !== 1) markDuplicate(inv, `f2-${seed}:同 requestId 落了多条运行`, { rows: c.duplicateRunRows });

  // (b) 同确认重复点击（顺序 + 并发）：副作用恰一次
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const createScript = beginScript(ctx, [
    step.tools([{ id: `f2-${seed}-cr`, name: 'create_chapter', args: { volumeId: target.volume_id, title: `重复确认 ${seed}` } }]),
  ]);
  const created = await writingStream(ctx, book.bookId, {
    content: '建一章用于重复确认注入', chapterId: target.id, request_id: `f2-${seed}-w`,
  });
  createScript.finish();
  const actionId = writingActionId(created.events);
  const versionsBefore = dbCount('chapter_versions');
  const firstConfirm = await confirmWritingAction(ctx, book.bookId, actionId, { approve: true });
  const secondConfirm = await confirmWritingAction(ctx, book.bookId, actionId, { approve: true });
  const [concurrentA, concurrentB] = await Promise.all([
    confirmWritingAction(ctx, book.bookId, actionId, { approve: true }),
    confirmWritingAction(ctx, book.bookId, actionId, { approve: true }),
  ]);
  c.confirmFirstApproved = firstConfirm.status === 200 && firstConfirm.body.status === 'approved';
  c.confirmSecondReplayed = secondConfirm.status === 200 && secondConfirm.body.replayed === true;
  c.chaptersAfterRepeatedConfirm = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  c.concurrentConfirmsDidNotDoubleApply = c.chaptersAfterRepeatedConfirm === chaptersBefore + 1;
  c.versionsNotDoubled = dbCount('chapter_versions') === versionsBefore;
  c.singleRunRow = c.duplicateRunRows === 1;
  c.concurrentStatuses = [concurrentA.status, concurrentB.status];
  if (!c.concurrentConfirmsDidNotDoubleApply) markDuplicate(inv, `f2-${seed}:重复/并发确认重复生效`, {});
  if (!c.confirmSecondReplayed) markDuplicate(inv, `f2-${seed}:重复点击未走幂等回放`, { status: secondConfirm.status });

  // (c) 重复续跑：第二次续跑必须 409，且不再调模型
  const resumeScript = beginScript(ctx, [step.text('已按真实结果继续。')]);
  const resumed = await writingStream(ctx, book.bookId, {
    resumeActionId: actionId, request_id: `f2-${seed}-r1`,
  });
  resumeScript.finish();
  const callsAfterResume = ctx.stub.calls.length;
  const resumedAgain = await writingStream(ctx, book.bookId, {
    resumeActionId: actionId, request_id: `f2-${seed}-r2`,
  });
  c.resumeFirstOk = resumed.status === 200;
  c.resumeSecondRejected = resumedAgain.status === 409;
  c.resumeSecondNoModelCall = ctx.stub.calls.length === callsAfterResume;
  if (!c.resumeSecondNoModelCall) markDuplicate(inv, `f2-${seed}:重复续跑仍调模型`, {});
}

// —— 组 3：拒绝与错误会话凭证（无未授权写入，拒绝后不暗重试）——
async function faultRejectAndCredentials(ctx, seed, { book, conversation, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  // 每轮从已知状态开始：先经真实路由解除定稿（组内多个种子共用同一书，不这样做第二轮的
  // 「未写入」判据会被上一轮锁定的状态污染）
  await api(ctx, 'POST', `/api/books/${book.bookId}/chapters/${target.id}/unlock`);
  const otherConversation = await createAgentConversation(ctx, { scope: 'global', title: `异会话 ${seed}` });
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const eventsBefore = dbCount('story_events');

  // (a) 作者拒绝：卡结算为 rejected，一行都不写；拒绝后不暗重试
  const scriptA = beginScript(ctx, [
    step.tools([{ id: `f3-${seed}-cr`, name: 'create_chapter', args: { volumeId: target.volume_id, title: `拒绝注入 ${seed}` } }]),
  ]);
  const rejectedRound = await writingStream(ctx, book.bookId, {
    content: '建一章（本轮会被作者拒绝）', chapterId: target.id, request_id: `f3-${seed}-w`,
  });
  scriptA.finish();
  const rejectActionId = writingActionId(rejectedRound.events);
  const rejected = await confirmWritingAction(ctx, book.bookId, rejectActionId, { approve: false });
  const callsAfterReject = ctx.stub.calls.length;
  const retryScript = beginScript(ctx, [step.text('收到拒绝，不再重复请求。')]);
  await writingStream(ctx, book.bookId, {
    resumeActionId: rejectActionId, request_id: `f3-${seed}-rr`,
  });
  retryScript.finish();
  const retryCalls = ctx.stub.calls.length - callsAfterReject;
  const pendingAfterReject = dbCount('chat_actions', "WHERE status = 'pending' AND book_id = ?", [book.bookId]);
  c.rejectSettled = rejected.status === 200 && rejected.body.status === 'rejected';
  c.rejectNoWrite = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]) === chaptersBefore;
  c.rejectNoPendingRetry = pendingAfterReject === 0;
  c.rejectResumeBounded = retryCalls <= 2;
  if (!c.rejectNoWrite) markUnauthorized(inv, `f3-${seed}:拒绝后仍写入`, {});
  if (!c.rejectNoPendingRetry) markUnauthorized(inv, `f3-${seed}:拒绝后留下待确认重试卡`, {});

  // (b) 错误会话凭证：Agent 卡用别的会话确认 → 403 且不执行
  const lockScript = beginScript(ctx, [
    step.tools([{ id: `f3-${seed}-lock`, name: 'lock_chapter', args: { book_id: book.bookId, chapter_id: target.id } }]),
  ]);
  const agentRound = await agentStream(ctx, {
    conversation_id: conversation.id, content: '把这一章定稿', mode: 'execute',
    book_id: book.bookId, request_id: `f3-${seed}-a`,
  });
  lockScript.finish();
  const envelope = agentConfirmationId(agentRound.parts);
  const wrongConversation = await api(ctx, 'POST', `/api/agent/actions/${envelope.id}/confirm`, {
    approve: true, conversation_id: otherConversation.id,
  });
  const lockedBeforeWrongCredential = db.get('SELECT locked FROM chapters WHERE id = ?', [target.id]).locked;
  const lockedAfterWrongCredential = db.get('SELECT locked FROM chapters WHERE id = ?', [target.id]).locked;
  c.wrongConversationRejected = wrongConversation.status === 403;
  c.wrongConversationNoWrite = lockedAfterWrongCredential === lockedBeforeWrongCredential && lockedAfterWrongCredential === 0;
  if (!c.wrongConversationNoWrite) markUnauthorized(inv, `f3-${seed}:错会话凭证执行了写入`, {});
  // 未知/伪造凭证 + 跨书写入口：一律拒绝
  const unknownConfirm = await api(ctx, 'POST', '/api/agent/actions/c_unknown_credential/confirm', { approve: true });
  const unknownResume = await api(ctx, 'POST', '/api/agent/actions/c_unknown_credential/resume', { request_id: `f3-${seed}-x` });
  const wrongBookConfirm = await api(ctx, 'POST', '/api/books/999999/chat-actions/c_unknown/confirm', { approve: true });
  c.unknownConfirmation404 = unknownConfirm.status === 404;
  c.unknownResume404 = unknownResume.status === 404;
  c.wrongBookConfirm404 = wrongBookConfirm.status === 404;
  c.canonicalUntouched = dbCount('story_events') === eventsBefore;
  // 正确凭证仍然可执行（对照：被拒的是凭证，不是功能）
  const correct = await confirmAgentAction(ctx, envelope.id, conversation.id);
  c.correctCredentialWorks = correct.status === 200 && correct.body.status === 'approved';
  await settleIndex(ctx, { expectChunks: true });
  await resumeAgentAction(ctx, envelope.id, conversation.id, `f3-${seed}-ar`, [step.text('已定稿。')]);
}

// —— 组 4：双标签页/两入口同书写（冲突可见，无静默覆盖）——
async function faultTwoTabs(ctx, seed, { book, conversation, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  // 先造一张该书待确认卡（占用期间它拿不到写锁，必须仍是 pending）
  const prepareScript = beginScript(ctx, [
    step.tools([{ id: `f4-${seed}-cr`, name: 'create_chapter', args: { volumeId: target.volume_id, title: `双页 ${seed}` } }]),
  ]);
  const prepared = await writingStream(ctx, book.bookId, {
    content: '建一章备用', chapterId: target.id, request_id: `f4-${seed}-p`,
  });
  prepareScript.finish();
  const pendingActionId = writingActionId(prepared.events);
  const contentBefore = chapterRow(target.id).content;
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  // 标签页 A：真实挂起的长任务占住该书写锁
  const held = hangingStream('标签页 A 正在写。');
  const scriptA = beginScript(ctx, [() => held.response]);
  const tabA = writingStream(ctx, book.bookId, {
    content: '标签页 A 的长任务', chapterId: target.id, request_id: `f4-${seed}-A`,
  }).catch(() => null);
  await waitForConditionSafe(() => ctx.stub.calls.length > 0 && runSvc.lockSnapshot().length > 0, 5000);
  const callsBeforeTabB = ctx.stub.calls.length;
  const tabB = await writingStream(ctx, book.bookId, {
    content: '标签页 B 的同书写入', chapterId: target.id, request_id: `f4-${seed}-B`,
  });
  const agentEntry = await agentStream(ctx, {
    conversation_id: conversation.id, content: '同时从 Agent 台执行写入', mode: 'execute',
    book_id: book.bookId, request_id: `f4-${seed}-C`,
  });
  const callsCarryingTabB = ctx.stub.calls
    .filter(call => JSON.stringify(call.body || {}).includes('标签页 B')).length;
  const callsCarryingAgentEntry = ctx.stub.calls
    .filter(call => JSON.stringify(call.body || {}).includes('同时从 Agent 台执行写入')).length;
  c.tabBConflictVisible = tabB.status === 409 && !!(tabB.json && tabB.json.error && tabB.json.error.code === 'CHAT_BUSY');
  c.tabBNoModelCall = callsCarryingTabB === 0;
  c.tabBExpected = '409 CHAT_BUSY';
  c.agentEntryConflictVisible = agentEntry.status === 409
    && !!(agentEntry.json && agentEntry.json.error && agentEntry.json.error.code === 'BOOK_BUSY');
  c.agentEntryNoModelCall = callsCarryingAgentEntry === 0;
  c.targetContentUnchanged = chapterRow(target.id).content === contentBefore;
  c.noChapterSilentlyAdded = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]) === chaptersBefore;
  c.pendingCardStillPending = db.get('SELECT status FROM chat_actions WHERE id = ?', [pendingActionId]).status === 'pending';
  if (!c.targetContentUnchanged || !c.noChapterSilentlyAdded) markUnauthorized(inv, `f4-${seed}:被拒的同写请求仍落盘`, {});
  // 释放 A：锁必须归还，后续请求可正常进行（冲突是「可见的忙」，不是死锁）
  held.close();
  await tabA;
  scriptA.finish();
  await waitForConditionSafe(() => runSvc.lockSnapshot().length === 0, 8000);
  c.lockReleasedAfterConflict = runSvc.lockSnapshot().length === 0;
  const afterScript = beginScript(ctx, [step.text('A 结束后再试一次。')]);
  const afterRelease = await writingStream(ctx, book.bookId, {
    content: 'A 结束后再试一次', chapterId: target.id, request_id: `f4-${seed}-D`,
  });
  afterScript.finish();
  c.requestSucceedsAfterRelease = afterRelease.status === 200;
  if (!c.lockReleasedAfterConflict) markUnauthorized(inv, `f4-${seed}:冲突后锁未归还`, runSvc.lockSnapshot());
  // 收尾：备用卡结算（作者拒绝），不留未结算卡
  await confirmWritingAction(ctx, book.bookId, pendingActionId, { approve: false });
}

// —— 组 5：保存期间输入/失败离开（冲突可见、目标不串）——
async function faultInputDuringSave(ctx, seed, { book, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  const other = book.latest;
  const before = chapterRow(target.id);
  const otherBefore = chapterRow(other.id);
  const saved = await api(ctx, 'PUT', `/api/books/${book.bookId}/chapters/${target.id}`, {
    content: `${before.content}\nS6SAVE${seed}A`, expected_revision: before.revision,
  });
  c.firstSaveOk = saved.status === 200;
  // 旧快照迟到提交（保存期间的输入）：必须 409 冲突可见，不得静默覆盖
  const stale = await api(ctx, 'PUT', `/api/books/${book.bookId}/chapters/${target.id}`, {
    content: `S6STALE${seed} 迟到的新稿`, expected_revision: before.revision,
  });
  const after = chapterRow(target.id);
  c.staleRejected = stale.status === 409;
  c.conflictCode = (stale.body && (stale.body.code || (stale.body.error && stale.body.error.code))) || null;
  c.newerContentKept = String(after.content).includes(`S6SAVE${seed}A`);
  c.staleTextNotAnywhere = dbCount('chapters', 'WHERE book_id = ? AND content LIKE ?', [book.bookId, `%S6STALE${seed}%`]) === 0;
  c.otherTargetUntouched = chapterRow(other.id).content === otherBefore.content
    && chapterRow(other.id).revision === otherBefore.revision;
  if (!c.staleRejected) markUnauthorized(inv, `f5-${seed}:旧快照保存未冲突`, { status: stale.status });
  if (!c.staleTextNotAnywhere) markUnauthorized(inv, `f5-${seed}:被拒的迟到稿落在某章`, {});
  if (!c.otherTargetUntouched) markUnauthorized(inv, `f5-${seed}:目标不串失败`, {});
}

// —— 组 6：磁盘失败与恢复（不假成功、恢复可落盘、不重放业务）——
async function faultDiskFailure(ctx, seed, { book, inv, record, diskFault }) {
  const c = checks(record);
  const target = book.selected;
  if (!diskFault) throw new Error('磁盘故障注入器未提供');
  await waitForConditionSafe(() => db.getPersistenceStatus().dirty === false, 5000);
  const base = chapterRow(target.id);
  diskFault.block();
  try {
    // (a) REST 保存：503 PERSISTENCE_PENDING，绝不 2xx 假成功
    const blocked = await api(ctx, 'PUT', `/api/books/${book.bookId}/chapters/${target.id}`, {
      content: `${base.content}\nS6DISK${seed}`, expected_revision: base.revision,
    });
    const rowWhileBlocked = chapterRow(target.id);
    const diskWhileBlocked = await fileRead(ctx.filePath, 'SELECT content FROM chapters WHERE id = ?', [target.id]);
    c.blockedStatus = blocked.status;
    c.blockedNotSuccessful = blocked.status === 503;
    c.blockedAppliedInMemory = !!(blocked.body && blocked.body.applied === true && String(rowWhileBlocked.content).includes(`S6DISK${seed}`));
    c.blockedNotDurable = !!(blocked.body && blocked.body.persistence && blocked.body.persistence.durable === false);
    c.blockedDiskStillOld = !String(diskWhileBlocked[0].content).includes(`S6DISK${seed}`);
    if (blocked.status === 200) markFalseDurable(inv, `f6-${seed}:磁盘拒写仍宣称成功`, { body: blocked.body });
    // (b) 工具确认写入（同一磁盘故障）：结果必须带 pending 标记，不得标成持久成功
    const prepScript = beginScript(ctx, [
      step.tools([{ id: `f6-${seed}-ap`, name: 'append_chapter', args: { chapterId: target.id, text: `S6DISKTOOL${seed}` } }]),
    ]);
    const prep = await writingStream(ctx, book.bookId, {
      content: '把这段写入', chapterId: target.id, request_id: `f6-${seed}-w`,
    });
    prepScript.finish();
    const actionId = writingActionId(prep.events);
    const confirmBlocked = await confirmWritingAction(ctx, book.bookId, actionId, { approve: true });
    const toolResult = confirmBlocked.body && confirmBlocked.body.result;
    c.toolConfirmStatus = confirmBlocked.status;
    c.toolResultPendingFlagged = !!(toolResult && toolResult.persistence
      && toolResult.persistence.pending === true && toolResult.persistence.durable === false);
    if (toolResult && toolResult.persistence && toolResult.persistence.durable === true) {
      markFalseDurable(inv, `f6-${seed}:工具写入在拒写期标为 durable`, { toolResult });
    }
  } finally {
    diskFault.restore();
  }
  // (c) 恢复：自动重试把内存态落盘，无需重放业务
  const executionsBeforeRecovery = executionsByTool();
  const chaptersBeforeRecovery = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const landed = await waitForConditionSafe(async () => {
    const rows = await fileRead(ctx.filePath, 'SELECT content FROM chapters WHERE id = ?', [target.id]);
    return String(rows[0].content).includes(`S6DISKTOOL${seed}`);
  }, 25000);
  c.recoveryLandedOnDisk = !!landed;
  const flush = await api(ctx, 'POST', '/api/persistence/flush');
  const diskAfterFlush = await fileRead(ctx.filePath, 'SELECT content FROM chapters WHERE id = ?', [target.id]);
  c.flushStatus = flush.status;
  c.flushDurable = !!(flush.body && flush.body.ok === true);
  c.flushDidNotReplayBusiness = executionDelta(executionsBeforeRecovery, executionsByTool()) === 0
    && dbCount('chapters', 'WHERE book_id = ?', [book.bookId]) === chaptersBeforeRecovery;
  c.diskHasInMemoryContent = String(diskAfterFlush[0].content).includes(`S6DISK${seed}`)
    && String(diskAfterFlush[0].content).includes(`S6DISKTOOL${seed}`);
  if (!c.recoveryLandedOnDisk) markFalseDurable(inv, `f6-${seed}:恢复后未落盘`, {});
  if (!c.flushDidNotReplayBusiness) markUnauthorized(inv, `f6-${seed}:恢复路径重放了业务`, {});
}

// —— 组 7：断连/取消/无事件超时（后续工具停止、锁释放、已生效结果可查）——
async function faultDisconnect(ctx, seed, { book, conversation, inv, record }) {
  const c = checks(record);
  record.timings = {};
  const timings = record.timings;
  const target = book.selected;
  // (a) 客户端断连（真实 AbortController）
  const tAbort = Date.now();
  const held = hangingStream('断连前已吐一帧。');
  const script = beginScript(ctx, [() => held.response]);
  const controller = new AbortController();
  const res = await fetch(`${ctx.http.baseUrl}/api/books/${book.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '断连注入：写一段很长的正文', chapterId: target.id, request_id: `f7-${seed}-abort` }),
    signal: controller.signal,
  }).catch(() => null);
  await waitForConditionSafe(() => ctx.stub.calls.length > 0, 5000);
  if (res && res.body) {
    const reader = res.body.getReader();
    await reader.read().catch(() => null);  // 先拿到首帧
    controller.abort();                      // 作者关页面
    await reader.cancel().catch(() => null);
  } else {
    controller.abort();
  }
  script.finish();
  const callsAtAbort = ctx.stub.calls.length;
  await waitForConditionSafe(() => runSvc.lockSnapshot().length === 0, 10000);
  await new Promise(r => setTimeout(r, 250));
  c.callsStoppedAfterAbort = ctx.stub.calls.length === callsAtAbort;
  c.lockReleasedAfterAbort = runSvc.lockSnapshot().length === 0;
  const userMsg = db.get("SELECT id FROM messages WHERE book_id = ? AND role = 'user' AND content LIKE ?", [book.bookId, '%断连注入%']);
  const runRow = db.get('SELECT status FROM agent_runs WHERE request_id = ?', [`f7-${seed}-abort`]);
  c.userMessageQueryable = !!userMsg;
  c.runTerminalStatus = runRow ? runRow.status : null;
  c.runQueryableWithTerminalStatus = !!runRow
    && ['cancelled', 'paused', 'failed', 'finished', 'interrupted'].includes(runRow.status);
  timings.abortPhaseMs = Date.now() - tAbort;
  if (!c.callsStoppedAfterAbort) markUnauthorized(inv, `f7-${seed}:断连后仍有模型调用`, {});
  if (!c.lockReleasedAfterAbort) markUnauthorized(inv, `f7-${seed}:断连后锁未释放`, runSvc.lockSnapshot());
  // (b) 无事件超时（Agent 侧硬超时 watchdog：上游静默时的系统裁决，S2-04）
  const originalWatchdog = runSvc.DEFAULT_MAX_DURATION_MS;
  const tWatchdog = Date.now();
  runSvc.DEFAULT_MAX_DURATION_MS = 600;
  try {
    const heldAgent = hangingStream('无事件注入：只吐一帧。');
    const watchdogScript = beginScript(ctx, [() => heldAgent.response]);
    const agentRes = await agentStream(ctx, {
      conversation_id: conversation.id, content: '无事件超时注入', mode: 'execute',
      book_id: book.bookId, request_id: `f7-${seed}-watchdog`,
    });
    watchdogScript.finish();
    const runRow2 = await waitForConditionSafe(
      () => db.get("SELECT status, reason FROM agent_runs WHERE request_id = ? AND status != 'running'", [`f7-${seed}-watchdog`]),
      8000
    );
    const callsAtWatchdog = ctx.stub.calls.length;
    c.agentStreamStatus = agentRes.status;
    c.watchdogTerminal = !!runRow2;
    c.watchdogStatus = runRow2 ? runRow2.status : null;
    c.watchdogReason = runRow2 ? runRow2.reason : null;
    heldAgent.close();
    await waitForConditionSafe(() => runSvc.lockSnapshot().length === 0, 10000);
    c.lockReleasedAfterWatchdog = runSvc.lockSnapshot().length === 0;
    c.watchdogNoFurtherCalls = ctx.stub.calls.length === callsAtWatchdog;
    timings.watchdogPhaseMs = Date.now() - tWatchdog;
    if (!c.watchdogTerminal) markUnauthorized(inv, `f7-${seed}:无事件超时未落终态`, {});
    if (!c.lockReleasedAfterWatchdog) markUnauthorized(inv, `f7-${seed}:watchdog 后锁未释放`, runSvc.lockSnapshot());
  } finally {
    runSvc.DEFAULT_MAX_DURATION_MS = originalWatchdog;
  }
}

// —— 组 8：length/空输出/429/5xx（有限重试、正确终态、不误报完成）——
async function faultUpstreamFinishes(ctx, seed, { book, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  const odd = seed % 2 === 1;
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  if (odd) {
    // (a) length 截断且补不齐：终态 paused/output_truncated，不假完成
    const script = beginScript(ctx, [
      step.truncated('S6TRUNC 半截正文，尚未写完'),
      step.truncated(''),   // 续写轮仍截断且无新增 → 判「补不齐」
    ]);
    const res = await writingStream(ctx, book.bookId, {
      content: '写一段会截断的正文', chapterId: target.id, request_id: `f8-${seed}-len`,
    });
    const stats = script.finish();
    const done = res.events.find(e => e && e.type === 'done');
    c.lengthCallsBounded = stats.llmRequests <= 4;
    c.lengthTerminalState = done && done.run ? done.run.status : null;
    c.lengthTerminalReason = done && done.run ? done.run.reason : null;
    c.lengthNotClaimedFinished = !!done && done.run && done.run.status !== 'finished';
    c.lengthTerminalOk = !!done && done.run && done.run.status === 'paused' && done.run.reason === 'output_truncated';
    if (done && done.run && done.run.status === 'finished') markUnauthorized(inv, `f8-${seed}:截断轮被误报完成`, { run: done.run });
    // (b) 429：网关有限重试后正确终态，不误报完成
    const script429 = beginScript(ctx, [
      step.status(429, 'synthetic rate limit'),
      step.status(429, 'synthetic rate limit'),
      step.status(429, 'synthetic rate limit'),
      step.status(429, 'synthetic rate limit'),  // 兜底轮首尝试
      step.status(429, 'synthetic rate limit'),
      step.status(429, 'synthetic rate limit'),
    ]);
    const res429 = await writingStream(ctx, book.bookId, {
      content: '429 注入', chapterId: target.id, request_id: `f8-${seed}-429`,
    });
    const stats429 = script429.finish();
    const errEvent = res429.events.find(e => e && e.type === 'error');
    const llmRow = db.get("SELECT status FROM llm_calls WHERE book_id = ? AND scope = 'chat-stream' ORDER BY id DESC LIMIT 1", [book.bookId]);
    const runRow = db.get('SELECT status, reason FROM agent_runs WHERE request_id = ?', [`f8-${seed}-429`]);
    // 2026-09-30：判据从策略常量推导（旧硬编码 ≤6 按 RETRY_MAX_ATTEMPTS=3 校准；7f1f0e1 调 5
    // ＋afed7e5 首轮流零外发重试后同剧本实测 7 次）。有界性上界＝首轮流 2 次尝试×RETRY_MAX_ATTEMPTS
    // ＋无工具兜底 RETRY_MAX_ATTEMPTS；语义仍是「有限重试、不无限打」。
    c.code429CallsBounded = stats429.llmRequests <= RETRY_MAX_ATTEMPTS * 3;
    c.code429ErrorVisible = !!errEvent;
    c.code429RunStatus = runRow ? runRow.status : null;
    c.code429RunReason = runRow ? runRow.reason : null;
    c.code429LedgerError = !!(llmRow && llmRow.status === 'error');
    c.code429NoFalseSuccess = !res429.events.some(e => e && e.type === 'done' && e.run && e.run.status === 'finished');
    c.code429TerminalOk = !!runRow && runRow.status === 'failed';
    if (!c.code429NoFalseSuccess) markUnauthorized(inv, `f8-${seed}:429 被误报完成`, {});
  } else {
    // (a) 空输出：终态 paused/empty_output（不是 finished）
    const script = beginScript(ctx, [
      step.empty(),
      step.textJson(''),   // 重生成也空 → 仍按无正文处理
    ]);
    const res = await writingStream(ctx, book.bookId, {
      content: '空输出注入', chapterId: target.id, request_id: `f8-${seed}-empty`,
    });
    const stats = script.finish();
    const done = res.events.find(e => e && e.type === 'done');
    c.emptyCallsBounded = stats.llmRequests <= 4;
    c.emptyTerminalState = done && done.run ? done.run.status : null;
    c.emptyTerminalReason = done && done.run ? done.run.reason : null;
    c.emptyNotClaimedFinished = !!done && done.run && done.run.status !== 'finished';
    c.emptyTerminalOk = !!done && done.run && done.run.status === 'paused' && done.run.reason === 'empty_output';
    if (done && done.run && done.run.status === 'finished') markUnauthorized(inv, `f8-${seed}:空输出被误报完成`, { run: done.run });
    // (b) 5xx：有限重试后正确终态
    const script500 = beginScript(ctx, [
      step.status(500, 'synthetic upstream 500'),
      step.status(500, 'synthetic upstream 500'),
      step.status(500, 'synthetic upstream 500'),
      step.status(500, 'synthetic upstream 500'),
      step.status(500, 'synthetic upstream 500'),
      step.status(500, 'synthetic upstream 500'),
    ]);
    const res500 = await writingStream(ctx, book.bookId, {
      content: '5xx 注入', chapterId: target.id, request_id: `f8-${seed}-500`,
    });
    const stats500 = script500.finish();
    const runRow = db.get('SELECT status, reason FROM agent_runs WHERE request_id = ?', [`f8-${seed}-500`]);
    // 2026-09-30：同 code429CallsBounded——判据随策略常量推导（首轮流 2 次尝试×RETRY_MAX_ATTEMPTS
    // ＋兜底 RETRY_MAX_ATTEMPTS；旧硬编码 ≤6 为 3 次重试时代口径）
    c.code5xxCallsBounded = stats500.llmRequests <= RETRY_MAX_ATTEMPTS * 3;
    c.code5xxRunStatus = runRow ? runRow.status : null;
    c.code5xxRunReason = runRow ? runRow.reason : null;
    c.code5xxNoFalseSuccess = !res500.events.some(e => e && e.type === 'done' && e.run && e.run.status === 'finished');
    c.code5xxTerminalOk = !!runRow && runRow.status === 'failed';
    if (!c.code5xxNoFalseSuccess) markUnauthorized(inv, `f8-${seed}:5xx 被误报完成`, {});
  }
  c.noChapterWritten = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]) === chaptersBefore;
  // 奇偶种子分别覆盖 length/429 与 空输出/5xx 两组子场景，判据清单随之切换
  record.requiredChecksOverride = odd
    ? ['lengthCallsBounded', 'lengthNotClaimedFinished', 'lengthTerminalOk', 'code429CallsBounded',
      'code429ErrorVisible', 'code429LedgerError', 'code429NoFalseSuccess', 'code429TerminalOk', 'noChapterWritten']
    : ['emptyCallsBounded', 'emptyNotClaimedFinished', 'emptyTerminalOk', 'code5xxCallsBounded',
      'code5xxNoFalseSuccess', 'code5xxTerminalOk', 'noChapterWritten'];
}

// —— 组 9：正文变更与异步总结/向量（旧结果不可作为新章有效资料）——
async function faultSourceChangeAsync(ctx, seed, { book, conversation, inv, record }) {
  const c = checks(record);
  const target = book.selected;
  // (a) 总结生成期间改稿：提交必须 409 SOURCE_CHANGED，且不落旧总结
  const before = chapterRow(target.id);
  const stalePayload = chatPayload({
    content: 'S6STALESUMMARY 依据旧正文的总结。',
    finish: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  });
  const deferred = deferredJson(stalePayload);
  const summaryScript = beginScript(ctx, [deferred.step]);
  const callsBeforeSummary = ctx.stub.calls.length;
  const summaryPromise = api(ctx, 'POST', `/api/books/${book.bookId}/chapters/${target.id}/summary`);
  await waitForConditionSafe(() => ctx.stub.calls.length > callsBeforeSummary, 5000);
  const changed = await api(ctx, 'PUT', `/api/books/${book.bookId}/chapters/${target.id}`, {
    content: `${before.content}\nS6NEWSOURCE${seed}`, expected_revision: before.revision,
  });
  deferred.release(stalePayload);
  const summaryRes = await summaryPromise;
  summaryScript.finish();
  const after = chapterRow(target.id);
  c.summaryChangeApplied = changed.status === 200;
  c.summaryRejected409 = summaryRes.status === 409;
  c.summaryGuardCode = (summaryRes.body && (summaryRes.body.code || (summaryRes.body.error && summaryRes.body.error.code))) || null;
  c.staleSummaryNotCommitted = !String(after.summary || '').includes('S6STALESUMMARY');
  c.newSourcePresent = String(after.content).includes(`S6NEWSOURCE${seed}`);
  if (!c.summaryRejected409) markUnauthorized(inv, `f9-${seed}:改稿后旧总结仍提交`, { status: summaryRes.status });
  if (!c.staleSummaryNotCommitted) markUnauthorized(inv, `f9-${seed}:旧来源总结进入了字段`, {});
  // (b) 向量：定稿索引进行中改稿 → 旧向量不得作为新章的有效资料
  const lockScript = beginScript(ctx, [
    step.tools([{ id: `f9-${seed}-lock`, name: 'lock_chapter', args: { book_id: book.bookId, chapter_id: target.id } }]),
  ]);
  const lockedRound = await agentStream(ctx, {
    conversation_id: conversation.id, content: '把这一章定稿', mode: 'execute',
    book_id: book.bookId, request_id: `f9-${seed}-a`,
  });
  lockScript.finish();
  const envelope = agentConfirmationId(lockedRound.parts);
  const confirmLock = await confirmAgentAction(ctx, envelope.id, conversation.id);
  c.lockApproved = confirmLock.status === 200 && confirmLock.body.status === 'approved';
  // embed 桩此刻必然处于「已调用未放行」（索引已开始，正文已改过一次）
  await waitForConditionSafe(() => ctx.embedGate.calls.length > 0, 8000);
  const embedCallsAtRace = ctx.embedGate.calls.length;
  c.embedInFlight = embedCallsAtRace > 0;
  const contentBeforeRace = chapterRow(target.id).content;
  const changedDuringIndex = await api(ctx, 'PUT', `/api/books/${book.bookId}/chapters/${target.id}`, {
    content: `${contentBeforeRace}\nS6INDEXRACE${seed}`,
    expected_revision: chapterRow(target.id).revision,
  });
  c.changeDuringIndexApplied = changedDuringIndex.status === 200;
  ctx.embedGate.releaseAll();
  await new Promise(r => setTimeout(r, 400));
  const chunks = db.all('SELECT text FROM embeddings WHERE chapter_id = ?', [target.id]);
  const currentContent = String(chapterRow(target.id).content);
  c.vectorCountAfterRace = chunks.length;
  c.unlockedAfterChange = chapterRow(target.id).locked === 0;
  // 旧向量必须整批丢弃（不得以「旧正文的块」作为新章的有效资料）
  c.staleVectorsRejected = chunks.every((row) => {
    const head = Array.from(String(row.text || '')).slice(0, 12).join('');
    return head && currentContent.includes(head);
  });
  if (!c.staleVectorsRejected) markUnauthorized(inv, `f9-${seed}:旧正文向量作为新章资料留存`, { chunks });
  await resumeAgentAction(ctx, envelope.id, conversation.id, `f9-${seed}-ar`, [step.text('已定稿。')]);
}

// ---------------------------------------------------------------- 隔离进程（第 10 组）

function pickPort(startPort = 3166, tries = 12) {
  for (let p = startPort; p < startPort + tries; p += 1) {
    try {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
      const busy = out.split('\n').some(line => line.includes(`:${p} `) && line.includes('LISTENING'));
      if (!busy) return p;
    } catch {
      return startPort;
    }
  }
  throw new Error(`3166+ 没有空闲端口（起始 ${startPort}）`);
}

// 子进程命令行核对（win32：PowerShell CIM 读 CommandLine）——杀之前必须确认目标
function processCommandLine(pid) {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').split(String.fromCharCode(0)).join(' ').trim();
    }
    if (process.platform !== 'win32') {
      return execFileSync('ps', ['-p', String(Number(pid)), '-o', 'args='], { encoding: 'utf8', timeout: 15000 }).trim();
    }
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return String(out).trim();
  } catch (e) {
    return `<命令行读取失败: ${e.message}>`;
  }
}

// 起一个真实的 server/index.js 隔离进程（临时库 + 独立端口 + 本机 stub 上游）
function startIsolatedServer({ filePath, port, stubBaseUrl, extraEnv = {} }) {
  const logChunks = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      NOVEL_DB_FILE: filePath,
      PORT: String(port),
      HOST: '127.0.0.1',
      NOVEL_ALLOW_PRIVATE_BASE_URL: '1',
      NOVEL_BASE_URL: stubBaseUrl,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logChunks.push(String(chunk)));
  child.stderr.on('data', chunk => logChunks.push(String(chunk)));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    pid: child.pid,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    log: () => logChunks.join(''),
    exited,
  };
}

async function waitForServer(server, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server.child.exitCode !== null) {
      throw new Error(`隔离进程提前退出（code=${server.child.exitCode}）：${server.log().slice(0, 500)}`);
    }
    try {
      const res = await fetch(`${server.baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`隔离进程 ${timeoutMs}ms 内未就绪：${server.log().slice(0, 500)}`);
    await new Promise(r => setTimeout(r, 150));
  }
}

// 结束时停进程：先核对命令行属于本轮的 server/index.js，再杀；核对失败也要停（避免残留孤儿进程），
// 但把核对结果如实记进证据。
async function stopIsolatedServer(server, { hard = false } = {}) {
  const commandLine = processCommandLine(server.pid);
  const verified = commandLine.includes('server/index.js');
  if (server.child.exitCode === null) {
    server.child.kill(hard ? 'SIGKILL' : 'SIGTERM');
    const outcome = await Promise.race([
      server.exited,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    if (outcome && outcome.timeout) {
      server.child.kill('SIGKILL');
      await server.exited;
    }
  }
  return { pid: server.pid, commandLine, verified, hard };
}

// 本机 stub 上游（隔离进程用）：脚本队列 + 请求计数，SSE / JSON 两种形态
function createStubUpstream() {
  const http = require('node:http');
  const state = { requests: [], steps: [], held: [] };
  state.script = steps => { state.steps.length = 0; state.steps.push(...steps); };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      state.requests.push({ url: req.url, body, at: Date.now() });
      // 只对 /chat/completions 消费剧本：渠道模型清单（/v1/models）等旁路请求走固定空响应，
      // 否则它们会把剧本步数吃掉（实测：一次模型清单刷新就吃掉一步，导致后续请求全 500）
      if (!String(req.url).includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      let out = null;
      try {
        const stepFn = state.steps.shift();
        if (!stepFn) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'S6-01 stub 上游剧本耗尽' } }));
          return;
        }
        // 剧本步允许是函数（按请求体决策）或普通对象（固定响应）
        out = (typeof stepFn === 'function' ? stepFn(body) : stepFn) || {};
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'S6-01 stub 上游剧本执行失败：' + String((err && err.message) || err) } }));
        return;
      }
      if (out.hold) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (out.firstText) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.firstText } }] })}\n\n`);
        state.held.push(res); // 不结束：模拟生成中（供「杀进程」场景）
        return;
      }
      if (out.sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const frame of out.sse) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (out.status && out.status !== 200) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: out.message || 'synthetic' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json || { choices: [{ message: { role: 'assistant', content: '（空）' } }] }));
    });
  });
  return {
    state,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}` };
    },
    async stop() {
      for (const held of state.held) { try { held.end(); } catch { /* 已断 */ } }
      state.held.length = 0;
      await new Promise(resolve => server.close(resolve));
    },
    requestCount: () => state.requests.length,
  };
}


// ---------------------------------------------------------------- 第 10 组：隔离进程重启/恢复

// 隔离进程轮次的工作目录：优先任务卡指定的 系统临时证据目录（不存在则退回系统临时目录并如实记录）
function restartWorkDir() {
  const preferred = path.join(os.tmpdir(), 'plotforge-system-qa');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return os.tmpdir();
  }
}

function removeIfExists(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* 不存在即可 */ }
}

// 一轮「隔离进程重启/恢复」：
//   1) 独立临时库 + 独立端口起真实 server/index.js（上游指向本机 stub，NOVEL_ALLOW_PRIVATE_BASE_URL=1）
//   2) 合成书写章 / 版本 / 会话证据 / 待确认卡 / 一个在途运行
//   3) 核对命令行后硬杀进程（模拟崩溃，不 flush、不优雅退出）
//   4) 同库同端口重启：逐项比对（运行 interrupted、会话证据、版本与卡绑定、不自动重放）
async function runRestartRound({ seed, port, workDir }) {
  const record = newRecord(seed, 'process-restart', 10);
  record.requiredChecks = REQUIRED_CHECKS[10];
  const dir = workDir || restartWorkDir();
  const dbFile = path.join(dir, `s601-restart-${seed}.db`);
  const lockFile = `${dbFile}.lock`;
  removeIfExists(lockFile);
  removeIfExists(dbFile);
  record.dbFile = dbFile;

  const upstream = createStubUpstream();
  const upstreamInfo = await upstream.start();
  record.stubUpstream = upstreamInfo.baseUrl;
  let first = null;
  let second = null;
  try {
    // 预置占位渠道配置（只复制必要模型配置，不复制任何真实小说）
    await db.init({ filePath: dbFile });
    db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?)", [`${upstreamInfo.baseUrl}/v1`]);
    db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
    db.run("INSERT INTO settings (key, value) VALUES ('model', 'synthetic-flash')");
    db.saveNow();
    db.close();

    const httpJson = async (baseUrl, method, pathname, body) => {
      const res = await fetch(baseUrl + pathname, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { payload = null; }
      return { status: res.status, body: payload, text };
    };

    first = startIsolatedServer({ filePath: dbFile, port, stubBaseUrl: `${upstreamInfo.baseUrl}/v1` });
    await waitForServer(first);
    record.firstPid = first.pid;

    // 合成书（走真实 REST 路由）
    const book = (await httpJson(first.baseUrl, 'POST', '/api/books', { title: `重启合成书 ${seed}` })).body.book;
    const volume = (await httpJson(first.baseUrl, 'POST', `/api/books/${book.id}/volumes`, { title: '第一卷 重启' })).body.volume;
    const chapter = (await httpJson(first.baseUrl, 'POST', `/api/books/${book.id}/chapters`, {
      title: '第1章 重启动点', volume_id: volume.id,
    })).body.chapter;
    const content = `S6RESTART${seed} 第一段正文。`;
    const put = await httpJson(first.baseUrl, 'PUT', `/api/books/${book.id}/chapters/${chapter.id}`, {
      content, expected_revision: chapter.revision,
    });
    record.checks = record.checks || {};
    record.checks.beforeWriteOk = put.status === 200;
    record.checks.beforeRevision = put.body.chapter.revision;
    record.revisionBefore = { [String(chapter.id)]: chapter.revision };
    record.changedChapters = [String(chapter.id)];

    // 会议证据：Agent 会话 + 一次正常讨论（stub 返回纯文本）
    const conversation = (await httpJson(first.baseUrl, 'POST', '/api/conversations', {
      kind: 'agent', scope: 'book', bookId: book.id, title: `重启会话 ${seed}`,
    })).body;
    upstream.state.script([
      { sse: [
        { choices: [{ delta: { content: 'S6RESTART-CONV 已记录。' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5 } },
      ] },
    ]);
    const agentRes = await fetch(`${first.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id, content: '记一条重启前会话证据', mode: 'discuss', request_id: `r${seed}-discuss`,
      }),
    });
    await agentRes.text().catch(() => '');
    record.checks.beforeConversationStatus = agentRes.status;

    // 待确认卡（Agent 台发起，绑定该会话）：重启后必须仍准确绑定、不被自动执行
    upstream.state.script([
      { sse: [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `r${seed}-card`, function: { name: 'lock_chapter', arguments: JSON.stringify({ book_id: book.id, chapter_id: chapter.id }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ] },
    ]);
    const cardRes = await fetch(`${first.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id, content: '把这一章定稿', mode: 'execute', book_id: book.id, request_id: `r${seed}-card`,
      }),
    });
    const cardText = await cardRes.text().catch(() => '');
    const cardIds = [...cardText.matchAll(/"id":"(c_[a-z0-9]+)"/g)].map(m => m[1]);
    const cardId = cardIds.length ? cardIds[0] : null;
    record.checks.pendingCardCreatedBefore = !!cardId;
    record.pendingCardId = cardId;

    // 在途运行：上游只吐一帧就保持（等待被杀的运行）
    upstream.state.script([{ hold: true, firstText: 'S6RESTART-INFLIGHT 生成中。' }]);
    const inflight = fetch(`${first.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id, content: '在途运行（将被杀掉）', mode: 'discuss', request_id: `r${seed}-inflight`,
      }),
    }).catch(() => null);
    await waitForConditionSafe(() => upstream.requestCount() >= 3, 10000);
    const requestsBeforeKill = upstream.requestCount();
    record.checks.inflightRequestsBeforeKill = requestsBeforeKill;
    // 硬杀之前必须确认「运行占位已落盘」：sql.js 的落盘有 1s debounce，关键写才走 saveNow。
    // 若在 debounce 窗口内硬杀，run 行本身可能尚未入盘——那是另一类边界（本次不作为断言对象），
    // 所以这里等它真的可读再杀，并把「杀前是否已落盘」如实记进证据。
    const durableBeforeKill = await waitForConditionSafe(
      () => db2Query(dbFile, 'SELECT status FROM agent_runs WHERE request_id = ?', [`r${seed}-inflight`]),
      8000
    );
    record.checks.inflightRunDurableBeforeKill = !!durableBeforeKill;
    await new Promise(r => setTimeout(r, 1200));   // 覆盖 debounce 窗口，保证落盘是一次真实同步写之后
    const durableStatus = durableBeforeKill ? durableBeforeKill.status : null;
    record.checks.inflightRunStatusBeforeKill = durableStatus;

    // 杀进程（先核对命令行，再硬杀）
    const stop1 = await stopIsolatedServer(first, { hard: true });
    record.stopEvidence = { pid: stop1.pid, verified: stop1.verified, commandLine: stop1.commandLine.slice(0, 200) };
    await inflight;
    record.checks.killedHard = stop1.verified === true;

    // 同库同端口重启
    second = startIsolatedServer({ filePath: dbFile, port, stubBaseUrl: `${upstreamInfo.baseUrl}/v1` });
    await waitForServer(second);
    record.secondPid = second.pid;
    const requestsAtRestart = upstream.requestCount();
    // 只数**生成请求**：服务器重启后的模型列表探测（/v1/models）也会进 requests，不能当成「重发又调了一次模型」。
    const completionsAtRestart = upstream.state.requests.filter(r => String(r.url).includes('/chat/completions')).length;

    // 逐项比对
    const runRow = (await httpJson(second.baseUrl, 'GET', `/api/books/${book.id}/chapters/${chapter.id}`)).body;
    record.checks.chapterSurvived = String(runRow.chapter.content).includes(`S6RESTART${seed}`);
    record.checks.revisionSurvived = runRow.chapter.revision === put.body.chapter.revision;
    record.revisionAfter = { [String(chapter.id)]: runRow.chapter.revision };
    // 持久化结果（第 10 组的口径）：硬杀重启后仍能从**同一个库文件**读回同一内容与 revision，
    // 就是这条链路的 durable 证明；卡在内存不落盘的写法过不了这一关。
    record.persisted = {
      durableSource: 'post-restart-api-read',
      changedChapters: record.changedChapters,
      chaptersCompared: 1,
      diskMismatched: record.checks.chapterSurvived === true && record.checks.revisionSurvived === true
        ? [] : [String(chapter.id)],
      durable: record.checks.chapterSurvived === true && record.checks.revisionSurvived === true,
    };
    const messages = await httpJson(second.baseUrl, 'GET', `/api/conversations/${conversation.id}/messages`);
    record.checks.conversationEvidenceSurvived = messages.status === 200
      && Array.isArray(messages.body.messages)
      && messages.body.messages.some(m => String(m.content || '').includes('重启前会话证据'));
    // 未结算运行 → interrupted（可解释），且不自动重放
    const inflightRow = await db2Query(dbFile, 'SELECT status, reason FROM agent_runs WHERE request_id = ?', [`r${seed}-inflight`]);
    record.checks.inflightInterrupted = !!inflightRow && inflightRow.status === 'interrupted';
    record.checks.inflightReason = inflightRow ? inflightRow.reason : null;
    // 同 request_id 重发 → duplicate，不再调上游
    const replay = await httpJson(second.baseUrl, 'POST', '/api/agent/chat', {
      conversation_id: conversation.id, content: '断后重发同一 request_id', mode: 'discuss', request_id: `r${seed}-inflight`,
    });
    record.checks.replayDuplicate = !!(replay.body && replay.body.duplicate === true);
    record.checks.replayNoNewUpstreamCall = upstream.requestCount() === requestsAtRestart;
    // 卡绑定准确：错会话确认 403，卡仍 pending（明确不自动执行）
    if (cardId) {
      const wrong = await httpJson(second.baseUrl, 'POST', `/api/agent/actions/${cardId}/confirm`, {
        approve: true, conversation_id: 'conv-not-mine',
      });
      record.checks.cardWrongConversation403 = wrong.status === 403;
      const cardRow = await db2Query(dbFile, 'SELECT status FROM chat_actions WHERE id = ?', [cardId]);
      record.checks.cardStillPending = !!cardRow && cardRow.status === 'pending';
      const lockedAfterRestart = (await httpJson(second.baseUrl, 'GET', `/api/books/${book.id}/chapters/${chapter.id}`)).body.chapter.locked;
      record.checks.noAutoExecution = lockedAfterRestart === 0;
    } else {
      record.checks.cardWrongConversation403 = false;
      record.checks.cardStillPending = false;
      record.checks.noAutoExecution = (await httpJson(second.baseUrl, 'GET', `/api/books/${book.id}/chapters/${chapter.id}`)).body.chapter.locked === 0;
    }
    record.checks.versionsSurvived = (await db2QueryAll(dbFile, 'SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chapter.id]))[0].n >= 1;

    // 五条安全不变量（第 10 组跑在独立子进程里，进程内计数器不适用）：
    // 全部由**实际库/接口证据**计数归零才算通过，不是常量 0。
    // 注意一处刻意的差别：本轮**故意**留下一张 pending 卡（S6-01 要求验证它重启后仍在、仍绑本会话、
    // 不被自动执行），因此「清理后活跃运行」只计 残留写锁 + running 运行 + 未被标记 interrupted 的在途运行；
    // pending 卡与 awaiting_confirmation 行数另记进 counters，供证据追溯，不计入该不变量。
    const appliedCards = (await db2QueryAll(dbFile,
      "SELECT COUNT(*) AS n FROM chat_actions WHERE book_id = ? AND status = 'approved'", [book.id]))[0].n;
    const cardBinding = cardId
      ? await db2Query(dbFile, `SELECT a.run_id AS run_id, r.conversation_id AS conversation_id
          FROM chat_actions a LEFT JOIN agent_runs r ON r.id = a.run_id WHERE a.id = ?`, [cardId])
      : null;
    const runRowsForRequest = (await db2QueryAll(dbFile,
      'SELECT COUNT(*) AS n FROM agent_runs WHERE request_id = ?', [`r${seed}-inflight`]))[0].n;
    const runningRows = (await db2QueryAll(dbFile,
      "SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'"))[0].n;
    const awaitingRows = (await db2QueryAll(dbFile,
      "SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'awaiting_confirmation'"))[0].n;
    const pendingCards = (await db2QueryAll(dbFile,
      "SELECT COUNT(*) AS n FROM chat_actions WHERE status = 'pending'"))[0].n;
    const lockedAfterRestart = Number((await httpJson(second.baseUrl,
      'GET', `/api/books/${book.id}/chapters/${chapter.id}`)).body.chapter.locked) || 0;
    const upstreamCallsAfterReplay = upstream.state.requests
      .filter(r => String(r.url).includes('/chat/completions')).length - completionsAtRestart;
    const cardConversationMatches = !!(cardBinding && cardBinding.run_id && cardBinding.conversation_id === conversation.id);
    record.counters = {
      appliedCards, runRowsForRequest, runningRows, awaitingRows, pendingCards,
      lockedAfterRestart, upstreamCallsAfterReplay, cardConversationMatches,
      upstreamRequestsAfterReplay: upstream.requestCount() - requestsAtRestart,
      cardBindingRunId: cardBinding ? cardBinding.run_id : null,
    };
    // 本轮运行留痕：卡的发起运行 + 被硬杀的在途运行（两者都在重启后从同一库文件里读回）
    const inflightRunRow = await db2Query(dbFile, 'SELECT id FROM agent_runs WHERE request_id = ?', [`r${seed}-inflight`]);
    record.runIds = [cardBinding ? cardBinding.run_id : null, inflightRunRow ? inflightRunRow.id : null].filter(Boolean);
    record.runId = inflightRunRow ? inflightRunRow.id : null;
    record.counters.inflightRunId = record.runId;
    record.invariants = {
      unauthorizedWrites: appliedCards + (lockedAfterRestart === 0 ? 0 : 1),
      duplicateAppliedActions: Math.max(0, runRowsForRequest - 1) + Math.max(0, upstreamCallsAfterReplay),
      crossConversationLeaks: (record.checks.cardWrongConversation403 === true ? 0 : 1)
        + (cardConversationMatches ? 0 : 1),
      falseDurableSuccesses: [record.checks.chapterSurvived, record.checks.revisionSurvived,
        record.checks.versionsSurvived, record.checks.conversationEvidenceSurvived].filter(v => v !== true).length,
      activeRunsAfterCleanup: runningRows + lockedAfterRestart
        + (record.checks.inflightInterrupted === true ? 0 : 1),
      evidence: [],
    };
    record.checks.secondLogTail = second.log().slice(-1200);
    record.checks.firstLogHead = first.log().slice(0, 2500);
    record.stubRequests = upstream.state.requests.map(r => ({
      url: r.url, at: r.at, messages: (r.body && r.body.messages || []).length, stream: !!(r.body && r.body.stream),
    }));
    const stop2 = await stopIsolatedServer(second, { hard: true });
    record.stopEvidence2 = { pid: stop2.pid, verified: stop2.verified };
    second = null;
  } finally {
    if (first) await stopIsolatedServer(first, { hard: true });
    if (second) await stopIsolatedServer(second, { hard: true });
    await upstream.stop();
  }
  return record;
}

// 直接读库（子进程已停止时用；sql.js 单文件读，不占锁）
async function db2Query(filePath, sql, params = []) {
  const rows = await db2QueryAll(filePath, sql, params);
  return rows[0] || null;
}

async function db2QueryAll(filePath, sql, params = []) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: f => path.join(REPO_ROOT, 'node_modules', 'sql.js', 'dist', f) });
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const stmt = database.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } finally {
    database.close();
  }
}

module.exports = {
  REPO_ROOT,
  STUB_BASE_URL,
  openSystem,
  api,
  writingStream,
  agentStream,
  drainResponse,
  beginScript,
  httpErrorStub,
  hangingStream,
  step,
  seedSyntheticBook,
  createAgentConversation,
  dbCount,
  chapterRow,
  fileRead,
  makeInvariants,
  markUnauthorized,
  markDuplicate,
  markLeak,
  markFalseDurable,
  activeRunsSnapshot,
  markActiveRuns,
  assertDurableWrite,
  scanLeaks,
  newRecord,
  executionsByTool,
  executionDelta,
  waitForCondition,
  waitForConditionSafe,
  writingActionId,
  agentConfirmationId,
  confirmWritingAction,
  confirmAgentAction,
  resumeAgentAction,
  settleIndex,
  runLoopRound,
  FAULT_GROUPS,
  runFaultRound,
  installDiskFault,
  deferredJson,
  withHeaders,
  pickPort,
  runRestartRound,
  restartWorkDir,
  db2Query,
  db2QueryAll,
  processCommandLine,
  startIsolatedServer,
  waitForServer,
  stopIsolatedServer,
  createStubUpstream,
  actionStore,
  runSvc,
  db,
  waitUntil,
  waitFor,
  os,
  path,
};
