// L5 卡片产出契约（第 5 步）：分档 / 规则正文 / 上限、L1 分布画像 / 人设转译校验 / 写卡幂等。
//
// 核心不变量：
//   ① 硬线（must）**必须有量化证据**：率比达标 + 计数核对通过 ≥1 + ≥2 作品复现；缺一项就降档或排除；
//   ② 冲突簇**不进卡**（同维度互相矛盾的说法要人工裁决，不许模型替人挑一个）；
//   ③ 人设里的**每个数字都要能在输入里找到**（编造数字是这类「指标转译」最容易出的错）；
//   ④ 重跑幂等：只覆盖自己上次写的规则（`source` 带 `distill/` 前缀），卡上人工写的规则不动；
//   ⑤ LLM 转译连续不合格 → **代码兜底**，绝不卡住管线，且兜底状态要写进 provenance。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const mask = require('../tools/distill/mask');
const l5 = require('../tools/distill/l5');

// ---------- 合成 L3 簇（形状与 l3.js 输出一致，测试不跑 reduce） ----------

const T = '短句成段，段落极短'.replace('，', '，');
function cluster(over) {
  return Object.assign({
    dim: '句法',
    trait: '单句成段占比高，段落极短',
    support: { works: 3, items: 12 },
    checks: { ok: 4, unverifiable: 0, mismatch: 0 },
    liftTier: 'lift',
    rate: { targetRate: 41.2, contrastRate: 18.4, targetCount: 300, contrastCount: 120 },
    markers: ['。', '！', '？', '超出上限的第四个'],
    items: [{ check: 'ok', evidence: '〔人名〕停住了。' }, { check: 'unverifiable', evidence: '他在等。' }],
  }, over || {});
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setupDb(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

// ---------- 分档 ----------

test('classifyCluster：must 需要「率比达标 + 计数可核对 + ≥2 作品」，缺一项就降档', () => {
  assert.deepEqual(l5.classifyCluster(cluster()), { tier: 'must', why: 'lift+checked' });

  // 率比达标但**没有任何可核对条目** → 只能是技法（设计 §2 闸门 3：可信度上限低一档）
  assert.deepEqual(
    l5.classifyCluster(cluster({ checks: { ok: 0, unverifiable: 2, mismatch: 0 } })),
    { tier: 'hint', why: 'lift' });

  // 定性簇：有可核对条目 normal / 全定性 hint
  assert.deepEqual(l5.classifyCluster(cluster({ liftTier: 'qualitative' })), { tier: 'normal', why: 'qualitative' });
  assert.deepEqual(
    l5.classifyCluster(cluster({ liftTier: 'qualitative', checks: { ok: 0, mismatch: 0 } })),
    { tier: 'hint', why: 'qualitative' });
});

test('classifyCluster：单作品 / 计数不符 / 冲突 / 率比未达标 / 空特质 一律不进卡并给理由', () => {
  assert.deepEqual(l5.classifyCluster(cluster({ support: { works: 1, items: 9 } })), { tier: null, why: 'single-work' });
  assert.deepEqual(l5.classifyCluster(cluster({ checks: { ok: 3, mismatch: 1 } })), { tier: null, why: 'count-mismatch' });
  assert.deepEqual(l5.classifyCluster(cluster({ conflict: true })), { tier: null, why: 'conflict' });
  assert.deepEqual(l5.classifyCluster(cluster({ liftTier: 'contrast-zero' })), { tier: null, why: 'weak-lift' });
  assert.deepEqual(l5.classifyCluster({ dim: '意象', trait: '' }), { tier: null, why: 'empty-trait' });
  assert.deepEqual(l5.classifyCluster(null), { tier: null, why: 'empty-trait' });
});

// ---------- 规则正文 ----------

test('ruleText：特质 + 对照值（可证伪）+ 典型标记截断到 3 个', () => {
  const t = l5.ruleText(cluster());
  assert.match(t, /单句成段占比高/);
  assert.match(t, /每万汉字出现 41\.20 次/);
  assert.match(t, /同题材对照作者 18\.40 次/);
  assert.match(t, /300 vs 120 次/, '原始计数也要带上，便于人工回查');
  assert.match(t, /典型标记：。、！、？/);
  assert.ok(!t.includes('超出上限的第四个'), 'marker 只留 3 个，避免正文被标记淹没');

  const bare = l5.ruleText(cluster({ rate: null, markers: [] }));
  assert.equal(bare, '单句成段占比高，段落极短', '没有率比与标记时正文就是特质本身');
});

test('goodExample：优先取「计数可核对」的原句；都没有则空串', () => {
  assert.equal(l5.goodExample(cluster()), '〔人名〕停住了。');
  assert.equal(l5.goodExample(cluster({ items: [{ check: 'unverifiable', evidence: '他在等。' }] })), '他在等。');
  assert.equal(l5.goodExample(cluster({ items: [] })), '');
});

test('buildRules：按证据条数降序、上限分桶计数、丢弃与排除可追溯、source 带前缀', () => {
  // 夹具按「上限 + 超量」造：上限值改了不用改测试体，cap 机制始终被真的走到
  const OVER = 5;
  const many = [];
  for (let i = 0; i < l5.RULE_CAPS.must + OVER; i++) many.push(cluster({ support: { works: 3, items: 1000 - i }, trait: `特质${i}，后段` }));
  many.push(cluster({ support: { works: 3, items: 1 }, liftTier: 'qualitative', checks: { ok: 1, mismatch: 0 }, trait: '定性A' }));
  many.push(cluster({ support: { works: 1, items: 999 }, trait: '单作品' }));

  const r = l5.buildRules(many, { author: '测试作者' });
  const must = r.rules.filter((x) => x.severity === 'must');
  const tech = r.rules.filter((x) => x.severity !== 'must');
  assert.equal(must.length, l5.RULE_CAPS.must, 'must 上限');
  assert.ok(tech.length <= l5.RULE_CAPS.technique, 'technique 上限');
  assert.equal(r.dropped.length, OVER, '超上限必须计数，不许静默丢');
  assert.ok(r.dropped.every((d) => d.why === 'over-cap' && typeof d.items === 'number'));
  assert.deepEqual(r.excluded.map((x) => x.why), ['single-work']);
  assert.equal(r.rules[0].support.items, 1000, '证据最多的排最前');
  assert.ok(r.rules.every((x) => x.source.startsWith('distill/测试作者/')), 'source 前缀是幂等替换的识别位');
  assert.deepEqual(must.map((x) => x.sortOrder).slice(0, 3), [0, 1, 2]);
  assert.ok(tech.every((x) => x.sortOrder >= 100), '技法排在硬线之后');
  assert.ok(r.rules.every((x) => Array.from(x.title).length <= 60), '标题不超 60 字（注入时是「标题：正文」）');
});

test('分档上限钉子：硬线 100 / 技法 40（改这两个数=改四张卡的规则规模，须同步报告与讲解页）', () => {
  // 硬线 15 → 100 是委托方 2026-09-14 的指示：原值在白石/青崖上顶死，各丢 41/26 条已过闸门的簇。
  // 技法那档没动——实测最高 7 条，从来没接近 40，故不是瓶颈。
  assert.equal(l5.RULE_CAPS.must, 100);
  assert.equal(l5.RULE_CAPS.technique, 40);
});

// ---------- 分布画像 ----------

test('percentile：空数组 0、单点自返、两点取中点', () => {
  assert.equal(l5.percentile([], 0.5), 0);
  assert.equal(l5.percentile([7], 0.5), 7);
  assert.equal(l5.percentile([1, 2], 0.5), 1.5);
  assert.equal(l5.percentile([1, 2, 3, 4], 0.25), 1.75);
});

test('distributionProfile：分布单调、对话占比与标点谱来自真实文本', (t) => {
  const root = tmpDir(t, 'l5-corpus-');
  const dataRoot = tmpDir(t, 'l5-data-');
  const dir = path.join(root, '都市', '测试作者');
  fs.mkdirSync(dir, { recursive: true });
  // 密度与真实叙事句一致：每 400 字块里的汉字数必须 ≥300，否则 L1 特征直接返回 null
  const line = '他站在门口看着巷子尽头那盏摇晃的灯，风把雨丝吹进门缝里他却没有动，'
    + '远处有人在喊名字声音被雨吞掉了一半。\n'
    + '“你来了。”她说。\n'
    + '那盏灯忽明忽暗，把他的影子拖得很长很长，像一条没有尽头的路。\n';
  fs.writeFileSync(path.join(dir, '作品甲.txt'), line.repeat(60), 'utf8');
  fs.writeFileSync(path.join(dir, '作品乙.txt'), line.repeat(60), 'utf8');
  mask.saveDict('测试作者', { version: 'v1-test', entries: [{ name: '林野', type: 'person' }], meta: {} }, dataRoot);

  const p = l5.distributionProfile({ corpusRoot: root, author: '测试作者', dataRoot: dataRoot });
  const s = p.sentenceLen;
  assert.ok(s.p25 <= s.p50 && s.p50 <= s.p75 && s.p75 <= s.p90, `分布必须单调：${JSON.stringify(s)}`);
  assert.ok(s.mean > 0 && s.sd > 0);
  assert.equal(p.files, 2);
  assert.ok(p.dialogPct > 0 && p.dialogPct < 100, `对话占比应在 (0,100)：${p.dialogPct}`);
  assert.ok(p.singleSentenceParagraphPct > 0, '单句成段占比必须真的算出来（否则段级指标全 0）');
  assert.ok(p.blocksSampled > 0, '块级特征要真的采到块（每块汉字 <300 会被 L1 丢弃）');
  assert.equal(p.punctTop5.length, 5);
  assert.ok(p.punctTop5[0].per10k >= p.punctTop5[4].per10k, '标点谱按密度降序');
  assert.equal(p.punctBottom3.length, 3);
  const sorted = [...p.punctTop5, ...p.punctBottom3].map((x) => x.per10k);
  assert.ok(sorted.some((v) => v > 0), '标点谱不能全 0');
});

// ---------- 人设校验（数字可溯源） ----------

test('allowedNumbers / untraceableNumbers：给定数字可溯源，编造数字被点名', () => {
  const allowed = l5.allowedNumbers(['句长中位 14 字，对话占比 0.29，标点 732.3/万']);
  assert.equal(l5.untraceableNumbers('句长中位 14 字，对话占比 29%', allowed).length, 0,
    '0.29 → 29% 属单位改写，仍是给定数字的可溯源改写');
  assert.equal(l5.untraceableNumbers('平均句长 14 字，写到第 6 章', allowed).length, 0,
    '0~12 的小整数当结构计数（「3 句」「7 行」）不算编造');
  assert.equal(l5.untraceableNumbers('标点每万 732.3 个', allowed).length, 0, '相对容差内的小数改写可接受');
  assert.deepEqual(l5.untraceableNumbers('对话占比 63.7%', allowed), ['63.7'],
    '输入里没有的百分比必须被点名');
  // 实测缺陷回归（2026-09-13）：省略号真值 77.82/万字 被写成 0.33/万字，
  // 旧实现因 Math.round(0.33)=0 命中白名单里的 '0' 而放过
  assert.deepEqual(l5.untraceableNumbers('省略号每万汉字 0.33 次', l5.allowedNumbers(['省略号 77.82'])), ['0.33'],
    '小数不得因取整塌缩到 0 而被当作可溯源');
});

test('validatePersona：元话语 / 专名 / 作家名 / 掩码残留 / 编造数字 / 超长标签 各自命中', () => {
  const allowed = l5.allowedNumbers(['句长中位 14 字，对话占比 29.23%，逗号 732.3/万，单句成段 77.58%']);
  const ctx = { names: ['林野'], allowedNumbers: allowed, banned: ['白石'] };
  const base = {
    persona: '我写句子以 14 字上下为主，靠短句把节奏推快，单句成段占到 77.58%，' +
      '对话约占 29.23%，每万字里逗号 732.3 个，标点用得密、停顿多，很少写长段铺陈。',
    profile: { sentence: '句长中位 14 字，短句独立成段', dialogue: '对话占 29.23%' },
  };
  assert.equal(l5.validatePersona(base, ctx).ok, true, '全部数字可溯源 → 通过');

  const cases = [
    ['meta-voice', { persona: base.persona.replace('我写句子', '本次对比显示，句子') }],
    ['meta-voice', { persona: base.persona + '（统计分布如此）' }],
    ['proper-name:林野', { persona: base.persona + '林野就爱这么写。' }],
    ['banned-word:白石', { persona: base.persona + '像白石那样。' }],
    ['mask-artifact', { persona: base.persona + '记住〔人名〕要替换。' }],
    ['invented-number:63.7', { persona: base.persona + '平均段长 63.7 字。' }],
    ['persona-too-short', { persona: '短句为主。' }],
    ['persona-too-few-numbers', { persona: '我写短句。' + '啊'.repeat(120) }],
    ['profile-too-long:sentence', { profile: { sentence: '句'.repeat(41) } }],
    ['profile-empty', { profile: { unknown: '不在白名单的键' } }],
  ];
  for (const [expected, over] of cases) {
    const v = l5.validatePersona(Object.assign({}, base, over), ctx);
    assert.equal(v.ok, false, `${expected} 应当判不合格`);
    assert.ok(v.problems.includes(expected), `期望 ${expected}，实得 ${v.problems.join(',')}`);
  }
});

// ---------- 写卡幂等与 provenance ----------

/**
 * 从**用户提示词**（不是系统提示词！）里取数字，拼一份必然可溯源的人设。
 * 系统提示词里的 80~400 字、40 字是格式要求，不在数字白名单里——
 * 拿它们当数字用正是「编造数字」的真实形态，stub 不许替模型犯这个错。
 */
function personaFromPrompt(prompt) {
  const nums = [...new Set(String(prompt).match(/\d+(?:\.\d+)?/g) || [])].slice(0, 4);
  assert.ok(nums.length >= 3, '提示词里必须至少给到 3 个数字，否则人设无从转译');
  return JSON.stringify({
    persona: `我写句子时以 ${nums[0]} 字上下为主，段落与对话的处理上跟着 ${nums[1]} 走，`
      + `标点密度看 ${nums[2]} 这一档；简单说就是短句推进、停顿密集，把节奏压快，`
      + `对话一律后接动作提示，不写孤立对话；省略号只留在话说到一半的地方。`,
  });
}

function stubFetch(replies) {
  const calls = [];
  let i = 0;
  const fn = async (url, options) => {
    calls.push({ url: url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
    const spec = replies[Math.min(i++, replies.length - 1)];
    const msgs = calls[calls.length - 1].body.messages;
    const content = typeof spec === 'function' ? spec(msgs[msgs.length - 1].content) : spec;
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: content }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }),
    };
  };
  fn.calls = calls;
  return fn;
}

