const db = require('../db');
const { listChapterPositions } = require('./chapterNavigation');
const { DomainError } = require('./errors');

function narrativeScope(bookId, chapterId, positions) {
  if (chapterId == null) return null;
  const chapters = positions || listChapterPositions(bookId);
  const current = chapters.find(chapter => chapter.id === Number(chapterId));
  if (!current) throw new DomainError('CHAPTER_NOT_FOUND', '叙事边界章节不属于本书', 404);
  return { chapterId: current.id, historical: current.global_ordinal < chapters.length,
    allowedIds: chapters.filter(chapter => chapter.global_ordinal <= current.global_ordinal).map(chapter => chapter.id) };
}

function chapterClause(scope, column) {
  if (!scope) return '';
  if (!['c.id', 'chapter_id', 'e.chapter_id', 's.chapter_id'].includes(column)) throw new Error('Invalid internal chapter column');
  return ' AND ' + column + ' IN (' + (scope.allowedIds.map(Number).join(',') || 'NULL') + ')';
}

function allowsHit(scope, hit) {
  if (!scope) return true;
  if (hit.location?.chapterId) return scope.allowedIds.includes(Number(hit.location.chapterId));
  if (['chapter_final', 'chapter_draft', 'event'].includes(hit.sourceType)) return false;
  return !scope.historical || !['relation', 'thread'].includes(hit.sourceType);
}

function historicalStateText(bookId, scope) {
  const events = db.all('SELECT e.* FROM story_events e WHERE e.book_id = ?' + chapterClause(scope, 'e.chapter_id')
    + ' AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id' + chapterClause(scope, 's.chapter_id') + ')', [bookId]);
  const ranks = new Map(scope.allowedIds.map((id, index) => [id, index]));
  events.sort((left, right) => ranks.get(left.chapter_id) - ranks.get(right.chapter_id) || left.narrative_sequence - right.narrative_sequence || left.id - right.id);
  const states = new Map();
  const relations = [];
  for (const event of events) {
    for (const change of db.all('SELECT ec.*, c.name FROM story_event_changes ec LEFT JOIN characters c ON c.id = CAST(ec.subject_ref AS INTEGER) AND c.book_id = ? WHERE ec.event_id = ? ORDER BY ec.sort_order, ec.id', [bookId, event.id])) {
      let value;
      try { value = JSON.parse(change.new_value_json); } catch { value = change.new_value_json; }
      const label = (change.name || change.subject_ref) + '·' + change.field_key;
      const text = label + '=' + JSON.stringify(value) + ' [chapterId=' + event.chapter_id + ', eventId=' + event.id + ']';
      if (change.change_kind === 'character_state') {
        const key = change.subject_ref + ':' + change.field_key;
        if (value === null) states.delete(key);
        else states.set(key, text);
      } else relations.push(text);
    }
  }
  const lines = [...states.values(), ...relations.slice(-4)];
  return '【历史正典】截至chapterId=' + scope.chapterId + '的事件状态与关系记录；未注入全书最新投影。\n'
    + (lines.length ? lines.map(line => Array.from(line).slice(0, 240).join('')).join('\n') : '暂无可追溯的历史状态；不得用全书最新状态补猜。');
}

module.exports = { narrativeScope, chapterClause, allowsHit, historicalStateText };
