const crypto = require('crypto');
const db = require('../db');
const { DomainError } = require('./errors');

const DIRECTIONS = new Set(['none', 'a_to_b', 'b_to_a', 'both']);
const POLARITIES = new Set(['positive', 'neutral', 'negative', 'mixed']);
const LIFECYCLES = new Set(['active', 'dormant', 'ended']);
const SECRECY = new Set(['public', 'secret']);
const MUTABLE_FIELDS = new Set([
  'relation_type_id',
  'direction',
  'strength',
  'polarity',
  'lifecycle',
  'secrecy',
  'note',
]);

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

function getCharacter(bookId, characterId, field) {
  const id = positiveId(characterId, field);
  const row = db.get('SELECT id, name FROM characters WHERE id = ? AND book_id = ?', [id, bookId]);
  if (!row) throw new DomainError('CROSS_BOOK_REFERENCE', '关系人物不属于当前书籍', 400, { field });
  return row;
}

function getRelationType(bookId, relationTypeId) {
  const id = positiveId(relationTypeId, 'relation_type_id');
  const row = db.get(
    'SELECT * FROM relation_type_definitions WHERE id = ? AND book_id = ?',
    [id, bookId]
  );
  if (!row) {
    throw new DomainError('CROSS_BOOK_REFERENCE', '关系类型不属于当前书籍', 400, {
      field: 'relation_type_id',
    });
  }
  return row;
}

function generatePublicId() {
  return `rel_${crypto.randomBytes(8).toString('hex')}`;
}

function reverseDirection(direction) {
  if (direction === 'a_to_b') return 'b_to_a';
  if (direction === 'b_to_a') return 'a_to_b';
  return direction;
}

function snapshotFromRow(row) {
  if (!row) return null;
  return {
    endpoint_a: Number(row.endpoint_a),
    endpoint_b: Number(row.endpoint_b),
    relation_type_id: Number(row.relation_type_id),
    direction: row.direction,
    strength: Number(row.strength),
    polarity: row.polarity,
    lifecycle: row.lifecycle,
    secrecy: row.secrecy,
    note: row.note || '',
  };
}

function relationRow(bookId, publicId) {
  return db.get(
    'SELECT * FROM character_relations WHERE public_id = ? AND book_id = ?',
    [publicId, bookId]
  );
}

