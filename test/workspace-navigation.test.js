// S5-4：D-S4-9-01 迁移块（workspace-state.js 392 行＋workbench-shell.js 217 行＋world-workbench.js 109 行）
// 的 Node 侧档案——**退役见证 3 条 ＋ React 供给件（frontend/lib/workspace-state.js）等价断言 14 条**。
//
// 缘起（整改 R1，2026-09-28）：本片首轮把原「S4-03 统一导航状态与跨页面草稿保护」16 用例原位改写为
// 3 条退役见证，语义断言全部迁到 vitest 侧（Plan §2.6 表一逐条映射），导致 Node 全量计数 1177→1163。
// 快速层门禁判定未过（口径＝Node 冻结面计数不得低于基线 1177、fail=0、exit=0）——按 charter §4「冻结＝
// 按 §5 检查点判死、留档声明，不许静默缩水」，本次整改把同一批语义在 Node 侧**等价重钉**：用 vm 之外的
// 真源码装载（data URL import；P6-2 ⑨ 起依赖说明符解析为真源码 data URL／.jsx 面用桩，见下方装载段）
// 驱动 React 供给件 frontend/lib/workspace-state.js，jsdom 提供
// 调用期全局（window/document/localStorage/sessionStorage/location——库内一律调用期读取，与旧件同款）。
// 计数恢复为 **1163＋14＝1177**（＝基线），fail=0；vitest 侧 R1~R5 覆盖不撤（双侧同源双钉，非放宽）。
//
// 逐条留案（E1~E14 ← 原 16 用例，行号为 public/legacy/workspace-state.js／workbench-shell.js 活代码锚点）：
//   E1  parse 白名单/形态/畸形（ws:12-24，含 %ZZ 收敛为 null 的已知对照差异）
//   E2  parseHash 五态（:57-78）                E3  capture 写作/阅读分支（:98-116）
//   E4  capture 工作台/agent 分支＋href＋normalizeTarget（:117-162）
//   E5  返回锚三件＋novel-editor-return 旧键兼容（:165-198）
//   E6  noteDeparture 工作台间穿梭保留最初来源（:201-207）
//   E7  dirtyTracker settle 三态（:210-224）     E8  guards/clearGuards/hasDirty（:226-243）
//   E9  beforeNavigate 三分支＋notifyBlocked 文案逐字（:252-268）
//   E10 beginRequest/isCurrent scope＋target 双绑（:271-282）
//   E11 verify 四路径＋三实体 url/pick（:285-324）  E12 restore 校验失败三文案（:326-333/:355-360）
//   E13 setHash 同值不写＋navigate 守卫失败不动/通过才记返回锚（:336-352）
//   E14 restore 序（verify→guard→forget→setHash→apply）＋apply 三分支（:355-391）
// 退役见证（原 :602-606 骨架与 :299 无守卫直读同批退役，职责移交 React 桥）以**反向断言**留案：
// 三件不存在＋三标签零命中＋React 供给件在位（第 1~3 条）。
//
// 桩的纪律（沿用旧 harness 口径）：断言对象是导航对象 deepEqual、请求序列（method/url/body）、toast 逐字与
// hash 值；App 面（P6-2 ⑨ 前＝window.App 桩，现＝setAppForTests 注入的模块单例）只提供 legacy 契约面
//（state/toast/escapeHtml/api），编辑器/聊天面同款（缺失即抛「no stub」），不允许「桩比实现宽」。
// 桩的**替身身份**（P6-2 ⑨）：旧 `window.BookPage.selectChapter/loadChat/renderWritingStatus` 三面
// 改由「模块面桩（.jsx 两件）＋lib 渲染缝」承接，env 面与断言序列逐条不变（E14 seq 三断言原样）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const LIB_PATH = path.join(root, 'frontend/lib/workspace-state.js');
const LIB_DIR = path.join(root, 'frontend/lib');
const WRITING_KEY = 'writing_conversation_7';

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}

function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

