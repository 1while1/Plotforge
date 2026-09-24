// S4-03 / 任务书 05「工作台导航保留对象、任务和返回位置」页面回归。
// 载入真实 public/index.html 的 id 集合与真实页面代码（workspace-state.js、app.js、
// workbench-shell.js、四个工作台、book-chapters.js 等），用最小 DOM/App 桩跑真实代码，钉住：
//   1) 写作章 → 大纲/台账 → 返回同一章、同一写作会话（导航对象 deepEqual）。
//   2) Agent 人物专题 → 人物工作台 → 返回同一个 Agent 会话。
//   3) returnTo 保存工作空间/实体/页签；刷新后由 hash 重建同一有效导航。
//   4) 四个工作台都接入离开保护：保存失败保留 dirty、不提交导航、不 toast「已保存」。
//   5) 异步 load 绑定 request token 与 bookId/entityId：晚到的 A 书结果不写进 B 书。
//   6) 已删除章节/人物给明确空态，不自动跳别的书/对象；浏览器前进后退走同一守卫。
//
// 桩的纪律（沿用 S1-03c / S4-02 的教训）：
//   · document.getElementById 只认 public/index.html 的静态 id 或页面自己渲染出来的节点，
//     查不到的 id 记入 missing 并由用例断言为空——不允许「桩比页面宽」。
//   · 桩解析 innerHTML（同一套极简解析），因为工作台表单/进度条都是页面自己渲染的；
//     断言对象是导航对象、表单节点值、请求序列、toast 与 hash，不比对整段 HTML 文案。
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
// 静态 id → 真实标签名：桩里 <select> 与 <div> 的选中语义不同，标签名不能一律当 div
function indexTags() {
  const tags = new Map();
  const re = /<([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*?)\bid="([^"]+)"/g;
  let m = re.exec(indexHtml());
  while (m) { tags.set(m[3], m[1].toLowerCase()); m = re.exec(indexHtml()); }
  return tags;
}
const CLIENT_IDS = indexIds();
const CLIENT_TAGS = indexTags();

