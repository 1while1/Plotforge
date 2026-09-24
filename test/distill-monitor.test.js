// 看板后端的两条口径钉子（tools/distill-monitor/server.js）：
//  ① 严格口径（map/）与归一后口径（map-relaxed/）分开计数——验证与下游消费看后者；
//  ② 归一后只统计 **sha 与主集一致** 的行（词典/切块变过之后的老行不算，与 map-final-stats.js 同口径），
//     落后时标记 relaxedStale，让页面能提示「主集新增行后要重跑 revalidate」。
// 夹具走环境无关的临时目录（authorStats 支持 dataRoot 覆盖），不依赖仓库里的真实产物。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authorStats } = require('../tools/distill-monitor/server');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
}

/** 造一行 map 产物：keptStrict 条严格保留 + dropped 条丢弃。 */
function row(index, sha, kept, dropped) {
  return JSON.stringify({
    chunkIndex: index, sha256: sha, at: new Date().toISOString(),
    provider: 'agnes', model: 'agnes-3.0-flash', usage: { input: 10, output: 20 },
    kept: Array.from({ length: kept }, (_, i) => ({ dim: '词汇', trait: `t${i}`, evidence: 'e', count: 1 })),
    dropped: Array.from({ length: dropped }, (_, i) => ({ item: { dim: 'vocabulary' }, reason: 'dim_invalid' })),
  });
}

function writeFixture(root, { mapLines, relaxedLines }) {
  const mapDir = path.join(root, 'data', 'corpus', 'src-测试甲', 'map');
  const relDir = path.join(root, 'data', 'corpus', 'src-测试甲', 'map-relaxed');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, '测试书.jsonl'), mapLines.join('\n') + '\n', 'utf8');
  if (relaxedLines) {
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(path.join(relDir, '测试书.jsonl'), relaxedLines.join('\n') + '\n', 'utf8');
  }
}

const AUTHOR = { name: '测试甲', total: 2, works: { 测试书: 2 } };

test('authorStats：严格与归一后分列计数，归一后只认 sha 一致的行', () => {
  const tmp = tmpdir();
  try {
    // 主集 2 行：块 0 = 严格 3 条、块 1 = 严格 1 条
    // 派生集：块 0 的 sha 与主集一致（归一后 5 条）→ 应计入；
    //         块 1 的 sha 对不上（词表/切块变过之前的老行）→ **不得计入**，且标记落后
    writeFixture(tmp, {
      mapLines: [row(0, 'sha-0', 3, 1), row(1, 'sha-1', 1, 2)],
      relaxedLines: [row(0, 'sha-0', 5, 0), row(1, 'sha-STALE', 9, 0)],
    });
    const a = authorStats(AUTHOR, tmp);
    assert.equal(a.done, 2);
    assert.equal(a.kept, 4, '严格口径 = 3 + 1');
    assert.equal(a.keptRelaxed, 5, '只计 sha 一致的那一行（不得把老行的 9 条算进来）');
    assert.equal(a.relaxedFresh, 1);
    assert.equal(a.doneRelaxed, 2);
    assert.equal(a.relaxedStale, true, '派生集落后于主集时必须标出来');
    assert.equal(a.keptPerBlock, 2, '4 / 2 块');
    assert.equal(a.keptPerBlockRelaxed, 2.5, '5 / 2 块');
    assert.equal(a.remaining, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('authorStats：没有派生集时归一后为 0 且标落后（页面不会显示误导性的高值）', () => {
  const tmp = tmpdir();
  try {
    writeFixture(tmp, { mapLines: [row(0, 'sha-0', 2, 0), row(1, 'sha-1', 2, 0)] });
    const a = authorStats(AUTHOR, tmp);
    assert.equal(a.kept, 4);
    assert.equal(a.keptRelaxed, 0);
    assert.equal(a.relaxedFresh, 0);
    assert.equal(a.relaxedStale, true);
    assert.equal(a.keptPerBlockRelaxed, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('authorStats：产物目录不存在时降级为空统计（看板不能成为故障点）', () => {
  const tmp = tmpdir();
  try {
    const a = authorStats({ name: '不存在', total: 7, works: {} }, tmp);
    assert.equal(a.done, 0);
    assert.equal(a.remaining, 7);
    assert.equal(a.kept, 0);
    assert.equal(a.keptRelaxed, 0);
    assert.equal(a.retention, null, '无数据时留存率是 null（页面渲染 —）而不是 0 或 NaN');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
