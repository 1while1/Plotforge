#!/usr/bin/env node
// S6-01 长跑驱动：故障矩阵十组 × 每组十次 = 100 轮确定性闭环（不进默认 npm test）。
//
// 用法：node tools/system-acceptance.cjs [选项]
//   --evidence-dir=<dir>   证据目录（默认 C:/tmp/moyan-s6/s601-acceptance）
//   --groups=1-10          只跑指定组（默认 1-10）
//   --seeds=10             每组轮数（默认 10，即 100 轮）
//   --port=3166            第 10 组隔离进程起始端口（占用则顺延，记录实测端口）
//
// 纪律（07-阶段六 §S6-01）：
//   · 每轮记录：种子 / 场景 / 组 / runId / 前后 revision / 模型请求次数 / 执行次数 / 持久化结果；
//   · 失败不改累计分母：失败轮原样记入证据目录并立即停止（该矩阵 NO-GO），后续轮不跑、不剔除；
//   · 五条安全不变量直接断言（下方 assert.equal 字面量），任一非 0 即该轮失败；
//   · 上游模型一律本机 fetch 剧本/本机 stub（组 1~9 进程内剧本，组 10 子进程上游指向本机 stub），
//     零真实渠道调用；模型配置为占位值（sk-test-xxx）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../test/helpers/system-harness');

function parseArgs(argv) {
  const opts = { evidenceDir: 'C:/tmp/moyan-s6/s601-acceptance', groups: null, seeds: 10, port: 3166 };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'evidence-dir' && value) opts.evidenceDir = value;
    if (key === 'seeds' && value) opts.seeds = Math.max(1, Number(value) || 10);
    if (key === 'port' && value) opts.port = Number(value) || 3166;
    if (key === 'groups' && value) {
      const match = /^(\d+)-(\d+)$/.exec(value);
      opts.groups = match
        ? Array.from({ length: Number(match[2]) - Number(match[1]) + 1 }, (_, i) => Number(match[1]) + i)
        : value.split(',').map(Number);
    }
  }
  if (!opts.groups) opts.groups = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return opts;
}