const BOOK7 = { id: 7, title: '雾港编年史', mode: 'collab', intro: '', master_outline: '原总纲' };
const BOOK9 = { id: 9, title: '另一本书', mode: 'collab', intro: '', master_outline: '' };
const CHAPTER12 = { id: 12, title: '第1章 石碑', content: '石碑正文', beat: '起', revision: 3, volume_id: 1 };
const VOLUME1 = { id: 1, sort_order: 1, title: '第一卷', intro: '卷简介', outline: '卷大纲', summary: '' };
const CHAR5 = { id: 5, name: '林昭', role: '主角', intro: '主角简介', archived_at: null };
const WORLD_7 = { id: 31, title: '世界规则·书七', content: '书七的设定正文' };
const WORLD_9 = { id: 91, title: '世界规则·书九', content: '书九的设定正文' };
const WRITING_CONV = { id: 'conv-writing-1', kind: 'writing', scope: 'book', book_id: 7, title: '写作历史对话', status: 'active' };
const AGENT_CONV = { id: 'conv-agent-1', kind: 'agent', scope: 'book', book_id: 7, title: '《雾港编年史》· 讨论', status: 'active' };
const WRITING_BOOK7_KEY = 'writing_conversation_7';

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(opts) {
  const o = opts || {};
  const nodes = new Map();
  const missing = new Set();
  const requests = [];
  const toasts = [];
  const modals = [];
  const winEvents = {};
  const loc = { hash: o.hash || '#/' };
  let modalBody = null;
  let routeOverride = null;

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], parent: null,
      attrs: {}, dataset: {}, style: {}, _classes: new Set(), _text: '',
      listeners: {}, disabled: false, hidden: false, title: '', value: '', href: '',
      checked: false, onclick: null, oninput: null, onsubmit: null,
    };
    // <select> 的选中语义：浏览器里 option.selected = true（或在插入前后置位）会把 select.value 同步过去，
    // 页面代码靠它回填「当前写作会话/当前 Agent 会话」。桩必须照做，否则断言的失真来自桩而不是产品。
    Object.defineProperty(el, 'selected', {
      get() { return !!el._selected; },
      set(v) {
        el._selected = !!v;
        if (el._selected && el.parent) el.parent.value = el.value;
      },
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
    el.appendChild = child => {
      child.parent = el;
      el.children.push(child);
      syncSelectValue(el, child);
      return child;
    };
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
    el.getAttribute = name => (Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null);
    el.setAttribute = (name, v) => { el.attrs[name] = String(v); };
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    return el;
  }

  function syncSelectValue(select, option) {
    if (!select || select.tagName !== 'SELECT' || !option) return;
    if (option.selected) { select.value = option.value; select.__hasSelected = true; return; }
    var opts = (select.children || []).filter(c => c.tagName === 'OPTION');
    if (select.value === '' && !select.__hasSelected && opts.length && !opts.some(o => o.selected)) {
      select.value = opts[0].value; // 单选下拉没有显式 selected 时默认选第一个
    }
  }

  function descendants(el) {    const out = [];
    for (const c of el.children || []) {
      if (!c._classes) continue; // 文本节点
      out.push(c, ...descendants(c));
    }
    return out;
  }
  function matchSimple(el, sel) {
    const parts = sel.match(/([.#]?[A-Za-z0-9_-]+|\[[^\]]+\])/g) || [];
    if (!parts.length) return false;
    return parts.every(p => {
      if (p[0] === '#') return el.id === p.slice(1);
      if (p[0] === '.') return el._classes.has(p.slice(1));
      if (p[0] === '[') {
        const m = /^\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(p);
        if (!m) return false;
        const name = m[1];
        const want = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        const camel = name.replace(/^data-/, '').replace(/-([a-z])/g, (s, c) => c.toUpperCase());
        const has = Object.prototype.hasOwnProperty.call(el.attrs, name)
          || (name.indexOf('data-') === 0 && Object.prototype.hasOwnProperty.call(el.dataset, camel));
        if (!has) return false;
        if (want === undefined) return true;
        const val = name.indexOf('data-') === 0 ? el.dataset[camel] : el.attrs[name];
        return String(val === undefined ? '' : val) === want;
      }
      return el.tagName === p.toUpperCase();
    });
  }
  function matches(el, sel) {
    const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
    return groups.some(g => {
      const chain = g.split(/\s+/).filter(Boolean);
      if (chain.length === 1) return matchSimple(el, chain[0]);
      if (!matchSimple(el, chain[chain.length - 1])) return false;
      let node = el.parent;
      for (let i = chain.length - 2; i >= 0; i--) {
        let found = false;
        while (node) {
          if (matchSimple(node, chain[i])) { found = true; node = node.parent; break; }
          node = node.parent;
        }
        if (!found) return false;
      }
      return true;
    });
  }
  function allInDoc() {
    const out = [];
    for (const root of nodes.values()) out.push(root, ...descendants(root));
    return out;
  }

  // 极简 innerHTML 解析：只认标签/属性/文本（够页面自己的固定模板）
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
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
        }
        continue;
      }
      if (tag === 'script' || tag === 'style') continue;
      const node = makeEl(tag);
      applyAttrs(node, m[3] || '');
      stack[stack.length - 1].appendChild(node);
      if (tag !== 'br' && tag !== 'input' && tag !== 'img') stack.push(node);
    }
    const tail = html.slice(last);
    if (tail) pushText(stack[stack.length - 1], tail);
  }
  function pushText(parent, text) {
    if (!String(text).trim()) return;
    parent.children.push({ nodeType: 3, textContent: String(text), children: [] });
  }
  function applyAttrs(node, attrs) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    while ((m = re.exec(attrs))) {
      const name = m[1];
      const val = m[2] === undefined ? '' : m[2];
      node.attrs[name] = val;
      if (name === 'class') node.className = val;
      else if (name === 'id') node.id = val;
      else if (name === 'value') node.value = val;
      else if (name === 'checked') node.checked = true;
      else if (name === 'selected') node.selected = true;
      else if (name === 'disabled') node.disabled = true;
      else if (name === 'href') node.href = val;
      else if (name === 'title') node.title = val;
      else if (name === 'name') node.attrs.name = val;
      else if (name.indexOf('data-') === 0) {
        node.dataset[name.slice(5).replace(/-([a-z])/g, (s, c) => c.toUpperCase())] = val;
      }
    }
  }

  function findByIdDeep(id) {
    for (const n of allInDoc()) if (n.id === id) return n;
    return null;
  }
  const docEvents = {};
  const doc = {
    // 真实页面：app.js 在 document.readyState === 'loading' 时把 init/route 挂到 DOMContentLoaded，
    // 所以路由发生在全部脚本解析完之后。桩必须照做——否则刷新到工作台 URL 时 WorkspaceShell 还未加载。
    readyState: 'loading',
    hidden: false,
    getElementById(id) {
      if (nodes.has(id)) return nodes.get(id);
      const found = findByIdDeep(id);
      if (found) return found;
      if (!CLIENT_IDS.has(id)) { missing.add(id); return null; }
      const el = makeEl(CLIENT_TAGS.get(id) || 'div');
      el.id = id;
      el.__inDoc = true;
      nodes.set(id, el);
      return el;
    },
    createElement: makeEl,
    createTextNode: t => ({ nodeType: 3, textContent: String(t == null ? '' : t), children: [] }),
    querySelector: sel => allInDoc().find(n => matches(n, sel)) || null,
    querySelectorAll: sel => allInDoc().filter(n => matches(n, sel)),
    addEventListener: (name, fn) => { (docEvents[name] = docEvents[name] || []).push(fn); },
  };

  function defaultRoute(req) {
    const url = req.url;
    const method = req.method;
    if (method === 'GET' && url === '/api/books') return { body: { books: [BOOK7, BOOK9] } };
    if (method === 'GET' && url === '/api/books/7') return { body: { book: BOOK7 } };
    if (method === 'GET' && url === '/api/books/9') return { body: { book: BOOK9 } };
    if (method === 'GET' && url === '/api/books/7/volumes') return { body: { volumes: [VOLUME1] } };
    if (method === 'GET' && url === '/api/books/9/volumes') return { body: { volumes: [] } };
    if (method === 'GET' && url === '/api/books/7/chapters') return { body: { chapters: [CHAPTER12] } };
    if (method === 'GET' && url === '/api/books/9/chapters') return { body: { chapters: [] } };
    // 大纲工作台脉络轴聚合端点（卷+章+烈度投影一次出）
    if (method === 'GET' && url === '/api/books/7/outline/timeline') {
      return { body: { volumes: [VOLUME1], chapters: [Object.assign({ sort_order: 1, locked: 0, drift_status: null, content_length: 4, has_summary: 0 }, CHAPTER12)], intensity: {} } };
    }
    if (method === 'GET' && url === '/api/books/9/outline/timeline') return { body: { volumes: [], chapters: [], intensity: {} } };
    if (method === 'GET' && url === '/api/books/7/chapters/12') return { body: { chapter: CHAPTER12 } };
    if (method === 'GET' && url === '/api/books/7/chapters/404') {
      return { status: 404, body: { error: { code: 'CHAPTER_NOT_FOUND', message: '章节不存在' } } };
    }
    if (method === 'PUT' && url === '/api/books/7/chapters/12') {
      return { body: { chapter: Object.assign({}, CHAPTER12, { revision: 4, content: req.body && req.body.content }), persistence: { durable: true } } };
    }
    if (method === 'GET' && url === '/api/books/7/world') return { body: { entries: [WORLD_7] } };
    if (method === 'GET' && url === '/api/books/9/world') return { body: { entries: [WORLD_9] } };
    if (method === 'GET' && url.indexOf('/api/books/7/characters?limit=') === 0) return { body: { items: [CHAR5] } };
    if (method === 'GET' && url.indexOf('/api/books/9/characters?limit=') === 0) return { body: { items: [] } };
    if (method === 'GET' && url === '/api/books/7/characters/5') {
      return {
        body: {
          character: CHAR5, aliases: [], relation_summary: { active: 0 },
          timeline_summary: { events: 0 }, thread_summary: { open: 0 },
        },
      };
    }
    if (method === 'GET' && url === '/api/books/7/sidebar-preferences') {
      return {
        body: {
          preferences: {
            moduleOrder: ['characters', 'relations', 'timeline', 'ledger', 'outline', 'world', 'chapters'],
            hiddenModules: [],
            summaryFields: {
              characters: ['name', 'role', 'intro'], chapters: ['title', 'volume', 'locked'],
              outline: ['mainPlot', 'currentVolume', 'drift'], ledger: ['progress', 'pendingCount'],
              world: ['name', 'summary'],
            },
          },
        },
      };
    }
    if (method === 'GET' && url === '/api/books/7/characters') return { body: { characters: [CHAR5] } };
    if (method === 'GET' && url === '/api/books/9/characters') return { body: { characters: [] } };
    if (method === 'GET' && url === '/api/books/7/state') return { body: { states: {} } };
    if (method === 'GET' && url.indexOf('/api/books/7/chat?') === 0) {
      return { body: { conversationId: WRITING_CONV.id, messages: [], expiredActions: [] } };
    }
    if (method === 'GET' && url === '/api/books/7/chat') {
      return { body: { conversationId: WRITING_CONV.id, messages: [], expiredActions: [] } };
    }
    if (method === 'GET' && url === '/api/books/7/chat/actions') return { body: { actions: [] } };
    if (method === 'GET' && url.indexOf('/api/books/7/context-status') === 0) {
      return { body: { contextWindow: 128000, estimatedPromptTokens: 10, messages: { active: 0 } } };
    }
    if (method === 'GET' && url.indexOf('/api/conversations?kind=writing&bookId=7') === 0) return { body: [WRITING_CONV] };
    if (method === 'GET' && url.indexOf('/api/conversations?kind=agent') === 0) return { body: [AGENT_CONV] };
    if (method === 'GET' && /^\/api\/conversations\/[^/]+\/messages\?limit=200$/.test(url)) return { body: { messages: [] } };
    if (method === 'GET' && url === '/api/agent/tools') return { body: { tools: [] } };
    if (method === 'GET' && url.indexOf('/api/resources?type=chapter&bookId=7') === 0) return { body: { items: [], nextCursor: null } };
    // 台账
    if (method === 'GET' && url === '/api/books/7/ledger/progress') return { body: { summary: '', stale: false } };
    if (method === 'GET' && url === '/api/books/7/ledger/proposals?status=pending') return { body: { items: [] } };
    if (method === 'GET' && url === '/api/books/7/ledger/threads?status=open') return { body: { items: [] } };
    if (method === 'GET' && url === '/api/books/7/ledger/threads') return { body: { items: [] } };
    if (method === 'GET' && url === '/api/books/7/ledger/issues') return { body: { items: [] } };
    if (method === 'GET' && url === '/api/books/7/ledger/backfill') return { body: { status: null } };
    if (method === 'GET' && url === '/api/books/7/health') return { body: { index: { locked_missing: 0 }, extraction: { locked_pending: 0 }, summary: { locked_without_summary: 0, stale_volumes: 0 }, ledger: { stale_proposals: 0, orphan_events: 0, stale_events: 0 }, llm_recent: { errors: 0, window: 20 }, canon: { chapters: 1, locked: 0, chars: 100 } } };
    if (method === 'PUT' && url === '/api/books/7/ledger/progress') return { body: { ok: true } };
    if (method === 'PUT' && url === '/api/books/7') return { body: { book: BOOK7 } };
    if (method === 'PUT' && url === '/api/books/7/volumes/1') return { body: { volume: VOLUME1 } };
    if (method === 'PUT' && url === '/api/books/7/world/31') return { body: { entry: WORLD_7 } };
    if (method === 'PATCH' && url === '/api/books/7/characters/5') return { body: { character: CHAR5 } };
    if (method === 'POST' && url === '/api/books/7/volumes/1/summary') return { body: { ok: true } };
    return null;
  }

  async function fetchStub(url, init) {
    const method = (init && init.method) || 'GET';
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    const req = { method, url: String(url), body };
    requests.push(req);
    let r = (routeOverride && routeOverride(req)) || defaultRoute(req);
    if (r && typeof r.then === 'function') r = await r; // 可控延迟（异步过期结果用例）
    if (!r) return jsonResponse({ error: { code: 'STUB_NO_ROUTE', message: 'no stub route: ' + url } }, 404);
    return jsonResponse(r.body, r.status || 200);
  }

  const storage = new Map(Object.keys(o.storage || {}).map(k => [k, String(o.storage[k])]));
  const session = new Map(Object.keys(o.session || {}).map(k => [k, String(o.session[k])]));

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
      nodes.set('modal-body', modalBody);
      const declared = new Set(['modal-body']);
      const origFind = modalBody.querySelector;
      modalBody.querySelector = sel => origFind(sel);
      void declared;
    },
    closeModal() {},
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

  const location = {};
  Object.defineProperty(location, 'hash', {
    get: () => loc.hash,
    set(v) {
      const next = String(v);
      if (next === loc.hash) return;
      loc.hash = next;
      // 桩：同步派发 hashchange（真实浏览器是任务队列；守卫用 reverting 标记，不依赖派发时序）
      dispatchWindow('hashchange');
    },
  });

  function dispatchWindow(type, ev) {
    const fns = winEvents[type] || [];
    for (const fn of fns) fn(ev || { type });
  }

  class FormDataStub {
    constructor(form) { this.form = form; }
    get(name) {
      const list = this.form && this.form.querySelectorAll ? this.form.querySelectorAll('[name="' + name + '"]') : [];
      return list.length ? list[0].value : null;
    }
  }

  const context = {
    window: { App }, App, document: doc, console, FormData: FormDataStub,
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
    URLSearchParams, TextDecoder, TextEncoder, Response, ReadableStream, AbortController,
    performance: { now: () => Date.now() },
    confirm: () => true,
    location,
  };
  context.window.document = doc;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.location = location;
  context.window.addEventListener = (name, fn) => { (winEvents[name] = winEvents[name] || []).push(fn); };
  context.window.dispatchEvent = ev => { dispatchWindow(ev && ev.type, ev); return true; };

  const FILES = [
    'chat-event-hub.js', 'workspace-state.js', 'app.js',
    'chapter-collapse.js', 'chapter-conflict.js', 'book-chapters.js',
    'book-outline.js', 'book-state.js', 'book-chat.js', 'book.js', 'sidebar-config.js',
    'agent.js',
    'character-workbench.js', 'ledger-workbench.js', 'outline-workbench.js', 'world-workbench.js',
    'workbench-shell.js',
  ];
  const loaded = [];
  for (const file of FILES) {
    const full = path.join(root, 'public', file);
    if (!fs.existsSync(full)) continue; // 红测阶段：模块尚未创建，由用例断言其存在
    vm.runInNewContext(fs.readFileSync(full, 'utf8'), context, { filename: file });
    // 浏览器里 window 就是全局对象：public/app.js 会 `var App = window.App = {}` 重建 App，
    // 后续文件裸引用的 App 必须跟着换成同一个对象（否则跨文件状态会分叉——桩比真实环境窄的反面）。
    context.App = context.window.App;
    context.window.App.toast = function (msg) { toasts.push(String(msg)); };
    if (!context.window.App.__modalRecorded) {
      const realOpenModal = context.window.App.openModal;
      context.window.App.openModal = function (opts) { modals.push(opts); return realOpenModal.call(context.window.App, opts); };
      context.window.App.__modalRecorded = true;
    }
    loaded.push(file);
    context.BookPage = context.window.BookPage;
    context.ChatEventHub = context.window.ChatEventHub;
    context.AgentPage = context.window.AgentPage;
    context.WorkspaceState = context.window.WorkspaceState;
    context.WorkbenchShell = context.window.WorkbenchShell;
    context.OutlineWorkbench = context.window.OutlineWorkbench;
    context.LedgerWorkbench = context.window.LedgerWorkbench;
    context.WorldWorkbench = context.window.WorldWorkbench;
    context.CharacterWorkbench = context.window.CharacterWorkbench;
  }
  // 全部脚本就绪后触发 DOMContentLoaded：app.js 的 init/route 在这里跑（与真实页面同序）
  doc.readyState = 'complete';
  (docEvents.DOMContentLoaded || []).forEach(fn => fn({ type: 'DOMContentLoaded' }));

  function fire(node, type, ev) {
    if (!node) return 0;
    let count = 0;
    const handler = node['on' + type];
    if (typeof handler === 'function') { handler.call(node, ev || { preventDefault() {}, target: node }); count += 1; }
    const fns = node.listeners[type] || [];
    for (const fn of fns) { fn(ev || { preventDefault() {}, target: node }); count += 1; }
    return count;
  }

  const h = {
    App: context.window.App, doc, requests, toasts, modals, missing, loaded, location,
    page: context.window.BookPage,
    agentPage: context.window.AgentPage,
    shell: context.window.WorkbenchShell,
    ws: () => context.window.WorkspaceState,
    node: id => doc.getElementById(id),
    $: sel => doc.querySelector(sel),
    $$: sel => doc.querySelectorAll(sel),
    text: id => (doc.getElementById(id) ? doc.getElementById(id).textContent : null),
    missingIds: () => Array.from(missing),
    html: indexHtml,
    modal: () => modals[modals.length - 1],
    setRoute(fn) { routeOverride = fn; },
    defer() {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      return { promise, resolve };
    },
    storageGet: k => (storage.has(k) ? storage.get(k) : null),
    storageSet: (k, v) => storage.set(k, String(v)),
    sessionGet: k => (session.has(k) ? session.get(k) : null),
    sessionAll: () => Object.fromEntries(session),
    fire,
    fireNode: fire,
    write(id, value) {
      const node = doc.getElementById(id);
      assert.ok(node, '页面必须渲染出可编辑节点 #' + id);
      node.value = value;
      const n = fire(node, 'input');
      assert.ok(n > 0, '#' + id + ' 必须绑定 input 监听（否则脏编辑检测不到）');
      return node;
    },
    async clickReturn() {
      const link = doc.getElementById('workbench-return');
      assert.ok(link, '工作台必须有返回链接 #workbench-return');
      const ev = { preventDefault() { this.prevented = true; } };
      let out = null;
      if (typeof link.onclick === 'function') out = link.onclick(ev);
      if (out && typeof out.then === 'function') await out;
      await tick();
      return ev.prevented === true;
    },
    async waitFor(pred, label, ms) {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return true;
        if (Date.now() - t0 > (ms || 3000)) {
          throw new Error('等待超时：' + (label || '条件未满足')
            + '｜hash=' + loc.hash
            + '｜toast=' + JSON.stringify(toasts.slice(-3))
            + '｜请求=' + JSON.stringify(requests.slice(-6).map(r => r.method + ' ' + r.url)));
        }
        await new Promise(r => setTimeout(r, 5));
      }
    },
    puts: () => requests.filter(r => r.method === 'PUT' || r.method === 'PATCH'),
  };
  return h;
}

