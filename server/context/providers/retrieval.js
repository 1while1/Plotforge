const db = require('../../db');
const { searchEvidence } = require('../../evidence/search');
const { truncateChars } = require('../../utils/truncate');
const { EMBED_TEXT_MAX } = require('../../vector/embed');

// 码点安全截断（统一 util）；reserveSuffix 使 内容+省略号 合计不超 max
const clip = (text, max) => truncateChars(text, max, { suffix: '…', reserveSuffix: true }).content;

// 续写指令识别（方向报告 4.3）：整句就是低信息量续写要求（"接着写/继续/往下写…"）。
// 只认整句匹配——「继续写第二章，林野要反杀」自带信息量，不需要锚点补强。
const CONTINUE_RE = /^(接着|继续|往下|接下去|接下来)[^，。！？!?,.?]{0,8}(写|续写|创作)?[。.!！~\s]*$/;

// 叙事锚点：上一章结尾 + 本章尾部（各 ~300 字）。纯续写指令不带任何检索线索，
// 此前全靠固定注入，上一章怎么收的、本章写到哪里检索完全空转——把锚点并入
// 检索 query，三路检索（向量/关键词/结构化）自动定向到叙事邻接内容。
const ANCHOR_CHARS = 300;
function narrativeAnchors(bookId, chapterId) {
  const positions = require('../../domain/chapterNavigation').listChapterPositions(bookId);
  const current = positions.find(chapter => chapter.id === Number(chapterId));
  if (!current) return null;
  const previous = positions.filter(chapter => chapter.global_ordinal < current.global_ordinal && chapter.has_content).at(-1);
  const tail = chapter => chapter ? String(db.get('SELECT content FROM chapters WHERE id = ? AND book_id = ?', [chapter.id, bookId])?.content || '').trim().slice(-ANCHOR_CHARS) : '';
  const prevTail = tail(previous);
  const curTail = tail(current);
  return prevTail || curTail ? { prevTail, curTail } : null;
}

/**
 * 头尾保真截断：长文本两端各留一部分（指令的开头是主题、结尾是落点，只砍中间）。
 */
function fitQueryText(text, max) {
  const s = String(text || '').trim();
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= 24) return s.slice(0, max);
  const tail = Math.max(8, Math.round(max * 0.4));
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}

/**
 * 拼检索 query，**保证总长不超嵌入安全边界**（embed.js EMBED_TEXT_MAX）。
 *
 * 为什么必须在这里裁剪：嵌入端对超长文本是**静默截断**（512 token ≈ 510 字），
 * 而锚点拼在字符串末尾——一旦指令偏长（>184 字）锚点就整段被吃掉，
 * 「续写时定向召回」这件事在无声中失效。这里按优先级分配预算：
 *   ① 作者指令（永远保留，超预算时头尾保真截断）
 *   ② 本章已写到（最近的叙事邻接，优先于上一章）
 *   ③ 上一章结尾（剩余预算内尽量给）
 * 预算不够时**显式舍弃**低优先级段，并把舍弃项与实测长度返回给调用方（供观测）。
 * @returns {{text:string, dropped:string[], chars:number, budget:number}}
 */
function assembleQuery(query, anchors) {
  const head = String(query || '').trim();
  const hasAnchors = !!(anchors && (anchors.prevTail || anchors.curTail));
  if (!hasAnchors) {
    const only = fitQueryText(head, EMBED_TEXT_MAX);
    return { text: only, dropped: [], chars: only.length, budget: EMBED_TEXT_MAX };
  }
  // 有锚点时给指令留出上限，避免长指令把锚点挤没（锚点正是这类指令需要的）
  const headText = fitQueryText(head, Math.min(EMBED_TEXT_MAX, 240));
  const parts = [headText];
  const dropped = [];
  let used = headText.length;
  const push = (label, text) => {
    const body = String(text || '').trim();
    if (!body) return;
    const budget = EMBED_TEXT_MAX - used - label.length - 1;
    if (budget < 20) { dropped.push(label.replace(/：$/, '')); return; }
    parts.push(label + fitQueryText(body, budget));
    used += label.length + Math.min(body.length, budget) + 1;
  };
  push('本章已写到：', anchors.curTail);
  push('上一章结尾：', anchors.prevTail);
  const text = parts.join('\n');
  return { text: text, dropped: dropped, chars: text.length, budget: EMBED_TEXT_MAX };
}

