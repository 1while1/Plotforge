const db = require('../db');
const { DomainError } = require('./errors');

const TYPES = new Set(['foreshadow', 'mystery', 'promise', 'debt', 'plan']);
const STATUSES = new Set(['open', 'progressing', 'resolved', 'abandoned']);
const IMPORTANCE = new Set(['low', 'normal', 'high', 'critical']);

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

function sameBookRef(table, bookId, value, field) {
  const id = positiveId(value, field, true);
  if (id === null) return null;
  const row = db.get(`SELECT id FROM ${table} WHERE id = ? AND book_id = ?`, [id, bookId]);
  if (!row) throw new DomainError('CROSS_BOOK_REFERENCE', `${field} 不属于当前书籍`, 400, { field });
  return id;
}

function normalizeCharacterIds(bookId, values) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map(value => positiveId(value, 'character_ids')))];
  for (const id of ids) {
    if (!db.get('SELECT id FROM characters WHERE id = ? AND book_id = ?', [id, bookId])) {
      throw new DomainError('CROSS_BOOK_REFERENCE', '线索关联人物不属于当前书籍', 400, {
        field: 'character_ids',
        character_id: id,
      });
    }
  }
  return ids;
}

function normalize(bookId, input, existing = null) {
  const bid = ensureBook(bookId);
  const type = input.type === undefined && existing ? existing.type : text(input.type);
  const status = input.status === undefined && existing ? existing.status : (text(input.status) || 'open');
  const importance = input.importance === undefined && existing
    ? existing.importance
    : (text(input.importance) || 'normal');
  const title = input.title === undefined && existing ? existing.title : text(input.title);
  if (!TYPES.has(type)) throw new DomainError('VALIDATION_ERROR', '线索类型无效', 400, { field: 'type' });
  if (!STATUSES.has(status)) throw new DomainError('VALIDATION_ERROR', '线索状态无效', 400, { field: 'status' });
  if (!IMPORTANCE.has(importance)) throw new DomainError('VALIDATION_ERROR', '重要度无效', 400);
  if (!title) throw new DomainError('VALIDATION_ERROR', '线索标题不能为空', 400, { field: 'title' });
  const opened = input.opened_chapter_id === undefined && existing
    ? existing.opened_chapter_id
    : sameBookRef('chapters', bid, input.opened_chapter_id, 'opened_chapter_id');
  const target = input.target_chapter_id === undefined && existing
    ? existing.target_chapter_id
    : sameBookRef('chapters', bid, input.target_chapter_id, 'target_chapter_id');
  const resolved = input.resolved_event_id === undefined && existing
    ? existing.resolved_event_id
    : sameBookRef('story_events', bid, input.resolved_event_id, 'resolved_event_id');
  const characterIds = input.character_ids === undefined && existing
    ? null
    : normalizeCharacterIds(bid, input.character_ids);
  return {
    book_id: bid,
    type,
    title,
    summary: input.summary === undefined && existing ? existing.summary : text(input.summary),
    status,
    importance,
    opened_chapter_id: opened,
    target_chapter_id: target,
    resolved_event_id: resolved,
    character_ids: characterIds,
  };
}

function getThread(bookId, threadId) {
  const bid = ensureBook(bookId);
  const id = positiveId(threadId, 'thread_id');
  const thread = db.get(
    'SELECT * FROM story_threads WHERE id = ? AND book_id = ?',
    [id, bid]
  );
  if (!thread) throw new DomainError('THREAD_NOT_FOUND', '故事线索不存在', 404);
  const characters = db.all(
    `SELECT c.id, c.name, c.role, c.intro
     FROM story_thread_characters tc JOIN characters c ON c.id = tc.character_id
     WHERE tc.thread_id = ? ORDER BY c.name, c.id`,
    [id]
  );
  return { ...thread, characters, character_ids: characters.map(item => item.id) };
}

function replaceCharacters(threadId, characterIds) {
  db.run('DELETE FROM story_thread_characters WHERE thread_id = ?', [threadId]);
  for (const characterId of characterIds) {
    db.run(
      'INSERT INTO story_thread_characters (thread_id, character_id) VALUES (?, ?)',
      [threadId, characterId]
    );
  }
}

function createThread(bookId, input = {}) {
  const value = normalize(bookId, input);
  return db.transaction(() => {
    const time = new Date().toISOString();
    const result = db.run(
      `INSERT INTO story_threads
       (book_id, type, title, summary, status, importance, opened_chapter_id,
        target_chapter_id, resolved_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.book_id,
        value.type,
        value.title,
        value.summary,
        value.status,
        value.importance,
        value.opened_chapter_id,
        value.target_chapter_id,
        value.resolved_event_id,
        time,
        time,
      ]
    );
    replaceCharacters(result.lastInsertRowid, value.character_ids || []);
    return getThread(value.book_id, result.lastInsertRowid);
  });
}

function updateThread(bookId, threadId, patch = {}) {
  const existing = getThread(bookId, threadId);
  const value = normalize(existing.book_id, patch, existing);
  return db.transaction(() => {
    db.run(
      `UPDATE story_threads SET
       type = ?, title = ?, summary = ?, status = ?, importance = ?,
       opened_chapter_id = ?, target_chapter_id = ?, resolved_event_id = ?, updated_at = ?
       WHERE id = ? AND book_id = ?`,
      [
        value.type,
        value.title,
        value.summary,
        value.status,
        value.importance,
        value.opened_chapter_id,
        value.target_chapter_id,
        value.resolved_event_id,
        new Date().toISOString(),
        existing.id,
        existing.book_id,
      ]
    );
    if (value.character_ids) replaceCharacters(existing.id, value.character_ids);
    return getThread(existing.book_id, existing.id);
  });
}

function listThreads(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const clauses = ['t.book_id = ?'];
  const params = [bid];
  if (filters.type) {
    clauses.push('t.type = ?');
    params.push(text(filters.type));
  }
  if (filters.status) {
    clauses.push('t.status = ?');
    params.push(text(filters.status));
  }
  if (filters.character_id) {
    clauses.push(`EXISTS (
      SELECT 1 FROM story_thread_characters tc
      WHERE tc.thread_id = t.id AND tc.character_id = ?
    )`);
    params.push(positiveId(filters.character_id, 'character_id'));
  }
  const rows = db.all(
    `SELECT t.id FROM story_threads t
     WHERE ${clauses.join(' AND ')}
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'progressing' THEN 1 ELSE 2 END,
       CASE t.importance WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
       t.id DESC`,
    params
  );
  return rows.map(row => getThread(bid, row.id));
}

module.exports = { createThread, updateThread, getThread, listThreads };
