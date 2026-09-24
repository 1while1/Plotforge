// S4-05 / 任务书 05「统一可见状态，不再依靠聊天话术猜结果」页面回归。
// 载入真实 public/index.html 的 id 集合与真实页面代码（chat-event-hub.js、run-status.js、
// book-chat.js、agent.js、book.js、workbench-shell.js），用最小 DOM/App 桩跑真实代码，钉住：
//   1) 统一任务卡：正在读取/执行、待确认、已拒绝、已暂停、失败、中断、完成七种徽标；
//      length 截断必须显示「已暂停」而不是「完成」；完成必须带可查看的结果引用；
//      工具细节默认折叠，展开可见「目标」与「来源版本」（缺字段写「未提供」，不臆造）。
//   2) 保存状态独立三分：本地未保存 / 已应用未落盘 / 已保存；任务 finished 不等于当前新输入
//      已经保存；S1 的 503 PERSISTENCE_PENDING 之后徽标必须是「已应用未落盘」。
//   3) 另一空间改了当前资料：只提示「资料更新」并给「查看差异 / 刷新」；脏正文不被覆盖、
//      聊天历史不自动加入。
//   4) 刷新后从服务端 run/action 重建（GET /chat 的 message.run 快照），不由浏览器上一条气泡猜；
//      待确认卡与当前会话绑定；网络中断显示「未知（待恢复）」，不臆造失败或成功。
//   5) 状态查询按需或页面可见时低频轮询，完成后停止；不接受秒级轮询。
//
// 桩的纪律（沿用 S4-04b 口径）：document.getElementById 请求 public/index.html 里不存在的 id
// 会被记入 missingIds 并返回 null，用例显式断言 missingIds 为空——不允许「桩比页面宽」。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const RS_PATH = path.join(root, 'public/run-status.js');

function indexHtml() {
  return fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
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
    el.addEventListener = (name, fn) => { (el.listeners[name] = el.listeners[name] || []).push(fn); };
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
    while ((m = re.exec(html))) {
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
    while ((m = re.exec(attrs))) {
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

  const context = {
    window: { App }, App, document: doc, console,
    localStorage: storageOf(storage),
    sessionStorage: storageOf(session),
    fetch: fetchStub, setTimeout, clearTimeout,
    // 定时器桩：页面低频轮询的 setInterval 不真的起定时器（用例用 watcher.tick() 手动驱动），
    // 否则一个活着的 interval 会让测试进程不退出。
    setInterval: () => 1, clearInterval: () => {},
    TextDecoder, AbortController, URLSearchParams,
    confirm: () => true,
    location: { hash: '' },
  };
  context.window.document = doc;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.location = context.location;
  // 写作页骨架：脏标记与保存管道的真实实现在 book-chapters.js（不在本文件路径上），
  // 这里只提供 hasUnsavedChanges / selectChapter 两个页面级入口作为可编程输入。
  const page = {
    dirty: false,
    reloads: [],
    hasUnsavedChanges() { return !!page.dirty; },
    selectChapter(id) { page.reloads.push(id); return Promise.resolve(true); },
  };
  context.window.BookPage = page;
  context.BookPage = page;

  const load = name => vm.runInNewContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  load('public/chat-event-hub.js');
  context.ChatEventHub = context.window.ChatEventHub;
  const hasRunStatus = fs.existsSync(RS_PATH);
  if (hasRunStatus) { load('public/run-status.js'); context.RunStatus = context.window.RunStatus; }
  load('public/book-chat.js');
  load('public/agent.js');
  context.AgentPage = context.window.AgentPage;
  load('public/book.js');
  load('public/workbench-shell.js');

  const allButtons = () => Array.from(dyn.values()).filter(el => el.tagName === 'BUTTON' || el.tagName === 'A');

  return {
    App, doc, requests, toasts, modals, storage, session, page,
    hasRunStatus,
    RS: context.window.RunStatus,
    hub: context.window.ChatEventHub,
    bookPage: context.window.BookPage,
    agentPage: context.window.AgentPage,
    workbench: context.window.WorkbenchShell,
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
      fns.forEach(fn => fn({ preventDefault() {} }));
      if (n.onclick && type === 'click') n.onclick({ preventDefault() {} });
      return fns.length + (n.onclick && type === 'click' ? 1 : 0);
    },
  };
}

function requireRS(h, what) {
  assert.ok(h.hasRunStatus, 'public/run-status.js 必须存在（S4-05 统一任务卡/保存三态/资料更新）');
  assert.ok(h.RS, 'public/run-status.js 必须导出 window.RunStatus（' + what + '）');
  return h.RS;
}

const tick = () => new Promise(r => setImmediate(r));

// ---------- 骨架 ----------

test('S4-05 骨架：run-status.js 与三处任务卡容器、状态条保存徽标都在真实页面上', () => {
  assert.ok(fs.existsSync(RS_PATH), 'public/run-status.js 必须存在（S4-05 统一可见状态）');
  assert.ok(/<script src="run-status\.js(\?[^"]*)?"><\/script>/.test(HTML), 'index.html 必须加载 run-status.js（统一状态模块）');
  const missing = REQUIRED_IDS.filter(id => !CLIENT_IDS.has(id));
  assert.deepEqual(missing, [], 'index.html 必须提供真实 id：' + missing.join(', '));
  assert.ok(HTML.indexOf('id="writing-run-card"') > 0, '写作页必须有 #writing-run-card');
  assert.ok(HTML.indexOf('id="agent-run-card"') > 0, 'Agent 台必须有 #agent-run-card');
  assert.ok(HTML.indexOf('id="workbench-notify"') > 0, '工作台必须有 #workbench-notify（任务提示铃铛：Toast + 铃铛回看形态）');
});

