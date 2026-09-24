// S4-01b / 任务书 05 + 契约 01 §6：Agent 台「书籍交流 + 受控资源视图」页面回归。
// 载入真实 public/index.html 的 id 集合与真实 public/agent.js（+ chat-event-hub.js），
// 用最小 DOM 桩跑真实页面代码，钉住四件事：
//   1) 顶部三件套：范围选择（一本书/全局资源）、当前会话、剧情边界；状态行清楚显示讨论/执行。
//   2) 左侧「会话/资源」切换 + 资源列表与摘要走 S4-01a 的 GET /api/resources（与两个只读工具同源）。
//   3) 三条作者流程的请求与渲染：问整书伏笔 / 看之前剧情 / 查看作家卡与索引状态。
//   4) 范围与权限纪律：切范围只选择或新建、绝不改写原会话归属；全局范围不默认拥有写权限。
//
// 桩的纪律（吸取 S1-03c「VM 桩过松掩盖真实选择器缺陷」的教训）：元素节点只按
// public/index.html 中真实存在的 id 提供——页面代码请求一个 index.html 里没有的 id
// 会被记入 missingIds 并返回 null，用例显式断言 missingIds 为空，不允许「桩比页面宽」。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function indexIds() {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const ids = new Set();
  const re = /id="([^"]+)"/g;
  let m = re.exec(html);
  while (m) { ids.add(m[1]); m = re.exec(html); }
  return ids;
}
const CLIENT_IDS = indexIds();

