const db = require('../db');
const anchors = require('./anchors');
const { chapterClause } = require('../domain/narrativeScope');

function includes(text, query) {
  return String(text || '').toLocaleLowerCase('zh-CN').includes(query);
}

// SQL 预筛（方向报告 2.1）：此前全部行读进 JS 逐字段 includes + 每人物一次
// 别名查询（N+1）。改为 SQL instr(lower(...)) 下推（中文无大小写差异，
// ASCII 小写化两侧一致），再保留 JS includes 终判保证语义不变；
// 事件/线索预筛附 LIMIT 上限防单字宽匹配拖垮大库。
const EVENTS_PREFILTER_LIMIT = 200;

function searchStructured(bookId, queryText, options = {}) {
  const query = String(queryText || '').trim().toLocaleLowerCase('zh-CN');
  if (!query) return [];
  const hits = [];
  const characters = db.all(`
    SELECT c.*, GROUP_CONCAT(ca.alias, ' / ') AS aliases,
           EXISTS(SELECT 1 FROM character_aliases x
                  WHERE x.character_id = c.id AND lower(x.alias) = ?) AS alias_exact
    FROM characters c LEFT JOIN character_aliases ca ON ca.character_id = c.id
    WHERE c.book_id = ?
      AND (instr(lower(c.name) || ' ' || lower(c.role) || ' ' || lower(c.intro) || ' '
                 || lower(c.appearance) || ' ' || lower(c.personality) || ' '
                 || lower(c.background) || ' ' || lower(c.note), ?) > 0
           OR lower(c.name) = ?
           OR EXISTS(SELECT 1 FROM character_aliases x2
                     WHERE x2.character_id = c.id AND lower(x2.alias) = ?))
    GROUP BY c.id
  `, [query, bookId, query, query, query]);
  for (const character of characters) {
    const exactName = character.name.toLocaleLowerCase('zh-CN') === query;
    const exactAlias = Boolean(character.alias_exact);
    const fields = ['name', 'role', 'intro', 'appearance', 'personality', 'background', 'note'];
    for (const field of fields) {
      if (!includes(character[field], query) && !(field === 'name' && (exactName || exactAlias))) continue;
      hits.push({
        anchor: anchors.character(character.id, field),
        sourceType: 'character',
        sourceId: String(character.id),
        title: `人物 · ${character.name} · ${field}`,
        quote: String(character[field] || character.name),
        context: character.aliases || '',
        trustClass: 'canon',
        canonicalStatus: 'canonical',
        relevance: exactName || exactAlias ? 1 : 0.76,
        matchReason: exactName ? '人物姓名精确匹配' : exactAlias ? '人物别名精确匹配' : '人物档案文本匹配',
        location: null,
        stale: false,
      });
    }
  }
  for (const row of db.all(`
    SELECT r.*, a.name AS a_name, b.name AS b_name, t.forward_label
    FROM character_relations r
    JOIN characters a ON a.id = r.endpoint_a
    JOIN characters b ON b.id = r.endpoint_b
    JOIN relation_type_definitions t ON t.id = r.relation_type_id
    WHERE r.book_id = ? AND ? = 0
      AND instr(lower(a.name) || ' ' || lower(b.name) || ' ' || lower(t.forward_label) || ' ' || lower(r.note), ?) > 0
  `, [bookId, options.narrativeScope?.historical ? 1 : 0, query])) {
    const haystack = `${row.a_name} ${row.b_name} ${row.forward_label} ${row.note}`;
    if (!includes(haystack, query)) continue;
    hits.push({
      anchor: anchors.relation(row.public_id),
      sourceType: 'relation',
      sourceId: row.public_id,
      title: `${row.a_name} ↔ ${row.b_name} · ${row.forward_label}`,
      quote: row.note || `${row.forward_label}，强度 ${row.strength}`,
      context: `${row.polarity} / ${row.lifecycle} / ${row.secrecy}`,
      trustClass: 'canon',
      canonicalStatus: 'canonical',
      relevance: 0.84,
      matchReason: '人物关系精确查询',
      location: null,
      stale: false,
    });
  }
  for (const event of db.all(
    `SELECT * FROM story_events WHERE book_id = ? ${chapterClause(options.narrativeScope, 'chapter_id')}
       AND instr(lower(title) || ' ' || lower(summary) || ' ' || lower(source_quote), ?) > 0
       ORDER BY id DESC LIMIT ${EVENTS_PREFILTER_LIMIT}`,
    [bookId, query]
  )) {
    if (!includes(`${event.title} ${event.summary} ${event.source_quote}`, query)) continue;
    hits.push({
      anchor: anchors.event(event.id),
      sourceType: 'event',
      sourceId: String(event.id),
      title: `故事事件 · ${event.title}`,
      quote: event.source_quote || event.summary || event.title,
      context: event.summary,
      trustClass: 'canon',
      canonicalStatus: 'canonical',
      relevance: 0.82,
      matchReason: '正式事件文本匹配',
      location: event.chapter_id ? {
        chapterId: event.chapter_id,
        paragraphIndex: event.paragraph_index,
        revisionHash: event.source_revision_hash,
      } : null,
      stale: Boolean(event.source_stale),
    });
  }
  for (const thread of db.all(
    `SELECT * FROM story_threads WHERE book_id = ? AND ? = 0
       AND instr(lower(title) || ' ' || lower(summary), ?) > 0`,
    [bookId, options.narrativeScope?.historical ? 1 : 0, query]
  )) {
    if (!includes(`${thread.title} ${thread.summary}`, query)) continue;
    hits.push({
      anchor: anchors.thread(thread.id),
      sourceType: 'thread',
      sourceId: String(thread.id),
      title: `故事线索 · ${thread.title}`,
      quote: thread.summary || thread.title,
      context: `${thread.type} / ${thread.status}`,
      trustClass: 'canon',
      canonicalStatus: 'canonical',
      relevance: 0.8,
      matchReason: '故事线索文本匹配',
      location: null,
      stale: false,
    });
  }
  return hits.slice(0, options.limit || 20);
}

module.exports = { searchStructured };
