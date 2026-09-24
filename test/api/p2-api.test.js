// 第二轮重审查 P2/P3 API 层修复的回归保护：
//   A6  PUT /api/settings 私网 base_url 拒绝；恶意 Origin 拒绝（403）
//   A8  章节正文乐观锁：过期 expected_updated_at → 409；匹配 → 200；AI 追加同样受守卫
//   A10 POST 章节(updated_at)、消息入库时基统一 localtime
//   A12 compactBook 归档两步写事务化：存档行写入失败 → 全部回滚
//   A15 非流式 chat 失败：用户消息回删 + llm_calls 落 error 台账
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

// ---------------- 假 LLM 服务器 ----------------
let fake;
const state = { requests: [], responder: () => ({ json: completion('', 'stop') }) };
function completion(content, finish_reason) { return { choices: [{ message: { content }, finish_reason }] }; }

function makeFakeApp() {
  const app = express();
  app.use(express.json());
  app.post('/chat/completions', (req, res) => {
    state.requests.push(req.body);
    const out = state.responder(req.body, state.requests.length - 1);
    if (out.status && out.status !== 200) return res.status(out.status).send(out.text || 'error');
    return res.json(out.json);
  });
  return app;
}

before(async () => { fake = await listen(makeFakeApp()); });
after(async () => { await fake.close(); });

async function setup(t, title) {
  state.requests = [];
  state.responder = () => ({ json: completion('ok', 'stop') });
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  // base_url 直接写库（与既有 chat-resilience 测试同路径），不经过 PUT 校验
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?)", [fake.baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'test-model')");
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, http };
}

// ---------------- A6 ----------------
test('A6 PUT base_url 指向回环/私网被 400 拒绝（SSRF 闸门）', async t => {
  const { http } = await setup(t, 'A6');
  const r = await json(http.baseUrl, 'PUT', '/api/settings', { base_url: 'http://127.0.0.1:9999/v1' });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /私网|回环|拒绝/);
  // 未入库
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'base_url'").value, fake.baseUrl, '非法 base_url 不应覆盖原值');
});

test('A6 恶意 Origin 请求被 403 拒绝，本机 Origin 放行', async t => {
  const { http } = await setup(t, 'A6O');
  const evil = await fetch(http.baseUrl + '/api/books', { headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403, '跨站 Origin 应被拒绝');
  const ok = await fetch(http.baseUrl + '/api/books', { headers: { Origin: `http://127.0.0.1:${new URL(http.baseUrl).port}` } });
  assert.equal(ok.status, 200, '本机 Origin 应放行');
});

// ---------------- A8 ----------------
test('A8 章节正文版本锁：过期 expected_revision → 409，匹配 → 200（S1-03 单调版本）', async t => {
  const { bookId, http } = await setup(t, 'A8 书');
  const created = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters`, { title: '第一章' });
  const chapterId = created.body.chapter.id;
  assert.equal(created.body.chapter.revision, 1, '新建章节返回真实 revision');

  // 模拟另一窗口已保存：内容与 revision 都推进
  db.run("UPDATE chapters SET content = '另一窗口的新内容', revision = revision + 1 WHERE id = ?", [chapterId]);
  const stale = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, {
    content: '过期窗口的旧内容',
    expected_revision: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CHAPTER_CONFLICT');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '另一窗口的新内容', '冲突时绝不盲写');

  // 带当前版本提交 → 200
  const freshRevision = Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chapterId]).revision);
  const good = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, {
    content: '本窗口的最新内容',
    expected_revision: freshRevision,
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.chapter.revision, freshRevision + 1);
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '本窗口的最新内容');
});

test('A8 AI 追加章节带过期版本被拒绝，不覆盖人工编辑（S1-03 revision 口径）', async t => {
  const { bookId } = await setup(t, 'A8 AI');
  const chId = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, '第一章', '人工正文')", [bookId]).lastInsertRowid;
  const bookTools = require('../../server/bookTools');
  // 业务失败统一抛 DomainError（旧 {error,code} 返回值曾被执行器误结算为成功）
  await assert.rejects(
    bookTools.executeWrite(bookId, 'append_chapter', {
      chapterId: chId, text: 'AI 追加', expected_revision: 99,
    }),
    err => err.code === 'CHAPTER_CONFLICT' && err.status === 409
  );
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chId]).content, '人工正文', 'AI 过期写入不得覆盖');

  const current = Number(db.get('SELECT revision FROM chapters WHERE id = ?', [chId]).revision);
  const okWrite = await bookTools.executeWrite(bookId, 'append_chapter', {
    chapterId: chId, text: 'AI 追加', expected_revision: current,
  });
  assert.equal(okWrite.ok, true);
  const after = db.get('SELECT content, revision, updated_at FROM chapters WHERE id = ?', [chId]);
  assert.equal(after.content, '人工正文\nAI 追加', '追加语义：原正文 + 换行 + 追加文本');
  assert.match(after.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'AI 写入后 updated_at 更新为 localtime 格式');
});

// ---------------- A10 ----------------
test('A10 POST 章节的 updated_at 为 localtime 格式（修复前为 UTC datetime）', async t => {
  const { bookId, http } = await setup(t, 'A10 书');
  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters`, { title: '第一章' });
  assert.equal(r.status, 200);
  assert.match(r.body.chapter.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '应为 SQL localtime 格式');
});

