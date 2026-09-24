// 作家卡契约（作家仓库第四步）：卡 CRUD / 主辅卡绑定 / 多卡编译去重 / 热插拔 / 范文注入。
// 核心不变量：
//   ① 换卡立即生效（编译路径无缓存，改完不用重启）；
//   ② 同名规则以主卡为准（多卡叠加不能出现两份互相打架的同名规则）；
//   ③ 停用一张卡即时从所有引用它的书里消失（可热插拔的关键）；
//   ④ 没有语料时不出现空的范文节（不留空壳标题）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const packs = require('../server/style/packs');
const cards = require('../server/style/cards');
const retrieve = require('../server/style/retrieve');
const styleProvider = require('../server/context/providers/style');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['卡测试书']).lastInsertRowid;
  return { location, bookId };
}

test('建卡与改卡：字段落地、卡名必填、内置位不可由接口设置', async (t) => {
  await setup(t);
  const pack = cards.createPack({
    name: '古龙武侠',
    persona: '你写武侠，句子极短。',
    profile: { stance: '冷。', sentence: '一句一段。' },
    builtin: 1, // 恶意/误传：必须被忽略
  });
  assert.equal(pack.name, '古龙武侠');
  assert.equal(pack.kind, 'preset', '未指定 kind 时默认 preset');
  assert.equal(pack.builtin, false, 'builtin 不可由接口设置（内置卡是代码资产）');
  assert.equal(pack.persona, '你写武侠，句子极短。');
  assert.equal(pack.profile.stance, '冷。');

  assert.throws(() => cards.createPack({ name: '  ' }), /卡名必填/);

  const renamed = cards.updatePack(pack.id, { name: '古龙', enabled: false });
  assert.equal(renamed.name, '古龙');
  assert.equal(renamed.enabled, false);
  assert.equal(renamed.persona, '你写武侠，句子极短。', '未传的字段不该被清空');
});

test('规则与范文 CRUD：校验必填、范文改正文即作废旧向量', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '规则测试卡' });

  assert.throws(() => cards.addRule(pack.id, { title: '有题无文' }), /规则正文必填/);
  assert.throws(() => cards.addRule(pack.id, { rule: '有文无题' }), /规则标题必填/);

  const rule = cards.addRule(pack.id, { title: '短句成段', rule: '一句话就是一段。', severity: 'must' });
  assert.equal(rule.severity, 'must');
  assert.equal(rule.sortOrder, 0, '首条规则 sort_order 从 0 起');
  const rule2 = cards.addRule(pack.id, { title: '慎用比喻', rule: '默认不用。' });
  assert.equal(rule2.sortOrder, 1, '后续规则自动递增排序');
  assert.equal(rule2.severity, 'normal', '未指定分级时默认 normal');

  assert.throws(() => cards.updateRule(rule.id, { severity: 'very-must' }), /分级只能是/);
  assert.equal(cards.updateRule(rule.id, { severity: 'hint' }).severity, 'hint');
  assert.equal(cards.deleteRule(rule.id), true);
  assert.equal(cards.deleteRule(rule.id), false, '重复删除返回 false 而不是抛错');

  const sample = cards.addSample(pack.id, { title: '片段一', text: '刀。很快的刀。' });
  assert.equal(sample.charCount, 7);
  assert.equal(sample.indexed, false, '新范文不该自称已索引');
  // 模拟已索引，再改正文 → 索引必须作废（宁可退回直出，也不要拿旧向量匹配新文本）
  db.run("UPDATE style_samples SET vector = ?, vector_model = 'bge-small-zh-v1.5', indexed_at = '2026-09-12T00:00:00Z' WHERE id = ?",
    [Buffer.from([1, 2, 3, 4]), sample.id]);
  assert.equal(retrieve.toSample(db.get('SELECT * FROM style_samples WHERE id = ?', [sample.id])).indexed, true);
  const after = cards.updateSample(sample.id, { text: '刀。' });
  assert.equal(after.indexed, false, '改正文必须清掉向量');
  assert.equal(after.charCount, 2);

  assert.throws(() => cards.addSample(pack.id, { text: '   ' }), /范文正文必填/);
});

