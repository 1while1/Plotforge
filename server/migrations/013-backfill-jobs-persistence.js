const version = 'backfill_jobs_persistence_v1';
const checksum = 'sha256:backfill-jobs-persistence-20260910-01';

// 回填任务状态落库（方向报告 3.1 第二部分）：任务状态此前是进程内存 Map——
// 服务重启后按 job_id 只能诚实报 lost（汇总 chapter_extraction_runs），实时进度
// 与计数全部丢失，作者还要记得手动重新触发。落库后 getStatus 直接从表还原
// 「本书最近一次任务」视图；resumeInterrupted 在启动时把死在半路（phase='running'）
// 的任务自动续跑一次（resume_count 防崩溃循环），幂等跳过已成功抽取的章节。
// started_at/done_at 由 persistStatus 单点写 ISO（毫秒精度可排序）；updated_at 用
// SQL localtime——列内各自单一格式，不违反 A10（A10 禁的是同列混排）。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_jobs (
      job_id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      phase TEXT NOT NULL DEFAULT 'running',
      force INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      skipped_changes INTEGER NOT NULL DEFAULT 0,
      skipped_chapters INTEGER NOT NULL DEFAULT 0,
      chapters_hit INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      options TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      done_at TEXT,
      last_chapter_id INTEGER,
      resume_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_backfill_jobs_book ON backfill_jobs(book_id, started_at);
  `);
}

module.exports = { version, checksum, up };
