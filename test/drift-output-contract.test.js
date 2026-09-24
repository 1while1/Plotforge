// S5-03 / R02：偏离检查空输出契约、受控重试上限与评测口径。
// 事实源：docs/report/20260921_全系统闭环审查/00-系统稳定性结论.md:149-156
// ——原 E2E 记录「[drift] 检查失败: LLM 返回内容为空（可能是 max_tokens 被推理占用，请重试）」，
// 其中「推理吃完预算」只是假设；空输出、截断与 UI 降级协议不能靠枚举修复顶替。
//
// 口径（00 总计划 §6 R02 + 01 契约 §7 派生结果）：
//   1. 空输出（空串/全空白/仅 reasoning/length+空正文）是**上游失败**，不是「无偏离」：
//      status='failed' + code='LLM_EMPTY_OUTPUT'，成功诊断（chapters.drift_status）一律不写。
//   2. 上游证据（finish_reason/usage）原样记录，供报告区分不同成因；没有证据不得给成因定性。
//   3. 无副作用分析只允许**一次**受控重试，唯一变化＝放大分析输出预算（800→1600）；
//      不换模型、不改提示词、不无上限重发；受取消信号与单次分析总时限约束。
//   4. 结果解析失败（坏 JSON/错误枚举）仍走 DRIFT_VERDICT_INVALID，且不重试（既有修复不回滚）。
// 断言全部打在既有入口（REST 两个漂移调用点 + 两个漂移工具 + checkDrift/callLLMFull）上，
// 走 fetch 边界 stub（零真实渠道、不记录任何凭证）+ 临时库；不用 import 缺失冒充红测。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');
const { installFetchStub, jsonStub, chatPayload } = require('./helpers/llm-stub');
const llm = require('../server/llm');
const { executeTool } = require('../server/tools/executor');

const OUTLINE = '主角林一在末日废土寻找净水芯片，一路北上，不会回头。';

// 上游响应载荷构造（非流式 chat/completions）
const emptyBody = (extra = {}) => chatPayload({ content: '', ...extra });
const blankBody = (text) => chatPayload({ content: text, finish: 'stop' });
const verdictBody = (text) => chatPayload({ content: text, finish: 'stop' });
const usageWithReasoning = (reasoningTokens) => ({
  prompt_tokens: 300,
  completion_tokens: 820,
  completion_tokens_details: { reasoning_tokens: reasoningTokens },
});

function driftRows(bookId) {
  return db.all('SELECT id, drift_status, drift_note FROM chapters WHERE book_id = ? ORDER BY id', [bookId]);
}
function savedSuccessfulDriftChecks(bookId) {
  return driftRows(bookId).filter(row => (row.drift_status || '') !== '').length;
}

async function setup(t, { chapters = 1 } = {}) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  t.after(() => { stub.restore(); cleanup(location); });
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['http://llm-stub.local/v1']);
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['sk-test-xxx']);
  db.run("INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['drift-stub-model']);
  const bookId = db.run('INSERT INTO books (title, master_outline) VALUES (?, ?)', ['偏离空输出书', OUTLINE]).lastInsertRowid;
  const volumeId = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const chapterIds = [];
  for (let i = 0; i < chapters; i++) {
    chapterIds.push(db.run(
      "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [bookId, volumeId, `第${i + 1}章`, `第${i + 1}章正文：林一继续北上。`, `第${i + 1}章总结：继续北上。`, i + 1]
    ).lastInsertRowid);
  }
  const http = await listen(createApp());
  t.after(() => http.close());
  return {
    stub, http, bookId, volumeId, chapterIds,
    book: db.get('SELECT * FROM books WHERE id = ?', [bookId]),
    chapter: db.get('SELECT * FROM chapters WHERE id = ?', [chapterIds[0]]),
  };
}

