// S4-02 / 任务书 05「沉浸式写作与另开讨论」页面回归。
// 载入真实 public/index.html 的 id 集合与真实页面代码（chat-event-hub.js、chapter-collapse.js、
// chapter-conflict.js、book-chapters.js、book-outline.js、book-state.js、book-chat.js、book.js），
// 用最小 DOM/App 桩跑真实代码，钉住任务书与冻结契约要求：
//   1) 当前写作会话/章节/保存状态始终可见（状态条在可折叠的资源侧栏之外）。
//   2) 折叠资源侧栏不重新初始化编辑器、不清空正在流的这一轮。
//   3) 「另开整体讨论」只带书籍与明确选中的文字：默认不带写作历史（哨兵）。
//   4) 未保存稿先走既有离开守卫（BookPage.leaveGuard）。
//   5) 从 Agent 台返回后还原同一写作会话、同一章。
//   6) 页面被隐藏（visibilitychange）不宣告取消/完成；终态由 run-service 的 run 状态决定。
//   7) 原入口（参谋/润色/总结/定稿/回收站版本通道）保持可达；新入口不自己发起对话流。
//
// 桩的纪律（吸取 S1-03c「VM 桩过松掩盖真实选择器缺陷」的教训）：
//   · document.getElementById 只认 public/index.html 里真实存在的 id；页面代码请求不存在的 id
//     会被记入 missingIds 并返回 null，用例显式断言 missingIds 为空——不允许「桩比页面宽」。
//   · 本桩不解析 innerHTML（无 HTML 解析器），章节列表/消息区的渲染结果不在断言范围；
//     断言对象是状态条、编辑器、消息区节点、localStorage/sessionStorage 与请求体。
//   · 弹窗内部的动态字段（#agent-discuss-*）不在 index.html 的静态 id 里：桩按
//     MODAL_FIELDS 白名单提供，页面查询白名单外的选择器会被记入 unknownModalSelectors 并断言为空。
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

// 写作工作台必须提供的 id（断言打在真实 index.html 上）
const REQUIRED_IDS = [
  'page-book', 'book-workbench', 'panel-left', 'btn-toggle-left-panel',
  'writing-status-bar', 'writing-status-book', 'writing-status-chapter',
  'writing-status-conversation', 'writing-status-save',
  'btn-open-agent-discuss',
  'writing-conversation-select', 'btn-new-writing-conv', 'btn-compress', 'btn-clear-chat',
  'btn-consult', 'btn-chat-stop', 'chat-form', 'chat-text', 'chat-messages',
  'btn-polish-chapter', 'btn-polish-selection', 'btn-gen-summary', 'btn-lock-chapter',
  'btn-chapter-recycle', 'btn-save-chapter', 'chapter-content', 'chapter-title-input', 'chapter-beat',
  'editor-body', 'editor-empty',
  'agent-return-writing',
];
// 弹窗内动态字段（页面代码用 modal body.querySelector 读取）
const MODAL_FIELDS = ['agent-discuss-quote', 'agent-discuss-character', 'agent-discuss-preview'];

const BOOK = { id: 7, title: '雾港编年史', mode: 'collab', master_outline: '总纲' };
const CHAPTER = { id: 12, title: '第1章 石碑', content: '石碑正文', beat: '起', revision: 3, volume_id: 1 };
const CHARACTERS = [{ id: 5, name: '林昭', role: '主角' }];
const WRITING_CONV = { id: 'conv-writing-1', kind: 'writing', scope: 'book', book_id: 7, title: '新写作任务', status: 'active' };
// 写作历史里的一条独有内容：任何「另开整体讨论」路径都不得把它带进 Agent 台
const WRITING_HISTORY_SENTINEL = 'WRITING_HISTORY_SENTINEL_写作历史里的一句私密草稿';
const SELECTED_TEXT = '这是作者在正文里明确选中的一段文字。';

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

