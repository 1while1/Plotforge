// S5-10（Plan §5.1 冻结测试转写映射；charter §2 豁免流程）：S4-05「统一可见状态，不再依靠聊天话术
// 猜结果」页面回归的 React 侧等价重钉。
//
// 缘起：public/legacy/run-status.js（666 行）本片 git rm 全退役，纯逻辑/单例状态/命令式渲染逐字
// 迁入 frontend/lib/run-status.js（createRunStatus(deps) 全注入：doc/app/bookPage），旧名
// window.RunStatus 由 legacy-bridge.jsx 守卫式承接。旧 9 例 → 新 9 例＝1 条退役见证＋8 条等价
// （旧断言逐字保留，仅装载源与宿主由 vm 真源码改为 lib 实例注入；去 book.js 胶水＝renderWritingStatus
// 拆成 runStatus.renderWritingSaveBadge 直调，React 等价物在 BookShell.renderWritingStatus，
// 另由 BookShell.test.jsx R8-2/R8-3 承接）。
//
// 钉住（原口径逐条沿用）：
//   1) 统一任务卡：正在读取/执行、待确认、已拒绝、已暂停、失败、中断、完成七种徽标；
//      length 截断必须显示「已暂停」而不是「完成」；完成必须带可查看的结果引用；
//      工具细节默认折叠，展开可见「目标」与「来源版本」（缺字段写「未提供」，不臆造）。
//   2) 保存状态独立三分：本地未保存 / 已应用未落盘 / 已保存；任务 finished 不等于当前新输入
//      已经保存；S1 的 503 PERSISTENCE_PENDING 之后徽标必须是「已应用未落盘」。
//   3) 另一空间改了当前资料：只提示「资料更新」并给「查看差异 / 刷新」；脏正文不被覆盖。
//   4) 刷新后从服务端 run/action 重建（GET /chat 的 message.run 快照），不由浏览器上一条气泡猜；
//      网络中断显示「未知（待恢复）」，不臆造失败或成功。
//   5) 状态查询按需或页面可见时低频轮询，完成后停止；不接受秒级轮询。
//
// 桩的纪律（沿用 S4-04b 口径）：document.getElementById 请求 frontend/index.html 里不存在的 id
// 会被记入 missingIds 并返回 null，用例显式断言 missingIds 为空——不允许「桩比页面宽」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const RS_LIB = path.join(root, 'frontend/lib/run-status.js');
const RS_LEGACY = path.join(root, 'public/legacy/run-status.js');
const BRIDGE = path.join(root, 'frontend/bridges/legacy-bridge.jsx');

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}
function indexIds() {
  const ids = new Set();
  const re = /id="([^"]+)"/g;
  let m = re.exec(indexHtml());
  while (m) { ids.add(m[1]); m = re.exec(indexHtml()); }
  return ids;
}
const CLIENT_IDS = indexIds();
const HTML = indexHtml();

// S4-05 必须提供的骨架（断言打在真实 index.html 上）
const REQUIRED_IDS = ['writing-run-card', 'agent-run-card', 'workbench-notify', 'workbench-notify-pop', 'workbench-notify-title', 'workbench-notify-body', 'workbench-notify-link', 'workbench-toast', 'writing-status-save'];

// 装载：data-URL import 真源码（仅说明符解析；test/chat-workspace-react.test.js:32 先例）。
// P6-2 ⑨（Plan §2.4 T-E3）：run-status.js 去全局后经模块单例取 App（`getApp()`）并直取写作状态缝，
// 不再是「零依赖单件」；data URL 无法解析相对说明符（真错因 ERR_UNSUPPORTED_RESOLVE_REQUEST），
// 故把依赖说明符解析为真源码 data URL（零语义变换，逐条自检命中）。
function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

