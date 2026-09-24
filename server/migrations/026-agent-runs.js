const version = 'agent_runs_v1';
const checksum = 'sha256:auto'; // 由 migrations/index.js 以内容哈希覆盖语义（A9）

// 统一运行记录（S2-01 / 契约 3.1）：写作聊天流与独立 Agent 共用一张运行表，
// 让「同一逻辑请求只跑一次」「同书写互斥」「重启后未结算运行可解释」成为库内事实，
// 而不是两个入口各自内存里互不知情的 Map。
//
// agent_runs：一次模型运行 = 一行。request_id 由客户端生成（重试复用同一个），
// session_key 服务端派生（写作=writing:book:<id>，Agent=agent:<会话>），二者联合唯一——
// 同 session+request 幂等返回既有运行，不同 request 在协调器忙时 409。
// resume_action_id 部分唯一索引：一个确认动作至多关联一次续跑运行（S2-03 的库级防绕过底座）。
//
// agent_run_events：服务端顺序 seq 的事件流（phase/tool_started/tool_result/
// confirmation_required/resource_changed/run_finished/error）。与 SSE 线上格式解耦：
// 线上格式照旧（adapter 映射），事件表是重启/重复请求后可回读的运行真相。
// 正文内容不进事件表（messages 是正典存储），run_finished 只带终态与原因。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      conversation_id TEXT,
      entry TEXT NOT NULL CHECK (entry IN ('chat', 'agent')),
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('write', 'discuss', 'execute')),
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'awaiting_confirmation', 'finished', 'paused', 'failed', 'cancelled', 'interrupted')),
      reason TEXT,
      resume_action_id TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_request ON agent_runs(session_key, request_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_book ON agent_runs(book_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_resume_action
      ON agent_runs(resume_action_id) WHERE resume_action_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, seq);
  `);
}

module.exports = { version, checksum, up };
