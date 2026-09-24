const PATTERNS = [
  ['character', /^char:(\d+):([a-z][a-z0-9_]*)$/],
  ['relation', /^rel:(rel_[a-zA-Z0-9_-]+)$/],
  ['event', /^event:(\d+)$/],
  ['thread', /^thread:(\d+)$/],
  ['chapter', /^ch:(\d+):p(\d+):([a-f0-9]+)$/],
  ['world', /^world:(\d+)$/],
  ['message', /^msg:(\d+)$/],
];

function parseAnchor(anchor) {
  const value = String(anchor || '').trim();
  for (const [type, pattern] of PATTERNS) {
    const match = value.match(pattern);
    if (!match) continue;
    if (type === 'character') return { type, id: Number(match[1]), field: match[2] };
    if (type === 'relation') return { type, id: match[1] };
    if (type === 'chapter') {
      return { type, id: Number(match[1]), paragraphIndex: Number(match[2]), hashPrefix: match[3] };
    }
    return { type, id: Number(match[1]) };
  }
  return null;
}

function chapterAnchor(chapterId, paragraphIndex, revisionHash) {
  return `ch:${Number(chapterId)}:p${Number(paragraphIndex)}:${String(revisionHash || '').slice(0, 8)}`;
}

module.exports = {
  parseAnchor,
  chapterAnchor,
  character: (id, field) => `char:${id}:${field}`,
  relation: id => `rel:${id}`,
  event: id => `event:${id}`,
  thread: id => `thread:${id}`,
  world: id => `world:${id}`,
  message: id => `msg:${id}`,
};
