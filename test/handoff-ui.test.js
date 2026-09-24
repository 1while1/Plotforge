// S4-04b / 任务书 05「规划笔记与显式交接」页面回归（Agent 台 → 写作页）。
// 载入真实 public/index.html 的 id 集合与真实页面代码（chat-event-hub.js、agent.js、book-chat.js），
// 用最小 DOM/App 桩跑真实代码，钉住任务书与冻结契约（01 §6）要求：
//   1) Agent 讨论里可勾选消息 → 存规划笔记（走 S4-04a 的 /api/planning-notes）：笔记只是草稿，
//      全程不得产生任何正文/大纲/人物/世界观/事件账本的写入。
//   2) 创建交接草案 → 预览（可编辑摘要 + 来源 + 服务端回显的来源指纹）→ 接受：
//      接受才写入，且只发一笔；重复点击不再插入第二条。
//   3) global→book 必须作者明确选定目标书与会话：未选定不发请求、不自动挑书、不夹带别的书材料。
//   4) 目标有活跃运行时「明确排队」：预览显示运行中、接受按钮禁用，且程序化点击也不得发出接受。
//   5) 来源变更（409 HANDOFF_SOURCE_CHANGED）必须提示重新预览，前端不得拿旧指纹重试。
//   6) 写作页收到交接消息后可跳转来源讨论（原会话），来源引用逐字可核对（笔记 id 不得渲染成 #NaN）。
//
// 桩的纪律（吸取 S1-03c「VM 桩过松掩盖真实选择器缺陷」与 S4-01b/S4-02 的教训）：
//   · document.getElementById 只认 public/index.html 里真实存在的 id；页面代码请求不存在的 id
//     会被记入 missingIds 并返回 null，用例显式断言 missingIds 为空——不允许「桩比页面宽」。
//   · 弹窗内部字段由页面自己用 bodyHTML 生成：桩解析 innerHTML 并记录「查询了但不存在」的选择器
//     （modalMissing），用例断言为空，防止页面查一个自己没渲染的 id。
//   · App.api 桩与 public/app.js 的 api() 同口径（含把 error.code 挂到 Error 上）。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

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

// S4-04b 必须提供的页面骨架（断言打在真实 index.html 上）
const REQUIRED_IDS = [
  'agent-messages', 'agent-text', 'agent-form',
  'agent-pick-bar', 'agent-pick-count', 'btn-agent-save-note', 'btn-agent-create-handoff', 'btn-agent-pick-clear',
  'chat-messages',
];

const BOOKS = [{ id: 7, title: '雾港编年史' }, { id: 9, title: '另一部' }];
const AGENT_CONVERSATIONS = [
  { id: 'c-global', kind: 'agent', scope: 'global', book_id: null, title: '全局资源讨论', status: 'active' },
  { id: 'c-book-7', kind: 'agent', scope: 'book', book_id: 7, title: '《雾港编年史》· 叛变推演', status: 'active' },
];
const WRITING_CONVERSATIONS = [
  { id: 'w-7-a', kind: 'writing', scope: 'book', book_id: 7, title: '正文写作', status: 'active' },
  { id: 'w-7-b', kind: 'writing', scope: 'book', book_id: 7, title: '另一条写作会话', status: 'active' },
];
const OTHER_BOOK_WRITING = { id: 'w-9', kind: 'writing', scope: 'book', book_id: 9, title: '另一部写作会话', status: 'active' };
const BOOK_MESSAGES = [
  { id: 1, role: 'user', content: '讨论：林野会不会叛变？', source: 'agent' },
  { id: 2, role: 'assistant', content: '结论一：林野不会主动叛变，但会在第 12 章被迫隐瞒。', source: 'agent' },
  { id: 3, role: 'assistant', content: '结论二：副官会因为旧债倒向敌方。', source: 'agent' },
  { id: 4, role: 'assistant', content: '（未选中的闲聊：今天天气不错）', source: 'agent' },
];
const GLOBAL_MESSAGES = [
  { id: 11, role: 'assistant', content: '全局结论：副官线可以更早埋。', source: 'agent' },
];
// 别书哨兵：任何 global→book 的请求体/材料都不得夹带它
const OTHER_BOOK_SENTINEL = '另一本书的正文哨兵';
const OTHER_BOOK_OUTLINE = '另一本书的总纲：不该出现在交接材料里';
// 写作页已有的一条交接消息（内容由 server/conversations/handoffs.js 的模板生成，逐字对齐）
const NOTE_ID = '9f1b7c2e-1111-4222-8333-444455556666';
const HANDOFF_MESSAGE = {
  id: 641, role: 'user', source: 'system',
  content: '【来自 Agent 讨论·显式交接】来源会话：《雾港编年史》· 叛变推演（c-book-7）\n'
    + '把这两条结论带进正文写作。\n'
    + '选定结论：\n'
    + '- #2：结论一：林野不会主动叛变，但会在第 12 章被迫隐瞒。\n'
    + '- #3：结论二：副官会因为旧债倒向敌方。\n'
    + '来源引用：规划笔记 #' + NOTE_ID + '（revision 2）\n'
    + '（这是作者显式交接的材料，不是已确认的故事事实；更新大纲/人物/世界观仍需走确认与 diff。）',
};
const PLAIN_USER_MESSAGE = { id: 640, role: 'user', content: '普通的一条作者输入，不是交接材料。', source: 'writing' };

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

