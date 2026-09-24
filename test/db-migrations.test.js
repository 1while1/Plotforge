const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, createTempLocation, createLegacySeed, cleanup } = require('./helpers/temp-db');
const migration = require('../server/migrations/001-character-hub');
const { MIGRATIONS, MIGRATION_FILES } = require('../server/migrations');

test('character_hub_v1 migrates legacy data, seeds definitions, and creates one backup', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));

  await db.init({ filePath: location.filePath });

  assert.deepEqual(
    db.all("SELECT version FROM schema_versions ORDER BY version"),
    [
      { version: 'action_recovery_v1' },
      { version: 'agent_runs_v1' },
      { version: 'ai_style_samples_v1' },
      { version: 'backfill_jobs_persistence_v1' },
      { version: 'book_summary_propagation_v1' },
      { version: 'chapter_recycle_v1' },
      { version: 'chapter_revision_v1' },
      { version: 'chapter_versions_fk_v1' },
      { version: 'character_hub_v1' },
      { version: 'chat_actions_lifecycle_v1' },
      { version: 'chat_actions_persistence_v1' },
      { version: 'conversations_v1' },
      { version: 'corpus_tables_v1' },
      { version: 'ledger_repair_v1' },
      { version: 'llm_call_parts_v1' },
      { version: 'llm_call_schema_v1' },
      { version: 'llm_observability_v1' },
      { version: 'message_source_v1' },
      { version: 'message_tools_persistence_v1' },
      { version: 'messages_book_index_v1' },
      { version: 'planning_handoffs_v1' },
      { version: 'polish_history_fk_v1' },
      { version: 'proposal_discard_ledger_v1' },
      { version: 'proposal_governance_v1' },
      { version: 'relock_pending_v1' },
      { version: 'style_packs_v1' },
      { version: 'style_rules_general_v1' },
      { version: 'volume_summary_propagation_v1' },
      { version: 'writer_cards_v1' },
    ]
  );
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
  for (const name of [
    'character_aliases',
    'state_field_definitions',
    'relation_type_definitions',
    'story_events',
    'story_event_changes',
    'character_state_values',
    'character_relations',
    'event_proposals',
    'event_proposal_changes',
    'story_threads',
    'advisor_sessions',
    'projection_watermarks',
    'sidebar_preferences',
    'tool_audit_logs',
    'proposal_discards',
  ]) {
    assert.equal(tables.has(name), true, `missing table ${name}`);
  }

  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM state_field_definitions WHERE book_id = ?', [location.bookId]).n,
    8
  );
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM relation_type_definitions WHERE book_id = ?', [location.bookId]).n,
    10
  );
  assert.deepEqual(
    db.get(
      'SELECT alias, alias_type, is_primary FROM character_aliases WHERE character_id = ?',
      [location.characterId]
    ),
    { alias: '林野', alias_type: 'primary', is_primary: 1 }
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM embeddings').n, 0);

  const backups = fs.readdirSync(path.join(location.dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.ok(fs.statSync(path.join(location.dir, 'backups', backups[0])).size > 0);
});

test('transaction rolls back every write and rejects async callbacks', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  assert.throws(() => db.transaction(() => {
    db.run("INSERT INTO books (title) VALUES ('会回滚')");
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM books').n, 0);

  assert.throws(
    () => db.transaction(async () => 'not allowed'),
    /必须是同步函数/
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM books').n, 0);
});

test('migration is idempotent and seedBook initializes books created later', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  db.close();
  await db.init({ filePath: location.filePath });

  assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_versions').n, 29);
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM state_field_definitions WHERE book_id = ?', [location.bookId]).n,
    8
  );
  assert.equal(fs.readdirSync(path.join(location.dir, 'backups')).length, 1);

  const newBookId = db.run("INSERT INTO books (title) VALUES ('新书')").lastInsertRowid;
  db.transaction(() => migration.seedBook(db, newBookId));
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM state_field_definitions WHERE book_id = ?', [newBookId]).n,
    8
  );
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM projection_watermarks WHERE book_id = ?', [newBookId]).n,
    2
  );
});

