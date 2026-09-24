// 三栏拖拽分栏（写作页 workbench）：左栏宽度与中:右比例可拖拽调整。
// 分隔条由本模块注入、列宽模板由本模块内联接管：模块未加载时页面维持
// style.css 原始三栏定义，零腐化风险。宽度偏好存 localStorage（屏幕空间
// 是设备级偏好，不按书存）；双击分隔条恢复默认。收起侧栏（left-collapsed）
// 经 MutationObserver 感知，折叠时左分隔条由 CSS 隐藏、模板自动改两栏。
(function () {
  'use strict';

  var STORAGE_KEY = 'novel-workbench-layout';
  var DEFAULT_LEFT = 260;
  var DEFAULT_RATIO = 1 / 2.2; // 中:右 = 1:1.2，与 .workbench 原始 grid 一致
  var MIN_LEFT = 200, MAX_LEFT = 420;
  var MIN_MIDDLE = 320, MIN_RIGHT = 360;
  var DIVIDER_W = 5;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (d && d.left > 0 && d.ratio > 0 && d.ratio < 1) return d;
    } catch (e) { /* 本地偏好损坏时回退默认 */ }
    return { left: DEFAULT_LEFT, ratio: DEFAULT_RATIO };
  }
  function save(d) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ } }

  function init() {
    var bench = document.getElementById('book-workbench');
    if (!bench) return;
    var leftPanel = bench.querySelector('.panel-left');
    var chatPanel = bench.querySelector('.panel-chat');
    if (!leftPanel || !chatPanel) return;

    var state = load();

    function makeDivider(side, hint) {
      var d = document.createElement('div');
      d.className = 'col-divider';
      d.dataset.side = side;
      d.title = hint;
      d.setAttribute('role', 'separator');
      d.setAttribute('aria-orientation', 'vertical');
      return d;
    }
    var divLeft = makeDivider('left', '拖拽调整侧栏宽度 · 双击恢复默认');
    var divRight = makeDivider('right', '拖拽调整聊天栏宽度 · 双击恢复默认');
    leftPanel.after(divLeft);
    chatPanel.after(divRight);
    bench.classList.add('resizable');

    function isCollapsed() { return bench.classList.contains('left-collapsed'); }
    function template() {
      var a = state.ratio, b = 1 - state.ratio;
      if (isCollapsed()) {
        return 'minmax(0,' + a + 'fr) ' + DIVIDER_W + 'px minmax(0,' + b + 'fr)';
      }
      return state.left + 'px ' + DIVIDER_W + 'px minmax(0,' + a + 'fr) ' + DIVIDER_W + 'px minmax(0,' + b + 'fr)';
    }
    function apply() { bench.style.gridTemplateColumns = template(); }

    // 「收起侧栏」由 book.js 切 class：监听后重算模板
    new MutationObserver(apply).observe(bench, { attributes: true, attributeFilter: ['class'] });

    function startDrag(side, e) {
      e.preventDefault();
      var startX = e.clientX;
      var collapsed = isCollapsed();
      var startLeft = leftPanel.getBoundingClientRect().width;
      var startMiddle = chatPanel.getBoundingClientRect().width;
      var dividerCount = collapsed ? 1 : 2;
      var flexTotal = bench.getBoundingClientRect().width - (collapsed ? 0 : startLeft) - DIVIDER_W * dividerCount;
      var divider = side === 'left' ? divLeft : divRight;
      divider.classList.add('dragging');
      document.body.classList.add('col-resizing');

      function onMove(ev) {
        var dx = ev.clientX - startX;
        if (side === 'left') {
          state.left = clamp(startLeft + dx, MIN_LEFT, MAX_LEFT);
        } else {
          var middle = clamp(startMiddle + dx, MIN_MIDDLE, Math.max(MIN_MIDDLE, flexTotal - MIN_RIGHT));
          state.ratio = clamp(middle / flexTotal, 0.2, 0.8);
        }
        apply();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        divider.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        save(state);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    divLeft.addEventListener('mousedown', function (e) { startDrag('left', e); });
    divRight.addEventListener('mousedown', function (e) { startDrag('right', e); });
    divLeft.addEventListener('dblclick', function () { state.left = DEFAULT_LEFT; apply(); save(state); });
    divRight.addEventListener('dblclick', function () { state.ratio = DEFAULT_RATIO; apply(); save(state); });

    apply();

    window.PanelResizer = {
      apply: apply,
      reset: function () { state = { left: DEFAULT_LEFT, ratio: DEFAULT_RATIO }; apply(); save(state); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
