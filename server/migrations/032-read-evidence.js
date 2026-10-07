const version = 'read_evidence_v1';
const checksum = 'sha256:auto';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_read_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL CHECK (tool_name IN ('read_chapter', 'read_chapter_range')),
      tool_call_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE (run_id, tool_call_id, chapter_id, tool_name, revision, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_run_read_evidence_run ON run_read_evidence(run_id, id);
  `);
}

module.exports = { version, checksum, up };
