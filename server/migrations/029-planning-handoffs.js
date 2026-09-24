const version = 'planning_handoffs_v1';
const checksum = 'sha256:planning-handoffs-20260922-01';

// S4-04a / 契约 01 §6：规划笔记与显式交接两张表。
//   planning_notes：Agent 讨论里的结论草稿（含单调 revision 的乐观锁）。
//     **笔记没有正典效力**——status 被 CHECK 锁死在 'draft'：它不能变成已采纳状态，
//     也不写 story_events / 大纲 / 正文；要变成故事事实必须走既有领域提案与确认链。
//     book_id 允许 NULL（global 会话里的笔记不属于任何书，不入书备份）。
//   handoffs：跨空间交接草案。origin→target 的显式材料传递，status(draft|accepted|cancelled)
//     只表示交接单自身的状态，不代表故事事实被采纳。
//     origin_conversation_id 有意不建外键：来源可能是 global 会话，而 global 会话按设计
//     不进任何书的整书备份——建外键会让「global→book 交接」在整书恢复时插不回去。
//     target_conversation_id 属于目标书、必然随书导出，保留级联外键。
//   幂等：CREATE TABLE IF NOT EXISTS（存量库升级只补表，不加列、不改既有表）。
const up = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_notes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      selected_message_ids TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_planning_notes_conversation ON planning_notes(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_planning_notes_book ON planning_notes(book_id, id);

    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      origin_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      selected_message_ids TEXT NOT NULL DEFAULT '[]',
      text TEXT NOT NULL DEFAULT '',
      source_refs TEXT NOT NULL DEFAULT '[]',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'cancelled')),
      accepted_at TEXT,
      accepted_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_book ON handoffs(book_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_target ON handoffs(target_conversation_id, status);
  `);
};

module.exports = { version, checksum, up };