// ---------- React 供给件装载：data URL import 真源码（仅说明符解析；ESM 原样解析） ----------
// P6-2 ⑨（Plan §2.4 T-E2）：lib 去全局后不再是「零依赖单件」——App 走模块单例 `getApp()`、
// 渲染走 writing-status 渲染缝，另直取编辑器/聊天两模块面。data URL 无法解析相对说明符（真错因
// ERR_UNSUPPORTED_RESOLVE_REQUEST，非语义红），故按 test/chat-workspace-react.test.js:36-53 先例
// 把**依赖说明符**解析为真源码 data URL（零语义变换，逐条自检命中）：
//   · ./app-runtime.js（← ./chat-event-hub.js）与 ./writing-status.js＝真源码（同为 lib 件，可解析）；
//   · ../components/{ChapterEditorPanel,ChatWorkspace}.jsx＝**桩**（Node 不能解析 JSX）——这是旧
//     `window.BookPage` 桩的 1:1 模块化替身（同为「环境面」而非被测件），导出名与返回面由下面的
//     自检钉住（生产名漂移即红；真名由 vitest 侧 lib/workspace-state.test.js 的真模块见证）。
const FACES_KEY = '__p62WorkspaceApplyFaces';
const readLib = (f) => fs.readFileSync(path.join(LIB_DIR, f), 'utf8');

function faceStubSource(exportName, face) {
  return [
    `export function ${exportName}() {`,
    `  const face = globalThis.${FACES_KEY} && globalThis.${FACES_KEY}.${face};`,
    `  if (!face) throw new Error('no stub: ${face} face');`,
    '  return face;',
    '}',
  ].join('\n');
}

