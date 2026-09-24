// 大纲工作台支撑域：脉络聚合（卷+章+台账烈度投影）与两个 LLM 规划助手（缝隙填补/节奏评语）。
// 约定：两个 LLM 端点只产出建议，不落库；采纳走既有章节创建/编辑路径。
// 输出解析失败按 R02 口径显式抛错（OUTLINE_LLM_PARSE_FAILED），不拿原始文本冒充结构化结果；
// 上游空输出/传输错误也统一包成带 status 的 DomainError（LLM_EMPTY_OUTPUT 在 HTTP 边界会丢 code）。
const db = require('../db');
const { callLLMFull } = require('../llm');
const { DomainError } = require('./errors');

const IMPORTANCE_RANK = { low: 1, normal: 2, high: 3, critical: 4 };

// 测试缝（顾问同款）：modelClient 可注入，string | {content} 归一到字符串；缺省走真实网关
async function invokeModel(messages, opts, modelClient) {
  try {
    const result = modelClient
      ? await (typeof modelClient === 'function' ? modelClient(messages, opts) : modelClient.call(messages, opts))
      : await callLLMFull(messages, opts);
    return typeof result === 'string' ? result : (result && result.content) || '';
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('OUTLINE_LLM_FAILED', '模型调用失败：' + String((err && err.message) || err).slice(0, 200), 502);
  }
}

function ensureBook(bookId) {
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  if (!book) throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  return book;
}

// 每章的台账烈度投影：已采纳且未被取代的事件数 + 最高烈度（1-4，无事件为 0）
function chapterIntensityMap(bookId) {
  const rows = db.all(
    `SELECT e.chapter_id AS chapter_id, COUNT(*) AS event_count,
            MAX(CASE e.importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END) AS max_importance
     FROM story_events e
     WHERE e.book_id = ? AND e.chapter_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
     GROUP BY e.chapter_id`,
    [bookId]
  );
  const map = {};
  for (const row of rows) map[row.chapter_id] = { event_count: row.event_count, max_importance: row.max_importance };
  return map;
}

// 一次出齐大纲工作台的全部结构数据：卷、章（含 beat/revision/字数/总结态）、烈度投影
function buildTimeline(bookId) {
  ensureBook(bookId);
  const volumes = db.all(
    'SELECT id, title, intro, outline, summary, sort_order FROM volumes WHERE book_id = ? ORDER BY sort_order, id',
    [bookId]
  );
  const chapters = db.all(
    `SELECT c.id, c.volume_id, c.title, c.beat, c.sort_order, c.revision, c.locked, c.drift_status,
            LENGTH(c.content) AS content_length, (c.summary != '') AS has_summary
     FROM chapters c WHERE c.book_id = ? ORDER BY c.sort_order, c.id`,
    [bookId]
  );
  const intensity = chapterIntensityMap(bookId);
  return { volumes, chapters, intensity };
}

function chapterBrief(ch) {
  if (!ch) return '（无）';
  const parts = [`第${ch.sort_order}章《${ch.title}》`];
  if (ch.beat && ch.beat.trim()) parts.push(`节拍：${ch.beat.trim()}`);
  if (ch.summary && ch.summary.trim()) parts.push(`已写内容摘要：${ch.summary.trim().slice(0, 300)}`);
  return parts.join('\n');
}

// 从模型输出里稳健提取 JSON 对象：先整体 parse，再退化到 ```json 代码块 / 首个 { 到末尾 }
function parseModelJson(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* 继续退化 */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { /* 继续退化 */ } }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* 放弃 */ } }
  return null;
}

// 缝隙填补：在两章之间（或卷首/卷末）给出 2-3 个衔接章方案。只建议，不写库。
async function fillGap(bookId, input = {}, options = {}) {
  const book = ensureBook(bookId);
  const volumeId = Number(input.volume_id);
  const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [volumeId, bookId]);
  if (!volume) throw new DomainError('VOLUME_NOT_FOUND', '卷不存在', 404);
  const chapters = db.all(
    'SELECT id, title, beat, summary, sort_order FROM chapters WHERE book_id = ? AND volume_id = ? ORDER BY sort_order, id',
    [bookId, volumeId]
  );
  const beforeId = input.before_chapter_id == null ? null : Number(input.before_chapter_id);
  const afterId = input.after_chapter_id == null ? null : Number(input.after_chapter_id);
  const before = beforeId == null ? null : chapters.find(c => c.id === beforeId);
  const after = afterId == null ? null : chapters.find(c => c.id === afterId);
  if (beforeId != null && !before) throw new DomainError('CHAPTER_NOT_FOUND', '前一章不在该卷', 404);
  if (afterId != null && !after) throw new DomainError('CHAPTER_NOT_FOUND', '后一章不在该卷', 404);

  const positionText = before && after
    ? `第${before.sort_order}章与第${after.sort_order}章之间`
    : (before ? `第${before.sort_order}章之后（卷末方向）`
      : (after ? `第${after.sort_order}章之前（卷首方向）`
        : (chapters.length ? '该卷任意空档（由你判断最缺衔接的位置）' : '整卷尚无章节，补第一章')));

  const messages = [
    { role: 'system', content: '你是长篇小说的剧情规划助手，擅长设计章节之间的衔接。只输出严格 JSON，不输出任何其他文字。' },
    { role: 'user', content: [
      `作者需要在《${book.title}》的${positionText}插入衔接章节。`,
      `请给出 2-3 个可选方案，每个方案包含：title（章节标题，≤20字）、beat（本章节拍——本章必须完成的剧情节点，100-200字，要具体可写）、rationale（设计理由，≤80字，说明它如何衔接前后）。`,
      '',
      `【全书总纲】\n${(book.master_outline || '（未填写）').slice(0, 800)}`,
      `【所属卷】第${volume.sort_order}卷《${volume.title}》\n阶段目标：${(volume.intro || '（未填写）').slice(0, 400)}\n卷大纲：${(volume.outline || '（未填写）').slice(0, 800)}`,
      `【前一章】\n${chapterBrief(before)}`,
      `【后一章】\n${chapterBrief(after)}`,
      chapters.length ? `【本卷已有章节】\n${chapters.map(c => `第${c.sort_order}章《${c.title}》`).join('、')}` : '',
      '',
      '输出格式：{"suggestions":[{"title":"…","beat":"…","rationale":"…"}]}',
    ].filter(Boolean).join('\n') },
  ];
  // maxTokens 给足思考模型的推理余量：2500 实测会被推理吃光导致空正文（finish_reason=length）
  const content = await invokeModel(messages, { maxTokens: 4000, temperature: 0.5, signal: options.signal, meta: { bookId, scope: 'outline' } }, options.modelClient);
  const parsed = parseModelJson(content);
  if (!parsed || !Array.isArray(parsed.suggestions) || !parsed.suggestions.length) {
    throw new DomainError('OUTLINE_LLM_PARSE_FAILED', '模型输出无法解析为衔接方案（未写入任何内容，可重试）', 502);
  }
  const suggestions = parsed.suggestions.slice(0, 3).map((s, i) => ({
    id: i + 1,
    title: String(s.title || '').trim().slice(0, 40) || `衔接方案 ${i + 1}`,
    beat: String(s.beat || '').trim(),
    rationale: String(s.rationale || '').trim(),
  })).filter(s => s.beat);
  if (!suggestions.length) throw new DomainError('OUTLINE_LLM_PARSE_FAILED', '模型方案缺少节拍内容（未写入任何内容，可重试）', 502);
  return { suggestions, volume_id: volumeId, before_chapter_id: beforeId, after_chapter_id: afterId };
}

