const { listTools, promptDescription } = require('../registry');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withBookScope(schema, profile, scope) {
  const out = clone(schema);
  // S3-05：agent-discuss 与 agent 同为跨书入口（global 会话只读找书）——书内工具
  // 一律显式带 book_id，不因只读而隐式回落当前书
  if ((profile === 'agent' || profile === 'agent-discuss') && scope === 'book') {
    out.properties = { book_id: { type: 'integer', minimum: 1 }, ...(out.properties || {}) };
    out.required = [...new Set(['book_id', ...(out.required || [])])];
  }
  return out;
}

// 工具清单的 LLM 序列化（M6 三层化）：description 字段只放 snippet/首句短描述——
// 这份清单随每条写作请求常驻（上游 prompt_tokens 含 tools 定义），完整说明留在
// registry descriptor.description（确认卡与人工核对用），使用守则由 TOOL_GUIDE 承担。
function toOpenAITools(profile = 'writing') {
  return listTools(profile).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: promptDescription(tool),
      parameters: withBookScope(tool.inputSchema, profile, tool.scope),
    },
  }));
}

module.exports = { toOpenAITools, withBookScope };
