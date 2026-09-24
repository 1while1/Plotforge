// 专名掩码工具单测（方案 §3.1.5 掩码契约的行为钉子）。
// 全部用小合成文本，不读真实语料（快）；真实语料实测由实测脚本另行执行。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mask = require('../tools/distill/mask');
const util = require('../tools/distill/util');

const dictOf = (pairs) => ({
  entries: pairs.map(([name, type, count]) => ({ name, type, count: count || 100 })),
});

// ---------- 掩码契约 ----------

test('PLACEHOLDERS：四类占位符固定 4 字符', () => {
  assert.deepEqual(mask.PLACEHOLDERS, {
    person: '〔人名〕', place: '〔地名〕', sect: '〔势力〕', skill: '〔功法〕',
  });
  for (const p of Object.values(mask.PLACEHOLDERS)) {
    assert.equal(p.length, 4, `占位符必须 4 个 UTF-16 码元: ${p}`);
    assert.equal(util.codePoints(p), 4, `占位符必须 4 个码点: ${p}`);
  }
});

test('最长优先：词典含「澜水」与「澜水圣地」时整体替换，不残留「圣地」', () => {
  const dict = dictOf([['澜水圣地', 'sect'], ['澜水', 'place']]);
  const text = '他来到澜水圣地附近，又沿澜水而下。';
  assert.equal(mask.maskText(text, dict), '他来到〔势力〕附近，又沿〔地名〕而下。');
  const { masked, ranges } = mask.maskTextByRanges(text, dict);
  assert.equal(masked, '他来到〔势力〕附近，又沿〔地名〕而下。');
  assert.equal(ranges.length, 2);
  assert.deepEqual([ranges[0].name, ranges[0].type], ['澜水圣地', 'sect']);
  assert.ok(!masked.includes('圣地'), '不得残留「圣地」');
});

test('maskText 与 maskTextByRanges 输出逐字节一致（嵌套/相邻专名）', () => {
  const dict = dictOf([
    ['澜水圣地', 'sect'], ['澜水', 'place'], ['沈觉', 'person'],
    ['铁铮', 'person'], ['天妖宝典', 'skill'],
  ]);
  const text = '沈觉与铁铮在澜水圣地修炼天妖宝典，圣地之外是澜水。澜水圣地旁住着沈觉。';
  assert.strictEqual(mask.maskText(text, dict), mask.maskTextByRanges(text, dict).masked);
  // 多轮随机拼接场景
  const mixed = '澜水圣地澜水沈觉澜水圣地天妖宝典铁铮澜水。'.repeat(3);
  assert.strictEqual(mask.maskText(mixed, dict), mask.maskTextByRanges(mixed, dict).masked);
});

test('★ 等长词条部分重叠时两实现取舍一致（实测验收①暴露的 bug 钉子）', () => {
  // 「许多人的」中「许多」(start 0) 与「多人」(start 1) 等长部分重叠：
  // 两实现都须按词条 name 升序（多人 < 许多）先取「多人」——否则一个取 start 序就会分叉
  const dict = dictOf([['许多', 'person', 500], ['多人', 'person', 400]]);
  const text = '许多人的脸色一下子白了。';
  const bySplit = mask.maskText(text, dict);
  const byRanges = mask.maskTextByRanges(text, dict);
  assert.strictEqual(bySplit, byRanges.masked);
  assert.equal(bySplit, '许〔人名〕的脸色一下子白了。');
  assert.deepEqual(byRanges.ranges.map((r) => r.name), ['多人']);
});

test('非专名区不变：ranges 之外字符与原文逐字节相同，ranges 区间与词条名精确对应', () => {
  const dict = dictOf([['澜水圣地', 'sect'], ['澜水', 'place'], ['沈觉', 'person'], ['铁铮', 'person']]);
  const text = '沈觉来到澜水圣地，又在澜水边遇到铁铮。';
  const { masked, ranges } = mask.maskTextByRanges(text, dict);
  for (const r of ranges) assert.equal(text.slice(r.start, r.end), r.name);
  let outside = '';
  let pos = 0;
  for (const r of ranges) { outside += text.slice(pos, r.start); pos = r.end; }
  outside += text.slice(pos);
  const stripped = masked.replace(/〔(?:人名|地名|势力|功法)〕/g, '');
  assert.equal(stripped, outside, '掩码后文本剔除占位符 = 原文剔除被掩区间');
  assert.ok(stripped.length < text.length, '至少掩掉了一个专名（用例自检）');
});

// ---------- 词典构建 ----------

// 合成语料：目标与对照里「大帝/修士/你好」完全同频（lift=1 应排除，且二者在题材词排除表），
// 「沈觉」仅目标有 → 对话提示语 + n-gram 双信号命中。
const DIALOG_PARA = '“你好。”沈觉道：“嗯。”沈觉看着大帝与修士走出大殿，坐在一旁。';
const CONTRAST_PARA = '你好。他看着大帝与修士走出大殿，坐在一旁。';
const SYN_TARGET = DIALOG_PARA.repeat(40);
const SYN_CONTRAST = CONTRAST_PARA.repeat(40);

