// 状态簿 tab：查看/手改人物状态、未回收伏笔、全书进展摘要
(function () {
  'use strict';
  const BookPage = window.BookPage = window.BookPage || {};

  function $(id) { return document.getElementById(id); }
  function A() { return window.App; }
  function bid() { return A().state.currentBook.id; }

  const KINDS = ['characters', 'foreshadowing', 'book_summary'];
  // book_summary 的元素 id 用连字符
  function elId(kind) { return 'state-' + kind.replace(/_/g, '-'); }

  BookPage.loadState = async function () {
    try {
      const res = await A().api('GET', '/api/books/' + bid() + '/state');
      const states = res.states || {};
      for (const kind of KINDS) {
        const s = states[kind] || { content: '', updated_at: null };
        $(elId(kind)).value = s.content || '';
        $(elId(kind) + '-time').textContent = s.updated_at ? '更新于 ' + String(s.updated_at).slice(5, 16) : '';
      }
    } catch (e) { A().toast(e.message); }
  };

  BookPage.bindStateEvents = function () {
    $('btn-save-state').onclick = async function () {
      try {
        const payload = {};
        for (const kind of KINDS) payload[kind] = $(elId(kind)).value;
        await A().api('PUT', '/api/books/' + bid() + '/state', payload);
        A().toast('状态簿已保存');
        await BookPage.loadState();
      } catch (e) { A().toast(e.message); }
    };
  };
})();