function harness(opts) {
  const o = opts || {};
  const nodes = new Map();
  const missing = new Set();
  const modalMissing = new Set();
  const requests = [];
  const toasts = [];
  const modals = [];
  const state = Object.assign(
    { previewBusy: false, staleFirst: false, fpVersion: 1, accepts: 0, cancelAccepted: false }, o.state || {});
  let closeCalls = 0;

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], parent: null,
      dataset: {}, style: {}, _classes: new Set(), _text: '',
      listeners: {}, disabled: false, title: '', value: '', href: '', open: false,
      checked: false, selected: false, scrollTop: 0, scrollHeight: 0, onclick: null,
      selectionStart: 0, selectionEnd: 0,
    };
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
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    return el;
  }

  function matches(el, sel) {
    if (!sel) return false;
    if (sel.charAt(0) === '.') return el._classes && el._classes.has(sel.slice(1));
    if (sel.charAt(0) === '#') return el.id === sel.slice(1);
    return false;
  }
  function descendants(el) {
    const out = [];
    for (const c of el.children || []) {
      if (!c._classes) continue; // 文本节点
      out.push(c, ...descendants(c));
    }
    return out;
  }

  // 极简 innerHTML 解析：只认标签/属性/文本，够页面自己的固定模板用（弹窗 body 的固定模板）
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
    const n = { nodeType: 3, textContent: String(text), children: [], parent };
    parent.children.push(n);
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
      else if (name === 'selected') node.selected = true;
      else if (name === 'disabled') node.disabled = true;
      else if (name.indexOf('data-') === 0) {
        const key = name.slice(5).replace(/-([a-z])/g, (s, c) => c.toUpperCase());
        node.dataset[key] = val;
      }
    }
  }

  const doc = {
    getElementById(id) {
      if (!CLIENT_IDS.has(id)) { missing.add(id); return null; }
      if (!nodes.has(id)) { const el = makeEl('div'); el.id = id; nodes.set(id, el); }
      return nodes.get(id);
    },
    createElement: makeEl,
    createTextNode: t => ({ nodeType: 3, textContent: String(t == null ? '' : t), children: [] }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    hidden: false,
  };

  function fetchStub(url, init) {
    const method = (init && init.method) || 'GET';
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    const req = { method, url: String(url), body };
    requests.push(req);
    const r = o.route ? o.route(req, state) : null;
    if (!r) return jsonResponse({ error: { code: 'STUB_NO_ROUTE', message: 'no stub route: ' + url } }, 404);
    return jsonResponse(r.body, r.status || 200);
  }

  const App = {
    state: {},
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
        const err = new Error((e2 && (e2.message || e2.code)) || ('请求失败 ' + res.status));
        if (e2 && e2.code) err.code = e2.code;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    openModal(opts) {
      const body = makeEl('div');
      body.id = 'modal-body';
      body.innerHTML = opts.bodyHTML || '';
      const origQ = body.querySelector;
      body.querySelector = sel => {
        const hit = origQ(sel);
        if (!hit && sel && sel.charAt(0) === '#') modalMissing.add(sel.slice(1));
        return hit;
      };
      nodes.set('modal-body', body);
      modals.push({
        title: opts.title, okText: opts.okText, bodyHTML: opts.bodyHTML || '', onOk: opts.onOk, body,
      });
    },
    closeModal() { closeCalls += 1; },
  };

  const storage = new Map();
  if (o.storage) for (const k of Object.keys(o.storage)) storage.set(k, o.storage[k]);

  const context = {
    window: { App }, App, document: doc, console,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    fetch: fetchStub, setTimeout, clearTimeout, TextDecoder, AbortController,
    // A-3：作废必须二次确认——桩的返回值可切换，用来断言「取消确认＝不发请求」
    confirm: () => (o.confirmResult === undefined ? true : o.confirmResult),
    location: { hash: '' },
  };
  context.window.document = doc;
  // 写作页返回锚：真实实现在 public/book.js:95（BookPage.saveWritingReturn 写 sessionStorage）；
  // 桩只记录调用参数——用例断言的是「跳转前是否记下当前书/当前章」，不复制 book.js 的存储细节。
  // hasUnsavedChanges/leaveGuard 的真实实现在 public/book-chapters.js:471/480，均不在本文件路径上。
  context.window.BookPage = {
    saveWritingReturn(target) { context.window.BookPage.savedReturn = target; },
    hasUnsavedChanges: () => false,
    leaveGuard: async () => true,
  };
  context.BookPage = context.window.BookPage;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/chat-event-hub.js'), 'utf8'), context);
  context.ChatEventHub = context.window.ChatEventHub;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8'), context);
  context.AgentPage = context.window.AgentPage;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/book-chat.js'), 'utf8'), context);

  const h = {
    App, requests, toasts, modals, doc, state,
    page: context.window.BookPage,
    agentPage: context.window.AgentPage,
    node: id => doc.getElementById(id),
    hasId: id => CLIENT_IDS.has(id),
    text: id => (doc.getElementById(id) ? doc.getElementById(id).textContent : null),
    missingIds: () => Array.from(missing),
    modalMissingIds: () => Array.from(modalMissing),
    modal: () => modals[modals.length - 1] || null,
    modalBody: () => (modals.length ? modals[modals.length - 1].body : null),
    storageGet: k => (storage.has(k) ? storage.get(k) : null),
    fire(id, type, ev) {
      const n = doc.getElementById(id);
      if (!n) return 0;
      const fns = n.listeners[type] || [];
      for (const fn of fns) fn(ev || { preventDefault() {}, target: n, key: '' });
      return fns.length;
    },
    fireInChild(containerId, predicate, type) {
      const n = doc.getElementById(containerId);
      if (!n) return null;
      const target = descendants(n).find(predicate);
      if (!target) return null;
      const fns = target.listeners[type] || [];
      if (fns.length) { for (const fn of fns) fn({ preventDefault() {}, target }); return target; }
      if (type === 'click' && typeof target.onclick === 'function') { target.onclick({ target }); return target; }
      return null;
    },
    fireInModal(selector, type) {
      const m = h.modal();
      if (!m) return null;
      const n = m.body.querySelector(selector);
      if (!n) return null;
      const fns = n.listeners[type] || [];
      if (fns.length) { for (const fn of fns) fn({ preventDefault() {}, target: n }); return n; }
      if (type === 'click' && typeof n.onclick === 'function') { n.onclick({ target: n }); return n; }
      return null;
    },
    async modalOk() {
      const m = h.modal();
      if (!m) throw new Error('没有打开的弹窗');
      return m.onOk(m.body);
    },
    modalOptions(selector) {
      const m = h.modal();
      const n = m ? m.body.querySelector(selector) : null;
      if (!n) return [];
      return (n.children || []).filter(c => c.tagName === 'OPTION')
        .map(c => ({ value: c.value, text: c.textContent, selected: !!c.selected }));
    },
    pickBoxes() {
      const wrap = doc.getElementById('agent-messages');
      if (!wrap) return [];
      return descendants(wrap).filter(x => x.tagName === 'INPUT' && x.dataset && x.dataset.messageId !== undefined);
    },
    pick(id, on) {
      const box = h.pickBoxes().find(x => String(x.dataset.messageId) === String(id));
      assert.ok(box, '讨论消息 #' + id + ' 必须可勾选（页面必须为每条历史消息提供勾选框），实际可勾选：'
        + JSON.stringify(h.pickBoxes().map(x => x.dataset.messageId)));
      box.checked = on === undefined ? true : !!on;
      if (typeof box.onchange === 'function') box.onchange({ target: box });
      return box;
    },
    bubbles() {
      const wrap = doc.getElementById('agent-messages');
      if (!wrap) return [];
      return descendants(wrap).filter(x => x._classes.has('msg-bubble')).map(x => x.textContent);
    },
    writingBubbles() {
      const wrap = doc.getElementById('chat-messages');
      if (!wrap) return [];
      return descendants(wrap).filter(x => x._classes.has('msg-bubble')).map(x => x.textContent);
    },
    textOfClass(containerId, cls) {
      const wrap = doc.getElementById(containerId);
      if (!wrap) return null;
      const hit = descendants(wrap).find(x => x._classes.has(cls));
      return hit ? hit.textContent : null;
    },
    notePosts: () => requests.filter(r => r.method === 'POST' && r.url === '/api/planning-notes'),
    handoffPosts: () => requests.filter(r => r.method === 'POST' && r.url === '/api/handoffs'),
    previewGets: () => requests.filter(r => r.method === 'GET' && /^\/api\/handoffs\/[^/]+$/.test(r.url)),
    acceptPosts: () => requests.filter(r => r.method === 'POST' && /^\/api\/handoffs\/[^/]+\/accept$/.test(r.url)),
    cancelPosts: () => requests.filter(r => r.method === 'POST' && /^\/api\/handoffs\/[^/]+\/cancel$/.test(r.url)),
    closeCalls: () => closeCalls,
    setConfirm(v) { o.confirmResult = v; },
    // 领域写入（正文/大纲/人物/世界观/事件账本/聊天）：交接与笔记流程一律不得产生
    domainWrites: () => requests.filter(r => r.method !== 'GET'
      && r.url.indexOf('/api/planning-notes') !== 0 && r.url.indexOf('/api/handoffs') !== 0),
    async start() {
      try {
        await context.window.AgentPage.show();
      } catch (e) {
        h.startError = e;
      }
      return h;
    },
    async openWritingPage() {
      App.state.currentBook = { id: 7, title: '雾港编年史', mode: 'collab' };
      App.state.currentChapterId = 12;
      await h.page.loadChat();
      return h;
    },
    async waitFor(pred, label, ms) {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return true;
        if (Date.now() - t0 > (ms || 2000)) {
          throw new Error('等待超时：' + (label || '条件未满足')
            + '｜弹窗=' + JSON.stringify(modals.map(m => m.title))
            + '｜toast=' + JSON.stringify(toasts.slice(-3))
            + '｜请求=' + JSON.stringify(requests.slice(-5).map(r => r.method + ' ' + r.url)));
        }
        await new Promise(r => setTimeout(r, 5));
      }
    },
    requireIds(label) {
      const absent = REQUIRED_IDS.filter(id => !CLIENT_IDS.has(id));
      assert.deepEqual(absent, [], (label || '页面') + '骨架缺失（index.html 必须提供真实 id）：' + absent.join(', '));
    },
  };
  return h;
}

