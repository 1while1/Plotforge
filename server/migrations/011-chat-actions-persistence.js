const version = 'chat_actions_persistence_v1';
const checksum = 'sha256:chat-actions-persistence-20260910-01';

// 确认凭证与结算结果落库（方向报告 3.1）：actionStore 此前是进程内存 Map——
// 服务重启（升级/断电/误关，本地单机并不罕见）后作者正要点的确认卡直接失效
// （表现为「动作不存在」），已结算的结果与续跑状态也一并丢失。
// 落库后同一文件重开即恢复；行带过期语义（pending 过期 → expired，settled
// 超期清理），清理逻辑在 actionStore.sweep 内（与内存版一致的惰性清理）。
// 时间戳统一存 Date.now() 毫秒整型（沿用内存版时基，避免换算层）。
function up(db) {
  db.exec(`
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
      CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_actions_book ON chat_actions(book_id, status);
  `);
}

module.exports = { version, checksum, up };
