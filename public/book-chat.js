(function () {
  'use strict';

  const A = App;
  const S = App.state;

  // S3-03：当前写作会话（按书存 localStorage；阅读页共享同一 key = 「默认继续作者选定的会话」）
  function convStorageKey() {
    return 'writing_conversation_' + ((S.currentBook && S.currentBook.id) || '');
  }
  var lastLoadedMessageId = null; // S3-04：压缩源版本锁（压缩期间来新消息 → 服务端 409）
  function currentConversationId() {
    if (!S.currentBook) return null;
    try { return localStorage.getItem(convStorageKey()) || null; } catch (e) { return null; }
  }
  function rememberConversation(id) {
    try {
      if (id) localStorage.setItem(convStorageKey(), id);
      else localStorage.removeItem(convStorageKey());
    } catch (e) { /* 忽略 */ }
    renderConversationBar();
  }
  // 会话切换器：书内 writing 会话列表（legacy 会话也在其中）
  async function renderConversationBar() {
    var sel = document.getElementById('writing-conversation-select');
    if (!sel || !S.currentBook) return;
    var list = [];
    try {
      list = await A.api('GET', '/api/conversations?kind=writing&bookId=' + S.currentBook.id);
    } catch (e) { list = []; }
    var cur = currentConversationId();
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = '（默认：历史对话）';
    if (!cur) none.selected = true;
    sel.appendChild(none);
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = list[i].id;
      opt.textContent = (list[i].title || '未命名会话') + (list[i].status === 'archived' ? '（已归档）' : '');
      if (list[i].id === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  async function switchConversation(id) {
    rememberConversation(id || null);
    await loadChat();
    refreshCtxMeter();
  }
  async function newWritingConversation() {
    if (!S.currentBook) return;
    try {
      var conv = await A.api('POST', '/api/conversations', { kind: 'writing', scope: 'book', bookId: S.currentBook.id, title: '新写作任务' });
      rememberConversation(conv.id);
      await loadChat();
      A.toast('已开始新写作会话（原会话历史保留，可从切换器回到）');
    } catch (e) { A.toast('新会话创建失败：' + e.message); }
  }
  function conversationQuery() {
    var id = currentConversationId();
    return id ? '?conversationId=' + encodeURIComponent(id) : '';
  }

  // ---------- S4-02：另开整体讨论（写作页 → Agent 台） ----------
  // 冻结契约（05-阶段四 S4-02）：携带 bookId 与可选 chapterId/characterId；只有作者明确选中的
  // 文字可以成为初始用户材料，默认不带任何写作对话历史；未保存稿先走既有离开守卫。
  // Agent 台读取的两个 key 由 public/agent.js 定义（S4-01b 的范围/会话持久化契约），这里只写不读；
  // 落地效果由 test/writing-workspace-state.test.js 与隔离实例冒烟共同钉住。
  var AGENT_SCOPE_KEY = 'agent_scope_v1';
  var AGENT_CONVERSATION_KEY = 'agent_conversation_v1';

  // 「明确选择的文字」= 编辑器里真实拉出的选区（不猜、不截取上下文）
  function selectedEditorText() {
    var el = document.getElementById('chapter-content');
    if (!el) return '';
    var start = Number(el.selectionStart);
    var end = Number(el.selectionEnd);
    if (!(end > start)) return '';
    return String(el.value || '').slice(start, end).trim();
  }

  function handoffRefs(book, chapter, character) {
    var refs = '《' + (book.title || ('#' + book.id)) + '》';
    if (chapter) refs += ' · 《' + (chapter.title || ('章节 #' + chapter.id)) + '》';
    if (character) refs += ' · 人物：' + character.name;
    return refs;
  }
  // 机器可读的来源锚：作者要看名字，模型与后续任务需要实体 id（契约 §6 的对象标识）
  function handoffIdAnchor(book, chapter, character) {
    var bits = ['bookId=' + book.id];
    if (chapter) bits.push('chapterId=' + chapter.id);
    if (character) bits.push('characterId=' + character.id);
    return '[' + bits.join(' ') + ']';
  }
  function handoffTitle(book, chapter, character) {
    var t = '《' + (book.title || ('#' + book.id)) + '》· 整体讨论';
    if (chapter) t += ' · 自《' + (chapter.title || ('章节 #' + chapter.id)) + '》';
    if (character) t += ' · 人物：' + character.name;
    return t.slice(0, 200); // 服务端 title 上限 200
  }
  function handoffMaterial(book, chapter, character, text) {
    return '【来自写作页·整体讨论】' + handoffRefs(book, chapter, character) + ' ' + handoffIdAnchor(book, chapter, character) +
      '\n以下为作者在写作页明确选中的文字：\n' + text;
  }
  function pickCharacter(list, value) {
    if (!value) return null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(value)) return list[i];
    }
    return null;
  }
  async function bookCharactersForHandoff() {
    try {
      var res = await A.api('GET', '/api/books/' + S.currentBook.id + '/characters');
      return res.characters || [];
    } catch (e) { return []; }
  }

  // 入口：未保存稿先走离开守卫（C03/S1-05），再预览确认，最后才建专题并跳转
  async function openAgentDiscussion() {
    if (!S.currentBook) return;
    if (BookPage.hasUnsavedChanges && BookPage.hasUnsavedChanges()) {
      var canLeave = await BookPage.leaveGuard({
        onRetry: function () { openAgentDiscussion(); },
        onDiscard: function () {
          if (BookPage.clearUnsaved) BookPage.clearUnsaved();
          openAgentDiscussion();
        },
      });
      if (!canLeave) return; // 留在本章：不交接、不跳转
    }
    var book = S.currentBook;
    var chapterId = S.currentChapterId || null;
    var titleInput = document.getElementById('chapter-title-input');
    var chapter = chapterId ? { id: chapterId, title: (titleInput && titleInput.value) || '' } : null;
    var characters = await bookCharactersForHandoff();
    var selected = selectedEditorText();
    var previewMaterial = selected ? handoffMaterial(book, chapter, null, selected) : '';
    var characterOptions = characters.map(function (c) {
      return '<option value="' + A.escapeHtml(c.id) + '">' + A.escapeHtml(c.name) + '</option>';
    }).join('');

    A.openModal({
      title: '另开整体讨论（AI 助手）',
      okText: '前往 AI 助手',
      bodyHTML:
        '<p class="field-hint">将在 <strong>AI 助手</strong> 的《' + A.escapeHtml(book.title || '') + '》范围新开一个讨论专题草案：<br><strong>' +
          A.escapeHtml(handoffTitle(book, chapter, null)) + '</strong></p>' +
        '<p class="field-hint">默认<strong>不带</strong>写作助手里的对话历史——两个空间的会话各自独立。只有你在这里明确选中的文字才会作为初始材料带过去。</p>' +
        (selected
          ? '<label class="field field-inline"><input type="checkbox" id="agent-discuss-quote" checked> 带上我在正文里选中的 ' + selected.length + ' 字作为初始材料</label>' +
            '<pre class="handoff-preview" id="agent-discuss-preview">' + A.escapeHtml(previewMaterial) + '</pre>'
          : '<p class="field-hint">当前没有选中文字：本次只带去这本书与当前章（不复制任何写作历史）。想带材料，先在正文里选中一段再来。</p>') +
        (characters.length
          ? '<label class="field"><span>讨论对象（可选，会写进专题名与来源行）</span><select id="agent-discuss-character"><option value="">不指定</option>' + characterOptions + '</select></label>'
          : ''),
      onOk: async function (body) {
        var quoteEl = body && body.querySelector ? body.querySelector('#agent-discuss-quote') : null;
        var charEl = body && body.querySelector ? body.querySelector('#agent-discuss-character') : null;
        var character = charEl ? pickCharacter(characters, charEl.value) : null;
        var includeText = !!(selected && (!quoteEl || quoteEl.checked));
        try {
          var conv = await A.api('POST', '/api/conversations', {
            kind: 'agent', scope: 'book', bookId: book.id, title: handoffTitle(book, chapter, character),
          });
          if (includeText) {
            await A.api('POST', '/api/conversations/' + encodeURIComponent(conv.id) + '/messages', {
              content: handoffMaterial(book, chapter, character, selected),
              source: 'writing',
            });
          }
          try {
            localStorage.setItem(AGENT_SCOPE_KEY, 'book:' + book.id);
            localStorage.setItem(AGENT_CONVERSATION_KEY, conv.id);
          } catch (e) { /* 忽略：存储不可用时仍照常跳转，Agent 台退回自己的范围 */ }
          if (BookPage.saveWritingReturn) BookPage.saveWritingReturn({ bookId: book.id, chapterId: chapterId });
          location.hash = '#/agent';
          A.toast(includeText ? '已在 AI 助手开启整体讨论（只带了这本书与你选中的文字）' : '已在 AI 助手开启整体讨论（未带写作历史）');
          return true;
        } catch (e) {
          A.toast('另开整体讨论失败：' + e.message);
          return false;
        }
      },
    });

    // 选了人物后预览里的来源行同步更新（真实 DOM；拿不到弹窗节点就保持无人物的预览）
    var modalBody = document.getElementById('modal-body');
    var charSel = modalBody && modalBody.querySelector ? modalBody.querySelector('#agent-discuss-character') : null;
    var preview = modalBody && modalBody.querySelector ? modalBody.querySelector('#agent-discuss-preview') : null;
    if (charSel && preview && selected) {
      charSel.onchange = function () {
        preview.textContent = handoffMaterial(book, chapter, pickCharacter(characters, charSel.value), selected);
      };
    }
  }
  BookPage.openAgentDiscussion = openAgentDiscussion;

  // ---------- S4-04b：交接消息的来源回跳（讨论 → 写作 的显式材料）----------
  // 消息内容由服务端模板生成（server/conversations/handoffs.js buildHandoffMessageContent）：
  // 首行「【来自 Agent 讨论·显式交接】来源会话：<标题>（<会话 id>）」，随后是作者摘要、选定结论
  // 摘录与「来源引用：…」行。这里只做两件事：识别来源 id、给出回跳入口；不推断、不改写内容——
  // 解析不到来源 id 就按普通消息渲染（材料原文仍在气泡里，作者照常可读）。
  var HANDOFF_PREFIX = '【来自 Agent 讨论·显式交接】';

  function parseHandoffSource(content) {
    var text = String(content || '');
    if (text.indexOf(HANDOFF_PREFIX) !== 0) return null;
    var head = /来源会话：([\s\S]*?)（([0-9a-zA-Z-]{8,64})）/.exec(text);
    var refs = [];
    var refLine = /来源引用：([^\n]*)/.exec(text);
    if (refLine) refs = refLine[1].split('｜').map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      originConversationId: head ? head[2] : '',
      originTitle: head ? head[1] : '',
      refs: refs,
    };
  }

  // 回跳＝把 Agent 台的落点键写到来源会话所在范围（书籍/全局）+ 记下写作页返回锚，
  // 由 S4-02 的「Agent 台入口重读范围键」接管（public/agent.js show()）。
  async function openHandoffOrigin(info) {
    if (!info || !info.originConversationId) {
      A.toast('这条交接消息没有可识别的来源会话 id（材料仍在会话里可读）');
      return;
    }
    var list = [];
    try { list = await A.api('GET', '/api/conversations?kind=agent'); } catch (e) { list = []; }
    var origin = null;
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i].id === info.originConversationId) origin = list[i];
    }
    if (!origin) {
      A.toast('来源讨论会话已不存在：交接消息与材料仍在写作会话里，可照常阅读');
      return;
    }
    try {
      localStorage.setItem('agent_scope_v1',
        (origin.scope === 'book' && origin.book_id) ? ('book:' + origin.book_id) : 'global');
      localStorage.setItem('agent_conversation_v1', origin.id);
    } catch (e) { /* 存储不可用：Agent 台退回自己的范围，跳转本身仍然发生 */ }
    if (BookPage.saveWritingReturn) {
      BookPage.saveWritingReturn({ bookId: S.currentBook ? S.currentBook.id : null, chapterId: S.currentChapterId || null });
    }
    location.hash = '#/agent';
    A.toast('已跳到来源讨论（来源与引用见消息下方）');
  }

  // 交接消息的动作区：回跳入口 + 逐字来源引用（笔记 id 是 UUID，不能当数字解析）
  function renderHandoffSource(div, info) {
    const ops = document.createElement('div');
    ops.className = 'msg-actions';
    const open = document.createElement('button');
    open.className = 'btn btn-small btn-outline';
    open.textContent = '查看来源讨论';
    open.onclick = function () { openHandoffOrigin(info); };
    ops.appendChild(open);
    div.appendChild(ops);

    if (info.refs.length) {
      const box = document.createElement('details');
      box.className = 'msg-handoff-refs';
      const sum = document.createElement('summary');
      sum.textContent = '来源与引用（' + info.refs.length + '）';
      box.appendChild(sum);
      const pre = document.createElement('pre');
      pre.className = 'handoff-preview';
      pre.textContent = (info.originTitle
        ? ('来源会话：' + info.originTitle + '（' + info.originConversationId + '）\n')
        : '') + info.refs.join('\n');
      box.appendChild(pre);
      div.appendChild(box);
    }
  }

  function api(method, path, body) {
    return A.api(method, '/api/books/' + S.currentBook.id + path, body);
  }

  function scrollBottom() {
    const m = document.getElementById('chat-messages');
    if (m) m.scrollTop = m.scrollHeight;
  }

  // 从【需要确认】区块解析「问题 → 选项」分组（B4；2026-09-11 作者实测反馈 ④）。
  // 旧行为：把所有行括号里的选项平铺进一个数组——模型给出两个问题时，4 个「选项A/B」
  // 按钮挤成一行，作者分不清哪个按钮属于哪个问题。
  // 新行为：按「问题行」切分（含 ？/? 的行，或带编号的问题行），每个问题只取自己行内
  // 括号里以 / 或 ／ 分隔的选项；无问题结构时退化为单组平铺（向后兼容旧格式）。
  // 返回 [{question, options:[...]}]；上限 3 组 × 每组 4 个。
  const QUICK_MAX_GROUPS = 3;
  const QUICK_MAX_OPTS = 4;
  const QUICK_MAX_LABEL = 20; // 超长片段（正文摘录等）不当选项，沿用旧口径

  function pushQuickOptions(arr, raw, max) {
    if (!arr || arr.length >= max) return;
    for (const opt of String(raw).split(/[\/／]/)) {
      if (arr.length >= max) break;
      const label = opt.trim().replace(/[。；;，,]$/, '');
      if (!label || label.length > QUICK_MAX_LABEL) continue;
      if (arr.indexOf(label) < 0) arr.push(label);
    }
  }

  function parseQuickReplies(text) {
    const groups = [];
    const loose = []; // 无问题结构时的平铺选项（旧行为兜底）
    let current = null; // 当前收选项的问题组；null 表示选项进 loose（无问题结构）
    for (const rawLine of String(text == null ? '' : text).split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parens = line.match(/（[^（）]*）|\([^()]*\)/g) || [];
      // 问题行：含问号，或行首编号（"1." / "1、" / "一、"）且带括号选项
      const numbered = /^([0-9]{1,2}|[一二三四五六七八九十])[.、)．]/.test(line);
      const isQuestion = /[？?]/.test(line) || (numbered && parens.length > 0);
      if (isQuestion) {
        if (groups.length < QUICK_MAX_GROUPS) {
          const question = line
            .replace(/^([0-9]{1,2}|[一二三四五六七八九十])[.、)．]\s*/, '')
            .replace(/（[^（）]*）|\([^()]*\)/g, '')
            .trim();
          current = { question: question || line, options: [] };
          groups.push(current);
        } else {
          // 超出组数上限：该问题的选项丢弃，绝不并进上一个问题（否则按钮归属又是错的）
          current = null;
        }
      }
      for (const p of parens) {
        if (current) pushQuickOptions(current.options, p.slice(1, -1), QUICK_MAX_OPTS);
        else pushQuickOptions(loose, p.slice(1, -1), QUICK_MAX_OPTS);
      }
    }
    const out = groups.filter(function (g) { return g.options.length; }).slice(0, QUICK_MAX_GROUPS);
    if (out.length) return out;
    return loose.length ? [{ question: '', options: loose.slice(0, QUICK_MAX_OPTS) }] : [];
  }

  // 「参考了旧文」折叠块：展示 AI 本轮语义召回的定稿旧文片段
  function renderRetrieval(hits) {
    if (!hits || !hits.length) return null;
    const box = document.createElement('details');
    box.className = 'msg-retrieval';
    const sum = document.createElement('summary');
    sum.textContent = '参考了 ' + hits.length + ' 段旧文（语义召回）';
    box.appendChild(sum);
    const list = document.createElement('div');
    list.className = 'retrieval-body';
    for (const h of hits) {
      const item = document.createElement('div');
      item.className = 'retrieval-item';
      const head = document.createElement('div');
      head.className = 'retrieval-head';
      head.textContent = '《' + (h.chapter || '') + '》 · 相似度 ' + h.score;
      const text = document.createElement('div');
      text.className = 'retrieval-text';
      text.textContent = h.text;
      item.appendChild(head);
      item.appendChild(text);
      list.appendChild(item);
    }
    box.appendChild(list);
    return box;
  }

  // 消息来源标签（B5）：写作台/阅读页侧栏/助手页/系统事件共用同一本书的会话，
  // 消息本身不带来源就无法区分「谁说的」。空串与未知值一律不渲染（老数据静默兼容）。
  const SOURCE_LABELS = {
    writing: '写作台',
    read: '阅读页',
    agent: '助手',
    system: '系统',
  };

  // 工具友好名
  const TOOL_LABELS = {
    search_story: '语义检索旧文',
    grep_chapters: '关键词查全文',
    read_chapter: '阅读章节',
    read_chapter_range: '分段阅读章节',
    list_chapters: '列出章节',
    get_story_state: '读取状态簿',
    list_characters: '查看人物卡',
    list_worldview: '查看世界观',
    get_book_info: '查看本书信息',
    create_chapter: '新建章节',
    append_chapter: '追加章节正文',
    replace_chapter: '替换章节正文',
    set_chapter_meta: '修改章节标题/节拍',
    set_master_outline: '设置全书总纲',
    update_volume: '修改分卷',
    add_character: '新增人物卡',
    update_character: '更新人物卡',
    add_worldview: '新增世界观条目',
    write_story_state: '改写状态簿',
  };

  // 只读工具调用块：展示 AI 写作中自主查了什么
  function renderToolEvent(t) {
    const box = document.createElement('details');
    box.className = 'tool-call';
    const sum = document.createElement('summary');
    sum.textContent = '调用工具：' + (TOOL_LABELS[t.name] || t.name);
    box.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'tool-call-body';
    const argsPre = document.createElement('pre');
    argsPre.textContent = '入参：' + JSON.stringify(t.args || {});
    const resPre = document.createElement('pre');
    resPre.textContent = '结果：' + (typeof t.result === 'string' ? t.result : JSON.stringify(t.result));
    body.appendChild(argsPre);
    body.appendChild(resPre);
    box.appendChild(body);
    return box;
  }

  // 确认卡状态文案（B1；2026-09-11 作者实测反馈 ②③）：
  //   后端结算行保留 30 天且 /chat/actions 返回全状态，前端必须把「已结算」渲染成
  //   只读历史卡——否则作者刷新后看到的要么是消失的卡，要么是能再点一次的假 pending 卡。
  const ACTION_STATUS_META = {
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
  // 未知状态兜底：契约枚举外一律按只读历史卡渲染（宁可不给点，也不给能误点第二次的按钮）
  const ACTION_STATUS_FALLBACK = { text: '已结算（状态未知）', readonly: true };

  function normalizeActionStatus(status) {
    const s = typeof status === 'string' ? status.trim() : '';
    return ACTION_STATUS_META[s] ? s : (s ? 'unknown' : 'pending');
  }

  function actionStatusMeta(status) {
    return ACTION_STATUS_META[status] || ACTION_STATUS_FALLBACK;
  }

  // 已结算写操作的紧凑留痕行：挂在来源消息正文下方（Claude Code 式单行日志），
  // 不再是独立卡片。详情入 title；找不到来源消息时不渲染（清空会话后随之不可见）。
  function renderActionLog(action, statusKey) {
    const key = statusKey || normalizeActionStatus(action.status);
    const row = document.createElement('div');
    row.className = 'msg-action-log status-' + key;
    const icon = document.createElement('span');
    icon.className = 'log-icon';
    icon.textContent = key === 'approved' ? '✓' : (key === 'rejected' ? '✕' : '·');
    const text = document.createElement('span');
    text.className = 'log-text';
    // 老数据的 summary 就是原始工具名，优先用中文标签；有章节标题参数时带上
    let label = TOOL_LABELS[action.name] || action.summary || action.name;
    if (action.args && action.args.title) label += '「' + String(action.args.title) + '」';
    text.textContent = label;
    const st = document.createElement('span');
    st.className = 'log-status';
    st.textContent = actionStatusMeta(key).text;
    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(st);
    row.title = JSON.stringify(action.args || {}, null, 2);
    return row;
  }

  // 写操作确认卡：AI 发起的改动必须作者点击「同意」才落地。
  // opts（阅读页等复用时传入；缺省按写作台行为）：
  //   bookId    结算请求发到哪本书（缺省 S.currentBook.id）
  //   onSettled(name, args)  写操作落地后的联动刷新（缺省 refreshAfterWrite）
  //   resume(actionId)       结算后续跑方式（缺省 resumeAfterConfirm，走写作台队列）
  function renderActionCard(action, opts) {
    opts = opts || {};
    const bookId = opts.bookId != null ? opts.bookId : (S.currentBook && S.currentBook.id);
    const confirmUrl = '/api/books/' + bookId + '/chat-actions/' + action.id + '/confirm';
    const afterSettled = opts.onSettled || function (name, args) { refreshAfterWrite(name, args); };
    const resumeRun = opts.resume || function (actionId) { resumeAfterConfirm(actionId); };
    // 状态缺省按 pending（SSE 的 action 事件不带 status——能推出来就是待确认的新卡）
    const statusKey = normalizeActionStatus(action.status);
    const statusMeta = actionStatusMeta(statusKey);
    const readonly = statusMeta.readonly;
    const card = document.createElement('div');
    card.className = 'msg-action status-' + statusKey;
    if (readonly) card.classList.add('msg-action-readonly');

    const head = document.createElement('div');
    head.className = 'action-head';
    head.textContent = (readonly ? '写操作（历史）：' : 'AI 请求写操作：') + (TOOL_LABELS[action.name] || action.name);
    card.appendChild(head);

    // 正文类参数重点预览，其余 JSON 折叠
    const a = action.args || {};
    const previewText = a.text || a.content || '';
    if (previewText) {
      const pre = document.createElement('pre');
      pre.className = 'action-preview';
      pre.textContent = previewText.length > 800 ? previewText.slice(0, 800) + '…' : previewText;
      card.appendChild(pre);
    }
    const detail = document.createElement('details');
    detail.className = 'action-args';
    const dsum = document.createElement('summary');
    dsum.textContent = '完整参数';
    const dpre = document.createElement('pre');
    dpre.textContent = JSON.stringify(a, null, 2);
    detail.appendChild(dsum);
    detail.appendChild(dpre);
    card.appendChild(detail);

    const ops = document.createElement('div');
    ops.className = 'action-ops';
    const status = document.createElement('span');
    status.className = 'action-status';
    status.textContent = statusMeta.text;

    // 只读历史卡：不给任何可点的结算入口，只留状态行（避免对已结算动作二次确认）
    if (readonly) {
      ops.appendChild(status);
      card.appendChild(ops);
      return card;
    }

    // 目标章节处于定稿态时，提供「写入后自动重新定稿」勾选（默认不勾）
    let relockChk = null;
    if (action.chapterLocked && (action.name === 'append_chapter' || action.name === 'replace_chapter')) {
      const relockLabel = document.createElement('label');
      relockLabel.className = 'action-relock';
      relockChk = document.createElement('input');
      relockChk.type = 'checkbox';
      relockLabel.appendChild(relockChk);
      relockLabel.appendChild(document.createTextNode(' 写入后自动重新定稿（重建语义索引）'));
      ops.appendChild(relockLabel);
    }
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-small';
    okBtn.textContent = '同意执行';
    const noBtn = document.createElement('button');
    noBtn.className = 'btn btn-small btn-ghost';
    noBtn.textContent = '拒绝';
    ops.appendChild(okBtn);
    ops.appendChild(noBtn);
    ops.appendChild(status);
    card.appendChild(ops);

    // 结算过程中同步卡片的视觉状态（执行中→只读、失败→可重试的 pending 外观），
    // 让「已结算的卡」即时变成只读历史卡，不必等下次刷新 loadChat 回放（B1）
    function setCardStatus(key) {
      card.className = 'msg-action status-' + key;
      if (actionStatusMeta(key).readonly) card.classList.add('msg-action-readonly');
      card.dataset.actionStatus = key;
      status.textContent = actionStatusMeta(key).text;
    }

    async function settle(approve) {
      okBtn.disabled = true;
      noBtn.disabled = true;
      status.textContent = approve ? '执行中…' : '已拒绝';
      try {
        const data = await A.api('POST', confirmUrl, { approve: approve, relock: approve && !!(relockChk && relockChk.checked) });
        if (!approve) {
          setCardStatus('rejected');
          // 结算即刻收编为留痕行（原位 = 原消息正文下方），不再留卡片
          card.replaceWith(renderActionLog(action, 'rejected'));
          resumeRun(action.id); // 拒绝也回灌：模型需要知道作者否决了它的请求并改道
          return;
        }
        setCardStatus('approved');
        card.replaceWith(renderActionLog(action, 'approved'));
        A.toast(data.relocked ? '写操作已执行，已重新定稿（后台重建索引中）' : '写操作已执行');
        afterSettled(action.name, a);
        resumeRun(action.id); // 结果回灌续跑（方向报告 1.4）：AI 看到真实执行结果后继续原任务
      } catch (e) {
        // S2-02：执行中断（结果不确定）不得变成「可重试」——终态化为只读 interrupted 卡，
        // 作者核对目标内容后须重新发起（新卡、新确认），这里不给重放按钮
        if (e && (e.code === 'ACTION_REQUIRES_REVIEW' || e.code === 'CONFIRMATION_INTERRUPTED')) {
          setCardStatus('interrupted');
          status.textContent = '执行中断，可能已部分生效——请核对目标内容后重新发起';
          A.toast(e.message || '执行中断，不能重放');
          return;
        }
        setCardStatus('pending');
        status.textContent = '执行失败，可重试';
        okBtn.disabled = false;
        noBtn.disabled = false;
        A.toast(e.message);
      }
    }

    // 「同意执行」不直接执行，先弹出物理隔绝的红色确认弹窗
    function buildConfirmBody() {
      var label = TOOL_LABELS[action.name] || action.name;
      var previewArgs = {};
      Object.keys(a).forEach(function (k) {
        var v = a[k];
        if ((k === 'text' || k === 'content') && typeof v === 'string' && v.length > 1500) {
          v = v.slice(0, 1500) + '…';
        }
        previewArgs[k] = v;
      });
      return '<p>AI 请求执行写操作，执行后将真实改动作品数据。请确认：</p>' +
        '<p><strong>' + A.escapeHtml(label) + '</strong></p>' +
        '<pre class="action-preview">' + A.escapeHtml(JSON.stringify(previewArgs, null, 2)) + '</pre>';
    }

    okBtn.onclick = function () {
      // 打开弹窗时快照勾选状态（勾选信息随确认请求一起提交）
      var wantRelock = !!(relockChk && relockChk.checked);
      A.openModal({
        title: '确认写操作',
        okText: '确认执行',
        danger: true,
        bodyHTML: buildConfirmBody() +
          (action.chapterLocked && (action.name === 'append_chapter' || action.name === 'replace_chapter')
            ? '<p class="relock-note"><label><input type="checkbox" id="modal-relock"' + (wantRelock ? ' checked' : '') + '> 写入后自动重新定稿（重建语义索引）</label></p>'
            : ''),
        onOk: async function () {
          var modalChk = document.getElementById('modal-relock');
          var relock = !!(modalChk && modalChk.checked);
          if (modalChk && relockChk) relockChk.checked = relock;
          okBtn.disabled = true;
          noBtn.disabled = true;
          setCardStatus('executing');
          try {
            const data = await A.api('POST', confirmUrl, { approve: true, relock: relock });
            setCardStatus('approved');
            if (data.relocked) status.textContent = '已执行 ✓（已重新定稿）';
            A.toast(data.relocked ? '写操作已执行，已重新定稿（后台重建索引中）' : '写操作已执行');
            afterSettled(action.name, a);
            resumeRun(action.id); // 结果回灌续跑（方向报告 1.4）
          } catch (e) {
            setCardStatus('pending');
            status.textContent = '执行失败，可重试';
            okBtn.disabled = false;
            noBtn.disabled = false;
            A.toast(e.message);
            return false; // 不关闭弹窗
          }
        }
      });
    };
    noBtn.onclick = function () { settle(false); };
    return card;
  }

  // 写操作落地后刷新相关面板
  function refreshAfterWrite(name, args) {
    if (!S.currentBook) return;
    if (['create_chapter', 'append_chapter', 'replace_chapter', 'set_chapter_meta'].includes(name)) {
      if (BookPage.loadChapters) BookPage.loadChapters();
      // 改动的是当前打开的章节 → 编辑器同步最新内容
      const cid = args.chapterId || (args.chapter && args.chapter.id);
      if (cid && cid === S.currentChapterId && BookPage.selectChapter) {
        BookPage.selectChapter(cid);
      }
    } else if (['add_character', 'update_character'].includes(name)) {
      loadCharacters();
    } else if (name === 'add_worldview') {
      loadWorld();
    }
  }

  // ---------- 上下文仪表 ----------
  function fmtK(n) {
    if (!n && n !== 0) return '—';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  }

  // usage: { prompt_tokens, cache_hit_tokens } 或 null（null 时拉估算）
  async function refreshCtxMeter(usage) {
    const fill = document.getElementById('ctx-fill');
    const text = document.getElementById('ctx-text');
    if (!fill || !text || !S.currentBook) return;
    try {
      const st = await api('GET', '/context-status' + conversationQuery());
      const win = (st && st.contextWindow) || 128000;
      // 窗口来源透明化（官方渠道报告 → 用户设置 → 系统默认）；被钳制/官方缺失时仪表直接说明原因
      const clampSuffix = (st && st.clamped) ? ' · 设 ' + fmtK(st.windowManual) + ' 被钳制为 ' + fmtK(win)
        : (st && st.officialSource === 'channel_not_reported') ? ' · 渠道未报官方上限' + (st.windowManual ? '，按你设置生效' : '，按系统默认')
        : (st && st.officialSource === 'not_fetched') ? ' · 官方源尚未拉取'
        : (st && st.officialSource === 'channel_reported') ? ' · 官方 ' + fmtK(st.windowOfficial)
        : '';
      const u = usage || (st && st.lastUsage) || null;
      if (u) {
        const used = u.prompt_tokens || 0;
        const pct = Math.min(100, Math.round(used / win * 100));
        fill.style.width = pct + '%';
        fill.classList.toggle('ctx-warn', pct > 70);
        let t = '上下文 ' + fmtK(used) + ' / ' + fmtK(win) + '（' + pct + '%）';
        if (u.cache_hit_tokens) t += ' · 缓存命中 ' + fmtK(u.cache_hit_tokens);
        text.textContent = t + clampSuffix;
      } else {
        const est = (st && st.estimatedPromptTokens) || 0;
        const pct = Math.min(100, Math.round(est / win * 100));
        fill.style.width = pct + '%';
        fill.classList.toggle('ctx-warn', pct > 70);
        text.textContent = '上下文 ≈' + fmtK(est) + ' / ' + fmtK(win) + '（' + pct + '%）· 活跃 ' + st.messages.active + ' 条' + (st.messages.archived ? ' · 已归档 ' + st.messages.archived + ' 条' : '') + clampSuffix;
      }
    } catch (e) { /* 仪表失败不影响聊天 */ }
  }

  // 上下文组成明细面板：像通用 agent 的上下文视图一样展示分段占比
  // （系统提示各节 / 对话历史 / 工具调用结果 / 输出预留 / 剩余自由）
  async function openCtxBreakdown() {
    if (!S.currentBook) return;
    try {
      const cidQ = conversationQuery();
      const q = (S.currentChapterId ? '?chapterId=' + S.currentChapterId : cidQ)
        + (S.currentChapterId && cidQ ? cidQ.replace('?', '&') : '');
      const d = await api('GET', '/context-breakdown' + q);
      const win = d.window || 128000;
      const lb = d.lastBreakdown;
      // 优先用最近一次真实请求的组成；没有则用当前估算
      const sys = lb ? lb.system : d.system.total;
      const hist = lb ? lb.history : d.history.chatTokens;
      const tool = lb ? lb.tool : d.history.toolTokens;
      const sch = lb ? (lb.schema || 0) : (d.schema || 0);
      const out = lb ? lb.outputReserve : d.outputReserve;
      const usedPrompt = (lb && lb.promptTokens) || d.estimatedPrompt;
      // free 用真实尺度算：窗口 − 真实 prompt 占用 − 真实输出预留。out 是 API 的 max_tokens、
      // usedPrompt 是官方 usage，二者本就是真实值，不可再乘校准系数。
      const free = Math.max(0, win - usedPrompt - out);
      const pct = function (t) { return win ? Math.round(t / win * 1000) / 10 : 0; };
      // 校准（A-05）：官方 usage 只报总量；本地对「四桶」（系统/历史/工具结果/工具定义）的逐层估算
      //   × 系数（官方总量 ÷ 本地四桶和）= 真实尺度的细分。系数只该作用在这四桶上——out/free 已是
      //   真实尺度，若一并乘系数会口径错配，「剩余自由」曾因此显示成窗口总量的 124%。
      const cal = d.calibration;
      const calib = function (t) { return cal ? Math.round(t * cal.factor) : t; };
      const calTag = cal ? '（校准）' : '';
      const segs = [
        { name: '系统提示词', tokens: sys, color: '#5b8dd9' },
        { name: '对话历史', tokens: hist, color: '#7fb069' },
        { name: '工具调用结果', tokens: tool, color: '#e0a458' },
        { name: '工具定义（schema）', tokens: sch, color: '#8d9aa5' },
        { name: '输出预留（max_tokens）', tokens: out, color: '#b58bd9', raw: true },
        { name: '剩余自由', tokens: free, color: '#d9d9d9', raw: true },
      ];
      // raw 段用原值（本就真实尺度），其余四桶用校准值
      const segVal = function (s) { return s.raw ? s.tokens : calib(s.tokens); };
      const segTag = function (s) { return s.raw ? '' : calTag; };
      let bar = '<div class="ctx-bd-bar">';
      segs.forEach(function (s) {
        const v = segVal(s);
        if (v <= 0) return;
        bar += '<div class="ctx-bd-seg" style="width:' + Math.max(0.5, pct(v)) + '%;background:' + s.color + '" title="' + s.name + ' ≈' + fmtK(v) + segTag(s) + '（' + pct(v) + '%）"></div>';
      });
      bar += '</div>';
      let rows = '';
      segs.forEach(function (s) {
        const v = segVal(s);
        rows += '<div class="ctx-bd-row"><span class="ctx-bd-dot" style="background:' + s.color + '"></span><span class="ctx-bd-name">' + s.name + '</span><span class="ctx-bd-val">≈' + fmtK(v) + segTag(s) + ' · ' + pct(v) + '%</span></div>';
      });
      // 系统提示逐层明细：优先用该次请求落库的组装层台账（parts_json），无则当前组装估算
      const parts = (lb && lb.parts && lb.parts.length) ? lb.parts : (d.system.parts || []);
      const partsSrc = (lb && lb.parts && lb.parts.length) ? '本次请求逐层组装台账，随调用落库' : '当前组装估算';
      let sub = '<div class="ctx-bd-subtitle">系统提示逐层明细（' + partsSrc + '，合计 ≈' + fmtK(calib(sys)) + calTag + ' / 预算 ' + fmtK(d.system.budget) + '）</div>';
      parts.forEach(function (p) {
        sub += '<div class="ctx-bd-row ctx-bd-sub"><span class="ctx-bd-name">' + p.name + (p.truncated ? '（被预算截断）' : '') + '</span><span class="ctx-bd-val">≈' + fmtK(calib(p.tokens)) + calTag + ' · ' + pct(calib(p.tokens)) + '%</span></div>';
      });
      if (!parts.length) sub += '<div class="ctx-bd-row ctx-bd-sub"><span class="ctx-bd-name">（暂无内容）</span><span class="ctx-bd-val">0</span></div>';
      const src = lb
        ? '数据来源：调用台账 llm_calls 最近一次真实请求（' + (lb.scope || 'chat') + ' · ' + String(lb.at || '').replace('T', ' ').slice(0, 19) + (lb.promptTokens ? '，上游 usage ' + fmtK(lb.promptTokens) + ' tokens' : '') + '）'
        : '数据来源：当前估算（本书暂无调用台账记录）';
      const offSrc = d.officialSource === 'channel_reported'
        ? '官方源：渠道 /models 报告 ' + fmtK(d.windowOfficial) + '（拉取于 ' + String(d.officialFetchedAt || '').replace('T', ' ').slice(0, 19) + '）'
        : d.officialSource === 'channel_not_reported'
          ? '官方源：渠道 /models 未报告上下文上限（官方缺失，不猜测）'
          : '官方源：尚未拉取（后台自动拉取中）';
      // 最近调用台账表（落库数据，重启不丢；对齐 Codex CLI 会话 token_count 事件）
      let calls = '';
      const callList = d.recentCalls || [];
      if (callList.length) {
        calls = '<div class="ctx-bd-subtitle">最近调用台账（llm_calls 落库，重启不丢）</div>' +
          '<table class="ctx-bd-table"><thead><tr><th>时间</th><th>场景</th><th>输入</th><th>输出</th><th>缓存命中</th><th>耗时</th><th>结束/状态</th></tr></thead><tbody>';
        callList.forEach(function (c) {
          calls += '<tr><td>' + String(c.at || '').replace('T', ' ').slice(5, 16) + '</td><td>' + (c.scope || '') + '</td><td>' + (c.prompt_tokens ? fmtK(c.prompt_tokens) : '—') + '</td><td>' + (c.completion_tokens ? fmtK(c.completion_tokens) : '—') + '</td><td>' + (c.cache_hit_tokens ? fmtK(c.cache_hit_tokens) : '—') + '</td><td>' + ((c.duration_ms || 0) / 1000).toFixed(1) + 's</td><td>' + (c.status === 'ok' ? (c.finish_reason || 'ok') : '✗ ' + (c.status || 'error')) + '</td></tr>';
        });
        calls += '</tbody></table>';
      }
      const calNote = cal ? ' · 校准 = 官方 usage ' + fmtK(cal.promptTokens) + ' ÷ 本地估算 ' + fmtK(cal.localTotal) + ' = ×' + cal.factor.toFixed(3) : '';
      const note = d.clamped ? '<div class="ctx-bd-note">⚠ ' + d.note + '</div>' : '';
      A.openModal({
        title: '上下文组成明细',
        okText: '关闭',
        bodyHTML: note + bar + rows + sub + calls +
          '<p class="field-hint">' + src + ' · ' + offSrc + ' · 窗口 ' + fmtK(win) + (d.windowManual ? '（你设置 ' + fmtK(d.windowManual) + '）' : '（自动跟随模型）') + calNote + '</p>',
        onOk: function () { return true; },
      });
    } catch (e) {
      A.toast(e.message);
    }
  }

  function compressContext() {
    A.openModal({
      title: '压缩上下文',
      okText: '开始压缩',
      // S4-05（G3 已知边界 9）：说清摘要是四节结构（S3-04 的 SUMMARY_SYSTEM 是唯一含义来源），
      // 作者才知道压缩后保住了什么、哪些仍只是设想。
      bodyHTML: '<p class="field-hint">将把较早的对话（保留最近 8 条）压缩成一份存档摘要，释放上下文空间。原消息不会删除，可在存档摘要处一键还原。</p>'
        + '<p class="field-hint">存档摘要分四节：【已确认的资料与设定】【已执行的动作与结果】【未决问题】【作者尚未采纳的设想】。'
        + '最后一节里的想法仍不是事实，不会被写成既定剧情。</p>',
      onOk: async function () {
        try {
          A.toast('正在压缩…');
          const data = await api('POST', '/chat/compress', { conversationId: currentConversationId(), expectedLastMessageId: lastLoadedMessageId });
          A.toast('已压缩 ' + data.archived + ' 条早期对话');
          await loadChat();
        } catch (e) {
          A.toast(e.message);
          return false;
        }
      }
    });
  }

  async function restoreContext() {
    try {
      const data = await api('POST', '/chat/compress/restore', { conversationId: currentConversationId() });
      A.toast('已还原 ' + data.restored + ' 条归档对话');
      await loadChat();
    } catch (e) {
      A.toast(e.message);
    }
  }

  // 已归档消息的折叠组
  function renderArchivedGroup(archived) {
    const box = document.createElement('details');
    box.className = 'msg-archived-group';
    const sum = document.createElement('summary');
    sum.textContent = '已压缩的 ' + archived.length + ' 条早期对话（点击展开查看）';
    box.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'archived-body';
    for (const m of archived) {
      const item = document.createElement('div');
      item.className = 'archived-item';
      const role = document.createElement('span');
      role.className = 'archived-role';
      role.textContent = m.role === 'user' ? '我' : 'AI';
      const c = document.createElement('span');
      c.textContent = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content;
      item.appendChild(role);
      item.appendChild(c);
      body.appendChild(item);
    }
    box.appendChild(body);
    return box;
  }

  // 来源标签元素（B5）：未知/空来源返回 null（老数据静默兼容）
  function makeSourceTag(source) {
    const label = SOURCE_LABELS[source] || '';
    if (!label) return null;
    const tag = document.createElement('span');
    tag.className = 'msg-source msg-source-' + source;
    tag.textContent = label;
    return tag;
  }

  // 把来源标签挂到角色行（appendMsg 与流式 live 气泡共用）
  function attachSource(roleDiv, source) {
    if (!roleDiv) return;
    const tag = makeSourceTag(source);
    if (tag) roleDiv.appendChild(tag);
  }

  function appendMsg(role, content, reasoning, retrieval, opts) {
    const wrap = document.getElementById('chat-messages');
    if (!wrap) return;

    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (opts && opts.archive) div.classList.add('msg-archive');

    const roleDiv = document.createElement('div');
    roleDiv.className = 'msg-role';
    roleDiv.textContent = role === 'user' ? '我' : (role === 'consultant' ? '参谋' : '写作助手');
    // 消息来源标注（B5；2026-09-11 作者实测反馈 ⑤）：写作台与阅读页侧栏共用同一会话，
    // 作者在写作台看到阅读页发的话会误判「这条不是我说的」。未知/空来源静默不渲染（历史消息兼容）。
    attachSource(roleDiv, opts && opts.source);

    div.appendChild(roleDiv);

    // 思考过程：默认折叠的浅色区块
    if (role !== 'user' && reasoning && reasoning.trim()) {
      const think = document.createElement('details');
      think.className = 'msg-reasoning';
      const sum = document.createElement('summary');
      sum.textContent = '思考过程';
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      body.textContent = reasoning.trim();
      think.appendChild(sum);
      think.appendChild(body);
      div.appendChild(think);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = content;

    // 语义召回的旧文参考（插在正文气泡前）
    if (role !== 'user' && retrieval && retrieval.length) {
      const rbox = renderRetrieval(retrieval);
      if (rbox) div.appendChild(rbox);
    }

    // 工具调用卡（持久化回看）：刷新后从 messages.tools 渲染，顺序在正文之前
    if (role !== 'user' && opts && Array.isArray(opts.tools) && opts.tools.length) {
      for (const t of opts.tools) div.appendChild(renderToolEvent(t));
    }

    // 主动询问协议：检测【需要确认】，高亮并渲染快捷回复
    const confirmMatch = content.match(/【需要确认】([\s\S]*?)$/);
    let quickReplies = [];
    if (role === 'assistant' && confirmMatch) {
      div.classList.add('msg-confirm');
      quickReplies = parseQuickReplies(confirmMatch[1]);
    }

    div.appendChild(bubble);

    // 长消息默认折叠，避免对话区被整段正文撑得无限下滑
    const isLong = content.length > 160;
    if (isLong) bubble.classList.add('clamped');

    if (role === 'consultant') {
      // 参谋建议：只提供展开/收起，不提供插入正文
      if (isLong) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const toggle = document.createElement('button');
        toggle.className = 'btn btn-small btn-ghost';
        toggle.textContent = '展开全文';
        toggle.onclick = function () {
          const collapsed = bubble.classList.toggle('clamped');
          toggle.textContent = collapsed ? '展开全文' : '收起';
        };
        actions.appendChild(toggle);
        div.appendChild(actions);
      }
    } else if (role === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      // 压缩存档摘要：提供一键还原，不提供插入正文
      if (opts && opts.archive) {
        const restore = document.createElement('button');
        restore.className = 'btn btn-small btn-outline';
        restore.textContent = '还原压缩前的对话';
        restore.onclick = function () {
          if (confirm('还原全部已压缩的对话？（存档摘要将被移除）')) restoreContext();
        };
        actions.appendChild(restore);
      } else {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small btn-outline';
      btn.textContent = '插入到当前章节';
      btn.onclick = function () {
        if (!S.currentChapterId) {
          A.toast('请先在左侧选择一个章节');
          return;
        }
        const c = document.getElementById('chapter-content');
        if (!c) return;
        c.value += '\n\n' + content;
        const wc = document.getElementById('word-count');
        if (wc) wc.textContent = '共 ' + c.value.replace(/\s/g, '').length + ' 字';
        A.toast('已插入，记得保存');
      };
      actions.appendChild(btn);

      if (isLong) {
        const toggle = document.createElement('button');
        toggle.className = 'btn btn-small btn-ghost';
        toggle.textContent = '展开全文';
        toggle.onclick = function () {
          const collapsed = bubble.classList.toggle('clamped');
          toggle.textContent = collapsed ? '展开全文' : '收起';
        };
        actions.appendChild(toggle);
      }
      }
      div.appendChild(actions);

      // 快捷回复按钮：按问题分组渲染（B4）；点击行为不变——填入输入框并发送
      if (quickReplies.length) {
        const qr = document.createElement('div');
        qr.className = 'quick-replies';
        for (const group of quickReplies) {
          const g = document.createElement('div');
          g.className = 'quick-group';
          // 无问题标题（旧格式兜底）时不渲染标题行，保持与改造前一致的平铺外观
          if (group.question) {
            const qt = document.createElement('div');
            qt.className = 'quick-group-title';
            qt.textContent = group.question;
            g.appendChild(qt);
          }
          const row = document.createElement('div');
          row.className = 'quick-group-opts';
          for (const label of group.options) {
            const b = document.createElement('button');
            b.className = 'btn btn-small btn-outline';
            b.textContent = label;
            b.onclick = function () {
              const input = document.getElementById('chat-text');
              if (input) { input.value = label; sendChat(); }
            };
            row.appendChild(b);
          }
          g.appendChild(row);
          qr.appendChild(g);
        }
        div.appendChild(qr);
      }
    } else if (isLong) {
      // 用户消息过长时也提供展开/收起
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-small btn-ghost';
      toggle.textContent = '展开全文';
      toggle.onclick = function () {
        const collapsed = bubble.classList.toggle('clamped');
        toggle.textContent = collapsed ? '展开全文' : '收起';
      };
      actions.appendChild(toggle);
      div.appendChild(actions);
    }

    // S4-04b：交接消息（服务端模板生成）——提供来源回跳与逐字来源引用
    const handoffInfo = parseHandoffSource(content);
    if (handoffInfo) {
      div.classList.add('msg-handoff');
      if (handoffInfo.originConversationId) renderHandoffSource(div, handoffInfo);
    }

    wrap.appendChild(div);
    scrollBottom();
    return div;
  }

  async function sendChat() {
    const input = document.getElementById('chat-text');
    const btn = document.getElementById('btn-send');
    if (!input || !btn) return;

    const content = input.value.trim();
    if (!content) return;

    btn.disabled = true;
    input.value = '';

    // 参谋模式走 /consult（非流式，建议类回复）
    if (S.consultMode) {
      btn.textContent = '参谋思考中…';
      appendMsg('user', content, null, null, { source: 'writing' });
      const wrap0 = document.getElementById('chat-messages');
      const typing0 = document.createElement('div');
      typing0.className = 'typing';
      typing0.textContent = '参谋正在分析…';
      wrap0.appendChild(typing0);
      scrollBottom();
      try {
        const data = await api('POST', '/consult', { question: content, chapterId: S.currentChapterId });
        typing0.remove();
        appendMsg('consultant', data.reply || '', data.reasoning || '', data.retrieval || [], { source: 'writing' });
      } catch (e) {
        typing0.remove();
        A.toast(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '发送';
      }
      return;
    }

    btn.textContent = '思考中…';
    appendMsg('user', content, null, null, { source: 'writing' });
    try { await runChatStream({ content: content, chapterId: S.currentChapterId, source: 'writing' }); }
    finally {
      btn.disabled = false;
      btn.textContent = '发送';
    }
  }

  // 单飞闸门 + 排队（对齐 pi：Agent 在 activeRun 期间拒绝新 prompt，调用方改走 steer/followUp 队列）。
  // 2026-09-11 实测的「乱」：此前没有任何并发保护——确认卡续跑与手输消息可同时发出，
  // 两条流并行各跑一遍工具循环，回复交叉上屏（连续两条 AI 消息）、同一写动作被重复提交成
  // 多张一模一样的确认卡。现在：流进行中收到的新请求一律排队，前一条结束后按序发出。
  let chatBusy = false;
  const chatQueue = [];
  // 当前流的停止句柄（对齐 pi「run 级单 AbortController」）：生成中显示「停止生成」按钮
  let chatAbort = null;

  function updateStopBtn() {
    const b = document.getElementById('btn-chat-stop');
    if (b) b.classList.toggle('hidden', !chatAbort);
  }

  async function runChatStream(body) {
    // W9（排队切书修复）：请求在入队时绑定书籍 id，执行时校验——排队期间切了书，
    // 该消息属于旧书的会话，绝不发到新书的 /chat/stream 里。
    return enqueueChat({ body: body, bookId: (S.currentBook && S.currentBook.id) || null, conversationId: currentConversationId() });
  }

  async function enqueueChat(item) {
    if (chatBusy) {
      chatQueue.push(item);
      A.toast('上一条回复还在进行中，已排队，稍后自动发出');
      return;
    }
    chatBusy = true;
    try {
      await streamChatOnce(item, 0);
    } finally {
      chatBusy = false;
      const next = chatQueue.shift();
      // 队列项直接执行：bookId 沿用入队时的绑定，不重读当前书（W9）
      if (next) enqueueChat(next);
    }
  }

  // 流式对话消费（sendChat 与确认续跑共用，方向报告 1.4）：实时气泡 → SSE → 落正式消息。
  // SSE 解析/事件折叠/中止管理统一走 ChatEventHub（对齐 pi：瞬态事件折叠为一份 transcript 状态），
  // 本函数只负责页面渲染、409 排队重试与收尾迁移。
  async function streamChatOnce(item, busyRetry) {
    const body = item.body;
    // W9：执行时校验归属——入队时绑定的书与当前书不一致则丢弃该项并 console 提示
    // S3-03：同款守卫扩到会话维度——排队期间切了会话，旧消息不发到新会话
    if (item.conversationId != null && item.conversationId !== currentConversationId()) {
      console.warn('[book-chat] 丢弃排队消息：入队于另一写作会话，当前会话已切换', body);
      A.toast('有一条排队消息属于另一个写作会话，已丢弃（未发送）');
      return;
    }
    if (item.bookId != null && (!S.currentBook || S.currentBook.id !== item.bookId)) {
      console.warn('[book-chat] 丢弃排队消息：入队于书籍 #' + item.bookId +
        '，当前书籍 #' + (S.currentBook && S.currentBook.id) + '，不发到新书的会话', body);
      A.toast('有一条排队消息属于另一本书，已丢弃（未发送）');
      return;
    }
    // 流式：实时渲染思考过程和正文
    const wrap = document.getElementById('chat-messages');
    const live = document.createElement('div');
    live.className = 'msg assistant';
    live.innerHTML = '<div class="msg-role">写作助手</div>' +
      '<details class="msg-reasoning live-reasoning hidden" open><summary>思考过程</summary><div class="reasoning-body"></div></details>' +
      '<div class="msg-phase hidden"></div>' +
      '<div class="msg-bubble"></div>';
    // B5：实时气泡同样标注来源（确认续跑等无 source 的调用静默不标）
    attachSource(live.querySelector('.msg-role'), body && body.source);
    wrap.appendChild(live);
    const liveReasoning = live.querySelector('.live-reasoning');
    const liveReasoningBody = live.querySelector('.reasoning-body');
    const livePhase = live.querySelector('.msg-phase');
    const liveBubble = live.querySelector('.msg-bubble');
    scrollBottom();

    // ---- 静默期可见（2026-09-13 「写一篇文章卡死」诊断）----
    // 后续轮是非流式的：首轮正文流完之后，后端最多还有 3 轮 LLM 调用不产生任何事件
    //（书#18 实测 30~60 秒）。此前界面对这段时间零反馈，作者判定为死机。
    // 现在每轮/每个工具前推一条 phase 事件，这里显示阶段名 + 秒表（秒表自走，不靠服务端续推）。
    let phaseTimer = null;
    function setPhase(text) {
      if (!text) {
        if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
        livePhase.classList.add('hidden');
        livePhase.textContent = '';
        return;
      }
      const t0 = Date.now();
      const paint = () => {
        // 气泡被移除（收尾/中止/重试）后自清，无需在每条退出路径上手动收尾
        if (!livePhase.isConnected) { clearInterval(phaseTimer); phaseTimer = null; return; }
        livePhase.textContent = text + '（已等待 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）';
      };
      if (phaseTimer) clearInterval(phaseTimer);
      livePhase.classList.remove('hidden');
      paint();
      phaseTimer = setInterval(paint, 1000);
    }

    // ---- 增量渲染：文本按**时间**合并落盘 + 滚动按时间节流（2026-09-14 二轮诊断，卡死真因）----
    // 实测（真实书#18 会话：容器 273,839 字 / 76 条消息）：
    //   · 容器内容只要有改动，浏览器就要为**整段历史**重算可滚动范围：一次约 **14ms**（微基准：
    //     把历史消息摘掉或让它们跳过布局后降到 2ms，只追加不读 0ms）；
    //   · 所以卡死的不是「思考文字写多长」，而是**每帧都在改这个容器**。按帧落盘 ≈ 100~200 次
    //     布局/秒 ⇒ 主线程被吃掉 1.4~2.8 秒/秒；思考比正文吐得快，于是「一开思考就卡死」。
    //   · 12 秒合成流实测：47 次 long task / 3,300ms / 最长 98ms（rAF p99 82.7ms）。
    // 故文本**按时间**（不是按帧——本环境 rAF 不锁帧，能到 200 次/秒）合并后**追加**
    //（insertAdjacentText 不重写整块 → 字符串不做 O(n) 复制、脏区域更小），滚动再节流到 200ms 一次。
    // 收尾/中止前必须 flush（commitLive 与读取 liveBubble.textContent 前都会调）。
    const FLUSH_INTERVAL_MS = 120;
    const SCROLL_THROTTLE_MS = 200;
    let pendingText = '', pendingReasoning = '', flushTimer = null, lastScrollAt = 0;
    function scrollThrottled() {
      const now = performance.now();
      if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
      lastScrollAt = now;
      scrollBottom();
    }
    function flushLive() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingText) { liveBubble.insertAdjacentText('beforeend', pendingText); pendingText = ''; }
      if (pendingReasoning) { liveReasoningBody.insertAdjacentText('beforeend', pendingReasoning); pendingReasoning = ''; }
      scrollThrottled();
    }
    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; flushLive(); }, FLUSH_INTERVAL_MS);
    }

    const runAbort = ChatEventHub.createAbort();
    chatAbort = runAbort;
    updateStopBtn();
    let finalRetrieval = [];
    const blocks = []; // 工具块/确认卡：流结束后迁移到正式消息里

    // 收尾迁移：live div → 正式消息（正常完结 / 用户停止后的部分输出共用一条路，
    // 对齐 pi「中止与完结走同一渲染路径」）
    function commitLive(finalContent, finalReasoning, note) {
      flushLive(); // 缓冲区里最后几帧的增量必须在换节点前落盘，否则丢字
      live.remove();
      const content = note
        ? (finalContent ? finalContent + '\n\n（' + note + '）' : '（' + note + '）')
        : finalContent;
      if (content) {
        const msgDiv = appendMsg('assistant', content, finalReasoning, finalRetrieval, { source: body && body.source });
        // 工具块/确认卡迁移到正式消息（保持出现顺序，位于正文气泡之前）
        if (msgDiv && blocks.length) {
          const bubble = msgDiv.querySelector('.msg-bubble');
          for (const b of blocks) msgDiv.insertBefore(b, bubble);
          scrollBottom();
        }
      } else if (blocks.length) {
        // 极端情况：只有工具调用/确认卡，没有正文
        const msgDiv2 = appendMsg('assistant', '（已发起操作，请查看上方确认卡）', '', finalRetrieval, { source: body && body.source });
        if (msgDiv2) {
          const bubble2 = msgDiv2.querySelector('.msg-bubble');
          for (const b of blocks) msgDiv2.insertBefore(b, bubble2);
          scrollBottom();
        }
      } else {
        A.toast(note || '未收到回复内容');
      }
      // 收尾后补一次滚动：live 气泡换成正式消息后容器高度变了，且流内滚动是被节流的
      scrollBottom();
      lastScrollAt = performance.now();
    }

    try {
      // S2-01：每次提交生成 requestId——网络重试/双击复用同一个（服务端幂等返回既有运行，
      // 不重跑模型）；作者明确发新消息时 runChatStream 每次新造 body，天然是新 requestId。
      if (!body.request_id) body.request_id = ChatEventHub.newRequestId('write');
      // S3-03：会话随请求下发（服务端解析校验；入队守卫已确保与当前会话一致）
      if (!body.conversationId) body.conversationId = item.conversationId || undefined;
      const res = await fetch('/api/books/' + S.currentBook.id + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: runAbort.signal,
      });
      // 服务端单飞闸门：另一条流（另一标签页/刷新前的流）仍在跑 → 等一会儿重试，而不是丢掉消息。
      // 必须区分 409 的两种性质：CHAT_BUSY 是暂时的（重试有意义），而「已续跑过」「动作未结算」
      // 是永久性的（重试 8 次只会白等 16 秒），后者直接报错退出。
      if (res.status === 409) {
        let payload = null;
        try { payload = await res.json(); } catch (e) { /* 非 JSON 响应按通用错误处理 */ }
        const isBusy = payload && payload.error && payload.error.code === 'CHAT_BUSY';
        if (isBusy && busyRetry < 8) {
          live.remove();
          if (runAbort.stopped()) { A.toast('已停止生成'); return; } // 等待重试期间用户按了停止
          A.toast('上一条回复还在进行中，稍候自动重试…');
          await new Promise(r => setTimeout(r, 2000));
          return streamChatOnce(item, busyRetry + 1);
        }
        const msg = (payload && payload.error && (payload.error.message || payload.error)) || '请求被拒绝';
        throw new Error(typeof msg === 'string' ? msg : '请求被拒绝');
      }
      // S2-01：重复请求（同 requestId）返回 JSON 而非 SSE——不解析成流、不重发业务请求，
      // 等原运行结束后从服务端刷新会话（messages 是正典存储，另一窗口的结果就在那里）。
      if (ChatEventHub.isJsonResponse(res)) {
        let dup = null;
        try { dup = await res.json(); } catch (e) { /* 落入通用错误 */ }
        if (dup && dup.duplicate) {
          setPhase(dup.status === 'finished' ? '该请求已在另一窗口完成，正在同步…' : '该请求正在另一窗口进行，等待其结果…');
          let finalStatus = dup.status;
          if (ChatEventHub.isActiveStatus(dup.status)) {
            try {
              const fin = await ChatEventHub.waitRunEvents({
                runId: dup.runId,
                sessionKey: dup.sessionKey,
                signal: runAbort.signal,
                onEvent: (ev) => {
                  if (ev.type === 'phase' && ev.payload && ev.payload.kind) {
                    setPhase('另一窗口：' + (ev.payload.name || ev.payload.kind) + '…');
                  } else if (ev.type === 'error') {
                    setPhase('另一窗口发生错误，等待收尾…');
                  }
                },
              });
              finalStatus = fin.status;
            } catch (e) {
              if (ChatEventHub.isAbortError(e)) { setPhase(''); live.remove(); A.toast('已停止等待'); return; }
              finalStatus = 'unknown';
            }
          }
          setPhase('');
          live.remove();
          A.toast('该请求已在另一窗口' + (finalStatus === 'finished' ? '完成' : '结束') + '，已同步最新会话');
          await loadChat();
          return;
        }
        // 非重复 JSON（如 503 RUN_PERSIST_FAILED / 400 参数错）按通用错误处理
        throw await ChatEventHub.parseResponseError(res, '请求失败 ' + res.status);
      }
      if (!res.ok || !res.body) throw new Error('流式请求失败');

      const state = await ChatEventHub.consumeBookStream(res, {
        onDelta: (t) => {
          if (t) { setPhase(''); pendingText += t; scheduleFlush(); }
        },
        onReasoning: (t) => {
          liveReasoning.classList.remove('hidden');
          pendingReasoning += t;
          scheduleFlush();
        },
        onRetrieval: (hits) => {
          finalRetrieval = hits;
          const rbox = renderRetrieval(hits);
          if (rbox) live.insertBefore(rbox, liveBubble);
        },
        onTool: (t) => {
          const tb = renderToolEvent(t);
          blocks.push(tb);
          live.insertBefore(tb, liveBubble);
        },
        onAction: (a) => {
          const ac = renderActionCard(a);
          blocks.push(ac);
          live.insertBefore(ac, liveBubble);
        },
        onRecovering: () => A.toast('输出被截断或连接中断，正在无缝续写…'),
        onAutoCompact: (n) => A.toast('上下文接近窗口上限，已自动压缩 ' + n + ' 条早期对话'),
        onDone: (ev) => { if (ev && ev.usage) refreshCtxMeter(ev.usage); },
        onEvent: (ev) => {
          if (ev && ev.type === 'phase') {
            setPhase(ev.kind === 'tool'
              ? '正在调用工具：' + (TOOL_LABELS[ev.name] || ev.name) + '…'
              : '正在继续处理（第 ' + (ev.round || 1) + '/' + (ev.total || 1) + ' 轮）…');
          }
          // 每个事件都来过一遍，但真正读 scrollHeight 只在节流窗口内发生（见 flushLive 上方注释）
          scrollThrottled();
          scheduleFlush();
        },
      });

      if (state.errors.length) {
        // 流内错误：保持既有语义——只提示，不落半截消息
        live.remove();
        A.toast(state.errors[state.errors.length - 1].message);
      } else {
        const finalContent = typeof state.finalContent === 'string' ? state.finalContent : state.content;
        const runLabel = state.run && ({ awaiting_confirmation: '等待作者确认', paused: '任务已暂停，尚未完成', cancelled: '已停止生成' })[state.run.status];
        commitLive(finalContent, state.reasoning, state.aborted ? '已停止生成' : runLabel || null);
      }
      // S4-05：本轮收尾后把服务端运行状态与工具细节搬进任务卡（不靠气泡话术），
      // 活跃运行由低频补齐接管，终态即停。
      await refreshRunStatus({
        run: state.aborted ? { status: 'cancelled', reason: 'user_abort' } : (state.run || lastRunSnapshot),
        tools: state.tools || [],
        toolErrors: [],
      });
      syncRunWatcher();
      // 自动压缩发生过：重新拉取消息列表，渲染归档折叠组
      if (state.autoCompact) loadChat();
    } catch (e) {
      if (runAbort.stopped()) {
        // 用户按了「停止生成」且尚未进入流读取：已流出的部分内容保留为正式消息
        flushLive();
        const partial = liveBubble.textContent;
        if (partial) commitLive(partial, liveReasoningBody.textContent, '已停止生成');
        else { live.remove(); A.toast('已停止生成'); }
      } else {
        live.remove();
        A.toast(e.message);
      }
    } finally {
      if (chatAbort === runAbort) { chatAbort = null; updateStopBtn(); }
    }
  }

  // 确认卡结算后自动续跑：把执行结果作为系统事件回灌对话（对齐独立 Agent 的 resume 机制）
  // 沉淀提示（方向报告 4.2）：压缩记忆留不住剧情决定——长期决定应进结构化持久记忆
  // （故事线/设定），提示跟着系统事件气泡走，不额外弹窗打扰
  async function resumeAfterConfirm(actionId) {
    if (!S.currentBook) return;
    appendMsg('user', '[确认执行结果·系统事件] 已把执行结果交给 AI，继续之前的任务…（若这是长期剧情决定，建议到「故事台账 → 故事线」沉淀，对话压缩后它仍可被检索）', null, null, { source: 'writing' });
    try { await runChatStream({ resumeActionId: actionId, chapterId: S.currentChapterId, source: 'writing' }); }
    catch (e) { /* runChatStream 内部已 toast */ }
  }

  // ---------- B3 过期操作横幅 ----------
  // 2026-09-11 作者实测反馈 ②：操作等待确认超时过期后，作者不知道（横幅缺位），
  // 模型也不知道（后端补过期系统事件）。横幅只消费 GET /chat 的 expiredActions，
  // 关闭仅隐藏本条（不写后端）；重新打开会话时若后端仍返回则再次显示。
  function parseLocalTs(s) {
    // SQLite datetime('now','localtime') → "YYYY-MM-DD HH:MM:SS"（本地时区，按本地解析不外推 UTC）
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  function fmtTs(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function argsSummary(args, max) {
    let s;
    try { s = JSON.stringify(args == null ? {} : args); } catch (e) { s = ''; }
    s = String(s || '');
    const limit = max || 240;
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }

  function toolLabel(name) {
    return TOOL_LABELS[name] || name || '未知操作';
  }

  // 横幅宿主：挂在聊天输入区（#chat-form）正上方，与 #chat-messages 平级——
  // 放在消息容器内会被 loadChat 的 innerHTML='' 清掉，也无法保证出现在输入区上方。
  function bannerHost() {
    const form = document.getElementById('chat-form');
    if (!form || !form.parentNode) return null;
    let host = document.getElementById('chat-banners');
    if (!host) {
      host = document.createElement('div');
      host.id = 'chat-banners';
      host.className = 'chat-banners';
      form.parentNode.insertBefore(host, form);
    }
    return host;
  }

  // 本条横幅的关闭记忆：键=书 id + 过期动作 id 集合。同一批过期操作在本页会话内被关闭后
  // 不再重复弹出（loadChat 会被每轮消息触发多次）；换书或出现新的过期批次则重新显示，
  // 刷新页面（JS 状态清零）后后端仍返回则再次显示——符合「关闭仅隐藏本条」。
  let expiredDismissedKey = '';

  // overflow（契约降级：字段缺失/非正数 → 不显示附加文案，绝不报错）：
  // 后端 GET /chat 只回最近 5 条 expiredActions，「另有 N 个未列出」由 expiredActionsOverflow 给出——
  // 否则作者会以为过期卡总共只有列出的这几张。
  function renderExpiredBanner(expired, overflow) {
    const host = bannerHost();
    if (!host) return;
    const old = host.querySelector('.expired-banner');
    if (old) old.remove();
    const items = Array.isArray(expired) ? expired.filter(Boolean) : [];
    if (!items.length) return; // 字段缺失/为空：不渲染横幅（契约降级）
    const overflowNum = Number(overflow);
    const overflowN = isFinite(overflowNum) && overflowNum > 0 ? Math.floor(overflowNum) : 0;
    const batchKey = ((S.currentBook && S.currentBook.id) || '') + '|' +
      items.map(function (a) { return a.id || ''; }).sort().join(',');
    if (batchKey === expiredDismissedKey) return;

    const bar = document.createElement('div');
    bar.className = 'expired-banner';
    bar.setAttribute('role', 'status');

    const head = document.createElement('span');
    head.className = 'expired-text';
    head.textContent = '有 ' + items.length + ' 个操作等待确认超时、从未执行：' +
      (overflowN ? '（另有 ' + overflowN + ' 个未列出）' : '');
    bar.appendChild(head);

    // 按工具名归组：同名操作共用一个可点击的名称，展开该组的参数摘要
    const byName = {};
    const order = [];
    items.forEach(function (a) {
      const name = a.name || '';
      if (!byName[name]) { byName[name] = []; order.push(name); }
      byName[name].push(a);
    });
    order.forEach(function (name) {
      const list = byName[name] || [];
      const box = document.createElement('span');
      box.className = 'expired-tool-group';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'expired-tool';
      btn.textContent = toolLabel(name) + (list.length > 1 ? ' ×' + list.length : '');
      const detail = document.createElement('div');
      detail.className = 'expired-detail hidden';
      list.forEach(function (a) {
        const row = document.createElement('div');
        row.className = 'expired-detail-row';
        row.textContent = toolLabel(a.name) + ' · ' + argsSummary(a.args) +
          (a.expiredAt ? '（过期于 ' + fmtTs(a.expiredAt) + '）' : '');
        detail.appendChild(row);
      });
      btn.onclick = function () { detail.classList.toggle('hidden'); };
      box.appendChild(btn);
      box.appendChild(detail);
      bar.appendChild(box);
    });

    const tail = document.createElement('span');
    tail.className = 'expired-text';
    tail.textContent = '（AI 已被告知，不要当成已完成）';
    bar.appendChild(tail);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'expired-close';
    close.title = '关闭提示（仅隐藏本条，不改变操作状态）';
    close.textContent = '×';
    close.onclick = function () {
      expiredDismissedKey = batchKey; // 只隐藏本条（不写后端）
      bar.remove();
    };
    bar.appendChild(close);

    host.appendChild(bar);
  }

  // ---------- B2 已结算卡回放 ----------
  // 2026-09-11 作者实测反馈 ③：已结算的确认卡刷新后从界面消失（卡只在当轮 DOM 里）。
  // 后端把结算行保留 30 天并在 GET /chat/actions 返回全状态，前端据此把非 pending 卡
  // 尽量插回原位：优先匹配「确认执行结果·系统事件」信封消息，其次按 settledAt 与消息
  // created_at 就近配对，都匹配不到则按时间顺序追加到对话末尾。每张卡只渲染一次（消费式匹配）。
  const ENVELOPE_MARK = '[确认执行结果·系统事件]';
  const NEAREST_WINDOW_MS = 30 * 60 * 1000; // 就近配对的容忍窗口，与动作 TTL 同尺度

  function matchEnvelope(entries, action) {
    const argsPrefix = JSON.stringify(action.args || {}).slice(0, 120);
    const marked = '此前你请求执行的写工具 ' + action.name;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.used) continue;
      const c = String(e.msg.content || '');
      if (c.indexOf(ENVELOPE_MARK) < 0 || c.indexOf(marked) < 0) continue;
      // args 前缀匹配：后端信封里参数被截到 400 字符，前缀一致即认定同一动作
      if (argsPrefix && c.indexOf(argsPrefix) < 0) continue;
      e.used = true;
      return e;
    }
    return null;
  }

  function matchNearest(entries, action) {
    const at = Number(action.settledAt || action.createdAt || 0) || 0;
    if (!at) return null;
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.used) continue;
      const ts = parseLocalTs(e.msg.created_at);
      if (!isFinite(ts)) continue;
      const gap = Math.abs(ts - at);
      if (gap < bestGap) { bestGap = gap; best = e; }
    }
    if (!best || bestGap > NEAREST_WINDOW_MS) return null;
    best.used = true;
    return best;
  }

  // 卡片插到锚点消息之后；锚点已从 DOM 摘除则退化为追加到末尾（返回 false）
  function insertAfter(node, anchorNode) {
    if (!anchorNode || !anchorNode.parentNode) return false;
    anchorNode.parentNode.insertBefore(node, anchorNode.nextSibling);
    return true;
  }

  async function loadChat() {
    const wrap = document.getElementById('chat-messages');
    if (!wrap) return;
    try {
      const data = await api('GET', '/chat' + conversationQuery());
      if (data.conversationId && data.conversationId !== currentConversationId()) {
        rememberConversation(data.conversationId);
      }
      wrap.innerHTML = '';
      const msgs = data.messages || [];
      lastLoadedMessageId = msgs.length ? msgs[msgs.length - 1].id : null;
      const archived = msgs.filter(function (m) { return m.compressed === 1; });
      const flow = msgs.filter(function (m) { return m.compressed !== 1; });
      let archivedRendered = false;
      const entries = []; // {msg, node, used}：非 pending 卡回放时的锚点索引（消费式）
      flow.forEach(function (m) {
        // 归档组插在第一条压缩存档摘要之前（无存档摘要则插在最前）
        if (!archivedRendered && archived.length && (m.compressed === 2 || m === flow[0])) {
          wrap.appendChild(renderArchivedGroup(archived));
          archivedRendered = true;
        }
        // B5：历史消息带来源标签（字段缺失→空串→不渲染，兼容老库/后端未落地）
        const node = appendMsg(m.role, m.content, m.reasoning || '', null,
          m.compressed === 2 ? { archive: true, source: m.source } : { tools: m.tools, source: m.source });
        if (node) entries.push({ msg: m, node: node, used: false });
      });
      if (!archivedRendered && archived.length) wrap.appendChild(renderArchivedGroup(archived));

      // B3：过期横幅（GET /chat 的 expiredActions；字段缺失则整段降级为不渲染）
      // expiredActionsOverflow（>0 时=未列出的过期卡数）：只影响标题行附加文案，其余逻辑不变
      renderExpiredBanner(data.expiredActions, data.expiredActionsOverflow);

      // 重建确认卡（2026-09-10 实测 + B1/B2 扩展；2026-09-24 起已结算动作不再回放成卡）：
      //   pending    → 可操作的卡（同参去重，保留最新一张）追加到对话末尾
      //   非 pending → 收编为紧凑留痕行，挂到来源消息正文下方（信封匹配 → 就近配对）；
      //               锚点不在（消息已删/已压缩/清空会话）则不渲染，不再末尾堆砌
      try {
        const act = await api('GET', '/chat/actions');
        const list = (act.actions || []).slice().sort(function (a, b) {
          return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
        });
        const seen = {}; // pending 同参去重：同工具同参数只渲染最新一张
        list.forEach(function (a) {
          const status = normalizeActionStatus(a.status);
          // 只有 pending 是可操作卡；executing/approved/... 已结算的一律留痕行（B1 契约仍成立）
          if (status === 'pending') {
            const key = a.name + '|' + JSON.stringify(a.args || {});
            if (seen[key]) seen[key].card.remove(); // 已有同参卡：用较新的一张替换（列表已按 createdAt 升序）
            const card = renderActionCard(a);
            card.dataset.actionKey = key;
            seen[key] = { card: card, createdAt: Number(a.createdAt) || 0 };
            wrap.appendChild(card);
            return;
          }
          const hit = matchEnvelope(entries, a) || matchNearest(entries, a);
          if (hit) hit.node.appendChild(renderActionLog(a));
        });
      } catch (e) { /* 动作列表拉取失败不影响会话渲染 */ }
      // S4-05：刷新/切书/切会话后按服务端 run 快照重建任务卡（message.run 是正典，不由气泡猜）。
      // 本页的待确认卡仍由上面的 /chat/actions 渲染在对话区；该接口不返回会话归属，
      // 因此不在这里把它们冒充成「本会话待确认」（会话归属不猜）。
      await refreshRunStatus({ messages: msgs });
      BookPage.setStatusPollingVisible(pageVisible());
      // S4-02：首屏也要能看到「当前写作会话」——此前会话切换器只在切换/新建后才渲染，
      // 进写作页时它是空的（状态条与切换器都读它）。
      await renderConversationBar();
      refreshCtxMeter(null);
    } catch (e) {
      A.toast(e.message);
    }
  }

  async function loadWorld() {
    const list = document.getElementById('world-list');
    if (!list) return;
    try {
      const data = await api('GET', '/world');
      list.innerHTML = '';
      (data.entries || []).forEach(function (entry) {
        const li = document.createElement('li');
        li.className = 'item-row';

        const left = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'item-name';
        name.textContent = entry.title;
        const sub = document.createElement('span');
        sub.className = 'item-sub';
        sub.textContent = (entry.content || '').slice(0, 30);
        left.appendChild(name);
        left.appendChild(sub);

        const ops = document.createElement('span');
        ops.className = 'item-ops';

        const edit = document.createElement('button');
        edit.className = 'icon-btn edit-we';
        edit.textContent = '✎';
        edit.onclick = function () { worldModal(entry); };

        const del = document.createElement('button');
        del.className = 'icon-btn del-we';
        del.textContent = '×';
        del.onclick = function () {
          if (confirm('确定删除该世界观条目？')) {
            api('DELETE', '/world/' + entry.id)
              .then(loadWorld)
              .catch(function (e) { A.toast(e.message); });
          }
        };

        ops.appendChild(edit);
        ops.appendChild(del);
        li.appendChild(left);
        li.appendChild(ops);
        list.appendChild(li);
      });
    } catch (e) {
      A.toast(e.message);
    }
  }

  function worldModal(entry) {
    entry = entry || {};
    const bodyHTML =
      '<label class="field"><span>标题</span><input id="we-title" value="' + A.escapeHtml(entry.title || '') + '"></label>' +
      '<label class="field"><span>内容</span><textarea id="we-content" rows="6">' + A.escapeHtml(entry.content || '') + '</textarea></label>';

    A.openModal({
      title: entry.id ? '编辑世界观条目' : '新建世界观条目',
      bodyHTML: bodyHTML,
      onOk: async function () {
        const title = document.getElementById('we-title').value.trim();
        const content = document.getElementById('we-content').value.trim();
        if (!title) {
          A.toast('请填写标题');
          return false;
        }
        try {
          if (entry.id) {
            await api('PUT', '/world/' + entry.id, { title: title, content: content });
          } else {
            await api('POST', '/world', { title: title, content: content });
          }
          await loadWorld();
        } catch (e) {
          A.toast(e.message);
          return false;
        }
      }
    });
  }

  async function loadCharacters() {
    const list = document.getElementById('character-list');
    if (!list) return;
    try {
      const data = await api('GET', '/characters');
      list.innerHTML = '';
      (data.characters || []).forEach(function (ch) {
        const li = document.createElement('li');
        li.className = 'item-row';

        const left = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'item-name';
        name.textContent = ch.name;
        const sub = document.createElement('span');
        sub.className = 'item-sub';
        sub.textContent = ch.role || '';
        left.appendChild(name);
        left.appendChild(sub);

        const ops = document.createElement('span');
        ops.className = 'item-ops';

        const edit = document.createElement('button');
        edit.className = 'icon-btn edit-char';
        edit.textContent = '✎';
        edit.onclick = function () { charModal(ch); };

        const del = document.createElement('button');
        del.className = 'icon-btn del-char';
        del.textContent = '×';
        del.onclick = function () {
          if (confirm('确定删除该人物卡片？')) {
            api('DELETE', '/characters/' + ch.id)
              .then(loadCharacters)
              .catch(function (e) { A.toast(e.message); });
          }
        };

        ops.appendChild(edit);
        ops.appendChild(del);
        li.appendChild(left);
        li.appendChild(ops);
        list.appendChild(li);
      });
    } catch (e) {
      A.toast(e.message);
    }
  }

  function charModal(c) {
    c = c || {};
    const fields = [
      ['ch-name', '姓名', 'input', c.name || ''],
      ['ch-role', '定位', 'input', c.role || ''],
      ['ch-appearance', '外貌', 'textarea', c.appearance || ''],
      ['ch-personality', '性格', 'textarea', c.personality || ''],
      ['ch-background', '背景', 'textarea', c.background || ''],
      ['ch-note', '备注', 'textarea', c.note || '']
    ];

    let bodyHTML = '';
    fields.forEach(function (f) {
      const id = f[0];
      const label = f[1];
      const tag = f[2];
      const val = f[3];
      bodyHTML += '<label class="field"><span>' + label + '</span>';
      if (tag === 'input') {
        bodyHTML += '<input id="' + id + '" value="' + A.escapeHtml(val) + '">';
      } else {
        bodyHTML += '<textarea id="' + id + '" rows="2">' + A.escapeHtml(val) + '</textarea>';
      }
      bodyHTML += '</label>';
    });

    A.openModal({
      title: c.id ? '编辑人物卡片' : '新建人物卡片',
      bodyHTML: bodyHTML,
      onOk: async function () {
        const name = document.getElementById('ch-name').value.trim();
        if (!name) {
          A.toast('请填写姓名');
          return false;
        }
        const body = {
          name: name,
          role: document.getElementById('ch-role').value.trim(),
          appearance: document.getElementById('ch-appearance').value.trim(),
          personality: document.getElementById('ch-personality').value.trim(),
          background: document.getElementById('ch-background').value.trim(),
          note: document.getElementById('ch-note').value.trim()
        };
        try {
          if (c.id) {
            await api('PUT', '/characters/' + c.id, body);
          } else {
            await api('POST', '/characters', body);
          }
          await loadCharacters();
        } catch (e) {
          A.toast(e.message);
          return false;
        }
      }
    });
  }

  // 更新模式按钮显示
  function refreshModeBtn() {
    const b = document.getElementById('btn-mode');
    if (!b || !S.currentBook) return;
    const collab = S.currentBook.mode !== 'direct';
    b.textContent = collab ? '协作模式' : '直接写模式';
    b.classList.toggle('mode-on', collab);
  }

  function bindChatEvents() {
    // 参谋模式切换（胶囊在输入区合成器底行左侧，见 index.html #chat-form）
    const PLACEHOLDER_WRITE = '和 AI 聊聊剧情，或让它续写正文…（Ctrl+Enter 发送）';
    const PLACEHOLDER_CONSULT = '向参谋提问：剧情走向、人物行为、大纲建议…';
    S.consultMode = false;
    const consultBtn = document.getElementById('btn-consult');
    const chatForm = document.getElementById('chat-form');
    const consultInput = document.getElementById('chat-text');
    if (consultBtn) {
      // 进书时视觉态与 S.consultMode 同步重置：否则切书后按钮/placeholder 残留参谋态
      consultBtn.classList.remove('mode-on');
      if (chatForm) chatForm.classList.remove('consult-on');
      if (consultInput) consultInput.placeholder = PLACEHOLDER_WRITE;
      consultBtn.onclick = function () {
        S.consultMode = !S.consultMode;
        consultBtn.classList.toggle('mode-on', S.consultMode);
        if (chatForm) chatForm.classList.toggle('consult-on', S.consultMode);
        if (consultInput) consultInput.placeholder = S.consultMode ? PLACEHOLDER_CONSULT : PLACEHOLDER_WRITE;
        A.toast(S.consultMode ? '参谋模式：只出建议不写正文' : '写作模式');
      };
    }
    // 写作模式切换
    const modeBtn = document.getElementById('btn-mode');
    if (modeBtn) {
      refreshModeBtn();
      modeBtn.onclick = async function () {
        const next = S.currentBook.mode === 'direct' ? 'collab' : 'direct';
        try {
          await A.api('PUT', '/api/books/' + S.currentBook.id, { mode: next });
          S.currentBook.mode = next;
          refreshModeBtn();
          A.toast(next === 'collab' ? '协作模式：AI 拿不准会主动问你' : '直接写模式：AI 直接成文');
        } catch (e) { A.toast(e.message); }
      };
    }
    const form = document.getElementById('chat-form');
    if (form && !form.dataset.chatBound) {
      form.dataset.chatBound = '1';
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        sendChat();
      });
    }

    // 停止生成（对齐 pi ESC 中止：run 级 AbortController.abort()，部分输出保留）
    const stopBtn = document.getElementById('btn-chat-stop');
    if (stopBtn) stopBtn.onclick = function () { if (chatAbort) chatAbort.stop('user'); };

    const text = document.getElementById('chat-text');
    if (text && !text.dataset.chatBound) {
      text.dataset.chatBound = '1';
      text.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          sendChat();
        }
      });
    }

    const clear = document.getElementById('btn-clear-chat');
    if (clear) {
      clear.onclick = function () {
        if (confirm('清空当前会话的对话记录？（同书其他写作会话不受影响）')) {
          api('DELETE', '/chat' + conversationQuery())
            .then(loadChat)
            .catch(function (e) { A.toast(e.message); });
        }
      };
    }

    const compressBtn = document.getElementById('btn-compress');
    if (compressBtn) compressBtn.onclick = function () { compressContext(); };

    const convSel = document.getElementById('writing-conversation-select');
    if (convSel) convSel.addEventListener('change', function () { switchConversation(convSel.value); });
    const newConvBtn = document.getElementById('btn-new-writing-conv');
    if (newConvBtn) newConvBtn.onclick = function () { newWritingConversation(); };

    // S4-02：另开整体讨论（携带书籍与选定对象，默认不带写作历史）
    const discussBtn = document.getElementById('btn-open-agent-discuss');
    if (discussBtn) discussBtn.onclick = function () { return openAgentDiscussion(); };

    const ctxDetailBtn = document.getElementById('btn-ctx-detail');
    if (ctxDetailBtn) ctxDetailBtn.onclick = function () { openCtxBreakdown(); };

    const worldBtn = document.getElementById('btn-add-world');
    if (worldBtn) worldBtn.onclick = function () { worldModal(null); };

    const charBtn = document.getElementById('btn-add-character');
    if (charBtn) charBtn.onclick = function () { charModal(null); };

    // 本书提示词 / 作家卡 / 错题库入口已迁至个人中心（#/profile，见 profile.js），
    // 工作台顶栏只留一个「个人中心」链接（纯 hash 跳转，无需在此绑事件）。
  }

  // ---------- S4-05：统一可见状态（任务卡 / 保存三态 / 资料更新）----------
  // 三个问题分开答，互不冒充：
  //   ① 任务状态只来自服务端运行快照（GET /chat 的 message.run，或本轮 SSE 的 done.run）——
  //      刷新后按服务端重建，不由浏览器上一条气泡猜；读不到就是「未知（待恢复）」。
  //   ② 保存状态由 run-status.js 统一（本地脏标记 + 落盘事实），这里只负责按需/可见时刷新。
  //   ③ 另一空间改了当前章：只提示「资料更新」并给「查看差异 / 刷新」；脏正文永不自动覆盖，
  //      聊天历史也不自动加入任何变更消息。
  var lastRunSnapshot = null;
  var lastToolErrors = [];
  var lastRoundTools = [];
  var resourceNotice = null;
  var runWatcher = null;
  var resourceWatcher = null;

  function cardHost() { return document.getElementById('writing-run-card'); }

  function isActiveRun(run) {
    return !!(run && (run.status === 'running' || run.status === 'awaiting_confirmation'));
  }

  function resourceKey(chapterId) {
    return 'writing_resource:' + ((S.currentBook && S.currentBook.id) || '?') + ':' + chapterId;
  }

  function renderRunCard() {
    var RS = window.RunStatus;
    var host = cardHost();
    if (!RS || !host) return null;
    var model = RS.cardModel({
      run: lastRunSnapshot,
      conversationId: currentConversationId(),
      tools: lastRoundTools,
      toolErrors: lastToolErrors,
      resourceNotice: resourceNotice,
    });
    RS.mountTaskCard(host, model, { onRefresh: onResourceRefresh });
    return model;
  }

  // 作者点「刷新」：脏正文保留（只提示），干净时才重新从服务端加载当前章
  async function onResourceRefresh() {
    var RS = window.RunStatus;
    if (!RS) return null;
    const cid = S.currentChapterId;
    const applied = RS.applyResourceRefresh({
      dirty: !!(BookPage.hasUnsavedChanges && BookPage.hasUnsavedChanges()),
      reload: function () { return cid && BookPage.selectChapter ? BookPage.selectChapter(cid) : null; },
    });
    if (!applied.applied) {
      A.toast(applied.hint || '暂时不能刷新');
      return applied;
    }
    resourceNotice = null;
    A.toast('已按服务端版本重新加载本章');
    if (cid) {
      try {
        const data = await A.api('GET', '/api/resources?type=chapter&bookId=' + S.currentBook.id + '&id=' + cid);
        var res = data && data.resource;
        if (res) RS.observeResource(resourceKey(cid), res);
      } catch (e) { /* 重新加载后读不到资源元数据：保持现状，不臆造 */ }
    }
    renderRunCard();
    return applied;
  }

  // 读取当前章的服务端版本，判断是否被另一空间改过（只提示，不覆盖）
  async function checkCurrentResource() {
    var RS = window.RunStatus;
    const cid = S.currentChapterId;
    if (!RS || !cid || !S.currentBook) return null;
    var data;
    try {
      data = await A.api('GET', '/api/resources?type=chapter&bookId=' + S.currentBook.id + '&id=' + cid);
    } catch (e) {
      return null; // 读不到资源元数据：不提示，也不臆造「没有变化」
    }
    var res = data && data.resource;
    if (!res) return null;
    var obs = RS.observeResource(resourceKey(cid), res);
    if (obs.changed && !obs.first) {
      var from = obs.previous && obs.previous.revision != null ? obs.previous.revision : '未记录';
      var to = obs.current && obs.current.revision != null ? obs.current.revision : '未记录';
      resourceNotice = {
        badge: RS.RESOURCE_BADGE,
        detail: '《' + (res.title || ('章节 #' + cid)) + '》已被另一处更新（版本 ' + from + ' → ' + to + '）：你的编辑器内容没有被覆盖。',
        actions: [
          { key: 'diff', label: '查看差异', href: res.route || '#/book/' + S.currentBook.id },
          { key: 'refresh', label: '刷新' },
        ],
      };
    } else if (!obs.changed) {
      resourceNotice = null;
    }
    return resourceNotice;
  }

  // 按需刷新：页面进入、消息加载完、每轮对话收尾、低频轮询都会走这里
  async function refreshRunStatus(opts) {
    var RS = window.RunStatus;
    if (!RS) return null;
    const o = opts || {};
    if (Array.isArray(o.messages)) {
      var snap = RS.runFromMessages(o.messages);
      if (snap) lastRunSnapshot = snap;
    }
    if (o.run) lastRunSnapshot = o.run;
    if (o.tools) lastRoundTools = o.tools;
    if (o.toolErrors) lastToolErrors = o.toolErrors;
    if (o.resourceNotice !== undefined) resourceNotice = o.resourceNotice;
    await RS.loadPersistence();
    if (o.checkResource !== false) await checkCurrentResource();
    renderRunCard();
    return lastRunSnapshot;
  }

  // 活跃运行时低频补齐（完成即停）；不可见时不发请求
  function syncRunWatcher() {
    var RS = window.RunStatus;
    if (!RS || !cardHost()) return null;
    if (!isActiveRun(lastRunSnapshot)) {
      if (runWatcher) { runWatcher.stop(); runWatcher = null; }
      return null;
    }
    if (runWatcher) return runWatcher;
    runWatcher = RS.createWatcher({
      intervalMs: 5000,
      isVisible: function () { return pageVisible(); },
      load: async function () {
        await refreshRunStatus({ checkResource: false });
        return { terminal: !isActiveRun(lastRunSnapshot) };
      },
    });
    runWatcher.start();
    return runWatcher;
  }

  function pageVisible() {
    var doc = window.document;
    return !doc || !doc.visibilityState || doc.visibilityState !== 'hidden';
  }

  function startStatusWatchers() {
    var RS = window.RunStatus;
    if (!RS) return null;
    syncRunWatcher();
    if (!resourceWatcher) {
      resourceWatcher = RS.createWatcher({
        intervalMs: 8000,   // 资料更新检查：低频（页面可见时才查）
        isVisible: function () { return pageVisible(); },
        load: async function () {
          await refreshRunStatus({ checkResource: true });
          return { terminal: false }; // 资料更新是常驻检查：停靠页面可见性与作者离开，不因任务结束而停
        },
      });
      resourceWatcher.start();
    }
    return resourceWatcher;
  }

  // 展示态开关（S4-02 口径：切后台只切展示态，不调 stop、不动运行状态）
  BookPage.setStatusPollingVisible = function (on) {
    const visible = !!on && pageVisible();
    if (visible) startStatusWatchers();
    else {
      if (resourceWatcher) { resourceWatcher.stop(); resourceWatcher = null; }
      if (runWatcher) { runWatcher.stop(); runWatcher = null; }
    }
    return visible;
  };
  BookPage.refreshRunStatus = refreshRunStatus;
  BookPage.renderRunCard = renderRunCard;

  if (window.RunStatus && window.RunStatus.onVisibilityChange) {
    window.RunStatus.onVisibilityChange(function () { BookPage.setStatusPollingVisible(pageVisible()); });
  }

  BookPage.loadChat = loadChat;
  BookPage.loadWorld = loadWorld;
  BookPage.loadCharacters = loadCharacters;
  BookPage.bindChatEvents = bindChatEvents;
  // S4-02：当前写作会话 id（状态条与「返回后同一会话」断言共用的只读出口）
  BookPage.currentWritingConversationId = currentConversationId;
  // 确认卡/工具块渲染器导出：阅读页侧边栏复用同一份卡片（样式与结算语义一致，M4/W7）
  BookPage.renderActionCard = renderActionCard;
  BookPage.renderToolEvent = renderToolEvent;
})();