// ---------------- 1. REST 批量偏离检查：空输出 = 显式失败 + 零成功诊断 + 调用 ≤2 ----------------
test('R02 哨兵：length+空正文经批量偏离检查 → failed/LLM_EMPTY_OUTPUT，零成功诊断，调用 ≤2', async t => {
  const { stub, http, bookId, chapterIds } = await setup(t);
  // 第 1 次调用：上游 finish_reason=length 且正文为空（唯一可用的成因证据：reasoning_tokens=780）
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length', usage: usageWithReasoning(780) })));
  // 受控重试（第 2 次调用）：仍是空正文，且这次没有 reasoning 证据
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'stop' })));

  const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/drift-check-all`);
  const emptyOutputResult = r.body.results[0];
  const modelRequestCount = stub.calls.length;
  const savedSuccessfulDriftChecks0 = savedSuccessfulDriftChecks(bookId);

  assert.equal(r.status, 200);
  assert.equal(emptyOutputResult.id, chapterIds[0]);
  assert.equal(emptyOutputResult.status, 'failed', '空输出必须是 failed，不能是 ok/error/undefined');
  assert.equal(emptyOutputResult.code, 'LLM_EMPTY_OUTPUT');
  assert.equal(emptyOutputResult.attempts.length, 2, '恰好一次受控重试');
  assert.equal(emptyOutputResult.attempts[0].finishReason, 'length');
  assert.equal(emptyOutputResult.attempts[0].usage.reasoningTokens, 780, '上游 usage 证据原样记录');
  assert.equal(emptyOutputResult.attempts[0].hypothesis, 'budget_consumed_by_reasoning', '有证据时只标为假设');
  assert.equal(emptyOutputResult.attempts[1].maxTokens, 1600, '重试的唯一变化＝放大分析输出预算');
  assert.equal(emptyOutputResult.finishReason, 'stop', '顶层证据＝末次上游事实');
  assert.equal(emptyOutputResult.hypothesis, null, '末次无证据 → 不得给成因定性');
  assert.ok(modelRequestCount <= 2, `最多 2 次调用，实际 ${modelRequestCount}`);
  assert.equal(modelRequestCount, 2);
  assert.equal(savedSuccessfulDriftChecks0, 0, '空输出不得写入成功诊断');

  // 受控重试的边界：只变预算，不换模型、不改温度/提示词
  assert.equal(stub.calls[0].body.max_tokens, 800);
  assert.equal(stub.calls[1].body.max_tokens, 1600);
  assert.equal(stub.calls[0].body.model, 'drift-stub-model');
  assert.equal(stub.calls[1].body.model, stub.calls[0].body.model, '不得静默换模型');
  assert.equal(stub.calls[1].body.temperature, stub.calls[0].body.temperature);
  assert.deepEqual(stub.calls[1].body.messages, stub.calls[0].body.messages, '提示词不变');
  // 记录证据但不记录凭证
  assert.equal(JSON.stringify(stub.calls[1].body).includes('sk-'), false);
  assert.equal(JSON.stringify(emptyOutputResult).includes('sk-'), false);
  // 失败不覆盖既有偏离状态（本次检查前为未检测）
  assert.equal(driftRows(bookId)[0].drift_status, '');
  assert.equal(driftRows(bookId)[0].drift_note, '');
});

// ---------------- 2. REST 摘要入口：空输出族 → drift 显式失败，总结仍保存，零成功诊断 ----------------
test('空输出族经摘要入口：drift 显式 failed，章节总结照常保存，不写偏离状态', async t => {
  const { stub, http, bookId, chapterIds } = await setup(t);
  const chapterId = chapterIds[0];
  const variants = [
    { name: '空字符串', payload: () => emptyBody({ finish: 'stop' }) },
    { name: '全空白', payload: () => blankBody('   \n\t  ') },
    { name: '仅 reasoning', payload: () => emptyBody({ reasoning: '想了一屏但一个字没写' }) },
  ];
  for (const v of variants) {
    const before = stub.calls.length;
    stub.responders.push(() => jsonStub(verdictBody(`总结（${v.name} 变体）：林一继续北上。`))); // summarize
    stub.responders.push(() => jsonStub(v.payload()));                                        // drift 首次
    stub.responders.push(() => jsonStub(v.payload()));                                        // drift 受控重试
    const r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/summary`);
    assert.equal(r.status, 200, v.name);
    assert.ok(String(r.body.summary || '').includes('林一继续北上'), `${v.name}：总结本身仍应保存`);
    assert.equal(r.body.drift && r.body.drift.status, 'failed', `${v.name}：drift 必须是 failed（null 会被读成「无偏离」）`);
    assert.equal(r.body.drift && r.body.drift.code, 'LLM_EMPTY_OUTPUT', v.name);
    assert.equal(r.body.drift && r.body.drift.attempts.length, 2, `${v.name}：恰一次受控重试`);
    assert.equal(savedSuccessfulDriftChecks(bookId), 0, `${v.name}：不得写入成功诊断`);
    assert.equal(stub.calls.length - before, 3, `${v.name}：1 次总结 + 2 次偏离检查，无额外重发`);
  }
});

