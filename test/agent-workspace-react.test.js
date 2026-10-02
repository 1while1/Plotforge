// S5-9（Plan §2.4 六处转写映射的 Node 侧等价重钉；charter §2 豁免流程）：agent.js 块二退役语义
// 的 Node 档案——**E1~E15 等价断言**（净计：Node 冻结面 22→15 之后的补足，保 npm test 计数只增不减）。
//
// 缘起：本片把 test/agent-workspace-ui.test.js 的 6 例、test/handoff-ui.test.js 的 7 例按 charter §2
// 逐条转写为 React 侧断言（Plan §2.4 表一/表二），三处 vm 直读面就地退役；为守住「Node 冻结面计数
// 不得低于基线」的立约，同一批语义在此**等价重钉**（双侧同源双钉，非放宽）。
//
// 装载纪律（S5-4／S5-7 先例）：data URL import 真源码，零文本变换——唯一例外＝带相对 import 的两个
// lib（agent-resources.js → agent-scope.js；agent-round.js → agent-scope.js）的说明符必须换成
// agent-scope.js 自身的 data URL（data URL 无目录上下文）；替换在装载前自检。
// 逐条留案（行号为 public/legacy/agent.js 活代码锚点）：
//   E1  readSavedScope/scopeKey/saveScope＋conversationInScope/firstConversationInScope（:94-136／:549-567）
//   E2  resolveBoundaryChapterId（:250-252）              E3  resourceListUrl＋resourceListHint（:344／:356-361）
//   E4  resourceDetailUrl（:408-410）                     E5  buildSendPayload 四态（:1924-1933）
//   E6  buildResumePayload（:1824）                       E7  buildNewConversationBody（:600-601）
//   E8  buildLegacyImportBody＋legacyBarModel（:1240-1246／:1215-1232）
//   E9  togglePick 去重＋id 升序（退役 handoff-ui:606 等价面，S5-8 出口锚）
//   E10 noteModalBodyHTML 段与四字段回执形状（退役 handoff-ui:635 等价面）
//   E11 handoffComposeBodyHTML 三形态＋HANDOFF_SOURCE_CHANGED 分支文案锚（退役 handoff-ui:666/:733/:872）
//   E12 作废语义（退役 handoff-ui:804/:848 等价面：空体 cancel 与「不撤回」文案锚）
//   E13 planPendingRebuild 过期/去重/截断（≙ :1308-1338）  E14 状态表与结算分派（≙ :1608-1629／:1749-1786）
//   E15 createRoundAccumulator 结果形状＋runCardInput（≙ :1395-1517／:2009-2034）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const LIB_DIR = path.join(root, 'frontend', 'lib');
const HOOK_DIR = path.join(root, 'frontend', 'hooks');

function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

function readLib(name) {
  return fs.readFileSync(path.join(LIB_DIR, name), 'utf8');
}

let modsPromise = null;
function loadLibs() {
  if (!modsPromise) {
    const scopeSrc = readLib('agent-scope.js');
    const scopeUrl = dataUrl(scopeSrc);
    const actionsUrl = dataUrl(readLib('agent-actions.js'));
    const rewrite = (src, file) => {
      let out = src;
      let hits = 0;
      for (const [spec, url] of [
        ['"./agent-scope.js"', `"${scopeUrl}"`],
        ['"./agent-actions.js"', `"${actionsUrl}"`],
      ]) {
        hits += out.split(spec).length - 1;
        out = out.split(spec).join(url);
      }
      assert.ok(hits >= 1, `${file} 的相对 import 说明符未命中替换`);
      assert.equal(
        out.split('data:text/javascript').length - 1,
        hits,
        `${file} 替换点数与控制点不一致`,
      );
      return out;
    };
    modsPromise = (async () => ({
      scope: await import(dataUrl(scopeSrc)),
      resources: await import(dataUrl(rewrite(readLib('agent-resources.js'), 'agent-resources.js'))),
      handoff: await import(dataUrl(readLib('agent-handoff.js'))),
      pending: await import(dataUrl(readLib('agent-pending.js'))),
      actions: await import(dataUrl(readLib('agent-actions.js'))),
      round: await import(dataUrl(rewrite(readLib('agent-round.js'), 'agent-round.js'))),
    }))();
  }
  return modsPromise;
}

function memStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const BOOKS = [{ id: 7, title: '雾港编年史' }];
const BOOK_SCOPE = { kind: 'book', bookId: 7 };
const GLOBAL_SCOPE = { kind: 'global', bookId: null };