// 打开写作页并选中第 1 章（真实 BookPage.show + selectChapter）
async function openWriting(h, bookId, chapterId) {
  await h.page.show(bookId || 7);
  await h.page.selectChapter(chapterId || 12);
  await h.page.loadChat();
  return h;
}

function requireWs(h) {
  const ws = h.ws();
  assert.ok(ws, 'public/workspace-state.js 必须已加载（S4-03 统一导航状态）');
  assert.equal(typeof ws.capture, 'function', 'WorkspaceState.capture 必须存在（01 契约 §6）');
  assert.equal(typeof ws.navigate, 'function', 'WorkspaceState.navigate 必须存在');
  assert.equal(typeof ws.restore, 'function', 'WorkspaceState.restore 必须存在');
  return ws;
}

test('S4-03 骨架：统一导航状态模块存在且由页面加载', () => {
  const modulePath = path.join(root, 'public/workspace-state.js');
  assert.equal(fs.existsSync(modulePath), true, 'public/workspace-state.js 必须存在（S4-03 统一导航状态与跨页面草稿保护）');
  assert.match(indexHtml(), /<script src="workspace-state\.js/, 'index.html 必须加载 workspace-state.js（四个工作台与写作页共用同一守卫）');
});

test('写作章打开大纲工作台再返回：同一章、同一写作会话', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);

  const originalContext = ws.capture();
  assert.equal(originalContext.workspace, 'writing');
  assert.equal(originalContext.bookId, '7');
  assert.equal(originalContext.chapterId, 12, '写作页当前章必须进导航对象');
  assert.equal(originalContext.conversationId, WRITING_CONV.id, '当前写作会话必须进导航对象');

  const opened = await ws.navigate({ workspace: 'workbench', entityType: 'outline' });
  assert.equal(opened, true, '干净稿应放行到工作台');
  assert.equal(h.location.hash, '#/book/7/workbench/outline', '导航提交到工作台路由');
  await h.waitFor(() => h.$('#save-outline-workbench'), '大纲工作台渲染');

  const inWorkbench = ws.capture();
  assert.equal(inWorkbench.workspace, 'workbench');
  assert.equal(inWorkbench.entityType, 'outline');
  assert.equal(inWorkbench.chapterId, 12, '工作台里仍记得当前的章（returnTo 的载荷）');
  assert.equal(inWorkbench.returnTo, '#/book/7', '工作台入口携带 returnTo 指向写作页');
  const returnRecord = ws.readReturn(7);
  assert.equal(returnRecord.workspace, 'writing');
  assert.equal(returnRecord.chapterId, 12, 'returnTo 记录必须保存章');
  assert.equal(returnRecord.conversationId, WRITING_CONV.id, 'returnTo 记录必须保存写作会话');

  const clicked = await h.clickReturn();
  assert.equal(clicked, true, '返回链接必须走 WorkspaceState.restore（不是裸 hash 跳转）');
  await h.waitFor(() => h.location.hash === '#/book/7', '回到写作页');
  await h.waitFor(() => h.page.hasUnsavedChanges() === false && h.App.state.currentChapterId === 12, '写作页载回第 1 章');

  const restoredContext = ws.capture();
  assert.deepEqual(restoredContext, originalContext, '返回后导航对象必须逐字段一致（书/章/会话/页签）');
  assert.equal(h.node('chapter-content').value, '石碑正文', '返回后编辑器载入同一章正文');
  await h.waitFor(() => h.node('writing-conversation-select').value === WRITING_CONV.id, '会话切换器回填同一会话');
  assert.equal(h.node('writing-conversation-select').value, WRITING_CONV.id, '返回后仍是同一写作会话');
  assert.deepEqual(h.missingIds(), [], '页面不得查询不存在的 id：' + h.missingIds().join(', '));
});

