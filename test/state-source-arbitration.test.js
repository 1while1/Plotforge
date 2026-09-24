const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { assembleDetailed } = require('../server/context');

// 双源仲裁成文（方向报告 1.1）：旧状态簿降级为「作者草稿·非正典」，
// 事件投影是唯一权威；两源同时注入时必须有明确的优先级标注与仲裁规则。
test('state providers carry canonical/non-canonical labels and arbitration rule', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['双源仲裁书']).lastInsertRowid;
  const charId = db.run('INSERT INTO characters (book_id, name) VALUES (?, ?)', [bookId, '林野']).lastInsertRowid;
  const eventId = db.run(
    `INSERT INTO story_events (book_id, title, narrative_sequence, created_at)
     VALUES (?, '林野受伤', 1, datetime('now'))`,
    [bookId]
  ).lastInsertRowid;
  db.run(
    `INSERT INTO character_state_values
     (book_id, character_id, field_key, value_json, source_event_id, last_event_id, updated_at)
     VALUES (?, ?, 'location', '北境雪原', ?, ?, datetime('now'))`,
    [bookId, charId, eventId, eventId]
  );
  db.run(
    `INSERT INTO story_state (book_id, kind, content, updated_at)
     VALUES (?, 'characters', '林野在南疆（作者手记，已过时）', datetime('now'))`,
    [bookId]
  );

  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const result = await assembleDetailed({ book, db, chapterId: null, query: '', systemTokenBudget: 20000 });
  const hubIdx = result.parts.findIndex(p => p.name.includes('人物中枢快照（正典投影）'));
  const draftIdx = result.parts.findIndex(p => p.name.includes('故事状态簿（作者草稿·非正典）'));
  assert.ok(hubIdx >= 0, '人物中枢快照节应存在且标题标注正典投影');
  assert.ok(draftIdx >= 0, '故事状态簿节应存在且标题标注非正典草稿');
  assert.ok(hubIdx < draftIdx, '正典投影应排在状态草稿之前');
  assert.ok(result.text.includes('【正典】'), '投影节内应带正典标识');
  assert.ok(result.text.includes('【非正典草稿】'), '状态簿节内应带非正典标识');
  assert.ok(result.text.includes('以正典投影为准') || result.text.includes('以投影为准'), '应写明冲突时以投影为准');
  assert.ok(result.text.includes('林野在南疆'), '草稿内容仍注入（降级不清除）');

  // 仲裁规则固定追加：自定义书级提示词也不能挤掉它
  db.run('UPDATE books SET system_prompt = ? WHERE id = ?', ['完全自定义的提示词', bookId]);
  const custom = await assembleDetailed({
    book: db.get('SELECT * FROM books WHERE id = ?', [bookId]),
    db, chapterId: null, query: '', systemTokenBudget: 20000,
  });
  assert.ok(custom.text.includes('【人物状态唯一权威源】'), '自定义提示词下仲裁规则仍应注入');
  assert.ok(custom.text.includes('完全自定义的提示词'));

  cleanup(location);
});