// 节奏评语：整卷各章打分（1-5）+ 总评。分数供前端画曲线，只建议不改数据。
async function tensionReview(bookId, input = {}, options = {}) {
  const book = ensureBook(bookId);
  const volumeId = Number(input.volume_id);
  const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [volumeId, bookId]);
  if (!volume) throw new DomainError('VOLUME_NOT_FOUND', '卷不存在', 404);
  const chapters = db.all(
    `SELECT id, title, beat, summary, sort_order, LENGTH(content) AS content_length
     FROM chapters WHERE book_id = ? AND volume_id = ? ORDER BY sort_order, id`,
    [bookId, volumeId]
  );
  if (!chapters.length) throw new DomainError('VOLUME_EMPTY', '该卷还没有章节，无法分析节奏', 400);
  const intensity = chapterIntensityMap(bookId);

  const lines = chapters.map((ch) => {
    const stat = intensity[ch.id] || { event_count: 0, max_importance: 0 };
    return [
      `第${ch.sort_order}章《${ch.title}》（id=${ch.id}）`,
      `  节拍：${(ch.beat || '（未设定）').slice(0, 200)}`,
      ch.summary ? `  摘要：${ch.summary.slice(0, 200)}` : '  （尚未写正文）',
      `  字数：${ch.content_length || 0}；台账事件 ${stat.event_count} 条，最高烈度 ${stat.max_importance}/4`,
    ].join('\n');
  }).join('\n');

  const messages = [
    { role: 'system', content: '你是小说节奏分析助手，熟悉长篇连载的铺垫-爆发节奏。只输出严格 JSON，不输出任何其他文字。' },
    { role: 'user', content: [
      `请分析《${book.title}》第${volume.sort_order}卷《${volume.title}》的节奏。`,
      `阶段目标：${(volume.intro || '（未填写）').slice(0, 300)}`,
      `卷大纲：${(volume.outline || '（未填写）').slice(0, 600)}`,
      '',
      '【各章情况】',
      lines,
      '',
      '要求：',
      '1. 每章给一个张力分 tension（1-5 整数：1=平淡铺垫，3=推进转折，5=高潮爆发），结合节拍、摘要与台账烈度判断；未写正文的章按节拍预估。',
      '2. 写一段总评 comment（≤200字）：指出节奏问题（连续平淡/高潮过密/铺垫不足等）并给 1-2 条具体改进建议。',
      '输出格式：{"chapter_scores":[{"chapter_id":数字,"tension":1-5}],"comment":"…"}',
    ].join('\n') },
  ];
  const content = await invokeModel(messages, { maxTokens: 5000, temperature: 0.35, signal: options.signal, meta: { bookId, scope: 'outline' } }, options.modelClient);
  const parsed = parseModelJson(content);
  if (!parsed || typeof parsed.comment !== 'string' || !parsed.comment.trim()) {
    throw new DomainError('OUTLINE_LLM_PARSE_FAILED', '模型输出无法解析为节奏评语（可重试）', 502);
  }
  const scoreMap = {};
  for (const row of (Array.isArray(parsed.chapter_scores) ? parsed.chapter_scores : [])) {
    const cid = Number(row.chapter_id);
    const t = Number(row.tension);
    if (chapters.some(c => c.id === cid) && Number.isFinite(t)) {
      scoreMap[cid] = Math.max(1, Math.min(5, Math.round(t)));
    }
  }
  return { comment: parsed.comment.trim(), chapter_scores: scoreMap, volume_id: volumeId };
}

module.exports = { buildTimeline, fillGap, tensionReview, chapterIntensityMap, IMPORTANCE_RANK };