// 页面骨架必须提供这些 id（断言打在真实 index.html 上，而不是桩上）
const REQUIRED_IDS = [
  'agent-main', 'agent-scope-select', 'agent-scope-status', 'agent-conversation-select', 'agent-boundary-select',
  'btn-agent-mode', 'agent-conversation-list', 'agent-tool-list',
  'agent-pane-conversations', 'agent-pane-resources', 'btn-agent-tab-conversations', 'btn-agent-tab-resources',
  'agent-res-type', 'agent-res-list', 'btn-agent-res-more', 'agent-res-hint',
  'agent-preview-panel', 'agent-preview-body', 'btn-agent-preview-close',
  'agent-messages', 'agent-form', 'agent-text', 'btn-agent-send', 'btn-agent-stop',
  'btn-agent-clear', 'btn-agent-compress', 'btn-agent-restore', 'agent-legacy-import',
];

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function sseResponse(frames) {
  const text = frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('');
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

const BOOKS = [{ id: 7, title: '雾港编年史' }, { id: 9, title: '另一部' }, { id: 5, title: '第三部' }];
const CONVERSATIONS = [
  { id: 'c-global', kind: 'agent', scope: 'global', book_id: null, title: '全局资源讨论', status: 'active' },
  { id: 'c-book-7', kind: 'agent', scope: 'book', book_id: 7, title: '雾港编年史 · 讨论', status: 'active' },
  { id: 'c-book-9', kind: 'agent', scope: 'book', book_id: 9, title: '另一部 · 讨论', status: 'active' },
];
const CHAT_REPLY = '这本书的伏笔有三处：第一卷的石碑、第二章的旧信、以及主角的身世。';

function harness(opts) {
  const o = opts || {};
  const nodes = new Map();
  const missing = new Set();
  const requests = [];
  const toasts = [];
  const conversations = o.conversations || CONVERSATIONS;

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], parent: null,
      dataset: {}, style: {}, _classes: new Set(), _text: '',
      listeners: {}, disabled: false, title: '', value: '', href: '', open: false,
      scrollTop: 0, scrollHeight: 0, onclick: null,
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
      set(v) { el.children.forEach(c => { c.parent = null; }); el.children = []; el._text = String(v == null ? '' : v); },
    });
    Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'nextSibling', {
      get() {
        if (!el.parent) return null;
        const i = el.parent.children.indexOf(el);
        return i >= 0 ? (el.parent.children[i + 1] || null) : null;
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
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    return el;
  }

  function matches(el, sel) {
    if (!sel) return false;
    if (sel.charAt(0) === '.') return el._classes && el._classes.has(sel.slice(1));
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
  };

  async function fetchStub(url, init) {
    const method = (init && init.method) || 'GET';
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    const req = { method, url: String(url), body };
    requests.push(req);
    const r = o.route ? o.route(req) : null;
    if (!r) return jsonResponse({ error: { code: 'STUB_NO_ROUTE', message: 'no stub route: ' + url } }, 404);
    if (r.sse) return sseResponse(r.sse);
    return jsonResponse(r.body, r.status || 200);
  }

  const App = {
    state: {},
    toast(msg) { toasts.push(String(msg)); },
    async api(method, url, body) {
      // 与 public/app.js 的 api() 同口径（含 Content-Type）：桩不能比真实调用宽
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
    confirm: () => true, location: { hash: '' },
  };
  context.window.document = doc;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/chat-event-hub.js'), 'utf8'), context);
  // 浏览器里 window 就是全局对象；VM 里要把 hub 再挂一层，agent.js 才能裸引用 ChatEventHub
  context.ChatEventHub = context.window.ChatEventHub;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8'), context);

  const h = {
    App,
    page: context.window.AgentPage,
    requests, toasts, missing,
    node: id => doc.getElementById(id),
    hasId: id => CLIENT_IDS.has(id),
    text: id => {
      const n = doc.getElementById(id);
      return n ? n.textContent : '';
    },
    missingIds: () => Array.from(missing),
    chats: () => requests.filter(r => r.url.indexOf('/api/agent/chat') === 0),
    resources: () => requests.filter(r => r.url.indexOf('/api/resources') === 0).map(r => r.url),
    posts: () => requests.filter(r => r.method && r.method !== 'GET'),
    lastChat: () => {
      const list = h.chats();
      return list.length ? list[list.length - 1].body : null;
    },
    optionsOf(id) {
      const n = doc.getElementById(id);
      if (!n) return [];
      return n.children.filter(c => c.tagName === 'OPTION').map(c => ({ value: c.value, text: c.textContent, selected: !!c.selected }));
    },
    bubbles() {
      const n = doc.getElementById('agent-messages');
      if (!n) return [];
      return descendants(n).filter(x => x._classes.has('msg-bubble')).map(x => x.textContent);
    },
    fire(id, type, ev) {
      const n = doc.getElementById(id);
      if (!n) return 0;
      const fns = n.listeners[type] || [];
      for (const fn of fns) fn(ev || { preventDefault() {}, target: n, key: '' });
      return fns.length;
    },
    fireChild(containerId, predicate, type, ev) {
      const n = doc.getElementById(containerId);
      if (!n) return null;
      const target = descendants(n).find(predicate);
      if (!target) return null;
      const fns = target.listeners[type] || [];
      if (fns.length) {
        for (const fn of fns) fn(ev || { preventDefault() {}, target });
      } else if (type === 'click' && typeof target.onclick === 'function') {
        target.onclick(ev || { target });
      } else {
        return null;
      }
      return target;
    },
    async waitFor(pred, label, ms) {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return true;
        if (Date.now() - t0 > (ms || 2000)) {
          throw new Error('等待超时：' + (label || '条件未满足')
            + '｜气泡=' + JSON.stringify(h.bubbles().slice(-3))
            + '｜消息区=' + JSON.stringify((doc.getElementById('agent-messages') || { textContent: '' }).textContent.slice(-160))
            + '｜toast=' + JSON.stringify(toasts.slice(-3))
            + '｜请求=' + JSON.stringify(requests.slice(-4).map(r => r.method + ' ' + r.url)));
        }
        await new Promise(r => setTimeout(r, 5));
      }
    },
    async start() {
      try {
        await context.window.AgentPage.show();
      } catch (e) {
        h.startError = e;
      }
      return h;
    },
    requirePage(label) {
      const absent = REQUIRED_IDS.filter(id => !CLIENT_IDS.has(id));
      assert.deepEqual(absent, [], (label || 'Agent 台') + '页面骨架缺失（index.html 必须提供真实 id）：' + absent.join(', '));
    },
  };
  return h;
}