test('写作章打开故事台账（带页签）再返回：页签与章都保留', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  const originalContext = ws.capture();

  await ws.navigate({ workspace: 'workbench', entityType: 'ledger', tab: 'proposals' });
  await h.waitFor(() => h.location.hash.indexOf('tab=proposals') > 0, '台账页签路由');
  await h.waitFor(() => h.$('#ledger-panel') && h.$('#ledger-panel').textContent.length >= 0, '台账面板渲染');

  const inWorkbench = ws.capture();
  assert.equal(inWorkbench.entityType, 'ledger');
  assert.equal(inWorkbench.tab, 'proposals', '页签必须进导航对象');
  assert.equal(inWorkbench.chapterId, 12);

  await h.clickReturn();
  await h.waitFor(() => h.location.hash === '#/book/7', '回到写作页');
  await h.waitFor(() => h.App.state.currentChapterId === 12, '载回原章');
  assert.deepEqual(ws.capture(), originalContext, '台账往返后导航对象必须一致');
});

test('Agent 人物专题打开人物工作台再返回：同一个 Agent 会话', async () => {
  const h = harness({ hash: '#/agent', storage: { agent_scope_v1: 'book:7', agent_conversation_v1: AGENT_CONV.id } });
  const ws = requireWs(h);
  assert.ok(h.agentPage, 'Agent 台页面脚本必须已加载');
  await h.agentPage.show();
  assert.equal(h.node('agent-conversation-select').value, AGENT_CONV.id, 'Agent 台进入时选中该书会话');

  const originalContext = ws.capture();
  assert.equal(originalContext.workspace, 'agent');
  assert.equal(originalContext.conversationId, AGENT_CONV.id);

  // 资源预览里的「打开工作台 →」就是这条 hash 路由（agent.js renderPreview 的 link.href）
  await ws.navigate({ workspace: 'workbench', entityType: 'characters', entityId: '5', tab: 'profile' });
  await h.waitFor(() => h.location.hash.indexOf('/workbench/characters/5') > 0, '人物工作台路由');
  await h.waitFor(() => h.$('#character-profile-form'), '人物档案表单渲染');

  const inWorkbench = ws.capture();
  assert.equal(inWorkbench.entityType, 'characters');
  assert.equal(inWorkbench.entityId, '5', '实体 id 必须进导航对象');
  assert.equal(inWorkbench.tab, 'profile', '页签必须进导航对象');
  assert.equal(ws.readReturn(7).workspace, 'agent', 'returnTo 记录来源工作空间＝Agent 台');

  const link = h.node('workbench-return');
  assert.match(link.textContent, /Agent/, '返回链接文案必须说明回的是 Agent 台：' + link.textContent);
  await h.clickReturn();
  await h.waitFor(() => h.location.hash === '#/agent', '回到 Agent 台');
  await h.waitFor(() => h.node('agent-conversation-select').value === AGENT_CONV.id, 'Agent 会话选择器恢复');

  assert.deepEqual(ws.capture(), originalContext, 'Agent 往返后导航对象必须一致（同一会话）');
  assert.equal(h.node('agent-conversation-select').value, AGENT_CONV.id, '返回后仍是同一个 Agent 会话');
});

