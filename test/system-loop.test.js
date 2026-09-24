// S6-01 确定性闭环（07-阶段六-整体验收.md §S6-01）：
//   合成书（至少两卷、重复展示章号、旧章选中状态）→ 完整动作链一轮一轮地跑：
//   定位正确范围 → 读取最新允许前文 → 创建下一章 → 确认 → 写入 → 确认 → 重读实际库
//   → 生成总结 → 定稿/索引 → 提案审阅 → 下一轮。
//   写作面走 /api/books/:id/chat/stream 与确认/续跑路由；Agent 面走 /api/agent/chat 与
//   confirm/resume 路由——不直调内部函数替代全链；断言侧直接读库/读磁盘（「重读实际库」本身）。
//   上游模型一律 fetch 边界剧本（helpers/llm-stub），零真实渠道调用。
//
// 长跑驱动（十组 × 十次 = 100 轮）在 tools/system-acceptance.cjs，不进默认 npm test。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  openSystem,
  seedSyntheticBook,
  createAgentConversation,
  runLoopRound,
  makeInvariants,
  chapterRow,
  dbCount,
  db,
} = require('./helpers/system-harness');

// 五条安全不变量：直接断言（不是「打印看看」）——任一非 0 即本轮失败
function assertSafetyInvariants(inv, where) {
  assert.equal(inv.unauthorizedWrites, 0, `${where}：出现未授权写入 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.duplicateAppliedActions, 0, `${where}：出现重复生效 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.crossConversationLeaks, 0, `${where}：出现跨会话泄漏 ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.falseDurableSuccesses, 0, `${where}：出现假保存/假 durable ${JSON.stringify(inv.evidence)}`);
  assert.equal(inv.activeRunsAfterCleanup, 0, `${where}：清理后仍有活跃运行 ${JSON.stringify(inv.evidence)}`);
}

test('S6-01 确定性闭环：合成书两卷同号章 + 旧章选中 → 三轮完整动作链全绿', async (t) => {
  const ctx = await openSystem({ label: 's6-01-loop' });
  t.after(() => ctx.dispose());
  const inv = makeInvariants();
  const book = await seedSyntheticBook(ctx, { title: 'S6-01 闭环合成书' });
  const conversation = await createAgentConversation(ctx, {
    scope: 'book', bookId: book.bookId, title: 'S6-01 闭环会话',
  });

  // 合成书形态（不是造字符串，是服务端真实分配的目录序号）
  assert.equal(book.volumes.length, 2, '合成书至少两卷');
  const directory = await (await fetch(`${ctx.http.baseUrl}/api/books/${book.bookId}/chapters`)).json();
  const ordinals = directory.chapters.map(c => `${c.volume_id}:${c.chapter_ordinal}`);
  assert.equal(new Set(ordinals).size, ordinals.length, '卷内序号唯一（无重复位置）');
  assert.equal(new Set(ordinals.map(o => o.split(':')[1])).size < ordinals.length, true,
    '存在重复展示章号（两卷各自从第1章起算）');
  assert.notEqual(book.selected.id, book.latest.id, '选中章是旧章而不是最新章');

  const rounds = [];
  for (const seed of [1, 2, 3]) {
    const record = await runLoopRound(ctx, { seed, book, conversation, inv });
    rounds.push(record);
    // 每轮记录：种子 / 场景 / runId / 前后 revision / 模型请求次数 / 执行次数 / 持久化结果
    assert.ok(record.seed === seed && record.scenario === 'deterministic-loop');
    assert.ok(record.runId, `种子 ${seed}：本轮应有真实 runId`);
    assert.ok(record.revisionAfter > record.revisionBefore, `种子 ${seed}：revision 必须前进`);
    assert.ok(record.llmRequests >= 8 && record.llmRequests <= 16, `种子 ${seed}：模型请求次数应在预算内，实测 ${record.llmRequests}`);
    assert.ok(record.executions >= 5, `种子 ${seed}：真实工具执行应有下限，实测 ${record.executions}`);
    assert.equal(record.notices.length, 0, `种子 ${seed}：剧本步数应与实际请求一致，实际 ${JSON.stringify(record.notices)}`);
    assert.equal(record.persisted.chapterOnDisk, record.persisted.chapterInDb, `种子 ${seed}：磁盘与内存必须一致`);
    assert.equal(record.persisted.rereadContentMatches, true, `种子 ${seed}：重读实际库必须与写入一致`);

    // 动作链逐项（全部经真实路由产生，断言直接读库/读文件）
    assert.equal(record.checks.resolveIdMatchesSelected, true, `种子 ${seed}：定位必须返回选中旧章的真实 id`);
    assert.equal(record.checks.resolveIdIsRealChapter, true, `种子 ${seed}：定位 id 必须在库里存在`);
    assert.equal(record.checks.readHasTargetSentinel, true, `种子 ${seed}：读取结果应含目标章正文`);
    assert.equal(record.checks.readExcludesFutureSentinels, true, `种子 ${seed}：读取不得混入未来章节正文`);
    assert.equal(record.checks.pendingDidNotCreate, true, `种子 ${seed}：待确认期间不得已建章`);
    assert.equal(record.checks.createdVolumeMatchesSelection, true, `种子 ${seed}：新章必须落在选中卷`);
    assert.equal(record.checks.createdOrdinalSequential, true, `种子 ${seed}：新章目录序号应顺序递增`);
    assert.equal(record.checks.createdSortOrderUnique, true, `种子 ${seed}：卷内排序必须唯一`);
    assert.equal(record.checks.volumeSortOrdersUnique, true, `种子 ${seed}：卷内 sort_order 不得重复`);
    assert.equal(record.checks.otherVolumeUntouched, true, `种子 ${seed}：未选中的卷不得被写入`);
    assert.equal(record.checks.writeLandedBeforeConfirmOnlyAfter, true, `种子 ${seed}：确认前不得有正文`);
    assert.equal(record.checks.writeContentExact, true, `种子 ${seed}：写入正文必须逐字相同`);
    assert.equal(record.checks.writeRevisionAdvanced, true, `种子 ${seed}：写入后 revision 必须 +1`);
    assert.equal(record.checks.rereadMatches, true, `种子 ${seed}：重读实际库必须一致`);
    assert.equal(record.checks.summaryCommitted, true, `种子 ${seed}：总结必须落库`);
    assert.equal(record.checks.summaryRevisionRecorded, true, `种子 ${seed}：总结提交必须记录来源版本`);
    assert.equal(record.checks.summaryFingerprintPresent, true, `种子 ${seed}：总结必须记录来源指纹`);
    assert.equal(record.checks.driftVerdict, 'ok', `种子 ${seed}：有大纲时偏离检查应有有效判定`);
    assert.equal(record.checks.locked, true, `种子 ${seed}：定稿必须真实生效`);
    assert.equal(record.checks.indexed, true, `种子 ${seed}：定稿后应真实建立向量索引`);
    assert.equal(record.checks.lockResumedTerminal, true, `种子 ${seed}：定稿确认后续跑应可完成`);
    assert.equal(record.checks.proposalListedBeforeReview, true, `种子 ${seed}：审阅前必须能列出待审提案`);
    assert.equal(record.checks.reviewWroteCanonical, true, `种子 ${seed}：采纳提案必须写入正典一次`);
    assert.equal(record.checks.proposalStatus, 'accepted', `种子 ${seed}：提案状态应为已采纳`);
    assert.equal(record.checks.reviewResumeStatus, 200, `种子 ${seed}：提案确认后续跑应可完成`);

    assertSafetyInvariants(inv, `闭环种子 ${seed}`);
  }

  // 下一轮仍然成立：前几轮建的新章在后续轮里仍是既有章节（真实目录序号、不串卷）
  assert.equal(dbCount('story_events'), 3, '三轮各采纳一条提案 → 正典事件恰 3 条');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM chat_actions WHERE status = 'pending'").n, 0, '收口后不得残留待确认卡');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").n, 0, '收口后不得残留运行中运行');
});

test('S6-01 重复展示章号：不加卷限定引用必须拒绝，消歧后才给真实 id', async (t) => {
  const ctx = await openSystem({ label: 's6-01-ambiguous' });
  t.after(() => ctx.dispose());
  const book = await seedSyntheticBook(ctx, { title: 'S6-01 同号章合成书' });
  const chaptersBefore = dbCount('chapters', 'WHERE book_id = ?', [book.bookId]);
  const callsBefore = ctx.stub.calls.length;
  const res = await fetch(`${ctx.http.baseUrl}/api/books/${book.bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '按第2章正文继续', chapterId: book.selected.id, request_id: 's6-01-ambiguous' }),
  });
  const text = await res.text();
  // 写作面在上下文装配期把歧义作为 SSE error 事件推送（HTTP 头已发出→200）；Agent 面前置校验回 400。
  // 两条路径的共同契约是「冲突可见 + 不猜章 + 不落任何写入」。
  assert.ok(text.includes('章节位置不唯一'),
    `两卷同号章的不限定引用必须给出可读冲突（位置不唯一），实际 ${res.status} / ${text.slice(0, 160)}`);
  assert.equal(ctx.stub.calls.length, callsBefore, '拒绝必须发生在模型调用之前（不白烧一轮）');
  assert.equal(dbCount('chapters', 'WHERE book_id = ?', [book.bookId]), chaptersBefore, '拒绝路径不得产生任何写入');
});
