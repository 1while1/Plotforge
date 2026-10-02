// chat-event-hub：统一 SSE 事件消费器（写作台 / AI 助手页 / 阅读页侧边栏共用）。
// 设计对齐 pi（docs/report/20260911_pi借鉴改造/01-pi-ref精读/H-协议与客户端.md）：
//   1) 「权威快照 + 瞬态增量」：SSE 事件是瞬态提示，折叠(fold)为一份可渲染的 transcript 状态；
//      done 事件携带的全文/思考属于权威快照，覆盖此前累计的增量（pi schemas.ts:203 注释公理）。
//   2) 结构化错误封闭枚举：Error 附 code/details（对齐 pi ProtocolError{code,message,details} /
//      PiServerError），message 保持纯字符串以兼容只读 e.message 的旧调用方——永不压平、永不正则猜。
//   3) run 级单 AbortController（pi agent.ts:313-321）：一次流一个 controller，stop() 扇出到
//      fetch 与 reader；中止不是异常终结——部分输出保留在 transcript 状态里（state.aborted）。
//   4) 监听器异常隔离（pi client/state.ts:115-132）：页面回调抛错只 console 上报，不打断流解析。
// 本文件零依赖、无 DOM 操作，必须在 app.js 之前加载（App.api 的错误解析会用到它）。
(function () {
  'use strict';

  // ---------- 结构化错误 ----------
  // 造一个带 code/details 的 Error。message 始终是可读字符串（兼容 toast(e.message)）。
  function error(message, code, details, status) {
    var err = new Error(message || '请求失败');
    if (code !== undefined && code !== null) err.code = code;
    if (details !== undefined) err.details = details;
    if (status !== undefined) err.status = status;
    return err;
  }

  // 服务端 JSON 错误体 → {message, code?, details?}。兼容线上三种形态：
  //   {error: '文案'}                        字符串错误（历史形态，多数路由）
  //   {error: {code, message, details}}      结构化错误（chat 409 CHAT_BUSY / agent confirm）
  //   {error: '文案', code: 'X', 其余字段}    code 与附加字段在顶层（chapters 409 CHAPTER_CONFLICT）
  function parseErrorBody(data) {
    if (!data || typeof data !== 'object') return null;
    var e = data.error;
    if (e && typeof e === 'object') {
      return {
        message: e.message || JSON.stringify(e),
        code: e.code,
        details: e.details !== undefined ? e.details : undefined,
      };
    }
    if (typeof e === 'string' || typeof data.message === 'string') {
      var details;
      if (data.details !== undefined) details = data.details;
      else if (data.current_updated_at !== undefined || data.expected_updated_at !== undefined) {
        // 乐观锁 409：把当前/期望版本放进 details，前端可结构化展示而不用解析文案
        details = {};
        if (data.current_updated_at !== undefined) details.current_updated_at = data.current_updated_at;
        if (data.expected_updated_at !== undefined) details.expected_updated_at = data.expected_updated_at;
      }
      return {
        message: typeof e === 'string' ? e : data.message,
        code: data.code,
        details: details,
      };
    }
    return null;
  }

  // 非 2xx 响应 → 结构化 Error（吞掉 JSON 解析失败，保留兜底文案）
  async function parseResponseError(res, fallback) {
    var msg = fallback || '请求失败 ' + res.status;
    var code, details;
    try {
      var data = await res.json();
      var parsed = parseErrorBody(data);
      if (parsed) {
        msg = parsed.message;
        code = parsed.code;
        details = parsed.details;
      }
    } catch (e) { /* 非 JSON 响应：保留默认文案 */ }
    return error(msg, code, details, res.status);
  }

  // 任意错误载荷（Error 实例 / SSE error 事件的 error 字段 / 字符串）→ {message, code?, details?}
  function normalizeError(err) {
    if (err == null) return { message: '未知错误' };
    if (typeof err === 'string') return { message: err };
    if (err instanceof Error) {
      var out = { message: err.message || String(err) };
      if (err.code !== undefined) out.code = err.code;
      if (err.details !== undefined) out.details = err.details;
      return out;
    }
    if (typeof err === 'object') {
      return {
        message: err.message || err.errorText || err.msg || JSON.stringify(err),
        code: err.code,
        details: err.details,
      };
    }
    return { message: String(err) };
  }

  // SDK 的 UI-Stream 把工具失败放在 tool-output-error / tool-input-error / tool-output-denied
  // 三个分片里（Vercel AI SDK：tool-error → tool-output-error）。服务端错误文案统一格式
  // `[CODE] 说明`（见 server/tools/adapters/ai-sdk.js 的 toolErrorText），这里把码与说明拆开，
  // 不靠猜：解析不到码就只给说明文本。此前这些分片被整段忽略，工具被拒绝的原因传不到页面。
  var CODE_PREFIX = /^\[([A-Z0-9_]{3,64})\]\s*(.*)$/;

  function parseToolErrorText(text) {
    var raw = String(text == null ? '' : text);
    var m = CODE_PREFIX.exec(raw.trim());
    if (!m) return { code: null, message: raw || '工具调用失败' };
    return { code: m[1], message: m[2] || m[1] };
  }

  // ---------- AbortController 管理 ----------
  // 一次流一个句柄：signal 传给 fetch；stop() 由「停止生成」按钮调用；
  // stopped()/reason() 供收尾时区分「用户停止」与「被新请求顶掉」。
  function createAbort() {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var reason = null;
    return {
      signal: ctl ? ctl.signal : undefined,
      stop: function (why) {
        if (reason) return;
        reason = why || 'user';
        if (ctl) {
          try { ctl.abort(reason); } catch (e) { /* ignore */ }
        }
      },
      stopped: function () { return reason !== null; },
      reason: function () { return reason; },
    };
  }

  function isAbortError(e) {
    if (!e) return false;
    if (e.name === 'AbortError') return true;
    return e.code === 'ABORT_ERR' || e.code === 20; // DOMException AbortError 的 code
  }

  // ---------- 统一 SSE 解析 ----------
  // 两套后端协议（书聊自定义事件 / Vercel AI SDK UI Message Stream）都是 `data: {...}\n\n` 线格式。
  // 按行切分天然兼容任意分帧/半包/粘包：单换行切分是双换行切分的子集（分隔行是空行，被跳过）。
  // event:/id:/retry: 字段行与注释行（:开头）跳过；JSON 解析失败的行（跨包半行、[DONE]）静默跳过。
  async function readSSE(response, onData) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop(); // 半行留到下一片
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        var ev = null;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev) onData(ev);
      }
    }
  }

  // ---------- 轻量 transcript 状态折叠（纯函数 reducer 思想，对齐 pi client/transcript.ts） ----------
  // state 只由事件驱动；页面渲染只读 state，不再各自散装解析事件。
  // aborted 不来自事件，由消费器在用户停止时直接置位（终态，见 consumeBookStream）。
  function createTranscript() {
    return {
      content: '',            // 正文增量累计（瞬态）
      reasoning: '',          // 思考增量累计（瞬态）
      retrieval: null,        // 语义召回旧文 [{chapter, score, text}]
      tools: [],              // 只读工具调用 [{name, args, result}]
      actions: [],            // 写操作确认卡 [{id, name, args}]
      errors: [],             // 流内错误（已归一为 {message, code?, details?}）
      recovering: 0,          // 断流无缝续写次数
      autoCompact: 0,         // 自动压缩掉的对话条数
      run: null,
      done: false,            // 是否收到 done（权威快照）
      finalContent: null,     // done 携带的全文（权威，覆盖增量累计）
      usage: null,            // done 携带的 usage
      aborted: false,         // 用户停止（部分输出保留在 content 里）
    };
  }

  function foldEvent(state, ev) {
    if (!ev || !ev.type) return state;
    switch (ev.type) {
      case 'retrieval': state.retrieval = ev.hits || []; break;
      case 'tool': state.tools.push({ name: ev.name, args: ev.args, result: ev.result }); break;
      case 'action': state.actions.push({ id: ev.id, name: ev.name, args: ev.args }); break;
      case 'reasoning': state.reasoning += (ev.text || ''); break;
      case 'content': state.content += (ev.text || ''); break;
      case 'recovering': state.recovering += 1; break;
      case 'auto_compact': state.autoCompact += (ev.archived || 0); break;
      case 'done':
        state.done = true;
        if (ev.run) state.run = ev.run;
        if (typeof ev.content === 'string') state.finalContent = ev.content; // 权威快照
        if (typeof ev.reasoning === 'string' && ev.reasoning) state.reasoning = ev.reasoning;
        if (ev.usage) state.usage = ev.usage;
        break;
      case 'error': state.errors.push(normalizeError(ev.error)); break;
    }
    return state;
  }

  // 回调异常隔离：一个回调抛错不传染其他回调、不打断流解析
  function call(fn, args, name) {
    if (typeof fn !== 'function') return;
    try { fn.apply(null, args); }
    catch (e) { console.error('[chat-event-hub] 回调异常（已隔离）：' + (name || 'onEvent'), e); }
  }

  // ---------- 书聊流消费（POST /api/books/:id/chat/stream 协议） ----------
  // handlers（全部可选）：
  //   onDelta(text)          正文增量
  //   onReasoning(text)      思考增量
  //   onTool(t)              只读工具调用 {name, args, result}
  //   onAction(a)            写操作确认卡 {id, name, args}
  //   onRetrieval(hits)      语义召回旧文
  //   onRecovering()         断流无缝续写提示（每流至多回调一次）
  //   onAutoCompact(n)       自动压缩发生
  //   onError(info)          流内错误（{message, code?, details?}）
  //   onDone(ev, state)      done 事件；ev=null 表示流结束但没等到 done（异常断流）
  //   onEvent(ev)            原始事件（向后兼容/扩展）
  // 返回折叠后的 transcript 终态（含 aborted 标志与部分输出）。
  async function consumeBookStream(response, handlers) {
    var h = handlers || {};
    var state = createTranscript();
    var recoveringFired = false;
    try {
      await readSSE(response, function (ev) {
        foldEvent(state, ev);
        switch (ev.type) {
          case 'retrieval': call(h.onRetrieval, [ev.hits || []], 'onRetrieval'); break;
          case 'tool': call(h.onTool, [{ name: ev.name, args: ev.args, result: ev.result }], 'onTool'); break;
          case 'action': call(h.onAction, [{ id: ev.id, name: ev.name, args: ev.args }], 'onAction'); break;
          case 'reasoning': call(h.onReasoning, [ev.text || ''], 'onReasoning'); break;
          case 'recovering':
            if (!recoveringFired) { recoveringFired = true; call(h.onRecovering, [], 'onRecovering'); }
            break;
          case 'content': call(h.onDelta, [ev.text || ''], 'onDelta'); break;
          case 'auto_compact': call(h.onAutoCompact, [ev.archived || 0], 'onAutoCompact'); break;
          case 'error': call(h.onError, [normalizeError(ev.error)], 'onError'); break;
          case 'done': call(h.onDone, [ev, state], 'onDone'); break;
        }
        call(h.onEvent, [ev], 'onEvent');
      });
    } catch (e) {
      if (isAbortError(e)) {
        // 用户停止不是错误：部分输出保留在 state 里，由页面决定如何渲染（pi「中止三定律」之二）
        state.aborted = true;
      } else {
        throw e;
      }
    }
    if (!state.done) call(h.onDone, [null, state], 'onDone');
    return state;
  }

  // ---------- 助手流消费（POST /api/agent/chat，Vercel AI SDK UI Message Stream 协议） ----------
  // 把细粒度 UI-Stream 事件归一为与书聊一致的回调形态，助手页不再自写分帧解析器：
  //   onReasoningStart() / onReasoningDelta(text) / onReasoningEnd()
  //   onDelta(text) / onTextEnd()
  //   onToolCall({toolCallId, toolName, input})
  //   onToolOutput({toolCallId, output})
  //   onToolError({toolCallId, toolName, code, message})  工具被拒绝/失败（含 TOOL_NOT_ALLOWED）
  //   onError(info) / onEvent(part)
  // 返回 {text, aborted, run, toolErrors}：toolErrors 是本轮工具错误（页面据此显示「被拒绝的工具」，
  // 不再靠聊天话术猜为什么没执行）。
  async function consumeAgentStream(response, handlers) {
    var h = handlers || {};
    var text = '';
    var run = null;
    var aborted = false;
    var toolErrors = [];
    var toolNames = {};   // toolCallId -> toolName（SDK 的 tool-output-error 分片不带工具名，靠入参分片补上）
    function toolError(part, kind) {
      var parsed = parseToolErrorText(part.errorText || part.error);
      var info = {
        toolCallId: part.toolCallId || null,
        toolName: part.toolName || (part.toolCallId ? toolNames[part.toolCallId] : null) || null,
        code: parsed.code,
        message: parsed.message,
        kind: kind,
      };
      toolErrors.push(info);
      call(h.onToolError, [info], 'onToolError');
      return info;
    }
    try {
      await readSSE(response, function (part) {
        if (!part || !part.type) return;
        switch (part.type) {
          case 'reasoning-start': call(h.onReasoningStart, [part], 'onReasoningStart'); break;
          case 'reasoning-delta': call(h.onReasoningDelta, [part.delta || ''], 'onReasoningDelta'); break;
          case 'reasoning-end': call(h.onReasoningEnd, [part], 'onReasoningEnd'); break;
          case 'text-delta':
            text += part.delta || '';
            call(h.onDelta, [part.delta || ''], 'onDelta');
            break;
          case 'text-end': call(h.onTextEnd, [part], 'onTextEnd'); break;
          case 'tool-input-available':
            if (part.toolCallId) toolNames[part.toolCallId] = part.toolName || null;
            call(h.onToolCall, [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }], 'onToolCall');
            break;
          case 'tool-input-error':
            toolError(part, 'invalid_input');
            break;
          case 'tool-output-available':
            call(h.onToolOutput, [{ toolCallId: part.toolCallId, output: part.output }], 'onToolOutput');
            break;
          case 'tool-output-error':
            toolError(part, 'tool_error');
            break;
          case 'tool-output-denied':
            toolError(part, 'denied');
            break;
          case 'finish':
            run = part.messageMetadata && part.messageMetadata.run || null;
            if (part.messageMetadata && typeof part.messageMetadata.finalContent === 'string') text = part.messageMetadata.finalContent;
            call(h.onDone, [{ text: text, run: run }], 'onDone');
            break;
          case 'error': call(h.onError, [normalizeError(part.errorText || part.error)], 'onError'); break;
        }
        call(h.onEvent, [part], 'onEvent');
      });
    } catch (e) {
      if (isAbortError(e)) aborted = true;
      else throw e;
    }
    return { text: text, aborted: aborted, run: run, toolErrors: toolErrors };
  }

  // ---------- S2-01：重复请求的 JSON 结果通道 ----------
  // 服务端幂等语义：同 session+requestId 的重试不再给 SSE，而是 JSON
  // { runId, status, duplicate:true, sessionKey }（运行中 202 / 已终结 200）。
  // 消费方先查 Content-Type 再决定走 SSE 还是这条轮询通道——绝不把 JSON 当新 SSE 解析，
  // 更不重发业务请求；原结果从 GET /api/runs/:id/events 回读（事件由服务端顺序编号）。
  function isJsonResponse(res) {
    var ct = (res.headers && res.headers.get('content-type')) || '';
    return ct.indexOf('application/json') >= 0;
  }

  function isActiveStatus(status) {
    return status === 'running' || status === 'awaiting_confirmation';
  }

  function newRequestId(prefix) {
    return (prefix || 'req') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  // 轮询运行事件直到终态。onEvent 收 { runId, seq, type, payload, createdAt }；
  // 网络抖动重试而非失败；用户 abort 以 AbortError 形态抛出（与 SSE 一致）。
  async function waitRunEvents(opts) {
    var o = opts || {};
    var after = o.afterSeq || 0;
    var interval = o.intervalMs || 1500;
    for (;;) {
      if (o.signal && o.signal.aborted) {
        var ae = new Error('等待运行结果时已停止');
        ae.name = 'AbortError';
        throw ae;
      }
      var res = null;
      try {
        res = await fetch('/api/runs/' + encodeURIComponent(o.runId) + '/events?afterSeq=' + after, {
          headers: { 'x-session-key': o.sessionKey || '' },
          signal: o.signal,
        });
      } catch (e) {
        if (isAbortError(e)) throw e;
        await new Promise(function (r) { setTimeout(r, interval); });
        continue; // 轮询通道的网络抖动重试
      }
      if (res.ok) {
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (data) {
          var evs = data.events || [];
          for (var i = 0; i < evs.length; i++) call(o.onEvent, [evs[i]], 'onEvent');
          if (data.nextAfterSeq != null) after = data.nextAfterSeq;
          if (data.status && !isActiveStatus(data.status)) return { status: data.status };
        }
      } else if (res.status === 404 || res.status === 403) {
        throw await parseResponseError(res, '无法读取运行结果');
      }
      await new Promise(function (r) { setTimeout(r, interval); });
    }
  }

  window.ChatEventHub = {
    error: error,
    parseErrorBody: parseErrorBody,
    parseResponseError: parseResponseError,
    normalizeError: normalizeError,
    parseToolErrorText: parseToolErrorText,
    createAbort: createAbort,
    isAbortError: isAbortError,
    readSSE: readSSE,
    createTranscript: createTranscript,
    foldEvent: foldEvent,
    consumeBookStream: consumeBookStream,
    consumeAgentStream: consumeAgentStream,
    isJsonResponse: isJsonResponse,
    isActiveStatus: isActiveStatus,
    newRequestId: newRequestId,
    waitRunEvents: waitRunEvents,
  };
})();
