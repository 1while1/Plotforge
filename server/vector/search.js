// 检索器：embed(query) → 同书暴力余弦 top-k（百万字规模 <10ms）
const { embedQuery } = require('./embed');
const store = require('./store');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// options: { topK, threshold, excludeChapterId }
async function search(bookId, queryText, options = {}, dependencies = {}) {
  const topK = options.topK || 3;
  const threshold = options.threshold !== undefined ? options.threshold : 0.45;
  const scope = options.narrativeScope || require('../domain/narrativeScope').narrativeScope(bookId, options.chapterId);
  const rows = store.getByBook(bookId).filter(row => !scope || scope.allowedIds.includes(row.chapter_id));
  if (!rows.length) return [];
  const q = await (dependencies.embedQuery || embedQuery)(queryText);
  const scored = [];
  for (const r of rows) {
    if (options.excludeChapterId && r.chapter_id === options.excludeChapterId) continue;
    const score = cosine(q, r.vector);
    if (score >= threshold) scored.push({ ...r, vector: undefined, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // 同章最多保留 1 块，保证出处多样性
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (seen.has(s.chapter_id)) continue;
    seen.add(s.chapter_id);
    out.push(s);
    if (out.length >= topK) break;
  }
  return out;
}

module.exports = { search };