// ---------------- A12 ----------------
test('A12 compactBook 归档两步写事务化：存档行写入失败全部回滚', async t => {
  const { bookId, http } = await setup(t, 'A12 书');
  for (let i = 0; i < 5; i++) {
    await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: `第${i}轮对话内容，凑足可压缩消息量。` });
  }
  const beforeActive = db.get("SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND COALESCE(compressed,0) != 1", [bookId]).n;
  assert.ok(beforeActive >= 4, '前置：应有足够活跃消息');

  const chatRouter = require('../../server/routes/chat');
  const origRun = db.run;
  try {
    // 让存档行 INSERT 炸掉，验证 UPDATE(compressed=1) 被一起回滚（A12 修复前会留下半截状态）
    db.run = function (sql, params) {
      if (/INSERT INTO messages/.test(sql) && /compressed/.test(sql)) {
        throw new Error('injected archive failure');
      }
      return origRun.call(db, sql, params);
    };
    await assert.rejects(
      () => chatRouter.compactBook(bookId, 10),
      /injected archive failure/
    );
  } finally {
    db.run = origRun;
  }
  const halfState = db.get("SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND compressed = 1", [bookId]).n;
  assert.equal(halfState, 0, '回滚后不得有任何消息被标记 compressed=1（半截状态）');
  const afterActive = db.get("SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND COALESCE(compressed,0) != 1", [bookId]).n;
  assert.equal(afterActive, beforeActive, '活跃消息数应与压缩前一致');
});

// ---------------- A15 ----------------
test('A15 非流式 chat 上游失败：用户消息回删 + llm_calls 落 error 台账', async t => {
  const { bookId, http } = await setup(t, 'A15 书');
  state.responder = () => ({ status: 500, text: 'upstream down' });

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chat`, { content: '这次会失败的消息' });
  assert.equal(r.status, 502);
  // 给重试退避留一点余量（500ms/1s 两轮退避）后核对库
  const orphans = db.get("SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND role = 'user'", [bookId]).n;
  assert.equal(orphans, 0, '失败轮的用户消息应被回删，不留无回复孤儿');
  const ledger = db.get("SELECT status, error FROM llm_calls WHERE book_id = ? AND scope = 'chat' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.ok(ledger, '失败调用应落 llm_calls 台账');
  assert.equal(ledger.status, 'error');
  assert.ok(String(ledger.error).length > 0);
});
