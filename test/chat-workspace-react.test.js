// S5-7（Plan §2.4「（一）~（四）」的 Node 侧等价重钉；charter §2 豁免流程）：book-chat.js 块三
// 退役语义的 Node 档案——**E1~E14 等价断言**（≥ 退役用例数 12，保 npm test 计数只增不减）。
//
// 缘起：本片把 test/writing-workspace-state.test.js 的 10 例、test/run-status-ui.test.js 的 4 例、
// test/handoff-ui.test.js 的 1 例按 charter §2 逐条转写为 React 侧断言（Plan §2.4 表一~表三），
// 三条 vm 直读面就地退役；为守住 S5-4 整改 R1 立约的「Node 冻结面计数不得低于基线 1177」，
// 同一批语义在此**等价重钉**（双侧同源双钉，非放宽）。
//
// 装载纪律（S5-4 先例 test/workspace-navigation.test.js:40-47）：data URL import 真源码，
// 零文本变换——唯一例外＝frontend/lib/chat-context.js 的一处相对 import（：6 `./chat-render.js`）
// 说明符必须换成 chat-render.js 自身的 data URL（data URL 无目录上下文）；替换在装载前自检。
// 逐条留案（行号为 public/legacy/book-chat.js 活代码锚点）：
//   E1  convStorageKey/currentConversationId（:8-15，含 storage 抛错容错）
//   E2  conversationQuery（:60-63）                    E3  会话选项模型（:32-44）
//   E4  rememberConversation/switchConversation/newWritingConversation（:16-22/:46-59）
//   E5  handoffRefs/handoffIdAnchor（:83-95）          E6  handoffTitle 截断＋pickCharacter（:96-112）
//   E7  handoffMaterial 四段（:102-105）               E8  parseHandoffSource＋handoffRefsText（:207-219/:269-271）
//   E9  handoffScopeKey（:239-241）＋selectedEditorText（:74-81）
//   E10 refreshAfterWrite 映射（:648-663）             E11 resourceKey＋resourceNotice（:1968-1970/:2027-2040）
//   E12 refreshRunStatus 参数合并与次序（:2044-2061）   E13 watcher 策略与展示态开关（:2064-2116）
//   E14 压缩四节 bodyHTML＋压缩/还原请求体与 toast（:796-827）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const LIB_DIR = path.join(root, 'frontend', 'lib');

function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

let modsPromise = null;
function loadLibs() {
  if (!modsPromise) {
    const read = (f) => fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
    const renderSrc = read('chat-render.js');
    const ctxOrig = read('chat-context.js');
    const ctxSrc = ctxOrig.replace('"./chat-render.js"', `"${dataUrl(renderSrc)}"`);
    // 装载自检：唯一一处替换必须命中（chat-context 依赖链不漂移）
    assert.notEqual(ctxSrc, ctxOrig, 'chat-context.js 的相对 import 说明符未命中替换');
    assert.equal(ctxSrc.split('data:text/javascript').length - 1, 1, '替换点应恰一处');
    modsPromise = (async () => ({
      session: await import(dataUrl(read('chat-session.js'))),
      handoff: await import(dataUrl(read('chat-handoff.js'))),
      context: await import(dataUrl(ctxSrc)),
      status: await import(dataUrl(read('chat-status.js'))),
      lists: await import(dataUrl(read('chat-side-lists.js'))),
    }))();
  }
  return modsPromise;
}

