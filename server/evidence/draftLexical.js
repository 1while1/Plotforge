const crypto = require('crypto');
const db = require('../db');
const anchors = require('./anchors');
const { narrativeScope, chapterClause } = require('../domain/narrativeScope');

function revision(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function paragraphs(content) {
  const text = String(content || '');
  const out = [];
  const pattern = /[^\n]+/g;
  let match;
  let index = 0;
  while ((match = pattern.exec(text))) {
    const value = match[0].trim();
    if (!value) continue;
    const leading = match[0].indexOf(value);
    out.push({
      index,
      text: value,
      charStart: match.index + Math.max(0, leading),
      charEnd: match.index + Math.max(0, leading) + value.length,
    });
    index += 1;
  }
  return out;
}

function searchDrafts(bookId, queryText, options = {}) {
  const scope = options.narrativeScope || narrativeScope(bookId, options.chapterId);
  const query = String(queryText || '').trim().toLocaleLowerCase('zh-CN');
  if (!query) return [];
  const terms = new Set([query]);
  for (const row of db.all(
    `SELECT c.name, ca.alias FROM characters c
     LEFT JOIN character_aliases ca ON ca.character_id = c.id
     WHERE c.book_id = ?`,
    [bookId]
  )) {
    for (const value of [row.name, row.alias]) {
      const term = String(value || '').trim().toLocaleLowerCase('zh-CN');
      if (term && query.includes(term)) terms.add(term);
    }
  }
  const hits = [];
  // 扫描范围限定（方向报告 2.1）：此前把该书全部草稿正文读进内存逐段 includes，
  // 数百章规模线性上涨。定向检索天然以「当前写作位置」为中心：
  // 当前卷草稿全扫 + 其他卷草稿按最近编辑取 30 章；无上下文时取最近 50 章。
  const OTHER_VOLUME_RECENT = 30;
  const NO_CONTEXT_RECENT = 50;
  const chapterRow = Number(options.chapterId)
    ? db.get('SELECT volume_id FROM chapters WHERE id = ? AND book_id = ?', [Number(options.chapterId), bookId])
    : null;
  let chapters;
  const baseSelect = `
    SELECT c.id, c.title, c.content FROM chapters c
    LEFT JOIN volumes v ON v.id = c.volume_id
    WHERE c.book_id = ? AND c.locked = 0 AND c.content != ''` + chapterClause(scope, 'c.id');
  if (chapterRow && chapterRow.volume_id) {
    const vol = chapterRow.volume_id;
    chapters = [
      ...db.all(`${baseSelect} AND c.volume_id = ?
        ORDER BY COALESCE(v.sort_order, 2147483647), c.sort_order, c.id`, [bookId, vol]),
      ...db.all(`${baseSelect} AND (c.volume_id IS NULL OR c.volume_id != ?)
        ORDER BY c.updated_at DESC, c.id DESC LIMIT ${OTHER_VOLUME_RECENT}`, [bookId, vol]),
    ];
  } else {
    chapters = db.all(`${baseSelect}
      ORDER BY c.updated_at DESC, c.id DESC LIMIT ${NO_CONTEXT_RECENT}`, [bookId]);
  }
  for (const chapter of chapters) {
    if (Number(options.excludeChapterId) === chapter.id) continue;
    const hash = revision(chapter.content);
    const paras = paragraphs(chapter.content);
    paras.forEach((para, idx) => {
      const lower = para.text.toLocaleLowerCase('zh-CN');
      const matched = [...terms].filter(term => lower.includes(term));
      if (!matched.length) return;
      hits.push({
        anchor: anchors.chapterAnchor(chapter.id, para.index, hash),
        sourceType: 'chapter_draft',
        sourceId: String(chapter.id),
        title: `草稿 · ${chapter.title} · 第 ${para.index + 1} 段`,
        quote: para.text,
        context: [paras[idx - 1] && paras[idx - 1].text, para.text, paras[idx + 1] && paras[idx + 1].text]
          .filter(Boolean).join('\n'),
        trustClass: 'draft',
        canonicalStatus: 'noncanonical',
        relevance: matched.includes(query) ? 0.78 : 0.66,
        matchReason: `草稿关键词匹配：${matched.join('、')}`,
        location: {
          chapterId: chapter.id,
          paragraphIndex: para.index,
          charStart: para.charStart,
          charEnd: para.charEnd,
          revisionHash: hash,
        },
        stale: false,
      });
    });
  }
  return hits.slice(0, options.limit || 20);
}

module.exports = { paragraphs, revision, searchDrafts };
