const crypto = require('crypto');

const version = 'character_hub_v1';
const checksum = 'sha256:character-hub-v1-20260813-01';

function now() {
  return new Date().toISOString();
}

function normalizeAlias(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function ensureColumn(db, table, column, definition) {
  const columns = db.all(`PRAGMA table_info(${table})`).map(item => item.name);
  if (!columns.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const STATE_FIELDS = [
  ['location', '位置', 'text', 10, 1],
  ['camp', '阵营', 'text', 20, 1],
  ['life_status', '生存状态', 'enum', 30, 1],
  ['health', '健康状态', 'enum', 40, 1],
  ['power_level', '能力层级', 'level', 50, 1],
  ['goal', '当前目标', 'text', 60, 1],
  ['possession', '关键持有物', 'list', 70, 1],
  ['identity', '身份揭露', 'text', 80, 0],
];

const RELATION_TYPES = [
  ['family', '亲属', '亲属', 'none', 'positive', 10],
  ['mentor', '师父', '弟子', 'a_to_b', 'positive', 20],
  ['friend', '朋友', '朋友', 'both', 'positive', 30],
  ['lover', '恋人', '恋人', 'both', 'positive', 40],
  ['enemy', '敌对', '敌对', 'both', 'negative', 50],
  ['master_servant', '主人', '下属', 'a_to_b', 'neutral', 60],
  ['ally', '利益盟友', '利益盟友', 'both', 'neutral', 70],
  ['unrequited_love', '单恋', '被爱慕', 'a_to_b', 'positive', 80],
  ['use', '利用', '被利用', 'a_to_b', 'negative', 90],
  ['rival', '宿敌', '宿敌', 'both', 'mixed', 100],
];

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      alias_normalized TEXT NOT NULL,
      alias_type TEXT NOT NULL DEFAULT 'other',
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE(character_id, alias_normalized)
    );
    CREATE INDEX IF NOT EXISTS idx_character_aliases_book_alias
      ON character_aliases(book_id, alias_normalized);
    CREATE INDEX IF NOT EXISTS idx_character_aliases_character
      ON character_aliases(character_id, is_primary);

    CREATE TABLE IF NOT EXISTS state_field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK(value_type IN ('text','enum','list','level')),
      options_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(book_id, field_key)
    );

    CREATE TABLE IF NOT EXISTS relation_type_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      type_key TEXT NOT NULL,
      forward_label TEXT NOT NULL,
      reverse_label TEXT NOT NULL,
      default_direction TEXT NOT NULL CHECK(default_direction IN ('none','a_to_b','b_to_a','both')),
      default_polarity TEXT NOT NULL CHECK(default_polarity IN ('positive','neutral','negative','mixed')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(book_id, type_key)
    );

    CREATE TABLE IF NOT EXISTS story_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      paragraph_index INTEGER,
      narrative_sequence INTEGER NOT NULL DEFAULT 0,
      importance TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low','normal','high','critical')),
      origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','proposal','advisor','import')),
      supersedes_event_id INTEGER REFERENCES story_events(id) ON DELETE SET NULL,
      source_revision_hash TEXT NOT NULL DEFAULT '',
      source_quote TEXT NOT NULL DEFAULT '',
      source_stale INTEGER NOT NULL DEFAULT 0 CHECK(source_stale IN (0, 1)),
      created_by TEXT NOT NULL DEFAULT 'author',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_events_timeline
      ON story_events(book_id, chapter_id, narrative_sequence, id);
    CREATE INDEX IF NOT EXISTS idx_story_events_supersedes
      ON story_events(supersedes_event_id);

    CREATE TABLE IF NOT EXISTS story_event_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES story_events(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('character_state','relation')),
      subject_ref TEXT NOT NULL,
      field_key TEXT NOT NULL,
      old_value_json TEXT NOT NULL DEFAULT 'null',
      new_value_json TEXT NOT NULL DEFAULT 'null',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_event_changes_subject
      ON story_event_changes(book_id, change_kind, subject_ref, field_key, event_id);

    CREATE TABLE IF NOT EXISTS character_state_values (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source_event_id INTEGER NOT NULL REFERENCES story_events(id),
      last_event_id INTEGER NOT NULL REFERENCES story_events(id),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (book_id, character_id, field_key)
    );

    CREATE TABLE IF NOT EXISTS character_relations (
      public_id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      endpoint_a INTEGER NOT NULL REFERENCES characters(id),
      endpoint_b INTEGER NOT NULL REFERENCES characters(id),
      relation_type_id INTEGER NOT NULL REFERENCES relation_type_definitions(id),
      direction TEXT NOT NULL CHECK(direction IN ('none','a_to_b','b_to_a','both')),
      strength INTEGER NOT NULL CHECK(strength BETWEEN 1 AND 5),
      polarity TEXT NOT NULL CHECK(polarity IN ('positive','neutral','negative','mixed')),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','dormant','ended')),
      secrecy TEXT NOT NULL CHECK(secrecy IN ('public','secret')),
      note TEXT NOT NULL DEFAULT '',
      source_event_id INTEGER NOT NULL REFERENCES story_events(id),
      last_event_id INTEGER NOT NULL REFERENCES story_events(id),
      updated_at TEXT NOT NULL,
      CHECK(endpoint_a < endpoint_b),
      UNIQUE(book_id, endpoint_a, endpoint_b, relation_type_id)
    );
    CREATE INDEX IF NOT EXISTS idx_character_relations_a ON character_relations(book_id, endpoint_a);
    CREATE INDEX IF NOT EXISTS idx_character_relations_b ON character_relations(book_id, endpoint_b);

    CREATE TABLE IF NOT EXISTS event_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      paragraph_index INTEGER,
      narrative_sequence INTEGER NOT NULL DEFAULT 0,
      importance TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low','normal','high','critical')),
      source_type TEXT NOT NULL CHECK(source_type IN ('chapter_summary','advisor','history_backfill','manual')),
      source_revision_hash TEXT NOT NULL DEFAULT '',
      source_quote TEXT NOT NULL DEFAULT '',
      confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      extraction_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','merged','stale')),
      review_note TEXT NOT NULL DEFAULT '',
      merged_into_id INTEGER REFERENCES event_proposals(id) ON DELETE SET NULL,
      accepted_event_id INTEGER REFERENCES story_events(id) ON DELETE SET NULL,
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE(book_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_event_proposals_inbox
      ON event_proposals(book_id, status, chapter_id, id);

    CREATE TABLE IF NOT EXISTS event_proposal_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES event_proposals(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('character_state','relation')),
      subject_ref TEXT NOT NULL,
      field_key TEXT NOT NULL,
      old_value_json TEXT NOT NULL DEFAULT 'null',
      new_value_json TEXT NOT NULL DEFAULT 'null',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS story_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('foreshadow','mystery','promise','debt','plan')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','progressing','resolved','abandoned')),
      importance TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low','normal','high','critical')),
      opened_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      target_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      resolved_event_id INTEGER REFERENCES story_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_threads_book_status
      ON story_threads(book_id, status, type);

    CREATE TABLE IF NOT EXISTS story_thread_characters (
      thread_id INTEGER NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      PRIMARY KEY (thread_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS advisor_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      trigger_kind TEXT NOT NULL DEFAULT 'manual',
      focus TEXT NOT NULL DEFAULT '',
      context_revision TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS advisor_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      suggestion_type TEXT NOT NULL CHECK(suggestion_type IN ('A','B','C','D')),
      title TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      inference TEXT NOT NULL DEFAULT '',
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      impacts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','adopted','ignored')),
      fingerprint TEXT NOT NULL,
      evidence_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_advisor_suggestion_dedupe
      ON advisor_suggestions(book_id, character_id, fingerprint, status);

    CREATE TABLE IF NOT EXISTS advisor_citations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id INTEGER NOT NULL REFERENCES advisor_suggestions(id) ON DELETE CASCADE,
      anchor TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      quote_snapshot TEXT NOT NULL,
      trust_class TEXT NOT NULL,
      canonical_status TEXT NOT NULL,
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      paragraph_index INTEGER,
      char_start INTEGER,
      char_end INTEGER,
      revision_hash TEXT NOT NULL DEFAULT '',
      stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0, 1)),
      relocated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS advisor_adoptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id INTEGER NOT NULL REFERENCES advisor_suggestions(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_entity_type TEXT NOT NULL DEFAULT '',
      target_entity_id TEXT NOT NULL DEFAULT '',
      confirmation_actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projection_watermarks (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      projection_name TEXT NOT NULL CHECK(projection_name IN ('character_state','relations')),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      rebuilt_at TEXT,
      checksum TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (book_id, projection_name)
    );

    CREATE TABLE IF NOT EXISTS sidebar_preferences (
      book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      module_order_json TEXT NOT NULL,
      hidden_modules_json TEXT NOT NULL,
      summary_fields_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT '',
      book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
      tool_name TEXT NOT NULL,
      capability TEXT NOT NULL,
      mutation TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      confirmation_id TEXT NOT NULL DEFAULT '',
      confirmed_by TEXT NOT NULL DEFAULT '',
      result_entity_type TEXT NOT NULL DEFAULT '',
      result_entity_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_book_time
      ON tool_audit_logs(book_id, created_at);
  `);
}

function seedBook(db, bookId) {
  const time = now();
  for (const [key, label, type, order, enabled] of STATE_FIELDS) {
    db.run(
      `INSERT OR IGNORE INTO state_field_definitions
       (book_id, field_key, label, value_type, options_json, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      [bookId, key, label, type, enabled, order, time, time]
    );
  }
  for (const [key, forward, reverse, direction, polarity, order] of RELATION_TYPES) {
    db.run(
      `INSERT OR IGNORE INTO relation_type_definitions
       (book_id, type_key, forward_label, reverse_label, default_direction, default_polarity,
        sort_order, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [bookId, key, forward, reverse, direction, polarity, order, time, time]
    );
  }
  for (const projection of ['character_state', 'relations']) {
    db.run(
      `INSERT OR IGNORE INTO projection_watermarks
       (book_id, projection_name, last_event_id, checksum) VALUES (?, ?, 0, '')`,
      [bookId, projection]
    );
  }
}

function seedExistingData(db) {
  for (const book of db.all('SELECT id FROM books')) seedBook(db, book.id);
  // Legacy databases may contain rows left behind by older cleanup paths that ran
  // without foreign-key enforcement. Only seed aliases for characters whose book
  // still exists; orphan cleanup is a separate, explicit data-repair decision.
  for (const character of db.all(`
    SELECT c.id, c.book_id, c.name
    FROM characters c JOIN books b ON b.id = c.book_id
  `)) {
    const normalized = normalizeAlias(character.name);
    if (!normalized) continue;
    db.run(
      `INSERT OR IGNORE INTO character_aliases
       (book_id, character_id, alias, alias_normalized, alias_type, is_primary, created_at)
       VALUES (?, ?, ?, ?, 'primary', 1, ?)`,
      [character.book_id, character.id, String(character.name).trim(), normalized, now()]
    );
  }
}

function up(db) {
  ensureColumn(db, 'characters', 'intro', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'characters', 'archived_at', 'TEXT');
  ensureColumn(db, 'characters', 'updated_at', 'TEXT');
  ensureColumn(db, 'embeddings', 'paragraph_start', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'embeddings', 'paragraph_end', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'embeddings', 'char_start', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'embeddings', 'char_end', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'embeddings', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'embeddings', 'source_revision_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'embeddings', 'indexed_at', 'TEXT');
  createTables(db);
  db.run('DELETE FROM embeddings');
  seedExistingData(db);
}

function makeDedupeKey(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = {
  version,
  checksum,
  up,
  seedBook,
  normalizeAlias,
  makeDedupeKey,
  STATE_FIELDS,
  RELATION_TYPES,
};
