// 风格包机制 + 风格层 provider 契约（作家仓库第二步）：
// 包解析优先级 / 三层编译（指纹常驻 + 硬线全文 + 其余只出目录）/ 全局开关 / 无规则时空串。
// 核心不变量：**绝不全家注入**——手册自身警告「消除 AI 味的技巧无节制运用会变成新的 AI 味」，
// 任何"把规则全塞进提示词"的改动都会破坏这条设计约束，必须被测试挡住。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const packs = require('../server/style/packs');
const styleProvider = require('../server/context/providers/style');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return { location };
}

test('内置基础包：迁移后即可用，含指纹与规则，无需任何配置', async t => {
  await setup(t);
  const basic = packs.basicPack();
  assert.ok(basic, '迁移应播种内置基础包');
  assert.equal(basic.kind, 'basic');
  assert.equal(basic.builtin, true);
  assert.ok(basic.profile.stance, '指纹应有克制总纲');
  const rules = packs.listRules(basic.id);
  assert.ok(rules.length >= 10, '基础包应有足量规则条目');
  assert.ok(rules.every(r => r.source), '每条规则都要标来源，便于追溯');
});

test('编译四节：指纹 + 硬线全文 + 技法参考全文 + 范文（全量注入，靠语义标签防模板化）', async t => {
  await setup(t);
  const basic = packs.basicPack();
  const text = packs.compilePackText(basic.id);

  assert.ok(text.includes('【文风约束'), '应带小节标题');
  assert.ok(text.includes('宁可少写一句'), '指纹应常驻');
  assert.ok(text.includes('【硬线规则（不可违反）】'), 'must 级规则应全文常驻');
  assert.ok(text.includes('【技法参考（按情境判断，不要逐条套用）】'),
    '非 must 规则也全文注入，但必须带「不要逐条套用」的语义标签');

  // 2026-09-12 修正：原设计把非 must 规则压成一行目录，导致 14 条规则完全失效
  // （模型只看到标题，且当时没有任何工具能读到正文）。实测 31 条全量展开仅约 3650 字符
  // （占 12000 预算 30%），省这 800 字符毫无意义。现在**所有规则的正文都进提示词**，
  // 防「模板泛滥」交给数据层（细节类只给反例）与语义标签，而不是把正文藏起来。
  const rules = packs.listRules(basic.id);
  const hintRule = rules.find(r => r.severity === 'hint' && r.rule);
  assert.ok(hintRule, '基础包应有 hint 级规则用于本断言');
  assert.ok(text.includes(hintRule.rule), 'hint 规则的正文同样必须注入（本次修正的核心）');
  assert.ok(text.includes(hintRule.title), '标题也在');
  const normalRule = rules.find(r => r.severity === 'normal' && r.rule);
  assert.ok(normalRule && text.includes(normalRule.rule), 'normal 规则正文同样必须注入');

  // must 规则必须带正反例（教得会，不只描述）
  const mustRule = rules.find(r => r.severity === 'must' && r.bad);
  assert.ok(text.includes(mustRule.rule));
  assert.ok(text.includes(mustRule.bad), 'must 规则的反面例应随规则一起注入');

  // 语义标签必须把两节分开：技法节的标题本身就是要说给模型的指令
  const mustIdx = text.indexOf('【硬线规则（不可违反）】');
  const restIdx = text.indexOf('【技法参考（按情境判断，不要逐条套用）】');
  assert.ok(mustIdx !== -1 && restIdx !== -1 && mustIdx < restIdx, '硬线在前，技法参考在后');
});

