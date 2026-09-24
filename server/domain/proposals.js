const crypto = require('crypto');
const db = require('../db');
const ledger = require('./storyLedger');
const { DomainError } = require('./errors');
const { makeDedupeKey } = require('../migrations/001-character-hub');
// 正文修订哈希与抽取端（server/domain/chapterSummaryProposals.js）**同源同函数**：
// 两处若各写一份 SHA-256，采纳侧的比对就变成「两个实现是否恰好一致」的赌注。
const { revision } = require('../evidence/draftLexical');

const STATUSES = new Set(['pending', 'accepted', 'rejected', 'merged', 'stale']);
const SOURCES = new Set(['chapter_summary', 'advisor', 'history_backfill', 'manual']);
const IMPORTANCE = new Set(['low', 'normal', 'high', 'critical']);
// 创建者身份（评审 §3）：区分作者/Agent/抽取器/顾问。003 迁移因 ALTER 不支持 CHECK，枚举在此校验。
const CREATED_BY = new Set(['author', 'agent', 'extractor', 'advisor']);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DomainError('VALIDATION_ERROR', `${field} 必须是正整数`, 400, { field });
  }
  return id;
}

function ensureBook(bookId) {
  const id = positiveId(bookId, 'book_id');
  if (!db.get('SELECT id FROM books WHERE id = ?', [id])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  return id;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function normalizeChange(bookId, raw) {
  if (!raw || typeof raw !== 'object') {
    throw new DomainError('VALIDATION_ERROR', '提案变化必须是对象', 400, { field: 'changes' });
  }
  const kind = text(raw.change_kind);
  if (!['character_state', 'relation'].includes(kind)) {
    throw new DomainError('VALIDATION_ERROR', 'change_kind 无效', 400, { field: 'change_kind' });
  }
  const subjectRef = text(raw.subject_ref);
  const fieldKey = text(raw.field_key);
  if (!subjectRef || !fieldKey || (kind === 'character_state' && fieldKey === 'relation')) {
    throw new DomainError('VALIDATION_ERROR', '提案变化的对象或字段无效', 400);
  }
  // subject_ref 必须是本书人物表里的数字 id（2026-09-10 十章实测）。
  // 此前创建侧只校验「非空字符串」，而采纳侧（ledger.validateStateChange → positiveId）
  // 要求正整数——两条路径口径不一致：模型把 subject_ref 填成人名「陈默」时，提案照样落库、
  // 照样出现在台账工作台里，作者点了「采纳」才被告知「subject_ref 必须是正整数」。
  // 这类提案永远无法采纳，成了死信，且作者要自己猜原因。现在提前到创建侧拦截，
  // 并按 Pi 的「错误即粮食」给出可纠正提示（点名要怎么做，而不是只说参数非法）。
  if (!/^\d+$/.test(subjectRef) || !db.get('SELECT id FROM characters WHERE id = ? AND book_id = ?', [Number(subjectRef), bookId])) {
    const hint = /^\d+$/.test(subjectRef)
      ? `subject_ref ${subjectRef} 不是本书的人物 id`
      : `subject_ref 必须是人物数字 id，收到的是「${subjectRef}」`;
    throw new DomainError('VALIDATION_ERROR',
      `${hint}。请先用 list_characters / find_characters 查到人物 id 再提交提案。`,
      400, { field: 'subject_ref', received: subjectRef });
  }
  // 值归一化（评审 §1 硬化A）：与账本提交共用 ledger.normalizeStateValue，old/new 同规则，
  // list 型在提案落库前就包装为数组，避免“接受时才发现类型不符”。字段未启用/不存在时不在此拦截，
  // 仍由采纳时的 validateStateChange 统一校验（保持提案创建宽松）。
  const definition = kind === 'character_state'
    ? db.get('SELECT value_type FROM state_field_definitions WHERE book_id = ? AND field_key = ?', [bookId, fieldKey])
    : null;
  const normalize = value => (definition ? ledger.normalizeStateValue(definition, value) : value);
  return {
    change_kind: kind,
    subject_ref: subjectRef,
    field_key: fieldKey,
    old_value: Object.hasOwn(raw, 'old_value') ? normalize(raw.old_value) : null,
    new_value: Object.hasOwn(raw, 'new_value') ? normalize(raw.new_value) : null,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
}

function validateChapter(bookId, chapterId) {
  if (chapterId === undefined || chapterId === null || chapterId === '') return null;
  const id = positiveId(chapterId, 'chapter_id');
  if (!db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [id, bookId])) {
    throw new DomainError('CROSS_BOOK_REFERENCE', '提案章节不属于当前书籍', 400);
  }
  return id;
}

// 修正提案：supersedes_event_id 必须指向本书一个真实事件；采纳时据此走修正事务而非普通提交。
function validateSupersedes(bookId, eventId) {
  if (eventId === undefined || eventId === null || eventId === '') return null;
  const id = positiveId(eventId, 'supersedes_event_id');
  if (!db.get('SELECT id FROM story_events WHERE id = ? AND book_id = ?', [id, bookId])) {
    throw new DomainError('EVENT_NOT_FOUND', '被修正的事件不存在或不属于当前书籍', 404, { field: 'supersedes_event_id' });
  }
  return id;
}

function normalizeProposal(bookId, input = {}) {
  const bid = ensureBook(bookId);
  const title = text(input.title);
  if (!title) throw new DomainError('VALIDATION_ERROR', '提案标题不能为空', 400, { field: 'title' });
  const sourceType = text(input.source_type) || 'manual';
  if (!SOURCES.has(sourceType)) {
    throw new DomainError('VALIDATION_ERROR', 'source_type 无效', 400);
  }
  const importance = text(input.importance) || 'normal';
  if (!IMPORTANCE.has(importance)) {
    throw new DomainError('VALIDATION_ERROR', 'importance 无效', 400);
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new DomainError('VALIDATION_ERROR', '事件提案至少需要一项变化', 400, { field: 'changes' });
  }
  const changes = input.changes.map(change => normalizeChange(bid, change));
  const chapterId = validateChapter(bid, input.chapter_id);
  const supersedesEventId = validateSupersedes(bid, input.supersedes_event_id);
  const createdBy = text(input.created_by) || 'author';
  if (!CREATED_BY.has(createdBy)) {
    throw new DomainError('VALIDATION_ERROR', 'created_by 无效', 400, { field: 'created_by' });
  }
  const confidence = input.confidence === undefined || input.confidence === null
    ? null
    : Number(input.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new DomainError('VALIDATION_ERROR', 'confidence 必须在 0 到 1 之间', 400);
  }
  const sourceRevisionHash = text(input.source_revision_hash);
  const dedupeKey = text(input.dedupe_key) || makeDedupeKey([
    sourceType,
    String(chapterId || ''),
    sourceRevisionHash,
    title,
    JSON.stringify(stable(changes)),
  ]);
  return {
    book_id: bid,
    title,
    summary: text(input.summary),
    chapter_id: chapterId,
    paragraph_index: input.paragraph_index === undefined || input.paragraph_index === null
      ? null
      : Math.max(0, Number(input.paragraph_index) || 0),
    narrative_sequence: Math.max(0, Number(input.narrative_sequence) || 0),
    importance,
    source_type: sourceType,
    source_revision_hash: sourceRevisionHash,
    source_quote: text(input.source_quote),
    confidence,
    extraction_model: text(input.extraction_model),
    dedupe_key: dedupeKey,
    supersedes_event_id: supersedesEventId,
    created_by: createdBy,
    created_via: text(input.created_via),
    created_session_id: text(input.created_session_id),
    created_model: text(input.created_model),
    job_id: text(input.job_id),
    changes,
  };
}

function changesFor(proposalId) {
  return db.all(
    'SELECT * FROM event_proposal_changes WHERE proposal_id = ? ORDER BY sort_order, id',
    [proposalId]
  ).map(row => ({
    ...row,
    old_value: parseJson(row.old_value_json),
    new_value: parseJson(row.new_value_json),
    metadata: parseJson(row.metadata_json) || {},
  }));
}

function getProposal(bookId, proposalId) {
  const bid = ensureBook(bookId);
  const id = positiveId(proposalId, 'proposal_id');
  const proposal = db.get(
    `SELECT p.*, c.title AS chapter_title
     FROM event_proposals p LEFT JOIN chapters c ON c.id = p.chapter_id
     WHERE p.id = ? AND p.book_id = ?`,
    [id, bid]
  );
  if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND', '事件提案不存在', 404);
  return { ...proposal, changes: changesFor(id) };
}

// 提案修订历史（评审 §6）：按 revision 升序返回快照，用于回溯编辑前的 changes。
function listProposalRevisions(bookId, proposalId) {
  const bid = ensureBook(bookId);
  const id = positiveId(proposalId, 'proposal_id');
  return db.all(
    `SELECT proposal_id, revision, title, summary, content_hash, edited_by, edit_note, created_at, changes_json
     FROM proposal_revisions WHERE proposal_id = ? AND book_id = ? ORDER BY revision`,
    [id, bid]
  ).map(row => ({ ...row, changes: parseJson(row.changes_json) || [], changes_json: undefined }));
}

function insertChanges(bookId, proposalId, changes) {
  changes.forEach((change, index) => {
    db.run(
      `INSERT INTO event_proposal_changes
       (proposal_id, book_id, change_kind, subject_ref, field_key,
        old_value_json, new_value_json, metadata_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposalId,
        bookId,
        change.change_kind,
        change.subject_ref,
        change.field_key,
        json(change.old_value),
        json(change.new_value),
        json(change.metadata),
        index,
      ]
    );
  });
}

// 内容哈希（评审 §3）：对提案实质内容做稳定哈希，用于确认期间检测提案是否被编辑。
// 不含 revision/status/时间戳等易变字段，只覆盖作者真正核对的正文与变化。
function computeContentHash(proposal) {
  return crypto.createHash('sha256').update(JSON.stringify(stable({
    title: proposal.title,
    summary: proposal.summary,
    chapter_id: proposal.chapter_id || null,
    paragraph_index: proposal.paragraph_index == null ? null : proposal.paragraph_index,
    narrative_sequence: proposal.narrative_sequence == null ? null : proposal.narrative_sequence,
    importance: proposal.importance,
    supersedes_event_id: proposal.supersedes_event_id || null,
    source_quote: proposal.source_quote || '',
    changes: (proposal.changes || []).map(change => ({
      change_kind: change.change_kind,
      subject_ref: change.subject_ref,
      field_key: change.field_key,
      old_value: change.old_value === undefined ? null : change.old_value,
      new_value: change.new_value === undefined ? null : change.new_value,
      metadata: change.metadata || {},
    })),
  }))).digest('hex');
}

// 提案编辑留痕（评审 §6）：每个 revision 保存一份快照，updateProposal 删除原 changes 后仍可回溯历史。
function snapshotRevision(proposal, editedBy, editNote) {
  db.run(
    `INSERT OR REPLACE INTO proposal_revisions
     (proposal_id, book_id, revision, title, summary, changes_json, content_hash, edited_by, edit_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      proposal.id, proposal.book_id, Number(proposal.revision || 1),
      proposal.title || '', proposal.summary || '', json(proposal.changes || []),
      proposal.content_hash || '', text(editedBy), text(editNote), new Date().toISOString(),
    ]
  );
}

// 乐观锁（评审 §3）：确认/编辑期间提案可能被他人改动，expected_revision 不符则拒绝，
// 避免“用户确认的是旧内容、实际采纳/覆盖的是新内容”。
function ensureRevisionMatch(proposal, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return;
  if (Number(expectedRevision) !== Number(proposal.revision)) {
    throw new DomainError('PROPOSAL_VERSION_CONFLICT', '提案已被修改，请基于最新版本重试', 409, {
      proposal_id: proposal.id,
      expected_revision: Number(expectedRevision),
      actual_revision: Number(proposal.revision),
    });
  }
}

// 采纳时的来源验票（A-1 / G5 审计 P1-1 兜底）：带章节来源的提案，采纳前重算**当前正文**
// 哈希与落库时的 source_revision_hash 比对；不一致说明提案依据的正文已经变化——放行等于
// 把改稿前的旧事实按「当前事实」写进正典，因此一律 409（SOURCE_CHANGED 家族）、不写
// story_event、不改正典。此层覆盖修复前已存在的旧待审提案与任何未来旁路，allow_stale 不能绕过。
// 手工/Agent 提案没有来源哈希可核（source_revision_hash 为空）时不改变既有语义。
function assertSourceCurrent(proposal) {
  if (!proposal.chapter_id) return;
  const expected = text(proposal.source_revision_hash);
  if (!expected) return;
  const row = db.get(
    'SELECT content FROM chapters WHERE id = ? AND book_id = ?',
    [Number(proposal.chapter_id), Number(proposal.book_id)]
  );
  const currentHash = row ? revision(row.content) : null;
  if (!row || currentHash !== expected) {
    throw new DomainError(
      'SOURCE_CHANGED',
      row
        ? '提案依据的正文已在生成后发生变化，请按当前正文重新抽取后再采纳'
        : '提案依据的章节已不存在，来源无法核验；请驳回该提案',
      409,
      { chapter_id: proposal.chapter_id, expected_hash: expected, current_hash: currentHash }
    );
  }
}

function createProposal(bookId, input = {}) {
  return db.transaction(() => createProposalInTransaction(bookId, input));
}

// 单条创建内核（**不自行开事务**）：供 createProposal（自开事务）与抽取端
// 「核验与整批写入同一同步事务」共用——db 不支持嵌套事务，抽取端必须在自己的事务里
// 逐条创建（A-1：来源核验与写入之间不得有 await，否则守卫形同虚设）。
function createProposalInTransaction(bookId, input = {}) {
  const proposal = normalizeProposal(bookId, input);
  const existing = db.get(
    'SELECT id FROM event_proposals WHERE book_id = ? AND dedupe_key = ?',
    [proposal.book_id, proposal.dedupe_key]
  );
  if (existing) return getProposal(proposal.book_id, existing.id);

  const createdAt = new Date().toISOString();
  const result = db.run(
    `INSERT INTO event_proposals
     (book_id, title, summary, chapter_id, paragraph_index, narrative_sequence,
      importance, source_type, source_revision_hash, source_quote, confidence,
      extraction_model, status, dedupe_key, supersedes_event_id,
      created_by, created_via, created_session_id, created_model, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      proposal.book_id,
      proposal.title,
      proposal.summary,
      proposal.chapter_id,
      proposal.paragraph_index,
      proposal.narrative_sequence,
      proposal.importance,
      proposal.source_type,
      proposal.source_revision_hash,
      proposal.source_quote,
      proposal.confidence,
      proposal.extraction_model,
      proposal.dedupe_key,
      proposal.supersedes_event_id,
      proposal.created_by,
      proposal.created_via,
      proposal.created_session_id,
      proposal.created_model,
      proposal.job_id,
      createdAt,
    ]
  );
  insertChanges(proposal.book_id, result.lastInsertRowid, proposal.changes);
  const created = getProposal(proposal.book_id, result.lastInsertRowid);
  // revision 默认 1；计算内容哈希并留痕首版快照
  const contentHash = computeContentHash(created);
  db.run('UPDATE event_proposals SET content_hash = ? WHERE id = ? AND book_id = ?',
    [contentHash, created.id, created.book_id]);
  created.content_hash = contentHash;
  snapshotRevision(created, created.created_by || 'author', '');
  return created;
}

function proposalClauses(bid, filters) {
  const clauses = ['p.book_id = ?'];
  const params = [bid];
  if (filters.status) {
    const statuses = String(filters.status).split(',').map(text).filter(value => STATUSES.has(value));
    if (statuses.length) {
      clauses.push(`p.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (filters.chapter_id) {
    clauses.push('p.chapter_id = ?');
    params.push(positiveId(filters.chapter_id, 'chapter_id'));
  }
  if (filters.source_type) {
    clauses.push('p.source_type = ?');
    params.push(text(filters.source_type));
  }
  return { clauses, params };
}

function listProposals(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const { clauses, params } = proposalClauses(bid, filters);
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
  const rows = db.all(
    `SELECT p.id FROM event_proposals p
     WHERE ${clauses.join(' AND ')}
     ORDER BY CASE p.status WHEN 'stale' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       p.chapter_id, p.id
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(row => getProposal(bid, row.id));
}

// 分页提案列表（方向报告 2.2）：统一 { items, total, next_cursor, truncated }，
// 与 getTimelinePage 同构——集合工具截断必须显式告知剩余量。
function listProposalPage(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const { clauses, params } = proposalClauses(bid, filters);
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
  const total = db.get(
    `SELECT COUNT(*) AS n FROM event_proposals p WHERE ${clauses.join(' AND ')}`,
    params
  ).n;
  const items = listProposals(bookId, { ...filters, limit, offset });
  const consumed = offset + items.length;
  return {
    items,
    total,
    truncated: consumed < total,
    next_cursor: consumed < total ? consumed : null,
  };
}

function ensureEditable(proposal) {
  if (!['pending', 'stale'].includes(proposal.status)) {
    throw new DomainError('PROPOSAL_NOT_EDITABLE', '只有待确认或失效提案可以编辑', 409);
  }
}

function updateProposal(bookId, proposalId, patch = {}, options = {}) {
  const proposal = getProposal(bookId, proposalId);
  ensureEditable(proposal);
  ensureRevisionMatch(proposal, options.expected_revision !== undefined ? options.expected_revision : patch.expected_revision);
  const fields = [];
  const params = [];
  for (const field of ['title', 'summary', 'source_quote', 'review_note']) {
    if (patch[field] === undefined) continue;
    const value = text(patch[field]);
    if (field === 'title' && !value) throw new DomainError('VALIDATION_ERROR', '提案标题不能为空', 400);
    fields.push(`${field} = ?`);
    params.push(value);
  }
  for (const field of ['paragraph_index', 'narrative_sequence']) {
    if (patch[field] === undefined) continue;
    fields.push(`${field} = ?`);
    params.push(Math.max(0, Number(patch[field]) || 0));
  }
  if (patch.importance !== undefined) {
    const value = text(patch.importance);
    if (!IMPORTANCE.has(value)) throw new DomainError('VALIDATION_ERROR', 'importance 无效', 400);
    fields.push('importance = ?');
    params.push(value);
  }
  if (patch.chapter_id !== undefined) {
    fields.push('chapter_id = ?');
    params.push(validateChapter(proposal.book_id, patch.chapter_id));
  }
  const changes = patch.changes === undefined ? null : patch.changes.map(change => normalizeChange(proposal.book_id, change));
  if (changes && !changes.length) throw new DomainError('VALIDATION_ERROR', '提案至少需要一项变化', 400);

  return db.transaction(() => {
    if (fields.length) {
      params.push(proposal.id, proposal.book_id);
      db.run(
        `UPDATE event_proposals SET ${fields.join(', ')} WHERE id = ? AND book_id = ?`,
        params
      );
    }
    if (changes) {
      db.run('DELETE FROM event_proposal_changes WHERE proposal_id = ?', [proposal.id]);
      insertChanges(proposal.book_id, proposal.id, changes);
    }
    const merged = getProposal(proposal.book_id, proposal.id);
    const newHash = computeContentHash(merged);
    // 内容未变则不递增 revision，避免无谓地让待确认凭证失效
    if (newHash === proposal.content_hash) return merged;
    const nextRevision = Number(proposal.revision || 1) + 1;
    db.run('UPDATE event_proposals SET revision = ?, content_hash = ? WHERE id = ? AND book_id = ?',
      [nextRevision, newHash, proposal.id, proposal.book_id]);
    merged.revision = nextRevision;
    merged.content_hash = newHash;
    snapshotRevision(merged, options.edited_by || options.actor || 'author', text(patch.review_note) || text(options.edit_note));
    return merged;
  });
}

function acceptProposal(bookId, proposalId, options = {}) {
  const bid = ensureBook(bookId);
  return db.transaction(() => {
    const proposal = getProposal(bid, proposalId);
    if (proposal.status === 'accepted') {
      return { proposal, event_id: proposal.accepted_event_id, idempotent: true };
    }
    ensureEditable(proposal);
    ensureRevisionMatch(proposal, options.expected_revision);
    // A-1 兜底（P1-1）：采纳这一刻来源必须仍然一致——旧来源提案（含修复前遗留的 pending 行）
    // 一律 409 SOURCE_CHANGED 拒绝，不写 story_event；allow_stale 也不能绕过这一层。
    assertSourceCurrent(proposal);
    if (proposal.status === 'stale' && options.allow_stale !== true) {
      throw new DomainError('PROPOSAL_STALE', '来源正文已经变化，请先核对提案', 409);
    }
    // 采纳即写正典：修正提案（带 supersedes_event_id）走修正事务生成替代事件并重建投影；
    // 普通提案走增量提交。历史回填按章节顺序重放，LLM 填的 old_value 与当前投影不一致是常态，不阻断采纳。
    const payload = {
      title: proposal.title,
      summary: proposal.summary,
      chapter_id: proposal.chapter_id,
      paragraph_index: proposal.paragraph_index,
      narrative_sequence: proposal.narrative_sequence,
      importance: proposal.importance,
      origin: 'proposal',
      source_revision_hash: proposal.source_revision_hash,
      source_quote: proposal.source_quote,
      changes: proposal.changes,
    };
    const result = proposal.supersedes_event_id
      ? ledger.correctEventInTransaction(bid, proposal.supersedes_event_id, payload, options.actor || 'author')
      : ledger.commitEventInTransaction(bid, payload, options.actor || 'author', proposal.source_type === 'history_backfill' ? { checkOld: false } : {});
    db.run(
      `UPDATE event_proposals
       SET status = 'accepted', accepted_event_id = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND book_id = ?`,
      [
        result.event.id,
        text(options.review_note),
        text(options.actor) || 'author',
        new Date().toISOString(),
        proposal.id,
        bid,
      ]
    );
    return {
      proposal: getProposal(bid, proposal.id),
      event: result.event,
      event_id: result.event.id,
      idempotent: false,
    };
  });
}

function rejectProposal(bookId, proposalId, options = {}) {
  const proposal = getProposal(bookId, proposalId);
  if (proposal.status === 'rejected') return { proposal, idempotent: true };
  ensureEditable(proposal);
  ensureRevisionMatch(proposal, options.expected_revision);
  db.run(
    `UPDATE event_proposals
     SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?
     WHERE id = ? AND book_id = ?`,
    [text(options.review_note), text(options.actor) || 'author', new Date().toISOString(), proposal.id, proposal.book_id]
  );
  return { proposal: getProposal(proposal.book_id, proposal.id), idempotent: false };
}

function markStale(bookId, proposalId, note = '') {
  const proposal = getProposal(bookId, proposalId);
  if (!['pending', 'stale'].includes(proposal.status)) return proposal;
  db.run(
    `UPDATE event_proposals SET status = 'stale', review_note = ?
     WHERE id = ? AND book_id = ?`,
    [text(note), proposal.id, proposal.book_id]
  );
  return getProposal(proposal.book_id, proposal.id);
}

function mergeProposal(bookId, proposalId, targetProposalId, mergedInput = {}, options = {}) {
  const bid = ensureBook(bookId);
  const source = getProposal(bid, proposalId);
  const target = getProposal(bid, targetProposalId);
  if (source.id === target.id) throw new DomainError('VALIDATION_ERROR', '不能合并到自身', 400);
  ensureEditable(source);
  ensureEditable(target);
  // 乐观锁（D1-04）：合并会用 mergedInput 覆盖 target 的内容，必须校验「确认所见即所纳」。
  // target 是内容被覆盖方（强制，语义同 accept/update）；source 可选校验，防其在合并前被并发改动。
  // 兼容两种传法：options.expected_revision（路由透传 body）或 mergedInput.expected_revision。
  ensureRevisionMatch(target, options.expected_revision !== undefined ? options.expected_revision : mergedInput.expected_revision);
  ensureRevisionMatch(source, options.expected_source_revision);
  const merged = {
    title: mergedInput.title === undefined ? target.title : mergedInput.title,
    summary: mergedInput.summary === undefined ? target.summary : mergedInput.summary,
    changes: mergedInput.changes === undefined ? target.changes : mergedInput.changes,
  };
  const normalizedTitle = text(merged.title);
  if (!normalizedTitle || !Array.isArray(merged.changes) || !merged.changes.length) {
    throw new DomainError('VALIDATION_ERROR', '合并后的标题和变化不能为空', 400);
  }
  const changes = merged.changes.map(change => normalizeChange(bid, change));

  return db.transaction(() => {
    db.run(
      'UPDATE event_proposals SET title = ?, summary = ? WHERE id = ? AND book_id = ?',
      [normalizedTitle, text(merged.summary), target.id, bid]
    );
    db.run('DELETE FROM event_proposal_changes WHERE proposal_id = ?', [target.id]);
    insertChanges(bid, target.id, changes);
    db.run(
      `UPDATE event_proposals
       SET status = 'merged', merged_into_id = ?, reviewed_at = ?
       WHERE id = ? AND book_id = ?`,
      [target.id, new Date().toISOString(), source.id, bid]
    );
    // 合并后重算 target 的 content_hash 与 revision（D1-04）：否则 target 内容已变而 hash 仍是旧的，
    // 后续 accept 的乐观锁会基于过期 hash 失效，且修订历史缺失这次合并。逻辑对齐 updateProposal。
    const mergedTarget = getProposal(bid, target.id);
    const newHash = computeContentHash(mergedTarget);
    if (newHash !== target.content_hash) {
      const nextRevision = Number(target.revision || 1) + 1;
      db.run('UPDATE event_proposals SET revision = ?, content_hash = ? WHERE id = ? AND book_id = ?',
        [nextRevision, newHash, target.id, bid]);
      mergedTarget.revision = nextRevision;
      mergedTarget.content_hash = newHash;
      snapshotRevision(mergedTarget, options.actor || 'author', text(mergedInput.review_note) || `合并提案 #${source.id}`);
    }
    return {
      source: getProposal(bid, source.id),
      target: getProposal(bid, target.id),
    };
  });
}

function batchReview(bookId, input = {}) {
  const action = text(input.action);
  if (!['accept', 'reject'].includes(action)) {
    throw new DomainError('VALIDATION_ERROR', '批量动作必须是 accept 或 reject', 400);
  }
  const ids = Array.isArray(input.proposal_ids)
    ? [...new Set(input.proposal_ids.map(value => positiveId(value, 'proposal_id')))]
    : [];
  if (!ids.length) throw new DomainError('VALIDATION_ERROR', '请选择至少一个提案', 400);
  // 乐观锁透传（D1-04）：批量评审此前完全绕过 expected_revision，「确认所见即所纳」在这条路径失效。
  // 支持可选的 expected_revisions 映射 { proposalId: revision }，逐项透传给 accept/reject；
  // 未提供某项则该提案不校验（向后兼容 ensureRevisionMatch 的空值跳过语义）。
  const revisions = (input.expected_revisions && typeof input.expected_revisions === 'object')
    ? input.expected_revisions : {};
  return ids.map(id => {
    try {
      const expected_revision = revisions[id];
      const result = action === 'accept'
        ? acceptProposal(bookId, id, {
          allow_stale: input.allow_stale === true,
          review_note: input.review_note,
          actor: input.actor,
          expected_revision,
        })
        : rejectProposal(bookId, id, { review_note: input.review_note, actor: input.actor, expected_revision });
      return { id, ok: true, event_id: result.event_id || null };
    } catch (err) {
      if (err instanceof DomainError) {
        return {
          id,
          ok: false,
          error: { code: err.code, message: err.message, details: err.details },
        };
      }
      throw err;
    }
  });
}

// 一次性驳回某次任务（job_id）产生的全部待审提案（评审 §6）：回填出错时整批撤销，
// 仅影响 pending/stale，不动已 accepted/rejected/merged。返回被驳回的提案 id 列表，供审计与前端提示。
function rejectProposalsByJob(bookId, jobId, options = {}) {
  const bid = ensureBook(bookId);
  const job = text(jobId);
  if (!job) throw new DomainError('VALIDATION_ERROR', 'job_id 不能为空', 400, { field: 'job_id' });
  const note = text(options.review_note) || `批量驳回任务 ${job} 产生的提案`;
  const rows = db.all(
    `SELECT id FROM event_proposals
     WHERE book_id = ? AND job_id = ? AND status IN ('pending', 'stale') ORDER BY id`,
    [bid, job]
  );
  return db.transaction(() => {
    const rejected = [];
    for (const row of rows) {
      rejectProposal(bid, row.id, { review_note: note, actor: options.actor });
      rejected.push(row.id);
    }
    return { job_id: job, rejected_proposal_ids: rejected, count: rejected.length };
  });
}

module.exports = {
  createProposal,
  createProposalInTransaction,
  getProposal,
  listProposalRevisions,
  listProposals,
  listProposalPage,
  updateProposal,
  acceptProposal,
  rejectProposal,
  markStale,
  mergeProposal,
  batchReview,
  rejectProposalsByJob,
};