function query(url) {
  const out = {};
  const qs = String(url).split('?')[1] || '';
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

function defaultRoute(req, state) {
  const url = req.url;
  const method = req.method;

  if (method === 'GET' && url === '/api/books') return { body: { books: BOOKS } };
  if (method === 'GET' && url === '/api/agent/tools') {
    return { body: { tools: [{ name: 'list_resources', title: '资源目录', description: '只读查询', mutation: 'read', confirmation: 'none' }] } };
  }
  if (method === 'GET' && url.indexOf('/api/conversations?') === 0) {
    const q = query(url);
    if (q.kind === 'writing') {
      const list = WRITING_CONVERSATIONS.filter(c => Number(c.book_id) === Number(q.bookId));
      if (Number(q.bookId) === 9) list.push(OTHER_BOOK_WRITING);
      return { body: list };
    }
    return { body: AGENT_CONVERSATIONS.slice() };
  }
  for (const c of AGENT_CONVERSATIONS) {
    if (method === 'GET' && url.indexOf('/api/conversations/' + c.id + '/messages') === 0) {
      return { body: { messages: c.id === 'c-global' ? GLOBAL_MESSAGES : BOOK_MESSAGES } };
    }
  }
  if (method === 'GET' && url.indexOf('/api/resources') === 0) {
    const q = query(url);
    return {
      body: {
        type: q.type, bookId: q.bookId ? Number(q.bookId) : null, nextCursor: null,
        items: [{ type: 'chapter', id: 12, title: '第1章 石碑', bookId: Number(q.bookId), status: 'draft', route: '#/book/7/read/12', meta: { sortOrder: 1, revision: 1 } }],
      },
    };
  }
  // 写作页：消息与动作
  if (method === 'GET' && url.indexOf('/api/books/7/chat?') === 0) {
    return { body: { conversationId: 'w-7-a', messages: [PLAIN_USER_MESSAGE, HANDOFF_MESSAGE] } };
  }
  if (method === 'GET' && url === '/api/books/7/chat/actions') return { body: { actions: [] } };
  if (method === 'GET' && url.indexOf('/api/books/7/context-status') === 0) {
    return { body: { contextWindow: 128000, estimatedPromptTokens: 12, messages: { active: 2, archived: 0 } } };
  }
  if (method === 'GET' && url.indexOf('/api/conversations?kind=writing') === 0) return { body: WRITING_CONVERSATIONS.slice() };
  // 规划笔记
  if (method === 'POST' && url === '/api/planning-notes') {
    return {
      status: 201,
      body: {
        id: NOTE_ID, conversationId: req.body.conversationId, bookId: 7,
        title: req.body.title || '', text: req.body.text || '',
        selectedMessageIds: req.body.selectedMessageIds || [],
        revision: 1, status: 'draft', createdAt: '2026-09-22 10:00:00', updatedAt: '2026-09-22 10:00:00',
      },
    };
  }
  // 交接：草案 / 预览 / 采纳
  if (method === 'POST' && url === '/api/handoffs') {
    state.draft = {
      id: 'h-1', status: 'draft', bookId: 7,
      originConversationId: req.body.originConversationId,
      originTitle: '《雾港编年史》· 叛变推演',
      targetConversationId: req.body.targetConversationId,
      text: req.body.text || '', selectedMessageIds: req.body.selectedMessageIds || [],
      sourceRefs: req.body.sourceRefs || [],
    };
    return { status: 201, body: handoffView(state, 1) };
  }
  if (method === 'GET' && /^\/api\/handoffs\/[^/]+$/.test(url)) {
    if (!state.draft) return { status: 404, body: { error: { code: 'HANDOFF_NOT_FOUND', message: '交接草案不存在' } } };
    return { body: handoffView(state, state.fpVersion) };
  }
  // A-3：作废草案（只对 draft 生效；已采纳 409）
  if (method === 'POST' && /^\/api\/handoffs\/[^/]+\/cancel$/.test(url)) {
    if (state.cancelAccepted) {
      return {
        status: 409,
        body: {
          error: {
            code: 'HANDOFF_ALREADY_ACCEPTED',
            message: '该交接已被采纳：那条注明来源的消息已经写进写作会话，作废不会撤回它（要换结论请重新创建草案）',
          },
        },
      };
    }
    if (state.draft) state.draft.status = 'cancelled';
    return { body: Object.assign(handoffView(state, state.fpVersion), { status: 'cancelled', duplicate: false }) };
  }
  if (method === 'POST' && /^\/api\/handoffs\/[^/]+\/accept$/.test(url)) {
    state.accepts += 1;
    if (state.accepts === 1 && state.staleFirst) {
      state.fpVersion = 2; // 来源已变：重新预览必然拿到新指纹
      return {
        status: 409,
        body: {
          error: {
            code: 'HANDOFF_SOURCE_CHANGED',
            message: '来源资料已更新，请重新预览后再采纳',
            details: { currentSourceFingerprint: 'sha256:fp-2' },
          },
        },
      };
    }
    if (state.accepts === 1) state.fpVersion = 2; // 接受后来源指纹前进（再次预览必然是新值）
    return { body: Object.assign(handoffView(state, state.fpVersion), { status: 'accepted', acceptedAt: '2026-09-22 10:05:00', acceptedMessageId: 641, duplicate: false, messageId: 641 }) };
  }
  return null;
}

function handoffView(state, fpVersion) {
  const d = state.draft || {};
  const excerpts = (d.selectedMessageIds || []).map(id => {
    const hit = BOOK_MESSAGES.concat(GLOBAL_MESSAGES).find(m => Number(m.id) === Number(id)) || { role: 'assistant', content: '' };
    return { messageId: Number(id), role: hit.role, excerpt: hit.content, truncated: false };
  });
  return {
    id: 'h-1', status: 'draft', bookId: 7,
    originConversationId: d.originConversationId || 'c-book-7',
    originTitle: d.originTitle || '《雾港编年史》· 叛变推演',
    targetConversationId: d.targetConversationId || 'w-7-a',
    target: {
      conversationId: d.targetConversationId || 'w-7-a',
      title: (WRITING_CONVERSATIONS.find(c => c.id === (d.targetConversationId || 'w-7-a')) || {}).title || '写作会话',
      status: 'active',
      busy: !!state.previewBusy,
    },
    text: d.text || '',
    selectedMessageIds: d.selectedMessageIds || [],
    sourceRefs: d.sourceRefs || [],
    material: { text: d.text || '', excerpts, sourceRefs: (d.sourceRefs || []).map(ref => (ref.kind === 'planning_note'
      ? { kind: 'planning_note', id: NOTE_ID, title: '叛变线两条结论', revision: 2 }
      : ref)) },
    sourceFingerprint: 'sha256:fp-' + fpVersion,
    sourceChanged: false,
    sourceIssue: '',
    acceptedAt: null,
    acceptedMessageId: null,
    createdAt: '2026-09-22 10:00:00',
    updatedAt: '2026-09-22 10:00:00',
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('S4-04b 骨架与选择：讨论消息可勾选，工具条提供存笔记/创建交接入口（选择本身不发请求）', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7' } });
  h.requireIds('Agent 台');
  await h.start();
  assert.equal(h.startError, undefined, 'Agent 台初始化不得抛错：' + (h.startError && h.startError.message));
  assert.deepEqual(h.missingIds(), [], '页面代码请求了 index.html 中不存在的 id：' + h.missingIds().join(', '));

  assert.ok(h.node('agent-pick-bar')._classes.has('hidden'), '未勾选时选择工具条必须收起');
  assert.deepEqual(
    h.pickBoxes().map(b => String(b.dataset.messageId)).sort(),
    ['1', '2', '3', '4'],
    '每条历史消息都必须可勾选（不能只挑助手消息）：'
      + JSON.stringify(h.pickBoxes().map(b => b.dataset.messageId))
  );

  h.pick(2);
  h.pick(3);
  assert.equal(h.node('agent-pick-bar')._classes.has('hidden'), false, '勾选后工具条必须出现');
  assert.ok(h.text('agent-pick-count').indexOf('2') >= 0, '工具条必须显示已选条数，实际：' + h.text('agent-pick-count'));

  // 勾选 / 取消勾选是纯本地行为：不得凭空创建会话或发任何写请求
  h.pick(3, false);
  assert.ok(h.text('agent-pick-count').indexOf('1') >= 0, '取消勾选后条数同步');
  h.fire('btn-agent-pick-clear', 'click');
  assert.equal(h.node('agent-pick-bar')._classes.has('hidden'), true, '清空选择后工具条收起');
  assert.deepEqual(h.domainWrites(), [], '勾选/清空不得产生任何写请求：'
    + JSON.stringify(h.domainWrites().map(r => r.method + ' ' + r.url)));
});

test('S4-04b 存规划笔记：走 S4-04a 接口、只带选中消息，不写正文/大纲/人物/世界观/事件账本', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7' } });
  await h.start();
  assert.ok(h.node('btn-agent-save-note'), 'Agent 台必须提供「存为规划笔记」入口');

  h.pick(2);
  h.pick(3);
  h.fire('btn-agent-save-note', 'click');
  await h.waitFor(() => h.modals.length === 1, '笔记弹窗打开');
  const modal = h.modal();
  assert.ok(modal.bodyHTML.indexOf('规划笔记') >= 0, '弹窗标题必须说明这是规划笔记');
  assert.ok(modal.bodyHTML.indexOf('草稿') >= 0, '必须明说笔记只是草稿：' + modal.bodyHTML.slice(0, 120));
  assert.ok(modal.bodyHTML.indexOf('#2') >= 0 && modal.bodyHTML.indexOf('#3') >= 0, '必须列出作为来源的选中消息');
  assert.equal(modal.bodyHTML.indexOf('今天天气不错'), -1, '未选中的讨论不得进笔记');
  assert.deepEqual(h.modalMissingIds(), [], '弹窗查询了自己没有渲染的字段：' + h.modalMissingIds().join(', '));

  const textEl = h.modalBody().querySelector('#agent-note-text');
  assert.ok(textEl, '笔记弹窗必须提供可编辑正文');
  textEl.value = '林野不会主动叛变但会隐瞒；副官因旧债倒戈。';
  await h.modalOk();
  await h.waitFor(() => h.notePosts().length === 1, '笔记请求');
  const body = h.notePosts()[0].body;
  assert.equal(body.conversationId, 'c-book-7', '笔记必须归属当前讨论会话');
  assert.deepEqual(body.selectedMessageIds, [2, 3], '只带作者勾选的两条结论');
  assert.equal(body.text, '林野不会主动叛变但会隐瞒；副官因旧债倒戈。', '用作者编辑后的正文');
  assert.equal('status' in body, false, '客户端不得伪造笔记状态（服务端产生）');
  assert.equal('revision' in body, false, '客户端不得伪造 revision');
  assert.deepEqual(h.domainWrites(), [], '存笔记不得改正文/大纲/人物/世界观/事件账本/聊天：'
    + JSON.stringify(h.domainWrites().map(r => r.method + ' ' + r.url)));
});

test('S4-04b 交接（书籍范围）：目标取自本书会话，预览后才接受，一次点击只发一笔', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7', writing_conversation_7: 'w-7-b' } });
  await h.start();
  h.pick(2);
  h.pick(3);
  h.fire('btn-agent-create-handoff', 'click');
  await h.waitFor(() => h.modals.length === 1, '交接弹窗打开');

  // 目标会话只可能来自本书：页面必须按「当前范围的书」取写作会话列表
  assert.ok(h.requests.some(r => r.url === '/api/conversations?kind=writing&bookId=7'),
    '必须按当前范围的书取写作会话，实际：' + JSON.stringify(h.requests.map(r => r.method + ' ' + r.url)));
  const targetSel = h.modalBody().querySelector('#handoff-target-conversation');
  assert.ok(targetSel, '交接弹窗必须提供目标写作会话选择');
  assert.deepEqual(h.modalOptions('#handoff-target-conversation').map(o => o.value), ['w-7-a', 'w-7-b'],
    '只列本书的写作会话');
  assert.equal(targetSel.value, 'w-7-b', '默认落在作者当前写作会话（仍可在弹窗里改）');
  assert.equal(h.modalOptions('#handoff-target-book').length, 0, '书籍范围内目标书由范围决定，不给跨书入口');

  const material = h.modalBody().querySelector('#handoff-material').textContent;
  assert.ok(material.indexOf('林野不会主动叛变') >= 0 && material.indexOf('副官会因为旧债') >= 0,
    '材料预览必须逐字含选中的两条结论，实际：' + material);
  assert.equal(material.indexOf('今天天气不错'), -1, '未选中的讨论不得进材料');

  const textEl = h.modalBody().querySelector('#handoff-text');
  assert.ok(textEl, '交接弹窗必须提供可编辑摘要');
  textEl.value = '把这两条结论带进正文写作。';
  await h.modalOk();
  await h.waitFor(() => h.handoffPosts().length === 1, '创建草案');
  const draft = h.handoffPosts()[0].body;
  assert.equal(draft.originConversationId, 'c-book-7', '来源必须是当前讨论会话');
  assert.equal(draft.targetConversationId, 'w-7-b', '目标必须是作者选定的写作会话');
  assert.deepEqual(draft.selectedMessageIds, [2, 3]);
  assert.equal(draft.text, '把这两条结论带进正文写作。');
  assert.deepEqual(draft.sourceRefs, [], '未勾选来源引用时不凭空加引用');
  assert.equal('status' in draft, false, '客户端不得伪造草案状态');
  assert.equal('sourceFingerprint' in draft, false, '客户端不得伪造来源指纹');

  // 预览阶段：服务端回显（GET /api/handoffs/h-1）——摘要/来源/目标/指纹都在，接受前不得写入
  await h.waitFor(() => h.previewGets().length === 1, '预览');
  const previewHtml = h.modal().bodyHTML;
  assert.ok(previewHtml.indexOf('把这两条结论带进正文写作。') >= 0, '预览必须显示将写入的摘要');
  assert.ok(previewHtml.indexOf('另一条写作会话') >= 0, '预览必须显示目标写作会话');
  assert.ok(previewHtml.indexOf('sha256:fp-1') >= 0, '预览必须显示来源指纹（接受要带它）');
  assert.ok(previewHtml.indexOf('不改正文') >= 0, '预览必须说明交接不改正文/大纲/事实');
  assert.deepEqual(h.acceptPosts(), [], '只预览不得产生写入');

  // 接受：一次点击只发一笔（按钮即时禁用 + 处理中标志）
  h.fireInModal('#btn-handoff-accept', 'click');
  const acceptBtn = h.modalBody().querySelector('#btn-handoff-accept');
  assert.equal(acceptBtn.disabled, true, '接受按钮必须即时禁用（防重复点击）');
  h.fireInModal('#btn-handoff-accept', 'click'); // 第一次仍在飞行中的第二次点击
  await h.waitFor(() => h.acceptPosts().length >= 1, '接受请求');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.acceptPosts().length, 1, '一次点击序列只能发一笔 accept');
  await h.waitFor(() => h.modal().bodyHTML.indexOf('已交接') >= 0, '接受完成态');
  assert.equal(h.acceptPosts()[0].body.expectedSourceFingerprint, 'sha256:fp-1', '接受必须回传预览拿到的指纹');

  // 完成态：显示已交接与消息 id；此时没有第二个可点的接受入口
  assert.ok(h.modal().bodyHTML.indexOf('已交接') >= 0, '接受后必须显示已交接');
  assert.ok(h.modal().bodyHTML.indexOf('641') >= 0, '必须显示写入的消息 id');
  assert.equal(h.fireInModal('#btn-handoff-accept', 'click'), null, '完成态不得再留有接受按钮');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.acceptPosts().length, 1, '完成态重复点击仍只有一笔（重复消息由服务端幂等兜底）');
  assert.deepEqual(h.domainWrites(), [], '交接全程不得产生领域写入：'
    + JSON.stringify(h.domainWrites().map(r => r.method + ' ' + r.url)));
});

