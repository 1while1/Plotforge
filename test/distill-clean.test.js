// 语料清洗单测（规则钉子：能删脏、**绝不能吃正文**）。
//
// 本文件的负面用例全部来自真实语料的过度删除事故（2026-09-13 首版规则）——
// 【…】包裹的读者群/游戏公屏内容、「对话提示语：」短行、正文里的读书叙述、
// 「……」场景分隔后的正文行，都是必须原样保留的。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const clean = require('../tools/distill/clean');

const D = (s) => { const r = clean.cleanText(s); return { out: r.text, stats: r.stats }; };

test('clean：PUA 私用区与替换符被剔除（否则污染指纹的字符/标点类特征）', () => {
  const { out } = D('他抬头看天\uE001，心里一沉\uFFFD。');
  assert.equal(out, '他抬头看天，心里一沉。');
});

test('clean：HTML 标签与实体行内清理，正文保留', () => {
  const { out } = D('第一行正文<br/>第二行&nbsp;正文');
  assert.equal(out, '第一行正文第二行 正文');
});

test('clean：纯 URL 行删除；正文行内 URL 只剥 URL，正文保留', () => {
  const a = D('https://www.example.com/book/12345');
  assert.equal(a.out, '');
  assert.equal(a.stats.url, 1);
  const b = D('他合上书本，忽然想起昨天的事。http://a.b.com/x 然后他笑了。');
  assert.equal(b.out, '他合上书本，忽然想起昨天的事。 然后他笑了。');
  const c = D('网址：http://www.shudugu.org');
  assert.equal(c.out, '');
});

test('clean：站点水印与盗版占位语删除（速读谷/记住本站/请升级到新版本）', () => {
  const { out, stats } = D([
    '正文第一段。',
    '来源：速读谷',
    '请记住本书首发域名：www.example.com',
    '请升级到新版本查看本章内容',
    '正文第二段。',
  ].join('\n'));
  assert.equal(stats.site, 2);
  assert.equal(stats.pirate, 1);
  assert.equal(out, '正文第一段。\n正文第二段。');
});

test('clean：广告框（分隔线 + 框内站点话术 + 推广话术）整块删，正文保留', () => {
  const { out, stats } = D([
    '正文段落。',
    '=====',
    '作者新书《黎明之劫》已经上传，求收藏求推荐票。',
    '更多章节请访问 www.example.com',
    '喜欢的朋友请加入书友群，谢谢大家支持。',
    '=====',
    '正文接下来的段落。',
  ].join('\n'));
  assert.ok(stats.ad_block >= 4, `广告框应整块删（实际 ${JSON.stringify(stats)}）`);
  assert.ok(out.includes('正文段落。') && out.includes('正文接下来的段落。'), '正文两段必须保留');
  assert.ok(!out.includes('黎明之劫'), '推广块里的他书书名必须被删掉');
});

test('clean：无强证据的「分隔线 + 疑似推广」不整块删（只有广告话术不到位就放过）', () => {
  const { out, stats } = D([
    '正文段落。',
    '……',
    '季青浅喜欢陆以北。',
    '……',
    '正文接下来的段落。',
  ].join('\n'));
  assert.equal(stats.ad_block, undefined);
  assert.ok(out.includes('季青浅喜欢陆以北。'), '场景分隔符后的正文必须保留');
});

test('clean：正文不吃——含 喜欢/推荐/月票/收藏/新书 的正常句子必须原样保留', () => {
  const prose = [
    '他喜欢她很久了，只是一直没有说出口。',
    '“这本书我推荐你读一读。”她把书递过来。',
    '月票的事他并不在意，倒是那张地图让他想了很久。',
    '他把信收藏在抽屉最底下，谁也不打算告诉。',
    '她的新书刚刚上架，收藏数还不到一百。',
  ].join('\n');
  const { out, stats } = D(prose);
  assert.equal(out, prose);
  assert.deepEqual(stats, {});
});

test('clean：正文不吃——【…】包裹的读者群/游戏公屏内容（首版误删事故）', () => {
  const prose = [
    '他打开手机，群里正刷着屏。',
    '【清浅：你怎么？掉线了？】',
    '【一路向北：白月光打电话过来，吵了一架，彻底闹掰了。】',
    '【1：鸽了？果真是好鸽鸽】',
  ].join('\n');
  const { out, stats } = D(prose);
  assert.equal(out, prose);
  assert.deepEqual(stats, {});
});

test('clean：正文不吃——「对话提示语：」短行（首版误删事故，删掉等于自毁对话特征）', () => {
  const prose = [
    '许澈沉默：',
    '「那就这样吧。」',
    '清浅更是嗔怪：',
    '「你怎么才来。」',
    '他拿起手机：',
  ].join('\n');
  const { out, stats } = D(prose);
  assert.equal(out, prose);
  assert.deepEqual(stats, {});
});

test('clean：正文不吃——读书/观影叙述里的「人名+推荐过《书名》」（首版误删事故）', () => {
  const prose = [
    '想必青浅女侠是知道这句话的，毕竟陆以北推荐她阅读过《我是猫》、《少爷》以及《虞美人草》等作品。',
    '“最近看的是《我心危》…”',
    '陆以北作为游戏高手，一眼看出他在玩名作《黑魂三》。',
  ].join('\n');
  const { out, stats } = D(prose);
  assert.equal(out, prose);
  assert.deepEqual(stats, {});
});

test('clean：纯符号行删除（===== / ------），但不误删带内容的破折号句', () => {
  const a = D('==========\n正文。');
  assert.equal(a.stats.symbol_line, 1);
  assert.equal(a.out, '正文。');
  const b = D('他说——不，是她说。');
  assert.equal(b.out, '他说——不，是她说。');
});

test('clean：（本章完）单独成行时删除', () => {
  const { out, stats } = D('正文最后一段。\n（本章完）');
  assert.equal(stats.chapter_mark, 1);
  assert.ok(!out.includes('本章完'));
  assert.ok(out.includes('正文最后一段。'));
});
