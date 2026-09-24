const crypto = require('crypto');
const db = require('../db');
const vectorStore = require('../vector/store');
const { DomainError } = require('./errors');

function chapter(bookId, chapterId) {
  const row = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [Number(chapterId), Number(bookId)]);
  if (!row) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);
  return row;
}

// ---------- 卷总结底料指纹（方向报告 4.1：章总结变化 → 卷总结过期） ----------
// 保存卷总结时记录「基于哪些章总结生成」的联合指纹；任一底料变化（章总结更新/
// 被清空）后指纹不再吻合 → summary_stale=1，作者与 Agent 都能看到卷总结讲的
// 还是旧故事，需重新生成。全书摘要层（story_state.book_summary）见下方书层三件套。
function volumeSummaryFingerprint(bookId, volumeId) {
  const rows = db.all(
    "SELECT id, summary FROM chapters WHERE book_id = ? AND volume_id = ? AND summary != '' ORDER BY sort_order, id",
    [Number(bookId), Number(volumeId)]
  );
  return crypto.createHash('sha256')
    .update(rows.map(row => `${row.id}:${row.summary}`).join('|'))
    .digest('hex');
}

// 章总结变化后调用：所在卷的指纹不吻合则标过期（幂等，无总结/无指纹的卷不动）
function markVolumeSummaryStale(bookId, chapterId) {
  const row = db.get('SELECT volume_id FROM chapters WHERE id = ? AND book_id = ?', [Number(chapterId), Number(bookId)]);
  if (!row || !row.volume_id) return false;
  const vol = db.get('SELECT id, summary, summary_based_on, summary_stale FROM volumes WHERE id = ?', [row.volume_id]);
  if (!vol || !vol.summary || !vol.summary_based_on || vol.summary_stale) return false;
  if (volumeSummaryFingerprint(bookId, vol.id) === vol.summary_based_on) return false;
  db.run('UPDATE volumes SET summary_stale = 1 WHERE id = ?', [vol.id]);
  return true;
}

// 保存卷总结时刷新底料指纹（新总结基于当前章总结生成 → 不过期）
function refreshVolumeSummaryFingerprint(bookId, volumeId) {
  const fingerprint = volumeSummaryFingerprint(bookId, volumeId);
  db.run('UPDATE volumes SET summary_based_on = ?, summary_stale = 0 WHERE id = ? AND book_id = ?', [
    fingerprint, Number(volumeId), Number(bookId),
  ]);
  return fingerprint;
}

// ---------- 全书摘要底料指纹（方向报告 4.1 收尾：章/卷总结变化 → 全书摘要过期） ----------
// 底料 = 全部卷总结 + 全部章总结（有总结的章）的联合指纹，章总结直连——传播链
// 「章总结变化 → 全书摘要过期」直达，不依赖卷总结先重生成。过期检测对手写/自动
// 保存一视同仁（底料变了就是过期，这正是作者需要知道的事实）；手写与自动的区别
// 只在过期后由谁重生成（作者手改 / update_book_progress 工具），保存时都刷新指纹。
function bookSummaryFingerprint(bookId) {
  const bid = Number(bookId);
  const vols = db.all(
    "SELECT id, summary FROM volumes WHERE book_id = ? AND summary != '' ORDER BY sort_order, id",
    [bid]
  );
  const chs = db.all(
    `SELECT c.id, c.summary FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE c.book_id = ? AND c.summary != ''
     ORDER BY COALESCE(v.sort_order, 2147483647), c.sort_order, c.id`,
    [bid]
  );
  return crypto.createHash('sha256')
    .update(vols.map(row => `v${row.id}:${row.summary}`).join('|') + '||' + chs.map(row => `c${row.id}:${row.summary}`).join('|'))
    .digest('hex');
}

// 底料变化后调用：指纹不吻合则把 story_state.book_summary 标过期（幂等；无摘要/无指纹不动）
function markBookSummaryStale(bookId) {
  const row = db.get(
    "SELECT based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'",
    [Number(bookId)]
  );
  if (!row || !row.based_on || row.stale) return false;
  if (bookSummaryFingerprint(bookId) === row.based_on) return false;
  db.run("UPDATE story_state SET stale = 1 WHERE book_id = ? AND kind = 'book_summary'", [Number(bookId)]);
  return true;
}

// 保存全书摘要时刷新底料指纹（四个写入路径共用：PUT /ledger/progress、PUT /state、
// update_book_progress 工具、llm.js updateStoryState）
function refreshBookSummaryFingerprint(bookId) {
  const fingerprint = bookSummaryFingerprint(bookId);
  db.run(
    "UPDATE story_state SET based_on = ?, stale = 0 WHERE book_id = ? AND kind = 'book_summary'",
    [fingerprint, Number(bookId)]
  );
  return fingerprint;
}

