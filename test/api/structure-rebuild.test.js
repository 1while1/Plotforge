const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const characters = require('../../server/domain/characters');
const ledger = require('../../server/domain/storyLedger');

// 结构操作触发投影重建（方向报告 1.5）：卷调序/章节换卷/删除改变叙事顺序，
// 此前这些路由不重建投影，重排后「人物当前状态」仍讲旧顺序的故事。
test('volume reorder and chapter move rebuild character-state projections', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['结构重建书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;

  const vol1 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '卷一']).lastInsertRowid;
  const vol2 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '卷二']).lastInsertRowid;
  const ch1 = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 1)', [bookId, vol1, '章一', '林野进城。']).lastInsertRowid;
  const ch2 = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 1)', [bookId, vol2, '章二', '林野北上。']).lastInsertRowid;

  ledger.commitEvent(bookId, { title: '进城', chapter_id: ch1, changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: null, new_value: '轻伤' }] });
  ledger.commitEvent(bookId, { title: '北上', chapter_id: ch2, changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'health', old_value: '轻伤', new_value: '重伤' }] });

  const currentState = () => {
    const row = db.get('SELECT value_json FROM character_state_values WHERE book_id = ? AND character_id = ? AND field_key = ?', [bookId, characterId, 'health']);
    return row ? JSON.parse(row.value_json) : null;
  };
  assert.equal(currentState(), '重伤', '叙事序卷一→卷二，后发事件应为当前值');

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 卷二调到最前：叙事序翻转，「进城」变后发 → 当前值应变回轻伤
  const swap = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/volumes/${vol2}`, { sort_order: 0 });
  assert.equal(swap.status, 200);
  assert.equal(swap.body.projection_rebuilt, true, '卷调序必须触发投影重建');
  assert.equal(currentState(), '轻伤', '卷序翻转后投影应重放为翻转后的终态');

  // 章节换卷：c2 挪回卷一（sort_order 同为 1，id 靠后）→ 仍应触发重建
  const move = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${ch2}`, { volume_id: vol1, expected_revision: Number(db.get('SELECT revision FROM chapters WHERE id = ?', [ch2]).revision) });
  assert.equal(move.status, 200);
  assert.equal(move.body.projection_rebuilt, true, '章节换卷必须触发投影重建');
  assert.ok(move.body.projection && move.body.projection.last_event_id >= 0);

  // 非结构修改（只改标题）不应重建
  const textOnly = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/volumes/${vol1}`, { intro: '只改文本' });
  assert.equal(textOnly.status, 200);
  assert.equal(textOnly.body.projection_rebuilt, false);

  // 删章（级联失效证据）后仍应完成重建且投影保持一致
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${ch1}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.projection_rebuilt, true);
});
