const db = require('../db');
const { ordinalNumber } = require('../domain/chapterCatalog');
const { listChapterPositions, resolveChapter } = require('../domain/chapterNavigation');
const { DomainError } = require('../domain/errors');

// S5-02 / R01：明确重读要求。判据只来自**作者本轮的原话**（服务器生成，不接受模型自报已读）：
//   1) 出现「重新/再次/实际/真正/亲自…+ 读取/通读/调阅/核对」这类**当下重读**的动词短语，
//      或直接点名 read_chapter/read_chapter_range；
//   2) 且说的是章节/正文（不是大纲、人物卡等其它资料）；
//   3) 且语气是要求而不是回指——「实际读取到的口令」这类完成态回指不算（见下 PAST_REFERENCE）。
// 一般讨论、纯历史回顾、总览（overview）与待建新章都不生成要求：不靠扩大上下文或每轮扫全书补救。
const FRESH_READ_DEMAND = /(?:重新|再次|再|从新|实际|真正|亲自|当场|现在|立刻|立即|马上)[^。！？\n]{0,20}?(?:读取|阅读|读一[下遍次回]|看一[下遍次回]|读原文|读正文|读全|通读|调阅|打开|核对)|\bread_chapter(?:_range)?\b/gu;
const READ_SCOPE_MARKER = /章|章节|正文|原文|全文|末尾|结尾|前文|旧文|最新|最近|读_chapter|read_chapter/u;
const DEMAND_NEGATED = /(?:不要|不用|不必|无需|无须|禁止|不得|别|勿)\s*(?:再|重新|重复)?\s*$/u;
const PAST_REFERENCE = /(?:已经|已|刚才|刚刚|之前|上次|上一轮|上一次)[^。！？\n]{0,6}$/u;

function hasFreshReadDemand(text) {
  const source = String(text || '');
  if (!READ_SCOPE_MARKER.test(source)) return false;
  for (const matched of source.matchAll(FRESH_READ_DEMAND)) {
    const before = source.slice(Math.max(0, matched.index - 14), matched.index);
    if (DEMAND_NEGATED.test(before) || PAST_REFERENCE.test(before)) continue; // 「不要重新调用工具」「刚才实际读取到的」
    const after = source.slice(matched.index + matched[0].length, matched.index + matched[0].length + 2);
    if (/^(?:到|过|了)/u.test(after)) continue; // 「实际读取到的」＝完成态回指，不是本轮要求
    return true;
  }
  return false;
}

