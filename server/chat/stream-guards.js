// 聊天流管线共享护栏（M2：纯函数，流式 /chat/stream 与非流式 /chat 两条管线同一实现）。
//
// 背景（W2/W3 分叉）：「上游重复投递折叠」与「自造截断标记终局检测」此前只挂在流式管线
// （chat.js 终局清理段），非流式管线从未调用——同一渠道故障在两条路径上表现不同，
// 修 bug 漏一半。pi 的公理是「直播与重放走同一管道」：护栏必须收敛为双侧共享的纯函数。
//
// 分层约定：底层判据（重复块对齐 / 截断标记正则）仍在 tools/loop-helpers.js（纯函数、
// 已有单测、SDK 路径也复用）；本模块只做**管线级组合**（清洗→折叠、检测→摘除），
// 不复制任何判据，改判据只改一处。

const { sanitizeLeakedToolMarkup } = require('../utils/sanitize');
const {
  collapseDuplicatedOutput,
  looksLikeSelfTruncationMarker,
  stripSelfTruncationMarker,
} = require('../tools/loop-helpers');

// 终局文本护栏：清洗泄漏的工具标记 → 折叠上游重复投递。
// 顺序固定不可换：重放判据要求各段**逐字节相同**，泄漏的 </think> 等标记必须先摘掉
// 才能判重（2026-09-10 实测现场即「两段相同正文夹一个 </think>」）。
// 流式侧在入库/定稿（done 事件）前调用；非流式侧在返回 reply 前调用。
function finalTextGuards(text) {
  return collapseDuplicatedOutput(sanitizeLeakedToolMarkup(text).text);
}

// 自造截断标记终局检测（二次防线）：
// 模型自己写下「……（较晚内容略）」当收尾时 finish_reason=stop，length/断流续写都不会触发，
// 两条管线的 followUp 判据组 C 只覆盖工具路径——首轮直接产出正文的路径没有任何防线。
// 命中返回 { hit: true, cut }（cut = 摘掉标记后的半截正文，供「回灌半截 + 续写提示」补齐）；
// 未命中返回 { hit: false, cut: null }。续写动作（流式 streamContinue / 非流式
// continueNonStream）由各管线用自己的实现执行，本模块只负责判定与摘除。
function detectSelfTruncation(text) {
  if (!looksLikeSelfTruncationMarker(text)) return { hit: false, cut: null };
  return { hit: true, cut: stripSelfTruncationMarker(text) };
}

module.exports = { finalTextGuards, detectSelfTruncation };
