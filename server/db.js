// SQLite 数据层：基于 sql.js（纯 WASM，免编译），提供同步查询、事务与版本化迁移。
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_FILE = path.join(DEFAULT_DATA_DIR, 'novel.db');

let db = null;
let dbFile = DEFAULT_DB_FILE;
let saveTimer = null;
let retryTimer = null;
let transactionDepth = 0;
let dirty = false;
let saveRetry = 0;

// 定时落盘失败时的退避重试上限与间隔（超限后不再自动重试，改由下一次写操作触发）
const SAVE_RETRY_MAX = 5;
const SAVE_RETRY_DELAY_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  intro TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS world_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  appearance TEXT DEFAULT '',
  personality TEXT DEFAULT '',
  background TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  intro TEXT DEFAULT '',
  outline TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS story_state (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (book_id, kind)
);
CREATE TABLE IF NOT EXISTS polish_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  scope TEXT DEFAULT 'chapter',
  original TEXT DEFAULT '',
  polished TEXT DEFAULT '',
  requirement TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_polish_history ON polish_history(chapter_id);
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL,
  chunk_idx INTEGER DEFAULT 0,
  text TEXT DEFAULT '',
  vector BLOB,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_chapter ON embeddings(chapter_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_book ON embeddings(book_id);
CREATE TABLE IF NOT EXISTS chapter_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chapter_versions ON chapter_versions(chapter_id);
`;

const COLUMN_MIGRATIONS = [
  ['books', 'mode', "TEXT DEFAULT 'collab'"],
  ['books', 'master_outline', "TEXT DEFAULT ''"],
  ['chapters', 'volume_id', 'INTEGER'],
  ['chapters', 'beat', "TEXT DEFAULT ''"],
  ['chapters', 'drift_status', "TEXT DEFAULT ''"],
  ['chapters', 'drift_note', "TEXT DEFAULT ''"],
  ['messages', 'reasoning', "TEXT DEFAULT ''"],
  ['chapters', 'locked', 'INTEGER DEFAULT 0'],
  ['chapters', 'locked_at', 'TEXT'],
  ['messages', 'compressed', 'INTEGER DEFAULT 0'],
];

function assertOpen() {
  if (!db) throw new Error('数据库尚未初始化');
}

function rows(stmt) {
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function all(sql, params = []) {
  assertOpen();
  return rows(db.prepare(sql, params));
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function markDirty() {
  dirty = true;
  if (transactionDepth === 0) scheduleSave();
}

function run(sql, params = []) {
  assertOpen();
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  const lastInsertRowid = get('SELECT last_insert_rowid() AS id').id;
  const changes = db.getRowsModified();
  markDirty();
  return { lastInsertRowid, changes };
}

function exec(sql) {
  assertOpen();
  db.exec(sql);
  markDirty();
}

function save() {
  if (!db) return;
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const exported = Buffer.from(db.export());
  // db.export() 会关闭并重开底层连接，PRAGMA foreign_keys 随之被重置为 OFF。
  // 不补回的话，首次落盘之后全库外键就永久处于关闭状态，
  // 各表的 ON DELETE CASCADE 全部失效，删书不再级联删卷/章/事件，孤儿行持续累积。
  db.run('PRAGMA foreign_keys = ON');
  // 原子写：先写 .tmp 再 rename，避免落盘中途崩溃/断电留下半截库文件
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, exported);
  try {
    fs.renameSync(tmp, dbFile);
  } catch (_) {
    // Windows 下目标文件被占用时 rename 会失败，回退为直接覆盖写
    fs.writeFileSync(dbFile, exported);
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略清理失败 */ }
  }
  dirty = false;
  lastSaveAt = new Date().toISOString();
  lastSaveError = null;
  // 落盘成功后，遗留的 debounce/重试计时器都无事可做，一并清掉，
  // 否则 init（SCHEMA/迁移标记的脏）之后长达 1s 谎报 pending=true
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  clearRetryTimer();
}

// 重试耗尽后的低频自愈间隔：磁盘满/文件被占用类故障恢复后，
// 无需等“下一次写操作”即可重新落盘（A3：避免耗尽后静默停摆、一切照常 200）
const SAVE_EXHAUSTED_RETRY_MS = 30 * 1000;
let lastSaveError = null;
let lastSaveAt = null;

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// 单一重试调度：saveNow 与定时落盘共用一个受追踪的重试计时器（S1-01/C01——
// 此前 saveNow 失败分支只置 dirty 返回 false，没有任何后续落盘安排）。
// 耗尽上限后退化为低频自愈，不叠加多个并行定时器。
function scheduleSaveRetry() {
  if (retryTimer || saveTimer) return;
  const delay = saveRetry < SAVE_RETRY_MAX ? SAVE_RETRY_DELAY_MS : SAVE_EXHAUSTED_RETRY_MS;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (db && dirty && !saveTimer && transactionDepth === 0) scheduleSave();
  }, delay);
}

function scheduleSave() {
  if (transactionDepth > 0 || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    try {
      save();
      saveRetry = 0;
    } catch (err) {
      // 定时器回调里抛错会成为 uncaughtException 直接崩掉整个服务。
      // 兜住并保留 dirty，退避后重试，让磁盘满/文件被占用这类瞬时故障可自愈。
      dirty = true;
      saveRetry += 1;
      lastSaveError = err && err.message ? err.message : String(err);
      console.error(`[db] 定时落盘失败(第 ${saveRetry}/${SAVE_RETRY_MAX} 次):`, lastSaveError);
      scheduleSaveRetry();
    }
  }, 1000);
}

// 关键写路径同步落盘（A2）：绕过 1s debounce 立即写盘，关闭“API 已返回 200 但 1 秒内
// 断电/强杀即丢该笔修改”的窗口。落盘失败不抛错（内存写入已成功），保留 dirty 并安排
// 有上限的退避重试（S1-01/C01），与 /api/health 一起暴露，返回值表示是否已真正持久化。
function saveNow() {
  if (!db) return false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    save();
    saveRetry = 0;
    return true;
  } catch (err) {
    dirty = true;
    saveRetry += 1;
    lastSaveError = err && err.message ? err.message : String(err);
    console.error(`[db] 同步落盘失败(第 ${saveRetry}/${SAVE_RETRY_MAX} 次，已安排自动重试):`, lastSaveError);
    scheduleSaveRetry();
    return false;
  }
}

function transaction(work) {
  assertOpen();
  if (transactionDepth !== 0) throw new Error('不支持嵌套数据库事务');
  if (typeof work !== 'function') throw new TypeError('transaction 需要函数');
  if (work.constructor && work.constructor.name === 'AsyncFunction') {
    throw new Error('数据库事务回调必须是同步函数');
  }
  const dirtyBefore = dirty;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  db.run('BEGIN IMMEDIATE');
  transactionDepth = 1;
  try {
    const result = work();
    if (result && typeof result.then === 'function') {
      throw new Error('数据库事务回调必须是同步函数');
    }
    db.run('COMMIT');
    transactionDepth = 0;
    markDirty();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
    transactionDepth = 0;
    dirty = dirtyBefore;
    if (dirty) scheduleSave();
    throw err;
  }
}

function migrateLegacyColumns() {
  // 返回是否真的改动了结构/数据，供 init 决定要不要落盘（幂等 no-op 不该触发全量重写）
  let changed = false;
  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    const cols = all(`PRAGMA table_info(${table})`).map(c => c.name);
    if (!cols.includes(column)) { run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`); changed = true; }
  }

  const books = all('SELECT id FROM books');
  for (const book of books) {
    let volume = get('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order, id LIMIT 1', [book.id]);
    if (!volume) {
      run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [book.id, '第一卷']);
      volume = get('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order, id LIMIT 1', [book.id]);
      changed = true;
    }
    const r = run('UPDATE chapters SET volume_id = ? WHERE book_id = ? AND volume_id IS NULL', [volume.id, book.id]);
    if (r.changes > 0) changed = true;
  }
  return changed;
}