function readFe(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function libSource() {
  const hub = readFe('frontend/lib/chat-event-hub.js');
  assert.equal(hub.indexOf('import '), -1, 'chat-event-hub.js 依赖链不漂移（应零 import）');
  const runtimeOrig = readFe('frontend/lib/app-runtime.js');
  const runtime = runtimeOrig.replace('"./chat-event-hub.js"', '"' + dataUrl(hub) + '"');
  assert.notEqual(runtime, runtimeOrig, 'app-runtime.js 的相对 import 说明符未命中替换');
  let src = readFe('frontend/lib/run-status.js');
  const pairs = [
    ['"./app-runtime.js"', dataUrl(runtime)],
    ['"./writing-status.js"', dataUrl(readFe('frontend/lib/writing-status.js'))],
  ];
  for (const [spec, url] of pairs) {
    assert.equal(src.split(spec).length - 1, 1, 'run-status.js 依赖说明符应恰一处且必须命中：' + spec);
    src = src.split(spec).join('"' + url + '"');
  }
  // 漂移闸门：新增相对依赖而不登记进本清单 ⇒ 红
  assert.equal(/from\s+"\.{1,2}\//.test(src), false, 'run-status.js 不得残留相对说明符');
  return src;
}

let modPromise = null;
function loadLib() {
  if (!modPromise) modPromise = import(dataUrl(libSource()));
  return modPromise;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

function harness(opts) {
  const o = opts || {};
  const nodes = new Map();
  const dyn = new Map();
  const missing = new Set();
  const requests = [];
  const toasts = [];
  const modals = [];

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], parent: null,
      dataset: {}, style: {}, _classes: new Set(), _text: '',
      listeners: {}, disabled: false, title: '', value: '', href: '', open: false,
      checked: false, selected: false, scrollTop: 0, scrollHeight: 0, onclick: null,
      selectionStart: 0, selectionEnd: 0,
    };
    Object.defineProperty(el, 'id', {
      get() { return el._id || ''; },
      set(v) { el._id = String(v || ''); if (el._id) dyn.set(el._id, el); },
    });
    Object.defineProperty(el, 'className', {
      get() { return Array.from(el._classes).join(' '); },
      set(v) { el._classes = new Set(String(v == null ? '' : v).split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(el, 'textContent', {
      get() { return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
      set(v) { el.children.forEach(c => { c.parent = null; }); el.children = []; el._text = String(v == null ? '' : v); },
    });
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._text; },
      set(v) {
        el.children.forEach(c => { c.parent = null; });
        el.children = [];
        el._text = '';
        parseHTML(el, String(v == null ? '' : v));
      },
    });
    Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'parentNode', { get() { return el.parent; } });
    Object.defineProperty(el, 'nextSibling', {
      get() {
        if (!el.parent) return null;
        const i = el.parent.children.indexOf(el);
        return i < 0 ? null : (el.parent.children[i + 1] || null);
      },
    });
    el.classList = {
      add() { for (const c of arguments) el._classes.add(c); },
      remove() { for (const c of arguments) el._classes.delete(c); },
      toggle(c, force) {
        const on = force === undefined ? !el._classes.has(c) : !!force;
        if (on) el._classes.add(c); else el._classes.delete(c);
        return on;
      },
      contains(c) { return el._classes.has(c); },
    };
    el.appendChild = child => { child.parent = el; el.children.push(child); return child; };
    el.insertBefore = (child, ref) => {
      child.parent = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(child); else el.children.splice(i, 0, child);
      return child;
    };
    el.remove = () => {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    };
    el.querySelector = sel => descendants(el).find(n => matches(n, sel)) || null;
    el.querySelectorAll = sel => descendants(el).filter(n => matches(n, sel));
    el.addEventListener = (name, fn) => {
      if (!el.listeners[name]) el.listeners[name] = [];
      el.listeners[name].push(fn);
    };
    el.removeEventListener = () => {};
    el.setAttribute = () => {};
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    return el;
  }

  function matches(el, sel) {
    if (!sel) return false;
    if (sel.charAt(0) === '.') return el._classes && el._classes.has(sel.slice(1));
    if (sel.charAt(0) === '#') return el.id === sel.slice(1);
    if (sel.charAt(0) === '[') return true;
    return el.tagName === String(sel).toUpperCase();   // 标签名选择器（querySelectorAll('a') 等）
  }
  function descendants(el) {
    const out = [];
    for (const c of el.children || []) {
      if (!c._classes) continue;
      out.push(c, ...descendants(c));
    }
    return out;
  }
  // 极简 innerHTML 解析：够页面自己的固定模板用
  function parseHTML(host, html) {
    const stack = [host];
    const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)\/?>/g;
    let last = 0;
    let m;
    for (;;) {
      m = re.exec(html);
      if (!m) break;
      const text = html.slice(last, m.index);
      if (text.trim()) pushText(stack[stack.length - 1], text);
      last = re.lastIndex;
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const attrs = m[3] || '';
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
        }
        continue;
      }
      if (tag === 'script' || tag === 'style') continue;
      const node = makeEl(tag);
      applyAttrs(node, attrs);
      stack[stack.length - 1].appendChild(node);
      if (tag !== 'br' && tag !== 'input' && tag !== 'img') stack.push(node);
    }
    const tail = html.slice(last);
    if (tail.trim()) pushText(stack[stack.length - 1], tail);
  }
  function pushText(parent, text) {
    parent.children.push({ nodeType: 3, textContent: String(text), children: [], parent });
  }
  function applyAttrs(node, attrs) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    for (;;) {
      m = re.exec(attrs);
      if (!m) break;
      const name = m[1];
      const val = m[2] === undefined ? '' : m[2];
      if (name === 'class') node.className = val;
      else if (name === 'id') node.id = val;
      else if (name === 'value') node.value = val;
      else if (name === 'checked') node.checked = true;
      else if (name === 'disabled') node.disabled = true;
      else if (name.indexOf('data-') === 0) {
        node.dataset[name.slice(5).replace(/-([a-z])/g, (s, c) => c.toUpperCase())] = val;
      }
    }
  }

  const doc = {
    getElementById(id) {
      if (nodes.has(id)) return nodes.get(id);
      if (dyn.has(id)) return dyn.get(id);
      if (!CLIENT_IDS.has(id)) { missing.add(id); return null; }
      const el = makeEl('div');
      el.id = id;
      delete dyn[id];
      nodes.set(id, el);
      return el;
    },
    createElement: makeEl,
    createTextNode: t => ({ nodeType: 3, textContent: String(t == null ? '' : t), children: [] }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    head: null,
    hidden: false,
  };

  function fetchStub(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    const req = { method, url: String(url), body };
    requests.push(req);
    const r = o.route ? o.route(req) : null;
    if (!r) return jsonResponse({ error: { code: 'STUB_NO_ROUTE', message: 'no stub route: ' + url } }, 404);
    if (r.sse) return new Response(r.sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return jsonResponse(r.body, r.status || 200);
  }

  const App = {
    state: o.state || {},
    toast(msg) { toasts.push(String(msg)); },
    escapeHtml(s) {
      if (s == null) return '';
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    async api(method, url, body) {
      const res = await fetchStub(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        let parsed = null;
        try { parsed = await res.json(); } catch (e) { /* 非 JSON */ }
        const e2 = parsed && parsed.error;
        const err = new Error((e2 && (e2.message || e2.code)) || (typeof e2 === 'string' ? e2 : '') || ('请求失败 ' + res.status));
        if (parsed && parsed.code) err.code = parsed.code;
        else if (e2 && e2.code) err.code = e2.code;
        err.status = res.status;
        err.details = parsed && parsed.details;
        err.body = parsed;
        throw err;
      }
      return res.json();
    },
    openModal(opts) { modals.push({ title: opts.title, okText: opts.okText, bodyHTML: opts.bodyHTML || '', onOk: opts.onOk }); },
    closeModal() {},
  };

  const storage = new Map();
  const session = new Map();
  function storageOf(map) {
    return {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k),
    };
  }

  // 写作页骨架：脏标记与保存管道的真实实现在 React 编辑器（ChapterEditorPanel）里，
  // 这里只提供 hasUnsavedChanges 页面级入口作为可编程输入（等值旧 book.js 消费面）。
  const page = {
    dirty: false,
    reloads: [],
    hasUnsavedChanges() { return !!page.dirty; },
    selectChapter(id) { page.reloads.push(id); return Promise.resolve(true); },
  };

  const allButtons = () => Array.from(dyn.values()).filter(el => el.tagName === 'BUTTON' || el.tagName === 'A');

  return {
    App, doc, requests, toasts, modals, storage, session, page, bookPage: page,
    node: id => doc.getElementById(id),
    text: id => { const n = doc.getElementById(id); return n ? n.textContent : null; },
    missingIds: () => Array.from(missing),
    storageGet: k => (storage.has(k) ? storage.get(k) : null),
    clickText(label) {
      const hit = allButtons().find(el => el.textContent.indexOf(label) >= 0 && typeof el.onclick === 'function');
      assert.ok(hit, '必须提供可点击的「' + label + '」入口（现有按钮：' + allButtons().map(b => b.textContent).join(' / ') + '）');
      hit.onclick({ preventDefault() {} });
      return hit;
    },
    fire(id, type) {
      const n = doc.getElementById(id);
      if (!n) return 0;
      const fns = (n.listeners[type] || []).slice();
      fns.forEach(fn => {
        fn({ preventDefault() {} });
      });
      if (n.onclick && type === 'click') n.onclick({ preventDefault() {} });
      return fns.length + (n.onclick && type === 'click' ? 1 : 0);
    },
  };
}

// React 侧实例（全注入；等价旧「vm 装载真源码 + window.App/BookPage/document 全局」）
async function instanceOf(h) {
  const mod = await loadLib();
  return mod.createRunStatus({ doc: h.doc, app: h.App, bookPage: h.bookPage });
}

// ---------- 退役见证 ----------

test('S5-10 退役见证：run-status.js 不在盘、index.html 零命中；三处任务卡容器与状态条保存徽标仍在；React 供给件在位', async () => {
  assert.equal(fs.existsSync(RS_LEGACY), false, 'public/legacy/run-status.js 必须已退役（git rm）');
  assert.equal(/legacy\/run-status\.js/.test(HTML), false, 'index.html 不得再加载 run-status.js（React 供给）');
  const missing = REQUIRED_IDS.filter(id => !CLIENT_IDS.has(id));
  assert.deepEqual(missing, [], 'index.html 必须提供真实 id：' + missing.join(', '));
  assert.ok(HTML.indexOf('id="writing-run-card"') > 0, '写作页必须有 #writing-run-card');
  assert.ok(HTML.indexOf('id="agent-run-card"') > 0, 'Agent 台必须有 #agent-run-card');
  assert.ok(HTML.indexOf('id="workbench-notify"') > 0, '工作台必须有 #workbench-notify（任务提示铃铛：Toast + 铃铛回看形态）');
  // React 供给件在位：lib 双导出＋桥守卫式旧名承接恰一处
  const mod = await loadLib();
  assert.equal(typeof mod.createRunStatus, 'function', 'frontend/lib/run-status.js 必须导出 createRunStatus(deps)');
  assert.equal(typeof mod.runStatus.taskBadge, 'function', '浏览器单例 runStatus 必须在位');
  // P6-2 ⑨（Plan §2.4 T-E3）：旧名承接面（legacy-bridge.jsx 恰一处 `window.RunStatus = runStatus`）
  // 随本片退役 ⇒ 断言反转为**零命中＋lib 单例被消费方直取**（vitest 侧 run-status 面由
  // frontend/lib/workspace-state.test.js／WorkbenchPage.test.jsx 的真模块见证）。
  const bridge = fs.readFileSync(BRIDGE, 'utf8');
  assert.equal((bridge.match(/window\.RunStatus\b/g) || []).length, 0, '旧名 window.RunStatus 必须零命中（P6-2 退役）');
  assert.equal(bridge.indexOf('window.RunStatus'), -1, '桥不得再出现 window.RunStatus（含守卫与赋值）');
  for (const rel of [
    'frontend/pages/BookShell.jsx',
    'frontend/pages/WorkbenchPage.jsx',
    'frontend/components/AgentWorkspace.jsx',
    'frontend/hooks/use-chat-workspace.js',
  ]) {
    assert.ok(
      /import \{ runStatus \} from "\.\.\/lib\/run-status\.js";/.test(readFe(rel)),
      rel + ' 必须经 lib 单例直取 runStatus（原 window.RunStatus 消费方）',
    );
  }
});

// ---------- 任务卡 ----------

test('任务徽标覆盖七种状态；length 截断显示「已暂停」而不是「完成」', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  const taskBadgeForLength = RS.taskBadge({ status: 'paused', reason: 'output_truncated' });
  assert.equal(taskBadgeForLength, '已暂停');
  assert.equal(RS.taskBadge({ status: 'paused', reason: 'result_budget' }), '已暂停');
  assert.equal(RS.taskBadge({ status: 'paused', reason: 'action_rejected' }), '已拒绝');
  assert.equal(RS.taskBadge({ status: 'running' }), '正在读取/执行');
  assert.equal(RS.taskBadge({ status: 'awaiting_confirmation' }), '待确认');
  assert.equal(RS.taskBadge({ status: 'failed', reason: 'upstream_error' }), '失败');
  assert.equal(RS.taskBadge({ status: 'interrupted', reason: 'server_restart' }), '中断');
  assert.equal(RS.taskBadge({ status: 'cancelled', reason: 'user_abort' }), '已停止');
  assert.equal(RS.taskBadge({ status: 'finished' }), '完成');
  // 无运行记录（刷新后还读不到 / 状态不认识）不得被当成「完成」
  assert.equal(RS.taskBadge(null), '未知（待恢复）');
  assert.equal(RS.taskBadge({ status: 'weird' }), '未知（待恢复）');
});