test('绑卡：一本书一张主卡 + 多张辅卡，换绑立即反映在解析结果上', async (t) => {
  const { bookId } = await setup(t);
  const basic = packs.basicPack();
  const main = cards.createPack({ name: '主卡' });
  const aux1 = cards.createPack({ name: '辅卡一' });
  const aux2 = cards.createPack({ name: '辅卡二' });

  // 默认：无绑定 → 内置卡兜底
  assert.equal(packs.resolveForBook(bookId).source, 'basic');

  cards.setBookBindings(bookId, [
    { packId: main.id, role: 'main' },
    { packId: aux1.id, role: 'aux', sortOrder: 0 },
    { packId: aux2.id, role: 'aux', sortOrder: 1 },
  ]);
  const r = packs.resolveForBook(bookId);
  assert.equal(r.source, 'bound');
  assert.equal(r.main.name, '主卡');
  assert.deepEqual(r.aux.map(p => p.name), ['辅卡一', '辅卡二']);
  assert.deepEqual(r.chain.map(p => p.name), ['主卡', '辅卡一', '辅卡二'], '主卡永远在链首');
  // books.style_pack_id 镜像列同步（历史读法兼容）
  assert.equal(db.get('SELECT style_pack_id FROM books WHERE id = ?', [bookId]).style_pack_id, main.id);

  // 换绑即整体替换（不是增量）
  cards.setBookBindings(bookId, [{ packId: main.id, role: 'main' }, { packId: basic.id, role: 'aux' }]);
  assert.deepEqual(packs.resolveForBook(bookId).chain.map(p => p.name), ['主卡', '去 AI 味·通用']);

  // 主卡重复 / 卡重复绑定 / 卡不存在 → 拒绝
  assert.throws(() => cards.setBookBindings(bookId, [
    { packId: main.id, role: 'main' }, { packId: aux1.id, role: 'main' },
  ]), /只能有一张主卡/);
  assert.throws(() => cards.setBookBindings(bookId, [
    { packId: main.id, role: 'main' }, { packId: main.id, role: 'aux' },
  ]), /不能重复绑定/);
  assert.throws(() => cards.setBookBindings(bookId, [{ packId: 999999, role: 'main' }]), /不存在/);
});

test('热插拔：停用一张卡即时从卡链消失，不需要逐本解绑', async (t) => {
  const { bookId } = await setup(t);
  const basic = packs.basicPack();
  const main = cards.createPack({ name: '会停用的主卡' });
  cards.setBookBindings(bookId, [
    { packId: main.id, role: 'main' },
    { packId: basic.id, role: 'aux' },
  ]);
  assert.deepEqual(packs.resolveForBook(bookId).chain.map(p => p.name), ['会停用的主卡', '去 AI 味·通用']);

  cards.updatePack(main.id, { enabled: false });
  assert.deepEqual(packs.resolveForBook(bookId).chain.map(p => p.name), ['去 AI 味·通用'],
    '停用的主卡应即时消失；绑定表里仍有记录但解析时被过滤');

  // 内置卡也停用后：无卡可用 = 'none'（风格层空转），而不是「有辅卡没主卡」的怪异状态
  cards.updatePack(basic.id, { enabled: false });
  assert.equal(packs.resolveForBook(bookId).source, 'none');
  assert.deepEqual(packs.resolveForBook(bookId).chain, []);
  cards.updatePack(basic.id, { enabled: true });
});

