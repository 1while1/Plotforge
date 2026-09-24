// S4-04a / 契约 01 §6：规划笔记与显式交接的服务层（唯一实现）。
//   规划笔记：Agent 讨论里的结论草稿 —— 只管理草稿（status=draft，库层 CHECK 锁死），
//     没有任何正典效力，不写正文/大纲/story_events；乐观锁 revision 单调递增。
//   显式交接：作者选定讨论消息 → createHandoff 落草案（含来源指纹）→ getHandoffPreview
//     给作者核对材料与来源 → acceptHandoff 才向**指定 writing 会话**追加一条注明来源的
//     消息。采纳本身不改大纲/正文/事实，也不是写权限后门（正式资料更新仍走领域确认与 diff）。
//   边界（服务层判断，不靠调用方自觉）：
//     · 同书校验：书内来源与目标必须同书，跨书 409；global→book 必须显式给目标会话；
//     · 材料范围：材料只由作者选定的消息 + 明确来源引用组成，不夹带其他会话/书的内容；
//     · 来源指纹：正文/笔记更新后旧预览过期（409 HANDOFF_SOURCE_CHANGED），重新预览才可采纳；
//     · 目标可用性：归档 409、有活跃运行 409（等这一轮结束再来，不混进正在发给模型的请求）；
//     · 幂等：同一草案重复采纳只落一条消息（accepted_message_id 留痕，重复调用返回同一条）。
const crypto = require('crypto');
const db = require('../db');
const conversationSvc = require('./service');

const NOTE_STATUS = 'draft';
const HANDOFF_STATUSES = ['draft', 'accepted', 'cancelled'];
const REF_KINDS = ['chapter', 'planning_note', 'general'];
const MAX_TITLE = 200;
const MAX_TEXT = 8000;
const MAX_SELECTED = 50;
const MAX_REFS = 50;
const EXCERPT_LIMIT = 2000;
// S6-02（L16 现场修正）：忙判据只认真正在飞的运行行。awaiting_confirmation 不再无条件算忙——
// 确认卡结算后运行行不终态化（根因见 08 台账 §13.2 与契约 01 §3.1），历史滞留行会把目标会话
// 永久判忙、交接采纳永远 409；现改为「该运行自己发起的卡仍未结算」才算忙（见 isTargetBusy）。
const ACTIVE_RUN_STATUSES = ['running'];
const AWAITING_CONFIRMATION_STATUS = 'awaiting_confirmation';
// 「未结算」＝作者还没裁决（pending）或正在执行（executing）；approved/rejected/failed/superseded/
// expired/interrupted 都是已落定的历史。
const UNRESOLVED_ACTION_STATUSES = ['pending', 'executing'];

function fail(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseJsonArray(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTitle(title) {
  if (title === undefined || title === null) return '';
  return String(title).slice(0, MAX_TITLE);
}

function normalizeText(text, code) {
  if (text === undefined || text === null) return '';
  const value = String(text);
  if (value.length > MAX_TEXT) {
    throw fail(400, code, `文本超长（上限 ${MAX_TEXT} 字）`);
  }
  return value;
}

function requireConversation(id, status, code, message) {
  const conv = conversationSvc.getConversation(typeof id === 'string' ? id : '');
  if (!conv) throw fail(status, code, message);
  return conv;
}

// 选定的消息必须真实存在且属于来源会话——绝不「顺手」带上其他会话/别书的内容。
function loadSelectedMessages(conversationId, ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT id, book_id, conversation_id, role, content, compressed FROM messages WHERE id IN (${marks})`,
    ids
  );
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  return ids.map(id => {
    const row = byId.get(id);
    if (!row) throw fail(404, 'HANDOFF_MESSAGE_NOT_FOUND', `选定的消息 #${id} 不存在`);
    if (row.conversation_id !== conversationId) {
      throw fail(400, 'HANDOFF_MESSAGE_FOREIGN_CONVERSATION',
        `选定的消息 #${id} 不属于来源会话（不自动夹带其他会话或别的书的内容）`);
    }
    return row;
  });
}

