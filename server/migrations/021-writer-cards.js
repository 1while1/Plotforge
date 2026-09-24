const version = 'writer_cards_v1';
const checksum = 'sha256:writer-cards-20260912-01';

// 作家卡机制（作家仓库第四步）：把「风格包」升级成可热插拔的**卡**。
// 委托方 2026-09-12 拍板：「人设文本 + 规则 + 范文都要有」「必须可热插拔」
// 「一本书用主卡 + 辅卡」「保留向量数据库接口」。
//
// 一张卡 = 人设（persona，散文式自述）+ 指纹（profile_json，结构化短句）
//        + 规则（style_rules）+ 范文（style_samples，本迁移新建）。
//
// 【为什么卡片要独立于书】卡是全局资产，书通过 book_style_packs 引用卡——
// 一本书换卡不改卡本身，一张卡可被多本书共用；删卡自动解绑（外键级联），
// 不留悬空引用（旧的 books.style_pack_id 单外键做不到这两点，故新增绑定表）。
//
// 【主卡 / 辅卡】主卡 = 这本书的风格本体（如「古龙」）；辅卡 = 叠加的修正层
// （如「去 AI 味·通用」任何主卡都可以带上）。允许多张辅卡，按 sort_order 叠加。
//
// 【向量接口预留】style_samples.vector / vector_model / indexed_at 三列本迁移只建不写：
// 将来要把知名作家的整部作品灌进卡里做「按当前章节检索相似段落」，写入路径是
// server/vector/embed.js（本地 bge-small-zh，512 维，Float32Array 原始字节，与 embeddings 表同格式），
// 检索路径收在 server/style/retrieve.js 一个函数里，调用方签名不变。现在不实现是为了
// 不让「没语料」的空转机制先长进代码里——接口留好，等语料到了再接线。
function up(db) {
  // ---- ① style_packs 增补人设列（幂等：PRAGMA 检查列是否存在，照 015/017/019 的写法）----
  const packCols = db.all('PRAGMA table_info(style_packs)').map(row => row.name);
  if (!packCols.includes('persona')) {
    db.exec("ALTER TABLE style_packs ADD COLUMN persona TEXT NOT NULL DEFAULT ''");
  }

  // ---- ② 范文表（含向量列）----
  db.exec(`
    CREATE TABLE IF NOT EXISTS style_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL REFERENCES style_packs(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      char_count INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL DEFAULT '',
      vector BLOB,
      vector_model TEXT NOT NULL DEFAULT '',
      indexed_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_style_samples_pack ON style_samples(pack_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_style_samples_hash ON style_samples(pack_id, content_hash);

    CREATE TABLE IF NOT EXISTS book_style_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      pack_id INTEGER NOT NULL REFERENCES style_packs(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'aux',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      CHECK (role IN ('main', 'aux')),
      UNIQUE (book_id, pack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_book_style_packs_book ON book_style_packs(book_id, role, sort_order);
  `);

  // ---- ③ 回填：books.style_pack_id 里的历史绑定搬进绑定表，避免存量绑定静默失效 ----
  // books.style_pack_id 从此降级为「主卡镜像列」（写绑定时同步刷新，只为兼容旧读法），
  // 读取路径一律走 book_style_packs。
  db.run(`
    INSERT OR IGNORE INTO book_style_packs (book_id, pack_id, role, sort_order)
    SELECT id, style_pack_id, 'main', 0 FROM books WHERE style_pack_id IS NOT NULL
  `);

  // ---- ④ 内置卡补人设：019 只播了指纹与规则，人设是卡片的第一人称自述 ----
  // 只在卡名仍是播种原值时才改（用户改过名就是我行我素，不覆盖）。
  db.run(
    `UPDATE style_packs SET persona = ?, updated_at = datetime('now','localtime')
      WHERE builtin = 1 AND kind = 'basic' AND name = '去 AI 味·基础包'`,
    ['你是一位把「克制」刻进骨子里的中文小说作者。你的信条：宁可少写一句，不要多写一句；'
      + '能用一个动作说清的，绝不解释一句；能让读者自己咂摸出来的，绝不点破。'
      + '你不怕句子短、不怕场面冷、不怕留白——你怕的是用力过猛，怕读者一眼看出你在「写」。'
      + '你的目标是让文字看上去出自一个具体的人之手，而不是一台被要求「写得丰富一点」的机器。']
  );
  db.run(
    `UPDATE style_packs SET name = ? WHERE builtin = 1 AND kind = 'basic' AND name = '去 AI 味·基础包'`,
    ['去 AI 味·通用']
  );
}

module.exports = { version, checksum, up };
