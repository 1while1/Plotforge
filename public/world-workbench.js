(function () {
  'use strict';
  var WorldWorkbench = window.WorldWorkbench = {};
  var state = { route: null, entries: [], selected: null, query: '', missingEntityId: null, pager: { page: 1, pageSize: 30, total: 0 } };
  var tracker = null; // S4-03：表单脏编辑（输入即脏；保存成功且期间无新输入才清）
  function esc(v) { return window.App.escapeHtml(v); }
  function ws() { return window.WorkspaceState; }
  function api(method, path, body) { return window.App.api(method, '/api/books/' + state.route.bookId + '/world' + path, body); }
  // 已删除/不在本书的设定：明确空态，绝不自动切到别的条目或别的书
  function missingHTML() {
    return '<section class="workbench-empty" data-world-missing="' + esc(state.missingEntityId) + '"><h2>这条设定已不在本书中</h2><p>它可能已被删除（#' + esc(state.missingEntityId) + '）。未自动切换到其他设定或别的书；可从左侧目录选一条继续编辑。</p></section>';
  }
  function trackInput(node) { if (node) node.addEventListener('input', function () { if (tracker) tracker.mark(); }); }
  function filtered() { var q = (state.query || '').toLowerCase(); return state.entries.filter(function (e) { return !q || ((e.title || '') + ' ' + (e.content || '')).toLowerCase().indexOf(q) >= 0; }); }
  function listHTML() { var items = filtered(); var pageItems = window.ListPager ? window.ListPager.slice(items, state.pager) : items; return pageItems.map(function (entry) { return '<button data-world-id="' + entry.id + '" class="world-entry-row' + (state.selected && entry.id === state.selected.id ? ' active' : '') + '"><strong>' + esc(entry.title) + '</strong><span>' + esc((entry.content || '').slice(0, 60) || '暂无内容') + '</span></button>'; }).join(''); }
  function render() {
    var root = document.getElementById('workbench-content');
    root.innerHTML = '<div class="world-workspace"><aside class="world-index"><div class="character-roster-head"><div><span class="workbench-kicker">WORLD BIBLE</span><h2>设定目录</h2></div><button id="new-world-entry" class="btn btn-primary btn-small">+ 新建</button></div><label class="roster-search"><span>⌕</span><input id="world-search" value="' + esc(state.query) + '" placeholder="搜索设定"></label><div id="world-entry-list">' + listHTML() + '</div><div id="world-entry-pager">' + (window.ListPager ? window.ListPager.html(state.pager) : '') + '</div></aside><section class="world-editor">' + (state.missingEntityId ? missingHTML() : (state.selected ? '<form id="world-entry-form"><div class="profile-sheet-head"><div><span class="workbench-kicker">SETTING ENTRY</span><h2>' + esc(state.selected.title) + '</h2></div><div><button id="delete-world-entry" type="button" class="btn btn-ghost">删除</button><button class="btn btn-primary">保存设定</button></div></div><label>名称<input id="world-entry-title" value="' + esc(state.selected.title) + '"></label><label>详细设定<textarea id="world-entry-content" rows="24">' + esc(state.selected.content || '') + '</textarea></label></form>' : '<section class="workbench-empty"><h2>选择一条设定</h2><p>在这里维护规则、地点、势力、物件与历史。</p></section>')) + '</section></div>';
    bind();
  }
  // 只重绘目录列表与分页条，不动搜索输入框：搜索时整块重渲染会替换 input 元素，
  // 中文输入法组合中的拼音候选被强制上屏/断字。
  function renderList() {
    var list = document.getElementById('world-entry-list');
    if (!list) return;
    list.innerHTML = listHTML();
    var pager = document.getElementById('world-entry-pager');
    if (pager && window.ListPager) pager.innerHTML = window.ListPager.html(state.pager);
    bindList();
  }
  function bindList() {
    document.querySelectorAll('[data-world-id]').forEach(function (b) { b.onclick = function () { state.selected = state.entries.find(function (e) { return String(e.id) === b.dataset.worldId; }); render(); }; });
    if (window.ListPager) window.ListPager.bind(document.getElementById('world-entry-pager'), state.pager, renderList);
  }
  function bind() {
    document.getElementById('new-world-entry').onclick = function () { window.App.openModal({ title: '新建设定', okText: '创建', bodyHTML: '<label>名称<input id="new-world-title"></label>', onOk: async function (body) { var res = await api('POST', '', { title: body.querySelector('#new-world-title').value, content: '' }); if (tracker) tracker.clear(); await load(res.entry.id); } }); };
    document.getElementById('world-search').oninput = function () { state.query = this.value; state.pager.page = 1; renderList(); };
    bindList();
    var form = document.getElementById('world-entry-form');
    if (form) {
      form.onsubmit = async function (event) { event.preventDefault(); await saveEntry(); };
      trackInput(document.getElementById('world-entry-title'));
      trackInput(document.getElementById('world-entry-content'));
    }
    var del = document.getElementById('delete-world-entry'); if (del) del.onclick = async function () { if (!confirm('删除这条世界设定？')) return; await api('DELETE', '/' + state.selected.id); if (tracker) tracker.clear(); await load(null); };
  }

  // 保存当前设定：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示
  async function saveEntry() {
    if (!state.selected) return !tracker || !tracker.isDirty();
    if (!tracker) return true;
    var snapshot = tracker.snapshot();
    var body = { title: document.getElementById('world-entry-title').value, content: document.getElementById('world-entry-content').value };
    var res;
    try { res = await api('PUT', '/' + state.selected.id, body); }
    catch (e) {
      window.App.toast('保存失败（世界设定未保存）：' + e.message + '，修改仍留在表单里');
      return false;
    }
    if (!tracker.settle(snapshot, true)) {
      window.App.toast('保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库');
      return false;
    }
    state.selected = res.entry;
    await load(res.entry.id);
    window.App.toast('世界设定已保存');
    return true;
  }

  function installGuard() {
    if (!ws() || !ws().registerGuard) return;
    if (!tracker) tracker = ws().dirtyTracker();
    ws().clearGuards(function (g) { return g.key === 'world'; });
    ws().registerGuard({
      key: 'world',
      label: '世界观工作台',
      isDirty: function () { return !!tracker && tracker.isDirty(); },
      save: saveEntry,
      discard: function () { if (tracker) tracker.clear(); },
    });
  }

  async function load(selectId) {
    var bookId = String(state.route.bookId);
    var hasTarget = selectId !== null && selectId !== undefined && selectId !== '';
    var target = bookId + '|' + (hasTarget ? String(selectId) : '');
    var token = ws() && ws().beginRequest ? ws().beginRequest('world', target) : null;
    var res = await api('GET', '');
    // 切书或切对象后晚到的响应：token 与书/对象双绑，过期即丢弃（不跨书回写）
    if (String(state.route.bookId) !== bookId) return;
    if (token && !ws().isCurrent(token, target)) return;
    state.entries = res.entries || [];
    if (hasTarget) {
      state.selected = state.entries.find(function (e) { return String(e.id) === String(selectId); }) || null;
      state.missingEntityId = state.selected ? null : String(selectId);
    } else {
      state.selected = state.entries[0] || null;
      state.missingEntityId = null;
    }
    if (tracker) tracker.clear(); // 已按服务端内容重渲染：旧草稿不再存在，脏标记必须同步归零
    render();
  }
  WorldWorkbench.show = function (route) {
    state.route = route;
    state.missingEntityId = null;
    state.pager.page = 1;
    installGuard();
    load(route.entityId).catch(function (e) { document.getElementById('workbench-content').innerHTML = '<div class="workbench-error">' + esc(e.message) + '</div>'; });
  };
})();
