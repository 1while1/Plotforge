// Agent 助手路由：POST /chat（SSE 流式）、GET /tools（工具清单）、
// POST /actions/:id/confirm（作者确认执行）、POST /actions/:id/resume（确认结果作为系统事件续跑 Agent）
// S2-01（2026-09-21）：接入共享运行协调器——agent 运行落 agent_runs（entry='agent'），
// mode=discuss 只占会话锁（可与写作并行）；mode=execute 绑定 book_id 时加该书写锁，
// 与写作页/确认执行共用同一把锁（book:write:<id>）。confirm 的 approve 执行在
// 持有该书写锁的临界区内进行，忙时 409 BOOK_BUSY 可见，不绕过。
// S3-02（2026-09-22）：历史改由服务端会话组装——/chat 只收 conversation_id+content，
// 客户端 messages 数组不再是权威（C10：跨轮工具证据来自服务端记录，不靠前端重发）。
const express = require('express');
const db = require('../db');
const { runAgent, buildActionResumeMessages } = require('../agent/agent');
const { listTools } = require('../tools/registry');
const { executeTool, auditRejection } = require('../tools/executor');
const { serializeToolError } = require('../tools/loop-helpers');
const actionStore = require('../actionStore');
const runSvc = require('../runtime/run-service');
const conversationSvc = require('../conversations/service');
const { historyFacts } = require('../chat/tool-history');
const { systemPromptTokenBudget } = require('../llm');

const router = express.Router();

// 会话键服务端派生：不信任浏览器任意字符串做访问凭据，只做归属比对用的稳定标识。
// 幂等前缀：已带 agent: 的（actionStore 存量/工具创建路径）不再重复叠加。
// S3-02 起正常路径传入 conversation_id（uuid），派生 'agent:<uuid>'——会话即运行归属。
function agentSessionKey(raw) {
  const clean = String(raw || '').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 64);
  if (!clean) return 'agent:anonymous';
  return clean.startsWith('agent:') ? clean.slice(0, 70) : ('agent:' + clean).slice(0, 70);
}

// 服务端历史组装：user/assistant 文本 + system 来源事件 + 可信工具证据块（复用写作页
// historyFacts 同一实现——tools_json 里的确认卡还会回查当前结算状态，不伪造成功）。
// S3-05：书范围会话注入「本书资料快照」——复用写作页同一 context 管道（不另造知识库），
// chapterId=时序边界（前情记忆 provider 按章裁剪未来事件）；未指定=全书口径。
// 快照在组装时刻生成（run 固定来源版本，资料更新下一次组装才生效）；
// 上次请求的选中章节不持久化——每次请求显式指定，不沿用旧边界。
// S4-01b：快照头带上本站 book_id（受控资源工具的书内类型要求显式 bookId——模型不该猜 id，
// 页面「范围」选中的就是这一本）；并改用 Agent 侧可独立收窄的快照预算（见下）。
const SNAPSHOT_BUDGET_ENV = 'NOVEL_AGENT_SNAPSHOT_TOKEN_BUDGET';

