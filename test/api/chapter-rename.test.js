// 章节改名契约（2026-09-11 A+B 可发现性修复的后端保护）：
// 目录行 ✎ 与阅读页标题点击都只提交 {title}——这条路径的语义必须被钉住，
// 否则后续任何"顺手统一保存逻辑"的改动都可能让改名连带拍版本快照、解除定稿或覆盖正文。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook(title);
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http };
}

test('只提交 title 改名：标题变、正文不动、定稿不被解除、不拍版本快照', async t => {
  const { bookId, http } = await setup(t, '改名书');
  const chId = db.run(
    'INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)',
    [bookId, '第一章 未命名', '这是正文内容。']
  ).lastInsertRowid;
  // 模拟已定稿章节：改名不应动 locked / locked_at / relock_pending
  db.run("UPDATE chapters SET locked = 1, locked_at = datetime('now','localtime') WHERE id = ?", [chId]);
  const beforeVersions = db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chId]).n;

  const res = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chId}`, { title: '第一章 雨夜', expected_revision: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.chapter.title, '第一章 雨夜');
  assert.equal(res.body.autoUnlocked, false, '改名不该触发自动解除定稿');
  assert.equal(res.body.chapter.content, '这是正文内容。', '正文必须原样保留');

  const row = db.get('SELECT title, content, locked, relock_pending FROM chapters WHERE id = ?', [chId]);
  assert.equal(row.locked, 1, '改名后仍保持定稿');
  assert.equal(row.relock_pending, 0, '改名不该标记"需重新定稿"');
  assert.equal(row.content, '这是正文内容。');

  const afterVersions = db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chId]).n;
  assert.equal(afterVersions, beforeVersions, '改名不该产生版本快照（快照只在正文变更时拍）');
});

test('改名遵守版本锁：过期 expected_revision → 409 且不写入（S1-03 单调版本）', async t => {
  const { bookId, http } = await setup(t, '改名冲突书');
  const chId = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '原名', 'x']).lastInsertRowid;
  // 另一窗口先改了（revision 前进到 2）
  db.run("UPDATE chapters SET title = '别处改的名', revision = revision + 1 WHERE id = ?", [chId]);

  const denied = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chId}`, {
    title: '我的新名',
    expected_revision: 1,
  });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'CHAPTER_CONFLICT');
  assert.equal(denied.body.details.currentRevision, 2);
  assert.equal(db.get('SELECT title FROM chapters WHERE id = ?', [chId]).title, '别处改的名', '冲突时绝不盲写');

  const fresh = Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chId]).revision);
  const ok = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chId}`, {
    title: '我的新名',
    expected_revision: fresh,
  });
  assert.equal(ok.status, 200);
  assert.equal(db.get('SELECT title FROM chapters WHERE id = ?', [chId]).title, '我的新名');
});

test('改名不出书：他书章节 → 404；不存在的章节 → 404', async t => {
  const { bookId, http } = await setup(t, '改名作用域书');
  const bookB = createBook('另一本');
  const chB = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookB, 'B的章', 'y']).lastInsertRowid;

  const cross = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chB}`, { title: '越权改名' });
  assert.equal(cross.status, 404);
  assert.equal(db.get('SELECT title FROM chapters WHERE id = ?', [chB]).title, 'B的章', '跨书改名必须失败且原样保留');

  const missing = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/999999`, { title: '幽灵章' });
  assert.equal(missing.status, 404);
});
