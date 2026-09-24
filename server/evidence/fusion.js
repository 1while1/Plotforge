function fuse(groups, options = {}) {
  const limit = options.limit || 12;
  const k = 60;
  const merged = new Map();
  groups.forEach(group => {
    group.forEach((hit, rank) => {
      const key = hit.anchor;
      const bonus = /精确匹配/.test(hit.matchReason || '') ? 0.03 : 0;
      const score = 1 / (k + rank + 1) + bonus;
      if (!merged.has(key)) merged.set(key, { hit, score });
      else merged.get(key).score += score;
    });
  });
  const sorted = [...merged.values()].sort((a, b) => b.score - a.score);
  const out = [];
  const sourceCounts = new Map();
  const chapterCounts = new Map();
  for (const item of sorted) {
    const sourceCount = sourceCounts.get(item.hit.sourceType) || 0;
    const chapterId = item.hit.location && item.hit.location.chapterId;
    const chapterCount = chapterId ? chapterCounts.get(chapterId) || 0 : 0;
    if (sourceCount >= Math.max(3, Math.ceil(limit / 2))) continue;
    if (chapterId && chapterCount >= 2) continue;
    out.push({ ...item.hit, relevance: Math.max(item.hit.relevance || 0, Number(item.score.toFixed(4))) });
    sourceCounts.set(item.hit.sourceType, sourceCount + 1);
    if (chapterId) chapterCounts.set(chapterId, chapterCount + 1);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { fuse };