test('S4-04b 交接（全局范围）：目标书与会话必须作者明确选定，不自动挑书、不夹带他书材料', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'global' }, state: { previewBusy: true } });
  await h.start();
  assert.equal(h.node('agent-conversation-select').value, 'c-global', '全局范围用全局会话');

  h.pick(11);
  h.fire('btn-agent-create-handoff', 'click');
  await h.waitFor(() => h.modals.length === 1, '交接弹窗打开');

  const bookSel = h.modalBody().querySelector('#handoff-target-book');
  assert.ok(bookSel, '全局范围交接必须由作者选定目标书');
  assert.deepEqual(h.modalOptions('#handoff-target-book').map(o => o.value), ['', '7', '9'], '目标书列表来自书架（第一项是「请选择」占位，不预选任何一本书）');

  // 未选定目标书：不得创建草案，且必须给明确提示（不自动挑书）
  await h.modalOk();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(h.handoffPosts(), [], '未选目标书时不得创建草案');
  assert.ok(h.toasts.some(t => t.indexOf('目标') >= 0), '必须提示先选定目标：' + JSON.stringify(h.toasts));

  // 选定目标书 → 只列该书的写作会话（不列别书）
  bookSel.value = '7';
  h.fireInModal('#handoff-target-book', 'change');
  await h.waitFor(() => h.requests.some(r => r.url === '/api/conversations?kind=writing&bookId=7'), '目标书会话列表');
  await h.waitFor(() => h.modalOptions('#handoff-target-conversation').some(o => o.value === 'w-7-a'), '目标会话选项渲染');
  const opts = h.modalOptions('#handoff-target-conversation').map(o => o.value);
  assert.deepEqual(opts, ['', 'w-7-a', 'w-7-b'],
    '只列目标书的写作会话，且不预选会话（第一项是占位），实际：' + JSON.stringify(opts));
  assert.equal(opts.indexOf('w-9'), -1, '不得把别的书的写作会话列为目标');

  // 未选定目标会话（选中仍是「请选择写作会话」占位）：仍不得创建草案
  assert.equal(h.modalBody().querySelector('#handoff-target-conversation').value, '', '选中目标书后会话是否仍然留在占位');
  await h.modalOk();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(h.handoffPosts(), [], '未选目标会话时不得创建草案');

  h.modalBody().querySelector('#handoff-target-conversation').value = 'w-7-a';
  h.modalBody().querySelector('#handoff-text').value = '全局讨论的结论交给这本书的写作。';
  await h.modalOk();
  await h.waitFor(() => h.handoffPosts().length === 1, '创建草案');
  const draft = h.handoffPosts()[0].body;
  assert.equal(draft.originConversationId, 'c-global', '来源是全局讨论会话');
  assert.equal(draft.targetConversationId, 'w-7-a', '目标是作者选定的写作会话');
  const rawDraft = JSON.stringify(draft);
  assert.equal(rawDraft.indexOf(OTHER_BOOK_SENTINEL), -1, '不得夹带其他书正文');
  assert.equal(rawDraft.indexOf(OTHER_BOOK_OUTLINE), -1, '不得夹带整书资料');

  // 目标有活跃运行：预览必须显示「运行中」排队提示、禁用接受，且程序化点击也发不出请求
  await h.waitFor(() => h.previewGets().length === 1, '预览');
  assert.ok(h.modal().bodyHTML.indexOf('运行中') >= 0, '预览必须显示目标正在运行');
  const acceptBtn = h.modalBody().querySelector('#btn-handoff-accept');
  assert.ok(acceptBtn, '预览必须提供接受入口');
  assert.equal(acceptBtn.disabled, true, '目标运行中：接受必须禁用（明确排队，不混进正在发给模型的请求）');
  h.fireInModal('#btn-handoff-accept', 'click');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(h.acceptPosts(), [], '忙碌时程序化点击也不得发出接受');
  assert.ok(h.modal().bodyHTML.indexOf('等这一轮结束') >= 0 || h.modal().bodyHTML.indexOf('结束') >= 0,
    '必须给出明确排队提示：' + h.modal().bodyHTML.slice(0, 200));

  // 运行结束后重新预览 → 可接受，且必须用新预览的指纹
  h.state.previewBusy = false;
  h.fireInModal('#btn-handoff-refresh', 'click');
  await h.waitFor(() => h.previewGets().length === 2, '重新预览');
  await h.waitFor(() => h.modal().bodyHTML.indexOf('id="btn-handoff-accept" class="btn btn-small btn-primary">接受交接') >= 0,
    '运行结束后的重新预览渲染（接受应可用）');
  const acceptBtn2 = h.modalBody().querySelector('#btn-handoff-accept');
  assert.equal(acceptBtn2.disabled, false, '运行结束后可接受');
  h.fireInModal('#btn-handoff-accept', 'click');
  await h.waitFor(() => h.acceptPosts().length === 1, '接受');
  assert.equal(h.acceptPosts()[0].body.expectedSourceFingerprint, 'sha256:fp-1', '接受带重新预览拿到的指纹');
});

