const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const characterHubV1 = require('./001-character-hub');
const relockPendingV1 = require('./002-relock-pending');
const proposalGovernanceV1 = require('./003-proposal-governance');
const ledgerRepairV1 = require('./004-ledger-repair');
const llmObservabilityV1 = require('./005-llm-observability');
const llmCallPartsV1 = require('./006-llm-call-parts');
const llmCallSchemaV1 = require('./007-llm-call-schema');
const messagesBookIndexV1 = require('./008-messages-book-index');
const chapterVersionsFkV1 = require('./009-chapter-versions-fk');
const polishHistoryFkV1 = require('./010-polish-history-fk');
const chatActionsPersistenceV1 = require('./011-chat-actions-persistence');
const volumeSummaryPropagationV1 = require('./012-volume-summary-propagation');
const backfillJobsPersistenceV1 = require('./013-backfill-jobs-persistence');
const bookSummaryPropagationV1 = require('./014-book-summary-propagation');
const messageToolsPersistenceV1 = require('./015-message-tools-persistence');
const chatActionsLifecycleV1 = require('./016-chat-actions-lifecycle');
const messageSourceV1 = require('./017-message-source');
const aiStyleSamplesV1 = require('./018-ai-style-samples');
const stylePacksV1 = require('./019-style-packs');
const styleRulesGeneralV1 = require('./020-style-rules-general');
const writerCardsV1 = require('./021-writer-cards');
const corpusTablesV1 = require('./023-corpus-tables');
const chapterRevisionV1 = require('./024-chapter-revision');
const chapterRecycleV1 = require('./025-chapter-recycle');
const agentRunsV1 = require('./026-agent-runs');
const actionRecoveryV1 = require('./027-action-recovery');
const conversationsV1 = require('./028-conversations');
const planningHandoffsV1 = require('./029-planning-handoffs');
const proposalDiscardLedgerV1 = require('./030-proposal-discard-ledger');
const llmCallConversationsV1 = require('./031-llm-call-conversations');
const readEvidenceV1 = require('./032-read-evidence');

const MIGRATION_FILES = [
  './001-character-hub.js',
  './002-relock-pending.js',
  './003-proposal-governance.js',
  './004-ledger-repair.js',
  './005-llm-observability.js',
  './006-llm-call-parts.js',
  './007-llm-call-schema.js',
  './008-messages-book-index.js',
  './009-chapter-versions-fk.js',
  './010-polish-history-fk.js',
  './011-chat-actions-persistence.js',
  './012-volume-summary-propagation.js',
  './013-backfill-jobs-persistence.js',
  './014-book-summary-propagation.js',
  './015-message-tools-persistence.js',
  './016-chat-actions-lifecycle.js',
  './017-message-source.js',
  './018-ai-style-samples.js',
  './019-style-packs.js',
  './020-style-rules-general.js',
  './021-writer-cards.js',
  './023-corpus-tables.js',
  './024-chapter-revision.js',
  './025-chapter-recycle.js',
  './026-agent-runs.js',
  './027-action-recovery.js',
  './028-conversations.js',
  './029-planning-handoffs.js',
  './030-proposal-discard-ledger.js',
  './031-llm-call-conversations.js',
  './032-read-evidence.js',
];
// 执行序（applyPending 按本数组顺序跑，已应用的跳过）。数组顺序必须与 MIGRATION_FILES
// 按 version 字母序严格一致：本文件末尾按位置给 MIGRATIONS[i] 配 MIGRATION_FILES[i]
// 计算 contentChecksum，错位＝每个迁移记录别人文件的哈希、A9 漂移告警错乱（G2 审查
// P2-1 实测 25/26 错位；不变量测试在 test/db-migrations.test.js 兜底）。
// 顺序约束核对：027-action-recovery 重建 chat_actions 依赖 016 后形态（字母序天然
// 满足，不得前移）；026-agent-runs 只依赖 001 建立的 books，位置无约束；029-planning-
// handoffs 的 planning_notes/handoffs 引用 028 建立的 conversations，必须在 028 之后；
// 030-proposal-discard-ledger 是全局台账（有意不挂任何外键），只依赖库已建，位置无约束。
const MIGRATIONS = [characterHubV1, relockPendingV1, proposalGovernanceV1, ledgerRepairV1, llmObservabilityV1, llmCallPartsV1, llmCallSchemaV1, messagesBookIndexV1, chapterVersionsFkV1, polishHistoryFkV1, chatActionsPersistenceV1, volumeSummaryPropagationV1, backfillJobsPersistenceV1, bookSummaryPropagationV1, messageToolsPersistenceV1, chatActionsLifecycleV1, messageSourceV1, aiStyleSamplesV1, stylePacksV1, styleRulesGeneralV1, writerCardsV1, corpusTablesV1, chapterRevisionV1, chapterRecycleV1, agentRunsV1, actionRecoveryV1, conversationsV1, planningHandoffsV1, proposalDiscardLedgerV1, llmCallConversationsV1, readEvidenceV1];

