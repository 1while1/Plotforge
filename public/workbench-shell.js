(function () {
  'use strict';

  var WorkbenchShell = window.WorkbenchShell = {};
  var labels = {
    characters: '人物中枢',
    ledger: '故事台账',
    outline: '大纲工作台',
    world: '世界观工作台'
  };

  function parse(hash) {
    var raw = (hash || '').replace(/^#/, '');
    var parts = raw.split('?');
    var segments = parts[0].split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== 'book' || segments[2] !== 'workbench' || !labels[segments[3]]) return null;
    var query = new URLSearchParams(parts[1] || '');
    return {
      bookId: segments[1],
      module: segments[3],
      entityId: segments[4] || null,
      tab: query.get('tab') || null
    };
  }

  function href(route, module) {
    return '#/book/' + encodeURIComponent(route.bookId) + '/workbench/' + module;
  }

  function rememberEditor(route) {
    var key = 'novel-editor-return:' + route.bookId;
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, '#/book/' + encodeURIComponent(route.bookId));
  }

  // S4-03：返回位置来自统一导航状态（WorkspaceState）记录的来源——可能是写作页，也可能是 Agent 台。
  // 记录在离开来源页面时写入（app.js 的 hashchange 调 noteDeparture）；没有记录时退回写作页，
  // 并继续兼容旧会话键（novel-editor-return:*），旧链接照旧能打开。
  function returnTarget(route) {
    return window.WorkspaceState ? window.WorkspaceState.readReturn(route.bookId) : null;
  }

  function bindReturn(route) {
    var link = document.getElementById('workbench-return');
    if (!link) return;
    var target = returnTarget(route);
    if (target && window.WorkspaceState) {
      link.href = window.WorkspaceState.href(target);
      link.textContent = target.workspace === 'agent' ? '← 返回 Agent 台' : '← 返回写作页';
      link.onclick = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        return window.WorkspaceState.restore(target); // 校验目标后还原同一章/同一会话
      };
      return;
    }
    link.href = sessionStorage.getItem('novel-editor-return:' + route.bookId)
      || href(route, '').replace('/workbench/', '');
    link.textContent = '← 返回写作页';
    link.onclick = null;
  }

  function renderPlaceholder(route) {
    var notes = {
      characters: '集中管理人物档案、别名、关系、时间线与人物专属顾问。',
      ledger: '审阅事实提案、追踪状态变化、伏笔与故事线。',
      outline: '从全书到卷章组织结构，并检查写作偏离。',
      world: '用分类与条目维护世界规则、地点、势力和设定。'
    };
    document.getElementById('workbench-content').innerHTML =
      '<section class="workbench-empty"><span class="workbench-kicker">专项编辑空间</span>' +
      '<h2>' + labels[route.module] + '</h2><p>' + notes[route.module] + '</p>' +
      '<div class="workbench-empty-card">模块正在载入；此页面不会挤占章节写作区。</div></section>';
  }

  function handoff(route) {
    var modules = {
      characters: window.CharacterWorkbench,
      ledger: window.LedgerWorkbench,
      outline: window.OutlineWorkbench,
      world: window.WorldWorkbench
    };
    var target = modules[route.module];
    if (target && typeof target.show === 'function') target.show(route);
    else renderPlaceholder(route);
  }

  // S4-05：工作台的当前书「相关任务」提示——状态取服务端运行行（S4-01a 的 task 资源），
  // 不在工作台里臆造完成状态；读不到就明说没有运行记录。
  // 呈现方式：进入时右下角 Toast 短暂浮出（约 5 秒自动消失），随后收纳到顶栏铃铛（红点提示），
  // 点击铃铛可随时再看；顶部空间留给当前编辑对象。同一内容不重复弹 Toast（模块间切换不打扰）。
  var lastToastKey = null;
  var toastTimer = null;

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '时间未记录';
    function pad(n) { return String(n).padStart(2, '0'); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fillNotify(model) {
    var titleEl = document.getElementById('workbench-notify-title');
    var bodyEl = document.getElementById('workbench-notify-body');
    if (titleEl) titleEl.textContent = model.title;
    if (bodyEl) bodyEl.textContent = model.body;
  }

  function showWorkbenchToast(model) {
    var toast = document.getElementById('workbench-toast');
    var dot = document.getElementById('workbench-notify-dot');
    if (!toast) return;
    fillNotify(model);
    var titleEl = toast.querySelector('.wb-toast-title');
    var bodyEl = toast.querySelector('.wb-toast-body');
    if (titleEl) titleEl.textContent = model.title;
    if (bodyEl) bodyEl.textContent = model.body;
    toast.classList.remove('hidden', 'closing');
    if (dot) dot.classList.add('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.add('closing');
      setTimeout(function () {
        toast.classList.add('hidden');
        toast.classList.remove('closing');
        if (dot) dot.classList.remove('hidden'); // 收进铃铛：红点提示有条通知
      }, 220);
    }, 5000);
  }

  function bindNotify() {
    var bell = document.getElementById('workbench-notify');
    var pop = document.getElementById('workbench-notify-pop');
    var dot = document.getElementById('workbench-notify-dot');
    if (!bell || !pop || bell.dataset.bound) return;
    bell.dataset.bound = '1';
    bell.onclick = function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      pop.classList.toggle('hidden');
      if (dot) dot.classList.add('hidden'); // 看过即清红点
    };
    document.addEventListener('click', function (ev) {
      if (pop.classList.contains('hidden')) return;
      if (pop.contains(ev.target) || bell.contains(ev.target)) return;
      pop.classList.add('hidden');
    });
  }

  async function renderTaskEntry(route, book) {
    var bell = document.getElementById('workbench-notify');
    if (!bell) return null;
    var latest = null;
    try {
      var data = await window.App.api('GET', '/api/resources?type=task&bookId=' + encodeURIComponent(route.bookId) + '&limit=1');
      latest = (data && data.items || [])[0] || null;
    } catch (e) { latest = null; }
    var bookTitle = (book && book.title) || ('#' + route.bookId);
    var model;
    if (latest) {
      var badge = window.RunStatus && window.RunStatus.taskBadge
        ? window.RunStatus.taskBadge({ status: latest.status, reason: latest.meta && latest.meta.reason })
        : latest.status;
      model = {
        title: badge + ' · ' + (latest.title || latest.id),
        body: '《' + bookTitle + '》最近一次任务，更新于 ' + fmtTime(latest.updatedAt) + '。完整任务卡在写作页对话区上方。',
      };
    } else {
      model = {
        title: '没有运行记录',
        body: '《' + bookTitle + '》还没有运行记录：这里不会臆造完成状态。',
      };
    }
    bell.classList.remove('hidden');
    bindNotify();
    fillNotify(model);
    // 下一步入口：有运行记录时给出可点链接（任务自带 route 优先，否则回写作页——任务卡在对话区上方）
    var link = document.getElementById('workbench-notify-link');
    if (link) {
      var href = latest ? (latest.route || ('#/book/' + route.bookId)) : '';
      link.href = href || '#';
      link.classList.toggle('hidden', !href);
    }
    var key = route.bookId + '|' + (latest ? latest.id + '|' + latest.updatedAt + '|' + latest.status : 'none');
    if (key !== lastToastKey) {
      lastToastKey = key;
      showWorkbenchToast(model);
    }
    return model;
  }

  WorkbenchShell.show = async function (hash) {
    var route = parse(hash);
    if (!route) {
      location.hash = '#/';
      return;
    }
    rememberEditor(route);
    bindReturn(route);
    document.getElementById('workbench-title').textContent = labels[route.module];
    document.getElementById('workbench-content').innerHTML = '<div class="workbench-loading">正在打开工作台…</div>';

    var nav = document.getElementById('workbench-nav');
    nav.innerHTML = Object.keys(labels).map(function (module) {
      return '<a class="workbench-nav-link' + (module === route.module ? ' active' : '') + '" href="' + href(route, module) + '">' + labels[module] + '</a>';
    }).join('');

    try {
      var data = await window.App.api('GET', '/api/books/' + encodeURIComponent(route.bookId));
      window.App.state.currentBook = data.book;
      document.getElementById('workbench-book-title').textContent = data.book.title;
      handoff(route);
      await renderTaskEntry(route, data.book);
    } catch (error) {
      document.getElementById('workbench-content').innerHTML = '<div class="workbench-error">' + window.App.escapeHtml(error.message) + '</div>';
    }
  };

  WorkbenchShell.parse = parse;
})();
