const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLeakedToolMarkup } = require('../server/utils/sanitize');

// 用拼接构造标记，避免测试源码里出现字面开/闭合标记
const open = (t, attrs) => '<' + t + (attrs || '') + '>';
const close = (t) => '<' + '/' + t + '>';
const lt = (rest) => '<' + rest;

test('正常中文正文与数学小于号原样保留', () => {
  const s = '夜色渐深，沈砚抬头。若 3 < 5 且 x<y 成立，则继续前行。';
  const r = sanitizeLeakedToolMarkup(s);
  assert.equal(r.text, s);
  assert.equal(r.stripped, false);
});

test('成对 tool_response 块被删，前后正文保留', () => {
  const leak = '前文段落。\n' + open('tool_response') + '\n{"ok":true}\n' + close('tool_response') + '\n后文段落。';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text.includes('tool_response'), false);
  assert.equal(r.text.includes('前文段落。'), true);
  assert.equal(r.text.includes('后文段落。'), true);
  assert.equal(r.stripped, true);
});

test('成对 invoke 块（含嵌套畸形 parameter=）整体被删', () => {
  const leak = '正文A\n' + open('invoke', ' name="append_chapter"') + '\n'
    + lt('parameter=chapterId>3') + close('parameter') + '\n' + close('invoke') + '\n正文B';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text.includes('invoke'), false);
  assert.equal(r.text.includes('parameter'), false);
  assert.equal(r.text.includes('正文A'), true);
  assert.equal(r.text.includes('正文B'), true);
});

test('结尾残缺 parameter= 标记被删（Run4 实测泄漏形态）', () => {
  const leak = '他缓缓推开雾眼之门，看见\n' + lt('parameter=bookId>123');
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text, '他缓缓推开雾眼之门，看见');
  assert.equal(r.stripped, true);
});

test('结尾未闭合 tool_code 围栏被删', () => {
  const leak = '章节正文结束。\n```tool_code\nappend_chapter(...)';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text, '章节正文结束。');
});

test('tool_response 开头后无闭合，尾部整体被删', () => {
  const leak = '前文\n' + open('tool_response') + '\n未闭合的内容';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text, '前文');
});

test('全标记 → text 为空且 stripped=true', () => {
  const leak = open('tool_response') + '\nx\n' + close('tool_response');
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text, '');
  assert.equal(r.stripped, true);
});

test('已闭合的普通 js 围栏代码块不误删', () => {
  const s = '示例：\n```js\nconst a = 1;\n```\n以上。';
  const r = sanitizeLeakedToolMarkup(s);
  assert.equal(r.text.includes('const a = 1;'), true);
  assert.equal(r.text.includes('以上。'), true);
});

test('空/非字符串输入安全返回', () => {
  assert.deepEqual(sanitizeLeakedToolMarkup(''), { text: '', stripped: false });
  assert.deepEqual(sanitizeLeakedToolMarkup(null), { text: '', stripped: false });
});

// 2026-09-10 用户反馈「最近一次输出截断了」的实测形态：agnes 把思考块边界漏进正文通道，
// 于两段正文之间夹了一个孤立的 </think>（前后两段逐字节相同，见下方 collapseDuplicatedOutput 用例）。
test('孤立 </think> 标签被删（思考块边界泄漏）', () => {
  const leak = '第一段正文结尾。\n' + close('think') + '\n\n第二段正文开头。';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(/<\/?think/i.test(r.text), false);
  assert.equal(r.text.includes('第一段正文结尾。'), true);
  assert.equal(r.text.includes('第二段正文开头。'), true);
  assert.equal(r.stripped, true);
});

test('孤立标签的多种形态（自闭合/带空格）均被删，相邻正文保留', () => {
  const leak = '甲' + close('reasoning') + '乙' + lt('thinking/>') + '丙' + lt('/analysis >') + '丁';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(/<\/?(?:think|thinking|reasoning|analysis)\b/i.test(r.text), false);
  assert.equal(r.text, '甲乙丙丁');
});

test('成对的 think 块整体被删，块外正文保留', () => {
  const leak = '正文甲\n' + open('think') + '\n内部推理不该给用户看\n' + close('think') + '\n正文乙';
  const r = sanitizeLeakedToolMarkup(leak);
  assert.equal(r.text.includes('内部推理不该给用户看'), false);
  assert.equal(r.text.includes('正文甲'), true);
  assert.equal(r.text.includes('正文乙'), true);
});

test('正文里的「思考」等中文词与小于号不受影响', () => {
  const s = '他思考着：若 x<thinking_cap 则继续。这段推理不属于标记。';
  const r = sanitizeLeakedToolMarkup(s);
  assert.equal(r.text, s);
  assert.equal(r.stripped, false);
});