/** 合法人设（数字来自提示词）+ 七行标签。 */
function goodReply(prompt, profile) {
  const base = JSON.parse(personaFromPrompt(prompt));
  base.profile = profile || { sentence: '句长偏短，短句独立成段', dialogue: '对话后接动作提示' };
  return JSON.stringify(base);
}

test('runL5：写人设与规则、只替换自己上次写的规则、provenance 记进 profile_json.distill', async (t) => {
  await setupDb(t);
  const f = fixture(t, '测试作者');
  const packId = db.run("INSERT INTO style_packs (name, kind) VALUES (?, 'imprint')", ['测试作者']).lastInsertRowid;
  db.run("INSERT INTO style_rules (pack_id, category, title, rule, severity, source, sort_order) VALUES (?, '人工', '人工写的规则', '不许删', 'must', '', 0)", [packId]);
  db.run("INSERT INTO style_rules (pack_id, category, title, rule, severity, source, sort_order) VALUES (?, '蒸馏', '上次蒸馏的规则', '要删掉', 'must', 'distill/测试作者/句法#0', 1)", [packId]);

  const fetchImpl = stubFetch([(prompt) => goodReply(prompt)]);
  const r = await l5.runL5({
    corpusRoot: f.root, author: '测试作者', dataRoot: f.dataRoot, db: db, fetchImpl: fetchImpl,
    apiKey: 'sk-test-xxx', provider: 'stepfun', write: true,
  });

  assert.equal(r.personaFallback, false, '合法人设不该走兜底');
  assert.ok(r.persona.includes('禁止使用参照作品中的任何人物名'), '两条负向硬线由代码追加，不靠模型自觉');
  assert.ok(r.persona.includes('〔人名〕'), '范文占位符提示必须在人设里出现');
  assert.equal(r.personaAttempts, 1);
  const rows = db.all("SELECT title, source, severity FROM style_rules WHERE pack_id = ? ORDER BY sort_order", [packId]);
  assert.equal(rows.length, 1 + r.writtenRules, '只保留人工 1 条 + 本次蒸馏规则');
  assert.ok(rows.some((x) => x.title === '人工写的规则' && x.source === ''), '人工规则必须留着');
  assert.ok(!rows.some((x) => x.title === '上次蒸馏的规则'), '上次蒸馏的规则被替换');
  assert.equal(r.deletedRules, 1);
  const pack = db.get('SELECT * FROM style_packs WHERE id = ?', [packId]);
  const pj = JSON.parse(pack.profile_json);
  assert.equal(pj.distill.maskDictVersion, 'v1-test');
  assert.ok(pj.distill.clustersIn >= 2);
  assert.equal(pj.distill.conflicts, 1, '冲突簇数记进 provenance（人工裁决量）');
  assert.equal(pj.distill.personaFallback, false);
  assert.equal(pj.distill.contrastAuthor, null);
  assert.ok(pj.distill.rules.must >= 1 && pj.sentence, '七行标签与分布快照都要留痕');
  assert.ok(pack.persona.length > 0, '人设落库');
  assert.ok(pack.note.includes('重跑会覆盖'), '注释写明幂等语义');
  // 渠道与 key 用法正确（key 只进 Authorization 头）
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
  assert.equal(fetchImpl.calls[0].auth, 'Bearer sk-test-xxx');
  assert.equal(fetchImpl.calls[0].body.messages[0].role, 'system');
  assert.match(fetchImpl.calls[0].body.messages[1].content, /【目标作家分布】/, '首轮提示词要带分布');
});

