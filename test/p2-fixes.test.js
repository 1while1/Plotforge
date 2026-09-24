// 第二轮重审查 P2 修复的回归保护（报告 A6/A7/A9/A10/A11/A12；A8/A15 见 test/api/p2-api.test.js）：
//   A6 SSRF 防护：urlGuard 私网/回环识别 + 出网校验
//   A7 context_window 钳制：越界值夹进 [4096, 2000000]
//   A9 迁移 checksum 内容化（告警不炸启动）+ 关键索引自愈
//   A11 chapter_versions 外键级联：删章/删书不再留孤儿版本行
//   A10 时基统一：story_state 写入为 localtime 格式
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPrivateHostname, assertPublicBaseUrl, isAllowedHost, isAllowedOrigin,
} = require('../server/urlGuard');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');

// ---------------- A6：urlGuard ----------------
test('A6 urlGuard：回环/私网/链路本地主机名全部识别', () => {
  for (const host of [
    'localhost', '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1',
    'mybox.local', 'svc.internal', '::ffff:192.168.0.1',
  ]) {
    assert.equal(isPrivateHostname(host), true, `${host} 应判为私网/回环`);
  }
  for (const host of ['api.deepseek.com', '8.8.8.8', '172.32.0.1', 'example.com']) {
    assert.equal(isPrivateHostname(host), false, `${host} 应判为公网`);
  }
});

test('A6 urlGuard：base_url 指向私网/回环被拒，公网 http(s) 放行', () => {
  for (const bad of [
    'http://127.0.0.1:3198/v1', 'http://localhost:3000/v1', 'http://192.168.1.5/v1',
    'http://10.0.0.1/v1', 'https://router.local/v1', 'ftp://example.com', 'not a url',
  ]) {
    assert.throws(() => assertPublicBaseUrl(bad), undefined, `${bad} 应被拒绝`);
  }
  assert.doesNotThrow(() => assertPublicBaseUrl('https://apihub.agnes-ai.com/v1'));
  assert.doesNotThrow(() => assertPublicBaseUrl('http://api.example.com/v1'));
});

test('A6 urlGuard：Host/Origin 校验放行本机与无 Origin 客户端，拒绝恶意来源', () => {
  assert.equal(isAllowedHost('127.0.0.1:3100'), true);
  assert.equal(isAllowedHost('localhost:3100'), true);
  assert.equal(isAllowedHost('[::1]:3100'), true);
  assert.equal(isAllowedHost('evil.example.com'), false);
  assert.equal(isAllowedHost(undefined), true, 'curl/测试可不带 Host 以外的校验');

  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:3100'), true, '非浏览器无 Origin 放行');
  assert.equal(isAllowedOrigin('http://127.0.0.1:3100', '127.0.0.1:3100'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173', '127.0.0.1:3100'), true);
  assert.equal(isAllowedOrigin('http://evil.example', '127.0.0.1:3100'), false);
  assert.equal(isAllowedOrigin('null', '127.0.0.1:3100'), false, 'sandboxed origin=null 拒绝');
});

// ---------------- A7：窗口钳制 ----------------
test('A7 context_window 越界钳制：1e9 → 上限，100 → 下限，合法值原样', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const llm = require('../server/llm');
  assert.equal(llm.CONTEXT_WINDOW_MAX, 2000000);
  assert.equal(llm.CONTEXT_WINDOW_MIN, 4096);

  db.run("INSERT INTO settings (key, value) VALUES ('context_window', '1000000000')");
  const huge = llm.resolveContextWindow('agnes-2.5-flash');
  assert.ok(huge <= llm.CONTEXT_WINDOW_MAX, `1e9 应被钳到上限，实际 ${huge}`);

  db.run("UPDATE settings SET value = '100' WHERE key = 'context_window'");
  const tiny = llm.resolveContextWindow('agnes-2.5-flash');
  assert.ok(tiny >= llm.CONTEXT_WINDOW_MIN, `100 应被抬到下限，实际 ${tiny}`);
  // max_tokens 不再随爆炸窗口算出超出常理的值（outputTokenBudget 本身有 16000 封顶）
  assert.ok(llm.outputTokenBudget('agnes-2.5-flash') <= 16000);

  db.run("UPDATE settings SET value = '200000' WHERE key = 'context_window'");
  assert.equal(llm.resolveContextWindow('agnes-2.5-flash'), 200000, '区间内手动值原样生效');
});

// ---------------- A9：迁移 checksum 内容化 + 索引自愈 ----------------
test('A9 迁移记录 checksum 被篡改：告警自愈而非拒绝启动', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const migrations = require('../server/migrations');
  const target = migrations.MIGRATIONS.find(m => m.version === 'messages_book_index_v1');
  db.run("UPDATE schema_versions SET checksum = 'sha256:tampered-by-attacker' WHERE version = 'messages_book_index_v1'");
  db.close();

  // 篡改后重启：不抛错（旧实现 init 直接炸），记录被自愈为当前内容哈希
  await db.init({ filePath: location.filePath });
  const row = db.get("SELECT checksum FROM schema_versions WHERE version = 'messages_book_index_v1'");
  assert.equal(row.checksum, target.contentChecksum, '篡改记录应被自愈为当前内容哈希');
});