// S4-01b / G3 已知边界 8（Agent 书资料快照 token 占用，属 S4-01 预算细分）：
// 给 Agent 台资料快照一个独立预算入口。默认与写作侧 systemPromptTokenBudget() 同值——
// 「两个空间共享正式资料」的语义与请求体逐位不变（不擅自改默认值：比例是产品决策）；
// 需要单独收窄 Agent 侧时用 NOVEL_AGENT_SNAPSHOT_TOKEN_BUDGET 显式指定，且只允许收窄
// （不越过写作侧预算，也就不越过模型窗口）。不改上下文架构，章节边界语义与 provider 管道不动。
function agentSnapshotTokenBudget() {
  const writing = systemPromptTokenBudget();
  const raw = Number(process.env[SNAPSHOT_BUDGET_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return writing;
  return Math.max(1000, Math.min(Math.floor(raw), writing));
}

async function assembleAgentModelMessages(ctx, newContent, { chapterId } = {}) {
  const msgs = [];
  if (ctx.conversation.scope === 'book' && ctx.conversation.book_id) {
    const book = db.get('SELECT * FROM books WHERE id = ?', [Number(ctx.conversation.book_id)]);
    if (book) {
      const context = require('../context');
      const assembled = await context.assembleDetailed({
        book, chapterId: Number(chapterId) > 0 ? Number(chapterId) : null, db,
        query: newContent, systemTokenBudget: agentSnapshotTokenBudget(),
      });
      const boundary = Number(chapterId) > 0
        ? `截至 chapterId=${Number(chapterId)}（含该章及更早的资料；更晚章节的事件与前文不注入）`
        : '全书范围（无时序边界）';
      msgs.push({
        role: 'system',
        content: `【本书资料快照】（book_id=${book.id}；${boundary}；资料为本次组装时刻的版本，期间的资料变更将在下一次请求生效）
${assembled.text}`,
      });
    }
  }
  const factRows = ctx.messages.filter(m => m.tools_json);
  if (factRows.length) {
    const bookId = ctx.conversation.scope === 'book' ? Number(ctx.conversation.book_id) : 0;
    const factText = historyFacts(factRows, bookId, null);
    if (factText) msgs.push({ role: 'system', content: factText });
  }
  for (const m of ctx.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    msgs.push(m.source === 'system' ? { role: 'system', content: m.content } : { role: m.role, content: m.content });
  }
  msgs.push({ role: 'user', content: newContent });
  return msgs;
}

// 会话归属与状态校验：/chat 与 /resume 共用。错误码与 S3-01 路由同口径。
function requireAgentConversation(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') {
    const err = new Error('必须指定有效会话（conversation_id），服务端按会话组装历史');
    err.status = 400; err.code = 'CONVERSATION_REQUIRED';
    throw err;
  }
  const conv = conversationSvc.getConversation(conversationId);
  if (!conv) {
    const err = new Error('会话不存在');
    err.status = 404; err.code = 'CONVERSATION_NOT_FOUND';
    throw err;
  }
  if (conv.kind !== 'agent') {
    const err = new Error('该会话不是 Agent 会话');
    err.status = 400; err.code = 'CONVERSATION_KIND_MISMATCH';
    throw err;
  }
  if (conv.status !== 'active') {
    const err = new Error('会话已归档，不能继续对话');
    err.status = 409; err.code = 'CONVERSATION_ARCHIVED';
    throw err;
  }
  return conv;
}

function rejectClientHistory(body) {
  if (body && body.messages !== undefined) {
    const err = new Error('客户端 messages 数组不再是历史权威；请只发 conversation_id 与 content');
    err.status = 400; err.code = 'CLIENT_HISTORY_REJECTED';
    throw err;
  }
}

// 运行协调包装：幂等短路 → 按 mode 取锁 → 占位落盘 → runAgent → 终态/释放。
// Agent 的 SSE 是 SDK UI Message Stream（与写作页格式不同），S2-01 不映射事件进
// agent_run_events（运行行+终态已可追溯；事件表先服务写作入口，见台账口径说明）。
// S3-02：conversationId 落 agent_runs.conversation_id；onRunStart 在占位成功后回调
// （幂等/忙时不回调——用户消息与系统事件只在真实新运行时落会话，重放不重复写入）。
async function runAgentCoordinated(messages, res, { conversationId, sessionKey, mode, bookId, resumeActionId, requestId, settledAction, verifiedWrite, onRunStart, readBookId, readChapterId }) {
  const existing = runSvc.findRunByRequest(sessionKey, requestId);
  if (existing) {
    return res.status(runSvc.ACTIVE_STATUSES.includes(existing.status) ? 202 : 200)
      .json({ runId: existing.id, status: existing.status, duplicate: true, sessionKey });
  }
  const scopes = [runSvc.sessionScope(sessionKey)];
  if (mode === 'execute' && Number.isFinite(Number(bookId))) scopes.push(runSvc.bookWriteScope(Number(bookId)));
  const runId = runSvc.newRunId();
  if (!runSvc.acquireScopes(scopes, runId).ok) {
    return res.status(409).json({
      error: { code: mode === 'execute' ? 'BOOK_BUSY' : 'AGENT_BUSY', message: '该会话上一条 Agent 运行还在进行中，请稍候再发' },
    });
  }
  const raced = runSvc.findRunByRequest(sessionKey, requestId);
  if (raced) { runSvc.releaseScopes(scopes, runId); return res.status(202).json({ runId: raced.id, status: raced.status, duplicate: true, sessionKey }); }
  try {
    // S2-03：startRun 对 resume_action_id 唯一索引冲突返回 duplicate（不抛）——
    // 该确认动作已有续跑运行（含已终结的 cancelled/interrupted），短路返回既有运行，防双跑。
    const started = runSvc.startRun({ runId, requestId, sessionKey, conversationId: conversationId || null, entry: 'agent', bookId: mode === 'execute' ? Number(bookId) : null, mode, resumeActionId: resumeActionId || null });
    if (started && started.duplicate) {
      runSvc.releaseScopes(scopes, runId);
      return res.status(runSvc.ACTIVE_STATUSES.includes(started.run.status) ? 202 : 200)
        .json({ runId: started.run.id, status: started.run.status, duplicate: true, sessionKey });
    }
    // 占位成功（新运行）：落会话消息（用户输入 / 系统事件）。失败则放锁报错，不跑模型。
    if (typeof onRunStart === 'function') {
      try {
        onRunStart(runId);
      } catch (e) {
        runSvc.releaseScopes(scopes, runId);
        try { runSvc.finishRun(runId, { status: 'failed', reason: 'conversation_persist_failed' }); } catch (_) { /* 不阻断 */ }
        return res.status(e.status || 500).json({ error: { code: e.code || 'CONVERSATION_PERSIST_FAILED', message: e.message } });
      }
    }
  } catch (e) {
    runSvc.releaseScopes(scopes, runId);
    return res.status(e.status || 503).json({ error: { code: e.code || 'RUN_PERSIST_FAILED', message: e.message } });
  }
  let runFinalized = false;
  const finalizeRunOnce = (status, reason) => {
    if (runFinalized) return;
    runFinalized = true;
    try { runSvc.finishRun(runId, { status, reason, actionId: resumeActionId || undefined }); } catch (_) { /* 不阻断 */ }
  };
  // S2-04：终态以 normalizeFinish 裁决为准落 agent_runs 行（watchdog 触发即刻定格）——
  // 此前一律写 finished，watchdog/截断事实只活在 SSE 里，run 行与前端裁决矛盾（G2 审查 P2-2）
  let runOutcome = null;
  const finalStatus = () => {
    // 终态白名单校验：未知状态退回 finished（与 chat 入口同口径）
    if (!runOutcome) return { status: 'finished', reason: null };
    const ok = runSvc.TERMINAL_STATUSES.includes(runOutcome.status) || runOutcome.status === 'awaiting_confirmation';
    return ok ? { status: runOutcome.status, reason: runOutcome.reason || null } : { status: 'finished', reason: null };
  };
  let clientGone = false;
  res.once('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    // 关闭即终结推断，但已有明确裁决（watchdog 到期/流式错误/截断定格）时以裁决为准——
    // watchdog 的 abort 会连锁触发 close，此时写 client_disconnected 等于丢掉真凶（G2 审查 P2-2）。
    // 不依赖 pipe 返回：abort 后 SDK 的 pipe 可能整体悬挂（HTTP 实测），run 行不能跟着悬。
    if (runOutcome) {
      const fin = finalStatus();
      finalizeRunOnce(fin.status, fin.reason);
    } else {
      finalizeRunOnce('cancelled', 'client_disconnected');
    }
    runSvc.releaseScopes(scopes, runId);
  });
  try {
    await runAgent(messages, res, {
      sessionId: sessionKey,
      conversationId: conversationId || null,
      mode,
      actor: 'author',
      settledAction: settledAction || (resumeActionId ? { id: resumeActionId } : undefined),
      verifiedWrite: verifiedWrite || undefined,
      // S2-02：确认卡创建时快照发起运行 id
      runId,
      // S2-04：硬超时可配（测试注入短值；默认 180s）
      watchdogMs: runSvc.DEFAULT_MAX_DURATION_MS,
      // S5-02 / R01：明确重读要求的解析范围（会话书归属/执行绑定书 + 本轮时序边界章）。
      // 只在作者明确要求本轮实际重读时用得上；global 会话无书归属 → 由核验给出范围歧义状态。
      bookId: Number.isFinite(Number(readBookId)) ? Number(readBookId) : null,
      chapterId: Number(readChapterId) > 0 ? Number(readChapterId) : null,
      // 控制态裁决（watchdog 到期/截断/失败）即刻落 run 行——不依赖 pipe 返回（abort 后
      // SDK 的 pipe 可能整体悬挂，HTTP 实测）也不依赖连接关闭（G2 审查 P2-2）；
      // finished/awaiting_confirmation 留给收尾路径统一白名单落行。
      onOutcome: (norm) => {
        runOutcome = norm;
        if (norm.status !== 'finished' && norm.status !== 'awaiting_confirmation') {
          const fin = finalStatus();
          finalizeRunOnce(fin.status, fin.reason);
          // 终态已落行：立即放锁（幂等）。不能等 pipe 返回或连接关闭——abort 后 SDK
          // 的 pipe 可能整体悬挂（node --test 实测），客户端不断开时锁会永不释放，
          // 同会话后续请求全部 409 AGENT_BUSY（S2-04 遗留边界，G2 整改收口）
          runSvc.releaseScopes(scopes, runId);
        }
      },
    });
    if (!clientGone) {
      const fin = finalStatus();
      finalizeRunOnce(fin.status, fin.reason);
      runSvc.releaseScopes(scopes, runId);
    }
  } catch (err) {
    // 抛错路径（含 watchdog abort 传播）：优先用已定格的裁决 reason，兜底才用错误消息
    const fin = finalStatus();
    finalizeRunOnce(fin.status === 'finished' ? 'failed' : fin.status,
      fin.reason || (runOutcome ? null : String(err && err.message || err).slice(0, 100)));
    runSvc.releaseScopes(scopes, runId);
    if (!res.headersSent) {
      return res.status(500).json({ error: { code: 'AGENT_RUN_FAILED', message: err.message || 'Agent 运行失败' } });
    }
    res.end();
  }
}