let mods = null;

test.before(async () => {
  mods = await loadLibs();
});

// E1（:94-136／:549-567）—— 范围/会话恢复
test('E1 范围与会话恢复：读回/写回键逐字＋范围匹配与首选会话', async () => {
  const { readSavedScope, scopeKey, saveScope, conversationInScope, firstConversationInScope, SCOPE_KEY, CONVERSATION_KEY } = mods.scope;
  assert.equal(SCOPE_KEY, 'agent_scope_v1');
  assert.equal(CONVERSATION_KEY, 'agent_conversation_v1');
  const store = memStorage({ agent_scope_v1: 'book:7' });
  const scope = readSavedScope(store);
  assert.deepEqual(scope, { kind: 'book', bookId: 7 });
  assert.equal(scopeKey(scope), 'book:7');
  saveScope(store, GLOBAL_SCOPE);
  assert.equal(store.map.get('agent_scope_v1'), 'global');
  assert.deepEqual(readSavedScope(memStorage({ agent_scope_v1: '坏值' })), { kind: 'global', bookId: null });
  const conversations = [
    { id: 'a', scope: 'book', book_id: 7, status: 'archived' },
    { id: 'b', scope: 'book', book_id: 7, status: 'active' },
    { id: 'c', scope: 'global', book_id: null, status: 'active' },
  ];
  assert.equal(conversationInScope(BOOK_SCOPE, conversations[0]), true);
  assert.equal(conversationInScope(BOOK_SCOPE, conversations[2]), false);
  assert.equal(firstConversationInScope(BOOK_SCOPE, conversations).id, 'b');
  assert.equal(firstConversationInScope(GLOBAL_SCOPE, conversations).id, 'c');
});

// E2（:250-252）—— 边界章节失效回落
test('E2 边界回落：章节已删/换书 → null（回全书，不猜）', async () => {
  const { resolveBoundaryChapterId } = mods.scope;
  assert.equal(resolveBoundaryChapterId([{ id: 12 }], 12), 12);
  assert.equal(resolveBoundaryChapterId([{ id: 12 }], 13), null);
  assert.equal(resolveBoundaryChapterId([], 12), null);
  assert.equal(resolveBoundaryChapterId([{ id: 12 }], null), null);
});

// E3（:344／:356-361）—— 资源列表 URL 与 cursor＋hint 两态
test('E3 资源列表 URL / cursor / hint：首读无 cursor、续读尾追编码、bookId 只在书内类型', async () => {
  const { resourceListUrl, resourceListHint } = mods.resources;
  assert.equal(
    resourceListUrl(BOOK_SCOPE, 'chapter', null),
    '/api/resources?type=chapter&bookId=7',
  );
  assert.equal(
    resourceListUrl(BOOK_SCOPE, 'chapter', 'CUR 1/+'),
    '/api/resources?type=chapter&bookId=7&cursor=CUR%201%2F%2B',
  );
  assert.equal(resourceListUrl(GLOBAL_SCOPE, 'book', 'x'), '/api/resources?type=book&cursor=x');
  assert.equal(resourceListUrl(GLOBAL_SCOPE, 'system', null), '/api/resources?type=system');
  const hint = resourceListHint(BOOK_SCOPE, BOOKS, 'chapter', 3, true);
  assert.equal(
    hint,
    '范围：《雾港编年史》 · 类型：章节 · 已列出 3 项（还有更多）。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。',
  );
  assert.equal(
    resourceListHint(GLOBAL_SCOPE, BOOKS, 'book', 1, false).indexOf('（还有更多）'),
    -1,
  );
});

// E4（:408-410）—— 摘要 URL 形状
test('E4 摘要 URL：id 在前、bookId 仅在书籍范围且属书内类型', async () => {
  const { resourceDetailUrl } = mods.resources;
  assert.equal(
    resourceDetailUrl(BOOK_SCOPE, 'style', 3),
    '/api/resources?type=style&id=3&bookId=7',
  );
  assert.equal(
    resourceDetailUrl(BOOK_SCOPE, 'book', 3),
    '/api/resources?type=book&id=3',
  );
  assert.equal(
    resourceDetailUrl(GLOBAL_SCOPE, 'style', 3),
    '/api/resources?type=style&id=3',
  );
});