function normalizeSelectedIds(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    throw fail(400, 'INVALID_SELECTED_MESSAGES', 'selectedMessageIds 必须是消息 id 数组');
  }
  if (value.length > MAX_SELECTED) {
    throw fail(400, 'INVALID_SELECTED_MESSAGES', `一次最多选定 ${MAX_SELECTED} 条消息`);
  }
  const ids = [];
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw fail(400, 'INVALID_SELECTED_MESSAGES', `选定的消息 id 非法：${raw}`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeRefs(value, code) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    throw fail(400, code, 'sourceRefs 必须是数组');
  }
  if (value.length > MAX_REFS) {
    throw fail(400, code, `来源引用最多 ${MAX_REFS} 条`);
  }
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw fail(400, code, '来源引用必须是对象');
    }
    const kind = raw.kind;
    if (!REF_KINDS.includes(kind)) {
      throw fail(400, code, `未知来源类型：${kind}；只接受 ${REF_KINDS.join('/')}`);
    }
    if (kind === 'general') {
      const label = normalizeTitle(raw.label);
      if (!label) throw fail(400, code, '通用来源引用必须带 label（明确标出引用了什么共享资料）');
      return { kind, label };
    }
    if (kind === 'planning_note') {
      // 笔记 id 是 UUID 文本（与 messages 的自增整数 id 不同）
      const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
      if (!id || id.length > 64) {
        throw fail(400, code, '来源引用 planning_note 缺少合法 id');
      }
      return { kind, id };
    }
    const id = Number(raw.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw fail(400, code, `来源引用 ${kind} 缺少合法 id`);
    }
    return { kind, id };
  });
}

// 来源引用 → 当前状态戳（指纹组成的一部分）。
// forCreate=true：解析失败/跨书直接给明确错误；forCreate=false（采纳前重算）：一律
// 视为「来源已变」，让作者重新预览，而不是拿一份没人核对过的材料往写作会话里塞。
function stampRef(ref, ctx, forCreate) {
  const changed = (message) => {
    throw fail(409, 'HANDOFF_SOURCE_CHANGED', message, { reason: ref.kind });
  };
  if (ref.kind === 'chapter') {
    const row = db.get('SELECT id, book_id, title, revision, content FROM chapters WHERE id = ?', [Number(ref.id)]);
    if (!row) {
      if (forCreate) throw fail(404, 'HANDOFF_SOURCE_NOT_FOUND', `来源章节 #${ref.id} 不存在`);
      return changed(`来源章节 #${ref.id} 已不存在，请重新预览`);
    }
    if (Number(row.book_id) !== ctx.targetBookId) {
      if (forCreate) {
        throw fail(409, 'HANDOFF_SOURCE_FOREIGN_BOOK',
          `来源章节 #${ref.id} 属于另一本书：交接只能带目标书内或明确通用的材料`);
      }
      return changed(`来源章节 #${ref.id} 已不属于目标书，请重新预览`);
    }
    return {
      kind: 'chapter', id: Number(row.id), title: row.title,
      revision: Number(row.revision), hash: sha256(row.content || ''),
    };
  }
  if (ref.kind === 'planning_note') {
    const row = db.get('SELECT * FROM planning_notes WHERE id = ?', [String(ref.id)]);
    if (!row) {
      if (forCreate) throw fail(404, 'HANDOFF_SOURCE_NOT_FOUND', `来源笔记 #${ref.id} 不存在`);
      return changed(`来源笔记 #${ref.id} 已不存在，请重新预览`);
    }
    if (row.conversation_id !== ctx.originConversationId) {
      if (forCreate) {
        throw fail(409, 'HANDOFF_SOURCE_FOREIGN_BOOK', '来源笔记不属于本次讨论会话，不能作为交接来源');
      }
      return changed('来源笔记已不属于本次讨论会话，请重新预览');
    }
    if (row.book_id !== null && row.book_id !== undefined && Number(row.book_id) !== ctx.targetBookId) {
      if (forCreate) {
        throw fail(409, 'HANDOFF_SOURCE_FOREIGN_BOOK', '来源笔记属于另一本书，不能交接给本书');
      }
      return changed('来源笔记已不属于目标书，请重新预览');
    }
    return {
      kind: 'planning_note', id: row.id, title: row.title,
      revision: Number(row.revision), hash: sha256(row.text || ''),
    };
  }
  if (ref.kind === 'general') {
    // 明确通用的共享资料（如作家卡/系统规则）：只登记作者写下的标签，不带任何书的内容
    return { kind: 'general', label: String(ref.label || ''), hash: sha256(ref.label || '') };
  }
  if (forCreate) throw fail(400, 'INVALID_SOURCE_REF', `未知来源类型：${ref.kind}`);
  return changed('来源引用含未知类型，请重新预览');
}