test('多卡编译：人设与指纹都注入，同名规则以主卡为准（不出现两份）', async (t) => {
  await setup(t);
  const main = cards.createPack({
    name: '主卡',
    persona: '你是主卡人设。',
    profile: { stance: '主卡立场。' },
  });
  const aux = cards.createPack({
    name: '辅卡',
    persona: '你是辅卡人设。',
    profile: { stance: '辅卡立场。' },
  });
  cards.addRule(main.id, { title: '短句成段', rule: '主卡版本：一句一段。', severity: 'must', category: '行文' });
  cards.addRule(aux.id, { title: '短句成段', rule: '辅卡版本（应被主卡挡住）。', severity: 'must', category: '行文' });
  cards.addRule(aux.id, { title: '慎用比喻', rule: '辅卡独有规则。', severity: 'must', category: '语言' });

  const text = packs.compileCardsText([main.id, aux.id]);
  assert.ok(text.includes('主卡 + 辅卡'), '标题应列出全部卡名');
  assert.ok(text.includes('你是主卡人设。'), '主卡人设应注入');
  assert.ok(text.includes('你是辅卡人设。'), '辅卡人设应注入');
  assert.ok(text.includes('〔主卡〕') && text.includes('〔辅卡〕'), '多卡时应标出每段人设属于哪张卡');
  assert.ok(text.includes('主卡版本：一句一段。'), '主卡的同名规则应存活');
  assert.ok(!text.includes('辅卡版本（应被主卡挡住）。'), '辅卡同名规则必须被去重挡掉');
  assert.equal((text.match(/短句成段/g) || []).length, 1, '同名规则只能出现一次');
  assert.ok(text.includes('辅卡独有规则。'), '辅卡独有的规则应正常注入');

  // 单卡时不标卡名（省得啰嗦）
  const single = packs.compileCardsText([main.id]);
  assert.ok(!single.includes('〔主卡〕'), '单卡时不必标卡名');
});

test('范文注入：有语料才出范文节，无语料不留空壳标题', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '带范文的卡' });
  cards.addRule(pack.id, { title: '一条规则', rule: '正文。', severity: 'must' });

  const empty = packs.compileCardsText([pack.id]);
  assert.ok(!empty.includes('【范文参照'), '没有范文时不得出现空壳标题');

  cards.addSample(pack.id, { title: '片段一', text: '刀。很快的刀。风很大。' });
  const filled = packs.compileCardsText([pack.id]);
  assert.ok(filled.includes('【范文参照'), '有范文时应出现范文节');
  assert.ok(filled.includes('刀。很快的刀。风很大。'), '范文正文应整段注入');
  assert.ok(filled.includes('片段一'), '范文段名应带上');

  // 单段超额度时整段跳过（截半个场景比不给还糟）
  const tiny = retrieve.selectSamples([pack.id], { maxChars: 3 });
  assert.equal(tiny.length, 0, '装不下时宁可不给，不截断');
});

test('超限降级顺序：范文 → 技法参考 → 硬线细则 → 只留人设与指纹', async (t) => {
  await setup(t);
  const pack = cards.createPack({ name: '降级测试卡', persona: '人设必须最后才丢。', profile: { stance: '立场必须最后才丢。' } });
  for (let i = 0; i < 20; i++) {
    cards.addRule(pack.id, { title: `必要规则${i}`, rule: `必要规则${i}的正文，`.repeat(10), severity: 'must', category: '总纲' });
    cards.addRule(pack.id, { title: `技法规则${i}`, rule: `技法规则${i}的正文，`.repeat(10), severity: 'normal', category: '语言' });
  }
  cards.addSample(pack.id, { title: '长范文', text: '范文内容。'.repeat(500) });

  // 逐层收紧额度：用「上一层实测长度 − 1」当下一层额度，
  // 保证断言的正是「装不下时先丢谁」，而不是拿猜的数字碰运气
  const full = packs.compileCardsText([pack.id], { maxChars: 10_000_000 });
  assert.ok(full.includes('【范文参照'), '额度充足时应包含范文');
  // 2026-09-12：非 must 规则现在也全文注入（原先只出一行目录，导致 14 条规则失效）
  assert.ok(full.includes('技法规则0的正文'), '额度充足时技法规则的正文也必须在');
  assert.ok(full.includes('【技法参考（按情境判断，不要逐条套用）】'), '技法节带语义标签');

  const noSamples = packs.compileCardsText([pack.id], { maxChars: full.length - 1 });
  assert.ok(!noSamples.includes('【范文参照'), '超限时先丢范文');
  assert.ok(noSamples.includes('【硬线规则（不可违反）】'), '硬线应比范文活得久');
  assert.ok(noSamples.includes('【技法参考（按情境判断，不要逐条套用）】'), '技法参考此时还在');
  assert.ok(noSamples.length <= full.length - 1, '降级后必须在额度内');

  const noRest = packs.compileCardsText([pack.id], { maxChars: noSamples.length - 1 });
  assert.ok(!noRest.includes('【技法参考'), '再超限时丢技法参考整节');
  assert.ok(noRest.includes('【硬线规则（不可违反）】'), '硬线应比技法参考活得久');
  assert.ok(noRest.includes('人设必须最后才丢。'), '人设此时还在');

  const profileOnly = packs.compileCardsText([pack.id], { maxChars: noRest.length - 1 });
  assert.ok(!profileOnly.includes('【硬线规则（不可违反）】'), '最后才丢硬线细则');
  assert.ok(profileOnly.includes('人设必须最后才丢。'), '人设是最终的兜底，永不先丢');
  assert.ok(profileOnly.indexOf('人设必须最后才丢。') < profileOnly.indexOf('立场必须最后才丢。'),
    '人设排在指纹之前（先读到「我是谁」再读「怎么落笔」）');
  assert.ok(profileOnly.length <= noRest.length - 1, '任何情况下都不得超出额度');
});