function harness(opts) {
  const o = opts || {};
  const nodes = new Map();
  const missing = new Set();
  const unknownModalSelectors = new Set();
  const requests = [];
  const toasts = [];
  const modals = [];
  let modalBody = null;
  let modalClosed = 0;

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
    // isConnected：沿父链找「已挂到页面上的节点」。book-chat 用它判断实时气泡是否已被收尾/移除
    // （phase 秒表自清），所以这里必须按父链算，不能只看自身 parent。
    Object.defineProperty(el, 'isConnected', {
      get() {
        let n = el;
        while (n) {
          if (n.__inDoc) return true;
          if (!n.parent) return false;
          n = n.parent;
        }
        return false;
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
    el.getAttribute = name => (name === 'data-tab' ? (el.dataset ? el.dataset.tab : null) : null);
    el.setAttribute = () => {};
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    el.insertAdjacentText = (pos, text) => { pushText(el, String(text)); };
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

  // 极简 innerHTML 解析：只认标签/属性/文本，够页面自己的固定模板用（book-chat 的实时气泡、
  // 各类列表项）。属性照 data-* → dataset、class → classList 落地，节点引用即可被
  // querySelector('.msg-phase') 这类选择器找到——桩不解析 innerHTML 会让实时气泡整条渲染链失效。
  function parseHTML(host, html) {
    const stack = [host];
    const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)\/?>/g;
    let last = 0;
    let m;
    while ((m = re.exec(html))) {
      const text = html.slice(last, m.index);
      if (text) pushText(stack[stack.length - 1], text);
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
    if (tail) pushText(stack[stack.length - 1], tail);
  }
  function pushText(parent, text) {
    if (!String(text).trim()) return;
    const n = { nodeType: 3, textContent: String(text), children: [] };
    n.parent = parent;
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
      else if (name === 'open') node.open = true;
      else if (name === 'disabled') node.disabled = true;
      else if (name === 'hidden') node.classList.add('hidden');
      else if (name.indexOf('data-') === 0) {
        const key = name.slice(5).replace(/-([a-z])/g, (s, c) => c.toUpperCase());
        node.dataset[key] = val;
      }
    }
  }

  const doc = {
    getElementById(id) {
      if (!CLIENT_IDS.has(id)) { missing.add(id); return null; }
      if (!nodes.has(id)) {
        const el = makeEl('div');
        el.id = id;
        el.__inDoc = true; // 真实 index.html 里的节点：挂在页面上
        nodes.set(id, el);
      }
      return nodes.get(id);
    },
    createElement: makeEl,
    createTextNode: t => ({ nodeType: 3, textContent: String(t == null ? '' : t), children: [] }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    hidden: false,
  };

  let stream = null; // 可控 SSE 通道（需要「流还在跑」时做别的操作）
  const agentMsgByConv = new Map(); // Agent 台：POST 的初始材料按会话记下，供 messages 路由回放
  function openStream() {
    const enc = (s) => new TextEncoder().encode(s);
    let controller = null;
    const body = new ReadableStream({ start(c) { controller = c; } });
    stream = {
      frame(f) { controller.enqueue(enc('data: ' + JSON.stringify(f) + '\n\n')); },
      close() { controller.enqueue(enc('data: [DONE]\n\n')); controller.close(); },
    };
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  function defaultRoute(req) {
    const url = req.url;
    const method = req.method;
    if (method === 'GET' && url === '/api/books/7') return { body: { book: BOOK } };
    if (method === 'GET' && url === '/api/books/7/volumes') return { body: { volumes: [{ id: 1, title: '第一卷' }] } };
    if (method === 'GET' && url === '/api/books/7/chapters') return { body: { chapters: [CHAPTER] } };
    if (method === 'GET' && url === '/api/books/7/chapters/12') return { body: { chapter: CHAPTER } };
    if (method === 'GET' && url === '/api/books/7/state') return { body: { states: {} } };
    if (method === 'GET' && url === '/api/books/7/world') return { body: { entries: [] } };
    if (method === 'GET' && url === '/api/books/7/characters') return { body: { characters: CHARACTERS } };
    if (method === 'GET' && url.indexOf('/api/books/7/chat?') === 0) {
      return {
        body: {
          conversationId: WRITING_CONV.id,
          messages: [
            { id: 101, role: 'user', content: WRITING_HISTORY_SENTINEL, source: 'writing', created_at: '2026-09-22 10:00:00' },
            { id: 102, role: 'assistant', content: '写作助手的回复', source: 'writing', tools: [], created_at: '2026-09-22 10:01:00' },
          ],
          expiredActions: [],
        },
      };
    }
    if (method === 'GET' && url === '/api/books/7/chat/actions') return { body: { actions: [] } };
    if (method === 'GET' && url.indexOf('/api/books/7/context-status') === 0) {
      return { body: { contextWindow: 128000, estimatedPromptTokens: 1000, messages: { active: 2 } } };
    }
    if (method === 'GET' && url === '/api/conversations?kind=writing&bookId=7') return { body: [WRITING_CONV] };
    if (method === 'POST' && url === '/api/conversations') {
      const body = req.body || {};
      if (body.kind === 'writing') return { status: 201, body: { id: 'conv-writing-2', kind: 'writing', scope: 'book', book_id: 7, title: body.title, status: 'active' } };
      return { status: 201, body: { id: 'conv-agent-draft', kind: body.kind, scope: body.scope, book_id: body.bookId, title: body.title, status: 'active' } };
    }
    if (method === 'POST' && /^\/api\/conversations\/[^/]+\/messages$/.test(url)) {
      const convId = url.split('/')[3];
      agentMsgByConv.set(convId, (req.body && req.body.content) || '');
      return { status: 201, body: { id: 900, conversationId: convId, role: 'user' } };
    }
    // ---- Agent 台（S4-02 交接落点）：会话列表/历史按页面刚写入的键回放 ----
    if (method === 'GET' && url === '/api/books') {
      return { body: { books: [{ id: BOOK.id, title: BOOK.title, mode: BOOK.mode }] } };
    }
    if (method === 'GET' && url === '/api/conversations?kind=agent') {
      const draftId = storage.get('agent_conversation_v1');
      return {
        body: draftId
          ? [{ id: draftId, kind: 'agent', scope: 'book', book_id: BOOK.id, title: '《' + BOOK.title + '》· 整体讨论', status: 'active', updated_at: '2026-09-22 10:05:00' }]
          : [],
      };
    }
    if (method === 'GET' && url.indexOf('/api/resources?type=chapter&bookId=' + BOOK.id) === 0) {
      return {
        body: {
          type: 'chapter', bookId: BOOK.id, nextCursor: null,
          items: [{ type: 'chapter', id: CHAPTER.id, title: CHAPTER.title, bookId: BOOK.id, status: 'draft', route: '#/book/' + BOOK.id + '/read/' + CHAPTER.id, meta: { sortOrder: 1, revision: CHAPTER.revision } }],
        },
      };
    }
    if (method === 'GET' && /^\/api\/conversations\/[^/]+\/messages\?limit=200$/.test(url)) {
      const convId = url.split('/')[3];
      return {
        body: {
          messages: agentMsgByConv.has(convId)
            ? [{ id: 901, role: 'user', content: agentMsgByConv.get(convId), source: 'writing', tools: [], created_at: '2026-09-22 10:05:00' }]
            : [],
        },
      };
    }
    if (method === 'GET' && url === '/api/agent/tools') return { body: { tools: [] } };
    if (method === 'PUT' && url === '/api/books/7/chapters/12') {
      return {
        body: {
          chapter: { id: 12, title: req.body && req.body.title, content: req.body && req.body.content, beat: req.body && req.body.beat, revision: 4 },
          persistence: { durable: true },
        },
      };
    }
    if (method === 'POST' && url === '/api/books/7/chat/stream') return { stream: true };
    return null;
  }

  async function fetchStub(url, init) {
    const method = (init && init.method) || 'GET';
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    const req = { method, url: String(url), body };
    requests.push(req);
    const r = (o.route && o.route(req)) || defaultRoute(req);
    if (!r) return jsonResponse({ error: { code: 'STUB_NO_ROUTE', message: 'no stub route: ' + url } }, 404);
    if (r.stream) return openStream();
    if (r.sse) {
      const text = r.sse.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('');
      return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return jsonResponse(r.body, r.status || 200);
  }

  const storage = new Map();
  const session = new Map();
  if (o.storage) for (const k of Object.keys(o.storage)) storage.set(k, o.storage[k]);

  const winEvents = {};
  const App = {
    state: {},
    toast(msg) { toasts.push(String(msg)); },
    escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },
    openModal(opts) {
      modals.push(opts);
      modalBody = makeEl('div');
      modalBody.id = 'modal-body';
      for (const fid of MODAL_FIELDS) {
        const n = makeEl('div');
        n.id = fid;
        if (fid === 'agent-discuss-quote') n.checked = true;
        modalBody.appendChild(n);
      }
      const declared = new Set(['modal-body', ...MODAL_FIELDS]);
      const origFind = modalBody.querySelector;
      modalBody.querySelector = sel => {
        if (typeof sel === 'string' && sel.charAt(0) === '#' && !declared.has(sel.slice(1))) unknownModalSelectors.add(sel);
        return origFind(sel);
      };
      nodes.set('modal-body', modalBody);
    },
    closeModal() { modalClosed += 1; },
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
  };

  const context = {
    window: { App }, App, document: doc, console,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    sessionStorage: {
      getItem: k => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: k => session.delete(k),
    },
    fetch: fetchStub, setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, Response, ReadableStream, AbortController,
    performance: { now: () => Date.now() },
    confirm: () => true, location: { hash: '' },
  };
  context.window.document = doc;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.addEventListener = (name, fn) => { (winEvents[name] = winEvents[name] || []).push(fn); };
  context.window.dispatchEvent = ev => {
    const fns = winEvents[ev && ev.type] || [];
    for (const fn of fns) fn(ev);
    return true;
  };

  for (const file of [
    'chat-event-hub.js', 'chapter-collapse.js', 'chapter-conflict.js',
    'book-chapters.js', 'book-outline.js', 'book-state.js', 'book-chat.js', 'book.js',
    // agent.js 与写作页在同一张页面上加载（真实 index.html 同时引两个脚本），
    // 交接的落点断言必须在同一上下文里跨页验证，否则「同 SPA 跳转」这条链没有覆盖。
    'agent.js',
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public', file), 'utf8'), context, { filename: file });
    // 浏览器里 window 就是全局对象；VM 里把各文件挂到 window 上的导出再挂一层，
    // 后面的文件才能像浏览器一样裸引用 BookPage / ChatEventHub（对齐 agent-workspace-ui.test.js）
    context.BookPage = context.window.BookPage;
    context.ChatEventHub = context.window.ChatEventHub;
    context.AgentPage = context.window.AgentPage;
  }

  const h = {
    App, requests, toasts, modals, missing, unknownModalSelectors, doc,
    page: context.window.BookPage,
    agentPage: context.window.AgentPage,
    node: id => doc.getElementById(id),
    html: indexHtml,
    hasId: id => CLIENT_IDS.has(id),
    text: id => (doc.getElementById(id) ? doc.getElementById(id).textContent : null),
    missingIds: () => Array.from(missing),
    unknownModalSelectors: () => Array.from(unknownModalSelectors),
    modal: () => modals[modals.length - 1],
    modalBody: () => modalBody,
    modalClosed: () => modalClosed,
    storageGet: k => (storage.has(k) ? storage.get(k) : null),
    storageSet: (k, v) => storage.set(k, String(v)),
    sessionGet: k => (session.has(k) ? session.get(k) : null),
    chatLoads: () => requests.filter(r => r.method === 'GET' && r.url.indexOf('/api/books/7/chat?') === 0),
    streams: () => requests.filter(r => r.url === '/api/books/7/chat/stream'),
    conversations: () => requests.filter(r => r.url === '/api/conversations' && r.method === 'POST').map(r => r.body),
    agentMessages: () => requests
      .filter(r => /^\/api\/conversations\/[^/]+\/messages$/.test(r.url) && r.method === 'POST')
      .map(r => ({ id: r.url.split('/')[3], body: r.body })),
    // 「Agent 台新专题的初始材料」＝ 写进新会话的消息 + 发往 Agent 的任何请求体
    agentInitialHistory: () => {
      const out = [];
      for (const m of h.agentMessages()) if (m.body && typeof m.body.content === 'string') out.push(m.body.content);
      for (const r of requests) {
        if (r.url.indexOf('/api/agent/chat') === 0 && r.body) {
          out.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        }
      }
      return out;
    },
    bubbles: () => {
      const wrap = doc.getElementById('chat-messages');
      if (!wrap) return [];
      return descendants(wrap).filter(x => x._classes.has('msg-bubble')).map(x => x.textContent);
    },
    stream: () => stream,
    setHidden(v) { doc.hidden = !!v; },
    dispatchWindow(type) { return context.window.dispatchEvent({ type }); },
    fire(id, type, ev) {
      const n = doc.getElementById(id);
      if (!n) return 0;
      const fns = n.listeners[type] || [];
      for (const fn of fns) fn(ev || { preventDefault() {}, target: n, key: '' });
      return fns.length;
    },
    async waitFor(pred, label, ms) {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return true;
        if (Date.now() - t0 > (ms || 2000)) {
          throw new Error('等待超时：' + (label || '条件未满足')
            + '｜toast=' + JSON.stringify(toasts.slice(-3))
            + '｜请求=' + JSON.stringify(requests.slice(-5).map(r => r.method + ' ' + r.url))
            + '｜状态条=' + JSON.stringify([h.text('writing-status-chapter'), h.text('writing-status-save')]));
        }
        await new Promise(r => setTimeout(r, 5));
      }
    },
    requireIds(label) {
      const absent = REQUIRED_IDS.filter(id => !CLIENT_IDS.has(id));
      assert.deepEqual(absent, [], (label || '写作页') + '骨架缺失（index.html 必须提供真实 id）：' + absent.join(', '));
    },
  };
  return h;
}

// 打开写作页并选中第 1 章（走真实 BookPage.show + BookPage.selectChapter）
async function openBook(h) {
  h.storageSet('writing_conversation_7', WRITING_CONV.id);
  await h.page.show(7);
  await h.page.selectChapter(12);
  return h;
}

test('写作页状态常显：书/当前章/写作会话/保存状态，且状态条在可折叠侧栏之外', async () => {
  const h = harness();
  h.requireIds();
  // 静态骨架：状态条与折叠开关都不在 <aside id="panel-left"> 里（折叠侧栏不得藏状态）
  const html = indexHtml();
  const leftStart = html.indexOf('id="panel-left"');
  const leftEnd = html.indexOf('</aside>', leftStart);
  assert.ok(leftStart > 0 && leftEnd > leftStart, 'index.html 必须提供可折叠的资源侧栏 #panel-left');
  const leftBlock = html.slice(leftStart, leftEnd);
  assert.equal(leftBlock.includes('writing-status-bar'), false, '状态条不得放在会被折叠的左侧栏里');
  assert.equal(leftBlock.includes('btn-toggle-left-panel'), false, '折叠开关必须在侧栏之外（折叠后仍可展开）');

  await openBook(h);
  assert.equal(h.App.state.currentChapterId, 12);
  assert.equal(typeof h.node('btn-toggle-left-panel').onclick, 'function', '折叠开关已绑定（toast=' + JSON.stringify(h.toasts) + '）');
  assert.equal(h.text('writing-status-book'), '《雾港编年史》');
  assert.equal(h.text('writing-status-chapter'), '《第1章 石碑》');
  assert.equal(h.text('writing-status-conversation'), '新写作任务');
  assert.equal(h.text('writing-status-save'), '已保存');

  // 手写正文 → 保存状态可见地变脏；保存成功 → 回到已保存
  h.node('chapter-content').value = '手写一段还没落库的正文';
  h.fire('chapter-content', 'input');
  assert.equal(h.text('writing-status-save'), '未保存修改');
  await h.page.saveChapter(true);
  assert.equal(h.text('writing-status-save'), '已保存');

  // 会话选择 / 折叠开关 / 压缩 / 新开入口保持可达且已绑定
  assert.ok(h.node('writing-conversation-select'), '写作会话选择入口');
  assert.equal(typeof h.node('btn-compress').onclick, 'function', '压缩入口已绑定');
  assert.equal(typeof h.node('btn-new-writing-conv').onclick, 'function', '新会话入口已绑定');
  assert.deepEqual(h.missingIds(), [], '页面请求了 index.html 里不存在的 id');
  assert.deepEqual(h.unknownModalSelectors(), [], '页面查询了非声明弹窗字段');
});

test('折叠资源侧栏不重新初始化编辑器、不清空正在流的这一轮', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  const editor = h.node('chapter-content');
  editor.value = 'CHAPTER_TEXT_BEFORE_LAYOUT_TOGGLE';
  h.fire('chapter-content', 'input');

  // 发起一轮流式写作（可控 SSE，先不结束）
  h.node('chat-text').value = '继续写一段';
  h.fire('chat-form', 'submit', { preventDefault() {} });
  await h.waitFor(() => h.streams().length === 1, '流式请求已发出');
  const s = h.stream();
  s.frame({ type: 'content', text: '正在流出的第一段。' });
  await h.waitFor(() => h.bubbles().join('\n').includes('正在流出的第一段'), '实时气泡已有增量');
  const liveBefore = h.bubbles().join('\n');
  const chatLoadsBefore = h.chatLoads().length;
  const chapterReadsBefore = h.requests.filter(r => r.url === '/api/books/7/chapters/12').length;
  const editorContentBeforeLayoutToggle = editor.value;

  // 折叠 → 展开
  h.node('btn-toggle-left-panel').onclick();
  assert.equal(h.node('book-workbench').classList.contains('left-collapsed'), true, '折叠后工作台进入收栏布局');
  assert.equal(h.text('writing-status-save'), '未保存修改', '折叠布局不得抹掉保存状态（草稿仍在）');
  assert.equal(h.node('chapter-title-input').value, '第1章 石碑', '折叠布局不得清空编辑器');
  h.node('btn-toggle-left-panel').onclick();
  assert.equal(h.node('book-workbench').classList.contains('left-collapsed'), false, '再点一次展开');

  const editorContentAfterLayoutToggle = editor.value;
  assert.equal(editorContentAfterLayoutToggle, editorContentBeforeLayoutToggle);
  assert.equal(h.bubbles().join('\n'), liveBefore, '折叠布局不得清空/重绘正在流的这一轮');
  assert.equal(h.chatLoads().length, chatLoadsBefore, '折叠布局不得重新拉取会话历史');
  assert.equal(h.requests.filter(r => r.url === '/api/books/7/chapters/12').length, chapterReadsBefore, '折叠布局不得重新初始化编辑器（不重读章节）');
  assert.equal(h.streams().length, 1, '折叠布局不得另起一条对话流');

  // 流结束后正文仍是编辑器里的内容，未被清空
  s.frame({ type: 'done', content: '正在流出的第一段。收尾。', run: { status: 'finished' } });
  s.close();
  await h.waitFor(() => h.bubbles().join('\n').includes('收尾'), '流已收尾');
  assert.equal(editor.value, editorContentAfterLayoutToggle, '收尾后编辑器内容保持原样');
});

test('另开整体讨论：只带书籍与明确选中的文字，默认不带写作历史（哨兵）', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  assert.ok(h.bubbles().join('\n').includes(WRITING_HISTORY_SENTINEL), '前置：写作会话里确有历史哨兵');

  const content = h.node('chapter-content');
  content.value = '前文。' + SELECTED_TEXT + '后文。';
  content.selectionStart = content.value.indexOf(SELECTED_TEXT);
  content.selectionEnd = content.selectionStart + SELECTED_TEXT.length;

  await h.node('btn-open-agent-discuss').onclick();
  const modal = h.modal();
  assert.ok(modal, '「另开整体讨论」应弹出预览确认');
  assert.ok(modal.bodyHTML.includes('不带') && modal.bodyHTML.includes('写作'), '弹窗必须说明默认不带写作对话历史');
  assert.ok(modal.bodyHTML.includes(SELECTED_TEXT), '弹窗必须预览将要带走的选中文字');
  assert.equal(modal.bodyHTML.includes(WRITING_HISTORY_SENTINEL), false, '弹窗不得预览任何写作历史');

  const ok = await modal.onOk(h.modalBody());
  assert.notEqual(ok, false, '确认后应完成交接');

  // 1) 新专题草案落在同一本书（bookId 随请求下发）
  const created = h.conversations();
  assert.equal(created.length, 1, '只建一个 Agent 会话');
  assert.equal(created[0].kind, 'agent');
  assert.equal(created[0].scope, 'book');
  assert.equal(created[0].bookId, 7, '携带 bookId');
  assert.ok(created[0].title.includes('雾港编年史') && created[0].title.includes('整体讨论'), '专题名带书籍');
  assert.ok(created[0].title.includes(CHAPTER.title), '专题名带当前章（可选 chapterId）');

  // 2) 初始用户材料＝明确选中的文字（含来源行），且不含任何写作历史
  const msgs = h.agentMessages();
  assert.equal(msgs.length, 1, '只写一条初始材料');
  assert.equal(msgs[0].id, 'conv-agent-draft');
  assert.equal(msgs[0].body.source, 'writing');
  const material = msgs[0].body.content;
  assert.ok(material.includes(SELECTED_TEXT), '选中文字逐字进入初始材料');
  assert.ok(material.includes('bookId=7') && material.includes('chapterId=12'), '来源行携带 bookId/chapterId');
  assert.equal(material.includes(WRITING_HISTORY_SENTINEL), false, '初始材料不得含写作历史');

  // 3) 哨兵不进入 Agent 台的任何输入
  assert.equal(h.agentInitialHistory().includes(WRITING_HISTORY_SENTINEL), false, 'agentInitialHistory 不得含写作历史哨兵');
  for (const r of h.requests) {
    if (r.body && typeof r.body !== 'string') {
      assert.equal(JSON.stringify(r.body).includes(WRITING_HISTORY_SENTINEL), false, '请求体泄漏写作历史：' + r.method + ' ' + r.url);
    }
  }
  // 4) 新入口不自己发起对话流（按书单飞闸门不被绕过）
  assert.equal(h.streams().length, 0, '另开整体讨论不触发对话流');
  // 5) 落到 Agent 台对应书的新专题（Agent 页读的两个 key）
  assert.equal(h.storageGet('agent_scope_v1'), 'book:7');
  assert.equal(h.storageGet('agent_conversation_v1'), 'conv-agent-draft');
  assert.equal(h.node('agent-return-writing').classList.contains('hidden'), false, '返回写作页入口可见');
  assert.equal(h.node('agent-return-writing').href, '#/book/7');
  assert.deepEqual(h.missingIds(), [], '页面请求了 index.html 里不存在的 id');
  assert.deepEqual(h.unknownModalSelectors(), [], '页面查询了非声明弹窗字段');
});

test('另开整体讨论：可选人物随选中对象携带，没有选中文字时不带任何材料', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  // 没有选中文字
  h.node('chapter-content').selectionStart = 0;
  h.node('chapter-content').selectionEnd = 0;
  await h.node('btn-open-agent-discuss').onclick();
  const modal = h.modal();
  assert.ok(modal.bodyHTML.includes('没有选中'), '无选中文字时明说不带材料');
  // 作者在弹窗里选了一个人物（可选 characterId）
  h.modalBody().querySelector('#agent-discuss-character').value = '5';
  await modal.onOk(h.modalBody());
  const created = h.conversations();
  assert.equal(created.length, 1);
  assert.ok(created[0].title.includes('林昭'), '专题名带所选人物');
  assert.equal(h.agentMessages().length, 0, '没有明确选中的文字就不写初始材料（默认不带写作历史）');
  assert.deepEqual(h.missingIds(), []);
  assert.deepEqual(h.unknownModalSelectors(), []);
});

test('另开整体讨论：未保存稿先走既有离开守卫，未放行不交接', async () => {
  // 保存必然失败：离开守卫必须拦下（三选一由 test/editor-navigation-guard.test.js 覆盖）
  const h = harness({
    route: (req) => {
      if (req.method === 'PUT' && req.url === '/api/books/7/chapters/12') {
        return { status: 500, body: { error: { code: 'AUDIT_NETWORK_FAILURE', message: '磁盘暂不可用' } } };
      }
      return null;
    },
  });
  h.requireIds();
  await openBook(h);
  h.node('chapter-content').value = '未保存的手稿';
  h.fire('chapter-content', 'input');
  assert.equal(h.page.hasUnsavedChanges(), true);

  await h.node('btn-open-agent-discuss').onclick();
  const guard = h.modal();
  assert.equal(guard.title, '有未保存的修改', '先弹离开守卫，不直接跳走');
  assert.equal(h.conversations().length, 0, '未放行前不得建专题');
  assert.equal(h.App.state.currentChapterId, 12, '留在原章');
  assert.equal(h.node('chapter-content').value, '未保存的手稿', '草稿原样保留');
  assert.equal(h.storageGet('agent_scope_v1'), null, '未放行不得改写 Agent 台范围');

  // 作者明确放弃修改后继续：交接照常，编辑器本地文本不被清空
  h.page.clearUnsaved();
  await h.page.openAgentDiscussion();
  await h.modal().onOk(h.modalBody());
  assert.equal(h.conversations().length, 1, '放弃修改后完成交接');
  assert.equal(h.node('chapter-content').value, '未保存的手稿', '放弃修改不等于清空编辑器内容');
});

test('从 Agent 台返回后还原同一写作会话、同一章', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  const originalWritingConversationId = h.storageGet('writing_conversation_7');
  const originalChapterId = h.App.state.currentChapterId;
  assert.equal(originalWritingConversationId, WRITING_CONV.id);
  const chatLoadsAtDeparture = h.chatLoads().length;

  await h.node('btn-open-agent-discuss').onclick();
  await h.modal().onOk(h.modalBody());
  assert.equal(h.requests.filter(r => r.url === '/api/agent/chat').length, 0, '交接到 Agent 台不等于替作者发问');

  // 模拟从 Agent 台返回：路由回到 #/book/7 → BookPage.show(7)
  h.App.state.currentChapterId = null;
  h.node('chapter-content').value = '';
  await h.page.show(7);
  await h.waitFor(() => h.chatLoads().length > chatLoadsAtDeparture, '返回后重新装载写作会话');
  const returnedWritingConversationId = h.storageGet('writing_conversation_7');
  const returnedChapterId = h.App.state.currentChapterId;
  const lastChatLoad = h.chatLoads()[h.chatLoads().length - 1];

  assert.equal(returnedWritingConversationId, originalWritingConversationId, '同一写作会话');
  assert.equal(returnedChapterId, originalChapterId, '同一章');
  assert.equal(new URL('http://x' + lastChatLoad.url).searchParams.get('conversationId'), originalWritingConversationId, '返回后会话历史读的是同一会话');
  assert.equal(h.page.currentWritingConversationId(), originalWritingConversationId, '页面当前会话 id 未变');
  assert.equal(h.node('chapter-content').value, CHAPTER.content, '返回后编辑器载入同一章正文');
});