test('任务卡：完成必须带可查看的结果引用；工具细节默认折叠、展开可见目标与来源版本', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  const host = h.node('writing-run-card');
  assert.ok(host, '#writing-run-card 必须存在');

  const model = RS.cardModel({
    run: { id: 'run_1', status: 'finished', reason: null },
    conversationId: 'w-7-a',
    events: [
      { runId: 'run_1', seq: 1, type: 'phase', payload: { kind: 'tool', name: 'append_chapter' } },
      { runId: 'run_1', seq: 2, type: 'tool_result', payload: { name: 'append_chapter', result: { ok: true, chapter: { id: 41, revision: 7 } } } },
      { runId: 'run_1', seq: 3, type: 'run_finished', payload: { status: 'finished', resultRefs: [{ kind: 'chapter', id: 41, route: '#/book/7/read/41' }] } },
    ],
    tools: [{ name: 'append_chapter', args: { book_id: 7, chapter_id: 41 }, result: { ok: true, chapter: { id: 41, revision: 7 } } }],
  });
  assert.equal(model.badge, '完成');
  assert.equal(model.hasResultRefs, true, '完成必须带可查看的结果引用（契约 01 §8）');
  assert.deepEqual(model.resultRefs.map(r => r.id), [41]);

  RS.mountTaskCard('writing-run-card', model);
  assert.ok(host.textContent.indexOf('完成') >= 0, '卡片必须显示任务徽标：' + host.textContent);
  assert.ok(host.textContent.indexOf('#/book/7/read/41') >= 0 || host.textContent.indexOf('结果引用') >= 0, '结果引用必须可查看：' + host.textContent);

  const details = host.querySelector('.run-tools');
  assert.ok(details, '工具细节必须是可折叠块');
  assert.equal(!!details.open, false, '工具细节默认折叠');
  assert.ok(details.textContent.indexOf('目标') >= 0, '展开项必须写清目标');
  assert.ok(details.textContent.indexOf('来源版本') >= 0, '展开项必须写清来源版本');
  assert.ok(details.textContent.indexOf('chapter_id=41') >= 0, '目标取自真实入参：' + details.textContent);
  assert.ok(details.textContent.indexOf('revision 7') >= 0, '来源版本取自真实工具结果：' + details.textContent);

  // 工具结果没给版本/目标时如实写「未提供」，不得编造
  const blank = RS.cardModel({ run: { status: 'finished' }, tools: [{ name: 'list_chapters', args: {}, result: {} }] });
  assert.equal(blank.tools[0].sourceVersion, null);
  assert.equal(blank.tools[0].target, null);
  RS.mountTaskCard('writing-run-card', blank);
  assert.ok(host.textContent.indexOf('未提供') >= 0, '缺失目标/来源版本时必须写「未提供」');

  // 没有结果引用的「完成」必须明说，不能拿徽标当写入凭据
  const noRefs = RS.cardModel({ run: { status: 'finished' }, events: [] });
  assert.equal(noRefs.hasResultRefs, false);
  RS.mountTaskCard('writing-run-card', noRefs);
  assert.ok(host.textContent.indexOf('没有可核验的结果引用') >= 0, '完成但无结果引用时必须写明：' + host.textContent);
});

