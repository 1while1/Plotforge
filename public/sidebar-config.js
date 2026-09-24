(function () {
  'use strict';

  var SidebarConfig = window.SidebarConfig = {};
  var preferences = null;
  var moduleToTab = { chapters: 'chapters', outline: 'outline', ledger: 'state', world: 'world', characters: 'characters' };
  var labels = { chapters: '章节', outline: '大纲', ledger: '故事台账', world: '世界观', characters: '人物' };
  var fields = {
    chapters: { title: '标题', volume: '所属卷', locked: '定稿状态' },
    outline: { mainPlot: '主线摘要', currentVolume: '当前卷', drift: '偏离提醒' },
    ledger: { progress: '进展摘要', pendingCount: '待审提案', openThreadCount: '未结故事线', issueCount: '一致性问题' },
    world: { name: '名称', summary: '简介' },
    characters: { name: '姓名', role: '类型', intro: '简介', location: '位置', goal: '当前目标' }
  };

  function bookId() { return window.App.state.currentBook && window.App.state.currentBook.id; }

  function selectFirstVisible() {
    var active = document.querySelector('.panel-left .tab.active');
    if (active && active.style.display !== 'none') return;
    var next = document.querySelector('.panel-left .tab:not([style*="display: none"])');
    if (next) next.click();
  }

  function apply(value) {
    preferences = value;
    window.App.state.sidebarPreferences = value;
    var tabs = document.querySelector('.panel-left .tabs');
    value.moduleOrder.forEach(function (module) {
      var tabName = moduleToTab[module];
      var button = tabs.querySelector('[data-tab="' + tabName + '"]');
      var pane = document.getElementById('tab-' + tabName);
      var hidden = value.hiddenModules.indexOf(module) !== -1;
      if (button) {
        button.textContent = labels[module];
        button.style.display = hidden ? 'none' : '';
        tabs.appendChild(button);
      }
      if (pane) pane.dataset.summaryFields = (value.summaryFields[module] || []).join(',');
    });
    selectFirstVisible();
    document.dispatchEvent(new CustomEvent('sidebar-preferences-changed', { detail: value }));
  }

  function rowHTML(module, index) {
    var hidden = preferences.hiddenModules.indexOf(module) !== -1;
    var checks = Object.keys(fields[module]).map(function (key) {
      var checked = preferences.summaryFields[module].indexOf(key) !== -1 ? ' checked' : '';
      return '<label class="sidebar-field"><input type="checkbox" data-field="' + key + '"' + checked + '> ' + fields[module][key] + '</label>';
    }).join('');
    return '<section class="sidebar-config-row" data-module="' + module + '">' +
      '<div class="sidebar-config-head"><strong>' + labels[module] + '</strong><span>' +
      '<button class="icon-btn move-up" type="button"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="icon-btn move-down" type="button"' + (index === preferences.moduleOrder.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<label class="visibility-toggle"><input type="checkbox" data-visible' + (!hidden ? ' checked' : '') + (module === 'chapters' ? ' disabled' : '') + '> 显示</label></span></div>' +
      '<div class="sidebar-fields">' + checks + '</div></section>';
  }

  function readModal(body) {
    var order = Array.from(body.querySelectorAll('.sidebar-config-row')).map(function (row) { return row.dataset.module; });
    var hiddenModules = [];
    var summaryFields = {};
    body.querySelectorAll('.sidebar-config-row').forEach(function (row) {
      var module = row.dataset.module;
      var visible = row.querySelector('[data-visible]');
      if (visible && !visible.checked) hiddenModules.push(module);
      summaryFields[module] = Array.from(row.querySelectorAll('[data-field]:checked')).map(function (item) { return item.dataset.field; });
    });
    return { moduleOrder: order, hiddenModules: hiddenModules, summaryFields: summaryFields };
  }

  function bindMoves() {
    var body = document.getElementById('modal-body');
    body.onclick = function (event) {
      var button = event.target.closest('.move-up,.move-down');
      if (!button) return;
      var row = button.closest('.sidebar-config-row');
      if (button.classList.contains('move-up') && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      if (button.classList.contains('move-down') && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    };
  }

  SidebarConfig.open = function () {
    if (!preferences) return;
    window.App.openModal({
      title: '调整写作侧栏',
      okText: '保存布局',
      bodyHTML: '<p class="field-hint">调整模块顺序、显隐和速览字段。章节入口始终保留。</p><div class="sidebar-config-list">' + preferences.moduleOrder.map(rowHTML).join('') + '</div>',
      onOk: async function (body) {
        var data = await window.App.api('PUT', '/api/books/' + encodeURIComponent(bookId()) + '/sidebar-preferences', readModal(body));
        apply(data.preferences);
        window.App.toast('侧栏布局已保存');
      }
    });
    bindMoves();
  };

  SidebarConfig.load = async function () {
    var data = await window.App.api('GET', '/api/books/' + encodeURIComponent(bookId()) + '/sidebar-preferences');
    apply(data.preferences);
  };

  SidebarConfig.bind = function () {
    var button = document.getElementById('btn-sidebar-config');
    if (button) button.onclick = SidebarConfig.open;
    document.querySelectorAll('[data-workbench]').forEach(function (link) {
      link.onclick = function () {
        var module = link.dataset.workbench;
        var id = bookId();
        sessionStorage.setItem('novel-editor-return:' + id, location.hash || '#/book/' + id);
        location.hash = '#/book/' + encodeURIComponent(id) + '/workbench/' + module;
      };
    });
  };
})();