test('页面被隐藏不宣告取消或完成：终态由 run-service 的 run 状态决定', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  h.node('chat-text').value = '写一段';
  h.fire('chat-form', 'submit', { preventDefault() {} });
  await h.waitFor(() => h.streams().length === 1, '流式请求已发出');
  const s = h.stream();
  s.frame({ type: 'content', text: '先流一段。' });
  await h.waitFor(() => h.bubbles().join('\n').includes('先流一段'), '实时气泡已有增量');

  const requestsBeforeHide = h.requests.length;
  const toastsBeforeHide = h.toasts.length;
  // 页面切到后台：不得中止当前运行，也不得宣告任何终态
  h.setHidden(true);
  h.dispatchWindow('visibilitychange');
  h.setHidden(false);
  h.dispatchWindow('visibilitychange');
  assert.equal(h.requests.length, requestsBeforeHide, '隐藏/恢复页面不得发出取消或重发请求');
  assert.equal(h.toasts.length, toastsBeforeHide, '隐藏页面不得宣告取消/完成');
  assert.equal(h.bubbles().join('\n').includes('先流一段'), true, '隐藏期间已收到的增量仍在');

  // 服务端终态为 paused（预算到限）→ 必须如实显示「已暂停」，不冒充完成
  s.frame({ type: 'done', content: '先流一段。收尾。', run: { status: 'paused' } });
  s.close();
  await h.waitFor(() => h.bubbles().join('\n').includes('收尾'), '流已收尾');
  const finished = h.bubbles().join('\n');
  assert.equal(finished.includes('任务已暂停，尚未完成'), true, '终态文案必须来自 run 状态');
  assert.equal(finished.includes('已停止生成'), false, '未按停止生成处理');
  assert.equal(h.streams().length, 1, '同一轮只有一条流，隐藏不引发重发');
});

