const version = 'proposal_discard_ledger_v1';
const checksum = 'sha256:auto'; // 由 migrations/index.js 以内容哈希覆盖语义（A9）

// A-1（G5 审计 P1-1）提案作废墓碑台账：AI 抽取在「在途窗口」内捕获的正文已变化时，
// 整批提案不创建——但作废本身是必须留痕的审计事实（谁在何时、用哪个模型、依据哪版正文
// 抽了什么、因哪次改稿作废），否则「AI 结果被静默丢弃」无法与「根本没抽」区分。
//
// 表口径（照 llm_calls 模式，委托方已批准占用 030 号）：
//  · 全局台账：book_id/chapter_id 只作普通整数，**不挂 books 级外键** —— 删书后仍要留作痕
//    （ON DELETE CASCADE 会把痕迹连带删掉，那正是「静默」而非「可审计」）。
//  · **不进 bookBackup**：书级导出/恢复只搬书内创作资产；墓碑是运行留痕，不是创作资产，
//    恢复一本书不该把其它书的作废行带回来（`server/bookBackup.js` 的 TABLES 清单不变）。
//  · 不设清理策略：量级已评估为每年 KB 级（一次作废一行），无清理需求。
//  · expected_hash/current_hash 都是正文 SHA-256（server/evidence/draftLexical.revision 同源），
//    两值可直接与 event_proposals.source_revision_hash 互查。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_discards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      source_path TEXT NOT NULL CHECK (source_path IN ('finalize', 'backfill')),
      reason TEXT NOT NULL CHECK (reason IN ('SOURCE_CHANGED', 'CHAPTER_MISSING')),
      expected_hash TEXT NOT NULL DEFAULT '',
      current_hash TEXT NOT NULL DEFAULT '',
      candidate_count INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      job_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_discards_book ON proposal_discards(book_id, id);
  `);
}

module.exports = { version, checksum, up };
