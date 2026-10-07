// R1（G6 审计 P2-1 ＝ S6-04 的 D1）：确认卡结算后运行行必须离开 awaiting_confirmation。
//   契约 01 §3.1：awaiting_confirmation 在 action 结算后标为 paused/action_settled（拒绝为 action_rejected）。
//   根因（G6-独立审查 §10 独立复现，探针 系统临时证据目录）：
//   结算路径只改 chat_actions 的状态，agent_runs 行留在 awaiting_confirmation；
//   conversations/compression.js 与 conversations/service.js 又无条件把它计为活跃运行 →
//   受影响会话永久 409 CONVERSATION_ACTIVE_RUN，不能再压缩/归档。
//   本文件按任务卡四组断言（业务行为表达，不 import 崩溃冒充红测）：
//     ①（i）写作链路 approve/reject 结算后运行行转终态，压缩与归档不再 409；
//     ②（ii）预置存量滞留行（卡片已全部结算）时压缩/归档不再 409 —— 读侧解滞留，
//       不依赖迁移/回填，能治真实库里已有的滞留行；
//     ③（iii）对照组：awaiting_confirmation 且自身卡仍 pending（或 executing）→ 仍须阻塞（防修过头）；
//     ④ 一个运行行多张卡：只在最后一张未结算卡落定时转终态（不提前转）；
//     ⑤ Agent 台确认（REST 另一入口）与 ⑥ 结算的其他出口（超时 sweep、回收恢复过期）同属
//       「使卡离开 pending」的路径，一并钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/system-harness');
const { db } = require('./helpers/temp-db');
const actionStore = require('../server/actionStore');
const conversationSvc = require('../server/conversations/service');

function runRow(runId) {
  return db.get('SELECT id, status, reason FROM agent_runs WHERE id = ?', [String(runId)]);
}

