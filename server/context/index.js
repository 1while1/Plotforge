// 上下文组装器：按优先级调度各 Provider，分配字符预算，拼成系统提示词
// 新增信息来源 = 在 providers/ 加一个文件并在这里注册一行
const identity = require('./providers/identity');
const worldview = require('./providers/worldview');
const characters = require('./providers/characters');
const outline = require('./providers/outline');
const memory = require('./providers/memory');
const storyState = require('./providers/storyState');
const retrieval = require('./providers/retrieval');
const hub = require('./providers/hub');
const style = require('./providers/style');
const writingTarget = require('./writing-target');

// 统一截断 + token 估算（对齐 pi：码点安全 + CJK 感知预算）
const { truncateChars } = require('../utils/truncate');
const { estimateTokens } = require('../contextBudget');

const PROVIDERS = [identity, writingTarget, style, worldview, characters, hub, outline, memory, storyState, retrieval];

// 全局系统提示 token 上限的兜底默认（正常由调用方按「模型窗口−预留」传入更大值）
const DEFAULT_SYSTEM_TOKEN_BUDGET = 8000;

// 码点安全截断（统一 util，避免截到半个汉字/代理对）
function truncate(text, max) {
  return truncateChars(text, max, { suffix: '\n……（内容过长已截断）' }).content;
}

// 按 token 额度反推保留字符数并码点安全裁剪（全局预算兜底用）
function truncateToTokens(text, maxTokens) {
  const est = estimateTokens(text);
  if (est <= maxTokens) return text;
  const chars = Array.from(text);
  const keep = Math.max(0, Math.floor(chars.length * (maxTokens / est)) - 8);
  return truncateChars(text, keep, { suffix: '\n……（受整体预算限制已截断）' }).content;
}

// XML 转义（对齐 pi system-prompt）：仅转义 & < > " '，对中文正文透明
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function formatSection(p, content) {
  return `<ctx name="${escapeXml(p.title)}" priority="${p.priority}">\n${escapeXml(content)}\n</ctx>`;
}

// ctx = { book, chapterId, db, query, systemTokenBudget? }
//（query = 用户最新输入，供检索 Provider 使用；systemTokenBudget = 系统提示整体 token 上限）
// 返回 { text, parts, budget }：parts = 各节实际占用（token 估算，含是否被预算截断），供上下文组成面板
async function assembleDetailed(ctx) {
  ctx.writingTarget = writingTarget.resolveWritingTarget(ctx.book.id, ctx.selectedChapterId ?? ctx.chapterId, ctx.query);
  ctx.selectedChapterId = ctx.writingTarget.selectedChapterId;
  ctx.chapterId = ctx.writingTarget.targetChapterId || ctx.writingTarget.anchorChapterId || null;
  ctx.chapterPositions = ctx.writingTarget.chapters;
  ctx.narrativeScope = require('../domain/narrativeScope').narrativeScope(ctx.book.id, ctx.chapterId, ctx.chapterPositions);
  const budget = Number(ctx.systemTokenBudget) > 0
    ? Number(ctx.systemTokenBudget)
    : DEFAULT_SYSTEM_TOKEN_BUDGET;
  const sorted = [...PROVIDERS].sort((a, b) => a.priority - b.priority);
  const sections = [];
  const parts = [];
  let used = 0;
  for (const p of sorted) {
    const content = await p.build(ctx);
    if (!content || !content.trim()) continue;
    let text = truncate(content.trim(), p.budget); // 单节 char 预算（码点安全）
    const est = estimateTokens(text);
    if (used + est > budget) {
      // 触达全局上限：把本节裁到剩余额度后停止纳入更低优先级节（重要设定优先保留）
      const remaining = budget - used;
      if (remaining > 0) {
        const trimmed = truncateToTokens(text, remaining);
        sections.push(formatSection(p, trimmed));
        parts.push({ name: p.title, tokens: estimateTokens(trimmed), truncated: true });
      }
      break;
    }
    used += est;
    sections.push(formatSection(p, text));
    parts.push({ name: p.title, tokens: est, truncated: false });
  }
  return { text: sections.join('\n\n'), parts, budget };
}

async function assemble(ctx) {
  return (await assembleDetailed(ctx)).text;
}

module.exports = { assemble, assembleDetailed, escapeXml, truncateToTokens };
