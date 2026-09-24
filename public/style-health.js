// AI 味体检面板（阅读/精修页）—— 作家仓库第三层的 UI。
//
// 解耦约束（委托方「必须不能十分耦合」）：
//   - 本文件是纯旁路：只调 /api/style-lab/*，不碰 book-read.js 的任何状态与渲染；
//   - book-read.js 只在章节切换时调一次 StyleHealth.render(bookId, chapterId)（一行）；
//   - 删掉本文件 + 那一行调用，阅读页行为与今天完全一致（只少一个入口）。
// 挂在 window.StyleHealth 上，与 chat-event-hub.js 同一种模块风格（原生 JS、无构建）。
(function () {
  'use strict';

  var App = window.App;
  var StyleHealth = window.StyleHealth = window.StyleHealth || {};

  var S = { bookId: null, chapterId: null, running: false };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return App.escapeHtml(v); }

  // 置信度 → 可读判读。阈值只是展示分档，不是「达标线」——
  // 分数只作参考维度，绝不设「必须低于 X」的目标（那会让作者为达标而生硬改写，反而产生新的 AI 味）。
  function confLabel(conf) {
    if (typeof conf !== 'number') return { text: '—', cls: 'unknown' };
    if (conf >= 0.9) return { text: 'AI 味很重', cls: 'high' };
    if (conf >= 0.7) return { text: 'AI 味较重', cls: 'high' };
    if (conf >= 0.5) return { text: '疑似 AI', cls: 'mid' };
    if (conf >= 0.2) return { text: '偏人工', cls: 'low' };
    return { text: '很像人写的', cls: 'low' };
  }

  // 段级标签：朱雀回的分段里带 label（0 人工 / 1 AI / 2 疑似）。实测口径（2026-09-14 归因报告）：
  // 整篇分是**篇章级聚合**——同一章整篇 0.9999，而章内任意 ~700 字窗口只有 0.68~0.89；
  // 所以「哪几段判 AI」比「整篇多少分」更像靶点，也是唯一能拿来做逐段改写的定位信息。
  var LABEL_TEXT = { 0: '人工', 1: 'AI', 2: '疑似' };
  var LABEL_CLS = { 0: 'low', 1: 'high', 2: 'mid' };

  // 参考区间不写成「达标线」：人类原文实测 0.0003~0.0159 只是参照物，
  // 本项目一贯不设「必须低于 X」（为达标而生硬改写会生出新的 AI 味）。
  var HUMAN_REF = '人类原文实测 0.0003~0.0159';

  function segRow(s) {
    var lab = (s.label === 0 || s.label === 1 || s.label === 2) ? s.label : null;
    var tags = (window.SegmentTargets && window.SegmentTargets.diagnose)
      ? window.SegmentTargets.diagnose(s.text) : [];
    return '<div class="health-seg ' + confLabel(s.conf).cls + '" data-label="' + (lab === null ? '' : lab) + '">' +
      '<div class="health-seg-head">' +
      (lab === null ? '' : '<span class="health-seg-label label-' + LABEL_CLS[lab] + '">' + LABEL_TEXT[lab] + '</span>') +
      '<span class="health-seg-conf">' + (typeof s.conf === 'number' ? s.conf.toFixed(3) : '—') + '</span>' +
      tags.map(function (t) {
        return '<span class="curve-tag" title="' + esc(t.hint) + '">' + esc(t.label + (t.count > 1 ? ' ×' + t.count : '')) + '</span>';
      }).join('') +
      '</div>' +
      '<div class="health-seg-text">' + esc(s.text) + '</div>' +
      '</div>';
  }

  // 结果面板：整章分数 + 逐段标签与靶点（可只筛「判 AI」的段，并可无分数复制）
  function reportHtml(data) {
    var overall = data.overall || {};
    var segments = data.segments || [];
    var conf = overall.conf;
    var lab = confLabel(conf);
    var head = '<div class="health-summary">' +
      '<span class="health-score ' + lab.cls + '">' + (typeof conf === 'number' ? conf.toFixed(4) : '—') + '</span>' +
      '<span class="health-label">' + lab.text + '</span>' +
      '<span class="health-meta">' + (overall.char_count || 0) + ' 字 · ' +
      (overall.usage_tokens ? overall.usage_tokens + ' tokens' : '') + '</span>' +
      '</div>' +
      '<p class="field-hint">参考区间：' + esc(HUMAN_REF) + '。整篇分是<strong>篇章级聚合</strong>——同一章里 ~700 字的窗口通常只有 0.68~0.89，' +
      '所以别只盯这一个数，看下面<strong>哪几段判 AI</strong>。' +
      '<br><strong>别把分数贴给模型让它改</strong>：实测贴了不降反更碎（0.9999 → 0.9999，句子被拆成一句一段）；' +
      '分数也不进模型上下文（项目铁律，Goodhart）。要改就用下面的「复制待改段 / 改稿目标」（都不含分数）。</p>';
    if (!segments.length) {
      return head + '<p class="empty-hint">本次未返回分段——朱雀只在长文本上分段，短文本只有整体分数。</p>';
    }
    var aiCount = segments.filter(function (s) { return s.label === 1; }).length;
    var toolbar = '<div class="health-toolbar">' +
      '<label class="health-only-ai"><input type="checkbox" id="health-only-ai"> 只看判 AI 的段（' + aiCount + '）</label>' +
      '<button class="btn btn-small btn-outline" id="health-copy-text" type="button" title="只复制段落正文，便于人改">复制待改段</button>' +
      '<button class="btn btn-small btn-outline" id="health-copy-brief" type="button" title="段落 + 可指名的毛病标签，不含任何分数">复制改稿目标</button>' +
      '<span class="field-hint" id="health-seg-count"></span>' +
      '</div>';
    return head + toolbar + '<div id="health-segs" class="health-segs">' +
      segments.map(segRow).join('') + '</div>' +
      '<p class="field-hint">判为 AI 的语句已自动进错题库，可在「错题库」页复核——你的复核结论决定它是否进入特征提取语料。</p>';
  }

  // 弹窗内的交互：筛「判 AI 的段」+ 两种无分数复制。整章数据留在 S.lastData，筛选不重新送检（不烧额度）。
  // 容器必须用 id `#modal-body`：通用弹窗（App.openModal）挂在 #modal-mask 下且 body 是 **id**，
  // 而 class `.modal-body` 只属于作家卡编辑器那个常驻弹窗——按 class 找会绑到那张卡的表单上，
  // 症状是段列表看着正常、筛选与复制按钮却全都不响应（2026-09-14 冒烟实测抓到的）。
  function bindModal(data) {
    var body = document.getElementById('modal-body');
    var segBox = body ? body.querySelector('#health-segs') : null;
    if (!body || !segBox) return;
    var segs = data.segments || [];
    var box = segBox;
    var countEl = body.querySelector('#health-seg-count');

    function renderFiltered() {
      var onlyAi = body.querySelector('#health-only-ai');
      var filtered = (onlyAi && onlyAi.checked) ? segs.filter(function (s) { return s.label === 1; }) : segs;
      if (box) box.innerHTML = filtered.map(segRow).join('') ||
        '<p class="empty-hint">没有判为「AI」的段——这章的分段里没有整段被判 AI 的。</p>';
      if (countEl) countEl.textContent = '显示 ' + filtered.length + ' / ' + segs.length + ' 段';
    }
    renderFiltered();

    var only = body.querySelector('#health-only-ai');
    if (only) only.onchange = renderFiltered;

    async function copyBrief(kind) {
      var ST = window.SegmentTargets;
      if (!ST) { App.toast('诊断模块未加载'); return; }
      var onlyAi = body.querySelector('#health-only-ai');
      var useAi = onlyAi && onlyAi.checked;
      var text = kind === 'text'
        ? ST.buildTextList(segs, { onlyAi: useAi })
        : ST.buildBrief(segs, { withText: true, onlyAi: useAi });
      if (!text.trim()) { App.toast('没有可复制的段落'); return; }
      try {
        await navigator.clipboard.writeText(text);
        App.toast('已复制' + (useAi ? '（只含判 AI 的段）' : '') + '——不含任何检测分数');
      } catch (e) {
        App.openModal({
          title: '手动复制（浏览器拒绝剪贴板）',
          bodyHTML: '<textarea class="curve-copy-fallback" rows="12">' + esc(text) + '</textarea>',
          okText: '知道了', onOk: function () { return true; },
        });
      }
    }
    var cbText = body.querySelector('#health-copy-text');
    if (cbText) cbText.onclick = function () { copyBrief('text'); };
    var cbBrief = body.querySelector('#health-copy-brief');
    if (cbBrief) cbBrief.onclick = function () { copyBrief('brief'); };
  }

  function setBusy(busy, text) {
    S.running = busy;
    var btn = $('read-health-btn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? (text || '体检中…') : 'AI 味体检';
  }

  // 体检入口：整章送检（服务端自己取正文），默认落库
  async function runCheck() {
    if (S.running || !S.bookId || !S.chapterId) return;
    var edited = $('read-editor');
    if (edited && !edited.classList.contains('hidden')) {
      var cur = edited.value;
      var saved = (App.state.currentChapter && App.state.currentChapter.content) || '';
      if (cur !== saved && !confirm('精修区有未保存的改动，体检的是已保存的正文。继续？')) return;
    }
    setBusy(true);
    try {
      var data = await App.api('POST', '/api/style-lab/detect-chapter', {
        book_id: S.bookId, chapter_id: S.chapterId
      });
      App.openModal({
        title: 'AI 味体检结果',
        bodyHTML: reportHtml(data),
        okText: '知道了',
        onOk: function () { return true; },
      });
      bindModal(data);
    } catch (e) {
      // 体检是旁路：没配 key / 额度耗尽 / 网络不通都只提示，不影响任何写作功能
      App.toast('体检未完成：' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // 本章历史标本：快速看「这一章之前检出过多少条、复核了没有」
  async function showSamples() {
    if (!S.bookId || !S.chapterId) return;
    try {
      var data = await App.api('GET', '/api/style-lab/samples?book_id=' + S.bookId +
        '&chapter_id=' + S.chapterId + '&limit=100&order=conf');
      var list = (data.samples || []);
      StyleHealth.showSampleList(list, '本章错题库标本（' + (data.total || 0) + ' 条）');
    } catch (e) {
      App.toast(e.message);
    }
  }

  // 标本列表弹窗（含复核按钮）——阅读页与错题库页共用
  StyleHealth.showSampleList = function (list, title) {
    if (!list.length) {
      App.openModal({
        title: title,
        bodyHTML: '<p class="empty-hint">还没有标本。点「AI 味体检」检测本章后，判为 AI 的语句会自动进来。</p>',
        okText: '知道了',
        onOk: function () { return true; },
      });
      return;
    }
    var html = '<div class="sample-list">' + list.map(function (s) {
      var l = confLabel(s.detectorConf);
      var verdictText = { pending: '待复核', ai: '确认 AI', human: '确认为人写', rejected: '已废弃' }[s.verdict] || s.verdict;
      return '<div class="sample-item" data-id="' + s.id + '">' +
        '<div class="sample-head">' +
        '<span class="health-seg-conf ' + l.cls + '">' + (typeof s.detectorConf === 'number' ? s.detectorConf.toFixed(3) : '—') + '</span>' +
        '<span class="sample-verdict verdict-' + s.verdict + '">' + verdictText + '</span>' +
        (s.seenCount > 1 ? '<span class="sample-seen" title="同一句被反复检出">×' + s.seenCount + '</span>' : '') +
        '<span class="sample-src">' + esc(s.chapterTitle || '') + '</span>' +
        '</div>' +
        '<div class="sample-text">' + esc(s.text) + '</div>' +
        '<div class="sample-ops">' +
        '<button class="btn btn-small btn-outline" data-review="ai">确认是 AI</button>' +
        '<button class="btn btn-small btn-ghost" data-review="human">这句是人写的</button>' +
        '<button class="btn btn-small btn-ghost" data-review="rejected">废弃</button>' +
        '</div></div>';
    }).join('') + '</div>';

    App.openModal({
      title: title,
      bodyHTML: html,
      okText: '关闭',
      onOk: function () { return true; },
    });

    var box = document.querySelector('#modal-body .sample-list'); // 容器是 #modal-body（id）：class .modal-body 属于作家卡编辑器弹窗，绑错处按钮全无响应（见上 88 行注释）
    if (!box) return;
    box.onclick = async function (ev) {
      var btn = ev.target.closest('[data-review]');
      if (!btn) return;
      var item = btn.closest('.sample-item');
      var id = item && item.dataset.id;
      if (!id) return;
      var verdict = btn.dataset.review;
      try {
        var res = await App.api('PATCH', '/api/style-lab/samples/' + id, { verdict: verdict });
        var label = item.querySelector('.sample-verdict');
        var map = { pending: '待复核', ai: '确认 AI', human: '确认为人写', rejected: '已废弃' };
        label.className = 'sample-verdict verdict-' + res.sample.verdict;
        label.textContent = map[res.sample.verdict] || res.sample.verdict;
        App.toast('已记录复核结论');
      } catch (e) {
        App.toast(e.message);
      }
    };
  };

  // 开关面板：插入阅读页顶栏按钮 + 结果弹窗；章节切换时由 book-read.js 调 render
  StyleHealth.render = function (bookId, chapterId) {
    S.bookId = bookId;
    S.chapterId = chapterId;
    var btn = $('read-health-btn');
    if (!btn) return;
    btn.classList.toggle('hidden', !chapterId);
    btn.title = chapterId ? '用朱雀检测本章 AI 味（结果只作参考，不设达标线）' : '';
  };

  function init() {
    var btn = $('read-health-btn');
    if (btn) btn.onclick = runCheck;
    var sBtn = $('read-samples-btn');
    if (sBtn) sBtn.onclick = showSamples;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
