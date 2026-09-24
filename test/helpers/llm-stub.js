// M5：LLM fetch 边界剧本化 mock —— 核心循环（chat.js 工具循环/纠正轮/护栏）单测的共享设施。
// 零真实网络：只拦截 /chat/completions（其余 URL 透传原 fetch），key 一律 sk-test-xxx，
// 端点为占位 http://llm-stub.local。
//
// 为什么 mock 点在 global.fetch 而不是替换 server/llm.js 导出（M5 决策，详见
// docs/report/20260911_pi借鉴改造/M5-循环可测性/3-怎么优化的.md）：
//  1) chat.js 在 require 时就解构了 llm 导出（chat.js 顶部 const { fetchChatCompletion, ... } = require('../llm')），
//     事后 patch 模块导出拦不到任何调用；先改缓存再 require 又依赖加载顺序，脆弱；
//  2) fetchChatCompletion 的全部流量（流式/非流式/重试）都过 global fetch（llm.js 唯一 fetch 点），
//     是天然咽喉——保住真实 SSE 解析（readChatSSEStream）、断流/abort 桥接与终局护栏
//     （chat/stream-guards）全部在环内，mock 只替代「上游模型说什么」这一层；
//  3) 与 M3 test/chat-abort.test.js 同一 mock 习惯用法（idiom），不引入第二套 mock 方言。
// 对齐 pi agent/test/agent-loop.test.ts 的 MockAssistantStream：剧本按调用序排队，
// 耗尽即抛错（意外的额外 LLM 调用本身就是断言失败）。

const enc = (s) => new TextEncoder().encode(s);

// 安装 fetch 计数 mock：calls 记录每次 LLM 请求（url/body/init），responders 按序消费。
// body 已 JSON.parse——剧本断言直接读「模型实际看到的上下文」（对齐 pi 断言第二次
// 调用 context 的做法）。
function installFetchStub() {
  const orig = global.fetch;
  const calls = [];
  const responders = []; // 队列：每个 () => Response | Promise；耗尽即抛错（不该发生）
  global.fetch = async (url, init) => {
    if (!String(url).includes('/chat/completions')) return orig(url, init);
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null, init });
    const respond = responders.shift();
    if (!respond) throw new Error('fetch stub exhausted: 意料之外的额外 LLM 调用');
    return respond(init);
  };
  return {
    calls,
    responders,
    restore: () => { global.fetch = orig; },
  };
}

// 流式 SSE 响应（web ReadableStream，与 undici res.body 同具 getReader/cancel）：
// frames 为 OpenAI 兼容 chunk 对象数组，末尾自动补 data: [DONE]。
function sseStub(frames) {
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc(`data: ${JSON.stringify(f)}\n\n`));
      controller.enqueue(enc('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

// 非流式 JSON 响应（followUp/纠正轮等 postChat → res.json() 路径）
function jsonStub(data) {
  return { ok: true, status: 200, json: async () => data };
}

// 非流式 chat.completions 载荷构造：纯文本 / 工具调用 / reasoning 任意组合
function chatPayload({ content = '', reasoning = '', toolCalls = null, finish = 'stop', usage } = {}) {
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;
  return { choices: [{ message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

// 工具调用对象（OpenAI 格式）
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// 悬挂的非流式响应：永不 resolve，直到 init.signal abort 才 reject（模拟慢 LLM，尊重取消）
function hangingNonStream(init) {
  return new Promise((resolve, reject) => {
    const s = init && init.signal;
    const abortErr = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); };
    if (!s) return reject(new Error('stub: 无 signal，无法模拟慢流'));
    if (s.aborted) return abortErr();
    s.addEventListener('abort', abortErr, { once: true });
  });
}

// 悬挂的 SSE：吐一帧后保持打开（模拟生成中的慢流；服务端 abort 时读端自会 cancel）
function hangingSse(firstText = '正在写。') {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [{ delta: { content: firstText } }] })}\n\n`));
      /* 不 close：模拟生成中的慢流 */
    },
  });
  return { ok: true, status: 200, body };
}

async function waitUntil(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise(r => setTimeout(r, 25));
  }
}

// 读完 SSE 响应并解析为事件数组（data: 行 → JSON 对象）
async function readStreamEvents(res) {
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

module.exports = {
  installFetchStub,
  sseStub,
  jsonStub,
  chatPayload,
  toolCall,
  hangingNonStream,
  hangingSse,
  waitUntil,
  readStreamEvents,
};