// ---------- 桩上游响应 ----------
function chapterResource(bookId) {
  return {
    type: 'chapter', bookId, nextCursor: null,
    items: [
      { type: 'chapter', id: 12, title: '第一章 石碑', bookId, status: 'locked', route: `#/book/${bookId}/read/12`, meta: { sortOrder: 1, revision: 3, locked: true, charCount: 1200 } },
      { type: 'chapter', id: 13, title: '第二章 旧信', bookId, status: 'draft', route: `#/book/${bookId}/read/13`, meta: { sortOrder: 2, revision: 1, locked: false, charCount: 800 } },
    ],
  };
}
function styleResource(bookId) {
  return {
    type: 'style', bookId: bookId || null, nextCursor: null,
    items: [{
      type: 'style', id: 3, title: '古龙武侠', bookId: 7, status: 'enabled', route: `#/book/${bookId}/cards`,
      meta: { kind: 'preset', shared: false, builtin: false, enabled: true, ruleCount: 4, sampleCount: 3, indexedSampleCount: 2, lastIndexedAt: '2026-09-20 10:00:00' },
    }],
  };
}
function styleSummary(bookId) {
  return {
    type: 'style', bookId, resource: {
      type: 'style', id: 3, bookId: 7, found: true, title: '古龙武侠', status: 'enabled', route: `#/book/${bookId}/cards`,
      meta: { kind: 'preset', shared: false, builtin: false, enabled: true, ruleCount: 4, sampleCount: 3, indexedSampleCount: 2, lastIndexedAt: '2026-09-20 10:00:00' },
      details: { note: '主卡', persona: '宁可少写一句。', boundBooks: [7], index: { samples: 3, indexed: 2, vectorModel: 'text-embedding-v3', lastIndexedAt: '2026-09-20 10:00:00' } },
    },
  };
}
function globalResource(type) {
  if (type === 'book') {
    return {
      type, bookId: null, nextCursor: null,
      items: BOOKS.map(b => ({ type: 'book', id: b.id, title: b.title, bookId: b.id, status: 'collab', route: `#/book/${b.id}`, meta: { mode: 'collab', chapterCount: 2 } })),
    };
  }
  if (type === 'task') {
    return { type, bookId: null, nextCursor: null, items: [{ type: 'task', id: 'run-1', title: 'agent · discuss', bookId: 7, status: 'finished', route: '#/agent', meta: { entry: 'agent', mode: 'discuss' } }] };
  }
  if (type === 'system') {
    return { type, bookId: null, nextCursor: null, items: [{ type: 'system', id: 1, title: 'deepseek-v4-flash', bookId: null, status: 'configured', route: '#/settings', meta: { model: 'deepseek-v4-flash', keyConfigured: true } }] };
  }
  return { type, bookId: null, nextCursor: null, items: [] };
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

function defaultRoute(req) {
  for (const c of CONVERSATIONS) {
    if (req.url.indexOf('/api/conversations/' + c.id + '/messages') === 0) {
      return {
        body: {
          messages: [
            { id: 1, role: 'user', content: '之前聊过的内容', source: 'agent' },
            { id: 2, role: 'assistant', content: '这是服务端历史回复', source: 'agent', tools: [] },
          ],
        },
      };
    }
  }
  if (req.method === 'GET' && req.url === '/api/books') return { body: { books: BOOKS } };
  if (req.method === 'GET' && req.url.indexOf('/api/conversations?') === 0) return { body: CONVERSATIONS.slice() };
  if (req.method === 'GET' && req.url === '/api/agent/tools') return { body: { tools: [{ name: 'list_resources', title: '资源目录', description: '只读查询', mutation: 'read', confirmation: 'none' }] } };
  if (req.method === 'POST' && req.url === '/api/conversations') {
    return {
      status: 201,
      body: { id: 'c-new', kind: req.body.kind, scope: req.body.scope, book_id: req.body.bookId || null, title: req.body.title || '', status: 'active' },
    };
  }
  if (req.method === 'POST' && req.url === '/api/agent/chat') {
    return { sse: [{ type: 'text-delta', delta: CHAT_REPLY }, { type: 'finish', messageMetadata: { run: { id: 'run-1', status: 'finished' }, finalContent: CHAT_REPLY } }] };
  }
  if (req.method === 'GET' && req.url.indexOf('/api/resources') === 0) {
    const q = query(req.url);
    const type = q.type;
    if (q.id !== undefined) return { body: type === 'style' ? styleSummary(q.bookId ? Number(q.bookId) : null) : { type, bookId: q.bookId ? Number(q.bookId) : null, resource: { type, id: Number(q.id), found: true, title: '资源 ' + q.id, status: 'ok', route: null, meta: {}, details: {} } } };
    if (type === 'chapter') return { body: chapterResource(Number(q.bookId)) };
    if (type === 'style') return { body: styleResource(q.bookId ? Number(q.bookId) : null) };
    return { body: globalResource(type) };
  }
  return null;
}

function scopeValueOf(h, label) {
  const opts = h.optionsOf('agent-scope-select');
  const hit = opts.find(o => o.text.indexOf(label) >= 0);
  return hit ? hit.value : null;
}

// ---------- 用例 ----------

test('S4-01b 页面骨架：顶部范围/会话/剧情边界、左侧会话与资源切换、右侧预览必须就位', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();
  assert.equal(h.startError, undefined, 'Agent 台初始化不得抛错：' + (h.startError && h.startError.message));
  assert.deepEqual(h.missingIds(), [], '页面代码请求了 index.html 中不存在的 id（桩比页面宽的反面）：' + h.missingIds().join(', '));

  // 范围：全局资源 + 每一本书；默认全局
  const scopeOpts = h.optionsOf('agent-scope-select');
  assert.ok(scopeOpts.some(o => o.value === 'global'), '范围选择必须含「全局资源」，实际：' + JSON.stringify(scopeOpts));
  assert.ok(scopeOpts.some(o => o.value === 'book:7'), '范围选择必须含每一本书（book:<id>），实际：' + JSON.stringify(scopeOpts));
  assert.ok(scopeOpts.some(o => o.value === 'book:9'), '范围选择必须含每一本书（book:<id>），实际：' + JSON.stringify(scopeOpts));
  assert.equal(scopeValueOf(h, '全局资源'), 'global', '默认范围为全局资源');

  // 当前会话：默认范围内已有会话被选中
  assert.ok(h.optionsOf('agent-conversation-select').some(o => o.value === 'c-global'), '当前会话选择器必须列出该范围内的会话');
  // 剧情边界：全局范围不可用（没有书就没有时序边界）
  assert.equal(h.node('agent-boundary-select').disabled, true, '全局范围下剧情边界应禁用');
  // 状态行：清楚说明范围、会话与「讨论还是执行」
  const status = h.text('agent-scope-status');
  assert.ok(status.indexOf('全局资源') >= 0, '状态行必须显示当前范围，实际：' + status);
  assert.ok(status.indexOf('只读讨论') >= 0, '状态行必须显示当前是讨论还是执行，实际：' + status);
  assert.equal(h.node('btn-agent-mode').disabled, true, '全局范围不得默认可写（模式按钮禁用）');
});