function sourceStamps({ originConversationId, targetBookId, selectedMessages, refs }, forCreate) {
  return {
    origin: originConversationId,
    messages: selectedMessages.map(row => ({ id: Number(row.id), hash: sha256(row.content || '') })),
    refs: refs.map(ref => stampRef(ref, { originConversationId, targetBookId }, forCreate)),
  };
}

function computeSourceFingerprint(input, forCreate) {
  return 'sha256:' + sha256(JSON.stringify(sourceStamps(input, forCreate)));
}

// 交接材料：与采纳时写入写作会话的内容同源（预览所见即实际交接所得）。
function buildMaterial({ text, selectedMessages, refs, stamps }) {
  const excerpts = selectedMessages.map(row => {
    const content = String(row.content || '');
    return {
      messageId: Number(row.id),
      role: row.role,
      excerpt: content.slice(0, EXCERPT_LIMIT),
      truncated: content.length > EXCERPT_LIMIT,
    };
  });
  // 正常路径用当前状态戳；来源过期/解析失败时退回作者当初登记的引用（只作展示，
  // 采纳仍会被指纹拦下，必须重新预览）
  const refStamps = Array.isArray(stamps) ? stamps : [];
  const sourceRefs = refStamps.length
    ? refStamps.map(stamp => (
      stamp.kind === 'general'
        ? { kind: 'general', label: stamp.label }
        : { kind: stamp.kind, id: stamp.id, title: stamp.title, revision: stamp.revision }
    ))
    : (refs || []).map(ref => (ref.kind === 'general'
      ? { kind: 'general', label: ref.label }
      // planning_note 的 id 是 UUID 文本，不能当数字解析（曾经把 #uuid 渲染成 #NaN，
      // 冒烟实测抓出：见台账 §11.5）
      : { kind: ref.kind, id: ref.kind === 'planning_note' ? String(ref.id) : Number(ref.id) }));
  return { text, excerpts, sourceRefs };
}

function buildHandoffMessageContent(view) {
  const lines = [];
  lines.push(`【来自 Agent 讨论·显式交接】来源会话：${view.originTitle || '（无标题）'}（${view.originConversationId}）`);
  if (view.material.text) lines.push(view.material.text);
  if (view.material.excerpts.length) {
    lines.push('选定结论：');
    for (const item of view.material.excerpts) {
      lines.push(`- #${item.messageId}：${item.excerpt}${item.truncated ? '……（原文更长，已截断）' : ''}`);
    }
  }
  if (view.material.sourceRefs.length) {
    const refs = view.material.sourceRefs.map(ref => (
      ref.kind === 'general'
        ? `通用资料：${ref.label}`
        : `${ref.kind === 'chapter' ? '章节' : '规划笔记'} #${ref.id}（revision ${ref.revision}）`
    ));
    lines.push(`来源引用：${refs.join('｜')}`);
  }
  lines.push('（这是作者显式交接的材料，不是已确认的故事事实；更新大纲/人物/世界观仍需走确认与 diff。）');
  return lines.join('\n');
}