// ---------------- 3. callLLMFull 边界：空输出带 code 与上游证据 ----------------
test('callLLMFull：四种空正文都归类为 LLM_EMPTY_OUTPUT，并记录 finish_reason/usage（不含凭证）', async t => {
  const { stub } = await setup(t);
  const cases = [
    { name: '空字符串', payload: () => emptyBody({ finish: 'stop' }), finish: 'stop', reasoningChars: 0 },
    { name: '全空白', payload: () => blankBody('\n  \t '), finish: 'stop', reasoningChars: 0 },
    { name: '仅 reasoning', payload: () => emptyBody({ reasoning: '思考内容不应被当作正文' }), finish: 'stop', reasoningChars: 11 },
    { name: 'length+空正文', payload: () => emptyBody({ finish: 'length', usage: usageWithReasoning(700) }), finish: 'length', reasoningChars: 0, reasoningTokens: 700 },
  ];
  for (const c of cases) {
    stub.responders.push(() => jsonStub(c.payload()));
    let err = null;
    try {
      await llm.callLLM([{ role: 'user', content: '写一条结论' }], { maxTokens: 800 });
    } catch (e) { err = e; }
    assert.ok(err, `${c.name}：空正文必须失败，不得把空内容当结果返回`);
    assert.equal(err.code, 'LLM_EMPTY_OUTPUT', c.name);
    assert.equal(err.evidence.finishReason, c.finish, c.name);
    assert.equal(err.evidence.reasoningChars, c.reasoningChars, c.name);
    if (c.reasoningTokens) {
      assert.equal(err.evidence.reasoningTokens, c.reasoningTokens, c.name);
      assert.equal(err.evidence.completionTokens, 820, c.name);
    }
    // 证据里不得出现凭证形状串
    assert.equal(JSON.stringify(err.evidence).includes('sk-'), false, c.name);
    assert.equal(String(err.message).includes('sk-'), false, c.name);
  }
  // 调用台账同时留下证据（四次都是失败记录，不再是无证据的裸错误文本）
  const rows = db.all("SELECT status, finish_reason, reasoning_tokens FROM llm_calls WHERE scope = 'llm' ORDER BY id");
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.status === 'error'));
  assert.equal(rows[3].finish_reason, 'length');
  assert.equal(rows[3].reasoning_tokens, 700);
});

// ---------------- 4. 受控重试：救得回就救；救不回就一次到底 ----------------
test('受控重试：首次空输出后第二次拿到有效结论 → 正常判定且恰好 2 次调用', async t => {
  const { stub, book, chapter } = await setup(t);
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length', usage: usageWithReasoning(600) })));
  stub.responders.push(() => jsonStub(verdictBody('轻度偏离\n与大纲方向一致但节奏偏慢')));
  const result = await llm.checkDrift(book, chapter);
  assert.deepEqual(result, { status: 'minor', note: '与大纲方向一致但节奏偏慢' });
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].body.max_tokens, 800);
  assert.equal(stub.calls[1].body.max_tokens, 1600);
});

// ---------------- 5. 结果解析失败：码不变、不重试（既有枚举修复不回滚） ----------------
test('结果解析失败（坏 JSON / 错误枚举）→ DRIFT_VERDICT_INVALID 且不重试；有效无偏离照常判定', async t => {
  const { stub, book, chapter } = await setup(t);
  const badOutputs = ['{"status":"unknown","note":"不确定"}', '不符合\n本章违背大纲', '没有严重偏离', '判断困难，建议补充大纲'];
  for (const text of badOutputs) {
    const before = stub.calls.length;
    stub.responders.push(() => jsonStub(verdictBody(text)));
    await assert.rejects(llm.checkDrift(book, chapter), { code: 'DRIFT_VERDICT_INVALID' });
    assert.equal(stub.calls.length - before, 1, `${text}：解析失败不重试`);
  }
  stub.responders.push(() => jsonStub(verdictBody('符合\r\n与大纲的北上主线一致')));
  assert.deepEqual(await llm.checkDrift(book, chapter), { status: 'ok', note: '与大纲的北上主线一致' });
});

// ---------------- 6. 成因定性：没有证据不下结论；有证据只标为假设 ----------------
test('成因定性：无证据不给假设；finish_reason=length 且有 reasoning 证据时标为假设并留原始数字', async t => {
  const { stub, http, bookId, chapterIds } = await setup(t);
  const chapterId = chapterIds[0];

  // 无任何上游证据（连 finish_reason 都没有）：不得出现「推理把 token 吃完」这类已确认根因
  const noFinishNoUsage = { choices: [{ message: { role: 'assistant', content: '' } }] };
  stub.responders.push(() => jsonStub(verdictBody('总结：林一继续北上。')));
  stub.responders.push(() => jsonStub(noFinishNoUsage));
  stub.responders.push(() => jsonStub(noFinishNoUsage));
  let r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/summary`);
  const noEvidence = r.body.drift || {};
  assert.equal(noEvidence.status, 'failed');
  assert.equal(noEvidence.code, 'LLM_EMPTY_OUTPUT');
  assert.equal(noEvidence.hypothesis, null, '没有 finish_reason/usage 证据时不得给成因定性');
  assert.equal(noEvidence.finishReason, '', '上游未给 finish_reason 就原样留空');
  assert.equal((noEvidence.usage || {}).reasoningTokens, 0);
  assert.equal(/推理/.test(String(noEvidence.note || '')), false, '不得把假设写成已确认根因');
  assert.equal(noEvidence.attempts.length, 2, '空输出仍做一次受控重试');

  // 有证据（length + reasoning_tokens）：只标为假设，且原始数字可追溯
  stub.responders.push(() => jsonStub(verdictBody('总结：林一继续北上。')));
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length', usage: usageWithReasoning(700) })));
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length', usage: usageWithReasoning(700) })));
  r = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapters/${chapterId}/summary`);
  const withEvidence = r.body.drift || {};
  assert.equal(withEvidence.status, 'failed');
  assert.equal(withEvidence.hypothesis, 'budget_consumed_by_reasoning', '有证据时标为假设（非根因）');
  assert.equal(withEvidence.finishReason, 'length');
  assert.equal((withEvidence.usage || {}).reasoningTokens, 700, '原始数字必须可追溯');
  assert.equal((withEvidence.usage || {}).completionTokens, 820);
  assert.equal(String(withEvidence.note).includes('finish_reason=length'), true, '说明里带上游事实');
  assert.equal(String(withEvidence.note).includes('reasoning_tokens=700'), true, '说明里的数字来自上游证据');
});

