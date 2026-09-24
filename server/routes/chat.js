const express = require('express');
const db = require('../db');
const {
  buildChatMessages, callLLMFull, consult, trimHistoryText,
  fetchChatCompletion, readChatSSEStream, REQUEST_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS, STREAM_FIRST_BYTE_TIMEOUT_MS,
} = require('../llm');
const { sanitizeLeakedToolMarkup } = require('../utils/sanitize');
const actionStore = require('../actionStore');
const bookTools = require('../bookTools');
const { executeTool, auditRejection } = require('../tools/executor');
const { toOpenAITools } = require('../tools/adapters/openai');
const toolRegistry = require('../tools/registry');
const { toolFact, serializeHistory } = require('../chat/tool-history');
const runPolicy = require('../chat/run-policy');
const { truncateToolResult, toolResultMessage, serializeToolError, toolErrorContent, looksLikeDanglingPromise, looksLikeWriteOutcomeClaim, looksLikeUnfulfilledWriteIntent, looksLikePendingActionAnnouncement, looksLikeSelfTruncationMarker, stripSelfTruncationMarker } = require('../tools/loop-helpers');
// M2：终局文本护栏（清洗泄漏标记 → 折叠上游重放；自造截断标记检测）——流式/非流式两条管线
// 共享同一实现，消除「防护只挂在一条路径上」的分叉（W2/W3）
const streamGuards = require('../chat/stream-guards');
const { sendDomainError } = require('../domain/errors');

const WRITING_SCHEMAS = toOpenAITools('writing');
// 工具规则：唯一来源是 bookTools.TOOL_GUIDE（工具清单与它同源，改一处即生效）。
// 2026-09-10 十章实测发现两处问题：
//   1) 本文件曾自带一份同名短版 TOOL_GUIDE，而 696d5cc 的联网规则改在 bookTools 那份上——
//      两份同名常量并存，生效的是短版，导致「上网 → 必须 web_search」的修复从未到达模型
//      （test/chat-markup-retry.test.js 断言的是 bookTools 那份，绿灯但测的不是生产路径）。
//   2) 缺「一次提交完整正文」与「禁止谎报已完成」两条：模型「先检索 → 再落笔」两步意图
//      在收尾轮被截断时，会把没提交的写入说成「已写入，章节ID：113」（实测，见
//      loop-helpers.looksLikeWriteOutcomeClaim）。
// 现在改为直接引用同一常量，仅追加写作聊天专属的稳定 ID 规则，消除漂移。
const TOOL_GUIDE = '\n【工具规则】人物更新必须使用稳定人物 ID；动态状态和关系通过事件提案表达。\n'
  + bookTools.TOOL_GUIDE;

// 长请求截断防护：写正文轮被 length 截断或网络提前结束时，回灌半截让模型无缝续写（最多 CONTINUATION_MAX 次）
const CONTINUATION_MAX = 2;
const CONTINUE_NUDGE = '（系统提示：上文因输出长度上限或连接中断被截断。请从截断处无缝续写，直接接着写正文——不要重复已写内容、不要重述前文、不要加标题或任何解释。）';

const router = express.Router({ mergeParams: true });

router.get('/:bookId/chat', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    // S3-03：列表核对 conversationId 属于该书且 kind=writing；未指定 → 该书 legacy 会话
    const conversationSvc = require('../conversations/service');
    const conv = conversationSvc.resolveWritingConversation(bookId, req.query.conversationId);
    const messages = db.all('SELECT id, role, content, reasoning, compressed, tools_json, source, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC', [conv.id]);
    // 工具事件随消息持久化（tools_json）：解析回传，前端刷新后可回看本轮工具卡
    for (const m of messages) {
      try {
        const tools = JSON.parse(m.tools_json || '[]');
        m.tools = Array.isArray(tools) ? tools.filter(tool => tool?.kind !== 'run') : [];
        m.run = Array.isArray(tools) ? tools.find(tool => tool?.kind === 'run')?.state || null : null;
      } catch { m.tools = []; }
      delete m.tools_json;
      // 契约 5：来源页字段（writing/read/agent/''/system），历史行默认空串
      m.source = m.source || '';
    }
    // 契约 1（F3）：未通知过的过期卡随会话返回（最多 5 条，按 created_at 升序）——作者刷新即可看到
    // 「这些操作已超时、从未执行」，而不是在界面里静默消失。
    const expiredActions = actionStore.listExpiredUnnotified(Number(bookId), 5).map(a => ({
      id: a.id,
      name: a.name,
      args: a.args,
      summary: a.summary,
      expiredAt: a.settledAt === undefined ? a.expiresAt : a.settledAt,
    }));
    // M9-A（F3 收口）：expiredActions 单批最多 5 条，超出部分前端看不到。附上溢出数
    // （同口径计数 - 本次返回的条数），前端据此提示「还有 N 个同样超时未执行」。
    const expiredActionsOverflow = Math.max(0, actionStore.countExpiredUnnotified(Number(bookId)) - expiredActions.length);
    res.json({ conversationId: conv.id, conversationStatus: conv.status, messages, expiredActions, expiredActionsOverflow });
  } catch (err) {
    next(err);
  }
});

// 上下文状态：供前端上下文仪表显示（占用/窗口/缓存命中/消息统计）——S3-03 起按会话统计
//（与实际发送口径同源，避免「仪表按书、发送按会话」两份历史）
router.get('/:bookId/context-status', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const conv = require('../conversations/service').resolveWritingConversation(bookId, req.query.conversationId);
    const stats = db.get(
      `SELECT
         SUM(CASE WHEN COALESCE(compressed,0) = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN COALESCE(compressed,0) = 1 THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN COALESCE(compressed,0) != 1 THEN LENGTH(content) ELSE 0 END) AS activeChars
       FROM messages WHERE conversation_id = ?`, [conv.id]);
    const { llmConfig, contextWindowInfo } = require('../llm');
    const cwi = contextWindowInfo(llmConfig().model);
    const contextWindow = cwi.effective;
    const ratio = getCompressionRatio();
    const lastUsage = lastUsageView(bookId);
    res.json({
      contextWindow,
      // 钳制透明化：手动设置超过渠道官方报告上限时，前端仪表需说明原因
      windowManual: cwi.manual,
      windowOfficial: cwi.official,
      officialSource: cwi.officialSource,
      officialFetchedAt: cwi.fetchedAt,
      clamped: cwi.clamped,
      note: cwi.note,
      lastUsage,
      lastBreakdown: breakdownView(llmCallLog.lastComposition(bookId)),
      compressionRatio: ratio,
      autoCompactAt: Math.floor(contextWindow * ratio),
      messages: {
        active: (stats && stats.active) || 0,
        archived: (stats && stats.archived) || 0,
        activeChars: (stats && stats.activeChars) || 0,
      },
      // 无真实 usage 时的兜底估算（chars/4，对齐 contextBudget；中文场景偏低，以 API usage 为准）
      estimatedPromptTokens: Math.ceil(((stats && stats.activeChars) || 0) / 4) + 2000,
    });
  } catch (err) {
    next(err);
  }
});

// 上下文组成明细：系统提示各节实际占用 + 对话历史/工具结果 + 输出预留 + 剩余，供前端「详细组成」面板
router.get('/:bookId/context-breakdown', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) return res.status(404).json({ error: '书籍不存在' });
    const conversationSvc = require('../conversations/service');
    const conv = conversationSvc.resolveWritingConversation(bookId, req.query.conversationId);
    const chapterId = Number(req.query.chapterId) > 0 ? Number(req.query.chapterId) : null;
    const { llmConfig, contextWindowInfo, outputTokenBudget, systemPromptTokenBudget } = require('../llm');
    const context = require('../context');
    const { estimateTokens } = require('../contextBudget');
    const cfg = llmConfig();
    const cwi = contextWindowInfo(cfg.model);

    // 系统提示：跑一遍与真实写作相同的组装管道（不调 LLM），取各节占用
    const lastUser = db.get('SELECT content FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [conv.id, 'user']);
    const assembled = await context.assembleDetailed({
      book, chapterId, db,
      query: (lastUser && lastUser.content) || '',
      systemTokenBudget: systemPromptTokenBudget(),
    });

    // 对话历史：必须与真实发送口径一致（A-13）。buildChatMessages 每次只发最近 HISTORY_LIMIT 条，
    // 且较早的长消息截断到 300 字；breakdown 若取全部活跃消息不截断，会严重高估 history。
    // 截断文本直接复用 llm.trimHistoryText（唯一口径来源），避免两处各写各的标记后再次漂移。
    const HISTORY_LIMIT = 12, RECENT_FULL = 4;
    const rows = db.all(
      'SELECT role, content FROM messages WHERE conversation_id = ? AND COALESCE(compressed,0) != 1 ORDER BY id DESC LIMIT ?',
      [conv.id, HISTORY_LIMIT]
    ).reverse(); // DESC 取最近 N 条后 reverse 成发送顺序（ASC），与 llm.js 一致
    let chatTokens = 0;
    let toolTokens = 0;
    rows.forEach((r, i) => {
      const isRecent = i >= rows.length - RECENT_FULL; // 最近 4 条保留全文
      const content = isRecent ? (r.content || '') : trimHistoryText(r.content || '');
      const t = estimateTokens(content);
      if (r.role === 'tool') toolTokens += t; else chatTokens += t;
    });

    const outputReserve = chatModelOptions(cfg.model).maxOutputTokens;
    const schemaEst = schemaTokens();
    const systemTotal = assembled.parts.reduce((s, p) => s + p.tokens, 0);
    const estimatedPrompt = systemTotal + chatTokens + toolTokens + schemaEst;
    // 最近一次真实请求的落库组成 + 校准系数（官方 usage 总量 ÷ 本地估算总量）：
    // 官方返回只报总量，本地逐层估算乘以系数即得「真实尺度」的分层细分
    const lb = breakdownView(llmCallLog.lastComposition(bookId));
    // 校准系数护栏（A-06）：factor = 官方 prompt 总量 ÷ 本地四桶估算和。
    // 护栏1 四桶完整：迁移 007 前的旧行没有 schema_tokens 列（默认 0），缺了工具定义这一桶会让
    //   localTotal 偏小、factor 爆表（实测旧行算出 13.59）。主请求恒带 schemaTokens()，故 schema>0
    //   是「这是完整新行」的可靠判据。
    // 护栏2 合理带：本地 estimateTokens 对中文偏低，官方÷本地通常略大于 1（实测 1.387）；超出
    //   [0.3,4.0] 说明该行组成不可信（旧行/异常），宁可不校准也不给面板喂荒谬系数。
    let calibration = null;
    if (lb && lb.promptTokens > 0 && lb.schema > 0) {
      const localTotal = lb.system + lb.history + lb.tool + lb.schema;
      const factor = localTotal > 0 ? lb.promptTokens / localTotal : 0;
      if (factor >= 0.3 && factor <= 4.0) {
        calibration = { promptTokens: lb.promptTokens, localTotal, factor };
      }
    }
    res.json({
      window: cwi.effective,
      windowManual: cwi.manual,
      windowOfficial: cwi.official,
      clamped: cwi.clamped,
      note: cwi.note,
      outputReserve,
      system: { total: systemTotal, budget: assembled.budget, parts: assembled.parts },
      history: { chatTokens, toolTokens, active: rows.length },
      schema: schemaEst,
      estimatedPrompt,
      free: Math.max(0, cwi.effective - estimatedPrompt - outputReserve),
      lastBreakdown: lb,
      calibration,
      recentCalls: llmCallLog.list(bookId, 12).map(usageView),
      officialSource: cwi.officialSource,
      officialFetchedAt: cwi.fetchedAt,
    });
  } catch (err) {
    next(err);
  }
});

// 上下文压缩：按 token 预算归档较早对话（默认目标 = 窗口×压缩率），LLM 摘要替代
// S3-03：压缩按会话（conversationId 校验属于该书且 kind=writing；未指定 → legacy 会话）
router.post('/:bookId/chat/compress', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const { targetTokens, conversationId } = req.body || {};
    const conv = require('../conversations/service').resolveWritingConversation(bookId, conversationId);
    const { llmConfig, resolveContextWindow } = require('../llm');
    const win = resolveContextWindow(llmConfig().model);
    const target = Number(targetTokens) > 0
      ? Math.floor(Number(targetTokens))
      : Math.floor(win * getCompressionRatio());

    const { compressConversation } = require('../conversations/compression');
    let result;
    try {
      result = await compressConversation({
        conversationId: conv.id,
        expectedLastMessageId: req.body && req.body.expectedLastMessageId,
        targetTokens: target,
      });
    } catch (e) {
      if (e.code === 'NOTHING_TO_COMPRESS') {
        return res.status(400).json({ error: '活跃对话太少或已低于预算，无需压缩', targetTokens: target });
      }
      throw e;
    }
    res.json({ ok: true, archived: result.coveredMessageIds.length, summary: result.summary, targetTokens: target,
      summaryId: result.summaryId, coveredMessageIds: result.coveredMessageIds, sourceFingerprint: result.sourceFingerprint });
  } catch (err) {
    next(err);
  }
});

// 还原压缩：恢复本会话已归档消息，删除本会话压缩存档
router.post('/:bookId/chat/compress/restore', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const { conversationId } = req.body || {};
    const conv = require('../conversations/service').resolveWritingConversation(bookId, conversationId);
    const restored = require('../conversations/compression').restoreConversation(conv.id);
    res.json({ ok: true, restored: restored.restored });
  } catch (err) {
    next(err);
  }
});

