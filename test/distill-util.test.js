// 蒸馏共通件单测：滑窗切块（P8 第三条硬性验收的断言落点）、章题剔除、语料走读。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('../tools/distill/util');

test('slidingChunks：基础切窗 + 重叠步长', () => {
  const text = 'a'.repeat(100);
  const chunks = util.slidingChunks(text, { size: 40, step: 30 });
  assert.equal(chunks.length, Math.ceil((100 - 40) / 30) + 1); // 覆盖全文
  assert.equal(chunks[0].text.length, 40);
  assert.equal(chunks[1].charStart, 30); // 步长 30 = 10 字重叠
  const tail = chunks[chunks.length - 1];
  assert.ok(tail.charStart + tail.text.length === 100, '最后一块必须覆盖到文末');
});

test('slidingChunks：步长合法性校验（step 必须 <= size）', () => {
  assert.throws(() => util.slidingChunks('abc', { size: 10, step: 11 }), /非法 step/);
  assert.throws(() => util.slidingChunks('abc', { size: 0, step: 1 }), /非法 size/);
});

test('★ P8 硬性验收：向量域切块每块 ≤500 码点，超长段落场景也不越界', () => {
  // indexer.js 的缺陷场景：单个 1598 字超长段落会整体成块（首轮不检查长度）。
  // 滑窗切块无段落概念，天然免疫——这里用实测语料里出现过的极端长度钉住。
  const longPara = '沈觉走进大殿。'.repeat(400); // 2800 字、无换行的单段
  const chunks = util.vectorChunks(longPara);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(util.codePoints(c.text) <= 500, `块 ${c.index} 超限: ${util.codePoints(c.text)}`);
  }
  // 输出块长分布口径：max(length) <= 500（验收①的人工复核方式）
  const maxLen = Math.max(...chunks.map(c => util.codePoints(c.text)));
  assert.ok(maxLen <= 500);
});

test('★ P8 硬性验收：向量域切块不得复用 indexer.chunkText（结构性断言）', () => {
  // 复用检测 = 本文件不 require/import server/vector/indexer（验收的人工复核方式固化为断言；
  // 注释里提及 indexer 是说明性文字，不算复用）
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'distill', 'util.js'), 'utf8');
  const requires = src.match(/require\([^)]*\)|import\s[^;]*from\s[^;]*/g) || [];
  assert.ok(!requires.some(r => /indexer/.test(r)), 'util.js 不得 require/import indexer.js');
});

test('slidingChunks：size 超嵌入边界时显式报错（把静默截断转为显式失败）', () => {
  // 510 是嵌入模型静默截断边界（方案 §1.7④ 实测）；除 8000 字 LLM 输入域外不得超
  assert.throws(() => util.slidingChunks('x'.repeat(2000), { size: 600, step: 500 }), /嵌入安全边界/);
  assert.throws(() => util.slidingChunks('x'.repeat(2000), { size: 8000 + 1, step: 7800 }), /嵌入安全边界/);
  // 8000 字 LLM 域是合法的（不进嵌入模型）
  const big = util.slidingChunks('x'.repeat(20000), { size: 8000, step: 7800 });
  assert.ok(big.length >= 2);
});

test('mapChunks：8,000 字块 / 步长 7,800（含 200 字重叠，§3.2 口径）', () => {
  const text = '字'.repeat(8000 + 7800 * 3);
  const chunks = util.mapChunks(text);
  assert.equal(chunks[1].charStart, 7800);
  assert.ok(chunks.every(c => c.text.length <= 8000));
});

test('stripChapterTitles：剔除「第N章」形态行，保留其余行', () => {
  const src = '第一章 起点\n\n沈觉抬起头。\n第126章 众妙之门，第127章 玄黄\n他愣住了。\n123 某种数字行\n正文继续。';
  const out = util.stripChapterTitles(src);
  assert.equal(out, '\n沈觉抬起头。\n他愣住了。\n正文继续。');
});

test('readCorpus：识别「题材/作家/作品_书名/分卷」4 层与「题材/作家/书名.txt」3 层', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  try {
    fs.mkdirSync(path.join(dir, '玄幻小说', '作家白石', '作品_蔽霄'), { recursive: true });
    fs.writeFileSync(path.join(dir, '玄幻小说', '作家白石', '作品_蔽霄', '蔽霄(1-500章).txt'), '正文一');
    fs.mkdirSync(path.join(dir, '温馨言情小说', '作家晚棠未开'), { recursive: true });
    fs.writeFileSync(path.join(dir, '温馨言情小说', '作家晚棠未开', '我家老婆来自一千年前(1-399章).txt'), '正文二');
    fs.writeFileSync(path.join(dir, '温馨言情小说', '作家晚棠未开', '老婆请安分.txt'), '正文三');

    const files = util.readCorpus(dir);
    assert.equal(files.length, 3);
    const byRel = Object.fromEntries(files.map(f => [f.rel, f]));
    const a = byRel['玄幻小说/作家白石/作品_蔽霄/蔽霄(1-500章).txt'];
    assert.equal(a.author, '白石');
    assert.equal(a.work, '蔽霄');
    assert.equal(a.topic, '玄幻小说');
    const b = byRel['温馨言情小说/作家晚棠未开/我家老婆来自一千年前(1-399章).txt'];
    assert.equal(b.author, '晚棠未开');
    assert.equal(b.work, '我家老婆来自一千年前');
    const c = byRel['温馨言情小说/作家晚棠未开/老婆请安分.txt'];
    assert.equal(c.work, '老婆请安分');
    assert.equal(c.author, '晚棠未开');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('han 统计只数汉字', () => {
  assert.equal(util.han('沈觉 Fan, 123！'), 2);
  assert.equal(util.han(''), 0);
});