test('防模板化的防线在数据层：情感/细节类规则不配 good 正例（只给反例）', async t => {
  await setup(t);
  const basic = packs.basicPack();
  const rules = packs.listRules(basic.id);

  // 手册 V6.0 警示：优化范例在多个情绪点反复套用会变成新的、更隐蔽的 AI 味。
  // 故细节/情感类条目只给反例——不给可以照抄的正面模板。这条防线不能退。
  const emotional = rules.filter(r => ['情感', '描写'].includes(r.category));
  assert.ok(emotional.length >= 5, `情感/描写类应有足量条目（实际 ${emotional.length}）`);
  for (const r of emotional) {
    assert.equal(r.good, '', `「${r.title}」属情感/细节类，不得配 good 正例（会被当模板批量套用）`);
  }

  // 正例只允许出现在「对就是对」的语言选择题上（动词精准、拒绝书面腔）
  const withGood = rules.filter(r => r.good);
  assert.ok(withGood.length <= 3, `配 good 的条目应极少（实际 ${withGood.length} 条：${withGood.map(r => r.title).join('、')}）`);
  for (const r of withGood) {
    assert.ok(['语言'].includes(r.category), `「${r.title}」不该出现在 ${r.category} 类里配正例`);
  }
});

test('卡解析优先级：绑定主卡 > 本书专属卡 > 内置通用卡', async t => {
  const { location } = await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['风格测试书']).lastInsertRowid;
  const basic = packs.basicPack();

  // 无任何绑定时 → 内置通用卡
  const fallback = packs.resolveForBook(bookId);
  assert.equal(fallback.source, 'basic');
  assert.equal(fallback.main.id, basic.id);
  assert.deepEqual(fallback.chain.map(p => p.id), [basic.id]);

  // 绑定一张全局预设卡（走绑定表，主卡） → 走绑定
  const presetId = db.run(
    "INSERT INTO style_packs (name, kind, profile_json) VALUES (?, 'preset', ?)",
    ['知乎盐选·测试卡', JSON.stringify({ stance: '快、爽、精、准。' })]
  ).lastInsertRowid;
  require('../server/style/cards').setBookBindings(bookId, [{ packId: presetId, role: 'main' }]);
  const bound = packs.resolveForBook(bookId);
  assert.equal(bound.source, 'bound');
  assert.equal(bound.main.id, presetId);

  // 本书专属卡（book_id 命中）：绑定表无主卡时顶上
  require('../server/style/cards').setBookBindings(bookId, []);
  const ownId = db.run(
    "INSERT INTO style_packs (name, kind, book_id, profile_json) VALUES (?, 'imprint', ?, ?)",
    ['某作者印记', bookId, JSON.stringify({ stance: '短句为主。' })]
  ).lastInsertRowid;
  const own = packs.resolveForBook(bookId);
  assert.equal(own.source, 'own');
  assert.equal(own.main.id, ownId);

  // 停用专属卡 → 退回内置通用卡（不让一个停用动作把书变成无风格层）
  db.run('UPDATE style_packs SET enabled = 0 WHERE id = ?', [ownId]);
  assert.equal(packs.resolveForBook(bookId).main.id, basic.id);

  // 拆掉全部卡 → source='none'，链空（调用方据此跳过本节）
  db.run('DELETE FROM style_packs WHERE id = ?', [ownId]);
  db.run('DELETE FROM style_packs WHERE id = ?', [presetId]);
  db.run('UPDATE style_packs SET enabled = 0 WHERE id = ?', [basic.id]);
  const none = packs.resolveForBook(bookId);
  assert.equal(none.source, 'none');
  assert.deepEqual(none.chain, []);
  db.run('UPDATE style_packs SET enabled = 1 WHERE id = ?', [basic.id]);
});