test('任务卡：失败/中断给出可执行的下一步；未知状态不臆造失败或成功（网络中断）', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  const failed = RS.cardModel({ run: { status: 'failed', reason: 'upstream_error' } });
  assert.equal(failed.badge, '失败');
  assert.ok(failed.nextStep && failed.nextStep.label, '失败必须给出下一步');
  const interrupted = RS.cardModel({ run: { status: 'interrupted', reason: 'server_restart' } });
  assert.equal(interrupted.badge, '中断');
  assert.ok(interrupted.nextStep && interrupted.nextStep.label, '中断必须给出下一步（核对后重新发起）');

  const unknown = RS.unknownCard({ reason: 'network' });
  assert.equal(unknown.badge, '未知（待恢复）');
  assert.equal(unknown.unknown, true);
  assert.ok(unknown.nextStep && unknown.nextStep.label, '未知状态也要给下一步（重试）');
  RS.mountTaskCard('writing-run-card', unknown);
  const text = h.text('writing-run-card');
  assert.ok(text.indexOf('未知（待恢复）') >= 0, text);
  assert.equal(text.indexOf('失败'), -1, '网络中断不得显示为失败：' + text);
  assert.equal(text.indexOf('完成'), -1, '网络中断不得显示为完成：' + text);
});

// ---------- 保存三态 ----------

