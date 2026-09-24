// 改写收益曲线（去 AI 率归因 2026-09-14）：把「人改多少 → 检测分降到哪」变成可见的曲线。
//
// 为什么要有它：实测里唯一能把读数拉进人工区的输入是「人写的字」（人类原文 0.0003~0.0159；
// 人写 1500 + AI 1250 混排 = 0.6082，人写段被准确判「人工」）。但「改到什么程度算够」没人知道——
// 本轮只有一个点。这个模块只做三件事，全部是纯函数，便于单测：
//   1) 把「原文 / 人改后的文本」算成比例（按字数、按段数两种口径）；
//   2) 记录 (人改比例, 检测分) 测量点并给出画图坐标；
//   3) 按书/章把草稿存 localStorage（刷新不丢改写成果）。
// 它**不设达标线**：分数只作参考维度（设线会让作者为达标而生硬改写，反而生出新的 AI 味）。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RewriteCurve = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 与 style-health.js 的 confLabel 同一组分档（图表参考线用），只作展示，不是目标
  var CONF_BANDS = [
    { max: 0.2, label: '很像人写的' },
    { max: 0.5, label: '偏人工' },
    { max: 0.7, label: '疑似 AI' },
    { max: 0.9, label: 'AI 味较重' },
    { max: 1.01, label: 'AI 味很重' },
  ];

  function bandOf(conf) {
    if (typeof conf !== 'number' || !isFinite(conf)) return { label: '—' };
    for (var i = 0; i < CONF_BANDS.length; i++) if (conf < CONF_BANDS[i].max) return CONF_BANDS[i];
    return CONF_BANDS[CONF_BANDS.length - 1];
  }

  function charsOf(s) { return Array.from(String(s || '').replace(/\s+/g, '')).length; }

  /** 段落条目：原文 + 当前(人改后)文本；changed 以「去空白后不同」为准，避免只改标点/空格被算成人改。 */
  function createItem(original, rewritten) {
    var o = String(original || '');
    var r = rewritten === undefined || rewritten === null ? o : String(rewritten);
    return {
      original: o,
      rewritten: r,
      origChars: charsOf(o),
      newChars: charsOf(r),
      changed: charsOf(o) !== charsOf(r) || o.replace(/\s+/g, '') !== r.replace(/\s+/g, ''),
    };
  }

  function normalizeItems(texts) {
    return (texts || []).map(function (t) { return createItem(t, t); });
  }

  /** 汇总：字数口径为准（段数口径同时给出，方便阅读）。 */
  function summarize(items) {
    var list = items || [];
    var totalChars = 0, changedChars = 0, changedCount = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      totalChars += it.newChars;
      if (it.changed) { changedChars += it.newChars; changedCount++; }
    }
    return {
      totalCount: list.length,
      changedCount: changedCount,
      totalChars: totalChars,
      changedChars: changedChars,
      ratioByChars: totalChars ? Math.round((changedChars / totalChars) * 1000) / 1000 : 0,
      ratioByCount: list.length ? Math.round((changedCount / list.length) * 1000) / 1000 : 0,
    };
  }

  /** 拼回全文（已改的用改写稿，其余原文），用于送检。 */
  function assemble(items) {
    return (items || []).map(function (it) { return it.changed ? it.rewritten : it.original; })
      .filter(function (t) { return String(t || '').trim(); })
      .join('\n\n');
  }

  function pct(v) { return Math.round((v || 0) * 100) + '%'; }

  /**
   * 追加一个测量点。同一「人改比例（1% 粒度）+ 分数（4 位小数）」的重复测量只记次数，
   * 避免自动测量把曲线刷成一条毛刺。
   */
  function addPoint(series, point) {
    var list = (series || []).slice();
    var p = {
      ratio: Math.round((point && point.ratio ? point.ratio : 0) * 100) / 100,
      conf: typeof point.conf === 'number' ? Math.round(point.conf * 10000) / 10000 : null,
      chars: (point && point.chars) || 0,
      at: (point && point.at) || null,
    };
    var last = list[list.length - 1];
    if (last && last.ratio === p.ratio && last.conf === p.conf) {
      last.n = (last.n || 1) + 1;
      last.at = p.at;
      return list;
    }
    p.n = 1;
    if (list.length >= 200) list.shift();
    list.push(p);
    return list;
  }

  /** 曲线坐标：x=人改比例(0~1)，y=检测分(0~1，1 在顶端)，返回像素点。 */
  function plotPoints(points, opts) {
    var o = opts || {};
    var w = o.width || 320, h = o.height || 160;
    var padL = o.padLeft === undefined ? 34 : o.padLeft;
    var padR = o.padRight === undefined ? 10 : o.padRight;
    var padT = o.padTop === undefined ? 10 : o.padTop;
    var padB = o.padBottom === undefined ? 22 : o.padBottom;
    var innerW = Math.max(1, w - padL - padR);
    var innerH = Math.max(1, h - padT - padB);
    return (points || []).filter(function (p) { return typeof p.conf === 'number'; }).map(function (p) {
      var rx = Math.min(1, Math.max(0, p.ratio));
      var ry = Math.min(1, Math.max(0, p.conf));
      return {
        x: Math.round((padL + rx * innerW) * 10) / 10,
        y: Math.round((padT + (1 - ry) * innerH) * 10) / 10,
        ratio: p.ratio,
        conf: p.conf,
        label: pct(p.ratio) + ' → ' + p.conf.toFixed(4) + '（' + bandOf(p.conf).label + '）',
      };
    });
  }

  function seriesPath(pts) {
    return (pts || []).map(function (p, i) { return (i ? 'L' : 'M') + p.x + ' ' + p.y; }).join(' ');
  }

  /** 人话进度：给面板顶部一行字用。 */
  function describeProgress(summary) {
    var s = summary || summarize([]);
    if (!s.totalCount) return '还没有载入段落';
    if (!s.changedCount) return '共 ' + s.totalCount + ' 段 / ' + s.totalChars + ' 字，尚未改写';
    return '已改 ' + s.changedCount + '/' + s.totalCount + ' 段（占 ' + pct(s.ratioByChars) + ' 字数，' +
      s.changedChars + ' 字）';
  }

  // ---- 草稿持久化（刷新不丢改写成果）----
  function detectStorage() {
    try {
      return (typeof window !== 'undefined' && window.localStorage) || null;
    } catch (e) { return null; }
  }

  function createDraftStore(options) {
    var o = options || {};
    var storage = o.storage !== undefined ? o.storage : detectStorage();
    var prefix = o.prefix || 'novel-rewrite:';

    function key(bookId, chapterId) { return prefix + String(bookId) + ':' + String(chapterId); }

    function load(bookId, chapterId) {
      if (!storage || bookId === null || bookId === undefined || chapterId === null || chapterId === undefined) return null;
      try {
        var raw = storage.getItem(key(bookId, chapterId));
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (!data || !Array.isArray(data.items)) return null;
        var items = data.items.filter(function (it) { return it && typeof it.o === 'string'; })
          .map(function (it) {
            var item = createItem(it.o, typeof it.r === 'string' ? it.r : it.o);
            return item;
          });
        if (!items.length) return null;
        // series 只需保留 {ratio, conf, chars, at, n}
        var series = Array.isArray(data.series) ? data.series.filter(function (p) {
          return p && typeof p.conf === 'number' && typeof p.ratio === 'number';
        }).map(function (p) {
          return { ratio: p.ratio, conf: p.conf, chars: p.chars || 0, at: p.at || null, n: p.n || 1 };
        }) : [];
        return { items: items, series: series, updatedAt: data.updatedAt || null };
      } catch (e) { return null; }
    }

    function save(bookId, chapterId, draft) {
      if (!storage || bookId === null || bookId === undefined || chapterId === null || chapterId === undefined) return false;
      try {
        var d = draft || {};
        var payload = {
          items: (d.items || []).map(function (it) { return { o: it.original, r: it.rewritten }; }),
          series: d.series || [],
          updatedAt: new Date().toISOString(),
        };
        storage.setItem(key(bookId, chapterId), JSON.stringify(payload));
        return true;
      } catch (e) { return false; }
    }

    function clear(bookId, chapterId) {
      if (!storage || bookId === null || bookId === undefined || chapterId === null || chapterId === undefined) return;
      try { storage.removeItem(key(bookId, chapterId)); } catch (e) { /* 忽略 */ }
    }

    return { load: load, save: save, clear: clear };
  }

  return {
    CONF_BANDS: CONF_BANDS,
    bandOf: bandOf,
    createItem: createItem,
    normalizeItems: normalizeItems,
    summarize: summarize,
    assemble: assemble,
    addPoint: addPoint,
    plotPoints: plotPoints,
    seriesPath: seriesPath,
    describeProgress: describeProgress,
    createDraftStore: createDraftStore,
  };
});