// ---------------- 工具循环核心 ----------------
// 模型在对话中可自主调用工具：
//   - 只读工具立即执行，结果回给模型继续推理
//   - 写工具不执行，生成待确认动作（前端弹确认卡，作者同意后才落地）
// hooks: { onTool({name,args,result}), onAction(action) } 用于把过程实时推给前端
// 对齐 pi agent-loop：错误也是喂给模型的粮食；参数解析失败不执行；后续轮不带工具 schema

// 调用台账落库（对齐 Codex CLI 会话 JSONL 的 token_count 事件）：每次模型调用一行 llm_calls，
// 重启不丢；仪表/组成面板/最近调用表统一读库，不再用内存态
const llmCallLog = require('../llmCallLog');

// 上游 usage → 台账字段
function usageFields(u) {
  return {
    promptTokens: u && u.prompt_tokens, completionTokens: u && u.completion_tokens,
    cacheHitTokens: u && u.prompt_cache_hit_tokens, cacheMissTokens: u && u.prompt_cache_miss_tokens,
    reasoningTokens: u && u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens,
  };
}

// 台账行 → 前端仪表兼容视图（字段名与原内存态保持一致）
function usageView(row) {
  if (!row) return null;
  return {
    prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens,
    cache_hit_tokens: row.cache_hit_tokens, cache_miss_tokens: row.cache_miss_tokens,
    reasoning_tokens: row.reasoning_tokens, finish_reason: row.finish_reason,
    scope: row.scope, model: row.model, status: row.status, duration_ms: row.duration_ms,
    at: row.created_at,
  };
}
function lastUsageView(bookId) { return usageView(llmCallLog.lastWithUsage(bookId)); }

// 台账行 → 组成面板视图
function breakdownView(row) {
  if (!row) return null;
  let parts = null;
  if (row.parts_json) { try { parts = JSON.parse(row.parts_json); } catch (e) { parts = null; } }
  return {
    system: row.system_tokens, history: row.history_tokens, tool: row.tool_tokens,
    schema: row.schema_tokens || 0,
    outputReserve: row.output_reserve, promptTokens: row.prompt_tokens || null,
    scope: row.scope, at: row.created_at, parts,
  };
}

// 本次请求组成估算（系统提示/历史/工具结果）：仅主请求行填写，供组成面板
function convoComposition(convo) {
  const { estimateTokens } = require('../contextBudget');
  let sysT = 0, histT = 0, toolT = 0;
  convo.forEach((m, i) => {
    const t = estimateTokens(m.content || '');
    if (i === 0) sysT = t; else if (m.role === 'tool') toolT += t; else histT += t;
  });
  return { sysT, histT, toolT };
}

// 组装层台账序列化：系统提示按 Provider 逐层组装，每层估算随调用落库（parts_json）
function partsJsonOf(parts) {
  return JSON.stringify((parts || []).map(p => ({ name: p.name, tokens: p.tokens, truncated: !!p.truncated })));
}

// 工具定义（schema）占用：上游 prompt_tokens 含 tools 定义，实测占空书请求的九成以上；
// 进程内常量，估算一次复用；不带工具的轮（续写/兜底）记 0
let _schemaTokens = null;
function schemaTokens() {
  if (_schemaTokens == null) {
    const { estimateTokens } = require('../contextBudget');
    _schemaTokens = estimateTokens(JSON.stringify(WRITING_SCHEMAS));
  }
  return _schemaTokens;
}

// 统一走 llm.js 韧性网关：自动重试传输抖动 + 超时；opts={ signal, timeoutMs }
// 返回原始 Response（非流式随后 res.json()，流式读 res.body）
async function postChat(baseUrl, apiKey, body, opts = {}) {
  return fetchChatCompletion({ baseUrl, apiKey, body, signal: opts.signal, timeoutMs: opts.timeoutMs });
}

// 读取上游 SSE 流（M2：接线 M1 的 llm.readChatSSEStream，SSE 解析/静默看门狗/终结校验唯一实现）。
// 该 helper 的契约是 pi 式「断流/停滞/中止一律抛错」，而本管线的恢复决策表是 premature 布尔
// 驱动（半截正文→续传；无半截→兜底/重生成）；在管线边界做一次适配：
//  - 自然结束却无 finish_reason（__prematureStream，可重试传输类）→ 降级为 premature=true，
//    与旧 readSseStream 行为逐位一致（是否升级为整轮重试见 M2 报告的决策记录）；
//  - 停滞（stream stalled）/ 传输中断 / 外部 abort（M3：断连经 runAbort 扇出）→ 抛错进 catch。
async function readStreamGuarded(res, onEvent, opts) {
  try {
    const r = await readChatSSEStream(res, onEvent, opts);
    return { finishReason: r.finishReason, usage: r.usage, premature: false };
  } catch (err) {
    if (err && err.__prematureStream) return { finishReason: '', usage: null, premature: true };
    throw err;
  }
}

// 非流式续写：把半截正文回灌为 assistant 消息 + 续写提示，无工具再请求，直到 stop 或达上限
// M3：signal 贯穿（aborted 时 postChat 起飞前即抛 __userAbort，交调用方 catch）
async function continueNonStream(bookId, convo, cfg, partial, signal = null, maxCont = CONTINUATION_MAX) {
  let content = partial || '';
  let reasoning = '';
  let usage = null;
  const maxOut = chatModelOptions(cfg.model).maxOutputTokens;
  for (let i = 0; i < maxCont; i++) {
    const contConvo = [...convo, { role: 'assistant', content }, { role: 'user', content: CONTINUE_NUDGE }];
    const t0 = Date.now();
    const res = await postChat(cfg.baseUrl, cfg.apiKey, {
      model: cfg.model, messages: contConvo, max_tokens: maxOut, temperature: 0.7,
    }, { signal });
    const data = await res.json();
    if (data.usage) usage = data.usage;
    const msg = data.choices?.[0]?.message || {};
    const finishReason = data.choices?.[0]?.finish_reason || '';
    llmCallLog.record({ bookId, scope: 'chat-continue', model: cfg.model, baseUrl: cfg.baseUrl, ...usageFields(data.usage), outputReserve: maxOut, finishReason, status: 'ok', durationMs: Date.now() - t0 });
    const added = msg.content || '';
    if (added) content += added;
    if (msg.reasoning_content) reasoning += (reasoning ? '\n' : '') + msg.reasoning_content;
    if (finishReason !== 'length' || !added.trim()) break; // 完成，或续写没吐出东西（防空转）
  }
  return { content, reasoning, usage };
}

// 流式续写：从半截正文无缝续写，新正文继续以 content 事件推送（前端天然追加），最多 CONTINUATION_MAX 次
// 返回 { content, usage }：usage 取最后一轮用量（prompt 最大、最贴近当前上下文），供调用方计入上下文仪表
// M3：signal 贯穿（断连即拆续写轮；aborted 时 postChat 起飞前即抛，catch 记台账后终止循环）
async function streamContinue(bookId, baseUrl, apiKey, model, convo, partial, send, signal = null, maxCont = CONTINUATION_MAX) {
  let content = partial || '';
  let lastUsage = null;
  const maxOut = chatModelOptions(model).maxOutputTokens;
  // S2-04：最后一轮是否仍截断（premature/length）——调用方据此归一 finishReason，
  // 供 normalizeFinish 区分「已补齐（stop）」与「补不齐（仍 length，半句=部分结果）」。
  let stillTruncated = true;
  for (let i = 0; i < maxCont; i++) {
    send({ type: 'recovering', reason: 'continue', round: i + 1 });
    const contConvo = [...convo, { role: 'assistant', content }, { role: 'user', content: CONTINUE_NUDGE }];
    let finishReason = '';
    let premature = true;
    let added = '';
    const t0 = Date.now();
    let roundUsage = null;
    try {
      const res = await postChat(baseUrl, apiKey, {
        model, messages: contConvo, max_tokens: maxOut, temperature: 0.7, stream: true,
        stream_options: { include_usage: true },
      }, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
      const r = await readStreamGuarded(res, (json, choice) => {
        const delta = choice.delta || {};
        if (delta.reasoning_content) send({ type: 'reasoning', text: delta.reasoning_content });
        if (delta.content) { added += delta.content; content += delta.content; send({ type: 'content', text: delta.content }); }
      }, { stallMs: STREAM_STALL_TIMEOUT_MS, signal });
      finishReason = r.finishReason;
      premature = r.premature;
      if (r.usage) { lastUsage = r.usage; roundUsage = r.usage; }
      llmCallLog.record({ bookId, scope: 'chat-stream-continue', model, baseUrl, ...usageFields(roundUsage), outputReserve: maxOut, finishReason: finishReason || (premature ? 'premature' : ''), status: 'ok', durationMs: Date.now() - t0 });
    } catch (e) {
      premature = true;
      llmCallLog.record({ bookId, scope: 'chat-stream-continue', model, baseUrl, outputReserve: maxOut, status: 'error', error: String((e && e.message) || e).slice(0, 300), durationMs: Date.now() - t0 });
    }
    stillTruncated = premature || finishReason === 'length';
    if (!stillTruncated || !added.trim()) break;
  }
  return { content, usage: lastUsage, stillTruncated };
}

// S2-05 / C11：模型选项单一权威构造器——输出预算与思考开关字段由同一函数决定
// （operation='chat'），写作网关与 Agent 两个入口共用；不再各写各的 max_tokens 口径。
function chatModelOptions(model, signal) {
  return require('../runtime/model-options').buildModelOptions({
    model, settings: {}, operation: 'chat', signal,
  });
}

// 单轮（一次用户请求内全部工具往返）工具结果累计字符上限：防多工具连环调用把上下文撑爆
// （单条截断口径与 truncateToolResult 已统一到 tools/loop-helpers，消除与 SDK 路径的分叉）
const TOOL_TURN_TOTAL_MAX_CHARS = runPolicy.DEFAULT_MAX_RESULT_CHARS;

// 写操作预检：id 类参数验证归属（错的当轮打回，模型可自查纠正）
// 2026-09-10 十章实测：此前只认驼峰 chapterId/volumeId，而 registry 里的原生工具用蛇形
// chapter_id（propose_story_event / correct_story_event / summarize_chapter 等）。
// 模型把章节序号（1）当成 chapter_id 提交时，预检看不见 → 挂成确认卡 → 作者点「同意」
// 才收到 CROSS_BOOK_REFERENCE「提案章节不属于当前书籍」。作者白白点一次，模型也拿不到
// 纠正机会。这里补蛇形键，并把 0/负数一并挡住（序号式误用最常见的就是小整数）。
const ID_ARG_KEYS = [
  { keys: ['chapterId', 'chapter_id'], label: 'chapterId', table: 'chapters' },
  { keys: ['volumeId', 'volume_id'], label: 'volumeId', table: 'volumes' },
];
function precheckWriteArgs(bookId, name, args) {
  for (const spec of ID_ARG_KEYS) {
    for (const key of spec.keys) {
      const value = args[key];
      if (value === undefined || value === null) continue;
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0 || !db.get(`SELECT id FROM ${spec.table} WHERE id = ? AND book_id = ?`, [id, bookId])) {
        // 提示区分「序号误用」与「他书 id」：前者按章序解释，后者按归属解释
        const hint = key.includes('_') && id > 0 && id < 1000
          ? `${spec.label} ${value} 不是本书的章节 id（看起来像章节序号）。请先用 list_chapters 取真实 id（形如 113），不要用第几章的数字。`
          : `${spec.label} ${value} 不属于本书`;
        return hint;
      }
    }
  }
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      if (!change || typeof change !== 'object') continue;
      if (change.change_kind === 'character_state' || change.change_kind === 'relation') {
        const ref = change.subject_ref;
        if (ref === undefined || ref === null) continue;
        if (!/^\d+$/.test(String(ref))) {
          return `changes.subject_ref 必须是人物数字 id（收到「${ref}」）。请先用 list_characters / find_characters 查 id。`;
        }
      }
    }
  }
  return null;
}