test('保存状态独立三分：本地未保存 / 已应用未落盘 / 已保存', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  assert.equal(RS.saveBadge({ dirty: true }), '本地未保存');
  assert.equal(RS.saveBadge({ dirty: false }), '已保存');
  // S1 的 503 PERSISTENCE_PENDING：已应用未落盘（业务已应用到内存，磁盘没写上）
  const saveBadgeDuringDiskFailure = RS.saveBadge({ dirty: false, pending: true });
  assert.equal(saveBadgeDuringDiskFailure, '已应用未落盘');
  // 服务端报告落盘失败/待重试时同样按「已应用未落盘」，即使编辑器还标着脏
  assert.equal(RS.saveBadge({ dirty: true, persistence: { lastSaveError: 'EBUSY', retryScheduled: true } }), '已应用未落盘');
  assert.equal(RS.saveBadge({ dirty: false, persistence: { exhausted: true } }), '已应用未落盘');
  // 落盘恢复且编辑器干净 → 回到「已保存」
  assert.equal(RS.saveBadge({ dirty: false, persistence: { dirty: false, retryScheduled: false, lastSaveError: null } }), '已保存');
});

test('写作页保存徽标走真实链路：503 PERSISTENCE_PENDING 之后显示「已应用未落盘」，任务 finished 不等于新输入已保存', async () => {
  const h = harness({
    state: { currentBook: { id: 7, title: '雾港编年史' }, currentChapterId: 41 },
    route(req) {
      if (req.url.indexOf('/api/health') === 0) {
        return { body: { ok: true, persistence: { dirty: true, pending: false, retryScheduled: true, lastSaveError: 'EBUSY' } } };
      }
      if (req.method === 'PUT' && req.url.indexOf('/chapters/41') > 0) {
        return { status: 503, body: { error: '写入磁盘仍失败', code: 'PERSISTENCE_PENDING', applied: true, persistence: { durable: false, pending: true, code: 'PERSISTENCE_PENDING' } } };
      }
      return { body: {} };
    },
  });
  const RS = await instanceOf(h);
  assert.equal(typeof h.bookPage.hasUnsavedChanges, 'function', '编辑部必须提供 hasUnsavedChanges（等值 book.js:81 消费面）');
  RS.observeApi();

  // 干净且服务端健康 → 已保存
  h.page.dirty = false;
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已保存');

  // 本地有改动 → 本地未保存
  h.page.dirty = true;
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '本地未保存');

  // 保存打到 503 PERSISTENCE_PENDING：业务已应用、未落盘 → 已应用未落盘
  h.page.dirty = false;
  await assert.rejects(
    h.App.api('PUT', '/api/books/7/chapters/41', { content: '正文' }),
    e => e.code === 'PERSISTENCE_PENDING',
  );
  RS.renderWritingSaveBadge();
  const saveBadgeDuringDiskFailure = h.text('writing-status-save');
  assert.equal(saveBadgeDuringDiskFailure, '已应用未落盘');

  // 落盘失败期间编辑器又出现新输入：徽标仍是「已应用未落盘」（磁盘还落后，不谎称已保存）
  h.page.dirty = true;
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已应用未落盘', '磁盘未恢复前不得谎称已保存');

  // 磁盘恢复（/api/health 报 clean）后，任务完成/保存成功都不等于当前新输入已保存：
  // 编辑器还为脏 → 本地未保存
  h.App.__runStatusObserved;
  RS.notePersistence({ dirty: false, retryScheduled: false, lastSaveError: null, durable: true });
  h.page.dirty = true;
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '本地未保存', '写入成功后的新输入仍必须显示未保存');
  h.page.dirty = false;
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已保存');
});

