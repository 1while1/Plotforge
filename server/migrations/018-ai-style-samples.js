const version = 'ai_style_samples_v1';
const checksum = 'sha256:ai-style-samples-20260911-01';

// AI 味错题库（作家仓库第一步）：把朱雀检测判为 AI 的语句留下来当语料，
// 积累多了就能从里面提取「AI 检测特征」，反哺风格规则库。
//
// 几个必须的列，各有理由：
//  - text_hash 唯一索引：同一句被反复检出不该堆成重复行，去重键；
//  - verdict 四态（pending/ai/human/rejected）：检测器会误判，必须记录**人工复核结论**——
//    human 态（朱雀判 AI、人确认为人写）是检测器的盲区，是规则的雷区清单，与 ai 态同样值钱。
//    不记复核，积累起来就是混着人类正常句子的脏语料，蒸馏出的特征直接是错的（防 Goodhart 第一道闸门）；
//  - chapter_revision / chapter_title_snapshot：章节是活的，作者随时会改、会改名（M10 刚上线改名）。
//    不存快照，半年后回看一条标本无法知道「当时检测的是哪一版正文」，也就无法复现；
//  - seen_count：同一句被反复判为 AI 的次数，本身就是最强的特征证据，用最低成本记下来。
//
// 检测器细节与本表设计依据见 docs/report/20260911_作家仓库/04-设计草案/02-错题库与特征提取设计.md
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_style_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      verdict TEXT NOT NULL DEFAULT 'pending',
      detector TEXT NOT NULL DEFAULT 'zhuque',
      detector_conf REAL,
      detector_label INTEGER,
      labels_ratio TEXT NOT NULL DEFAULT '[]',
      segment_index INTEGER,
      segment_position TEXT NOT NULL DEFAULT '',
      detection_id TEXT NOT NULL DEFAULT '',
      book_id INTEGER,
      chapter_id INTEGER,
      chapter_title_snapshot TEXT NOT NULL DEFAULT '',
      chapter_revision TEXT,
      source TEXT NOT NULL DEFAULT 'chapter',
      review_note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      reviewed_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      CHECK (verdict IN ('pending', 'ai', 'human', 'rejected')),
      CHECK (source IN ('chapter', 'paste', 'manual')),
      CHECK (detector IN ('zhuque', 'manual'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_samples_hash ON ai_style_samples(text_hash);
    CREATE INDEX IF NOT EXISTS idx_ai_samples_book ON ai_style_samples(book_id, verdict);
    CREATE INDEX IF NOT EXISTS idx_ai_samples_verdict ON ai_style_samples(verdict, detector_conf);
  `);
}

module.exports = { version, checksum, up };
