// 工具循环共享原语（对齐 pi：两条会话循环复用同一套截断/错误/消息构造，消除分叉）
// 此前 chat.js 与 SDK 路径各写各的截断与错误串，是校验/截断口径漂移的根因。
const { truncateChars } = require('../utils/truncate');
const { DomainError } = require('../domain/errors');

// 单条工具结果回填上限（字符，码点安全；工具输出预算，非设置项，内部优化防上下文爆炸）
const TOOL_RESULT_MAX_CHARS = 3000;

// 截断续读指引（对齐 pi read 工具 "Use offset=N to continue"）：截断提示必须是可行动指引。
// 只说「已截断，剩余N字符」不说怎么续读时，模型要么原样重取全文（再被截一次，白烧一轮），
// 要么基于残缺结果硬答。指引按结果形态分流到现存的续读通道：分页信封（offset=next_cursor）、
// 长正文分段（read_chapter_range）、过滤收紧（limit/topK/更精确条件）——均为既有机制，零 schema 变更。
function truncationNotice(remaining) {
  return `…(已截断，剩余约${remaining}字符未展示。续读指引：结果带 next_cursor/truncated=true 时以 offset=next_cursor 重取下一页；`
    + '章节长正文改用 read_chapter_range(start,length) 分段读取；列表/检索用更小 limit/topK 或更精确条件重取；'
    + '勿基于不完整结果下「全书没有X」类断言。)';
}

// 可重试错误码：模型据此判断能否修正参数/核对 details 后重试（对齐评审 retryable 语义）
const RETRYABLE_TOOL_ERRORS = new Set(['STALE_OLD_VALUE', 'PROPOSAL_VERSION_CONFLICT']);

// 工具错误统一文案：错误也是喂给模型的粮食，明确告知可纠正参数或基于已有信息作答
function toolErrorText(msg) {
  return '[工具错误] ' + (msg || '执行失败') + '。可修正参数后重试，或直接基于已有信息回答。';
}

// 统一截断工具结果（序列化 + 码点安全截断），返回字符串。
// 截断必须显式标注剩余量并给出续读指引（方向报告 2.2 + M6）：
// 模型不知道自己看到的不是全部、也不知道怎么取到全量时，
// 会基于不完整数据下「全书没有X」类断言，错误无声。
function truncateToolResult(result, maxChars = TOOL_RESULT_MAX_CHARS) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  const remaining = Math.max(0, s.length - maxChars);
  // reserveSuffix：内容+指引合计不超 maxChars——指引变长后单条上限仍严格成立
  return truncateChars(s, maxChars, { suffix: truncationNotice(remaining), reserveSuffix: true }).content;
}

// SDK 路径结果封顶：未超限原样返回（对象交由 SDK 自行序列化，不改语义）；
// 超限才降级为截断字符串；确认信封保持对象结构以便前端识别，永不截断。
function capToolResult(result, maxChars = TOOL_RESULT_MAX_CHARS) {
  if (result && typeof result === 'object' && result.status === 'confirmation_required') return result;
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  if (s.length <= maxChars) return result;
  const remaining = Math.max(0, s.length - maxChars);
  return truncateChars(s, maxChars, { suffix: truncationNotice(remaining), reserveSuffix: true }).content;
}

// 统一错误序列化：仅在模型适配器边界把异常转成结构化结果，保留 code/message/status/details，
// 隐藏堆栈与 SQL。非 DomainError 一律降级为 TOOL_EXECUTION_FAILED，不向模型泄露内部细节。
function serializeToolError(err, name = '') {
  if (!(err instanceof DomainError)) {
    console.error('[tool]' + (name ? ' ' + name : ''), err);
    return { code: 'TOOL_EXECUTION_FAILED', message: '工具执行失败', status: 500, retryable: false };
  }
  const error = {
    code: err.code,
    message: err.message,
    status: err.status,
    retryable: RETRYABLE_TOOL_ERRORS.has(err.code),
  };
  if (err.details !== undefined) error.details = err.details;
  return error;
}

// 传统 chat 路径：结构化错误 → 模型可读字符串（含 code 与关键 details，按 retryable 给行动建议）
function toolErrorContent(serialized) {
  let s = '[工具错误] ' + (serialized.code ? serialized.code + '：' : '') + (serialized.message || '执行失败');
  if (serialized.details && typeof serialized.details === 'object') {
    try { s += '（' + JSON.stringify(serialized.details) + '）'; } catch (e) { /* details 不可序列化则略 */ }
  }
  s += serialized.retryable
    ? '。可修正参数或依据 details 核对后重试，或直接基于已有信息回答。'
    : '。请勿重复该调用，直接基于已有信息回答。';
  return s;
}