// ---------- 刷新后从服务端重建 ----------

test('网络中断只显示「未知（待恢复）」：不臆造失败也不臆造完成', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  const failing = async () => { throw new TypeError('fetch failed'); };
  const card = await RS.rebuildFromServer({ runId: 'run_x', sessionKey: 'writing:book:7', fetchImpl: failing });
  assert.equal(card.ok, false);
  assert.equal(card.card.badge, '未知（待恢复）');
  assert.equal(card.card.unknown, true);
  RS.mountTaskCard('writing-run-card', card.card);
  const text = h.text('writing-run-card');
  assert.ok(text.indexOf('未知（待恢复）') >= 0, text);

  // 服务端有运行行时按服务端状态重建（不猜）
  const okFetch = async () => jsonResponse({ run: { id: 'run_x', status: 'interrupted', reason: 'server_restart', sessionKey: 'writing:book:7' } });
  const built = await RS.rebuildFromServer({ runId: 'run_x', sessionKey: 'writing:book:7', fetchImpl: okFetch });
  assert.equal(built.ok, true);
  assert.equal(built.card.badge, '中断');
  assert.equal(built.events, null, '没有事件表（Agent 入口）时如实标记，不编造事件');
});

// ---------- 轮询 ----------

test('状态查询低频、页面可见才轮询、完成后停止（不新增每秒全库扫描）', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  const fast = RS.createWatcher({ intervalMs: 1000, load: async () => ({ terminal: false }) });
  assert.ok(fast.intervalMs >= RS.MIN_INTERVAL_MS, '轮询间隔必须被抬到低频下限，不接受秒级全库扫描');
  assert.ok(RS.MIN_INTERVAL_MS >= 2000, '低频下限至少 2 秒');
  fast.stop();

  let visible = true;
  let loads = 0;
  const w = RS.createWatcher({
    intervalMs: 5000,
    isVisible: () => visible,
    load: async () => { loads += 1; return { terminal: loads >= 2, badge: '完成' }; },
  });
  assert.equal(w.intervalMs, 5000);
  visible = false;
  await w.tick();
  assert.equal(loads, 0, '页面不可见时不得发状态查询请求');
  visible = true;
  await w.tick();
  assert.equal(loads, 1);
  await w.tick();
  assert.equal(loads, 2);
  assert.equal(w.stopped(), true, '完成后必须停止轮询');
  await w.tick();
  assert.equal(loads, 2, '停止后不得再发起状态查询');
  w.stop();

  // P6-2 ⑨ 原位改钉：book-chat.js 早退役、聊天委托桩段（P6-2 ⑨ 前 index.html 内联段）亦随本片清退 ⇒
  // 可见性开关的供给方＝聊天模块面（ChatWorkspace 命令面 `setStatusPollingVisible`），index.html 零内联段。
  const html = indexHtml();
  assert.equal((html.match(/legacy\/book-chat\.js/g) || []).length, 0, 'index.html 不得再加载 book-chat.js');
  assert.equal((html.match(/<script\b/g) || []).length, 1, '源 index.html 只余一个 script＝Vite entry 声明 /entry.jsx（P6-2 ⑨ 内联段清零＋P6-3 产物化）');
  assert.equal(html.indexOf('setStatusPollingVisible'), -1, 'index.html 不得再内联供给可见性开关');
  assert.ok(
    /setStatusPollingVisible: \(on\) => controller\.setStatusPollingVisible\(on\)/.test(
      readFe('frontend/components/ChatWorkspace.jsx'),
    ),
    '可见性开关必须由聊天模块面供给（等值原 :2108-2116 的对外面）',
  );
});

