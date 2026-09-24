const crypto = require('crypto');
const db = require('../db');
const actionStore = require('../actionStore');
const { descriptor, profiles } = require('./registry');
const { DomainError } = require('../domain/errors');
const { capToolResult, serializeToolError } = require('./loop-helpers');

function hashArgs(args) {
  return crypto.createHash('sha256')
    .update(actionStore.canonicalJson(args))
    .digest('hex');
}

function bookExists(bookId) {
  return db.get('SELECT id FROM books WHERE id = ?', [bookId]);
}

function normalizeContext(context, tool, args, opts = {}) {
  const bookId = Number(context.bookId || args.book_id || args.bookId || 0);
  const cleanArgs = { ...args };
  delete cleanArgs.book_id;
  delete cleanArgs.bookId;
  if (tool.scope === 'book') {
    if (!Number.isInteger(bookId) || bookId <= 0 || !bookExists(bookId)) {
      throw new DomainError('BOOK_NOT_FOUND', '工具需要有效的当前书籍', 404);
    }
  }
  return {
    profile: context.profile || 'writing',
    sessionId: String(context.sessionId || `${context.profile || 'writing'}:book:${bookId}`),
    model: context.model || '',
    source: context.source || context.profile || 'writing',
    actor: context.actor || 'author',
    bookId,
    // A-4：运行所属会话 id（路由层注入，非模型参数）——只读工具据此把范围收在「本会话」，
    // 例如规划笔记默认只列本会话的笔记（无会话且无书时按 NOTE_SCOPE_REQUIRED 拒绝，不给全库出口）。
    conversationId: typeof context.conversationId === 'string' && context.conversationId
      ? context.conversationId : null,
    args: cleanArgs,
    // S2-02：发起运行 id（可选）——确认卡创建时快照关联，供中断恢复展示与追溯
    runId: context.runId || null,
    // 对齐 pi execute 契约：可取消信号 / 进度回调 / 工具调用 id（缺省安全：signal=null、onUpdate=noop）
    signal: opts.signal || context.signal || null,
    onUpdate: typeof opts.onUpdate === 'function' ? opts.onUpdate
      : (typeof context.onUpdate === 'function' ? context.onUpdate : () => {}),
    toolCallId: opts.toolCallId || context.toolCallId || '',
    // S5-02 / R01：调用方传入的读取凭据/失败记录容器（写作页与独立 Agent 各持一份运行内记录）
    readReceipts: Array.isArray(context.readReceipts) ? context.readReceipts : null,
    readAttempts: Array.isArray(context.readAttempts) ? context.readAttempts : null,
  };
}

function ensureAllowed(profile, name) {
  const allowed = profiles[profile];
  if (!allowed || !allowed.has(name)) {
    // S3-05：discuss 只读模式的写工具请求用专属错误码——文本自抬权限无效，
    // 权限只在 profile 白名单；其余 profile 维持原口径。
    if (profile === 'agent-discuss') {
      throw new DomainError('TOOL_NOT_ALLOWED', '讨论模式为只读：写操作需要作者明确的执行请求（仍会走确认）', 403, { tool: name });
    }
    throw new DomainError('TOOL_FORBIDDEN', '当前助手无权使用该工具', 403, { tool: name });
  }
}

// S5-02 / R01：明确重读的读取凭据（readReceipts）——唯一写入点是共享执行器里「工具真的读成了」这一步。
// 凭据记录读取时的 chapterId/revision/正文哈希：模型自报「已读」、上层伪造 tool_result 都写不进这里；
// 读取之后正文又变了，revision/哈希对不上，核验时按未读处理（见 run-policy.verifyReads）。
const CHAPTER_READ_TOOLS = new Set(['read_chapter', 'read_chapter_range']);