// OpenAI tool 消息构造
function toolResultMessage(toolCallId, content) {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

function toolErrorMessage(toolCallId, msg) {
  return { role: 'tool', tool_call_id: toolCallId, content: toolErrorText(msg) };
}

// 悬空承诺检测（2026-09-10 实测）：模型在无工具收尾轮把「让我查看/确认一下」这类
// 过渡语当成最终回复吐出——答案其实已在思考里算完，正文却停在下文缺失处，
// 用户看到的就是「思考一会儿然后卡住」。这类文本既不是空串也不是工具标记泄漏，
// 既有的空正文兜底与标记清洗都不会触发，必须独立识别。
// 判据（窄口径，避开「我来解释一下：第一…」这类宣告后真有内容的正常回复）：
//   1) 以冒号结尾 = 明确的下文缺失；或
//   2) 最后一句只是行动宣告，且整段过短（没有承载结论）
const DANGLING_ACTION = /^(抱歉[，,]?\s*)?(让我|我来|我先|我需要|请让我|我去)[^。！？\n]{0,24}(查看|看一下|看看|确认|核对|检查|读取|查询|搜索|检索|列出|获取|梳理|整理)/;
function looksLikeDanglingPromise(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[：:]\s*$/.test(t)) return true; // 冒号结尾：下文缺失
  const sentences = t.split(/[。！？\n]+/).map(s => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] || '';
  return DANGLING_ACTION.test(last) && t.length <= 120;
}

// 虚假完成声明检测（2026-09-10 十章实测：第三个「假收尾」变体）。
// 实测现场：作者说「把刚才这一章写进第1章」，模型需要「先查目录 → 再落笔」两步，
// 但 followUpRounds 最后一轮强制无工具收尾，模型于是在收尾轮把**没提交的写入**说成
// 已完成——「第1章《被粘回去的那一页》已写入，章节ID：113，字数约1800字」。实际
// chapters.content 长度 0，tool_audit_logs 无任何写工具记录，reasoning 里甚至写着
// 「我刚刚通过 update_chapter 调用了写入」——它幻觉了一个不存在的工具。
// 与悬空承诺同源（模型意图与工具能力断层），形态相反：一个是「还没做」，一个是
// 「谎称做了」。必须独立判据，否则作者把「已保存」当真，离开页面即丢稿。
//
// 判据（窄口径，只认「完成态断言 + 写入动词 + 章节对象」三者同现，避开正常汇报与
// 作品讨论）。实测反例已纳入回归：「第三章已经写完，接下来我打算写第四章」（否定/将来
// 词放行）、「已更新大纲，第2章改成了对峙」（更新不在写入动词表内，对象是大纲不是正文）。
const WRITE_DONE_ADVERB = /(已|已经|成功|刚刚|刚才|完成)/;
const WRITE_NEGATED = /(未|没有|还没|尚未|无法|不能|失败|不会|打算|准备|将要|即将|接下来)/;
// 不含「更新」：与「已更新大纲，第2章…」这类非章节正文写入误伤
const WRITE_VERB = /(写入|追加|替换|覆盖|保存|落笔|录入|填进|写进|放进)/;
const CHAPTER_OBJECT = /(章节|正文|本章|这一章|这一节|第[一二三四五六七八九十百零\d]+章)/;
function looksLikeWriteOutcomeClaim(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 只看前两句：完成态结论若存在必开门见山；后文常出现「如需/尚未」等讨论性措辞
  const head = t.split(/[。！？\n]+/).slice(0, 2).join('。');
  if (WRITE_NEGATED.test(head)) return false;
  // 形态一：完成副词 + 写入动词 + 章节对象（「已写入第1章」「正文已追加到当前章节」）
  if (WRITE_DONE_ADVERB.test(head) && WRITE_VERB.test(head) && CHAPTER_OBJECT.test(head)) return true;
  // 形态二：「我把/将这一章保存到第3章了」——完成义由「了」承担，句中没有「已」
  return /把[^。！？\n]{0,10}(章节|正文|本章|这一章|这一节)[^。！？\n]{0,6}(写入|追加|替换|保存|放进|填进|写进)[^。！？\n]{0,10}了/.test(head);
}

