// S6-01 故障矩阵（07-阶段六-整体验收.md §S6-01 的十组，每组真实注入）：
//   1 正常与多卷同号章｜2 重复 confirm/resume/requestId｜3 拒绝与错误会话凭证｜4 双标签页/两入口同书写
//   5 保存期间输入/失败离开｜6 磁盘失败与恢复｜7 断连/取消/无事件超时｜8 length/空输出/429/5xx
//   9 正文变更与异步总结/向量｜10 隔离进程重启/恢复
// 每轮记录种子/场景/runId/前后 revision/模型请求次数/执行次数/持久化结果；失败不改累计分母
// （单轮失败即断言失败，绝不把该轮从统计里剔除）。本文件跑每组 1~2 个确定性种子；
// 十组 × 十次的长跑在 tools/system-acceptance.cjs（不进默认 npm test）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  openSystem,
  seedSyntheticBook,
  createAgentConversation,
  runFaultRound,
  installDiskFault,
  makeInvariants,
  pickPort,
  restartWorkDir,
  runRestartRound,
  db,
} = require('./helpers/system-harness');

// 五条安全不变量：直接断言（任一非 0 即本轮失败）
function assertSafetyInvariants(inv, where) {
  assert.equal(inv.unauthorizedWrites, 0, `${where}：出现未授权写入 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.duplicateAppliedActions, 0, `${where}：出现重复生效 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.crossConversationLeaks, 0, `${where}：出现跨会话泄漏 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.falseDurableSuccesses, 0, `${where}：出现假保存/假 durable ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.activeRunsAfterCleanup, 0, `${where}：清理后仍有活跃运行 ${JSON.stringify(inv.evidence)}`);
}

// 组内公共夹具：同一套合成书 + 会话，跑若干确定性种子，逐项断言 checks 全真
function makeGroupRunner(group, seeds, extraChecks = []) {
  return async (t) => {
    const ctx = await openSystem({ label: `s6-01-fault-g${group}` });
    t.after(() => ctx.dispose());
    const diskFault = installDiskFault(ctx.filePath);
    t.after(() => diskFault.uninstall());
    const book = await seedSyntheticBook(ctx, { title: `S6-01 故障组 ${group} 合成书` });
    const conversation = await createAgentConversation(ctx, {
      scope: 'book', bookId: book.bookId, title: `S6-01 故障组 ${group} 会话`,
    });
    const inv = makeInvariants();
    const records = [];
    for (const seed of seeds) {
      const record = await runFaultRound(ctx, group, seed, { book, conversation, inv, diskFault });
      records.push(record);
      assert.ok(Array.isArray(record.requiredChecks) && record.requiredChecks.length > 0,
        `组 ${group} 种子 ${seed}：必须有判据清单`);
      for (const name of [...record.requiredChecks, ...extraChecks]) {
        assert.equal(record.checks[name], true,
          `组 ${group} 种子 ${seed}：${name} 未满足（实测 ${JSON.stringify(record.checks[name])}）`);
      }
      assert.ok(record.llmRequests >= 0 && record.llmRequests <= 12,
        `组 ${group} 种子 ${seed}：模型请求次数应在有限预算内，实测 ${record.llmRequests}`);
      assert.equal(record.invariants.activeRunsAfterCleanup, 0, `组 ${group} 种子 ${seed}：本轮收口必须无活跃运行`);
      assertSafetyInvariants(inv, `故障组 ${group} 种子 ${seed}`);
      // 每组收口后：不得残留待确认卡与运行中运行（否则下一轮的前提就被污染）
      assert.equal(db.get("SELECT COUNT(*) AS n FROM chat_actions WHERE status = 'pending'").n, 0,
        `组 ${group} 种子 ${seed}：收口后不得残留待确认卡`);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").n, 0,
        `组 ${group} 种子 ${seed}：收口后不得残留运行中运行`);
    }
    assert.equal(records.length, seeds.length, '全部轮次都跑了（失败不减少分母——不这样做测试会提前抛）');
  };
}

