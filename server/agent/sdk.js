// Vercel AI SDK 是 ESM-only，本文件用动态 import 桥接进 CommonJS 项目。
// 缓存加载结果，全进程只加载一次。
let cache = null;

async function loadSDK() {
  if (cache) return cache;
  const [ai, oc, zod] = await Promise.all([
    import('ai'),
    import('@ai-sdk/openai-compatible'),
    import('zod'),
  ]);
  cache = {
    streamText: ai.streamText,
    generateText: ai.generateText,
    tool: ai.tool,
    stepCountIs: ai.stepCountIs,
    createOpenAICompatible: oc.createOpenAICompatible,
    z: zod.z,
  };
  return cache;
}

module.exports = { loadSDK };
