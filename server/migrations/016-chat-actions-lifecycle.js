const version = 'chat_actions_lifecycle_v1';
const checksum = 'sha256:chat-actions-lifecycle-20260911-01';

// 确认卡生命周期（2026-09-11 真实库 chat_actions 取证）：
//   F2 近重复卡并存 —— 同一章连开 3 张 create_chapter 卡（参数只差标题「第6章」vs「第6章：书架间的猎物」），
//      精确去重按设计不合并，作者面对三张几乎一样的卡；
//   F3 过期静默丢意图 —— 5 张卡 30 分钟 TTL 静默过期，其中「第三卷改名回常识修改」的 update_volume
//      从未执行，模型却把它当既定事实继续写作；
//   F5a 结算卡不可回放 —— settled 行 30 分钟即被 sweep 删除，作者刷新后连「已结算」痕迹都没有。
// 本迁移：状态机新增 'superseded'（被更新的同类请求取代）；新增 expiry_notified（过期卡是否已作为
// 系统事件回灌模型——保证同一批只通知一次）与 superseded_by（取代者 id，供前端重建卡片链）。
// SQLite 无法修改 CHECK 约束 → 重建表：建新表 → 拷旧数据（新列取默认值）→ drop 旧表 → rename →
// 重建 idx_chat_actions_book。migrations/index.js 已在外层包事务，这里只用 db.exec。
// 幂等：已含新列则直接返回（重复执行不复制、不丢行）。
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_actions (
    id TEXT PRIMARY KEY,
    book_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '{}',
    args_hash TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL DEFAULT '',
    target_revision INTEGER,
    requested_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    impact_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    settled_at INTEGER,
    used_at INTEGER,
    resume_done INTEGER NOT NULL DEFAULT 0,
    resume_message_id INTEGER,
    expiry_notified INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT,
    CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired', 'superseded'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_actions_book ON chat_actions(book_id, status);
`;

function up(db) {
  const exists = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_actions'");
  if (!exists) {
    db.exec(TABLE_SQL);
    return;
  }
  const cols = db.all('PRAGMA table_info(chat_actions)').map(row => row.name);
  if (cols.includes('expiry_notified') && cols.includes('superseded_by')) return;

  db.exec(`
    DROP TABLE IF EXISTS chat_actions_lifecycle_new;
    CREATE TABLE chat_actions_lifecycle_new (
      id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      args_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL DEFAULT '',
      target_revision INTEGER,
      requested_by TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',
      impact_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      settled_at INTEGER,
      used_at INTEGER,
      resume_done INTEGER NOT NULL DEFAULT 0,
      resume_message_id INTEGER,
      expiry_notified INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired', 'superseded'))
    );
    INSERT INTO chat_actions_lifecycle_new (
      id, book_id, name, args_json, args_hash, session_id, tool_call_id, target_revision,
      requested_by, status, summary, impact_json, result_json, created_at, expires_at,
      settled_at, used_at, resume_done, resume_message_id, expiry_notified, superseded_by
    )
    SELECT
      id, book_id, name, args_json, args_hash, session_id, tool_call_id, target_revision,
      requested_by, status, summary, impact_json, result_json, created_at, expires_at,
      settled_at, used_at, resume_done, resume_message_id, 0, NULL
    FROM chat_actions;
    DROP TABLE chat_actions;
    ALTER TABLE chat_actions_lifecycle_new RENAME TO chat_actions;
    CREATE INDEX IF NOT EXISTS idx_chat_actions_book ON chat_actions(book_id, status);
  `);
}

module.exports = { version, checksum, up };
