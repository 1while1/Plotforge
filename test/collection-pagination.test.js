const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');
const { executeRead } = require('../server/bookTools');
const { truncateToolResult } = require('../server/tools/loop-helpers');

// 集合工具分页与截断标注（方向报告 2.2）：全量读+静默截断会让模型基于
// 不完整列表下「全书没有X」类断言。统一 { items, total, next_cursor, truncated }。
test('timeline, chapter list and tool-result truncation carry pagination/truncation meta', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['分页书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const charId = characters.createCharacter(bookId, { name: '林野' }).character.id;

  for (let i = 1; i <= 5; i++) {
    db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, ?)', [bookId, `第${i}章`, '正文' + i, i]);
    ledger.commitEvent(bookId, {
      title: `事件${i}`,
      changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: 'health', old_value: i === 1 ? null : `状态${i - 1}`, new_value: `状态${i}` }],
    });
  }

  // 1) 时间线分页：limit 2 取第 1 页
  const page1 = ledger.getTimelinePage(bookId, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 5);
  assert.equal(page1.truncated, true);
  assert.equal(page1.next_cursor, 2);

  // 尾页：offset 4 → 1 条，无余量
  const last = ledger.getTimelinePage(bookId, { limit: 2, offset: 4 });
  assert.equal(last.items.length, 1);
  assert.equal(last.truncated, false);
  assert.equal(last.next_cursor, null);

  // 旧数组接口不受影响（advisor/存量测试依赖）
  assert.ok(Array.isArray(ledger.getTimeline(bookId, { limit: 3 })));
  assert.equal(ledger.getTimeline(bookId, { limit: 3 }).length, 3);

  // 2) list_chapters 工具：分页信封
  const toc = await executeRead(bookId, 'list_chapters', {});
  assert.equal(toc.total, 5);
  assert.equal(toc.items.length, 5);
  assert.equal(toc.truncated, false);
  const paged = await executeRead(bookId, 'list_chapters', { limit: 3 });
  assert.equal(paged.items.length, 3);
  assert.equal(paged.truncated, true);
  assert.equal(paged.next_cursor, 3);
  const page2 = await executeRead(bookId, 'list_chapters', { limit: 3, offset: 3 });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.truncated, false);

  // 3) 工具结果字符串截断：必须带剩余量标注
  const long = 'x'.repeat(5000);
  const clipped = truncateToolResult(long, 1000);
  assert.ok(clipped.includes('已截断'));
  assert.ok(clipped.includes('剩余约4000字符'), '截断后缀应标注剩余量');

  cleanup(location);
});
