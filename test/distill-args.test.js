// CLI 参数解析契约（tools/distill/args.js）。
//
// 这里钉的是一次**静默做反**的缺陷（2026-09-13 实测）：
// `--dry-run` 写在末尾（后面没有取值）时旧实现给出 `args['dry-run'] = undefined`，
// 而调用处是 `write: !args['dry-run']` → `!undefined === true` → **照样写库**；
// `--no-reduce` 同理（想只看闸门，实际照样跑 reduce 计费）。两者都不报错，
// 只在「结果与预期相反」时才被发现——必须由单测钉住语义。
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, BOOL_FLAGS } = require('../tools/distill/args');

test('布尔开关：命中即 true，且不吞掉下一个位置参数', () => {
  assert.deepEqual([...BOOL_FLAGS].sort(), ['dry-run', 'no-reduce']);

  const a = parseArgs(['小说作品', '--author', '白石', '--dry-run']);
  assert.equal(a.args['dry-run'], true, '末尾的 --dry-run 必须是 true（旧实现是 undefined → 写库）');
  assert.equal(a.args.author, '白石');
  assert.equal(a.root, '小说作品');
  assert.equal(a.flagsWithoutValue.has('dry-run'), false, '布尔开关不是「缺取值」');

  const b = parseArgs(['--no-reduce', '小说作品', '--author', '青崖']);
  assert.equal(b.args['no-reduce'], true);
  assert.equal(b.root, '小说作品', '布尔开关不得被当成位置参数');

  const c = parseArgs(['小说作品', '--dry-run', '--author', '白石']);
  assert.equal(c.args['dry-run'], true);
  assert.equal(c.args.author, '白石');
});

test('取值开关：吃掉取值、缺取值要能被调用方识别（不静默退化为默认值）', () => {
  const a = parseArgs(['小说作品', '--author', '白石', '--concurrency', '5', '--max-items', '110']);
  assert.equal(a.args.concurrency, '5');
  assert.equal(a.args['max-items'], '110');
  assert.equal(a.root, '小说作品');
  assert.equal(a.flagsWithoutValue.size, 0);

  const missing = parseArgs(['小说作品', '--author']);
  assert.equal(missing.flagsWithoutValue.has('author'), true, '末尾缺取值 → 调用方须拒绝执行');

  const nextIsFlag = parseArgs(['小说作品', '--limit', '--concurrency', '5']);
  assert.equal(nextIsFlag.flagsWithoutValue.has('limit'), true);
  assert.equal(nextIsFlag.args.limit, undefined);
  assert.equal(nextIsFlag.args.concurrency, '5', '后面的开关仍要正常解析');
  assert.equal(nextIsFlag.root, '小说作品');
});

test('语料根：不得被某个开关的取值顶掉（旧实现取「第一个不以 -- 开头」）', () => {
  // 旧实现：rest.find(a => !a.startsWith('--')) → `--author 白石 小说作品` 会把「白石」当语料根，
  // 报错信息变成「语料里没有 <白石 下面的路径> 的文件」，排障时极易误判为语料缺失。
  const a = parseArgs(['--author', '白石', '小说作品', '--dry-run']);
  assert.equal(a.root, '小说作品', '开关的取值不能被当成语料根');

  const noRoot = parseArgs(['--author', '白石', '--dry-run']);
  assert.equal(noRoot.root, undefined, '没有位置参数时应为 undefined（调用方打印用法并退出）');
});

test('l3 的实际调用形态：--timeout 与 --no-reduce 能同时生效', () => {
  const a = parseArgs(['data/corpus/clean/小说作品', '--author', '青崖', '--provider', 'agnes',
    '--concurrency', '10', '--timeout', '900000', '--no-reduce']);
  assert.equal(a.root, 'data/corpus/clean/小说作品');
  assert.equal(a.args.timeout, '900000');
  assert.equal(a.args['no-reduce'], true);
  assert.equal(a.args.provider, 'agnes');
});