/** 造一位作者的完整输入：语料 + 词典 + L3 产物 + 卡。 */
function fixture(t, author, clusterRows) {
  const root = tmpDir(t, 'l5-fixture-corpus-');
  const dataRoot = tmpDir(t, 'l5-fixture-data-');
  const dir = path.join(root, '都市', author);
  fs.mkdirSync(dir, { recursive: true });
  const line = '他站在门口看着巷子尽头那盏摇晃的灯，风把雨丝吹进门缝里他却没有动。' + '\n'
    + '“你来了。”她说。' + '\n' + '风从巷子里穿过去，卷起一层灰，那盏灯忽明忽暗像一条没有尽头的路。' + '\n' + ';'
  fs.writeFileSync(path.join(dir, '作品甲.txt'), line.repeat(40), 'utf8');
  fs.writeFileSync(path.join(dir, '作品乙.txt'), line.repeat(40), 'utf8');
  mask.saveDict(author, { version: 'v1-test', entries: [{ name: '林野', type: 'person' }], meta: {} }, dataRoot);
  const l3dir = path.join(dataRoot, 'data', 'corpus', `src-${author}`, 'l3');
  fs.mkdirSync(l3dir, { recursive: true });
  const rows = clusterRows || [cluster(), cluster({ dim: '词汇', trait: '口语化短词多，语气助词密集', liftTier: 'qualitative' })];
  fs.writeFileSync(path.join(l3dir, 'clusters.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(l3dir, 'conflicts.jsonl'),
    JSON.stringify({ dim: '意象', trait: '冲突簇示例', conflict: true }) + '\n', 'utf8');
  fs.writeFileSync(path.join(l3dir, 'summary.json'), JSON.stringify({ clusters: rows.length, conflicts: 1 }), 'utf8');
  return { root: root, dataRoot: dataRoot };
}

test('runL5：人设转译两次不合格 → 代码兜底但仍写规则（管线不卡死）', async (t) => {
  await setupDb(t);
  const f = fixture(t, '测试作者乙');
  db.run("INSERT INTO style_packs (name, kind) VALUES (?, 'imprint')", ['测试作者乙']);
  const bad = JSON.stringify({ persona: '文笔优美，引人入胜。', profile: {} });   // 太短、无数字、空标签
  const fetchImpl = stubFetch([bad]);
  const logs = [];
  const r = await l5.runL5({
    corpusRoot: f.root, author: '测试作者乙', dataRoot: f.dataRoot, db: db, fetchImpl: fetchImpl,
    apiKey: 'sk-test-xxx', provider: 'stepfun', write: true, log: (m) => logs.push(m),
  });
  assert.equal(r.personaFallback, true);
  assert.equal(r.personaAttempts, 2, '两次都试过才兜底');
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(r.persona.includes('本条为代码兜底描述'), '兜底要在人设里自我声明，别冒充 LLM 产物');
  assert.ok(r.writtenRules >= 1, '人设失败不影响规则入库');
  assert.ok(logs.some((m) => m.includes('代码兜底')), '兜底必须留下日志');
});

test('runL5：dry-run 不写库、不建卡也不写规则', async (t) => {
  await setupDb(t);
  const f = fixture(t, '测试作者丙');
  db.run("INSERT INTO style_packs (name, kind) VALUES (?, 'imprint')", ['测试作者丙']);
  // 新库自带迁移种下的内置卡规则，所以断言「没有 distill/ 来源的行」而不是「表为空」
  const before = db.get('SELECT COUNT(*) AS n FROM style_rules').n;
  const r = await l5.runL5({
    corpusRoot: f.root, author: '测试作者丙', dataRoot: f.dataRoot, db: db,
    fetchImpl: stubFetch([(prompt) => goodReply(prompt)]), apiKey: 'sk-test-xxx', provider: 'stepfun', write: false,
  });
  assert.ok(r.persona.length > 0, 'dry-run 也要把人设返回来（否则没法验收）');
  assert.equal(r.writtenRules, undefined, 'dry-run 不应有写入结果字段');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM style_rules').n, before, 'dry-run 一条规则都不许写');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM style_rules WHERE source LIKE 'distill/%'").n, 0);
  assert.ok(!db.get('SELECT persona FROM style_packs WHERE name = ?', ['测试作者丙']).persona, 'dry-run 不许写人设');
});

test('runL5：卡不存在时明确报错（提示先跑 samples），不静默造卡', async (t) => {
  await setupDb(t);
  const f = fixture(t, '测试作者丁');
  await assert.rejects(
    () => l5.runL5({
      corpusRoot: f.root, author: '测试作者丁', dataRoot: f.dataRoot, db: db,
      fetchImpl: stubFetch([(prompt) => goodReply(prompt)]), apiKey: 'sk-test-xxx', write: true,
    }),
    /找不到印记卡/);
});

// ---------- 冲突簇处理（2026-09-13 实测补丁） ----------

test('looksConflicting：只有方向对立或自述「冲突」才算真冲突', () => {
  // 实测被判为冲突但其实是互补的不同侧面（溪上老翁三簇里的两簇）
  assert.equal(l5.looksConflicting({
    trait: '高频使用口语化表达，涵盖网络流行语、方言、语气词，部分存在混搭词库、重复特定词汇的特点',
    variants: ['高频使用口语化表达，涵盖网络流行语、方言、语气词', '部分存在混搭词库、重复特定词汇的特点'],
  }), false, '「口语词多」+「有重复用词习惯」是两条互补观测，不是冲突');
  assert.equal(l5.looksConflicting({
    trait: '以细碎动作、神态描写为核心，极少有大段独立的环境铺陈段落，细节贴近日常生活',
    variants: ['以细碎动作、神态描写为核心，极少有大段铺陈', '存在零星直白心理活动、外貌特征等细节描写'],
  }), false, '「极少大段铺陈」+「存在零星细节」并不矛盾');
  // 真冲突：方向相反的量化说法
  assert.equal(l5.looksConflicting({
    trait: '标点使用倾向不一', variants: ['高频使用省略号等口语化标点', '辅以少量特殊标点用法'],
  }), true, '高频 vs 少量 是互相否定');
  // 真冲突：簇自己就说「存在冲突」
  assert.equal(l5.looksConflicting({
    trait: '叙事采用第三人称有限视角，存在第一人称「我」的视角冲突', variants: ['第三人称有限视角', '存在第一人称视角'],
  }), true, '自述「冲突」的措辞不适合当规则正文');
  assert.equal(l5.looksConflicting({ trait: '句长偏短', variants: [] }), true,
    '标了冲突却不给 variants → 无从核对，按真冲突处理（保守方向是不进卡）');
});

test('classifyCluster：误标冲突降档为技法；真冲突/单作品冲突仍不进卡', () => {
  const spurious = cluster({ conflict: true, variants: ['多用口语词', '有重复用词习惯'], liftTier: 'lift', checks: { ok: 3, mismatch: 0 } });
  assert.deepEqual(l5.classifyCluster(spurious), { tier: 'hint', why: 'conflict-downgraded' },
    '证据再多也不给硬线——冲突标记只降档，不升档');

  const real = cluster({ conflict: true, variants: ['高频使用省略号', '极少使用省略号'] });
  assert.deepEqual(l5.classifyCluster(real), { tier: null, why: 'conflict' }, '真冲突走人工裁决');

  const singleWork = cluster({ conflict: true, variants: ['多用口语词', '有重复用词习惯'], support: { works: 1, items: 9 } });
  assert.deepEqual(l5.classifyCluster(singleWork), { tier: null, why: 'conflict-single-work' });
});

test('buildRules：降档簇进技法桶并在 downgraded 里留痕（供人工复核）', () => {
  const rows = [
    cluster({ conflict: true, variants: ['多用口语词', '有重复用词习惯'], liftTier: 'lift', checks: { ok: 3, mismatch: 0 }, trait: '口语词多，兼有重复用词习惯' }),
    cluster({ conflict: true, variants: ['高频使用省略号', '极少使用省略号'], trait: '省略号使用倾向不一' }),
    cluster({ dim: '词汇', trait: '正常簇' }),
  ];
  const r = l5.buildRules(rows, { author: '测试作者' });
  assert.equal(r.rules.length, 2);
  const downgradedRule = r.rules.find((x) => x.trait.startsWith('口语词多'));
  assert.equal(downgradedRule.severity, 'hint', '降档簇绝不能当硬线（冲突标记只降档，不升档）');
  assert.equal(r.downgraded.length, 1);
  assert.equal(r.downgraded[0].dim, '句法');
  assert.deepEqual(r.downgraded[0].variants, ['多用口语词', '有重复用词习惯']);
  assert.deepEqual(r.excluded.map((x) => x.why), ['conflict']);
});

test('runL5：误标冲突的簇落库时写进 provenance，且卡片不再 0 条规则', async (t) => {
  await setupDb(t);
  const f = fixture(t, '测试作者戊', [
    cluster({ conflict: true, variants: ['多用口语词', '有重复用词习惯'], liftTier: 'lift', checks: { ok: 3, mismatch: 0 }, trait: '口语词多，兼有重复用词习惯' }),
  ]);
  const packId = db.run("INSERT INTO style_packs (name, kind) VALUES (?, 'imprint')", ['测试作者戊']).lastInsertRowid;
  const r = await l5.runL5({
    corpusRoot: f.root, author: '测试作者戊', dataRoot: f.dataRoot, db: db,
    fetchImpl: stubFetch([(prompt) => goodReply(prompt)]), apiKey: 'sk-test-xxx', provider: 'stepfun', write: true,
  });
  assert.equal(r.writtenRules, 1, '误标冲突不该让整张卡 0 条规则');
  assert.equal(r.downgraded.length, 1);
  const pj = JSON.parse(db.get('SELECT profile_json FROM style_packs WHERE id = ?', [packId]).profile_json);
  assert.equal(pj.distill.conflictsDowngraded, 1);
  assert.equal(pj.distill.conflictDowngrades[0].dim, '句法');
  const note = db.get('SELECT note FROM style_packs WHERE id = ?', [packId]).note;
  assert.match(note, /看不出对立/, '注释里要写明降档原因，方便日后复核');
});
