// 回复意图判定（写作聊天）：服务器为每条助手回复打一个确定性 intent 标签，
// 前端据此决定是否提供「插入章节」入口——只有 prose（模型直接产出的可插正文）才给，
// 讨论/操作结果/待确认话术一律不给，避免把点评当正文插进章节。
//
// 判定只依赖本轮已存在的事实（resumed / 用户原话 / 工具事实 / 运行态 / 待确认动作数），
// 不看模型输出正文（正文长度/语气都不是可靠信号），因此同一输入必然同一结论。
const PROSE_IMPERATIVE_RE = /^(?:请|麻烦|帮我|给我|你)?\s*(?:直接|再|重新|继续|接着|往下)?\s*(?:续写|重写|改写|扩写|润色|写(?=一(?:段|章|场|篇|版|个)|第[一二三四五六七八九十百千\d]+(?:章|段|节)|点|下|些|出|成|得|完|正文|小说|故事|场景|对话|情节))/u;
const PROSE_REQUEST_RE = /(?:帮我|给我|请你?|麻烦你?)(?:直接|再|重新|继续|接着)?(?:续写|重写|改写|扩写|润色|写(?=一(?:段|章|场|篇|版|个)|第[一二三四五六七八九十百千\d]+(?:章|段|节)|点|下|些|出|成|得|完|正文|小说|故事|场景|对话|情节))/u;
const PROSE_CONTINUE_RE = /^(?:继续|接着|续写|然后呢|往下|下一段)[。！!.…~～]*$/u;
const DISCUSSION_RE = /为什么|怎么样|怎么看|如何|分析|点评|评价|检查|问题|建议|意见|看法|觉得|对比|总结|梳理|解释|[?？]/u;
const PROSE_WEAK_RE = /续写|接着写|继续写|往下写|写下去|写一段|写一章|扩写|改写|重写/u;
const RESUME_EVENT_PREFIX = '[确认执行结果';

// 写工具判定：走注册表 descriptor.mutation（'read' | 'write' | 'archive'）。
// 未注册的名字（历史数据/拼写漂移）不抛错，按非写工具处理。
function isWriteTool(name) {
  try {
    const d = require('../tools/registry').descriptor(name);
    return !!d && d.mutation !== 'read';
  } catch { return false; }
}

function classifyReplyIntent({ userText, resumed, facts, runState, hasPendingAction } = {}) {
  if (resumed === true) return 'operation';
  const text = String(userText == null ? '' : userText).trim();
  if (text.startsWith(RESUME_EVENT_PREFIX)) return 'operation';
  if ((runState && runState.status === 'awaiting_confirmation') || hasPendingAction) return 'operation';
  if ((Array.isArray(facts) ? facts : []).some(f => isWriteTool(f && f.name))) return 'operation';
  // 祈使句式优先于疑问词：『帮我写一段吵架戏，可以吗？』是点单不是讨论。
  if (PROSE_IMPERATIVE_RE.test(text) || PROSE_REQUEST_RE.test(text) || PROSE_CONTINUE_RE.test(text)) return 'prose';
  if (DISCUSSION_RE.test(text)) return 'discussion';
  // 弱写作信号（句中提及续写/改写）：讨论判据未命中才落到这里。
  if (PROSE_WEAK_RE.test(text)) return 'prose';
  return 'unknown';
}

module.exports = {
  classifyReplyIntent, isWriteTool,
  PROSE_IMPERATIVE_RE, PROSE_REQUEST_RE, PROSE_CONTINUE_RE, DISCUSSION_RE, PROSE_WEAK_RE, RESUME_EVENT_PREFIX,
};