test('流程一「问整书伏笔」：切到某本书 → 选中该书会话 → 讨论模式发送只带会话与内容', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();

  const bookScope = scopeValueOf(h, '雾港编年史');
  assert.ok(bookScope, '范围选择必须能选中《雾港编年史》');
  h.node('agent-scope-select').value = bookScope;
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === 'c-book-7', '切到该书后选中现有书籍会话');
  assert.equal(h.node('agent-conversation-select').value, 'c-book-7', '切范围必须选择该范围现有会话');

  // 剧情边界选项来自本书章节（受控资源目录同一服务端口）
  await h.waitFor(() => h.optionsOf('agent-boundary-select').length >= 3, '剧情边界选项');
  const boundary = h.optionsOf('agent-boundary-select');
  assert.equal(boundary[0].value, '', '剧情边界第一项必须是「全书」');
  assert.deepEqual(boundary.map(o => o.value), ['', '12', '13'], '剧情边界必须列出本书章节，实际：' + JSON.stringify(boundary));
  assert.ok(h.resources().some(u => u.indexOf('type=chapter') >= 0 && u.indexOf('bookId=7') >= 0),
    '剧情边界必须走 GET /api/resources?type=chapter&bookId=…，实际：' + JSON.stringify(h.resources()));
  const status = h.text('agent-scope-status');
  assert.ok(status.indexOf('雾港编年史') >= 0 && status.indexOf('全书') >= 0, '状态行必须显示当前书与边界，实际：' + status);
  assert.ok(status.indexOf('只读讨论') >= 0, '默认是只读讨论，实际：' + status);

  h.node('agent-text').value = '整本书埋了哪些伏笔？';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '助手回复渲染');

  const body = h.lastChat();
  assert.ok(body, '必须向 /api/agent/chat 发送请求');
  assert.equal(body.conversation_id, 'c-book-7', '发送必须带当前会话 id');
  assert.equal(body.content, '整本书埋了哪些伏笔？', '发送必须带用户内容');
  assert.equal(body.mode, undefined, '只读讨论不得声明 execute 模式');
  assert.equal(body.book_id, undefined, '讨论不需要 book_id（服务端按会话归属）');
  assert.equal(body.chapterId, undefined, '未选边界时不得凭空带 chapterId');
  assert.ok(h.bubbles().some(t => t.indexOf('整本书埋了哪些伏笔？') >= 0), '用户消息必须渲染');
  assert.ok(h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '助手回复必须渲染');
});

