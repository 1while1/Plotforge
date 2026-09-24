// 体检自动触发（作家仓库 · 体检层）：章节定稿后自动送检一次。
//
// 定位：这是一个**可选的旁路**，默认关闭（settings.style_healthcheck_mode = 'manual'）。
// 硬约束（本文件存在的全部意义就是守住这些）：
//   1. 绝不阻塞定稿：fire-and-forget，调用方不 await、不感知失败；
//   2. 绝不抛错：任何异常（无 key / 超时 / 额度耗尽 / 上游 5xx）都在这里被吞掉并记日志；
//   3. 绝不影响写作：体检只读章节、只写 ai_style_samples，失败时写作行为与今天完全一致；
//   4. 额度自觉：朱雀免费版 50 万 token/月（约 80 章），因此**同一章同一版本只检一次**——
//      靠 chapter_revision 比对，作者反复定稿同一章不会重复烧额度。
const db = require('../db');

function mode() {
  try {
    const row = db.get("SELECT value FROM settings WHERE key = 'style_healthcheck_mode'");
    const v = String((row && row.value) || 'manual').trim().toLowerCase();
    return v === 'auto' ? 'auto' : 'manual';
  } catch {
    return 'manual';
  }
}

// 该章这一版是否已检过（避免重复烧额度）
function alreadyChecked(chapterId, revision) {
  try {
    const row = db.get(
      "SELECT id FROM ai_style_samples WHERE chapter_id = ? AND chapter_revision = ? LIMIT 1",
      [chapterId, revision]
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 定稿后自动体检（若开关为 auto）。返回一个 Promise，但**调用方不该等它**——
 * 内部已吞掉全部异常，resolve 值只用于日志/测试断言。
 * @param {number} bookId
 * @param {number} chapterId
 * @returns {Promise<{ran:boolean, reason?:string, saved?:object}>}
 */
async function maybeAutoCheck(bookId, chapterId) {
  try {
    if (mode() !== 'auto') return { ran: false, reason: 'manual' };
    const zhuque = require('../detectors/zhuque');
    if (!zhuque.hasKey()) return { ran: false, reason: 'no_key' };

    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
    if (!chapter) return { ran: false, reason: 'not_found' };
    const content = String(chapter.content || '');
    if (!content.trim()) return { ran: false, reason: 'empty' };

    const revision = chapter.updated_at || null;
    if (alreadyChecked(chapter.id, revision)) return { ran: false, reason: 'already_checked' };

    const result = await zhuque.detect(content, { isMerge: false });
    const samples = require('./samples');
    const saved = samples.saveSegments(result.segments, {
      bookId,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      chapterRevision: revision,
      source: 'chapter',
    });
    db.saveNow();
    console.log(`[style-lab] 定稿自动体检完成：章节 ${chapter.id}，新增标本 ${saved.inserted}，合并 ${saved.merged}`);
    return { ran: true, saved };
  } catch (err) {
    // 体检是旁路：失败绝不影响定稿流程，只记一行日志
    console.warn(`[style-lab] 定稿自动体检失败（不影响定稿）：${err && err.message}`);
    return { ran: false, reason: 'error' };
  }
}

module.exports = { mode, alreadyChecked, maybeAutoCheck };