test('四个工作台各自往返：导航对象逐字段一致', async () => {
  const modules = [
    { entityType: 'outline', marker: '#save-outline-workbench' },
    { entityType: 'ledger', marker: '#ledger-panel' },
    { entityType: 'world', marker: '#world-entry-list' },
    { entityType: 'characters', marker: '#character-profile-form' },
  ];
  for (const mod of modules) {
    const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
    const ws = requireWs(h);
    await openWriting(h, 7, 12);
    const originalContext = ws.capture();

    assert.equal(await ws.navigate({ workspace: 'workbench', entityType: mod.entityType }), true, mod.entityType + ' 应放行');
    await h.waitFor(() => h.$(mod.marker), mod.entityType + ' 渲染');
    const inside = ws.capture();
    assert.equal(inside.workspace, 'workbench', mod.entityType + ' 导航对象 workspace');
    assert.equal(inside.bookId, '7', mod.entityType + ' 导航对象 bookId');

    await h.clickReturn();
    await h.waitFor(() => h.location.hash === '#/book/7', mod.entityType + ' 返回写作页');
    await h.waitFor(() => h.App.state.currentChapterId === 12, mod.entityType + ' 载回原章');
    assert.deepEqual(ws.capture(), originalContext, mod.entityType + ' 往返后导航对象必须一致');
  }
});

