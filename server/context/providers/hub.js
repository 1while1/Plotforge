// 人物中枢快照：活跃角色的最新状态投影 + 生效关系（源自故事事件账本）
// 数据由事件账本驱动（character_state_values / character_relations 投影表）
module.exports = {
  name: 'hub',
  title: '人物中枢快照（正典投影）',
  priority: 22,
  budget: 800,
  build({ book, db, narrativeScope }) {
    if (narrativeScope?.historical) return require('../../domain/narrativeScope').historicalStateText(book.id, narrativeScope);
    const states = db.all(
      `SELECT c.name, v.field_key, v.value_json, d.label
       FROM character_state_values v
       JOIN characters c ON c.id = v.character_id AND c.book_id = v.book_id
       LEFT JOIN state_field_definitions d ON d.book_id = v.book_id AND d.field_key = v.field_key
       WHERE v.book_id = ?
       ORDER BY v.updated_at DESC, v.character_id`,
      [book.id]
    );
    const rels = db.all(
      `SELECT a.name AS an, b.name AS bn, t.forward_label,
              r.strength, r.polarity, r.secrecy, r.note
       FROM character_relations r
       JOIN characters a ON a.id = r.endpoint_a
       JOIN characters b ON b.id = r.endpoint_b
       JOIN relation_type_definitions t ON t.id = r.relation_type_id
       WHERE r.book_id = ? AND r.lifecycle = 'active'
       ORDER BY r.strength DESC LIMIT 10`,
      [book.id]
    );
    if (!states.length && !rels.length) return null;
    const byChar = new Map();
    for (const row of states) {
      if (!byChar.has(row.name) && byChar.size >= 8) break;
      if (!byChar.has(row.name)) byChar.set(row.name, []);
      if (byChar.get(row.name).length >= 4) continue;
      let value = row.value_json;
      try { value = JSON.parse(row.value_json); } catch (_) { /* 保持原值 */ }
      const rendered = Array.isArray(value) ? value.join('、') : String(value == null ? '' : value);
      if (rendered) byChar.get(row.name).push(`${row.label || row.field_key}=${rendered}`);
    }
    const lines = [...byChar.entries()].map(([name, fields]) => `${name}：${fields.join('；')}`);
    const POLARITY = { positive: '正向', neutral: '中性', negative: '负向', mixed: '复杂' };
    for (const r of rels) {
      const label = r.forward_label || '关联';
      const secret = r.secrecy === 'secret' ? '，保密' : '';
      const note = r.note ? `，${r.note}` : '';
      lines.push(`${r.an} 与 ${r.bn}：${label}（强度${r.strength}，${POLARITY[r.polarity] || r.polarity}${secret}${note}）`);
    }
    return '【正典】以下由正式故事事件投影生成，是人物当前状态与关系的唯一权威来源。\n' + lines.join('\n');
  },
};