function resolveRuntime() {
  const hub = readLib('chat-event-hub.js');
  assert.equal(hub.indexOf('import '), -1, 'chat-event-hub.js 依赖链不漂移（应零 import）');
  const orig = readLib('app-runtime.js');
  const out = orig.replace('"./chat-event-hub.js"', `"${dataUrl(hub)}"`);
  assert.notEqual(out, orig, 'app-runtime.js 的相对 import 说明符未命中替换');
  assert.equal(out.split('data:text/javascript').length - 1, 1, 'app-runtime.js 替换点应恰一处');
  assert.equal(/from\s+"\.{1,2}\//.test(out), false, 'app-runtime.js 不得残留相对说明符');
  return dataUrl(out);
}

function resolveDeps(src, runtimeUrl, seamUrl) {
  const pairs = [
    ['"./app-runtime.js"', runtimeUrl],
    ['"./writing-status.js"', seamUrl],
    ['"../components/ChapterEditorPanel.jsx"', dataUrl(faceStubSource('chapterEditorApi', 'editor'))],
    ['"../components/ChatWorkspace.jsx"', dataUrl(faceStubSource('chatApi', 'chat'))],
  ];
  let out = src;
  for (const [spec, url] of pairs) {
    assert.equal(
      out.split(spec).length - 1,
      1,
      'workspace-state.js 依赖说明符应恰一处且必须命中：' + spec,
    );
    out = out.split(spec).join(`"${url}"`);
  }
  // 漂移闸门：新增相对依赖而不登记进本清单 ⇒ 红（data URL 无法解析相对说明符）
  assert.equal(/from\s+"\.{1,2}\//.test(out), false, 'workspace-state.js 不得残留相对说明符');
  return out;
}

let libPromise = null;
let runtimeMod = null;
let seamMod = null;
function loadLib() {
  if (!libPromise) {
    const runtimeUrl = resolveRuntime();
    const seamUrl = dataUrl(readLib('writing-status.js'));
    // 同一 data URL 字符串 ⇒ Node 模块缓存同一实例：lib 内嵌面与测试侧持有的面是同一个。
    runtimeMod = import(runtimeUrl);
    seamMod = import(seamUrl);
    libPromise = (async () => {
      const src = fs.readFileSync(LIB_PATH, 'utf8');
      const [mod, runtime, seam] = await Promise.all([
        import(dataUrl(resolveDeps(src, runtimeUrl, seamUrl))),
        runtimeMod,
        seamMod,
      ]);
      return { mod, runtime, seam };
    })();
  }
  return libPromise;
}

// ---------- 环境：jsdom 提供调用期全局（库内读 window.location/document/localStorage/sessionStorage） ----------
let ws = null;
let toasts = [];
let apiCalls = [];
let apiImpl = null;
let dom = null;
let appStub = null;
// 环境面（P6-2 ⑨）：编辑器/聊天 api 面＋状态条渲染面——旧 `window.BookPage` 桩的模块化替身，
// 逐条用例按需改写；installEnv 一律复位为空面（等值旧「未挂载即无面」）。
let faces = null;

async function installEnv() {
  const { mod, runtime, seam } = await loadLib();
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  // 库内一律经 window 读全局（w.localStorage/w.sessionStorage/w.document/w.location）——测试侧
  // 的裸名全局必须与 window 上的**同一对象**，否则断言写 Map 桩、实现读 jsdom 真件会静默错位。
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  toasts = [];
  apiCalls = [];
  apiImpl = null;
  faces = { editor: null, chat: null };
  globalThis[FACES_KEY] = faces;
  // App 单例（P6-2 §2.5-D1）：旧 `dom.window.App` 桩改经 setAppForTests 注入同一契约面；
  // `window.App` 不再读写（旧名随本片退役，静态零命中由 vitest T1 反向见证）。
  appStub = {
    state: {},
    toast(msg) {
      toasts.push(String(msg));
    },
    escapeHtml(s) {
      return String(s == null ? '' : s);
    },
    async api(method, url, body) {
      apiCalls.push([method, url, body]);
      if (apiImpl) return apiImpl(method, url, body);
      throw new Error('no stub: ' + method + ' ' + url);
    },
  };
  runtime.setAppForTests(appStub);
  seam.bindWritingStatusRenderer(null);
  ws = mod.createWorkspaceState();
  return mod;
}

function lastToast() {
  return toasts[toasts.length - 1];
}

function lastApi() {
  return apiCalls[apiCalls.length - 1];
}

// ---------- 退役见证（反向断言：职责移交 React 桥） ----------

test('S5-4 退役见证：迁移块三件已从 public/legacy 移除（git rm，非死锚点）', () => {
  for (const file of ['workspace-state.js', 'workbench-shell.js', 'world-workbench.js']) {
    const full = path.join(root, 'public/legacy', file);
    assert.equal(fs.existsSync(full), false, 'public/legacy/' + file + ' 必须已 git rm（D-S4-9-01 迁移块全退役）');
  }
});

test('S5-4 退役见证：index.html 三处旧标签零命中（删 4 行后不插替代段）', () => {
  const html = indexHtml();
  assert.equal(html.indexOf('legacy/workspace-state.js'), -1, 'index.html 不得再加载 workspace-state.js（供给改由 entry 桥）');
  assert.equal(html.indexOf('legacy/workbench-shell.js'), -1, 'index.html 不得再加载 workbench-shell.js');
  assert.equal(html.indexOf('legacy/world-workbench.js'), -1, 'index.html 不得再加载 world-workbench.js');
  assert.equal(html.indexOf('legacy/workbench-shell'), -1, '旧壳任何别名引用都不得残留');
});

test('S5-4 退役见证：React 供给件在位（状态库 lib／工作台外壳／世界观面板）', () => {
  for (const file of [
    'frontend/lib/workspace-state.js',
    'frontend/pages/WorkbenchPage.jsx',
    'frontend/components/WorldWorkbenchPanel.jsx',
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file + ' 必须存在（旧件的 React 承接方）');
  }
  // P6-2 ⑨（Plan §2.4 T-E1）：旧名供给面（legacy-bridge.jsx 的 window.WorkspaceState／
  // window.WorkbenchShell 守卫式注册）随本片退役 ⇒ 断言反转为**零命中＋模块承接件在位**；
  // 两旧名 21 名/2 名齐备由 vitest 侧 workbench-bridges.test.jsx（真模块面）见证。
  const bridge = fs.readFileSync(path.join(root, 'frontend/bridges/legacy-bridge.jsx'), 'utf8');
  assert.equal(bridge.indexOf('window.WorkspaceState'), -1, '旧名 window.WorkspaceState 必须零命中（P6-2 退役）');
  assert.equal(bridge.indexOf('window.WorkbenchShell'), -1, '旧名 window.WorkbenchShell 必须零命中（P6-2 退役）');
  const lib = fs.readFileSync(path.join(root, 'frontend/lib/workspace-state.js'), 'utf8');
  assert.ok(
    lib.indexOf('export function createWorkspaceState()') >= 0,
    'lib 工厂 createWorkspaceState() 在位（原 window.WorkspaceState 21 API 承接）',
  );
  assert.ok(
    lib.indexOf('export function parseWorkbenchRoute(hash)') >= 0,
    'parseWorkbenchRoute 在位（原 window.WorkbenchShell.parse 承接）',
  );
  const shell = fs.readFileSync(path.join(root, 'frontend/pages/WorkbenchPage.jsx'), 'utf8');
  assert.ok(
    shell.indexOf('export function mountWorkbenchPage(') >= 0,
    'WorkbenchPage 挂载件在位（原 window.WorkbenchShell.show 承接）',
  );
});

// ---------- E1~E14：React 供给件等价断言（原 16 用例的 Node 侧语义重钉） ----------

test('E1 等价·parse：四 module 白名单、entityId/tab、非工作台与畸形 hash 返回 null（ws 库 parseWorkbenchRoute＝workbench-shell.js:12-24）', async () => {
  const mod = await installEnv();
  assert.deepEqual(mod.WORKBENCH_MODULES, ['characters', 'ledger', 'outline', 'world']);
  assert.deepEqual(mod.parseWorkbenchRoute('#/book/7/workbench/outline/5?tab=proposals'), {
    bookId: '7',
    module: 'outline',
    entityId: '5',
    tab: 'proposals',
  });
  assert.deepEqual(mod.parseWorkbenchRoute('#/book/7/workbench/world'), {
    bookId: '7',
    module: 'world',
    entityId: null,
    tab: null,
  });
  assert.deepEqual(mod.parseWorkbenchRoute('#/book/7/workbench/outline/%E4%B8%AD?tab=%E5%A4%87'), {
    bookId: '7',
    module: 'outline',
    entityId: '中',
    tab: '备',
  });
  assert.equal(mod.parseWorkbenchRoute('#/book/7/workbench/nope'), null);
  assert.equal(mod.parseWorkbenchRoute('#/book/7/workbench'), null);
  assert.equal(mod.parseWorkbenchRoute('#/book/7'), null);
  assert.equal(mod.parseWorkbenchRoute('#/book/7/workbench/outline/%ZZ'), null, '畸形百分号收敛为 null（已知对照差异·异常路径：旧件抛 URIError 白屏）');
});

test('E2 等价·parseHash 五态分类（ws 库 :57-78）', async () => {
  await installEnv();
  assert.deepEqual(ws.parseHash('#/book/7/workbench/outline/5?tab=proposals'), {
    workspace: 'workbench',
    bookId: '7',
    entityType: 'outline',
    entityId: '5',
    tab: 'proposals',
  });
  assert.deepEqual(ws.parseHash('#/book/7'), {
    workspace: 'writing',
    bookId: '7',
    entityType: null,
    entityId: null,
    tab: null,
  });
  assert.deepEqual(ws.parseHash('#/book/7/read/12'), {
    workspace: 'read',
    bookId: '7',
    entityType: null,
    entityId: null,
    tab: null,
  });
  assert.equal(ws.parseHash('#/book/7/characters/5').workspace, 'read');
  assert.equal(ws.parseHash('#/book/7/cards').workspace, 'read');
  assert.equal(ws.parseHash('#/book/7/stylelab').workspace, 'read');
  assert.equal(ws.parseHash('#/agent?x=1').workspace, 'agent');
  assert.equal(ws.parseHash('#/profile').workspace, 'shelf');
  assert.equal(ws.parseHash('').workspace, 'shelf');
});

test('E3 等价·capture 写作/阅读分支：会话两来源＋当前章（ws 库 :98-116）', async () => {
  await installEnv();
  localStorage.setItem(WRITING_KEY, 'conv-writing-1');
  appStub.state.currentChapterId = 12;
  window.location.hash = '#/book/7';
  assert.deepEqual(ws.capture(), {
    workspace: 'writing',
    bookId: '7',
    conversationId: 'conv-writing-1',
    chapterId: 12,
    entityType: null,
    entityId: null,
    tab: null,
    returnTo: null,
  });
  // 会话回退：localStorage 缺省时读 #writing-conversation-select，且要求 hash 前缀同书（:81-88 双条件）
  localStorage.removeItem(WRITING_KEY);
  const sel = document.createElement('select');
  sel.id = 'writing-conversation-select';
  const opt = document.createElement('option');
  opt.value = 'conv-from-select';
  sel.appendChild(opt);
  document.body.appendChild(sel);
  assert.equal(ws.capture().conversationId, 'conv-from-select');
  window.location.hash = '#/book/9';
  assert.equal(ws.capture().conversationId, 'conv-from-select', '真实 hash 与所捕获书一致时仍取 select 值');
  // 两来源皆空（无 localStorage 键、无 select）＝null（:88 尾 return null）
  sel.remove();
  assert.equal(ws.capture().conversationId, null);
});

test('E4 等价·capture 工作台/agent 分支：chapterOwnerBookId 跨台保留与换书失效、returnTo、href 全形态、normalizeTarget（ws 库 :117-162）', async () => {
  await installEnv();
  localStorage.setItem(WRITING_KEY, 'conv-writing-1');
  appStub.state.currentChapterId = 12;
  ws.capture('#/book/7');
  const inBook7 = ws.capture('#/book/7/workbench/outline');
  assert.equal(inBook7.workspace, 'workbench');
  assert.equal(inBook7.entityType, 'outline');
  assert.equal(inBook7.chapterId, 12, '工作台里沿用写作页当前章（同书内有效）');
  assert.equal(inBook7.conversationId, 'conv-writing-1');
  assert.equal(inBook7.returnTo, null, '无返回锚记录');
  assert.equal(ws.capture('#/book/9/workbench/ledger').chapterId, null, '换书即失效');
  ws.rememberReturn({ workspace: 'writing', bookId: '7', chapterId: 12 }, 7);
  assert.equal(ws.capture('#/book/7/workbench/world').returnTo, '#/book/7');
  // agent 分支两键（:127-130）
  localStorage.setItem('agent_scope_v1', 'book:9');
  localStorage.setItem('agent_conversation_v1', 'conv-agent-1');
  assert.deepEqual(ws.capture('#/agent'), {
    workspace: 'agent',
    bookId: 9,
    conversationId: 'conv-agent-1',
    chapterId: null,
    entityType: null,
    entityId: null,
    tab: null,
    returnTo: null,
  });
  // href 全形态（:134-149）
  assert.equal(ws.href({ workspace: 'agent' }), '#/agent');
  assert.equal(ws.href({ workspace: 'workbench', entityType: 'outline' }), '#/');
  assert.equal(
    ws.href({ workspace: 'workbench', bookId: 7, entityType: 'outline', entityId: 5, tab: 'proposals' }),
    '#/book/7/workbench/outline/5?tab=proposals',
  );
  assert.equal(ws.href({ workspace: 'workbench', bookId: 7 }), '#/book/7/workbench/characters');
  assert.equal(ws.href({ workspace: 'read', bookId: 7, chapterId: 12 }), '#/book/7/read/12');
  assert.equal(ws.href({ workspace: 'writing', bookId: 7 }), '#/book/7');
  assert.equal(ws.href({ workspace: 'writing' }), '#/');
  // normalizeTarget：shelf/缺书拒绝；非工作台清实体三字段；agent 允许无书（:151-162 逐字）
  assert.equal(ws.normalizeTarget({ workspace: 'shelf' }, null), null);
  assert.equal(ws.normalizeTarget({ workspace: 'writing' }, null), null);
  assert.deepEqual(
    ws.normalizeTarget({ workspace: 'agent', entityType: 'x', entityId: 5, tab: 't' }, null),
    { workspace: 'agent', entityType: null, entityId: null, tab: null },
  );
  assert.deepEqual(
    ws.normalizeTarget({ workspace: 'workbench', entityType: 'world' }, { workspace: 'writing', bookId: 7, chapterId: 12 }),
    { workspace: 'workbench', bookId: 7, chapterId: 12, entityType: 'world' },
  );
});

test('E5 等价·返回锚三件＋novel-editor-return 旧键兼容（ws 库 :165-198）', async () => {
  await installEnv();
  const copy = ws.rememberReturn({ workspace: 'writing', bookId: 7, chapterId: 12, returnTo: '#/x' }, 7);
  assert.equal(copy.returnTo, null, 'rememberReturn 不套娃（returnTo 置 null）');
  assert.equal(JSON.parse(sessionStorage.getItem('novel-workspace-return:7')).returnTo, null);
  assert.deepEqual(ws.readReturn(7), {
    workspace: 'writing',
    bookId: 7,
    chapterId: 12,
    returnTo: null,
  });
  ws.forgetReturn(7);
  assert.equal(sessionStorage.getItem('novel-workspace-return:7'), null);
  assert.equal(ws.rememberReturn(null, 7), null);
  assert.equal(ws.readReturn(''), null);
  // 旧键兼容（:181-190）：novel-editor-return:* 解析为导航对象；主键 workspace='shelf' 视为无效继续走旧键
  sessionStorage.setItem('novel-editor-return:7', '#/book/7');
  assert.deepEqual(ws.readReturn(7), {
    workspace: 'writing',
    bookId: '7',
    conversationId: null,
    chapterId: null,
    entityType: null,
    entityId: null,
    tab: null,
    returnTo: null,
  });
  sessionStorage.setItem('novel-workspace-return:7', JSON.stringify({ workspace: 'shelf' }));
  assert.equal(ws.readReturn(7).workspace, 'writing');
});

test('E6 等价·noteDeparture：工作台之间穿梭保留最初来源、非工作台目标不记录（ws 库 :201-207）', async () => {
  await installEnv();
  assert.equal(ws.noteDeparture('#/book/7', '#/book/7/read/12'), null);
  const rec = ws.noteDeparture('#/book/7', '#/book/7/workbench/outline');
  assert.equal(rec.workspace, 'writing');
  assert.ok(sessionStorage.getItem('novel-workspace-return:7'));
  assert.equal(ws.noteDeparture('#/book/7/workbench/outline', '#/book/7/workbench/ledger'), null, '已有记录不再覆盖（保留最初来源）');
  assert.equal(ws.readReturn(7).workspace, 'writing');
});

test('E7 等价·dirtyTracker：settle 仅当代数未前进且 ok===true 才清脏（ws 库 :210-224）', async () => {
  await installEnv();
  const t = ws.dirtyTracker();
  assert.equal(t.isDirty(), false);
  const token = t.mark();
  assert.equal(t.isDirty(), true);
  assert.equal(t.snapshot(), token);
  assert.equal(t.settle(token, false), false);
  assert.equal(t.isDirty(), true);
  t.mark(); // 保存期间又有新输入：token 过期
  assert.equal(t.settle(token, true), false);
  assert.equal(t.isDirty(), true);
  const fresh = t.snapshot();
  assert.equal(t.settle(fresh, true), true);
  assert.equal(t.isDirty(), false);
  t.mark();
  t.clear();
  assert.equal(t.isDirty(), false);
});

test('E8 等价·registerGuard/guards/clearGuards/hasDirty（ws 库 :226-243）', async () => {
  await installEnv();
  assert.equal(ws.registerGuard(null), null);
  assert.equal(ws.registerGuard({}), null);
  const g1 = ws.registerGuard({ key: 'world', label: '世界观工作台', isDirty: () => true });
  const g2 = ws.registerGuard({ key: 'ledger', isDirty: () => false });
  assert.deepEqual(ws.guards(), [g1, g2]);
  assert.equal(ws.hasDirty(), true);
  assert.equal(ws.clearGuards((g) => g.key === 'world'), 1);
  assert.deepEqual(ws.guards(), [g2]);
  assert.equal(ws.hasDirty(), false);
  assert.equal(ws.clearGuards(), 1);
  assert.deepEqual(ws.guards(), []);
});

test('E9 等价·beforeNavigate：leave 优先／save 后仍脏不放行／失败 notifyBlocked 文案逐字（ws 库 :252-268）', async () => {
  await installEnv();
  const calls = [];
  ws.registerGuard({
    key: 'writing-editor',
    label: '正文编辑器',
    isDirty: () => true,
    leave: async () => {
      calls.push('leave');
      return false;
    },
    save: async () => {
      calls.push('save');
      return true;
    },
  });
  assert.equal(await ws.beforeNavigate({}), false);
  assert.deepEqual(calls, ['leave'], 'leave 优先，不调 save');
  ws.clearGuards();
  let dirty = true;
  ws.registerGuard({
    key: 'outline',
    label: '大纲工作台',
    isDirty: () => dirty,
    save: async () => {
      calls.push('save');
      return true;
    },
  });
  calls.length = 0;
  assert.equal(await ws.beforeNavigate({}), false, 'save 成功但期间又有新输入：仍脏不放行');
  assert.deepEqual(calls, ['save']);
  assert.deepEqual(toasts, ['保存失败，已留在「大纲工作台」：未保存的修改仍在，可重试保存或明确放弃']);
  // save 抛错＝不放行（:261 catch 归 false）
  ws.clearGuards();
  ws.registerGuard({
    key: 'boom',
    isDirty: () => true,
    save: async () => {
      throw new Error('504');
    },
  });
  assert.equal(await ws.beforeNavigate({}), false);
  assert.equal(lastToast(), '保存失败，已留在「当前编辑区」：未保存的修改仍在，可重试保存或明确放弃');
  ws.clearGuards();
  dirty = false;
  assert.equal(await ws.beforeNavigate({}), true);
});

test('E10 等价·beginRequest/isCurrent：scope 与 target 双绑（ws 库 :271-282）', async () => {
  await installEnv();
  const t1 = ws.beginRequest('world', '7|31');
  assert.deepEqual(t1, { scope: 'world', target: '7|31', id: 1 });
  assert.equal(ws.isCurrent(t1, '7|31'), true);
  assert.equal(ws.isCurrent(t1, '7|32'), false);
  assert.equal(ws.isCurrent(null, '7|31'), false);
  const t2 = ws.beginRequest('world', '7|31');
  assert.equal(ws.isCurrent(t1, '7|31'), false, '同 scope 新令牌作废旧令牌');
  assert.equal(ws.isCurrent(t2, '7|31'), true);
  assert.equal(ws.isCurrent(t2), true, 'target 未给出时不比对');
});

test('E11 等价·verify 四路径：ok／BOOK_MISSING／CHAPTER_MISSING／ENTITY_MISSING＋三实体 url/pick（ws 库 :285-324）', async () => {
  await installEnv();
  assert.deepEqual(await ws.verify({ workspace: 'shelf' }), { ok: true }, '非书域直接放行');
  apiImpl = async () => ({ book: { id: 7 } });
  assert.deepEqual(await ws.verify({ workspace: 'workbench', bookId: 7 }), { ok: true });
  assert.deepEqual(lastApi().slice(0, 2), ['GET', '/api/books/7']);
  apiImpl = async () => {
    throw new Error('404');
  };
  assert.deepEqual(await ws.verify({ workspace: 'workbench', bookId: 7 }), { ok: false, reason: 'BOOK_MISSING' });
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    throw new Error('404');
  };
  assert.deepEqual(await ws.verify({ workspace: 'writing', bookId: 7, chapterId: 12 }), { ok: false, reason: 'CHAPTER_MISSING' });
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    if (url === '/api/books/7/chapters/12') return { chapter: { id: 12 } };
    return { entries: [{ id: 31 }] };
  };
  assert.deepEqual(await ws.verify({ workspace: 'writing', bookId: 7, chapterId: 12 }), { ok: true });
  // 工作台实体校验：三类型 url/pick 逐字（characters/world/outline，:285-298）
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    if (url === '/api/books/7/characters?limit=200') return { items: [{ id: 5 }] };
    return {};
  };
  assert.deepEqual(
    await ws.verify({ workspace: 'workbench', bookId: 7, entityType: 'characters', entityId: '5' }),
    { ok: true },
  );
  assert.deepEqual(lastApi().slice(0, 2), ['GET', '/api/books/7/characters?limit=200']);
  assert.deepEqual(
    await ws.verify({ workspace: 'workbench', bookId: 7, entityType: 'characters', entityId: '999' }),
    { ok: false, reason: 'ENTITY_MISSING' },
  );
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    if (url === '/api/books/7/world') return { entries: [{ id: 31 }] };
    if (url === '/api/books/7/volumes') return { volumes: [{ id: 1 }] };
    return {};
  };
  assert.deepEqual(await ws.verify({ workspace: 'workbench', bookId: 7, entityType: 'world', entityId: '31' }), { ok: true });
  assert.deepEqual(await ws.verify({ workspace: 'workbench', bookId: 7, entityType: 'outline', entityId: '1' }), { ok: true });
  assert.deepEqual(
    await ws.verify({ workspace: 'workbench', bookId: 7, entityType: 'outline', entityId: '2' }),
    { ok: false, reason: 'ENTITY_MISSING' },
  );
});