// 处理一轮返回的 tool_calls：执行只读 / 挂起写操作，拼出 assistant+tool 消息
// 一切失败（参数残缺/校验失败/执行异常）都转成 '[工具错误] …' 的 tool 消息——模型可见可纠正
// M3：signal 传入 toolContext（executor.normalizeContext 对齐 pi execute 契约：工具可取消）
async function settleToolCalls(bookId, assistantContent, toolCalls, hooks, signal = null) {
  const toolMsgs = [];
  if (typeof hooks._toolCharsUsed !== 'number') hooks._toolCharsUsed = 0;
  const toolContext = {
    profile: 'writing',
    sessionId: `writing:book:${Number(bookId)}`,
    bookId: Number(bookId),
    source: 'writing-chat',
    actor: 'author',
    settledAction: hooks._settledAction,
    signal: signal || null,
    // S2-02：确认卡创建时快照发起运行 id（中断恢复可关联展示）
    runId: hooks._runId || null,
    // S5-02 / R01：本运行的真实读取凭据/失败尝试由共享执行器写入（模型自报不产生凭据）
    readReceipts: Array.isArray(hooks._readReceipts) ? hooks._readReceipts : null,
    readAttempts: Array.isArray(hooks._readAttempts) ? hooks._readAttempts : null,
  };
  for (const tc of toolCalls) {
    const name = tc.function?.name || '';
    if (hooks._runState?.reason === 'action_rejected') {
      toolMsgs.push(toolResultMessage(tc.id, '[工具错误] ' + runPolicy.stateText(hooks._runState)));
      continue;
    }
    if (hooks._runState?.status === 'awaiting_confirmation') {
      toolMsgs.push(toolResultMessage(tc.id, '[工具错误] 等待前一操作确认，本工具未执行；确认后必须使用真实结果重新调用。'));
      continue;
    }
    // 单轮工具预算已耗尽：不再执行，直接回预算提示，模型据此基于已有信息收尾
    hooks._runBudget ||= runPolicy.createBudget();
    const stop = runPolicy.stopReason(hooks._runBudget, { aborted: signal?.aborted, resultChars: hooks._toolCharsUsed, checkSteps: false });
    if (stop) {
      hooks._runState = runPolicy.pausedState(stop, hooks._runBudget);
      toolMsgs.push(toolResultMessage(tc.id, '[工具错误] 本轮已暂停，工具未执行：' + stop));
      continue;
    }
    let args = null;
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = null; }

    if (args === null) {
      // pi 经验：截断的参数"可能 parse 成功但静默不完整"——解析失败宁可不执行
      toolMsgs.push(toolResultMessage(tc.id,
        '[工具错误] 参数 JSON 解析失败（可能被输出截断）。请修正参数后重试，或直接基于已有信息回答。'));
      continue;
    }

    // 工具执行前先告知前端（2026-09-13 「卡死」诊断）：读整章 / 建索引等工具是秒级黑盒，
    // 静默期里作者只看到界面不动。事件是纯提示，失败不影响执行（onToolStart 可选）。
    if (hooks.onToolStart) {
      try { hooks.onToolStart(name, args); } catch { /* 提示失败不影响工具执行 */ }
    }

    try {
      // S1-03：章节写工具的版本绑定（expected_revision 注入确认信封）已上收到统一执行器
      // executor.bindChapterRevision——写作页与独立 Agent 两入口同一份绑定逻辑，此处不再单独注入。
      // 写操作预检：id 类参数先验归属，错了当轮回给模型纠正（pi：错误即结果），不等作者点击时才报错。
      // 2026-09-10 实测：此前只看 bookTools.WRITE_TOOLS（7 个旧书工具），而 registry 的原生写工具
      // （propose_story_event / correct_story_event / propose_relation_change 等）走的是 descriptor，
      // 完全绕过预检——无效 chapter_id（模型常把章节序号当 id）会一路挂成确认卡，作者点「同意」才报
      // CROSS_BOOK_REFERENCE。改成按 descriptor 的 mutation 判定：只要不是只读就预检。
      const desc = toolRegistry.listAllTools().find(t => t.name === name);
      if (bookTools.WRITE_TOOLS.has(name) || (desc && desc.mutation !== 'read')) {
        const pre = precheckWriteArgs(Number(bookId), name, args);
        if (pre) {
          toolMsgs.push(toolResultMessage(tc.id, '[工具错误] ' + pre + '。请先用 list_chapters / list_characters 确认正确 id，或直接基于已有信息回答。'));
          continue;
        }
      }
      const result = await executeTool(toolContext, name, args, '', { toolCallId: tc.id });
      if (result && result.status === 'confirmation_required') {
        const actionEvent = { id: result.confirmation.id, name, args };
        // 本章已真的提交过一个待确认写动作 → 后续收尾轮里模型说「已提交」是实话，
        // 虚假完成声明检测据此放行（见 followUpRounds 的 chat-writeclaim-retry）
        hooks._writeActionSubmitted = true;
        hooks._runState = runPolicy.waitingState(name, result.confirmation.id, hooks._runBudget);
        // 章节内容写入：告知前端目标章节是否处于定稿态（决定是否显示「写入后自动重新定稿」勾选）
        if (name === 'append_chapter' || name === 'replace_chapter') {
          const chRow = db.get('SELECT locked FROM chapters WHERE id = ? AND book_id = ?', [args.chapterId, Number(bookId)]);
          actionEvent.chapterLocked = !!(chRow && chRow.locked);
        }
        if (hooks.onAction) hooks.onAction(actionEvent);
        toolMsgs.push(toolResultMessage(tc.id,
          JSON.stringify({ status: 'confirmation_required', confirmation_id: result.confirmation.id, notice: `写操作「${name}」已提交作者确认，等待作者点击同意后才生效。请基于当前已有信息继续回复。` })));
      } else {
        const content = truncateToolResult(result);
        hooks._toolCharsUsed += content.length;
        if (hooks.onTool) hooks.onTool({ name, args, result: content.slice(0, 800) });
        toolMsgs.push(toolResultMessage(tc.id, content));
      }
    } catch (e) {
      // 统一序列化：把 code/details 一并回灌模型（此前只回 e.message，丢失错误码与可纠正信息）
      if (e.code === 'ACTION_REJECTED') hooks._runState = runPolicy.pausedState('action_rejected', hooks._runBudget);
      toolMsgs.push(toolResultMessage(tc.id, toolErrorContent(serializeToolError(e, name))));
    }
  }
  hooks._toolFacts = hooks._toolFacts || [];
  for (const call of toolCalls) {
    const message = toolMsgs.find(item => item.tool_call_id === call.id);
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
    if (message) hooks._toolFacts.push(toolFact(call.function?.name || '', args, message.content));
  }
  const assistantHistoryMsg = {
    role: 'assistant',
    content: assistantContent || null,
    tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
  };
  return [assistantHistoryMsg, ...toolMsgs];
}

const FOLLOWUP_MAX_ROUNDS = runPolicy.DEFAULT_MAX_STEPS - 1;

// S5-02 / R01：明确重读的核验 + 最多一次有预算的纠正（写作页流式/非流式共用）。
// 要求（requiredReads）由服务器依据作者原话与写作定位生成；凭据（readReceipts）只由共享
// 执行器在真实读取成后写入。判定走 run-policy.verifyReads（与独立 Agent 同一函数）：
// 凭据必须命中目标章且 revision/正文哈希仍是当前版本。纠正轮沿用本运行预算与 abort 信号，
// 不新开循环、不无上限重发；仍未满足则定格 paused/read_not_verified（内容换成系统说明，
// 未核验的模型答复不得当成交付物）。
async function enforceFreshRead(bookId, convo, cfg, hooks, signal, requiredReads) {
  if (!Array.isArray(requiredReads) || !requiredReads.length) return null;
  if (hooks._runState && ['awaiting_confirmation', 'paused', 'failed', 'cancelled'].includes(hooks._runState.status)) return null;
  const verdictOf = () => runPolicy.verifyReads({
    requiredReads, readReceipts: hooks._readReceipts, readAttempts: hooks._readAttempts,
  });
  let verdict = verdictOf();
  let correctionText = '';
  if (!verdict.ok && !hooks._readCorrectionDone) {
    hooks._readCorrectionDone = true;
    hooks._runBudget ||= runPolicy.createBudget();
    const budgetReason = runPolicy.stopReason(hooks._runBudget, { aborted: signal?.aborted, resultChars: hooks._toolCharsUsed });
    const maxOut = chatModelOptions(cfg.model).maxOutputTokens;
    if (!budgetReason && !signal?.aborted) {
      const t0 = Date.now();
      try {
        hooks._runBudget.steps++;
        const response = await postChat(cfg.baseUrl, cfg.apiKey, {
          model: cfg.model,
          messages: [...convo, { role: 'user', content: runPolicy.freshReadNudge(requiredReads) }],
          max_tokens: maxOut, temperature: 0.7, tools: WRITING_SCHEMAS,
        }, { signal });
        const data = await response.json();
        const msg = data.choices?.[0]?.message || {};
        const finishReason = data.choices?.[0]?.finish_reason || '';
        llmCallLog.record({
          bookId, scope: 'chat-readverify-retry', model: cfg.model, baseUrl: cfg.baseUrl,
          ...usageFields(data.usage), outputReserve: maxOut, schemaTokens: schemaTokens(),
          finishReason, status: 'ok', durationMs: Date.now() - t0,
        });
        const calls = (msg.tool_calls || []).filter(tc => tc && tc.function && tc.function.name);
        if (calls.length && finishReason !== 'length') {
          // 截断轮的 tool_calls 参数可能残缺，一律不执行（与主循环同口径）
          const settled = await settleToolCalls(bookId, msg.content || '', calls, hooks, signal);
          convo.push(...settled);
          const tail = await runFollowUpRounds(bookId, convo, cfg, hooks, FOLLOWUP_MAX_ROUNDS, signal);
          correctionText = tail.content || sanitizeLeakedToolMarkup(msg.content || '').text || '';
        } else {
          correctionText = sanitizeLeakedToolMarkup(msg.content || '').text;
        }
      } catch (error) {
        try {
          llmCallLog.record({
            bookId, scope: 'chat-readverify-retry', model: cfg.model, baseUrl: cfg.baseUrl,
            status: 'error', error: String((error && error.message) || error).slice(0, 300), durationMs: Date.now() - t0,
          });
        } catch (_) { /* 台账失败不影响主流程 */ }
      }
      verdict = verdictOf();
    }
  }
  const receipts = (hooks._readReceipts || []).slice();
  if (verdict.ok) {
    hooks._runState = { ...(hooks._runState || { status: 'finished' }), requiredReads: verdict.required, readReceipts: receipts };
    return { ok: true, text: correctionText, verdict };
  }
  hooks._runState = {
    ...runPolicy.pausedState('read_not_verified', hooks._runBudget),
    readCode: verdict.code, requiredReads: verdict.required, readReceipts: receipts,
  };
  return { ok: false, text: '', code: verdict.code, verdict };
}

async function followUpRounds(bookId, convo, cfg, hooks, maxRounds = FOLLOWUP_MAX_ROUNDS, signal = null) {
  hooks._runBudget ||= runPolicy.createBudget({ maxSteps: maxRounds });
  if (hooks._runState?.status === 'awaiting_confirmation' || hooks._runState?.reason === 'action_rejected') return { content: runPolicy.stateText(hooks._runState), reasoning: '', usage: null };
  let result = { content: '', reasoning: '', usage: null };
  try {
    result = await runFollowUpRounds(bookId, convo, cfg, hooks, maxRounds, signal);
  } catch (error) {
    if (error.code !== 'RUN_PAUSED') throw error;
  }
  if (hooks._runState?.status === 'paused' || hooks._runState?.status === 'awaiting_confirmation') {
    result.content = runPolicy.stateText(hooks._runState);
  } else if (hooks._runState?.status !== 'cancelled') {
    hooks._runState = { status: 'finished', steps: hooks._runBudget.steps };
  }
  return result;
}