// E5（:1924-1933）—— 发送体四态
test('E5 发送体：恒三键；mode/book_id 仅 book+execute；chapterId 仅 book 且有值', async () => {
  const { buildSendPayload } = mods.round;
  const base = { conversationId: 'c-1', content: '问', requestId: 'req-1' };
  assert.deepEqual(buildSendPayload({ ...base, scope: GLOBAL_SCOPE, mode: 'execute', boundaryChapterId: 12 }), {
    conversation_id: 'c-1',
    content: '问',
    request_id: 'req-1',
  });
  assert.deepEqual(buildSendPayload({ ...base, scope: BOOK_SCOPE, mode: 'discuss', boundaryChapterId: null }), {
    conversation_id: 'c-1',
    content: '问',
    request_id: 'req-1',
  });
  assert.deepEqual(buildSendPayload({ ...base, scope: BOOK_SCOPE, mode: 'execute', boundaryChapterId: null }), {
    conversation_id: 'c-1',
    content: '问',
    request_id: 'req-1',
    mode: 'execute',
    book_id: 7,
  });
  assert.deepEqual(buildSendPayload({ ...base, scope: BOOK_SCOPE, mode: 'discuss', boundaryChapterId: 12 }), {
    conversation_id: 'c-1',
    content: '问',
    request_id: 'req-1',
    chapterId: 12,
  });
});

// E6（:1824）—— 续跑体
test('E6 续跑体：conversation_id 有值才带（逐字 || undefined）', async () => {
  const { buildResumePayload } = mods.round;
  assert.deepEqual(buildResumePayload({ conversationId: 'c-1', requestId: 'r1' }), {
    conversation_id: 'c-1',
    request_id: 'r1',
  });
  assert.deepEqual(Object.keys(buildResumePayload({ conversationId: null, requestId: 'r1' })), ['request_id']);
});

// E7（:600-601）—— 新会话体
test('E7 新会话体：kind/scope/title 逐字；book 才带 bookId', async () => {
  const { buildNewConversationBody } = mods.round;
  assert.deepEqual(buildNewConversationBody(BOOK_SCOPE, BOOKS), {
    kind: 'agent',
    scope: 'book',
    title: '雾港编年史 · 讨论',
    bookId: 7,
  });
  assert.deepEqual(buildNewConversationBody(GLOBAL_SCOPE, BOOKS), {
    kind: 'agent',
    scope: 'global',
    title: '全局资源讨论',
  });
});

// E8（:1240-1246／:1215-1232）—— 导入体与提示条
test('E8 legacy 导入体过滤＋导入条两态文案', async () => {
  const { buildLegacyImportBody, legacyBarModel } = mods.round;
  assert.deepEqual(
    buildLegacyImportBody([
      { role: 'user', content: '甲' },
      { role: 'tool', content: '忽略' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '乙' },
    ]),
    {
      scope: 'global',
      title: '导入的助手历史',
      messages: [
        { role: 'user', content: '甲' },
        { role: 'assistant', content: '乙' },
      ],
    },
  );
  assert.equal(legacyBarModel([], false).visible, false);
  const pending = legacyBarModel([{ content: '这是一条超过二十四个字的旧助手历史首条内容用于截断断言' }], false);
  assert.equal(pending.visible, true);
  // :1229-1231 逐字：content.slice(0, 24) 截断后接「…」再收括号（省略号在内层引号内）
  assert.ok(pending.text.includes('（首条：「这是一条超过二十四个字的旧助手历史首条内容用于截…」）'));
  const imported = legacyBarModel([{ content: '甲' }], true);
  assert.equal(imported.importHidden, true);
  assert.equal(imported.cleanHidden, false);
  assert.ok(imported.text.includes('已导入服务端'));
});

// E9（退役 handoff-ui:606 等价面）—— 勾选去重＋升序
test('E9 勾选语义：togglePick 去重＋按 Number(id) 升序（S5-8 出口锚）', async () => {
  const { togglePick } = mods.handoff;
  const m = (id, content) => ({ id, content, role: 'assistant' });
  let picks = [];
  picks = togglePick(picks, m(2, '二'), true);
  picks = togglePick(picks, m(10, '十'), true);
  picks = togglePick(picks, m(2, '二'), true);
  assert.deepEqual(picks.map((p) => p.id), [2, 10]);
  picks = togglePick(picks, m(2, '二'), false);
  assert.deepEqual(picks.map((p) => p.id), [10]);
  assert.deepEqual(picks[0].content, '十');
});