test('A9 关键索引被删后重启自动补建', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  db.exec('DROP INDEX idx_messages_book');
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_book'"), null);
  db.close();

  await db.init({ filePath: location.filePath });
  assert.ok(
    db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_book'"),
    '重启后 idx_messages_book 应被自愈补建'
  );
});

// ---------------- A11：chapter_versions 外键级联 ----------------
test('A11 删章节/删书后 chapter_versions 不再残留孤儿行', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['A11 书']).lastInsertRowid;
  const ch1 = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, ?, '初稿一')", [bookId, '第一章']).lastInsertRowid;
  const ch2 = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, ?, '初稿二')", [bookId, '第二章']).lastInsertRowid;
  const versions = require('../server/versions');
  versions.snapshot(ch1, 'test');
  versions.snapshot(ch1, 'test');
  versions.snapshot(ch2, 'test');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapter_versions').n, 3);

  // FK 已就位（migration 009 重建过表）
  const fk = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='chapter_versions'");
  assert.ok(/REFERENCES chapters\(id\) ON DELETE CASCADE/.test(fk.sql), 'chapter_versions 应带级联外键');

  // 删章 → 版本级联消失（此前永久残留）
  db.run('DELETE FROM chapters WHERE id = ?', [ch1]);
  db.run('DELETE FROM chapter_versions WHERE chapter_id = ? AND 1=0'); // no-op，确保表可查
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [ch1]).n, 0,
    '删章后该章版本行应被级联删除'
  );

  // 删书 → 全部版本清零（此前实测留 2 行孤儿）
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapter_versions').n, 0, '删书后不应有任何版本孤儿');
});

// ---------------- §6.10-A：polish_history 外键级联（镜像 A11） ----------------
test('A11b 删章节/删书后 polish_history 不再残留孤儿行（migration 010）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['A11b 书']).lastInsertRowid;
  const ch1 = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, ?, '初稿一')", [bookId, '第一章']).lastInsertRowid;
  const ch2 = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, ?, '初稿二')", [bookId, '第二章']).lastInsertRowid;
  const insertPolish = (chapterId, polished) => db.run(
    'INSERT INTO polish_history (chapter_id, scope, original, polished, requirement) VALUES (?, ?, ?, ?, ?)',
    [chapterId, 'chapter', '原稿', polished, '要求']
  );
  insertPolish(ch1, '精修一');
  insertPolish(ch1, '精修二');
  insertPolish(ch2, '精修三');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM polish_history').n, 3);

  // FK 已就位（migration 010 重建过表）
  const fk = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='polish_history'");
  assert.ok(/REFERENCES chapters\(id\) ON DELETE CASCADE/.test(fk.sql), 'polish_history 应带级联外键');
  assert.ok(
    db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_polish_history'"),
    'polish_history 应有 chapter_id 索引'
  );

  // 删章 → 精修历史级联消失（此前永久残留）
  db.run('DELETE FROM chapters WHERE id = ?', [ch1]);
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM polish_history WHERE chapter_id = ?', [ch1]).n, 0,
    '删章后该章精修历史行应被级联删除'
  );

  // 删书 → 全部清零
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM polish_history').n, 0, '删书后不应有任何精修历史孤儿');
});

// ---------------- A10：story_state 时基 ----------------
// write_story_state 已随死工具清理删除（方向报告 1.10）；本用例改走存活的
// update_book_progress 工具（同一张 story_state 表、同一 SQL localtime 写入约定）
test('A10 story_state 写入 updated_at 为 localtime 格式（非 ISO）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['A10 书']).lastInsertRowid;
  const registry = require('../server/tools/registry');
  const tool = registry.descriptor('update_book_progress');
  await tool.execute({ bookId, args: { summary: '进展到第三章' } });
  const row = db.get("SELECT updated_at FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'story_state.updated_at 应为 SQL localtime 格式');
});

// 批次 C 补漏：PUT /ledger/progress 与 PUT /state 两个作者手写路径此前仍写 ISO（UTC 带 T/Z），
// 与同列 localtime 混排导致字符串排序错序（storyState provider 取「最后更新」的排序依据）
test('A10 手写路径 PUT /ledger/progress 与 PUT /state 也写 localtime 格式', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['A10 手写书']).lastInsertRowid;
  const { createApp } = require('../server/app');
  const { listen, json } = require('./helpers/http');
  const http = await listen(createApp());
  t.after(async () => { await http.close(); });

  const put = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/ledger/progress`, { summary: '进展到第五章' });
  assert.equal(put.status, 200);
  assert.match(put.body.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'PUT /ledger/progress 响应应回 localtime 格式');

  await json(http.baseUrl, 'PUT', `/api/books/${bookId}/state`, { characters: '林野在北境', book_summary: '进展到第五章' });

  const rows = db.all('SELECT kind, updated_at FROM story_state WHERE book_id = ?', [bookId]);
  assert.ok(rows.length >= 2, '应有 book_summary 与 characters 两行');
  for (const r of rows) {
    assert.match(r.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `PUT /state 写入的 ${r.kind} 应为 SQL localtime 格式`);
  }
});