function hashChapterContent(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function readChapterIdOf(args) {
  const chapterId = Number(args && (args.chapterId != null ? args.chapterId : args.chapter_id));
  return Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null;
}

function recordReadReceipt(context, name, result) {
  if (!CHAPTER_READ_TOOLS.has(name) || !Array.isArray(context.readReceipts)) return;
  const chapterId = readChapterIdOf(context.args);
  // 结果必须是该章的真实读取页（工具失败/读到别的章不记账）
  if (chapterId == null || !result || typeof result !== 'object' || Number(result.id) !== chapterId) return;
  const row = db.get('SELECT revision, content FROM chapters WHERE id = ? AND book_id = ?', [chapterId, context.bookId]);
  if (!row) return;
  context.readReceipts.push({
    toolCallId: context.toolCallId || '',
    bookId: Number(context.bookId),
    chapterId,
    revision: Number(row.revision),
    contentHash: hashChapterContent(row.content),
    observedAt: new Date().toISOString(),
  });
}

function recordReadFailure(context, name, error) {
  if (!CHAPTER_READ_TOOLS.has(name) || !Array.isArray(context.readAttempts)) return;
  const chapterId = readChapterIdOf(context.args);
  if (chapterId == null) return;
  context.readAttempts.push({
    toolCallId: context.toolCallId || '',
    bookId: Number(context.bookId),
    chapterId,
    code: (error && error.code) || 'READ_FAILED',
    observedAt: new Date().toISOString(),
  });
}

// 参数校验层（对齐 pi：校验失败不执行，错误回给模型）——必需齐全 + 类型正确 + 无多余键
// 注意：schema 存于 tool.inputSchema（registry 冻结字段）；此前误读 tool.parameters 导致本层长期空转（P0）
function validateArgs(tool, args) {
  const params = tool.inputSchema || tool.parameters || {};
  const required = Array.isArray(params.required) ? params.required : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      throw new DomainError('INVALID_ARGS', `缺少必需参数: ${key}`, 400, { tool: tool.name, arg: key });
    }
  }
  const properties = params.properties || {};
  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] === undefined || args[key] === null) continue;
    const t = spec && spec.type;
    const v = args[key];
    if ((t === 'integer' || t === 'number') && typeof v !== 'number') {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 类型错误，应为 ${t}`, 400, { tool: tool.name, arg: key });
    }
    if (t === 'integer' && typeof v === 'number' && !Number.isInteger(v)) {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 应为整数`, 400, { tool: tool.name, arg: key });
    }
    if (t === 'string' && typeof v !== 'string') {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 类型错误，应为 string`, 400, { tool: tool.name, arg: key });
    }
    if (t === 'boolean' && typeof v !== 'boolean') {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 类型错误，应为 boolean`, 400, { tool: tool.name, arg: key });
    }
    if (t === 'array' && !Array.isArray(v)) {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 类型错误，应为 array`, 400, { tool: tool.name, arg: key });
    }
    if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) {
      throw new DomainError('INVALID_ARGS', `参数 ${key} 类型错误，应为 object`, 400, { tool: tool.name, arg: key });
    }
  }
  // additionalProperties:false 时拒绝未声明的多余键（防模型幻觉参数，对齐 pi 严格 schema）
  if (params.additionalProperties === false && Object.keys(properties).length) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        throw new DomainError('INVALID_ARGS', `不支持的参数: ${key}`, 400, { tool: tool.name, arg: key });
      }
    }
  }
}

// S1-03/C04-B：章节写工具的版本绑定。确认创建时快照目标章当前 revision 注入 expected_revision
// （模型无需也不应提供）；执行时由 chapterMutations 与当前 revision 比对——确认等待期间的
// 并行编辑返回 CHAPTER_CONFLICT 而不是静默覆盖旧参数。提案采纳/评审类工具的 expected_revision
// 指提案版本（targetRevision 语义），与此无关，不得加入绑定清单。
const CHAPTER_REVISION_TOOLS = new Set([
  'append_chapter', 'replace_chapter', 'set_chapter_meta',
  'save_chapter_summary', 'move_chapter', 'restore_chapter',
]);

function resolveRevisionChapterId(name, args) {
  if (name === 'restore_chapter') {
    const versionId = Number(args.version_id);
    if (!Number.isInteger(versionId) || versionId <= 0) return null;
    const row = db.get(
      'SELECT c.id AS chapterId FROM chapter_versions v JOIN chapters c ON c.id = v.chapter_id WHERE v.id = ?',
      [versionId]
    );
    return row ? Number(row.chapterId) : null;
  }
  const chapterId = Number(args.chapterId != null ? args.chapterId : args.chapter_id);
  return Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null;
}

function bindChapterRevision(name, args) {
  if (!CHAPTER_REVISION_TOOLS.has(name)) return args;
  const chapterId = resolveRevisionChapterId(name, args);
  if (chapterId == null) return args; // 目标解析不出：留给工具执行时按 NOT_FOUND 报错
  const row = db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]);
  if (!row) return args;
  return { ...args, expected_revision: Number(row.revision) };
}

// S5-01/C06：卷/全书总结的来源绑定。确认创建时快照当前来源指纹注入 source_fingerprint
// （模型无需也不应提供）；执行时由工具在同一个同步事务内与当下来源比对——等待确认期间
// 底料变化 → 409 SOURCE_CHANGED，不把旧生成结果写成「基于新底料」的总结。
// 章总结（save_chapter_summary）仍用 revision 绑定：revision 覆盖章节任何字段变化，
// 比来源指纹更严格，不重复绑定。
const SUMMARY_SOURCE_TOOLS = Object.freeze({
  save_volume_summary: 'volume',
  update_book_progress: 'book',
});

function bindSummarySource(bookId, name, args) {
  const kind = SUMMARY_SOURCE_TOOLS[name];
  if (!kind) return args;
  const entityId = kind === 'volume'
    ? Number(args.volume_id != null ? args.volume_id : args.volumeId)
    : Number(bookId);
  if (!Number.isInteger(entityId) || entityId <= 0) return args; // 目标解析不出：交给执行时报 NOT_FOUND
  try {
    const { fingerprint } = require('../domain/sourceGuard').captureSource({ bookId, kind, entityId });
    return { ...args, source_fingerprint: fingerprint };
  } catch (_) {
    return args; // 目标不存在/来源不可读：不阻断确认创建，执行时报真实错误
  }
}

function requestConfirmation(context, name, args) {
  const tool = descriptor(name);
  if (!tool) throw new DomainError('TOOL_NOT_FOUND', '工具不存在', 404);
  ensureAllowed(context.profile || 'writing', name);
  const normalized = normalizeContext(context, tool, args || {});
  normalized.args = bindSummarySource(normalized.bookId, name, bindChapterRevision(name, normalized.args));
  const action = actionStore.create(normalized.bookId, name, normalized.args, {
    sessionId: normalized.sessionId,
    summary: tool.title,
    impact: [tool.capability],
    toolCallId: normalized.toolCallId || '',
    // 目标 revision：若参数带 expected_revision（提案采纳/评审类工具），一并持久化以绑定确认快照
    targetRevision: normalized.args && normalized.args.expected_revision != null
      ? normalized.args.expected_revision : null,
    // 固化原始发起方（agent），供确认执行阶段写 requested_by（评审 §6）
    requestedBy: normalized.source,
    // S2-02：快照发起运行 id
    runId: normalized.runId || null,
  });
  // F4（2026-09-11 真实库取证：作者拒绝 create_character 后模型立刻换参数再发起同类操作）：
  // 拒绝冷却窗口内同类近重复请求不落库——抛领域错误由循环回灌模型（错误即粮食），
  // 让它向作者说明理由并等待指示，而不是把确认卡再次拍给作者。
  if (action && action.refused) {
    throw new DomainError(
      'REJECTED_RETRY',
      '该操作刚被作者拒绝，不得立即重试；请先向作者说明并等待指示',
      409,
      { priorActionId: action.priorActionId }
    );
  }
  const confirmation = {
    id: action.id,
    tool: name,
    summary: tool.title,
    impact: action.impact,
    expires_at: new Date(action.expiresAt).toISOString(),
  };
  // 提案评审/更新类工具：附带提案当前完整差异快照，供作者在确认卡独立核对（评审 §1/§3）。
  // preview 读取失败不得阻断确认流程——降级为无 preview，作者仍可依据参数确认。
  if (typeof tool.confirmationPreview === 'function') {
    try {
      confirmation.preview = tool.confirmationPreview(normalized);
    } catch (err) {
      console.error('[confirmation preview]', name, err && err.message);
    }
  }
  // 请求阶段审计（append-only）：记录 agent 发起了一个待确认动作（此时尚无 confirmed_by）
  audit(tool, normalized, 'requested', { confirmationId: action.id, requestedBy: normalized.source });
  return {
    status: 'confirmation_required',
    confirmation: confirmation,
  };
}

// 审计字段大小上限：args_json / error_details / result_entity_ids 受限存储，避免超长正文或堆栈撑爆审计表
const AUDIT_ARGS_MAX = 2000;
const AUDIT_DETAILS_MAX = 1000;

function limitJson(value, max) {
  if (value === undefined || value === null) return '';
  try {
    const s = JSON.stringify(value);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (err) {
    return '';
  }
}

// 从工具结果收集受影响实体 id 列表（评审 §6：结果实体列表）——撤销/采纳/批量可能影响多个实体，
// 单列 result_entity_id 不足以重放，故完整列表以 type:id 形式存 result_entity_ids。
function collectEntityIds(result) {
  const ids = [];
  if (!result || typeof result !== 'object') return ids;
  const push = (type, id) => { if (id !== undefined && id !== null && id !== '') ids.push(`${type}:${id}`); };
  if (result.event && result.event.id != null) push('event', result.event.id);
  if (result.character && result.character.id != null) push('character', result.character.id);
  if (result.thread && result.thread.id != null) push('thread', result.thread.id);
  if (result.proposal && result.proposal.id != null) push('proposal', result.proposal.id);
  if (result.retracted_event_id != null) push('retracted_event', result.retracted_event_id);
  if (result.superseded_event_id != null) push('superseded_event', result.superseded_event_id);
  if (Array.isArray(result.proposals)) for (const p of result.proposals) if (p && p.id != null) push('proposal', p.id);
  if (Array.isArray(result.rejected_proposal_ids)) for (const id of result.rejected_proposal_ids) push('proposal', id);
  return ids;
}

// 追加式工具审计（评审 §6）：每次状态转移追加一行（requested/denied/rejected/success/failed），
// 分开记录 requested_by（谁发起，如 agent）与 confirmed_by（谁确认，如 author），
// 并存受限 args_json、目标 revision、结果实体列表、失败 details。审计失败绝不阻断工具执行。
function audit(tool, context, status, opts = {}) {
  const confirmationId = opts.confirmationId || '';
  const result = opts.result || null;
  const errorCode = opts.errorCode || '';
  const requestedBy = opts.requestedBy != null ? opts.requestedBy : (context.source || '');
  // confirmed_by 仅在作者真正做出确认决定时记录（成功/失败/拒绝）；请求与拒绝执行阶段为空
  const confirmedBy = confirmationId && ['success', 'failed', 'rejected'].includes(status)
    ? (context.actor || '') : '';
  try {
    let entityType = '';
    let entityId = '';
    if (result && typeof result === 'object') {
      const candidate = result.event || result.character || result.thread || result.proposal || result;
      if (candidate && candidate.id !== undefined) {
        entityType = result.event ? 'event' : result.character ? 'character' :
          result.thread ? 'thread' : result.proposal ? 'proposal' : 'result';
        entityId = String(candidate.id);
      }
    }
    db.run(
      `INSERT INTO tool_audit_logs
       (session_id, book_id, tool_name, capability, mutation, args_hash,
        confirmation_id, requested_by, confirmed_by, args_json, target_revision,
        result_entity_type, result_entity_id, result_entity_ids,
        status, error_code, error_details, model, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.sessionId,
        context.bookId || null,
        tool.name,
        tool.capability,
        tool.mutation,
        hashArgs(context.args),
        confirmationId,
        requestedBy,
        confirmedBy,
        limitJson(context.args, AUDIT_ARGS_MAX),
        context.args && context.args.expected_revision != null ? Number(context.args.expected_revision) : null,
        entityType,
        entityId,
        limitJson(collectEntityIds(result), AUDIT_DETAILS_MAX),
        status,
        errorCode,
        limitJson(opts.errorDetails === undefined ? null : opts.errorDetails, AUDIT_DETAILS_MAX),
        context.model,
        context.source,
        new Date().toISOString(),
      ]
    );
  } catch (err) {
    console.error('[tool audit] 写入失败:', err.message);
  }
}