test('A-3 作废草案：预览第三按钮、二次确认后才发一笔 cancel，只带空体且不产生领域写入', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7' } });
  await h.start();
  h.pick(2);
  h.fire('btn-agent-create-handoff', 'click');
  await h.waitFor(() => h.modals.length === 1, '交接弹窗');
  await h.modalOk();
  await h.waitFor(() => h.previewGets().length === 1, '预览');

  const cancelBtn = h.modalBody().querySelector('#btn-handoff-cancel');
  assert.ok(cancelBtn, '预览弹窗必须提供「作废草案」第三按钮');
  assert.ok(h.modal().bodyHTML.indexOf('作废') >= 0, '预览必须说明作废只作用于这份还没交接的草案');
  assert.ok(h.modal().bodyHTML.indexOf('未向写作会话写入任何内容') >= 0,
    '作废说明必须写明不写入写作会话：' + h.modal().bodyHTML.slice(-220));

  // 二次确认取消：不发任何请求，弹窗不动
  h.setConfirm(false);
  h.fireInModal('#btn-handoff-cancel', 'click');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(h.cancelPosts(), [], '取消二次确认后不得发作废请求');
  assert.deepEqual(h.acceptPosts(), [], '作废入口不得发采纳请求');
  assert.equal(h.closeCalls(), 0, '取消确认不得关闭弹窗');
  assert.ok(h.modalBody().querySelector('#btn-handoff-accept'), '取消确认后仍是预览态（接受入口还在）');

  // 确认作废：一笔请求、空体（客户端不得伪造状态）、成功文案不得读成「撤回」
  h.setConfirm(true);
  h.fireInModal('#btn-handoff-cancel', 'click');
  assert.equal(h.modalBody().querySelector('#btn-handoff-cancel').disabled, true,
    '作废按钮必须即时禁用（防重复点击）');
  h.fireInModal('#btn-handoff-cancel', 'click'); // 飞行中的第二次点击
  await h.waitFor(() => h.cancelPosts().length === 1, '作废请求');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.cancelPosts().length, 1, '一次点击序列只能发一笔 cancel');
  assert.deepEqual(Object.keys(h.cancelPosts()[0].body || {}), [], '作废只发空体：客户端不得伪造状态');
  const okToast = h.toasts.find(t => t.indexOf('草案已作废') >= 0);
  assert.ok(okToast && okToast.indexOf('未向写作会话写入') >= 0,
    '成功提示必须写明草案已作废且未写入写作会话，实际：' + JSON.stringify(h.toasts));
  assert.equal(okToast.indexOf('撤回'), -1,
    '成功提示不得让作者读成「已写入的消息被撤回」：' + okToast);
  assert.equal(h.closeCalls(), 1, '作废成功后必须关闭弹窗');
  assert.deepEqual(h.domainWrites(), [], '作废全程不得产生领域写入：'
    + JSON.stringify(h.domainWrites().map(r => r.method + ' ' + r.url)));
});

