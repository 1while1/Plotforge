// 错题库页（#/book/:id/stylelab）—— 作家仓库第三层的语料管理界面。
//
// 解耦：本页是独立整页 + 独立模块，只调 /api/style-lab/*。
// 不改写作页/阅读页的任何逻辑；删掉本文件与 app.js 里的一行路由，系统行为不变（只少一个页面）。
(function () {
  'use strict';

  var App = window.App;
  var StyleLab = window.StyleLab = window.StyleLab || {};

  var S = { bookId: null, filter: { verdict: '', chapterId: '', order: 'conf' } };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return App.escapeHtml(v); }

  function confCls(conf) {
    if (typeof conf !== 'number') return 'unknown';
    if (conf >= 0.7) return 'high';
    if (conf >= 0.5) return 'mid';
    return 'low';
  }

  // 统计栏：语料够不够用一眼可见（特征提取需要「已复核」的语料，不是原始标本数）
  function renderStats(stats) {
    var box = $('stylelab-stats');
    if (!box || !stats) return;
    var v = stats.byVerdict || {};
    var c = stats.byConfidence || {};
    box.innerHTML =
      '共 <b>' + (stats.total || 0) + '</b> 条标本 · ' +
      '待复核 <b>' + (v.pending || 0) + '</b> · ' +
      '确认 AI <b>' + (v.ai || 0) + '</b> · ' +
      '确认为人写 <b>' + (v.human || 0) + '</b> · ' +
      '已废弃 <b>' + (v.rejected || 0) + '</b>' +
      '<span class="stylelab-tip" title="特征提取只用已复核且未废弃的语料">｜' +
      '高置信(≥0.7) <b>' + ((c.veryHigh || 0) + (c.high || 0)) + '</b> · ' +
      '中 <b>' + (c.mid || 0) + '</b> · 低 <b>' + (c.low || 0) + '</b></span>';
  }

  function renderList(data) {
    var box = $('stylelab-list');
    if (!box) return;
    var list = data.samples || [];
    if (!list.length) {
      box.innerHTML = '<p class="empty-hint">还没有标本。去阅读页点「AI 味体检」检测章节，判为 AI 的语句会自动进这里。</p>';
      return;
    }
    box.innerHTML = list.map(function (s) {
      var verdictText = { pending: '待复核', ai: '确认 AI', human: '确认为人写', rejected: '已废弃' }[s.verdict] || s.verdict;
      return '<div class="sample-item" data-id="' + s.id + '">' +
        '<div class="sample-head">' +
        '<span class="health-seg-conf ' + confCls(s.detectorConf) + '">' +
        (typeof s.detectorConf === 'number' ? s.detectorConf.toFixed(3) : '—') + '</span>' +
        '<span class="sample-verdict verdict-' + s.verdict + '">' + verdictText + '</span>' +
        (s.seenCount > 1 ? '<span class="sample-seen" title="同一句被反复检出，重复次数本身就是最强的特征证据">×' + s.seenCount + '</span>' : '') +
        '<span class="sample-src">' + esc(s.chapterTitle || (s.bookId ? '书 #' + s.bookId : '')) + '</span>' +
        '</div>' +
        '<div class="sample-text">' + esc(s.text) + '</div>' +
        (s.reviewNote ? '<div class="sample-note">复核备注：' + esc(s.reviewNote) + '</div>' : '') +
        '<div class="sample-ops">' +
        '<button class="btn btn-small btn-outline" data-review="ai">确认是 AI</button>' +
        '<button class="btn btn-small btn-ghost" data-review="human">这句是人写的</button>' +
        '<button class="btn btn-small btn-ghost" data-review="rejected">废弃</button>' +
        '<button class="btn btn-small btn-ghost" data-del="1">删除</button>' +
        '</div></div>';
    }).join('');
    box.onclick = onListClick;
    var info = $('stylelab-count');
    if (info) info.textContent = '显示 ' + list.length + ' / ' + (data.total || 0) + ' 条';
  }

  async function onListClick(ev) {
    var item = ev.target.closest('.sample-item');
    if (!item) return;
    var id = item.dataset.id;
    var reviewBtn = ev.target.closest('[data-review]');
    var delBtn = ev.target.closest('[data-del]');
    try {
      if (reviewBtn) {
        var res = await App.api('PATCH', '/api/style-lab/samples/' + id, { verdict: reviewBtn.dataset.review });
        var map = { pending: '待复核', ai: '确认 AI', human: '确认为人写', rejected: '已废弃' };
        var label = item.querySelector('.sample-verdict');
        label.className = 'sample-verdict verdict-' + res.sample.verdict;
        label.textContent = map[res.sample.verdict] || res.sample.verdict;
        App.toast('已记录复核结论');
        load(); // 刷新统计
      } else if (delBtn) {
        if (!confirm('删除这条标本？删除后无法找回。')) return;
        await App.api('DELETE', '/api/style-lab/samples/' + id);
        item.remove();
        App.toast('已删除');
        load();
      }
    } catch (e) {
      App.toast(e.message);
    }
  }

  async function loadChapterOptions() {
    var sel = $('stylelab-chapter');
    if (!sel || !S.bookId) return;
    try {
      var res = await App.api('GET', '/api/books/' + S.bookId + '/chapters');
      var chapters = res.chapters || [];
      sel.innerHTML = '<option value="">全部章节</option>' + chapters.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.title) + '</option>';
      }).join('');
      sel.value = S.filter.chapterId || '';
    } catch (e) { /* 过滤是增强项，取不到就不显示章节下拉 */ }
  }

  async function load() {
    if (!S.bookId) return;
    try {
      var params = ['book_id=' + encodeURIComponent(S.bookId), 'limit=100'];
      if (S.filter.verdict) params.push('verdict=' + encodeURIComponent(S.filter.verdict));
      if (S.filter.chapterId) params.push('chapter_id=' + encodeURIComponent(S.filter.chapterId));
      if (S.filter.order) params.push('order=' + encodeURIComponent(S.filter.order));
      var data = await App.api('GET', '/api/style-lab/samples?' + params.join('&'));
      renderList(data);
    } catch (e) {
      App.toast(e.message);
    }
    try {
      var st = await App.api('GET', '/api/style-lab/stats?book_id=' + encodeURIComponent(S.bookId));
      renderStats(st.stats);
    } catch (e) { /* ignore */ }
  }

  function bind() {
    var vSel = $('stylelab-verdict');
    if (vSel && !vSel.dataset.bound) {
      vSel.dataset.bound = '1';
      vSel.onchange = function () { S.filter.verdict = this.value; load(); };
    }
    var cSel = $('stylelab-chapter');
    if (cSel && !cSel.dataset.bound) {
      cSel.dataset.bound = '1';
      cSel.onchange = function () { S.filter.chapterId = this.value; load(); };
    }
    var oSel = $('stylelab-order');
    if (oSel && !oSel.dataset.bound) {
      oSel.dataset.bound = '1';
      oSel.onchange = function () { S.filter.order = this.value; load(); };
    }
    var exBtn = $('stylelab-export');
    if (exBtn && !exBtn.dataset.bound) {
      exBtn.dataset.bound = '1';
      // 导出走浏览器下载：默认只导「已复核且非废弃」的语料（未复核不进分析，防污染）。
      // 用 location.href 直接触发下载而不是 fetch——文件可能很大，也不需要前端再解析一遍。
      exBtn.onclick = function () {
        var url = '/api/style-lab/samples-export?book_id=' + encodeURIComponent(S.bookId);
        if (S.filter.verdict) url += '&verdict=' + encodeURIComponent(S.filter.verdict);
        if (confirm('导出已复核语料（确认 AI + 确认为人写）？\n\n点「取消」则导出含待复核的全部语料。')) {
          location.href = url;
        } else {
          location.href = url + '&include_pending=true';
        }
      };
    }
  }

  StyleLab.show = async function (bookId) {
    S.bookId = bookId;
    // 返回枢纽是个人中心（#/profile）：错题库页的唯一入口已迁到那里
    var back = $('stylelab-return');
    if (back) back.href = '#/profile';
    var title = $('stylelab-book-title');
    if (title && !title.textContent.trim()) title.textContent = '错题库';
    bind();
    await loadChapterOptions();
    load();
    // 改写工作台（独立模块，纯旁路：删掉这一行只是少一个面板）
    if (window.RewriteCurvePanel) window.RewriteCurvePanel.show(bookId);
  };
})();
