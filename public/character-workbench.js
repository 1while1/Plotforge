(function () {
  'use strict';

  var CharacterWorkbench = window.CharacterWorkbench = {};
  var state = { route: null, characters: [], selected: null, context: null, showArchived: false, query: '', preferences: null, missingEntityId: null, rosterPager: { page: 1, pageSize: 30, total: 0 } };
  var aliasLabels = { primary: '主名', nickname: '昵称', former_name: '曾用名', title: '称号', pen_name: '化名', other: '其他' };
  var tracker = null; // S4-03：人物档案表单脏编辑（输入即脏；保存成功且期间无新输入才清）

  function api(method, path, body) { return window.App.api(method, '/api/books/' + encodeURIComponent(state.route.bookId) + path, body); }
  function esc(value) { return window.App.escapeHtml(value); }
  function ws() { return window.WorkspaceState; }
  function activeTab() { return ['profile', 'relations', 'timeline', 'advisor'].indexOf(state.route.tab) >= 0 ? state.route.tab : 'profile'; }

  function fieldValue(person, key) {
    if (key === 'name') return person.name;
    if (key === 'role') return person.role || '未分类';
    if (key === 'intro') return person.intro || '暂无简介';
    if (key === 'location' || key === 'goal') return '';
    return '';
  }

  // 角色标签色系：按常见定位词归类，沉稳低饱和；未命中走默认黛蓝
  function roleTagClass(role) {
    if (/主角|主人公/.test(role)) return ' role-lead';
    if (/反派|黑化/.test(role)) return ' role-villain';
    if (/配角|龙套|路人/.test(role)) return ' role-support';
    return '';
  }

  function rosterHTML() {
    var selectedFields = state.preferences && state.preferences.summaryFields.characters || ['name', 'role', 'intro'];
    // 名册前端分页：服务端列表上限 200（无 offset），真实单书人物难越此界；页内切片防堆叠
    var pageItems = window.ListPager ? window.ListPager.slice(state.characters, state.rosterPager) : state.characters;
    var cards = pageItems.map(function (person) {
      var initial = (person.name || '?').trim().charAt(0) || '?';
      var hue = Math.abs(Number(person.id) || 0) % 5;
      var top = '';
      var extra = '';
      selectedFields.forEach(function (field, index) {
        var value = fieldValue(person, field);
        if (!value) return;
        if (index === 0) { top += '<strong class="character-card-name">' + esc(value) + '</strong>'; return; }
        if (field === 'role') { top += '<span class="roster-role-tag' + roleTagClass(value) + '">' + esc(value) + '</span>'; return; }
        extra += '<span class="character-card-' + field + '">' + esc(value) + '</span>';
      });
      return '<button class="character-roster-card' + (state.selected && Number(state.selected.id) === Number(person.id) ? ' active' : '') + '" data-character-id="' + person.id + '">' +
        '<span class="roster-avatar avatar-hue-' + hue + '" aria-hidden="true">' + esc(initial) + '</span>' +
        '<span class="roster-card-main"><span class="roster-card-top">' + top + '</span>' + extra + '</span></button>';
    }).join('');
    return cards || '<div class="roster-empty">没有符合条件的人物</div>';
  }

  function shellHTML() {
    return '<div class="character-hub">' +
      '<aside class="character-roster"><div class="character-roster-head"><div><span class="workbench-kicker">CHARACTERS</span><h2>人物名册</h2></div><button id="character-create" class="btn btn-primary btn-small">+ 新建</button></div>' +
      '<label class="roster-search"><span>⌕</span><input id="character-search" value="' + esc(state.query) + '" placeholder="搜索姓名、别名或简介"></label>' +
      '<label class="roster-archive-toggle"><input id="character-show-archived" type="checkbox"' + (state.showArchived ? ' checked' : '') + '> 查看已归档人物</label>' +
      '<div id="character-roster-list" class="character-roster-list">' + rosterHTML() + '</div><div id="character-roster-pager"></div></aside>' +
      '<section id="character-detail" class="character-detail"></section></div>';
  }

  var RAIL_KEY = 'mozhen-character-rail-collapsed';
  function railCollapsed() { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (e) { return false; } }

  function profileHTML(ctx) {
    var person = ctx.character;
    var aliases = (ctx.aliases || []).map(function (item) {
      return '<span class="alias-chip">' + esc(item.alias) + '<small>' + esc(aliasLabels[item.alias_type] || item.alias_type) + '</small></span>';
    }).join('');
    return '<div class="character-profile-grid' + (railCollapsed() ? ' rail-collapsed' : '') + '"><form id="character-profile-form" class="profile-sheet">' +
      '<div class="profile-sheet-head"><div class="profile-title-wrap"><span class="workbench-kicker">人物档案</span>' +
      '<input class="profile-name-input" name="name" value="' + esc(person.name) + '" required aria-label="姓名" title="点击直接修改姓名"></div></div>' +
      '<label class="field"><span class="field-label">类型</span><input name="role" list="character-role-options" value="' + esc(person.role || '') + '" placeholder="主角、配角、反派…">' +
      '<datalist id="character-role-options"><option value="主角"></option><option value="配角"></option><option value="反派"></option><option value="龙套"></option></datalist></label>' +
      '<label class="field"><span class="field-label">一句话简介</span><textarea name="intro" data-autogrow rows="2" placeholder="这个人是谁，他在故事里承担什么作用">' + esc(person.intro || '') + '</textarea></label>' +
      '<div class="form-grid"><label class="field"><span class="field-label">外貌</span><textarea name="appearance" data-autogrow rows="3">' + esc(person.appearance || '') + '</textarea></label>' +
      '<label class="field"><span class="field-label">性格</span><textarea name="personality" data-autogrow rows="3">' + esc(person.personality || '') + '</textarea></label></div>' +
      '<label class="field"><span class="field-label">背景</span><textarea name="background" data-autogrow rows="4">' + esc(person.background || '') + '</textarea></label>' +
      '<label class="field"><span class="field-label">创作备注</span><textarea name="note" data-autogrow rows="3">' + esc(person.note || '') + '</textarea></label>' +
      '<div class="profile-save-bar"><button id="archive-character" class="btn btn-ghost" type="button">' + (person.archived_at ? '恢复人物' : '归档人物') + '</button>' +
      '<span class="save-bar-right"><span id="profile-save-state" class="save-state">已保存</span><button class="btn btn-primary" type="submit">保存档案</button></span></div></form>' +
      '<aside class="character-context-rail"><button id="rail-toggle" class="rail-toggle" type="button" title="' + (railCollapsed() ? '展开资料栏' : '收起资料栏') + '">' + (railCollapsed() ? '«' : '»') + '</button>' +
      '<div class="rail-body"><section class="context-card"><div class="context-card-head"><h3>别名与称号</h3><button id="edit-aliases" class="btn btn-ghost btn-small">编辑</button></div><div class="alias-list">' + (aliases || '<span class="muted">暂无别名</span>') + '</div></section>' +
      '<section class="context-card"><h3>创作概况</h3><dl class="metric-list"><div><dt>关系</dt><dd>' + ctx.relation_summary.active + ' 条活跃</dd></div><div><dt>事件</dt><dd>' + ctx.timeline_summary.events + ' 条</dd></div><div><dt>故事线</dt><dd>' + ctx.thread_summary.open + ' 条未结</dd></div></dl></section></div></aside></div>';
  }

  function relationOther(relation) {
    return Number(relation.endpoint_a.id) === Number(state.selected.id) ? relation.endpoint_b : relation.endpoint_a;
  }

  function relationsHTML(relations) {
    var rows = relations.map(function (relation) {
      var other = relationOther(relation);
      return '<article class="relation-list-row"><div><strong>' + esc(other.name) + '</strong><span>' + esc(relation.relation_type.label_from_focus) + ' · 强度 ' + relation.strength + '/5</span><small>' + esc(relation.note || '暂无关系备注') + '</small></div><div><span class="relation-badge ' + esc(relation.polarity) + '">' + esc(relation.lifecycle) + (relation.secrecy === 'secret' ? ' · 秘密' : '') + '</span><button class="btn btn-ghost btn-small edit-relation" data-relation="' + esc(relation.public_id) + '">编辑</button></div></article>';
    }).join('');
    return '<div class="relations-workspace"><div class="relations-toolbar"><div><span class="workbench-kicker">RELATION MAP</span><h2>' + esc(state.selected.name) + '的人物关系</h2></div><button id="add-relation" class="btn btn-primary">+ 添加关系</button></div>' +
      '<div class="relation-view-switch"><button class="active" data-relation-view="map">关系图</button><button data-relation-view="list">关系列表</button></div>' +
      '<div id="relation-map-panel" class="relation-map-panel"></div><div id="relation-list-panel" class="relation-list-panel hidden">' + (rows || '<div class="workbench-empty-card">还没有关系。添加第一条关系，让人物网络开始生长。</div>') + '</div></div>';
  }

  function renderDetail() {
    var detail = document.getElementById('character-detail');
    if (!state.selected) {
      // 指定的对象已不在本书（被删/被移走）：明确空态，绝不自动落到名册里的其他人物
      detail.innerHTML = state.missingEntityId
        ? '<section class="workbench-empty" data-character-missing="' + esc(state.missingEntityId) + '"><h2>这个人物已不在本书中</h2><p>它可能已被删除（#' + esc(state.missingEntityId) + '）。未自动切换到其他人物或别的书；可从左侧名册另选一位。</p></section>'
        : '<section class="workbench-empty"><h2>选择一个人物</h2><p>从左侧名册进入档案、关系与时间线。</p></section>';
      return;
    }
    var tab = activeTab();
    var person = state.selected;
    detail.innerHTML = '<header class="character-detail-nav"><div><strong>' + esc(person.name) + '</strong><span>' + esc(person.role || '未分类') + '</span></div><nav>' +
      '<button data-character-tab="profile" class="' + (tab === 'profile' ? 'active' : '') + '">档案</button>' +
      '<button data-character-tab="relations" class="' + (tab === 'relations' ? 'active' : '') + '">关系</button>' +
      '<button data-character-tab="timeline" class="' + (tab === 'timeline' ? 'active' : '') + '">时间线</button>' +
      '<button data-character-tab="advisor" class="' + (tab === 'advisor' ? 'active' : '') + '">人物顾问</button></nav></header>' +
      '<div id="character-tab-content" class="character-tab-content"><div class="workbench-loading">正在加载…</div></div>';
    bindDetailNav();
    if (tab === 'relations') loadRelations();
    else if (tab === 'timeline' && window.CharacterTimeline) window.CharacterTimeline.show(state.route, state.selected);
    else if (tab === 'advisor' && window.CharacterAdvisor) window.CharacterAdvisor.show(state.route, state.selected);
    else loadProfile();
  }

  function bindDetailNav() {
    document.querySelectorAll('[data-character-tab]').forEach(function (button) {
      button.onclick = function () {
        var tab = button.dataset.characterTab;
        location.hash = '#/book/' + state.route.bookId + '/workbench/characters/' + state.selected.id + '?tab=' + tab;
      };
    });
  }

  async function loadProfile() {
    var bookId = String(state.route.bookId);
    var characterId = state.selected ? String(state.selected.id) : '';
    var target = bookId + '|' + characterId;
    var token = ws() && ws().beginRequest ? ws().beginRequest('character-profile', target) : null;
    var ctx = await api('GET', '/characters/' + state.selected.id);
    // 切人物或切书后晚到的档案：token 与书/人物双绑，过期即丢弃（不把 A 的档案画到 B 上）
    if (!state.selected || String(state.selected.id) !== characterId) return;
    if (String(state.route.bookId) !== bookId) return;
    if (token && !ws().isCurrent(token, target)) return;
    state.context = ctx;
    state.selected = ctx.character;
    document.getElementById('character-tab-content').innerHTML = profileHTML(ctx);
    bindProfile();
  }

  function profilePayload(form) {
    var data = new FormData(form);
    return ['name', 'role', 'intro', 'appearance', 'personality', 'background', 'note'].reduce(function (out, key) { out[key] = data.get(key) || ''; return out; }, {});
  }

  function setSaveState(dirty) {
    var el = document.getElementById('profile-save-state');
    if (!el) return;
    el.textContent = dirty ? '有未保存的修改' : '已保存';
    el.classList.toggle('dirty', !!dirty);
  }

  // 保存人物档案：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示
  async function saveProfile() {
    if (!state.selected) return !tracker || !tracker.isDirty();
    if (!tracker) return true;
    var form = document.getElementById('character-profile-form');
    if (!form) return !tracker.isDirty();
    var snapshot = tracker.snapshot();
    var result;
    try { result = await api('PATCH', '/characters/' + state.selected.id, profilePayload(form)); }
    catch (e) {
      window.App.toast('保存失败（人物档案未保存）：' + e.message + '，修改仍留在表单里');
      return false;
    }
    if (!tracker.settle(snapshot, true)) {
      setSaveState(true);
      window.App.toast('保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库');
      return false;
    }
    state.selected = result.character;
    await loadCharacters(false);
    setSaveState(false);
    window.App.toast('人物档案已保存');
    return true;
  }

  function installGuard() {
    if (!ws() || !ws().registerGuard) return;
    if (!tracker) tracker = ws().dirtyTracker();
    ws().clearGuards(function (g) { return g.key === 'characters'; });
    ws().registerGuard({
      key: 'characters',
      label: '人物工作台',
      isDirty: function () { return !!tracker && tracker.isDirty(); },
      save: saveProfile,
      discard: function () { if (tracker) tracker.clear(); },
    });
  }

  // 文本域随内容长高，封顶约 40vh 后转内部滚动（去掉手拖三角）
  function autogrow(el) {
    el.style.height = 'auto';
    var max = Math.max(120, Math.round(window.innerHeight * 0.4));
    var need = el.scrollHeight + 4;
    el.style.height = Math.min(need, max) + 'px';
    el.style.overflowY = need > max ? 'auto' : 'hidden';
  }
  function autogrowAll() {
    document.querySelectorAll('.profile-sheet textarea[data-autogrow]').forEach(autogrow);
  }
  window.addEventListener('resize', autogrowAll); // 视口变化时 40vh 上限会变，全局重算一次

  function bindProfile() {
    var form = document.getElementById('character-profile-form');
    if (form) {
      form.onsubmit = async function (event) { event.preventDefault(); await saveProfile(); };
      var fields = form.querySelectorAll('input[name],textarea[name]');
      for (var i = 0; i < fields.length; i++) {
        fields[i].addEventListener('input', function () { if (tracker) tracker.mark(); setSaveState(true); });
      }
      var areas = form.querySelectorAll('textarea[data-autogrow]');
      for (var j = 0; j < areas.length; j++) {
        autogrow(areas[j]);
        areas[j].addEventListener('input', function () { autogrow(this); });
      }
      // 网络字体就绪后文字可能换行变化，届时重算一轮高度
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(autogrowAll);
    }
    var railToggle = document.getElementById('rail-toggle');
    if (railToggle) {
      railToggle.onclick = function () {
        var grid = document.querySelector('.character-profile-grid');
        if (!grid) return;
        var collapsed = !grid.classList.contains('rail-collapsed');
        grid.classList.toggle('rail-collapsed', collapsed);
        railToggle.textContent = collapsed ? '«' : '»';
        railToggle.title = collapsed ? '展开资料栏' : '收起资料栏';
        try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch (e) { /* 私密模式下不持久化也能用 */ }
      };
    }
    document.getElementById('edit-aliases').onclick = editAliases;
    document.getElementById('archive-character').onclick = async function () {
      var action = state.selected.archived_at ? 'unarchive' : 'archive';
      await api('POST', '/characters/' + state.selected.id + '/' + action, {});
      state.showArchived = action === 'archive';
      await loadCharacters(true);
      window.App.toast(action === 'archive' ? '人物已归档' : '人物已恢复');
    };
  }

  function editAliases() {
    var extras = state.context.aliases.filter(function (item) { return !item.is_primary; });
    var rows = extras.map(function (item) { return item.alias + '|' + item.alias_type; }).join('\n');
    window.App.openModal({
      title: '编辑别名与称号', okText: '保存别名',
      bodyHTML: '<p class="field-hint">每行一个，格式：别名|类型。类型可用 nickname、former_name、title、pen_name、other。</p><textarea id="alias-editor" class="outline-textarea" rows="9">' + esc(rows) + '</textarea>',
      onOk: async function (body) {
        var aliases = [{ alias: state.selected.name, alias_type: 'primary', is_primary: true }];
        body.querySelector('#alias-editor').value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).forEach(function (line) {
          var parts = line.split('|'); aliases.push({ alias: parts[0].trim(), alias_type: (parts[1] || 'other').trim(), is_primary: false });
        });
        state.context = await api('PUT', '/characters/' + state.selected.id + '/aliases', { aliases: aliases });
        await loadProfile();
        window.App.toast('别名已保存');
      }
    });
  }

  async function loadRelations() {
    var response = await api('GET', '/characters/' + state.selected.id + '/relations?secrecy=all&lifecycle=all');
    var relations = response.items || [];
    document.getElementById('character-tab-content').innerHTML = relationsHTML(relations);
    window.CharacterRelations.renderSVG(document.getElementById('relation-map-panel'), state.selected, relations);
    document.querySelectorAll('[data-relation-view]').forEach(function (button) {
      button.onclick = function () {
        document.querySelectorAll('[data-relation-view]').forEach(function (item) { item.classList.toggle('active', item === button); });
        document.getElementById('relation-map-panel').classList.toggle('hidden', button.dataset.relationView !== 'map');
        document.getElementById('relation-list-panel').classList.toggle('hidden', button.dataset.relationView !== 'list');
      };
    });
    document.getElementById('add-relation').onclick = function () { openRelationModal(null); };
    document.querySelectorAll('.edit-relation').forEach(function (button) {
      button.onclick = function () { openRelationModal(relations.find(function (item) { return item.public_id === button.dataset.relation; })); };
    });
  }

  async function openRelationModal(existing) {
    var results = await Promise.all([api('GET', '/characters?limit=200'), api('GET', '/relation-types')]);
    var people = results[0].items.filter(function (item) { return Number(item.id) !== Number(state.selected.id); });
    var types = results[1].items;
    var other = existing ? relationOther(existing) : people[0];
    var options = people.map(function (item) { return '<option value="' + item.id + '"' + (other && Number(item.id) === Number(other.id) ? ' selected' : '') + '>' + esc(item.name) + '</option>'; }).join('');
    // 对方已归档时不在候选列表（默认过滤归档），补回一项并选中，避免 select 静默落到第一个人、保存即错改关系对象
    if (other && !people.some(function (item) { return Number(item.id) === Number(other.id); })) {
      options = '<option value="' + other.id + '" selected>' + esc(other.name) + '（已归档）</option>' + options;
    }
    var typeOptions = types.map(function (item) { return '<option value="' + item.id + '"' + (existing && Number(item.id) === Number(existing.relation_type.id) ? ' selected' : '') + '>' + esc(item.forward_label) + ' / ' + esc(item.reverse_label) + '</option>'; }).join('');
    if (!people.length) { window.App.toast('至少需要两个人物才能建立关系'); return; }
    window.App.openModal({
      title: existing ? '编辑人物关系' : '添加人物关系', okText: existing ? '记录变化' : '建立关系',
      bodyHTML: '<div class="form-grid"><label>关系对象<select id="relation-other">' + options + '</select></label><label>关系类型<select id="relation-type">' + typeOptions + '</select></label></div>' +
        '<div class="form-grid"><label>方向<select id="relation-direction"><option value="both">双向</option><option value="a_to_b">我 → 对方</option><option value="b_to_a">对方 → 我</option><option value="none">无方向</option></select></label><label>强度<input id="relation-strength" type="range" min="1" max="5" value="' + (existing ? existing.strength : 3) + '"></label></div>' +
        '<div class="form-grid"><label>倾向<select id="relation-polarity"><option value="positive">正向</option><option value="neutral">中性</option><option value="negative">负向</option><option value="mixed">复杂</option></select></label><label>状态<select id="relation-lifecycle"><option value="active">活跃</option><option value="dormant">潜伏</option><option value="ended">结束</option></select></label></div>' +
        '<label class="visibility-toggle"><input id="relation-secret" type="checkbox"' + (existing && existing.secrecy === 'secret' ? ' checked' : '') + '> 秘密关系</label><label>关系备注<textarea id="relation-note" rows="4">' + esc(existing && existing.note || '') + '</textarea></label>',
      onOk: async function (body) {
        var relation = {
          public_id: existing && existing.public_id,
          character_a_id: state.selected.id,
          character_b_id: Number(body.querySelector('#relation-other').value),
          relation_type_id: Number(body.querySelector('#relation-type').value),
          direction: body.querySelector('#relation-direction').value,
          strength: Number(body.querySelector('#relation-strength').value),
          polarity: body.querySelector('#relation-polarity').value,
          lifecycle: body.querySelector('#relation-lifecycle').value,
          secrecy: body.querySelector('#relation-secret').checked ? 'secret' : 'public',
          note: body.querySelector('#relation-note').value
        };
        await api('POST', '/relations/changes', { event: { title: '更新人物关系：' + state.selected.name }, relation: relation });
        await loadRelations();
        window.App.toast('关系变化已记入故事台账');
      }
    });
    if (existing) {
      document.getElementById('relation-direction').value = existing.direction;
      document.getElementById('relation-polarity').value = existing.polarity;
      document.getElementById('relation-lifecycle').value = existing.lifecycle;
    }
  }

  function openCreate() {
    window.App.openModal({
      title: '新建人物', okText: '创建人物',
      bodyHTML: '<div class="form-grid"><label>姓名<input id="new-character-name" required></label><label>类型<input id="new-character-role" placeholder="主角、配角…"></label></div><label>简介<textarea id="new-character-intro" rows="4"></textarea></label>',
      onOk: async function (body) {
        var name = body.querySelector('#new-character-name').value.trim();
        if (!name) { window.App.toast('请填写人物姓名'); return false; }
        var result = await api('POST', '/characters', { name: name, role: body.querySelector('#new-character-role').value, intro: body.querySelector('#new-character-intro').value });
        state.showArchived = false;
        location.hash = '#/book/' + state.route.bookId + '/workbench/characters/' + result.character.id + '?tab=profile';
      }
    });
  }

  function bindRoster() {
    document.getElementById('character-create').onclick = openCreate;
    document.getElementById('character-show-archived').onchange = async function () { state.showArchived = this.checked; state.rosterPager.page = 1; await loadCharacters(true); };
    var timer;
    document.getElementById('character-search').oninput = function () {
      state.query = this.value; state.rosterPager.page = 1;
      clearTimeout(timer); timer = setTimeout(function () { loadCharacters(true); }, 220);
    };
    document.querySelectorAll('[data-character-id]').forEach(function (button) {
      button.onclick = function () { location.hash = '#/book/' + state.route.bookId + '/workbench/characters/' + button.dataset.characterId + '?tab=' + activeTab(); };
    });
    if (window.ListPager) window.ListPager.bind(document.getElementById('character-roster-pager'), state.rosterPager, renderRoster);
  }

  // 只重绘名册列表与分页条：不动搜索框（中文输入法组合中重绘会断字）
  function renderRoster() {
    var list = document.getElementById('character-roster-list');
    if (!list) return;
    list.innerHTML = rosterHTML();
    var pager = document.getElementById('character-roster-pager');
    if (pager && window.ListPager) pager.innerHTML = window.ListPager.html(state.rosterPager, '人');
    bindRoster();
  }

  async function loadCharacters(keepSelection) {
    var bookId = String(state.route.bookId);
    var entityId = state.route.entityId == null ? '' : String(state.route.entityId);
    var target = bookId + '|' + entityId;
    var token = ws() && ws().beginRequest ? ws().beginRequest('characters', target) : null;
    var suffix = '?limit=200' + (state.showArchived ? '&archived=true' : '') + (state.query ? '&q=' + encodeURIComponent(state.query) : '');
    var response = await api('GET', '/characters' + suffix);
    // 切书后晚到的名册：token 与书/目标对象双绑，过期即丢弃（不跨书回写）
    if (String(state.route.bookId) !== bookId) return;
    if (token && !ws().isCurrent(token, target)) return;
    state.characters = response.items || [];
    if (!keepSelection || !state.selected) {
      var requested = state.characters.find(function (person) { return String(person.id) === String(state.route.entityId); });
      var current = state.selected && state.characters.find(function (person) { return String(person.id) === String(state.selected.id); });
      // 指定的对象已不在本书：明确空态，绝不落到名册第一个人
      state.missingEntityId = (!requested && !current && state.route.entityId) ? String(state.route.entityId) : null;
      state.selected = requested || current || (state.route.entityId ? null : (state.characters[0] || null));
    } else {
      state.selected = state.characters.find(function (person) { return Number(person.id) === Number(state.selected.id); }) || state.selected;
    }
    var list = document.getElementById('character-roster-list');
    if (list) renderRoster();
    if (keepSelection) renderDetail();
  }

  CharacterWorkbench.show = async function (route) {
    state.route = route;
    state.selected = null;
    state.missingEntityId = null;
    state.rosterPager.page = 1;
    document.getElementById('workbench-content').innerHTML = shellHTML();
    bindRoster();
    installGuard(); // 表单可能马上就能编辑：守卫先注册，离开保护不留空窗
    try {
      var pref = await api('GET', '/sidebar-preferences');
      state.preferences = pref.preferences;
      await loadCharacters(false);
      renderRoster();
      renderDetail();
    } catch (error) {
      document.getElementById('character-detail').innerHTML = '<div class="workbench-error">' + esc(error.message) + '</div>';
    }
  };
})();