test('刷新可恢复有效导航：hash 重建工作空间/实体/页签，不依赖内存', async () => {
  const first = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(first);
  await openWriting(first, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'characters', entityId: '5', tab: 'profile' });
  await first.waitFor(() => first.location.hash.indexOf('tab=profile') > 0, '人物档案页签');
  const before = ws.capture();
  const session = first.sessionAll();

  // 刷新：同一份 sessionStorage、同一 hash、全新页面实例
  const second = harness({ hash: first.location.hash, storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id }, session });
  const ws2 = requireWs(second);
  // app.js 在加载时按 hash 路由（真实刷新路径）
  const after = ws2.capture();
  assert.equal(after.workspace, 'workbench', '刷新后仍是工作台导航');
  assert.equal(after.bookId, '7');
  assert.equal(after.entityType, 'characters');
  assert.equal(after.entityId, '5', '刷新后实体仍在导航对象里');
  assert.equal(after.tab, 'profile', '刷新后页签仍在导航对象里');
  assert.equal(after.returnTo, before.returnTo, '刷新后 returnTo 指向同一来源');
  assert.equal(second.loaded.includes('workspace-state.js'), true, '刷新路径也必须加载统一导航状态');

  // 旧链接（S4-03 之前的 workbench hash）仍可打开
  const legacy = harness({ hash: '#/book/7/workbench/outline', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws3 = requireWs(legacy);
  const legacyNav = ws3.capture();
  assert.equal(legacyNav.workspace, 'workbench');
  assert.equal(legacyNav.entityType, 'outline');
  // 旧链接没有 S4-03 返回记录时：退回同一本书的写作页（不猜来源、不猜章）
  assert.equal(legacyNav.returnTo, '#/book/7', '旧链接退回同书写作页');
  await legacy.waitFor(() => legacy.$('#save-outline-workbench'), '旧链接仍能打开大纲工作台');
});