test('原入口保持可达：参谋/润色/总结/定稿/回收站版本通道', async () => {
  const h = harness();
  await openBook(h);
  for (const id of ['btn-consult', 'btn-polish-chapter', 'btn-polish-selection', 'btn-gen-summary', 'btn-lock-chapter', 'btn-chapter-recycle', 'btn-clear-chat']) {
    assert.ok(h.hasId(id), '入口必须留在写作页上：' + id);
  }
  assert.equal(typeof h.node('btn-polish-chapter').onclick, 'function', '润色入口已绑定');
  assert.equal(typeof h.node('btn-gen-summary').onclick, 'function', '总结入口已绑定');
  assert.equal(typeof h.node('btn-lock-chapter').onclick, 'function', '定稿入口已绑定');
  assert.equal(typeof h.node('btn-consult').onclick, 'function', '参谋入口已绑定');
  assert.equal(typeof h.node('btn-chapter-recycle').onclick, 'function', '章节回收站（历史版本恢复通道）已绑定');
  // 参谋模式仍在写作页内可用（不把局部讨论赶去 Agent 台）
  h.node('btn-consult').onclick();
  assert.equal(h.App.state.consultMode, true);
  // 新入口不触发对话流：按书单飞闸门（409 CHAT_BUSY）只在既有 enqueue 路径上
  assert.equal(h.streams().length, 0);
  assert.deepEqual(h.missingIds(), []);
});