test('范文选择：整段进整段出，跨卡按顺序填充', async (t) => {
  await setup(t);
  const a = cards.createPack({ name: '卡A' });
  const b = cards.createPack({ name: '卡B' });
  cards.addSample(a.id, { title: 'A1', text: 'A一'.repeat(10) }); // 20 字符
  cards.addSample(a.id, { title: 'A2', text: 'A二'.repeat(10) });
  cards.addSample(b.id, { title: 'B1', text: 'B一'.repeat(10) });

  const picked = retrieve.selectSamples([a.id, b.id], { maxChars: 100 });
  assert.deepEqual(picked.map(s => s.title), ['A1', 'A2', 'B1'], '按卡顺序与段内顺序填充');
  assert.deepEqual(picked.map(s => s.packId), [a.id, a.id, b.id]);

  const limited = retrieve.selectSamples([a.id, b.id], { maxChars: 25 });
  assert.deepEqual(limited.map(s => s.title), ['A1'], '装满即止');
  assert.equal(retrieve.selectSamples([], {}).length, 0, '空卡链返回空数组');
});

test('风格层 provider 用卡链编译：改卡后同一本书的注入文本立即变化（无缓存）', async (t) => {
  const { bookId } = await setup(t);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const before = styleProvider.build({ book, db });
  assert.ok(before.includes('去 AI 味·通用'), '默认注入内置通用卡');

  const main = cards.createPack({ name: '新主卡', persona: '你是新主卡。' });
  cards.setBookBindings(bookId, [{ packId: main.id, role: 'main' }]);
  const after = styleProvider.build({ book, db });
  assert.ok(after.includes('你是新主卡。'), '换卡后应立即生效（编译路径无缓存）');
  assert.ok(!after.includes('去 AI 味·通用'), '换掉的主卡不应残留');

  // 删卡：绑定级联清理，回到内置卡
  cards.deletePack(main.id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM book_style_packs WHERE book_id = ?', [bookId]).n, 0,
    '删卡应级联清掉绑定，不留悬空引用');
  assert.ok(styleProvider.build({ book, db }).includes('去 AI 味·通用'), '删卡后回落到内置卡');
});

test('内置卡受保护：不可删除，但可改名与停用', async (t) => {
  await setup(t);
  const basic = packs.basicPack();
  assert.throws(() => cards.deletePack(basic.id), /内置卡不可删除/);
  assert.equal(cards.updatePack(basic.id, { name: '我的通用卡' }).name, '我的通用卡');
  assert.equal(cards.updatePack(basic.id, { enabled: false }).enabled, false);
  // 停用后 basicPack() 找不到它 → provider 返回空串（风格层空转，写作回到原状态）
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['空转书']).lastInsertRowid;
  assert.equal(styleProvider.build({ book: db.get('SELECT * FROM books WHERE id = ?', [bookId]), db }), '',
    '内置卡停用且无其他卡时，风格层应完全不产出');
});
