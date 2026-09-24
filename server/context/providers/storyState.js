// 状态簿：人物状态 + 未回收伏笔（作者手工维护的草稿备注）
// 双源仲裁（方向报告 1.1，2026-09-10 成文）：本簿不是人物当前状态的正典——
// 唯一正典是故事事件投影出的「人物中枢快照」（providers/hub.js）。本簿不随
// 定稿/总结自动刷新，注入时必须声明非正典身份，冲突时以投影为准。
module.exports = {
  name: 'storyState',
  title: '故事状态簿（作者草稿·非正典）',
  priority: 35,
  budget: 2500,
  build({ book, db, narrativeScope }) {
    if (narrativeScope?.historical) return '历史写作：未注入缺少叙事时间戳的全书状态草稿，请以截至目标章的事件和正文为准。';
    const rows = db.all(
      `SELECT kind, content, updated_at FROM story_state
       WHERE book_id = ? AND kind IN ('characters', 'foreshadowing') AND content != ''
       ORDER BY kind`,
      [book.id]
    );
    if (!rows.length) return null;
    const labels = { characters: '人物当前状态', foreshadowing: '未回收伏笔（写作时注意呼应或回收）' };
    const body = rows.map(r => `◇ ${labels[r.kind] || r.kind}\n${r.content.trim()}`).join('\n\n');
    const newest = rows.map(r => r.updated_at).filter(Boolean).sort().pop();
    return '【非正典草稿】以下为作者手工维护的状态草稿，不随定稿自动刷新。'
      + '人物当前状态/关系一律以「人物中枢快照」正典投影为准；两处冲突时以投影为准，'
      + '并在回复中提醒作者更新这份草稿。\n\n'
      + body
      + `\n\n（草稿最后更新：${newest || '未知'}）`;
  },
};