function validateSnapshot(bookId, value, publicId, current = null) {
  if (!value || typeof value !== 'object') {
    throw new DomainError('VALIDATION_ERROR', '关系快照必须是对象', 400);
  }
  let rawA = value.endpoint_a !== undefined ? value.endpoint_a : value.character_a_id;
  let rawB = value.endpoint_b !== undefined ? value.endpoint_b : value.character_b_id;
  if (rawA === undefined && current) rawA = current.endpoint_a;
  if (rawB === undefined && current) rawB = current.endpoint_b;
  const characterA = getCharacter(bookId, rawA, 'character_a_id');
  const characterB = getCharacter(bookId, rawB, 'character_b_id');
  if (characterA.id === characterB.id) {
    throw new DomainError('VALIDATION_ERROR', '人物不能与自己建立关系', 400);
  }
  const swapped = characterA.id > characterB.id;
  const endpointA = Math.min(characterA.id, characterB.id);
  const endpointB = Math.max(characterA.id, characterB.id);
  const type = getRelationType(
    bookId,
    value.relation_type_id === undefined && current
      ? current.relation_type_id
      : value.relation_type_id
  );
  let direction = text(value.direction) || (current && current.direction) || type.default_direction;
  if (!DIRECTIONS.has(direction)) throw new DomainError('VALIDATION_ERROR', '关系方向无效', 400);
  if (swapped && (value.endpoint_a === undefined || value.endpoint_b === undefined)) {
    direction = reverseDirection(direction);
  }
  const strength = value.strength === undefined
    ? (current ? Number(current.strength) : 3)
    : Number(value.strength);
  if (!Number.isInteger(strength) || strength < 1 || strength > 5) {
    throw new DomainError('VALIDATION_ERROR', '关系强度必须是 1 到 5', 400);
  }
  const polarity = text(value.polarity) || (current && current.polarity) || type.default_polarity;
  const lifecycle = text(value.lifecycle) || (current && current.lifecycle) || 'active';
  const secrecy = text(value.secrecy) || (current && current.secrecy) || 'public';
  if (!POLARITIES.has(polarity)) throw new DomainError('VALIDATION_ERROR', '关系极性无效', 400);
  if (!LIFECYCLES.has(lifecycle)) throw new DomainError('VALIDATION_ERROR', '关系生命周期无效', 400);
  if (!SECRECY.has(secrecy)) throw new DomainError('VALIDATION_ERROR', '关系保密性无效', 400);

  const duplicate = db.get(
    `SELECT public_id FROM character_relations
     WHERE book_id = ? AND endpoint_a = ? AND endpoint_b = ? AND relation_type_id = ?
       AND public_id != ?`,
    [bookId, endpointA, endpointB, type.id, publicId]
  );
  if (duplicate) {
    throw new DomainError('RELATION_EXISTS', '这对人物已经存在相同类型的关系', 409, {
      public_id: duplicate.public_id,
    });
  }
  return {
    endpoint_a: endpointA,
    endpoint_b: endpointB,
    relation_type_id: type.id,
    direction,
    strength,
    polarity,
    lifecycle,
    secrecy,
    note: value.note === undefined ? (current ? current.note || '' : '') : text(value.note),
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeRelationChange(bookId, raw, options = {}) {
  const bid = ensureBook(bookId);
  const fieldKey = text(raw.field_key) || 'snapshot';
  let publicId = text(raw.subject_ref);
  if (!publicId && fieldKey === 'snapshot') publicId = generatePublicId();
  if (!/^rel_[a-zA-Z0-9_-]+$/.test(publicId)) {
    throw new DomainError('VALIDATION_ERROR', '关系 public_id 无效', 400, { field: 'subject_ref' });
  }
  const row = relationRow(bid, publicId);
  const current = snapshotFromRow(row);
  if (fieldKey === 'snapshot') {
    const next = validateSnapshot(bid, raw.new_value, publicId, current);
    if (options.checkOld !== false && Object.hasOwn(raw, 'old_value') && !same(raw.old_value, current)) {
      throw new DomainError('STALE_OLD_VALUE', '关系当前值已经变化', 409, {
        subject_ref: publicId,
        expected: raw.old_value,
        actual: current,
      });
    }
    return {
      change_kind: 'relation',
      subject_ref: publicId,
      field_key: 'snapshot',
      old_value: Object.hasOwn(raw, 'old_value') ? raw.old_value : current,
      new_value: next,
      metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    };
  }
  if (!MUTABLE_FIELDS.has(fieldKey)) {
    throw new DomainError('VALIDATION_ERROR', `关系字段“${fieldKey}”不可修改`, 400);
  }
  if (!current) throw new DomainError('RELATION_NOT_FOUND', '关系不存在', 404);
  const nextValue = raw.new_value;
  const candidate = validateSnapshot(bid, { ...current, [fieldKey]: nextValue }, publicId, current);
  if (options.checkOld !== false && Object.hasOwn(raw, 'old_value') && !same(raw.old_value, current[fieldKey])) {
    throw new DomainError('STALE_OLD_VALUE', `关系的“${fieldKey}”已经变化`, 409, {
      expected: raw.old_value,
      actual: current[fieldKey],
    });
  }
  return {
    change_kind: 'relation',
    subject_ref: publicId,
    field_key: fieldKey,
    old_value: Object.hasOwn(raw, 'old_value') ? raw.old_value : current[fieldKey],
    new_value: candidate[fieldKey],
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
}

function applyRelationProjection(bookId, eventId, change) {
  const currentRow = relationRow(bookId, change.subject_ref);
  const current = snapshotFromRow(currentRow);
  let next;
  if (change.field_key === 'snapshot') {
    next = validateSnapshot(bookId, change.new_value, change.subject_ref, current);
  } else {
    if (!current) throw new DomainError('RELATION_NOT_FOUND', '关系不存在', 404);
    next = validateSnapshot(
      bookId,
      { ...current, [change.field_key]: change.new_value },
      change.subject_ref,
      current
    );
  }
  db.run(
    `INSERT INTO character_relations
     (public_id, book_id, endpoint_a, endpoint_b, relation_type_id, direction,
      strength, polarity, lifecycle, secrecy, note, source_event_id, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(public_id) DO UPDATE SET
       endpoint_a = excluded.endpoint_a,
       endpoint_b = excluded.endpoint_b,
       relation_type_id = excluded.relation_type_id,
       direction = excluded.direction,
       strength = excluded.strength,
       polarity = excluded.polarity,
       lifecycle = excluded.lifecycle,
       secrecy = excluded.secrecy,
       note = excluded.note,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [
      change.subject_ref,
      bookId,
      next.endpoint_a,
      next.endpoint_b,
      next.relation_type_id,
      next.direction,
      next.strength,
      next.polarity,
      next.lifecycle,
      next.secrecy,
      next.note,
      currentRow ? currentRow.source_event_id : eventId,
      eventId,
      new Date().toISOString(),
    ]
  );
  return relationRow(bookId, change.subject_ref);
}

function relationChecksum(bookId) {
  const rows = db.all(
    `SELECT public_id, endpoint_a, endpoint_b, relation_type_id, direction,
       strength, polarity, lifecycle, secrecy, note, source_event_id, last_event_id
     FROM character_relations WHERE book_id = ? ORDER BY public_id`,
    [bookId]
  );
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function updateRelationWatermark(bookId, lastEventId, rebuiltAt = null) {
  db.run(
    `INSERT INTO projection_watermarks
     (book_id, projection_name, last_event_id, rebuilt_at, checksum)
     VALUES (?, 'relations', ?, ?, ?)
     ON CONFLICT(book_id, projection_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       rebuilt_at = excluded.rebuilt_at,
       checksum = excluded.checksum`,
    [bookId, lastEventId || 0, rebuiltAt, relationChecksum(bookId)]
  );
}

function effectiveRelationEvents(bookId, maxChapterSort = null) {
  const params = [bookId];
  const maxClause = maxChapterSort === null
    ? ''
    : 'AND e.chapter_id IS NOT NULL AND c.sort_order <= ?';
  if (maxChapterSort !== null) params.push(maxChapterSort);
  // 重放排序必须含卷序（D1-01）：多卷书卷间章 sort_order 重叠，只按 c.sort_order 会取错「最后」事件，
  // 致关系投影终态错误。与 storyLedger.effectiveEvents / latestStateEventId 的排序口径对齐。
  return db.all(
    `SELECT e.id
     FROM story_events e LEFT JOIN chapters c ON c.id = e.chapter_id
     LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE e.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
       ${maxClause}
     ORDER BY CASE WHEN e.chapter_id IS NULL THEN 1 ELSE 0 END,
       COALESCE(v.sort_order, 2147483647), COALESCE(c.sort_order, 2147483647),
       e.narrative_sequence, e.id`,
    params
  );
}

function rebuildRelationProjectionInternal(bookId) {
  db.run('DELETE FROM character_relations WHERE book_id = ?', [bookId]);
  let lastEventId = 0;
  for (const event of effectiveRelationEvents(bookId)) {
    const changes = db.all(
      `SELECT * FROM story_event_changes
       WHERE event_id = ? AND change_kind = 'relation'
       ORDER BY sort_order, id`,
      [event.id]
    );
    for (const row of changes) {
      applyRelationProjection(bookId, event.id, {
        subject_ref: row.subject_ref,
        field_key: row.field_key,
        new_value: JSON.parse(row.new_value_json),
      });
    }
    lastEventId = Math.max(lastEventId, event.id);
  }
  const rebuiltAt = new Date().toISOString();
  updateRelationWatermark(bookId, lastEventId, rebuiltAt);
  return {
    projection: 'relations',
    last_event_id: lastEventId,
    checksum: relationChecksum(bookId),
    rebuilt_at: rebuiltAt,
  };
}

function listRelationTypes(bookId) {
  const bid = ensureBook(bookId);
  return db.all(
    'SELECT * FROM relation_type_definitions WHERE book_id = ? ORDER BY sort_order, id',
    [bid]
  );
}

function createRelationType(bookId, input = {}) {
  const bid = ensureBook(bookId);
  const typeKey = text(input.type_key);
  const forward = text(input.forward_label);
  const reverse = text(input.reverse_label) || forward;
  const direction = text(input.default_direction) || 'both';
  const polarity = text(input.default_polarity) || 'neutral';
  if (!/^[a-z][a-z0-9_]*$/.test(typeKey) || !forward) {
    throw new DomainError('VALIDATION_ERROR', '关系类型 key 或标签无效', 400);
  }
  if (!DIRECTIONS.has(direction) || !POLARITIES.has(polarity)) {
    throw new DomainError('VALIDATION_ERROR', '关系类型默认语义无效', 400);
  }
  const time = new Date().toISOString();
  try {
    const result = db.run(
      `INSERT INTO relation_type_definitions
       (book_id, type_key, forward_label, reverse_label, default_direction,
        default_polarity, sort_order, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [bid, typeKey, forward, reverse, direction, polarity, Number(input.sort_order) || 0, time, time]
    );
    return db.get('SELECT * FROM relation_type_definitions WHERE id = ?', [result.lastInsertRowid]);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new DomainError('RELATION_TYPE_EXISTS', '关系类型已经存在', 409);
    throw err;
  }
}

function updateRelationType(bookId, typeId, patch = {}) {
  const bid = ensureBook(bookId);
  const type = getRelationType(bid, typeId);
  const used = db.get(
    'SELECT 1 AS used FROM character_relations WHERE book_id = ? AND relation_type_id = ? LIMIT 1',
    [bid, type.id]
  );
  if (used && ['type_key', 'default_direction', 'default_polarity'].some(key => patch[key] !== undefined)) {
    throw new DomainError('RELATION_TYPE_IN_USE', '已使用关系类型不能修改底层语义', 409);
  }
  const fields = [];
  const params = [];
  for (const field of ['forward_label', 'reverse_label']) {
    if (patch[field] === undefined) continue;
    const value = text(patch[field]);
    if (!value) throw new DomainError('VALIDATION_ERROR', '关系标签不能为空', 400);
    fields.push(`${field} = ?`);
    params.push(value);
  }
  if (patch.sort_order !== undefined) {
    fields.push('sort_order = ?');
    params.push(Number(patch.sort_order) || 0);
  }
  if (!fields.length) return type;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString(), type.id, bid);
  db.run(
    `UPDATE relation_type_definitions SET ${fields.join(', ')}
     WHERE id = ? AND book_id = ?`,
    params
  );
  return getRelationType(bid, type.id);
}

function labelFromFocus(row, focusId) {
  if (row.direction === 'a_to_b') {
    return focusId === row.endpoint_a ? row.forward_label : row.reverse_label;
  }
  if (row.direction === 'b_to_a') {
    return focusId === row.endpoint_b ? row.forward_label : row.reverse_label;
  }
  return row.forward_label;
}

function decorate(row, focusId) {
  return {
    ...row,
    endpoint_a: { id: Number(row.endpoint_a), name: row.endpoint_a_name },
    endpoint_b: { id: Number(row.endpoint_b), name: row.endpoint_b_name },
    relation_type: {
      id: Number(row.relation_type_id),
      key: row.type_key,
      forward_label: row.forward_label,
      reverse_label: row.reverse_label,
      label_from_focus: labelFromFocus(row, focusId),
    },
  };
}

function currentRows(bookId) {
  return db.all(
    `SELECT r.*, a.name AS endpoint_a_name, b.name AS endpoint_b_name,
       t.type_key, t.forward_label, t.reverse_label
     FROM character_relations r
     JOIN characters a ON a.id = r.endpoint_a
     JOIN characters b ON b.id = r.endpoint_b
     JOIN relation_type_definitions t ON t.id = r.relation_type_id
     WHERE r.book_id = ?`,
    [bookId]
  );
}

function rowsAsOf(bookId, chapterId) {
  const chapter = db.get('SELECT id, sort_order FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
  if (!chapter) throw new DomainError('CROSS_BOOK_REFERENCE', '快照章节不属于当前书籍', 400);
  const projected = new Map();
  for (const event of effectiveRelationEvents(bookId, chapter.sort_order)) {
    const changes = db.all(
      `SELECT subject_ref, field_key, new_value_json FROM story_event_changes
       WHERE event_id = ? AND change_kind = 'relation' ORDER BY sort_order, id`,
      [event.id]
    );
    for (const change of changes) {
      const value = JSON.parse(change.new_value_json);
      if (change.field_key === 'snapshot') projected.set(change.subject_ref, { ...value, public_id: change.subject_ref, last_event_id: event.id });
      else if (projected.has(change.subject_ref)) {
        projected.set(change.subject_ref, {
          ...projected.get(change.subject_ref),
          [change.field_key]: value,
          last_event_id: event.id,
        });
      }
    }
  }
  const characters = new Map(db.all('SELECT id, name FROM characters WHERE book_id = ?', [bookId]).map(row => [row.id, row.name]));
  const types = new Map(listRelationTypes(bookId).map(row => [row.id, row]));
  return [...projected.values()].map(row => {
    const type = types.get(Number(row.relation_type_id));
    return {
      ...row,
      endpoint_a_name: characters.get(Number(row.endpoint_a)) || '',
      endpoint_b_name: characters.get(Number(row.endpoint_b)) || '',
      type_key: type ? type.type_key : '',
      forward_label: type ? type.forward_label : '',
      reverse_label: type ? type.reverse_label : '',
    };
  });
}

function getRelations(bookId, characterId, filters = {}) {
  const bid = ensureBook(bookId);
  const focusId = positiveId(characterId, 'character_id');
  getCharacter(bid, focusId, 'character_id');
  const rows = filters.as_of_chapter
    ? rowsAsOf(bid, positiveId(filters.as_of_chapter, 'as_of_chapter'))
    : currentRows(bid);
  return rows.filter(row => {
    if (Number(row.endpoint_a) !== focusId && Number(row.endpoint_b) !== focusId) return false;
    if (filters.lifecycle && filters.lifecycle !== 'all' && row.lifecycle !== filters.lifecycle) return false;
    if (filters.secrecy && filters.secrecy !== 'all' && row.secrecy !== filters.secrecy) return false;
    if (filters.type && row.type_key !== filters.type && String(row.relation_type_id) !== String(filters.type)) return false;
    if (filters.direction && row.direction !== filters.direction) return false;
    if (filters.polarity && row.polarity !== filters.polarity) return false;
    if (filters.strength_min && Number(row.strength) < Number(filters.strength_min)) return false;
    return true;
  }).sort((left, right) =>
    Number(right.strength) - Number(left.strength) ||
    String(left.public_id).localeCompare(String(right.public_id))
  ).map(row => decorate(row, focusId));
}

function recordRelationChange(bookId, input = {}, actor = 'author') {
  const bid = ensureBook(bookId);
  const eventInput = input.event || {};
  const relation = input.relation || {};
  const publicId = text(relation.public_id) || generatePublicId();
  const oldRow = relationRow(bid, publicId);
  const oldValue = snapshotFromRow(oldRow);
  const newValue = validateSnapshot(bid, relation, publicId, oldValue);
  const ledger = require('./storyLedger');
  return ledger.commitEvent(bid, {
    ...eventInput,
    title: text(eventInput.title) || '人物关系发生变化',
    changes: [{
      change_kind: 'relation',
      subject_ref: publicId,
      field_key: 'snapshot',
      old_value: oldValue,
      new_value: newValue,
    }],
  }, actor);
}

module.exports = {
  normalizeRelationChange,
  applyRelationProjection,
  updateRelationWatermark,
  rebuildRelationProjectionInternal,
  relationChecksum,
  listRelationTypes,
  createRelationType,
  updateRelationType,
  getRelations,
  recordRelationChange,
  generatePublicId,
  snapshotFromRow,
};
