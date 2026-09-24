// L3 驱动层的钉子测试（tools/distill/l3.js）——不联网、不读语料，只钉会静默改变成本/正确性的参数。
//
// 为什么值得单独立一个文件：reduce 的**输出尺度与 map 差一个数量级**（map 块 → 1~3k token，
// reduce 叶层批 150 条观测 → 实测 12~20k token），而两个阶段的预算一度共用一个定稿值。
// 后果不是报错，而是**成片静默截断**：每批白烧一次满额输出、再拆成 2 批重算，日志里只留一行
// 「输出截断 → 一分为二重算」。这类「参数太小但看起来能跑」的缺陷已踩两次
// （map 的 4000、reduce 的 16000），故把下界变成测试。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const l3 = require('../tools/distill/l3');

test('reduce 预算：默认 32k 输出 / 600s 超时（叶层批 150 条观测的真实尺度）', () => {
  const b = l3.reduceBudget();
  assert.equal(b.maxTokens, l3.REDUCE_MAX_TOKENS);
  assert.equal(b.timeoutMs, l3.REDUCE_TIMEOUT_MS);
  // 下界取证：溪上老翁 L0 实测 11 批 139,541 output token（均值 12,687，全部通过）；
  // 白石「一个 trait 拖着上百个 id」的池子单批需 19k+。16000 会把这种批成片打断。
  assert.ok(b.maxTokens >= 20000, `reduce 输出预算 ${b.maxTokens} 小于实测单批需求（≥19k）`);
  assert.ok(b.timeoutMs >= 300000, `reduce 超时 ${b.timeoutMs} 小于 map 阶段定稿的 300s`);
});

test('reduce 预算：显式覆盖生效，非法值回落默认（0/负数/非整数不算覆盖）', () => {
  assert.equal(l3.reduceBudget({ maxTokens: 40000, timeoutMs: 900000 }).maxTokens, 40000);
  assert.equal(l3.reduceBudget({ maxTokens: 40000, timeoutMs: 900000 }).timeoutMs, 900000);
  for (const bad of [0, -1, 1.5, '32000', null, undefined]) {
    assert.equal(l3.reduceBudget({ maxTokens: bad }).maxTokens, l3.REDUCE_MAX_TOKENS, `maxTokens=${bad} 不该被当成覆盖`);
    assert.equal(l3.reduceBudget({ timeoutMs: bad }).timeoutMs, l3.REDUCE_TIMEOUT_MS, `timeoutMs=${bad} 不该被当成覆盖`);
  }
});

test('reduce 预算：与 map 阶段参数解耦（map 定稿 16k 不得回流成 reduce 默认）', () => {
  const map = require('../tools/distill/map');
  assert.equal(map.MAX_TOKENS, 16000, 'map 阶段的 16000 是 2026-09-12 实测定稿，不该改');
  assert.notEqual(l3.REDUCE_MAX_TOKENS, map.MAX_TOKENS, 'reduce 不得沿用 map 的输出预算');
});
