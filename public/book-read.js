// 阅读 / 精修工作台：独立整页，左侧目录 + 中间阅读/精修 + 右侧 AI 侧边栏。
// 不改动写作页右侧的章节预览编辑器；本页保存沿用章节 PUT（自动版本快照与证据失效）。
(function () {
  'use strict';

  var App = window.App;
  var ReadPage = window.ReadPage = window.ReadPage || {};

  var S = {
    bookId: null,
    bookTitle: '',
    chapterId: null,
    chapter: null,
    volumes: [],
    chapters: [], // 扁平、按卷/序排列
    paras: [], // 阅读视图每段在原始正文中的偏移 {text,start,end}，供选区精确回定位（D3-02/03）
    mode: 'read', // 'read' | 'edit'
    theme: 'light',
    fontSize: 18,
    pendingSelection: null, // {start,end,text}
    lastReply: '',
    streaming: false,
    sendToken: 0,
    abortCtl: null,
  };

  function $(id) { return document.getElementById(id); }
  function basePath() { return '/api/books/' + S.bookId + '/chapters'; }
  function volPath() { return '/api/books/' + S.bookId + '/volumes'; }
  function esc(v) { return App.escapeHtml(v); }
  function wordCount(text) { return String(text || '').replace(/\s/g, '').length; }

  // ---------- 持久化偏好 ----------
  function prefKey(name) { return 'novel-read:' + name + ':' + S.bookId; }
  function loadPrefs() {
    try {
      S.theme = localStorage.getItem(prefKey('theme')) || 'light';
      var fs = parseInt(localStorage.getItem(prefKey('fontSize')), 10);
      S.fontSize = fs > 0 ? fs : 18;
    } catch (e) { /* ignore */ }
  }
  function savePref(name, val) { try { localStorage.setItem(prefKey(name), String(val)); } catch (e) { /* ignore */ } }
  function progressKey() { return 'novel-read:progress:' + S.bookId; }

  // ---------- 目录 / 章节 ----------
  async function loadStructure() {
    var volRes = await App.api('GET', volPath());
    S.volumes = volRes.volumes || [];
    var res = await App.api('GET', basePath());
    var all = res.chapters || [];
    S.chapters = [];
    for (var v = 0; v < S.volumes.length; v++) {
      var vol = S.volumes[v];
      for (var i = 0; i < all.length; i++) {
        if (all[i].volume_id === vol.id) S.chapters.push(all[i]);
      }
    }
    // 未归卷的章节兜底追加
    for (var k = 0; k < all.length; k++) {
      var inVol = S.chapters.indexOf(all[k]) >= 0;
      if (!inVol) S.chapters.push(all[k]);
    }
    renderTOC();
  }

  function renderTOC() {
    var list = $('read-toc-list');
    if (!list) return;
    var html = '';
    for (var v = 0; v < S.volumes.length; v++) {
      var vol = S.volumes[v];
      html += '<li class="read-toc-vol">' + esc(vol.title) + '</li>';
      for (var i = 0; i < S.chapters.length; i++) {
        var ch = S.chapters[i];
        if (ch.volume_id !== vol.id) continue;
        var active = ch.id === S.chapterId ? ' active' : '';
        html += '<li class="read-toc-item' + active + '" data-id="' + ch.id + '">' + esc(ch.title) + '</li>';
      }
    }
    // 未归卷/悬空卷章节：volume_id 为空或指向已不存在的卷（跨书挂卷残留、卷随他书删除等）。
    // 此前仅当全书无卷时才显示，有卷时这些章节能被「下一章」到达却在目录里永远不可见（实测 27/28 章漏 1 章）。
    var volumeIds = {};
    for (var vv = 0; vv < S.volumes.length; vv++) volumeIds[S.volumes[vv].id] = true;
    var orphan = S.chapters.filter(function (c) { return !c.volume_id || !volumeIds[c.volume_id]; });
    if (orphan.length) {
      html += '<li class="read-toc-vol read-toc-orphan">未归卷</li>';
      for (var o = 0; o < orphan.length; o++) {
        var oc = orphan[o];
        html += '<li class="read-toc-item' + (oc.id === S.chapterId ? ' active' : '') + '" data-id="' + oc.id + '">' + esc(oc.title) + '</li>';
      }
    }
    list.innerHTML = html;
    var items = list.querySelectorAll('.read-toc-item');
    for (var j = 0; j < items.length; j++) {
      items[j].onclick = function () { selectChapter(parseInt(this.dataset.id, 10)); };
    }
  }

  async function selectChapter(cid) {
    try {
      var res = await App.api('GET', basePath() + '/' + cid);
      S.chapter = res.chapter;
      S.chapterId = cid;
      S.pendingSelection = null;
      try { localStorage.setItem(progressKey(), String(cid)); } catch (e) { /* ignore */ }
      renderChapter();
      renderTOC();
      updateNav();
      // 作家仓库 · 体检入口（旁路）：只把当前书/章告知面板模块，
      // 面板自身不参与本页任何状态与渲染——删掉这行与 style-health.js，本页行为不变
      if (window.StyleHealth) window.StyleHealth.render(S.bookId, S.chapterId);
    } catch (e) {
      App.toast(e.message);
    }
  }

  // 标题改名（2026-09-11）：阅读/精修页此前标题是只读 span，全书改名唯一入口在写作页编辑器顶部，
  // 作者在阅读台看到错别字也只能切回写作页。现在点标题就地变输入框：回车/失焦提交，Esc 取消。
  // 只提交 title（服务端不改正文、不解除定稿）；精修模式下正文有未保存改动时先落库再改名。
  function showTitleInput() {
    if (!S.chapterId) return;
    var span = $('read-chapter-title');
    var input = $('read-chapter-title-input');
    if (!span || !input || !input.classList.contains('hidden')) return;
    input.value = (S.chapter && S.chapter.title) || '';
    span.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    input.select();
  }

  function hideTitleInput() {
    var span = $('read-chapter-title');
    var input = $('read-chapter-title-input');
    if (input) input.classList.add('hidden');
    if (span) span.classList.remove('hidden');
  }

  async function commitTitle() {
    var input = $('read-chapter-title-input');
    if (!input || input.classList.contains('hidden') || !S.chapterId) return;
    var title = input.value.trim();
    var previous = (S.chapter && S.chapter.title) || '';
    hideTitleInput();
    if (!title || title === previous) return;
    try {
      // 精修模式下正文可能已改未存：先存正文，避免改名后 renderChapter 用旧正文回填编辑器丢手改
      if (S.mode === 'edit' && $('read-editor').value !== ((S.chapter && S.chapter.content) || '')) {
        await save();
      }
      var putBody = { title: title };
      // S1-03：改名也走版本比对；上面的先落库（save 成功时）已刷新 S.chapter.revision
      if (S.chapter && S.chapter.revision != null) putBody.expected_revision = Number(S.chapter.revision);
      var res = await App.api('PUT', basePath() + '/' + S.chapterId, putBody);
      S.chapter = res.chapter || S.chapter;
      S.chapter.title = title;
      var ch = S.chapters.find(function (c) { return c.id === S.chapterId; });
      if (ch) ch.title = title;
      $('read-chapter-title').textContent = title;
      renderTOC();
      App.toast('已重命名');
    } catch (e) {
      App.toast(e.message);
      $('read-chapter-title').textContent = previous;
      // 冲突时不动编辑器：正文草稿可能因冲突未落库（save 已把本地稿留在编辑器），
      // renderChapter 用旧快照回填会把它抹掉
      if (!(S.mode === 'edit' && e && (e.code === 'CHAPTER_CONFLICT' || e.code === 'CHAPTER_REVISION_REQUIRED'))) renderChapter();
    }
  }

  function renderChapter() {
    var ch = S.chapter || {};
    $('read-chapter-title').textContent = ch.title || '';
    hideTitleInput();
    // 阅读视图：按段渲染，并记录每段在原始正文中的偏移（D3-02/03 精确回定位所需）
    var content = ch.content || '';
    S.paras = splitParas(content);
    var html = S.paras.length
      ? S.paras.map(function (p, i) { return '<p data-pidx="' + i + '">' + esc(p.text) + '</p>'; }).join('')
      : '<p class="read-empty">（本章还没有内容）</p>';
    $('read-article').innerHTML = html;
    // 精修视图
    $('read-editor').value = content;
    updateWordCount();
    applyMode();
    applyTheme();
    applyFontSize();
  }

  function updateWordCount() {
    var text = S.mode === 'edit' ? $('read-editor').value : (S.chapter && S.chapter.content) || '';
    $('read-word-count').textContent = '共 ' + wordCount(text) + ' 字';
  }

  function updateNav() {
    var idx = S.chapters.findIndex(function (c) { return c.id === S.chapterId; });
    $('read-prev').disabled = idx <= 0;
    $('read-next').disabled = idx < 0 || idx >= S.chapters.length - 1;
  }

  function stepChapter(delta) {
    var idx = S.chapters.findIndex(function (c) { return c.id === S.chapterId; });
    var next = S.chapters[idx + delta];
    if (next) selectChapter(next.id);
  }

  // ---------- 模式 / 主题 / 字号 ----------
  function applyMode() {
    var isEdit = S.mode === 'edit';
    $('read-article').classList.toggle('hidden', isEdit);
    $('read-editor').classList.toggle('hidden', !isEdit);
    $('read-save').classList.toggle('hidden', !isEdit);
    $('read-mode-read').classList.toggle('mode-on', !isEdit);
    $('read-mode-edit').classList.toggle('mode-on', isEdit);
    if (!isEdit) { $('read-ai-revise').classList.add('hidden'); $('read-apply-reply').classList.add('hidden'); }
    updateWordCount();
  }
  function setMode(m) { S.mode = m; applyMode(); }

  function applyTheme() {
    var wrap = $('read-center');
    wrap.classList.remove('theme-light', 'theme-sepia', 'theme-night');
    wrap.classList.add('theme-' + S.theme);
    $('read-theme').value = S.theme;
  }
  function applyFontSize() {
    $('read-article').style.fontSize = S.fontSize + 'px';
    $('read-editor').style.fontSize = Math.max(14, S.fontSize - 2) + 'px';
  }

  // ---------- 保存 ----------
  async function save() {
    if (!S.chapterId) return;
    try {
      // S1-03/C04-B：携带打开章节时的服务端 revision（单调版本；秒级 updated_at 已废弃），
      // 版本不符=别处已改，走 ChapterConflict 显式二选一，不静默覆盖也不自动重载。
      var body = { content: $('read-editor').value };
      if (S.chapter && S.chapter.revision != null) body.expected_revision = Number(S.chapter.revision);
      var res;
      try {
        res = await App.api('PUT', basePath() + '/' + S.chapterId, body);
      } catch (e1) {
        // 快照缺版本（428）：按服务端契约「先读当前 revision 再写」重读一次后重试；
        // 仅此一个防御性重试，重试后 409 仍走冲突对话。
        if (e1 && e1.code === 'CHAPTER_REVISION_REQUIRED' && !(S.chapter && S.chapter.revision != null)) {
          var reread = await App.api('GET', basePath() + '/' + S.chapterId);
          S.chapter = reread.chapter;
          body.expected_revision = Number(S.chapter.revision);
          res = await App.api('PUT', basePath() + '/' + S.chapterId, body);
        } else {
          throw e1;
        }
      }
      if (res && res.autoUnlocked) App.toast('该章原定稿，修改后已自动解除定稿');
      else App.toast('已保存');
      S.chapter = res.chapter || S.chapter;
      S.chapter.content = $('read-editor').value;
      updateWordCount();
    } catch (e) {
      // 409 冲突：另一窗口/AI 已修改本章。拉最新版弹显式二选一——本地稿留在编辑器，
      // 复制/比对/重载由作者决定（旧版静默载入最新内容会抹掉本地手改）。
      // e.code 由 App.api 结构化透传（M4/W8）；/已被修改/ 正则仅作旧文案兜底。
      if (e && (e.code === 'CHAPTER_CONFLICT' || e.code === 'CHAPTER_REVISION_REQUIRED' || /已被修改/.test(e.message || ''))) {
        try {
          var fresh = await App.api('GET', basePath() + '/' + S.chapterId);
          if (window.ChapterConflict) {
            window.ChapterConflict.show({
              server: fresh.chapter,
              local: { content: $('read-editor').value },
              onReload: function (srv) {
                if (S.chapterId !== srv.id) return; // 弹窗期间已切章：不动编辑器
                S.chapter = srv;
                renderChapter();
              }
            });
          } else {
            App.toast('章节已在其他窗口被修改，本地稿已保留在编辑器中，请核对后重试');
          }
        } catch (_) { App.toast('获取服务端最新版本失败，本地稿已保留，可先手动复制'); }
        return;
      }
      App.toast(e.message);
    }
  }

  // ---------- AI 侧边栏（复用写作聊天后端，带全书上下文） ----------
  // 阅读页与写作台共用同一本书的会话（同一个 messages 表）。消息来源标注（B5）：
  // 侧边栏发的消息在库里标 source='read'，写作台看到时才不会误判「这条不是我说的」。
  var SOURCE_LABELS = { writing: '写作台', read: '阅读页', agent: '助手', system: '系统' };

  function makeSourceTag(source) {
    var label = SOURCE_LABELS[source] || '';
    if (!label) return null;
    var tag = document.createElement('span');
    tag.className = 'msg-source msg-source-' + source;
    tag.textContent = label;
    return tag;
  }

  function appendMsg(role, text, source) {
    var wrap = $('read-ai-messages');
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    // 仅当有来源时才多出一行标注（无来源保持改造前 DOM，历史/未知来源静默兼容）
    var tag = makeSourceTag(source);
    if (tag) {
      var srcRow = document.createElement('div');
      srcRow.className = 'msg-role';
      srcRow.textContent = role === 'user' ? '我' : '写作助手';
      srcRow.appendChild(tag);
      div.appendChild(srcRow);
    }
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text || '';
    div.appendChild(bubble);
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
    return bubble;
  }

  function updateStopBtn() {
    var b = $('read-ai-stop');
    if (b) b.classList.toggle('hidden', !S.abortCtl);
  }

  function sendToAI(content, targetSel) {
    // B5：阅读页发出的消息标 source='read'，写作台/助手页据此显示「阅读页」来源标签
    return streamChat({ content: content, chapterId: S.chapterId, source: 'read' }, targetSel, content);
  }

  // 确认卡结算后续跑（复用侧边栏流）：执行结果作为系统事件回灌，AI 继续原任务
  function readResumeAfterConfirm(actionId) {
    if (!S.bookId) return;
    appendMsg('user', '[确认执行结果·系统事件] 已把执行结果交给 AI，继续之前的任务…', 'read');
    streamChat({ resumeActionId: actionId, chapterId: S.chapterId, source: 'read' }, null, null);
  }

  // 写操作落地后的联动刷新：涉及章节的工具刷新目录；改动的是当前章则重载正文
  async function readRefreshAfterWrite(name, args) {
    if (['create_chapter', 'append_chapter', 'replace_chapter', 'set_chapter_meta'].indexOf(name) >= 0) {
      await loadStructure();
      var cid = args && (args.chapterId || (args.chapter && args.chapter.id));
      if (cid && cid === S.chapterId) await selectChapter(S.chapterId);
    }
  }

  // 侧边栏流式消费（统一走 ChatEventHub，M4/W7）：此前手写循环只认 content/done/error，
  // 工具调用与确认卡事件被静默丢弃——AI 在阅读页发起写操作时作者永远看不到确认卡（功能级缺陷）。
  // 现在工具事件与确认卡都渲染在侧边栏内，卡片复用 book-chat.js 的同一渲染器（含同意/拒绝/续跑闭环）。
  async function streamChat(body, targetSel, userEcho) {
    // 上一次请求若还挂着（服务端长响应/断流）：取消它再发新的，
    // 避免 S.streaming 卡死导致后续点击被静默吞掉
    var my = ++S.sendToken;
    if (S.abortCtl) { try { S.abortCtl.stop('superseded'); } catch (e) { /* ignore */ } }
    var runAbort = ChatEventHub.createAbort();
    S.abortCtl = runAbort;
    S.streaming = true;
    if (userEcho) appendMsg('user', userEcho, 'read');
    var bubble = appendMsg('assistant', '', 'read');
    bubble.textContent = '（AI 思考中…）';
    var started = false;
    $('read-ai-send').disabled = true;
    $('read-ai-revise').disabled = true;
    updateStopBtn();
    try {
      // S2-01：幂等 requestId——网络重试/双击复用同一个，服务端返回既有运行不重跑
      if (!body.request_id) body.request_id = ChatEventHub.newRequestId('read');
      // S3-03：阅读页默认继续作者选定的写作会话（与写作台共享同一存储 key；source=read 只是来源标签）
      if (!body.conversationId) {
        try { body.conversationId = localStorage.getItem('writing_conversation_' + S.bookId) || undefined; } catch (e) { /* 忽略 */ }
      }
      var res = await fetch('/api/books/' + S.bookId + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: runAbort.signal,
      });
      if (res.status === 409) {
        // 阅读页没有排队语义（那是写作台的单飞闸门职责），CHAT_BUSY 与其他 409 一样直接提示
        throw await ChatEventHub.parseResponseError(res, '流式请求失败');
      }
      // S2-01：重复请求（同 requestId）返回 JSON 而非 SSE——不解析成流、不重发业务请求，
      // 等原运行结束（结果在发起窗口与书聊历史里）。请求体带幂等 requestId。
      if (ChatEventHub.isJsonResponse(res)) {
        var dupR = null;
        try { dupR = await res.json(); } catch (e) {}
        if (dupR && dupR.duplicate) {
          bubble.textContent = '（该请求已在另一窗口进行，等待其结果…）';
          if (ChatEventHub.isActiveStatus(dupR.status)) {
            try {
              await ChatEventHub.waitRunEvents({ runId: dupR.runId, sessionKey: dupR.sessionKey, signal: runAbort.signal });
            } catch (e2) {
              if (!ChatEventHub.isAbortError(e2)) App.toast('等待运行结果失败：' + e2.message);
            }
          }
          bubble.textContent = '（该请求已在另一窗口完成，结果见写作台会话）';
          return;
        }
        throw await ChatEventHub.parseResponseError(res, '请求失败 ' + res.status);
      }
      if (!res.ok || !res.body) throw new Error('流式请求失败');
      var wrap = $('read-ai-messages');
      var state = await ChatEventHub.consumeBookStream(res, {
        onDelta: function (t) {
          if (!started) { started = true; bubble.textContent = ''; }
          bubble.textContent += t;
          wrap.scrollTop = wrap.scrollHeight;
        },
        onTool: function (t) {
          if (!window.BookPage || !BookPage.renderToolEvent) return;
          var tb = BookPage.renderToolEvent(t);
          bubble.parentNode.insertBefore(tb, bubble);
          wrap.scrollTop = wrap.scrollHeight;
        },
        onAction: function (a) {
          if (!window.BookPage || !BookPage.renderActionCard) return;
          var ac = BookPage.renderActionCard(a, {
            bookId: S.bookId,
            onSettled: readRefreshAfterWrite,
            resume: readResumeAfterConfirm,
          });
          bubble.parentNode.insertBefore(ac, bubble);
          wrap.scrollTop = wrap.scrollHeight;
        },
        onRecovering: function () { App.toast('输出被截断或连接中断，正在无缝续写…'); },
        onError: function (info) { App.toast(info.message || 'AI 返回错误'); },
        onDone: function (ev, st) {
          if (st && st.aborted) return; // 用户停止：部分输出不作为可替换回复
          // 只有真正拿到过正文，才记录回复/开放替换按钮，
          // 防止空流把"（AI 思考中…）"占位误当回复
          if (ev && typeof ev.content === 'string' && ev.content) {
            started = true;
            S.lastReply = ev.content;
            bubble.textContent = S.lastReply;
          } else if (started) {
            S.lastReply = bubble.textContent;
          }
          // D3-05：把回复绑定到「触发它的那段选区」，替换只认这段自己的回复，绝不误用上一轮 S.lastReply
          if (targetSel && started) targetSel.reply = S.lastReply;
          if (started && targetSel && S.pendingSelection === targetSel) $('read-apply-reply').classList.remove('hidden');
        },
      });
      if (state.aborted) {
        if (runAbort.reason() === 'user') {
          // 用户按「停止」：部分输出保留在气泡里，附停止标记
          bubble.textContent = started ? bubble.textContent + '\n（已停止生成）' : '（已停止生成）';
        } else {
          bubble.textContent = '（本次请求已被新的提问取消）';
        }
      } else {
        var finalText = typeof state.finalContent === 'string' ? state.finalContent : state.content;
        if (!started && !finalText) {
          bubble.textContent = '（AI 未返回内容：可能超时或断流，可重发一次）';
        } else {
          if (finalText) S.lastReply = finalText;
          else if (!S.lastReply) S.lastReply = bubble.textContent;
          if (targetSel) targetSel.reply = S.lastReply; // D3-05：兜底绑定（done 事件缺失时）
          if (targetSel && S.pendingSelection === targetSel) $('read-apply-reply').classList.remove('hidden');
        }
      }
    } catch (e) {
      if (ChatEventHub.isAbortError(e)) {
        bubble.textContent = runAbort.reason() === 'user' ? '（已停止生成）' : '（本次请求已被新的提问取消）';
      } else {
        App.toast(e.message);
      }
    } finally {
      if (my === S.sendToken) {
        S.streaming = false;
        S.abortCtl = null;
        $('read-ai-send').disabled = false;
        $('read-ai-revise').disabled = false;
        updateStopBtn();
      }
    }
  }

  function currentSelection() {
    var el = $('read-editor');
    var s = el.selectionStart, e = el.selectionEnd;
    if (s >= e) return null;
    return { start: s, end: e, text: el.value.slice(s, e) };
  }

  // 把正文按段切分并记录每段在原始 content 中的 [start,end)（D3-02/03 精确回定位基础）。
  // 与阅读视图渲染同口径：按换行分段、trim、丢弃空段；start/end 指向 trim 后文本在原文的偏移。
  function splitParas(content) {
    var out = [];
    var re = /[^\r\n]+/g;
    var m;
    while ((m = re.exec(content)) !== null) {
      var raw = m[0];
      var text = raw.trim();
      if (!text) continue;
      var lead = raw.match(/^\s*/)[0].length;
      var trail = raw.match(/\s*$/)[0].length;
      out.push({ text: text, start: m.index + lead, end: m.index + raw.length - trail });
    }
    return out;
  }

  // 计算 DOM 点 (node,offset) 相对其所属 <p> 文本起点的字符偏移。
  function paraOffsetIn(p, node, offset) {
    if (node === p) {
      var sum = 0;
      for (var i = 0; i < offset && i < p.childNodes.length; i++) sum += (p.childNodes[i].textContent || '').length;
      return sum;
    }
    if (node.parentNode === p) return offset; // 扁平 <p> 的直接文本子节点（本渲染即此形态）
    try {
      var r = document.createRange();
      r.selectNodeContents(p);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch (e) { return null; }
  }

  // 把 DOM 点映射回原始正文的绝对偏移；定位失败返回 null（调用方回退 indexOf）。
  function domPointToContentPos(node, offset) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    var p = el && el.closest ? el.closest('p[data-pidx]') : null;
    if (!p) return null;
    var para = S.paras[parseInt(p.dataset.pidx, 10)];
    if (!para) return null;
    var within = paraOffsetIn(p, node, offset);
    if (within == null) return null;
    if (within < 0) within = 0;
    if (within > para.text.length) within = para.text.length;
    return para.start + within;
  }

  // 阅读模式：从正文 DOM 的鼠标选区取文字，并尽量解析出其在原始正文中的精确 [start,end)
  function readSelection() {
    var selObj = window.getSelection();
    if (!selObj || selObj.rangeCount === 0 || selObj.isCollapsed) return null;
    var text = String(selObj.toString()).trim();
    if (!text) return null;
    var out = { text: text, fromRead: true };
    try {
      var range = selObj.getRangeAt(0);
      var a = domPointToContentPos(range.startContainer, range.startOffset);
      var b = domPointToContentPos(range.endContainer, range.endOffset);
      if (a != null && b != null && a !== b) {
        out.start = Math.min(a, b);
        out.end = Math.max(a, b);
        out.rawText = ((S.chapter && S.chapter.content) || '').slice(out.start, out.end);
      }
    } catch (e) { /* 解析失败则只带 text，替换时回退 indexOf 老路 */ }
    return out;
  }

  // ---------- 选中段引用：侧边栏"接住"选区，供用户自由下命令 ----------
  function setQuote(sel) {
    S.pendingSelection = sel;
    var t = $('read-ai-quote-text');
    t.textContent = sel.text;
    t.title = sel.text;
    $('read-ai-quote').classList.remove('hidden');
    // 选区换了，上一轮的替换按钮作废
    $('read-apply-reply').classList.add('hidden');
  }
  function clearQuote() {
    S.pendingSelection = null;
    $('read-ai-quote').classList.add('hidden');
    $('read-apply-reply').classList.add('hidden');
  }
  function withSelectionPrompt(cmd) {
    if (!S.pendingSelection) return cmd;
    return '下面是我从正文中选中的段落（唯一处理对象）：\n"""\n' + S.pendingSelection.text + '\n"""\n\n我的要求：' + cmd +
      '\n\n若要求是改写/润色：只直接输出改后的段落正文，不要解释、不要加引号或标记；若要求是分析或讨论：正常回答。';
  }

  function checkSelection() {
    var sel = S.mode === 'edit' ? currentSelection() : readSelection();
    $('read-ai-revise').classList.toggle('hidden', !sel);
    if (sel) setQuote(sel); else clearQuote();
  }

  function reviseSelection() {
    var sel = S.mode === 'edit' ? currentSelection() : readSelection();
    if (!sel) return;
    setQuote(sel);
    $('read-ai').classList.remove('collapsed');
    sendToAI(withSelectionPrompt('精修改写这一段：保持人称、剧情与设定不变；改写长度与原文相近（上下不超过三成），不要扩写、不要拆成多段、不要新增情节。'), sel);
  }

  // 替换前净化 AI 回复：剥掉模型夹带的标记噪音（Markdown 标题行、代码围栏、成对首尾引号、"改写后："式前导行），
  // 只留段落正文，避免把 "## 改写后" 这类东西写进小说正文（Agnes 实测会带）
  function sanitizeReply(text) {
    var lines = String(text || '').trim().split('\n');
    if (lines.length && lines[0].indexOf('```') === 0) lines.shift();
    if (lines.length && lines[lines.length - 1].trim().indexOf('```') === 0) lines.pop();
    var t = lines.join('\n').trim();
    t = t.replace(/^(?:#{1,6}[^\n]*|(?:改写后|修改后|润色后|改后|重写后)\s*[:：])\s*(?:\n+|$)/, '');
    // 只剥「同族成对」的首尾引号（模型包裹输出的常见形态）。此前 /^["“「『]…["”」』]$/ 不要求配对，
    // 开头 " 结尾 』 也会被剥；而整段本身就是引文对话（小说常态）时更会把正文引号一起误删。
    var qm = t.match(/^(?:"([\s\S]*)"|“([\s\S]*)”|「([\s\S]*)」|『([\s\S]*)』)$/);
    if (qm) t = qm[1] != null ? qm[1] : (qm[2] != null ? qm[2] : (qm[3] != null ? qm[3] : qm[4]));
    return t.trim();
  }

  async function applyReplyToSelection() {
    var sel = S.pendingSelection;
    if (!sel) return;
    // D3-05：只用「为这段选区生成的」回复；流式未结束或已切换选区时 sel.reply 为空，拒绝替换，绝不误用上一轮旧回复
    var reply = sel.reply;
    if (!reply) { App.toast('这段的 AI 回复还没生成完，请等它结束再替换'); return; }
    var el = $('read-editor');
    var revised = sanitizeReply(reply);
    if (!revised) { App.toast('AI 回复里没有可替换的正文'); return; }
    var start, end;
    // 两种模式同一校验：精确偏移只在「选中后正文没再变动」时使用（快照文本仍吻合），
    // 否则回退 indexOf 重定位。精修模式此前直接信任选中时的偏移，选中后再粘贴/编辑正文即错位替换。
    if (typeof sel.start === 'number' && typeof sel.end === 'number' &&
        el.value.slice(sel.start, sel.end) === (sel.rawText != null ? sel.rawText : sel.text)) {
      start = sel.start; end = sel.end;
    } else {
      var idx = el.value.indexOf(sel.text); // 回退：正文已变动或拿不到精确偏移
      if (idx < 0) { App.toast('在当前章正文中找不到这段原文，无法替换（正文可能已被改动）'); return; }
      start = idx; end = idx + sel.text.length;
    }
    el.value = el.value.slice(0, start) + revised + el.value.slice(end);
    S.pendingSelection = null;
    clearQuote();
    $('read-ai-revise').classList.add('hidden');
    updateWordCount();
    await save();
    renderChapter();
    App.toast('已替换选中段并保存');
  }

  // ---------- 入口 ----------
  ReadPage.show = async function (bookId, chapterId) {
    S.bookId = bookId;
    loadPrefs();
    try {
      var book = await App.api('GET', '/api/books/' + bookId);
      S.bookTitle = (book.book && book.book.title) || '';
      $('read-book-title').textContent = S.bookTitle;
      $('read-return').href = '#/book/' + bookId;
    } catch (e) { S.bookTitle = ''; }

    await loadStructure();

    var cid = chapterId;
    if (!cid) {
      try { cid = parseInt(localStorage.getItem(progressKey()), 10) || null; } catch (e) { cid = null; }
    }
    if (!cid && S.chapters.length) cid = S.chapters[0].id;
    if (cid) await selectChapter(cid);
    else { S.chapter = null; renderChapter(); updateNav(); }

    applyTheme();
    applyFontSize();
    applyMode();
  };

  ReadPage.bind = function () {
    $('read-mode-read').onclick = function () { setMode('read'); };
    $('read-mode-edit').onclick = function () { setMode('edit'); };
    $('read-prev').onclick = function () { stepChapter(-1); };
    $('read-next').onclick = function () { stepChapter(1); };
    $('read-save').onclick = save;
    $('read-theme').onchange = function () { S.theme = this.value; savePref('theme', S.theme); applyTheme(); };
    $('read-font-minus').onclick = function () { S.fontSize = Math.max(14, S.fontSize - 1); savePref('fontSize', S.fontSize); applyFontSize(); };
    $('read-font-plus').onclick = function () { S.fontSize = Math.min(28, S.fontSize + 1); savePref('fontSize', S.fontSize); applyFontSize(); };
    $('read-toggle-toc').onclick = function () { $('read-toc').classList.toggle('collapsed'); };
    $('read-toggle-ai').onclick = function () { $('read-ai').classList.toggle('collapsed'); };
    // 标题改名：点/回车（键盘可达）进入编辑；回车提交、Esc 取消、失焦提交
    var titleSpan = $('read-chapter-title');
    titleSpan.onclick = showTitleInput;
    titleSpan.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTitleInput(); }
    };
    var titleInput = $('read-chapter-title-input');
    titleInput.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideTitleInput(); }
    };
    titleInput.onblur = function () { commitTitle(); };
    $('read-ai-revise').onclick = reviseSelection;
    $('read-apply-reply').onclick = applyReplyToSelection;
    $('read-ai-quote-clear').onclick = clearQuote;
    // 停止生成：中止侧边栏当前流（部分输出保留，对齐 pi 中止语义）
    $('read-ai-stop').onclick = function () { if (S.abortCtl) S.abortCtl.stop('user'); };
    $('read-ai-clear').onclick = function () { $('read-ai-messages').innerHTML = ''; };

    var editor = $('read-editor');
    editor.addEventListener('input', updateWordCount);
    editor.addEventListener('mouseup', checkSelection);
    editor.addEventListener('keyup', checkSelection);
    // 阅读模式：正文选区同样唤起「让AI修改选中段」
    $('read-article').addEventListener('mouseup', checkSelection);

    $('read-ai-form').onsubmit = function (e) {
      e.preventDefault();
      var input = $('read-ai-text');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      // 有选中段引用时：用户的命令作用于该段；无引用时：普通全书聊天
      sendToAI(withSelectionPrompt(text), S.pendingSelection);
    };
  };

  // 脚本位于 body 末尾，DOM 已就绪，直接绑定一次
  ReadPage.bind();
})();
