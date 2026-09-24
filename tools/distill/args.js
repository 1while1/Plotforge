'use strict';
/**
 * CLI 参数解析（tools/distill.js 专用，抽出来是为了可单测）。
 *
 * 为什么要单独一个模块：这段解析出过一次**静默做反**的缺陷——
 * `--dry-run` 写在命令末尾时后面没有取值，旧实现给出 `args['dry-run'] = undefined`，
 * 而调用处写的是 `write: !args['dry-run']` → `!undefined === true` → **照样写库**；
 * `--no-reduce` 同理（想只看闸门，实际照样跑 reduce 计费）。这类缺陷不会报错、
 * 只在「输出与预期相反」时被察觉，所以必须有钉住语义的单测。
 *
 * 约定：
 *   - 布尔开关（`BOOL_FLAGS`）**不吞下一个参数**，命中即为 `true`；
 *   - 取值开关 `--name value`；若后面没有取值或直接跟了另一个 `--开关`，记入 `flagsWithoutValue`
 *     （调用方据此拒绝执行，而不是静默退化为默认行为）；
 *   - 位置参数取**第一个非开关、且不是任何开关取值**的 token 作为语料根
 *     （旧实现取「第一个不以 -- 开头」→ `--author 白石 <根>` 会把「白石」当语料根）。
 */
const BOOL_FLAGS = new Set(['dry-run', 'no-reduce']);

function parseArgs(rest) {
  const args = {};
  const flagsWithoutValue = new Set();
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = String(rest[i]);
    if (!tok.startsWith('--')) { positionals.push(tok); continue; }
    const name = tok.slice(2);
    if (BOOL_FLAGS.has(name)) { args[name] = true; continue; }
    const next = rest[i + 1];
    if (next === undefined || String(next).startsWith('--')) {
      flagsWithoutValue.add(name);
      args[name] = undefined;
      continue;
    }
    args[name] = next;
    i++;   // 取值已被这个开关消费，不能再当位置参数（语料根）
  }
  return { args: args, flagsWithoutValue: flagsWithoutValue, root: positionals[0] };
}

module.exports = { BOOL_FLAGS, parseArgs };