// 模式提取语料（repeat 35 次 → 每个模式词 35 次 ≥ ngram 门槛 30，
// 使 ≤4 字的模式候选同时被 n-gram 命中——模式信号收紧后的收录条件）
const PATTERN_PARA =
  '苍始大帝镇压当世，绝人大帝与玄穹大帝并立。' +
  '阴阳教、奇士府与天鳞族在万初圣地会盟。' +
  '他修成兵字诀与凰劫再生术，又得先天太虚罡气。';
const PATTERN_TARGET = PATTERN_PARA.repeat(35);
const PATTERN_CONTRAST = '无关联文本，纯为对照。'.repeat(60);

test('对话提示语提取：“……”沈觉道： ×N → 「沈觉」入典且为 person', () => {
  const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
  const yf = dict.entries.find((e) => e.name === '沈觉');
  assert.ok(yf, `「沈觉」应入典，实际: ${JSON.stringify(dict.entries)}`);
  assert.equal(yf.type, 'person');
  assert.ok(/^v1-[0-9a-f]{12}$/.test(dict.version), `version 形如 v1-<sha256前12>: ${dict.version}`);
});

test('题材词白名单：buildDict 不收「大帝/修士」（同频 lift 排除 + 排除表双保险）', () => {
  const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.includes('大帝'), `「大帝」是题材词不得入典: ${names}`);
  assert.ok(!names.includes('修士'), `「修士」是题材词不得入典: ${names}`);
  assert.ok(!names.includes('你好'), `同频通用词应被 lift 排除: ${names}`);
});

test('「人名+动词」碎片不入典（沈觉道/沈觉看 一类）', () => {
  const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.some((n) => /^(沈觉道|沈觉看|凡道)$/.test(n)), `碎片词条不得入典: ${names}`);
});

test('无对照语料时仍可构建（空数组不抛错）', () => {
  const dict = mask.buildDict([SYN_TARGET], []);
  assert.ok(Array.isArray(dict.entries));
  assert.ok(dict.entries.some((e) => e.name === '沈觉'));
});

// ---------- 模式提取（称号/势力/功法，验收②新增） ----------

test('模式提取：称号→person（苍始大帝/绝人大帝/玄穹大帝）', () => {
  const dict = mask.buildDict([PATTERN_TARGET], [PATTERN_CONTRAST]);
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['苍始大帝'], 'person', JSON.stringify(byName));
  assert.equal(byName['绝人大帝'], 'person');
  assert.equal(byName['玄穹大帝'], 'person');
  assert.ok(dict.meta.patternCandidates > 0);
});

test('模式提取：势力→sect（阴阳教/奇士府/天鳞族/万初圣地）与功法→skill（兵字诀/先天太虚罡气）', () => {
  const dict = mask.buildDict([PATTERN_TARGET], [PATTERN_CONTRAST]);
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  for (const n of ['阴阳教', '奇士府', '天鳞族', '万初圣地']) {
    assert.equal(byName[n], 'sect', `${n} 应为 sect: ${JSON.stringify(byName)}`);
  }
  for (const n of ['兵字诀', '凰劫再生术', '先天太虚罡气']) {
    assert.equal(byName[n], 'skill', `${n} 应为 skill`);
  }
});

test('模式提取：4 字词根切片清洗（凰劫再生术 不收「劫再生」碎片）', () => {
  const dict = mask.buildDict([PATTERN_TARGET], [PATTERN_CONTRAST]);
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.some((n) => n === '劫再生' || n === '再生术'), JSON.stringify(names));
});

test('模式提取：宽后缀（会/门/法）不产生自由组合垃圾（≥5 字或 n-gram 命中才收）', () => {
  // 「肯定会/想办法/厨房门」这类词根+宽后缀的组合达不到 ngram 门槛，不得入典
  const noisy = '他肯定会想办法。厨房门关好门。'.repeat(20);
  const dict = mask.buildDict([noisy], ['无关对照文本。'.repeat(30)]);
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.includes('肯定会'), JSON.stringify(names));
  assert.ok(!names.includes('想办法'));
  assert.ok(!names.includes('厨房门'));
});

test('排除表：阵/兽类通用词不入典（验收②误掩清除）', () => {
  const dict = mask.buildDict([PATTERN_TARGET], [PATTERN_CONTRAST]);
  const names = dict.entries.map((e) => e.name);
  for (const w of ['大阵', '古阵', '杀阵', '金狮', '妖兽']) {
    assert.ok(!names.includes(w), `「${w}」是通用词不得入典: ${names}`);
  }
});

// ---------- 词内禁片段 / 数词量词 / 前缀虚词 / 称号词根（验收③新增） ----------