let lockFd = null;
let lockPath = null;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// 单实例锁：sql.js 是全库内存态 + 整文件覆盖写，两个进程同开一个库时后落盘者会
// 整库抹掉先写方（脑裂且双方均无告警）。启动时对库文件加排他锁，第二实例拒绝启动。
// 锁文件内写持有者 PID；若持有者已死（上次崩溃残留）则接管，避免死锁文件永久挡路。
function acquireLock(file) {
  const target = file + '.lock';
  if (fs.existsSync(target)) {
    let holder = NaN;
    try { holder = parseInt(fs.readFileSync(target, 'utf8'), 10); } catch (_) { /* 读不出视为 stale */ }
    if (isProcessAlive(holder)) {
      const err = new Error(`数据库已被进程 ${holder} 占用（${target}）。sql.js 双开会整库互相覆盖，本实例拒绝启动；若确认对方已退出，删除该锁文件后重试。`);
      err.code = 'DB_LOCKED';
      throw err;
    }
    try { fs.unlinkSync(target); } catch (_) { /* 竞争下继续走 wx 创建 */ }
  }
  lockFd = fs.openSync(target, 'wx');
  fs.writeSync(lockFd, String(process.pid));
  lockPath = target;
}

function releaseLock() {
  if (lockFd !== null) { try { fs.closeSync(lockFd); } catch (_) { /* 忽略 */ } lockFd = null; }
  if (lockPath) { try { fs.unlinkSync(lockPath); } catch (_) { /* 忽略 */ } lockPath = null; }
}

