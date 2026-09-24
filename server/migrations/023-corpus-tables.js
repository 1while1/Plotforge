const version = 'corpus_tables_v1';
const checksum = 'sha256:corpus-tables-20260912-01';

// 作家印记蒸馏（任务书 P8）第 1 步：corpus 三表（源集 / 文件登记 / 任务进度）。
//
// 【编号说明】022 预留给任务书 P0（盐选快爽卡，另一轮派发）；
// 本任务按方案 docs/report/20260911_作家仓库/20-作家印记蒸馏/01-成熟方法调研与方案设计.md
// §4「新增迁移（编号取执行时实际最大号 + 1）」的规则，当前最大号 021 + 指定预留 → 用 023。
//
// 【铁律：只存元数据与路径，向量与正文绝不入主库】
// 方案 §1.1 实测：向 25,700 个向量块灌进主库会让库膨胀到 101 MB、
// save() 阻塞 99–105 ms（server/db.js 的 save() 是 db.export() 全量覆盖式同步存盘，
// 每次聊天/存章都触发）；而元数据表实测「20 源集 + 200 文档」只增 56 KB、save() 仍 1 ms。
// 向量与掩码后正文一律放侧文件 data/corpus/src-<sourceId>/
// （vectors.bin / text.bin / index.json / meta.json，方案 §3.4.1 / §4.1）。
//
// 【表间关系】corpus_sources：一作家一源集（一作家一卡的粒度定案，方案 §3.4.1），
// 可被多张作家卡经 style_packs.source_refs（迁移 019 既有列）引用；
// corpus_docs：源集下的语料文件登记（掩码词典版本不一致时拒绝检索，靠 sha256 复核）；
// distill_jobs：L1~L5 各阶段（fingerprint/mask/map/reduce/select/card）的断点续跑进度。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL UNIQUE,
      works_json TEXT NOT NULL DEFAULT '[]',
      han_count INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      fingerprint_json TEXT NOT NULL DEFAULT '{}',
      mask_dict_version TEXT NOT NULL DEFAULT '',
      dir_path TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS corpus_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES corpus_sources(id) ON DELETE CASCADE,
      work TEXT NOT NULL,
      path TEXT NOT NULL,
      han_count INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_corpus_docs_source ON corpus_docs(source_id);

    CREATE TABLE IF NOT EXISTS distill_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES corpus_sources(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('fingerprint','mask','map','reduce','select','card')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      progress_json TEXT NOT NULL DEFAULT '{}',
      concurrency INTEGER NOT NULL DEFAULT 5,
      stats_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_source ON distill_jobs(source_id, stage, status);
  `);
}

module.exports = { version, checksum, up };
