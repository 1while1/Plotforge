// 第二轮重审查五条 P1 的回归保护（报告 §6 / Q24 指出这些修复原先零测试保护）：
//   A2 关键写同步落盘 saveNow 关闭 1s 丢失窗
//   A3 /api/health 暴露持久化健康度（dirty / 重试耗尽）
//   A4 单实例锁：第二进程同开一库被拒绝（DB_LOCKED）
//   A5 流式客户端断连后不把用户没看到的回复入库
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const express = require('express');
const initSqlJs = require('sql.js');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

const loadSqlJs = () => initSqlJs({
  locateFile: f => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
});
const countBooksInFile = async (SQL, file) => {
  const reopened = new SQL.Database(fs.readFileSync(file));
  const n = reopened.exec('SELECT COUNT(*) FROM books')[0].values[0][0];
  reopened.close();
  return n;
};

// ---------------- A2：saveNow 同步关闭落盘窗口 ----------------
test('A2 saveNow 立即落盘：debounce 未触发时文件无新行，saveNow 后有', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const SQL = await loadSqlJs();

  db.run('INSERT INTO books (title) VALUES (?)', ['A2']);
  // 1s debounce 尚未触发：此刻磁盘上不应有这一行（丢失窗存在）
  assert.equal(await countBooksInFile(SQL, location.filePath), 0, 'debounce 窗口内磁盘应无新行');
  // 关键写路径同步落盘后立即可见
  assert.equal(db.saveNow(), true);
  assert.equal(await countBooksInFile(SQL, location.filePath), 1, 'saveNow 后磁盘应立即有新行');
});

// ---------------- A3：/api/health 暴露持久化健康度 ----------------
test('A3 /api/health 反映 dirty 与落盘状态', async t => {
  const location = createTempLocation();
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  await db.init({ filePath: location.filePath });

  let r = await json(http.baseUrl, 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.persistence.dirty, false, '干净启动应 dirty=false');

  db.run('INSERT INTO books (title) VALUES (?)', ['A3']);
  r = await json(http.baseUrl, 'GET', '/api/health');
  assert.equal(r.body.persistence.dirty, true, '写入后应 dirty=true 供前端挂横幅');

  db.saveNow();
  r = await json(http.baseUrl, 'GET', '/api/health');
  assert.equal(r.body.persistence.dirty, false, '落盘后应回到 dirty=false');
});

// ---------------- A4：单实例锁，第二进程拒绝启动 ----------------
test('A4 双进程同开一库：第二实例被 DB_LOCKED 拒绝，释放后可再开', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath }); // 父进程持有锁

  const dbModule = path.join(__dirname, '..', 'server', 'db.js');
  const childCode =
    `const db = require(${JSON.stringify(dbModule)});` +
    `db.init({ filePath: ${JSON.stringify(location.filePath) } })` +
    `.then(() => { console.log('LOCK_NOT_HELD'); process.exit(0); })` +
    `.catch(e => { console.log('CODE=' + e.code); process.exit(3); });`;
  const runChild = () => new Promise(resolve => {
    execFile(process.execPath, ['--eval', childCode], (err, stdout) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout) });
    });
  });

  const locked = await runChild();
  assert.equal(locked.code, 3, '第二实例应启动失败');
  assert.ok(locked.stdout.includes('CODE=DB_LOCKED'), `应报 DB_LOCKED，实际：${locked.stdout}`);

  db.close(); // 释放锁
  const freed = await runChild();
  assert.equal(freed.code, 0, '释放后应能正常启动');
  assert.ok(freed.stdout.includes('LOCK_NOT_HELD'));
});

// ---------------- A5：客户端断连不入库没看到的回复 ----------------
// 假上游：慢速流式（40ms/块），给客户端留出中途 abort 的窗口
function makeSlowStreamApp() {
  const app = express();
  app.use(express.json());
  app.post('/chat/completions', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i > 40) { clearInterval(timer); res.write('data: [DONE]\n\n'); return res.end(); }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `字${i}` } }] })}\n\n`);
    }, 40);
    req.on('close', () => clearInterval(timer));
  });
  return app;
}

test('A5 流式中途断连：assistant 不入库（不污染历史、不白烧后续轮）', async t => {
  const location = createTempLocation();
  const fake = await listen(makeSlowStreamApp());
  t.after(async () => { await fake.close(); });
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['A5']).lastInsertRowid;
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [fake.baseUrl]);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['agnes-2.5-flash']);
  const http = await listen(createApp());
  t.after(async () => {
    // 强制断开 keep-alive/半开连接，避免 server.close() 等待导致测试进程不退出
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    if (fake.server.closeAllConnections) fake.server.closeAllConnections();
    await http.close();
    cleanup(location);
  });

  // 原生 http 客户端：读到首个数据即 destroy（模拟关页/断网），避免 undici abort 的句柄残留
  const url = new URL(http.baseUrl);
  await new Promise(resolve => {
    const req = require('node:http').request({
      method: 'POST', host: url.hostname, port: url.port,
      path: `/api/books/${bookId}/chat/stream`,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
    const bail = setTimeout(() => { req.destroy(); resolve(); }, 3000);
    req.write(JSON.stringify({ content: '写点什么' }));
    req.end();
    req.on('close', () => clearTimeout(bail));
  });

  await new Promise(r => setTimeout(r, 600)); // 给服务端处理断连的时间
  const counts = db.get(
    "SELECT SUM(role='user') AS u, SUM(role='assistant') AS a FROM messages WHERE book_id = ?",
    [bookId]
  );
  assert.equal(Number(counts.u), 1, '用户消息应入库');
  assert.equal(Number(counts.a || 0), 0, '断连后 assistant 不应入库');
});