test('流程二「看之前剧情」：剧情边界=截至某章时请求携带 chapterId，切回全局不留残边界', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();

  h.node('agent-scope-select').value = scopeValueOf(h, '雾港编年史');
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.optionsOf('agent-boundary-select').length >= 3, '剧情边界选项');

  h.node('agent-boundary-select').value = '12';
  h.fire('agent-boundary-select', 'change');
  const status = h.text('agent-scope-status');
  assert.ok(status.indexOf('截至') >= 0, '选了边界后状态行必须显示「截至某章」，实际：' + status);

  h.node('agent-text').value = '之前剧情里主角走到哪了？';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.chats().length >= 1, '发出请求');
  await h.waitFor(() => h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '助手回复渲染');
  const body = h.lastChat();
  assert.equal(body.chapterId, 12, '截至第 N 章的讨论必须把 chapterId 传给服务端（资料快照边界）');
  assert.equal(body.mode, undefined, '讨论模式不变');

  // 切回全局范围：边界必须清空，且不得把上一本书的 chapterId 带进全局请求
  h.node('agent-scope-select').value = 'global';
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === 'c-global', '切回全局会话');
  assert.equal(h.node('agent-boundary-select').disabled, true, '全局范围下剧情边界不可选');
  assert.equal(h.text('agent-scope-status').indexOf('截至'), -1, '全局范围不得残留上一本书的边界');
  h.node('agent-text').value = '全局问一句';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.chats().length >= 2, '全局请求');
  await h.waitFor(() => h.node('agent-text').value === '', '全局请求完成');
  const globalBody = h.lastChat();
  assert.equal(globalBody.conversation_id, 'c-global', '全局范围用全局会话');
  assert.equal(globalBody.chapterId, undefined, '全局会话不得携带书籍时序边界');
});