async function executeTool(context, name, args = {}, confirmationId = '', opts = {}) {
  const tool = descriptor(name);
  if (!tool) throw new DomainError('TOOL_NOT_FOUND', '工具不存在', 404, { tool: name });
  ensureAllowed(context.profile || 'writing', name);
  const normalized = normalizeContext(context, tool, args, opts);
  if (context.settledAction?.status === 'rejected' && tool.mutation !== 'read') {
    audit(tool, normalized, 'denied', { confirmationId: context.settledAction.id, errorCode: 'ACTION_REJECTED', requestedBy: normalized.source });
    throw new DomainError('ACTION_REJECTED', '作者已拒绝操作，本次自动续跑只能读取和讨论；如需修改，请由作者重新发起请求', 403, { confirmationId: context.settledAction.id });
  }
  validateArgs(tool, normalized.args);
  // 业务级参数校验（如条件必填）：在请求确认前抛错，避免浪费作者的一次确认
  if (typeof tool.validate === 'function') tool.validate(normalized);
  let requestedBy = normalized.source;
  if (tool.confirmation === 'required') {
    if (!confirmationId) return requestConfirmation(normalized, name, normalized.args);
    const authorization = actionStore.authorize(confirmationId, {
      bookId: normalized.bookId,
      name,
      args: normalized.args,
      sessionId: normalized.sessionId,
    });
    if (!authorization.ok) {
      // 确认凭证无效/过期/已用：审计拒绝执行阶段（denied），requested_by 仍记发起方
      audit(tool, normalized, 'denied', { confirmationId, errorCode: 'INVALID_CONFIRMATION', requestedBy });
      throw new DomainError('INVALID_CONFIRMATION', '确认凭证无效、过期或已经使用', 403, {
        reason: authorization.code,
      });
    }
    // 执行阶段的 requested_by 取创建时固化的原始发起方（agent），而非本次请求的 agent-confirm
    requestedBy = authorization.action.requestedBy || normalized.source;
  }
  try {
    const result = await tool.execute(normalized);
    // S5-02 / R01：真实读取成后记账（凭据 = 读取时章版本 + 正文哈希）
    recordReadReceipt(normalized, name, result);
    // S1-01/C01：写工具业务已应用后立刻同步落盘。未落盘时结果与确认结算都带
    // PERSISTENCE_PENDING 状态——业务确已发生（模型不得当失败重放写操作），
    // 但结算记录不得标 approved-durable；持久化由 db 层自动重试/flush 完成。
    let finalResult = result;
    if (tool.mutation !== 'read') {
      const persistence = require('../persistence').persistenceState();
      if (!persistence.durable) {
        finalResult = result && typeof result === 'object'
          ? { ...result, persistence }
          : { value: result, persistence };
      }
    }
    if (confirmationId) actionStore.settle(confirmationId, 'approved', finalResult);
    audit(tool, normalized, 'success', { confirmationId, result: finalResult, requestedBy });
    return finalResult;
  } catch (err) {
    // S5-02 / R01：失败的读取尝试单独记账——「读取失败」与「根本没读」在核验时是不同状态
    recordReadFailure(normalized, name, err);
    if (confirmationId) actionStore.settle(confirmationId, 'failed', {
      error: err.message,
      code: err.code || '',
    });
    audit(tool, normalized, 'failed', {
      confirmationId, errorCode: err.code || 'EXECUTION_FAILED', errorDetails: err.details, requestedBy,
    });
    throw err;
  }
}

