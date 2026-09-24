const crypto = require('crypto');
const db = require('../db');
const { DomainError } = require('./errors');

const IMPORTANCE = new Set(['low', 'normal', 'high', 'critical']);
const ORIGINS = new Set(['manual', 'proposal', 'advisor', 'import']);
const VALUE_TYPES = new Set(['text', 'enum', 'list', 'level']);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function positiveId(value, field, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
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

function json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function sameJson(left, right) {
  return json(left) === json(right);
}

// 共享值归一化（评审 §1 硬化A）：提案创建/更新与事件提交共用同一套形状规则，old_value 与 new_value 同归一。
// 只做形状归一（list 单值包装为数组 + 逐项裁剪去空），不做 enum 成员校验——种子字段 options 为空，
// 成员校验会误伤既有正典；类型合法性由各层其余校验（字段存在性、list 结构）保证。
function normalizeStateValue(definition, value) {
  if (value === undefined) return null;
  const type = definition && definition.value_type;
  if (type === 'list') {
    if (value === null) return null;
    const arr = Array.isArray(value) ? value : [value];
    return arr
      .map(item => (typeof item === 'string' ? item.trim() : item))
      .filter(item => item !== '' && item !== null && item !== undefined);
  }
  return value;
}

// STALE_OLD_VALUE 详情补充当前值来源事件的叙事位置（评审 §2）：模型据此判断“候选事实”与“当前值”
// 孰先孰后，而不是把 actual 直接写回 old_value 后重试——那会把并发冲突伪装成合法倒退。
function staleDetails(fieldKey, expected, actual, current) {
  const details = { field_key: fieldKey, expected, actual };
  const actualEventId = current ? (current.last_event_id || null) : null;
  details.actual_event_id = actualEventId;
  if (actualEventId) {
    const src = db.get(
      `SELECT e.id, e.chapter_id, e.narrative_sequence, c.title AS chapter_title
       FROM story_events e LEFT JOIN chapters c ON c.id = e.chapter_id
       WHERE e.id = ?`,
      [actualEventId]
    );
    if (src) {
      details.actual_event_ref = {
        event_id: src.id,
        chapter_id: src.chapter_id,
        chapter_title: src.chapter_title,
        narrative_sequence: src.narrative_sequence,
      };
    }
  }
  return details;
}

function stateProjection(bookId, characterId, fieldKey) {
  const row = db.get(
    `SELECT value_json, source_event_id, last_event_id
     FROM character_state_values
     WHERE book_id = ? AND character_id = ? AND field_key = ?`,
    [bookId, characterId, fieldKey]
  );
  return row ? { ...row, value: parseJson(row.value_json) } : null;
}

function validateStateChange(bookId, raw, options = {}) {
  const characterId = positiveId(raw.subject_ref, 'subject_ref');
  const character = db.get(
    'SELECT id FROM characters WHERE id = ? AND book_id = ?',
    [characterId, bookId]
  );
  if (!character) {
    throw new DomainError(
      'CROSS_BOOK_REFERENCE',
      '状态变化中的人物不属于当前书籍',
      400,
      { field: 'subject_ref' }
    );
  }
  const fieldKey = text(raw.field_key);
  if (!fieldKey || fieldKey === 'relation') {
    throw new DomainError(
      'INVALID_STATE_FIELD',
      '关系不能作为人物状态字段',
      400,
      { field: 'field_key' }
    );
  }
  const definition = db.get(
    `SELECT * FROM state_field_definitions
     WHERE book_id = ? AND field_key = ? AND enabled = 1`,
    [bookId, fieldKey]
  );
  if (!definition) {
    throw new DomainError(
      'STATE_FIELD_NOT_FOUND',
      `状态字段“${fieldKey}”不存在或未启用`,
      400,
      { field: 'field_key' }
    );
  }
  // 值归一化（评审 §1 硬化A）：list 型自动包装为数组，old_value 与 new_value 同时归一，
  // 使提案层与账本层用同一套形状规则，避免“list 类型直到采纳才校验”的延迟爆炸。
  const newValue = normalizeStateValue(definition, raw.new_value);
  const hasOld = Object.hasOwn(raw, 'old_value');
  const oldValue = hasOld ? normalizeStateValue(definition, raw.old_value) : null;
  const current = stateProjection(bookId, characterId, fieldKey);
  const currentValue = current ? current.value : null;
  if (options.checkOld !== false && hasOld && !sameJson(oldValue, currentValue)) {
    throw new DomainError(
      'STALE_OLD_VALUE',
      `“${definition.label}”的当前值已经变化`,
      409,
      staleDetails(fieldKey, oldValue, currentValue, current)
    );
  }
  return {
    change_kind: 'character_state',
    subject_ref: String(characterId),
    field_key: fieldKey,
    old_value: hasOld ? oldValue : currentValue,
    new_value: newValue,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
}

function normalizeChange(bookId, raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new DomainError('VALIDATION_ERROR', '事件变化必须是对象', 400, { field: 'changes' });
  }
  const kind = text(raw.change_kind);
  if (kind === 'character_state') return validateStateChange(bookId, raw, options);
  if (kind === 'relation') {
    const relations = require('./relations');
    return relations.normalizeRelationChange(bookId, raw, options);
  }
  throw new DomainError('VALIDATION_ERROR', 'change_kind 无效', 400, { field: 'change_kind' });
}

function normalizeEvent(bookId, input = {}, options = {}) {
  const bid = ensureBook(bookId);
  const title = text(input.title);
  if (!title) throw new DomainError('VALIDATION_ERROR', '事件标题不能为空', 400, { field: 'title' });
  const importance = text(input.importance) || 'normal';
  if (!IMPORTANCE.has(importance)) {
    throw new DomainError('VALIDATION_ERROR', 'importance 无效', 400, { field: 'importance' });
  }
  const origin = text(input.origin) || options.defaultOrigin || 'manual';
  if (!ORIGINS.has(origin)) {
    throw new DomainError('VALIDATION_ERROR', 'origin 无效', 400, { field: 'origin' });
  }
  const chapterId = positiveId(input.chapter_id, 'chapter_id', true);
  if (chapterId && !db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bid])) {
    throw new DomainError(
      'CROSS_BOOK_REFERENCE',
      '事件章节不属于当前书籍',
      400,
      { field: 'chapter_id' }
    );
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new DomainError('VALIDATION_ERROR', '故事事件至少需要一项变化', 400, { field: 'changes' });
  }
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
    origin,
    supersedes_event_id: options.supersedesEventId || null,
    source_revision_hash: text(input.source_revision_hash),
    source_quote: text(input.source_quote),
    changes: input.changes.map(change => normalizeChange(bid, change, {
      checkOld: options.checkOld,
    })),
  };
}

