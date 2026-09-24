// 大纲工作台编排：总纲/卷编辑器 + 保存守卫（沿用既有口径），
// 卷内章节脉络轴交给 OutlineTimeline，页内小助手交给 OutlineAssistant。
// 数据：GET /api/books/:id（总纲）+ GET /api/books/:id/outline/timeline（卷+章+烈度投影）。
// 重渲染纪律：结构变化（拖拽/采纳/冲突）只重渲脉络轴插槽，不动卷编辑器——正在输入的文本不丢。
(function () {
  'use strict';
  var OutlineWorkbench = window.OutlineWorkbench = {};
  function esc(v) { return window.App.escapeHtml(v); }
  function ws() { return window.WorkspaceState; }
  var tracker = null;       // S4-03：脏编辑追踪（输入即脏；只有本次快照保存成功才清）
  var currentBookId = null; // 当前渲染的工作台所属书：异步结果按它丢弃，避免跨书回写
  var currentRoute = null;
  var timelineData = null;  // 最近一次 /outline/timeline 的响应（刷新脉络轴用）
  function trackInput(node) { node.addEventListener('input', function () { tracker.mark(); }); }

  var NIGHT_KEY = 'mozhen-outline-night';
  function nightOn() { try { return localStorage.getItem(NIGHT_KEY) === '1'; } catch (e) { return false; } }

  // 保存全部：先落节拍（行内自动保存的兜底），再落总纲 + 每一卷。
  // 返回 true 仅当全部写入成功且保存期间没有新输入；部分失败立刻停手、保留脏态并如实说明。
  async function saveAll(base) {
    if (window.OutlineTimeline && !await window.OutlineTimeline.flushBeats()) {
      window.App.toast('有章节拍点未能保存（可能冲突），请先处理红色提示再保存大纲');
      return false;
    }
    var snapshot = tracker ? tracker.snapshot() : 0;
    var failure = null;
    try {
      await window.App.api('PUT', base, { master_outline: document.getElementById('workbench-master-outline').value });
    } catch (e) { failure = e; }
    if (!failure) {
      // 必须锁定卷卡：脉络轴节点也带 data-volume 属性，裸选择器会把节点当卷卡然后崩在找不到卷标题框
      var cards = document.querySelectorAll('.volume-outline-card[data-volume]');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        try {
          await window.App.api('PUT', base + '/volumes/' + card.dataset.volume, { title: card.querySelector('[data-volume-title]').value, intro: card.querySelector('[data-volume-intro]').value, outline: card.querySelector('[data-volume-outline]').value });
        } catch (e) { failure = e; break; }
      }
    }
    if (failure) {
      window.App.toast('保存中断（保存失败）：' + failure.message + '（总纲与其后部分卷可能未保存，草稿仍在，请重试）');
      return false;
    }
    if (tracker && !tracker.settle(snapshot, true)) {
      window.App.toast('保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库');
      return false;
    }
    window.App.toast('大纲已保存');
    return true;
  }

  function bindDirty(root) {
    tracker = ws() && ws().dirtyTracker ? ws().dirtyTracker() : null;
    if (!tracker) return;
    var fields = root.querySelectorAll('#workbench-master-outline,[data-volume-title],[data-volume-intro],[data-volume-outline]');
    for (var i = 0; i < fields.length; i++) trackInput(fields[i]);
  }

  function registerGuard(base) {
    if (!ws() || !ws().registerGuard) return;
    ws().clearGuards(function (g) { return g.key === 'outline'; });
    ws().registerGuard({
      key: 'outline',
      label: '大纲工作台',
      isDirty: function () {
        return (!!tracker && tracker.isDirty()) ||
          (window.OutlineTimeline && window.OutlineTimeline.hasDirtyBeats());
      },
      save: function () { return saveAll(base); },
      discard: function () { if (tracker) tracker.clear(); },
    });
  }

  function chaptersOfVolume(volumeId) {
    return (timelineData ? timelineData.chapters : []).filter(function (ch) { return Number(ch.volume_id) === Number(volumeId); });
  }

  // 只重渲脉络轴插槽（卷编辑器里的未保存文本不动）。
  // flushFirst：拖拽/采纳后重渲前先把未落库的节拍落库，避免输入被重渲吃掉；
  // 冲突场景调用方传 false（冲突保存重试只会再撞 409）。
  async function refreshTimelines(flushFirst) {
    if (!currentRoute) return;
    if (flushFirst && window.OutlineTimeline) await window.OutlineTimeline.flushBeats();
    var res = await window.App.api('GET', '/api/books/' + currentRoute.bookId + '/outline/timeline');
    if (!currentRoute || String(currentRoute.bookId) !== currentBookId) return; // 已切书
    timelineData = res;
    document.querySelectorAll('[data-tl-slot]').forEach(function (slot) {
      var volumeId = Number(slot.dataset.tlSlot);
      var volume = (res.volumes || []).find(function (v) { return Number(v.id) === volumeId; });
      if (!volume) { slot.innerHTML = ''; return; }
      window.OutlineTimeline.render(slot, currentRoute.bookId, volume, chaptersOfVolume(volumeId), res.intensity);
    });
    var loose = document.getElementById('outline-loose-chapters');
    if (loose) loose.innerHTML = looseHTML(res.chapters || []);
  }

  function looseHTML(chapters) {
    var loose = chapters.filter(function (ch) { return ch.volume_id == null; });
    if (!loose.length) return '';
    return '<section class="master-outline-card"><span class="workbench-kicker">未归卷章节</span>' +
      '<p class="field-hint">这些章节不属于任何卷，不进脉络轴。到章节页把它们归卷后再回来排布。</p><ul>' +
      loose.map(function (ch) { return '<li>' + esc(ch.title) + '</li>'; }).join('') + '</ul></section>';
  }

  function volumeCardHTML(volume) {
    var count = chaptersOfVolume(volume.id).length;
    return '<article class="volume-outline-card" data-volume="' + volume.id + '"><div><span>第 ' + volume.sort_order + ' 卷 · ' + count + ' 章</span><input data-volume-title value="' + esc(volume.title) + '"></div><label>阶段目标与冲突<textarea data-volume-intro rows="3">' + esc(volume.intro || '') + '</textarea></label><label>卷大纲<textarea data-volume-outline rows="7">' + esc(volume.outline || '') + '</textarea></label>'
      + '<label>卷总结（写作上下文与卷末检视都会用到；由已定稿/已总结章节凝练）<textarea data-volume-summary rows="4" readonly placeholder="（尚未生成）">' + esc(volume.summary || '') + '</textarea></label>'
      + '<button class="btn btn-ghost btn-small" data-gen-summary="' + volume.id + '">' + (volume.summary ? '重新生成并保存卷总结' : '生成并保存卷总结') + '</button>'
      + '<div class="tl-slot" data-tl-slot="' + volume.id + '"></div></article>';
  }

  OutlineWorkbench.show = async function (route) {
    var root = document.getElementById('workbench-content');
    if (window.OutlineTimeline) window.OutlineTimeline.reset();
    if (window.OutlineAssistant) window.OutlineAssistant.unmount();
    root.innerHTML = '<div class="workbench-loading">正在展开全书结构…</div>';
    currentBookId = String(route.bookId);
    currentRoute = route;
    var token = ws() && ws().beginRequest ? ws().beginRequest('outline', currentBookId) : null;
    try {
      var base = '/api/books/' + route.bookId;
      var result = await Promise.all([window.App.api('GET', base), window.App.api('GET', base + '/outline/timeline')]);
      // 切书后晚到的响应：token 与书 id 双绑，过期即丢弃（不把 A 书结构写进 B 书）
      if (currentBookId !== String(route.bookId)) return;
      if (token && !ws().isCurrent(token, currentBookId)) return;
      var book = result[0].book;
      timelineData = result[1];
      var volumes = timelineData.volumes || [];
      var night = nightOn();
      root.innerHTML = '<div class="outline-workspace' + (night ? ' outline-night' : '') + '"><header class="workspace-heading"><div><span class="workbench-kicker">STORY ARCHITECTURE</span><h2>大纲工作台</h2><p>总纲定方向，卷纲定阶段，脉络轴上排章节、写拍点、看节奏。</p></div><div class="workspace-actions"><button id="outline-night-toggle" class="btn btn-ghost">' + (night ? '☀ 日间' : '☾ 夜览') + '</button><button id="save-outline-workbench" class="btn btn-primary">保存全部大纲</button></div></header><section class="master-outline-card"><label>全书总纲<textarea id="workbench-master-outline" rows="9">' + esc(book.master_outline || '') + '</textarea></label></section><div class="volume-outline-list">'
        + (volumes.length ? volumes.map(volumeCardHTML).join('') : '<section class="workbench-empty-card"><h3>还没有分卷</h3><p>到章节页创建第一卷后，这里会出现脉络轴。</p></section>')
        + '</div><div id="outline-loose-chapters">' + looseHTML(timelineData.chapters || []) + '</div></div>';

      // 每卷脉络轴挂进插槽（测试桩环境可能不加载该模块：守卫降级为纯编辑器页）
      var workspace = root.querySelector('.outline-workspace');
      if (window.OutlineTimeline) {
        volumes.forEach(function (volume) {
          var slot = workspace.querySelector('[data-tl-slot="' + volume.id + '"]');
          if (slot) window.OutlineTimeline.render(slot, route.bookId, volume, chaptersOfVolume(volume.id), timelineData.intensity);
        });
        // 结构变化/冲突回调：只刷脉络轴，卷编辑器不动
        window.OutlineTimeline.onStructureChanged = function () { refreshTimelines(true).catch(function (e) { window.App.toast('脉络轴刷新失败：' + e.message); }); };
        window.OutlineTimeline.onConflict = function () { refreshTimelines(false).catch(function () {}); };
      }
      // 小助手胶囊挂到工作台容器
      if (window.OutlineAssistant) window.OutlineAssistant.mount(route.bookId, workspace);

      // 夜览开关：类挂在大纲工作台容器上，localStorage 记忆
      document.getElementById('outline-night-toggle').onclick = function () {
        var on = !workspace.classList.contains('outline-night');
        workspace.classList.toggle('outline-night', on);
        try { localStorage.setItem(NIGHT_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        this.textContent = on ? '☀ 日间' : '☾ 夜览';
      };

      var saveBtn = document.getElementById('save-outline-workbench');
      saveBtn.onclick = async function () {
        saveBtn.disabled = true;
        try { await saveAll(base); } finally { saveBtn.disabled = false; }
      };
      // 卷总结入口（方向报告 1.2）：生成后整页重渲（卷总结是只读字段，不影响在编辑内容）
      root.querySelectorAll('[data-gen-summary]').forEach(function (btn) {
        btn.onclick = async function () {
          btn.disabled = true;
          btn.textContent = "生成中…（依赖模型速度）";
          try {
            await window.App.api('POST', base + '/volumes/' + btn.dataset.genSummary + '/summary', {});
            window.App.toast('卷总结已生成并保存');
            OutlineWorkbench.show(route);
          } catch (e) {
            window.App.toast("卷总结生成失败：" + e.message);
            btn.disabled = false;
            btn.textContent = '生成并保存卷总结';
          }
        };
      });
      // S4-03：多卷编辑也进统一离开保护（不能只保护正文）——输入变脏、失败保留 dirty
      bindDirty(root);
      registerGuard(base);
    } catch (e) { root.innerHTML = '<div class="workbench-error">' + esc(e.message) + '</div>'; }
  };
})();