test('风格层 provider：默认注入、开关可关、无包时输出空串', async t => {
  const { location } = await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['注入测试书']).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const on = styleProvider.build({ book, db });
  assert.ok(on.includes('【文风约束'), '默认应注入风格约束');
  assert.equal(styleProvider.priority, 5, 'style 节应紧接 identity 之后');
  assert.ok(
    styleProvider.budget >= 12000,
    `单节预算 ${styleProvider.budget} 字符不足以容纳委托方要求的 10000 汉字 + 结构余量`
  );

  // 全局开关关闭 → 完全不产出（写作流退回无风格层状态）
  db.run("INSERT INTO settings (key, value) VALUES ('style_layer_enabled', '0')");
  assert.equal(styleProvider.build({ book, db }), '', '关闭后应零产出');
  db.run("UPDATE settings SET value = '1' WHERE key = 'style_layer_enabled'");
  assert.ok(styleProvider.build({ book, db }).includes('【文风约束'), "'1' 视为开启");

  // 删除全部包 → 输出空串（调用方据此跳过本节），不抛错
  db.run('DELETE FROM style_rules').run;
  db.exec('DELETE FROM style_rules');
  db.exec('DELETE FROM style_packs');
  assert.equal(styleProvider.build({ book, db }), '', '无包时应优雅退化为空串');
});

test('超限降级：先丢技法参考，指纹必须存活', async t => {
  await setup(t);
  const packId = db.run(
    "INSERT INTO style_packs (name, kind, profile_json) VALUES (?, 'preset', ?)",
    ['超限测试包', JSON.stringify({ stance: '指纹必须存活。' })]
  ).lastInsertRowid;
  for (let i = 0; i < 60; i++) {
    db.run(
      `INSERT INTO style_rules (pack_id, category, title, rule, severity, sort_order)
       VALUES (?, '测试', ?, ?, 'hint', ?)`,
      [packId, `技法条目${i}`, '这条细则很长'.repeat(20), i]
    );
  }

  const text = packs.compilePackText(packId, { maxChars: 1200 });
  assert.ok(text.length <= 1200, '超限时必须裁到额度内');
  assert.ok(text.includes('指纹必须存活'), '降级顺序：先丢技法参考，指纹最后才动');
  assert.ok(!text.includes('【技法参考（按情境判断，不要逐条套用）】'), '超限时技法参考整节先丢');
});

test('预算充足时全部规则正文都在（不误伤、不再压成目录）', async t => {
  await setup(t);
  const basic = packs.basicPack();
  const text = packs.compilePackText(basic.id, { maxChars: packages_budget() });
  const rules = packs.listRules(basic.id);
  for (const r of rules) {
    assert.ok(text.includes(r.title), `预算充足时规则应包含「${r.title}」`);
    assert.ok(text.includes(r.rule), `预算充足时「${r.title}」的正文必须注入（不是只有标题）`);
  }
});

// 与 provider 常量保持同一来源，避免两处各写一个数字
function packages_budget() {
  return require('../server/context/providers/style').STYLE_BUDGET_CHARS;
}

test('★ 风格层能容纳 25000 汉字注入内容（委托方 2026-09-14 由 10000 提到 25000）', async t => {
  await setup(t);
  const budget = require('../server/context/providers/style').STYLE_BUDGET_CHARS;

  // 关键：预算约束的是**注入内容本身**（人设/指纹 + must 规则全文 + 技法参考 + 范文）。
  // 要证明「容得下 25000 汉字」，就让注入内容真的达到 25000 汉字——
  // 构造指纹 5000 汉字 + 100 条 must 规则各 200 汉字（= 20000 汉字），合计 25000 汉字。
  // 用 repeat+slice 精确取长，避免手写串长度对不上。
  const unit = '以克制为纲删除可有可无的形容词与解释性从句让动作与细节承担情绪避免直白概括与心理总结保持短句节奏并留白';
  const takeCjk = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const fingerprint = takeCjk(5000);
  assert.equal(fingerprint.length, 5000, '指纹应为 5000 汉字');

  const packId = db.run(
    "INSERT INTO style_packs (name, kind, profile_json) VALUES (?, 'preset', ?)",
    ['万字体量包', JSON.stringify({ stance: fingerprint })]
  ).lastInsertRowid;

  const ruleText = takeCjk(200);
  assert.equal(ruleText.length, 200, '单条规则正文应为 200 汉字');
  for (let i = 0; i < 100; i++) {
    db.run(
      `INSERT INTO style_rules (pack_id, category, title, trigger, rule, severity, sort_order)
       VALUES (?, '去AI化', ?, ?, ?, 'must', ?)`,
      [packId, `容量条目${i}`, `触发${i}`, ruleText, i]
    );
  }
  const injectedCjk = fingerprint.length + 100 * ruleText.length;
  assert.equal(injectedCjk, 25000, '构造的注入内容应恰为 25000 汉字');

  const text = packs.compilePackText(packId, { maxChars: budget });
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;

  assert.ok(text.length <= budget, `注入文本 ${text.length} 字符应不超过预算 ${budget}`);
  assert.ok(
    cjk >= injectedCjk,
    `25000 汉字注入内容必须完整存活，实际仅 ${cjk} 汉字——预算不足以容纳委托方要求的体量`
  );
  assert.ok(!text.includes('已截断'), '不应出现截断标记');
  // 断言首尾都在：证明是完整保留而非「只留开头」
  assert.ok(text.includes(fingerprint.slice(-40)), '指纹结尾必须存活');
  assert.ok(text.includes(`容量条目99`), '最后一条规则必须存活');
});