function applyStateProjection(bookId, eventId, change) {
  const characterId = Number(change.subject_ref);
  if (change.new_value === null) {
    db.run(
      `DELETE FROM character_state_values
       WHERE book_id = ? AND character_id = ? AND field_key = ?`,
      [bookId, characterId, change.field_key]
    );
    return;
  }
  db.run(
    `INSERT INTO character_state_values
     (book_id, character_id, field_key, value_json, source_event_id, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, character_id, field_key) DO UPDATE SET
       value_json = excluded.value_json,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [bookId, characterId, change.field_key, json(change.new_value), eventId, eventId, new Date().toISOString()]
  );
}

function applyProjection(bookId, eventId, change) {
  if (change.change_kind === 'character_state') {
    return applyStateProjection(bookId, eventId, change);
  }
  if (change.change_kind === 'relation') {
    return require('./relations').applyRelationProjection(bookId, eventId, change);
  }
  throw new DomainError('VALIDATION_ERROR', '未知变化类型', 400);
}

function stateChecksum(bookId) {
  const rows = db.all(
    `SELECT character_id, field_key, value_json, source_event_id, last_event_id
     FROM character_state_values WHERE book_id = ?
     ORDER BY character_id, field_key`,
    [bookId]
  );
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function updateStateWatermark(bookId, lastEventId, rebuiltAt = null) {
  db.run(
    `INSERT INTO projection_watermarks
     (book_id, projection_name, last_event_id, rebuilt_at, checksum)
     VALUES (?, 'character_state', ?, ?, ?)
     ON CONFLICT(book_id, projection_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       rebuilt_at = excluded.rebuilt_at,
       checksum = excluded.checksum`,
    [bookId, lastEventId || 0, rebuiltAt, stateChecksum(bookId)]
  );
}

function insertEventRows(event, actor, applyProjection) {
  const createdAt = new Date().toISOString();
  const result = db.run(
    `INSERT INTO story_events
     (book_id, title, summary, chapter_id, paragraph_index, narrative_sequence,
      importance, origin, supersedes_event_id, source_revision_hash, source_quote,
      source_stale, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      event.book_id,
      event.title,
      event.summary,
      event.chapter_id,
      event.paragraph_index,
      event.narrative_sequence,
      event.importance,
      event.origin,
      event.supersedes_event_id,
      event.source_revision_hash,
      event.source_quote,
      text(actor) || 'author',
      createdAt,
    ]
  );
  const eventId = result.lastInsertRowid;
  event.changes.forEach((change, index) => {
    db.run(
      `INSERT INTO story_event_changes
       (event_id, book_id, change_kind, subject_ref, field_key,
        old_value_json, new_value_json, metadata_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        event.book_id,
        change.change_kind,
        change.subject_ref,
        change.field_key,
        json(change.old_value),
        json(change.new_value),
        json(change.metadata),
        index,
      ]
    );
    if (applyProjection) applyProjectionChange(event.book_id, eventId, change);
  });
  if (applyProjection) {
    if (event.changes.some(change => change.change_kind === 'character_state')) {
      updateStateWatermark(event.book_id, eventId);
    }
    if (event.changes.some(change => change.change_kind === 'relation')) {
      require('./relations').updateRelationWatermark(event.book_id, eventId);
    }
  }
  return eventId;
}

function getEvent(bookId, eventId) {
  const bid = ensureBook(bookId);
  const eid = positiveId(eventId, 'event_id');
  const event = db.get(
    `SELECT e.*, c.title AS chapter_title, c.sort_order AS chapter_sort_order,
       c.volume_id AS volume_id, v.title AS volume_title, v.sort_order AS volume_sort_order,
       (SELECT id FROM story_events s WHERE s.supersedes_event_id = e.id ORDER BY s.id DESC LIMIT 1)
         AS superseded_by_event_id
     FROM story_events e
     LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE e.id = ? AND e.book_id = ?`,
    [eid, bid]
  );
  if (!event) throw new DomainError('EVENT_NOT_FOUND', '故事事件不存在', 404);
  const changes = db.all(
    'SELECT * FROM story_event_changes WHERE event_id = ? ORDER BY sort_order, id',
    [eid]
  ).map(change => ({
    ...change,
    old_value: parseJson(change.old_value_json),
    new_value: parseJson(change.new_value_json),
    metadata: parseJson(change.metadata_json) || {},
  }));
  return { ...event, changes };
}

// 叙事最末判定：在所有「未被取代」的有效事件里，按叙事序（无章最后→卷序→章序→narrative_sequence→id）
// 找出触及某 (角色,字段) / 某关系的最后一个事件 id。增量投影是 last-write-wins by commit order，
// 若刚提交的事件并非叙事最末，它会把更晚事件的值覆盖掉 → 需重建该类投影。
function latestStateEventId(bookId, characterId, fieldKey) {
  const rows = db.all(
    `SELECT e.id FROM story_events e
     LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE e.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
       AND EXISTS (SELECT 1 FROM story_event_changes ec
         WHERE ec.event_id = e.id AND ec.change_kind = 'character_state'
           AND ec.subject_ref = ? AND ec.field_key = ?)
     ORDER BY CASE WHEN e.chapter_id IS NULL THEN 1 ELSE 0 END,
       COALESCE(v.sort_order, 2147483647), COALESCE(c.sort_order, 2147483647),
       e.narrative_sequence, e.id`,
    [bookId, String(characterId), fieldKey]
  );
  return rows.length ? rows[rows.length - 1].id : null;
}

function latestRelationEventId(bookId, publicId) {
  // 卷序前置（D1-02）：与 effectiveEvents 一致，否则多卷书乱序保护误判、关系投影滞留旧值。
  const rows = db.all(
    `SELECT e.id FROM story_events e
     LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE e.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
       AND EXISTS (SELECT 1 FROM story_event_changes ec
         WHERE ec.event_id = e.id AND ec.change_kind = 'relation' AND ec.subject_ref = ?)
     ORDER BY CASE WHEN e.chapter_id IS NULL THEN 1 ELSE 0 END,
       COALESCE(v.sort_order, 2147483647), COALESCE(c.sort_order, 2147483647),
       e.narrative_sequence, e.id`,
    [bookId, String(publicId)]
  );
  return rows.length ? rows[rows.length - 1].id : null;
}

function commitEventInTransaction(bookId, input, actor = 'author', options = {}) {
  const checkOld = options.checkOld !== false;
  const event = normalizeEvent(bookId, input, { checkOld });
  event.changes = event.changes.map(change => normalizeChange(event.book_id, change, { checkOld }));
  const eventId = insertEventRows(event, actor, true);
  // 乱序保护：若新事件对某 (角色,字段) 或某关系不是叙事最末，增量投影已把更晚事件的值覆盖，
  // 重建对应投影，使「当前状态」始终等于叙事序最新的有效事件（与 correctEvent/rebuildProjections 一致）。
  let stateRebuilt = false;
  let relationRebuilt = false;
  for (const change of event.changes) {
    if (change.change_kind === 'character_state') {
      if (!stateRebuilt && latestStateEventId(event.book_id, Number(change.subject_ref), change.field_key) !== eventId) {
        rebuildStateProjectionInternal(event.book_id);
        stateRebuilt = true;
      }
    } else if (change.change_kind === 'relation') {
      if (!relationRebuilt && latestRelationEventId(event.book_id, change.subject_ref) !== eventId) {
        require('./relations').rebuildRelationProjectionInternal(event.book_id);
        relationRebuilt = true;
      }
    }
  }
  return {
    event: getEvent(event.book_id, eventId),
    projections: {
      character_states: event.changes
        .filter(change => change.change_kind === 'character_state')
        .map(change => stateProjection(event.book_id, Number(change.subject_ref), change.field_key)),
    },
  };
}

function commitEvent(bookId, input, actor = 'author', options = {}) {
  return db.transaction(() => commitEventInTransaction(bookId, input, actor, options));
}

function effectiveEvents(bookId) {
  return db.all(
    `SELECT e.id
     FROM story_events e
     LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE e.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
     ORDER BY
       CASE WHEN e.chapter_id IS NULL THEN 1 ELSE 0 END,
       COALESCE(v.sort_order, 2147483647),
       COALESCE(c.sort_order, 2147483647),
       e.narrative_sequence,
       e.id`,
    [bookId]
  );
}

function rebuildStateProjectionInternal(bookId) {
  db.run('DELETE FROM character_state_values WHERE book_id = ?', [bookId]);
  let lastEventId = 0;
  for (const item of effectiveEvents(bookId)) {
    const changes = db.all(
      `SELECT * FROM story_event_changes
       WHERE event_id = ? AND change_kind = 'character_state'
       ORDER BY sort_order, id`,
      [item.id]
    );
    for (const row of changes) {
      applyStateProjection(bookId, item.id, {
        subject_ref: row.subject_ref,
        field_key: row.field_key,
        new_value: parseJson(row.new_value_json),
      });
    }
    lastEventId = Math.max(lastEventId, item.id);
  }
  const rebuiltAt = new Date().toISOString();
  updateStateWatermark(bookId, lastEventId, rebuiltAt);
  return {
    projection: 'character_state',
    last_event_id: lastEventId,
    checksum: stateChecksum(bookId),
    rebuilt_at: rebuiltAt,
  };
}

const applyProjectionChange = applyProjection;

// 只读重放：按叙事序（与 rebuildStateProjectionInternal 同源同序）重放有效事件，
// 计算每个 (角色,字段) 的期望当前值与末事件 id，不写库。供状态体检对比投影一致性（评审 §5）。
function computeExpectedStates(bookId) {
  const bid = ensureBook(bookId);
  const expected = new Map();
  for (const item of effectiveEvents(bid)) {
    const changes = db.all(
      `SELECT subject_ref, field_key, new_value_json FROM story_event_changes
       WHERE event_id = ? AND change_kind = 'character_state' ORDER BY sort_order, id`,
      [item.id]
    );
    for (const row of changes) {
      const value = parseJson(row.new_value_json);
      const key = `${Number(row.subject_ref)}:${row.field_key}`;
      if (value === null) expected.delete(key);
      else expected.set(key, { character_id: Number(row.subject_ref), field_key: row.field_key, value, last_event_id: item.id });
    }
  }
  return expected;
}

function rebuildProjectionsInTransaction(bookId) {
  const bid = ensureBook(bookId);
  const characterState = rebuildStateProjectionInternal(bid);
  const relationProjection = require('./relations').rebuildRelationProjectionInternal(bid);
  return {
    ...characterState,
    character_state: characterState,
    relations: relationProjection,
  };
}

function rebuildProjections(bookId) {
  return db.transaction(() => rebuildProjectionsInTransaction(bookId));
}

// 结构性变更后的投影重建（方向报告 1.5）：章节移动/调序/删除、卷调序/删除都会改变
// effectiveEvents 的叙事排序（v.sort_order, c.sort_order 参与排序），但这些路由此前
// 不触发任何重建——重排后「人物当前状态」仍按旧顺序讲故事，且体检无「结构变了没重建」项。
// 结构操作低频、重放开销可控：路由内同步重建 + 观测日志，漂移源头就此关闭。
// 排序口径无需再合并：状态与关系重放同用 effectiveEvents（relations.js 已对齐注释）。
function rebuildProjectionsAfterStructureChange(bookId, reason) {
  const result = rebuildProjections(bookId);
  console.log(`[ledger] 结构变更触发投影重建 book=${bookId} reason=${reason} watermark=${result.last_event_id}`);
  return result;
}

// 修正事务内核（不包 db.transaction）：供 acceptProposal 在已有事务内路由修正提案复用。
// 生成带 supersedes_event_id 的替代事件（不应用增量投影）后全量重建投影，与 correctEvent 一致。
function correctEventInTransaction(bookId, eventId, replacement, actor = 'author') {
  const bid = ensureBook(bookId);
  const original = getEvent(bid, eventId);
  if (original.superseded_by_event_id) {
    throw new DomainError('EVENT_ALREADY_SUPERSEDED', '该事件已经被修正', 409, {
      superseded_by_event_id: original.superseded_by_event_id,
    });
  }
  const event = normalizeEvent(bid, replacement, {
    checkOld: false,
    supersedesEventId: original.id,
    defaultOrigin: 'manual',
  });
  const replacementId = insertEventRows(event, actor, false);
  const projection = {
    character_state: rebuildStateProjectionInternal(bid),
    relations: require('./relations').rebuildRelationProjectionInternal(bid),
  };
  return {
    event: getEvent(bid, replacementId),
    superseded_event_id: original.id,
    projection,
  };
}

function correctEvent(bookId, eventId, replacement, actor = 'author') {
  return db.transaction(() => correctEventInTransaction(bookId, eventId, replacement, actor));
}

// 追加式撤销（评审 §6）：修正链只能「替换错误事件」，无法「撤销一个本不该存在的事件」。
// retractEvent 追加一个带 supersedes_event_id、零 changes 的 retraction 事件后全量重建投影：
// 原事件记录保留（append-only，可审计回溯），但因被取代而不再参与有效事件重放，其状态变化被撤销。
// 撤销事件继承原事件的叙事位置（chapter_id/narrative_sequence），使撤销标记落在时间线原处。
function retractEventInTransaction(bookId, eventId, options = {}, actor = 'author') {
  const bid = ensureBook(bookId);
  const original = getEvent(bid, eventId);
  if (original.superseded_by_event_id) {
    throw new DomainError('EVENT_ALREADY_SUPERSEDED', '该事件已经被修正或撤销', 409, {
      superseded_by_event_id: original.superseded_by_event_id,
    });
  }
  const importance = text(options.importance);
  const retraction = {
    book_id: bid,
    title: text(options.title) || `撤销：${original.title}`,
    summary: text(options.summary) || text(options.reason)
      || `撤销事件 #${original.id}「${original.title}」，其状态变化不再生效。`,
    chapter_id: original.chapter_id,
    paragraph_index: original.paragraph_index,
    narrative_sequence: original.narrative_sequence,
    importance: IMPORTANCE.has(importance) ? importance : original.importance,
    origin: 'manual',
    supersedes_event_id: original.id,
    source_revision_hash: '',
    source_quote: text(options.source_quote),
    changes: [], // 零 changes：撤销不引入任何新状态，只让原事件退出有效重放
  };
  const retractionId = insertEventRows(retraction, actor, false); // 不做增量投影，改由全量重建
  const projection = {
    character_state: rebuildStateProjectionInternal(bid),
    relations: require('./relations').rebuildRelationProjectionInternal(bid),
  };
  return {
    event: getEvent(bid, retractionId),
    retracted_event_id: original.id,
    projection,
  };
}

function retractEvent(bookId, eventId, options = {}, actor = 'author') {
  return db.transaction(() => retractEventInTransaction(bookId, eventId, options, actor));
}

function timelineClauses(bid, filters) {
  const clauses = ['e.book_id = ?'];
  const params = [bid];
  if (filters.include_superseded !== true && filters.include_superseded !== 'true') {
    clauses.push('NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)');
  }
  if (filters.chapter_id) {
    clauses.push('e.chapter_id = ?');
    params.push(positiveId(filters.chapter_id, 'chapter_id'));
  }
  if (filters.importance) {
    clauses.push('e.importance = ?');
    params.push(text(filters.importance));
  }
  if (filters.origin) {
    clauses.push('e.origin = ?');
    params.push(text(filters.origin));
  }
  if (filters.character_id) {
    clauses.push(`EXISTS (
      SELECT 1 FROM story_event_changes ec
      WHERE ec.event_id = e.id
        AND ec.change_kind = 'character_state'
        AND ec.subject_ref = ?
    )`);
    params.push(String(positiveId(filters.character_id, 'character_id')));
  }
  if (filters.change_kind) {
    clauses.push('EXISTS (SELECT 1 FROM story_event_changes ec WHERE ec.event_id = e.id AND ec.change_kind = ?)');
    params.push(text(filters.change_kind));
  }
  if (filters.field_key) {
    clauses.push('EXISTS (SELECT 1 FROM story_event_changes ec WHERE ec.event_id = e.id AND ec.field_key = ?)');
    params.push(text(filters.field_key));
  }
  return { clauses, params };
}

const TIMELINE_FROM = `FROM story_events e
     LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id`;
const TIMELINE_ORDER = `ORDER BY CASE WHEN e.chapter_id IS NULL THEN 1 ELSE 0 END,
       COALESCE(v.sort_order, 2147483647), COALESCE(c.sort_order, 2147483647), e.narrative_sequence, e.id`;

function pageWindow(filters) {
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
  return { limit, offset };
}

function getTimeline(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const { clauses, params } = timelineClauses(bid, filters);
  const { limit, offset } = pageWindow(filters);
  const rows = db.all(
    `SELECT e.*, c.title AS chapter_title, c.sort_order AS chapter_sort_order
     ${TIMELINE_FROM}
     WHERE ${clauses.join(' AND ')}
     ${TIMELINE_ORDER}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(row => getEvent(bid, row.id));
}

// 分页时间线（方向报告 2.2）：集合工具统一 { items, total, next_cursor, truncated }，
// 模型不再面对「读了全量却不知被截断」的静默不完整列表。
function getTimelinePage(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const { clauses, params } = timelineClauses(bid, filters);
  const { limit, offset } = pageWindow(filters);
  const total = db.get(
    `SELECT COUNT(*) AS n ${TIMELINE_FROM} WHERE ${clauses.join(' AND ')}`,
    params
  ).n;
  const items = getTimeline(bookId, { ...filters, limit, offset });
  const consumed = offset + items.length;
  return {
    items,
    total,
    truncated: consumed < total,
    next_cursor: consumed < total ? consumed : null,
  };
}

function getCurrentStates(bookId, characterId) {
  const bid = ensureBook(bookId);
  const cid = positiveId(characterId, 'character_id');
  if (!db.get('SELECT id FROM characters WHERE id = ? AND book_id = ?', [cid, bid])) {
    throw new DomainError('CHARACTER_NOT_FOUND', '人物不存在', 404);
  }
  return db.all(
    `SELECT d.field_key, d.label, d.value_type, d.options_json, d.sort_order,
       v.value_json, v.source_event_id, v.last_event_id
     FROM state_field_definitions d
     LEFT JOIN character_state_values v
       ON v.book_id = d.book_id AND v.character_id = ? AND v.field_key = d.field_key
     WHERE d.book_id = ? AND d.enabled = 1
     ORDER BY d.sort_order, d.id`,
    [cid, bid]
  ).map(row => ({
    field_key: row.field_key,
    label: row.label,
    value_type: row.value_type,
    options: parseJson(row.options_json) || [],
    value: row.value_json === null ? null : parseJson(row.value_json),
    source_event_id: row.source_event_id || null,
    last_event_id: row.last_event_id || null,
  }));
}

function listStateFields(bookId) {
  const bid = ensureBook(bookId);
  return db.all(
    'SELECT * FROM state_field_definitions WHERE book_id = ? ORDER BY sort_order, id',
    [bid]
  ).map(row => ({ ...row, options: parseJson(row.options_json) || [] }));
}

function createStateField(bookId, input = {}) {
  const bid = ensureBook(bookId);
  const fieldKey = text(input.field_key);
  const label = text(input.label);
  const valueType = text(input.value_type) || 'text';
  if (!/^[a-z][a-z0-9_]*$/.test(fieldKey) || fieldKey === 'relation') {
    throw new DomainError('INVALID_STATE_FIELD', 'field_key 无效或被保留', 400, { field: 'field_key' });
  }
  if (!label || !VALUE_TYPES.has(valueType)) {
    throw new DomainError('VALIDATION_ERROR', '状态字段名称或类型无效', 400);
  }
  // 归一 options 为去空字符串数组；enum/level 必须提供非空候选项（评审 §1 强限制，中央校验）。
  // 种子的 enum/level 字段走直接 INSERT（不经此函数），不受此约束影响。
  const rawOptions = input.options === undefined || input.options === null ? [] : input.options;
  if (!Array.isArray(rawOptions)) {
    throw new DomainError('VALIDATION_ERROR', 'options 必须是数组', 400, { field: 'options' });
  }
  const options = rawOptions.map(option => text(option)).filter(Boolean);
  if ((valueType === 'enum' || valueType === 'level') && !options.length) {
    throw new DomainError('VALIDATION_ERROR', `${valueType} 类型字段必须提供非空 options 候选项`, 400, {
      field: 'options', value_type: valueType,
    });
  }
  const time = new Date().toISOString();
  try {
    const result = db.run(
      `INSERT INTO state_field_definitions
       (book_id, field_key, label, value_type, options_json, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bid,
        fieldKey,
        label,
        valueType,
        json(options),
        input.enabled === false ? 0 : 1,
        Number(input.sort_order) || 0,
        time,
        time,
      ]
    );
    return db.get('SELECT * FROM state_field_definitions WHERE id = ?', [result.lastInsertRowid]);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      throw new DomainError('STATE_FIELD_EXISTS', '状态字段已经存在', 409);
    }
    throw err;
  }
}

function updateStateField(bookId, fieldKey, patch = {}) {
  const bid = ensureBook(bookId);
  const key = text(fieldKey);
  const existing = db.get(
    'SELECT * FROM state_field_definitions WHERE book_id = ? AND field_key = ?',
    [bid, key]
  );
  if (!existing) throw new DomainError('STATE_FIELD_NOT_FOUND', '状态字段不存在', 404);
  const fields = [];
  const params = [];
  if (patch.value_type !== undefined && text(patch.value_type) !== existing.value_type) {
    const used = db.get(
      `SELECT 1 AS used FROM story_event_changes
       WHERE book_id = ? AND change_kind = 'character_state' AND field_key = ? LIMIT 1`,
      [bid, key]
    );
    if (used) throw new DomainError('STATE_FIELD_IN_USE', '已使用字段不能修改底层类型', 409);
    const valueType = text(patch.value_type);
    if (!VALUE_TYPES.has(valueType)) throw new DomainError('VALIDATION_ERROR', 'value_type 无效', 400);
    fields.push('value_type = ?');
    params.push(valueType);
  }
  if (patch.label !== undefined) {
    const label = text(patch.label);
    if (!label) throw new DomainError('VALIDATION_ERROR', '字段名称不能为空', 400);
    fields.push('label = ?');
    params.push(label);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.sort_order !== undefined) {
    fields.push('sort_order = ?');
    params.push(Number(patch.sort_order) || 0);
  }
  if (patch.options !== undefined) {
    if (!Array.isArray(patch.options)) throw new DomainError('VALIDATION_ERROR', 'options 必须是数组', 400);
    fields.push('options_json = ?');
    params.push(json(patch.options));
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString(), bid, key);
  db.run(
    `UPDATE state_field_definitions SET ${fields.join(', ')}
     WHERE book_id = ? AND field_key = ?`,
    params
  );
  return db.get(
    'SELECT * FROM state_field_definitions WHERE book_id = ? AND field_key = ?',
    [bid, key]
  );
}

module.exports = {
  commitEvent,
  commitEventInTransaction,
  correctEvent,
  correctEventInTransaction,
  retractEvent,
  retractEventInTransaction,
  getEvent,
  getTimeline,
  getTimelinePage,
  getCurrentStates,
  rebuildProjections,
  rebuildProjectionsInTransaction,
  rebuildProjectionsAfterStructureChange,
  listStateFields,
  createStateField,
  updateStateField,
  normalizeStateValue,
  computeExpectedStates,
};
