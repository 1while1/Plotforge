// 人物卡片（多信号相关性排序：问题点名 > 当前场景登场 > 台账近期活跃）
// 信号说明（方向报告 2.3）：
//  - 问题点名（名字或别名出现在本轮指令里）最强；
//  - 当前章正文（保尾 4000 字）出现名字 = 正在写的场景里登场；
//  - 最近 60 条事件变更涉及 = 台账意义上的近期活跃人物。
// 稳定排序，同分保持创建序兜底；人物多而预算有限时裁掉的是三者皆无的人物。
module.exports = {
  name: 'characters',
  title: '人物卡片',
  priority: 20,
  budget: 2500,
  build({ book, db, query, chapterId }) {
    const chars = db.all(`
      SELECT c.*, GROUP_CONCAT(ca.alias, '\\n') AS aliases
      FROM characters c LEFT JOIN character_aliases ca ON ca.character_id = c.id
      WHERE c.book_id = ?
      GROUP BY c.id
      ORDER BY c.id`, [book.id]);
    if (!chars.length) return null;
    const q = String(query || '');
    const current = chapterId
      ? db.get('SELECT content FROM chapters WHERE id = ? AND book_id = ?', [chapterId, book.id])
      : null;
    // 场景信号取正文保尾：正在写的位置在结尾，前文已由上下文其他节覆盖
    const sceneText = current ? String(current.content || '').slice(-4000) : '';
    const recentIds = new Set(db.all(`
      SELECT ec.subject_ref FROM story_event_changes ec
      JOIN story_events e ON e.id = ec.event_id
      WHERE e.book_id = ? AND ec.change_kind = 'character_state'
      ORDER BY e.id DESC LIMIT 60`, [book.id]).map(r => Number(r.subject_ref)));
    const score = (c) => {
      const aliases = String(c.aliases || '').split('\n').filter(Boolean);
      const named = q && (q.includes(c.name) || aliases.some(a => q.includes(a)));
      const onStage = sceneText && sceneText.includes(c.name);
      return (named ? 4 : 0) + (onStage ? 2 : 0) + (recentIds.has(c.id) ? 1 : 0);
    };
    chars.sort((a, b) => score(b) - score(a));
    return chars.map(c => {
      const fields = [
        c.role && `定位：${c.role}`,
        c.appearance && `外貌：${c.appearance}`,
        c.personality && `性格：${c.personality}`,
        c.background && `背景：${c.background}`,
        c.note && `备注：${c.note}`,
      ].filter(Boolean).join('；');
      return `◆ ${c.name}${fields ? '（' + fields + '）' : ''}`;
    }).join('\n');
  },
};