test('大纲工作台保存失败：保留 dirty、不提交导航、不报「已保存」', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'outline' });
  await h.waitFor(() => h.$('#workbench-master-outline'), '大纲工作台渲染');

  h.setRoute(req => (req.method === 'PUT' && req.url === '/api/books/7') ? { status: 503, body: { error: { code: 'DB_LOCKED', message: '落盘失败' } } } : null);
  h.write('workbench-master-outline', '改了一半的总纲');
  assert.equal(ws.hasDirty(), true, '编辑后必须视为脏');

  const before = h.location.hash;
  const returned = await ws.navigate({ workspace: 'writing' });
  const after = h.location.hash;
  const failedSaveNavigationCommitted = !(returned === false && after === before);
  assert.equal(failedSaveNavigationCommitted, false, '保存失败不得提交导航（hash 不动）');
  assert.equal(ws.hasDirty(), true, '保存失败后剩余修改仍是 dirty');
  assert.equal(h.node('workbench-master-outline').value, '改了一半的总纲', '草稿留在表单里');
  assert.deepEqual(h.toasts.filter(t => t.indexOf('大纲已保存') >= 0), [], '不得统一 toast「已保存」：' + JSON.stringify(h.toasts));
  assert.ok(h.toasts.some(t => t.indexOf('保存失败') >= 0), '必须明确提示保存失败：' + JSON.stringify(h.toasts));
  assert.equal(h.puts().filter(r => r.url === '/api/books/7').length, 1, '失败路径只尝试一次，不重放');
});

test('世界观工作台保存失败：保留 dirty、不提交导航、不报「已保存」', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'world' });
  await h.waitFor(() => h.$('#world-entry-content'), '世界观表单渲染');

  h.setRoute(req => (req.method === 'PUT' && /\/world\/31$/.test(req.url)) ? { status: 503, body: { error: { code: 'DB_LOCKED', message: '落盘失败' } } } : null);
  h.write('world-entry-content', '改了一半的设定');

  const before = h.location.hash;
  const returned = await ws.navigate({ workspace: 'writing' });
  const after = h.location.hash;
  const failedSaveNavigationCommitted = !(returned === false && after === before);
  assert.equal(failedSaveNavigationCommitted, false, '世界观保存失败不得提交导航');
  assert.equal(ws.hasDirty(), true, '剩余修改必须仍是 dirty');
  assert.equal(h.node('world-entry-content').value, '改了一半的设定', '草稿留在表单里');
  assert.deepEqual(h.toasts.filter(t => t.indexOf('世界设定已保存') >= 0), [], '不得报「已保存」');
  assert.ok(h.toasts.some(t => t.indexOf('保存失败') >= 0), '必须明确提示保存失败：' + JSON.stringify(h.toasts));
});

test('人物工作台保存失败：保留 dirty、不提交导航、不报「已保存」', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'characters', entityId: '5' });
  await h.waitFor(() => h.$('#character-profile-form'), '人物档案表单渲染');

  h.setRoute(req => (req.method === 'PATCH' && /\/characters\/5$/.test(req.url)) ? { status: 500, body: { error: { code: 'WRITE_FAILED', message: '写入失败' } } } : null);
  const form = h.$('#character-profile-form');
  const nameField = form.querySelectorAll('[name="name"]')[0];
  assert.ok(nameField, '人物表单必须有 name 字段');
  nameField.value = '林昭（改）';
  h.fire(nameField, 'input');
  assert.equal(ws.hasDirty(), true, '人物表单编辑后必须视为脏');

  const before = h.location.hash;
  const returned = await ws.navigate({ workspace: 'writing' });
  const after = h.location.hash;
  const failedSaveNavigationCommitted = !(returned === false && after === before);
  assert.equal(failedSaveNavigationCommitted, false, '人物保存失败不得提交导航');
  assert.equal(ws.hasDirty(), true, '剩余修改必须仍是 dirty');
  assert.equal(nameField.value, '林昭（改）', '草稿留在表单里');
  assert.deepEqual(h.toasts.filter(t => t.indexOf('人物档案已保存') >= 0), [], '不得报「已保存」');
  assert.ok(h.toasts.some(t => t.indexOf('保存失败') >= 0), '必须明确提示保存失败：' + JSON.stringify(h.toasts));
});

test('台账工作台保存失败：保留 dirty、不提交导航、不报「已保存」', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'ledger' });
  await h.waitFor(() => h.$('#ledger-progress'), '台账概览渲染');

  h.setRoute(req => (req.method === 'PUT' && /\/ledger\/progress$/.test(req.url)) ? { status: 503, body: { error: { code: 'DB_LOCKED', message: '落盘失败' } } } : null);
  h.write('ledger-progress', '改了一半的进展摘要');

  const before = h.location.hash;
  const returned = await ws.navigate({ workspace: 'writing' });
  const after = h.location.hash;
  const failedSaveNavigationCommitted = !(returned === false && after === before);
  assert.equal(failedSaveNavigationCommitted, false, '台账保存失败不得提交导航');
  assert.equal(ws.hasDirty(), true, '剩余修改必须仍是 dirty');
  assert.equal(h.node('ledger-progress').value, '改了一半的进展摘要', '草稿留在表单里');
  assert.deepEqual(h.toasts.filter(t => t.indexOf('进展摘要已保存') >= 0), [], '不得报「已保存」');
  assert.ok(h.toasts.some(t => t.indexOf('保存失败') >= 0), '必须明确提示保存失败：' + JSON.stringify(h.toasts));
});

