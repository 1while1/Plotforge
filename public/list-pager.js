(function () {
  'use strict';
  // 轻量分页器：四个工作台共用。state 形如 { page, pageSize, total }。
  // 前端切片场景用 slice()；服务端分页场景由调用方先按页拉取、只把 total 填进来。
  var ListPager = window.ListPager = {};

  ListPager.pageCount = function (st) {
    return Math.max(1, Math.ceil((st.total || 0) / st.pageSize));
  };

  // 前端切片：越界页码自动收拢（删元素/过滤后总数变小的常见情况）
  ListPager.slice = function (items, st) {
    st.total = items.length;
    var pages = ListPager.pageCount(st);
    if (st.page > pages) st.page = pages;
    if (st.page < 1) st.page = 1;
    var start = (st.page - 1) * st.pageSize;
    return items.slice(start, start + st.pageSize);
  };

  // 总数不超一页时不渲染（不制造噪音）
  ListPager.html = function (st, unit) {
    var pages = ListPager.pageCount(st);
    if ((st.total || 0) <= st.pageSize) return '';
    return '<div class="list-pager">' +
      '<button class="btn btn-ghost btn-small" type="button" data-page-prev' + (st.page <= 1 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span class="list-pager-meta">第 ' + st.page + ' / ' + pages + ' 页 · 共 ' + st.total + ' ' + (unit || '条') + '</span>' +
      '<button class="btn btn-ghost btn-small" type="button" data-page-next' + (st.page >= pages ? ' disabled' : '') + '>下一页 ›</button></div>';
  };

  // root 为分页条所在容器；onChange 负责重拉/重渲
  ListPager.bind = function (root, st, onChange) {
    if (!root) return;
    var prev = root.querySelector('[data-page-prev]');
    var next = root.querySelector('[data-page-next]');
    if (prev) prev.onclick = function () { if (st.page > 1) { st.page--; onChange(); } };
    if (next) next.onclick = function () { if (st.page < ListPager.pageCount(st)) { st.page++; onChange(); } };
  };
})();