// ---------- 任务卡 ----------

test('任务徽标覆盖七种状态；length 截断显示「已暂停」而不是「完成」', () => {
  const h = harness();
  const RS = requireRS(h, '任务徽标');
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

test('任务卡：完成必须带可查看的结果引用；工具细节默认折叠、展开可见目标与来源版本', () => {
  const h = harness();
  const RS = requireRS(h, '任务卡渲染');
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

test('任务卡：失败/中断给出可执行的下一步；未知状态不臆造失败或成功（网络中断）', () => {
  const h = harness();
  const RS = requireRS(h, '下一步链接');
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

test('保存状态独立三分：本地未保存 / 已应用未落盘 / 已保存', () => {
  const h = harness();
  const RS = requireRS(h, '保存三态');
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
  requireRS(h, '保存徽标渲染');
  assert.ok(h.bookPage.renderWritingStatus, 'book.js 必须提供 renderWritingStatus');

  // 干净且服务端健康 → 已保存
  h.page.dirty = false;
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '已保存');

  // 本地有改动 → 本地未保存
  h.page.dirty = true;
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '本地未保存');

  // 保存打到 503 PERSISTENCE_PENDING：业务已应用、未落盘 → 已应用未落盘
  h.page.dirty = false;
  await assert.rejects(
    h.App.api('PUT', '/api/books/7/chapters/41', { content: '正文' }),
    e => e.code === 'PERSISTENCE_PENDING',
  );
  h.bookPage.renderWritingStatus();
  const saveBadgeDuringDiskFailure = h.text('writing-status-save');
  assert.equal(saveBadgeDuringDiskFailure, '已应用未落盘');

  // 落盘失败期间编辑器又出现新输入：徽标仍是「已应用未落盘」（磁盘还落后，不谎称已保存）
  h.page.dirty = true;
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '已应用未落盘', '磁盘未恢复前不得谎称已保存');

  // 磁盘恢复（/api/health 报 clean）后，任务完成/保存成功都不等于当前新输入已保存：
  // 编辑器还为脏 → 本地未保存
  h.App.__runStatusObserved;
  h.RS.notePersistence({ dirty: false, retryScheduled: false, lastSaveError: null, durable: true });
  h.page.dirty = true;
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '本地未保存', '写入成功后的新输入仍必须显示未保存');
  h.page.dirty = false;
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '已保存');
});

test('保存徽标只认「落盘失败」：/api/health 的排队计时器不算失败；磁盘恢复后不敲键盘也回到「已保存」', async () => {
  // 同名键在两条契约里含义不同：S1 的 persistence 信封（durable/pending/code）里
  // pending=true 就是「saveNow 试过、没写下去」；/api/health 走 db.getPersistenceStatus()，
  // 其中 pending 只是 1s debounce 计时器排着队、dirty 只表示内存里还有改动。
  // 徽标必须按「失败事实」亮（lastSaveError/retryScheduled/exhausted 或 durable=false），
  // 否则每次正常保存的 1s 窗口都会被误报成「已应用未落盘」。
  let phase = 'queued';   // queued：正常但有 debounce 排队；failing：写盘失败；clean：落盘已成功
  const h = harness({
    state: { currentBook: { id: 7, title: '雾港编年史' }, currentChapterId: 41 },
    route(req) {
      if (req.url.indexOf('/api/health') === 0) {
        const persistence = phase === 'failing'
          ? { dirty: true, pending: false, retryScheduled: true, exhausted: false, lastSaveError: 'EACCES: permission denied' }
          : (phase === 'queued'
            ? { dirty: true, pending: true, retryScheduled: false, exhausted: false, lastSaveError: '' }
            : { dirty: false, pending: false, retryScheduled: false, exhausted: false, lastSaveError: '' });
        return { body: { ok: true, persistence } };
      }
      if (req.method === 'POST' && req.url.indexOf('/api/persistence/flush') === 0) {
        return { body: { ok: true, applied: true, persistence: { durable: true, pending: false, code: null } } };
      }
      if (req.method === 'PUT' && req.url.indexOf('/chapters/41') > 0) {
        return { status: 503, body: { error: '写入磁盘仍失败', code: 'PERSISTENCE_PENDING', applied: true, persistence: { durable: false, pending: true, code: 'PERSISTENCE_PENDING' } } };
      }
      return { body: {} };
    },
  });
  const RS = requireRS(h, '保存徽标只认落盘失败');
  h.page.dirty = false;

  // ① 磁盘正常，只是还有一次落盘排在 debounce 队列里（health: dirty/pending=true，无错误）
  await h.bookPage.refreshRunStatus();
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '已保存', '排队的 debounce 不算落盘失败，不得误报「已应用未落盘」');

  // ② 真的写不下去（503 PERSISTENCE_PENDING）→ 已应用未落盘
  phase = 'failing';
  await assert.rejects(
    h.App.api('PUT', '/api/books/7/chapters/41', { content: '正文' }),
    e => e.code === 'PERSISTENCE_PENDING',
  );
  h.bookPage.renderWritingStatus();
  assert.equal(h.text('writing-status-save'), '已应用未落盘');

  // ③ 磁盘恢复（S1 的 flush 成功 + health 不再报错）→ 页面自身的状态刷新就该把徽标带回去，
  //    不必等作者再敲一次键（否则「已应用未落盘」会一直挂着骗人）
  phase = 'clean';
  await h.RS.retryFlush();
  await h.bookPage.refreshRunStatus();
  assert.equal(h.text('writing-status-save'), '已保存', '落盘恢复后即使没有新输入也应回到「已保存」');
});

