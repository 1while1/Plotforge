// 源码契约：Agent 输出上限参数名必须匹配已安装 ai SDK 的类型定义。
// 背景：ai SDK v6 已移除 v4 的 maxTokens 参数（改名 maxOutputTokens），传旧名会被
// streamText 静默忽略——8000 输出上限从未生效（全景报告§十记录的问题）。
// 本项目是纯 JS 无类型检查，用源码文本断言兜底，防止未来改回旧参数名。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('agent.js streamText 使用 maxOutputTokens（ai v6 参数名），不出现旧名 maxTokens:', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'agent', 'agent.js'),
    'utf8'
  );
  assert.ok(/maxOutputTokens\s*:/.test(source), 'streamText 应显式传 maxOutputTokens');
  assert.ok(!/\bmaxTokens\s*:/.test(source), 'ai v6 已移除 maxTokens 参数名，不得再使用');
});

test('已安装 ai SDK 类型定义确实提供 maxOutputTokens 且不含 maxTokens', () => {
  const types = fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', 'ai', 'dist', 'index.d.ts'),
    'utf8'
  );
  assert.ok(/maxOutputTokens\??\s*:/.test(types), 'SDK 应定义 maxOutputTokens');
  assert.ok(!/\bmaxTokens\??\s*:/.test(types), 'SDK 不应再有 maxTokens（防升级后参数名再变）');
});
