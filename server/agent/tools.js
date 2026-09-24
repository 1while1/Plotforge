// 兼容入口：Agent 工具由统一 registry + AI SDK adapter 生成，不再维护第二套业务实现。
const { toAISDKTools } = require('../tools/adapters/ai-sdk');

async function buildTools(context = {}) {
  // S3-05：discuss=只读工具面（agent-discuss）；execute=完整 agent 面（写操作仍走确认）
  const profile = context.mode === 'discuss' ? 'agent-discuss' : 'agent';
  return toAISDKTools(profile, {
    sessionId: context.sessionId || 'agent:anonymous',
    model: context.model || '',
    source: 'agent',
    actor: context.actor || 'author',
    runGate: context.runGate,
    settledAction: context.settledAction,
    // S2-02：确认卡创建时快照发起运行 id（中断恢复可关联展示）
    runId: context.runId || null,
    // A-4：运行所属会话 id——只读工具（如规划笔记）据此把范围收在「本会话」。
    // runAgent 的 context 里已有该字段（routes/agent.js 注入），但本函数是白名单式重建，
    // 不显式带上就会在这里丢掉（实测：漏掉时列表工具拿不到会话范围，返 NOTE_SCOPE_REQUIRED）。
    conversationId: context.conversationId || null,
    // S3-02：服务端工具事件观察（会话证据持久化）
    onToolResult: context.onToolResult || null,
    // S3-05：discuss 只读约束传给执行器（executeForModel 内 ensureAllowed 二次校验）
    profile,
  });
}

module.exports = { buildTools };
