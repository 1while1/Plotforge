// 大纲脉络轴：卷下的纵向时间线（节点卡 + 烈度着色 + 缝隙填补 + 节奏条 + 拖拽排序）。
// 数据契约：GET /api/books/:id/outline/timeline → { volumes, chapters, intensity }。
// 本模块只负责「卷内章节」部分；卷/总纲编辑仍归 outline-workbench.js。
// 视图状态（正在编辑的 beat、拖拽源、AI 建议）只挂模块内 state，不写 DOM 数据集以外的隐状态。
(function () {
  'use strict';
  var OutlineTimeline = window.OutlineTimeline = {};

  var state = {
    bookId: null,
    chapters: {},        // id -> 章（含 revision，beat 保存成功后以响应为准刷新）
    intensity: {},       // chapterId -> { event_count, max_importance }
    beatTimers: {},      // chapterId -> 防抖定时器
    beatDirty: {},       // chapterId -> true 表示有未落库输入
    saving: {},          // chapterId -> true 表示保存进行中
    dragId: null,        // 正在拖拽的章 id
  };

  function esc(v) { return window.App.escapeHtml(v == null ? '' : String(v)); }
  function api(method, path, body) {
    return window.App.api(method, '/api/books/' + encodeURIComponent(state.bookId) + path, body);
  }

  // 烈度 → 档位名（着色与文案共用）：0 无事件 / 1 低 / 2 常 / 3 高 / 4 极
  function intensityTier(chapterId) {
    var stat = state.intensity[chapterId];
    if (!stat || !stat.event_count) return 0;
    return Math.max(1, Math.min(4, Number(stat.max_importance) || 1));
  }
  var TIER_LABEL = ['无台账事件', '低烈度', '常规推进', '高烈度', '关键爆发'];

  // ---------- 脉络轴渲染 ----------

  function nodeHTML(ch, index) {
    var tier = intensityTier(ch.id);
    var stat = state.intensity[ch.id] || { event_count: 0, max_importance: 0 };
    var meta = [];
    if (ch.content_length) meta.push(ch.content_length + ' 字');
    if (stat.event_count) meta.push('台账 ' + stat.event_count + ' 条 · ' + TIER_LABEL[tier]);
    if (ch.locked) meta.push('已定稿');
    if (ch.drift_status === 'drifted') meta.push('偏离大纲');
    // 标题已带「第N章」前缀（建章时自动编号）就不重复序号称谓
    var hasOrdinal = /^第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*章/.test(ch.title || '');
    var heading = hasOrdinal ? ch.title : ('第 ' + (index + 1) + ' 章 · ' + ch.title);
    return '<div class="tl-node" data-chapter="' + ch.id + '" data-volume="' + (ch.volume_id || '') + '">' +
      '<span class="tl-dot tier-' + tier + '" title="' + esc(TIER_LABEL[tier]) + '"></span>' +
      '<article class="tl-card" data-chapter="' + ch.id + '">' +
        '<header class="tl-card-head">' +
          '<span class="tl-drag" title="拖动调整本卷内顺序">⠿</span>' +
          '<span class="tl-title">' + esc(heading) + '</span>' +
          '<span class="tl-meta">' + esc(meta.join(' · ') || '未写正文') + '</span>' +
        '</header>' +
        '<textarea class="tl-beat" rows="2" data-beat="' + ch.id + '" placeholder="本章节拍：这一章必须完成的剧情节点（直接写在这里，自动保存）">' + esc(ch.beat || '') + '</textarea>' +
        '<div class="tl-beat-state" data-beat-state="' + ch.id + '"></div>' +
      '</article></div>';
  }

  function gapHTML(volumeId, beforeId, afterId, label) {
    return '<div class="tl-gap-row"><button class="tl-gap" data-gap-volume="' + volumeId + '"' +
      ' data-gap-before="' + (beforeId == null ? '' : beforeId) + '" data-gap-after="' + (afterId == null ? '' : afterId) + '"' +
      ' title="让 AI 给这个位置设计 2-3 个衔接章方案">＋ ' + esc(label || '补衔接') + '</button></div>';
  }

  // 节奏条：每章一根柱，高度=台账事件数，颜色=最高烈度；纯前端投影，不调模型
  function tensionStripHTML(chapters) {
    if (!chapters.length) return '';
    var maxCount = 1;
    chapters.forEach(function (ch) {
      var stat = state.intensity[ch.id];
      if (stat && stat.event_count > maxCount) maxCount = stat.event_count;
    });
    var bars = chapters.map(function (ch, i) {
      var stat = state.intensity[ch.id] || { event_count: 0, max_importance: 0 };
      var tier = intensityTier(ch.id);
      var h = stat.event_count ? Math.max(12, Math.round((stat.event_count / maxCount) * 40)) : 4;
      return '<span class="tl-bar tier-' + tier + '" style="height:' + h + 'px" title="第 ' + (i + 1) + ' 章 ' + esc(ch.title) +
        '：台账 ' + stat.event_count + ' 条，' + TIER_LABEL[tier] + '"></span>';
    }).join('');
    return '<div class="tl-strip"><span class="tl-strip-label">节奏</span><div class="tl-strip-bars">' + bars + '</div></div>';
  }

  // 一卷的完整脉络轴：节奏条 + AI 评语入口 + 卷首缝隙 + 节点/缝隙交替 + 卷尾缝隙
  function timelineHTML(volume, chapters) {
    var rows = [gapHTML(volume.id, null, chapters.length ? chapters[0].id : null, chapters.length ? '补卷首' : '补第一章')];
    chapters.forEach(function (ch, i) {
      rows.push(nodeHTML(ch, i));
      var after = chapters[i + 1];
      rows.push(gapHTML(volume.id, ch.id, after ? after.id : null, after ? '补衔接' : '补卷末'));
    });
    return '<section class="tl-root" data-tl-volume="' + volume.id + '">' +
      '<div class="tl-toolbar">' + tensionStripHTML(chapters) +
        '<button class="btn btn-ghost btn-small" data-tension-review="' + volume.id + '"' +
        (chapters.length ? '' : ' disabled') + '>AI 节奏评语</button>' +
      '</div>' +
      '<div class="tl-axis">' + rows.join('') + '</div></section>';
  }

  OutlineTimeline.render = function (container, bookId, volume, chapters, intensity) {
    state.bookId = bookId;
    chapters.forEach(function (ch) { state.chapters[ch.id] = ch; });
    Object.assign(state.intensity, intensity || {});
    container.innerHTML = timelineHTML(volume, chapters);
    bindTimeline(container, volume);
  };

  // ---------- beat 行内编辑 + 自动保存 ----------

  function setBeatState(chapterId, text, cls) {
    var el = document.querySelector('[data-beat-state="' + chapterId + '"]');
    if (!el) return;
    el.textContent = text;
    el.className = 'tl-beat-state' + (cls ? ' ' + cls : '');
  }

  async function saveBeat(chapterId) {
    var ch = state.chapters[chapterId];
    var input = document.querySelector('[data-beat="' + chapterId + '"]');
    if (!ch || !input) return;
    var value = input.value.trim();
    if (value === (ch.beat || '').trim()) { state.beatDirty[chapterId] = false; setBeatState(chapterId, '', ''); return; }
    state.saving[chapterId] = true;
    setBeatState(chapterId, '保存中…', 'saving');
    try {
      var res = await api('PUT', '/chapters/' + chapterId, { beat: value, expected_revision: ch.revision });
      if (res && res.chapter) state.chapters[chapterId] = Object.assign({}, ch, res.chapter);
      state.beatDirty[chapterId] = false;
      setBeatState(chapterId, res && res.persistence && res.persistence.durable === false ? '已保存（磁盘写入重试中）' : '已保存', 'saved');
    } catch (e) {
      if (e && (e.code === 'CHAPTER_CONFLICT' || e.status === 409 || e.status === 428)) {
        setBeatState(chapterId, '冲突：内容已在别处更新', 'failed');
        window.App.toast('节拍保存冲突：该章已在别处更新，正在刷新脉络轴');
        if (typeof OutlineTimeline.onConflict === 'function') OutlineTimeline.onConflict();
      } else {
        setBeatState(chapterId, '保存失败：' + e.message, 'failed');
      }
    } finally {
      state.saving[chapterId] = false;
    }
  }

  function bindBeatEditors(root) {
    root.querySelectorAll('[data-beat]').forEach(function (input) {
      var chapterId = Number(input.dataset.beat);
      input.addEventListener('input', function () {
        state.beatDirty[chapterId] = true;
        setBeatState(chapterId, '未保存', 'dirty');
        clearTimeout(state.beatTimers[chapterId]);
        state.beatTimers[chapterId] = setTimeout(function () { saveBeat(chapterId); }, 900);
      });
      input.addEventListener('blur', function () {
        if (!state.beatDirty[chapterId]) return;
        clearTimeout(state.beatTimers[chapterId]);
        saveBeat(chapterId);
      });
    });
  }

  // 离开保护接入：还有未落库的节拍输入时，先强制落库（供 outline-workbench 的守卫 save 调用）
  OutlineTimeline.flushBeats = async function () {
    var ids = Object.keys(state.beatDirty).filter(function (id) { return state.beatDirty[id]; });
    for (var i = 0; i < ids.length; i++) {
      clearTimeout(state.beatTimers[ids[i]]);
      await saveBeat(Number(ids[i]));
    }
    return !Object.keys(state.beatDirty).some(function (id) { return state.beatDirty[id]; });
  };
  OutlineTimeline.hasDirtyBeats = function () {
    return Object.keys(state.beatDirty).some(function (id) { return state.beatDirty[id]; });
  };

  // ---------- 拖拽排序（仅同卷） ----------

  function volumeOf(nodeEl) { return nodeEl.dataset.volume || ''; }

  function bindDrag(root, volume) {
    var axis = root.querySelector('.tl-axis');
    if (!axis) return;
    axis.querySelectorAll('.tl-card').forEach(function (card) {
      // 只有捏住把手才可拖：卡片里装着 beat 文本域，整卡 draggable 会吃掉文本选择
      var handle = card.querySelector('.tl-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { card.draggable = true; });
        handle.addEventListener('mouseup', function () { card.draggable = false; });
      }
      card.addEventListener('dragstart', function (e) {
        state.dragId = Number(card.dataset.chapter);
        card.classList.add('dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(state.dragId)); }
      });
      card.addEventListener('dragend', function () {
        state.dragId = null;
        card.draggable = false;
        card.classList.remove('dragging');
        axis.querySelectorAll('.drop-before,.drop-after').forEach(function (n) { n.classList.remove('drop-before', 'drop-after'); });
      });
      card.addEventListener('dragover', function (e) {
        if (state.dragId == null) return;
        var node = card.closest('.tl-node');
        if (!node || volumeOf(node) !== String(volume.id)) return; // 跨卷不允许
        e.preventDefault();
        var rect = card.getBoundingClientRect();
        var before = (e.clientY - rect.top) < rect.height / 2;
        card.classList.toggle('drop-before', before);
        card.classList.toggle('drop-after', !before);
      });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        var targetId = Number(card.dataset.chapter);
        var before = card.classList.contains('drop-before');
        if (state.dragId != null && targetId !== state.dragId) reorderVolume(volume, state.dragId, targetId, before, root);
      });
    });
  }

  // 重排：乐观改 DOM 之前先算好新顺序，逐个 PUT sort_order；任一失败 → 抛给上层整轴重载（回滚真相=服务端）
  async function reorderVolume(volume, dragId, targetId, insertBefore, root) {
    var nodes = Array.from(root.querySelectorAll('.tl-node'));
    var ids = nodes.map(function (n) { return Number(n.dataset.chapter); });
    var from = ids.indexOf(dragId);
    var to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(insertBefore ? to - (from < to ? 1 : 0) : to + (from < to ? 0 : 1), 0, dragId);
    var changed = [];
    ids.forEach(function (id, i) {
      var ch = state.chapters[id];
      var want = i + 1;
      if (ch && ch.sort_order !== want) changed.push({ chapter: ch, sort_order: want });
    });
    if (!changed.length) return;
    try {
      for (var i = 0; i < changed.length; i++) {
        var item = changed[i];
        var res = await api('PUT', '/chapters/' + item.chapter.id, { sort_order: item.sort_order, expected_revision: item.chapter.revision });
        if (res && res.chapter) state.chapters[item.chapter.id] = Object.assign({}, item.chapter, res.chapter);
      }
      window.App.toast('章节顺序已调整');
    } catch (e) {
      window.App.toast('排序保存失败：' + e.message + '（已恢复原顺序）');
    }
    if (typeof OutlineTimeline.onStructureChanged === 'function') OutlineTimeline.onStructureChanged();
  }

  // ---------- 缝隙填补（AI） ----------

  function bindGaps(root) {
    root.querySelectorAll('[data-gap-volume]').forEach(function (btn) {
      btn.onclick = async function () {
        var volumeId = Number(btn.dataset.gapVolume);
        var beforeId = btn.dataset.gapBefore === '' ? null : Number(btn.dataset.gapBefore);
        var afterId = btn.dataset.gapAfter === '' ? null : Number(btn.dataset.gapAfter);
        btn.disabled = true;
        btn.textContent = 'AI 推演中…';
        try {
          var res = await api('POST', '/outline/fill-gap', { volume_id: volumeId, before_chapter_id: beforeId, after_chapter_id: afterId });
          openGapModal(volumeId, beforeId, afterId, res.suggestions || []);
        } catch (e) {
          window.App.toast('缝隙填补失败：' + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = '＋ ' + (beforeId == null ? (afterId == null ? '补第一章' : '补卷首') : (afterId == null ? '补卷末' : '补衔接'));
        }
      };
    });
  }

  function openGapModal(volumeId, beforeId, afterId, suggestions) {
    var body = '<p class="field-hint">AI 只给方案，不写库。点「采纳为章节」才会在该位置建章（标题与节拍可再改）。</p>' +
      suggestions.map(function (s, i) {
        return '<article class="gap-suggestion"><header><strong>' + esc(s.title) + '</strong></header>' +
          '<p class="gap-beat">' + esc(s.beat) + '</p>' +
          (s.rationale ? '<p class="gap-rationale">' + esc(s.rationale) + '</p>' : '') +
          '<button class="btn btn-primary btn-small" data-adopt-gap="' + i + '">采纳为章节</button></article>';
      }).join('');
    window.App.openModal({ title: '衔接章方案', okText: '关闭', bodyHTML: body });
    document.querySelectorAll('[data-adopt-gap]').forEach(function (btn) {
      btn.onclick = function () { adoptGap(volumeId, beforeId, afterId, suggestions[Number(btn.dataset.adoptGap)], btn); };
    });
  }

  async function adoptGap(volumeId, beforeId, afterId, suggestion, btn) {
    btn.disabled = true;
    btn.textContent = '落章中…';
    try {
      var created = await api('POST', '/chapters', { volume_id: volumeId, title: suggestion.title, beat: suggestion.beat });
      var chapter = created && created.chapter;
      // 新建章落在卷尾；指定了 before 时需要把它提到 before 之后（整卷重排一次）
      if (chapter && beforeId != null) {
        var chs = Object.keys(state.chapters).map(function (k) { return state.chapters[k]; })
          .filter(function (c) { return Number(c.volume_id) === Number(volumeId); })
          .sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; });
        var ids = chs.map(function (c) { return c.id });
        ids.push(chapter.id);
        var pos = ids.indexOf(beforeId);
        ids.splice(ids.indexOf(chapter.id), 1);
        ids.splice(pos + 1, 0, chapter.id);
        var all = Object.assign({}, state.chapters);
        all[chapter.id] = chapter;
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          var want = i + 1;
          var cur = all[id];
          if (cur && cur.sort_order !== want) {
            var res = await api('PUT', '/chapters/' + id, { sort_order: want, expected_revision: cur.revision });
            if (res && res.chapter) all[id] = Object.assign({}, cur, res.chapter);
          }
        }
      }
      window.App.toast('已采纳并建章：《' + suggestion.title + '》');
      if (typeof OutlineTimeline.onStructureChanged === 'function') OutlineTimeline.onStructureChanged();
    } catch (e) {
      window.App.toast('采纳失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '采纳为章节';
    }
  }

  // ---------- AI 节奏评语 ----------

  function bindTensionReview(root) {
    root.querySelectorAll('[data-tension-review]').forEach(function (btn) {
      btn.onclick = async function () {
        var volumeId = Number(btn.dataset.tensionReview);
        btn.disabled = true;
        btn.textContent = '分析中…';
        try {
          var res = await api('POST', '/outline/tension-review', { volume_id: volumeId });
          openTensionModal(res);
        } catch (e) {
          window.App.toast('节奏分析失败：' + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'AI 节奏评语';
        }
      };
    });
  }

  function openTensionModal(res) {
    var scores = res.chapter_scores || {};
    var ids = Object.keys(scores);
    var rows = ids.map(function (cid) {
      var ch = state.chapters[cid];
      var t = scores[cid];
      return '<li><span class="tl-score-dot tier-' + Math.max(1, Math.min(4, t - 1)) + '"></span>' +
        esc(ch ? ch.title : ('章节 ' + cid)) + ' —— 张力 ' + t + '/5</li>';
    }).join('');
    window.App.openModal({
      title: 'AI 节奏评语', okText: '关闭',
      bodyHTML: '<blockquote class="tension-comment">' + esc(res.comment || '') + '</blockquote>' +
        (rows ? '<ul class="tension-scores">' + rows + '</ul>' : '<p class="field-hint">模型未给出逐章分数。</p>'),
    });
  }

  // ---------- 绑定入口 ----------

  function bindTimeline(container, volume) {
    bindBeatEditors(container);
    bindDrag(container, volume);
    bindGaps(container);
    bindTensionReview(container);
  }

  // 切书/重载时清掉模块状态（脉络轴归当前书所有）
  OutlineTimeline.reset = function () {
    Object.keys(state.beatTimers).forEach(function (k) { clearTimeout(state.beatTimers[k]); });
    state.bookId = null;
    state.chapters = {};
    state.intensity = {};
    state.beatTimers = {};
    state.beatDirty = {};
    state.saving = {};
    state.dragId = null;
  };
})();
