// S4-03：统一导航状态与跨页面草稿保护（冻结契约 01 §6）。
//
// 导航对象固定为 { workspace, bookId, conversationId, chapterId, entityType, entityId, tab, returnTo }：
//   · workspace  写作页 writing / Agent 台 agent / 专项工作台 workbench / 其他站点页面按 hash 归类
//   · bookId     当前书（写作页与工作台必须有效；Agent 台取 scope 键里的书，可能为空）
//   · conversationId 写作会话取自 writing_conversation_<bookId>（Agent 台取 agent_conversation_v1）
//   · chapterId  写作页当前章；在工作台里沿用「上一次在写作页选中的章」且只在同一本书内有效
//   · entityType/entityId/tab  工作台路由的模块名、模块内对象 id 与页签（与 #/book/:id/workbench/... 同源）
//   · returnTo   工作台入口携带的来源路由（由本模块记录的返回锚还原，不是猜出来的）
//
// 本模块是三个能力的唯一实现，四个工作台与写作编辑器只做接入：
//   1) 导航：capture / navigate / restore。navigate 先过守卫再改 hash——保存失败时 hash 一动不动，
//      因此「保存失败却提交了导航」在结构上不可能发生；restore 先按服务端校验目标（书/章/实体），
//      不拿过期内存当真相，对象已删时明确拒绝并给空态，绝不自动跳到别的书或对象。
//   2) 守卫：registerGuard / beforeNavigate。工作台表单与正文编辑器注册同一套守卫；保存成功且期间
//      无新输入才放行，失败保留 dirty 并明确提示（绝不 toast「已保存」，也绝不隐式当作放弃）。
//      浏览器前进/后退与站内跳转都走 app.js 的同一个 hashchange → beforeNavigate 路径。
//   3) 异步结果：beginRequest / isCurrent。load 响应必须同时匹配请求 token 与目标（书/实体），
//      切对象或切书后晚到的结果一律丢弃（不跨书回写）。
(function () {
  'use strict';

  var WS = window.WorkspaceState = {};
  var RETURN_PREFIX = 'novel-workspace-return:';
  var LEGACY_RETURN_PREFIX = 'novel-editor-return:'; // S4-02 之前的键：旧会话仍可打开
  var guards = [];
  var epochs = {};
  var chapterOwnerBookId = null; // 「当前章属于哪本书」：跨工作台保留，换书即失效

  function app() { return window.App || {}; }
  function appState() { return (window.App && window.App.state) || {}; }
  function currentHash() { return (window.location && window.location.hash) || '#/'; }
  function localStore() { return window.localStorage; }
  function sessionStore() { return window.sessionStorage; }
  function decode(value) { try { return decodeURIComponent(value); } catch (e) { return value; } }
  function readStore(store, key) { try { return store ? store.getItem(key) : null; } catch (e) { return null; } }
  function writeStore(store, key, value) {
    try { if (store) store.setItem(key, value); } catch (e) { /* 存储不可用：不影响导航 */ }
  }
  function removeStore(store, key) {
    try { if (store) store.removeItem(key); } catch (e) { /* 同上 */ }
  }
  function safeParse(raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function waitFor(pred, ms) {
    var deadline = Date.now() + (ms || 3000);
    for (;;) {
      try { if (pred()) return true; } catch (e) { /* 节点尚未渲染：继续等 */ }
      if (Date.now() > deadline) return false;
      await wait(10);
    }
  }

  // ---------- 路由解析（与 app.js / workbench-shell.js 同一套 hash 约定）----------
  function parseHash(raw) {
    var out = { workspace: 'shelf', bookId: null, entityType: null, entityId: null, tab: null };
    var hash = String(raw == null ? '' : raw);
    if (window.WorkbenchShell && typeof window.WorkbenchShell.parse === 'function') {
      var route = window.WorkbenchShell.parse(hash);
      if (route) {
        out.workspace = 'workbench';
        out.bookId = route.bookId;
        out.entityType = route.module;
        out.entityId = route.entityId;
        out.tab = route.tab;
        return out;
      }
    }
    var m;
    if ((m = /^#\/agent(?:$|[/?])/.exec(hash))) out.workspace = 'agent';
    else if ((m = /^#\/book\/([^/?]+)\/read(?:$|[/?])/.exec(hash))) { out.workspace = 'read'; out.bookId = decode(m[1]); }
    else if ((m = /^#\/book\/([^/?]+)\/characters\//.exec(hash))) { out.workspace = 'read'; out.bookId = decode(m[1]); }
    else if ((m = /^#\/book\/([^/?]+)\/(?:cards|stylelab)/.exec(hash))) { out.workspace = 'read'; out.bookId = decode(m[1]); }
    else if ((m = /^#\/book\/([^/?]+)/.exec(hash))) { out.workspace = 'writing'; out.bookId = decode(m[1]); }
    return out;
  }
  WS.parseHash = parseHash;

  function writingConversationId(bookId) {
    if (bookId === null || bookId === undefined || bookId === '') return null;
    var saved = readStore(localStore(), 'writing_conversation_' + String(bookId));
    if (saved) return saved;
    var sel = document.getElementById('writing-conversation-select');
    if (sel && sel.value && currentHash().indexOf('#/book/' + bookId) === 0) return String(sel.value);
    return null;
  }
  function agentScopeBookId() {
    var m = /^book:(\d+)$/.exec(readStore(localStore(), 'agent_scope_v1') || '');
    return m ? Number(m[1]) : null;
  }
  function agentConversationId() {
    return readStore(localStore(), 'agent_conversation_v1') || null;
  }

  // ---------- 导航对象 ----------
  WS.capture = function (rawHash) {
    var parsed = parseHash(rawHash === undefined ? currentHash() : rawHash);
    var state = appState();
    var nav = {
      workspace: parsed.workspace,
      bookId: parsed.bookId,
      conversationId: null,
      chapterId: null,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      tab: parsed.tab,
      returnTo: null,
    };
    if (parsed.workspace === 'writing' || parsed.workspace === 'read') {
      nav.conversationId = writingConversationId(parsed.bookId);
      nav.chapterId = state.currentChapterId != null ? Number(state.currentChapterId) : null;
      chapterOwnerBookId = nav.chapterId != null ? String(parsed.bookId) : null;
      return nav;
    }
    if (parsed.workspace === 'workbench') {
      nav.conversationId = writingConversationId(parsed.bookId);
      // 工作台里沿用写作页的当前章——只在同一本书内有效，避免把 A 书的章带到 B 书
      if (chapterOwnerBookId && String(chapterOwnerBookId) === String(parsed.bookId) && state.currentChapterId != null) {
        nav.chapterId = Number(state.currentChapterId);
      }
      var record = WS.readReturn(parsed.bookId);
      nav.returnTo = record ? WS.href(record) : null;
      return nav;
    }
    if (parsed.workspace === 'agent') {
      nav.bookId = agentScopeBookId();
      nav.conversationId = agentConversationId();
    }
    return nav;
  };

  WS.href = function (target) {
    var t = target || {};
    if (t.workspace === 'agent') return '#/agent';
    if (t.workspace === 'workbench') {
      if (t.bookId === null || t.bookId === undefined || t.bookId === '') return '#/';
      var base = '#/book/' + encodeURIComponent(t.bookId) + '/workbench/' + encodeURIComponent(t.entityType || 'characters');
      if (t.entityId !== null && t.entityId !== undefined && t.entityId !== '') base += '/' + encodeURIComponent(t.entityId);
      if (t.tab) base += '?tab=' + encodeURIComponent(t.tab);
      return base;
    }
    if (t.bookId === null || t.bookId === undefined || t.bookId === '') return '#/';
    if (t.workspace === 'read' && t.chapterId) {
      return '#/book/' + encodeURIComponent(t.bookId) + '/read/' + encodeURIComponent(t.chapterId);
    }
    return '#/book/' + encodeURIComponent(t.bookId);
  };

  function normalizeTarget(target, base) {
    var out = {};
    var src = base || {};
    for (var k in src) out[k] = src[k];
    var given = target || {};
    for (var g in given) if (given[g] !== undefined) out[g] = given[g];
    if (!out.workspace || out.workspace === 'shelf') return null;
    if (out.workspace !== 'workbench') { out.entityType = null; out.entityId = null; out.tab = null; }
    if (out.workspace !== 'agent' && (out.bookId === null || out.bookId === undefined || out.bookId === '')) return null;
    return out;
  }
  WS.normalizeTarget = normalizeTarget;

  // ---------- 返回锚（工作台入口携带 returnTo）----------
  WS.rememberReturn = function (snapshot, bookId) {
    if (!snapshot || bookId === null || bookId === undefined || bookId === '') return null;
    var copy = {};
    for (var k in snapshot) copy[k] = snapshot[k];
    copy.returnTo = null; // 记录的是「来源本身」，不再套娃
    writeStore(sessionStore(), RETURN_PREFIX + String(bookId), JSON.stringify(copy));
    return copy;
  };

  WS.readReturn = function (bookId) {
    if (bookId === null || bookId === undefined || bookId === '') return null;
    var raw = readStore(sessionStore(), RETURN_PREFIX + String(bookId));
    if (raw) {
      var nav = safeParse(raw);
      if (nav && nav.workspace && nav.workspace !== 'shelf') return nav;
    }
    var legacy = readStore(sessionStore(), LEGACY_RETURN_PREFIX + String(bookId));
    if (legacy) {
      var parsed = parseHash(legacy);
      if (parsed.workspace !== 'shelf') {
        return {
          workspace: parsed.workspace, bookId: parsed.bookId, conversationId: null, chapterId: null,
          entityType: parsed.entityType, entityId: parsed.entityId, tab: parsed.tab, returnTo: null,
        };
      }
    }
    return null;
  };

  WS.forgetReturn = function (bookId) {
    if (bookId === null || bookId === undefined || bookId === '') return;
    removeStore(sessionStore(), RETURN_PREFIX + String(bookId));
    removeStore(sessionStore(), LEGACY_RETURN_PREFIX + String(bookId));
  };

  // 离开一个非工作台页面且目标进入工作台时记录来源（工作台之间穿梭保留最初来源）
  WS.noteDeparture = function (fromHash, toHash) {
    var to = parseHash(toHash === undefined ? currentHash() : toHash);
    if (to.workspace !== 'workbench') return null;
    var from = WS.capture(fromHash);
    if (from.workspace === 'workbench' && WS.readReturn(to.bookId)) return null;
    return WS.rememberReturn(from, to.bookId);
  };

  // ---------- 脏编辑守卫 ----------
  WS.dirtyTracker = function () {
    var generation = 0;
    var dirty = false;
    return {
      mark: function () { generation += 1; dirty = true; return generation; },
      snapshot: function () { return generation; },
      isDirty: function () { return dirty; },
      // 保存成功只有当「提交时的代数仍是当前代数」才标干净（保存期间的新输入仍是脏）
      settle: function (token, ok) {
        if (ok === true && token === generation) dirty = false;
        return dirty === false;
      },
      clear: function () { dirty = false; },
    };
  };

  WS.registerGuard = function (guard) {
    if (!guard || !guard.key) return null;
    guards.push(guard);
    return guard;
  };

  WS.clearGuards = function (filter) {
    var before = guards.length;
    guards = guards.filter(function (g) {
      return !(typeof filter === 'function' ? filter(g) : true);
    });
    return before - guards.length;
  };

  WS.guards = function () { return guards.slice(); };
  WS.hasDirty = function () {
    return guards.some(function (g) { return typeof g.isDirty === 'function' && g.isDirty(); });
  };

  function notifyBlocked(guard) {
    var toast = app().toast;
    if (typeof toast !== 'function') return;
    toast('保存失败，已留在「' + ((guard && guard.label) || '当前编辑区') + '」：未保存的修改仍在，可重试保存或明确放弃');
  }

  // 返回 true 表示守卫全部放行（该保存的已保存）；false 表示拦下，调用方不得提交导航
  WS.beforeNavigate = async function (ctx) {
    var dirty = guards.filter(function (g) { return typeof g.isDirty === 'function' && g.isDirty(); });
    for (var i = 0; i < dirty.length; i++) {
      var guard = dirty[i];
      var allowed;
      if (typeof guard.leave === 'function') {
        allowed = await guard.leave(ctx || {}); // 自带弹窗的守卫（正文编辑器三选一）
      } else {
        var ok = false;
        try { ok = await guard.save(); } catch (e) { ok = false; }
        allowed = ok === true && !guard.isDirty();
        if (!allowed) notifyBlocked(guard);
      }
      if (!allowed) return false;
    }
    return true;
  };

  // ---------- 异步结果 token ----------
  WS.beginRequest = function (scope, target) {
    var key = String(scope == null ? '' : scope);
    var seq = (epochs[key] || 0) + 1;
    epochs[key] = seq;
    return { scope: key, target: target == null ? '' : String(target), id: seq };
  };
  WS.isCurrent = function (token, target) {
    if (!token) return false;
    if (epochs[token.scope] !== token.id) return false;
    if (target !== undefined && String(target == null ? '' : target) !== token.target) return false;
    return true;
  };

  // ---------- 服务端真相校验（不把过期内存当服务器真相）----------
  var ENTITY_CHECKS = {
    characters: {
      url: function (snap) { return '/api/books/' + encodeURIComponent(snap.bookId) + '/characters?limit=200'; },
      pick: function (data) { return (data && (data.items || data.characters)) || []; },
    },
    world: {
      url: function (snap) { return '/api/books/' + encodeURIComponent(snap.bookId) + '/world'; },
      pick: function (data) { return (data && data.entries) || []; },
    },
    outline: {
      url: function (snap) { return '/api/books/' + encodeURIComponent(snap.bookId) + '/volumes'; },
      pick: function (data) { return (data && data.volumes) || []; },
    },
  };

  WS.verify = async function (snap) {
    var api = app().api;
    if (typeof api !== 'function') return { ok: true };
    if (snap.workspace === 'workbench' || snap.workspace === 'writing') {
      try { await api('GET', '/api/books/' + encodeURIComponent(snap.bookId)); }
      catch (e) { return { ok: false, reason: 'BOOK_MISSING' }; }
    }
    if (snap.workspace === 'writing' && snap.chapterId) {
      var chapter = null;
      try { chapter = await api('GET', '/api/books/' + encodeURIComponent(snap.bookId) + '/chapters/' + encodeURIComponent(snap.chapterId)); }
      catch (e) { return { ok: false, reason: 'CHAPTER_MISSING' }; }
      if (!chapter || !chapter.chapter) return { ok: false, reason: 'CHAPTER_MISSING' };
    }
    if (snap.workspace === 'workbench' && snap.entityId) {
      var spec = ENTITY_CHECKS[snap.entityType];
      if (spec) {
        var data;
        try { data = await api('GET', spec.url(snap)); }
        catch (e) { return { ok: false, reason: 'ENTITY_MISSING' }; }
        var hit = (spec.pick(data) || []).some(function (item) { return String(item.id) === String(snap.entityId); });
        if (!hit) return { ok: false, reason: 'ENTITY_MISSING' };
      }
    }
    return { ok: true };
  };

  function notifyMissing(reason) {
    var toast = app().toast;
    if (typeof toast !== 'function') return;
    if (reason === 'BOOK_MISSING') toast('要返回的作品已不存在；未自动切换到其他书籍');
    else if (reason === 'CHAPTER_MISSING') toast('要返回的章节已被删除；未自动跳到其他章节，当前对象保持不变');
    else if (reason === 'ENTITY_MISSING') toast('要返回的对象已被删除或不在本书中；未自动切换到其他对象');
    else toast('要返回的位置已失效；未自动切换对象');
  }

  // ---------- 导航提交 ----------
  function setHash(hash) {
    if (currentHash() === hash) return false;
    if (window.location) window.location.hash = hash;
    return true;
  }
  WS.setHash = setHash;

  WS.navigate = async function (target) {
    var from = WS.capture();
    var to = normalizeTarget(target, from);
    if (!to) return false;
    var allowed = await WS.beforeNavigate({ from: WS.href(from), to: WS.href(to) });
    if (!allowed) return false; // 保存失败：hash 保持原样，导航没有发生
    if (to.workspace === 'workbench') WS.rememberReturn(from, to.bookId);
    setHash(WS.href(to));
    return true;
  };

  // 回到来源：先按服务端校验目标，再导航，最后把章/会话装回写作页
  WS.restore = async function (snapshot) {
    var snap = normalizeTarget(snapshot, null);
    if (!snap) return false;
    var check = await WS.verify(snap);
    if (!check.ok) { notifyMissing(check.reason); return false; }
    var from = WS.capture();
    var allowed = await WS.beforeNavigate({ from: WS.href(from), to: WS.href(snap) });
    if (!allowed) return false;
    WS.forgetReturn(snap.bookId); // 返回锚一次性消费
    setHash(WS.href(snap));
    return await WS.apply(snap);
  };

  WS.apply = async function (snap) {
    if (snap.workspace !== 'writing') return true;
    if (snap.conversationId) writeStore(localStore(), 'writing_conversation_' + String(snap.bookId), snap.conversationId);
    else removeStore(localStore(), 'writing_conversation_' + String(snap.bookId));
    var page = window.BookPage;
    if (!page) return true;
    if (snap.chapterId && typeof page.selectChapter === 'function') {
      // 等写作页真正接上目标书（route → BookPage.show 先重置当前章，再装载），否则会被 show 的重置吃掉
      await waitFor(function () {
        var pageEl = document.getElementById('page-book');
        var visible = pageEl && pageEl.classList && !pageEl.classList.contains('hidden');
        var s = appState();
        return visible && s.currentBook && String(s.currentBook.id) === String(snap.bookId);
      }, 4000);
      await page.selectChapter(snap.chapterId);
    }
    var select = document.getElementById('writing-conversation-select');
    var want = snap.conversationId || '';
    if (select && String(select.value || '') !== String(want) && typeof page.loadChat === 'function') {
      await page.loadChat();
    }
    if (typeof page.renderWritingStatus === 'function') page.renderWritingStatus();
    return true;
  };
})();