test('按书单飞闸门不被绕过：409 CHAT_BUSY 仍走排队重试，不并发发第二条流', async () => {
  let busyRounds = 0;
  const h = harness({
    route: (req) => {
      if (req.method === 'POST' && req.url === '/api/books/7/chat/stream') {
        busyRounds += 1;
        if (busyRounds === 1) return { status: 409, body: { error: { code: 'CHAT_BUSY', message: '该书已有对话在进行中' } } };
        return { sse: [{ type: 'content', text: '轮到我了。' }, { type: 'done', content: '轮到我了。', run: { status: 'finished' } }] };
      }
      return null;
    },
  });
  await openBook(h);
  h.node('chat-text').value = '在忙时发送';
  h.fire('chat-form', 'submit', { preventDefault() {} });
  await h.waitFor(() => h.bubbles().join('\n').includes('轮到我了'), '忙碌后重试成功', 8000);
  assert.equal(h.streams().length, 2, '第一条 409 排队重试，不是并发两路');
  assert.ok(h.toasts.join('|').includes('进行中'), '忙碌时明确提示排队');
  assert.deepEqual(h.missingIds(), []);
});

test('另开整体讨论后，同一 SPA 内进 Agent 台即选中该书与新专题草案（不整页重载、不断写作流）', async () => {
  const h = harness();
  h.requireIds();
  await openBook(h);
  const content = h.node('chapter-content');
  content.value = '前文。' + SELECTED_TEXT + '后文。';
  content.selectionStart = content.value.indexOf(SELECTED_TEXT);
  content.selectionEnd = content.selectionStart + SELECTED_TEXT.length;

  await h.node('btn-open-agent-discuss').onclick();
  await h.modal().onOk(h.modalBody());

  // 前置：写作页已把「这本书 + 这个新专题草案」写进 Agent 台的两个持久化键
  const draftId = h.storageGet('agent_conversation_v1');
  assert.equal(h.storageGet('agent_scope_v1'), 'book:7');
  assert.equal(draftId, 'conv-agent-draft', '写作页交出的专题草案 id');
  assert.equal(h.streams().length, 0, '交接不由写作页发起对话流（按书单飞闸门不被绕过）');

  // 同一 SPA 跳转：agent.js 与写作页同处一个页面上下文，而它的范围是脚本加载时读的。
  // 作者必须落到「刚选的那本书 + 刚建的新专题草案」，而不是加载时的旧范围。
  await h.agentPage.show();
  assert.equal(h.node('agent-scope-select').value, 'book:7', 'Agent 台范围应落到作者刚选的书');
  assert.equal(h.node('agent-conversation-select').value, draftId, '会话选择器应选中刚建的新专题草案');
  assert.ok(h.text('agent-messages').includes(SELECTED_TEXT), 'Agent 台要读得到这条初始材料');
  assert.equal(h.text('agent-messages').includes(WRITING_HISTORY_SENTINEL), false, 'Agent 台不得出现写作历史');
  assert.deepEqual(h.missingIds(), [], '页面请求了 index.html 里不存在的 id');
});
