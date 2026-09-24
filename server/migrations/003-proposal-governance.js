const version = 'proposal_governance_v1';
const checksum = 'sha256:proposal-governance-v1-20260904-01';

// P2a 提案治理与审计底座（评审 §3 采纳授权边界 / §4 长任务 / §6 审计与回滚）：
// - event_proposals：区分创建者(created_by)、创建来源(created_via/session/model)、乐观锁(revision)、
//   内容快照(content_hash)、评审者(review_requested_by/reviewed_by)、修正提案(supersedes_event_id)。
//   注意：SQLite ALTER ADD COLUMN 不支持 CHECK/UNIQUE，created_by 等枚举由领域层校验。
// - proposal_revisions：提案编辑留痕（当前 updateProposal 会删除原 changes，无历史可回溯）。
// - chapter_extraction_runs：抽取覆盖持久化 + 幂等（替代进程内 dedupe，重启可查“某章是否抽取过”）。
// - tool_audit_logs：分离 requested_by/confirmed_by，存受限 args_json / 目标 revision / 结果实体列表 / 失败 details。
function addColumnIfMissing(db, table, column, ddl) {
  const columns = db.all(`PRAGMA table_info(${table})`).map(item => item.name);
  if (!columns.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function up(db) {
  // ---- event_proposals 扩展 ----
  addColumnIfMissing(db, 'event_proposals', 'supersedes_event_id', 'INTEGER REFERENCES story_events(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'event_proposals', 'created_by', "TEXT NOT NULL DEFAULT 'author'");
  addColumnIfMissing(db, 'event_proposals', 'created_via', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'event_proposals', 'created_session_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'event_proposals', 'created_model', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'event_proposals', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'event_proposals', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'event_proposals', 'review_requested_by', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'event_proposals', 'reviewed_by', "TEXT NOT NULL DEFAULT ''");

  // ---- tool_audit_logs 扩展（不新建重复表，沿用现有审计表）----
  addColumnIfMissing(db, 'tool_audit_logs', 'requested_by', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'tool_audit_logs', 'args_json', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'tool_audit_logs', 'target_revision', 'INTEGER');
  addColumnIfMissing(db, 'tool_audit_logs', 'result_entity_ids', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'tool_audit_logs', 'error_details', "TEXT NOT NULL DEFAULT ''");

  // ---- proposal_revisions：提案每次编辑保存一份快照，编辑不再丢失原 changes ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES event_proposals(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      changes_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL DEFAULT '',
      edited_by TEXT NOT NULL DEFAULT '',
      edit_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(proposal_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_revisions_proposal
      ON proposal_revisions(proposal_id, revision);

    CREATE TABLE IF NOT EXISTS chapter_extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      revision_hash TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','success','failed')),
      job_id TEXT NOT NULL DEFAULT '',
      proposal_count INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(book_id, chapter_id, revision_hash, source_type)
    );
    CREATE INDEX IF NOT EXISTS idx_extraction_runs_book
      ON chapter_extraction_runs(book_id, status);
    CREATE INDEX IF NOT EXISTS idx_extraction_runs_job
      ON chapter_extraction_runs(job_id);
  `);
}

module.exports = { version, checksum, up };
