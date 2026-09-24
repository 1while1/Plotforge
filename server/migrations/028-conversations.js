const version = 'conversations_v1';
const checksum = 'sha256:conversations-20260922-01';

// S3-01 / C10-A（契约 §4/§5）：服务端会话、消息归属与工具证据存储。
//   conversations：kind(agent|writing) × scope(book|global)，writing 必须挂书；
//   global 会话 book_id 为 NULL——绝不伪造 bookId=0（messages.book_id 原为 NOT NULL，
//   为容纳 global 消息按 027 模式重建表：复制全部旧列、主键原样、索引重建）。
//   messages 复用不另建聊天表：新增 conversation_id（FK CASCADE，删会话即删其消息——
//   归档不删史，走 status 而非 DELETE）与 tool_facts_json（服务端写入的可信工具事实，
//   与前端渲染用的 tools_json 分离）。
//   conversation_summaries：压缩内容/被覆盖消息范围/指纹（S3-04 使用，表随本迁移建立）。
//   旧消息按书归入每书一个 legacy-writing 会话（确定性 id，含 read 来源与已压缩行）。
//   幂等：表 IF NOT EXISTS + 列存在检查 + INSERT OR IGNORE + 只处理无归属行。
const LEGACY_TITLE = '写作历史对话';

function legacyConversationId(bookId) {
  return `legacy-writing-${bookId}`;
}

// 为书确保一个 legacy-writing 会话，并把该书无会话归属的消息归入其中。
// 迁移与 bookBackup 旧版备份恢复共用（迁移 up 内与恢复事务内均为同步语句）。
function assignOrphanMessages(dbApi, bookId) {
  const orphans = dbApi.get(
    'SELECT COUNT(*) AS n FROM messages WHERE book_id = ? AND conversation_id IS NULL', [bookId]);
  if (!orphans || !orphans.n) return null;
  const id = legacyConversationId(bookId);
  dbApi.run(
    `INSERT OR IGNORE INTO conversations
       (id, kind, scope, book_id, title, status, context_policy_json, created_at, updated_at)
     VALUES (?, 'writing', 'book', ?, ?, 'active', '{"legacy":true}',
             datetime('now','localtime'), datetime('now','localtime'))`,
    [id, bookId, LEGACY_TITLE]
  );
  dbApi.run(
    'UPDATE messages SET conversation_id = ? WHERE book_id = ? AND conversation_id IS NULL',
    [id, bookId]
  );
  return id;
}

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'writing')),
      scope TEXT NOT NULL CHECK (scope IN ('book', 'global')),
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      context_policy_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      CHECK (kind != 'writing' OR (scope = 'book' AND book_id IS NOT NULL)),
      CHECK (scope != 'book' OR book_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_book ON conversations(book_id, kind, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_kind ON conversations(kind, scope, updated_at);

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      covered_message_ids TEXT NOT NULL DEFAULT '[]',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      usage_estimate INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_summaries ON conversation_summaries(conversation_id, status, id);
  `);

  const cols = db.all('PRAGMA table_info(messages)').map(row => row.name);
  if (!cols.includes('conversation_id')) {
    db.exec(`
      DROP TABLE IF EXISTS messages_conversations_new;
      CREATE TABLE messages_conversations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        reasoning TEXT DEFAULT '',
        compressed INTEGER DEFAULT 0,
        tools_json TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        tool_facts_json TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO messages_conversations_new
        (id, book_id, role, content, created_at, reasoning, compressed, tools_json, source)
      SELECT id, book_id, role, content, created_at, reasoning, compressed, tools_json, source
      FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_conversations_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_book ON messages(book_id, id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
    `);
  }

  const books = db.all(
    'SELECT DISTINCT book_id FROM messages WHERE conversation_id IS NULL AND book_id IS NOT NULL');
  for (const row of books) {
    assignOrphanMessages(db, row.book_id);
  }
}

module.exports = { version, checksum, up, assignOrphanMessages, legacyConversationId, LEGACY_TITLE };