async function runFollowUpRounds(bookId, convo, cfg, hooks, maxRounds, signal) {
  const requestStep = async (...args) => {
    const reason = runPolicy.stopReason(hooks._runBudget, { aborted: signal?.aborted, resultChars: hooks._toolCharsUsed });
    if (reason) {
      hooks._runState = runPolicy.pausedState(reason, hooks._runBudget);
      throw Object.assign(new Error(reason), { code: 'RUN_PAUSED' });
    }
    hooks._runBudget.steps++;
    return postChat(...args);
  };
  const out = { content: '', reasoning: '', usage: null };
  const maxOut = chatModelOptions(cfg.model).maxOutputTokens;
  for (let round = 0; round < maxRounds; round++) {
    // M3：断连即停——signal 已 abort 时返回已累积产出，不再发起本轮及后续任何 LLM 调用
    const reason = runPolicy.stopReason(hooks._runBudget, { aborted: signal?.aborted, resultChars: hooks._toolCharsUsed });
    if (reason) {
      hooks._runState = runPolicy.pausedState(reason, hooks._runBudget);
      return out;
    }
    const allowTools = true;
    // 后续轮是非流式：整轮期间后端一句都不推给前端。2026-09-13 实测一轮写作最多 4 次调用、
    // 后续 3 轮合计静默 30~60 秒（书#18：首轮 25s 后还有 7s+18.6s+8.4s 完全无事件），
    // 作者观感就是「卡死」。每轮起飞前推一条阶段事件，前端据此显示「已等待 N 秒」。
    if (hooks.onPhase) {
      try { hooks.onPhase('followup-round', { round: round + 1, total: maxRounds }); } catch { /* 提示失败不影响生成 */ }
    }
    const t0 = Date.now();
    const res = await requestStep(cfg.baseUrl, cfg.apiKey, {
      model: cfg.model,
      messages: convo,
      max_tokens: maxOut,
      temperature: 0.7,
      ...(allowTools ? { tools: WRITING_SCHEMAS } : {}),
    }, { signal });
    const data = await res.json();
    if (data.usage) out.usage = data.usage;
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = msg.tool_calls || [];
    const finishReason = data.choices?.[0]?.finish_reason || '';
    llmCallLog.record({ bookId, scope: 'chat-followup', model: cfg.model, baseUrl: cfg.baseUrl, ...usageFields(data.usage), outputReserve: maxOut, schemaTokens: allowTools ? schemaTokens() : 0, finishReason, status: 'ok', durationMs: Date.now() - t0 });
    if (msg.content) out.content += (out.content ? '\n' : '') + msg.content;
    if (msg.reasoning_content) out.reasoning += (out.reasoning ? '\n' : '') + msg.reasoning_content;
    // pi 防护：截断轮的 tool_calls 不执行；无工具轮必须直接产出正文
    if (finishReason === 'length' && toolCalls.length) {
      hooks._runState = runPolicy.pausedState('output_truncated', hooks._runBudget);
      return out;
    }
    if (!toolCalls.length || finishReason === 'length') {
      // 写正文轮被 length 截断且已有正文 → 回灌半截无工具续写补齐（最多 CONTINUATION_MAX 次）
      if (finishReason === 'length' && out.content && out.content.trim()) {
        const cont = await continueNonStream(bookId, convo, cfg, out.content, signal);
        out.content = cont.content;
        if (cont.reasoning) out.reasoning += (out.reasoning ? '\n' : '') + cont.reasoning;
        if (cont.usage) out.usage = cont.usage;
      }
      // 无工具收尾轮的两类「假收尾」（2026-09-10 两次用户反馈，同一病根的两个变体）：
      //   a) GLM 系以 <tool_call> 文本标记表达调用意图 → C6 清洗后正文为空；
      //   b) 悬空承诺：答案已在思考里算完，正文却停在「让我查看/确认一下：」不再往下写
      //      （实测：reasoning 1026 字已推出「第3卷·第4章」，正文只有 42 字过渡语）。
      // 两者都表现为「思考一会儿然后卡住」。带明确指令重试一次：把半截正文作为
      // assistant 消息回灌（延续它的行文），只要求「接着写、别再宣告动作」。
      const sanitizedOut = sanitizeLeakedToolMarkup(out.content).text;
      // 空白正文（"\n\n" 这类只有换行的产出）与空串同义：模型什么也没说就收尾了。
      // 2026-09-10 实测：末轮 content="\n\n" finish=stop，既非空串（!sanitizedOut 为假）
      // 也不悬空（没有冒号/过渡语），旧判据两个分支都不进，作者收到一条空白回复。
      const blankOut = !sanitizedOut.trim();
      const dangling = looksLikeDanglingPromise(sanitizedOut);
      // 待办宣告（「现在我根据第1章…，创建这三个人物档案。」）：工具轮预算被读取耗尽后，
      // 收尾轮只剩一句「接下来要做 X」，而 X 从未发生——既非悬空承诺也非虚假完成声明，
      // 旧判据放行后作者收到一句空话（2026-09-10 十章实测建人物现场）。
      const pendingAction = looksLikePendingActionAnnouncement(sanitizedOut);
      if (out.content && (blankOut || dangling || pendingAction) && !hooks._markupRetryDone) {
        hooks._markupRetryDone = true;
        const t1 = Date.now();
        // 悬空且有未完成的**动作意图**时必须带工具重试（2026-09-10 十章实测）：
        // 作者要求「把陈默、老周、王教授建到人物中枢」，模型回「我先读取第1章正文，
        // 提取人物信息后再创建。」——它需要 create_character 才能完成，而无工具重试
        // 只能再吐一句过渡语（实测 retryText 仍是过渡语，被「只采纳更好的结果」丢弃，
        // 作者最终拿到的是那句空话）。判据：过渡语里点名了工具，或出现「建/创建/写入/
        // 更新/改/加/提交」这类需要落地到数据的动词，或带「后再…」的待办结构。
        // 纯问答型悬空（「让我看一下第几卷」）保持无工具，避免无谓的工具面开销。
        const NEEDS_TOOL_INTENT = /(create_character|update_character_profile|set_character_aliases|archive_character|create_chapter|append_chapter|replace_chapter|set_chapter_meta|add_worldview|propose_[a-z_]+|correct_story_event|update_volume|create_story_thread|update_story_thread|写工具|建档|建到|创建|新建|写入|提交|更新|添加|补上|改成|落库)/;
        // 空白正文无从判断意图（没内容可读），一律带工具重试——空回复本身已是失败态，
        // 且重试只有一次，带工具至少给模型真正完成任务的机会。
        // 待办宣告同理：它已经说清要做什么，带上工具让它真的做完。
        const retryWithTools = blankOut || pendingAction || NEEDS_TOOL_INTENT.test(sanitizedOut);
        try {
          const retryRes = await requestStep(cfg.baseUrl, cfg.apiKey, {
            model: cfg.model,
            messages: [
              ...convo,
              { role: 'assistant', content: out.content },
              {
                role: 'user',
                // 措辞注意：不说「本轮没有可用工具」（模型会把它写进回复，2026-09-10 实测
                // 用户收到「抱歉我没有联网搜索功能」）；只要求接着上文给出最终答复。
                // 需要工具的意图（建人物/写章节等）另给一版指令：允许它真的调用工具，
                // 但仍要求别再只回过渡语。
                content: retryWithTools
                  ? '（系统提示）不要再宣告下一步动作、不要说「让我查看/确认」；'
                    + '该做的事请直接调用对应工具完成（需要作者确认的会返回确认卡），'
                    + '完成后用一句话说明结果。不要输出任何工具调用标记文本。'
                  : '（系统提示）不要再宣告下一步动作、不要说「让我查看/确认」，检索已经完成；'
                    + '请直接接着上文，把给用户的最终答复完整写出来。不要输出任何工具调用标记。',
              },
            ],
            max_tokens: maxOut,
            temperature: 0.7,
            // 需要工具才能完成的意图必须带工具重试，否则模型只能再吐一句过渡语
            ...(retryWithTools ? { tools: WRITING_SCHEMAS } : {}),
          }, { signal });
          const retryData = await retryRes.json();
          if (retryData.usage) out.usage = retryData.usage;
          const retryMsg = retryData.choices?.[0]?.message || {};
          llmCallLog.record({
            bookId, scope: 'chat-followup-retry', model: cfg.model, baseUrl: cfg.baseUrl,
            ...usageFields(retryData.usage), outputReserve: maxOut,
            schemaTokens: retryWithTools ? schemaTokens() : 0,
            finishReason: retryData.choices?.[0]?.finish_reason || '', status: 'ok',
            durationMs: Date.now() - t1,
          });
          // 带工具的纠正轮：把工具调用真的结算掉（含写动作 → 确认卡），再取收尾话术
          const retryCalls = (retryMsg.tool_calls || []).filter(tc => tc && tc.function && tc.function.name);
          let retryText = sanitizeLeakedToolMarkup(retryMsg.content || '').text;
          if (retryWithTools && retryCalls.length && retryData.choices?.[0]?.finish_reason !== 'length') {
            const settledRetry = await settleToolCalls(bookId, retryMsg.content || '', retryCalls, hooks, signal);
            convo.push(...settledRetry);
            if (hooks._runState) return out;
            const tail = await runFollowUpRounds(bookId, convo, cfg, hooks, maxRounds, signal);
            out.content = tail.content;
            if (tail.reasoning) out.reasoning += tail.reasoning;
            if (tail.usage) out.usage = tail.usage;
            return out;
          }
          // 重试仍悬空/为空时保留原产出，只采纳更好的结果
          if (retryText && !looksLikeDanglingPromise(retryText)) {
            out.content = retryText;
            if (retryMsg.reasoning_content) out.reasoning += (out.reasoning ? '\n' : '') + retryMsg.reasoning_content;
          } else if (!out.content && retryText) {
            out.content = retryText;
          }
        } catch (retryErr) {
          try {
            llmCallLog.record({
              bookId, scope: 'chat-followup-retry', model: cfg.model, baseUrl: cfg.baseUrl,
              outputReserve: maxOut, status: 'error',
              error: String((retryErr && retryErr.message) || retryErr).slice(0, 300),
              durationMs: Date.now() - t1,
            });
          } catch (_) { /* 台账失败不影响主流程 */ }
        }
      }

      // 第三类「假收尾」：虚假完成声明与未兑现的写入意图（2026-09-10 十章实测，同一病根两个形态）。
      // 形态 a（谎称完成）：作者说「把刚才这一章写进第1章」，模型需要「先查目录 → 再落笔」两步，
      //   但最后一轮强制无工具收尾（allowTools=false），于是它把**没提交的写入**说成既成事实——
      //   「第1章《被粘回去的那一页》已写入，章节ID：113，字数约1800字」。实际 chapters.content
      //   为 0，tool_audit_logs 该轮只有只读记录，reasoning 里甚至写着「我刚刚通过 update_chapter
      //   调用了写入」——它幻觉了一个不存在的工具名。作者把「已保存」当真，离开页面即丢稿。
      // 形态 b（空头支票，第4章现场）：「第4章的chapterId是116，我直接用replace_chapter提交正文。」
      //   ——回复到此为止，没有工具调用、没有确认卡。句中无「已/成功」，也不在悬空承诺的动作词表
      //   （「我直接」不在 让我/我来/我先 之列），前两种判据都漏掉。
      // 悬空承诺检测（「让我确认一下：」）与空正文兜底同样覆盖不到，故统一在此处理：
      // 补一次**带工具**的纠正轮，让模型真正提交写工具，或明确改口说还没提交。
      // 有写动作已提交（hooks._writeActionSubmitted）时不触发——那时的「已提交」是实话。
      const claimText = sanitizeLeakedToolMarkup(out.content).text;
      const writeNotSubmitted = looksLikeWriteOutcomeClaim(claimText) || looksLikeUnfulfilledWriteIntent(claimText);
      if (writeNotSubmitted && !hooks._writeActionSubmitted && !hooks._writeClaimRetryDone) {
        hooks._writeClaimRetryDone = true;
        const t2 = Date.now();
        try {
          const fixRes = await requestStep(cfg.baseUrl, cfg.apiKey, {
            model: cfg.model,
            messages: [
              ...convo,
              { role: 'assistant', content: out.content },
              {
                role: 'user',
                // 措辞只描述要做什么，不声明能力缺失（否则模型会把「没有工具」复述给用户，2026-09-10 实测）
                content: '（系统提示）你上一条回复里说章节已经写入，但系统没有收到任何写入提交。'
                  + '请现在真正调用写工具（整章改写用 replace_chapter，续写用一次 append_chapter）把正文提交出来；'
                  + '如果这一步做不到，就直接告诉作者正文尚未提交、还差哪一步，不要再说「已写入」。',
              },
            ],
            max_tokens: maxOut,
            temperature: 0.7,
            tools: WRITING_SCHEMAS,
          }, { signal });
          const fixData = await fixRes.json();
          if (fixData.usage) out.usage = fixData.usage;
          const fixMsg = fixData.choices?.[0]?.message || {};
          const fixFinish = fixData.choices?.[0]?.finish_reason || '';
          llmCallLog.record({
            bookId, scope: 'chat-writeclaim-retry', model: cfg.model, baseUrl: cfg.baseUrl,
            ...usageFields(fixData.usage), outputReserve: maxOut, schemaTokens: schemaTokens(),
            finishReason: fixFinish, status: 'ok', durationMs: Date.now() - t2,
          });
          const fixCalls = (fixMsg.tool_calls || []).filter(tc => tc && tc.function && tc.function.name);
          let fixText = fixMsg.content || '';
          // 截断轮的 tool_calls 参数可能残缺，一律不执行（与主循环同口径）
          if (fixCalls.length && fixFinish !== 'length') {
            const settledFix = await settleToolCalls(bookId, fixMsg.content || '', fixCalls, hooks, signal);
            convo.push(...settledFix);
            if (hooks._runState) return out;
            const tail = await runFollowUpRounds(bookId, convo, cfg, hooks, maxRounds, signal);
            out.content = tail.content;
            if (tail.reasoning) out.reasoning += tail.reasoning;
            if (tail.usage) out.usage = tail.usage;
            return out;
          }
          const fixSanitized = sanitizeLeakedToolMarkup(fixText).text;
          // 只采纳更好的结果：改口后的说明必须不再是虚假完成声明
          if (fixSanitized && !looksLikeWriteOutcomeClaim(fixSanitized)) out.content = fixSanitized;
          if (fixMsg.reasoning_content) out.reasoning += (out.reasoning ? '\n' : '') + fixMsg.reasoning_content;
        } catch (fixErr) {
          // 纠正轮失败不能毁掉整轮：保留原产出（至少有正文在气泡里），失败入台账
          try {
            llmCallLog.record({
              bookId, scope: 'chat-writeclaim-retry', model: cfg.model, baseUrl: cfg.baseUrl,
              outputReserve: maxOut, status: 'error',
              error: String((fixErr && fixErr.message) || fixErr).slice(0, 300),
              durationMs: Date.now() - t2,
            });
          } catch (_) { /* 台账失败不影响主流程 */ }
        }
      }
      // 第四类「假收尾」：模型自己写下截断标记当收尾（2026-09-10 用户反馈「写到一半就停下来了」）。
      // 实测现场：正文末尾是「她发动汽车，然后……（较晚内容略）」——「较晚内容略」全仓库 grep 不到，
      // 是模型自造的收尾（模仿历史裁剪标记「……（较早内容略）」，该标记在同一次请求里出现了 2 次）。
      // finish_reason=stop（不是 length），所以上面所有 length/断流兜底都不触发；回复看着完整、
      // 实则正文断在半句上，且那一章一个字都没落库。
      // 处理：把标记摘掉，用**无工具**续写把剩下的正文补出来（与 length 续写同一套 continueNonStream，
      // 复用其「回灌半截 + 续写提示」的口径），补不动就保留原产出，至少不让作者看到假的「已完成」。
      // 本次同时把历史裁剪标记改成了机器样式（llm.trimHistoryText），消除模仿源；本判据是第二道防线。
      const selfTrunc = looksLikeSelfTruncationMarker(out.content);
      if (selfTrunc && !hooks._selfTruncationRetryDone) {
        hooks._selfTruncationRetryDone = true;
        const tSelf = Date.now();
        const cut = stripSelfTruncationMarker(out.content);
        if (cut) {
          try {
            // 续写轮自身的台账由 continueNonStream 记（scope=chat-continue），此处不重复记
            const cont = await continueNonStream(bookId, convo, cfg, cut, signal);
            // 只采纳更完整的产出：续写结果必须比原半截长，且自身结尾不再带截断标记
            if (cont.content && cont.content.length > cut.length && !looksLikeSelfTruncationMarker(cont.content)) {
              out.content = cont.content;
              if (cont.reasoning) out.reasoning += (out.reasoning ? '\n' : '') + cont.reasoning;
              if (cont.usage) out.usage = cont.usage;
            }
          } catch (contErr) {
            try {
              llmCallLog.record({
                bookId, scope: 'chat-selftrunc-continue', model: cfg.model, baseUrl: cfg.baseUrl,
                outputReserve: maxOut, status: 'error',
                error: String((contErr && contErr.message) || contErr).slice(0, 300),
                durationMs: Date.now() - tSelf,
              });
            } catch (_) { /* 台账失败不影响主流程 */ }
          }
        }
      }

      return out;
    }
    const settled = await settleToolCalls(bookId, msg.content || '', toolCalls, hooks, signal);
    convo.push(...settled);
    if (hooks._runState) return out;
  }
  hooks._runState = runPolicy.pausedState('step_budget', hooks._runBudget);
  return out;
}

