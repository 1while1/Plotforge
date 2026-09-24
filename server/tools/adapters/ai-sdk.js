const { loadSDK } = require('../../agent/sdk');
const { listTools, promptDescription } = require('../registry');
const { withBookScope } = require('./openai');
const { executeForModel } = require('../executor');
const { serializeToolError } = require('../loop-helpers');

// S4-05 / G3 已知边界 4：AI SDK 的 UI 流默认把任何错误压成通用文案
// （ai@6 的 `onError = () => "An error occurred."`，是防泄漏的默认值），于是 discuss 模式里
// 模型请求写工具时 TOOL_NOT_ALLOWED 这类结构化码既到不了前端、也看不清原因，模型会反复重试到
// 步数耗尽。这里给出一份「带码、可展示、不泄漏」的错误文案：
//   · 分片格式 `[CODE] 说明`——前端 chat-event-hub 按同一约定拆回 code/message；
//   · 未知工具（NoSuchToolError）的语义就是「该模式工具面里没有这个工具」＝只读讨论拒写工具；
//   · 只给工具名与原因：不带 SDK 的 available tools 列表、不带堆栈/SQL，任何 sk- 串掩码。
const SECRET_LIKE = /sk-[A-Za-z0-9_\-]{6,}/g;

function safeText(value, max) {
  const text = String(value == null ? '' : value).replace(SECRET_LIKE, 'sk-…').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// 交给 StreamTextResult.pipeUIMessageStreamToResponse({ onError })。
// Agent 入口的错误表、前端可见文案与「模型看到什么」都从这一处走，语义单一。
function toolErrorText(error) {
  if (!error) return '[TOOL_EXECUTION_FAILED] 工具调用失败';
  const name = safeText(error.name || '', 64);
  const message = safeText(error.message || '', 200);
  const toolName = error.toolName ? safeText(error.toolName, 64) : '';
  if (/NoSuchToolError/.test(name) || /unavailable tool/i.test(message)) {
    return '[TOOL_NOT_ALLOWED] 工具 ' + (toolName ? '"' + toolName + '" ' : '')
      + '不在当前模式可用的工具面内（只读讨论不加载写工具；写操作需要作者明确的执行请求，仍会走确认）。未执行任何写入。';
  }
  if (/InvalidToolInputError/.test(name)) {
    return '[INVALID_ARGS] 工具 ' + (toolName ? '"' + toolName + '" ' : '') + '的参数不合法：'
      + (message || '参数校验未通过');
  }
  const serialized = serializeToolError(error, toolName);
  return '[' + serialized.code + '] ' + safeText(serialized.message || '工具执行失败', 200);
}

function schemaToZod(schema, z) {
  if (!schema || schema.type === undefined) return z.any();
  if (schema.enum) return z.enum(schema.enum);
  if (schema.type === 'string') {
    let value = z.string();
    if (schema.minLength) value = value.min(schema.minLength);
    return value;
  }
  if (schema.type === 'integer') {
    let value = z.number().int();
    if (schema.minimum !== undefined) value = value.min(schema.minimum);
    if (schema.maximum !== undefined) value = value.max(schema.maximum);
    return value;
  }
  if (schema.type === 'number') return z.number();
  if (schema.type === 'boolean') return z.boolean();
  if (schema.type === 'array') return z.array(schemaToZod(schema.items || {}, z));
  if (schema.type === 'object') {
    const required = new Set(schema.required || []);
    const shape = {};
    for (const [key, child] of Object.entries(schema.properties || {})) {
      const parsed = schemaToZod(child, z);
      shape[key] = required.has(key) ? parsed : parsed.optional();
    }
    return schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape);
  }
  return z.any();
}

async function toAISDKTools(profile = 'agent', baseContext = {}) {
  const { tool, z } = await loadSDK();
  const result = {};
  for (const descriptor of listTools(profile)) {
    const schema = withBookScope(descriptor.inputSchema, profile, descriptor.scope);
    result[descriptor.name] = tool({
      // M6 三层化：LLM 常驻工具面只放 snippet/首句短描述，完整说明留在 descriptor.description
      description: promptDescription(descriptor),
      inputSchema: schemaToZod(schema, z),
      execute: async (args, execOpts = {}) => {
        const execute = () => executeForModel(
          { ...baseContext, profile }, descriptor.name, args,
          { toolCallId: execOpts.toolCallId, signal: execOpts.abortSignal, onUpdate: execOpts.onUpdate }
        );
        // S3-02：可选观察钩子——Agent 会话侧据此把服务端工具事件持久化为可信证据。
        // 只观察不干预：异常隔离，绝不影响工具执行结果本身。
        const out = await (baseContext.runGate ? baseContext.runGate.execute(descriptor.name, execute, execOpts.abortSignal) : execute());
        if (typeof baseContext.onToolResult === 'function') {
          try { baseContext.onToolResult(descriptor.name, args, out); } catch (_) { /* 观察失败不阻断 */ }
        }
        return out;
      },
    });
  }
  return result;
}

function descriptorSchemas(profile = 'agent') {
  return listTools(profile).map(tool => ({
    name: tool.name,
    schema: withBookScope(tool.inputSchema, profile, tool.scope),
  }));
}

module.exports = { toAISDKTools, schemaToZod, descriptorSchemas, toolErrorText };
