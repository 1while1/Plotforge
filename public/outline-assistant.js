// 大纲小助手：像素胶囊 + 页内对话面板。
// 通道复用 Agent 只读讨论（kind=agent、scope=book，不传 mode/book_id → discuss 只读工具，
// 与写作流并行安全）；SSE 统一走 ChatEventHub.consumeAgentStream，不自写解析。
// 会话懒创建：第一次发送时才 POST /api/conversations；同书重进复用同名会话并回放历史。
(function () {
  'use strict';
  var OutlineAssistant = window.OutlineAssistant = {};

  var state = {
    bookId: null,
    conversationId: null,
    sending: false,
    abort: null,
    opened: false,
    historyLoaded: false,
  };

  function esc(v) { return window.App.escapeHtml(v == null ? '' : String(v)); }

  // 16×16 像素小人（戴帽书生）：字符画 → SVG rect，crispEdges 保持像素棱角
  var PIXEL_ROWS = [
    '................',
    '.....######.....',
    '....########....',
    '..############..',
    '....ffffffff....',
    '....fefffeff....',
    '....ffffffff....',
    '.....ffffff.....',
    '..rrrrrrrrrrrr..',
    '.rrrrrrrrrrrrrr.',
    '.rrrssssssssrrr.',
    '.rrrssssssssrrr.',
    '.rrrrrrrrrrrrrr.',
    '.rrrrrrrrrrrrrr.',
    '....rr....rr....',
    '................',
  ];
  var PIXEL_COLORS = { '#': '#2b2620', f: '#ecd9b0', e: '#2b2620', r: '#a63a2b', s: '#e3d3a8' };

  function pixelSVG() {
    var rects = [];
    for (var y = 0; y < PIXEL_ROWS.length; y++) {
      var row = PIXEL_ROWS[y];
      for (var x = 0; x < row.length; x++) {
        var c = PIXEL_COLORS[row[x]];
        if (c) rects.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + c + '"/>');
      }
    }
    return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' + rects.join('') + '</svg>';
  }

  function capsuleHTML() {
    return '<button id="oa-capsule" class="oa-capsule" type="button" title="大纲小助手：问我节奏、断层、下一章怎么接">' +
      pixelSVG() + '<span class="oa-capsule-label">小助手</span></button>' +
      '<section id="oa-panel" class="oa-panel hidden" aria-label="大纲小助手对话面板">' +
        '<header class="oa-panel-head"><span class="oa-panel-title">大纲小助手</span>' +
          '<span class="oa-panel-tag">只读讨论 · 看得到总纲/卷纲/拍点</span>' +
          '<button id="oa-close" class="oa-close" type="button" title="收起">×</button></header>' +
        '<div id="oa-messages" class="oa-messages"></div>' +
        '<div class="oa-chips">' +
          '<button type="button" data-oa-chip="这卷的节奏怎么样？有没有连续平淡或高潮过密的地方？">节奏体检</button>' +
          '<button type="button" data-oa-chip="帮我看看章节拍点之间有没有断层，哪里需要补衔接章？">拍点断层</button>' +
          '<button type="button" data-oa-chip="按现在的总纲和卷纲，下一章可以往哪个方向写？给我两个可选方案。">下一章方向</button>' +
        '</div>' +
        '<form id="oa-form" class="oa-form">' +
          '<textarea id="oa-input" rows="2" placeholder="问小助手：写大纲卡住了就说话…"></textarea>' +
          '<button id="oa-send" class="btn btn-primary btn-small" type="submit">发送</button>' +
        '</form>' +
      '</section>';
  }

  function addMsg(role, text) {
    var box = document.getElementById('oa-messages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'oa-msg oa-' + role;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function addNote(text) {
    var box = document.getElementById('oa-messages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'oa-note';
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  // 复用同书的小助手会话：找标题前缀「大纲小助手」的最新一条；没有就在首次发送时创建
  async function findConversation() {
    var list = await window.App.api('GET', '/api/conversations?kind=agent&bookId=' + encodeURIComponent(state.bookId));
    var items = Array.isArray(list) ? list : [];
    for (var i = 0; i < items.length; i++) {
      if ((items[i].title || '').indexOf('大纲小助手') === 0 && items[i].status !== 'archived') return items[i];
    }
    return null;
  }

  async function ensureConversation() {
    if (state.conversationId) return state.conversationId;
    var existing = await findConversation();
    if (existing) { state.conversationId = existing.id; return existing.id; }
    var conv = await window.App.api('POST', '/api/conversations', {
      kind: 'agent', scope: 'book', bookId: state.bookId, title: '大纲小助手 · 工作台内讨论',
    });
    state.conversationId = conv.id;
    return conv.id;
  }

  async function loadHistory() {
    if (state.historyLoaded) return;
    state.historyLoaded = true;
    var conv = null;
    try { conv = await findConversation(); } catch (e) { /* 列表失败按新会话处理 */ }
    var box = document.getElementById('oa-messages');
    if (!box) return;
    if (!conv) {
      addNote('我是这本书的大纲小助手。我能看到总纲、卷纲、章节拍点和台账节奏——写大纲卡住了就问我。');
      return;
    }
    state.conversationId = conv.id;
    var data;
    try { data = await window.App.api('GET', '/api/conversations/' + conv.id + '/messages?limit=60'); }
    catch (e) { addNote('历史加载失败：' + e.message); return; }
    var msgs = (data && data.messages) || [];
    var shown = 0;
    msgs.forEach(function (m) {
      if (m.role === 'user' || m.role === 'assistant') {
        var text = typeof m.content === 'string' ? m.content : '';
        if (text.trim()) { addMsg(m.role === 'user' ? 'user' : 'assistant', text); shown++; }
      }
    });
    if (!shown) addNote('历史会话还在，但没有可显示的消息。直接问我吧。');
  }

  async function send(text) {
    if (state.sending) return;
    var input = document.getElementById('oa-input');
    var btn = document.getElementById('oa-send');
    state.sending = true;
    btn.textContent = '停止';
    input.value = '';
    addMsg('user', text);
    var reply = addMsg('assistant', '…');
    var acc = '';
    var abort = window.ChatEventHub.createAbort();
    state.abort = abort;
    try {
      var convId = await ensureConversation();
      var resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // discuss 模式：不传 mode/book_id → 只读工具，不拿写锁，与写作流并行安全
        body: JSON.stringify({ conversation_id: convId, content: text, request_id: window.ChatEventHub.newRequestId('oa') }),
        signal: abort.signal,
      });
      if (resp.ok && window.ChatEventHub.isJsonResponse(resp)) {
        var dup = null;
        try { dup = await resp.json(); } catch (e) { /* 落入通用错误 */ }
        if (dup && dup.duplicate) {
          reply.textContent = '（这条问题正在另一窗口回答中，请到那边查看）';
          return;
        }
        throw new Error((dup && dup.error && (dup.error.message || dup.error.code)) || ('请求失败 ' + resp.status));
      }
      if (!resp.ok) {
        var errData = null;
        try { errData = await resp.json(); } catch (e) { /* ignore */ }
        throw new Error((errData && errData.error && (errData.error.message || errData.error.code)) || ('请求失败 ' + resp.status));
      }
      var hadError = false;
      var result = await window.ChatEventHub.consumeAgentStream(resp, {
        onDelta: function (t) { acc += t; reply.textContent = acc; },
        onToolCall: function (t) { addNote('查阅了 ' + (t.toolName || '资料')); },
        onDone: function (ev) { if (ev && ev.text) { reply.textContent = ev.text; acc = ev.text; } },
        onError: function (info) { hadError = true; reply.textContent = '出错了：' + info.message; },
      });
      if (result.aborted) reply.textContent = acc ? acc + '\n（已停止）' : '（已停止）';
      else if (!acc.trim() && !result.toolErrors.length && !hadError) reply.textContent = '（小助手没有给出文字回答，换个问法试试）';
      result.toolErrors.forEach(function (te) { addNote('工具被拒：' + (te.message || te.code || te.toolName || '未知')); });
    } catch (e) {
      reply.textContent = '出错了：' + e.message;
    } finally {
      state.sending = false;
      state.abort = null;
      btn.textContent = '发送';
      var box = document.getElementById('oa-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
  }

  function bind() {
    var capsule = document.getElementById('oa-capsule');
    var panel = document.getElementById('oa-panel');
    var form = document.getElementById('oa-form');
    var btn = document.getElementById('oa-send');
    capsule.onclick = function () {
      state.opened = !state.opened;
      panel.classList.toggle('hidden', !state.opened);
      if (state.opened) loadHistory();
    };
    document.getElementById('oa-close').onclick = function () {
      state.opened = false;
      panel.classList.add('hidden');
    };
    panel.querySelectorAll('[data-oa-chip]').forEach(function (chip) {
      chip.onclick = function () {
        var input = document.getElementById('oa-input');
        input.value = chip.dataset.oaChip;
        input.focus();
      };
    });
    form.onsubmit = function (e) {
      e.preventDefault();
      if (state.sending) {
        if (state.abort) state.abort.stop('user');
        return;
      }
      var input = document.getElementById('oa-input');
      var text = input.value.trim();
      if (!text) return;
      send(text);
    };
  }

  // 由 outline-workbench 在渲染完工作台后挂载；anchor 为容器（position:relative 由 CSS 保证）
  OutlineAssistant.mount = function (bookId, anchor) {
    OutlineAssistant.unmount();
    state.bookId = bookId;
    var wrap = document.createElement('div');
    wrap.id = 'oa-root';
    wrap.innerHTML = capsuleHTML();
    anchor.appendChild(wrap);
    bind();
  };

  OutlineAssistant.unmount = function () {
    if (state.abort) state.abort.stop('unmount');
    var old = document.getElementById('oa-root');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    state.bookId = null;
    state.conversationId = null;
    state.sending = false;
    state.abort = null;
    state.opened = false;
    state.historyLoaded = false;
  };
})();