// 给系统提示词追加工具使用说明（拼在 messages[0] 的 system 上）
function withToolGuide(messages) {
  if (messages.length && messages[0].role === 'system') {
    messages[0] = { ...messages[0], content: messages[0].content + TOOL_GUIDE };
  }
  return messages;
}

// ---------------- 上下文压缩 ----------------
// S3-04：压缩率与转录纯函数上收到 conversations/compression.js（全仓唯一实现），
// 写作页与 Agent 会话共用同一套摘要含义与保尾口径。
const { getCompressionRatio, buildCompressTranscript } = require('../conversations/compression');

async function compactBook(bookId, targetTokens, signal = null, conversationId = null) {
  // S3-04：委托统一压缩实现（四节摘要/保尾/事务同生同死/摘要版本记录）。
  // 未指定会话 = 书级兼容口径（该书 legacy 会话）；返回结构保持 { archived, summary }。
  const { compressConversation } = require('../conversations/compression');
  const conv = conversationId
    ? { id: conversationId }
    : require('../conversations/service').resolveWritingConversation(bookId, null);
  const result = await compressConversation({ conversationId: conv.id, targetTokens, signal });
  return { archived: result.coveredMessageIds.length, summary: result.summary };
}

router.post('/:bookId/chat', async (req, res, next) => {
  // S2-01：运行协调器句柄提升到 try 外——外层 catch 也要能落终态/释放锁
  const runSvc = require('../runtime/run-service');
  let writeScope = null;
  let runId = null;
  let finalizeRunOnce = () => {};
  try {
    const { bookId } = req.params;
    const { content, chapterId, source, conversationId } = req.body || {};
    // 契约 3/5（同流式口径）：来源页可选，落库用户/助手消息都写
    const reqSource = ['writing', 'read', 'agent'].includes(source) ? source : '';

    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required and must be non-empty' });
    }

    const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }
    // S3-03：会话解析（显式校验属于该书且 kind=writing；未指定 → legacy 会话）
    const conversationSvc = require('../conversations/service');
    const conv = conversationSvc.resolveWritingConversation(bookId, conversationId);
    if (conv.status !== 'active') {
      return res.status(409).json({ error: { code: 'CONVERSATION_ARCHIVED', message: '该写作会话已归档，请另开会话' } });
    }

    // S2-01：非流式入口接入同一运行协调器（此前完全无闸门，可与流式并发双写）。
    // 幂等/占位/释放语义与流式入口一致；终态在三个出口（成功/502/异常）落定。
    const requestId = (req.body && req.body.request_id) ? String(req.body.request_id).slice(0, 128) : runSvc.newRunId();
    const sessionKey = `writing:book:${Number(bookId)}`;
    const existingRun = runSvc.findRunByRequest(sessionKey, requestId);
    if (existingRun) {
      return res.status(runSvc.ACTIVE_STATUSES.includes(existingRun.status) ? 202 : 200)
        .json({ runId: existingRun.id, status: existingRun.status, duplicate: true, sessionKey });
    }
    writeScope = runSvc.bookWriteScope(Number(bookId));
    runId = runSvc.newRunId();
    if (!runSvc.acquireScopes([writeScope], runId).ok) {
      runId = null;
      return res.status(409).json({ error: { code: 'CHAT_BUSY', message: '上一条回复还在进行中，请稍候再发' } });
    }
    const raced = runSvc.findRunByRequest(sessionKey, requestId);
    if (raced) { runSvc.releaseScopes([writeScope], runId); runId = null; return res.status(202).json({ runId: raced.id, status: raced.status, duplicate: true, sessionKey }); }
    try {
      // S2-03：startRun 对 resume_action_id 唯一索引冲突返回 duplicate（不抛）——
      // 该确认动作已有续跑运行（含已终结的 cancelled/interrupted），必须短路返回既有运行，
      // 否则锁释放后的重发会双跑模型。
      const started = runSvc.startRun({ runId, requestId, sessionKey, conversationId: conv.id, entry: 'chat', bookId: Number(bookId), mode: 'write' });
      if (started && started.duplicate) {
        runSvc.releaseScopes([writeScope], runId);
        const dup = started.run;
        runId = null;
        return res.status(runSvc.ACTIVE_STATUSES.includes(dup.status) ? 202 : 200)
          .json({ runId: dup.id, status: dup.status, duplicate: true, sessionKey });
      }
    } catch (e) {
      runSvc.releaseScopes([writeScope], runId);
      runId = null;
      return res.status(e.status || 503).json({ error: { code: e.code || 'RUN_PERSIST_FAILED', message: e.message } });
    }
    let runFinalized = false;
    finalizeRunOnce = (status, reason) => {
      if (runFinalized) return;
      runFinalized = true;
      try { runSvc.finishRun(runId, { status, reason }); } catch (_) { /* 不阻断响应 */ }
    };

    const userContent = content.trim();

    // 先组装消息（此时新消息还未入库，buildChatMessages 会把它拼在末尾）——S3-03 起按会话取历史
    const { messages, retrieval, parts, writingTarget } = await buildChatMessages(book, userContent, chapterId || null, 12, conv.id);

    db.run(
      'INSERT INTO messages (book_id, conversation_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\',\'localtime\'))',
      [bookId, conv.id, 'user', userContent, reqSource]
    );
    // A15：记住刚插入的用户消息 id，LLM 失败时回删（对齐流式路径语义：失败不留下无回复的孤儿消息）
    const userMsgId = db.get('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]).id;

    const { llmConfig } = require('../llm');
    const cfg = llmConfig();
    const maxOut = chatModelOptions(cfg.model).maxOutputTokens;
    const convo = withToolGuide([...messages]);
    const comp = convoComposition(convo);
    const toolEvents = [];
    const actions = [];
    const hooks = {
      _runBudget: runPolicy.createBudget({ steps: 1 }),
      _runId: runId,
      // S5-02 / R01：本运行的真实读取凭据/失败尝试（共享执行器写入）
      _readReceipts: [],
      _readAttempts: [],
      onTool: (t) => toolEvents.push(t),
      onAction: (a) => actions.push(a),
    };

    let result = { content: '', reasoning: '' };
    // S2-04：主轮 finish_reason 贯通到终态裁决（length 补齐成功归一 stop，补不齐保留）
    let lastFinishReason = '';
    const t0 = Date.now();
    try {
      // 首轮：带工具非流式
      const res = await postChat(cfg.baseUrl, cfg.apiKey, {
        model: cfg.model,
        messages: convo,
        max_tokens: maxOut,
        temperature: 0.7,
        tools: WRITING_SCHEMAS,
      });
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      const toolCalls = msg.tool_calls || [];
      const finishReason = data.choices?.[0]?.finish_reason || '';
      lastFinishReason = finishReason;
      llmCallLog.record({ bookId, scope: 'chat', model: cfg.model, baseUrl: cfg.baseUrl, ...usageFields(data.usage), systemTokens: comp.sysT, historyTokens: comp.histT, toolTokens: comp.toolT, schemaTokens: schemaTokens(), outputReserve: maxOut, finishReason, status: 'ok', durationMs: Date.now() - t0, partsJson: partsJsonOf(parts) });

      // pi 防护：输出被截断（length）时 tool_calls 参数可能残缺，一律不执行
      if (finishReason === 'length') {
        if ((msg.content || '').trim()) {
          // 已有半截正文 → 回灌续写补齐
          const cont = await continueNonStream(bookId, convo, cfg, msg.content);
          result = { content: cont.content, reasoning: cont.reasoning || (msg.reasoning_content || '') };
          if (cont.content && cont.content.length > (msg.content || '').length) lastFinishReason = 'stop';
        } else {
          result = { content: '', reasoning: msg.reasoning_content || '' }; // 全被思考吃掉 → 交下方兜底重生成
        }
      } else if (toolCalls.length) {
        const settled = await settleToolCalls(bookId, msg.content || '', toolCalls, hooks);
        convo.push(...settled);
        const follow = await followUpRounds(bookId, convo, cfg, hooks);
        result = { content: (msg.content ? msg.content + '\n' : '') + follow.content, reasoning: follow.reasoning };
      } else {
        result = { content: msg.content || '', reasoning: msg.reasoning_content || '' };
      }

      // C6 清洗泄漏工具标记 + M2 终局护栏（与流式管线同一实现：清洗 → 折叠上游重复投递）；
      // 清洗/折叠后为空或悬空承诺 → 无工具重生成兜底一次
      result.content = streamGuards.finalTextGuards(result.content);
      // M2：自造截断标记终局二次防线（与流式同判据，chat/stream-guards.detectSelfTruncation）——
      // finish=stop 的截断不触发上方 length 续写，正文会静默断在半句上；摘掉标记后按
      // 「回灌半截 + 续写提示」补齐。失败不毁整轮（保留原产出，错误入台账，与判据组 C 同口径）。
      {
        const st = streamGuards.detectSelfTruncation(result.content);
        if (st.hit && st.cut) {
          const tSt = Date.now();
          try {
            const cont = await continueNonStream(bookId, convo, cfg, st.cut);
            // 只采纳更完整的产出：续写结果必须比原半截长，且自身结尾不再带截断标记
            const again = streamGuards.detectSelfTruncation(cont.content);
            if (cont.content && cont.content.length > st.cut.length && !again.hit) {
              result.content = cont.content;
              if (cont.reasoning) result.reasoning += (result.reasoning ? '\n' : '') + cont.reasoning;
              lastFinishReason = 'stop'; // 补齐成功：不再按截断收尾
            }
          } catch (contErr) {
            try {
              llmCallLog.record({
                bookId, scope: 'chat-selftrunc-continue', model: cfg.model, baseUrl: cfg.baseUrl,
                outputReserve: maxOut, status: 'error',
                error: String((contErr && contErr.message) || contErr).slice(0, 300),
                durationMs: Date.now() - tSt,
              });
            } catch (_) { /* 台账失败不影响主流程 */ }
          }
        }
      }
      if (!result.content || looksLikeDanglingPromise(result.content)) {
        // 兜底失败不能毁掉整轮（此前异常直通外层 catch → 502 + 删用户消息）：
        // 保底返回已有产出（可能就是那半截过渡语），失败入台账
        try {
          const regen = await callLLMFull(convo, { maxTokens: maxOut, temperature: 0.7, meta: { bookId, scope: 'chat-regen' } });
          const regenText = sanitizeLeakedToolMarkup(regen.content).text;
          // 重生成仍悬空时保留原产出，只采纳更完整的答复
          if (regenText && !looksLikeDanglingPromise(regenText)) {
            result = { content: regenText, reasoning: regen.reasoning || result.reasoning };
            lastFinishReason = 'stop'; // 重生成拿到了完整产出
          }
        } catch (regenErr) {
          try {
            llmCallLog.record({
              bookId, scope: 'chat-regen', model: cfg.model, baseUrl: cfg.baseUrl,
              outputReserve: maxOut, status: 'error',
              error: String((regenErr && regenErr.message) || regenErr).slice(0, 300),
              durationMs: Date.now() - t0,
            });
          } catch (_) { /* 台账失败不影响主流程 */ }
        }
      }
    } catch (err) {
      // A16：非流式失败也要落调用台账（此前只流式路径记，catch 直接 502，失败调用无迹可查）
      try {
        llmCallLog.record({ bookId, scope: 'chat', model: cfg.model, baseUrl: cfg.baseUrl, systemTokens: comp.sysT, historyTokens: comp.histT, toolTokens: comp.toolT, schemaTokens: schemaTokens(), outputReserve: maxOut, status: 'error', error: String((err && err.message) || err).slice(0, 300), durationMs: Date.now() - t0 });
      } catch (_) { /* 台账失败不影响主错误返回 */ }
      // A15：删除本次失败轮插入的用户消息，避免无回复消息污染后续 history 与上下文面板
      try { db.run('DELETE FROM messages WHERE id = ?', [userMsgId]); } catch (_) { /* 忽略 */ }
      finalizeRunOnce('failed', 'llm_error');
      runSvc.releaseScopes([writeScope], runId);
      return res.status(502).json({ error: err.message || 'LLM call failed' });
    }

    // S5-02 / R01：明确重读核验（服务器要求 × 本轮真实读取凭据；未满足最多一次有预算纠正）
    const readGuard = await enforceFreshRead(bookId, convo, cfg, hooks, null, writingTarget && writingTarget.requiredReads);
    if (readGuard && readGuard.text) result.content = readGuard.text;

    const finalized = runPolicy.finalizeText(result.content, hooks._runState);
    result.content = finalized.content;
    hooks._runState = finalized.state;
    // S2-04：终态统一裁决（与流式同一函数）——控制态定格保留，只复核即将判 finished 的事实
    {
      const norm = runPolicy.normalizeFinish({
        finishReason: lastFinishReason,
        emittedText: result.content,
        state: hooks._runState,
        hasPendingAction: actions.length > 0,
        readRequirement: readGuard && !readGuard.ok ? readGuard.verdict : null,
      });
      if (norm.status !== 'finished' && (!hooks._runState || hooks._runState.status === 'finished')) {
        hooks._runState = { ...hooks._runState, status: norm.status, reason: norm.reason };
      }
    }
    db.run(
      "INSERT INTO messages (book_id, conversation_id, role, content, reasoning, tools_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
      [bookId, conv.id, 'assistant', result.content, result.reasoning, serializeHistory(toolEvents, hooks, writingTarget), reqSource]
    );
    for (const a of actions) { try { runSvc.appendRunEvent(runId, { type: 'confirmation_required', payload: { id: a.id, name: a.name } }); } catch (_) {} }
    {
      const st = (hooks._runState && hooks._runState.status) || 'finished';
      finalizeRunOnce(runSvc.TERMINAL_STATUSES.includes(st) || st === 'awaiting_confirmation' ? st : 'finished', hooks._runState && hooks._runState.reason);
    }
    runSvc.releaseScopes([writeScope], runId);

    res.json({ reply: result.content, reasoning: result.reasoning, retrieval, tools: toolEvents, actions, run: hooks._runState, usage: lastUsageView(bookId) });
  } catch (err) {
    if (runId) { finalizeRunOnce('failed', 'internal_error'); runSvc.releaseScopes([writeScope], runId); }
    next(err);
  }
});