test('A-3 已采纳后作废：409 必须明确「不会撤回已写进写作会话的消息」，且前端不自动重试', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7' }, state: { cancelAccepted: true } });
  await h.start();
  h.pick(2);
  h.fire('btn-agent-create-handoff', 'click');
  await h.waitFor(() => h.modals.length === 1, '交接弹窗');
  await h.modalOk();
  await h.waitFor(() => h.previewGets().length === 1, '预览');

  h.setConfirm(true);
  h.fireInModal('#btn-handoff-cancel', 'click');
  await h.waitFor(() => h.toasts.some(t => t.indexOf('不会撤回') >= 0), '已采纳的作废提示');
  const toast = h.toasts.find(t => t.indexOf('不会撤回') >= 0);
  assert.ok(toast.indexOf('已经写进写作会话') >= 0,
    '必须明确告诉作者那条消息已经写进写作会话，实际：' + toast);
  assert.equal(h.cancelPosts().length, 1, '一次点击只发一笔作废（被拒后不自动重试）');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.cancelPosts().length, 1, '前端不得自动重试作废');
  assert.deepEqual(h.acceptPosts(), [], '作废入口不得发采纳请求');
  assert.equal(h.modal().bodyHTML.indexOf('已交接'), -1, '被拒的作废不得渲染成完成态');
  assert.deepEqual(h.domainWrites(), [], '作废被拒不得产生领域写入：'
    + JSON.stringify(h.domainWrites().map(r => r.method + ' ' + r.url)));
});