// A9（第二轮重审查）：checksum 改为迁移源码文件内容哈希。
// 此前是手写版本串（与文件内容无关），一旦手串变更 → 存量库 init 直接抛“校验和不一致”
// → process.exit(1)，升级迁移文件即炸掉所有存量库（E4 实测）。
// 现行为：内容哈希不一致 → console.warn 告警并自愈记录，绝不拒绝启动。
function computeContentChecksum(relativeFile) {
  const source = fs.readFileSync(path.join(__dirname, relativeFile));
  return 'sha256:' + crypto.createHash('sha256').update(source).digest('hex');
}
for (let i = 0; i < MIGRATIONS.length; i++) {
  MIGRATIONS[i].contentChecksum = computeContentChecksum(MIGRATION_FILES[i]);
  MIGRATIONS[i].legacyChecksum = MIGRATIONS[i].checksum; // 兼容历史手写版本串记录
}

// 启动索引自愈（A9 实测场景：版本已记录 + 索引被手动删 → 此前永不重建，查询静默全表扫描）。
// 仅补建缺失项（存在性检查先行），避免每次启动都置脏导致全量重写库文件。
const CRITICAL_INDEXES = [
  ['idx_messages_book', 'CREATE INDEX IF NOT EXISTS idx_messages_book ON messages(book_id, id)'],
  ['idx_embeddings_chapter', 'CREATE INDEX IF NOT EXISTS idx_embeddings_chapter ON embeddings(chapter_id)'],
  ['idx_embeddings_book', 'CREATE INDEX IF NOT EXISTS idx_embeddings_book ON embeddings(book_id)'],
  ['idx_chapter_versions', 'CREATE INDEX IF NOT EXISTS idx_chapter_versions ON chapter_versions(chapter_id)'],
  ['idx_polish_history', 'CREATE INDEX IF NOT EXISTS idx_polish_history ON polish_history(chapter_id)'],
  ['idx_story_events_timeline', 'CREATE INDEX IF NOT EXISTS idx_story_events_timeline ON story_events(book_id, chapter_id, narrative_sequence)'],
  ['idx_llm_calls_book', 'CREATE INDEX IF NOT EXISTS idx_llm_calls_book ON llm_calls(book_id, id)'],
];

function ensureCriticalIndexes(db) {
  const healed = [];
  for (const [name, ddl] of CRITICAL_INDEXES) {
    const exists = db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [name]);
    if (!exists) {
      db.exec(ddl);
      healed.push(name);
    }
  }
  if (healed.length) {
    console.warn(`[migrations] 检测到关键索引缺失并已补建: ${healed.join(', ')}`);
  }
  return healed;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createBackup(filePath) {
  const backupDir = path.join(path.dirname(filePath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `novel-before-character-hub-v1-${timestamp()}.db`);
  fs.copyFileSync(filePath, target);
  return target;
}

function applyPending(db, context) {
  const hasVersionTable = Boolean(db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'"
  ));
  let backupPath = null;
  for (const migration of MIGRATIONS) {
    const applied = hasVersionTable
      ? db.get('SELECT version, checksum FROM schema_versions WHERE version = ?', [migration.version])
      : null;
    if (applied) {
      // A9：历史记录兼容手写版本串；内容哈希不一致 = 迁移文件在应用后被改动过。
      // 告警（不再 exit(1) 炸启动）并自愈记录为当前内容哈希——同一文件内容不会反复告警。
      if (applied.checksum !== migration.contentChecksum && applied.checksum !== migration.legacyChecksum) {
        console.warn(
          `[migrations] 迁移 ${migration.version} 的文件内容与已应用记录不一致` +
          `（记录=${applied.checksum.slice(0, 24)}…，当前内容=${migration.contentChecksum.slice(0, 24)}…）。` +
          '已更新记录以匹配当前内容；若这是非预期改动，请用 data/backups 下的迁移前备份核对。'
        );
        db.run('UPDATE schema_versions SET checksum = ? WHERE version = ?', [migration.contentChecksum, migration.version]);
      } else if (applied.checksum === migration.legacyChecksum && applied.checksum !== migration.contentChecksum) {
        // 旧手写串 → 一次性升级为内容哈希记录（静默，属记录格式迁移而非内容告警）
        db.run('UPDATE schema_versions SET checksum = ? WHERE version = ?', [migration.contentChecksum, migration.version]);
      }
      continue;
    }

    if (context.fileExisted && !backupPath) backupPath = createBackup(context.filePath);
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL,
          checksum TEXT NOT NULL
        )
      `);
      migration.up(db);
      db.run(
        'INSERT INTO schema_versions (version, applied_at, checksum) VALUES (?, ?, ?)',
        [migration.version, new Date().toISOString(), migration.contentChecksum]
      );
    });
  }
  const healedIndexes = ensureCriticalIndexes(db);
  return { backupPath, healedIndexes };
}

module.exports = { applyPending, MIGRATIONS, MIGRATION_FILES, ensureCriticalIndexes, CRITICAL_INDEXES };