function seedRunRow({ id, conversationId, status, sessionKey }) {
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, mode, status, created_at)
     VALUES (?, ?, ?, ?, 'chat', 'write', ?, ?)`,
    [id, `req-${id}`, sessionKey, conversationId, status, new Date().toISOString()]
  );
}

// 直接落一张确认卡（与 S6-02 交接用例同口径）：status/run_id/expires_at 由调用方指定。
function seedCardRow({ id, bookId, sessionKey, status, runId = null, args = {}, expiresInMs = 600000 }) {
  const now = Date.now();
  db.run(
    `INSERT INTO chat_actions (id, book_id, name, args_json, args_hash, session_id, tool_call_id,
       requested_by, status, summary, impact_json, created_at, expires_at, run_id)
     VALUES (?, ?, 'create_chapter', ?, ?, ?, '', 'agent', ?, '新建章节', '["write"]', ?, ?, ?)`,
    [id, Number(bookId), JSON.stringify(args), `hash-${id}`, sessionKey, status,
      now, now + expiresInMs, runId]
  );
}

function seedMessages(conversationId, count = 6) {
  for (let i = 1; i <= count; i++) {
    conversationSvc.appendMessage({
      conversationId, role: i % 2 ? 'user' : 'assistant',
      content: `第${i}轮：${'结算后压缩材料'.repeat(30)}`, source: 'writing',
    });
  }
}

// 摘要调用走非流式 chat.completions —— 剧本给一步纯文本响应。
function scriptedSummary(ctx, text = '【已确认的资料与设定】…\n【已执行的动作与结果】…\n【未决问题】…\n【作者尚未采纳的设想】…') {
  return H.beginScript(ctx, [H.step.textJson(text)]);
}

test('① 写作链路批准结算：运行行转 paused/action_settled，压缩与归档不再 409', async t => {
  const ctx = await H.openSystem({ label: 'r1-approve' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 结算终态化（批准）' });
  const convId = `legacy-writing-${book.bookId}`;

  const script = H.beginScript(ctx, [
    H.step.tools([{ id: 'r1-new', name: 'create_chapter', args: { volumeId: book.selected.volume_id, title: '结算后终态化新章' } }]),
  ]);
  const streamed = await H.writingStream(ctx, book.bookId, {
    content: '请新建一章', chapterId: book.selected.id, request_id: 'r1-approve-1',
  });
  const used = script.finish();
  assert.equal(used.unusedScriptSteps, 0, '剧本必须全部消费（不靠 sleep 猜时序）');
  const actionId = H.writingActionId(streamed.events);
  assert.ok(actionId, '写作链路应产生确认卡（前置条件）');

  const before = db.get('SELECT id, status FROM agent_runs WHERE conversation_id = ?', [convId]);
  assert.equal(before.status, 'awaiting_confirmation', '卡片发出后运行行停在等待确认（前置事实，非缺陷本身）');

  const confirmed = await H.confirmWritingAction(ctx, book.bookId, actionId, { approve: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'approved');

  const settled = runRow(before.id);
  assert.equal(settled.status, 'paused',
    `G6 P2-1 根因：结算后运行行必须离开 awaiting_confirmation（实测 ${JSON.stringify(settled)}）`);
  assert.equal(settled.reason, 'action_settled', '契约 3.1：结算后标 paused/action_settled');

  seedMessages(convId);
  const summaryScript = scriptedSummary(ctx);
  const compress = await H.api(ctx, 'POST', `/api/conversations/${convId}/compress`, { targetTokens: 30 });
  summaryScript.finish();
  assert.equal(compress.status, 200,
    `压缩不得再被活跃运行拦（实测 ${compress.status} ${compress.text.slice(0, 200)}）`);
  assert.ok(compress.body && compress.body.summaryId > 0, '压缩应产出摘要');

  const archive = await H.api(ctx, 'POST', `/api/conversations/${convId}/archive`);
  assert.equal(archive.status, 200, `归档应放行（此前 409 CONVERSATION_ACTIVE_RUN；实测 ${archive.status}）`);
});

test('① 写作链路拒绝结算：运行行转 paused/action_rejected，归档不再 409', async t => {
  const ctx = await H.openSystem({ label: 'r1-reject' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 结算终态化（拒绝）' });
  const convId = `legacy-writing-${book.bookId}`;

  const script = H.beginScript(ctx, [
    H.step.tools([{ id: 'r1-new', name: 'create_chapter', args: { volumeId: book.selected.volume_id, title: '被拒的新章' } }]),
  ]);
  const streamed = await H.writingStream(ctx, book.bookId, {
    content: '请新建一章', chapterId: book.selected.id, request_id: 'r1-reject-1',
  });
  script.finish();
  const actionId = H.writingActionId(streamed.events);
  assert.ok(actionId, '写作链路应产生确认卡（前置条件）');
  const before = db.get('SELECT id, status FROM agent_runs WHERE conversation_id = ?', [convId]);
  assert.equal(before.status, 'awaiting_confirmation');

  const rejected = await H.confirmWritingAction(ctx, book.bookId, actionId, { approve: false });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');

  const settled = runRow(before.id);
  assert.equal(settled.status, 'paused',
    `拒绝结算后运行行必须离开 awaiting_confirmation（实测 ${JSON.stringify(settled)}）`);
  assert.equal(settled.reason, 'action_rejected', '契约 3.1：拒绝后标 paused/action_rejected');

  const archive = await H.api(ctx, 'POST', `/api/conversations/${convId}/archive`);
  assert.equal(archive.status, 200, `归档应放行（实测 ${archive.status}）`);
});

test('② 存量滞留行（卡已全结算）不再阻塞压缩/归档；③ 对照组：自身卡 pending 仍阻塞', async t => {
  const ctx = await H.openSystem({ label: 'r1-stranded' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 存量滞留行' });

  // ② 历史滞留现场：运行行停在 awaiting_confirmation，其卡片已全部结算（批准/拒绝）
  const stranded = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '滞留会话' });
  seedMessages(stranded.id);
  seedRunRow({ id: 'run-r1-stranded', conversationId: stranded.id, status: 'awaiting_confirmation', sessionKey: `agent:${stranded.id}` });
  seedCardRow({ id: 'c-r1-stranded-ok', bookId: book.bookId, sessionKey: `agent:${stranded.id}`, status: 'approved', runId: 'run-r1-stranded' });
  seedCardRow({ id: 'c-r1-stranded-no', bookId: book.bookId, sessionKey: `agent:${stranded.id}`, status: 'rejected', runId: 'run-r1-stranded' });

  const strandedSummary = scriptedSummary(ctx);
  const strandedCompress = await H.api(ctx, 'POST', `/api/conversations/${stranded.id}/compress`, { targetTokens: 30 });
  strandedSummary.finish();
  assert.equal(strandedCompress.status, 200,
    `卡已全结算的滞留行不得再阻塞压缩（实测 ${strandedCompress.status} ${strandedCompress.text.slice(0, 200)}）`);
  const strandedArchive = await H.api(ctx, 'POST', `/api/conversations/${stranded.id}/archive`);
  assert.equal(strandedArchive.status, 200, `卡已全结算的滞留行不得再阻塞归档（实测 ${strandedArchive.status}）`);

  // ③ 对照组：awaiting_confirmation 且它自己发起的卡仍 pending → 仍须 409（防修过头）
  const pending = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '等待确认会话' });
  seedMessages(pending.id);
  seedRunRow({ id: 'run-r1-pending', conversationId: pending.id, status: 'awaiting_confirmation', sessionKey: `agent:${pending.id}` });
  seedCardRow({ id: 'c-r1-pending', bookId: book.bookId, sessionKey: `agent:${pending.id}`, status: 'pending', runId: 'run-r1-pending' });

  const pendingCompress = await H.api(ctx, 'POST', `/api/conversations/${pending.id}/compress`, { targetTokens: 30 });
  assert.equal(pendingCompress.status, 409, '仍有未结算卡的会话不得被压缩');
  assert.equal(pendingCompress.body.error.code, 'CONVERSATION_ACTIVE_RUN');
  const pendingArchive = await H.api(ctx, 'POST', `/api/conversations/${pending.id}/archive`);
  assert.equal(pendingArchive.status, 409, '仍有未结算卡的会话不得被归档');
  assert.equal(pendingArchive.body.error.code, 'CONVERSATION_ACTIVE_RUN');
  assert.equal(runRow('run-r1-pending').status, 'awaiting_confirmation', '仍等确认的运行行保持原状');

  // ③b 对照组：同运行行、卡在 executing（执行中，结果未落）同样算未结算
  const executing = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '执行中会话' });
  seedRunRow({ id: 'run-r1-executing', conversationId: executing.id, status: 'awaiting_confirmation', sessionKey: `agent:${executing.id}` });
  seedCardRow({ id: 'c-r1-executing', bookId: book.bookId, sessionKey: `agent:${executing.id}`, status: 'executing', runId: 'run-r1-executing' });
  const executingArchive = await H.api(ctx, 'POST', `/api/conversations/${executing.id}/archive`);
  assert.equal(executingArchive.status, 409, 'executing 卡（结果未落）同样算未结算，仍须阻塞');
  assert.equal(executingArchive.body.error.code, 'CONVERSATION_ACTIVE_RUN');
});

test('④ 一个运行多张卡：只在最后一张未结算卡落定时转终态', async t => {
  const ctx = await H.openSystem({ label: 'r1-multi-card' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 多卡运行' });
  const conv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '多卡会话' });
  seedRunRow({ id: 'run-r1-multi', conversationId: conv.id, status: 'awaiting_confirmation', sessionKey: `agent:${conv.id}` });
  seedCardRow({ id: 'c-r1-multi-1', bookId: book.bookId, sessionKey: `agent:${conv.id}`, status: 'pending', runId: 'run-r1-multi' });
  seedCardRow({ id: 'c-r1-multi-2', bookId: book.bookId, sessionKey: `agent:${conv.id}`, status: 'pending', runId: 'run-r1-multi' });

  actionStore.settle('c-r1-multi-1', 'approved', { ok: true, chapterId: 1 });
  assert.equal(runRow('run-r1-multi').status, 'awaiting_confirmation',
    '第二张卡仍 pending：运行行不得提前转终态（否则会放过一个随时会推进的运行）');
  const archiveMid = await H.api(ctx, 'POST', `/api/conversations/${conv.id}/archive`);
  assert.equal(archiveMid.status, 409, '仍有未结算卡时归档仍须 409');
  assert.equal(archiveMid.body.error.code, 'CONVERSATION_ACTIVE_RUN');

  actionStore.reject('c-r1-multi-2', `agent:${conv.id}`);
  const after = runRow('run-r1-multi');
  assert.equal(after.status, 'paused', `最后一张未结算卡落定后运行行必须转终态（实测 ${JSON.stringify(after)}）`);
  assert.equal(after.reason, 'action_rejected');
  const archiveDone = await H.api(ctx, 'POST', `/api/conversations/${conv.id}/archive`);
  assert.equal(archiveDone.status, 200, '全部卡落定后归档放行');
});

test('⑤ Agent 台确认链路（REST 另一入口）：批准结算后运行行同样终态化', async t => {
  const ctx = await H.openSystem({ label: 'r1-agent-confirm' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 Agent 确认链路' });
  const conv = await H.createAgentConversation(ctx, { scope: 'book', bookId: book.bookId, title: 'Agent 确认会话' });
  const script = H.beginScript(ctx, [
    H.step.tools([{ id: 'r1-agent-new', name: 'create_chapter', args: { book_id: book.bookId, title: 'Agent 建章' } }]),
  ]);
  const stream = await H.agentStream(ctx, {
    conversation_id: conv.id, content: '请新建一章。', mode: 'execute', book_id: book.bookId, request_id: 'r1-agent-1',
  });
  script.finish();
  assert.equal(stream.status, 200, `Agent 流应 200（实测 ${stream.status}）`);
  const envelope = H.agentConfirmationId(stream.parts);
  assert.ok(envelope, 'Agent 台应产生确认卡（前置条件）');
  const before = db.get('SELECT id, status FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', [conv.id]);
  assert.equal(before.status, 'awaiting_confirmation', 'Agent 台卡片发出后运行行停在等待确认');

  const confirmed = await H.confirmAgentAction(ctx, envelope.id, conv.id, { approve: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'approved');
  const after = runRow(before.id);
  assert.equal(after.status, 'paused', `Agent 台结算后运行行必须离开等待确认（实测 ${JSON.stringify(after)}）`);
  assert.equal(after.reason, 'action_settled');
  const archive = await H.api(ctx, 'POST', `/api/conversations/${conv.id}/archive`);
  assert.equal(archive.status, 200, `归档应放行（此前 409 CONVERSATION_ACTIVE_RUN；实测 ${archive.status}）`);
});

test('⑥ 结算的其他出口同样终态化：超时 sweep 与回收恢复过期', async t => {
  const ctx = await H.openSystem({ label: 'r1-other-exits' });
  t.after(() => ctx.dispose());
  const book = await H.seedSyntheticBook(ctx, { title: 'R1 其他结算出口' });

  // ⑤a 超时过期：pending 卡被 sweep 标 expired 时，其运行行一并终态化
  const expiredConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '超时会话' });
  seedRunRow({ id: 'run-r1-expired', conversationId: expiredConv.id, status: 'awaiting_confirmation', sessionKey: `agent:${expiredConv.id}` });
  seedCardRow({
    id: 'c-r1-expired', bookId: book.bookId, sessionKey: `agent:${expiredConv.id}`,
    status: 'pending', runId: 'run-r1-expired', expiresInMs: -60000,
  });
  actionStore.get('c-r1-expired'); // 触发 sweep（惰性清理）
  assert.equal(db.get("SELECT status FROM chat_actions WHERE id = 'c-r1-expired'").status, 'expired', '前置：卡应被标过期');
  const expiredRun = runRow('run-r1-expired');
  assert.equal(expiredRun.status, 'paused', `卡过期后运行行必须离开等待确认（实测 ${JSON.stringify(expiredRun)}）`);
  assert.equal(expiredRun.reason, 'action_settled');
  const expiredArchive = await H.api(ctx, 'POST', `/api/conversations/${expiredConv.id}/archive`);
  assert.equal(expiredArchive.status, 200);

  // ⑤b 恢复回收章时过期该章的 pending 卡（chapterRecycle.expirePendingActionsForChapter）：
  //     运行行同样终态化
  const recycleConv = conversationSvc.createConversation({ kind: 'agent', scope: 'book', bookId: book.bookId, title: '回收恢复会话' });
  seedRunRow({ id: 'run-r1-recycle', conversationId: recycleConv.id, status: 'awaiting_confirmation', sessionKey: `agent:${recycleConv.id}` });
  const deleted = await H.api(ctx, 'DELETE', `/api/books/${book.bookId}/chapters/${book.selected.id}`, { reason: 'r1-test' });
  assert.ok(deleted.status === 200 || deleted.status === 201, `删章应成功（实测 ${deleted.status}）`);
  const bin = await H.api(ctx, 'GET', `/api/books/${book.bookId}/chapter-recycle`);
  assert.equal(bin.status, 200);
  assert.ok(bin.body.items.length >= 1, '回收清单应有刚删除的章');
  seedCardRow({
    id: 'c-r1-recycle', bookId: book.bookId, sessionKey: `agent:${recycleConv.id}`,
    status: 'pending', runId: 'run-r1-recycle', args: { chapterId: book.selected.id, content: '替换正文' },
  });
  const restored = await H.api(ctx, 'POST',
    `/api/books/${book.bookId}/chapter-recycle/${bin.body.items[0].id}/restore`,
    { volume_id: book.selected.volume_id });
  assert.equal(restored.status, 200, `恢复回收章应成功（实测 ${restored.status} ${restored.text.slice(0, 200)}）`);
  assert.equal(db.get("SELECT status FROM chat_actions WHERE id = 'c-r1-recycle'").status, 'expired',
    '前置：恢复回收章时该章的 pending 卡被显式过期');
  const recycleRun = runRow('run-r1-recycle');
  assert.equal(recycleRun.status, 'paused', `卡被过期后运行行必须离开等待确认（实测 ${JSON.stringify(recycleRun)}）`);
  assert.equal(recycleRun.reason, 'action_settled');
  const recycleArchive = await H.api(ctx, 'POST', `/api/conversations/${recycleConv.id}/archive`);
  assert.equal(recycleArchive.status, 200);
});
