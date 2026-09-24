(function () {
  'use strict';
  var LedgerWorkbench = window.LedgerWorkbench = {};
  var state = { route: null, tab: 'overview' };
  // 分页状态：提案/事件走服务端分页（limit+offset，total 为服务端 COUNT），故事线/问题前端切片
  var pagers = {
    proposals: { page: 1, pageSize: 20, total: 0 },
    events: { page: 1, pageSize: 20, total: 0 },
    threads: { page: 1, pageSize: 20, total: 0 },
    issues: { page: 1, pageSize: 20, total: 0 },
  };
  var threadItems = []; // 故事线全量缓存：翻页不重拉
  var issueItems = [];
  var charNames = null; // 人物 id↔姓名缓存；bookId 变化时在 show() 里重置
  var pollToken = 0;    // 轮询世代：shell() 重绘即失效旧轮询，防止离开台账页后轮询不停与误报
  var tracker = null;   // S4-03：进展摘要脏编辑（输入即脏；保存成功且期间无新输入才清）
  var activeLoadToken = null; // 异步面板结果的请求 token：换书/换页签后晚到的响应不再写面板
  // 后端 threads 契约（domain/threads.js TYPES）：type 必须是这五个枚举值，说明字段叫 summary
  var THREAD_TYPE_LABELS = { foreshadow: '伏笔', mystery: '悬念', promise: '承诺', debt: '亏欠', plan: '计划' };
  function esc(v) { return window.App.escapeHtml(v); }
  function ws() { return window.WorkspaceState; }
  function api(method, path, body) { return window.App.api(method, '/api/books/' + state.route.bookId + '/ledger' + path, body); }

  function nav() {
    var labels = { overview: '总览', proposals: '待审提案', events: '事实事件', threads: '故事线', issues: '一致性问题' };
    return '<nav class="ledger-tabs">' + Object.keys(labels).map(function (key) { return '<button data-ledger-tab="' + key + '" class="' + (state.tab === key ? 'active' : '') + '">' + labels[key] + '</button>'; }).join('') + '</nav>';
  }
  function shell() { pollToken++; document.getElementById('workbench-content').innerHTML = '<div class="ledger-workspace"><header class="workspace-heading"><div><span class="workbench-kicker">CANONICAL STORY MEMORY</span><h2>故事台账</h2><p>提案先审阅，接受后才成为正式事实。</p></div></header>' + nav() + '<section id="ledger-panel" class="ledger-panel"></section></div>'; bindNav(); }
  function bindNav() {
    document.querySelectorAll('[data-ledger-tab]').forEach(function (button) {
      button.onclick = async function () {
        var next = button.dataset.ledgerTab;
        if (next === state.tab) return;
        // S4-03：页签切换也是「离开」——进展摘要草稿同样过统一守卫，保存失败留在原页签
        if (ws() && ws().beforeNavigate) {
          var allowed = await ws().beforeNavigate({ from: 'ledger:' + state.tab, to: 'ledger:' + next });
          if (!allowed) return;
        }
        state.tab = next; shell(); load();
      };
    });
  }
  function loadCurrent() { return !(activeLoadToken && ws() && !ws().isCurrent(activeLoadToken)); }
  function panel(html) {
    // 换书/换页签/重入后晚到的面板结果：token 过期即丢弃（不覆盖当前页签）
    if (!loadCurrent()) return false;
    var target = document.getElementById('ledger-panel');
    if (!target) return false;
    target.innerHTML = html;
    return true;
  }

  // 保存全书进展摘要：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示
  async function saveProgress() {
    if (!tracker) return true;
    var node = document.getElementById('ledger-progress');
    if (!node) return !tracker.isDirty();
    var snapshot = tracker.snapshot();
    try { await api('PUT', '/progress', { summary: node.value }); }
    catch (err) {
      window.App.toast('保存失败（进展摘要未保存）：' + err.message + '，修改仍留在表单里');
      return false;
    }
    if (!tracker.settle(snapshot, true)) {
      window.App.toast('保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库');
      return false;
    }
    window.App.toast('进展摘要已保存');
    return true;
  }

  function installGuard() {
    if (!ws() || !ws().registerGuard) return;
    if (!tracker) tracker = ws().dirtyTracker();
    ws().clearGuards(function (g) { return g.key === 'ledger'; });
    ws().registerGuard({
      key: 'ledger',
      label: '故事台账',
      isDirty: function () { return !!tracker && tracker.isDirty(); },
      save: saveProgress,
      discard: function () { if (tracker) tracker.clear(); },
    });
  }

  // 作品健康条（方向报告 3.3）：索引/抽取/摘要/台账/调用的单一观察面。
  // 计数全为 0 → 全绿；任一非 0 → 黄色警示（点击跳到对应工作台处理）。
  function healthHTML(h) {
    if (!h) return '';
    var items = [
      { n: h.index.locked_missing, label: '索引缺失', hint: '定稿章无语义索引，AI 检索不到；写作页章节列表可一键重建' },
      { n: h.extraction.locked_pending, label: '抽取待补', hint: '定稿章无成功抽取记录；下方「一键回填」可补' },
      { n: h.summary.locked_without_summary, label: '章总结缺', hint: '定稿章没有总结，跨章记忆压缩缺底料' },
      { n: h.summary.stale_volumes, label: '卷总结过期', hint: '卷内章总结已变化，卷总结基于旧内容（写作页卷行有标记）' },
      { n: h.ledger.stale_proposals + h.ledger.orphan_events + h.ledger.stale_events, label: '一致性问题', hint: '过期提案/孤儿事件/证据过期事件' },
      { n: h.llm_recent.errors, label: '近期调用失败', hint: '最近 ' + h.llm_recent.window + ' 次 LLM 调用中的失败数' }
    ];
    var warn = items.some(function (it) { return it.n > 0; });
    return '<div class="ledger-health' + (warn ? ' warn' : '') + '"><span class="ledger-health-title">' + (warn ? '⚠ 作品健康有待处理' : '✓ 作品健康') + '</span>'
      + items.map(function (it) { return '<span class="ledger-health-item' + (it.n > 0 ? ' bad' : '') + '" title="' + esc(it.hint) + '">' + esc(it.label) + ' <strong>' + it.n + '</strong></span>'; }).join('')
      + '<span class="ledger-health-meta">正典 ' + h.canon.chapters + ' 章 / 定稿 ' + h.canon.locked + ' / ' + Math.round(h.canon.chars / 1000) + 'K 字</span></div>';
  }

  async function overview() {
    var result = await Promise.all([api('GET', '/progress'), api('GET', '/proposals?status=pending'), api('GET', '/threads?status=open'), api('GET', '/issues'), api('GET', '/backfill'),
      window.App.api('GET', '/api/books/' + state.route.bookId + '/health').catch(function () { return null; })]);
    if (!panel(healthHTML(result[5])
      + '<div class="ledger-metrics"><article><strong>' + (result[1].page && result[1].page.total != null ? result[1].page.total : result[1].items.length) + '</strong><span>待审提案</span></article><article><strong>' + result[2].items.length + '</strong><span>未结故事线</span></article><article><strong>' + result[3].items.length + '</strong><span>一致性问题</span></article></div>'
      + '<div class="ledger-backfill-card"><div class="ledger-backfill-text"><h3>状态回填</h3><p>用 AI 从所有<strong>已定稿</strong>章节重新抽取人物事实，生成<strong>待审提案</strong>；已入库的字段会自动跳过，<strong>绝不直接改正典</strong>。采纳后人物状态即推进到最新剧情。</p></div><div class="ledger-backfill-control"><button id="backfill-start" class="btn btn-primary">一键回填</button><span id="backfill-progress" class="ledger-backfill-progress"></span></div></div>'
      + '<form id="progress-form" class="ledger-summary-card"><label>全书进展摘要'
      + (result[0].stale ? '<span class="vol-stale" title="保存后章/卷总结有更新，此摘要讲的可能是旧故事，建议重新生成">底料已变化</span>' : '')
      + '<textarea id="ledger-progress" rows="10">' + esc(result[0].summary || '') + '</textarea></label><button class="btn btn-primary">保存进展摘要</button></form>')) return;
    document.getElementById('progress-form').onsubmit = async function (event) { event.preventDefault(); await saveProgress(); };
    var progressNode = document.getElementById('ledger-progress');
    if (progressNode && tracker) progressNode.addEventListener('input', function () { tracker.mark(); });
    bindBackfill(result[4].status);
  }
  function backfillText(s) {
    if (!s) return '';
    if (s.running) return '回填中… ' + s.processed + '/' + s.total + ' 章 · 已生成 ' + s.created + ' 条提案';
    if (s.phase === 'done') return '上次回填：' + s.total + ' 章 · 新增 ' + s.created + ' 条待审提案 · 跳过 ' + s.skipped_changes + ' 项已入库变化' + (s.errors && s.errors.length ? ' · ' + s.errors.length + ' 条提示' : '');
    if (s.phase === 'aborted') return '上次回填已取消';
    if (s.phase === 'interrupted') return '上次回填因服务重启中断，未再自动续跑；重新点「一键回填」即可续跑（已抽取章节会自动跳过）';
    return '';
  }
  function bindBackfill(status) {
    var btn = document.getElementById('backfill-start');
    var prog = document.getElementById('backfill-progress');
    if (!btn) return;
    prog.textContent = backfillText(status);
    if (status && status.running) { btn.disabled = true; pollBackfill(pollToken); return; }
    btn.disabled = false;
    btn.onclick = function () {
      window.App.openModal({
        title: '一键回填历史章节', okText: '开始回填',
        bodyHTML: '<p>将用 AI 重新抽取本书<strong>所有已定稿章节</strong>的人物事实，生成<strong>待审提案</strong>；已入库的字段会自动跳过，<strong>不会直接修改正典</strong>。</p><p>会消耗 AI 调用，章节多时可能耗时数分钟。完成后请到「待审提案」逐条核对采纳。</p>',
        onOk: async function () { btn.disabled = true; prog.textContent = '正在启动回填…'; try { await api('POST', '/backfill', {}); } catch (err) { window.App.toast('回填启动失败：' + err.message); btn.disabled = false; return; } pollBackfill(pollToken); }
      });
    };
  }
  async function pollBackfill(myToken) {
    // 世代失效（切页/切tab/show 重入）→ 停止轮询，不打扰其它页面
    if (myToken !== pollToken) return;
    var res;
    try { res = await api('GET', '/backfill'); }
    catch (err) { window.App.toast('回填状态查询失败：' + err.message + '（回填可能仍在后台进行）'); return; }
    if (myToken !== pollToken) return;
    var s = res.status;
    var btn = document.getElementById('backfill-start');
    var prog = document.getElementById('backfill-progress');
    if (prog) prog.textContent = backfillText(s);
    if (s && s.running) { setTimeout(function () { pollBackfill(myToken); }, 2500); return; }
    if (btn) btn.disabled = false;
    // 仅在真正跑完时报完成；aborted/异常终止不冒充成功
    if (!s || s.phase === 'done') window.App.toast('回填完成：新增 ' + ((s && s.created) || 0) + ' 条待审提案');
  }
  async function loadCharNames() {
    if (charNames) return charNames;
    try {
      var res = await window.App.api('GET', '/api/books/' + state.route.bookId + '/characters?limit=200'); // 后端默认 limit=50，大书会把提案里的人物显示成 人物#id
      var list = res.characters || res.items || [];
      charNames = {};
      list.forEach(function (c) { charNames[String(c.id)] = c.name; });
    } catch (e) { charNames = {}; }
    return charNames;
  }
  // 提案双轨对齐（方向报告 1.3）：人工入口与 Agent 入口同一业务规则——
  // 乐观锁版本绑定 + 完整差异展示（每项 旧值→新值 + 来源引文）+ 驳回必填理由。
  function fmtVal(v) { if (v && typeof v === 'object') return JSON.stringify(v); return (v == null || v === '') ? '（空）' : String(v); }
  function isVersionConflict(err) {
    var msg = String((err && err.message) || err || '');
    return /版本|VERSION|revision|并发/i.test(msg);
  }
  async function proposals() {
    var pg = pagers.proposals;
    var res = await api('GET', '/proposals?status=pending&limit=' + pg.pageSize + '&offset=' + (pg.page - 1) * pg.pageSize);
    pg.total = (res.page && res.page.total != null) ? res.page.total : res.items.length;
    // 末页刚被清空（接受/拒绝完当页最后一条）：自动回退一页再拉，不留空白页
    if (!res.items.length && pg.page > 1) { pg.page--; return proposals(); }
    var names = await loadCharNames();
    var SRC = { history_backfill: '回填', chapter_summary: '章总结', advisor: '顾问', manual: '手动' };
    var byId = {};
    if (!panel('<div class="ledger-list-head"><h3>待审事实提案</h3><span>' + pg.total + ' 项</span></div><div class="ledger-card-list">' + (res.items.map(function (item) {
      byId[item.id] = item;
      var changes = (item.changes || []).map(function (c) {
        var who = c.change_kind === 'relation' ? '关系' : (names[String(c.subject_ref)] || ('人物#' + c.subject_ref));
        return '<li><span class="proposal-change-who">' + esc(who) + '</span> · ' + esc(c.field_key)
          + '：<s>' + esc(fmtVal(c.old_value)) + '</s> → <strong>' + esc(fmtVal(c.new_value)) + '</strong></li>';
      }).join('');
      var src = SRC[item.source_type] || item.source_type || '提案';
      var quote = item.source_quote ? '<blockquote class="proposal-quote">' + esc(item.source_quote) + '</blockquote>' : '';
      var supersede = item.supersedes_event_id ? '<span class="proposal-supersede" title="该提案用于替换一条既有事件">修正事件 #' + esc(item.supersedes_event_id) + '</span> · ' : '';
      return '<article class="proposal-card"><div><span class="proposal-kind">' + esc(src) + (item.chapter_title ? ' · ' + esc(item.chapter_title) : '')
        + ' · v' + esc(item.revision || 1) + ' · ' + supersede + esc(item.importance || 'normal') + '</span><h3>' + esc(item.title) + '</h3>'
        + (item.summary ? '<p>' + esc(item.summary) + '</p>' : '') + quote
        + '<ul class="proposal-changes">' + changes + '</ul></div><div class="proposal-actions"><button class="btn btn-primary btn-small" data-accept="' + item.id + '">接受</button><button class="btn btn-ghost btn-small" data-reject="' + item.id + '">拒绝</button></div></article>';
    }).join('') || '<div class="workbench-empty-card">收件箱已清空。</div>') + '</div>'
      + (window.ListPager ? window.ListPager.html(pg) : ''))) return;
    if (window.ListPager) window.ListPager.bind(document.getElementById('ledger-panel'), pg, proposals);
    document.querySelectorAll('[data-accept]').forEach(function (b) { b.onclick = async function () {
      var item = byId[b.dataset.accept] || {};
      try { await api('POST', '/proposals/' + b.dataset.accept + '/accept', { expected_revision: item.revision }); }
      catch (err) {
        window.App.toast(isVersionConflict(err) ? '提案已被并发修改（版本冲突），已为你刷新列表' : '接受失败：' + err.message);
        await proposals();
        return;
      }
      await proposals();
    }; });
    document.querySelectorAll('[data-reject]').forEach(function (b) { b.onclick = function () {
      var item = byId[b.dataset.reject] || {};
      window.App.openModal({
        title: '拒绝提案：' + (item.title || ''),
        okText: '确认拒绝',
        bodyHTML: '<label>拒绝理由（必填，会随提案留档）<textarea id="reject-note" rows="3" placeholder="例如：与第 12 章剧情矛盾"></textarea></label>',
        onOk: async function (body) {
          var note = (body.querySelector('#reject-note').value || '').trim();
          if (!note) { window.App.toast('拒绝必须填写理由：留档后作者/Agent 才能知道为什么被拒'); return false; }
          try { await api('POST', '/proposals/' + b.dataset.reject + '/reject', { review_note: note, expected_revision: item.revision }); }
          catch (err) {
            window.App.toast(isVersionConflict(err) ? '提案已被并发修改（版本冲突），已为你刷新列表' : '拒绝失败：' + err.message);
            await proposals();
            return false;
          }
          await proposals();
        }
      });
    }; });
  }
  // 事件撤销入口（方向报告 1.6）：retractEvent 内核与路由此前没有作者可见入口，
  // 发现已采纳的错误事件只能绕「修正提案」。与 Agent 工具 retract_event 同一语义：
  // append-only 撤销（原事件留档可审计，退出有效重放），必填理由写入撤销事件。
  async function events() {
    var pg = pagers.events;
    var res = await api('GET', '/events?limit=' + pg.pageSize + '&offset=' + (pg.page - 1) * pg.pageSize);
    pg.total = (res.page && res.page.total != null) ? res.page.total : res.items.length;
    if (!res.items.length && pg.page > 1) { pg.page--; return events(); }
    var byId = {};
    if (!panel('<div class="ledger-list-head"><h3>正式事实事件</h3><span>' + pg.total + ' 项</span></div><div class="ledger-card-list">' + (res.items.map(function (item) {
      byId[item.id] = item;
      return '<article class="ledger-event-card"><div><span>' + esc(item.chapter_title || '未绑定章节') + ' · ' + esc(item.importance) + '</span><h3>' + esc(item.title) + '</h3><p>' + (item.changes || []).length + ' 项事实变化 · 来源 ' + esc(item.origin) + '</p></div><div class="proposal-actions"><button class="btn btn-ghost btn-small" data-retract="' + item.id + '">撤销</button></div></article>';
    }).join('') || '<div class="workbench-empty-card">尚无正式事实事件。</div>') + '</div>'
      + (window.ListPager ? window.ListPager.html(pg) : ''))) return;
    if (window.ListPager) window.ListPager.bind(document.getElementById('ledger-panel'), pg, events);
    document.querySelectorAll('[data-retract]').forEach(function (b) { b.onclick = function () {
      var item = byId[b.dataset.retract] || {};
      window.App.openModal({
        title: '撤销事件：' + (item.title || ''),
        okText: '确认撤销',
        bodyHTML: '<p>将撤销事件 #' + esc(item.id) + '「' + esc(item.title) + '」：原记录保留可审计，但其 ' + (item.changes || []).length + ' 项状态变化不再生效，人物当前状态与关系投影会全量重建。</p>'
          + '<label>撤销理由（必填，写入撤销事件留档）<textarea id="retract-reason" rows="3" placeholder="例如：该事件与正文不符，系误抽取"></textarea></label>',
        onOk: async function (body) {
          var reason = (body.querySelector('#retract-reason').value || '').trim();
          if (!reason) { window.App.toast('撤销必须填写理由：撤销事件本身也会留档供审计'); return false; }
          try { await api('POST', '/events/' + item.id + '/retraction', { reason: reason }); }
          catch (err) {
            window.App.toast(/已被修正或撤销|SUPERSEDED/i.test(String(err && err.message)) ? '该事件已被修正或撤销，已为你刷新列表' : '撤销失败：' + err.message);
            await events();
            return false;
          }
          window.App.toast('已撤销，投影已重建');
          await events();
        }
      });
    }; });
  }
  function renderThreads() {
    var pg = pagers.threads;
    var pageItems = window.ListPager ? window.ListPager.slice(threadItems, pg) : threadItems;
    if (!panel('<div class="ledger-list-head"><h3>故事线与伏笔</h3><button id="new-thread" class="btn btn-primary btn-small">+ 新建</button></div><div class="ledger-card-list">' + (pageItems.map(function (item) { return '<article class="thread-card"><span>' + esc(THREAD_TYPE_LABELS[item.type] || item.type) + ' · ' + esc(item.status) + '</span><h3>' + esc(item.title) + '</h3><p>' + esc(item.summary || '') + '</p></article>'; }).join('') || '<div class="workbench-empty-card">尚无故事线。</div>') + '</div>'
      + (window.ListPager ? window.ListPager.html(pg) : ''))) return;
    if (window.ListPager) window.ListPager.bind(document.getElementById('ledger-panel'), pg, renderThreads);
    document.getElementById('new-thread').onclick = function () { window.App.openModal({ title: '新建故事线', okText: '创建', bodyHTML: '<label>类型<select id="thread-type">' + Object.keys(THREAD_TYPE_LABELS).map(function (key) { return '<option value="' + key + '">' + THREAD_TYPE_LABELS[key] + '</option>'; }).join('') + '</select></label><label>标题<input id="thread-title"></label><label>说明<textarea id="thread-summary" rows="4"></textarea></label>', onOk: async function (body) { await api('POST', '/threads', { title: body.querySelector('#thread-title').value, summary: body.querySelector('#thread-summary').value, type: body.querySelector('#thread-type').value, status: 'open' }); await threads(); } }); };
  }
  async function threads() {
    var res = await api('GET', '/threads');
    threadItems = res.items || [];
    renderThreads();
  }
  function renderIssues() {
    var pg = pagers.issues;
    var pageItems = window.ListPager ? window.ListPager.slice(issueItems, pg) : issueItems;
    if (!panel('<div class="ledger-list-head"><h3>一致性问题</h3><span>' + issueItems.length + ' 项</span></div><div class="ledger-card-list">' + (pageItems.map(function (item) { return '<article class="issue-card"><span>' + esc(item.type) + '</span><h3>' + esc(item.title) + '</h3></article>'; }).join('') || '<div class="workbench-empty-card">当前没有检测到问题。</div>') + '</div>'
      + (window.ListPager ? window.ListPager.html(pg) : ''))) return;
    if (window.ListPager) window.ListPager.bind(document.getElementById('ledger-panel'), pg, renderIssues);
  }
  async function issues() {
    var res = await api('GET', '/issues');
    issueItems = res.items || [];
    renderIssues();
  }
  async function load() {
    var bookId = String(state.route.bookId);
    var tab = state.tab;
    activeLoadToken = ws() && ws().beginRequest ? ws().beginRequest('ledger', bookId + '|' + tab) : null;
    try { await ({ overview: overview, proposals: proposals, events: events, threads: threads, issues: issues }[tab] || overview)(); }
    catch (e) { if (loadCurrent()) panel('<div class="workbench-error">' + esc(e.message) + '</div>'); }
  }
  LedgerWorkbench.show = function (route) {
    state.route = route; state.tab = route.tab || 'overview'; charNames = null;
    threadItems = []; issueItems = [];
    Object.keys(pagers).forEach(function (key) { pagers[key].page = 1; pagers[key].total = 0; });
    installGuard(); // 进展摘要在概览页签即可编辑：守卫先注册
    shell(); load();
  };
})();