// 确认结果续跑信封（方向报告 1.4）：对齐独立 Agent buildActionResumeMessages 的
// [确认执行结果·系统事件] 语义——写作页作者点「同意」后，模型终于能看到真实执行
// 结果并继续原任务，而不是断点等作者重新组织指令。
function confirmResumeEventText(action) {
  const brief = action.result === undefined ? '' : JSON.stringify(action.result).slice(0, 1200);
  // F4（2026-09-11 真实库取证：作者拒绝 create_character 后模型立刻换参数再发起同类操作）：
  // rejected 分支文案强化为逐字禁令——不得以「换个参数表达」的方式重试，必须先向作者说明。
  const statusText = action.status === 'approved'
    ? '已执行成功'
    : action.status === 'rejected'
      ? '被作者拒绝（未做任何改动）。作者已明确拒绝该操作：不要再次发起相同或高度相似的操作（包括更换参数表达）；如需推进，请先用文字向作者说明理由并等待作者指示。'
      : '执行失败';
  return `[确认执行结果·系统事件]\n此前你请求执行的写工具 ${action.name}`
    + `（参数：${JSON.stringify(action.args || {}).slice(0, 400)}）${statusText}。`
    + (brief ? `\n执行结果：${brief}` : '')
    + '\n请基于该结果继续完成之前的任务；若已无后续动作，向作者简要汇报完成情况，不要重复执行已完成的操作。';
}

// 每本书同时只允许一条对话流在跑（对齐 pi：Agent.prompt 在 activeRun 期间直接抛错
// 「Use steer() or followUp() to queue messages」，由调用方改走队列）。
// 2026-09-11 实测的「乱」：前端无并发保护、后端也无——确认卡续跑与手输消息可同时发出，
// 两条流各跑一遍完整工具循环。证据：llm_calls 315/316 相隔 1.4 秒同时启动、317/318 同样重叠；
// 落库出现连续两条 assistant 消息（487/488 相隔 5 秒、491/492 相隔 2 秒，中间没有用户消息），
// 同一写动作被重复提交成 2 张 create_chapter、3 张 update_volume 同参确认卡。
// 前端收到 409 后把消息排队，待当前流结束再发（pi 的 followUp 语义）。
// S2-01（2026-09-21）：本入口私有 activeChatRuns 已由共享协调器取代（server/runtime/run-service.js
// 的 book:write:<id> scope，owner=runId、finally 释放）——写作页按书单飞语义原样迁入，
// Agent execute 模式与确认执行共用同一把写锁，不再有两把互不知情的锁。

