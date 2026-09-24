// AI 助手页：function-calling Agent 对话界面
// 后端走 Vercel AI SDK UI Message Stream（SSE），这里逐事件渲染：
// 文本流 / 思考过程 / 工具调用（输入+结果折叠块）。
// S3-02：正典历史迁到服务端会话（/api/conversations）——localStorage 旧历史只作为
// 待导入资料（作者预览后导入、确认后才清理本地副本）；发送只带 conversation_id+content。
// S4-01b：页面按「范围」组织——顶部选一本书或全局资源，左侧在会话/资源之间切换，
// 资源走 S4-01a 的 GET /api/resources（与 list_resources/get_resource_summary 同一份目录），
// 点击进右侧预览或既有工作台。切范围只选择或新建该范围的会话，绝不改写原会话归属。
(function () {
  'use strict';

  var A = App;
  var HISTORY_KEY = 'agent_history_v1';
  var CONVERSATION_KEY = 'agent_conversation_v1';

  // legacy 本地历史（只读待导入；损坏/缺失按空处理，绝不影响服务端数据）
  var legacyHistory = [];
  try {
    legacyHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(legacyHistory)) legacyHistory = [];
  } catch (e) { legacyHistory = []; }

  var sending = false;
  var inited = false;
  // 稳定会话 id：S3-02 前创建的旧确认卡仍靠它过后端 session 校验（新卡走 conversation_id）。
  var SESSION_KEY = 'agent_session_v1';
  function newSessionId() {
    return 'agent:' + Math.random().toString(36).slice(2) + ':' + Date.now().toString(36);
  }
  var sessionId = newSessionId();
  try {
    var savedSession = localStorage.getItem(SESSION_KEY);
    if (savedSession) sessionId = savedSession;
    else localStorage.setItem(SESSION_KEY, sessionId);
  } catch (e) { /* localStorage 不可用则退回内存态 */ }

  // ---------- 服务端会话（S3-02 正典）----------
  var conversations = [];
  var currentConversation = null;

  // ---------- S4-01b：范围（一本书 / 全局资源）、剧情边界与资源视图 ----------
  // 范围决定三件事：能看到哪些资源、资料快照的时序边界、能不能进执行模式。
  // 切范围只做「选择该范围现有会话，或按该范围新建」——服务端契约 §4 规定会话建立后
  // kind/scope/book_id 不允许静默改变，所以这里没有、也不会有改归属的请求。
  var SCOPE_KEY = 'agent_scope_v1';
  // 与 server/resources/catalog.js 的白名单一致：书内类型（必须带 bookId）/ 全局类型。
  // style 与 task 是全局资产、可作为书过滤器；book/corpus/system 不接受 bookId（服务端 400）。
  var BOOK_SCOPED_TYPES = ['chapter', 'outline', 'character', 'world', 'ledger', 'style', 'task'];
  var GLOBAL_SCOPED_TYPES = ['book', 'style', 'corpus', 'task', 'system'];
  var BOOK_ID_TYPES = { chapter: 1, outline: 1, character: 1, world: 1, ledger: 1, style: 1, task: 1 };
  var RES_TYPE_LABELS = {
    book: '书籍', chapter: '章节', outline: '大纲（卷）', character: '人物', world: '世界观',
    ledger: '事件账本', style: '作家卡', corpus: '语料元数据', task: '任务 / 运行', system: '系统能力',
  };
  var RES_STATUS_LABELS = {
    active: '在场', archived: '已归档', locked: '已定稿', draft: '草稿', stale: '已过期',
    enabled: '启用', disabled: '停用', ready: '就绪', empty: '空', canonical: '正典',
    configured: '已配置', unconfigured: '未配置', deleted: '已删除（回收站）', ok: '正常', collab: '协作模式',
  };
  var RES_META_LABELS = {
    sortOrder: '序号', revision: '版本', locked: '定稿', volumeId: '所属卷', charCount: '正文字数',
    summaryChars: '摘要字数', outlineChars: '大纲字数', stale: '摘要过期', chapterCount: '章节数',
    characterCount: '人物数', volumeCount: '卷数', eventCount: '事件数', role: '身份', archived: '已归档',
    aliasCount: '别名数', relationCount: '关系数', importance: '重要性', origin: '来源', sourceStale: '来源过期',
    pendingProposalCount: '待审提案', kind: '类型', shared: '共享卡', builtin: '内置', enabled: '启用',
    ruleCount: '规则条目', sampleCount: '范文段数', indexedSampleCount: '索引段数', lastIndexedAt: '最近索引时间',
    works: '作品', hanCount: '汉字数', docCount: '文档数', jobCount: '蒸馏任务数', maskDictVersion: '掩码词表',
    model: '模型', modelConfigured: '模型已配置', keyConfigured: '密钥已配置', thinkingDisabledModels: '关闭思考模型',
    protocol: '协议', entry: '入口', mode: '模式', finishedAt: '结束时间', hasConversation: '有会话绑定',
    intro: '简介', masterOutlineChars: '总纲字数', chapterId: '所属章', driftStatus: '偏离状态',
  };
  var RES_DETAIL_LABELS = {
    index: '索引', note: '备注', persona: '人设', boundBooks: '绑定书籍', summary: '摘要', beat: '节拍',
    content: '内容', intro: '简介', outline: '大纲', aliases: '别名', jobs: '蒸馏任务', driftStatus: '偏离状态',
    conversationId: '会话', eventCount: '事件数', vectorModel: '向量模型', samples: '范文段数', indexed: '已索引',
    lastIndexedAt: '最近索引时间', stage: '阶段', status: '状态',
  };
  var books = [];
  var agentScope = readSavedScope();
  var boundaryChapterId = null;   // null = 全书（无时序边界）
  var boundaryChapters = [];
  var activeSideTab = 'conversations';
  var resType = '';
  var resCursor = null;
  var resItems = [];
  // S4-04b：讨论结论 → 规划笔记 / 显式交接（写作页）的状态
  var pickedMessages = [];       // 作者勾选的讨论消息（{id, role, content}），只在本轮渲染内有效
  var pickInputs = [];           // {id, input}：与消息区复选框一一对应（清空选择时同步 UI）
  var lastPlanningNote = null;   // 本会话最近保存的规划笔记（可作交接的来源引用）
  var handoffSubmitting = false; // 防重复点击：一次点击只创建一个草案
  var handoffAccepting = false;  // 防重复点击：一次点击只发一笔采纳
  var handoffCancelling = false; // 防重复点击：一次点击只发一笔作废

  function readSavedScope() {
    try {
      var raw = localStorage.getItem(SCOPE_KEY);
      if (raw === 'global') return { kind: 'global', bookId: null };
      var m = /^book:(\d+)$/.exec(raw || '');
      if (m) return { kind: 'book', bookId: Number(m[1]) };
    } catch (e) { /* localStorage 不可用则退回全局 */ }
    return { kind: 'global', bookId: null };
  }
  function scopeKey(scope) {
    return scope.kind === 'book' ? ('book:' + scope.bookId) : 'global';
  }
  function saveScope() {
    try { localStorage.setItem(SCOPE_KEY, scopeKey(agentScope)); } catch (e) { /* 忽略 */ }
  }
  function parseScopeValue(value) {
    if (value === 'global') return { kind: 'global', bookId: null };
    var m = /^book:(\d+)$/.exec(String(value || ''));
    return m ? { kind: 'book', bookId: Number(m[1]) } : null;
  }
  function currentBook() {
    if (agentScope.kind !== 'book') return null;
    for (var i = 0; i < books.length; i++) {
      if (Number(books[i].id) === Number(agentScope.bookId)) return books[i];
    }
    return null;
  }
  function scopeBookTitle() {
    var b = currentBook();
    return b ? b.title : ('书籍 #' + agentScope.bookId);
  }
  function conversationInScope(c) {
    if (!c) return false;
    if (c.scope !== agentScope.kind) return false;
    if (agentScope.kind === 'global') return true;
    return Number(c.book_id) === Number(agentScope.bookId);
  }
  function firstConversationInScope() {
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].status !== 'archived' && conversationInScope(conversations[i])) return conversations[i];
    }
    return null;
  }

  function renderScopeBar() {
    var sel = el('agent-scope-select');
    if (sel) {
      sel.innerHTML = '';
      var g = document.createElement('option');
      g.value = 'global';
      g.textContent = '全局资源（跨书检索 · 只读讨论）';
      sel.appendChild(g);
      for (var i = 0; i < books.length; i++) {
        var opt = document.createElement('option');
        opt.value = 'book:' + books[i].id;
        opt.textContent = '《' + books[i].title + '》';
        sel.appendChild(opt);
      }
      // 记住的书已被删除：明确回落全局，不猜一本书
      var known = ['global'];
      for (var k = 0; k < books.length; k++) known.push('book:' + books[k].id);
      if (known.indexOf(scopeKey(agentScope)) < 0) { agentScope = { kind: 'global', bookId: null }; saveScope(); }
      sel.value = scopeKey(agentScope);
    }
    var bsel = el('agent-boundary-select');
    if (bsel) {
      var isBook = agentScope.kind === 'book';
      bsel.innerHTML = '';
      var all = document.createElement('option');
      all.value = '';
      all.textContent = isBook ? '全书（无时序边界）' : '全书（先选一本书）';
      bsel.appendChild(all);
      if (isBook) {
        for (var c = 0; c < boundaryChapters.length; c++) {
          var ch = boundaryChapters[c];
          var co = document.createElement('option');
          co.value = String(ch.id);
          var order = ch.meta && ch.meta.sortOrder != null ? ch.meta.sortOrder : null;
          co.textContent = (order != null ? '第' + order + '章 · ' : '') + (ch.title || ('#' + ch.id));
          bsel.appendChild(co);
        }
      }
      bsel.disabled = !isBook;
      bsel.value = isBook && boundaryChapterId ? String(boundaryChapterId) : '';
    }
    renderScopeStatus();
  }

  function boundaryLabel() {
    for (var i = 0; i < boundaryChapters.length; i++) {
      if (Number(boundaryChapters[i].id) === Number(boundaryChapterId)) return '截至《' + boundaryChapters[i].title + '》';
    }
    return boundaryChapterId ? ('截至章节 #' + boundaryChapterId) : '全书';
  }
  function modeLabel() {
    if (agentScope.kind !== 'book') return '只读讨论（不可写）';
    return agentMode === 'execute' ? '执行操作（每步需确认）' : '只读讨论（不可写）';
  }
  function renderScopeStatus() {
    var s = el('agent-scope-status');
    if (!s) return;
    var bits = [];
    bits.push('范围：' + (agentScope.kind === 'book' ? ('《' + scopeBookTitle() + '》') : '全局资源'));
    bits.push('会话：' + (currentConversation ? (currentConversation.title || '未命名会话') : '未选择（发送时新建）'));
    if (agentScope.kind === 'book') bits.push('边界：' + boundaryLabel());
    bits.push('模式：' + modeLabel());
    s.textContent = bits.join(' · ');
  }

  function renderConversationList() {
    var ul = el('agent-conversation-list');
    if (!ul) return;
    ul.innerHTML = '';
    var list = [];
    for (var i = 0; i < conversations.length; i++) if (conversationInScope(conversations[i])) list.push(conversations[i]);
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'agent-tools-hint';
      empty.textContent = '该范围还没有会话：发送一条消息或点「新会话」即会按当前范围新建（不会借用别的书或全局历史）。';
      ul.appendChild(empty);
      return;
    }
    for (var k = 0; k < list.length; k++) {
      (function (c) {
        var li = document.createElement('li');
        li.className = 'item-row agent-conversation-item' + (currentConversation && currentConversation.id === c.id ? ' active' : '');
        li.dataset.conversationId = c.id;
        var name = document.createElement('span');
        name.className = 'agent-conv-title';
        name.textContent = (c.title || '未命名会话') + (c.status === 'archived' ? '（已归档）' : '');
        var meta = document.createElement('span');
        meta.className = 'agent-conv-meta';
        meta.textContent = c.scope === 'book' ? '书籍' : '全局';
        li.appendChild(name);
        li.appendChild(meta);
        li.onclick = function () { selectConversation(c.id); };
        ul.appendChild(li);
      })(list[k]);
    }
  }

  async function loadBooks() {
    try {
      var data = await A.api('GET', '/api/books');
      books = (data && data.books) || [];
    } catch (e) { books = []; }
  }

  // 剧情边界选项来自本书章节（受控资源目录：与助手只读工具同一份 data 源）
  async function loadBoundaryChapters() {
    boundaryChapters = [];
    if (agentScope.kind !== 'book') { boundaryChapterId = null; renderScopeBar(); return; }
    try {
      var data = await A.api('GET', '/api/resources?type=chapter&bookId=' + encodeURIComponent(agentScope.bookId) + '&limit=100');
      boundaryChapters = (data && data.items) || [];
    } catch (e) { boundaryChapters = []; }
    if (boundaryChapterId && !boundaryChapters.some(function (c) { return Number(c.id) === Number(boundaryChapterId); })) {
      boundaryChapterId = null; // 章节已不在（被删/换书）：回全书，不猜
    }
    renderScopeBar();
  }

  // 切范围：选择该范围现有会话（无则留空，发送或「新会话」时按当前范围新建）
  async function switchScope(value) {
    var next = parseScopeValue(value);
    if (!next) return;
    agentScope = next;
    var token = scopeKey(next);
    boundaryChapterId = null;
    boundaryChapters = [];
    saveScope();
    currentConversation = firstConversationInScope();
    try { localStorage.setItem(CONVERSATION_KEY, currentConversation ? currentConversation.id : ''); } catch (e) { /* 忽略 */ }
    renderConversationBar();
    renderConversationList();
    renderScopeBar();
    refreshModeBtn();
    renderResourceTypes();
    await loadBoundaryChapters();
    if (scopeKey(agentScope) !== token) return; // 又切走：这次范围的结果丢弃，不写进新范围
    if (activeSideTab === 'resources') await loadResources({ reset: true });
    if (scopeKey(agentScope) !== token) return;
    await renderServerHistory();
  }

  // ---------- S4-01b：受控资源视图（GET /api/resources）----------
  function resourceTypesForScope() {
    return (agentScope.kind === 'book' ? BOOK_SCOPED_TYPES : GLOBAL_SCOPED_TYPES).slice();
  }
  function renderResourceTypes() {
    var sel = el('agent-res-type');
    if (!sel) return;
    var types = resourceTypesForScope();
    if (types.indexOf(resType) < 0) { resType = types[0]; resCursor = null; resItems = []; }
    sel.innerHTML = '';
    for (var i = 0; i < types.length; i++) {
      var o = document.createElement('option');
      o.value = types[i];
      o.textContent = RES_TYPE_LABELS[types[i]] || types[i];
      sel.appendChild(o);
    }
    sel.value = resType;
  }

  // 资源请求参数：书内类型在书籍范围带 bookId；全局范围一律不带（book/corpus/system 会被 400）
  function resourceQuery(parts) {
    var out = ['type=' + encodeURIComponent(resType)];
    if (agentScope.kind === 'book' && BOOK_ID_TYPES[resType]) out.push('bookId=' + encodeURIComponent(agentScope.bookId));
    for (var i = 0; i < (parts || []).length; i++) out.push(parts[i]);
    return out.join('&');
  }

  function resourceMetaText(it) {
    var m = it.meta || {};
    var bits = [];
    if (it.type === 'chapter' && m.sortOrder != null) bits.push('第' + m.sortOrder + '章');
    if (it.type === 'style') {
      bits.push('规则 ' + (m.ruleCount || 0));
      bits.push('索引 ' + (m.indexedSampleCount || 0) + '/' + (m.sampleCount || 0));
      if (m.shared) bits.push('共享卡');
    } else if (it.type === 'book') {
      bits.push('章节 ' + (m.chapterCount || 0));
    } else if (it.type === 'outline') {
      bits.push('大纲 ' + (m.outlineChars || 0) + ' 字');
      if (m.stale) bits.push('卷摘要已过期');
    } else if (it.type === 'character') {
      bits.push(m.role ? ('身份 ' + m.role) : '人物');
      if (m.archived) bits.push('已归档');
    } else if (it.type === 'world') {
      bits.push('设定 ' + (m.contentChars || 0) + ' 字');
    } else if (it.type === 'ledger') {
      bits.push('事件');
      if (m.chapterId) bits.push('挂第 ' + m.chapterId + ' 章');
    } else if (it.type === 'task') {
      bits.push((m.entry || '') + ' / ' + (m.mode || ''));
    } else if (it.type === 'system') {
      bits.push(m.model || '未配置模型');
    } else if (it.type === 'corpus') {
      bits.push('文档 ' + (m.docCount || 0));
    }
    if (it.updatedAt) bits.push('更新 ' + it.updatedAt);
    return bits.join(' · ');
  }

  async function loadResources(opts) {
    var o = opts || {};
    var ul = el('agent-res-list');
    if (o.reset) { resCursor = null; resItems = []; if (ul) ul.innerHTML = ''; }
    if (!resType) return;
    var hint = el('agent-res-hint');
    var url = '/api/resources?' + resourceQuery(resCursor ? ['cursor=' + encodeURIComponent(resCursor)] : []);
    var data;
    try {
      data = await A.api('GET', url);
    } catch (e) {
      if (hint) hint.textContent = '资源读取失败：' + (e && e.message ? e.message : e);
      return;
    }
    var items = (data && data.items) || [];
    resItems = resItems.concat(items);
    resCursor = data && data.nextCursor ? data.nextCursor : null;
    renderResourceItems();
    if (hint) {
      hint.textContent = '范围：' + (agentScope.kind === 'book' ? ('《' + scopeBookTitle() + '》') : '全局资源')
        + ' · 类型：' + (RES_TYPE_LABELS[resType] || resType)
        + ' · 已列出 ' + resItems.length + ' 项' + (resCursor ? '（还有更多）' : '')
        + '。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。';
    }
  }

  function renderResourceItems() {
    var ul = el('agent-res-list');
    if (!ul) return;
    ul.innerHTML = '';
    if (!resItems.length) {
      var empty = document.createElement('li');
      empty.className = 'agent-tools-hint';
      empty.textContent = '该类型在当前范围内没有资源（空态，不是错误）。';
      ul.appendChild(empty);
    }
    for (var i = 0; i < resItems.length; i++) {
      (function (it) {
        var row = document.createElement('li');
        row.className = 'item-row agent-res-item';
        row.dataset.resourceType = it.type;
        row.dataset.resourceId = String(it.id);
        var title = document.createElement('span');
        title.className = 'agent-res-title';
        var statusLabel = RES_STATUS_LABELS[it.status] || it.status || '';
        title.textContent = (it.title || ('#' + it.id)) + (statusLabel ? ' · ' + statusLabel : '');
        var meta = document.createElement('span');
        meta.className = 'agent-res-meta';
        meta.textContent = resourceMetaText(it);
        row.appendChild(title);
        row.appendChild(meta);
        row.onclick = function () { openResource(it); };
        ul.appendChild(row);
      })(resItems[i]);
    }
    var more = el('btn-agent-res-more');
    if (more) more.classList.toggle('hidden', !resCursor);
  }

  async function openResource(item) {
    if (!item) return;
    var body = el('agent-preview-body');
    showPreview(true);
    if (body) {
      body.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'agent-tools-hint';
      loading.textContent = '正在读取摘要…';
      body.appendChild(loading);
    }
    var parts = ['id=' + encodeURIComponent(item.id)];
    if (agentScope.kind === 'book' && BOOK_ID_TYPES[item.type]) parts.push('bookId=' + encodeURIComponent(agentScope.bookId));
    var url = '/api/resources?type=' + encodeURIComponent(item.type) + '&' + parts.join('&');
    try {
      var data = await A.api('GET', url);
      renderPreview(data && data.resource ? data.resource : null);
    } catch (e) {
      if (!body) return;
      body.innerHTML = '';
      var err = document.createElement('div');
      err.className = 'agent-tools-hint';
      err.textContent = '摘要读取失败：' + (e && e.message ? e.message : e);
      body.appendChild(err);
    }
  }

  function previewRow(parent, key, value) {
    var row = document.createElement('div');
    row.className = 'agent-preview-row';
    var k = document.createElement('span');
    k.className = 'agent-preview-key';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'agent-preview-value';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    parent.appendChild(row);
  }

  // 摘要渲染：只用 textContent，不用 innerHTML（资源字段来自服务端，但仍按不可信文本处理）
  function renderPreview(res) {
    var body = el('agent-preview-body');
    if (!body) return;
    body.innerHTML = '';
    if (!res) {
      var none = document.createElement('div');
      none.className = 'agent-tools-hint';
      none.textContent = '没有可展示的摘要。';
      body.appendChild(none);
      return;
    }
    var head = document.createElement('div');
    head.className = 'agent-preview-title';
    head.textContent = (RES_TYPE_LABELS[res.type] || res.type) + ' · ' + (res.title || ('#' + res.id));
    body.appendChild(head);
    previewRow(body, '状态', RES_STATUS_LABELS[res.status] || res.status || '—');
    if (res.found === false) previewRow(body, '说明', '该引用已不在正典（' + (res.deletedAt || '') + '）');
    var meta = res.meta || {};
    for (var mk in meta) {
      if (!Object.prototype.hasOwnProperty.call(meta, mk)) continue;
      var mv = meta[mk];
      if (mv === null || mv === undefined || mv === '') continue;
      if (Array.isArray(mv)) { if (!mv.length) continue; mv = mv.join('、'); }
      else if (typeof mv === 'object') mv = JSON.stringify(mv);
      previewRow(body, RES_META_LABELS[mk] || mk, String(mv));
    }
    var details = res.details || {};
    for (var dk in details) {
      if (!Object.prototype.hasOwnProperty.call(details, dk)) continue;
      var dv = details[dk];
      if (dv === null || dv === undefined || dv === '') continue;
      if (Array.isArray(dv)) { if (!dv.length) continue; previewRow(body, RES_DETAIL_LABELS[dk] || dk, dv.join('、')); continue; }
      if (typeof dv === 'object') {
        for (var sk in dv) {
          if (!Object.prototype.hasOwnProperty.call(dv, sk)) continue;
          var sv = dv[sk];
          if (sv === null || sv === undefined || sv === '') continue;
          previewRow(body, (RES_DETAIL_LABELS[dk] || dk) + ' · ' + (RES_DETAIL_LABELS[sk] || sk), String(sv));
        }
        continue;
      }
      previewRow(body, RES_DETAIL_LABELS[dk] || dk, String(dv));
    }
    if (res.route) {
      var link = document.createElement('a');
      link.className = 'btn btn-small btn-outline agent-preview-link';
      link.href = res.route;
      link.textContent = '打开工作台 →';
      link.title = '站内跳转：' + res.route;
      body.appendChild(link);
    } else {
      var noPage = document.createElement('div');
      noPage.className = 'agent-tools-hint';
      noPage.textContent = '该类资源没有站内页面，这里只展示元数据与摘要（不提供文件浏览）。';
      body.appendChild(noPage);
    }
    if (res.type === 'book') {
      var useBtn = document.createElement('button');
      useBtn.className = 'btn btn-small btn-ghost';
      useBtn.type = 'button';
      useBtn.textContent = '把交流范围切到这本书';
      useBtn.onclick = function () { switchScope('book:' + res.id); };
      body.appendChild(useBtn);
    }
  }

  function showPreview(on) {
    var panel = el('agent-preview-panel');
    var main = el('agent-main');
    if (panel) panel.classList.toggle('hidden', !on);
    if (main) main.classList.toggle('with-preview', !!on);
  }

  function switchSideTab(name) {
    activeSideTab = name === 'resources' ? 'resources' : 'conversations';
    var pairs = [
      ['btn-agent-tab-conversations', 'conversations', 'agent-pane-conversations'],
      ['btn-agent-tab-resources', 'resources', 'agent-pane-resources'],
    ];
    for (var i = 0; i < pairs.length; i++) {
      var btn = el(pairs[i][0]);
      var pane = el(pairs[i][2]);
      var on = pairs[i][1] === activeSideTab;
      if (btn) btn.classList.toggle('active', on);
      if (pane) pane.classList.toggle('hidden', !on);
    }
    if (activeSideTab === 'resources') {
      renderResourceTypes();
      loadResources({ reset: true });
    }
  }

  // S3-05：discuss/execute 模式（服务端权限的权威在 agent-discuss 只读 profile；
  // 这里只是发送入口——execute 仍走两段式确认，文本不能自抬权限）。
  // S4-01b：模式跟随「范围」——只有书籍范围可执行（global 会话可只读找书，书内执行须绑定书）。
  var agentMode = 'discuss';
  function refreshModeBtn() {
    var btn = el('btn-agent-mode');
    if (!btn) return;
    var bookScope = agentScope.kind === 'book';
    if (!bookScope && agentMode === 'execute') agentMode = 'discuss';
    btn.textContent = agentMode === 'execute' ? '执行操作' : '只读讨论';
    btn.classList.toggle('btn-ghost', agentMode !== 'execute');
    btn.disabled = !bookScope;
    btn.title = bookScope
      ? (agentMode === 'execute' ? '执行操作：可发起写操作（每一步仍需作者确认）；点此切回只读讨论' : '只读讨论：可检索阅读不可写；点此进入执行模式')
      : '全局范围只读（找书与检索）；执行操作请把「范围」切到某一本书';
    renderScopeStatus();
  }

  async function loadConversations() {
    try {
      var data = await A.api('GET', '/api/conversations?kind=agent');
      conversations = Array.isArray(data) ? data : [];
    } catch (e) { conversations = []; }
    var saved = null;
    try { saved = localStorage.getItem(CONVERSATION_KEY); } catch (e) { /* 忽略 */ }
    currentConversation = null;
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === saved && conversations[i].status !== 'archived' && conversationInScope(conversations[i])) {
        currentConversation = conversations[i];
        break;
      }
    }
    if (!currentConversation) currentConversation = firstConversationInScope();
    renderConversationBar();
    renderConversationList();
    refreshModeBtn();
  }

  // 会话选择器只列「当前范围」的会话：切范围看到的是该范围的历史，不混别的书与全局
  function renderConversationBar() {
    var select = el('agent-conversation-select');
    if (!select) return;
    select.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = currentConversation ? '' : '（未选择会话 · 发送时按当前范围新建）';
    select.appendChild(none);
    for (var i = 0; i < conversations.length; i++) {
      var c = conversations[i];
      if (!conversationInScope(c)) continue;
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.title || '未命名会话') + (c.status === 'archived' ? '（已归档）' : '');
      if (currentConversation && c.id === currentConversation.id) opt.selected = true;
      select.appendChild(opt);
    }
    select.value = currentConversation ? currentConversation.id : '';
  }

  function rememberConversation(conv) {
    currentConversation = conv;
    try { localStorage.setItem(CONVERSATION_KEY, conv ? conv.id : ''); } catch (e) { /* 忽略 */ }
    renderConversationBar();
    renderConversationList();
    refreshModeBtn();
  }

  // 新建会话按当前范围落库（scope/book_id 与范围一致），不借用别的书或全局历史
  async function newConversation() {
    var body = { kind: 'agent', scope: agentScope.kind, title: agentScope.kind === 'book' ? (scopeBookTitle() + ' · 讨论') : '全局资源讨论' };
    if (agentScope.kind === 'book') body.bookId = agentScope.bookId;
    var conv = await A.api('POST', '/api/conversations', body);
    conversations.unshift(conv);
    rememberConversation(conv);
    el('agent-messages').innerHTML = '';
    return conv;
  }

  async function selectConversation(id) {
    if (!id) { rememberConversation(null); el('agent-messages').innerHTML = ''; return; }
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) { rememberConversation(conversations[i]); break; }
    }
    await renderServerHistory();
  }

  // 服务端历史渲染：user/assistant 气泡 + 工具事件块 + 系统事件标注
  // S4-01b：切范围/切会话是异步的——整段重绘前先确认「目标会话没变、且没有正在进行的这一轮」，
  // 否则一次晚到的历史响应会把作者已经发出、正在流式渲染的这一轮对话抹掉（契约 §6：
  // 异步结果用请求 token 与目标 id 防止跨目标回写）。
  async function renderServerHistory() {
    var wrap = el('agent-messages');
    // S4-04b：历史整段重绘 = 勾选作废（选中的消息 id 仍然有效，但界面不再有对应勾选框）
    pickInputs = [];
    pickedMessages = [];
    updatePickBar();
    if (!currentConversation) { wrap.innerHTML = ''; return; }
    var convId = currentConversation.id;
    if (sending) return; // 正在生成：消息区归这一轮流所有（连清空都不做），历史在下次进入/刷新时再装
    wrap.innerHTML = '';
    var data;
    try {
      data = await A.api('GET', '/api/conversations/' + convId + '/messages?limit=200');
    } catch (e) {
      if (sending || !currentConversation || currentConversation.id !== convId) return;
      var eb = addBubble(addMsgShell('assistant'));
      eb.textContent = '历史加载失败：' + (e && e.message ? e.message : e);
      return;
    }
    if (!currentConversation || currentConversation.id !== convId) return; // 目标已变：丢弃这次结果
    if (sending) return; // 等待期间开始了新一轮：不拿历史覆盖它
    wrap.innerHTML = '';
    var list = (data && data.messages) || [];
    lastLoadedMessageId = list.length ? list[list.length - 1].id : null;
    var rsBtn = el('btn-agent-restore');
    if (rsBtn) rsBtn.classList.toggle('hidden', !list.some(function (m) { return m.compressed === 1; }));
    for (var i = 0; i < list.length; i++) renderServerMessage(wrap, list[i]);
    // S4-05：刷新/切会话后按服务端 history 的 run 快照重建任务卡（不由上一条气泡猜）
    var RS = window.RunStatus;
    if (RS) {
      var snap = RS.runFromMessages(list);
      lastRunSnapshot = snap || null;
      renderAgentRunCard();
    }
    scrollBottom();
  }

  function renderServerMessage(wrap, m) {
    if (m.source === 'system') {
      var sShell = addMsgShell('assistant');
      var sTag = sShell.querySelector('.msg-role');
      if (sTag) sTag.appendChild(document.createTextNode(' · 系统事件'));
      addBubble(sShell).textContent = m.content;
      return;
    }
    var shell = addMsgShell(m.role === 'user' ? 'user' : 'assistant');
    addBubble(shell).textContent = m.content;
    // S4-04b：历史消息可勾选（只有已落库、有 id 的消息才能当交接来源）
    if (m.id !== undefined && m.id !== null) attachPickToggle(shell, m);
    var tools = m.tools || [];
    for (var t = 0; t < tools.length; t++) {
      var block = document.createElement('details');
      block.className = 'tool-call';
      var s = document.createElement('summary');
      s.textContent = '调用工具 · ' + (tools[t].name || '') + '（' + (tools[t].status || '') + '）';
      block.appendChild(s);
      if (tools[t].result) {
        var pre = document.createElement('pre');
        pre.className = 'tool-call-io';
        var txt = String(tools[t].result);
        if (txt.length > 800) txt = txt.slice(0, 800) + '…';
        pre.textContent = txt;
        block.appendChild(pre);
      }
      shell.appendChild(block);
    }
  }

  // ---------- S4-04b：讨论结论 → 规划笔记 / 显式交接到写作（契约 01 §6）----------
  // 规划笔记只是草稿（服务端 status=draft，库层锁死）：没有正典效力，不写正文/大纲/story_events。
  // 交接是显式材料传递：创建草案（可编辑摘要 + 选定消息 + 来源引用）→ 预览（服务端回显材料、
  // 来源版本与指纹）→ 接受后才向**作者选定**的写作会话追加一条注明来源的消息；重复点击仍一条
  // （服务端幂等，前端也不重复发起）。本文件只做选择与预览：不改正文/大纲/人物/世界观——
  // 「提议更新资料」仍走既有确认卡与提案，交接到写作不是替代写权限的后门。
  var HANDOFF_NOTE_HINT = '规划笔记只是草稿：不写正文、不改大纲、不进事件账本（不是故事事实）。';
  var HANDOFF_WRITE_HINT = '交接只向指定写作会话追加一条注明来源的消息：不改正文/大纲/人物/世界观；'
    + '要改正式资料请在讨论里提出，AI 会生成待审提案，你在确认卡里放行。';

  function clipText(text, max) {
    var value = String(text === undefined || text === null ? '' : text);
    return value.length > max ? value.slice(0, max) + '…' : value;
  }

  function updatePickBar() {
    var bar = el('agent-pick-bar');
    if (!bar) return;
    if (!pickedMessages.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    var count = el('agent-pick-count');
    if (count) count.textContent = '已选 ' + pickedMessages.length + ' 条讨论结论';
    var archived = !!(currentConversation && currentConversation.status !== 'active');
    var noteBtn = el('btn-agent-save-note');
    if (noteBtn) noteBtn.disabled = archived;
    var handoffBtn = el('btn-agent-create-handoff');
    if (handoffBtn) handoffBtn.disabled = archived;
  }

  function toggleMessagePick(m, on) {
    var kept = [];
    for (var i = 0; i < pickedMessages.length; i++) {
      if (pickedMessages[i].id !== Number(m.id)) kept.push(pickedMessages[i]);
    }
    if (on) kept.push({ id: Number(m.id), role: m.role, content: String(m.content || '') });
    kept.sort(function (a, b) { return a.id - b.id; });
    pickedMessages = kept;
    updatePickBar();
  }

  function attachPickToggle(shell, m) {
    var label = document.createElement('label');
    label.className = 'agent-pick-toggle';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.messageId = String(m.id);
    box.onchange = function () { toggleMessagePick(m, box.checked); };
    label.appendChild(box);
    label.appendChild(document.createTextNode('选入结论'));
    shell.appendChild(label);
    pickInputs.push({ id: Number(m.id), input: box });
  }

  function clearPick() {
    pickedMessages = [];
    for (var i = 0; i < pickInputs.length; i++) pickInputs[i].input.checked = false;
    pickInputs = [];
    updatePickBar();
  }

  function pickedContextLine() {
    return pickedMessages.map(function (m) {
      return '#' + m.id + '（' + (m.role === 'user' ? '我' : '助手') + '）：' + clipText(m.content, 300);
    }).join('\n');
  }

  function defaultHandoffText() {
    return pickedMessages.map(function (m) { return String(m.content || '').trim(); })
      .filter(Boolean).join('\n\n').slice(0, 4000);
  }

  function activeConversationLabel() {
    return currentConversation
      ? (currentConversation.title || '未命名会话')
      : '（未选择会话）';
  }

  // 规划笔记：走 S4-04a 的 POST /api/planning-notes（只管理草稿；状态/版本由服务端产生）
  function saveNoteFromSelection() {
    if (!currentConversation) { A.toast('请先选择会话'); return; }
    if (currentConversation.status !== 'active') { A.toast('该会话已归档：只读，不能再新建笔记'); return; }
    if (!pickedMessages.length) { A.toast('先在讨论里勾选要沉淀的结论'); return; }
    var picks = pickedMessages.slice();
    var defaultTitle = clipText(scopeBookTitle() + ' · 讨论纪要', 200);
    A.openModal({
      title: '存为规划笔记（草稿）',
      okText: '存为笔记',
      bodyHTML:
        '<p class="field-hint">' + A.escapeHtml(HANDOFF_NOTE_HINT) + '</p>'
        + '<label class="field"><span>标题</span><input id="agent-note-title" type="text" value="' + A.escapeHtml(defaultTitle) + '"></label>'
        + '<label class="field"><span>笔记正文（可编辑）</span><textarea id="agent-note-text" rows="6">'
        + A.escapeHtml(picks.map(function (m) { return String(m.content || '').trim(); }).join('\n\n').slice(0, 4000)) + '</textarea></label>'
        + '<p class="field-hint">来源：本轮勾选的 ' + picks.length + ' 条讨论消息（'
        + A.escapeHtml(picks.map(function (m) { return '#' + m.id; }).join('、')) + '）</p>',
      onOk: async function (body) {
        var titleEl = body && body.querySelector ? body.querySelector('#agent-note-title') : null;
        var textEl = body && body.querySelector ? body.querySelector('#agent-note-text') : null;
        var text = textEl ? String(textEl.value || '').trim() : '';
        if (!text) { A.toast('笔记正文不能为空（服务端不接受空笔记）'); return false; }
        try {
          var note = await A.api('POST', '/api/planning-notes', {
            conversationId: currentConversation.id,
            title: titleEl ? String(titleEl.value || '').trim() : '',
            text: text,
            selectedMessageIds: picks.map(function (m) { return m.id; }),
          });
          lastPlanningNote = {
            id: note.id, title: note.title || '', revision: note.revision, conversationId: note.conversationId,
          };
          A.toast('已存为规划笔记草稿（不是故事事实；创建交接时可把它作为来源引用）');
          return true;
        } catch (e) {
          A.toast('存笔记失败：' + (e && e.message ? e.message : e));
          return false;
        }
      },
    });
  }

  // ---------- 交接草案（创建 → 预览 → 接受）----------
  async function loadWritingConversations(bookId) {
    try {
      var list = await A.api('GET', '/api/conversations?kind=writing&bookId=' + encodeURIComponent(bookId));
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  // 没有已选定会话时保留占位项：全局范围的「目标书→目标会话」必须逐步由作者选定，
  // 不预选（书籍范围的默认值只落在当前范围这一本书自己的会话里，见 defaultTargetId）。
  function writingOptionsHtml(list, selectedId) {
    var out = [];
    if (!selectedId) out.push('<option value="">（请选择写作会话）</option>');
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var archived = c.status === 'archived';
      out.push('<option value="' + A.escapeHtml(c.id) + '"' + (c.id === selectedId ? ' selected' : '')
        + (archived ? ' disabled' : '') + '>'
        + A.escapeHtml((c.title || '未命名会话') + (archived ? '（已归档 · 不能交接）' : '')) + '</option>');
    }
    return out.join('');
  }

  // 默认目标＝作者当前的写作会话（写作页的持久化键，S3-03），否则该书第一个未归档会话；
  // 目标书本身在书籍范围由「范围」决定，全局范围必须由作者显式选定（不自动挑书）。
  function defaultTargetId(list, bookId) {
    var remembered = null;
    try { remembered = localStorage.getItem('writing_conversation_' + bookId); } catch (e) { /* 忽略 */ }
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === remembered && list[i].status !== 'archived') return remembered;
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j].status !== 'archived') return list[j].id;
    }
    return '';
  }

  function boundaryChapterTitle(chapterId) {
    for (var i = 0; i < boundaryChapters.length; i++) {
      if (Number(boundaryChapters[i].id) === Number(chapterId)) return boundaryChapters[i].title || ('章节 #' + chapterId);
    }
    return '章节 #' + chapterId;
  }

  function handoffTargetHint(s) {
    if (!s.bookId) return '先选目标书，再选该书写作会话（全局讨论不自动挑书）。';
    if (!s.writingList.length) return '这本书还没有写作会话：请先在写作页打开该书（会自动建立写作会话），再回来交接。';
    var hit = null;
    for (var i = 0; i < s.writingList.length; i++) if (s.writingList[i].id === s.targetId) hit = s.writingList[i];
    return '将交给：《' + (s.bookTitle || '') + '》· ' + (hit ? (hit.title || '未命名会话') : '（未选择会话）');
  }

  function handoffComposeHtml(s) {
    var parts = [];
    parts.push('<p class="field-hint">' + A.escapeHtml(HANDOFF_WRITE_HINT) + '</p>');
    if (s.bookScope) {
      parts.push('<p class="field-hint">目标书：<strong>' + A.escapeHtml(s.bookTitle) + '</strong>（当前范围；交接不能跨书）</p>');
    } else {
      var bookOpts = ['<option value="">（请选择目标书）</option>'];
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        bookOpts.push('<option value="' + A.escapeHtml(b.id) + '">' + A.escapeHtml(b.title || ('#' + b.id)) + '</option>');
      }
      parts.push('<label class="field"><span>目标书（全局讨论不会自动挑书）</span><select id="handoff-target-book">'
        + bookOpts.join('') + '</select></label>');
    }
    parts.push('<label class="field"><span>目标写作会话</span><select id="handoff-target-conversation">'
      + (s.writingList.length
        ? writingOptionsHtml(s.writingList, s.targetId)
        : '<option value="">（这本书还没有写作会话）</option>')
      + '</select></label>');
    parts.push('<p class="field-hint" id="handoff-target-hint">' + A.escapeHtml(handoffTargetHint(s)) + '</p>');
    parts.push('<label class="field"><span>交接摘要（可编辑，会写进写作会话）</span><textarea id="handoff-text" rows="4">'
      + A.escapeHtml(defaultHandoffText()) + '</textarea></label>');
    var refs = [];
    if (s.chapterId) {
      refs.push('<label class="field field-inline"><input type="checkbox" id="handoff-ref-chapter" checked> 来源引用：章节《'
        + A.escapeHtml(boundaryChapterTitle(s.chapterId)) + '》（当前剧情边界）</label>');
    }
    if (s.note) {
      refs.push('<label class="field field-inline"><input type="checkbox" id="handoff-ref-note" checked> 来源引用：规划笔记《'
        + A.escapeHtml(s.note.title || '未命名笔记') + '》（revision ' + Number(s.note.revision) + '）</label>');
    }
    if (refs.length) {
      parts.push('<div class="field"><span>来源引用（可选：只带目标书内或明确通用的资料）</span>'
        + refs.join('') + '</div>');
    }
    parts.push('<div class="field"><span>材料预览（选定 ' + s.picks.length + ' 条结论）</span>'
      + '<pre class="handoff-preview" id="handoff-material">' + A.escapeHtml(s.picks.length ? pickedContextLine() : '（无选定消息：只交接摘要文本）') + '</pre></div>');
    return parts.join('');
  }

  function bindHandoffCompose(s) {
    var body = el('modal-body');
    if (!body || !body.querySelector) return;
    var targetSel = body.querySelector('#handoff-target-conversation');
    if (targetSel && s.targetId) targetSel.value = s.targetId;
    // 目标书选择器只在全局范围渲染（书籍范围的目标书由「范围」决定）：不查不该存在的字段
    if (s.bookScope) return;
    var bookSel = body.querySelector('#handoff-target-book');
    if (!bookSel) return;
    bookSel.addEventListener('change', async function () {
      var hint = body.querySelector('#handoff-target-hint');
      var sel = body.querySelector('#handoff-target-conversation');
      var bookId = Number(bookSel.value);
      if (!bookId) {
        s.bookId = null;
        s.bookTitle = '';
        s.writingList = [];
        s.targetId = '';
        if (sel) sel.innerHTML = '<option value="">（先选择目标书）</option>';
        if (hint) hint.textContent = handoffTargetHint(s);
        return;
      }
      if (hint) hint.textContent = '正在读取该书的写作会话…';
      var list = await loadWritingConversations(bookId);
      var bookTitle = '';
      for (var i = 0; i < books.length; i++) if (Number(books[i].id) === bookId) bookTitle = books[i].title || '';
      s.bookId = bookId;
      s.bookTitle = bookTitle;
      s.writingList = list;
      // 全局范围不预选会话：目标书与会话都要作者点名（不自动挑书、也不替作者挑会话）
      s.targetId = s.bookScope ? defaultTargetId(list, bookId) : '';
      if (sel) {
        sel.innerHTML = list.length
          ? writingOptionsHtml(list, s.targetId)
          : '<option value="">（这本书还没有写作会话）</option>';
        if (s.targetId) sel.value = s.targetId;
      }
      if (hint) hint.textContent = handoffTargetHint(s);
    });
  }

  async function createHandoffFromSelection() {
    if (!currentConversation) { A.toast('请先选择会话'); return; }
    if (currentConversation.status !== 'active') { A.toast('该会话已归档：只读，不能交接'); return; }
    if (!pickedMessages.length) { A.toast('先在讨论里勾选要交接的结论'); return; }
    var bookScope = agentScope.kind === 'book';
    var bookId = bookScope ? Number(agentScope.bookId) : null;
    var writingList = bookId ? await loadWritingConversations(bookId) : [];
    var s = {
      bookScope: bookScope,
      bookId: bookId,
      bookTitle: bookScope ? scopeBookTitle() : '',
      writingList: writingList,
      targetId: bookScope ? defaultTargetId(writingList, bookId) : '',
      picks: pickedMessages.slice(),
      chapterId: (bookScope && boundaryChapterId) ? Number(boundaryChapterId) : null,
      note: (lastPlanningNote && lastPlanningNote.conversationId === currentConversation.id) ? lastPlanningNote : null,
    };
    A.openModal({
      title: '创建交接到写作（草案）',
      okText: '创建草案',
      bodyHTML: handoffComposeHtml(s),
      onOk: function (body) { return submitHandoffDraft(body, s); },
    });
    bindHandoffCompose(s);
  }

  async function submitHandoffDraft(body, s) {
    var targetSel = body && body.querySelector ? body.querySelector('#handoff-target-conversation') : null;
    var textEl = body && body.querySelector ? body.querySelector('#handoff-text') : null;
    var targetConversationId = targetSel ? String(targetSel.value || '') : '';
    var text = textEl ? String(textEl.value || '') : '';
    if (!targetConversationId) {
      A.toast(s.bookScope
        ? '请选择目标写作会话（交接只写入你选定的会话）'
        : '请先选定目标书与写作会话（全局讨论不自动挑书）');
      return false;
    }
    // 来源引用勾选框与渲染条件一致：只有该引用存在时才查它（不查自己没有渲染的字段）
    var refs = [];
    if (s.chapterId) {
      var chapterBox = body && body.querySelector ? body.querySelector('#handoff-ref-chapter') : null;
      if (!chapterBox || chapterBox.checked) refs.push({ kind: 'chapter', id: s.chapterId });
    }
    if (s.note) {
      var noteBox = body && body.querySelector ? body.querySelector('#handoff-ref-note') : null;
      if (!noteBox || noteBox.checked) refs.push({ kind: 'planning_note', id: s.note.id });
    }
    if (!String(text).trim() && !s.picks.length) {
      A.toast('交接材料不能为空：写一句摘要或先勾选讨论结论');
      return false;
    }
    if (handoffSubmitting) return false; // 防重复点击：一次点击只创建一个草案
    handoffSubmitting = true;
    try {
      var draft = await A.api('POST', '/api/handoffs', {
        originConversationId: currentConversation.id,
        targetConversationId: targetConversationId,
        selectedMessageIds: s.picks.map(function (m) { return m.id; }),
        text: String(text).trim(),
        sourceRefs: refs,
      });
      await showHandoffPreview(draft.id);
      return false; // 保持在弹窗上：下一步是预览与接受，交接受控
    } catch (e) {
      A.toast('创建交接草案失败：' + (e && e.message ? e.message : e));
      return false;
    } finally {
      handoffSubmitting = false;
    }
  }

  async function showHandoffPreview(handoffId) {
    var view = null;
    try {
      view = await A.api('GET', '/api/handoffs/' + encodeURIComponent(handoffId));
    } catch (e) {
      A.toast('交接预览加载失败：' + (e && e.message ? e.message : e));
      return;
    }
    renderHandoffPreview(view, 'preview');
  }

  function handoffMaterialHtml(view) {
    var material = view.material || {};
    var parts = [];
    parts.push('<div class="field"><span>交接摘要</span><pre class="handoff-preview" id="handoff-preview-text">'
      + A.escapeHtml(material.text || '（无摘要文本）') + '</pre></div>');
    var excerpts = material.excerpts || [];
    parts.push('<div class="field"><span>选定结论（' + excerpts.length + ' 条）</span><ul>'
      + (excerpts.length
        ? excerpts.map(function (item) {
          return '<li>#' + A.escapeHtml(item.messageId) + '（' + A.escapeHtml(item.role === 'user' ? '我' : '助手')
            + '）：' + A.escapeHtml(clipText(item.excerpt, 500))
            + (item.truncated ? '……（原文更长，已截断）' : '') + '</li>';
        }).join('')
        : '<li>（无：只交接摘要文本）</li>')
      + '</ul></div>');
    var refs = material.sourceRefs || [];
    parts.push('<div class="field"><span>来源引用（' + refs.length + '）</span><ul>'
      + (refs.length
        ? refs.map(function (ref) {
          if (ref.kind === 'general') return '<li>通用资料：' + A.escapeHtml(ref.label || '') + '</li>';
          return '<li>' + A.escapeHtml(ref.kind === 'chapter' ? '章节' : '规划笔记') + ' #' + A.escapeHtml(ref.id)
            + (ref.title ? '《' + A.escapeHtml(ref.title) + '》' : '')
            + '（revision ' + A.escapeHtml(ref.revision) + '）</li>';
        }).join('')
        : '<li>（无引用）</li>')
      + '</ul></div>');
    parts.push('<p class="field-hint">来源指纹：<code>'
      + A.escapeHtml(view.sourceFingerprint || '（来源已变更，需重新预览）') + '</code></p>');
    return parts.join('');
  }

  function renderHandoffPreview(view, stage) {
    var target = view.target || {};
    if (stage === 'done') {
      A.openModal({
        title: '已交接（一条注明来源的消息）',
        okText: '完成',
        bodyHTML:
          '<p class="field-hint">已交接到 <strong>' + A.escapeHtml(target.title || '写作会话') + '</strong>：消息 #'
          + A.escapeHtml(view.acceptedMessageId || view.messageId || '')
          + '（重复点击不会再插入第二条）。</p>'
          + '<p class="field-hint">' + A.escapeHtml(HANDOFF_WRITE_HINT) + '</p>'
          + handoffMaterialHtml(view),
        onOk: function () { return true; },
      });
      return;
    }
    var busy = !!target.busy;
    var stale = !!view.sourceChanged || !view.sourceFingerprint;
    var head = [];
    if (busy) {
      head.push('<p class="field-hint"><strong>⚠ 目标会话正在运行中：等这一轮结束再接受</strong>'
        + '（不会混进正在发给模型的请求）。运行结束后点「重新预览」再交接。</p>');
    } else if (stale) {
      head.push('<p class="field-hint"><strong>⚠ 来源已变更：'
        + A.escapeHtml(view.sourceIssue || '需要重新预览') + '</strong></p>');
    } else {
      head.push('<p class="field-hint">目标会话空闲，可接受。</p>');
    }
    head.push('<p class="field-hint">接受后只向 <strong>' + A.escapeHtml(target.title || '写作会话')
      + '</strong> 追加一条注明来源的消息（' + A.escapeHtml(HANDOFF_WRITE_HINT) + '）</p>');
    A.openModal({
      title: '交接预览（接受前请核对材料与来源）',
      okText: '关闭（不交接）',
      bodyHTML: head.join('') + handoffMaterialHtml(view)
        + '<div class="msg-actions" style="margin-top:8px">'
        + '<button type="button" id="btn-handoff-accept" class="btn btn-small btn-primary"'
        + ((busy || stale) ? ' disabled' : '') + '>接受交接（写入写作会话）</button>'
        + '<button type="button" id="btn-handoff-refresh" class="btn btn-small btn-ghost">重新预览</button>'
        + '<button type="button" id="btn-handoff-cancel" class="btn btn-small btn-ghost">作废草案</button>'
        + '</div>'
        + '<p class="field-hint">关闭本窗口＝不交接：草案保留为草稿，不写入任何内容。</p>'
        + '<p class="field-hint">「作废草案」只作废这份还没交接的草案（'
        + '未向写作会话写入任何内容，且不撤回任何已写进写作会话的消息）。</p>',
      onOk: function () { return true; }, // 关闭不产生写入
    });
    var body = el('modal-body');
    if (!body || !body.querySelector) return;
    var acceptBtn = body.querySelector('#btn-handoff-accept');
    if (acceptBtn) acceptBtn.addEventListener('click', function () { acceptHandoff(view, acceptBtn); });
    var refreshBtn = body.querySelector('#btn-handoff-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { showHandoffPreview(view.id); });
    var cancelBtn = body.querySelector('#btn-handoff-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { cancelHandoffDraft(view, cancelBtn); });
  }

  // 作废只对草案（draft）生效——不会撤回任何已经写进写作会话的消息（appendMessage 不可撤回）
  async function cancelHandoffDraft(view, btn) {
    if (handoffCancelling || handoffAccepting) return;
    if (!view || !view.id) return;
    if (view.status === 'accepted') {
      A.toast('这条交接已经写进写作会话：作废不会撤回那条消息。要换结论请重新创建草案。');
      return;
    }
    if (!confirm('作废这份交接草案？\n\n'
      + '只作废草案本身（未向写作会话写入任何内容）；\n'
      + '已经采纳过、写进写作会话的消息不会因此撤回。')) return;
    handoffCancelling = true;
    if (btn) { btn.disabled = true; btn.textContent = '作废中…'; }
    try {
      var result = await A.api('POST', '/api/handoffs/' + encodeURIComponent(view.id) + '/cancel', {});
      A.closeModal();
      A.toast(result && result.duplicate
        ? '该草案此前已作废（未向写作会话写入任何内容）'
        : '草案已作废（未向写作会话写入任何内容）');
    } catch (e) {
      var code = e && e.code ? e.code : '';
      if (code === 'HANDOFF_ALREADY_ACCEPTED') {
        A.toast('这条交接已经写进写作会话：作废不会撤回那条消息（要换结论请重新创建草案）');
      } else if (code === 'HANDOFF_ALREADY_SETTLED') {
        A.toast('该交接刚刚已被处理：请刷新预览确认当前状态');
      } else {
        A.toast('作废失败：' + (e && e.message ? e.message : e));
      }
      if (btn) { btn.disabled = false; btn.textContent = '作废草案'; }
      if (code === 'HANDOFF_ALREADY_ACCEPTED' || code === 'HANDOFF_ALREADY_SETTLED') {
        await showHandoffPreview(view.id); // 让「已处理」立刻可见
      }
    } finally {
      handoffCancelling = false;
    }
  }

  // 接受＝唯一写入点（服务端幂等：同一草案重复接受只落一条消息）
  async function acceptHandoff(view, btn) {
    if (handoffAccepting) return;
    if (view && view.target && view.target.busy) {
      A.toast('目标会话正在运行中：等这一轮结束后点「重新预览」再交接（不会混进正在发给模型的请求）');
      return;
    }
    if (!view || !view.sourceFingerprint || view.sourceChanged) {
      A.toast('来源已变更：请重新预览后再交接');
      return;
    }
    handoffAccepting = true;
    if (btn) { btn.disabled = true; btn.textContent = '交接中…'; }
    try {
      var result = await A.api('POST', '/api/handoffs/' + encodeURIComponent(view.id) + '/accept',
        { expectedSourceFingerprint: view.sourceFingerprint });
      renderHandoffPreview(result, 'done');
      A.toast(result && result.duplicate
        ? '该交接此前已交接（同一条消息，未重复插入）'
        : '已交接到写作会话（一条注明来源的消息）');
    } catch (e) {
      var code = e && e.code ? e.code : '';
      if (code === 'HANDOFF_TARGET_BUSY') {
        A.toast('目标会话正在运行中：等这一轮结束后点「重新预览」再接受');
      } else if (code === 'HANDOFF_SOURCE_CHANGED') {
        A.toast('来源资料已更新：请点「重新预览」核对后再接受');
      } else if (code === 'HANDOFF_TARGET_ARCHIVED') {
        A.toast('目标写作会话已归档：请在写作页另开会话后重新创建交接');
      } else {
        A.toast('交接失败：' + (e && e.message ? e.message : e));
      }
      if (btn) { btn.disabled = false; btn.textContent = '接受交接（写入写作会话）'; }
      if (code === 'HANDOFF_TARGET_BUSY' || code === 'HANDOFF_SOURCE_CHANGED') {
        await showHandoffPreview(view.id); // 让「忙碌/过期」立刻可见，必须重新预览后才可接受
      }
    } finally {
      handoffAccepting = false;
    }
  }

  var lastLoadedMessageId = null;

  // ---------- S3-04：会话压缩/恢复（与写作页同一套摘要含义，四节结构） ----------
  async function compressConversation() {
    if (!currentConversation) { A.toast('请先选择会话'); return; }
    if (!confirm('把当前会话较早的对话压缩成存档摘要？（原消息不删除，可随时还原）')) return;
    try {
      A.toast('正在压缩…');
      var result = await A.api('POST', '/api/conversations/' + currentConversation.id + '/compress',
        { expectedLastMessageId: lastLoadedMessageId });
      A.toast('已归档 ' + result.coveredMessageIds.length + ' 条早期对话（估算 ' + result.usageEstimate + ' tokens，真实占用以最近一次对话 usage 为准）');
      await renderServerHistory();
    } catch (e) {
      A.toast('压缩失败：' + (e && e.message ? e.message : e));
    }
  }

  async function restoreConversation() {
    if (!currentConversation) return;
    try {
      var r = await A.api('POST', '/api/conversations/' + currentConversation.id + '/compress/restore');
      A.toast('已还原 ' + r.restored + ' 条归档对话');
      await renderServerHistory();
    } catch (e) {
      A.toast('还原失败：' + (e && e.message ? e.message : e));
    }
  }

  // ---------- legacy 历史导入（预览 → 导入 → 作者确认后才清本地副本）----------
  function updateLegacyBar() {
    var bar = el('agent-legacy-import');
    if (!bar) return;
    if (!legacyHistory.length) { bar.classList.add('hidden'); return; }
    // 已导入过（标记持久化，刷新后仍有效）：不再引导重复导入，只保留清理口
    if (legacyImported) {
      bar.classList.remove('hidden');
      var imp = el('btn-agent-import'); if (imp) imp.classList.add('hidden');
      var txt = el('agent-legacy-text');
      if (txt) txt.textContent = '本地旧助手历史 ' + legacyHistory.length + ' 条已导入服务端。以下可清理浏览器本地副本（服务端历史不受影响）。';
      var clean = el('btn-agent-clean-local'); if (clean) clean.classList.remove('hidden');
      return;
    }
    bar.classList.remove('hidden');
    var first = legacyHistory[0] && legacyHistory[0].content ? legacyHistory[0].content.slice(0, 24) : '';
    var text = el('agent-legacy-text');
    if (text) text.textContent = '检测到浏览器本地旧助手历史 ' + legacyHistory.length + ' 条（首条：「' + first + '…」）。导入为服务端只读历史，不会带入任何工具证据。';
  }

  var legacyImported = false;
  try { legacyImported = localStorage.getItem('agent_legacy_imported_v1') === '1'; } catch (e) { /* 忽略 */ }
  async function importLegacy() {
    var btn = el('btn-agent-import');
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    try {
      var result = await A.api('POST', '/api/conversations/import-legacy-agent', {
        scope: 'global',
        title: '导入的助手历史',
        messages: legacyHistory
          .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
          .map(function (m) { return { role: m.role, content: m.content }; }),
      });
      legacyImported = true;
      try { localStorage.setItem('agent_legacy_imported_v1', '1'); } catch (e) { /* 忽略 */ }
      var conv = { id: result.conversationId, title: '导入的助手历史' };
      conversations.unshift(conv);
      rememberConversation(conv);
      await renderServerHistory();
      A.toast(result.duplicate ? '该批次已导入过，已切换到对应会话' : '已导入 ' + result.createdMessages + ' 条旧对话');
      updateLegacyBar();
      var clean = el('btn-agent-clean-local');
      if (clean) clean.classList.remove('hidden');
    } catch (e) {
      A.toast('导入失败：' + (e && e.message ? e.message : e));
      if (btn) { btn.disabled = false; btn.textContent = '导入到服务端'; }
    }
  }

  function cleanLocalLegacy() {
    if (!legacyImported) return; // 未成功导入前不给清理口（任务书：导入成功且作者确认后才允许）
    try { localStorage.removeItem(HISTORY_KEY); localStorage.removeItem('agent_legacy_imported_v1'); } catch (e) { /* 忽略 */ }
    legacyImported = false;
    legacyHistory = [];
    var clean = el('btn-agent-clean-local');
    if (clean) clean.classList.add('hidden');
    updateLegacyBar();
    A.toast('本地旧副本已清理（服务端历史不受影响）');
  }

  // ---------- pending 确认卡持久化（对齐 book-chat.js loadChat 的重建机制，M4/W11） ----------
  // 后端没有「列助手 pending 动作」的接口（chat_actions 按书归属），纯前端方案：
  // 渲染确认卡时把确认信封快照进 localStorage；结算（同意/拒绝/失败）后移除；
  // 刷新后重建未结算的卡（过期的跳过）。sessionId 持久化保证重建的卡可以真正结算。
  var PENDING_KEY = 'agent_pending_v1';
  function loadPending() {
    try {
      var list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function savePendingList(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20))); } catch (e) { /* 超限忽略 */ }
  }

  // S3-02：确认卡的会话归属（新卡随快照记录；旧卡无此字段 → 走 legacy session_id）
  function pendingConversationId(cid) {
    var list = loadPending();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === cid) return list[i].conversationId || null;
    }
    return currentConversation ? currentConversation.id : null;
  }
  function rememberPending(entry) {
    savePendingList(loadPending().filter(function (x) { return x.id !== entry.id; }).concat([entry]));
  }
  function forgetPending(id) {
    savePendingList(loadPending().filter(function (x) { return x.id !== id; }));
  }

  // 刷新后重建未结算的确认卡（含同参去重，语义对齐 book-chat.js loadChat）：
  // 同工具同参数只渲染最新一张；已过期（30 分钟 TTL）的**不再静默丢弃**——渲染为只读
  // status-expired 卡（M9-B，对齐「过期卡不得静默消失」原则），并从 pending 存储移除，
  // 保证下次刷新不会重复渲染。同参去重只在 pending 之间生效。
  function rebuildPendingCards() {
    var wrap = el('agent-messages');
    if (!wrap) return;
    var now = Date.now();
    var list = loadPending();
    var seen = {};
    var kept = [];
    var expired = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !entry.id || !entry.conf) continue;
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) {
        expired.push(entry); // 已过期：渲染只读历史卡，不再进 pending 存储
        continue;
      }
      var key = (entry.toolName || '') + '|' + JSON.stringify(entry.input || {});
      if (seen[key]) {
        // 同参卡：用较新的一张替换（列表按写入顺序，后者更新）
        kept = kept.filter(function (x) { return x !== seen[key]; });
      }
      seen[key] = entry;
      kept.push(entry);
    }
    savePendingList(kept); // 过期卡已排除：下次刷新不会重复重建
    // 先渲染过期只读卡、后渲染可操作卡：待确认的卡留在对话末尾（贴近输入区）
    for (var e = 0; e < expired.length; e++) {
      renderConfirmCard(wrap, expired[e].conf, expired[e].toolName, expired[e].input, { status: 'expired' });
    }
    for (var k = 0; k < kept.length; k++) {
      renderConfirmCard(wrap, kept[k].conf, kept[k].toolName, kept[k].input);
    }
    if (kept.length || expired.length) scrollBottom();
  }

  function el(id) { return document.getElementById(id); }

  function scrollBottom() {
    var m = el('agent-messages');
    if (m) m.scrollTop = m.scrollHeight;
  }

  // ---------- 消息渲染 ----------
  function addMsgShell(role) {
    var wrap = el('agent-messages');
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    var roleDiv = document.createElement('div');
    roleDiv.className = 'msg-role';
    roleDiv.textContent = role === 'user' ? '我' : '助手';
    // 消息来源标注（M8 B5 口径，与 public/book-chat.js 的 SOURCE_LABELS 一致）：
    // 助手页 → 「助手」。标签挂在角色行上（renderHistory 走本函数，历史消息自动获得）。
    var src = document.createElement('span');
    src.className = 'msg-source msg-source-agent';
    src.textContent = '助手';
    roleDiv.appendChild(src);
    div.appendChild(roleDiv);
    wrap.appendChild(div);
    scrollBottom();
    return div;
  }

  function addBubble(shell) {
    var b = document.createElement('div');
    b.className = 'msg-bubble';
    shell.appendChild(b);
    return b;
  }

  // ---------- 工具清单 ----------
  async function loadTools() {
    try {
      var data = await A.api('GET', '/api/agent/tools');
      var ul = el('agent-tool-list');
      ul.innerHTML = '';
      (data.tools || []).forEach(function (t) {
        var li = document.createElement('li');
        li.className = 'agent-tool-item';
        li.innerHTML = '<span class="agent-tool-name"></span><span class="agent-tool-desc"></span>';
        li.querySelector('.agent-tool-name').textContent = t.name;
        li.querySelector('.agent-tool-desc').textContent = t.description || '';
        ul.appendChild(li);
      });
    } catch (e) { /* 工具清单加载失败不阻塞 */ }
  }

  // ---------- SSE 流式消费（统一走 ChatEventHub：分帧解析/回调异常隔离/中止时部分文本保留） ----------
  // 返回 {text, aborted}：text 为本轮可见文本（含被停止时的部分输出），aborted 表示用户按了停止。
  async function consumeStream(resp, shell) {
    var fullText = '';      // 助手本轮可见文本（进历史）
    var curText = null;     // 当前文本气泡
    var curReason = null;   // 当前思考块
    var toolBlocks = {};    // toolCallId -> {statusEl, resultPre, input, toolName}
    var roundTools = [];    // S4-05：本轮工具调用明细（任务卡折叠展示目标与来源版本）

    function ensureTextBubble() {
      if (!curText) curText = addBubble(shell);
      return curText;
    }

    var out = await ChatEventHub.consumeAgentStream(resp, {
      onReasoningStart: function () {
        curReason = document.createElement('details');
        curReason.className = 'msg-reasoning';
        var sum = document.createElement('summary');
        sum.textContent = '思考过程';
        var body = document.createElement('div');
        body.className = 'reasoning-body';
        curReason.appendChild(sum);
        curReason.appendChild(body);
        shell.insertBefore(curReason, shell.firstChild.nextSibling);
      },
      onReasoningDelta: function (delta) {
        if (!curReason) return;
        var rb = curReason.querySelector('.reasoning-body');
        if (rb) rb.textContent += delta;
      },
      onReasoningEnd: function () { curReason = null; },
      onDelta: function (delta) {
        var b = ensureTextBubble();
        b.textContent += delta;
        fullText += delta;
        scrollBottom();
      },
      onTextEnd: function () { curText = null; },
      onToolCall: function (tc) {
        var block = document.createElement('details');
        block.className = 'tool-call';
        var s = document.createElement('summary');
        var label = document.createElement('span');
        label.className = 'tool-call-name';
        label.textContent = '调用工具 · ' + (tc.toolName || '');
        var status = document.createElement('span');
        status.className = 'tool-call-status';
        status.textContent = '执行中…';
        s.appendChild(label);
        s.appendChild(status);
        var inputPre = document.createElement('pre');
        inputPre.className = 'tool-call-io';
        var inputStr = '';
        try { inputStr = JSON.stringify(tc.input, null, 2); } catch (e) { inputStr = String(tc.input); }
        inputPre.textContent = '入参：' + (inputStr === '{}' ? '（无）' : inputStr);
        var resultPre = document.createElement('pre');
        resultPre.className = 'tool-call-io tool-call-result hidden';
        block.appendChild(s);
        block.appendChild(inputPre);
        block.appendChild(resultPre);
        shell.appendChild(block);
        toolBlocks[tc.toolCallId] = { statusEl: status, resultPre: resultPre, input: tc.input, toolName: tc.toolName };
        roundTools.push({ name: tc.toolName, args: tc.input, result: null });
        curText = null; // 工具调用后新起文本气泡
        scrollBottom();
      },
      onToolOutput: function (to) {
        var tb = toolBlocks[to.toolCallId];
        if (!tb) return;
        for (var rt = roundTools.length - 1; rt >= 0; rt--) {
          if (roundTools[rt].name === tb.toolName && !roundTools[rt].result) { roundTools[rt].result = to.output; break; }
        }
        // 确认信封：executeForModel 返回 {ok:true,data:{status:'confirmation_required',confirmation}}
        var conf = extractConfirmation(to.output);
        if (conf) {
          tb.statusEl.textContent = '待作者确认';
          renderConfirmCard(shell, conf, tb.toolName, tb.input);
          // 快照进 localStorage：刷新后可重建（M4/W11），结算时移除
          rememberPending({ id: conf.id, conf: conf, toolName: tb.toolName, input: tb.input, expiresAt: conf.expires_at || null, conversationId: currentConversation ? currentConversation.id : null });
          scrollBottom();
        } else {
          var failed = to.output && to.output.ok === false;
          tb.statusEl.textContent = failed ? '未执行或失败' : '完成';
          if (!failed) tb.statusEl.classList.add('done');
          var out2 = '';
          try { out2 = JSON.stringify(to.output, null, 2); } catch (e) { out2 = String(to.output); }
          if (out2.length > 2000) out2 = out2.slice(0, 2000) + '\n…（结果过长，已截断）';
          tb.resultPre.textContent = '结果：' + out2;
          tb.resultPre.classList.remove('hidden');
          scrollBottom();
        }
      },
      onDone: function (result) {
        if (result.text !== fullText) {
          shell.querySelectorAll('.msg-bubble').forEach(function (bubble) { bubble.remove(); });
          curText = null;
          ensureTextBubble().textContent = result.text;
          fullText = result.text;
        }
      },
      onError: function (info) {
        A.toast('助手出错：' + (info.message || '未知错误'));
      },
      // S4-05 / G3 边界 4 的前端一半：工具被拒绝/失败时把结构化错误码显示出来
      // （此前 SDK 的 tool-output-error 被整段忽略，页面只剩「没有执行」的空白）。
      onToolError: function (info) {
        lastToolErrors.push(info);
        var notice = document.createElement('div');
        notice.className = 'msg-tool-error';
        notice.textContent = '工具未执行：' + (info.code ? '[' + info.code + '] ' : '')
          + (info.toolName || '') + (info.message ? ' — ' + info.message : '');
        shell.appendChild(notice);
        scrollBottom();
        renderAgentRunCard();
      },
    });
    if (out.run) lastRunSnapshot = out.run;
    return {
      text: (out.text || fullText).trim(),
      aborted: out.aborted,
      run: out.run || null,
      tools: roundTools,
      toolErrors: out.toolErrors || [],
    };
  }

  // ---------- 写操作确认卡 + resume 闭环 ----------
  // 从工具输出提取确认信封（兼容 {ok,data:{status}} 包裹与裸信封两种形态）
  function extractConfirmation(output) {
    if (!output || typeof output !== 'object') return null;
    if (output.status === 'confirmation_required' && output.confirmation) return output.confirmation;
    if (output.data && output.data.status === 'confirmation_required' && output.data.confirmation) return output.data.confirmation;
    return null;
  }

  // 值展示：null→（空）、数组→[a、b]、对象→紧凑 JSON、其余→字符串
  function fmtVal(v) {
    if (v === null || v === undefined) return '（空）';
    if (Array.isArray(v)) return '[' + v.map(fmtVal).join('、') + ']';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  // 提案完整差异快照渲染（textContent 安全输出，不用 innerHTML）：标题/版本/来源/每项 old→new/原文依据
  function renderProposalPreview(preview) {
    var box = document.createElement('div');
    box.className = 'action-preview';

    if (preview.version_match === false) {
      var warn = document.createElement('div');
      warn.className = 'preview-warn';
      warn.textContent = '⚠ 版本不符：你确认的是 revision ' + preview.expected_revision
        + '，但提案当前已是 revision ' + preview.revision + '。执行将被拒绝，请重新读取核对。';
      box.appendChild(warn);
    }

    var title = document.createElement('div');
    title.className = 'preview-title';
    title.textContent = '提案 #' + preview.proposal_id + '：' + (preview.title || '（无标题）');
    box.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'preview-meta';
    var metaBits = ['revision ' + preview.revision, '状态 ' + (preview.status || ''), '来源 ' + (preview.created_by || 'author')];
    if (preview.chapter_title) metaBits.push('章节 ' + preview.chapter_title);
    else if (preview.chapter_id) metaBits.push('章节 #' + preview.chapter_id);
    if (preview.importance) metaBits.push('重要性 ' + preview.importance);
    if (preview.supersedes_event_id) metaBits.push('替代事件 #' + preview.supersedes_event_id);
    meta.textContent = metaBits.join(' · ');
    box.appendChild(meta);

    if (preview.summary) {
      var sum = document.createElement('div');
      sum.className = 'preview-summary';
      sum.textContent = preview.summary;
      box.appendChild(sum);
    }

    var changes = document.createElement('div');
    changes.className = 'preview-changes';
    var list = preview.changes || [];
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'preview-change-item';
      empty.textContent = '（无变化项）';
      changes.appendChild(empty);
    }
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      var item = document.createElement('div');
      item.className = 'preview-change-item';
      var label = ch.change_kind === 'relation'
        ? ('关系 ' + (ch.subject_ref || ''))
        : ((ch.field_key || '') + '（' + (ch.subject_ref || '') + '）');
      item.textContent = label + '：' + fmtVal(ch.old_value) + ' → ' + fmtVal(ch.new_value);
      changes.appendChild(item);
    }
    box.appendChild(changes);

    if (preview.source_quote) {
      var quote = document.createElement('div');
      quote.className = 'preview-quote';
      quote.textContent = '原文依据：「' + preview.source_quote + '」';
      box.appendChild(quote);
    }

    return box;
  }

  // 确认卡状态文案（M8 B1 口径，与 public/book-chat.js 逐字一致）：
  //   后端结算行保留 30 天，非 pending 状态必须渲染成只读历史卡——否则刷新后要么卡消失，
  //   要么变成「还能再点一次」的假 pending 卡。枚举外状态一律按只读历史卡兜底。
  var ACTION_STATUS_META = {
    pending: { text: '', readonly: false },
    executing: { text: '执行中…', readonly: true },
    approved: { text: '已执行 ✓', readonly: true },
    rejected: { text: '已拒绝，未做任何改动', readonly: true },
    expired: { text: '已过期未执行（等待确认超时）', readonly: true },
    superseded: { text: '已被更新的同类请求取代（未执行）', readonly: true },
    failed: { text: '执行失败', readonly: true },
    // S2-02：执行中断（重启/恢复期间执行到一半）——结果不确定，不给重放入口，
    // 提示作者核对目标内容后重新发起（新卡、新确认）
    interrupted: { text: '执行中断，可能已部分生效——请核对目标内容后重新发起', readonly: true },
  };
  var ACTION_STATUS_FALLBACK = { text: '已结算（状态未知）', readonly: true };

  function normalizeActionStatus(status) {
    var s = typeof status === 'string' ? status.trim() : '';
    return ACTION_STATUS_META[s] ? s : (s ? 'unknown' : 'pending');
  }

  function actionStatusMeta(status) {
    return ACTION_STATUS_META[status] || ACTION_STATUS_FALLBACK;
  }

  // 卡片状态切换：类名与状态行文案同步（只读态加 msg-action-readonly，与 book-chat 同口径）
  function setConfirmCardStatus(ui, key) {
    if (!ui) return;
    var meta = actionStatusMeta(key);
    if (ui.card) {
      ui.card.className = 'msg-action status-' + key;
      if (meta.readonly) ui.card.classList.add('msg-action-readonly');
      ui.card.dataset.actionStatus = key;
    }
    if (ui.status) ui.status.textContent = meta.text;
  }

  // 确认卡：展示工具名 + 完整变更参数 + 影响面；作者点「同意执行/拒绝」才落地
  // opts（M9-B 新增；缺省 = 现状，旧调用零改动）：
  //   status  卡片状态（缺省 pending）。非 pending → 只读历史卡：类名 status-<s> +
  //           msg-action-readonly，只留状态行，不提供任何可点的结算入口。
  function renderConfirmCard(shell, conf, toolName, args, opts) {
    opts = opts || {};
    var statusKey = normalizeActionStatus(opts.status);
    var statusMeta = actionStatusMeta(statusKey);
    var readonly = statusMeta.readonly;
    var card = document.createElement('div');
    card.className = 'msg-action status-' + statusKey;
    if (readonly) card.classList.add('msg-action-readonly');
    card.dataset.actionStatus = statusKey;

    var head = document.createElement('div');
    head.className = 'action-head';
    head.textContent = 'AI 请求写操作：' + (conf.summary || toolName || conf.tool || '');
    card.appendChild(head);

    // 提案评审/更新：展示提案完整差异（每项 old→new），供作者独立核对后再放行
    if (conf.preview && conf.preview.kind === 'event_proposal') {
      card.appendChild(renderProposalPreview(conf.preview));
    }

    var detail = document.createElement('details');
    detail.className = 'action-args';
    detail.open = true;
    var dsum = document.createElement('summary');
    dsum.textContent = '完整变更参数';
    var dpre = document.createElement('pre');
    var argsStr = '';
    try { argsStr = JSON.stringify(args || {}, null, 2); } catch (e) { argsStr = String(args); }
    dpre.textContent = argsStr === '{}' ? '（无参数）' : argsStr;
    detail.appendChild(dsum);
    detail.appendChild(dpre);
    card.appendChild(detail);

    if (conf.impact && conf.impact.length) {
      var imp = document.createElement('div');
      imp.className = 'action-impact';
      imp.textContent = '影响能力：' + conf.impact.join('、');
      card.appendChild(imp);
    }

    var ops = document.createElement('div');
    ops.className = 'action-ops';
    var status = document.createElement('span');
    status.className = 'action-status';
    status.textContent = statusMeta.text;

    // 只读历史卡（已结算/已过期/被取代/状态未知）：不给任何可点的结算入口，
    // 也不挂 settleAction——避免作者对已终态的动作误点第二次
    if (readonly) {
      ops.appendChild(status);
      card.appendChild(ops);
      shell.appendChild(card);
      return;
    }

    var okBtn = document.createElement('button');
    okBtn.className = 'btn btn-small';
    okBtn.textContent = '同意执行';
    var noBtn = document.createElement('button');
    noBtn.className = 'btn btn-small btn-ghost';
    noBtn.textContent = '拒绝';
    ops.appendChild(okBtn);
    ops.appendChild(noBtn);
    ops.appendChild(status);
    card.appendChild(ops);

    var ui = { okBtn: okBtn, noBtn: noBtn, status: status, card: card };
    okBtn.onclick = function () { settleAction(conf.id, true, ui); };
    noBtn.onclick = function () { settleAction(conf.id, false, ui); };
    shell.appendChild(card);
  }

  // 结算失败（网络错误 / 其余 4xx5xx）：保持现状——文案「确认失败」、按钮恢复可点、toast
  function failConfirm(ui, message) {
    setConfirmCardStatus(ui, 'pending');
    if (ui.status) ui.status.textContent = '确认失败';
    if (ui.okBtn) ui.okBtn.disabled = false;
    if (ui.noBtn) ui.noBtn.disabled = false;
    A.toast(message);
  }

  // 作者确认/拒绝 → 后端执行并结算 → 以系统事件 resume 续跑 Agent
  async function settleAction(cid, approve, ui) {
    ui.okBtn.disabled = true;
    ui.noBtn.disabled = true;
    ui.status.textContent = approve ? '执行中…' : '已拒绝';
    var confResp = null;
    var confData = null;
    try {
      var pendingConv = pendingConversationId(cid);
      confResp = await fetch('/api/agent/actions/' + cid + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingConv
          ? { approve: approve, conversation_id: pendingConv }
          : { approve: approve, session_id: sessionId }),
      });
      try { confData = await confResp.json(); } catch (e) { /* 非 JSON 响应 */ }
    } catch (e) {
      failConfirm(ui, e.message);
      return;
    }
    var errCode = confData && confData.error && confData.error.code ? confData.error.code : '';
    if (!confResp.ok) {
      // M7 F2：被更新的同类请求取代（409）→ 只读历史卡，不报「确认失败」、不 toast、不再 resume
      if (confResp.status === 409 && errCode === 'CONFIRMATION_SUPERSEDED') {
        forgetPending(cid);
        setConfirmCardStatus(ui, 'superseded');
        return;
      }
      // 已过期/凭证不存在（404 或 CONFIRMATION_NOT_FOUND）→ 只读 status-expired 卡，
      // 与「过期卡不得静默消失」同口径；从 pending 存储移除、不再 resume
      if (confResp.status === 404 || errCode === 'CONFIRMATION_NOT_FOUND') {
        forgetPending(cid);
        setConfirmCardStatus(ui, 'expired');
        return;
      }
      // S2-02：执行中断（结果不确定，可能已部分生效）→ 只读 interrupted 卡，不给重放入口
      if (confResp.status === 409 && errCode === 'ACTION_REQUIRES_REVIEW') {
        forgetPending(cid);
        setConfirmCardStatus(ui, 'interrupted');
        A.toast(confData && confData.error && confData.error.message ? confData.error.message : '执行中断，不能重放');
        return;
      }
      var msg = (confData && confData.error && (confData.error.message || confData.error.code)) || ('请求失败 ' + confResp.status);
      failConfirm(ui, msg);
      return;
    }
    // 已受理结算（同意/拒绝/执行失败都算已结算）：从 pending 存储移除，刷新后不再重建
    forgetPending(cid);
    var settled = confData && confData.status ? confData.status : '';
    if (settled === 'rejected') {
      setConfirmCardStatus(ui, 'rejected'); // 文案「已拒绝，未做任何改动」（与现状逐字一致）
    } else if (settled === 'failed') {
      setConfirmCardStatus(ui, 'failed');
      // 现状文案保留：执行失败 + 错误码后缀
      ui.status.textContent = '执行失败' + (errCode ? '：' + errCode : '');
    } else {
      setConfirmCardStatus(ui, 'approved');
    }
    // 无论同意/拒绝/失败，都以系统事件 resume，让模型基于可信结果续跑
    await resumeAction(cid);
  }

  // 调用 resume 接口：后端把可信执行结果作为系统事件重启 Agent，前端消费续流。
  // 串行队列：嵌套确认（resume 中 Agent 再次请求写操作）时，后一次 resume 等前一次流结束再跑，不丢弃
  var resumeChain = Promise.resolve();
  function resumeAction(cid) {
    var run = function () { return runResume(cid); };
    resumeChain = resumeChain.then(run, run);
    return resumeChain;
  }

  // 当前流（send/resume 共用）的停止句柄：生成中显示「停止生成」按钮（对齐 pi run 级 AbortController）
  var agentAbort = null;
  function updateStopBtn() {
    var b = el('btn-agent-stop');
    if (b) b.classList.toggle('hidden', !agentAbort);
  }

  async function runResume(cid) {
    sending = true;
    var btn = el('btn-agent-send');
    if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
    var runAbort = ChatEventHub.createAbort();
    agentAbort = runAbort;
    updateStopBtn();
    var shell = addMsgShell('assistant');
    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.textContent = '助手正在继续…';
    shell.appendChild(typing);
    scrollBottom();
    try {
      var resp = await fetch('/api/agent/actions/' + cid + '/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: pendingConversationId(cid) || undefined, request_id: ChatEventHub.newRequestId('agent-resume') }),
        signal: runAbort.signal,
      });
      // S2-01：同 requestId 重复续跑（另一窗口已发起）返回 202/200 JSON 幂等体——分流等待，不当错误处理
      if (resp.ok && ChatEventHub.isJsonResponse(resp)) {
        var dup = null;
        try { dup = await resp.json(); } catch (e) { /* 落入通用错误 */ }
        if (dup && dup.duplicate) {
          typing.remove();
          var wb = addBubble(shell);
          if (ChatEventHub.isActiveStatus(dup.status)) {
            wb.textContent = '（该续跑请求正在另一窗口进行，等待其结束…）';
            try {
              var fin = await ChatEventHub.waitRunEvents({
                runId: dup.runId,
                sessionKey: dup.sessionKey,
                signal: runAbort.signal,
                onEvent: function (ev) { if (ev.type === 'error') wb.textContent = '（该续跑在另一窗口发生错误，等待收尾…）'; },
              });
              wb.textContent = '（该续跑请求已在另一窗口' + (fin.status === 'finished' ? '完成' : '结束：' + fin.status) + '，请到发起窗口查看结果）';
            } catch (e) {
              if (ChatEventHub.isAbortError(e)) { wb.textContent = '（已停止等待另一窗口的续跑）'; return; }
              wb.textContent = '（等待另一窗口续跑结果失败：' + (e && e.message) + '，请到发起窗口查看）';
            }
          } else {
            wb.textContent = '（该续跑请求已在另一窗口结束，请到发起窗口查看结果）';
          }
          A.toast('该续跑请求已在另一窗口处理');
          return;
        }
        throw new Error((dup && dup.error && (dup.error.message || dup.error.code)) || ('恢复失败 ' + resp.status));
      }
      if (!resp.ok) {
        var errData = null;
        try { errData = await resp.json(); } catch (e) { /* 忽略 */ }
        throw new Error((errData && errData.error && (errData.error.message || errData.error.code)) || ('恢复失败 ' + resp.status));
      }
      typing.remove();
      var result = await consumeStream(resp, shell);
      lastRoundTools = result.tools || [];
      renderAgentRunCard();
      if (result.aborted) addBubble(shell).textContent = '（已停止生成）';
      // 回复由服务端落会话正典（S3-02），前端不再维护本地历史
    } catch (e) {
      typing.remove();
      if (runAbort.stopped()) {
        addBubble(shell).textContent = '（已停止生成）';
      } else {
        addBubble(shell).textContent = '续跑出错了：' + e.message;
        A.toast(e.message);
      }
    } finally {
      sending = false;
      if (agentAbort === runAbort) { agentAbort = null; updateStopBtn(); }
      if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    }
  }

  // ---------- 发送 ----------
  async function send() {
    if (sending) return;
    var input = el('agent-text');
    var btn = el('btn-agent-send');
    var content = input.value.trim();
    if (!content) return;

    sending = true;
    btn.disabled = true;
    btn.textContent = '执行中…';
    // S4-01b：先把会话准备好再渲染本轮气泡——newConversation() 会清空消息区（开新会话的语义），
    // 若放在气泡之后，作者刚发出的消息与正在流式渲染的回复会当场被清掉（无会话时首次发送必现）。
    if (!currentConversation) {
      try {
        await newConversation();
      } catch (e) {
        sending = false;
        btn.disabled = false;
        btn.textContent = '发送';
        A.toast('新会话创建失败：' + (e && e.message ? e.message : e));
        return;
      }
    }
    input.value = '';
    var runAbort = ChatEventHub.createAbort();
    agentAbort = runAbort;
    updateStopBtn();

    var userShell = addMsgShell('user');
    addBubble(userShell).textContent = content;

    var shell = addMsgShell('assistant');
    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.textContent = '助手正在思考…';
    shell.appendChild(typing);
    scrollBottom();

    try {
      // S4-01b：执行声明只在书籍范围；剧情边界（chapterId）按当前选择显式传递——
      // 服务端每次请求重新组装资料快照，不沿用上一轮的边界（S3-05 口径）。
      var payload = {
        conversation_id: currentConversation.id,
        content: content,
        request_id: ChatEventHub.newRequestId('agent'),
      };
      if (agentScope.kind === 'book' && agentMode === 'execute') {
        payload.mode = 'execute';
        payload.book_id = agentScope.bookId;
      }
      if (agentScope.kind === 'book' && boundaryChapterId) payload.chapterId = boundaryChapterId;
      var resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: runAbort.signal,
      });
      // S2-01：同 requestId 重复发送（另一窗口已发起）返回 202/200 JSON 幂等体——分流等待，不当错误处理
      if (resp.ok && ChatEventHub.isJsonResponse(resp)) {
        var dup = null;
        try { dup = await resp.json(); } catch (e) { /* 落入通用错误 */ }
        if (dup && dup.duplicate) {
          typing.remove();
          var wb = addBubble(shell);
          if (ChatEventHub.isActiveStatus(dup.status)) {
            wb.textContent = '（该请求正在另一窗口进行，等待其结束…）';
            try {
              var fin = await ChatEventHub.waitRunEvents({
                runId: dup.runId,
                sessionKey: dup.sessionKey,
                signal: runAbort.signal,
                onEvent: function (ev) { if (ev.type === 'error') wb.textContent = '（该请求在另一窗口发生错误，等待收尾…）'; },
              });
              wb.textContent = '（该请求已在另一窗口' + (fin.status === 'finished' ? '完成' : '结束：' + fin.status) + '，请到发起窗口查看结果）';
            } catch (e) {
              if (ChatEventHub.isAbortError(e)) { wb.textContent = '（已停止等待另一窗口的请求）'; return; }
              wb.textContent = '（等待另一窗口结果失败：' + (e && e.message) + '，请到发起窗口查看）';
            }
          } else {
            wb.textContent = '（该请求已在另一窗口结束，请到发起窗口查看结果）';
          }
          A.toast('该请求已在另一窗口处理');
          return;
        }
        throw new Error((dup && dup.error && (dup.error.message || dup.error.code)) || ('请求失败 ' + resp.status));
      }
      if (!resp.ok) {
        var errData = null;
        try { errData = await resp.json(); } catch (e) {}
        // errData.error 可能是对象（AGENT_BUSY/BOOK_BUSY 等 { code, message }），取 message/code 避免显示 [object Object]
        throw new Error((errData && errData.error && (errData.error.message || errData.error.code)) || ('请求失败 ' + resp.status));
      }
      var modelTag = el('agent-model');
      var m = resp.headers.get('X-Agent-Model');
      if (m && modelTag) modelTag.textContent = decodeURIComponent(m);
      typing.remove();
      var result = await consumeStream(resp, shell);
      lastRoundTools = result.tools || [];
      renderAgentRunCard();
      if (result.aborted) addBubble(shell).textContent = '（已停止生成）';
      // 回复由服务端落会话正典（S3-02）
    } catch (e) {
      typing.remove();
      var b = addBubble(shell);
      if (runAbort.stopped()) {
        b.textContent = '（已停止生成）';
      } else {
        b.textContent = '出错了：' + e.message;
        A.toast(e.message);
      }
    } finally {
      sending = false;
      if (agentAbort === runAbort) { agentAbort = null; updateStopBtn(); }
      btn.disabled = false;
      btn.textContent = '发送';
      input.focus();
    }
  }

  // ---------- S4-05：统一任务卡（任务徽标 / 结果引用 / 工具细节 / 待确认绑定会话）----------
  // 任务状态只来自服务端运行快照：本轮 SSE 的 finish.run，或刷新后会话历史里的 message.run
  // （S3-02 落库的正典）。读不到就显示「未知（待恢复）」，不由上一条气泡猜。
  var lastRunSnapshot = null;
  var lastToolErrors = [];
  var lastRoundTools = [];

  function pendingActionSummaries() {
    try {
      return loadPending().map(function (entry) {
        return {
          id: entry.id,
          conversationId: entry.conversationId || null,
          summary: (entry.toolName ? entry.toolName : '写操作') + '（等你在会话里确认）',
        };
      });
    } catch (e) { return []; }
  }

  function renderAgentRunCard() {
    var RS = window.RunStatus;
    var host = el('agent-run-card');
    if (!RS || !host) return null;
    var model = RS.cardModel({
      run: lastRunSnapshot,
      conversationId: currentConversation ? currentConversation.id : null,
      tools: lastRoundTools,
      toolErrors: lastToolErrors,
      actions: pendingActionSummaries(),
    });
    var empty = !model.badge && !model.pendingActions.length && !model.tools.length && !model.toolErrors.length;
    RS.mountTaskCard(host, empty ? null : model, {});
    return empty ? null : model;
  }

  // ---------- 页面入口 ----------
  async function show() {
    if (!inited) {
      inited = true;
      el('agent-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        send();
      });
      el('agent-text').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          send();
        }
      });
      el('btn-agent-stop').addEventListener('click', function () {
        if (agentAbort) agentAbort.stop('user');
      });
      var select = el('agent-conversation-select');
      if (select) select.addEventListener('change', function () {
        selectConversation(select.value);
      });
      // S4-01b：范围 / 剧情边界 / 左侧会话·资源切换 / 资源面板 / 预览
      var scopeSel = el('agent-scope-select');
      if (scopeSel) scopeSel.addEventListener('change', function () { switchScope(scopeSel.value); });
      var boundarySel = el('agent-boundary-select');
      if (boundarySel) boundarySel.addEventListener('change', function () {
        boundaryChapterId = boundarySel.value ? Number(boundarySel.value) : null;
        renderScopeStatus();
      });
      function bindSideTab(btnId, tabName) {
        var b = el(btnId);
        if (b) b.addEventListener('click', function () { switchSideTab(tabName); });
      }
      bindSideTab('btn-agent-tab-conversations', 'conversations');
      bindSideTab('btn-agent-tab-resources', 'resources');
      var typeSel = el('agent-res-type');
      if (typeSel) typeSel.addEventListener('change', function () {
        resType = typeSel.value;
        resCursor = null;
        resItems = [];
        loadResources({ reset: true });
      });
      var resRefresh = el('btn-agent-res-refresh');
      if (resRefresh) resRefresh.addEventListener('click', function () { loadResources({ reset: true }); });
      var resMore = el('btn-agent-res-more');
      if (resMore) resMore.addEventListener('click', function () { loadResources({}); });
      var previewClose = el('btn-agent-preview-close');
      if (previewClose) previewClose.addEventListener('click', function () { showPreview(false); });
      el('btn-agent-clear').addEventListener('click', async function () {
        // S3-02：清空=开新会话（S4-01b：按当前范围新建）。旧会话与服务端历史保留，不删任何数据
        try { await newConversation(); A.toast('已在当前范围开始新会话（原会话历史保留，可从会话列表切回）'); }
        catch (e) { A.toast('新会话创建失败：' + (e && e.message ? e.message : e)); }
      });
      var importBtn = el('btn-agent-import');
      if (importBtn) importBtn.addEventListener('click', importLegacy);
      var cleanBtn = el('btn-agent-clean-local');
      if (cleanBtn) cleanBtn.addEventListener('click', cleanLocalLegacy);
      var modeBtn = el('btn-agent-mode');
      if (modeBtn) modeBtn.addEventListener('click', function () {
        if (modeBtn.disabled) return;
        agentMode = agentMode === 'execute' ? 'discuss' : 'execute';
        refreshModeBtn();
        A.toast(agentMode === 'execute' ? '执行模式：AI 可发起写操作，每一步仍需你在确认卡放行' : '已切回只读讨论');
      });
      var cpBtn = el('btn-agent-compress');
      if (cpBtn) cpBtn.addEventListener('click', compressConversation);
      var rsBtn = el('btn-agent-restore');
      if (rsBtn) rsBtn.addEventListener('click', restoreConversation);
      // S4-04b：勾选讨论结论 → 存规划笔记 / 创建交接到写作（选择是本地行为，接受才写入）
      var noteBtn = el('btn-agent-save-note');
      if (noteBtn) noteBtn.addEventListener('click', saveNoteFromSelection);
      var handoffBtn = el('btn-agent-create-handoff');
      if (handoffBtn) handoffBtn.addEventListener('click', function () { createHandoffFromSelection(); });
      var pickClearBtn = el('btn-agent-pick-clear');
      if (pickClearBtn) pickClearBtn.addEventListener('click', clearPick);
      loadTools();
    }
    // S4-02：写作页「另开整体讨论」是在同一个 SPA 内跳过来的，范围/会话键在跳转前才写入；
    // 本文件的范围只在脚本加载时读过一次（S4-01b），这里入口重读一次，作者才落到刚选的那本书与
    // 那个新专题草案（readSavedScope 与 loadConversations 各读一半，键缺失/书被删都按既有回落）。
    agentScope = readSavedScope();
    // S4-01b：先取书（范围标题/边界选项要用），再装会话与资源视图
    await loadBooks();
    await loadConversations();
    renderScopeBar();
    renderResourceTypes();
    await loadBoundaryChapters();
    await renderServerHistory();
    updatePickBar();
    // 重建未结算的确认卡（M4/W11）：刷新前 AI 已发起、作者还没点的写动作不再凭空消失
    rebuildPendingCards();
    renderAgentRunCard();
    updateLegacyBar();
  }

  window.AgentPage = { show: show };
})();