// ---------- 资料更新 ----------

test('另一空间改了当前资料：只提示「资料更新」并给查看差异/刷新；脏正文不被覆盖、聊天历史不自动加入', async () => {
  let revision = 3;
  const h = harness({
    state: { currentBook: { id: 7, title: '雾港编年史' }, currentChapterId: 41 },
    route(req) {
      if (req.url.indexOf('/api/resources?type=chapter') === 0) {
        return {
          body: {
            type: 'chapter', bookId: 7,
            resource: {
              type: 'chapter', id: 41, bookId: 7, found: true, title: '第 41 章', status: 'draft',
              route: '#/book/7/read/41', updatedAt: '2026-09-23T00:00:00.000Z',
              meta: { revision, locked: false, charCount: 1200 },
            },
          },
        };
      }
      if (req.url.indexOf('/api/health') === 0) {
        return { body: { ok: true, persistence: { dirty: false, retryScheduled: false, lastSaveError: null } } };
      }
      if (req.url.indexOf('/api/books/7/chat') === 0) return { body: { conversationId: 'w-7-a', messages: [] } };
      return { body: {} };
    },
  });
  const RS = requireRS(h, '资料更新提示');
  assert.ok(typeof h.bookPage.refreshRunStatus === 'function', '写作页必须提供按需/可见时刷新的状态入口');

  // 第一次：建立基线，无提示
  await h.bookPage.refreshRunStatus();
  assert.equal(h.text('writing-run-card').indexOf('资料更新'), -1, '基线读取不得误报资料更新');

  // 另一空间（Agent 台/阅读页）改了同一章：revision 3 → 4
  const unsavedLocalText = '编辑器里的未保存草稿：主角推开门，风灌进来。';
  h.node('chapter-content').value = unsavedLocalText;
  h.page.dirty = true;
  revision = 4;
  const messagesBefore = h.node('chat-messages').children.length;
  await h.bookPage.refreshRunStatus();

  const notice = h.text('writing-run-card');
  assert.ok(notice.indexOf('资料更新') >= 0, '另一空间改了当前资料必须提示「资料更新」：' + notice);
  assert.ok(notice.indexOf('查看差异') >= 0 && notice.indexOf('刷新') >= 0, '必须提供查看差异/刷新两个动作：' + notice);
  const editorTextAfterResourceChanged = h.node('chapter-content').value;
  assert.equal(editorTextAfterResourceChanged, unsavedLocalText, '脏正文不得被自动覆盖');
  assert.equal(h.node('chat-messages').children.length, messagesBefore, '聊天历史不得自动加入资料变更消息');
  assert.equal(h.page.reloads.length, 0, '脏正文时不得静默重载');
  assert.equal(h.requests.some(r => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH'), false,
    '资料更新提示本身不得发写请求');

  // 作者点「刷新」：脏正文仍在，不覆盖，只给明确提示
  h.clickText('刷新');
  await tick();
  assert.equal(h.node('chapter-content').value, unsavedLocalText, '点刷新也不得覆盖未保存的稿子');
  assert.equal(h.page.reloads.length, 0);
  assert.ok(h.toasts.some(t => t.indexOf('未保存') >= 0), '必须提示先保存/复制再来刷新：' + h.toasts.join(' | '));
  assert.equal(RS.observeResource('writing_resource:7:41', { meta: { revision: 4 } }).changed, false,
    '同版本重复观察不得重复报警');

  // 干净时点「刷新」才真正重新加载该章（从服务端取真相）
  h.page.dirty = false;
  h.clickText('刷新');
  await tick();
  assert.deepEqual(h.page.reloads, [41], '干净编辑器下刷新应重新加载当前章');
});

// ---------- 刷新后从服务端重建 ----------

test('刷新后从服务端 run 快照重建任务卡（不靠浏览器上一条气泡）；待确认卡与当前会话绑定', async () => {
  const messages = [
    { id: 1, role: 'user', content: '把这一章补完', source: 'writing', run: null },
    { id: 2, role: 'assistant', content: '（半截）', source: 'writing', run: { status: 'paused', reason: 'output_truncated' } },
  ];
  const h = harness({
    state: { currentBook: { id: 7, title: '雾港编年史' }, currentChapterId: 41 },
    route(req) {
      if (req.url.indexOf('/api/books/7/chat') === 0 && req.url.indexOf('/chat/actions') < 0) {
        return { body: { conversationId: 'w-7-a', messages } };
      }
      if (req.url.indexOf('/chat/actions') > 0) {
        return {
          body: {
            actions: [
              { id: 'a-1', name: 'append_chapter', args: { chapterId: 41 }, summary: '写入第 41 章', status: 'pending', conversationId: 'w-7-a' },
              { id: 'a-2', name: 'replace_chapter', args: { chapterId: 42 }, summary: '覆盖第 42 章', status: 'pending', conversationId: 'w-7-other' },
            ],
            expiredUnnotified: [],
          },
        };
      }
      if (req.url.indexOf('/api/health') === 0) {
        return { body: { ok: true, persistence: { dirty: false, retryScheduled: false, lastSaveError: null } } };
      }
      return { body: {} };
    },
  });
  const RS = requireRS(h, '服务端重建');
  await h.bookPage.loadChat();

  const badge = h.node('writing-run-card').querySelector('.run-badge');
  assert.ok(badge, '任务卡必须渲染徽标元素');
  assert.equal(badge.textContent, '已暂停', '刷新后必须按服务端 run 快照显示「已暂停」（length 截断）：' + h.text('writing-run-card'));

  const bound = RS.actionsForConversation([
    { id: 'a-1', conversationId: 'w-7-a', summary: '写入第 41 章' },
    { id: 'a-2', conversationId: 'w-7-other', summary: '覆盖第 42 章' },
  ], 'w-7-a');
  assert.equal(bound.bound.map(a => a.id).join(','), 'a-1');
  assert.equal(bound.unbound.map(a => a.id).join(','), 'a-2');
  const model = RS.cardModel({ run: { status: 'awaiting_confirmation' }, actions: bound.bound.concat(bound.unbound), conversationId: 'w-7-a' });
  assert.equal(model.pendingActions.map(a => a.id).join(','), 'a-1', '待确认卡只属于当前会话');
  RS.mountTaskCard('writing-run-card', model);
  const confirmText = h.text('writing-run-card');
  assert.ok(confirmText.indexOf('写入第 41 章') >= 0);
  assert.equal(confirmText.indexOf('覆盖第 42 章') >= 0, false, '其他会话的待确认卡不得显示为当前会话的');

  assert.deepEqual(h.missingIds(), [], '页面代码不得请求 index.html 里不存在的 id');
});

test('网络中断只显示「未知（待恢复）」：不臆造失败也不臆造完成', async () => {
  const h = harness();
  const RS = requireRS(h, '网络中断');
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
  const RS = requireRS(h, '状态轮询');
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

  assert.ok(typeof h.bookPage.setStatusPollingVisible === 'function', '写作页必须提供可见性开关');
});

// ---------- 统一错误可见（G3 已知边界 4 的前端一半）----------

test('工具被拒绝时错误码可达前端：tool-output-error 携带 TOOL_NOT_ALLOWED 而不是通用文案', async () => {
  const h = harness();
  const hub = h.hub;
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

test('写作页压缩弹窗说明四节结构（S3-04 摘要结构，G3 已知边界 9）', () => {
  const h = harness({ state: { currentBook: { id: 7, title: '雾港编年史' }, currentChapterId: 41 } });
  assert.ok(typeof h.bookPage.bindChatEvents === 'function');
  h.bookPage.bindChatEvents();
  h.fire('btn-compress', 'click');
  assert.equal(h.modals.length, 1, '压缩按钮必须打开弹窗');
  const body = h.modals[0].bodyHTML;
  for (const section of ['已确认的资料与设定', '已执行的动作与结果', '未决问题', '尚未采纳的设想']) {
    assert.ok(body.indexOf(section) >= 0, '压缩弹窗必须说明四节摘要结构，缺：' + section + '（文案：' + body + '）');
  }
});

// ---------- 工作台任务入口 ----------

test('工作台显示当前书的任务入口（服务端运行状态 + 下一步链接）', async () => {
  const h = harness({
    route(req) {
      if (req.url.indexOf('/api/books/7') === 0) return { body: { book: { id: 7, title: '雾港编年史' } } };
      if (req.url.indexOf('/api/resources?type=task') === 0) {
        return {
          body: {
            type: 'task', bookId: 7,
            items: [{ type: 'task', id: 'run_9', title: 'chat · write', bookId: 7, status: 'paused', route: '#/agent', updatedAt: '2026-09-23T00:00:00.000Z', meta: { entry: 'chat', mode: 'write' } }],
            nextCursor: null,
          },
        };
      }
      return { body: {} };
    },
  });
  requireRS(h, '工作台任务入口');
  await h.workbench.show('#/book/7/workbench/ledger');
  // Toast + 铃铛形态：状态徽标落在铃铛弹层标题（#workbench-task-entry 已退役为 notify 组件）
  const title = h.text('workbench-notify-title');
  assert.ok(title, '铃铛弹层标题必须渲染');
  assert.ok(title.indexOf('已暂停') >= 0, '工作台必须显示服务端运行状态徽标：' + title);
  const link = h.node('workbench-notify-link');
  assert.ok(link, '铃铛弹层必须有下一步链接');
  assert.equal(link.href, '#/agent', '下一步入口指向任务自带的 route：' + link.href);
  assert.ok(!link.classList.contains('hidden'), '有运行记录时下一步链接必须可见');

  // 服务端查不到任务时明确说明，不臆造完成
  const h2 = harness({ route: req => (req.url.indexOf('/api/books/7') === 0 ? { body: { book: { id: 7, title: '雾港编年史' } } } : { body: { type: 'task', bookId: 7, items: [], nextCursor: null } }) });
  await h2.workbench.show('#/book/7/workbench/ledger');
  const t2 = h2.text('workbench-notify-title');
  assert.ok(t2.indexOf('没有') >= 0, '没有运行记录时必须明说，不得显示为完成：' + t2);
  const link2 = h2.node('workbench-notify-link');
  assert.ok(link2.classList.contains('hidden'), '没有运行记录时下一步链接必须隐藏');
});