// 未兑现的写入意图检测（2026-09-10 十章实测，第4章现场）。
// 实测原文：「第4章的chapterId是116，我直接用replace_chapter提交正文。」——回复到此为止，
// 没有写工具调用、没有确认卡，章节依旧为空。它既不是 looksLikeWriteOutcomeClaim 的
// 「谎称已完成」（句中没有「已/成功」），也不在 looksLikeDanglingPromise 的动作词表里
// （「我直接」不在 让我/我来/我先 之列），两种防护都漏掉。
//
// 判据（窄口径，靠工具名与「写工具」这类不可能出现在正常答复里的词来锚定，避免误伤）：
//   模型在给用户的正文里点名了写工具，说明它打算写；既然写动作没提交，这句就是空头支票。
//   工具名对作者毫无意义，出现在答复里本身即异常，故不与其他条件做与运算。
//   例外：正文里带【需要确认】（协作模式约定的提问标记）时不算——模型是在按协议向作者
//   提问（实测第9章：它发现 chapterId 与章序不符，先问再写，属正确行为），
//   此时强推纠正轮会把一个合法提问顶掉。
//   注意：本判据扫**全篇**而非只看前两句（2026-09-10 第10章现场：模型把过渡语与正文粘在
//   一起——「让我先检查一下。第10章还没有内容，我需要先写正文再提交。…## 第10章…」，
//   写工具名出现在第 2、3 句上，只看前两句会漏）。
const WRITE_TOOL_NAME = /(replace_chapter|append_chapter|create_chapter|update_chapter|set_chapter_meta)/;
const WRITE_TOOL_GENERIC = /(写工具|写入工具|写操作工具)/;
const ASKING_AUTHOR = /【需要确认】/;
// 形态 b：模型明说「提交」（提交是给系统看的动作，作者不会要求把正文提交给他自己），
// 且正文已有实质篇幅（>=600 字）却没提交 —— 2026-09-10 第10章：「我需要先确认第10章的
// 完整正文是否存在，然后提交。…然后写正文再提交。」后面直接跟了整章正文就收尾。
const SUBMIT_INTENT = /(提交|提上去|交上去)/;
// 否定必须紧贴写入动词才算数：「第10章还没有内容」里的「没有」不否定写入动作，
// 只有「不打算用 replace_chapter」「无法提交」这类才是指向写入本身的否定/将来时。
const NEGATED_WRITE = /(未|没有|还没|尚未|无法|不能|失败|不会|不打算|不准备|无意)[^。！？\n]{0,10}(提交|写入|追加|替换|保存|落笔|录入|填进|写进|放进)/;
// 否定/搁置紧贴工具名：「但我不打算用 replace_chapter」——工具名出现不等于要用它
const NEGATED_TOOL = /(未|没有|还没|尚未|无法|不能|失败|不会|不打算|不准备|无意|不|别)[^。！？\n]{0,10}(replace_chapter|append_chapter|create_chapter|update_chapter|set_chapter_meta|写工具)/;
function looksLikeUnfulfilledWriteIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (ASKING_AUTHOR.test(t)) return false;
  const head = t.split(/[。！？\n]+/).slice(0, 3).join('。');
  if (NEGATED_WRITE.test(head) || NEGATED_TOOL.test(head)) return false;
  // 形态 a：点名写工具（扫全篇：过渡语与正文粘连时工具名可能不在开头）
  if (WRITE_TOOL_NAME.test(t) || WRITE_TOOL_GENERIC.test(t)) return true;
  // 形态 b：明说提交 + 章节对象 + 已有实质正文
  return t.length >= 600 && SUBMIT_INTENT.test(head) && CHAPTER_OBJECT.test(head);
}

// 待办宣告（2026-09-10 十章实测，建人物现场）：
// 末轮只回一句行动宣告——「现在我根据第1章和第2章的内容，创建这三个人物档案。」——
// 模型上一轮把工具轮预算全花在读取上，收尾轮只能宣告「接下来要做 X」，X 从未发生。
// 它既不是悬空承诺（没有「让我查看…：」的过渡结构）、也不是虚假完成声明（没有「已」），
// 于是被当成正常答复展示，作者以为马上就好，实际什么也没发生。
// 判据（窄口径，靠长度与「宣告词 + 落库类动词」锚定）：
//   文本短（<=200 字，长文本通常是真内容）+ 首句是宣告 + 出现需要落地到数据的动词
//   + 无完成态措辞（「已/成功/完成」）
const ANNOUNCE_PREFIX = /(现在我|现在我来|现在我根据|接下来我|接下来|下面我|下面|我先|我来)/;
const LANDING_VERB = /(创建|新建|建立|建档|写入|追加|替换|提交|更新|添加|补上|改成|落库|建到)/;
function looksLikePendingActionAnnouncement(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  if (/(已|成功|完成)/.test(t)) return false;
  const head = t.split(/[。！？\n]+/).slice(0, 2).join('。');
  return ANNOUNCE_PREFIX.test(head) && LANDING_VERB.test(t);
}

