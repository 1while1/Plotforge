// 工作台入口编排：BookPage.show 由路由调用，具体功能在 book-chapters.js / book-chat.js
(function () {
  'use strict';
  var BookPage = window.BookPage = window.BookPage || {};

  // ---------- S4-02：写作工作台外壳 ----------
  // 三件事：① 当前书 / 当前章 / 当前写作会话 / 保存状态常显（#writing-status-bar，
  // 位置在可折叠侧栏之外，折叠布局后仍在）；② 资源侧栏可折叠且按书记住——折叠只切布局类，
  // 绝不重新初始化编辑器、不清空正在流的这一轮；③ 「另开整体讨论」的返回锚
  // （sessionStorage，关标签页即失效）：从 Agent 台回来还原同一写作会话与同一章。
  var WB = window.App;
  var LAYOUT_PREFIX = 'writing_layout_v1:';
  var RETURN_KEY = 'novel-writing-return';

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { var n = $(id); if (n) n.textContent = text; }

  function readLayoutCollapsed(bookId) {
    try { return localStorage.getItem(LAYOUT_PREFIX + String(bookId)) === 'collapsed'; } catch (e) { return false; }
  }
  function saveLayoutCollapsed(bookId, collapsed) {
    try { localStorage.setItem(LAYOUT_PREFIX + String(bookId), collapsed ? 'collapsed' : 'full'); } catch (e) { /* 忽略 */ }
  }

  // 折叠/展开资源侧栏：只切 #book-workbench 的布局类与按钮文案
  BookPage.applyLeftPanelLayout = function (collapsed) {
    var bench = $('book-workbench');
    if (bench) bench.classList.toggle('left-collapsed', !!collapsed);
    var btn = $('btn-toggle-left-panel');
    if (btn) {
      btn.textContent = collapsed ? '展开侧栏' : '收起侧栏';
      btn.classList.toggle('mode-on', !!collapsed);
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    return !!collapsed;
  };
  BookPage.toggleLeftPanel = function () {
    var book = WB.state.currentBook;
    var next = !(book && readLayoutCollapsed(book.id));
    if (book) saveLayoutCollapsed(book.id, next);
    return BookPage.applyLeftPanelLayout(next);
  };

  // 当前写作会话名：会话切换器由 book-chat.js 渲染，这里只读（不查服务端）
  function writingConversationLabel() {
    var sel = $('writing-conversation-select');
    if (!sel) return '（默认：历史对话）';
    var id = String(sel.value || '');
    var opts = sel.children || [];
    var selected = null;
    for (var i = 0; i < opts.length; i++) {
      if (id && String(opts[i].value) === id) return opts[i].textContent || id;
      if (!selected && opts[i].selected) selected = opts[i];
    }
    if (selected) return selected.textContent || '（默认：历史对话）';
    return id ? ('写作会话 ' + id.slice(0, 8)) : '（默认：历史对话）';
  }

  function currentChapterLabel() {
    var cid = WB.state.currentChapterId;
    if (!cid) return '未选择章节';
    var input = $('chapter-title-input');
    var title = input ? input.value : '';
    return title ? ('《' + title + '》') : ('章节 #' + cid);
  }

  // 保存状态的事实源是 book-chapters.js 的脏标记（BookPage.hasUnsavedChanges）+ 服务端落盘事实；
  // 这里只做展示。S4-05 起三态（本地未保存 / 已应用未落盘 / 已保存）由 run-status.js 统一推导：
  // 503 PERSISTENCE_PENDING，或 /api/health 报告落盘失败/待重试时，显示「已应用未落盘」；
  // 任务 finished 与「当前新输入已保存」仍是两件事（新输入回到「本地未保存」）。
  BookPage.renderWritingStatus = function () {
    var book = WB.state.currentBook;
    if (!book) return;
    setText('writing-status-book', '《' + (book.title || ('#' + book.id)) + '》');
    setText('writing-status-chapter', currentChapterLabel());
    setText('writing-status-conversation', writingConversationLabel());
    if (window.RunStatus && window.RunStatus.renderWritingSaveBadge) {
      window.RunStatus.renderWritingSaveBadge();
      return;
    }
    var dirty = !!(BookPage.hasUnsavedChanges && BookPage.hasUnsavedChanges());
    setText('writing-status-save', dirty ? '未保存修改' : '已保存');
  };

  // ---------- 返回锚（sessionStorage）----------
  function readReturnTarget() {
    try {
      var raw = sessionStorage.getItem(RETURN_KEY);
      if (!raw) return null;
      var t = JSON.parse(raw);
      return t && t.bookId ? t : null;
    } catch (e) { return null; }
  }
  function updateAgentReturnLink() {
    var link = $('agent-return-writing');
    if (!link) return;
    var t = readReturnTarget();
    link.classList.toggle('hidden', !t);
    if (t) link.href = '#/book/' + t.bookId;
  }
  BookPage.saveWritingReturn = function (target) {
    try { sessionStorage.setItem(RETURN_KEY, JSON.stringify(target || {})); } catch (e) { /* 忽略 */ }
    updateAgentReturnLink();
  };
  BookPage.readWritingReturn = readReturnTarget;
  BookPage.clearWritingReturn = function () {
    try { sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* 忽略 */ }
    updateAgentReturnLink();
  };
  // 回到写作页：只有同一本书才还原（换书不猜章节），一次性消费
  BookPage.restoreWritingReturn = async function (bookId) {
    var t = readReturnTarget();
    if (!t || Number(t.bookId) !== Number(bookId)) return false;
    BookPage.clearWritingReturn();
    if (t.chapterId && BookPage.selectChapter) await BookPage.selectChapter(t.chapterId);
    BookPage.renderWritingStatus();
    return true;
  };

  function bindShellEvents() {
    var btn = $('btn-toggle-left-panel');
    if (btn && !btn.dataset.shellBound) {
      btn.dataset.shellBound = '1';
      btn.onclick = function () { BookPage.toggleLeftPanel(); };
    }
    var link = $('agent-return-writing');
    if (link && !link.dataset.shellBound) {
      link.dataset.shellBound = '1';
      link.onclick = function (ev) {
        var t = readReturnTarget();
        if (!t) return; // 没有来源就不拦默认跳转
        if (ev && ev.preventDefault) ev.preventDefault();
        location.hash = '#/book/' + t.bookId; // 路由 → BookPage.show 消费返回锚
      };
    }
    updateAgentReturnLink();
  }

  // 编辑器输入让状态条即时跟上。顺序敏感：必须在 book-chapters.js 的脏检查监听之后注册
  // （同一事件上先跑的监听读到的还是旧脏态），所以只在 BookPage.show 里绑定，不在加载期绑定。
  // 保存/切章的刷新走下面的公开 API 包装（3 秒防抖自动保存没有事件可听）。
  function bindStatusInputs() {
    ['chapter-content', 'chapter-title-input', 'chapter-beat'].forEach(function (id) {
      var el = $(id);
      if (el && !el.dataset.statusBound) {
        el.dataset.statusBound = '1';
        el.addEventListener('input', function () { BookPage.renderWritingStatus(); });
      }
    });
  }

  // 包装公开 API 只加「刷新状态条」这一个副作用，不改内部实现（book-chapters.js 不在本切片改动面）
  function wrapStatusRefresh(name) {
    var orig = BookPage[name];
    if (typeof orig !== 'function') return;
    BookPage[name] = async function () {
      try { return await orig.apply(this, arguments); }
      finally { BookPage.renderWritingStatus(); }
    };
  }
  wrapStatusRefresh('saveChapter');
  wrapStatusRefresh('selectChapter');
  wrapStatusRefresh('loadChat');
  BookPage.bindShellEvents = bindShellEvents;
  BookPage.bindStatusInputs = bindStatusInputs;
  // 打开页面即可用：会话级返回锚可能在刷新后仍存在（直接落在 Agent 台时也要能返回写作页）；
  // 绑定是幂等的（dataset 守卫），BookPage.show 里再调一次无副作用。
  bindShellEvents();

  // 进入书籍工作台：加载书籍信息并并行初始化各模块
  BookPage.show = async function (bookId) {
    var App = window.App;
    try {
      App.state.currentChapterId = null;
      App.state.currentVolumeId = null;
      document.getElementById('editor-body').classList.add('hidden');
      document.getElementById('editor-empty').classList.remove('hidden');

      var data = await App.api('GET', '/api/books/' + encodeURIComponent(bookId));
      App.state.currentBook = data.book;
      document.getElementById('book-title').textContent = data.book.title;

      BookPage.bindChapterEvents();
      BookPage.bindChatEvents();
      BookPage.bindOutlineEvents();
      BookPage.bindStateEvents();
      if (window.SidebarConfig) window.SidebarConfig.bind();
      BookPage.loadOutline();
      BookPage.loadState();
      await Promise.all([
        BookPage.loadChapters(),
        BookPage.loadWorld(),
        BookPage.loadCharacters(),
        BookPage.loadChat(),
        window.SidebarConfig ? window.SidebarConfig.load() : Promise.resolve(),
      ]);
      BookPage.bindShellEvents();
      BookPage.bindStatusInputs();
      BookPage.applyLeftPanelLayout(readLayoutCollapsed(bookId));
      BookPage.renderWritingStatus();
      await BookPage.restoreWritingReturn(bookId);
    } catch (e) {
      App.toast(e.message);
    }
  };
})();
