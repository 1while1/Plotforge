// 深度思考开关的唯一实现（G2 独立审查 P2-3：此前 llm.js 与 runtime/model-options.js
// 各写一份 thinkingDisabledModel，「单一权威构造器」名不副实——两份逻辑漂移时
// 写作网关与 Agent 入口对同一 settings 会打出不同请求体）。本模块两个入口共用：
//   · llm.js 的 applyThinkingMode（网关就地补字段）
//   · runtime/model-options.js 的 buildModelOptions（requestOverrides）
//
// 渠道参数实测结论（报告 21-写文章卡死诊断.md）：enable_thinking:false 是唯一
// 被实测生效的关思考字段（reasoning_effort/chat_template_kwargs 被静默忽略或 400）。
// 不同网关对未知字段容忍度不同，故默认关闭：只有点名的模型才带该字段，
// `*` 对所有模型生效，空值 = 与历史行为逐位一致。
//
// 读设置失败（库未初始化/纯网关单测不建库）一律按「不干预」处理：可选增强绝不能
// 把正常 LLM 请求打死。
const THINKING_OFF_FIELD = 'enable_thinking';
const THINKING_OFF_SETTING = 'disable_thinking_models';

function listFromRaw(raw) {
  return String(raw || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

// 名单匹配：大小写不敏感，`*` 通配；未配置/空名单 = 不干预
function matchesList(model, list) {
  if (!list.length) return false;
  const m = String(model || '').toLowerCase();
  return m !== '' && list.some((p) => p === '*' || p.toLowerCase() === m);
}

// 从库读名单判定（读失败按不干预）
function thinkingDisabledModel(model) {
  let raw = '';
  try {
    const db = require('../db');
    const row = db.get('SELECT value FROM settings WHERE key = ?', [THINKING_OFF_SETTING]);
    raw = row ? (row.value || '') : '';
  } catch { return false; }
  return matchesList(model, listFromRaw(raw));
}

// 就地补字段：调用方无需改写法（所有请求体都带 model 字段）
function applyThinkingMode(body) {
  if (body && typeof body === 'object' && thinkingDisabledModel(body.model)) body[THINKING_OFF_FIELD] = false;
  return body;
}

module.exports = { THINKING_OFF_FIELD, THINKING_OFF_SETTING, listFromRaw, matchesList, thinkingDisabledModel, applyThinkingMode };