test('流程三「查看作家卡与索引状态」：资源列表与摘要走 /api/resources，点击进预览或工作台', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();
  assert.deepEqual(h.missingIds(), [], '页面代码请求了 index.html 中不存在的 id：' + h.missingIds().join(', '));

  h.node('agent-scope-select').value = scopeValueOf(h, '雾港编年史');
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.optionsOf('agent-boundary-select').length >= 3, '切书完成');

  // 左侧切到「资源」
  h.fire('btn-agent-tab-resources', 'click');
  assert.ok(h.node('agent-pane-resources')._classes.has('hidden') === false, '资源面板必须展开');
  assert.ok(h.node('agent-pane-conversations')._classes.has('hidden'), '会话面板必须收起');
  await h.waitFor(() => h.resources().some(u => u.indexOf('type=chapter') >= 0), '书籍范围默认列出书内资源');

  const types = h.optionsOf('agent-res-type').map(o => o.value);
  assert.ok(types.indexOf('style') >= 0, '书籍范围资源类型必须含作家卡，实际：' + JSON.stringify(types));
  assert.ok(types.indexOf('character') >= 0 && types.indexOf('ledger') >= 0, '书籍范围资源类型必须含人物/台账');

  h.node('agent-res-type').value = 'style';
  h.fire('agent-res-type', 'change');
  await h.waitFor(() => h.resources().some(u => u.indexOf('type=style') >= 0), '作家卡列表请求');
  const listUrl = h.resources().filter(u => u.indexOf('type=style') >= 0).pop();
  assert.ok(listUrl.indexOf('bookId=7') >= 0, '书籍范围的资源列表必须带 bookId，实际：' + listUrl);
  await h.waitFor(() => h.text('agent-res-list').indexOf('古龙武侠') >= 0, '作家卡渲染');
  assert.ok(h.text('agent-res-list').indexOf('索引 2/3') >= 0, '卡片必须显示索引状态（indexed/total），实际：' + h.text('agent-res-list'));

  // 点击卡片 → 摘要进右侧预览
  h.fireChild('agent-res-list', n => n.dataset && n.dataset.resourceId === '3', 'click');
  await h.waitFor(() => h.text('agent-preview-body').indexOf('古龙武侠') >= 0, '预览渲染');
  const detailUrl = h.resources().filter(u => u.indexOf('id=3') >= 0).pop();
  assert.ok(detailUrl && detailUrl.indexOf('type=style') >= 0 && detailUrl.indexOf('bookId=7') >= 0,
    '摘要必须走 GET /api/resources?type=style&id=3&bookId=7，实际：' + JSON.stringify(h.resources()));
  const preview = h.text('agent-preview-body');
  assert.ok(preview.indexOf('text-embedding-v3') >= 0, '预览必须显示索引向量模型（index 状态），实际：' + preview);
  assert.ok(preview.indexOf('索引') >= 0, '预览必须显示索引小节');
  assert.equal(h.node('agent-preview-panel')._classes.has('hidden'), false, '预览面板必须展开');
  // 资源点击进入已有工作台：预览提供站内 hash 路由
  const link = (function find(n) {
    if (n.tagName === 'A' && n.href) return n;
    for (const c of n.children || []) { if (!c.children) continue; const r = find(c); if (r) return r; }
    return null;
  })(h.node('agent-preview-body'));
  assert.ok(link, '预览必须提供跳转已有工作台的入口');
  assert.equal(link.href, '#/book/7/cards', '作家卡必须在预览里跳既有卡片页（hash 导航）');

  // 收起
  h.fire('btn-agent-preview-close', 'click');
  assert.ok(h.node('agent-preview-panel')._classes.has('hidden'), '预览可收起');
});

test('范围切换纪律：选择该范围现有会话或新建，绝不改写原会话归属', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();
  const before = h.requests.length;

  // 切到有会话的书：直接用现有会话，不创建
  h.node('agent-scope-select').value = 'book:9';
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === 'c-book-9', '选中书9现有会话');
  assert.equal(h.node('agent-conversation-select').value, 'c-book-9', '有现有会话时必须复用，不新建');

  // 切到没有会话的书：不新建（发送时或点「新会话」才建），状态行给出明确交代
  h.node('agent-scope-select').value = 'book:5';
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === '', '该书暂无会话');
  assert.ok(h.text('agent-scope-status').indexOf('未选择') >= 0, '没有会话时状态行必须交代，实际：' + h.text('agent-scope-status'));
  const created = h.posts().filter(r => r.url === '/api/conversations');
  assert.equal(created.length, 0, '仅浏览范围不得凭空创建会话');

  // 发送：按当前范围新建会话（scope/bookId 正确），随后聊天用新会话
  h.node('agent-text').value = '这本书的开头怎么改？';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.posts().some(r => r.url === '/api/conversations'), '按当前范围新建会话');
  await h.waitFor(() => h.chats().length >= 1, '新会话发出请求');
  await h.waitFor(() => h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '新会话第一轮回复');
  // 新建会话会清空消息区——必须发生在渲染本轮气泡之前，否则刚发的消息与回复当场消失
  assert.ok(h.bubbles().some(t => t.indexOf('这本书的开头怎么改？') >= 0), '本轮用户消息必须留在消息区（不得被新建会话清掉）');
  assert.ok(h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '本轮回复必须留在消息区');
  const post = h.posts().filter(r => r.url === '/api/conversations').pop();
  assert.deepEqual({ kind: post.body.kind, scope: post.body.scope, bookId: post.body.bookId }, { kind: 'agent', scope: 'book', bookId: 5 },
    '新建会话必须用当前范围的 scope/bookId（不能落在别的书上）');
  const chat = h.lastChat();
  assert.equal(chat.conversation_id, 'c-new', '新会话创建后聊天用它');
  assert.equal(chat.mode, undefined, '仍是讨论模式');

  // 会话归属只读：全程不得有 PUT/PATCH 会话的请求（切范围不改写原会话归属）
  const mutating = h.requests.filter(r => (r.method === 'PUT' || r.method === 'PATCH') || r.url.indexOf('/api/conversations/archive') >= 0);
  assert.deepEqual(mutating, [], '切范围不得改写/归档任何会话，实际：' + JSON.stringify(mutating.map(r => r.method + ' ' + r.url)));
  const globalUsedInBook = h.chats().filter(r => r.body.conversation_id === 'c-global');
  assert.equal(globalUsedInBook.length, 0, '书籍范围的交流不得复用全局会话（历史必须分开）');
  assert.ok(before >= 0);
});

