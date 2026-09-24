const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const bookTools = require('../server/bookTools');
const { truncateToolResult, capToolResult } = require('../server/tools/loop-helpers');

async function setup(t, count = 59) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['导航回归']).lastInsertRowid;
  const volumeId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  for (let index = 0; index < count; index++) {
    db.run('INSERT INTO chapters (book_id, volume_id, title, beat, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [bookId, volumeId, '第' + (index + 1) + '章', '节拍与引号"\n'.repeat(40), '章末内容', index + 1]);
  }
  return { bookId, volumeId };
}

test('带长节拍的59章目录经外层预算后仍为完整JSON，游标遍历无遗漏', async t => {
  const { bookId } = await setup(t);
  const seen = [];
  let offset = 0;
  do {
    const raw = await bookTools.executeRead(bookId, 'list_chapters', { offset });
    const page = JSON.parse(truncateToolResult(raw));
    assert.equal(typeof capToolResult(raw), 'object');
    assert.equal(page.total, 59);
    assert.ok(page.items.length > 0);
    seen.push(...page.items.map(item => item.id));
    offset = page.next_cursor;
    if (page.truncated) assert.ok(offset > 0);
  } while (offset !== null);
  assert.equal(new Set(seen).size, 59);
  assert.equal(seen.length, 59);
});

test('卷章定位与最近有正文定位显式返回真实ID，歧义不猜', async t => {
  const { bookId } = await setup(t, 3);
  const second = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '同排序第二卷']).lastInsertRowid;
  const latest = db.run('INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, 1)', [bookId, second, '不带章号的标题', '新正文']).lastInsertRowid;
  const located = await bookTools.executeRead(bookId, 'resolve_chapter', { volumeOrdinal: 2, chapterOrdinal: 1 });
  assert.equal(located.id, latest);
  assert.equal(located.global_ordinal, 4);
  await assert.rejects(bookTools.executeRead(bookId, 'resolve_chapter', { chapterOrdinal: 1 }), { code: 'AMBIGUOUS_CHAPTER' });
  const tail = await bookTools.executeRead(bookId, 'list_chapters', { order: 'desc', limit: 1, withContent: true });
  assert.equal(tail.items[0].id, latest);
});

test('长章读尾并按实际游标完整拼回，JSON元数据不被剪断', async t => {
  const { bookId } = await setup(t, 1);
  const chapterId = db.get('SELECT id FROM chapters WHERE book_id = ?', [bookId]).id;
  const content = '😀引号"\n'.repeat(900) + '最后衔接点';
  db.run('UPDATE chapters SET content = ? WHERE id = ?', [content, chapterId]);
  const tail = JSON.parse(truncateToolResult(await bookTools.executeRead(bookId, 'read_chapter', { chapterId, tail: true })));
  assert.ok(tail.content.endsWith('最后衔接点'));
  assert.equal(tail.end, content.length);
  let start = 0;
  let restored = '';
  do {
    const page = JSON.parse(truncateToolResult(await bookTools.executeRead(bookId, 'read_chapter_range', { chapterId, start, length: 4000 })));
    assert.equal(page.totalChars, content.length);
    assert.equal(page.start, start);
    assert.equal(page.end, start + page.content.length);
    restored += page.content;
    start = page.next_cursor;
  } while (start !== null);
  assert.equal(restored, content);
});