// ---------- 统一错误可见（G3 已知边界 4 的前端一半）----------

test('工具被拒绝时错误码可达前端：tool-output-error 携带 TOOL_NOT_ALLOWED 而不是通用文案', async () => {
  const hub = await import(dataUrl(fs.readFileSync(path.join(root, 'frontend/lib/chat-event-hub.js'), 'utf8')));
  const sse = [
    'data: ' + JSON.stringify({ type: 'tool-input-available', toolCallId: 't1', toolName: 'create_character', input: { name: '甲' } }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'tool-output-error', toolCallId: 't1', errorText: '[TOOL_NOT_ALLOWED] 工具 "create_character" 不在当前工具面（只读讨论模式不加载写工具，未执行任何写入）' }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'finish', messageMetadata: { run: { status: 'paused', reason: 'step_budget' } } }) + '\n\n',
  ].join('');
  const resp = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const seen = [];
  const out = await hub.consumeAgentStream(resp, { onToolError: info => seen.push(info) });
  assert.equal(seen.length, 1, 'tool-output-error 必须回调给页面（此前被静默丢弃）');
  assert.equal(seen[0].toolName, 'create_character');
  assert.equal(seen[0].code, 'TOOL_NOT_ALLOWED', '错误码必须到达前端：' + JSON.stringify(seen[0]));
  assert.ok(seen[0].message.indexOf('不在当前工具面') >= 0);
  assert.ok(Array.isArray(out.toolErrors) && out.toolErrors.length === 1, '当前轮的工具错误要能被状态卡读到');
  assert.equal(out.toolErrors[0].code, 'TOOL_NOT_ALLOWED');
});

