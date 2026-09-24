// Agent 模型工厂：复用项目现有多渠道配置（settings 表 / apikey 文件兜底）
// 免费渠道 apiKey 为空时不传，createOpenAICompatible 不会加 Authorization 头。
const llm = require('../llm');
const { loadSDK } = require('./sdk');

// provider 名即 AI SDK 的 providerOptions 命名空间键（SDK 读 providerOptions[name] 与
// 驼峰 providerOptions[toCamelCase(name)]）；写成别的名字（如 openaiCompatible）会被静默
// 丢弃——渠道字段从未出网（G2 独立审查 P1 实证：构造器测试全绿而出网体无字段）。
const PROVIDER_NAME = 'novel-agent';

async function getModel() {
  const { createOpenAICompatible } = await loadSDK();
  const { baseUrl, apiKey, model } = llm.llmConfig();
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: baseUrl,
    apiKey: apiKey || undefined,
  });
  return { model: provider(model), modelName: model, baseUrl };
}

module.exports = { getModel, PROVIDER_NAME };