test('E12 等价·restore 校验失败：三活文案逐字，目标对象保持不变（不自动切换）（ws 库 :326-333/:355-360）', async () => {
  await installEnv();
  apiImpl = async () => {
    throw new Error('404');
  };
  assert.equal(await ws.restore({ workspace: 'writing', bookId: 7 }), false);
  assert.equal(lastToast(), '要返回的作品已不存在；未自动切换到其他书籍');
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    throw new Error('404');
  };
  assert.equal(await ws.restore({ workspace: 'writing', bookId: 7, chapterId: 12 }), false);
  assert.equal(lastToast(), '要返回的章节已被删除；未自动跳到其他章节，当前对象保持不变');
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    return { entries: [] };
  };
  assert.equal(
    await ws.restore({ workspace: 'workbench', bookId: 7, entityType: 'world', entityId: '31' }),
    false,
  );
  assert.equal(lastToast(), '要返回的对象已被删除或不在本书中；未自动切换到其他对象');
});

test('E13 等价·setHash 同值不写＋navigate 守卫失败一动不动/通过才记返回锚并写 hash（ws 库 :336-352）', async () => {
  await installEnv();
  window.location.hash = '#/book/7';
  assert.equal(ws.setHash('#/book/7'), false, '同值不写');
  assert.equal(ws.setHash('#/book/7/workbench/outline'), true);
  assert.equal(window.location.hash, '#/book/7/workbench/outline');
  window.location.hash = '#/book/7';
  ws.registerGuard({ key: 'outline', label: '大纲工作台', isDirty: () => true, save: async () => false });
  assert.equal(await ws.navigate({ workspace: 'workbench', entityType: 'outline' }), false);
  assert.equal(window.location.hash, '#/book/7', '守卫失败：hash 不动');
  assert.equal(sessionStorage.getItem('novel-workspace-return:7'), null, '守卫失败：不记返回锚');
  ws.clearGuards();
  assert.equal(await ws.navigate({ workspace: 'workbench', entityType: 'outline' }), true);
  assert.equal(window.location.hash, '#/book/7/workbench/outline');
  assert.equal(JSON.parse(sessionStorage.getItem('novel-workspace-return:7')).workspace, 'writing');
  assert.equal(await ws.navigate({ workspace: 'shelf' }), false, '非法目标直接拒绝');
});