// 迁移注册表不变量（G2 独立审查 P2-1）：index.js 末尾按位置把 MIGRATIONS[i] 与
// MIGRATION_FILES[i] 配对计算 contentChecksum，执行序一旦与文件列表不同序，每个迁移
// 记录的就是别人文件的哈希、A9「文件被应用后改动」漂移告警错乱。2a4eb2b 曾把
// agentRunsV1 放 MIGRATIONS[1]、文件却在末尾，实测 25/26 错位。此测试让错位不可再发生。
test('迁移注册表不变量：执行序与文件列表同序、checksum 配对自洽、依赖约束成立', () => {
  assert.equal(MIGRATIONS.length, MIGRATION_FILES.length, '两个数组长度必须一致');
  const versions = MIGRATIONS.map(m => m.version);
  const fileVersions = MIGRATION_FILES.map(
    f => require(path.join(__dirname, '..', 'server', 'migrations', f)).version
  );
  assert.deepEqual(versions, fileVersions, 'MIGRATIONS 顺序必须与 MIGRATION_FILES 按 version 字母序一致');
  // 文件列表自身按编号字母序（ORDER BY version 的库内断言见首个测试；此处防手滑调换）
  assert.deepEqual(MIGRATION_FILES, [...MIGRATION_FILES].sort(), '文件列表必须按文件编号序');

  for (let i = 0; i < MIGRATION_FILES.length; i++) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'migrations', MIGRATION_FILES[i]));
    const expected = 'sha256:' + crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(
      MIGRATIONS[i].contentChecksum, expected,
      `${MIGRATION_FILES[i]} 的 contentChecksum 与自身文件内容不符（索引错位）`
    );
  }

  // 依赖约束：027-action-recovery 重建 chat_actions，必须排在 016 后形态之后
  assert.ok(
    versions.indexOf('action_recovery_v1') > versions.indexOf('chat_actions_lifecycle_v1'),
    '027-action-recovery 必须在 016-chat-actions-lifecycle 之后执行'
  );
  // 026-agent-runs 只引用 books（001 建立），不得排在 001 之前
  assert.ok(
    versions.indexOf('agent_runs_v1') > versions.indexOf('character_hub_v1'),
    '026-agent-runs 依赖 001 建立的 books 表'
  );
  // 029-planning-handoffs 的 planning_notes/handoffs 引用 conversations（028 建立）
  assert.ok(
    versions.indexOf('planning_handoffs_v1') > versions.indexOf('conversations_v1'),
    '029-planning-handoffs 依赖 028 建立的 conversations 表'
  );
});

