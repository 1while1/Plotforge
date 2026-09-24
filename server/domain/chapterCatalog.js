const db = require('../db');
const { DomainError } = require('./errors');

const CHAPTER_PREFIX = /^第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*章/u;

function ordinalNumber(text) {
  const value = String(text || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digits) digit = digits[character];
    else if (units[character] === 10000) {
      total += (section + digit || 1) * 10000;
      section = 0;
      digit = 0;
    } else if (units[character]) {
      section += (digit || 1) * units[character];
      digit = 0;
    } else return null;
  }
  return value ? total + section + digit : null;
}

function requireBook(bookId) {
  const id = Number(bookId);
  if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT id FROM books WHERE id = ?', [id])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  return id;
}

function requireVolume(bookId, volumeId) {
  const id = Number(volumeId);
  if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT id FROM volumes WHERE id = ? AND book_id = ?', [id, bookId])) {
    throw new DomainError('VOLUME_NOT_IN_BOOK', '指定的分卷不属于这本书', 400);
  }
  return id;
}

function createChapter(bookId, input = {}) {
  const id = requireBook(bookId);
  if (input.title != null && typeof input.title !== 'string') throw new DomainError('INVALID_TITLE', '章节标题必须是文字', 400);
  const requestedVolume = input.volumeId == null ? null : requireVolume(id, input.volumeId);
  return db.transaction(() => {
    let volumeId = requestedVolume;
    if (!volumeId) {
      const last = db.get('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1', [id]);
      volumeId = last ? last.id : db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [id, '第一卷']).lastInsertRowid;
    }
    const chapters = db.all('SELECT title, sort_order FROM chapters WHERE book_id = ? AND volume_id = ?', [id, volumeId]);
    const sortOrder = chapters.reduce((maximum, chapter) => Math.max(maximum, Number(chapter.sort_order) || 0), 0) + 1;
    const number = chapters.reduce((maximum, chapter) => {
      const match = CHAPTER_PREFIX.exec(chapter.title || '');
      return Math.max(maximum, match ? ordinalNumber(match[1]) || 0 : 0);
    }, chapters.length) + 1;
    const requestedTitle = (input.title || '').trim();
    const title = requestedTitle ? requestedTitle.replace(CHAPTER_PREFIX, '第' + number + '章') : '第' + number + '章';
    const created = db.run(
      "INSERT INTO chapters (book_id, volume_id, title, beat, content, summary, sort_order, updated_at) VALUES (?, ?, ?, ?, '', '', ?, datetime('now','localtime'))",
      [id, volumeId, title, input.beat || '', sortOrder]
    );
    return db.get('SELECT * FROM chapters WHERE id = ?', [created.lastInsertRowid]);
  });
}

function validatePlacement(bookId, patch, chapter) {
  const placement = {};
  if (patch.volume_id !== undefined) {
    placement.volume_id = patch.volume_id === null ? null : requireVolume(bookId, patch.volume_id);
  }
  if (patch.sort_order !== undefined) {
    if (!Number.isInteger(patch.sort_order) || patch.sort_order < 0) {
      throw new DomainError('INVALID_SORT_ORDER', 'sort_order 必须是非负整数', 400);
    }
    placement.sort_order = patch.sort_order;
  } else if (chapter && placement.volume_id !== undefined && placement.volume_id !== chapter.volume_id) {
    placement.sort_order = db.get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM chapters WHERE book_id = ? AND volume_id IS ?', [bookId, placement.volume_id]).next;
  }
  return placement;
}

// 结构变更的库内副作用（涉及卷标过期、全书摘要标过期、投影重建）。
// 同事务原语（S1-02）：调用方必须已持有数据库事务（如 chapterMutations 组合调用）；
// 独立使用走 commitStructureChange，两层不得各自 BEGIN。
function applyStructureChangeInTransaction(bookId, volumeIds = []) {
  for (const volumeId of new Set(volumeIds.filter(value => value != null))) {
    db.run('UPDATE volumes SET summary_stale = 1 WHERE id = ? AND book_id = ?', [volumeId, bookId]);
  }
  db.run("UPDATE story_state SET stale = 1 WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  return require('./storyLedger').rebuildProjectionsInTransaction(bookId);
}

function commitStructureChange(bookId, work, volumeIds = []) {
  return db.transaction(() => {
    work();
    return applyStructureChangeInTransaction(bookId, volumeIds);
  });
}

function moveChapter(bookId, chapterId, patch) {
  const id = requireBook(bookId);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [chapterId, id]);
  if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);
  const placement = validatePlacement(id, patch, chapter);
  if (!Object.keys(placement).length) throw new DomainError('INVALID_PLACEMENT', '请指定目标分卷或排序', 400);
  // S1-03：位置变更同样走单调版本守卫（expected_revision 由确认信封创建时绑定注入）
  const applied = require('./chapterMutations').applyChapterMutation({
    bookId: id,
    chapterId,
    expectedRevision: patch.expected_revision,
    patch: placement,
    reason: 'before-move',
  });
  return { ...applied.chapter, projection_rebuilt: applied.structureChanged, projection: applied.projection };
}

module.exports = { createChapter, requireBook, requireVolume, ordinalNumber, validatePlacement, commitStructureChange, applyStructureChangeInTransaction, moveChapter };