test('词内禁片段与数词量词：判定函数（验收③）', () => {
  const { hasForbiddenSub, hasNumQuant, hasGenericTitleRoot } = mask._internal;
  for (const w of ['人根本无法', '定要想办法', '股神秘', '踩神秘步法', '诸多大教', '身体五大秘']) {
    assert.ok(hasForbiddenSub(w), `「${w}」应被词内禁片段拒`);
  }
  for (const w of ['先天太虚罡气', '成一道人', '恒宇大帝', '玄穹大帝', '白衣神王']) {
    assert.ok(!hasForbiddenSub(w), `「${w}」不得被词内禁片段误杀`);
  }
  for (const w of ['一名四极秘', '一页神灵古经', '四大天女', '九大祖乌法']) {
    assert.ok(hasNumQuant(w), `「${w}」应被数词量词规则拒`);
  }
  for (const w of ['万初圣地', '九龙圣铜印', '斗战圣法', '成一道人']) {
    assert.ok(!hasNumQuant(w), `「${w}」不得被数词量词规则误杀`);
  }
  for (const w of ['人族大帝', '绝代神王', '棕发大圣']) {
    assert.ok(hasGenericTitleRoot(w), `「${w}」应被通用称号词根拒`);
  }
  for (const w of ['玄穹大帝', '恒宇大帝', '白衣神王', '玄雀大明王', '苍始大帝']) {
    assert.ok(!hasGenericTitleRoot(w), `「${w}」不得被通用称号词根误杀`);
  }
});