test('保存成功后脏标记清除，导航才放行（正向对照）', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'world' });
  await h.waitFor(() => h.$('#world-entry-content'), '世界观表单渲染');
  h.write('world-entry-content', '这次能保存的设定');

  assert.equal(await ws.navigate({ workspace: 'writing' }), true, '保存成功应放行');
  assert.equal(ws.hasDirty(), false, '保存成功后不再是脏');
  assert.equal(h.location.hash, '#/book/7');
  assert.equal(h.puts().filter(r => /\/world\/31$/.test(r.url)).length, 1);
});

test('异步过期结果：切书后晚到的 A 书响应不写进 B 书', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  const deferred = h.defer();
  h.setRoute(req => ((req.method === 'GET' && req.url === '/api/books/7/world') ? deferred.promise : null));

  await ws.navigate({ workspace: 'workbench', bookId: 7, entityType: 'world' });
  await h.waitFor(() => h.location.hash === '#/book/7/workbench/world', 'A 书工作台路由');
  // A 书的 load 仍挂着，切到 B 书工作台
  await ws.navigate({ workspace: 'workbench', bookId: 9, entityType: 'world' });
  await h.waitFor(() => h.location.hash === '#/book/9/workbench/world', 'B 书工作台路由');
  await h.waitFor(() => (h.node('world-entry-list') || {}).textContent
    && h.node('world-entry-list').textContent.indexOf(WORLD_9.title) >= 0, 'B 书设定列表渲染');

  const listBefore = h.node('world-entry-list').textContent;
  deferred.resolve({ body: { entries: [WORLD_7] } });
  await tick(); await tick(); await tick();

  const listAfter = h.node('world-entry-list').textContent;
  const lateBookAResponseAppliedToBookB = (listBefore.indexOf(WORLD_7.title) >= 0) || (listAfter.indexOf(WORLD_7.title) >= 0);
  assert.equal(lateBookAResponseAppliedToBookB, false,
    'A 书（书 7）的晚到响应不得写进 B 书（书 9）：' + listAfter);
  h.setRoute(null);
});

test('已删除人物：明确空态，不自动跳其他人物', async () => {
  const h = harness({ hash: '#/book/7/workbench/characters/99', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await h.waitFor(() => {
    const detail = h.node('character-detail');
    return !!detail && /不在本书|已被删除|找不到/.test(detail.textContent);
  }, '空态渲染');
  const detail = h.node('character-detail').textContent;
  assert.match(detail, /不在本书|已被删除|找不到/, '已删除人物必须给明确空态：' + detail);
  assert.equal(detail.indexOf(CHAR5.name) >= 0, false, '不得自动跳到名册里的其他人物：' + detail);
  assert.equal(ws.capture().bookId, '7', '仍在同一本书，不自动跳其他书');
});

test('已删除章节：restore 明确失败并给空态，不自动跳其他章', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  const snapshot = { workspace: 'writing', bookId: 7, conversationId: WRITING_CONV.id, chapterId: 404 };

  const ok = await ws.restore(snapshot);
  assert.equal(ok, false, '目标章已删除：restore 必须返回 false');
  assert.equal(h.App.state.currentChapterId === 404, false, '不得把已删除的章当作当前章');
  assert.ok(h.toasts.some(t => /删除|不存在/.test(t)), '必须明确说明目标章已不在：' + JSON.stringify(h.toasts));
});

test('浏览器后退/前进同样走守卫：脏表单时 hash 回退、草稿保留', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  await ws.navigate({ workspace: 'workbench', entityType: 'world' });
  await h.waitFor(() => h.$('#world-entry-content'), '世界观表单渲染');

  h.setRoute(req => (req.method === 'PUT' && /\/world\/31$/.test(req.url)) ? { status: 503, body: { error: { code: 'DB_LOCKED', message: '落盘失败' } } } : null);
  h.write('world-entry-content', '浏览器后退前的草稿');

  const workbenchHash = h.location.hash;
  h.location.hash = '#/book/7';           // 等价于浏览器后退（hash 已变）
  await h.waitFor(() => h.location.hash === workbenchHash, '守卫把 hash 回退到原工作台');

  assert.equal(h.location.hash, workbenchHash, 'dirty 未保存时不得离开工作台');
  assert.equal(h.node('world-entry-content').value, '浏览器后退前的草稿', '草稿保留');
  assert.equal(ws.hasDirty(), true, '仍是脏');
  assert.equal(h.puts().filter(r => /\/world\/31$/.test(r.url)).length, 1, '只尝试一次保存，不重放');
});

test('统一守卫不回退 S1-05：正文脏稿时 hashchange 仍弹三选一', async () => {
  const h = harness({ hash: '#/book/7', storage: { [WRITING_BOOK7_KEY]: WRITING_CONV.id } });
  const ws = requireWs(h);
  await openWriting(h, 7, 12);
  h.setRoute(req => (req.method === 'PUT' && req.url === '/api/books/7/chapters/12') ? { status: 503, body: { error: { code: 'DB_LOCKED', message: '落盘失败' } } } : null);
  h.write('chapter-content', '还没保存的正文草稿');

  const bookHash = h.location.hash;
  h.location.hash = '#/';                 // 切到书架
  await h.waitFor(() => h.location.hash === bookHash, 'hash 回退到写作页');
  const modal = h.modal();
  assert.ok(modal, '脏稿离开必须弹三选一（S1-05 语义）');
  assert.equal(modal.title, '有未保存的修改');
  assert.equal(h.node('chapter-content').value, '还没保存的正文草稿', '草稿原样保留');
  assert.equal(ws.hasDirty(), true, '仍是脏');
});