test('S4-04b 来源变更：409 必须提示重新预览、前端不拿旧指纹重试，重新预览后可接受', async () => {
  const h = harness({ route: defaultRoute, storage: { agent_scope_v1: 'book:7' }, state: { staleFirst: true } });
  await h.start();
  h.pick(2);
  h.fire('btn-agent-create-handoff', 'click');
  await h.waitFor(() => h.modals.length === 1, '交接弹窗');
  await h.modalOk();
  await h.waitFor(() => h.previewGets().length === 1, '预览');

  h.fireInModal('#btn-handoff-accept', 'click');
  await h.waitFor(() => h.toasts.some(t => t.indexOf('重新预览') >= 0),
    '来源变更後的明确提示');
  assert.equal(h.acceptPosts().length, 1, '一次点击只发一笔接受');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.acceptPosts().length, 1, '前端不得自动拿旧指纹重试');
  await h.waitFor(() => h.previewGets().length >= 2, '来源变更后重新读取预览');
  assert.ok(h.modal().bodyHTML.indexOf('sha256:fp-2') >= 0, '重新预览必须给出新指纹');

  // 作者点「重新预览」核对后再接受（用新指纹）
  h.fireInModal('#btn-handoff-refresh', 'click');
  await h.waitFor(() => h.previewGets().length >= 3, '重新预览');
  h.fireInModal('#btn-handoff-accept', 'click');
  await h.waitFor(() => h.acceptPosts().length === 2, '接受');
  assert.equal(h.acceptPosts()[1].body.expectedSourceFingerprint, 'sha256:fp-2', '第二次接受用新预览的指纹');
  await h.waitFor(() => h.modal().bodyHTML.indexOf('已交接') >= 0, '接受完成态');
  assert.ok(h.modal().bodyHTML.indexOf('已交接') >= 0, '重新预览后可接受');
});

