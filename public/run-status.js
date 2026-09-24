// run-status.js —— S4-05 统一可见状态（任务卡 / 保存三态 / 资料更新）。
//
// 解决的作者问题：任务到底是「在读、在跑、等你确认、失败、断了、还是做完了」，此前只能从
// 聊天话术和气泡文案里猜；保存状态也只有两态（未保存修改/已保存），S1-01 的「已应用未落盘」
// 在界面上看不出来；另一个空间改了当前资料时页面既不提示也不给下一步。
//
// 单一含义来源（冻结契约 01 §8 / §3.1）：
//   · 任务徽标只由服务端运行状态（running/awaiting_confirmation/paused/failed/interrupted/
//     cancelled/finished + reason）决定——length 截断是 paused/output_truncated，必须显示
//     「已暂停」而不是「完成」；声明完成必须带可查看的结果引用（run_finished.resultRefs）。
//   · 保存三态只由两件事决定：编辑器本地脏标记 + 服务端落盘事实（GET /api/health 的
//     persistence.lastSaveError/retryScheduled/exhausted，或 S1 的 503 PERSISTENCE_PENDING
//     响应）。任务 finished 与「当前新输入已保存」是两件事，这里不合并。
//   · 资料更新只提示、不覆盖：脏正文永远保留在编辑器里，刷新必须由作者点；聊天历史不自动加入。
//   · 未知就是未知：读不到服务端运行状态（网络中断/无权读取）显示「未知（待恢复）」，
//     绝不臆造成「失败」或「完成」。
//
// 本文件只做展示与状态推导，不写业务数据、不发写请求（唯一例外是作者点「重试落盘」时调用
// S1-01 既有的 POST /api/persistence/flush，该入口只尝试落盘、不重做业务写入）。
(function () {
  'use strict';

  var RS = window.RunStatus = window.RunStatus || {};

  // ---------- 文案（唯一表） ----------
  var BADGES = {
    running: '正在读取/执行',
    awaiting_confirmation: '待确认',
    paused: '已暂停',
    rejected: '已拒绝',
    failed: '失败',
    interrupted: '中断',
    cancelled: '已停止',
    finished: '完成',
    unknown: '未知（待恢复）',
  };
  var SAVE_BADGES = { local: '本地未保存', pending: '已应用未落盘', saved: '已保存' };
  var RESOURCE_BADGE = '资料更新';
  var UNKNOWN_DETAIL = '网络中断或读不到服务端状态：结果未知，网络恢复后自动重试。';

  RS.BADGES = BADGES;
  RS.SAVE_BADGES = SAVE_BADGES;
  RS.RESOURCE_BADGE = RESOURCE_BADGE;
  RS.MIN_INTERVAL_MS = 2000;

  // ---------- 任务徽标 ----------
  RS.taskBadge = function (run) {
    var status = run && run.status ? String(run.status) : '';
    var reason = run && run.reason ? String(run.reason) : '';
    if (status === 'paused') return reason === 'action_rejected' ? BADGES.rejected : BADGES.paused;
    if (Object.prototype.hasOwnProperty.call(BADGES, status) && status !== 'rejected') return BADGES[status];
    return BADGES.unknown;
  };

  RS.isTerminalStatus = function (status) {
    return ['finished', 'paused', 'failed', 'interrupted', 'cancelled'].indexOf(String(status || '')) >= 0;
  };

  // ---------- 保存三态 ----------
  // pending：本次保存明确回了「已应用未落盘」（S1 的 503 PERSISTENCE_PENDING）；
  // persistence：GET /api/health 的 persistence 快照（落盘失败/待重试 = 已应用未落盘）。
  // 落盘失败期间「已应用未落盘」优先于本地脏标记：磁盘落后是更不可见、更需要作者知道的事实。
  RS.saveBadge = function (input) {
    var i = input || {};
    var p = i.persistence || null;
    if (i.pending === true) return SAVE_BADGES.pending;
    if (p && (p.lastSaveError || p.retryScheduled || p.exhausted)) return SAVE_BADGES.pending;
    if (i.dirty) return SAVE_BADGES.local;
    return SAVE_BADGES.saved;
  };

  var persistenceSnapshot = null;   // 最近一次 GET /api/health 的 persistence
  var savePending = false;          // 最近一次写请求是否回了「已应用未落盘」

  RS.persistence = function () { return persistenceSnapshot; };
  RS.savePending = function () { return savePending; };
  RS.notePersistence = function (persistence) {
    if (!persistence || typeof persistence !== 'object') return persistenceSnapshot;
    persistenceSnapshot = persistence;
    if (persistence.durable === true) {
      savePending = false;
      return persistenceSnapshot;
    }
    if (persistence.durable === false) {
      savePending = true;    // S1 信封：本次写已应用到内存、磁盘没写上
      return persistenceSnapshot;
    }
    // /api/health 的原始状态：只有「失败事实」才算未落盘。dirty/pending 是 db 层的
    // debounce 队列（每次正常保存都会短暂为 true，db.js 自己称其为「谎报 pending」），
    // 拿它当失败会让作者每次保存都看见一次假的「已应用未落盘」；而落盘失败一定伴随
    // lastSaveError（并安排 retryScheduled，耗尽后 exhausted），成功落盘时 db.save()
    // 会清掉这三样 —— 所以用它们做唯一判据，恢复了就自动收回徽标。
    savePending = !!(persistence.lastSaveError || persistence.retryScheduled || persistence.exhausted);
    return persistenceSnapshot;
  };
  // 只认「失败事实」：durable=false / code=PERSISTENCE_PENDING。这里不能看 pending——
  // S1 的响应信封（durable/pending/code）里 pending=true 等于「saveNow 试过没写下去」，
  // 而 GET /api/health 的 persistence 来自 db.getPersistenceStatus()，同名 pending 只是
  // 1s debounce 计时器排着队（每次都正常保存也会短暂为 true）。两者混用会把正常保存
  // 误报成「已应用未落盘」，所以健康快照走 notePersistence，不走这里。
  RS.noteSaveOutcome = function (info) {
    var p = info && info.persistence ? info.persistence : info;
    if (!p || typeof p !== 'object') return savePending;
    var failed = p.durable === false || p.code === 'PERSISTENCE_PENDING';
    if (failed) {
      savePending = true;
      persistenceSnapshot = p;
    } else if (p.durable === true) {
      savePending = false;
      persistenceSnapshot = p;
    }
    return savePending;
  };

  // 落盘事实一变（读快照/重试 flush）就重画状态条徽标：磁盘恢复后不该等作者再敲一次键，
  // 页面自己的刷新（进入页面、每轮收尾、可见时低频轮询）就要把「已应用未落盘」收回去。
  function renderWritingSaveBadgeIfMounted() {
    if (!window.document || !window.document.getElementById('writing-status-save')) return null;
    return RS.renderWritingSaveBadge();
  }
  RS.renderWritingSaveBadgeIfMounted = renderWritingSaveBadgeIfMounted;

  // 观察 page 层的 HTTP 客户端：所有页面的写请求都经 App.api，落盘失败（200 带
  // persistence.durable=false 或 503 PERSISTENCE_PENDING）在这里被记成「已应用未落盘」。
  // 只观察不干预：原样返回结果/原样抛出错误。
  function observeApi() {
    var App = window.App;
    if (!App || typeof App.api !== 'function' || App.__runStatusObserved) return false;
    var orig = App.api;
    App.api = async function () {
      try {
        var res = await orig.apply(this, arguments);
        if (res && res.persistence) {
          RS.noteSaveOutcome(res.persistence);
          renderWritingSaveBadgeIfMounted();
        }
        return res;
      } catch (e) {
        if (e && (e.code === 'PERSISTENCE_PENDING' || (e.details && e.details.persistence))) {
          RS.noteSaveOutcome(e.code === 'PERSISTENCE_PENDING' ? { code: e.code, durable: false, pending: true } : e.details.persistence);
          renderWritingSaveBadgeIfMounted();
        }
        throw e;
      }
    };
    App.__runStatusObserved = true;
    return true;
  }
  RS.observeApi = observeApi;
  observeApi();

  // 读写盘快照（作者 UI 只读入口，复用 S1-01 的 /api/health）
  RS.loadPersistence = async function () {
    var App = window.App;
    if (!App || typeof App.api !== 'function') return persistenceSnapshot;
    try {
      var data = await App.api('GET', '/api/health');
      if (data && data.persistence) {
        RS.notePersistence(data.persistence);
        renderWritingSaveBadgeIfMounted();
      }
    } catch (e) { /* 读不到就保持上一份快照，不臆造「已保存」 */ }
    return persistenceSnapshot;
  };

  // 重试落盘：只调 S1-01 的 flush（不重做业务写入）
  RS.retryFlush = async function () {
    var App = window.App;
    if (!App || typeof App.api !== 'function') return { ok: false, message: '当前页面没有可用的接口层' };
    try {
      var data = await App.api('POST', '/api/persistence/flush', {});
      if (data && data.persistence) {
        RS.notePersistence(data.persistence);
        renderWritingSaveBadgeIfMounted();
      }
      var durable = !!(data && data.persistence && data.persistence.durable);
      return { ok: durable, message: durable ? '已写入磁盘' : '磁盘仍不可用：改动已保留在内存并将自动重试，请勿关闭页面' };
    } catch (e) {
      if (e && e.details && e.details.persistence) {
        RS.notePersistence(e.details.persistence);
        renderWritingSaveBadgeIfMounted();
      } else if (e && e.code === 'PERSISTENCE_PENDING') {
        RS.noteSaveOutcome({ code: e.code, durable: false, pending: true });
        renderWritingSaveBadgeIfMounted();
      }
      return { ok: false, message: (e && e.message) || '重试落盘失败' };
    }
  };

  // 写作页状态条上的保存徽标（book.js 的 renderWritingStatus 调用这里，单一含义来源）
  RS.renderWritingSaveBadge = function () {
    var BookPage = window.BookPage || {};
    var dirty = !!(BookPage.hasUnsavedChanges && BookPage.hasUnsavedChanges());
    var badge = RS.saveBadge({ dirty: dirty, pending: savePending, persistence: persistenceSnapshot });
    var el = document.getElementById('writing-status-save');
    if (el) el.textContent = badge;
    return badge;
  };

  // ---------- 资料更新（另一空间改了当前资料）----------
  var resourceStamps = {};

  RS.resourceStamp = function (resource) {
    if (!resource || typeof resource !== 'object') return null;
    var meta = resource.meta || {};
    var revision = meta.revision != null ? meta.revision : (resource.revision != null ? resource.revision : null);
    return {
      revision: revision == null ? null : Number(revision),
      updatedAt: resource.updatedAt || resource.updated_at || null,
      deleted: resource.status === 'deleted' || resource.found === false,
    };
  };

  RS.stampChanged = function (before, after) {
    if (!before || !after) return false;
    if (before.deleted !== after.deleted) return true;
    if (before.deleted && after.deleted) return false;
    if (before.revision != null && after.revision != null) return before.revision !== after.revision;
    return String(before.updatedAt || '') !== String(after.updatedAt || '');
  };

  // 记录本次读到的服务端版本；返回是否相对上次发生变化（第一次只建立基线）
  RS.observeResource = function (key, resource) {
    var stamp = RS.resourceStamp(resource);
    if (!stamp) return { changed: false, current: null, previous: null, first: false };
    var previous = resourceStamps[key] || null;
    resourceStamps[key] = stamp;
    return { changed: RS.stampChanged(previous, stamp), current: stamp, previous: previous, first: !previous };
  };

  // 刷新动作：脏正文永不被覆盖；干净时才由调用方重新从服务端取该对象
  RS.applyResourceRefresh = function (input) {
    var i = input || {};
    if (i.dirty) {
      return {
        applied: false, reason: 'dirty_editor',
        hint: '编辑器里还有未保存的修改：已保留你的稿子，未从服务端覆盖。请先保存（或复制）后再刷新。',
      };
    }
    if (typeof i.reload === 'function') {
      return { applied: true, reason: 'clean', result: i.reload() };
    }
    return { applied: false, reason: 'no_loader', hint: '当前没有可用的重新加载入口。' };
  };

  // ---------- 工具细节（折叠；可展开看目标与来源版本）----------
  var TARGET_KEYS = ['chapter_id', 'chapterId', 'character_id', 'characterId', 'entity_id', 'world_id', 'volume_id', 'note_id', 'handoff_id', 'book_id', 'bookId', 'name'];

  RS.toolTarget = function (args) {
    if (!args || typeof args !== 'object') return null;
    for (var i = 0; i < TARGET_KEYS.length; i++) {
      var v = args[TARGET_KEYS[i]];
      if (v === undefined || v === null || v === '') continue;
      return TARGET_KEYS[i] + '=' + v;
    }
    return null;
  };

  // 来源版本只从工具结果里已经返回的字段取（revision / sourceVersion / 指纹），没有就是 null
  RS.toolSourceVersion = function (result) {
    if (!result || typeof result !== 'object') return null;
    var data = result.data && typeof result.data === 'object' ? result.data : result;
    if (data.chapter && data.chapter.revision != null) return 'revision ' + data.chapter.revision;
    if (data.volume && data.volume.revision != null) return 'revision ' + data.volume.revision;
    if (data.revision != null) return 'revision ' + data.revision;
    if (data.sourceVersion != null) return 'sourceVersion ' + data.sourceVersion;
    if (data.sourceFingerprint) return 'fingerprint ' + String(data.sourceFingerprint).slice(0, 12);
    return null;
  };

  RS.toolDetails = function (list) {
    return (Array.isArray(list) ? list : []).map(function (t) {
      var result = t && t.result;
      var data = result && result.data && typeof result.data === 'object' ? result.data : result;
      return {
        name: (t && t.name) || (data && data.name) || '',
        target: RS.toolTarget(t && t.args),
        sourceVersion: RS.toolSourceVersion(result),
        status: result && result.ok === false ? 'failed' : 'ok',
      };
    });
  };

  // ---------- 确认卡与会话绑定 ----------
  // 待确认卡只属于它自己的会话：其他会话（或没有会话归属的旧卡）不显示为当前会话的待确认。
  RS.actionsForConversation = function (actions, conversationId) {
    var list = Array.isArray(actions) ? actions : [];
    var bound = [];
    var unbound = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i] || {};
      var cid = a.conversationId || a.conversation_id || null;
      if (cid && conversationId && String(cid) === String(conversationId)) bound.push(a);
      else unbound.push(a);
    }
    return { bound: bound, unbound: unbound };
  };

  // ---------- 结果引用 ----------
  RS.resultRefsFrom = function (events, run) {
    var refs = [];
    var list = Array.isArray(events) ? events : [];
    for (var i = list.length - 1; i >= 0; i--) {
      var ev = list[i] || {};
      if (ev.type === 'run_finished' && ev.payload && Array.isArray(ev.payload.resultRefs)) {
        refs = ev.payload.resultRefs;
        break;
      }
    }
    if (!refs.length && run && Array.isArray(run.resultRefs)) refs = run.resultRefs;
    return refs;
  };

  RS.nextStepFor = function (badge, opts) {
    var o = opts || {};
    if (badge === BADGES.failed) return { label: '查看运行记录后重试', href: '#/agent' };
    if (badge === BADGES.interrupted) return { label: '核对目标内容后重新发起', href: '#/agent' };
    if (badge === BADGES.awaiting_confirmation) return { label: '回到会话处理待确认操作', href: '#/agent' };
    if (badge === BADGES.unknown) return { label: '重试读取运行状态', action: 'retry' };
    if (badge === BADGES.paused) return { label: '按已取得的结果继续（任务未完成）', href: o.continueHref || '#/agent' };
    if (badge === BADGES.rejected) return { label: '重新发起需要作者先说明理由', href: '#/agent' };
    return null;
  };

  // ---------- 卡片模型 ----------
  RS.cardModel = function (input) {
    var i = input || {};
    var run = i.run || null;
    // 没有运行快照时不摆徽标（也不猜）：只有真正读到服务端状态才给徽标
    var badge = run ? RS.taskBadge(run) : null;
    var tools = RS.toolDetails(i.tools || []);
    var refs = RS.resultRefsFrom(i.events || [], run);
    var scope = RS.actionsForConversation(i.actions || [], i.conversationId || null);
    var toolErrors = (i.toolErrors || []).slice();
    return {
      badge: badge,
      status: (run && run.status) || null,
      reason: (run && run.reason) || null,
      runId: (i.runId || (run && run.id)) || null,
      conversationId: i.conversationId || null,
      unknown: badge === BADGES.unknown,
      finished: badge === BADGES.finished,
      hasRun: !!run,
      resultRefs: refs,
      hasResultRefs: refs.length > 0,
      tools: tools,
      toolErrors: toolErrors,
      pendingActions: scope.bound,
      otherConversationActions: scope.unbound.length,
      resourceNotice: i.resourceNotice || null,
      detail: i.detail || null,
      recovered: i.recovered || null,
      nextStep: RS.nextStepFor(badge, i),
    };
  };

  RS.unknownCard = function (input) {
    var i = input || {};
    var card = RS.cardModel({
      run: null,
      conversationId: i.conversationId || null,
      detail: i.detail || UNKNOWN_DETAIL,
      recovered: 'unknown',
    });
    card.badge = BADGES.unknown;      // 明确：读不到服务端状态＝未知（待恢复），不是失败也不是完成
    card.unknown = true;
    card.nextStep = RS.nextStepFor(BADGES.unknown, {});
    return card;
  };

  // ---------- 渲染（DOM API；模块自带样式，不改 style.css）----------
  var STYLE_ID = 'run-status-style';
  function ensureStyle() {
    var doc = window.document;
    if (!doc || !doc.head || typeof doc.createElement !== 'function') return;
    if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.run-card{display:flex;flex-direction:column;gap:4px;padding:6px 10px;font-size:12px;'
      + 'border-bottom:1px solid rgba(127,127,127,.25);align-items:flex-start}'
      + '.run-card.hidden{display:none}'
      + '.run-badge{font-weight:600}'
      + '.run-card .run-tools{font-size:12px}'
      + '.run-card .run-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}';
    doc.head.appendChild(style);
  }

  function span(className, text) {
    var el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function actionLink(label, href) {
    var a = document.createElement('a');
    a.className = 'run-action-link';
    a.href = href;
    a.textContent = label;
    return a;
  }

  // 渲染任务卡。opts.onRefresh：作者点「刷新」（资料更新）时的回调。
  RS.mountTaskCard = function (target, model, opts) {
    var o = opts || {};
    var host = typeof target === 'string' ? document.getElementById(target) : target;
    if (!host) return null;
    var doc = window.document;
    ensureStyle();
    host.innerHTML = '';
    if (!model) {
      host.classList.add('hidden');
      return host;
    }
    host.classList.remove('hidden');

    var head = doc.createElement('div');
    head.className = 'run-head';
    if (model.badge) head.appendChild(span('run-badge', model.badge));
    if (model.detail) head.appendChild(span('run-detail', '· ' + model.detail));
    host.appendChild(head);

    if (model.finished) {
      if (model.hasResultRefs) {
        var rl = doc.createElement('div');
        rl.className = 'run-results';
        rl.appendChild(span('run-results-label', '结果引用：'));
        model.resultRefs.forEach(function (r, idx) {
          var href = r && (r.route || r.href);
          var label = (r && (r.label || r.id)) || ('#' + (idx + 1));
          if (href) rl.appendChild(actionLink('查看结果 ' + label, href));
          else rl.appendChild(span('run-result-item', String(label)));
        });
        host.appendChild(rl);
      } else {
        host.appendChild(span('run-no-result', '本轮没有可核验的结果引用：徽标只表示运行收尾，不代表已写入任何内容。'));
      }
    }

    if (model.tools.length) {
      var details = doc.createElement('details');
      details.className = 'run-tools';
      var summary = doc.createElement('summary');
      summary.textContent = '工具细节（' + model.tools.length + '）— 目标与来源版本';
      details.appendChild(summary);
      var ul = doc.createElement('ul');
      model.tools.forEach(function (t) {
        var li = doc.createElement('li');
        li.textContent = (t.name || '工具') + ' · 目标：' + (t.target || '未提供')
          + ' · 来源版本：' + (t.sourceVersion || '未提供');
        ul.appendChild(li);
      });
      details.appendChild(ul);
      host.appendChild(details);
    }

    if (model.toolErrors.length) {
      var errs = doc.createElement('details');
      errs.className = 'run-tool-errors';
      var esum = doc.createElement('summary');
      esum.textContent = '被拒绝/失败的工具（' + model.toolErrors.length + '）';
      errs.appendChild(esum);
      var eul = doc.createElement('ul');
      model.toolErrors.forEach(function (e) {
        var li = doc.createElement('li');
        li.textContent = (e.code ? '[' + e.code + '] ' : '') + (e.toolName || '') + '：' + (e.message || '');
        eul.appendChild(li);
      });
      errs.appendChild(eul);
      host.appendChild(errs);
    }

    if (model.pendingActions.length || model.otherConversationActions) {
      var pl = doc.createElement('div');
      pl.className = 'run-pending';
      model.pendingActions.forEach(function (a) {
        pl.appendChild(span('run-pending-item', '待确认（本会话）：' + (a.summary || a.name || a.id)));
      });
      if (model.otherConversationActions) {
        pl.appendChild(span('run-pending-other', '另有 ' + model.otherConversationActions + ' 张待确认卡属于其他会话，不在本会话显示。'));
      }
      host.appendChild(pl);
    }

    if (model.resourceNotice) {
      var rn = doc.createElement('div');
      rn.className = 'run-resource-notice';
      rn.appendChild(span('run-resource-badge', model.resourceNotice.badge));
      rn.appendChild(span('run-resource-detail', '· ' + model.resourceNotice.detail));
      var actions = doc.createElement('div');
      actions.className = 'run-actions';
      (model.resourceNotice.actions || []).forEach(function (a) {
        if (a.key === 'diff') actions.appendChild(actionLink(a.label, a.href || '#'));
        else {
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-small btn-outline';
          btn.id = 'writing-run-card-refresh';
          btn.textContent = a.label;
          btn.onclick = function () { if (typeof o.onRefresh === 'function') o.onRefresh(); };
          actions.appendChild(btn);
        }
      });
      rn.appendChild(actions);
      host.appendChild(rn);
    }

    if (model.nextStep) {
      var ns = doc.createElement('div');
      ns.className = 'run-next';
      if (model.nextStep.action === 'retry' && typeof o.onRetry === 'function') {
        var rbtn = doc.createElement('button');
        rbtn.type = 'button';
        rbtn.className = 'btn btn-small btn-outline';
        rbtn.id = 'run-card-retry';
        rbtn.textContent = model.nextStep.label;
        rbtn.onclick = function () { o.onRetry(); };
        ns.appendChild(rbtn);
      } else if (model.nextStep.href) {
        ns.appendChild(actionLink('下一步：' + model.nextStep.label, model.nextStep.href));
      } else {
        ns.appendChild(span('run-next-label', '下一步：' + model.nextStep.label));
      }
      host.appendChild(ns);
    }
    return host;
  };

  // ---------- 从服务端重建（刷新后不靠浏览器上一条气泡）----------
  // 服务端有两个真相源：会话消息里的运行快照（GET /chat 的 message.run，写作入口与 Agent 入口
  // 都有）与运行行/事件（GET /api/runs/:id[/events]，写作入口有事件表）。两者都读不到 → 未知。
  RS.runFromMessages = function (messages) {
    var list = Array.isArray(messages) ? messages : [];
    for (var i = list.length - 1; i >= 0; i--) {
      var run = list[i] && list[i].run;
      if (run && run.status) return run;
    }
    return null;
  };

  RS.cardFromMessages = function (messages, opts) {
    var o = opts || {};
    var run = RS.runFromMessages(messages);
    if (!run) return null;
    return RS.cardModel({
      run: run,
      conversationId: o.conversationId || null,
      actions: o.actions || [],
      tools: o.tools || [],
      toolErrors: o.toolErrors || [],
      resourceNotice: o.resourceNotice || null,
      recovered: 'server',
    });
  };

  RS.rebuildFromServer = async function (input) {
    var i = input || {};
    if (!i.runId) return { ok: false, card: RS.unknownCard({ conversationId: i.conversationId || null }) };
    var doFetch = i.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, card: RS.unknownCard({ conversationId: i.conversationId || null }) };
    var res = null;
    try {
      res = await doFetch('/api/runs/' + encodeURIComponent(i.runId), {
        headers: { 'x-session-key': i.sessionKey || '' },
      });
    } catch (e) {
      return { ok: false, card: RS.unknownCard({ conversationId: i.conversationId || null }) };
    }
    if (!res || !res.ok) {
      return { ok: false, card: RS.unknownCard({ conversationId: i.conversationId || null, detail: '读不到运行状态（HTTP ' + (res && res.status) + '）：不臆造成功或失败。' }) };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!data || !data.run) return { ok: false, card: RS.unknownCard({ conversationId: i.conversationId || null }) };
    var events = null;
    try {
      var eres = await doFetch('/api/runs/' + encodeURIComponent(i.runId) + '/events?afterSeq=0', {
        headers: { 'x-session-key': i.sessionKey || '' },
      });
      if (eres && eres.ok) { var ed = await eres.json(); events = (ed && ed.events) || null; }
    } catch (e) { events = null; }   // Agent 入口本来就没有事件表：只有运行行，如实标记
    return {
      ok: true,
      events: events,
      card: RS.cardModel({
        run: data.run,
        runId: data.run.id,
        conversationId: (i.conversationId || data.run.conversationId) || null,
        events: events || [],
        actions: i.actions || [],
        resourceNotice: i.resourceNotice || null,
        recovered: 'server',
      }),
    };
  };

  // ---------- 低频轮询（按需 / 页面可见时；完成后停止）----------
  // intervalMs 有下限（RS.MIN_INTERVAL_MS）：不接受「每秒全库扫描」这类高频查询。
  RS.createWatcher = function (opts) {
    var o = opts || {};
    var interval = Math.max(Number(o.intervalMs) || 5000, RS.MIN_INTERVAL_MS);
    var timer = null;
    var isStopped = false;
    var skippedHidden = 0;
    function visible() { return typeof o.isVisible === 'function' ? !!o.isVisible() : true; }
    async function tick() {
      if (isStopped) return null;
      if (!visible()) { skippedHidden += 1; return null; }
      var card = await o.load();
      if (o.onUpdate && card) o.onUpdate(card);
      if (card && card.terminal) stop();
      return card || null;
    }
    function start() {
      if (isStopped || timer) return;
      timer = setInterval(function () { tick().catch(function () { /* 单次失败不打断轮询 */ }); }, interval);
    }
    function stop() {
      isStopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    }
    return {
      intervalMs: interval,
      tick: tick,
      start: start,
      stop: stop,
      stopped: function () { return isStopped; },
      skippedHidden: function () { return skippedHidden; },
    };
  };

  RS.onVisibilityChange = function (handler) {
    if (!window.document || typeof window.document.addEventListener !== 'function') return false;
    window.document.addEventListener('visibilitychange', handler);
    return true;
  };

  // ---------- 工作台任务入口 ----------
  RS.mountWorkbenchTask = async function (target, opts) {
    var o = opts || {};
    var host = typeof target === 'string' ? document.getElementById(target) : target;
    if (!host) return null;
    var App = window.App;
    var items = [];
    if (App && typeof App.api === 'function' && o.bookId) {
      try {
        var data = await App.api('GET', '/api/resources?type=task&bookId=' + encodeURIComponent(o.bookId) + '&limit=1');
        items = (data && data.items) || [];
      } catch (e) { items = []; }
    }
    var latest = items[0] || null;
    var run = latest ? { id: latest.id, status: latest.status, reason: latest.meta && latest.meta.reason } : null;
    var model = RS.cardModel({
      run: run,
      runId: latest ? latest.id : null,
      detail: latest
        ? ('《' + (o.bookTitle || ('#' + o.bookId)) + '》最近一次任务：' + (latest.title || latest.id)
          + '（' + (latest.updatedAt || '时间未记录') + '）')
        : ('《' + (o.bookTitle || ('#' + o.bookId)) + '》还没有运行记录：这里不会臆造完成状态。'),
    });
    if (!latest) model.badge = '没有运行记录';
    if (!latest) model.nextStep = null;
    RS.mountTaskCard(host, model, {});
    return model;
  };
})();
