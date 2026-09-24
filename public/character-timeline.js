(function () {
  'use strict';
  var CharacterTimeline = window.CharacterTimeline = {};

  var IMPORTANCE_LABEL = { low: '低', normal: '普通', high: '高', critical: '关键' };
  var ORIGIN_LABEL = { manual: '手动', proposal: '提案', advisor: '顾问', import: '导入' };
  var POLARITY_LABEL = { positive: '正向', neutral: '中性', negative: '负向', mixed: '复杂' };
  var LIFECYCLE_LABEL = { active: '活跃', dormant: '潜伏', ended: '结束' };

  // 渲染上下文：路由、当前人物、字段定义与当前状态缓存，供卡片渲染与弹窗处理器共用
  var ctx = { route: null, person: null, mode: 'embedded', fieldDefs: [], fieldByKey: {}, stateByKey: {}, eventsById: {}, eventList: [], stateList: [], pendingList: [] };

  function esc(v) { return window.App.escapeHtml(v); }
  function base() { return '/api/books/' + encodeURIComponent(ctx.route.bookId); }
  function api(method, path, body) { return window.App.api(method, base() + path, body); }
  function toast(msg) { window.App.toast(msg); }
  function relationsHash() { return '#/book/' + ctx.route.bookId + '/workbench/characters/' + ctx.person.id + '?tab=relations'; }
  function proposalsHash() { return '#/book/' + ctx.route.bookId + '/workbench/ledger?tab=proposals'; }
  function fullPageHash() { return '#/book/' + ctx.route.bookId + '/characters/' + ctx.person.id + '/timeline'; }

  function fieldDef(fieldKey) { return ctx.fieldByKey[fieldKey] || null; }
  function fieldLabel(fieldKey) { var d = fieldDef(fieldKey); return d ? d.label : fieldKey; }
  function fieldValueType(fieldKey) { var d = fieldDef(fieldKey); return d ? d.value_type : 'text'; }
  function currentStateValue(fieldKey) { var s = ctx.stateByKey[fieldKey]; return s ? s.value : null; }

  // 值格式化：null/空→未记录；数组→顿号连接；对象→JSON；其余→字符串
  function formatValue(valueType, value) {
    if (value === null || value === undefined || value === '') return '未记录';
    if (Array.isArray(value)) {
      if (!value.length) return '未记录';
      return value.map(function (v) { return (v && typeof v === 'object') ? JSON.stringify(v) : String(v); }).join('、');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  // 一条变化是否与当前人物相关：状态变化看 subject_ref；关系变化看快照端点
  function isRelevantChange(change) {
    if (!change) return false;
    if (change.change_kind === 'character_state') return String(change.subject_ref) === String(ctx.person.id);
    if (change.change_kind === 'relation') {
      var vals = [change.new_value, change.old_value];
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (v && (Number(v.endpoint_a) === Number(ctx.person.id) || Number(v.endpoint_b) === Number(ctx.person.id))) return true;
      }
    }
    return false;
  }

  function changeHTML(change) {
    if (change.change_kind === 'relation') {
      var snap = change.new_value || change.old_value || {};
      var meta = [snap.strength ? ('强度 ' + snap.strength + '/5') : '', POLARITY_LABEL[snap.polarity] || snap.polarity || '', LIFECYCLE_LABEL[snap.lifecycle] || snap.lifecycle || ''].filter(Boolean).join(' · ');
      return '<div class="timeline-change timeline-change-relation">' +
        '<span class="timeline-change-kind">关系变化</span>' +
        '<span class="timeline-change-body">' + esc(meta || '关系已更新') + '</span>' +
        '<a class="btn btn-ghost btn-small timeline-rel-jump" href="' + relationsHash() + '">去关系 tab</a>' +
        '</div>';
    }
    var vt = fieldValueType(change.field_key);
    return '<div class="timeline-change">' +
      '<span class="timeline-change-field">' + esc(fieldLabel(change.field_key)) + '</span>' +
      '<span class="timeline-change-old">' + esc(formatValue(vt, change.old_value)) + '</span>' +
      '<span class="timeline-change-arrow">→</span>' +
      '<span class="timeline-change-new">' + esc(formatValue(vt, change.new_value)) + '</span>' +
      '</div>';
  }

  function renderEvent(event) {
    var badges = [];
    badges.push('<span class="tl-badge tl-badge-chapter">' + esc(event.chapter_title || '未绑定章节') + '</span>');
    badges.push('<span class="tl-badge tl-importance-' + esc(event.importance || 'normal') + '">' + esc(IMPORTANCE_LABEL[event.importance] || event.importance || '普通') + '</span>');
    badges.push('<span class="tl-badge tl-badge-origin">来源·' + esc(ORIGIN_LABEL[event.origin] || event.origin || '手动') + '</span>');
    if (event.source_stale) badges.push('<span class="tl-badge tl-badge-stale" title="来源正文已改动，依据可能过期">⚠ 依据已失效</span>');

    var changes = (event.changes || []).filter(isRelevantChange);
    var changesHTML = changes.map(changeHTML).join('') || '<div class="timeline-change-empty">该事件未包含与该人物直接相关的可显示变化</div>';
    var summaryHTML = event.summary ? '<p class="timeline-summary">' + esc(event.summary) + '</p>' : '';
    var sourceBtn = (event.source_quote && event.chapter_id)
      ? '<button class="btn btn-ghost btn-small timeline-source-btn" data-source="' + event.id + '">📖 原文依据</button>' : '';

    return '<article class="timeline-event' + (event.source_stale ? ' is-stale' : '') + '">' +
      '<div class="timeline-dot"></div>' +
      '<div class="timeline-event-body">' +
        '<div class="timeline-badges">' + badges.join('') + '</div>' +
        '<h3>' + esc(event.title) + '</h3>' + summaryHTML +
        '<div class="timeline-changes">' + changesHTML + '</div>' +
        '<div class="timeline-event-actions">' + sourceBtn +
          '<button class="btn btn-ghost btn-small timeline-edit-btn" data-edit="' + event.id + '">编辑</button>' +
        '</div>' +
      '</div></article>';
  }

  function bindTimeline(root) {
    var addBtn = root.querySelector('#timeline-add-event');
    if (addBtn) addBtn.onclick = function () { openEventModal(null); };
    root.querySelectorAll('[data-source]').forEach(function (b) { b.onclick = function () { openSourcePreview(ctx.eventsById[b.dataset.source]); }; });
    root.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openEventModal(ctx.eventsById[b.dataset.edit]); }; });
    root.querySelectorAll('.tl-volume-head').forEach(function (head) {
      head.onclick = function () {
        var sec = head.closest ? head.closest('.tl-volume') : head.parentNode;
        if (sec && sec.classList) {
          sec.classList.toggle('collapsed');
          head.setAttribute('aria-expanded', sec.classList.contains('collapsed') ? 'false' : 'true');
        }
      };
    });
  }

  // 按分卷分组（events 已是后端修正后的时序：卷序→卷内章序→id）；无卷/孤儿卷归入「未分卷」
  function groupEventsByVolume(events) {
    var groups = [], byKey = {};
    (events || []).forEach(function (ev) {
      var hasVol = ev.volume_id !== null && ev.volume_id !== undefined && ev.volume_title;
      var key = hasVol ? ('v' + ev.volume_id) : 'none';
      if (!byKey[key]) {
        var vs = ev.volume_sort_order;
        byKey[key] = {
          key: key,
          volumeId: hasVol ? ev.volume_id : null,
          volumeTitle: hasVol ? ev.volume_title : '未分卷',
          volumeSortOrder: hasVol ? (vs === null || vs === undefined ? 0 : Number(vs)) : Number.MAX_SAFE_INTEGER,
          events: []
        };
        groups.push(byKey[key]);
      }
      byKey[key].events.push(ev);
    });
    return groups;
  }

  // 最新卷 = 真实分卷中 volume_sort_order 最大者；若无真实分卷则取第一组
  function findLatestVolumeKey(groups) {
    var latestKey = null, latestSort = -Infinity;
    groups.forEach(function (g) {
      if (g.volumeId !== null && g.volumeSortOrder > latestSort) { latestSort = g.volumeSortOrder; latestKey = g.key; }
    });
    if (latestKey === null && groups.length) latestKey = groups[0].key;
    return latestKey;
  }

  function renderVolumeGroup(group, expanded) {
    var eventsHTML = group.events.map(renderEvent).join('');
    return '<section class="tl-volume' + (expanded ? '' : ' collapsed') + '">' +
      '<button type="button" class="tl-volume-head" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
        '<span class="tl-volume-chevron">▾</span>' +
        '<span class="tl-volume-title">' + esc(group.volumeTitle) + '</span>' +
        '<span class="tl-volume-count">' + group.events.length + ' 个事件</span>' +
      '</button>' +
      '<div class="tl-volume-body"><div class="timeline-list">' + eventsHTML + '</div></div>' +
    '</section>';
  }

  function buildWorkspaceHTML(mode) {
    var events = ctx.eventList || [];
    var states = ctx.stateList || [];
    var pendingCount = (ctx.pendingList || []).filter(function (p) { return (p.changes || []).some(isRelevantChange); }).length;
    var banner = pendingCount > 0
      ? '<div class="timeline-banner"><span>该人物有 <strong>' + pendingCount + '</strong> 条待审提案</span><a class="btn btn-primary btn-small" href="' + proposalsHash() + '">去故事台账审阅</a></div>' : '';
    var stateCards = states.map(function (item) {
      return '<div class="state-chip"><span>' + esc(item.label) + '</span><strong>' + esc(formatValue(item.value_type, item.value)) + '</strong></div>';
    }).join('');
    var groups = groupEventsByVolume(events);
    var latestKey = findLatestVolumeKey(groups);
    var timelineInner = events.length
      ? groups.map(function (g) { return renderVolumeGroup(g, g.key === latestKey); }).join('')
      : '<div class="workbench-empty-card">还没有与该人物关联的状态事件。点击「+ 新增事件」手动记录第一条。</div>';
    var expandBtn = mode === 'embedded'
      ? '<a class="btn btn-ghost btn-small timeline-expand-btn" href="' + fullPageHash() + '" title="在独立页面放大查看">⤢ 放大</a>' : '';
    return '<div class="timeline-workspace' + (mode === 'full' ? ' timeline-workspace-full' : '') + '">' + banner +
      '<section><div class="relations-toolbar"><div><span class="workbench-kicker">CURRENT STATE</span><h2>' + esc(ctx.person.name) + '的当前状态</h2></div></div>' +
      '<div class="state-chip-grid">' + (stateCards || '<span class="muted">暂无状态字段</span>') + '</div></section>' +
      '<section class="timeline-section"><div class="relations-toolbar"><div><span class="workbench-kicker">NARRATIVE HISTORY</span><h2>事件时间线</h2></div>' +
      '<div class="timeline-section-actions">' + expandBtn +
      '<button id="timeline-add-event" class="btn btn-primary btn-small">+ 新增事件</button></div></div>' +
      '<div class="timeline-scroll' + (mode === 'full' ? ' timeline-scroll-full' : '') + '">' + timelineInner + '</div></section></div>';
  }

  async function loadAndRender(container, mode) {
    container.innerHTML = '<div class="workbench-loading">正在整理人物时间线…</div>';
    try {
      var results = await Promise.all([
        api('GET', '/ledger/events?character_id=' + ctx.person.id + '&limit=200'),
        api('GET', '/characters/' + ctx.person.id + '/states'),
        api('GET', '/state-fields'),
        api('GET', '/ledger/proposals?status=pending')
      ]);
      var events = results[0].items || [];
      var states = results[1].items || [];
      var fieldDefs = (results[2].items || []).filter(function (f) { return f.enabled !== 0; });
      var pending = results[3].items || [];

      ctx.fieldDefs = fieldDefs; ctx.fieldByKey = {}; ctx.stateByKey = {}; ctx.eventsById = {};
      fieldDefs.forEach(function (f) { ctx.fieldByKey[f.field_key] = f; });
      states.forEach(function (s) { ctx.stateByKey[s.field_key] = s; });
      events.forEach(function (e) { ctx.eventsById[e.id] = e; });
      ctx.eventList = events; ctx.stateList = states; ctx.pendingList = pending; ctx.mode = mode;

      container.innerHTML = buildWorkspaceHTML(mode);
      bindTimeline(container);
    } catch (error) { container.innerHTML = '<div class="workbench-error">' + esc(error.message) + '</div>'; }
  }

  // 依当前模式重新渲染到正确容器（新增/编辑事件后刷新用）
  async function refresh() {
    if (ctx.mode === 'full') {
      var full = document.getElementById('timeline-full-content');
      if (full) await loadAndRender(full, 'full');
    } else {
      var root = document.getElementById('character-tab-content');
      if (root) await loadAndRender(root, 'embedded');
    }
  }

  CharacterTimeline.show = async function (route, person) {
    ctx.route = route; ctx.person = person; ctx.mode = 'embedded';
    var root = document.getElementById('character-tab-content');
    if (!root) return;
    await loadAndRender(root, 'embedded');
  };

  // 独立路由全屏页：#/book/{id}/characters/{cid}/timeline
  CharacterTimeline.showFullPage = async function (bookId, cid) {
    ctx.route = { bookId: bookId, tab: 'timeline', entityId: String(cid) };
    ctx.person = null; ctx.mode = 'full';
    var container = document.getElementById('timeline-full-content');
    if (!container) return;
    container.innerHTML = '<div class="workbench-loading">正在整理人物时间线…</div>';
    var ret = document.getElementById('timeline-full-return');
    if (ret) ret.href = '#/book/' + encodeURIComponent(bookId) + '/workbench/characters/' + encodeURIComponent(cid) + '?tab=timeline';
    try {
      var res = await api('GET', '/characters/' + encodeURIComponent(cid));
      ctx.person = res.character;
      var titleEl = document.getElementById('timeline-full-title');
      if (titleEl) titleEl.textContent = ctx.person.name + ' · 事件时间线';
      await loadAndRender(container, 'full');
    } catch (error) {
      container.innerHTML = '<div class="workbench-error">' + esc(error.message) + '</div>';
    }
  };

  // ---------- D. 原文依据悬浮高亮 ----------
  async function openSourcePreview(event) {
    if (!event) return;
    if (!event.chapter_id) { toast('该事件未绑定章节，无法定位原文'); return; }
    if (!event.source_quote) { toast('该事件没有原文依据'); return; }
    try {
      var res = await api('GET', '/chapters/' + event.chapter_id);
      var chapter = res.chapter || {};
      var content = chapter.content || '';
      if (!content) { toast('该章节暂无正文'); return; }
      var quote = String(event.source_quote);
      var idx = content.indexOf(quote);
      var located = idx >= 0;
      var matchLen = quote.length;
      if (!located && quote.length > 12) {
        var head = quote.slice(0, 12);
        var hi = content.indexOf(head);
        if (hi >= 0) { located = true; idx = hi; matchLen = head.length; }
      }
      var html;
      if (located) {
        html = esc(content.slice(0, idx)) + '<mark class="source-highlight">' + esc(content.slice(idx, idx + matchLen)) + '</mark>' + esc(content.slice(idx + matchLen));
      } else if (event.paragraph_index !== null && event.paragraph_index !== undefined) {
        var paras = content.split('\n');
        var pi = Math.max(0, Math.min(paras.length - 1, Number(event.paragraph_index) || 0));
        html = esc(paras.slice(0, pi).join('\n')) + '<mark class="source-highlight">' + esc(paras[pi] || '') + '</mark>' + esc(paras.slice(pi + 1).join('\n'));
        toast('未能精确匹配原句，已定位到第 ' + (pi + 1) + ' 段');
      } else {
        html = esc(content);
        toast('未能精确定位，已显示全章');
      }
      html = html.replace(/\n/g, '<br>');
      window.App.openModal({
        title: '原文依据 · ' + (chapter.title || event.chapter_title || ''),
        okText: '关闭',
        bodyHTML: '<div class="chapter-preview"><div class="chapter-preview-content">' + html + '</div></div>',
        onOk: function () { return true; }
      });
      setTimeout(function () {
        var mark = document.querySelector('#modal-body .source-highlight');
        if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: 'center' });
      }, 40);
    } catch (e) { toast(e.message); }
  }

  // ---------- E. 手动新增/编辑事件 ----------
  function valueFieldHTML(which, valueType, options, value) {
    var cls = 'ev-' + which;
    var hasOptions = Array.isArray(options) && options.length > 0;
    if ((valueType === 'enum' || valueType === 'level') && hasOptions) {
      var opts = '<option value=""></option>' + options.map(function (o) {
        var ov = (o && typeof o === 'object') ? (o.value !== undefined ? o.value : o.label) : o;
        var ol = (o && typeof o === 'object') ? (o.label !== undefined ? o.label : o.value) : o;
        return '<option value="' + esc(ov) + '"' + (value != null && String(value) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>';
      }).join('');
      return '<select class="' + cls + '">' + opts + '</select>';
    }
    if (valueType === 'list') {
      var lv = Array.isArray(value) ? value.join('、') : (value == null ? '' : String(value));
      return '<input class="' + cls + '" placeholder="多个值用、分隔" value="' + esc(lv) + '">';
    }
    var tv = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    return '<input class="' + cls + '" value="' + esc(tv) + '">';
  }

  function addChangeRow(container, change) {
    if (!ctx.fieldDefs.length) { container.innerHTML = '<div class="muted">本书还没有启用的状态字段，无法记录状态变化。</div>'; return; }
    var row = document.createElement('div');
    row.className = 'ev-change-row';
    var selectedKey = change ? change.field_key : ctx.fieldDefs[0].field_key;
    if (!ctx.fieldByKey[selectedKey]) selectedKey = ctx.fieldDefs[0].field_key;
    var fieldOptions = ctx.fieldDefs.map(function (f) {
      return '<option value="' + esc(f.field_key) + '"' + (f.field_key === selectedKey ? ' selected' : '') + '>' + esc(f.label) + '</option>';
    }).join('');
    var def = ctx.fieldByKey[selectedKey];
    var vt = def ? def.value_type : 'text';
    var opts = def ? def.options : [];
    var oldVal = change ? change.old_value : currentStateValue(selectedKey);
    var newVal = change ? change.new_value : null;
    row.innerHTML =
      '<select class="ev-field">' + fieldOptions + '</select>' +
      '<div class="ev-value-pair">' +
        '<span class="ev-value-cell ev-old-cell">' + valueFieldHTML('old', vt, opts, oldVal) + '</span>' +
        '<span class="ev-arrow">→</span>' +
        '<span class="ev-value-cell ev-new-cell">' + valueFieldHTML('new', vt, opts, newVal) + '</span>' +
      '</div>' +
      '<button type="button" class="ev-remove" title="删除此行">×</button>';
    container.appendChild(row);
    row.querySelector('.ev-field').onchange = function () {
      var key = row.querySelector('.ev-field').value;
      var d = ctx.fieldByKey[key];
      var t = d ? d.value_type : 'text';
      var o = d ? d.options : [];
      row.querySelector('.ev-old-cell').innerHTML = valueFieldHTML('old', t, o, currentStateValue(key));
      row.querySelector('.ev-new-cell').innerHTML = valueFieldHTML('new', t, o, null);
    };
    row.querySelector('.ev-remove').onclick = function () {
      row.remove();
      if (!container.querySelectorAll('.ev-change-row').length) addChangeRow(container, null);
    };
  }

  function parseValue(valueType, el) {
    if (!el) return null;
    var raw = el.value == null ? '' : String(el.value).trim();
    if (raw === '') return null;
    if (valueType === 'list') {
      var arr = raw.split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      return arr.length ? arr : null;
    }
    return raw;
  }

  function collectChanges(container) {
    var out = [];
    container.querySelectorAll('.ev-change-row').forEach(function (row) {
      var fieldSel = row.querySelector('.ev-field');
      var fieldKey = fieldSel ? fieldSel.value : '';
      if (!fieldKey) return;
      var vt = fieldValueType(fieldKey);
      out.push({
        change_kind: 'character_state',
        subject_ref: String(ctx.person.id),
        field_key: fieldKey,
        old_value: parseValue(vt, row.querySelector('.ev-old')),
        new_value: parseValue(vt, row.querySelector('.ev-new'))
      });
    });
    return out;
  }

  async function submitEventModal(modalBody, event, relationChanges) {
    var isEdit = !!event;
    var title = modalBody.querySelector('#ev-title').value.trim();
    if (!title) { toast('请填写事件标题'); return false; }
    var container = modalBody.querySelector('#ev-changes');
    var stateChanges = collectChanges(container);
    var carriedRelations = (relationChanges || []).map(function (c) {
      return { change_kind: 'relation', subject_ref: c.subject_ref, field_key: c.field_key, old_value: c.old_value, new_value: c.new_value, metadata: c.metadata || {} };
    });
    if (!stateChanges.length && !carriedRelations.length) { toast('至少需要一项变化'); return false; }

    var payloadChanges = stateChanges.map(function (c) {
      var out = { change_kind: 'character_state', subject_ref: c.subject_ref, field_key: c.field_key, new_value: c.new_value };
      // 编辑走替代式修正（checkOld=false），旧值原样带回；新建仅在提供了旧值时带上（避免与当前投影冲突报 409）
      if (isEdit || (c.old_value !== null && c.old_value !== undefined)) out.old_value = c.old_value;
      return out;
    }).concat(carriedRelations);

    var chapterSel = modalBody.querySelector('#ev-chapter').value;
    var payload = {
      title: title,
      summary: modalBody.querySelector('#ev-summary').value.trim(),
      importance: modalBody.querySelector('#ev-importance').value,
      source_quote: modalBody.querySelector('#ev-quote').value.trim(),
      changes: payloadChanges
    };
    if (chapterSel) payload.chapter_id = Number(chapterSel);

    try {
      if (isEdit) { await api('POST', '/ledger/events/' + event.id + '/corrections', payload); toast('事件已修正'); }
      else { await api('POST', '/ledger/events', payload); toast('事件已创建'); }
      await refresh();
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  async function openEventModal(event) {
    var isEdit = !!event;
    var chapters = [];
    try { chapters = (await api('GET', '/chapters')).chapters || []; } catch (e) { chapters = []; }

    var importanceOptions = ['low', 'normal', 'high', 'critical'].map(function (k) {
      return '<option value="' + k + '"' + ((isEdit ? event.importance : 'normal') === k ? ' selected' : '') + '>' + IMPORTANCE_LABEL[k] + '</option>';
    }).join('');
    var currentChapterId = isEdit ? event.chapter_id : null;
    var chapterOptions = '<option value=""' + (!currentChapterId ? ' selected' : '') + '>未绑定章节</option>' +
      chapters.map(function (c) { return '<option value="' + c.id + '"' + (Number(currentChapterId) === Number(c.id) ? ' selected' : '') + '>' + esc(c.title) + '</option>'; }).join('');

    var existing = (isEdit && event.changes) ? event.changes : [];
    var relationChanges = existing.filter(function (c) { return c.change_kind === 'relation'; });
    var stateChanges = existing.filter(function (c) { return c.change_kind === 'character_state' && String(c.subject_ref) === String(ctx.person.id); });
    var relationNotice = relationChanges.length
      ? '<div class="timeline-relation-notice">该事件含 ' + relationChanges.length + ' 项关系变化，保存时将原样保留；如需修改请到<a href="' + relationsHash() + '">关系 tab</a>。</div>' : '';

    window.App.openModal({
      title: isEdit ? '编辑事件' : '新增事件',
      okText: isEdit ? '保存修正' : '创建事件',
      bodyHTML: '<div class="event-form">' +
        '<label>标题<span class="req">*</span><input id="ev-title" value="' + esc(isEdit ? event.title : '') + '" placeholder="例如：初次登场 / 身受重伤"></label>' +
        '<label>简介<textarea id="ev-summary" rows="2" placeholder="一句话说明这件事发生了什么">' + esc(isEdit ? (event.summary || '') : '') + '</textarea></label>' +
        '<div class="form-grid"><label>重要性<select id="ev-importance">' + importanceOptions + '</select></label>' +
        '<label>章节<select id="ev-chapter">' + chapterOptions + '</select></label></div>' +
        '<label>原文依据<textarea id="ev-quote" rows="2" placeholder="粘贴对应的正文原句，便于日后核对与定位">' + esc(isEdit ? (event.source_quote || '') : '') + '</textarea></label>' +
        relationNotice +
        '<div class="ev-changes-head"><span>状态变化</span><button type="button" id="ev-add-change" class="btn btn-ghost btn-small">+ 添加变化</button></div>' +
        '<div id="ev-changes" class="ev-changes"></div></div>',
      onOk: function (modalBody) { return submitEventModal(modalBody, event, relationChanges); }
    });

    var container = document.getElementById('ev-changes');
    if (container) {
      if (stateChanges.length) stateChanges.forEach(function (c) { addChangeRow(container, c); });
      else addChangeRow(container, null);
      var addChange = document.getElementById('ev-add-change');
      if (addChange) addChange.onclick = function () { addChangeRow(container, null); };
    }
  }
})();