async function init(options = {}) {
  if (db) close();
  dbFile = path.resolve(options.filePath || process.env.NOVEL_DB_FILE || DEFAULT_DB_FILE);
  const fileExisted = fs.existsSync(dbFile);
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  acquireLock(dbFile);
  db = fileExisted ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
  try {
    db.run('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    // SCHEMA 全是 CREATE ... IF NOT EXISTS：对已存在的库是幂等 no-op，不该仅因跑了它就重写整个库文件。
    // 先把 dirty 归零作为基线，之后只有真正的结构/数据迁移才重新置脏（A-15/D4-06：每次启动全量重写）。
    // exec(SCHEMA) 已武装了一个 1s debounce 计时器，但它触发时 dirty 必为 false——
    // 清掉这个幽灵计时器，避免 init 后长达 1s 谎报 pending=true。
    dirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const structChanged = migrateLegacyColumns();

    let migrated = false;
    if (options.migrateVersions !== false) {
      const migrations = require('./migrations');
      const r = migrations.applyPending(module.exports, { filePath: dbFile, fileExisted });
      migrated = Boolean(r && r.backupPath); // backupPath 非空 = 确实执行了 pending 迁移
    }
    // 只有「新库」或「确实发生了结构/数据迁移」才落盘；否则内存态已就绪（pragma 已 ON），无需写盘。
    if (!fileExisted || structChanged || migrated) save();
    return module.exports;
  } catch (err) {
    close({ save: false });
    throw err;
  }
}

function close(options = {}) {
  if (!db) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  clearRetryTimer();
  if (dirty && options.save !== false) save();
  db.close();
  db = null;
  transactionDepth = 0;
  dirty = false;
  releaseLock();
}

function getFilePath() {
  return dbFile;
}

// 对外脱敏：fs 报错原文可能携带本机绝对路径（如 ENOSPC ... 'C:\...\novel.db.tmp'），
// 健康接口/HTTP 响应不得回传原始路径，只保留错误类别描述
function sanitizeSaveError(message) {
  return String(message || '')
    .replace(/[A-Za-z]:\\[^'"\s]*/g, '[路径已隐藏]')
    .replace(/\/[^'"\s]{2,}/g, '[路径已隐藏]');
}

// 持久化健康度：供 /api/health 暴露，前端可在“有未落盘改动/重试耗尽”时挂横幅警示
function getPersistenceStatus() {
  return {
    dirty,
    saveRetry,
    exhausted: saveRetry >= SAVE_RETRY_MAX,
    pending: saveTimer !== null,
    retryScheduled: retryTimer !== null,
    lastSaveAt,
    lastSaveError: sanitizeSaveError(lastSaveError),
  };
}

// 优雅落盘：仅在有未落盘改动（dirty）时才写，避免干净退出也无谓重写整个库文件。
function flushOnExit() {
  if (db && dirty) { try { save(); } catch (_) { /* 退出不覆盖原错误 */ } }
  releaseLock();
}
process.on('exit', flushOnExit);
// SIGINT（Ctrl+C）与 SIGTERM（kill/容器停止/PM2）都要落盘；此前只有 SIGINT，SIGTERM 会丢最后一秒的改动。
function gracefulShutdown() {
  flushOnExit();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

module.exports = { init, close, all, get, run, exec, transaction, save, saveNow, getFilePath, getPersistenceStatus };