// 模型适配器边界（AI SDK 路径统一入口）：成功 {ok:true,data}（确认信封经 capToolResult 原样保留、
// 超限结果被截断）；失败 {ok:false,error:serializeToolError(...)}。异常永不穿透到 SDK，避免丢失 code/details。
async function executeForModel(context, name, args = {}, opts = {}) {
  try {
    return { ok: true, data: capToolResult(await executeTool(context, name, args, '', opts)) };
  } catch (err) {
    return { ok: false, error: serializeToolError(err, name) };
  }
}

// 作者在确认卡「拒绝」时的审计（评审 §6 拒绝阶段）：由确认路由调用。
// 与执行阶段分离——拒绝不触发工具执行，只记录作者的决定（confirmed_by=author）与原始发起方（requested_by=agent）。
function auditRejection(action, sessionId) {
  if (!action) return;
  const tool = descriptor(action.name);
  if (!tool) return;
  audit(tool, {
    sessionId: sessionId || action.sessionId,
    bookId: action.bookId,
    args: action.args || {},
    source: action.requestedBy || 'agent',
    actor: 'author',
    model: '',
  }, 'rejected', { confirmationId: action.id, requestedBy: action.requestedBy || 'agent' });
}

module.exports = { executeTool, executeForModel, requestConfirmation, normalizeContext, auditRejection };
