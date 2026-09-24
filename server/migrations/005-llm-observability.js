const version = 'llm_observability_v1';
const checksum = 'sha256:llm-observability-v1-20260909-01';

// 调用可观测性（对齐 Codex CLI 会话 JSONL 的 token_count 事件落盘思路）：
//  - model_info：缓存渠道 /models 报告的上下文上限（唯一官方信息源；NULL = 渠道未报告，绝不猜测）
//  - llm_calls：每次模型调用落库一条（真实 usage / 请求组成估算 / finish / 状态 / 耗时），不再只存内存
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_info (
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      context_length INTEGER,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (base_url, model)
    );
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER,
      scope TEXT,
      model TEXT,
      base_url TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cache_hit_tokens INTEGER DEFAULT 0,
      cache_miss_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      system_tokens INTEGER DEFAULT 0,
      history_tokens INTEGER DEFAULT 0,
      tool_tokens INTEGER DEFAULT 0,
      output_reserve INTEGER DEFAULT 0,
      finish_reason TEXT DEFAULT '',
      status TEXT DEFAULT 'ok',
      error TEXT DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_book ON llm_calls(book_id, id);
  `);
}

module.exports = { version, checksum, up };
