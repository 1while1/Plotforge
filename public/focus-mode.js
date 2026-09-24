// AI 专注写作模式（agent 对话核心区）：隐藏左右侧栏，聊天居中铺满；
// 顶部悬浮卷/章面包屑快切；右上「预览草稿」滑出右侧抽屉（Esc/点外即走）；
// 抽屉内划选文字浮出「↵ 引用」，点击注入聊天输入框并自动收起。
// 全部 UI 运行时注入，模块未加载则页面零痕迹；不碰聊天流与保存逻辑。
(function () {
  'use strict';

  var active = false;
  var drawerOpen = false;
  var vols = [];
  var chapters = [];
  var quoteText = '';
  var els = {};

  function $(id) { return document.getElementById(id); }
  function bookId() { return window.App && App.state.currentBook ? App.state.currentBook.id : null; }
  function onBookHome() { return /^#\/book\/\d+$/.test(location.hash); }

  // ---------- 数据 ----------
  function refreshData() {
    var bid = bookId();
    if (!bid) return Promise.resolve();
    return Promise.all([
      App.api('GET', '/api/books/' + bid + '/volumes'),
      App.api('GET', '/api/books/' + bid + '/chapters'),
    ]).then(function (r) {
      vols = r[0].volumes || [];
      chapters = r[1].chapters || [];
      buildOptions();
      syncLabels();
    }).catch(function () { /* 列表刷新失败不打断主流程 */ });
  }

  function chaptersOf(volId) {
    return chapters.filter(function (c) { return String(c.volume_id || '') === String(volId); });
  }

  function buildOptions() {
    var volSel = els.volSel, chSel = els.chSel;
    volSel.innerHTML = '';
    vols.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.title;
      volSel.appendChild(o);
    });
    rebuildChapterOptions();
  }

  function rebuildChapterOptions() {
    var chSel = els.chSel;
    var volId = els.volSel.value;
    var list = chaptersOf(volId);
    chSel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = list.length ? '选择章节' : '（本卷暂无章节）';
    chSel.appendChild(ph);
    list.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.title;
      chSel.appendChild(o);
    });
  }

  function syncLabels() {
    if (!els.volSel) return;
    var cid = App.state.currentChapterId;
    var cur = chapters.filter(function (c) { return c.id === cid; })[0];
    var volId = cur && cur.volume_id ? cur.volume_id : App.state.currentVolumeId;
    if (volId != null) els.volSel.value = String(volId);
    rebuildChapterOptions();
    els.chSel.value = cid ? String(cid) : '';
  }

  // ---------- 模式开关 ----------
  function toggle(force) {
    active = typeof force === 'boolean' ? force : !active;
    document.body.classList.toggle('focus-mode', active);
    els.btn.classList.toggle('mode-on', active);
    if (active) refreshData();
    if (!active) closeDrawer();
  }

  // ---------- 草稿抽屉 ----------
  function openDrawer() {
    renderDraft();
    drawerOpen = true;
    els.drawer.classList.add('open');
    els.backdrop.classList.add('open');
  }
  function closeDrawer() {
    drawerOpen = false;
    hideQuote();
    if (els.drawer) els.drawer.classList.remove('open');
    if (els.backdrop) els.backdrop.classList.remove('open');
  }
  function renderDraft() {
    var title = ($('chapter-title-input') && $('chapter-title-input').value || '').trim();
    var text = $('chapter-content') ? $('chapter-content').value : '';
    els.drawerCh.textContent = title || '未选择章节';
    if (!text.trim()) {
      els.drawerBody.innerHTML = '<p class="focus-draft-empty">当前章节还没有内容</p>';
      return;
    }
    // 纯净文本展示：按空行分段，段内换行保留
    var html = App.escapeHtml(text).split(/\n\s*\n/)
      .map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; })
      .join('');
    els.drawerBody.innerHTML = html;
  }

  // ---------- 划选引用 ----------
  function hideQuote() { if (els.quoteBtn) els.quoteBtn.classList.remove('show'); }

  function onDrawerMouseup() {
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { hideQuote(); return; }
      var text = String(sel.toString() || '').trim();
      if (!text) { hideQuote(); return; }
      var range = sel.getRangeAt(0);
      if (!els.drawerBody.contains(range.commonAncestorContainer)) { hideQuote(); return; }
      quoteText = sel.toString();
      var rect = range.getBoundingClientRect();
      var top = rect.top - 34;
      if (top < 70) top = rect.bottom + 6;
      els.quoteBtn.style.left = Math.max(12, rect.left) + 'px';
      els.quoteBtn.style.top = top + 'px';
      els.quoteBtn.classList.add('show');
    }, 0);
  }

  function insertQuote() {
    var ta = $('chat-text');
    if (!ta || !quoteText) return;
    var quoted = quoteText.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    ta.value = ta.value.slice(0, start) + quoted + ta.value.slice(end);
    var caret = start + quoted.length;
    closeDrawer();
    ta.focus();
    try { ta.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------- DOM 注入 ----------
  function inject() {
    // 顶栏入口（放在「收起侧栏」之后）
    var btn = document.createElement('button');
    btn.id = 'btn-focus-mode';
    btn.className = 'btn btn-ghost';
    btn.type = 'button';
    btn.textContent = '专注模式';
    btn.title = 'AI 专注写作模式：隐藏左右栏，对话居中；Esc 退出';
    var anchor = $('btn-toggle-left-panel');
    anchor.after(btn);
    els.btn = btn;

    // 面包屑胶囊：放进专注头部条（文档流内居中，杜绝与 chat-head 控件悬浮重叠）
    var crumbs = document.createElement('div');
    crumbs.className = 'focus-crumbs';
    crumbs.innerHTML =
      '<span class="crumb"><select aria-label="切换分卷"></select></span>' +
      '<span class="crumb-sep">/</span>' +
      '<span class="crumb"><select aria-label="切换章节"></select></span>';
    var head = document.createElement('div');
    head.className = 'focus-head';
    head.appendChild(crumbs);
    var chatPanel = $('book-workbench').querySelector('.panel-chat');
    chatPanel.insertBefore(head, chatPanel.firstChild);
    els.crumbs = crumbs;
    els.volSel = crumbs.querySelectorAll('select')[0];
    els.chSel = crumbs.querySelectorAll('select')[1];

    // 预览草稿按钮
    var pv = document.createElement('button');
    pv.className = 'focus-preview-btn';
    pv.type = 'button';
    pv.innerHTML = '📖 预览草稿';
    pv.title = '滑出当前章草稿（Esc 或点击外侧关闭）';
    document.body.appendChild(pv);
    els.previewBtn = pv;

    // 抽屉 + 背板
    var backdrop = document.createElement('div');
    backdrop.className = 'focus-draft-backdrop';
    document.body.appendChild(backdrop);
    els.backdrop = backdrop;

    var drawer = document.createElement('aside');
    drawer.className = 'focus-draft';
    drawer.innerHTML =
      '<div class="focus-draft-head"><span class="focus-draft-title">草稿预览</span>' +
      '<span class="focus-draft-ch"></span></div>' +
      '<div class="focus-draft-body"></div>';
    document.body.appendChild(drawer);
    els.drawer = drawer;
    els.drawerCh = drawer.querySelector('.focus-draft-ch');
    els.drawerBody = drawer.querySelector('.focus-draft-body');

    // 划选引用按钮
    var qb = document.createElement('button');
    qb.className = 'quote-insert-btn';
    qb.type = 'button';
    qb.textContent = '↵ 引用';
    document.body.appendChild(qb);
    els.quoteBtn = qb;
  }

  // ---------- 事件 ----------
  function bind() {
    els.btn.addEventListener('click', function () { toggle(); });

    els.volSel.addEventListener('change', function () {
      var list = chaptersOf(els.volSel.value);
      rebuildChapterOptions();
      if (!list.length) { App.toast('该卷还没有章节'); syncLabels(); return; }
      window.BookPage.selectChapter(list[0].id);
    });
    els.chSel.addEventListener('change', function () {
      if (!els.chSel.value) return;
      window.BookPage.selectChapter(Number(els.chSel.value));
    });

    els.previewBtn.addEventListener('click', function () {
      if (drawerOpen) closeDrawer(); else openDrawer();
    });
    els.backdrop.addEventListener('click', closeDrawer);
    els.drawerBody.addEventListener('mouseup', onDrawerMouseup);
    els.drawerBody.addEventListener('scroll', hideQuote, { passive: true });

    // mousedown 拦截在 document 之前，保住按钮点击；划选文本已在上一步存好
    els.quoteBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    els.quoteBtn.addEventListener('click', insertQuote);
    document.addEventListener('mousedown', function (e) {
      if (els.quoteBtn.classList.contains('show') && !els.quoteBtn.contains(e.target)) hideQuote();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !active) return;
      if (drawerOpen) closeDrawer();
      else toggle(false);
    });

    // 离开书本主页（书架/精修页等）自动退出专注模式
    window.addEventListener('hashchange', function () {
      if (active && !onBookHome()) toggle(false);
    });
  }

  function init() {
    if (!window.App || !$('book-workbench') || !$('btn-toggle-left-panel') || !window.BookPage) return;
    inject();
    bind();
    window.FocusMode = {
      // 供 selectChapter 等外部动作后同步面包屑（一行钩子调用）
      sync: function () { if (active) refreshData(); },
      isActive: function () { return active; },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
