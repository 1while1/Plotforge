const version = 'action_recovery_v1';
const checksum = 'sha256:action-recovery-20260921-01';

// S2-02 / C07：执行中断的确认可解释、不可盲重放。
//   问题：authorize 置 executing 后、settle 落盘前进程中断（重启/崩溃），
//   action 永远卡在 executing——确认入口报「已结算」（说谎），也没有任何状态说明
//   业务到底执行了没有。领域写（sql.js 同步语句）可能已应用，盲重放会二次执行。
//   本迁移：status 新增 'interrupted'（结果不确定，不得重放）；新增三列——
//     run_id          发起该确认的模型运行（创建时快照，供关联展示与追溯）
//     settlement_ref  durable 结算凭据（settle 落盘时写入，编码结算状态；恢复时
//                     仅凭它 + result_json 双全才允许恢复既有 approved/failed）
//     recovery_reason 中断原因（启动恢复/备份恢复写入，UI 展示「可能已部分生效」）
//   target_revision 已在 016 存在，复用不重复加列。
//   SQLite 无法修改 CHECK → 重建表（建新表→拷旧数据→drop→rename→重建索引）。
// 幂等：已含新列则直接返回。
const BASE_COLUMNS = `
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
    run_id TEXT,
    settlement_ref TEXT,
    recovery_reason TEXT,
    CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired', 'superseded', 'interrupted'))
`;

function up(db) {
  const exists = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_actions'");
  if (!exists) {
    db.exec(`CREATE TABLE chat_actions (${BASE_COLUMNS});
      CREATE INDEX IF NOT EXISTS idx_chat_actions_book ON chat_actions(book_id, status);`);
    return;
  }
  const cols = db.all('PRAGMA table_info(chat_actions)').map(row => row.name);
  if (cols.includes('settlement_ref')) return;

  db.exec(`
    DROP TABLE IF EXISTS chat_actions_recovery_new;
    CREATE TABLE chat_actions_recovery_new (${BASE_COLUMNS});
    INSERT INTO chat_actions_recovery_new (
      id, book_id, name, args_json, args_hash, session_id, tool_call_id, target_revision,
      requested_by, status, summary, impact_json, result_json, created_at, expires_at,
      settled_at, used_at, resume_done, resume_message_id, expiry_notified, superseded_by,
      run_id, settlement_ref, recovery_reason
    )
    SELECT
      id, book_id, name, args_json, args_hash, session_id, tool_call_id, target_revision,
      requested_by, status, summary, impact_json, result_json, created_at, expires_at,
      settled_at, used_at, resume_done, resume_message_id, expiry_notified, superseded_by,
      NULL, NULL, NULL
    FROM chat_actions;
    DROP TABLE chat_actions;
    ALTER TABLE chat_actions_recovery_new RENAME TO chat_actions;
    CREATE INDEX IF NOT EXISTS idx_chat_actions_book ON chat_actions(book_id, status);
  `);
}

module.exports = { version, checksum, up };