test('组 1：正常与多卷同号章（真实 id、唯一顺序、正文正确）', makeGroupRunner(1, [11, 12]));
test('组 2：重复 confirm/resume/requestId（执行次数不增加，运行唯一）', makeGroupRunner(2, [21, 22]));
test('组 3：拒绝与错误会话凭证（无未授权写入，拒绝后不暗重试）', makeGroupRunner(3, [31, 32]));
test('组 4：双标签页/两入口同书写（冲突可见，无静默覆盖）', makeGroupRunner(4, [41, 42]));
test('组 5：保存期间输入/失败离开（新稿保留，目标不串）', makeGroupRunner(5, [51, 52]));
test('组 6：磁盘失败与恢复（不假成功，恢复可落盘，不重放业务）', makeGroupRunner(6, [61, 62]));
test('组 7：断连/取消/无事件超时（后续工具停止，锁释放，已生效结果可查）', makeGroupRunner(7, [71, 72]));
test('组 8：length/空输出/429/5xx（有限重试，正确终态，不误报完成）', makeGroupRunner(8, [81, 82]));
test('组 9：正文变更与异步总结/向量（旧结果不可作为新章有效资料）', makeGroupRunner(9, [91, 92]));

// 组 10 单列：真实子进程（server/index.js）同库同端口重启，不是进程内模拟
test('组 10：隔离进程重启/恢复（会话证据、动作中断、版本与卡绑定准确）', async () => {
  const port = pickPort(3166);
  const record = await runRestartRound({ seed: 101, port, workDir: restartWorkDir() });
  for (const name of record.requiredChecks) {
    assert.equal(record.checks[name], true, `组 10：${name} 未满足（实测 ${JSON.stringify(record.checks[name])}）`);
  }
  assert.equal(record.checks.inflightRunStatusBeforeKill, 'running', '杀进程前该运行必须真的在途');
  assert.equal(record.checks.inflightInterrupted, true, '硬杀重启后未结算运行必须标记 interrupted');
  assert.equal(record.checks.inflightReason, 'server_restart', 'interrupted 必须带可解释原因');
  assert.equal(record.checks.replayDuplicate, true, '同 request_id 重发必须返回既有运行（不自动再执行）');
  assert.equal(record.checks.replayNoNewUpstreamCall, true, '重发不得再调上游模型');
  assert.equal(record.checks.killedHard, true, '杀进程前必须核对过命令行属于本轮的 server/index.js');
  // 五条安全不变量：子进程轮同样直接断言（数值由库/接口证据算出，见 harness 的 counters）
  assert.equal(record.invariants.unauthorizedWrites, 0,
    `组 10：出现未授权写入（appliedCards=${record.counters.appliedCards} 残留锁=${record.counters.lockedAfterRestart}）`);
  assert.equal(record.invariants.duplicateAppliedActions, 0,
    `组 10：出现重复生效（同 request_id 运行行=${record.counters.runRowsForRequest} 重发后上游调用=${record.counters.upstreamCallsAfterReplay}）`);
  assert.equal(record.invariants.crossConversationLeaks, 0,
    `组 10：出现跨会话泄漏（错会话确认=${record.checks.cardWrongConversation403} 卡绑定会话正确=${record.counters.cardConversationMatches}）`);
  assert.equal(record.invariants.falseDurableSuccesses, 0,
    '组 10：重启后出现假 durable（宣称已保存的正文/版本/会话证据必须挺过硬杀）');
  assert.equal(record.invariants.activeRunsAfterCleanup, 0,
    `组 10：重启后仍有活跃运行（running=${record.counters.runningRows} 锁=${record.counters.lockedAfterRestart} 在途未标记中断=${record.checks.inflightInterrupted !== true}）`);
  // 故意保留的产物：待确认卡仍在且未被自动执行（这是设计，不计入 activeRunsAfterCleanup）
  assert.equal(record.counters.pendingCards, 1, '重启后应保留 1 张待确认卡（作者尚未确认）');
  assert.equal(record.counters.cardConversationMatches, true, '待确认卡必须仍绑定原会话（重启不串会话）');
});
