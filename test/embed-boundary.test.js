// 嵌入边界不变量（2026-09-13 线上缺陷修复）：
//
//   ① 检索 query 的拼装**必须**落在嵌入安全边界内——嵌入端对超长文本静默截断，
//      而叙事锚点拼在末尾，指令一长锚点就整段被吃掉，「续写定向召回」无声失效；
//   ② 定稿索引切块**必须**块块 ≤ CHUNK_SIZE——切块内层循环的 `combined &&` 守卫
//      让首段不受长度检查，一个 3000 字不分段的章节会变成 3000 字块，
//      尾部在语义检索里永久失联。
const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleQuery, buildRetrievalQuery, fitQueryText } = require('../server/context/providers/retrieval')._internals;
const { EMBED_TEXT_MAX } = require('../server/vector/embed');
const { chunkText } = require('../server/vector/indexer');

const LONG = '他站在崖顶，风把松林压出一道又一道的弧线。'.repeat(40);   // 800 字

test('assembleQuery：任何输入下总长都不超嵌入边界，且指令永不被丢', () => {
  const cases = [
    { q: '接着写', a: { prevTail: LONG, curTail: LONG } },
    { q: '继续', a: { prevTail: LONG, curTail: '' } },
    { q: '往下写', a: { prevTail: '', curTail: LONG } },
    { q: '续', a: { prevTail: LONG.slice(0, 300), curTail: LONG.slice(0, 300) } },
    { q: '接着写'.repeat(80), a: { prevTail: LONG, curTail: LONG } },      // 指令 240 字
    { q: '接着写'.repeat(400), a: { prevTail: LONG, curTail: LONG } },     // 指令 1200 字
    { q: '接着写', a: null },
    { q: '分析一下这段对话的节奏', a: null },
    { q: '写'.repeat(2000), a: null },
  ];
  for (const c of cases) {
    const r = assembleQuery(c.q, c.a);
    assert.ok(r.chars <= EMBED_TEXT_MAX, `超界：${r.chars} > ${EMBED_TEXT_MAX}（指令 ${c.q.length} 字）`);
    assert.equal(r.chars, r.text.length);
    assert.ok(r.text.length > 0, '指令不许被整段丢掉');
    assert.equal(r.budget, EMBED_TEXT_MAX);
    // 头尾保真：字符码点截断不出乱码代理对
    assert.ok(!/\uFFFD/.test(r.text));
  }
});

test('assembleQuery：锚点在预算内时进 query，被舍弃时点名（不静默）', () => {
  const both = assembleQuery('接着写', { prevTail: LONG.slice(0, 300), curTail: LONG.slice(0, 300) });
  assert.ok(both.text.includes('本章已写到：'), '本章尾部锚点应进 query');
  assert.ok(both.text.includes('上一章结尾：'), '预算够时上一章锚点也应进 query');
  assert.deepEqual(both.dropped, []);

  // 指令吃满预算 → 低优先级锚点被显式舍弃并点名（旧行为是静默被嵌入端截断）
  const starved = assembleQuery('接着写'.repeat(200), { prevTail: LONG, curTail: LONG });
  assert.ok(starved.text.includes('本章已写到：'), '最近的叙事邻接优先保住');
  assert.ok(starved.dropped.includes('上一章结尾'), `应点名舍弃项：${JSON.stringify(starved.dropped)}`);
  assert.ok(starved.chars <= EMBED_TEXT_MAX);

  // 只有上一章锚点（首章之外的常见形态）：本章为空时它仍要被利用起来
  const one = assembleQuery('继续', { prevTail: LONG, curTail: '' });
  assert.ok(one.text.includes('上一章结尾：'));
  assert.ok(!one.text.includes('本章已写到：'));
});

test('buildRetrievalQuery：保持字符串签名（旧调用方不受影响）', () => {
  const anchors = { prevTail: '灰雁号驶入北境冻港。', curTail: '林野握紧了舵轮。' };
  const q = buildRetrievalQuery('接着写', anchors);
  assert.equal(typeof q, 'string');
  assert.ok(q.startsWith('接着写'));
  assert.ok(q.includes('上一章结尾：灰雁号驶入北境冻港。'));
  assert.ok(q.includes('本章已写到：林野握紧了舵轮。'));
  assert.equal(buildRetrievalQuery('写一段追逐戏', null), '写一段追逐戏');
});

test('fitQueryText：短文本原样、长文本头尾保真、极小预算不越界', () => {
  assert.equal(fitQueryText('  接着写  ', 100), '接着写');
  const long = '开头主题在这里。' + '中间过程。'.repeat(100) + '结尾落点在这里。';
  const fitted = fitQueryText(long, 60);
  assert.equal(Array.from(fitted).length, 60);
  assert.ok(fitted.startsWith('开头主题在这里。'), '开头（主题）要保住');
  assert.ok(fitted.endsWith('结尾落点在这里。'), '结尾（落点）要保住');
  assert.equal(fitQueryText(long, 0), '');
  assert.equal(Array.from(fitQueryText(long, 10)).length, 10);
});

test('chunkText：超长段落拆成 ≤500 字块，尾部不再失联', () => {
  const tail = '这是这一段最后一句，必须能被检索到。';
  const oneLongPara = '第一句。' + '中间内容继续铺陈。'.repeat(400) + tail;   // 3,000+ 字单段
  const chunks = chunkText(oneLongPara);
  assert.ok(chunks.length >= 6, `超长段落应被切成多块，实得 ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= 500, `块长必须 ≤500，实得 ${c.text.length}`);
    assert.ok(c.text.length > 30);
  }
  assert.ok(chunks.some(c => c.text.includes(tail)), '段落尾部必须落在某一块里（旧实现整段丢弃）');
  // 区间单调且落在原文范围内
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].charStart >= chunks[i - 1].charStart);
  for (const c of chunks) {
    assert.ok(c.charEnd <= oneLongPara.length);
    assert.equal(c.text, oneLongPara.slice(c.charStart, c.charEnd).replace(/^\s+|\s+$/g, ''),
      'charStart/charEnd 必须指向原文真实位置');
  }
});

test('chunkText：普通多段文本行为不变（块 ≤500、段落区间与哈希稳定）', () => {
  const paras = Array.from({ length: 9 }, (_, i) => `第${i + 1}段：` + '星海'.repeat(40));
  const chunks = chunkText(paras.join('\n\n'));
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.text.length <= 500 && c.text.length > 30);
    assert.ok(c.paragraphEnd >= c.paragraphStart);
    assert.ok(c.charEnd > c.charStart);
    assert.match(c.contentHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(chunks.map(c => c.sourceRevisionHash)).size, 1);
});

test('chunkText：纯单行短文本与空文本不产生垃圾块', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('短句。'), [], '不足 30 字的块不索引（沿用既有口径）');
  const single = chunkText('这句话够长，刚好超过三十个字，用来做一个最小可索引的块，不会被丢掉。');
  assert.equal(single.length, 1);
  assert.ok(single[0].text.length > 30);
});
