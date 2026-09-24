// 改写工作台（#/book/:id/stylelab 页内）—— 把「人改多少 → 检测分降到哪」画出来。
//
// 解耦：只调 /api/style-lab/* 与既有章节列表接口；不碰写作流、不碰阅读页。
// 纯逻辑在 public/rewrite-curve.js 与 public/segment-targets.js（有单测），
// 本文件只做 DOM 与请求编排。
(function () {
  'use strict';

  var App = window.App;
  var RC = window.RewriteCurve;
  var ST = window.SegmentTargets;
  if (!App || !RC || !ST) return;

  var S = {
    bookId: null, chapterId: null, chapterTitle: '',
    items: [], series: [], measuring: false, lastMeasureAt: 0, timer: null,
  };
  var store = RC.createDraftStore();
  var AUTOSAVE_MS = 400;
  var AUTO_MEASURE_MS = 3000;
  var MIN_MEASURE_GAP_MS = 5000;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return App.escapeHtml(v); }
  function chars(s) { return Array.from(String(s || '').replace(/\s+/g, '')).length; }

  function setStatus(text, cls) {
    var el = $('curve-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'field-hint' + (cls ? ' ' + cls : '');
  }

  // ---------- 章节选择 ----------
  async function loadChapterOptions() {
    var sel = $('curve-chapter');
    if (!sel || !S.bookId) return;
    try {
      var res = await App.api('GET', '/api/books/' + S.bookId + '/chapters');
      var chapters = res.chapters || [];
      sel.innerHTML = chapters.length
        ? chapters.map(function (c) {
          return '<option value="' + c.id + '">' + esc(c.title) + '（' + (c.content_length || 0) + ' 字）</option>';
        }).join('')
        : '<option value="">（本书还没有章节）</option>';
    } catch (e) {
      sel.innerHTML = '<option value="">章节载入失败</option>';
    }
  }

  // ---------- 载入 / 渲染 ----------
  async function loadChapter() {
    var sel = $('curve-chapter');
    var chapterId = sel && Number(sel.value);
    if (!S.bookId || !Number.isFinite(chapterId)) { setStatus('先选一章。'); return; }
    setStatus('载入中…');
    try {
      var res = await App.api('GET', '/api/style-lab/chapter-text?book_id=' + S.bookId + '&chapter_id=' + chapterId);
      var chapter = res.chapter || {};
      S.chapterId = chapterId;
      S.chapterTitle = chapter.title || '';

      var draft = store.load(S.bookId, S.chapterId);
      var paras = ST.splitParagraphs(chapter.content || '');
      if (draft && draft.items.length) {
        // 草稿优先，但正文被改动过（段数或原文不同）时以库里正文为准，避免改错版本
        var sameShape = draft.items.length === paras.length &&
          draft.items.every(function (it, i) { return it.original === paras[i].text; });
        if (sameShape) {
          S.items = draft.items;
          S.series = draft.series || [];
        } else {
          S.items = paras.map(function (p) { return RC.createItem(p.text, p.text); });
          S.series = [];
          setStatus('正文与上次草稿不一致（章节可能改过），已按最新正文重新载入，草稿未套用。', 'warn');
        }
      } else {
        S.items = paras.map(function (p) { return RC.createItem(p.text, p.text); });
        S.series = [];
      }
      renderParas();
      renderChart();
      var mBtn = $('curve-measure');
      if (mBtn) mBtn.disabled = !S.items.length;
      if (!S.items.length) setStatus('这一章还没有正文，无法改写。');
      else if (!draft) setStatus('已载入「' + S.chapterTitle + '」共 ' + S.items.length + ' 段。改完一段点「测一次」。');
    } catch (e) {
      setStatus('载入失败：' + e.message, 'warn');
    }
  }

  function renderParas() {
    var box = $('curve-paras');
    if (!box) return;
    var summary = RC.summarize(S.items);
    var head = '<div class="curve-paras-head">' + esc(RC.describeProgress(summary)) +
      ' <button id="curve-copy-targets" class="btn btn-small btn-outline" type="button" title="复制还没改的段落 + 该段的毛病标签（不含任何分数）">复制待改段（不含分数）</button>' +
      '</div>';
    var rows = S.items.map(function (it, i) {
      var tags = ST.diagnose(it.changed ? it.original : it.original);
      var tagHtml = tags.map(function (t) {
        return '<span class="curve-tag" title="' + esc(t.hint) + '">' + esc(t.label + (t.count > 1 ? ' ×' + t.count : '')) + '</span>';
      }).join('');
      return '<div class="curve-para' + (it.changed ? ' changed' : '') + '" data-i="' + i + '">' +
        '<div class="curve-para-head">' +
        '<span class="curve-para-idx">' + (i + 1) + '</span>' +
        '<span class="curve-para-chars">' + it.newChars + ' 字</span>' +
        (it.changed ? '<span class="curve-para-state">已改写</span>' : '') +
        '<span class="curve-para-tags">' + tagHtml + '</span>' +
        (it.changed ? '<button class="btn btn-small btn-ghost" data-reset="1" type="button">还原</button>' : '') +
        '</div>' +
        '<textarea class="curve-para-text" rows="2" spellcheck="false">' + esc(it.changed ? it.rewritten : it.original) + '</textarea>' +
        '</div>';
    }).join('');
    box.innerHTML = head + rows;
  }

  // 只重画某一段的状态（避免整列表重建导致光标丢失——输入中不能重建 DOM）
  function markParaChanged(idx) {
    var box = $('curve-paras');
    var row = box && box.querySelector('.curve-para[data-i="' + idx + '"]');
    if (!row) return;
    var it = S.items[idx];
    row.classList.toggle('changed', it.changed);
    var state = row.querySelector('.curve-para-state');
    if (it.changed && !state) {
      var span = document.createElement('span');
      span.className = 'curve-para-state';
      span.textContent = '已改写';
      row.querySelector('.curve-para-head').insertBefore(span, row.querySelector('.curve-para-tags'));
    } else if (!it.changed && state) {
      state.remove();
    }
    var charsEl = row.querySelector('.curve-para-chars');
    if (charsEl) charsEl.textContent = it.newChars + ' 字';
    var head = box.querySelector('.curve-paras-head');
    if (head) head.firstChild.textContent = RC.describeProgress(RC.summarize(S.items)) + ' ';
  }

  function onParasInput(ev) {
    var ta = ev.target.closest('.curve-para-text');
    if (!ta) return;
    var row = ta.closest('.curve-para');
    var idx = Number(row && row.dataset.i);
    if (!Number.isFinite(idx) || !S.items[idx]) return;
    S.items[idx] = RC.createItem(S.items[idx].original, ta.value);
    markParaChanged(idx);
    scheduleAutosave();
    if ($('curve-auto') && $('curve-auto').checked) scheduleAutoMeasure();
  }

  function onParasClick(ev) {
    var reset = ev.target.closest('[data-reset]');
    if (reset) {
      var row = reset.closest('.curve-para');
      var idx = Number(row && row.dataset.i);
      if (!Number.isFinite(idx) || !S.items[idx]) return;
      S.items[idx] = RC.createItem(S.items[idx].original, S.items[idx].original);
      var ta = row.querySelector('.curve-para-text');
      if (ta) ta.value = S.items[idx].original;
      markParaChanged(idx);
      scheduleAutosave();
      return;
    }
    if (ev.target.closest('#curve-copy-targets')) copyTargets();
  }

  function scheduleAutosave() {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      S.timer = null;
      store.save(S.bookId, S.chapterId, { items: S.items, series: S.series });
    }, AUTOSAVE_MS);
  }

  function scheduleAutoMeasure() {
    if (S.autoTimer) clearTimeout(S.autoTimer);
    S.autoTimer = setTimeout(function () { S.autoTimer = null; measure(true); }, AUTO_MEASURE_MS);
  }

  // ---------- 测量 ----------
  async function measure(auto) {
    if (S.measuring || !S.items.length) return;
    var text = RC.assemble(S.items);
    if (!text.trim()) { setStatus('没有可送检的正文。'); return; }
    var gap = Date.now() - S.lastMeasureAt;
    if (auto && gap < MIN_MEASURE_GAP_MS) { scheduleAutoMeasure(); return; }
    S.measuring = true;
    var btn = $('curve-measure');
    if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
    setStatus('送检中（' + chars(text) + ' 字）…');
    try {
      var res = await App.api('POST', '/api/style-lab/detect', { text: text, save: false });
      var conf = res.overall && res.overall.conf;
      S.lastMeasureAt = Date.now();
      S.series = RC.addPoint(S.series, {
        ratio: RC.summarize(S.items).ratioByChars, conf: conf, chars: chars(text), at: new Date().toISOString(),
      });
      renderChart();
      store.save(S.bookId, S.chapterId, { items: S.items, series: S.series });
      var band = RC.bandOf(conf);
      setStatus('最新读数 ' + (typeof conf === 'number' ? conf.toFixed(4) : '—') + '（' + band.label + '）· ' +
        RC.describeProgress(RC.summarize(S.items)) + '　（分数只作参考，不设达标线）');
    } catch (e) {
      setStatus('检测失败：' + e.message + '（额度/网络问题不影响改写与草稿）', 'warn');
    } finally {
      S.measuring = false;
      if (btn) { btn.disabled = false; btn.textContent = '测一次（花 1 次朱雀额度）'; }
    }
  }

  // ---------- 画曲线 ----------
  function renderChart() {
    var svg = $('curve-chart');
    if (!svg) return;
    var W = 360, H = 200;
    var pads = { padLeft: 38, padRight: 12, padTop: 12, padBottom: 26 };
    var grid = RC.CONF_BANDS.map(function (b, i) {
      var y = pads.padTop + (1 - b.max) * (H - pads.padTop - pads.padBottom);
      if (b.max > 1) y = H - pads.padBottom;
      return { y: Math.round(y * 10) / 10, label: b.label };
    });
    var humanY = Math.round((pads.padTop + (1 - 0.016) * (H - pads.padTop - pads.padBottom)) * 10) / 10;
    var pts = RC.plotPoints(S.series, { width: W, height: H, padLeft: pads.padLeft, padRight: pads.padRight, padTop: pads.padTop, padBottom: pads.padBottom });
    var gridHtml = grid.map(function (g) {
      return '<line x1="' + pads.padLeft + '" y1="' + g.y + '" x2="' + (W - pads.padRight) + '" y2="' + g.y + '" class="chart-grid"></line>' +
        '<text x="' + (pads.padLeft - 4) + '" y="' + (g.y + 3) + '" class="chart-axis" text-anchor="end">' + g.label + '</text>';
    }).join('');
    var humanLine = '<line x1="' + pads.padLeft + '" y1="' + humanY + '" x2="' + (W - pads.padRight) + '" y2="' + humanY + '" class="chart-human"></line>' +
      '<text x="' + (W - pads.padRight) + '" y="' + (humanY - 4) + '" class="chart-axis chart-human-label" text-anchor="end">人类原文实测区间 0.0003~0.0159</text>';
    var dots = pts.map(function (p) {
      return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3.5" class="chart-dot"><title>' + esc(p.label) + '</title></circle>';
    }).join('');
    var path = pts.length > 1 ? '<path d="' + RC.seriesPath(pts) + '" class="chart-line"></path>' : '';
    var xAxis = '<line x1="' + pads.padLeft + '" y1="' + (H - pads.padBottom) + '" x2="' + (W - pads.padRight) + '" y2="' + (H - pads.padBottom) + '" class="chart-grid"></line>' +
      '<text x="' + pads.padLeft + '" y="' + (H - 8) + '" class="chart-axis">人改 0%</text>' +
      '<text x="' + (W - pads.padRight) + '" y="' + (H - 8) + '" class="chart-axis" text-anchor="end">100%</text>';
    svg.innerHTML = gridHtml + humanLine + xAxis + path + dots;
    renderPoints();
  }

  function renderPoints() {
    var box = $('curve-points');
    if (!box) return;
    if (!S.series.length) { box.innerHTML = '<p class="empty-hint">还没有测量点。改几段后点「测一次」。</p>'; return; }
    box.innerHTML = S.series.map(function (p, i) {
      return '<div class="curve-point">' +
        '<span class="curve-point-idx">#' + (i + 1) + '</span>' +
        '<span>人改 ' + Math.round(p.ratio * 100) + '%</span>' +
        '<span class="curve-point-conf">' + (typeof p.conf === 'number' ? p.conf.toFixed(4) : '—') + '</span>' +
        '<span class="curve-point-band">' + esc(RC.bandOf(p.conf).label) + '</span>' +
        (p.n > 1 ? '<span class="curve-point-n" title="同一比例重复测量次数">×' + p.n + '</span>' : '') +
        '</div>';
    }).join('');
  }

  // ---------- 复制待改段（不含分数） ----------
  async function copyTargets() {
    var pending = S.items.filter(function (it) { return !it.changed; })
      .map(function (it) { return { index: 0, text: it.original }; });
    if (!pending.length) { App.toast('所有段落都已改过一遍'); return; }
    var brief = ST.buildBrief(pending, { withText: true });
    try {
      await navigator.clipboard.writeText(brief);
      App.toast('已复制 ' + pending.length + ' 段（含毛病标签，不含任何分数）');
    } catch (e) {
      App.openModal({
        title: '手动复制（浏览器拒绝剪贴板）', bodyHTML: '<textarea class="curve-copy-fallback" rows="12">' + esc(brief) + '</textarea>',
        okText: '知道了', onOk: function () { return true; },
      });
    }
  }

  function resetDraft() {
    if (!S.chapterId) return;
    if (!confirm('清空本章的改写草稿与曲线？（不影响章节正文）')) return;
    store.clear(S.bookId, S.chapterId);
    S.items = S.items.map(function (it) { return RC.createItem(it.original, it.original); });
    S.series = [];
    renderParas();
    renderChart();
    setStatus('草稿已清空，章节正文未受影响。');
  }

  function bind() {
    var pairs = [['curve-load', loadChapter], ['curve-measure', function () { measure(false); }], ['curve-reset', resetDraft]];
    pairs.forEach(function (p) {
      var el = $(p[0]);
      if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.onclick = p[1]; }
    });
    var paras = $('curve-paras');
    if (paras && !paras.dataset.bound) {
      paras.dataset.bound = '1';
      paras.addEventListener('input', onParasInput);
      paras.addEventListener('click', onParasClick);
    }
  }

  window.RewriteCurvePanel = {
    show: async function (bookId) {
      S.bookId = bookId;
      S.chapterId = null; S.items = []; S.series = [];
      bind();
      renderParas();
      renderChart();
      await loadChapterOptions();
      var sel = $('curve-chapter');
      // 默认选到最后一章（通常是最新写的）
      if (sel && sel.options.length) sel.selectedIndex = sel.options.length - 1;
      setStatus('选一章后点「载入本章」。草稿按书/章自动保存，刷新不丢。');
    },
  };
})();
