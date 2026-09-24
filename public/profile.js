// 个人中心（#/profile）：作家卡 / 错题库 / 本书提示词的全局总览与按书下钻。
// 定位是「汇总 + 跳转」：统计与状态在这里一眼看全，具体管理仍进各书既有页面
// （#/book/:id/cards、#/book/:id/stylelab、本书提示词弹窗），不在这里重做编辑器。
// 数据全部走既有接口：/api/books、/api/style-lab/packs、/api/style-lab/stats、
// /api/books/:id/delete-preview（目前唯一带字数的接口，逐书聚合）。
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return window.App.escapeHtml(String(s == null ? '' : s)); }

  function fmtWan(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万' : String(n);
  }

  var lastData = null;   // 最近一次 loadAll 的结果（弹窗保存后局部重绘用）
  var lastBooks = {};    // id → book（提示词弹窗取当前值）

  // ---------- 拉数 ----------
  async function loadAll() {
    var A = window.App;
    var booksRes = await A.api('GET', '/api/books');
    var books = booksRes.books || [];
    var globals = await Promise.all([
      A.api('GET', '/api/style-lab/packs').catch(function () { return { packs: [] }; }),
      A.api('GET', '/api/style-lab/stats').catch(function () { return { stats: null }; }),
    ]);
    // 逐书聚合：字数（delete-preview 里的 words）+ 生效卡链（packs?book_id= 里的 effective）。
    // 书多时是 N×2 个请求，书架量级下可接受；若日后加 server 聚合接口，只换这一段。
    var perBook = await Promise.all(books.map(function (b) {
      return Promise.all([
        A.api('GET', '/api/books/' + encodeURIComponent(b.id) + '/delete-preview').catch(function () { return null; }),
        A.api('GET', '/api/style-lab/packs?book_id=' + encodeURIComponent(b.id)).catch(function () { return null; }),
      ]);
    }));
    return { books: books, packs: globals[0].packs || [], stats: globals[1].stats || null, perBook: perBook };
  }

  // ---------- 渲染 ----------
  function statHtml(n, label) {
    return '<div class="profile-stat"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>';
  }

  function emptyRow(text) {
    return '<div class="profile-empty">' + esc(text) + '</div>';
  }

  function bookRow(go, name, metaHtml) {
    return '<button class="profile-book-row" type="button" data-go="' + esc(go) + '">' +
      '<span class="pbr-name">' + esc(name) + '</span>' + metaHtml + '</button>';
  }

  function render(d) {
    // 创作者印记条
    var totalWords = 0;
    d.perBook.forEach(function (pb) { if (pb[0] && pb[0].words) totalWords += Number(pb[0].words) || 0; });
    var errTotal = d.stats ? (Number(d.stats.total) || 0) : 0;
    $('profile-stats').innerHTML =
      statHtml(d.books.length, '作品') +
      statHtml(d.packs.length, '作家卡') +
      statHtml(errTotal, '错题') +
      statHtml(fmtWan(totalWords), '累计字数');

    var packName = {};
    d.packs.forEach(function (p) { packName[p.id] = p.name; });

    // 作家卡：每本书的生效卡链（bound/own=本书指定，basic=兜底，none=未指定）
    $('profile-sum-cards').textContent = '卡库 ' + d.packs.length + ' 张';
    $('profile-rows-cards').innerHTML = d.books.length ? d.books.map(function (b, i) {
      var eff = d.perBook[i][1] && d.perBook[i][1].effective;
      var meta = '<span class="pbr-meta">未指定用卡</span>';
      if (eff && eff.chain_ids && eff.chain_ids.length) {
        var main = eff.main_id ? (packName[eff.main_id] || '主卡') : null;
        var auxN = eff.aux_ids ? eff.aux_ids.length : 0;
        var label = main ? esc(main) : ('仅 ' + auxN + ' 张辅卡');
        var prefix = eff.source === 'basic' ? '兜底：' : '';
        meta = '<span class="pbr-meta">' + prefix + label + (main && auxN ? ' ＋' + auxN + ' 辅' : '') + '</span>';
      }
      return bookRow('#/book/' + encodeURIComponent(b.id) + '/cards', b.title, meta);
    }).join('') : emptyRow('还没有作品，先去书架新建一部');

    // 错题库：全局统计自带 byBook 分布
    var errByBook = {};
    if (d.stats && d.stats.byBook) {
      d.stats.byBook.forEach(function (r) { errByBook[r.bookId] = r.count; });
    }
    $('profile-sum-stylelab').textContent = '共 ' + errTotal + ' 条';
    $('profile-rows-stylelab').innerHTML = d.books.length ? d.books.map(function (b) {
      var n = errByBook[b.id] || 0;
      return bookRow('#/book/' + encodeURIComponent(b.id) + '/stylelab', b.title,
        '<span class="pbr-chip ' + (n ? 'on' : 'off') + '">' + n + ' 条</span>');
    }).join('') : emptyRow('还没有作品，先去书架新建一部');

    renderPromptRows(d);
  }

  function renderPromptRows(d) {
    var overridden = d.books.filter(function (b) { return b.system_prompt && b.system_prompt.trim(); }).length;
    $('profile-sum-prompts').textContent = overridden ? overridden + ' 本已覆盖' : '全部跟随全局';
    $('profile-rows-prompts').innerHTML = d.books.length ? d.books.map(function (b) {
      var has = !!(b.system_prompt && b.system_prompt.trim());
      return '<button class="profile-book-row" type="button" data-prompt-book="' + esc(b.id) + '">' +
        '<span class="pbr-name">' + esc(b.title) + '</span>' +
        '<span class="pbr-chip ' + (has ? 'on' : 'off') + '">' + (has ? '已覆盖' : '跟随全局') + '</span></button>';
    }).join('') : emptyRow('还没有作品，先去书架新建一部');
  }

  // ---------- 本书提示词弹窗（与原工作台弹窗同一数据源：PUT /api/books/:id 的 system_prompt） ----------
  function openPromptModal(bookId) {
    var A = window.App;
    var book = lastBooks[bookId];
    if (!A || !book) return;
    A.openModal({
      title: '本书系统提示词 · ' + book.title,
      bodyHTML: '<p class="field-hint">留空则使用全局系统提示词（全局模板在设置页维护）。</p>' +
        '<textarea id="bp-prompt" rows="10">' + esc(book.system_prompt || '') + '</textarea>',
      onOk: async function () {
        try {
          var val = document.getElementById('bp-prompt').value.trim();
          await A.api('PUT', '/api/books/' + encodeURIComponent(book.id), { system_prompt: val });
          book.system_prompt = val;
          if (lastData) renderPromptRows(lastData);
          A.toast('已保存');
        } catch (e) {
          A.toast(e.message);
          return false;
        }
      }
    });
  }

  // ---------- 事件（一次性委托在页根，行是每次渲染重画的） ----------
  var bound = false;
  function bindOnce() {
    if (bound) return;
    var root = $('page-profile');
    if (!root) return;
    bound = true;
    root.addEventListener('click', function (e) {
      var go = e.target.closest('[data-go]');
      if (go) { location.hash = go.getAttribute('data-go'); return; }
      var pr = e.target.closest('[data-prompt-book]');
      if (pr) openPromptModal(pr.getAttribute('data-prompt-book'));
    });
  }

  function setLoading() {
    $('profile-stats').innerHTML = statHtml('…', '作品') + statHtml('…', '作家卡') + statHtml('…', '错题') + statHtml('…', '累计字数');
    ['cards', 'stylelab', 'prompts'].forEach(function (k) {
      $('profile-sum-' + k).textContent = '…';
      $('profile-rows-' + k).innerHTML = emptyRow('载入中…');
    });
  }

  async function show() {
    bindOnce();
    setLoading();
    try {
      var d = await loadAll();
      lastData = d;
      lastBooks = {};
      d.books.forEach(function (b) { lastBooks[b.id] = b; });
      render(d);
    } catch (e) {
      var msg = '载入失败：' + (e && e.message ? e.message : e);
      $('profile-stats').innerHTML = '';
      ['cards', 'stylelab', 'prompts'].forEach(function (k) {
        $('profile-sum-' + k).textContent = '';
        $('profile-rows-' + k).innerHTML = emptyRow(msg);
      });
    }
  }

  window.ProfilePage = { show: show };
})();