function invalidateChapter(bookId, chapterId, reason = '正文已变化') {
  const row = chapter(bookId, chapterId);
  const embeddingChunks = vectorStore.chapterChunkCount(row.id);
  vectorStore.deleteChapter(row.id);
  const proposalRows = db.all("SELECT id FROM event_proposals WHERE book_id = ? AND chapter_id = ? AND status = 'pending'", [row.book_id, row.id]);
  for (const proposal of proposalRows) db.run("UPDATE event_proposals SET status = 'stale', review_note = ? WHERE id = ?", [reason, proposal.id]);
  const citationRows = db.all('SELECT id FROM advisor_citations WHERE chapter_id = ? AND stale = 0', [row.id]);
  if (citationRows.length) db.run('UPDATE advisor_citations SET stale = 1 WHERE chapter_id = ?', [row.id]);
  const events = db.run('UPDATE story_events SET source_stale = 1 WHERE book_id = ? AND chapter_id = ? AND source_stale = 0', [row.book_id, row.id]).changes;
  // 语义层失效：正文已变，旧章节总结与最新剧情矛盾，若继续以“必须保持连贯”注入，
  // AI 会基于过期事实自信地写下去（不崩溃不报错，危害隐蔽）。置空后 memory provider
  // 的 `summary != ''` 过滤自然跳过；重新定稿/手动总结时会再生成。
  const summariesCleared = db.run("UPDATE chapters SET summary = '' WHERE id = ? AND summary != ''", [row.id]).changes;
  // 章总结被清空 → 基于它的卷总结与全书摘要同步标过期（4.1 传播链）
  if (summariesCleared) {
    markVolumeSummaryStale(bookId, row.id);
    markBookSummaryStale(bookId);
  }
  return { embeddingChunks, proposals: proposalRows.length, citations: citationRows.length, events, summariesCleared };
}

function unlockChapter(bookId, chapterId, reason = '章节已解锁') {
  const invalidated = invalidateChapter(bookId, chapterId, reason);
  // S1-03：状态（定稿/解锁）也是可持久化字段变化，revision 只前进
  db.run('UPDATE chapters SET locked = 0, locked_at = NULL, revision = revision + 1 WHERE id = ? AND book_id = ?', [Number(chapterId), Number(bookId)]);
  return { ok: true, chapterId: Number(chapterId), locked: false, invalidated };
}

// 定稿：锁定章节并异步重建向量索引（作者点「定稿」或确认卡勾选「写入后自动重新定稿」都走这里）
// 定稿也是事实抽取的唯一自动触发点：作者宣布本章完成 → 后台抽取人物状态/关系变化为待审提案（不直接改正典）
function relockChapter(bookId, chapterId) {
  const row = chapter(bookId, chapterId);
  if (!row.content) throw new DomainError('CHAPTER_EMPTY', '章节内容为空，无法定稿', 400);
  db.run(
    "UPDATE chapters SET locked = 1, locked_at = datetime('now','localtime'), relock_pending = 0, revision = revision + 1 WHERE id = ?",
    [row.id]
  );
  const indexer = require('../vector/indexer');
  indexer.indexChapter(Number(row.id))
    .then(result => {
      // S5-04：索引期间来源变化（改稿/移卷/删章）时返回明确的过期状态——缺口可见、可重建，不静默
      if (result && result.stale) {
        console.warn(`[vector] 第 ${row.id} 章定稿索引被拒（${result.code}）：索引期间来源已变化，本批整批丢弃（缺口可见，可重新定稿或一键重建）`);
      }
    })
    .catch(e => console.error('[vector] 定稿索引失败:', e.message));
  const extraction = require('./chapterSummaryProposals').scheduleChapterExtraction(Number(bookId), Number(row.id));
  // 作家仓库 · 体检层：定稿后自动送检（可选旁路，默认手动，见 settings.style_healthcheck_mode）。
  // 不 await、不感知失败——maybeAutoCheck 内部吞掉全部异常，体检永远不会拖慢或搞挂定稿。
  require('../style/autoHealthcheck').maybeAutoCheck(Number(bookId), Number(row.id)).catch(() => {});
  return { ok: true, chapterId: Number(row.id), locked: true, indexing: true, extraction };
}

module.exports = {
  invalidateChapter, unlockChapter, relockChapter, chapter,
  volumeSummaryFingerprint, markVolumeSummaryStale, refreshVolumeSummaryFingerprint,
  bookSummaryFingerprint, markBookSummaryStale, refreshBookSummaryFingerprint,
};
