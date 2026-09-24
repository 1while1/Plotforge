// 世界观设定（两信号相关性排序：问题点名 > 当前场景提及，稳定排序创建序兜底）
// 「登场章节关联」（方向报告 2.3）：标题出现在当前章正文保尾段 = 正在写的场景
// 用到的设定，裁剪预算时排在纯背景条目之前。
module.exports = {
  name: 'worldview',
  title: '世界观设定',
  priority: 10,
  budget: 2000,
  build({ book, db, query, chapterId }) {
    const world = db.all('SELECT title, content FROM world_entries WHERE book_id = ? ORDER BY id', [book.id]);
    if (!world.length) return null;
    const q = String(query || '');
    const current = chapterId
      ? db.get('SELECT content FROM chapters WHERE id = ? AND book_id = ?', [chapterId, book.id])
      : null;
    const sceneText = current ? String(current.content || '').slice(-4000) : '';
    const score = (w) => (q && q.includes(w.title) ? 2 : 0) + (sceneText && sceneText.includes(w.title) ? 1 : 0);
    world.sort((a, b) => score(b) - score(a));
    return world.map(w => `◆ ${w.title}\n${w.content}`).join('\n\n');
  },
};