// ---------------- 7. 取消与总时限约束 ----------------
test('取消/总时限：signal 已取消时不发模型请求；总时限用尽时不做受控重试', async t => {
  const { stub, book, chapter } = await setup(t);

  const ac = new AbortController();
  ac.abort(new Error('作者取消'));
  let cancelled = null;
  try {
    await llm.checkDrift(book, chapter, { signal: ac.signal });
  } catch (e) { cancelled = e; }
  assert.ok(cancelled, '取消后必须失败，不得返回空结论当「无偏离」');
  assert.equal(stub.calls.length, 0, '取消后不得再发模型请求');

  const before = stub.calls.length;
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length' })));
  await assert.rejects(llm.checkDrift(book, chapter, { maxDurationMs: 0 }), { code: 'LLM_EMPTY_OUTPUT' });
  assert.equal(stub.calls.length - before, 1, '总时限用尽 → 不做受控重试');
});

// ---------------- 8. 工具侧：结构化失败不打断批量，也不写成「符合」 ----------------
test('工具侧：check_drift 返回结构化失败（含 code）；check_drift_all 单章失败不打断整批', async t => {
  const { stub, bookId, chapterIds } = await setup(t, { chapters: 2 });
  const ctx = { profile: 'agent', sessionId: 'drift-tool', bookId, source: 'agent', actor: 'author' };

  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length', usage: usageWithReasoning(650) })));
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'stop' })));
  const single = await executeTool(ctx, 'check_drift', { chapter_id: chapterIds[0] })
    .catch(err => ({ threw: err.code || err.message }));
  assert.equal(single.status, 'failed', '失败必须以结构化结果返回，而不是抛通用异常');
  assert.equal(single.code, 'LLM_EMPTY_OUTPUT');
  assert.equal(single.attempts.length, 2);

  stub.responders.push(() => jsonStub(verdictBody('{"verdict":"ok"}')));           // 第 1 章：坏 JSON
  const badVerdict = await executeTool(ctx, 'check_drift', { chapter_id: chapterIds[0] })
    .catch(err => ({ threw: err.code || err.message }));
  assert.equal(badVerdict.status, 'failed');
  assert.equal(badVerdict.code, 'DRIFT_VERDICT_INVALID');
  assert.equal(badVerdict.attempts.length, 1, '解析失败不重试');

  stub.responders.push(() => jsonStub(emptyBody({ finish: 'length' })));            // 第 1 章首次
  stub.responders.push(() => jsonStub(emptyBody({ finish: 'stop' })));             // 第 1 章重试
  stub.responders.push(() => jsonStub(verdictBody('严重偏离\n与大纲主线冲突')));      // 第 2 章
  const batch = await executeTool(ctx, 'check_drift_all', { limit: 5 })
    .catch(err => ({ threw: err.code || err.message }));
  assert.equal(batch.checked, 2, '单章失败不得打断整批');
  assert.equal(batch.results[0].status, 'failed');
  assert.equal(batch.results[0].code, 'LLM_EMPTY_OUTPUT');
  assert.equal(batch.results[1].status, 'major');
  // 两个漂移工具都是 analysis.read：只回结果、不写库（落库只发生在 REST「全书对齐检查」入口，
  // 该入口本切片已断言「失败不写、只有真实判定才写」）——失败自然也不会有成功诊断
  assert.equal(savedSuccessfulDriftChecks(bookId), 0, '工具侧不落库；失败更不能写成成功诊断');
  assert.equal(driftRows(bookId)[0].drift_status, '');
});