// ---------- S5-7-X2 等价承接（P6-4）：健康快照映射 ----------

test('健康快照映射：/api/health 的 dirty/pending 是 debounce 队列不算失败，lastSaveError/retryScheduled 才算（S5-7-X2② 等价承接；lib run-status.js:111-136）', async () => {
  const h = harness();
  const RS = await instanceOf(h);
  h.page.dirty = false;
  // 健康快照形（无 durable 字段）：db 层 debounce 队列的 dirty/pending=true ≠ 落盘失败
  //（legacy run-status.js:88-93 语义；db.js 自称「谎报 pending」，实现注释 run-status.js:123-131 逐字）
  RS.notePersistence({ dirty: true, pending: true, retryScheduled: false, lastSaveError: null });
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已保存', '健康快照 dirty/pending 是 debounce 队列，不得显示「已应用未落盘」');
  // 对照组①：lastSaveError＝失败事实 → 已应用未落盘
  RS.notePersistence({ dirty: false, pending: false, retryScheduled: false, lastSaveError: 'EACCES: permission denied' });
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已应用未落盘');
  // 对照组②：retryScheduled＝已安排重试（失败事实）→ 已应用未落盘
  RS.notePersistence({ dirty: false, pending: false, retryScheduled: true, lastSaveError: null });
  RS.renderWritingSaveBadge();
  assert.equal(h.text('writing-status-save'), '已应用未落盘');
});
