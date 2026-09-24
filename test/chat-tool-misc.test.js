// 顺手修三件套回归：
//   1. compactBook 压缩输入保尾（提取纯函数 buildCompressTranscript）
//      —— 此前归档块按正序 slice(0,12000) 保头弃尾，被归档的最新内容没进摘要
//   2. grep_chapters 空关键词防护 —— split('') 会把每个字符算命中，返回整书伪结果
//   3. read_chapter 码点安全截断 —— 旧 brief 的 UTF-16 slice 会劈开代理对
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { buildCompressTranscript } = require('../server/routes/chat');
const bookTools = require('../server/bookTools');

async function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['顺手修回归']).lastInsertRowid;
  return bookId;
}

test('压缩转录：超限时保尾——归档块最新的内容必须进摘要输入', () => {
  const messages = [];
  for (let i = 1; i <= 60; i++) {
    messages.push({ role: 'user', content: `第${i}轮：`.padEnd(300, `话${i}`) });
  }
  const transcript = buildCompressTranscript(messages, { total: 6000 });
  assert.ok(transcript.includes('第60轮'), '归档块最新一轮必须保留');
  assert.ok(!transcript.includes('第1轮'), '超限时最旧内容让位（保尾）');
  assert.ok(transcript.length <= 6000, '整体不超过输入上限');
});

test('压缩转录：未超限时完整保留（不裁）', () => {
  const messages = [
    { role: 'user', content: '第一轮讨论' },
    { role: 'assistant', content: 'AI 回复' },
  ];
  const transcript = buildCompressTranscript(messages);
  assert.ok(transcript.includes('作者：第一轮讨论'));
  assert.ok(transcript.includes('AI：AI 回复'));
});

test('压缩转录：单条超 500 字截断', () => {
  const messages = [{ role: 'user', content: '长'.repeat(800) }];
  const transcript = buildCompressTranscript(messages);
  assert.ok(transcript.includes('…'));
  assert.ok(!transcript.includes('长'.repeat(600)), '单条内容应被裁到 500 字');
});

test('grep_chapters：空/空白关键词报错，不返回伪命中', async t => {
  const bookId = await setup(t);
  db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, '第一章', '正文')", [bookId]);
  await assert.rejects(
    bookTools.executeRead(bookId, 'grep_chapters', { keyword: '' }),
    err => err.code === 'INVALID_ARGS'
  );
  await assert.rejects(
    bookTools.executeRead(bookId, 'grep_chapters', { keyword: '   ' }),
    err => err.code === 'INVALID_ARGS'
  );
});

test('read_chapter：maxChars 截断不劈开代理对（emoji 完整保留）', async t => {
  const bookId = await setup(t);
  const chId = db.run(
    "INSERT INTO chapters (book_id, title, content) VALUES (?, '表情章', ?)",
    [bookId, '😀'.repeat(10)]
  ).lastInsertRowid;
  const r = await bookTools.executeRead(bookId, 'read_chapter', { chapterId: chId, maxChars: 5 });
  // 5 个码点 = 5 个完整 emoji；若按 UTF-16 slice 会得到 2 个 emoji + 半个代理对
  assert.equal((r.content.match(/😀/g) || []).length, 5);
  assert.ok(!r.content.includes('\uFFFD'), '不得出现替换字符（代理对被劈开的痕迹）');
  assert.equal(r.truncated, true);
  assert.equal(r.next_cursor, 10);
  assert.ok(r.content.endsWith('😀'));
});