/** 兼容旧签名：只要字符串的调用方（测试与工具链）。 */
function buildRetrievalQuery(query, anchors) {
  return assembleQuery(query, anchors).text;
}

module.exports = {
  name: 'retrieval',
  title: '相关证据（正典资料、定稿正文与草稿命中）',
  priority: 45,
  budget: 2200,
  async build(ctx) {
    const { book, chapterId, query } = ctx;
    if (!query || !query.trim()) return '';
    // 续写类指令：并入叙事锚点作为检索线索（本章自身仍被 excludeChapterId 排除，
    // 本章尾部只参与 query 定向，召回的是叙事邻接的前文证据）
    const trimmedQuery = String(query).trim();
    const anchors = (chapterId && CONTINUE_RE.test(trimmedQuery))
      ? narrativeAnchors(book.id, chapterId)
      : null;
    const assembled = assembleQuery(trimmedQuery, anchors);
    const result = await searchEvidence(book.id, assembled.text, {
      topK: 12,
      excludeChapterId: chapterId,
      chapterId,
      narrativeScope: ctx.narrativeScope,
    });
    ctx.retrievalAnchor = anchors ? {
      triggered: true,
      prev_tail: clip(anchors.prevTail, 120),
      current_tail: clip(anchors.curTail, 120),
      // 观测口径：query 是否顶到嵌入边界、哪些锚点因预算被舍弃（超长曾被静默截断）
      query_chars: assembled.chars,
      query_budget: assembled.budget,
      dropped: assembled.dropped,
    } : undefined;
    const finalHits = result.hits.filter(hit => hit.sourceType === 'chapter_final').slice(0, 3);
    const draftHits = result.hits.filter(hit => hit.sourceType === 'chapter_draft').slice(0, 2);
    const structured = result.hits
      .filter(hit => !['chapter_final', 'chapter_draft'].includes(hit.sourceType))
      .slice(0, 12);
    const selected = [...structured, ...finalHits, ...draftHits];
    ctx.retrievalHits = selected.map(hit => ({
      anchor: hit.anchor,
      chapter: hit.title,
      score: Number(hit.relevance.toFixed(3)),
      text: clip(hit.quote, 200),
      trustClass: hit.trustClass,
      stale: hit.stale,
    }));
    ctx.retrievalDegraded = result.degraded;
    if (!selected.length) return '';
    let warning = '';
    if (result.degraded.includes('semantic')) {
      // 覆盖数区分「索引失败」与「索引缺失」（方向报告 3.2），两者都显式提示
      const cov = result.semantic_coverage;
      warning = cov && cov.locked > cov.indexed
        ? `（注意：${cov.locked} 章定稿中仅 ${cov.indexed} 章有语义索引，缺失章可能检索不到；可在写作页章节列表一键重建索引。以下结果可能不完整。）\n`
        : '（定稿语义检索暂不可用，以下来自结构化资料和草稿关键词。）\n';
    }
    return warning + selected.map(hit =>
      `◆ ${hit.title}〔${hit.anchor}〕${hit.stale ? '（来源正文已修改，此证据可能过期）' : ''}\n${clip(hit.quote, 260)}`
    ).join('\n\n');
  },
};

// 供测试直接校验识别与锚点构造（不走网络检索）
module.exports._internals = { CONTINUE_RE, narrativeAnchors, buildRetrievalQuery, assembleQuery, fitQueryText };