// E10（退役 handoff-ui:635 等价面）—— 笔记弹窗正文段与回执形状
test('E10 笔记弹窗：noteModalBodyHTML 段＋四字段回执形状（S5-8 出口锚）', async () => {
  const { noteModalBodyHTML, defaultHandoffText } = mods.handoff;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = noteModalBodyHTML('《雾港编年史》 · 讨论', [{ id: 2, content: '结论甲' }], esc);
  assert.ok(html.includes('id="agent-note-title"'));
  assert.ok(html.includes('id="agent-note-text"'));
  assert.ok(html.includes('《雾港编年史》 · 讨论 · 讨论纪要'));
  assert.ok(html.includes('来源：本轮勾选的 1 条讨论消息（#2）'));
  assert.equal(defaultHandoffText([{ content: ' 结论甲 ' }, { content: '' }]), '结论甲');
  // 四字段回执（node 侧只锚形状：use-agent-handoff.js:839-844 的 saved 物件）
  const hookSrc = fs.readFileSync(path.join(HOOK_DIR, 'use-agent-handoff.js'), 'utf8');
  assert.ok(hookSrc.includes('id: note.id'));
  assert.ok(hookSrc.includes('title: note.title || ""'));
  assert.ok(hookSrc.includes('revision: note.revision'));
  assert.ok(hookSrc.includes('conversationId: note.conversationId'));
});

// E11（退役 handoff-ui:666/:733/:872 等价面）—— 交接表单三形态＋来源变更文案锚
test('E11 交接：handoffComposeBodyHTML 三形态＋来源变更不拿旧指纹重试（文案锚）', async () => {
  const { handoffComposeBodyHTML } = mods.handoff;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const deps = { books: BOOKS, boundaryChapters: [{ id: 12, title: '第一章 石碑' }], escapeHtml: esc };
  const bookForm = handoffComposeBodyHTML(
    { bookScope: true, bookTitle: '雾港编年史', bookId: 7, writingList: [{ id: 'w-1', title: '正文写作', status: 'active' }], targetId: 'w-1', picks: [{ id: 2 }], chapterId: 12, note: null },
    deps,
  );
  assert.ok(bookForm.includes('目标书：<strong>雾港编年史</strong>（当前范围；交接不能跨书）'));
  assert.ok(bookForm.includes('id="handoff-target-conversation"'));
  assert.equal(bookForm.includes('id="handoff-target-book"'), false);
  assert.ok(bookForm.includes('id="handoff-ref-chapter"'));
  assert.ok(bookForm.includes('id="handoff-material"'));
  const globalForm = handoffComposeBodyHTML(
    { bookScope: false, bookTitle: '', bookId: null, writingList: [], targetId: '', picks: [], chapterId: null, note: { id: 9, title: '笔记甲', revision: 2 } },
    deps,
  );
  assert.ok(globalForm.includes('id="handoff-target-book"'));
  assert.ok(globalForm.includes('（请选择目标书）')); // agent.js:138 逐字
  assert.ok(globalForm.includes('id="handoff-ref-note"'));
  assert.ok(globalForm.includes('（无选定消息：只交接摘要文本）'));
  const hookSrc = fs.readFileSync(path.join(HOOK_DIR, 'use-agent-handoff.js'), 'utf8');
  assert.ok(hookSrc.includes('来源资料已更新：请点「重新预览」核对后再接受'));
  assert.ok(hookSrc.includes('来源已变更：请重新预览后再交接'));
  assert.ok(hookSrc.includes('{ expectedSourceFingerprint: view.sourceFingerprint }'));
});

// E12（退役 handoff-ui:804/:848 等价面）—— 作废语义锚
test('E12 作废：空体 cancel＋「不撤回」文案锚＋成功不复位按钮', async () => {
  const hookSrc = fs.readFileSync(path.join(HOOK_DIR, 'use-agent-handoff.js'), 'utf8');
  assert.ok(hookSrc.includes('`/api/handoffs/${encodeURIComponent(view.id)}/cancel`'));
  assert.ok(hookSrc.includes('作废这份交接草案？'));
  assert.ok(hookSrc.includes('已经采纳过、写进写作会话的消息不会因此撤回。'));
  assert.ok(hookSrc.includes('这条交接已经写进写作会话：作废不会撤回那条消息。要换结论请重新创建草案。'));
  assert.ok(hookSrc.includes('if (view.status === "accepted")'));
  assert.ok(hookSrc.includes('草案已作废（未向写作会话写入任何内容）'));
});

