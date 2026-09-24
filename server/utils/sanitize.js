// 泄漏工具标记清洗：某些模型（agnes 实测、其它模型也可能）会把工具调用标记当正文吐出来。
// 窄口径、保守——只删「已知工具标签名白名单」命中的标记，绝不误伤正文（中文、以及正文里的
// 数学小于号如「3 < 5」、变量比较如「x<y」都必须原样保留）。
'use strict';

// 已知工具标签名白名单（不含尖括号/斜杠，供拼正则；大小写不敏感匹配）
const TOOL_TAG_NAMES = [
  'tool_call', 'tool_calls', 'tool_response', 'tool_result', 'tool_code',
  'function_call', 'function_calls', 'function', 'invoke', 'parameter',
  'antml:invoke', 'antml:parameter', 'antml:function_calls',
];
// 正则片段：匹配上述任一标签名（转义冒号，词边界收尾避免误配 tool_callxx）
const TAG = TOOL_TAG_NAMES.map(n => n.replace(':', '\\:')).join('|');

// 推理块标签（2026-09-10 实测）：聚合渠道会把思考块边界漏进正文通道——agnes 在同一次
// 回复里于两段正文之间夹了一个孤立 </think>。这类标签与工具标记同属通道泄漏，正文里
// 出现即异常（中文叙事不会写出这些标签），故成对块整体删除、孤立标签只删标签本身。
const REASONING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'analysis'];
const PAIRED_REASONING = /<(?:think|thinking|reasoning|analysis)(?:[\s=][^<>]*?)?>[\s\S]*?<\/(?:think|thinking|reasoning|analysis)\s*>/gi;
const STRAY_REASONING_TAG = /<\/?(?:think|thinking|reasoning|analysis)\s*\/?>/gi;

// 1) 成对标记块：<tag ...> ... </tag> 或畸形 <tag=...> ... </tag>（非贪婪，跨行）
const PAIRED_TAG = new RegExp(
  '<(' + TAG + ')(?:[\\s=][^<>]*?)?>[\\s\\S]*?<\\/\\1\\s*>',
  'gi'
);
// 2) 三反引号围栏块：```tool_code ... ``` / ```tool_call ... ```（语言标注命中白名单）
const FENCED = new RegExp(
  '```[ \\t]*(?:' + TAG + ')[ \\t]*\\r?\\n[\\s\\S]*?```',
  'gi'
);
// 3) 尾部未闭合的残缺标记：PAIRED 已删掉成对块，剩下的 <标签（后跟 =/空格/>// 或即到结尾）
//    视为泄漏起点，从它截到结尾（Run4 实测 agnes 在正文尾部吐这种残缺 XML）
const TRAILING_OPEN_TAG = new RegExp(
  '<(?:' + TAG + ')(?:[\\s=>/][\\s\\S]*)?$',
  'i'
);
// 4) 未闭合围栏在函数内用「``` 计数为奇数」判定（避免误删已闭合的普通代码块）

// 清洗泄漏的工具标记；返回 { text, stripped }
//   text    —— 清洗后正文（去掉首尾空白）
//   stripped —— 是否删过东西（布尔）。若清洗后为空/纯空白，调用方据此触发「无工具重生成」兜底，而非保存空正文
function sanitizeLeakedToolMarkup(text) {
  if (typeof text !== 'string' || !text) return { text: text || '', stripped: false };
  const before = text;
  let out = text;
  out = out.replace(PAIRED_TAG, '');
  out = out.replace(FENCED, '');
  out = out.replace(TRAILING_OPEN_TAG, '');
  out = out.replace(PAIRED_REASONING, '');
  out = out.replace(STRAY_REASONING_TAG, '');
  // 未闭合围栏：仅当 ``` 出现奇数次（有开无合）时，从最后一个 ``` 截到结尾
  const fenceCount = (out.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) out = out.slice(0, out.lastIndexOf('```'));
  // 删标记后可能留下多余空行，收敛 3+ 连续换行为 2 个，并去首尾空白
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, stripped: out !== before.trim() };
}

module.exports = { sanitizeLeakedToolMarkup, TOOL_TAG_NAMES, REASONING_TAG_NAMES };