test('前缀虚词剥离：「如广寒仙子」不入典，「广寒仙子」保留（验收③）', () => {
  const t = '如广寒仙子般清冷。同广寒仙子并肩而立。广寒仙子立于月宫之上。广寒仙子不语。'.repeat(35);
  const dict = mask.buildDict([t], ['无关联文本，纯为对照。'.repeat(60)]);
  const names = dict.entries.map((e) => e.name);
  assert.ok(names.includes('广寒仙子'), `「广寒仙子」应入典: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('如广寒仙子'),
    `虚词前缀粘连「如广寒仙子」不得入典: ${JSON.stringify(names)}`);
});

test('称号词根清洗：「人族大帝」不入典，「玄穹大帝」保留（验收③）', () => {
  const t = '人族大帝与妖族大帝的传说，远古大帝的威名。玄穹大帝镇压当世。'.repeat(35);
  const dict = mask.buildDict([t], ['无关联文本，纯为对照。'.repeat(60)]);
  const names = dict.entries.map((e) => e.name);
  for (const w of ['人族大帝', '妖族大帝', '远古大帝']) {
    assert.ok(!names.includes(w), `「${w}」是描述短语不得入典: ${JSON.stringify(names)}`);
  }
  assert.ok(names.includes('玄穹大帝'), `「玄穹大帝」应入典: ${JSON.stringify(names)}`);
});

test('帝兵/法宝归类 skill（占位符〔功法〕）', () => {
  const dict = dictOf([['恒宇炉', 'skill'], ['太皇剑', 'skill'], ['虚空镜', 'skill'], ['太初命石', 'skill']]);
  assert.equal(mask.maskText('恒宇炉与太皇剑齐鸣。', dict), '〔功法〕与〔功法〕齐鸣。');
  // 后缀规则兜底（非 include/模式来源时）
  const c = mask._internal.classifyName;
  assert.equal(c('恒宇炉', 'ngram'), 'skill');
  assert.equal(c('太皇剑', 'ngram'), 'skill');
  assert.equal(c('太初命石', 'ngram'), 'skill');
  assert.equal(c('苍始大帝', 'ngram'), 'person');
});

test('2 字证据闸门：通用词海不入典，对话/后缀/白名单真名保留（验收③）', () => {
  // 2 字候选池 count≥100 有近 3000 个、多数是通用词——闸门（白名单/对话位置/强尾字）是
  // 唯一可行的收口方式（清单式清理是死循环，实测浮出 110→28→17）。
  const t = ('他盯紧前方，残酷而涅槃。岳苍道：“走吧。”沈觉道：“好。”' +
    '异域与仙域并立，楚家与王家相邻。').repeat(40);
  // maxRatio=1 关闭预算截断：小语料里对话人名密度极高会吃满 4.5% 预算，测的不是预算
  const dict = mask.buildDict([t], ['无关对照文本，纯为对照。'.repeat(40)], { maxRatio: 1 });
  const names = dict.entries.map((e) => e.name);
  for (const w of ['盯紧', '残酷', '涅槃']) assert.ok(!names.includes(w), `通用词「${w}」不得入典`);
  // 后缀证据代表用「异域」「楚家」（「仙域并立」「王家相邻」这类 4-gram 会按剪枝规则
  // 吞掉 2 字词——那是剪枝而非闸门的行为，这里不混测）
  for (const w of ['岳苍', '沈觉', '异域', '楚家']) {
    assert.ok(names.includes(w), `「${w}」应入典: ${JSON.stringify(names)}`);
  }
});

test('作者停用词：作者专属碎片随词表生效，未提供时不套用（跨作者隔离）', () => {
  // 实测教训：B8 批停用词里「座巨山」「渡星域」是白石语料专属的跨词碎片。这类人工批次
  // 已移出代码（2026-09-12 核查），只随作者词表传入——否则换作者会被静默套用。
  const t = ('座巨山压落，渡星域而行。' + '岳苍道：“走吧。”').repeat(40);
  const contrast = ['无关对照文本，纯为对照。'.repeat(40)];
  const base = mask.buildDict([t], contrast, { maxRatio: 1 });
  const withStop = mask.buildDict([t], contrast, { maxRatio: 1, stopWords: ['座巨山', '渡星域'] });
  const n0 = base.entries.map((e) => e.name);
  const n1 = withStop.entries.map((e) => e.name);
  for (const w of ['座巨山', '渡星域']) {
    assert.ok(n0.includes(w), `「${w}」本身能过统计闸门（说明拦截来自作者停用词，而非闸门侥幸）`);
    assert.ok(!n1.includes(w), `给出作者停用词后「${w}」不得入典`);
  }
  assert.equal(base.meta.opts.stopWords.length, 0, '默认不内置任何作者停用词');
});

// ---------- include / exclude（验收②机制） ----------

test('include：人工确证词条强制入典（绕过过滤与预算），type 按指定', () => {
  const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST], {
    include: [{ name: '梵仙', type: 'person' }, { name: '人欲道', type: 'sect' }],
  });
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['梵仙'], 'person', '「梵仙」语料中出现 0 次也必须入典');
  assert.equal(byName['人欲道'], 'sect');
});

test('excludeNames：ngram 直通路径也硬拦（计数达门槛时不得被收编），且优先于 include', () => {
  // 实测发现的 bug 钉子：v2 里「须弥山」只在 putWith 拦，ngram 直通路径（pool.set）
  // 绕过了拦截——预算释放后被收进词典。两条路径都必须拦。
  const target = ('须弥山巅云雾缭绕，他望向须弥山。' + SYN_TARGET).repeat(40);
  const dict = mask.buildDict([target], [SYN_CONTRAST], { excludeNames: ['须弥山'] });
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.includes('须弥山'), `「须弥山」不得入典: ${JSON.stringify(names)}`);
  assert.deepEqual(dict.meta.exclude, ['须弥山']);
  assert.ok(dict.meta.excludedHitCount >= 1, 'excludedHitCount 应记录实际拦截命中');
  // 不掩清单优先于人工确证（冲突输入以不掩为准）
  const dict2 = mask.buildDict([SYN_TARGET], [], {
    include: [{ name: '须弥山', type: 'place' }],
    excludeNames: ['须弥山'],
  });
  assert.ok(!dict2.entries.some((e) => e.name === '须弥山'), '不掩清单应优先于 include');
});

test('excludeNames：保护半径覆盖子串与超串（拦下须弥山后「须弥/弥山」不得入典）', () => {
  // 实测 bug 钉子（v4）：只拦整词时，2 字碎片「须弥」「弥山」会从 ngram 进来，
  // 掩码时把「须弥山」切成两半掩掉（「〔人名〕山」）——保护须同时覆盖子串与超串。
  const target = ('须弥山巅云雾缭绕，他望向须弥山。' + SYN_TARGET).repeat(40);
  const dict = mask.buildDict([target], [SYN_CONTRAST], { excludeNames: ['须弥山'] });
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.includes('须弥') && !names.includes('弥山'),
    `不掩词的子串碎片不得入典: ${JSON.stringify(names)}`);
  assert.equal(mask.maskText('他望向须弥山。', dict), '他望向须弥山。', '不掩词整体保留，不得半掩');
});

test('excludeNames：强制不掩清单生效并写入 meta.exclude', () => {
  // 「地狱」「龙虎山」即便在目标语料高频（这里构造同频 lift 也救不了它）也不得入典
  const target = ('他在地狱与龙虎山间徘徊，上苍之人莫知。' + SYN_TARGET).repeat(3);
  const dict = mask.buildDict([target], [SYN_CONTRAST], {
    excludeNames: ['地狱', '龙虎山', '上苍'],
  });
  const names = dict.entries.map((e) => e.name);
  assert.ok(!names.includes('地狱'), JSON.stringify(names)); 
  assert.ok(!names.includes('龙虎山'));
  assert.ok(!names.includes('上苍'));
  assert.deepEqual(dict.meta.exclude, ['地狱', '龙虎山', '上苍']);
});

// ---------- dictStats ----------

test('dictStats：条目数/掩码汉字/占比/膨胀率口径', () => {
  const dict = dictOf([['澜水圣地', 'sect'], ['澜水', 'place'], ['沈觉', 'person'], ['铁铮', 'person']]);
  const text = '沈觉来到澜水圣地，又在澜水边遇到铁铮。'; // 汉字 17，被掩 2+4+2+2=10
  const st = mask.dictStats(dict, text);
  assert.equal(st.entries, 4);
  assert.equal(st.distinctNames, 4);
  assert.equal(st.maskedChars, 10);
  assert.equal(st.maskRatio, 10 / 17); // 占比按汉字口径（分母 han=17，不含标点）
  // 膨胀率按文本全长口径：19 码元原文 → 19-10 码元 + 4 个占位符×4 码元 = 25
  assert.equal(st.expansion, 25 / 19);
});

// ---------- 预算分层可审计（2026-09-12 复核发现：include 扩容挤空 n-gram 通道是静默的） ----------

test('预算分层：core 单独顶到 maxRatio 时 n-gram 整层出局，meta 如实记录而非静默', () => {
  // 真实事故：青崖（include 267 条）核心层占比 4.48% 顶到上限 → 37 个自动词条（含
  // 李慕婉 count 1300+）静默出局；溪上老翁核心层 10.29% → 自动通道 0 词条。
  // 合成语料的对话信号（沈觉）单独就远超默认上限，等价复现该状态。
  const tight = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
  const loose = mask.buildDict([SYN_TARGET], [SYN_CONTRAST], { maxRatio: 0.6 });
  const tm = tight.meta;
  assert.ok(tm.coreCoverage > tm.opts.maxRatio,
    `核心层应单独超限：coreCoverage=${tm.coreCoverage} maxRatio=${tm.opts.maxRatio}`);
  assert.equal(tm.ngramKept, 0, 'n-gram 通道整层出局');
  assert.ok(tm.ngramDropped > 0, '出局数须如实记录');
  assert.equal(tm.ngramKept + tm.ngramDropped, tm.ngramPool, '保留+出局 = 候选池');
  assert.ok(tight.entries.some((e) => e.name === '沈觉'), '核心层强制保留（宁可如实超比例）');
  // 同一语料放宽上限 → 自动通道有词，证明「出局」是预算所致而非无候选
  assert.ok(loose.meta.ngramKept > 0, `放宽上限后应有自动词条：${JSON.stringify(loose.meta)}`);
  assert.ok(loose.meta.ngramDropped < tight.meta.ngramDropped);
});

// ---------- 停用词与前缀闸门的已知耦合（2026-09-12 复核定性：有意保留，补救手段=include） ----------

test('已知耦合：停用词连带压掉同前缀的更长候选（有意保留；真专名走 include 补救）', () => {
  // 3/4 字候选的计数以前缀集为闸门（省一次全量扫描），而该前缀集是「过滤后的候选集」——
  // 于是停用词里的 2 字词不仅自己不掩，还压掉同前缀的更长候选。2026-09-12 复核曾把它当缺陷
  // 解耦，实测后果是白石一次性涌入 28 条组合碎片（金色血/施展秘/许多古族/天神书：金色/许多
  // 等停用词重新成为生成前缀），故定性为**有意保留**：它是 9 批验收③停用词累积生效的基础。
  // 代价与补救：真专名若以停用词为前缀会被连带压掉（实测 孔雀 → 孔雀王；该例「孔雀王」是
  // 太古神鸟，压掉恰好正确）。补救是显式的——把真专名写进 include，绕过全部剪枝。
  const T = '孔雀王看着孔雀，孔雀王说话了。'.repeat(40);
  const C = '他走进大殿，看着天边，低声自语。'.repeat(40);
  const names = (d) => d.meta.poolTop.map(([n]) => n);
  assert.ok(names(mask.buildDict([T], [C])).includes('孔雀王'), '基线：候选池应含 3 字候选');
  const d1 = mask.buildDict([T], [C], { stopWords: ['孔雀'] });
  assert.ok(!names(d1).includes('孔雀'), '被停用的词本身不得入池');
  assert.ok(!names(d1).includes('孔雀王'), '已知耦合：同前缀的更长候选一并出局（当前行为）');
  const d2 = mask.buildDict([T], [C], { stopWords: ['孔雀'], include: [{ name: '孔雀王', type: 'person' }] });
  assert.ok(names(d2).includes('孔雀王'), '补救手段：写进 include 的真专名不受耦合影响');
});

// ---------- 验收①逐段差分 ----------

const SEG_BEFORE = '华云抬头。\n华云看着远方，华云沉默。\n\n澜水圣地外，华云止步。';
const SEG_DICT = dictOf([['华云', 'person'], ['澜水圣地', 'sect']]);

test('verifySegments：正确掩码全文通过', () => {
  const after = mask.maskText(SEG_BEFORE, SEG_DICT);
  const r = mask.verifySegments(SEG_BEFORE, after, SEG_DICT, 50);
  assert.equal(r.segmentsCompared, r.segmentsPassed, `应全部通过: ${JSON.stringify(r.failures)}`);
  assert.equal(r.failures.length, 0);
  assert.equal(r.segmentsCompared, 3); // 非空段全比（sampleSize 50 > 非空段数 3）
});

test('verifySegments：人为多吃一个字必须失败', () => {
  const after = mask.maskText(SEG_BEFORE, SEG_DICT);
  const lines = after.split('\n');
  lines[0] = '〔人名〕头。'; // 正确为「〔人名〕抬头。」——掩码区间多吃掉了「抬」
  const r = mask.verifySegments(SEG_BEFORE, lines.join('\n'), SEG_DICT, 50);
  assert.ok(r.segmentsPassed < r.segmentsCompared, '被篡改的段必须报失败');
  assert.ok(r.failures.length >= 1 && r.failures[0].segment === 0);
});

test('verifySegments：段落数不等直接判失败并报告', () => {
  const r = mask.verifySegments('a\nb\nc', 'a\nb\nc\nd', SEG_DICT, 10);
  assert.equal(r.segmentsCompared, 0);
  assert.equal(r.segmentsPassed, 0);
  assert.equal(r.failures[0].reason, '段落数不等');
});

test('verifySegments：LCG 固定种子，两次抽样结果可复现', () => {
  const after = mask.maskText(SEG_BEFORE, SEG_DICT);
  const r1 = mask.verifySegments(SEG_BEFORE, after, SEG_DICT, 2);
  const r2 = mask.verifySegments(SEG_BEFORE, after, SEG_DICT, 2);
  assert.deepEqual(r1, r2);
});

// ---------- 验收③第三轮：称号词根 / 书名号变体 / include 外部化（2026-09-12） ----------

test('称号词根提取：X圣主/X神王 类称号的词根单独入典（凛霄圣主→凛霄）', () => {
  // 实测背景：『凛霄圣地』整词在典，但『凛霄圣主』的独立词根「凛霄」漏掩（1693 次）。
  // 词根须自身有频次证据（独立 2-gram ≥ minNgramCount=30）——语料里让「凛霄」独立出现。
  const t = ('凛霄圣主降临，凛霄盘坐。' + SYN_TARGET).repeat(20);
  const dict = mask.buildDict([t], [SYN_CONTRAST]);
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['凛霄'], 'person', `词根「凛霄」应入典: ${JSON.stringify(Object.keys(byName))}`);
  assert.equal(byName['凛霄圣主'], 'person');
  // 词根「凛霄」不在任何人工白名单里 → 只可能来自 rootpat（钉子：防止走别的路径侥幸通过）
  assert.equal(dict.meta.opts.confirmedTwoChar.length, 0, '默认不内置任何作者白名单');
  const pats = mask._internal.extractPatternNames(['凛霄圣主出关，凛霄圣主降临。'.repeat(8)], 5, new Set(['凛霄']));
  const root = pats.find((p) => p.name === '凛霄');
  assert.ok(root, `rootpat 应产出词根候选: ${JSON.stringify(pats)}`);
  assert.equal(root.source, 'rootpat');
  assert.equal(root.type, 'person');
  // 词根无频次证据（ngramSet 未命中）时不得凭空提取
  const pats2 = mask._internal.extractPatternNames(['凛霄圣主出关，凛霄圣主降临。'.repeat(8)], 5, new Set());
  assert.ok(!pats2.some((p) => p.source === 'rootpat'), 'ngramSet 未命中时不得提取词根');
});

test('称号后缀新成员：圣主/圣使（X圣主、X圣使 整词入典）', () => {
  const t = ('凛霄圣主与朱雀圣使并肩而行。').repeat(12);
  const dict = mask.buildDict([t], ['无关对照文本而已。'.repeat(60)]);
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['凛霄圣主'], 'person', JSON.stringify(Object.keys(byName)));
  assert.equal(byName['朱雀圣使'], 'person');
});

test('书名号变体：『』「」与错配右界（『太皇经》/「』太皇经》」）都能识别', () => {
  // 实测背景：盗版清洗把《》换成『』「」，且存在错配右界（『太皇经》）；单字强调
  // （蔽霄 1001-1500 章的『色』『露』）必须被长度门槛挡住。
  const t = ('他参悟『太皇经』与「寂灭天功」，又见『太皇经》残卷与『色』之妙。').repeat(12);
  const dict = mask.buildDict([t], ['无关对照文本而已。'.repeat(60)]);
  const byName = Object.fromEntries(dict.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['太皇经'], 'skill', JSON.stringify(Object.keys(byName)));
  assert.equal(byName['寂灭天功'], 'skill');
  assert.ok(!dict.entries.some((e) => e.name.length < 2), '单字强调不得入典');
  // 变体逐条走 extractBookNames（直测正则覆盖）
  const books = mask._internal.extractBookNames(['《太皇经》『太皇经』「太皇经」『太皇经》'], 1);
  assert.equal(books.filter((b) => b.name === '太皇经').length, 1, JSON.stringify(books));
  assert.equal(books.find((b) => b.name === '太皇经').count, 4, '四种变体各计 1 次');
});

test('include/词表外部化：默认零内置，作者词表四通道按作者加载，旧 include 路径兼容', () => {
  // 默认（不传 include）：不再内置任何作者的专名——2026-09-12 核查实测的跨作者污染
  // （内置 77 条白石词条被无条件并入，言情作者词典里出现 8 个白石专名）由此杜绝。
  const d0 = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
  const by0 = Object.fromEntries(d0.entries.map((e) => [e.name, e.type]));
  assert.equal(by0['苍始大帝'], undefined, '默认不得内置作者词条');
  assert.equal(by0['源天书'], undefined);
  assert.equal(d0.meta.includedCount, 0);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-inc-'));
  try {
    // 作者词表（tools/distill/wordlists/<author>.json）：include/白名单/停用词一并加载
    fs.mkdirSync(path.join(base, 'tools/distill/wordlists'), { recursive: true });
    fs.writeFileSync(path.join(base, 'tools/distill/wordlists/白石.json'), JSON.stringify({
      include: { person: ['苍始大帝'], skill: ['源天书'] },
      confirmedTwoChar: ['凛霄'],
      confirmed3Plus: ['凛霄圣地'],
      stopWords: ['座巨山'],
    }), 'utf8');
    const wl = mask.loadWordlists('白石', base);
    assert.equal(wl.source.endsWith(path.join('wordlists', '白石.json')), true, wl.source);
    assert.deepEqual(wl.include, [
      { name: '苍始大帝', type: 'person' }, { name: '源天书', type: 'skill' },
    ]);
    assert.deepEqual(wl.confirmedTwoChar, ['凛霄']);
    assert.deepEqual(wl.confirmed3Plus, ['凛霄圣地']);
    assert.deepEqual(wl.stopWords, ['座巨山']);
    const d1 = mask.buildDict([SYN_TARGET], [SYN_CONTRAST], {
      include: wl.include,
      confirmedTwoChar: wl.confirmedTwoChar,
      confirmed3Plus: wl.confirmed3Plus,
      stopWords: wl.stopWords,
    });
    const by1 = Object.fromEntries(d1.entries.map((e) => [e.name, e.type]));
    assert.equal(by1['苍始大帝'], 'person');
    assert.equal(by1['源天书'], 'skill');
    assert.equal(d1.meta.includedCount, 2);
    // 词表文件不存在 → include:null（调用方回落旧路径），其余通道为空数组
    const miss = mask.loadWordlists('不存在', base);
    assert.equal(miss.include, null);
    assert.equal(miss.source, null);
    assert.deepEqual(miss.stopWords, []);

    // 旧路径兼容：data/corpus/dict/include-<author>.json（对象形态）
    fs.mkdirSync(path.join(base, 'data/corpus/dict'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'data/corpus/dict/include-白石.json'),
      JSON.stringify({ person: ['刘云志'], place: ['朱雀'], skill: ['太皇经'] }), 'utf8');
    const inc = mask.loadInclude('白石', base);
    assert.deepEqual(inc, [
      { name: '刘云志', type: 'person' }, { name: '朱雀', type: 'place' }, { name: '太皇经', type: 'skill' },
    ]);
    const d2 = mask.buildDict([SYN_TARGET], [SYN_CONTRAST], { include: inc });
    const by2 = Object.fromEntries(d2.entries.map((e) => [e.name, e.type]));
    assert.equal(by2['刘云志'], 'person');
    assert.equal(by2['太皇经'], 'skill');
    assert.equal(d2.meta.includedCount, 3);
    // 备用形态：data/corpus/dict/<author>/include.json（数组形态，与词典同目录）
    fs.mkdirSync(path.join(base, 'data/corpus/dict/乙'), { recursive: true });
    fs.writeFileSync(path.join(base, 'data/corpus/dict/乙/include.json'),
      JSON.stringify([{ name: '昭月', type: 'person' }]), 'utf8');
    assert.deepEqual(mask.loadInclude('乙', base), [{ name: '昭月', type: 'person' }]);
    // 文件不存在 → 空数组，不抛错
    assert.deepEqual(mask.loadInclude('不存在', base), []);
    // mergeInclude：同名词条以靠后者为准，缺 type 默认 person
    assert.deepEqual(
      mask._internal.mergeInclude([{ name: '甲', type: 'place' }], [{ name: '甲', type: 'sect' }, { name: '乙' }]),
      [{ name: '甲', type: 'sect' }, { name: '乙', type: 'person' }]
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------- 持久化 ----------

test('maskDictPath/saveDict/loadDict：路径约定与往返一致', () => {
  assert.equal(mask.maskDictPath('白石'), 'data/corpus/dict/白石/mask-dict.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-dict-'));
  try {
    const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST]);
    const p = mask.saveDict('白石', dict, tmp);
    assert.equal(p, path.join(tmp, 'data/corpus/dict/白石/mask-dict.json'));
    const loaded = mask.loadDict('白石', tmp);
    assert.deepEqual(loaded, dict);
    // 落盘词典可直接驱动掩码（round-trip 后 maskText 行为不变）
    assert.equal(
      mask.maskText('沈觉来到澜水圣地。', loaded),
      mask.maskText('沈觉来到澜水圣地。', dict)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 证据⑤：姓氏起头通道（验收②第六轮，2026-09-12） ----------

test('姓氏通道：中低频「姓+名」配角可入典（无对话位置/无强尾字的兜底信号）', () => {
  // 徐恒×N 高频、对照语料 0 次——此前四条证据全不满足而漏收（第六轮人工核对确证的场景）。
  // 后接字刻意分散（走/看/笑/站…）：同一后缀连排会让 3-gram 前缀扩展吃满 count、
  // 触发碎片剪枝「丢短保长」，那是合成语料的形态假象，真实语料后接字天然分散。
  const tails = ['走上前去', '看了看天', '笑了笑', '站在原地', '大声说道', '点了点头', '转身就走', '沉默不语'];
  const filler = '山风吹过，大地上尘土飞扬，远处的山峰在云雾中若隐若现，一切看起来都寂静无比。'.repeat(6);
  const target = Array.from({ length: 40 }, (_, i) =>
    `第${i}章 起始\n徐恒${tails[i % tails.length]}，像是想起了什么。金赤霄同样如此。${filler}`);
  const dict = mask.buildDict(target, ['这里没有任何相关的内容，只是普通叙述，还有一些别的字。'.repeat(10)]);
  const names = new Set(dict.entries.map(e => e.name));
  assert.equal(names.has('徐恒'), true, '徐恒应经姓氏通道入典');
  assert.equal(names.has('金赤霄'), true, '3 字姓+双字名应入典');
  assert.equal(dict.entries.find(e => e.name === '徐恒').type, 'person');
});

test('姓氏通道：停用词与对照高频组合不误收', () => {
  const target = ['马上出发。王家的人来了。这里的黄河很宽。'.repeat(20)];
  const contrast = ['马上出发。王家的人来了。这里的黄河很宽。'.repeat(20)];
  const dict = mask.buildDict(target, contrast);
  const names = new Set(dict.entries.map(e => e.name));
  assert.equal(names.has('马上'), false, '停用词不吃姓氏通道');
  assert.equal(names.has('黄河'), false, '对照同频组合过不了 lift');
});

// ---------- 跨作者隔离与作者词表数据（2026-09-12 核查修复的回归钉子） ----------

test('跨作者隔离：代码层不含任何作者专名（词表全在数据文件里）', () => {
  // 核查实测的污染：mask.js 曾内置 77 条白石 include + 132/327 条白名单 + 636 条停用词批次，
  // buildDict 无条件并入 → 言情作者的词典里出现 8 个白石专名（词表随代码走向所有作者）。
  for (const w of ['沈觉', '苍始大帝', '凛霄圣地', '岳苍浑身', '沈觉眸光', '座巨山', '渡星域']) {
    assert.equal(mask._internal.STOP_WORDS.has(w), false, `通用词层不得含作者词条「${w}」`);
  }
  assert.equal(mask._internal.DEFAULT_INCLUDE, undefined, '不得再有代码内置 include');
  assert.equal(mask._internal.CONFIRMED_TWO_CHAR, undefined, '不得再有代码内置 2 字白名单');
  assert.equal(mask._internal.CONFIRMED_3PLUS, undefined, '不得再有代码内置 3+ 字白名单');
  // 通用词层规模＝旧全量 2076 − 作者批次 635（两集合无交集，实测）
  assert.equal(mask._internal.STOP_WORDS.size, 1441, '通用词层只该剩功能/题材词');
});

test('CLI 参数校验：--max-ratio 必须是 (0,1) 小数（写成 8 或 0 会静默毁掉词典）', () => {
  // 上限直接决定 n-gram 通道是否整层出局；`--max-ratio 8`（想写 8%）会被当成 800% 全收，
  // `--max-ratio 0` 会把预算压成 0 → 词典只剩核心层。两者都不报错就产出、无法察觉。
  const cli = path.join(__dirname, '..', 'tools', 'distill.js');
  const run = (args) => spawnSync(process.execPath, [cli, 'mask', os.tmpdir(), ...args], { encoding: 'utf8' });
  for (const bad of ['8', '0', '-0.1', '1.5', 'abc']) {
    const r = run(['--max-ratio', bad]);
    assert.equal(r.status, 1, `应拒绝 --max-ratio ${bad}（stderr=${r.stderr}）`);
    assert.ok(/max-ratio/.test(r.stderr), r.stderr);
  }
  const missing = run(['--max-ratio']);
  assert.equal(missing.status, 1);
  assert.ok(/缺少取值/.test(missing.stderr), missing.stderr);
});

test('buildDict：opts 里显式 undefined 不得覆盖默认上限（CLI 未声明上限时会传 undefined）', () => {
  // 缺陷形态：`{ maxRatio: 0.045, ...opts }` 遇到 opts.maxRatio === undefined → budget = NaN，
  // 词典静默退化成「只有核心层」而 CLI 照常打印成功。
  const text = '张三丰说道：「今日天气甚好，山中云雾不散。」'.repeat(60);
  const withUndef = mask.buildDict([text], [text + '李四'], { maxRatio: undefined });
  const plain = mask.buildDict([text], [text + '李四'], {});
  assert.equal(withUndef.meta.opts.maxRatio, 0.045);
  assert.equal(withUndef.version, plain.version);
  assert.deepEqual(withUndef.entries.map((e) => e.name), plain.entries.map((e) => e.name));
});

test('词条守卫：与占位符同形/含〔〕/非纯汉字词条被剔除并记录（防两实现分叉）', () => {
  // 词典若含「人名」这类词条，maskText 会把已产出的〔人名〕再掩成〔〔人名〕〕，
  // 而 maskTextByRanges 只在原文上匹配 → 两实现分叉且 verifySegments 判失败。
  const dict = mask.buildDict([SYN_TARGET], [SYN_CONTRAST], {
    include: [
      { name: '人名', type: 'person' },
      { name: '〔人名〕', type: 'person' },
      { name: '甲1', type: 'person' },
    ],
  });
  assert.deepEqual(dict.meta.droppedEntries, [
    { name: '人名', reason: 'placeholder_like' },
    { name: '〔人名〕', reason: 'placeholder_bracket' },
    { name: '甲1', reason: 'not_han' },
  ]);
  assert.equal(dict.entries.some((e) => ['人名', '〔人名〕', '甲1'].includes(e.name)), false);
  // 守卫生效后，这类输入上两实现不再分叉
  const text = '他的人名被反复提及，还有〔人名〕字样。';
  assert.equal(mask.maskText(text, dict), text);
  assert.equal(mask.maskTextByRanges(text, dict).masked, text);
  assert.equal(mask._internal.entryGuardReason('沈觉'), null);
  assert.equal(mask._internal.entryGuardReason('人名'), 'placeholder_like');
  assert.equal(mask._internal.entryGuardReason('A1'), 'not_han');
});