function toNoteView(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    bookId: row.book_id === null || row.book_id === undefined ? null : Number(row.book_id),
    title: row.title || '',
    text: row.text || '',
    selectedMessageIds: parseJsonArray(row.selected_message_ids).map(Number),
    revision: Number(row.revision),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 规划笔记（只管理草稿）
// ---------------------------------------------------------------------------

function createPlanningNote({ conversationId, title, text, selectedMessageIds }) {
  const conv = requireConversation(conversationId, 404, 'NOTE_CONVERSATION_NOT_FOUND', '会话不存在');
  if (conv.status !== 'active') {
    throw fail(409, 'CONVERSATION_ARCHIVED', '会话已归档，不能新建笔记');
  }
  const safeText = normalizeText(text, 'NOTE_TEXT_TOO_LARGE').trim();
  if (!safeText) throw fail(400, 'NOTE_TEXT_REQUIRED', '笔记正文不能为空');
  const ids = normalizeSelectedIds(selectedMessageIds);
  // 选定的消息必须属于本会话（与交接同口径：不夹带其他会话/书的内容）
  if (ids.length) loadSelectedMessages(conv.id, ids);
  const id = crypto.randomUUID();
  const bookId = conv.scope === 'book' ? Number(conv.book_id) : null;
  db.run(
    `INSERT INTO planning_notes
       (id, conversation_id, book_id, title, text, selected_message_ids, revision, status)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, conv.id, bookId, normalizeTitle(title), safeText, JSON.stringify(ids), NOTE_STATUS]
  );
  return toNoteView(db.get('SELECT * FROM planning_notes WHERE id = ?', [id]));
}

function updatePlanningNote({ noteId, expectedRevision, title, text }) {
  const row = db.get('SELECT * FROM planning_notes WHERE id = ?', [String(noteId)]);
  if (!row) throw fail(404, 'NOTE_NOT_FOUND', '规划笔记不存在');
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    throw fail(428, 'NOTE_REVISION_REQUIRED',
      '缺少 expectedRevision：请先读取笔记当前 revision 再提交修改',
      { currentRevision: Number(row.revision) });
  }
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected <= 0) {
    throw fail(400, 'INVALID_REVISION', 'expectedRevision 必须是正整数');
  }
  if (expected !== Number(row.revision)) {
    throw fail(409, 'NOTE_CONFLICT', '笔记已被修改，请重新读取后再提交',
      { currentRevision: Number(row.revision) });
  }
  const fields = [];
  const params = [];
  const nextTitle = title === undefined ? row.title : normalizeTitle(title);
  const nextText = text === undefined ? row.text : normalizeText(text, 'NOTE_TEXT_TOO_LARGE');
  if (text !== undefined && !String(nextText).trim()) {
    throw fail(400, 'NOTE_TEXT_REQUIRED', '笔记正文不能为空');
  }
  if (title !== undefined && nextTitle !== row.title) { fields.push('title = ?'); params.push(nextTitle); }
  if (text !== undefined && nextText !== row.text) { fields.push('text = ?'); params.push(nextText); }
  if (!fields.length) return toNoteView(row); // 同值 no-op 不递增（对齐 S1-02 口径）
  const result = db.run(
    `UPDATE planning_notes SET ${fields.join(', ')}, revision = revision + 1,
       updated_at = datetime('now','localtime')
     WHERE id = ? AND revision = ?`,
    [...params, row.id, expected]
  );
  if (!result.changes) {
    throw fail(409, 'NOTE_CONFLICT', '笔记已被修改，请重新读取后再提交',
      { currentRevision: Number(db.get('SELECT revision FROM planning_notes WHERE id = ?', [row.id]).revision) });
  }
  return toNoteView(db.get('SELECT * FROM planning_notes WHERE id = ?', [row.id]));
}

function listPlanningNotes({ bookId, conversationId } = {}) {
  const where = ["status = 'draft'"];
  const params = [];
  const hasBook = bookId !== undefined && bookId !== null && bookId !== '';
  const hasConversation = conversationId !== undefined && conversationId !== null && conversationId !== '';
  if (hasBook) {
    const id = Number(bookId);
    if (!Number.isInteger(id) || id <= 0) throw fail(400, 'INVALID_BOOK_ID', 'bookId 非法');
    where.push('book_id = ?');
    params.push(id);
  }
  if (hasConversation) {
    where.push('conversation_id = ?');
    params.push(String(conversationId));
  }
  if (!hasBook && !hasConversation) {
    throw fail(400, 'NOTE_SCOPE_REQUIRED', '必须指定 bookId 或 conversationId（不提供全库笔记出口）');
  }
  const rows = db.all(
    `SELECT * FROM planning_notes WHERE ${where.join(' AND ')} ORDER BY id`, params);
  return rows.map(toNoteView);
}

// 只读单条笔记：与 listPlanningNotes 共用同一 toNoteView（工具与 HTTP 侧同源，不写第二份 SQL）。
// 找不到返回 null——「是否存在」不外泄：调用方（工具层）把「不在可见范围」与「不存在」
// 统一按不存在处理，不借错误码确认别处有这条笔记。
function getPlanningNote(noteId) {
  if (noteId === undefined || noteId === null || noteId === '') return null;
  const id = String(noteId);
  if (id.length > 64) return null;
  const row = db.get('SELECT * FROM planning_notes WHERE id = ?', [id]);
  return row ? toNoteView(row) : null;
}

// ---------------------------------------------------------------------------
// 交接（草案 → 预览 → 采纳）
// ---------------------------------------------------------------------------

function getHandoffRow(handoffId) {
  if (typeof handoffId !== 'string' || !handoffId) return null;
  return db.get('SELECT * FROM handoffs WHERE id = ?', [handoffId]) || null;
}

// 目标是否「忙」＝有没有正在发给模型的请求。两道判据：
//   ① 运行维度：存在 status='running' 的运行行，或停在 awaiting_confirmation 且它自己发起的
//      确认卡仍未结算的运行行（作者还没裁决 → 这一轮随时会继续推进）；
//   ② 会话维度保守兜底：run_id 为空的未结算卡无法证明它不属于在飞运行，只要落在本会话用过的
//      session_key 上就一律算忙（宁可多拒，不放行可能混进在飞请求的采纳）。
function unresolvedActionId(conversationId) {
  const unresolved = UNRESOLVED_ACTION_STATUSES.map(() => '?').join(', ');
  const own = db.get(
    `SELECT id FROM chat_actions
      WHERE status IN (${unresolved})
        AND run_id IN (SELECT id FROM agent_runs WHERE conversation_id = ? AND status = ?)
      LIMIT 1`,
    [...UNRESOLVED_ACTION_STATUSES, conversationId, AWAITING_CONFIRMATION_STATUS]
  );
  if (own) return own.id;
  const sessionKeys = db.all(
    `SELECT DISTINCT session_key FROM agent_runs
      WHERE conversation_id = ? AND session_key IS NOT NULL AND session_key <> ''`,
    [conversationId]
  ).map(row => row.session_key).filter(Boolean);
  if (!sessionKeys.length) return null;
  const orphan = db.get(
    `SELECT id FROM chat_actions
      WHERE status IN (${unresolved}) AND run_id IS NULL
        AND session_id IN (${sessionKeys.map(() => '?').join(', ')})
      LIMIT 1`,
    [...UNRESOLVED_ACTION_STATUSES, ...sessionKeys]
  );
  return orphan ? orphan.id : null;
}

function isTargetBusy(conversationId) {
  const running = db.get(
    `SELECT id FROM agent_runs WHERE conversation_id = ?
       AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(', ')})`,
    [conversationId, ...ACTIVE_RUN_STATUSES]
  );
  if (running) return true;
  return Boolean(unresolvedActionId(conversationId));
}

function targetState(conversationId) {
  const conv = conversationSvc.getConversation(conversationId);
  if (!conv) return { conversationId, title: '', status: 'missing', busy: false };
  return {
    conversationId: conv.id,
    title: conv.title || '',
    status: conv.status,
    busy: isTargetBusy(conversationId),
  };
}

function toHandoffView(row) {
  const origin = conversationSvc.getConversation(row.origin_conversation_id);
  const ids = parseJsonArray(row.selected_message_ids).map(Number);
  const refs = parseJsonArray(row.source_refs);
  const selectedMessages = ids.length
    ? db.all(
      `SELECT id, role, content FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids
    ).sort((a, b) => Number(a.id) - Number(b.id))
    : [];
  const ctx = {
    originConversationId: row.origin_conversation_id,
    targetBookId: Number(row.book_id),
    selectedMessages,
    refs,
  };
  let sourceFingerprint = null;
  let sourceChanged = false;
  let sourceIssue = '';
  let stamps = { origin: row.origin_conversation_id, messages: [], refs: [] };
  try {
    stamps = sourceStamps(ctx, false);
    sourceFingerprint = 'sha256:' + sha256(JSON.stringify(stamps));
  } catch (err) {
    sourceChanged = true;
    sourceIssue = err.message;
  }
  return {
    id: row.id,
    status: row.status,
    bookId: Number(row.book_id),
    originConversationId: row.origin_conversation_id,
    originTitle: origin ? (origin.title || '') : '',
    targetConversationId: row.target_conversation_id,
    target: targetState(row.target_conversation_id),
    text: row.text || '',
    selectedMessageIds: ids,
    sourceRefs: refs,
    material: buildMaterial({ text: row.text || '', selectedMessages, refs, stamps: stamps.refs }),
    sourceFingerprint,
    sourceChanged,
    sourceIssue,
    acceptedAt: row.accepted_at || null,
    acceptedMessageId: row.accepted_message_id === null || row.accepted_message_id === undefined
      ? null : Number(row.accepted_message_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createHandoff({ originConversationId, targetConversationId, selectedMessageIds, text, sourceRefs }) {
  if (!originConversationId) {
    throw fail(400, 'HANDOFF_ORIGIN_REQUIRED', '必须提供来源会话（originConversationId）');
  }
  const origin = requireConversation(originConversationId, 404, 'HANDOFF_ORIGIN_NOT_FOUND', '来源会话不存在');
  if (origin.kind !== 'agent') {
    throw fail(400, 'HANDOFF_ORIGIN_NOT_AGENT', '交接来源必须是 Agent 讨论会话');
  }
  // global 来源没有任何默认目标：必须由作者明确选定一本书的写作会话
  if (!targetConversationId) {
    throw fail(400, 'HANDOFF_TARGET_REQUIRED',
      '必须由作者明确选定目标写作会话（global 讨论不自动挑书、不夹带其他书材料）');
  }
  const target = requireConversation(targetConversationId, 404, 'HANDOFF_TARGET_NOT_FOUND', '目标会话不存在');
  if (target.kind !== 'writing' || target.scope !== 'book') {
    throw fail(400, 'HANDOFF_TARGET_NOT_WRITING', '交接目标必须是某本书的写作会话');
  }
  if (origin.scope === 'book' && Number(origin.book_id) !== Number(target.book_id)) {
    throw fail(409, 'HANDOFF_CROSS_BOOK', '交接不能跨书：请在该书的讨论会话里选定本书写作会话');
  }
  const bookId = Number(target.book_id);
  const safeText = normalizeText(text, 'HANDOFF_TEXT_TOO_LARGE').trim();
  const ids = normalizeSelectedIds(selectedMessageIds);
  const messages = loadSelectedMessages(origin.id, ids);
  if (!safeText && !messages.length) {
    throw fail(400, 'HANDOFF_MATERIAL_EMPTY', '交接草案必须至少包含摘要文本或选定的讨论消息');
  }
  const refs = normalizeRefs(sourceRefs, 'INVALID_SOURCE_REF');
  const sourceFingerprint = computeSourceFingerprint(
    { originConversationId: origin.id, targetBookId: bookId, selectedMessages: messages, refs }, true);
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO handoffs
       (id, book_id, origin_conversation_id, target_conversation_id, selected_message_ids, text,
        source_refs, source_fingerprint, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [id, bookId, origin.id, target.id, JSON.stringify(ids), safeText, JSON.stringify(refs), sourceFingerprint]
  );
  return toHandoffView(getHandoffRow(id));
}

function getHandoffPreview(handoffId) {
  const row = getHandoffRow(handoffId);
  if (!row) throw fail(404, 'HANDOFF_NOT_FOUND', '交接草案不存在');
  return toHandoffView(row);
}

function acceptHandoff({ handoffId, expectedSourceFingerprint }) {
  const row = getHandoffRow(handoffId);
  if (!row) throw fail(404, 'HANDOFF_NOT_FOUND', '交接草案不存在');
  // 幂等：已采纳的草案重复点击返回同一条消息，不再插入
  if (row.status === 'accepted') {
    return { ...toHandoffView(row), duplicate: true, messageId: row.accepted_message_id === null ? null : Number(row.accepted_message_id) };
  }
  if (row.status === 'cancelled') {
    throw fail(409, 'HANDOFF_CANCELLED', '该交接草案已作废，请重新创建');
  }
  if (expectedSourceFingerprint === undefined || expectedSourceFingerprint === null || expectedSourceFingerprint === '') {
    throw fail(428, 'HANDOFF_FINGERPRINT_REQUIRED',
      '缺少 expectedSourceFingerprint：请先预览交接材料与来源再采纳');
  }
  const current = toHandoffView(row);
  if (!current.sourceFingerprint) {
    throw fail(409, 'HANDOFF_SOURCE_CHANGED', current.sourceIssue || '来源已变更，请重新预览',
      { reason: current.sourceIssue });
  }
  if (current.sourceFingerprint !== String(expectedSourceFingerprint)) {
    throw fail(409, 'HANDOFF_SOURCE_CHANGED', '来源资料已更新，请重新预览后再采纳',
      { currentSourceFingerprint: current.sourceFingerprint });
  }
  const target = conversationSvc.getConversation(row.target_conversation_id);
  if (!target) {
    throw fail(409, 'HANDOFF_TARGET_MISSING', '目标写作会话已不存在，请重新创建交接');
  }
  if (target.status !== 'active') {
    throw fail(409, 'HANDOFF_TARGET_ARCHIVED', '目标写作会话已归档，请另开会话后重新交接');
  }
  if (current.target.busy) {
    throw fail(409, 'HANDOFF_TARGET_BUSY',
      '目标会话正在运行中：等这一轮结束后再采纳（不会混进正在发给模型的那次请求）');
  }
  const content = buildHandoffMessageContent(current);
  let appended = null;
  db.transaction(() => {
    appended = conversationSvc.appendMessage({
      conversationId: target.id, role: 'user', content, source: 'system',
    });
    const updated = db.run(
      `UPDATE handoffs SET status = 'accepted', accepted_at = datetime('now','localtime'),
         accepted_message_id = ?, source_fingerprint = ?, updated_at = datetime('now','localtime')
       WHERE id = ? AND status = 'draft'`,
      [appended.id, current.sourceFingerprint, row.id]
    );
    if (!updated.changes) {
      throw fail(409, 'HANDOFF_ALREADY_SETTLED', '该交接刚刚已被处理，请刷新预览');
    }
  });
  return {
    ...toHandoffView(getHandoffRow(row.id)),
    duplicate: false,
    messageId: appended.id,
  };
}

// 作废**只对草案（draft）生效**：已采纳的交接消息已经写进写作会话（appendMessage 不可撤回），
// 对它必须 409 而不是静默成功——否则作者会把「作废」读成「那条消息被撤回」。
// 作废是留痕的状态变化（不删行）：作者「选过又放弃」本身是有用的记录。
function cancelHandoff({ handoffId }) {
  const row = getHandoffRow(handoffId);
  if (!row) throw fail(404, 'HANDOFF_NOT_FOUND', '交接草案不存在');
  if (row.status === 'accepted') {
    throw fail(409, 'HANDOFF_ALREADY_ACCEPTED',
      '该交接已被采纳：那条注明来源的消息已经写进写作会话，作废不会撤回它（要换结论请重新创建草案）');
  }
  // 幂等：重复作废返回同一状态，不产生第二次状态迁移
  if (row.status === 'cancelled') {
    return { ...toHandoffView(row), duplicate: true };
  }
  // 与 acceptHandoff 同款的竞态防护：条件更新（不能「先读后写」——两个标签页可能同时点）
  const updated = db.run(
    `UPDATE handoffs SET status = 'cancelled', updated_at = datetime('now','localtime')
     WHERE id = ? AND status = 'draft'`,
    [row.id]
  );
  if (!updated.changes) {
    throw fail(409, 'HANDOFF_ALREADY_SETTLED', '该交接刚刚已被处理，请刷新预览');
  }
  return { ...toHandoffView(getHandoffRow(row.id)), duplicate: false };
}

module.exports = {
  createPlanningNote,
  updatePlanningNote,
  listPlanningNotes,
  getPlanningNote,
  createHandoff,
  getHandoffPreview,
  acceptHandoff,
  cancelHandoff,
  buildHandoffMessageContent,
  NOTE_STATUS,
  HANDOFF_STATUSES,
  REF_KINDS,
};