// 产出 requiredReads=[{ bookId, chapterId, reason }]：
// 目标章取本轮写作定位已解析出的目标（作者点名第几卷/第几章或「最新章」都已在 resolveWritingTarget
// 里解析成真实 id），待建新章取前文锚点章（写作前必须先读到衔接处）；都解析不出（空书/无法唯一
// 定位）时保留 chapterId=null，由核验给出 read_scope_ambiguous，而不是放任模型凭历史作答。
function requiredReadsFor(bookId, text, target) {
  if (/^\[确认执行结果/u.test(String(text || ''))) return []; // 确认续跑信封不是作者新请求
  if (!hasFreshReadDemand(text)) return [];
  if (!target || target.mode === 'overview') return [];
  const chapterId = target.targetChapterId || target.anchorChapterId || null;
  return [{ bookId: Number(bookId), chapterId: chapterId == null ? null : Number(chapterId), reason: 'user_explicit_reread' }];
}

function resolveWritingTarget(bookId, chapterId, query = '') {
  const chapters = listChapterPositions(bookId);
  const selectedId = chapterId == null ? null : Number(chapterId);
  const selected = chapters.find(chapter => chapter.id === selectedId);
  if (selectedId !== null && !selected) throw new DomainError('CHAPTER_NOT_FOUND', '界面选中章节不属于本书，请重新选择', 404);
  const latest = chapters.filter(chapter => chapter.has_content).at(-1) || chapters.at(-1);
  const text = String(query || '');
  const chapterRefs = [...text.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*章/gu)];
  const volumeRef = text.match(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*(?:分卷|卷)/u);
  const overview = chapterRefs.length > 1 || /(?:全书|整本|所有章节).{0,8}(?:分析|检查|总结|概览|回顾)|(?:分析|检查|总结|概览|回顾).{0,8}(?:全书|整本|所有章节)/u.test(text);
  const result = { selectedChapterId: selectedId, latestChapterId: latest?.id || null,
    targetChapterId: selected?.id || latest?.id || null, anchorChapterId: null, mode: overview ? 'overview' : 'chapter', chapters };
  if (overview) {
    result.targetChapterId = null;
    result.requiredReads = requiredReadsFor(bookId, text, result);
    return result;
  }
  if (chapterRefs.length === 1 && !text.startsWith('[确认执行结果')) {
    const chapterOrdinal = ordinalNumber(chapterRefs[0][1]);
    const volumeOrdinal = volumeRef ? ordinalNumber(volumeRef[1]) : undefined;
    try {
      result.targetChapterId = resolveChapter(bookId, { chapterOrdinal, ...(volumeOrdinal ? { volumeOrdinal } : {}) }).id;
    } catch (error) {
      if (error.code !== 'CHAPTER_NOT_FOUND' || !/(?:写|创建|新建)/u.test(text)) throw error;
      const volumes = db.all('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order, id', [bookId]);
      const volume = volumeOrdinal ? volumes[volumeOrdinal - 1] : volumes.at(-1);
      const inVolume = chapters.filter(chapter => chapter.volume_id === volume?.id);
      if ((!volume && volumes.length) || chapterOrdinal !== inVolume.length + 1) throw error;
      result.targetChapterId = null;
      result.anchorChapterId = inVolume.filter(chapter => chapter.has_content).at(-1)?.id || null;
      result.plannedChapterOrdinal = chapterOrdinal;
      result.plannedVolumeId = volume?.id || null;
      result.mode = 'create';
    }
  } else if (/(?:最近|最新|最后).{0,12}(?:章|正文|前文)|(?:章|正文|前文).{0,8}(?:最近|最新|最后)/u.test(text)) {
    result.targetChapterId = latest?.id || null;
  } else if (/(?:新建|创建|写).{0,4}(?:下一章|一个新章)|(?:继续|接着).{0,3}写下一章/u.test(text)) {
    result.targetChapterId = null;
    result.anchorChapterId = latest?.id || null;
    result.mode = 'create';
  }
  result.requiredReads = requiredReadsFor(bookId, text, result);
  return result;
}

function describeChapter(chapter) {
  return chapter ? '第' + (chapter.volume_ordinal || '?') + '卷·第' + chapter.chapter_ordinal + '章《' + chapter.title + '》 chapterId=' + chapter.id : '未指定';
}

module.exports = {
  name: 'writingTarget', title: '本轮写作定位', priority: 2, budget: 1000,
  build(ctx) {
    const target = ctx.writingTarget;
    if (!target) return null;
    const find = id => target.chapters.find(chapter => chapter.id === id);
    const required = Array.isArray(target.requiredReads) ? target.requiredReads : [];
    return '界面选中：' + describeChapter(find(target.selectedChapterId))
      + '\n最新正文位置：' + describeChapter(find(target.latestChapterId))
      + '\n本轮任务目标：' + (target.mode === 'overview' ? '全书讨论，不能把界面选中章当唯一范围'
        : target.mode === 'create' ? '待创建新章' + (target.plannedChapterOrdinal ? '（目录第' + target.plannedChapterOrdinal + '章）' : '') + '；尚无章节ID，确认创建后才能写入'
          : describeChapter(find(target.targetChapterId)))
      + (target.anchorChapterId ? '\n新章前文锚点：' + describeChapter(find(target.anchorChapterId)) : '')
      + (required.length ? '\n本轮为明确重读：作者要求本轮实际读取' + (required[0].chapterId ? describeChapter(find(required[0].chapterId)) : '目标章节正文')
        + '，请调用 read_chapter 真实读取后再作答；系统按本轮实际读取凭据核验，历史消息与自述不作为已读凭据。' : '')
      + '\n目录序号不是数据库ID；写入必须使用已定位的真实ID，待确认不等于已执行。';
  },
  resolveWritingTarget,
  hasFreshReadDemand,
  requiredReadsFor,
};
