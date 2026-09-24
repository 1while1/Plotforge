// 上下文预算器（对齐 pi：token 估算仅用于预算/压缩触发，有上游 usage 时一律以 API 返回为准）
// 两套估算并存：
//  - estimateText / estimateMessages：chars/4 粗略估算，服务 compactBook / context-status 兜底显示（保守、沿用已久）
//  - estimateTokens / estimateMessagesTokens：CJK 感知启发式（中文≈0.7 token/字），服务 assemble() 全局 token 预算，
//    比 chars/4 更贴近中文真实 token 占用（chars/4 对中文低估约 4~6 倍）
// M1 收敛层（W17 双轨制的对齐 pi 方案）：
//  - estimateContextUsage：usage 锚点估算——前段用 provider 真实计费、仅锚点后增量 chars/4，
//    有 usage 时它是会话占用估算的首选入口；无 usage 自动退化为 CJK 全量估算（现状兜底）

/**
 * CJK 感知的 token 估算：中文/日文等 CJK 码点按 0.7 token/字，其余字符按 1/4 token/字。
 * @param {string} text
 * @returns {number} Math.ceil；异常输入返回 0
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const isCJK =
      (c >= 0x3040 && c <= 0x30ff) || // 日文平/片假名
      (c >= 0x3400 && c <= 0x4dbf) || // CJK 扩展 A
      (c >= 0x4e00 && c <= 0x9fff) || // CJK 基本汉字
      (c >= 0xac00 && c <= 0xd7af) || // 韩文音节
      (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容汉字
      (c >= 0x20000 && c <= 0x2a6df); // CJK 扩展 B
    if (isCJK) cjk++; else other++;
  }
  return Math.ceil(cjk * 0.7 + other / 4);
}

/**
 * 消息数组的 CJK 感知估算（结构同 estimateMessages，改用 estimateTokens）。
 * @param {Array<{role:string, content?:any, tool_calls?:Array<{function:{name:string, arguments:string}}>}>} messages
 * @returns {number}
 */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (typeof c === 'string') {
      total += estimateTokens(c);
    } else if (Array.isArray(c)) {
      total += estimateTokens(c.map(b => (b && typeof b.text === 'string') ? b.text : '').join(''));
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const f = tc && tc.function;
        if (!f) continue;
        total += estimateTokens(String(f.name || '')) + estimateTokens(String(f.arguments || ''));
      }
    }
  }
  return total;
}

/**
 * 单段文本估算 token 数（粗略 chars/4，向后兼容）
 * @param {string} text
 * @returns {number} Math.ceil(chars / 4)；异常输入返回 0
 */
function estimateText(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * 消息数组估算（OpenAI chat 格式：{role, content, tool_calls?}）
 * - content 为字符串 → estimateText(content)
 * - content 为 null/undefined → 0
 * - content 为数组 → 拼接各元素 text 字段后估算
 * - 含 tool_calls 时每条追加各 tool_call 的 function.name + function.arguments 长度
 * @param {Array<{role:string, content?:any, tool_calls?:Array<{function:{name:string, arguments:string}}>}>} messages
 * @returns {number}
 */
function estimateMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (typeof c === 'string') {
      total += estimateText(c);
    } else if (Array.isArray(c)) {
      total += estimateText(c.map(b => (b && typeof b.text === 'string') ? b.text : '').join(''));
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const f = tc && tc.function;
        if (!f) continue;
        total += estimateText(String(f.name || '')) + estimateText(String(f.arguments || ''));
      }
    }
  }
  return total;
}

/**
 * usage 锚点估算（对齐 pi ai/src/utils/estimate.ts:63-103 的 ContextUsageEstimate）：
 * 会话占用的首选估算入口——锚点之前的头部大头用 provider 真实计费，仅对锚点之后的
 * 增量消息走 chars/4 粗估，把估算误差限制在尾部小区间（中文系数只在无 usage 的兜底分支起作用）。
 * 锚点 = 数组中最后一条 assistant 消息；lastUsage 视为产生该消息那次调用的真实 usage
 * （prompt_tokens 覆盖其前全部输入，completion_tokens 即该回复本体，两者相加 ≈ 锚点处的会话体积）。
 * @param {Array<{role:string, content?:any, tool_calls?:Array<{function:{name:string, arguments:string}}>}>} messages
 * @param {{promptTokens:number, completionTokens?:number}|null|undefined} lastUsage
 *   台账最近一条有效 usage（llm_calls 行经 llm.sessionUsageEstimate 映射）
 * @returns {{tokens:number, usageTokens:number, trailingTokens:number, anchored:boolean, anchorIndex:number}}
 *   anchored=false（无 usage / promptTokens 无效 / 无 assistant 消息可作锚点）时，
 *   tokens = estimateMessagesTokens(messages)（CJK 感知全量估算，即现状兜底行为）
 */
function estimateContextUsage(messages, lastUsage) {
  const empty = { tokens: 0, usageTokens: 0, trailingTokens: 0, anchored: false, anchorIndex: -1 };
  if (!Array.isArray(messages) || messages.length === 0) return empty;
  const promptTokens = Number(lastUsage && lastUsage.promptTokens);
  const completionTokens = Number(lastUsage && lastUsage.completionTokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    // 无有效 usage：退化为现状行为（CJK 感知全量估算），供压缩触发/仪表兜底
    return { tokens: estimateMessagesTokens(messages), usageTokens: 0, trailingTokens: 0, anchored: false, anchorIndex: -1 };
  }
  let anchorIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') { anchorIndex = i; break; }
  }
  if (anchorIndex < 0) return { tokens: estimateMessagesTokens(messages), usageTokens: 0, trailingTokens: 0, anchored: false, anchorIndex: -1 };
  const usageTokens = Math.ceil(promptTokens) + (Number.isFinite(completionTokens) && completionTokens > 0 ? Math.ceil(completionTokens) : 0);
  const trailingTokens = estimateMessages(messages.slice(anchorIndex + 1)); // 尾部增量：chars/4（对齐 pi）
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, anchored: true, anchorIndex };
}

module.exports = { estimateText, estimateMessages, estimateTokens, estimateMessagesTokens, estimateContextUsage };
