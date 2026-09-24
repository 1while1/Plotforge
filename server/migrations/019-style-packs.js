const version = 'style_packs_v1';
const checksum = 'sha256:style-packs-20260911-01';

// 风格包机制（作家仓库第二步）：把「文风该怎么写」从代码里搬出来变成数据。
// 委托方硬要求「不能十分耦合」——因此本层只提供机制，规则全部是数据：
//   新增一个风格包 = 插数据，不改代码；解绑 books.style_pack_id = 回到无风格层的原始行为。
//
// style_packs.book_id 可空：NULL = 全局包（内置起步包与手工编写的预设包都挂这里），
// 非空 = 某本书专属（作者印记蒸馏产物走这条）。避免每本书都要播种一份。
// kind 区分来源：'basic' 内置去 AI 味起步包 / 'preset' 手工预设（如知乎盐选）/ 'imprint' 作者印记。
// source_refs 记录作者印记的样本来源（书 id / 章节 id），供复现蒸馏过程——接口先留，蒸馏算法待委托方提供样本后再定。
//
// style_rules 是「可检索的最小单元」：title 常驻注入（一行一条的规则目录），
// rule/good/bad 只在命中 trigger 或 severity='must' 时才展开——绝不全家注入，
// 因为手册自身警告「消除 AI 味的技巧无节制运用本身会变成新的 AI 味」（过度优化之魔）。
// source 存出处（如「焚决·速查手册 §6.3」），规则条目拆分是独立的数据工程，本迁移只播种起步包。
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS style_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'preset',
      book_id INTEGER,
      profile_json TEXT NOT NULL DEFAULT '{}',
      source_refs TEXT NOT NULL DEFAULT '[]',
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      CHECK (kind IN ('basic', 'preset', 'imprint'))
    );
    CREATE TABLE IF NOT EXISTS style_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL REFERENCES style_packs(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT '',
      rule TEXT NOT NULL DEFAULT '',
      good TEXT NOT NULL DEFAULT '',
      bad TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      CHECK (severity IN ('must', 'normal', 'hint'))
    );
    CREATE INDEX IF NOT EXISTS idx_style_rules_pack ON style_rules(pack_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_style_packs_book ON style_packs(book_id, enabled);
  `);

  // books.style_pack_id：本机制与业务表的**唯一**耦合点（一个可空外键）。
  // 先 PRAGMA 检查列是否存在（照 015/017 的幂等写法），重复执行不报错。
  const cols = db.all('PRAGMA table_info(books)').map(row => row.name);
  if (!cols.includes('style_pack_id')) {
    db.exec('ALTER TABLE books ADD COLUMN style_pack_id INTEGER');
  }

  // 内置起步包：只播种「去 AI 味」的通用规则（任何文风都该避开的 AI 腔），
  // 属性级文风规则（盐选快爽 / 某作者印记）一律留给后续的 preset / imprint 包。
  // 条目来自委托方提供的《知乎盐选 AI 创作风格速查手册》与《AI 内功心法》，
  // 取其无歧义的核心项；手册里互相打架的细则（爽 vs 克制等）属数据工程范围，需委托方在场逐条定夺，不在此播种。
  const exists = db.get("SELECT id FROM style_packs WHERE builtin = 1 AND name = '去 AI 味·基础包'");
  if (exists) return;
  const packId = db.run(
    "INSERT INTO style_packs (name, kind, book_id, profile_json, builtin, note) VALUES (?, 'basic', NULL, ?, 1, ?)",
    [
      '去 AI 味·基础包',
      JSON.stringify({
        stance: '宁可少写一句，不要多写一句。真正的艺术在于舍弃。',
        sentence: '以短句和中短句为叙事常态，长短交错营造呼吸感；避免连续长句与四字成语堆砌。',
        diction: '动词为王，少用形容词和副词；比喻默认不用。',
        psychology: '内化生理反应优先（手心出汗、喉咙发干），少做心理总结与概括。',
        dialogue: '口语化，允许犹豫、结巴、重复——真人的对话本就带毛边。',
        warning: '消除 AI 味的技巧若无节制地使用，本身会成为新的、更隐蔽的 AI 味（用力过猛）。',
      }),
      '内置起步包，随代码演进；属性级文风（平台/作者）请另建 preset 或 imprint 包。',
    ]
  ).lastInsertRowid;

  const rules = [
    ['总纲', '克制高于一切', '形容词|副词|比喻|描写|修饰', '永远先问：这句话能删掉吗？这个形容词是必需的吗？这段描写服务于情节，还是自我炫技？把「解释的冲动」转化为「暗示的技巧」。', '他把手里的硬币抛起来，又接住，反复了十几次，最终还是揣回了兜里。', '他内心充满了难以言喻的纠结与挣扎。', 'must', '焚决·内功心法·四条天律'],
    ['总纲', '无声胜有声', '结尾|留白|解释|点题|升华', '最深刻的情感和最关键的信息，往往不靠语言直白说出。情节或对话结束后不要画蛇添足地解释含义，把回味空间留给读者。', '', '（对话结束后）这句话的意思是，他其实早就知道了真相。', 'must', '焚决·内功心法·四条天律'],
    ['总纲', '防过度优化', '细节|描写|精雕|丰富|补足', '不是所有地方都值得精雕细琢。把每个场景都做最大化精细描写是一种新的、更隐蔽的 AI 味——用力过猛，会破坏节奏让读者疲劳。详略得当，大部分时候简洁有力才是王道。', '', '', 'must', '焚决·补充卷·过度优化之魔'],
    ['行文', '动词为王', '愤怒|悲伤|高兴|害怕|情绪', '用动词承担情绪，不用形容词+副词直陈。不说「他非常愤怒地走了」，要说「他摔门而出」。', '他摔门而出。', '他非常愤怒地转身离开了房间。', 'normal', '焚决·心法·第二卷第一式'],
    ['行文', '短句为主', '长句|节奏|句子', '以短句和中短句作为叙事常态。长句只在极少量必要说明或营造舒缓氛围时使用，且必须结构清晰。', '', '', 'normal', '焚决·心法·第二卷第一式'],
    ['行文', '修辞审慎', '比喻|仿佛|如同|就像|宛如', '默认不使用比喻。只有当比喻能让极其抽象或陌生的概念秒懂、或带来无与伦比的冲击力时才可用，且必须新颖贴切。避免「心像刀割一样」这类陈词滥调。', '', '他的心像刀割一样疼，仿佛整个世界都崩塌了。', 'normal', '焚决·心法·第二卷第一式'],
    ['去AI化', '放弃总结癖', '感到|觉得|意识到|明白了|总结', '不要对角色的内心活动做概括性总结。不写「他感到很纠结」，而用行为替角色说话。', '', '他感到很纠结，不知道该怎么办才好。', 'must', '焚决·心法·第三式'],
    ['去AI化', '放弃场景扫描', '环境|描写|房间|风景|四周', '描写场景时绝不逐件罗列（这里有一张桌子、两把椅子、一个窗户），而要通过主角的视角与心境去聚焦。焦虑就只写那只走得震天响的钟。', '', '房间里有张桌子、两把椅子、一个窗户，墙上挂着一幅画。', 'must', '焚决·心法·第二重'],
    ['去AI化', '内化生理反应', '恐惧|紧张|激动|愤怒|情绪', '极端情绪下首先写生理反应（手心出汗、喉咙发干、心脏狂跳、胃部抽搐），而不是长篇分析内心的矛盾情感。', '他的手指在袖口里攥出了汗。', '他此刻内心充满了恐惧与愤怒交织的矛盾情感。', 'normal', '焚决·心法·第二重'],
    ['去AI化', '拥抱毛边感', '对话|说|回答|台词', '真人的对话充满犹豫、结巴、重复甚至语法错误。情绪激动时让角色说「你……你你……」，远好过「我内心充满了难以言喻的愤怒」。', '', '', 'normal', '焚决·心法·第二重'],
    ['去AI化', '戒关联词套话', '不仅|而且|然而|因此|总之|综上所述', '避免「不仅…而且…」「之所以…是因为…」这类书面关联词织成的顺滑逻辑链，真人叙述是跳跃的。', '', '这不仅改变了他的命运，而且深刻地影响了整个故事的走向。', 'normal', '焚决·速查手册·去AI化清单'],
    ['去AI化', '允许不确定性', '巧合|合理|逻辑|解释', '真人的世界充满意外。允许「意料之外、情理之中」的巧合，允许角色做出非理性的、纯出于情感的决定，不必解释每个细节的前因后果。', '', '', 'hint', '焚决·补充卷·逻辑洁癖之魔'],
  ];
  let order = 0;
  for (const [category, title, trigger, rule, good, bad, severity, source] of rules) {
    db.run(
      `INSERT INTO style_rules (pack_id, category, title, trigger, rule, good, bad, severity, source, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [packId, category, title, trigger, rule, good, bad, severity, source, order++]
    );
  }
}

module.exports = { version, checksum, up };