test('★ 25000 汉字要按「实测最密的字符构成」也装得下（预算按字符计，不能只算纯汉字）', async t => {
  await setup(t);
  const budget = require('../server/context/providers/style').STYLE_BUDGET_CHARS;

  // 为什么单开一条：预算是**字符**、需求是**汉字**，中间有个换算系数。
  // 四张蒸馏卡实测 字符/汉字 = 1.344~1.460（最密的是白石 68.5% 汉字——规则行自带
  // 「每万汉字出现 1.11 次——1623 vs 24 次」这类数字与拉丁标记）。
  // 旧注释按「汉字之外只多 15~20%」估，实际多 34~46%；只按纯汉字配预算，
  // 密卡就会在注入时被降级丢范文。这条钉子把实测最密的构成钉进测试：
  // 25 条规则 ×（1000 汉字 + 460 非汉字）= 25000 汉字 / 36500 字符。
  const unit = '以克制为纲删除可有可无的形容词与解释性从句让动作与细节承担情绪避免直白概括与心理总结保持短句节奏并留白';
  const takeCjk = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const ascii = '0123456789 .-vs/#+'.repeat(40);

  const packId = db.run(
    "INSERT INTO style_packs (name, kind, profile_json) VALUES (?, 'preset', ?)",
    ['密构成包', JSON.stringify({ stance: '密构成测试' })]
  ).lastInsertRowid;
  for (let i = 0; i < 25; i++) {
    const body = takeCjk(1000) + ascii.slice(0, 460);
    assert.equal(body.length - 1000, 460, '每条的非汉字部分应为 460 字符');
    db.run(
      `INSERT INTO style_rules (pack_id, category, title, trigger, rule, severity, sort_order)
       VALUES (?, '去AI化', ?, ?, ?, 'must', ?)`,
      [packId, `密构成条目${i}`, `触发${i}`, body, i]
    );
  }
  const wantCjk = 25 * 1000;
  const wantChars = 25 * 1460;
  assert.equal(wantCjk, 25000, '构造的注入内容应恰为 25000 汉字');
  assert.equal(wantChars, 36500, '构造的注入内容应恰为 36500 字符');

  const text = packs.compilePackText(packId, { maxChars: budget });
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  assert.ok(text.length <= budget, `注入文本 ${text.length} 字符应不超过预算 ${budget}`);
  assert.ok(
    cjk >= wantCjk,
    `按实测最密构成，25000 汉字也必须完整存活，实际仅 ${cjk} 汉字` +
    `——预算 ${budget} 字符装不下 36500 字符的密构成卡，换算系数需要重算`
  );
  assert.ok(!text.includes('已截断'), '不应出现截断标记');
  assert.ok(text.includes('密构成条目24'), '最后一条规则必须存活');
});