router.post('/chat', async (req, res, next) => {
  try {
    // S3-02：客户端 messages 数组不再是历史权威（C10：跨轮工具证据来自服务端会话）
    rejectClientHistory(req.body);
    const conv = requireAgentConversation(req.body.conversation_id);
    const content = req.body.content;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: { code: 'CONTENT_REQUIRED', message: 'content 必须是非空字符串' } });
    }
    // S2-01：mode=discuss（默认，只读对话，可与写作并行）/ execute（明确执行请求，
    // 必须绑定 book_id——执行书内变更前必须明确绑定一本书，契约 3.3）
    const mode = req.body.mode === 'execute' ? 'execute' : 'discuss';
    const bookId = req.body.book_id !== undefined && req.body.book_id !== null && req.body.book_id !== ''
      ? Number(req.body.book_id) : null;
    if (mode === 'execute' && !Number.isFinite(bookId)) {
      return res.status(400).json({ error: { code: 'BOOK_REQUIRED', message: 'execute 模式必须绑定 book_id' } });
    }
    // S3-05：global 会话可只读找书，但书内执行必须明确绑定「存在的」书（不能猜 ID）
    if (mode === 'execute' && !db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      return res.status(404).json({ error: { code: 'BOOK_NOT_FOUND', message: 'execute 模式绑定的书籍不存在；请先用工具定位真实 id，不要猜测' } });
    }
    // 服务端历史组装：会话文本 + 书资料快照（时序边界）+ 可信工具证据（tools_json，非客户端重发）
    const ctx = conversationSvc.getConversationContext({ conversationId: conv.id });
    const messages = await assembleAgentModelMessages(ctx, content, { chapterId: req.body.chapterId });
    await runAgentCoordinated(messages, res, {
      conversationId: conv.id,
      sessionKey: agentSessionKey(conv.id),
      mode,
      bookId,
      // S5-02 / R01：重读要求的解析范围＝会话书归属（book 会话）或本轮执行绑定书 + 时序边界章
      readBookId: conv.scope === 'book' && conv.book_id ? Number(conv.book_id) : (Number.isFinite(bookId) ? bookId : null),
      readChapterId: req.body.chapterId,
      requestId: req.body.request_id ? String(req.body.request_id).slice(0, 128) : runSvc.newRunId(),
      onRunStart: (runId) => {
        conversationSvc.appendMessage({ conversationId: conv.id, role: 'user', content, source: 'agent', runId });
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/tools', async (req, res, next) => {
  try {
    const list = listTools('agent').map(tool => ({
      name: tool.name,
      title: tool.title,
      description: (tool.description || '').split('。')[0],
      mutation: tool.mutation,
      confirmation: tool.confirmation,
    }));
    res.json({ tools: list });
  } catch (err) {
    next(err);
  }
});

router.post('/actions/:confirmationId/confirm', async (req, res, next) => {
  try {
    const action = actionStore.get(req.params.confirmationId);
    if (!action) {
      return res.status(404).json({
        error: { code: 'CONFIRMATION_NOT_FOUND', message: '确认动作不存在或已过期' },
      });
    }
    // F2：被更新的同类请求取代的卡不得执行——409 + 可读消息（与写作页确认路由同口径）
    if (action.status === 'superseded') {
      return res.status(409).json({
        error: {
          code: 'CONFIRMATION_SUPERSEDED',
          message: '该操作已被更新的同类请求取代，请确认最新那张卡',
        },
        superseded_by: action.supersededBy || null,
      });
    }
    // S2-02 / C07：执行中断结果不确定，不得重放；已结算的重复确认幂等返回既有结果（注入点③）
    if (action.status === 'interrupted') {
      return res.status(409).json({
        error: {
          code: 'ACTION_REQUIRES_REVIEW',
          message: '执行中断，可能已部分生效；请核对目标内容后重新发起请求',
        },
      });
    }
    // S2-03 / G2 审查 P3-1：会话归属校验必须先于一切读取/执行分支——此前幂等回放
    // （approved/failed/rejected 结果回看）排在会话派生之前，任何拿到 confirmationId
    // 的请求都能回看别人的工具执行结果。校验口径与 resume 路由一致：显式带别的
    // 会话 id 拒绝，不带则回落到动作发起会话。
    // S3-02：新卡按 conversation_id 派生（'agent:<uuid>'）；旧卡（S3-02 前创建）按
    // localStorage session_id 派生——两种显式声明都先于回放分支校验。
    const claimedSession = req.body.conversation_id
      ? agentSessionKey(req.body.conversation_id)
      : (req.body.session_id ? agentSessionKey(req.body.session_id) : null);
    if (claimedSession && claimedSession !== action.sessionId) {
      return res.status(403).json({
        error: { code: 'CONFIRMATION_MISMATCH', message: '确认凭证不属于该会话，无法查看或执行' },
      });
    }
    const sessionId = claimedSession || action.sessionId;
    if (action.status === 'approved' || action.status === 'failed' || action.status === 'rejected') {
      const r = action.result && typeof action.result === 'object' ? action.result : {};
      if (action.status === 'approved') return res.json({ ok: true, status: 'approved', result: action.result, replayed: true, confirmation_id: action.id });
      if (action.status === 'failed') return res.json({ ok: false, status: 'failed', error: { message: r.error || '执行失败', code: r.code || '' }, result: action.result, replayed: true, confirmation_id: action.id });
      return res.json({ ok: true, status: 'rejected', result: null, replayed: true, confirmation_id: action.id });
    }
    if (req.body.approve !== true) {
      const rejected = actionStore.reject(action.id, sessionId);
      if (!rejected.ok) {
        return res.status(403).json({
          error: { code: 'INVALID_CONFIRMATION', message: '确认凭证无效或已结算' },
        });
      }
      // 拒绝阶段审计（评审 §6）：记录作者驳回决定（confirmed_by=author）与原始发起方（requested_by=agent）
      auditRejection(action, sessionId);
      return res.json({ ok: true, status: 'rejected', result: null, confirmation_id: action.id });
    }
    // S2-01：Agent 的确认执行参与同一写操作所有权——与写作页单飞互斥（忙时 409 可见），
    // 临界区只包住同步 executeTool（执行完即释放，不跨模型调用持锁）
    const lockOwner = `confirm:${action.id}`;
    const writeScope = Number.isFinite(Number(action.bookId)) ? runSvc.bookWriteScope(Number(action.bookId)) : null;
    if (writeScope && !runSvc.acquireScopes([writeScope], lockOwner).ok) {
      return res.status(409).json({
        error: { code: 'BOOK_BUSY', message: '该书正在写作或执行其他操作，请稍候再确认' },
      });
    }
    try {
      const result = await executeTool({
        profile: 'agent',
        sessionId,
        bookId: action.bookId,
        source: 'agent-confirm',
        actor: 'author',
      }, action.name, action.args, action.id);
      // executeTool 内部已 settle('approved', result)；resume 可直接读取该可信结果
      return res.json({ ok: true, status: 'approved', result, confirmation_id: action.id });
    } catch (err) {
      // 执行失败：executeTool 已 settle('failed', {error,code})。回传结构化错误（非堆栈），
      // 前端仍可 resume 让模型知晓失败并决定修正——HTTP 200 表示“确认操作已受理并结算”
      return res.json({ ok: false, status: 'failed', error: serializeToolError(err, action.name), confirmation_id: action.id });
    } finally {
      if (writeScope) runSvc.releaseScopes([writeScope], lockOwner);
    }
  } catch (err) {
    return next(err);
  }
});

// 确认执行后恢复 Agent：把可信执行结果作为系统事件重新驱动模型续跑（非伪装用户消息）。
// 仅接受已结算动作（approved/failed/rejected）；旧凭证一次性，失败后需重新发起确认。
// S2-01：续跑是关联原 action 的执行类运行（resume_action_id 库级唯一，防换 requestId
// 绕过重复续跑）；幂等占位语义与 /chat 一致——完整 claim 协议在 S2-03 落地。
// S3-02：历史从确认卡快照的 run → conversation 服务端组装；客户端 messages 数组
// 拒收。S3-02 之前的旧卡（run 未绑会话）结果已结算但不能续跑——明确 409，不借
// anonymous 历史盲跑（旧卡 30 分钟 TTL，实际窗口极小）。
router.post('/actions/:confirmationId/resume', async (req, res, next) => {
  try {
    const action = actionStore.get(req.params.confirmationId);
    if (!action) {
      return res.status(404).json({
        error: { code: 'CONFIRMATION_NOT_FOUND', message: '确认动作不存在或已过期' },
      });
    }
    // 动作状态守卫先于请求形状校验：中断/未结算/已续跑的语义对作者更重要
    if (action.status === 'interrupted') {
      return res.status(409).json({
        error: {
          code: 'ACTION_REQUIRES_REVIEW',
          message: '该动作执行中断，结果不确定（可能已部分生效），不能续跑；请核对目标内容后重新发起',
        },
      });
    }
    if (action.status !== 'approved' && action.status !== 'failed' && action.status !== 'rejected') {
      return res.status(409).json({
        error: { code: 'ACTION_NOT_SETTLED', message: '该动作尚未确认执行或已过期，无法恢复' },
      });
    }
    if (action.resumeDone) {
      return res.status(409).json({
        error: { code: 'ACTION_ALREADY_RESUMED', message: '该确认结果已续跑过' },
      });
    }
    rejectClientHistory(req.body);
    // 会话绑定解析：action.run_id → agent_runs.conversation_id（生产路径由运行内创建的
    // 确认卡自动快照）。无绑定的旧卡不支持会话续跑。
    const run = action.runId
      ? db.get('SELECT id, conversation_id FROM agent_runs WHERE id = ?', [String(action.runId)])
      : null;
    const conversationId = run && run.conversation_id;
    if (!conversationId) {
      return res.status(409).json({
        error: {
          code: 'ACTION_LEGACY_NO_CONVERSATION',
          message: '旧确认卡未绑定会话，不能续跑；结果已结算，请在新会话中继续任务',
        },
      });
    }
    // S2-03：续跑凭证与发起会话绑定（与 confirm 的 authorize 校验同口径）——
    // 请求显式带了别的会话 id 时拒绝，不允许跨会话消费别人的确认结果。
    if (req.body.conversation_id && req.body.conversation_id !== conversationId) {
      return res.status(403).json({
        error: { code: 'CONFIRMATION_MISMATCH', message: '确认凭证不属于该会话，无法续跑' },
      });
    }
    if (req.body.session_id && agentSessionKey(req.body.session_id) !== action.sessionId) {
      return res.status(403).json({
        error: { code: 'CONFIRMATION_MISMATCH', message: '确认凭证不属于该会话，无法续跑' },
      });
    }
    const conv = requireAgentConversation(conversationId);
    // 服务端历史组装 + 系统事件（可信执行结果，非用户消息）
    const ctx = conversationSvc.getConversationContext({ conversationId: conv.id });
    const historyPairs = ctx.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => (m.source === 'system' ? { role: 'system', content: m.content } : { role: m.role, content: m.content }));
    const factRows = ctx.messages.filter(m => m.tools_json);
    let resumeMessages;
    if (factRows.length) {
      const factText = historyFacts(factRows, Number(conv.book_id) || 0, null);
      resumeMessages = buildActionResumeMessages(
        (factText ? [{ role: 'system', content: factText }, ...historyPairs] : historyPairs), action);
    } else {
      resumeMessages = buildActionResumeMessages(historyPairs, action);
    }
    const systemEvent = resumeMessages[resumeMessages.length - 1];
    // 续跑可再发起写工具（走确认），按执行类运行绑定该书写锁
    await runAgentCoordinated(resumeMessages, res, {
      conversationId: conv.id,
      sessionKey: agentSessionKey(conv.id),
      mode: 'execute',
      bookId: Number.isFinite(Number(action.bookId)) ? Number(action.bookId) : null,
      // S5-02 / R01：续跑同口径提供解析范围（续跑输入是系统事件，不会生成重读要求）
      readBookId: Number.isFinite(Number(action.bookId)) ? Number(action.bookId) : (conv.scope === 'book' ? Number(conv.book_id) : null),
      resumeActionId: action.id,
      requestId: req.body.request_id ? String(req.body.request_id).slice(0, 128) : runSvc.newRunId(),
      settledAction: { id: action.id, name: action.name, status: action.status },
      verifiedWrite: action.status === 'approved' && ['append_chapter', 'replace_chapter'].includes(action.name),
      onRunStart: (runId) => {
        conversationSvc.appendMessage({
          conversationId: conv.id, role: 'assistant', content: systemEvent.content, source: 'system', runId,
        });
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// S4-01b：供测试直接核对 Agent 快照预算与写作侧同源/可独立收窄（不影响路由挂载）
module.exports.agentSnapshotTokenBudget = agentSnapshotTokenBudget;
module.exports.SNAPSHOT_BUDGET_ENV = SNAPSHOT_BUDGET_ENV;
