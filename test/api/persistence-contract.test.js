// S1-01 / C01：同步落盘失败的接口契约（01-架构与接口契约 §2）。
//   已应用到内存但未落盘 → HTTP 503 PERSISTENCE_PENDING、applied=true、附当前实体与脱敏状态；
//   恢复写盘后由有上限的自动重试完成落盘，客户端不得把 503 当“业务未执行”重放写操作；
//   flush 只落盘、不重做业务写入；确认执行的写工具结算记录不得标 approved-durable。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const { requestConfirmation, executeTool } = require('../../server/tools/executor');
const actionStore = require('../../server/actionStore');

const loadSqlJs = () => initSqlJs({
  locateFile: f => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', f),
});

// 直接读临时库文件（绕过内存态），验证磁盘真相
async function diskValue(file, sql, params = []) {
  const SQL = await loadSqlJs();
  const reopened = new SQL.Database(fs.readFileSync(file));
  const stmt = reopened.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
    return stmt.getAsObject();
  } finally {
    stmt.free();
    reopened.close();
  }
}

// 复刻 C01 反例的磁盘拒写注入：仅拦截目标临时库文件的 writeFileSync（.tmp 与回退直写都覆盖）
let writesBlocked = false;
let blockedPrefix = '';
const originalWrite = fs.writeFileSync;
function blockWrites(filePath) {
  blockedPrefix = String(filePath);
  writesBlocked = true;
}
function restoreWrites() {
  writesBlocked = false;
}

// 轮询直到谓词为真或超时（自动重试的等待必须有上限）
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return await predicate();
}

async function seedChapter(title) {
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['持久化契约书']).lastInsertRowid;
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)',
    [bookId, title, '原始正文']
  ).lastInsertRowid;
  return { bookId, chapterId };
}

test('PUT 章节遇磁盘拒写：503 PERSISTENCE_PENDING 而非假成功，恢复后自动重试落盘', async t => {
  // 安装拒写注入（进程级，必须在任何断言前生效；finally 兜底还原）
  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (writesBlocked && String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => { fs.writeFileSync = originalWrite; restoreWrites(); });

  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = await seedChapter('第一章');
  assert.equal(db.saveNow(), true, '基线应先成功落盘');
  const http = await listen(createApp());
  t.after(async () => { restoreWrites(); await http.close(); cleanup(location); });

  blockWrites(location.filePath);
  const r = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, { content: '仅在内存的新正文', expected_revision: 1 });

  // 契约：503 + applied=true + durable=false + 附当前实体；绝不假成功
  assert.equal(r.status, 503, `磁盘拒写时 PUT 不得宣称成功，实际 ${r.status}`);
  assert.equal(r.body.applied, true, '业务写已应用到内存，applied 必须为 true');
  assert.equal(r.body.persistence.durable, false);
  assert.equal(r.body.persistence.pending, true);
  assert.equal(r.body.code, 'PERSISTENCE_PENDING');
  assert.equal(r.body.chapter.id, chapterId, '响应须附当前实体标识');
  assert.ok(!JSON.stringify(r.body).includes(location.filePath), '响应不得泄漏本地文件路径');

  // 内存已应用、磁盘仍旧文的“已应用未落盘”中间态
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '仅在内存的新正文');
  assert.equal((await diskValue(location.filePath, 'SELECT content FROM chapters WHERE id = ?', [chapterId])).content, '原始正文');
  const midHealth = await json(http.baseUrl, 'GET', '/api/health');
  assert.equal(midHealth.body.persistence.dirty, true, '未落盘期间健康检查应持续可见');

  restoreWrites();
  // 恢复写盘后：不再发任何业务请求，等待有上限的自动重试完成
  const durable = await waitUntil(async () =>
    (await diskValue(location.filePath, 'SELECT content FROM chapters WHERE id = ?', [chapterId])).content === '仅在内存的新正文',
  15000);
  assert.ok(durable, '恢复写盘后应由自动重试完成落盘，无需重放业务写');
  const health = await json(http.baseUrl, 'GET', '/api/health');
  assert.equal(health.body.persistence.dirty, false, '自愈后 dirty 应回落');

  // flush 只落盘，不重做业务：记录数不再变化
  const countBeforeFlush = (await diskValue(location.filePath, 'SELECT COUNT(*) AS n FROM chapters')).n;
  const flush = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(flush.status, 200);
  const countAfterFlush = (await diskValue(location.filePath, 'SELECT COUNT(*) AS n FROM chapters')).n;
  assert.equal(countAfterFlush, countBeforeFlush);
});