// 流式对话：SSE 实时推送思考过程和正文；首轮带工具流式，命中工具后转非流式后续轮
// resumeActionId 模式（方向报告 1.4）：确认卡结算后把真实结果作为系统事件回灌对话
// 续跑（复用独立 Agent 已验证的机制），写作页确认不再是「写完就断」的死胡同。
router.post('/:bookId/chat/stream', async (req, res) => {
  const { bookId } = req.params;
  const { content, chapterId, resumeActionId, source, conversationId } = req.body || {};
  // 契约 3（2026-09-11 前端统一消费器）：来源页 'writing'|'read'|'agent'（可选）。
  // 契约 5：落库的用户/助手消息都写该 source；续跑信封消息写来源页 source，无则 'system'。
  const reqSource = ['writing', 'read', 'agent'].includes(source) ? source : '';

  let resumeAction = null;
  let userContent = String(content || '').trim();
  if (resumeActionId) {
    const action = actionStore.get(String(resumeActionId));
    if (!action || action.bookId !== Number(bookId)) {
      return res.status(404).json({ error: '确认动作不存在或已过期' });
    }
    if (action.status === 'interrupted') {
      return res.status(409).json({
        error: '该动作执行中断，结果不确定（可能已部分生效），不能续跑；请核对目标内容后重新发起',
        code: 'ACTION_REQUIRES_REVIEW',
      });
    }
    if (!['approved', 'rejected', 'failed'].includes(action.status)) {
      return res.status(409).json({ error: '动作尚未结算，无法续跑' });
    }
    if (action.resumeDone) {
      return res.status(409).json({ error: '该确认结果已续跑过' });
    }
    resumeAction = action;
    userContent = confirmResumeEventText(action);
  }
  if (!userContent) {
    return res.status(400).json({ error: 'content is required' });
  }
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  if (!book) return res.status(404).json({ error: '书籍不存在' });
  // S3-03：会话解析——续跑优先绑定「发起该动作的会话」（run 快照），显式带别的会话 403
  //（待确认动作留在原会话，不能切会话后在新会话偷偷续跑）；普通消息按显式指定校验，
  // 未指定 → 该书 legacy 会话（旧调用过渡）。
  const conversationSvc = require('../conversations/service');
  let streamConversationId = conversationId;
  if (resumeAction) {
    const actionRun = resumeAction.runId
      ? db.get('SELECT conversation_id FROM agent_runs WHERE id = ?', [String(resumeAction.runId)])
      : null;
    if (actionRun && actionRun.conversation_id) {
      if (conversationId && conversationId !== actionRun.conversation_id) {
        return res.status(403).json({ error: { code: 'CONFIRMATION_MISMATCH', message: '确认动作属于另一个写作会话，不能跨会话续跑' } });
      }
      streamConversationId = actionRun.conversation_id;
    }
  }
  let conv;
  try {
    conv = conversationSvc.resolveWritingConversation(bookId, streamConversationId);
  } catch (err) {
    return res.status(err.status || 404).json({ error: { code: err.code || 'CONVERSATION_NOT_FOUND', message: err.message } });
  }
  if (conv.status !== 'active') {
    return res.status(409).json({ error: { code: 'CONVERSATION_ARCHIVED', message: '该写作会话已归档，请另开会话' } });
  }
  // S2-01：统一运行记录 + 共享并发协调。幂等：同 session+requestId 的重试返回既有
  // 运行（202 运行中/待确认、200 已终结），不插消息、不调模型、不动锁；不同
  // requestId 忙时 409 CHAT_BUSY（前端排队语义不变）。占位落盘成功才继续调模型。
  const runSvc = require('../runtime/run-service');
  const requestId = (req.body && req.body.request_id) ? String(req.body.request_id).slice(0, 128) : runSvc.newRunId();
  const sessionKey = `writing:book:${Number(bookId)}`;
  const duplicateResponse = (existing) => res.status(runSvc.ACTIVE_STATUSES.includes(existing.status) ? 202 : 200)
    .json({ runId: existing.id, status: existing.status, duplicate: true, sessionKey });
  const existingRun = runSvc.findRunByRequest(sessionKey, requestId);
  if (existingRun) return duplicateResponse(existingRun);
  // 单飞闸门（必须在 writeHead 之前，才能以 JSON 回 409 让前端排队）
  const runKey = Number(bookId);
  const writeScope = runSvc.bookWriteScope(runKey);
  const runId = runSvc.newRunId();
  if (!runSvc.acquireScopes([writeScope], runId).ok) {
    return res.status(409).json({
      error: { code: 'CHAT_BUSY', message: '上一条回复还在进行中，请稍候再发' },
    });
  }
  // 竞态兜底：拿锁瞬间同 requestId 占位可能已落库 → 幂等返回既有运行并归还锁
  const raced = runSvc.findRunByRequest(sessionKey, requestId);
  if (raced) { runSvc.releaseScopes([writeScope], runId); return duplicateResponse(raced); }
  try {
    // S2-03：唯一索引冲突以 duplicate 返回（不抛）——短路返回既有续跑运行，防双跑
    const started = runSvc.startRun({
      runId, requestId, sessionKey, conversationId: conv.id, entry: 'chat', bookId: runKey, mode: 'write',
      resumeActionId: resumeActionId ? String(resumeActionId) : null,
    });
    if (started && started.duplicate) {
      runSvc.releaseScopes([writeScope], runId);
      return duplicateResponse(started.run);
    }
  } catch (e) {
    runSvc.releaseScopes([writeScope], runId);
    return res.status(e.status || 503).json({ error: { code: e.code || 'RUN_PERSIST_FAILED', message: e.message } });
  }
  // 终态只落一次：正常结束/报错先落真实终态，断连路径兜底 cancelled
  let runFinalized = false;
  const finalizeRunOnce = (status, reason) => {
    if (runFinalized) return;
    runFinalized = true;
    try { runSvc.finishRun(runId, { status, reason }); } catch (_) { /* 终态失败不阻断响应 */ }
  };
  // 释放闸门：正常结束、报错、客户端断连三种路径都要放开，否则该书永久卡死
  let runReleased = false;
  const releaseRun = () => {
    if (runReleased) return;
    runReleased = true;
    finalizeRunOnce('cancelled', 'client_disconnected');
    runSvc.releaseScopes([writeScope], runId);
  };
  res.on('close', releaseRun);
  const { llmConfig } = require('../llm');
  const { baseUrl, apiKey, model } = llmConfig();
  const maxOut = chatModelOptions(model).maxOutputTokens;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // S2-01：SSE 线上格式不变；adapter 把生命周期事件镜像进 run-service 的顺序事件表
  // （正文/reasoning 不进事件表——messages 才是正典存储；事件表供重复请求与事后回读）。
  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      if (obj && obj.type === 'phase') {
        runSvc.appendRunEvent(runId, obj.kind === 'tool'
          ? { type: 'tool_started', payload: { name: obj.name } }
          : { type: 'phase', payload: { kind: obj.kind, round: obj.round, total: obj.total } });
      } else if (obj && obj.type === 'tool') {
        runSvc.appendRunEvent(runId, { type: 'tool_result', payload: { name: obj.name, result: obj.result } });
      } else if (obj && obj.type === 'action') {
        runSvc.appendRunEvent(runId, { type: 'confirmation_required', payload: { id: obj.id, name: obj.name } });
      } else if (obj && obj.type === 'error') {
        runSvc.appendRunEvent(runId, { type: 'error', payload: { message: String(obj.error || '').slice(0, 200) } });
      }
    } catch (_) { /* 事件记录失败不影响流 */ }
  };

  // A5 + M3：客户端断连（关页/断网/取消）后不再继续烧 tokens，也不把用户没看到的回复入库。
  // 必须监听 res 的 close（而非 req：req 的 close 在请求体读完即触发，会误判）；
  // writableFinished 区分“正常结束”与“客户端中途放弃”。
  // M3：abort 收敛为**每轮运行单一 AbortController**（对齐 pi Agent.runWithLifecycle 的
  // activeRun 扇出）——断连触发 runAbort.abort()，贯穿首轮/兜底/续写/followUp 全部后续 LLM
  // 调用与工具执行（signal 经 fetchChatCompletion 桥接：重试 sleep 可中断、__userAbort 不重试）。
  // 此前 followUpRounds/streamContinue 的 postChat 不接 signal，只在阶段边界查 clientGone，
  // 断连后纠正轮/确认续跑的后续调用仍会跑完，token 空烧（W4）。
  let clientGone = false;
  const runAbort = new AbortController();
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    runAbort.abort(new Error('client disconnected'));
    // M3：台账记 abort 原因（复用现有 scope 体系，不加列/迁移）——只记中途放弃，正常结束不记
    try {
      llmCallLog.record({
        bookId, scope: 'chat-abort', model, baseUrl, status: 'error',
        error: '客户端断连：本轮运行已中止，后续 LLM 调用不再发出',
      });
    } catch (_) { /* 台账失败不影响主流程 */ }
  });
  // M3：入口防线——signal 已 abort（客户端在接线后、工作开展前断开；含确认续跑入口）则
  // 拒绝启动：不插用户消息、不调 LLM、释放闸门后直接结束
  if (runAbort.signal.aborted) { releaseRun(); return res.end(); }

  // M2：失败回滚（对齐非流式 A15 语义「失败不留下无回复的孤儿消息」）——回复尚未落库的
  // 失败轮（首轮/兜底/外层异常）回删本次插入的用户消息。断连（clientGone）不回滚：
  // 用户消息是真实发生的历史，且与既有断连路径（阶段边界直接 return，消息保留）保持一致；
  // 回滚只针对服务端失败（LLM 报错等，前端会收到 error 事件）。
  let userMsgId = null;
  let assistantSaved = false;
  const rollbackUserMessage = () => {
    if (assistantSaved || !userMsgId || clientGone) return;
    try { db.run('DELETE FROM messages WHERE id = ?', [userMsgId]); } catch (_) { /* 忽略 */ }
  };

  try {
    // 续跑重试幂等：上次续跑若在断连中途中断，事件行已插入但无回复——先删旧行再重建
    if (resumeAction && resumeAction.resumeMessageId) {
      try { db.run('DELETE FROM messages WHERE id = ?', [resumeAction.resumeMessageId]); } catch (_) { /* 忽略 */ }
    }
    // F3（2026-09-11 真实库取证：5 张卡 30 分钟 TTL 静默过期，其中「第三卷改名回常识修改」的
    // update_volume 从未执行，模型却把它当既定事实继续写作）：在闸门之后、上下文组装之前，
    // 把未通知过的过期卡作为 user 角色系统事件落到 messages 并立即 markExpiredNotified——
    // 该消息自然进入本轮 history（模型下一轮可见），同一批只通知一次。
    const unnotified = actionStore.listExpiredUnnotified(Number(bookId), 5);
    if (unnotified.length) {
      // M9-A（F3 收口）：本批之外还剩多少张过期未通知卡——必须在 markExpiredNotified 之前计数，
      // 否则标记完就永远算作 0。溢出 >0 时提示挂在最后一条通知尾部：模型知道「还有存量」，
      // 不会把「已提醒过 5 张」当成全部；剩余卡在后续对话批次里继续通知。
      const overflow = Math.max(0, actionStore.countExpiredUnnotified(Number(bookId)) - unnotified.length);
      let lastNoticeId = null;
      for (const expired of unnotified) {
        lastNoticeId = db.run(
          "INSERT INTO messages (book_id, conversation_id, role, content, source, created_at) VALUES (?, ?, 'user', ?, 'system', datetime('now','localtime'))",
          [bookId, conv.id, actionStore.expiredNoticeText(expired)]
        ).lastInsertRowid;
      }
      if (overflow > 0 && lastNoticeId != null) {
        db.run('UPDATE messages SET content = content || ? WHERE id = ?', [
          `\n（另有 ${overflow} 个操作同样超时未执行，将在后续对话中提醒。）`, lastNoticeId,
        ]);
      }
      actionStore.markExpiredNotified(unnotified.map(a => a.id));
    }
    const confirmedChapter = resumeAction?.status === 'approved'
      ? resumeAction.result?.chapter?.id || resumeAction.args?.chapterId || resumeAction.args?.chapter_id : null;
    const resumeChapter = confirmedChapter && db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [confirmedChapter, bookId]);
    const { messages, retrieval, parts, writingTarget } = await buildChatMessages(book, userContent, resumeChapter?.id || chapterId || null, 12, conv.id);
    userMsgId = db.run(
      // 契约 5：用户消息写来源页 source（续跑信封写来源页 source，无则 'system'）
      'INSERT INTO messages (book_id, conversation_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\',\'localtime\'))',
      [bookId, conv.id, 'user', userContent, resumeAction ? (reqSource || 'system') : reqSource]
    ).lastInsertRowid;
    if (resumeAction) {
      // 3.1 落库版：属性赋值不再持久化，走显式更新
      actionStore.setResumeMessage(resumeAction.id, userMsgId);
    }

    // 先把本次召回的旧文片段推给前端展示
    if (retrieval.length) send({ type: 'retrieval', hits: retrieval });

    const convo = withToolGuide([...messages]);
    const comp = convoComposition(convo);
    let actionCount = 0; // 待确认写动作数：>0 时本轮产出即确认卡，空正文不重生成
    const toolEvents = []; // 本轮工具事件：随助手消息落库（刷新后工具卡可回看）
    const hooks = {
      _settledAction: resumeAction,
      _runBudget: runPolicy.createBudget({ steps: 1 }),
      _runId: runId,
      // S5-02 / R01：本运行的真实读取凭据/失败尝试（共享执行器写入，模型自报不产生凭据）
      _readReceipts: [],
      _readAttempts: [],
      onTool: (t) => {
        send({ type: 'tool', name: t.name, args: t.args, result: t.result });
        toolEvents.push({ name: t.name, args: t.args, result: t.result });
      },
      onAction: (a) => { actionCount++; send({ type: 'action', id: a.id, name: a.name, args: a.args }); },
      // 阶段提示（2026-09-13）：后续轮是非流式的，整轮无事件可推；工具执行与每轮起飞各推一条，
      // 前端显示「已等待 N 秒」——静默期可见，作者才知道不是死机。纯提示，不影响任何控制流。
      onToolStart: (name) => send({ type: 'phase', kind: 'tool', name }),
      onPhase: (kind, info) => send({ type: 'phase', kind, round: info && info.round, total: info && info.total }),
    };

    // ---- 首轮：带工具流式（stall 守护 + 提前结束检测） ----
    let fullContent = '', fullReasoning = '';
    let toolCalls = []; // 按 index 累积 delta.tool_calls
    let finishReason = '';
    let upstreamOk = false;
    let firstPremature = false;
    let streamUsage = null;

    const tFirst = Date.now();
    try {
      const upstream = await postChat(baseUrl, apiKey, {
        model, messages: convo, max_tokens: maxOut, temperature: 0.7, stream: true,
        stream_options: { include_usage: true },
        tools: WRITING_SCHEMAS,
      }, { signal: runAbort.signal, timeoutMs: STREAM_FIRST_BYTE_TIMEOUT_MS }); // A16：流式首字节超时（已放宽至 3 分钟，照顾推理模型思考期）；M3：断连即拆
      upstreamOk = true;

      const r = await readStreamGuarded(upstream, (json, choice) => {
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          send({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          fullContent += delta.content;
          send({ type: 'content', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const dtc of delta.tool_calls) {
            const i = dtc.index ?? toolCalls.length;
            if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (dtc.id) toolCalls[i].id += dtc.id;
            if (dtc.function?.name) toolCalls[i].function.name += dtc.function.name;
            if (dtc.function?.arguments) toolCalls[i].function.arguments += dtc.function.arguments;
          }
        }
      }, { stallMs: STREAM_STALL_TIMEOUT_MS, signal: runAbort.signal });
      finishReason = r.finishReason;
      firstPremature = r.premature;
      if (r.usage) streamUsage = r.usage;
    } catch (err) {
      // 首轮建连/流中断：不盲目追加（避免重复）；据半截是否为空决定“续传”或“fresh 无工具兜底”
      upstreamOk = false;
      firstPremature = true;
    }
    // 首轮调用落库（含本次请求组成估算）；后续轮/续写/兜底各自单独成行
    llmCallLog.record({
      bookId, scope: 'chat-stream', model, baseUrl,
      ...usageFields(streamUsage),
      systemTokens: comp.sysT, historyTokens: comp.histT, toolTokens: comp.toolT, schemaTokens: schemaTokens(), outputReserve: maxOut,
      finishReason: finishReason || (firstPremature ? 'premature' : ''),
      status: upstreamOk ? 'ok' : 'error',
      error: upstreamOk ? '' : '首轮建连或流中断',
      durationMs: Date.now() - tFirst,
      partsJson: partsJsonOf(parts),
    });
    // 客户端已断连：停止后续轮/续写/入库，避免白烧 tokens 与污染历史
    if (clientGone) { releaseRun(); return res.end(); }

    // ---- 命中工具调用：结算并进入非流式后续轮（后续轮内含 length 续写） ----
    // pi 防护：finish_reason==='length'/提前结束时 tool_calls 参数可能残缺，一律不执行
    let wroteViaTools = false;
    if (upstreamOk && !firstPremature && finishReason !== 'length' && !clientGone
        && toolCalls.length) {
      const usable = toolCalls.filter(tc => tc && tc.function && tc.function.name);
      if (usable.length) {
        const settled = await settleToolCalls(book.id, fullContent, usable, hooks, runAbort.signal);
        convo.push(...settled);
        const follow = await followUpRounds(book.id, convo, { baseUrl, apiKey, model }, hooks, FOLLOWUP_MAX_ROUNDS, runAbort.signal);
        if (follow.usage) streamUsage = follow.usage;
        if (follow.content) {
          // 上线前先清洗泄漏的工具标记（2026-09-10 十章实测）：后续轮的 out.content 保留原始
          // 形态供上面的重试判据使用，但**推给前端的 content 事件必须是干净的**——实测该轮
          // 模型把整章正文包在 <tool_call><function=replace_chapter>… 里当文本吐出，
          // 1893 字符的标记块直接渲染进了作者的气泡（done/入库虽已清洗，但流式事件已发出去，
          // 前端没有二次清洗的机会）。
          const followText = sanitizeLeakedToolMarkup(follow.content).text;
          fullContent += (fullContent ? '\n' : '') + follow.content;
          if (followText) send({ type: 'content', text: followText });
        }
        fullReasoning += (fullReasoning && follow.reasoning ? '\n' : '') + (follow.reasoning || '');
        wroteViaTools = true; // 正文经后续轮产出，其 length 续写已在 followUpRounds 内处理
      }
    }

    // ---- 断流/截断续传（保住已写正文，不重复） ----
    if (!wroteViaTools && !clientGone) {
      const hasPartial = !!(fullContent && fullContent.trim());
      const truncated = (finishReason === 'length') || firstPremature;
      if (truncated && hasPartial) {
        // 已有半截正文 → 无工具流式续写（前端继续追加 content 事件，无缝）
        const contRes = await streamContinue(bookId, baseUrl, apiKey, model, convo, fullContent, send, runAbort.signal);
        fullContent = contRes.content;
        // S2-04：续写补齐 → 按 stop 收尾；补不齐 → 保留 length（normalizeFinish 落 paused/output_truncated）
        finishReason = contRes.stillTruncated ? 'length' : 'stop';
        if (contRes.usage) streamUsage = contRes.usage; // 续写轮 usage 计入仪表（取最后一轮）
      } else if (!upstreamOk && !hasPartial) {
        // 建连即失败且无半截 → fresh 无工具流式兜底（保持既有降级语义；fetch 已经过网关重试）
        send({ type: 'tool_fallback' });
        const tFb = Date.now();
        try {
          const plain = await postChat(baseUrl, apiKey, {
            model, messages, max_tokens: maxOut, temperature: 0.7, stream: true,
            stream_options: { include_usage: true },
          }, { signal: runAbort.signal, timeoutMs: STREAM_FIRST_BYTE_TIMEOUT_MS }); // A16：流式首字节超时（已放宽至 3 分钟，照顾推理模型思考期）；M3：断连即拆
          const r = await readStreamGuarded(plain, (json, choice) => {
            const delta = choice.delta || {};
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              send({ type: 'reasoning', text: delta.reasoning_content });
            }
            if (delta.content) {
              fullContent += delta.content;
              send({ type: 'content', text: delta.content });
            }
          }, { stallMs: STREAM_STALL_TIMEOUT_MS, signal: runAbort.signal });
          if (r.usage) streamUsage = r.usage;
          llmCallLog.record({ bookId, scope: 'chat-stream-fallback', model, baseUrl, ...usageFields(r.usage), outputReserve: maxOut, finishReason: r.finishReason || (r.premature ? 'premature' : ''), status: 'ok', durationMs: Date.now() - tFb });
          // 兜底自身也可能 length/提前结束 → 再续传
          if ((r.premature || r.finishReason === 'length') && fullContent.trim()) {
            const contRes2 = await streamContinue(bookId, baseUrl, apiKey, model, convo, fullContent, send, runAbort.signal);
            fullContent = contRes2.content;
            finishReason = contRes2.stillTruncated ? 'length' : 'stop';
            if (contRes2.usage) streamUsage = contRes2.usage;
          }
        } catch (err2) {
          llmCallLog.record({ bookId, scope: 'chat-stream-fallback', model, baseUrl, status: 'error', error: String((err2 && err2.message) || err2).slice(0, 300), durationMs: Date.now() - tFb });
          send({ type: 'error', error: err2.message || 'LLM 请求失败' });
          rollbackUserMessage(); // M2：整轮失败（首轮+兜底都失败）→ 回滚用户消息
          finalizeRunOnce('failed', 'llm_error'); // S2-01：显式落失败终态（不等 close 兜底误判成断连取消）
          releaseRun();
          return res.end();
        }
      }
    }

    // ---- C6 清洗泄漏工具标记与上游重复投递；清洗后为空或悬空承诺且无待确认写动作 → 无工具重生成兜底 ----
    // （只读工具轮若把正文全泄漏成标记被清空，或停在「让我确认一下：」不往下写，应重生成救回；
    //   写动作轮的产出是确认卡，不重生成）
    // M2：终局护栏收敛到 chat/stream-guards（清洗 → 折叠上游重放），非流式管线调用同一实现。
    // 折叠判据极窄（全文恰由 N 段逐字节相同的长文本拼成），背景见 2026-09-10 实测：
    // agnes 聚合渠道把同一段 3204 字正文原样吐两遍，温度 0.7 不可能逐字节重复三千字，判定通道重放。
    fullContent = streamGuards.finalTextGuards(fullContent);
    // 模型自造截断标记（判据详见 loop-helpers.looksLikeSelfTruncationMarker）：finish=stop 时
    // 上面所有 length/断流续写都不会触发，正文会静静地断在半句上。M2：检测/摘除抽到共享模块
    // （detectSelfTruncation），非流式管线同判据；摘掉标记后按同一套「回灌半截 + 续写提示」
    // 补齐，续写事件先推给前端，作者能看到「正在无缝续写」的提示。
    {
      const st = streamGuards.detectSelfTruncation(fullContent);
      if (st.hit && st.cut && !clientGone) {
        const contRes = await streamContinue(bookId, baseUrl, apiKey, model, convo, st.cut, send, runAbort.signal);
        // 只采纳更完整的产出，且续写结果自身结尾不得再带截断标记（否则等于没补）
        const again = streamGuards.detectSelfTruncation(contRes.content);
        if (contRes.content && contRes.content.length > st.cut.length && !again.hit) {
          fullContent = contRes.content;
          finishReason = contRes.stillTruncated ? 'length' : 'stop';
          if (contRes.usage) streamUsage = contRes.usage;
        }
      }
    }
    if ((!fullContent || looksLikeDanglingPromise(fullContent)) && !actionCount && !clientGone) {
      try {
        const regen = await callLLMFull(convo, { maxTokens: maxOut, temperature: 0.7, signal: runAbort.signal, meta: { bookId, scope: 'chat-regen' } });
        const regenText = sanitizeLeakedToolMarkup(regen.content).text;
        // 重生成仍悬空时保留原产出（有过渡语也好过空白），只采纳更完整的答复
        if (regenText && !looksLikeDanglingPromise(regenText)) {
          fullContent = regenText;
          if (regen.reasoning) fullReasoning = regen.reasoning;
          finishReason = 'stop'; // 重生成拿到了完整产出
          send({ type: 'content', text: fullContent });
        }
      } catch { /* 落空则下方按无正文处理 */ }
    }

    // S5-02 / R01：明确重读核验（服务器要求 × 本轮真实读取凭据；未满足最多一次有预算纠正）
    const readGuard = clientGone ? null
      : await enforceFreshRead(book.id, convo, { baseUrl, apiKey, model }, hooks, runAbort.signal, writingTarget && writingTarget.requiredReads);
    if (readGuard && readGuard.text) fullContent = readGuard.text;

    const finalized = runPolicy.finalizeText(fullContent, hooks._runState, { settledAction: resumeAction, verifiedWrite: resumeAction?.status === 'approved' && ['append_chapter', 'replace_chapter'].includes(resumeAction.name) });
    fullContent = finalized.content;
    hooks._runState = finalized.state;
    // S2-04：终态统一裁决——控制态定格（待确认/暂停/失败/取消）原样保留，只复核
    // 「即将判 finished」的事实：补不齐的截断（半句=部分结果）、空输出不谎称完成。
    {
      const norm = runPolicy.normalizeFinish({
        finishReason,
        emittedText: fullContent,
        state: hooks._runState,
        hasPendingAction: actionCount > 0,
        verifiedWrite: resumeAction?.status === 'approved' && ['append_chapter', 'replace_chapter'].includes(resumeAction.name),
        readRequirement: readGuard && !readGuard.ok ? readGuard.verdict : null,
      });
      if (norm.status !== 'finished' && (!hooks._runState || hooks._runState.status === 'finished')) {
        hooks._runState = { ...hooks._runState, status: norm.status, reason: norm.reason };
      }
    }
    if (fullContent && !clientGone) {
      db.run(
        "INSERT INTO messages (book_id, conversation_id, role, content, reasoning, tools_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
        [bookId, conv.id, 'assistant', fullContent, fullReasoning, serializeHistory(toolEvents, hooks, writingTarget), reqSource]
      );
      assistantSaved = true; // M2：回复已落库，此后失败不再回滚用户消息
      // 确认续跑完成（回复已入库）→ 标记一次性，防重复续跑（3.1 落库版走显式更新）
      if (resumeAction) actionStore.markResumeDone(resumeAction.id);
    }
    // ---- 自动压缩：真实占用达到 窗口×压缩率 时触发（压缩到阈值以下，事件先于 done 推送） ----
    // 组成估算与 usage 已随调用落库（llm_calls），此处直接读库
    const usageNow = lastUsageView(bookId);
    if (!clientGone && usageNow && usageNow.prompt_tokens > 0) {
      const { resolveContextWindow } = require('../llm');
      const win = resolveContextWindow(model);
      const ratio = getCompressionRatio();
      if (usageNow.prompt_tokens >= win * ratio) {
        try {
          // S3-04：统一压缩实现；发起压缩的运行就是当前运行自身（消息不再变），豁免活跃检查
          const compacted = await require('../conversations/compression').compressConversation({
            conversationId: conv.id, targetTokens: Math.floor(win * ratio * 0.8), signal: runAbort.signal, excludeRunId: runId,
          });
          if (compacted.coveredMessageIds.length) send({ type: 'auto_compact', archived: compacted.coveredMessageIds.length });
        } catch (e) {
          console.error('[auto_compact] 失败:', e.message);
        }
      }
    }

    if (!clientGone) send({ type: 'done', content: fullContent, reasoning: fullReasoning, run: hooks._runState, usage: lastUsageView(bookId) });
    {
      // S2-01：终态映射——run-policy 的状态即运行终态（awaiting_confirmation 表示
      // 停在待确认，action 结算后的续跑是关联它的新运行，本运行不再改写）
      const st = (hooks._runState && hooks._runState.status) || 'finished';
      finalizeRunOnce(runSvc.TERMINAL_STATUSES.includes(st) || st === 'awaiting_confirmation' ? st : 'finished',
        hooks._runState && hooks._runState.reason);
    }
    releaseRun();
    res.end();
  } catch (err) {
    send({ type: 'error', error: err.message || 'stream failed' });
    rollbackUserMessage(); // M2：外层异常且回复未落库 → 回滚用户消息（与 A15 非流式语义对齐）
    finalizeRunOnce('failed', 'stream_error');
    releaseRun();
    res.end();
  }
});

