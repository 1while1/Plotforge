const version = 'ledger_repair_v1';
const checksum = 'sha256:ledger-repair-v1-20260904-01';

// P6 台账修复与回滚（评审 §6）：
// - event_proposals.job_id：回填/抽取任务产生的提案记录来源 job_id，
//   以便「一次性驳回某次任务产生的全部 pending 提案」（回填出错时整批撤销）。
//   SQLite ALTER ADD COLUMN 不支持索引内联，索引单独 CREATE。
function addColumnIfMissing(db, table, column, ddl) {
  const columns = db.all(`PRAGMA table_info(${table})`).map(item => item.name);
  if (!columns.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function up(db) {
  addColumnIfMissing(db, 'event_proposals', 'job_id', "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_proposals_job
      ON event_proposals(book_id, job_id, status);
  `);
}

module.exports = { version, checksum, up };
