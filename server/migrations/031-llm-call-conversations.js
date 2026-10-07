const version = 'llm_call_conversations_v1';
const checksum = 'sha256:auto';

function up(db) {
  const columns = db.all('PRAGMA table_info(llm_calls)').map(row => row.name);
  if (!columns.includes('conversation_id')) db.exec('ALTER TABLE llm_calls ADD COLUMN conversation_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_llm_calls_conversation ON llm_calls(conversation_id, id)');
}

module.exports = { version, checksum, up };