// 待确认写动作列表（2026-09-10 十章实测）：此前确认卡只活在 SSE 事件与当前页面 DOM 里，
// 作者刷新后卡消失，而动作仍 pending 到 30 分钟 TTL 过期——模型会继续说「已提交等待确认」，
// 作者却找不到确认入口。前端加载会话时用本接口重建未结算的卡。
// 契约 2（2026-09-11，F5a）：改为返回 `{ actions, expiredUnnotified }`——actions 是该书**全部状态**
// 动作（含已结算/已取代/已过期），前端据此重建已结算卡与「已被取代」卡；expiredUnnotified 是
// 未通知过的过期卡（与契约 1 的 expiredActions 同口径）。
router.get('/:bookId/chat/actions', async (req, res, next) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      return res.status(404).json({ error: '书籍不存在' });
    }
    const expiredItem = a => ({
      id: a.id, name: a.name, args: a.args, summary: a.summary,
      expiredAt: a.settledAt === undefined ? a.expiresAt : a.settledAt,
    });
    const actions = actionStore.listAll(bookId, 100).map(a => {
      const item = {
        id: a.id, name: a.name, args: a.args, summary: a.summary, impact: a.impact,
        status: a.status, createdAt: a.createdAt, expiresAt: a.expiresAt,
        settledAt: a.settledAt === undefined ? null : a.settledAt,
        result: a.result === undefined ? null : a.result,
        supersededBy: a.supersededBy,
      };
      // 与 SSE 的 action 事件同口径：章节正文写入需带上目标章是否已定稿，
      // 前端据此决定要不要显示「写入后自动重新定稿」勾选
      if (a.name === 'append_chapter' || a.name === 'replace_chapter') {
        const chRow = db.get('SELECT locked FROM chapters WHERE id = ? AND book_id = ?', [a.args.chapterId, bookId]);
        item.chapterLocked = !!(chRow && chRow.locked);
      }
      return item;
    });
    const expiredUnnotified = actionStore.listExpiredUnnotified(bookId, 5).map(expiredItem);
    res.json({ actions, expiredUnnotified });
  } catch (err) {
    next(err);
  }
});

// 写动作确认：作者在前端点击「同意/拒绝」后调用
router.post('/:bookId/chat-actions/:actionId/confirm', async (req, res) => {
  try {
    const { bookId, actionId } = req.params;
    const { approve, relock } = req.body || {};
    const action = actionStore.get(actionId);
    if (!action || action.bookId !== Number(bookId)) {
      return res.status(404).json({ error: '动作不存在或已过期' });
    }
    // F2：被更新的同类请求取代的卡不得执行——409 + 可读消息（与 INVALID_CONFIRMATION 同层级处理）
    if (action.status === 'superseded') {
      return res.status(409).json({
        error: '该操作已被更新的同类请求取代，请确认最新那张卡',
        code: 'CONFIRMATION_SUPERSEDED',
        status: action.status,
        supersededBy: action.supersededBy || null,
      });
    }
    // S2-02 / C07：interrupted 结果不确定（领域变更可能已部分生效）——明确拒绝重放，
    // 要求作者核对目标内容后重新发起（新卡、新确认）
    if (action.status === 'interrupted') {
      return res.status(409).json({
        error: '执行中断，可能已部分生效；请核对目标章节/实体当前内容后重新发起请求',
        code: 'ACTION_REQUIRES_REVIEW',
        status: action.status,
      });
    }
    // S2-02 注入点③：结算已落盘、响应未送达（网络断/进程崩）——客户端重发同一次确认时
    // 幂等返回同一已结算结果，而不是 409「已结算」让作者误以为失败；也不再执行业务。
    if (action.status === 'approved' || action.status === 'failed') {
      const r = action.result && typeof action.result === 'object' ? action.result : {};
      return res.json(action.status === 'approved'
        ? { ok: true, status: 'approved', result: action.result, replayed: true }
        : { ok: false, status: 'failed', error: { message: r.error || '执行失败', code: r.code || '' }, result: action.result, replayed: true });
    }
    if (action.status === 'rejected') {
      return res.json({ ok: true, status: 'rejected', replayed: true });
    }
    if (action.status !== 'pending') {
      return res.status(409).json({ error: action.status === 'executing' ? '该操作正在执行中' : '该动作已结算', status: action.status });
    }
    if (!approve) {
      const rejected = actionStore.reject(actionId, action.sessionId);
      // M9-A：拒绝也要写审计（与助手页 routes/agent.js 同口径）——此前写作页拒绝只改状态，
      // tool_audit_logs 里 create_chapter/create_character 只有 requested 行、没有 rejected 行，
      // 事后无法区分「作者拒绝」与「一直没点」。拒绝不执行工具，只记录作者决定（confirmed_by=author）
      // 与原始发起方（requested_by 取创建时固化的来源）。
      if (rejected.ok) auditRejection(action, action.sessionId);
      return res.json({ ok: true, status: 'rejected' });
    }
    const result = await executeTool({
      profile: 'writing',
      sessionId: action.sessionId,
      bookId: Number(bookId),
      source: 'writing-chat-confirm',
      actor: 'author',
    }, action.name, action.args, actionId);
    // 作者勾选「写入后自动重新定稿」：写入成功后立刻重定稿并重建语义索引
    let relocked = null;
    if (relock === true && ['append_chapter', 'replace_chapter'].includes(action.name)) {
      try {
        relocked = require('../domain/chapterLifecycle').relockChapter(Number(bookId), action.args.chapterId);
      } catch (e) {
        return res.status(400).json({ error: '写入成功，但重新定稿失败：' + e.message, result });
      }
    }
    res.json({ ok: true, status: 'approved', result, relocked });
  } catch (err) {
    // F2：executor.authorize 对被取代卡返回 CONFIRMATION_SUPERSEDED，经 DomainError 的 details.reason
    // 上抛——在此映射为 409 + 可读消息（与既有 INVALID_CONFIRMATION 同一处理层级）。
    if (err && err.code === 'INVALID_CONFIRMATION' && err.details && err.details.reason === 'CONFIRMATION_SUPERSEDED') {
      return res.status(409).json({
        error: '该操作已被更新的同类请求取代，请确认最新那张卡',
        code: 'CONFIRMATION_SUPERSEDED',
      });
    }
    // 领域错误按 code/status 精确回传（如 CHAPTER_NOT_FOUND→404），其余降级 500
    if (sendDomainError(res, err)) return;
    res.status(500).json({ error: err.message || 'confirm failed' });
  }
});

// 参谋模式：剧情走向/人物行为建议（不入库，避免污染写作上下文）
router.post('/:bookId/consult', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const { question, chapterId } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question 不能为空' });
    }
    const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) return res.status(404).json({ error: '书籍不存在' });

    try {
      const result = await consult(book, question.trim(), chapterId || null);
      res.json({ reply: result.content, reasoning: result.reasoning, retrieval: result.retrieval || [] });
    } catch (err) {
      res.status(502).json({ error: err.message || 'LLM call failed' });
    }
  } catch (err) {
    next(err);
  }
});

// S3-03：清空按会话（默认 legacy）——不动同书其他写作会话与 agent 会话的历史
router.delete('/:bookId/chat', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const conv = require('../conversations/service').resolveWritingConversation(bookId, req.query.conversationId);
    db.run('DELETE FROM messages WHERE conversation_id = ?', [conv.id]);
    res.json({ ok: true, conversationId: conv.id });
  } catch (err) {
    next(err);
  }
});

// 导出 compactBook 供测试（A12 事务原子性验证）；buildCompressTranscript 供压缩输入保尾单测；
// followUpRounds 供 M3 abort 前置检查单测（不触发任何 LLM 调用的路径）
router.compactBook = compactBook;
router.buildCompressTranscript = buildCompressTranscript;
router.followUpRounds = followUpRounds;
module.exports = router;