test('POST 建章遇磁盘拒写：503 后不重放写操作，恢复后恰一章入库', async t => {
  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (writesBlocked && String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => { fs.writeFileSync = originalWrite; restoreWrites(); });

  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId } = await seedChapter('第一章');
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { restoreWrites(); await http.close(); cleanup(location); });
  const before = (await diskValue(location.filePath, 'SELECT COUNT(*) AS n FROM chapters')).n;

  blockWrites(location.filePath);
  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters`, { title: '拒写期间新建的章' });
  assert.equal(r.status, 503, `建章遇拒写应为 503，实际 ${r.status}`);
  assert.equal(r.body.applied, true);
  assert.equal(r.body.persistence.durable, false);
  assert.equal(r.body.code, 'PERSISTENCE_PENDING');
  assert.ok(Number.isInteger(r.body.chapter.id), '建章须返回真实 id，供客户端幂等核对而非重放');

  restoreWrites();
  const persisted = await waitUntil(async () =>
    (await diskValue(location.filePath, "SELECT COUNT(*) AS n FROM chapters WHERE title = '拒写期间新建的章'")).n === 1,
  15000);
  assert.ok(persisted, '恢复后自动重试应恰好落盘这一章');
  const after = (await diskValue(location.filePath, 'SELECT COUNT(*) AS n FROM chapters')).n;
  assert.equal(after, before + 1, '503 之后的自动重试不得重放 create');
});

test('POST /api/persistence/flush：干净时无事可做，有未落盘时只落盘，拒写时 503', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 干净状态：无未落盘改动
  const clean = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(clean.status, 200);
  assert.equal(clean.body.ok, true);
  assert.equal(clean.body.applied, false, '无待落盘改动时不应重写库文件');

  // 制造未落盘改动（绕过 1s debounce 前直接 flush）
  db.run("INSERT INTO books (title) VALUES ('flush 用书')");
  const flushed = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(flushed.status, 200);
  assert.equal(flushed.body.ok, true);
  assert.equal(flushed.body.applied, true);
  assert.equal((await diskValue(location.filePath, "SELECT COUNT(*) AS n FROM books WHERE title = 'flush 用书'")).n, 1);
});

test('flush 遇持续拒写：503 PERSISTENCE_PENDING，恢复后重试成功且不重做业务', async t => {
  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (writesBlocked && String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => { fs.writeFileSync = originalWrite; restoreWrites(); });

  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = await seedChapter('第一章');
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { restoreWrites(); await http.close(); cleanup(location); });

  blockWrites(location.filePath);
  const r = await json(http.baseUrl, 'PUT', `/api/books/${bookId}/chapters/${chapterId}`, { content: '等待 flush 的新正文', expected_revision: 1 });
  assert.equal(r.status, 503);
  const flushFail = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(flushFail.status, 503, '持续拒写时 flush 不得宣称成功');
  assert.equal(flushFail.body.ok, false);
  assert.equal(flushFail.body.code, 'PERSISTENCE_PENDING');
  assert.ok(!JSON.stringify(flushFail.body).includes(location.filePath), 'flush 响应不得泄漏本地路径');

  restoreWrites();
  const flushOk = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(flushOk.status, 200);
  assert.equal(flushOk.body.ok, true);
  assert.equal((await diskValue(location.filePath, 'SELECT content FROM chapters WHERE id = ?', [chapterId])).content, '等待 flush 的新正文');
  const count = (await diskValue(location.filePath, 'SELECT COUNT(*) AS n FROM chapters')).n;
  assert.equal(count, 1, 'flush 只落盘，不得新增/重放任何记录');
});

test('saveNow 失败安排有上限的自动重试，close 清理计时器', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });

  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (writesBlocked && String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    blockWrites(location.filePath);
    db.run("INSERT INTO books (title) VALUES ('重试调度用书')");
    assert.equal(db.saveNow(), false, '拒写时 saveNow 返回 false');
    const status = db.getPersistenceStatus();
    assert.equal(status.dirty, true);
    assert.ok(status.saveRetry >= 1, '失败必须计入重试计数');
    assert.equal(status.retryScheduled, true, '失败分支必须安排自动重试');
  } finally {
    fs.writeFileSync = originalWrite;
    restoreWrites();
    // close 必须清理重试计时器（不残留孤儿定时器拖住进程）
    db.close();
    assert.equal(db.getPersistenceStatus().retryScheduled, false, 'close 后不得残留重试计时器');
  }
  cleanup(location);
});

test('确认执行的写工具遇拒写：结果与结算记录标注未落盘，不得标 approved-durable', async t => {
  fs.writeFileSync = function patchedWrite(file, ...args) {
    if (writesBlocked && String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => { fs.writeFileSync = originalWrite; restoreWrites(); });

  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = await seedChapter('第一章');
  db.saveNow();
  const http = await listen(createApp());
  t.after(async () => { restoreWrites(); await http.close(); cleanup(location); });

  const ctx = { profile: 'writing', bookId, sessionId: 'persistence-contract', source: 'agent', actor: 'author' };
  const args = { chapterId, text: 'AI 追加的正文' };
  blockWrites(location.filePath);
  const conf = requestConfirmation(ctx, 'append_chapter', args);
  assert.equal(conf.status, 'confirmation_required');

  const result = await executeTool(ctx, 'append_chapter', actionStore.get(conf.confirmation.id).args, conf.confirmation.id);
  assert.equal(result.ok, true, '业务写已应用到内存，不得当失败回灌模型诱使重放');
  assert.ok(result.persistence, '写工具结果必须携带持久化状态');
  assert.equal(result.persistence.durable, false);
  assert.equal(result.persistence.code, 'PERSISTENCE_PENDING');

  const action = actionStore.get(conf.confirmation.id);
  assert.equal(action.status, 'approved');
  assert.equal(action.result.persistence.durable, false, '结算记录不得标 approved-durable');

  restoreWrites();
  const flush = await json(http.baseUrl, 'POST', '/api/persistence/flush');
  assert.equal(flush.status, 200);
  const onDisk = await diskValue(location.filePath, 'SELECT content FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(onDisk.content, '原始正文\nAI 追加的正文', '恢复后正文恰好追加一次，无重放');
});