// 自造截断标记检测（2026-09-10 用户反馈：最近一次输出「写到一半就停下来了」）。
// 实测现场：回复正文末尾是「女人的眼神突然变得空洞，规则覆盖了她。她发动汽车，然后……（较晚内容略）」
// ——「较晚内容略」全仓库 grep 不到，是模型自己写的收尾。来源是历史裁剪标记的模仿：
// 更早的长消息被截成 300 字 + 「……（较早内容略）」，同一次请求里出现了 2 次，
// 模型照抄了这个句式（「较早」→「较晚」）。它写完 3204 字后据此收尾，finish_reason=stop
// （并非 length），续写兜底因此完全不触发，第6章一个字都没落库（chapters 无该内容）。
// 本次同时把裁剪标记改成机器样式（llm.trimHistoryText）以消除模仿源；本判据是第二道防线：
// 模型若仍写出这类括注，就当作「正文没写完」的信号，触发无缝续写补齐。
//
// 判据（窄口径）：只认**结尾处**的「（……略）」「（……省略）」括注。
// 方括号机器历史标记是输入省略注记，即使出现在模型引用中也不作为续写信号。
//   正文中间出现的「略」不动（可能是作品内容）；「未完待续」不匹配（无「略」字）；
//   「（此处内容略去不表）」也不匹配（「略」后还有字，收尾不是括注）。
const SELF_TRUNCATION_TAIL = /[（(][^）)]{0,10}(?:省略|略)[）)]\s*[。！？…、，,．.!?]*$/;
function looksLikeSelfTruncationMarker(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return SELF_TRUNCATION_TAIL.test(t);
}

// 摘掉结尾的自造截断标记（续写前调用）：保留标记之前的全部正文，让续写轮的 assistant
// 消息停在自然的半句上，避免把「（较晚内容略）」带进续写结果与定稿。
function stripSelfTruncationMarker(text) {
  const t = String(text || '').trim();
  if (!looksLikeSelfTruncationMarker(t)) return t;
  return t.replace(SELF_TRUNCATION_TAIL, '').trim();
}

// 上游重复投递折叠（2026-09-10 实测）：agnes 聚合渠道把同一段正文原样吐了两遍，
// 中间只夹了一个泄漏的 </think>（清洗后两段逐字节相同，各 3204 字）。温度 0.7 的采样器
// 不可能逐字节重复三千字，故判定为通道重放而非模型行为；模型自己的 reasoning 只有一份，
// 可佐证重放只发生在正文通道。前端会把两段都渲染出来（作者读到第一段末尾的
// 「（较晚内容略）」就以为卡住了），故在入库前折叠。
// 判据极窄：全文由 N 段（N>=2）**逐字节相同**的长文本拼成，段间只有空白/Markdown 分隔符。
// 正常创作不可能满足——列出一模一样的 400 字以上连续文本，等同于内容事故。
// 实现：k 段候选从少到多试（优先折叠成大块），逐段对齐校验，段间分隔片段各自不超 8 字符。
const DUPLICATE_MIN_CHARS = 400;
const DUPLICATE_MAX_SEPARATOR = 8;
const DUPLICATE_MAX_COPIES = 5;
const DUPLICATE_SEPARATOR = /^[\s\-*=]*$/;

// 命中则返回重复的块（应保留的那一段），否则返回 null
function matchRepeatedBlocks(t) {
  const n = t.length;
  for (let k = 2; k <= DUPLICATE_MAX_COPIES; k++) {
    const maxSepTotal = (k - 1) * DUPLICATE_MAX_SEPARATOR;
    for (let sepTotal = 0; sepTotal <= maxSepTotal; sepTotal++) {
      const rest = n - sepTotal;
      if (rest % k !== 0) continue;
      const blockLen = rest / k;
      if (blockLen < DUPLICATE_MIN_CHARS) continue;
      const block = t.slice(0, blockLen);
      let pos = blockLen;
      let copies = 1;
      let ok = true;
      while (pos < n) {
        let advanced = false;
        for (let g = 0; g <= DUPLICATE_MAX_SEPARATOR; g++) {
          if (pos + g + blockLen > n) break;
          if (DUPLICATE_SEPARATOR.test(t.slice(pos, pos + g)) && t.startsWith(block, pos + g)) {
            pos += g + blockLen;
            copies += 1;
            advanced = true;
            break;
          }
        }
        if (!advanced) { ok = false; break; }
      }
      if (ok && copies === k && pos === n) return block;
    }
  }
  return null;
}

function collapseDuplicatedOutput(text, maxPasses = 3) {
  let t = String(text || '').trim();
  for (let pass = 0; pass < maxPasses; pass++) {
    const block = matchRepeatedBlocks(t);
    if (!block) break;
    t = block.trim();
  }
  return t;
}

module.exports = {
  TOOL_RESULT_MAX_CHARS,
  RETRYABLE_TOOL_ERRORS,
  toolErrorText,
  truncationNotice,
  truncateToolResult,
  capToolResult,
  serializeToolError,
  toolErrorContent,
  toolResultMessage,
  toolErrorMessage,
  looksLikeDanglingPromise,
  looksLikeWriteOutcomeClaim,
  looksLikeUnfulfilledWriteIntent,
  looksLikePendingActionAnnouncement,
  looksLikeSelfTruncationMarker,
  stripSelfTruncationMarker,
  collapseDuplicatedOutput,
};