// E13（≙ :1308-1338）—— pending 计划（本片 T1 的 Node 双钉）
test('E13 pending 计划：过期划分＋同参去重＋slice(-20) 截断', async () => {
  const { planPendingRebuild, savePendingList, PENDING_KEY } = mods.pending;
  const now = Date.UTC(2026, 8, 28);
  const entry = (over) => ({ id: 'a', conf: { id: 'a' }, toolName: 't', input: { a: 1 }, expiresAt: null, ...over });
  const { kept, expired } = planPendingRebuild(
    [
      entry({ id: 'p1', expiresAt: new Date(now - 1).toISOString() }),
      entry({ id: 'p2', toolName: 't', input: { a: 1 } }),
      entry({ id: 'p3', toolName: 't', input: { a: 1 } }),
    ],
    now,
  );
  assert.deepEqual(expired.map((e) => e.id), ['p1']);
  assert.deepEqual(kept.map((e) => e.id), ['p3']);
  const store = memStorage();
  const many = [];
  for (let i = 0; i < 25; i++) many.push(entry({ id: `x${i}` }));
  savePendingList(store, many);
  assert.equal(JSON.parse(store.map.get(PENDING_KEY)).length, 20);
  assert.equal(JSON.parse(store.map.get(PENDING_KEY))[0].id, 'x5');
});

// E14（≙ :1608-1629／:1749-1786）—— 状态表与结算分派四错误码
test('E14 状态表八键与结算分派四错误码', async () => {
  const { ACTION_STATUS_META, normalizeActionStatus, actionStatusMeta, settleOutcome } = mods.actions;
  assert.equal(Object.keys(ACTION_STATUS_META).length, 8);
  assert.equal(normalizeActionStatus(''), 'pending');
  assert.equal(normalizeActionStatus('wat'), 'unknown');
  assert.equal(actionStatusMeta('unknown').text, '已结算（状态未知）');
  assert.equal(settleOutcome({ ok: false, status: 409, errCode: 'CONFIRMATION_SUPERSEDED', data: null }).key, 'superseded');
  assert.equal(settleOutcome({ ok: false, status: 404, errCode: '', data: null }).key, 'expired');
  assert.equal(settleOutcome({ ok: false, status: 409, errCode: 'ACTION_REQUIRES_REVIEW', data: null }).key, 'interrupted');
  const fail = settleOutcome({ ok: false, status: 500, errCode: 'E', data: null });
  assert.equal(fail.key, 'fail');
  assert.equal(fail.statusText, '确认失败');
  assert.equal(fail.resetButtons, true);
  assert.equal(settleOutcome({ ok: true, status: 200, data: { status: 'approved' } }).shouldResume, true);
});

// E15（≙ :1395-1517／:2009-2034）—— 轮次累积结果形状＋任务卡取参
test('E15 轮次累积结果形状＋任务卡取参与空判定', async () => {
  const { createRoundAccumulator, runCardInput, isRunCardEmpty, pendingActionSummaries, TOOL_RESULT_MAX } = mods.round;
  const acc = createRoundAccumulator();
  acc.onReasoningStart();
  acc.onReasoningDelta('想');
  acc.onReasoningEnd();
  acc.onDelta('正文');
  acc.onToolCall({ toolCallId: 't1', toolName: 'read', input: {} });
  acc.onToolOutput({ toolCallId: 't1', output: { ok: true } });
  acc.onToolError({ toolCallId: 'e1', toolName: 'write', code: 'TOOL_NOT_ALLOWED' });
  const result = acc.result({});
  assert.equal(result.text, '正文');
  assert.equal(result.tools, acc.roundTools);
  assert.equal(result.tools[0].result.ok, true);
  assert.equal(result.toolErrors.length, 1);
  assert.equal(TOOL_RESULT_MAX, 2000);
  const input = runCardInput({ run: null, conversationId: null, tools: result.tools, toolErrors: result.toolErrors, actions: [] });
  assert.deepEqual(Object.keys(input).sort(), ['actions', 'conversationId', 'run', 'toolErrors', 'tools']);
  assert.equal(isRunCardEmpty({ badge: null, pendingActions: [], tools: [], toolErrors: [] }), true);
  assert.equal(isRunCardEmpty({ badge: null, pendingActions: [], tools: [], toolErrors: [{ code: 'X' }] }), false);
  assert.deepEqual(
    pendingActionSummaries([{ id: 'a', toolName: 'update_chapter', conversationId: null }]),
    [{ id: 'a', conversationId: null, summary: 'update_chapter（等你在会话里确认）' }],
  );
});
