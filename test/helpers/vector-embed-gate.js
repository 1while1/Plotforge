// S5-04 测试设施：可控暂停的 embedding 调用。
//
// 为什么需要它：indexer.indexChapter 的真实竞态窗口就是 `await embed(...)`（本地 bge 模型
// 逐块推理，每块一次异步调用）。测试无法依赖真实模型与真实时序，因此把 embed 换成
// 「调用即挂起、由测试显式释放」的桩，精确复现「开始索引 A → 索引期间来源变化 → 释放 A」。
//
// 关键约束：indexer 在模块加载时解构 `const { embed } = require('./embed')`，因此**必须在
// require indexer 之前**替换 embed 模块的导出，并清掉 indexer 的 require 缓存重新加载。
// 每个测试调用一次 installEmbedGate()，t.after(restore) 还原，避免污染其它用例。
const embedModule = require('../../server/vector/embed');

const indexerPath = require.resolve('../../server/vector/indexer');
const DEFAULT_VECTOR = new Float32Array([1, 0, 0, 0]);

function installEmbedGate() {
  const calls = [];
  let autoVector = null; // releaseAll 之后：调用即返回，避免多块正文的后续 embed 再次挂起
  const original = embedModule.embed;
  embedModule.embed = text => {
    const call = { text, resolve: null, reject: null };
    calls.push(call);
    if (autoVector) return Promise.resolve(autoVector);
    return new Promise((resolve, reject) => {
      call.resolve = vector => resolve(vector || DEFAULT_VECTOR);
      call.reject = reject;
    });
  };
  delete require.cache[indexerPath];
  const indexer = require(indexerPath);
  return {
    indexer,
    calls,
    // 放行指定的一次 embed 调用（精确控制时序的用例用这个）
    release(index = 0, vector) {
      const call = calls[index];
      if (!call) throw new Error(`没有第 ${index} 次 embed 调用可释放`);
      if (call.resolve) call.resolve(vector);
    },
    // 放行当前与后续所有 embed 调用（只验证主路径、不关心时序的用例用这个）
    releaseAll(vector) {
      autoVector = vector || DEFAULT_VECTOR;
      calls.forEach(call => { if (call.resolve) call.resolve(vector); });
    },
    fail(index, err) {
      const call = calls[index];
      if (!call) throw new Error(`没有第 ${index} 次 embed 调用可失败`);
      if (call.reject) call.reject(err || new Error('测试注入：embedding 失败'));
    },
    restore() {
      // 清理语义：先放掉仍未释放的调用，避免断言失败后留下悬挂的 await（真实请求会挂住事件循环，
      // 单测里表现为「测试进程不退出」而不是「测试失败」）
      calls.forEach(call => { if (call.resolve) call.resolve(); });
      embedModule.embed = original;
      delete require.cache[indexerPath];
    },
  };
}

// 有界轮询：等待异步索引任务推进到某个可观察状态（单测里不用裸 sleep 猜时序）
async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${message}`);
}

// 单测出网守卫（S5-04）：只放行本机测试服务器的 HTTP 调用，任何外部地址立即失败。
// 规程要求本阶段真实模型渠道零调用——单测里宁可直接炸掉，也不要静静打真实端点
// （server/llm.js 的默认 base_url 指向外部地址，一次误触发的后台任务就够出网）。
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

function guardOutboundFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!LOCAL_URL.test(url)) throw new Error(`S5-04 单测禁止出网：${String(url).slice(0, 80)}`);
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

module.exports = { installEmbedGate, waitFor, guardOutboundFetch, DEFAULT_VECTOR };
