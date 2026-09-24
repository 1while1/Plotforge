const db = require('../db');
const { DomainError } = require('./errors');
const { requireBook, requireVolume } = require('./chapterCatalog');

const PAGE_CHARS = 2800;
const clip = (value, limit) => Array.from(String(value || '')).slice(0, limit).join('');

function listChapterPositions(bookId) {
  const id = requireBook(bookId);
  const volumes = db.all('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order, id', [id]);
  const volumeOrdinals = new Map(volumes.map((volume, index) => [volume.id, index + 1]));
  const counts = new Map();
  return db.all(
    'SELECT c.id, c.book_id, c.volume_id, c.title, c.beat, c.sort_order, c.updated_at, c.locked, v.title AS volume, LENGTH(c.content) AS chars, LENGTH(TRIM(c.content)) > 0 AS has_content FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id WHERE c.book_id = ? ORDER BY COALESCE(v.sort_order, 2147483647), COALESCE(v.id, 2147483647), c.sort_order, c.id',
    [id]
  ).map((chapter, index) => {
    const ordinal = (counts.get(chapter.volume_id) || 0) + 1;
    counts.set(chapter.volume_id, ordinal);
    return { ...chapter, volume_ordinal: volumeOrdinals.get(chapter.volume_id) || null, chapter_ordinal: ordinal, global_ordinal: index + 1 };
  });
}

function positive(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new DomainError('INVALID_ARGS', name + ' 必须是正整数', 400);
  return value;
}

function resolveChapter(bookId, args = {}) {
  let chapters = listChapterPositions(bookId);
  if (args.chapterId !== undefined) chapters = chapters.filter(chapter => chapter.id === positive(args.chapterId, 'chapterId'));
  if (args.volumeOrdinal !== undefined) chapters = chapters.filter(chapter => chapter.volume_ordinal === positive(args.volumeOrdinal, 'volumeOrdinal'));
  if (args.chapterOrdinal !== undefined) chapters = chapters.filter(chapter => chapter.chapter_ordinal === positive(args.chapterOrdinal, 'chapterOrdinal'));
  if (args.withContent) chapters = chapters.filter(chapter => chapter.has_content);
  if (args.latest) chapters = chapters.slice(-1);
  if (!chapters.length) throw new DomainError('CHAPTER_NOT_FOUND', '未找到符合条件的章节，请核对目录位置', 404);
  if (chapters.length !== 1) throw new DomainError('AMBIGUOUS_CHAPTER', '章节位置不唯一，请指定第几卷或真实章节ID', 400, {
    candidates: chapters.slice(0, 10).map(chapter => ({ id: chapter.id, volume_ordinal: chapter.volume_ordinal, chapter_ordinal: chapter.chapter_ordinal })),
  });
  return directoryItem(chapters[0]);
}

function directoryItem(chapter) {
  return {
    id: chapter.id, volume_id: chapter.volume_id, volume_ordinal: chapter.volume_ordinal,
    chapter_ordinal: chapter.chapter_ordinal, global_ordinal: chapter.global_ordinal,
    volume: chapter.volume_ordinal ? '第' + chapter.volume_ordinal + '卷·' + clip(chapter.volume, 60) : '未分卷',
    title: clip(chapter.title, 120), beat: clip(chapter.beat, 160), chars: chapter.chars,
    details_truncated: Array.from(chapter.title || '').length > 120 || Array.from(chapter.beat || '').length > 160,
  };
}

function listChapterPage(bookId, args = {}) {
  let chapters = listChapterPositions(bookId);
  if (args.volumeId !== undefined) {
    const volumeId = requireVolume(bookId, args.volumeId);
    chapters = chapters.filter(chapter => chapter.volume_id === volumeId);
  }
  if (args.volumeOrdinal !== undefined) chapters = chapters.filter(chapter => chapter.volume_ordinal === positive(args.volumeOrdinal, 'volumeOrdinal'));
  if (args.withContent) chapters = chapters.filter(chapter => chapter.has_content);
  if (args.order !== undefined && !['asc', 'desc'].includes(args.order)) throw new DomainError('INVALID_ARGS', 'order 必须是 asc 或 desc', 400);
  if (args.order === 'desc') chapters.reverse();
  const limit = args.limit === undefined ? 200 : Math.min(500, positive(args.limit, 'limit'));
  const offset = args.offset === undefined ? 0 : args.offset;
  if (!Number.isInteger(offset) || offset < 0) throw new DomainError('INVALID_ARGS', 'offset 必须是非负整数', 400);
  const items = [];
  const envelope = () => ({ items, total: chapters.length, truncated: offset + items.length < chapters.length, next_cursor: offset + items.length < chapters.length ? offset + items.length : null });
  for (const chapter of chapters.slice(offset, offset + limit)) {
    items.push(directoryItem(chapter));
    if (JSON.stringify(envelope()).length > PAGE_CHARS) {
      items.pop();
      break;
    }
  }
  if (!items.length && offset < chapters.length) throw new DomainError('TOOL_RESULT_TOO_LARGE', '单个目录条目超过预算，请直接定位章节', 400);
  return envelope();
}

function readChapterPage(bookId, args = {}) {
  const chapter = db.get('SELECT id, title, content, beat, summary FROM chapters WHERE id = ? AND book_id = ?', [args.chapterId, bookId]);
  if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);
  const source = chapter.content || '';
  const length = Math.min(4000, positive(args.length ?? args.maxChars ?? 2000, 'length'));
  let start = args.start === undefined ? 0 : args.start;
  if (!Number.isInteger(start) || start < 0) throw new DomainError('INVALID_ARGS', 'start 必须是非负整数', 400);
  start = Math.min(start, source.length);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(source[start] || '')) start--;
  let points = Array.from(args.tail ? source : source.slice(start));
  points = args.tail ? points.slice(-length) : points.slice(0, length);
  const makePage = () => {
    const content = points.join('');
    const begin = args.tail ? source.length - content.length : start;
    const end = begin + content.length;
    return { id: chapter.id, title: clip(chapter.title, 120), beat: clip(chapter.beat, 80), summary: clip(chapter.summary, 120),
      start: begin, end, totalChars: source.length, offset_unit: 'utf16', truncated: begin > 0 || end < source.length,
      next_cursor: end < source.length ? end : null, content };
  };
  let page = makePage();
  while (JSON.stringify(page).length > PAGE_CHARS && points.length) {
    const keep = Math.max(0, points.length - Math.max(1, Math.ceil((JSON.stringify(page).length - PAGE_CHARS) / 6)));
    points = args.tail ? points.slice(points.length - keep) : points.slice(0, keep);
    page = makePage();
  }
  return page;
}

module.exports = { listChapterPositions, resolveChapter, listChapterPage, readChapterPage };