test('权限纪律：全局范围不默认拥有写权限；执行模式只在书籍范围且随范围回落', async () => {
  const h = harness({ route: defaultRoute });
  h.requirePage('Agent 台');
  await h.start();

  // 全局：模式按钮禁用，点击无效
  assert.equal(h.node('btn-agent-mode').disabled, true, '全局范围模式按钮必须禁用');
  h.fire('btn-agent-mode', 'click');
  await h.waitFor(() => true);
  assert.ok(h.text('agent-scope-status').indexOf('只读讨论') >= 0, '全局范围必须保持只读讨论，实际：' + h.text('agent-scope-status'));

  // 书籍范围：可切执行，执行请求带 mode=execute 与 book_id
  h.node('agent-scope-select').value = scopeValueOf(h, '雾港编年史');
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === 'c-book-7', '切到书');
  assert.equal(h.node('btn-agent-mode').disabled, false, '书籍范围可进入执行模式');
  h.fire('btn-agent-mode', 'click');
  assert.ok(h.text('agent-scope-status').indexOf('执行') >= 0, '状态行必须显示执行模式，实际：' + h.text('agent-scope-status'));
  h.node('agent-text').value = '把第 2 章标题改一下';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.chats().length >= 1, '执行请求');
  const exec = h.lastChat();
  assert.equal(exec.mode, 'execute', '执行模式必须声明 mode=execute');
  assert.equal(exec.book_id, 7, '执行必须绑定当前书');
  await h.waitFor(() => h.bubbles().some(t => t.indexOf(CHAT_REPLY) >= 0), '执行请求完成');

  // 切回全局：执行模式必须回落为只读讨论，且请求不得带写声明
  h.node('agent-scope-select').value = 'global';
  h.fire('agent-scope-select', 'change');
  await h.waitFor(() => h.node('agent-conversation-select').value === 'c-global', '切回全局');
  assert.equal(h.node('btn-agent-mode').disabled, true, '切回全局后执行模式必须回落（按钮禁用）');
  assert.ok(h.text('agent-scope-status').indexOf('只读讨论') >= 0, '切回全局后状态行必须显示只读讨论，实际：' + h.text('agent-scope-status'));
  h.node('agent-text').value = '全局找一本书';
  h.fire('agent-form', 'submit');
  await h.waitFor(() => h.chats().length >= 2, '全局请求');
  const globalBody = h.lastChat();
  assert.equal(globalBody.mode, undefined, '全局范围不得携带 execute 声明');
  assert.equal(globalBody.book_id, undefined, '全局范围不得绑定书');

  // 全局资源查询：不带 bookId（服务端对 corpus/system 会 400，页面不许瞎传）
  h.fire('btn-agent-tab-resources', 'click');
  await h.waitFor(() => h.resources().some(u => u.indexOf('type=') >= 0), '全局资源列表');
  const url = h.resources().slice(-1)[0];
  assert.equal(url.indexOf('bookId'), -1, '全局范围的资源查询不得带 bookId，实际：' + url);
  h.node('agent-res-type').value = 'system';
  h.fire('agent-res-type', 'change');
  await h.waitFor(() => h.resources().some(u => u.indexOf('type=system') >= 0), '系统资源列表');
  assert.equal(h.resources().slice(-1)[0].indexOf('bookId'), -1, '系统资源查询不得带 bookId');
});