// 判据：requiredChecks 全真 + 五条不变量全 0（与测试文件同一份语义，但驱动里不抛——失败要留证据）
function judgeRecord(record) {
  const failures = [];
  const checks = record.checks || {};
  for (const name of record.requiredChecks || []) {
    if (checks[name] !== true) failures.push(`判据未满足：${name}（实测 ${JSON.stringify(checks[name])}）`);
  }
  for (const key of ['unauthorizedWrites', 'duplicateAppliedActions', 'crossConversationLeaks',
    'falseDurableSuccesses', 'activeRunsAfterCleanup']) {
    const value = (record.invariants || {})[key];
    if (value !== 0) failures.push(`安全不变量非 0：${key}=${JSON.stringify(value)}`);
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(opts.evidenceDir, { recursive: true });
  const roundsFile = path.join(opts.evidenceDir, 'rounds.jsonl');
  fs.writeFileSync(roundsFile, '');
  const summary = {
    node: process.version,
    startedAt: new Date().toISOString(),
    evidenceDir: opts.evidenceDir,
    plannedRounds: opts.groups.length * opts.seeds,
    attempted: 0,
    passed: 0,
    failed: 0,
    groups: {},
    totals: { llmRequests: 0, executions: 0 },
    invariants: { unauthorizedWrites: 0, duplicateAppliedActions: 0, crossConversationLeaks: 0, falseDurableSuccesses: 0, activeRunsAfterCleanup: 0 },
  };
  const recordRound = (record) => {
    fs.appendFileSync(roundsFile, `${JSON.stringify(record)}\n`);
    summary.totals.llmRequests += record.llmRequests || 0;
    summary.totals.executions += record.executions || 0;
    for (const key of Object.keys(summary.invariants)) summary.invariants[key] += (record.invariants || {})[key] || 0;
  };

  console.log(`[S6-01] 长跑开始：组 ${opts.groups.join(',')} × ${opts.seeds} 轮 = ${summary.plannedRounds} 轮`);
  console.log(`[S6-01] 证据目录：${opts.evidenceDir}（rounds.jsonl 每轮一行）`);

  const inProcessGroups = opts.groups.filter(g => g <= 9);
  let ctx = null;
  try {
    if (inProcessGroups.length) {
      ctx = await H.openSystem({ label: 's6-01-acceptance' });
      const diskFault = H.installDiskFault(ctx.filePath);
      const book = await H.seedSyntheticBook(ctx, { title: 'S6-01 长跑合成书' });
      const conversation = await H.createAgentConversation(ctx, {
        scope: 'book', bookId: book.bookId, title: 'S6-01 长跑会话',
      });
      for (const group of inProcessGroups) {
        summary.groups[group] = { name: H.FAULT_GROUPS.find(g => g.group === group).name, attempted: 0, passed: 0, failed: 0 };
        const inv = H.makeInvariants();
        for (let seed = 1; seed <= opts.seeds; seed += 1) {
          const roundSeed = group * 100 + seed;
          summary.attempted += 1;
          summary.groups[group].attempted += 1;
          const t0 = Date.now();
          let record = null;
          let error = null;
          try {
            record = await H.runFaultRound(ctx, group, roundSeed, { book, conversation: conversation, inv, diskFault });
          } catch (err) {
            error = err;
          }
          const durationMs = Date.now() - t0;
          if (record) {
            record.durationMs = durationMs;
            recordRound(record);
          }
          const verdict = record ? judgeRecord(record) : { ok: false, failures: [`轮次抛错：${error && error.message}`] };
          if (!verdict.ok) {
            summary.failed += 1;
            summary.groups[group].failed += 1;
            const failure = {
              group, seed: roundSeed, durationMs, failures: verdict.failures,
              record, errorStack: error ? String(error.stack || error) : null,
              invariants: inv, endedAt: new Date().toISOString(),
            };
            fs.writeFileSync(path.join(opts.evidenceDir, `failure-g${group}-s${roundSeed}.json`), JSON.stringify(failure, null, 1));
            fs.writeFileSync(path.join(opts.evidenceDir, 'summary.json'), JSON.stringify({ ...summary, stoppedAt: new Date().toISOString(), stopReason: 'round_failed' }, null, 1));
            console.error(`[S6-01] 组 ${group} 种子 ${roundSeed} 失败（矩阵 NO-GO，停止；分母保持 ${summary.plannedRounds}）：`);
            for (const line of verdict.failures) console.error(`  - ${line}`);
            console.error(`  证据：${path.join(opts.evidenceDir, `failure-g${group}-s${roundSeed}.json`)}`);
            process.exitCode = 1;
            return;
          }
          summary.passed += 1;
          summary.groups[group].passed += 1;
          console.log(`[S6-01] 组 ${group}（${summary.groups[group].name}）种子 ${roundSeed} 通过`
            + `｜llm=${record.llmRequests} 执行=${record.executions} 用时=${durationMs}ms`
            + `｜不变量=${JSON.stringify(record.invariants)}`);
        }
      }
      diskFault.uninstall();
    }

    if (opts.groups.includes(10)) {
      summary.groups[10] = { name: '隔离进程重启/恢复', attempted: 0, passed: 0, failed: 0, ports: [] };
      for (let seed = 1; seed <= opts.seeds; seed += 1) {
        const roundSeed = 1000 + seed;
        const port = H.pickPort(opts.port);
        summary.attempted += 1;
        summary.groups[10].attempted += 1;
        summary.groups[10].ports.push(port);
        const t0 = Date.now();
        let record = null;
        let error = null;
        try {
          record = await H.runRestartRound({ seed: roundSeed, port, workDir: H.restartWorkDir() });
        } catch (err) {
          error = err;
        }
        const durationMs = Date.now() - t0;
        if (record) {
          record.durationMs = durationMs;
          record.port = port;
          recordRound(record);
        }
        const verdict = record ? judgeRecord(record) : { ok: false, failures: [`轮次抛错：${error && error.message}`] };
        if (!verdict.ok) {
          summary.failed += 1;
          summary.groups[10].failed += 1;
          const failure = {
            group: 10, seed: roundSeed, port, durationMs, failures: verdict.failures,
            record, errorStack: error ? String(error.stack || error) : null,
            endedAt: new Date().toISOString(),
          };
          fs.writeFileSync(path.join(opts.evidenceDir, `failure-g10-s${roundSeed}.json`), JSON.stringify(failure, null, 1));
          fs.writeFileSync(path.join(opts.evidenceDir, 'summary.json'), JSON.stringify({ ...summary, stoppedAt: new Date().toISOString(), stopReason: 'round_failed' }, null, 1));
          console.error(`[S6-01] 组 10 种子 ${roundSeed}（端口 ${port}）失败（矩阵 NO-GO，停止）：`);
          for (const line of verdict.failures) console.error(`  - ${line}`);
          process.exitCode = 1;
          return;
        }
        summary.passed += 1;
        summary.groups[10].passed += 1;
        console.log(`[S6-01] 组 10（隔离进程重启/恢复）种子 ${roundSeed} 通过｜端口 ${port}`
          + `｜pid ${record.firstPid}→${record.secondPid}｜用时=${durationMs}ms`);
      }
    }
  } finally {
    if (ctx) await ctx.dispose();
  }

  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(opts.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log('\n[S6-01] 汇总：'
    + `${summary.passed}/${summary.plannedRounds} 轮通过（失败 ${summary.failed}；分母固定为计划轮数，失败不改分母）`);
  for (const [group, info] of Object.entries(summary.groups)) {
    console.log(`  组 ${group} ${info.name}：${info.passed}/${info.attempted}`);
  }
  console.log(`[S6-01] 模型请求合计=${summary.totals.llmRequests}，真实工具执行合计=${summary.totals.executions}`);
  console.log(`[S6-01] 安全不变量合计=${JSON.stringify(summary.invariants)}`);
  console.log(`[S6-01] 证据：${roundsFile} / summary.json`);

  // 五条安全不变量：长跑末尾再直接断言一次（全 0 才允许退出码 0）
  assert.equal(summary.invariants.unauthorizedWrites, 0);
  assert.equal(summary.invariants.duplicateAppliedActions, 0);
  assert.equal(summary.invariants.crossConversationLeaks, 0);
  assert.equal(summary.invariants.falseDurableSuccesses, 0);
  assert.equal(summary.invariants.activeRunsAfterCleanup, 0);
}

main().catch((err) => {
  console.error('[S6-01] 驱动异常：', err && err.stack || err);
  process.exitCode = 1;
});