test('polish_history_fk_v1 重建表并清掉历史孤儿行（迁移 010）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  // 先造一个「迁移前」的旧库：polish_history 无外键（旧 schema 形态），含 2 行存活 + 1 行孤儿
  await db.init({ filePath: location.filePath, migrateVersions: false });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['旧书']).lastInsertRowid;
  const ch1 = db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, ?, '正文')", [bookId, '第一章']).lastInsertRowid;
  db.exec(`
    DROP TABLE polish_history;
    CREATE TABLE polish_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      scope TEXT DEFAULT 'chapter',
      original TEXT DEFAULT '',
      polished TEXT DEFAULT '',
      requirement TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  db.run('INSERT INTO polish_history (chapter_id, polished) VALUES (?, ?)', [ch1, '存活行一']);
  db.run('INSERT INTO polish_history (chapter_id, polished) VALUES (?, ?)', [ch1, '存活行二']);
  db.run('INSERT INTO polish_history (chapter_id, polished) VALUES (999999, ?)', '孤儿行');
  db.save();
  db.close();

  // 正常 init（带迁移）→ migration 010 重建：孤儿不拷贝，存活行保留，外键就位
  await db.init({ filePath: location.filePath });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM polish_history').n, 2, '孤儿行应被清掉，存活行保留');
  const fk = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='polish_history'");
  assert.ok(/REFERENCES chapters\(id\) ON DELETE CASCADE/.test(fk.sql), '重建后应带级联外键');
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'polish_history_fk_v1'").n, 1
  );
});

test('proposal_governance_v1 扩展提案治理列并新建留痕/抽取覆盖表', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const proposalCols = new Set(db.all('PRAGMA table_info(event_proposals)').map(c => c.name));
  for (const col of [
    'supersedes_event_id', 'created_by', 'created_via', 'created_session_id',
    'created_model', 'revision', 'content_hash', 'review_requested_by', 'reviewed_by',
  ]) {
    assert.equal(proposalCols.has(col), true, `event_proposals 缺列 ${col}`);
  }
  const auditCols = new Set(db.all('PRAGMA table_info(tool_audit_logs)').map(c => c.name));
  for (const col of ['requested_by', 'args_json', 'target_revision', 'result_entity_ids', 'error_details']) {
    assert.equal(auditCols.has(col), true, `tool_audit_logs 缺列 ${col}`);
  }
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  assert.equal(tables.has('proposal_revisions'), true);
  assert.equal(tables.has('chapter_extraction_runs'), true);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'proposal_governance_v1'").n, 1);
});

test('chat_actions_lifecycle_v1 重建表：旧行保留、新列与 superseded 状态就位（迁移 016）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  // 先造「迁移前」的旧库：chat_actions 旧 schema（无 expiry_notified/superseded_by，CHECK 无 superseded）
  await db.init({ filePath: location.filePath, migrateVersions: false });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['旧库书']).lastInsertRowid;
  db.exec(`
    DROP TABLE IF EXISTS chat_actions;
    CREATE TABLE chat_actions (
      id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      args_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL DEFAULT '',
      target_revision INTEGER,
      requested_by TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',
      impact_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      settled_at INTEGER,
      used_at INTEGER,
      resume_done INTEGER NOT NULL DEFAULT 0,
      resume_message_id INTEGER,
      CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired'))
    );
  `);
  db.run(
    `INSERT INTO chat_actions (id, book_id, name, args_json, args_hash, session_id, status, created_at, expires_at, settled_at)
     VALUES ('c_old_pending', ?, 'create_chapter', '{"title":"第6章"}', 'h1', ?, 'pending', 1, 2, NULL),
            ('c_old_approved', ?, 'append_chapter', '{"chapterId":1,"text":"x"}', 'h2', ?, 'approved', 1, 2, 3)`,
    [bookId, `book:${bookId}`, bookId, `book:${bookId}`]
  );
  db.save();
  db.close();

  // 正常 init（带迁移）→ 016 重建表：旧行原样保留，新列取默认值
  await db.init({ filePath: location.filePath });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chat_actions').n, 2, '重建表不得丢旧行');
  const cols = new Set(db.all('PRAGMA table_info(chat_actions)').map(c => c.name));
  assert.equal(cols.has('expiry_notified'), true);
  assert.equal(cols.has('superseded_by'), true);
  const pending = db.get("SELECT * FROM chat_actions WHERE id = 'c_old_pending'");
  assert.equal(pending.status, 'pending');
  assert.equal(pending.expiry_notified, 0, '新列取默认值');
  assert.equal(pending.superseded_by, null);
  assert.equal(pending.args_json, '{"title":"第6章"}', '参数原样保留');
  assert.equal(db.get("SELECT status FROM chat_actions WHERE id = 'c_old_approved'").status, 'approved');
  // 新 CHECK 接受 superseded（旧表会拒绝）
  db.run("UPDATE chat_actions SET status = 'superseded', superseded_by = 'c_new' WHERE id = 'c_old_pending'");
  assert.equal(db.get("SELECT superseded_by FROM chat_actions WHERE id = 'c_old_pending'").superseded_by, 'c_new');
  // 索引重建
  assert.equal(
    db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_actions_book'").name,
    'idx_chat_actions_book'
  );
  // 幂等：再次 init（记录已存在）不重复重建、行数不变
  db.close();
  await db.init({ filePath: location.filePath });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chat_actions').n, 2);
});

test('message_source_v1：messages 新增 source 列，历史行默认空串（迁移 017）', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const cols = new Set(db.all('PRAGMA table_info(messages)').map(c => c.name));
  assert.equal(cols.has('source'), true, 'messages 应有 source 列');
  const info = db.all('PRAGMA table_info(messages)').find(c => c.name === 'source');
  assert.equal(info.notnull, 1, 'source NOT NULL');
  assert.equal(String(info.dflt_value).includes("''"), true, "source 默认空串");
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'message_source_v1'").n, 1);
});

test('ai_style_samples_v1：错题库表就位，四态复核约束与去重索引生效（迁移 018）', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const cols = new Set(db.all('PRAGMA table_info(ai_style_samples)').map(c => c.name));
  for (const col of [
    'text', 'text_hash', 'verdict', 'detector', 'detector_conf', 'labels_ratio',
    'chapter_id', 'chapter_title_snapshot', 'chapter_revision', 'review_note', 'tags', 'seen_count',
  ]) {
    assert.equal(cols.has(col), true, `错题库缺列 ${col}`);
  }

  // 去重索引：同 hash 第二次插入必须失败（去重靠索引，不靠调用方自觉）
  const ins = (hash) => db.run(
    "INSERT INTO ai_style_samples (text, text_hash, verdict) VALUES ('句子', ?, 'pending')",
    [hash]
  );
  ins('hash-a');
  assert.throws(() => ins('hash-a'), /UNIQUE|constraint/i, '同 hash 必须被唯一索引挡住');

  // 四态约束：非法状态被 CHECK 拒绝
  assert.throws(
    () => db.run("UPDATE ai_style_samples SET verdict = 'maybe' WHERE text_hash = 'hash-a'"),
    /CHECK|constraint/i
  );
  db.run("UPDATE ai_style_samples SET verdict = 'human' WHERE text_hash = 'hash-a'");
  assert.equal(db.get("SELECT verdict FROM ai_style_samples WHERE text_hash = 'hash-a'").verdict, 'human');
});

test('style_packs_v1：风格包/规则表 + books.style_pack_id 就位，内置基础包已播种（迁移 019）', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const bookCols = new Set(db.all('PRAGMA table_info(books)').map(c => c.name));
  assert.equal(bookCols.has('style_pack_id'), true, 'books 应有 style_pack_id（本机制唯一耦合点）');

  const packCols = new Set(db.all('PRAGMA table_info(style_packs)').map(c => c.name));
  for (const col of ['name', 'kind', 'book_id', 'profile_json', 'source_refs', 'builtin', 'enabled']) {
    assert.equal(packCols.has(col), true, `style_packs 缺列 ${col}`);
  }
  const ruleCols = new Set(db.all('PRAGMA table_info(style_rules)').map(c => c.name));
  for (const col of ['pack_id', 'category', 'title', 'trigger', 'rule', 'good', 'bad', 'severity', 'source']) {
    assert.equal(ruleCols.has(col), true, `style_rules 缺列 ${col}`);
  }

  const basic = db.get("SELECT * FROM style_packs WHERE builtin = 1 AND kind = 'basic'");
  assert.ok(basic, '应播种内置基础包');
  assert.equal(basic.book_id, null, '基础包是全局包，book_id 为空');
  assert.ok(basic.profile_json.includes('stance'), '基础包应有文风指纹');
  assert.ok(
    db.get('SELECT COUNT(*) AS n FROM style_rules WHERE pack_id = ?', [basic.id]).n >= 10,
    '基础包应有足量规则条目'
  );
  // 每条规则都要有出处，规则条目拆分是数据工程，来源必须可追溯
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM style_rules WHERE source = ''").n, 0,
    '规则条目必须标注来源'
  );

  // 级联：删包即删规则（不留孤儿）
  db.run('DELETE FROM style_packs WHERE id = ?', [basic.id]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM style_rules WHERE pack_id = ?', [basic.id]).n, 0);

  // 幂等：重复 init 不重复播种
  db.close();
  await db.init({ filePath: location.filePath });
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM style_packs WHERE builtin = 1 AND kind = 'basic'").n, 0,
    '包已被删除时不应被重新播种（迁移只跑一次，符合迁移语义）'
  );
});

test('corpus_tables_v1：corpus 三表就位，外键级联与 CHECK 约束生效（迁移 023）', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  for (const name of ['corpus_sources', 'corpus_docs', 'distill_jobs']) {
    assert.equal(tables.has(name), true, `缺表 ${name}`);
  }
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'corpus_tables_v1'").n, 1);

  // 级联：删源集即删其下文件登记（不留孤儿；向量/正文在侧文件，主库只登记路径）
  const sid = db.run("INSERT INTO corpus_sources (author) VALUES ('测试作家')").lastInsertRowid;
  db.run(
    'INSERT INTO corpus_docs (source_id, work, path) VALUES (?, ?, ?)',
    [sid, '测试书', 'data/corpus/src-1/test.txt']
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM corpus_docs WHERE source_id = ?', [sid]).n, 1);
  db.run('DELETE FROM corpus_sources WHERE id = ?', [sid]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM corpus_docs').n, 0, '删源集应级联删掉文件登记');

  // CHECK：非法 stage / status 必须被拒（distill_jobs 的阶段与状态是受限枚举）
  assert.throws(
    () => db.run("INSERT INTO distill_jobs (stage) VALUES ('bogus')"),
    /CHECK|constraint/i,
    '非法 stage 必须被 CHECK 挡住'
  );
  assert.throws(
    () => db.run("INSERT INTO distill_jobs (stage, status) VALUES ('mask', 'paused')"),
    /CHECK|constraint/i,
    '非法 status 必须被 CHECK 挡住'
  );
  // 合法值可插入（source_id 允许 NULL——全局任务不挂具体源集）
  const jobId = db.run("INSERT INTO distill_jobs (stage) VALUES ('fingerprint')").lastInsertRowid;
  assert.ok(jobId > 0);
  assert.equal(db.get('SELECT status FROM distill_jobs WHERE id = ?', [jobId]).status, 'pending');
});

test('planning_handoffs_v1：笔记/交接两表就位，草稿状态与级联在库层生效（迁移 029）', async t => {
  const location = await createLegacySeed();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });

  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  assert.equal(tables.has('planning_notes'), true, '缺表 planning_notes');
  assert.equal(tables.has('handoffs'), true, '缺表 handoffs');
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'planning_handoffs_v1'").n, 1);

  // 笔记：book_id 允许 NULL（global 会话），但状态只能是 draft
  const bookId = db.run("INSERT INTO books (title) VALUES ('迁移 029 书')").lastInsertRowid;
  const convId = 'notes-conv-1';
  db.run(
    `INSERT INTO conversations (id, kind, scope, book_id, title) VALUES (?, 'agent', 'book', ?, '讨论')`,
    [convId, bookId]
  );
  db.run(
    `INSERT INTO planning_notes (id, conversation_id, book_id, title, text)
     VALUES ('note-1', ?, ?, '标题', '正文'), ('note-2', ?, NULL, '全局笔记', '正文')`,
    [convId, bookId, convId]
  );
  assert.equal(db.get('SELECT revision, status FROM planning_notes WHERE id = ?', ['note-1']).revision, 1);
  assert.equal(db.get('SELECT status FROM planning_notes WHERE id = ?', ['note-2']).status, 'draft');
  assert.throws(
    () => db.run("UPDATE planning_notes SET status = 'accepted' WHERE id = 'note-1'"),
    /CHECK|constraint/i,
    '规划笔记没有正典效力：库层不接受 draft 以外的状态'
  );

  // 交接：status 受限枚举 + 删书级联（目标会话与书都清了，交接单不许留孤儿）
  const targetId = 'writing-conv-1';
  db.run(
    `INSERT INTO conversations (id, kind, scope, book_id, title) VALUES (?, 'writing', 'book', ?, '写作')`,
    [targetId, bookId]
  );
  db.run(
    `INSERT INTO handoffs (id, book_id, origin_conversation_id, target_conversation_id, text)
     VALUES ('h-1', ?, ?, ?, '草案')`,
    [bookId, convId, targetId]
  );
  assert.throws(
    () => db.run("UPDATE handoffs SET status = 'adopted' WHERE id = 'h-1'"),
    /CHECK|constraint/i,
    'handoffs.status 只接受 draft/accepted/cancelled'
  );
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs').n, 0, '删书必须级联删交接单');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM planning_notes').n, 0, '删书必须级联删书内笔记');

  // 幂等：再次 init 不重复建表、不报错
  db.close();
  await db.init({ filePath: location.filePath });
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'planning_handoffs_v1'").n, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM handoffs').n, 0);
});