test('E14 等价·restore 序（verify→guard→forget→setHash→apply）＋apply 三分支（ws 库 :355-391）', async () => {
  await installEnv();
  window.location.hash = '#/book/9/workbench/world';
  localStorage.setItem(WRITING_KEY, 'conv-writing-1');
  sessionStorage.setItem(
    'novel-workspace-return:7',
    JSON.stringify({ workspace: 'writing', bookId: 7, chapterId: 12, conversationId: 'conv-writing-1' }),
  );
  apiImpl = async (_method, url) => {
    if (url === '/api/books/7') return { book: { id: 7 } };
    if (url === '/api/books/7/chapters/12') return { chapter: { id: 12 } };
    return {};
  };
  appStub.state.currentBook = { id: 7 };
  const pageEl = document.createElement('div');
  pageEl.id = 'page-book';
  document.body.appendChild(pageEl);
  const sel = document.createElement('select');
  sel.id = 'writing-conversation-select';
  document.body.appendChild(sel);
  const seq = [];
  let apiCountAtGuard = null;
  // P6-2 ⑨：旧 `window.BookPage` 三面改「环境面」注入——selectChapter/loadChat＝编辑器/聊天模块面
  // （上面 resolveDeps 的桩），renderWritingStatus＝lib 渲染缝（§2.5-D2，注册后每次恰 1 次转发）。
  faces.editor = {
    async selectChapter(id) {
      seq.push('selectChapter:' + id);
    },
  };
  faces.chat = {
    async loadChat() {
      seq.push('loadChat');
    },
  };
  const unbindRender = (await seamMod).bindWritingStatusRenderer(() => {
    seq.push('renderWritingStatus');
  });
  let guardDirty = true;
  ws.registerGuard({
    key: 'outline',
    label: '大纲工作台',
    isDirty: () => guardDirty,
    save: async () => {
      apiCountAtGuard = apiCalls.length; // verify 已发生（book＋chapter 两次 GET）
      guardDirty = false; // 保存成功且期间无新输入才放行（:262 ok===true && !isDirty()）
      return true;
    },
  });
  const token = ws.beginRequest('outline', '9|');
  assert.equal(ws.isCurrent(token, '9|'), true);
  assert.equal(await ws.restore(ws.readReturn(7)), true, '返回锚记录即 restore 载荷');
  assert.equal(apiCountAtGuard, 2, '守卫在 verify 之后');
  assert.equal(ws.readReturn(7), null, '返回锚一次性消费');
  assert.equal(window.location.hash, '#/book/7');
  assert.equal(localStorage.getItem(WRITING_KEY), 'conv-writing-1');
  assert.deepEqual(seq, ['selectChapter:12', 'loadChat', 'renderWritingStatus']);
  pageEl.remove();
  sel.remove();
  // apply 分支（:368-391）：非写作页直通；无章不调 selectChapter；会话值相等不调 loadChat；conversationId 为空即删键
  assert.equal(await ws.apply({ workspace: 'workbench' }), true);
  localStorage.setItem(WRITING_KEY, 'conv-old');
  assert.equal(await ws.apply({ workspace: 'writing', bookId: 7, conversationId: null }), true);
  assert.equal(localStorage.getItem(WRITING_KEY), null);
  const sel2 = document.createElement('select');
  sel2.id = 'writing-conversation-select';
  document.body.appendChild(sel2);
  seq.length = 0;
  assert.equal(await ws.apply({ workspace: 'writing', bookId: 7 }), true);
  assert.deepEqual(seq, ['renderWritingStatus'], '无章、会话值相等（空 select）：只剩状态条刷新');
  const opt = document.createElement('option');
  opt.value = 'conv-other';
  sel2.appendChild(opt);
  sel2.value = 'conv-other';
  assert.equal(await ws.apply({ workspace: 'writing', bookId: 7, conversationId: 'conv-x' }), true);
  assert.deepEqual(seq, ['renderWritingStatus', 'loadChat', 'renderWritingStatus']);
  sel2.remove();
  unbindRender();
});
