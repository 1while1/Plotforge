// 章节保存冲突对话框（S1-03/C04-B）：服务端 revision 已前进（他窗口/工具已改）时，
// 本地稿与服务端版本的显式二选一。铁律：绝不自动以新 revision 重发旧全文——
// 本地稿原样留在编辑器，复制/比对/重载全部由作者主动点击。
(function () {
  'use strict';

  function countChars(s) {
    return String(s == null ? '' : s).replace(/\s/g, '').length;
  }

  // opts: {
  //   server: { title, content, revision, updated_at },   // GET 到的服务端最新章
  //   local:  { title?, content },                        // 编辑器当前本地稿
  //   onReload: Function(serverChapter)                   // 作者选择「放弃本地稿重载」
  // }
  function show(opts) {
    var App = window.App;
    if (!App || !App.openModal) return;
    var server = opts.server || {};
    var local = opts.local || {};
    var revText = server.revision != null ? String(server.revision) : '?';
    App.openModal({
      title: '章节已在别处被修改',
      bodyHTML:
        '<p class="field-hint">服务端已是第 ' + App.escapeHtml(revText) + ' 版' +
        (server.updated_at ? '（' + App.escapeHtml(String(server.updated_at)) + ' 保存）' : '') +
        '，与编辑器里的本地稿不一致。本地稿已原样保留，两边内容都不会被自动覆盖或重发。</p>' +
        '<p class="field-hint">本地稿约 ' + countChars(local.content) + ' 字 · 服务端约 ' + countChars(server.content) + ' 字。' +
        '可先复制本地稿留底，再对照差异决定去留。</p>' +
        '<div class="conflict-actions">' +
        '<button class="btn btn-outline btn-small" type="button" data-act="copy">复制本地稿</button> ' +
        '<button class="btn btn-outline btn-small" type="button" data-act="diff">查看差异（本地 vs 服务端）</button> ' +
        '<button class="btn btn-outline btn-small" type="button" data-act="reload">放弃本地稿，重载服务端版本</button>' +
        '</div>' +
        '<div class="diff-body conflict-diff" id="conflict-diff" style="display:none;max-height:40vh;overflow:auto;margin-top:8px"></div>',
      okText: '继续编辑本地稿',
      onOk: function () { /* 关闭弹窗即可：本地稿留在编辑器，稍后仍可保存（会再比对版本） */ }
    });
    // #modal-body 只有 id 没有类名（index.html:659），类选择器取不到，必须走 id
    var box = document.querySelector('#modal-body .conflict-actions');
    if (!box) return;
    box.onclick = function (ev) {
      var btn = ev.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'copy') {
        var text = local.content || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { App.toast('本地稿已复制到剪贴板'); },
            function () { App.toast('复制失败，请在编辑器中手动全选复制'); }
          );
        } else {
          App.toast('浏览器不支持剪贴板，请在编辑器中手动全选复制');
        }
      } else if (act === 'diff') {
        var pane = document.getElementById('conflict-diff');
        if (!pane) return;
        if (window.DiffView && typeof window.DiffView._renderDiff === 'function') {
          // 视角：本地稿为“旧”（d-old 删除线），服务端为“新”（d-ins 高亮）
          pane.innerHTML = window.DiffView._renderDiff(local.content || '', server.content || '');
          pane.style.display = '';
          btn.disabled = true;
        } else {
          App.toast('差异组件未加载');
        }
      } else if (act === 'reload') {
        if (typeof opts.onReload === 'function') opts.onReload(server);
        App.closeModal();
      }
    };
  }

  window.ChapterConflict = { show: show };
})();
