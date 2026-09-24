// 段级靶点诊断回归（2026-09-14，去 AI 率归因配套工具）。
// 钉住两件事：①标签必须能在原文里数出来（确定性，不是模型判断）；
// ②导出的「改稿目标清单」**绝不含检测分数**——把分数给模型是项目铁律禁止的（而且实测无效）。
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../public/segment-targets');

test('诊断命中可按原文计数：比喻/拟声/身体模板/套话/感叹号', () => {
  const text = '他的眼神像刀，语气像冰，动作像风。轰！轰！他的瞳孔收缩，嘴角抖动。瞬间，顿时，缓缓，微微，淡淡。';
  const tags = ST.diagnose(text).map(t => t.key);
  assert.ok(tags.includes('simile'), '3 处明喻应命中');
  assert.ok(tags.includes('onomatopoeia'));
  assert.ok(tags.includes('bodyTic'));
  assert.ok(tags.includes('cliche'));
  assert.ok(tags.includes('exclaim'));
});

test('阈值生效：单处比喻不报（避免把正常比喻当病灶）', () => {
  const tags = ST.diagnose('他像风一样跑过。').map(t => t.key);
  assert.ok(!tags.includes('simile'));
});

test('结尾升华只在段末命中，段中出现不算', () => {
  const mid = ST.diagnose('他知道这件事终将过去，于是转身继续赶路，再没有回头看过一眼那个地方。').map(t => t.key);
  assert.ok(!mid.includes('elevate'), '升华词在段中不应命中');
  const tailHit = ST.diagnose('他抬起头。这一刻，他终将明白自己的路。').map(t => t.key);
  assert.ok(tailHit.includes('elevate'), '段末升华应命中');
});

test('句长整齐：>=3 句且波动小才命中，长短交错不报', () => {
  const even = '他走进屋子。她坐着喝茶。灯光很暗。窗外有风。';
  assert.ok(ST.diagnose(even).map(t => t.key).includes('evenSentences'));
  const varied = '他走进屋子的时候，屋里只剩下半盏灯。她坐着喝茶。窗外，风把雪吹成一片模糊的白，远处的狗叫了整整一晚。';
  assert.ok(!ST.diagnose(varied).map(t => t.key).includes('evenSentences'), '长短交错不应命中');
});

test('诊断输出不含任何「分数」形状的数字（0.xxxx）', () => {
  const out = JSON.stringify(ST.diagnose('他的眼神像刀，像冰，像风。瞬间，缓缓，微微，淡淡的。'));
  assert.ok(!/0\.\d{3,}/.test(out), '诊断只给计数，不给检测分数');
});

test('改稿目标清单：含段落正文与毛病标签，但绝不出现分数', () => {
  const segs = [
    { index: 0, text: '他的眼神像刀，像冰，像风。轰！轰！', label: 1, conf: 0.9999 },
    { index: 1, text: '她走进屋子，坐下。', label: 2, conf: 0.7411 },
  ];
  const brief = ST.buildBrief(segs);
  assert.ok(brief.includes('他的眼神像刀'), '应带段落正文');
  assert.ok(brief.includes('比喻密集'), '应带毛病标签');
  assert.ok(!/0\.\d{3,}/.test(brief), '不得把 con f分数写进给模型的清单');
  assert.ok(!/0\.9999|0\.7411/.test(brief), '具体分数绝不能出现');
});

test('onlyAi：只收朱雀判为 AI（label=1）的段', () => {
  const segs = [
    { index: 0, text: '第一段像刀，像冰。', label: 1, conf: 0.99 },
    { index: 1, text: '第二段她走进屋子，坐下喝茶。', label: 2, conf: 0.6 },
  ];
  const brief = ST.buildBrief(segs, { onlyAi: true });
  assert.ok(brief.includes('第一段'));
  assert.ok(!brief.includes('第二段'));
  const texts = ST.buildTextList(segs, { onlyAi: true });
  assert.equal(texts, '第一段像刀，像冰。', '纯文本清单同样只收 AI 段');
});

test('段落切分：按换行切、去空白段、索引连续', () => {
  const paras = ST.splitParagraphs('甲\n\n乙。\n  \n丙。\n');
  assert.deepEqual(paras.map(p => p.text), ['甲', '乙。', '丙。']);
  assert.deepEqual(paras.map(p => p.index), [0, 1, 2]);
  assert.deepEqual(ST.splitParagraphs(''), []);
});

test('单句成段要有句末标点：章节标题行（「第二章」）不算靶点', () => {
  const keys = ST.diagnose('第二章').map(t => t.key);
  assert.ok(!keys.includes('oneLineParas'), '3 字标题行不是「单句成段」');
  const hit = ST.diagnose('他站住了。').map(t => t.key);
  assert.ok(hit.includes('oneLineParas'), '真的有句末标点的单句短段才命中');
});

test('空段落与空白输入不炸', () => {
  assert.deepEqual(ST.diagnose(''), []);
  assert.deepEqual(ST.diagnose(null), []);
  assert.equal(ST.buildBrief([]), '（没有可定位的段落）');
  assert.equal(ST.buildTextList(null), '');
});
