const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateText, estimateMessages, estimateTokens, estimateMessagesTokens,
} = require('../server/contextBudget');

test('estimateText 粗略 chars/4 向后兼容', () => {
  assert.equal(estimateText(''), 0);
  assert.equal(estimateText('abcdefgh'), 2); // 8/4
  assert.equal(estimateText('a'.repeat(5)), 2); // ceil(5/4)
});

test('estimateTokens 空/非字符串返回 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(123), 0);
});

test('estimateTokens 中文按 ≈0.7 token/字，高于 chars/4 的低估', () => {
  const zh = '一二三四五六七八九十'; // 10 CJK
  assert.equal(estimateTokens(zh), 7); // ceil(10*0.7)
  assert.ok(estimateTokens(zh) > estimateText(zh));
});

test('estimateTokens 英文按 1/4 token/字', () => {
  assert.equal(estimateTokens('a'.repeat(8)), 2);
});

test('estimateTokens 中英混合分桶累加', () => {
  // 5 CJK(3.5) + 8 ascii(2) = 5.5 → ceil 6
  assert.equal(estimateTokens('一二三四五abcdefgh'), 6);
});

test('estimateTokens 含中文标点不抛异常且为正', () => {
  assert.ok(estimateTokens('你好，世界。——测试、') > 0);
});

test('estimateMessagesTokens 处理字符串/数组/tool_calls（CJK 感知）', () => {
  const msgs = [
    { role: 'system', content: '一二三四五六七八九十' }, // 7
    { role: 'user', content: [{ type: 'text', text: 'abcdefgh' }] }, // 2
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'ab', arguments: '1234' } }] }, // 1+1
  ];
  assert.equal(estimateMessagesTokens(msgs), 11);
});

test('estimateMessages 与 estimateMessagesTokens 并存且中文场景后者更大', () => {
  const msgs = [{ role: 'user', content: '一二三四五六七八九十' }];
  assert.ok(estimateMessagesTokens(msgs) > estimateMessages(msgs));
});
