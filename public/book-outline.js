// 大纲 tab：总纲编辑 + 偏离监督
(function () {
  'use strict';
  const BookPage = window.BookPage = window.BookPage || {};

  function $(id) { return document.getElementById(id); }
  function A() { return window.App; }
  function bid() { return A().state.currentBook.id; }

  // S5-03/R02：偏离检查失败（空输出/解析失败）由服务端显式分类为 failed + code，
  // 不再混在 error 里；未检测（无大纲）不下发条目。
  const DRIFT_LABEL = { ok: '符合', minor: '轻度偏离', major: '严重偏离', failed: '检测失败', error: '检测失败' };

  BookPage.loadOutline = function () {
    const book = A().state.currentBook;
    if (book && $('master-outline')) {
      $('master-outline').value = book.master_outline || '';
    }
    const list = $('drift-results');
    if (list) list.innerHTML = '';
  };

  BookPage.bindOutlineEvents = function () {
    // 保存总纲
    $('btn-save-outline').onclick = async function () {
      try {
        const val = $('master-outline').value.trim();
        await A().api('PUT', '/api/books/' + bid(), { master_outline: val });
        A().state.currentBook.master_outline = val;
        A().toast('总纲已保存');
      } catch (e) { A().toast(e.message); }
    };

    // 全书对齐检查（当前卷批量）
    $('btn-drift-check').onclick = async function () {
      const btn = this;
      btn.disabled = true;
      btn.textContent = '检查中…';
      try {
        const res = await A().api('POST', '/api/books/' + bid() + '/drift-check-all');
        const list = $('drift-results');
        list.innerHTML = (res.results || []).map(r =>
          '<li class="item-row drift-' + r.status + '">' +
          '<span class="drift-badge ' + r.status + '">' + (DRIFT_LABEL[r.status] || r.status) + '</span>' +
          '<span class="item-name" title="' + A().escapeHtml(r.note || '') + '">' +
          A().escapeHtml(r.title) + (r.status !== 'ok' && r.note ? ' — ' + A().escapeHtml(r.note.slice(0, 40)) : '') +
          '</span>' +
          (r.code ? '<span class="drift-code">' + A().escapeHtml(r.code) + '</span>' : '') + '</li>'
        ).join('');
        BookPage.loadChapters(); // 刷新章节列表上的偏离标记
      } catch (e) { A().toast(e.message); }
      finally {
        btn.disabled = false;
        btn.textContent = '全书对齐检查';
      }
    };
  };
})();