// 会话存储桩（无 jsdom 依赖；storage 抛错容错由 E1 单独覆盖）
function memStorage(throwOnGet) {
  const map = new Map();
  return {
    map,
    getItem(k) {
      if (throwOnGet) throw new Error('storage 不可用');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

let dom = null;
let mods = null;

test.before(async () => {
  mods = await loadLibs();
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
});

// ---------- E1~E4 会话（chat-session.js ≙ :1-63） ----------
test('E1 convStorageKey/currentConversationId 逐字（:8-15，含 storage 抛错容错）', async () => {
  const { session } = mods;
  assert.equal(session.convStorageKey(7), 'writing_conversation_7');
  assert.equal(session.convStorageKey(undefined), 'writing_conversation_');
  const storage = memStorage();
  const calls = [];
  const api = async (method, url) => {
    calls.push(`${method} ${url}`);
    return [];
  };
  const s = session.createChatSession({
    getBookId: () => 7,
    storage,
    api,
    toast() {},
    loadChat: async () => {},
    refreshCtxMeter() {},
    onConversations() {},
  });
  assert.equal(s.currentConversationId(), null); // 未写：null（:14）
  await s.rememberConversation('conv-1');
  assert.equal(storage.map.get('writing_conversation_7'), 'conv-1');
  assert.equal(s.currentConversationId(), 'conv-1');
  // 缺书：null 且不读 storage（:13）
  const s2 = session.createChatSession({ getBookId: () => null, storage });
  assert.equal(s2.currentConversationId(), null);
  // storage 抛错容错（:14 catch）
  const s3 = session.createChatSession({ getBookId: () => 7, storage: memStorage(true) });
  assert.equal(s3.currentConversationId(), null);
  await s3.rememberConversation('x'); // 不抛
  void calls;
});

test('E2 conversationQuery 逐字（:60-63）', async () => {
  const { session } = mods;
  assert.equal(session.conversationQuery(null), '');
  assert.equal(session.conversationQuery(''), '');
  assert.equal(session.conversationQuery('c-1'), '?conversationId=c-1');
  assert.equal(
    session.conversationQuery('a b/c'),
    '?conversationId=a%20b%2Fc', // encodeURIComponent 逐字
  );
});

test('E3 会话选项模型：默认项恒首/未命名兜底/已归档后缀/选中匹配（:32-44）', async () => {
  const { session } = mods;
  assert.deepEqual(session.conversationOptions(null, null), [
    { value: '', label: '（默认：历史对话）', selected: true },
  ]);
  assert.deepEqual(
    session.conversationOptions(
      [
        { id: 'c1', title: '任务一', status: 'active' },
        { id: 'c2', title: '', status: 'archived' },
      ],
      'c1',
    ),
    [
      { value: '', label: '（默认：历史对话）', selected: false },
      { value: 'c1', label: '任务一', selected: true },
      { value: 'c2', label: '未命名会话（已归档）', selected: false },
    ],
  );
});

test('E4 rememberConversation/switchConversation/newWritingConversation 调用序与文案逐字（:16-22/:46-59）', async () => {
  const { session } = mods;
  const storage = memStorage();
  const order = [];
  let apiImpl = async () => [];
  const s = session.createChatSession({
    getBookId: () => 7,
    storage,
    api: async (method, url, body) => {
      order.push(`${method} ${url}`);
      return apiImpl(method, url, body);
    },
    toast: (m) => order.push(`TOAST ${m}`),
    loadChat: async () => order.push('LOAD_CHAT'),
    refreshCtxMeter: () => order.push('REFRESH_CTX'),
    onConversations: () => order.push('ON_CONVERSATIONS'),
  });
  await s.rememberConversation('conv-1');
  assert.deepEqual(order, [
    'GET /api/conversations?kind=writing&bookId=7',
    'ON_CONVERSATIONS',
  ]);
  order.length = 0;
  await s.switchConversation('conv-2');
  assert.deepEqual(order, [
    'GET /api/conversations?kind=writing&bookId=7',
    'ON_CONVERSATIONS',
    'LOAD_CHAT',
    'REFRESH_CTX',
  ]);
  assert.equal(storage.map.get('writing_conversation_7'), 'conv-2');
  order.length = 0;
  apiImpl = async (method, url) => {
    assert.equal(method, 'POST');
    assert.equal(url, '/api/conversations');
    return { id: 'conv-new' };
  };
  const posted = [];
  const s3 = session.createChatSession({
    getBookId: () => 7,
    storage,
    api: async (method, url, body) => {
      posted.push({ method, url, body });
      return { id: 'conv-new' };
    },
    toast: (m) => order.push(`TOAST ${m}`),
    loadChat: async () => order.push('LOAD_CHAT'),
    refreshCtxMeter() {},
    onConversations: () => order.push('ON_CONVERSATIONS'),
  });
  await s3.newWritingConversation();
  assert.deepEqual(posted[0], {
    method: 'POST',
    url: '/api/conversations',
    body: { kind: 'writing', scope: 'book', bookId: 7, title: '新写作任务' },
  });
  assert.equal(storage.map.get('writing_conversation_7'), 'conv-new');
  assert.ok(order.includes('TOAST 已开始新写作会话（原会话历史保留，可从切换器回到）'));
  assert.ok(order.includes('LOAD_CHAT'));

  // 失败：toast 前缀逐字 + 不切会话（:58）
  const toasts = [];
  const storage2 = memStorage();
  storage2.setItem('writing_conversation_7', 'keep-me');
  const s4 = session.createChatSession({
    getBookId: () => 7,
    storage: storage2,
    api: async () => {
      throw new Error('boom');
    },
    toast: (m) => toasts.push(m),
    loadChat: async () => {},
    refreshCtxMeter() {},
    onConversations() {},
  });
  await s4.newWritingConversation();
  assert.deepEqual(toasts, ['新会话创建失败：boom']);
  assert.equal(storage2.map.get('writing_conversation_7'), 'keep-me');
});

// ---------- E5~E9 交接与来源回跳（chat-handoff.js ≙ :65-275） ----------
test('E5 handoffRefs/handoffIdAnchor 逐字（:83-95）', async () => {
  const { handoff } = mods;
  const book = { id: 7, title: '雾港编年史' };
  assert.equal(handoff.handoffRefs(book, null, null), '《雾港编年史》');
  assert.equal(
    handoff.handoffRefs(book, { id: 12, title: '第1章 石碑' }, { id: 5, name: '林昭' }),
    '《雾港编年史》 · 《第1章 石碑》 · 人物：林昭',
  );
  assert.equal(handoff.handoffRefs({ id: 9 }, null, null), '《#9》');
  assert.equal(
    handoff.handoffRefs(book, { id: 12, title: '' }, null),
    '《雾港编年史》 · 《章节 #12》',
  );
  assert.equal(handoff.handoffIdAnchor(book, null, null), '[bookId=7]');
  assert.equal(
    handoff.handoffIdAnchor(book, { id: 12 }, { id: 5 }),
    '[bookId=7 chapterId=12 characterId=5]',
  );
});

test('E6 handoffTitle 200 截断＋pickCharacter String 比较（:96-112）', async () => {
  const { handoff } = mods;
  const book = { id: 7, title: '雾港编年史' };
  assert.equal(handoff.handoffTitle(book, null, null), '《雾港编年史》· 整体讨论');
  assert.equal(
    handoff.handoffTitle(book, { id: 12, title: '第1章 石碑' }, { id: 5, name: '林昭' }),
    '《雾港编年史》· 整体讨论 · 自《第1章 石碑》 · 人物：林昭',
  );
  const long = '长'.repeat(300);
  assert.equal(handoff.handoffTitle({ id: 1, title: long }, null, null).length, 200);
  const list = [{ id: 5, name: '林昭' }];
  assert.equal(handoff.pickCharacter(list, '5').name, '林昭'); // String 比较（:109）
  assert.equal(handoff.pickCharacter(list, ''), null);
  assert.equal(handoff.pickCharacter(list, '9'), null);
});

test('E7 handoffMaterial 四段逐字（:102-105）', async () => {
  const { handoff } = mods;
  const book = { id: 7, title: '雾港编年史' };
  const text = '这是作者明确选中的一段文字。';
  assert.equal(
    handoff.handoffMaterial(book, { id: 12, title: '第1章 石碑' }, null, text),
    '【来自写作页·整体讨论】《雾港编年史》 · 《第1章 石碑》 [bookId=7 chapterId=12]\n' +
      '以下为作者在写作页明确选中的文字：\n' +
      text,
  );
});

test('E8 parseHandoffSource＋handoffRefsText 逐字（:207-219/:269-271）', async () => {
  const { handoff } = mods;
  assert.equal(handoff.parseHandoffSource('普通消息'), null);
  const info = handoff.parseHandoffSource(
    '【来自 Agent 讨论·显式交接】来源会话：整体讨论（conv-origin-01）\n摘要\n来源引用：规划笔记 #n-1 revision 2｜ 结论 A ｜｜',
  );
  assert.deepEqual(info, {
    originConversationId: 'conv-origin-01',
    originTitle: '整体讨论',
    refs: ['规划笔记 #n-1 revision 2', '结论 A'],
  });
  assert.equal(
    handoff.handoffRefsText(info),
    '来源会话：整体讨论（conv-origin-01）\n规划笔记 #n-1 revision 2\n结论 A',
  );
  // 无来源会话 head：字段空串，不误伤（:214-217）
  const bare = handoff.parseHandoffSource('【来自 Agent 讨论·显式交接】无头行');
  assert.deepEqual(bare, { originConversationId: '', originTitle: '', refs: [] });
  assert.equal(handoff.handoffRefsText(bare), '');
});

test('E9 handoffScopeKey 两态＋selectedEditorText 选区（:74-81/:239-241）', async () => {
  const { handoff } = mods;
  assert.equal(handoff.handoffScopeKey({ scope: 'book', book_id: 7 }), 'book:7');
  assert.equal(handoff.handoffScopeKey({ scope: 'global' }), 'global');
  assert.equal(handoff.handoffScopeKey(null), 'global');
  const content = dom.window.document.createElement('textarea');
  content.id = 'chapter-content';
  content.value = '前文。这是选中的。后文。';
  content.selectionStart = 3;
  content.selectionEnd = 9;
  dom.window.document.body.appendChild(content);
  assert.equal(handoff.selectedEditorText(dom.window.document), '这是选中的。');
  content.selectionStart = 3;
  content.selectionEnd = 3;
  assert.equal(handoff.selectedEditorText(dom.window.document), ''); // 未选（:79）
  assert.equal(handoff.selectedEditorText(null), '');
  content.remove();
  assert.equal(handoff.selectedEditorText(dom.window.document), ''); // 无元素（:76）
});

// ---------- E10~E13 写后刷新与运行状态（chat-status.js ≙ :648-663＋:1948-2122） ----------
test('E10 refreshAfterWrite 四类映射与无书早退（:648-663）', async () => {
  const { status } = mods;
  const log = [];
  const hooks = {
    hasBook: () => true,
    getChapterId: () => 12,
    loadChapters: () => log.push('loadChapters'),
    selectChapter: (cid) => log.push(`selectChapter:${cid}`),
    loadCharacters: () => log.push('loadCharacters'),
    loadWorld: () => log.push('loadWorld'),
  };
  status.refreshAfterWrite('append_chapter', { chapterId: 12 }, hooks);
  assert.deepEqual(log, ['loadChapters', 'selectChapter:12']);
  log.length = 0;
  status.refreshAfterWrite('set_chapter_meta', { chapter: { id: 13 } }, hooks);
  assert.deepEqual(log, ['loadChapters']); // 非当前章：只刷列表（:654-657）
  log.length = 0;
  status.refreshAfterWrite('add_character', {}, hooks);
  assert.deepEqual(log, ['loadCharacters']);
  log.length = 0;
  status.refreshAfterWrite('add_worldview', {}, hooks);
  assert.deepEqual(log, ['loadWorld']);
  log.length = 0;
  status.refreshAfterWrite('read_chapter', {}, hooks);
  assert.deepEqual(log, []);
  status.refreshAfterWrite('append_chapter', {}, { ...hooks, hasBook: () => false });
  assert.deepEqual(log, []); // 无书早退（:650）
});

test('E11 resourceKey 逐字＋resourceNotice 文案/两动作（:1968-1970/:2027-2040）', async () => {
  const { status } = mods;
  assert.equal(status.resourceKey(7, 12), 'writing_resource:7:12');
  assert.equal(status.resourceKey(null, 12), 'writing_resource:?:12');
  const RS = { RESOURCE_BADGE: '资料更新' };
  const res = { title: '第1章 石碑', route: '#/book/7?chapter=12' };
  assert.equal(
    status.resourceNoticeFor(RS, res, 12, 7, { changed: false, first: false }),
    null,
  );
  assert.equal(
    status.resourceNoticeFor(RS, res, 12, 7, { changed: true, first: true }),
    null,
  );
  assert.deepEqual(
    status.resourceNoticeFor(RS, res, 12, 7, {
      changed: true,
      first: false,
      previous: { revision: 3 },
      current: { revision: 4 },
    }),
    {
      badge: '资料更新',
      detail:
        '《第1章 石碑》已被另一处更新（版本 3 → 4）：你的编辑器内容没有被覆盖。',
      actions: [
        { key: 'diff', label: '查看差异', href: '#/book/7?chapter=12' },
        { key: 'refresh', label: '刷新' },
      ],
    },
  );
  const noRev = status.resourceNoticeFor(RS, {}, 12, 7, {
    changed: true,
    first: false,
    previous: null,
    current: null,
  });
  assert.ok(noRev.detail.includes('版本 未记录 → 未记录'));
  assert.ok(noRev.detail.includes('《章节 #12》'));
  assert.equal(noRev.actions[0].href, '#/book/7'); // route 缺失回退（:2034）
});

test('E12 refreshRunStatus 参数合并与次序（:2044-2061）', async () => {
  const { status } = mods;
  const log = [];
  const host = { id: 'writing-run-card' };
  const RS = {
    RESOURCE_BADGE: '资料更新',
    runFromMessages: (msgs) => {
      log.push(`runFromMessages:${msgs.length}`);
      return msgs.length ? { status: 'paused' } : null;
    },
    loadPersistence: async () => log.push('loadPersistence'),
    observeResource: (key) => {
      log.push(`observeResource:${key}`);
      return { changed: false, first: false };
    },
    cardModel: (input) => {
      log.push(`cardModel:${input.run ? input.run.status : 'null'}`);
      return { badge: input.run ? '已暂停' : null };
    },
    mountTaskCard: (el, model) => log.push(`mountTaskCard:${model.badge}`),
  };
  const controller = status.createRunStatusController({
    RS: () => RS,
    host: () => host,
    api: async (method, url) => {
      log.push(`${method} ${url}`);
      return { resource: { title: '第1章', revision: 4 } };
    },
    toast() {},
    getBookId: () => 7,
    getChapterId: () => 12,
    getConversationId: () => 'conv-1',
    pageVisible: () => true,
    hasUnsavedChanges: () => false,
    selectChapter: () => null,
  });
  const snap = await controller.refreshRunStatus({ messages: [{ id: 1 }] });
  assert.equal(snap.status, 'paused');
  assert.deepEqual(log, [
    'runFromMessages:1',
    'loadPersistence',
    'GET /api/resources?type=chapter&bookId=7&id=12',
    'observeResource:writing_resource:7:12',
    'cardModel:paused',
    'mountTaskCard:已暂停',
  ]);
  // messages 为空 → runFromMessages 回 null 不覆盖；checkResource:false 跳过 GET
  log.length = 0;
  await controller.refreshRunStatus({ messages: [], checkResource: false });
  assert.deepEqual(log, [
    'runFromMessages:0',
    'loadPersistence',
    'cardModel:paused',
    'mountTaskCard:已暂停',
  ]);
  // o.run 覆盖快照（:2053）
  log.length = 0;
  await controller.refreshRunStatus({ run: { status: 'running' } });
  assert.ok(log.includes('cardModel:running'));
  assert.equal(controller.getSnapshot().status, 'running');
});

test('E13 watcher 策略与展示态开关（:2064-2116）', async () => {
  const { status } = mods;
  const watchers = [];
  const RS = {
    RESOURCE_BADGE: '资料更新',
    createWatcher: (cfg) => {
      const w = {
        cfg,
        started: false,
        stops: 0,
        start() {
          this.started = true;
        },
        stop() {
          this.stops += 1;
        },
      };
      watchers.push(w);
      return w;
    },
    runFromMessages: () => ({ status: 'running' }),
    loadPersistence: async () => {},
    observeResource: () => ({ changed: false, first: false }),
    cardModel: () => ({}),
    mountTaskCard: () => {},
  };
  const controller = status.createRunStatusController({
    RS: () => RS,
    host: () => ({ id: 'writing-run-card' }),
    api: async () => ({}),
    toast() {},
    getBookId: () => 7,
    getChapterId: () => 12,
    getConversationId: () => 'conv-1',
    pageVisible: () => true,
    hasUnsavedChanges: () => false,
    selectChapter: () => null,
  });
  // 无活跃运行：不建 run watcher；资料 watcher 8000 常驻（terminal:false）
  assert.equal(controller.syncRunWatcher(), null);
  controller.startStatusWatchers();
  assert.deepEqual(
    watchers.map((w) => w.cfg.intervalMs),
    [8000],
  );
  assert.equal(watchers[0].started, true);
  assert.equal(typeof watchers[0].cfg.isVisible, 'function');
  const terminal = await watchers[0].cfg.load();
  assert.equal(terminal.terminal, false);
  // 活跃运行（refreshRunStatus 带入 run）→ 建 5000；完成即停
  await controller.refreshRunStatus({ run: { status: 'running' }, checkResource: false });
  controller.syncRunWatcher();
  assert.deepEqual(
    watchers.map((w) => w.cfg.intervalMs),
    [8000, 5000],
  );
  const runWatcher = watchers[1];
  assert.equal((await runWatcher.cfg.load()).terminal, false);
  await controller.refreshRunStatus({ run: { status: 'finished' }, checkResource: false });
  assert.equal(controller.syncRunWatcher(), null);
  assert.equal(runWatcher.stops, 1);
  // 展示态开关：不可见 → 双停；可见 → 重建（幂等：已存在不重建）
  assert.equal(controller.setStatusPollingVisible(false), false);
  assert.equal(watchers[0].stops, 1);
  const before = watchers.length;
  controller.setStatusPollingVisible(true);
  assert.equal(watchers.length, before + 1); // 只剩资料 watcher 需重建（run 已结束）
  controller.setStatusPollingVisible(true);
  assert.equal(watchers.length, before + 1); // 幂等
  // RS 缺失：全静默
  const silent = status.createRunStatusController({
    RS: () => null,
    host: () => ({}),
    api: async () => ({}),
    getBookId: () => 7,
    getChapterId: () => 12,
  });
  assert.equal(silent.setStatusPollingVisible(true), null);
  assert.equal(await silent.refreshRunStatus({}), null);
  assert.equal(silent.renderRunCard(), null);
});

// ---------- E14 压缩/还原（chat-context.js ≙ :796-827） ----------
test('E14 压缩四节 bodyHTML＋压缩/还原请求体与 toast 逐字（:796-827）', async () => {
  const { context } = mods;
  const bodyHTML = context.compressBodyHTML();
  for (const s of [
    '【已确认的资料与设定】',
    '【已执行的动作与结果】',
    '【未决问题】',
    '【作者尚未采纳的设想】',
  ]) {
    assert.ok(bodyHTML.includes(s), s);
  }
  assert.ok(bodyHTML.includes('保留最近 8 条'));
  assert.ok(bodyHTML.includes('原消息不会删除，可在存档摘要处一键还原'));
  assert.equal(context.COMPRESS_TITLE, '压缩上下文');
  assert.equal(context.COMPRESS_OK_TEXT, '开始压缩');
  assert.equal(context.COMPRESSING_TOAST, '正在压缩…');
  assert.deepEqual(context.compressRequest('conv-1', 99), {
    method: 'POST',
    path: '/chat/compress',
    body: { conversationId: 'conv-1', expectedLastMessageId: 99 },
  });
  assert.deepEqual(context.restoreRequest('conv-1'), {
    method: 'POST',
    path: '/chat/compress/restore',
    body: { conversationId: 'conv-1' },
  });
  assert.equal(context.compressToast(3), '已压缩 3 条早期对话');
  assert.equal(context.restoreToast(2), '已还原 2 条归档对话');
});