test('S4-04b 写作页：交接消息可跳转来源讨论，来源引用逐字可核对（不是 #NaN）', async () => {
  const h = harness({ route: defaultRoute, storage: { writing_conversation_7: 'w-7-a' } });
  await h.openWritingPage();
  assert.deepEqual(h.missingIds(), [], '写作页代码请求了 index.html 中不存在的 id：' + h.missingIds().join(', '));

  const bubbles = h.writingBubbles();
  assert.ok(bubbles.some(t => t.indexOf('【来自 Agent 讨论·显式交接】') >= 0), '交接消息必须渲染在写作会话里');
  assert.ok(bubbles.some(t => t.indexOf('把这两条结论带进正文写作。') >= 0), '交接材料正文必须可见');

  // 来源引用逐字可核对：笔记 id 与 revision 不得被渲染成 #NaN
  const refs = h.textOfClass('chat-messages', 'msg-handoff-refs');
  assert.ok(refs, '交接消息必须提供「来源与引用」入口');
  assert.ok(refs.indexOf('规划笔记 #' + NOTE_ID) >= 0, '来源引用必须逐字含笔记 id，实际：' + refs);
  assert.ok(refs.indexOf('revision 2') >= 0, '来源引用必须含版本，实际：' + refs);
  assert.equal(refs.indexOf('NaN'), -1, '来源引用不得出现 NaN');

  // 跳转来源讨论：写 Agent 台的落点键（范围 + 会话）+ 记下写作页返回锚
  const jumped = h.fireInChild('chat-messages', n => n.tagName === 'BUTTON' && n.textContent === '查看来源讨论', 'click');
  assert.ok(jumped, '交接消息必须提供「查看来源讨论」入口');
  await h.waitFor(() => h.storageGet('agent_conversation_v1') === 'c-book-7', 'Agent 台落点键');
  assert.equal(h.storageGet('agent_scope_v1'), 'book:7', '来源是书籍范围会话：范围键必须落到同一本书');
  assert.ok(h.page.savedReturn, '必须记下写作页返回锚（BookPage.saveWritingReturn）');
  assert.equal(h.page.savedReturn.bookId, 7, '返回锚必须是当前书');
  assert.equal(h.page.savedReturn.chapterId, 12, '返回锚必须是当前章（不是其他章）');
  assert.equal(h.doc.hidden, false);

  // 普通消息不得出现交接入口（不误伤其他消息）
  const buttons = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tagName === 'BUTTON' && c.textContent === '查看来源讨论') buttons.push(c);
      walk(c);
    }
  })(h.node('chat-messages'));
  assert.equal(buttons.length, 1, '只有交接消息才有来源跳转入口（普通消息不误伤），实际 ' + buttons.length + ' 个');
});
