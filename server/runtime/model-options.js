// S2-05 / C11：模型选项单一权威构造器。
// 此前两个入口各写各的：写作网关（llm.js postChat）在请求体上就地打
// enable_thinking；Agent（ai SDK）只有裸 maxOutputTokens:8000，既没有思考开关、
// 也没有按模型窗口给输出预算——同一本书、同一渠道，两种请求体口径。
//
// 本模块只做「配置映射」集中：按 operation 决定输出预算、按 settings 的
// disable_thinking_models 决定是否下发思考关闭字段、统一 abort 信号装配。
// 不更换供应商、不升级 SDK、不改网关既有重试语义。
//
// SDK 出网字段传递方式（本地安装的 @ai-sdk/openai-compatible 实测）：
// providerOptions 里 SDK 实际读取的命名空间是 providerOptionsName（本仓 'novel-agent'，
// 由 server/agent/model.js 导出同源派生）及其驼峰键；写成别的名字（如
// openaiCompatible）会被静默丢弃、字段从未出网（G2 审查 P1 实证+红测）。
const runPolicy = require('../chat/run-policy');

// 输出预算口径与 llm.js outputTokenBudget 完全一致（单一事实源，勿各写各的）
const OUTPUT_TOKEN_FLOOR = 4096;
const OUTPUT_TOKEN_CEIL = 16000;
const { resolveContextWindow } = require('../llm');
// G2 审查 P2-3：思考开关名单匹配与 llm.js 共用同一实现（server/runtime/thinking-mode），
// 不再各写一份——两份漂移时两个入口对同一 settings 会打出不同请求体。
const { THINKING_OFF_SETTING, listFromRaw, matchesList, thinkingDisabledModel } = require('./thinking-mode');

function outputBudgetFor(model, operation) {
  let win = 0;
  try {
    win = resolveContextWindow(model);
  } catch {
    win = 0; // 库未初始化（纯网关单测不建库）：走兜底下限，绝不因预算查询打死请求
  }
  const base = Math.min(OUTPUT_TOKEN_CEIL, Math.max(OUTPUT_TOKEN_FLOOR, win ? Math.floor(win / 8) : OUTPUT_TOKEN_FLOOR));
  if (operation === 'agent') {
    // Agent 单步产出（工具调用+短说明）远小于整章正文：步数预算已由 run-policy 管，
    // 这里按写作的一半给足，同时不低于 floor（思考+工具参数同样吃 max_tokens）。
    return Math.max(OUTPUT_TOKEN_FLOOR, Math.floor(base / 2));
  }
  return base;
}

function thinkingDisabledModelFromSettings(model, settingsList) {
  return matchesList(model, listFromRaw(settingsList));
}

// 唯一权威构造器：operation ∈ 'chat' | 'agent'。
// 返回 { requestOverrides, maxOutputTokens, timeoutMs, signal }——
//   · requestOverrides 只含允许字段（模型在 disable 名单内才有 enable_thinking:false；
//     未配置时对象为空，两边都「不额外注入」，与历史行为逐位一致）；
//   · maxOutputTokens 由同一函数按 operation 决定、可解释；
//   · timeoutMs/signal 供网关与 SDK 统一装配（SDK 不叠加第二层无限重试）。
function buildModelOptions({ model, settings, operation, signal } = {}) {
  const op = operation === 'agent' ? 'agent' : 'chat';
  const settingsList = settings && settings[THINKING_OFF_SETTING] !== undefined
    ? String(settings[THINKING_OFF_SETTING])
    : null;
  const requestOverrides = {};
  const disabled = settingsList !== null
    ? thinkingDisabledModelFromSettings(model, settingsList)
    : thinkingDisabledModel(model);
  if (disabled) requestOverrides.enable_thinking = false;
  return {
    requestOverrides,
    maxOutputTokens: outputBudgetFor(model, op),
    timeoutMs: runPolicy.DEFAULT_MAX_DURATION_MS,
    signal: signal || null,
  };
}

module.exports = { buildModelOptions, OUTPUT_TOKEN_FLOOR, OUTPUT_TOKEN_CEIL };
