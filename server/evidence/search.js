const semanticSearch = require('../vector/search');
const anchors = require('./anchors');
const { searchStructured } = require('./structured');
const { searchDrafts } = require('./draftLexical');
const { fuse } = require('./fusion');
const db = require('../db');
const { narrativeScope, allowsHit } = require('../domain/narrativeScope');

function semanticHit(row) {
  return {
    anchor: anchors.chapterAnchor(row.chapter_id, row.paragraph_start || 0, row.source_revision_hash || ''),
    sourceType: 'chapter_final',
    sourceId: String(row.chapter_id),
    title: `定稿 · ${row.chapter_title}`,
    quote: row.text,
    context: row.text,
    trustClass: 'final_text',
    canonicalStatus: 'canonical',
    relevance: Number(row.score || 0),
    matchReason: '定稿正文语义匹配',
    location: {
      chapterId: row.chapter_id,
      paragraphIndex: row.paragraph_start || 0,
      charStart: row.char_start || 0,
      charEnd: row.char_end || 0,
      revisionHash: row.source_revision_hash || '',
    },
    stale: false,
  };
}

async function searchEvidence(bookId, query, options = {}, dependencies = {}) {
  const scope = options.narrativeScope || narrativeScope(bookId, options.chapterId);
  const structured = (dependencies.structured || searchStructured)(bookId, query, { limit: 20, narrativeScope: scope });
  const draft = (dependencies.draft || searchDrafts)(bookId, query, {
    limit: 20,
    excludeChapterId: options.excludeChapterId,
    chapterId: options.chapterId,
    narrativeScope: scope,
  });
  const degraded = [];
  let semantic = [];
  try {
    const search = dependencies.semantic || semanticSearch.search;
    semantic = (await search(bookId, query, {
      topK: 8,
      excludeChapterId: options.excludeChapterId,
      narrativeScope: scope,
    })).map(semanticHit);
  } catch (err) {
    degraded.push('semantic');
  }
  // 索引缺口显性化（方向报告 3.2）：缺索引此前静默返回空数组，连 degraded 都不标——
  // 该章从此不在定稿语义检索中，作者对「AI 想不起某章」无从知晓。
  // 定稿章未被全部索引时同样标记 semantic 降级并给出覆盖数，提示端与失败端同路。
  const lockedCount = db.get(
    "SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND locked = 1 AND content != ''",
    [bookId]
  ).n;
  const indexedCount = db.get(
    'SELECT COUNT(DISTINCT chapter_id) AS n FROM embeddings WHERE book_id = ?',
    [bookId]
  ).n;
  const semanticCoverage = { indexed: indexedCount, locked: lockedCount };
  if (lockedCount > indexedCount && !degraded.includes('semantic')) {
    degraded.push('semantic');
  }
  const sourceTypes = Array.isArray(options.sourceTypes) ? new Set(options.sourceTypes) : null;
  const groups = [structured, semantic, draft].map(group => group.filter(hit => allowsHit(scope, hit)));
  const hits = fuse(groups, { limit: options.topK || 12 })
    .filter(hit => !sourceTypes || sourceTypes.has(hit.sourceType));
  return { hits, degraded, semantic_coverage: semanticCoverage, budgets: { structured: 5, final: 5, draft: 2 } };
}

module.exports = { searchEvidence, semanticHit };
