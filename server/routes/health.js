const express = require('express');
const db = require('../db');
const { DomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

// 单一健康视图（方向报告 3.3）：定稿覆盖、索引覆盖、抽取覆盖、摘要新鲜度、
// 台账一致性、最近调用失败原先散在日志与各角落，长篇维护（本产品核心场景）
// 需要一眼看清作品数据的健康度。全部轻量 SQL 聚合，不触发体检重算
// （体检有独立入口与快照缓存，见 2.4）。
// 后台回填任务的实时进度是进程内存态（3.1 第二部分落库另批），
// 这里聚合的是其持久化底料 chapter_extraction_runs 的覆盖情况。
router.get('/:bookId/health', (req, res, next) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!Number.isInteger(bookId) || !db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
    }

    // 正典规模
    const canon = db.get(
      `SELECT COUNT(*) AS chapters,
              COALESCE(SUM(CASE WHEN locked = 1 THEN 1 ELSE 0 END), 0) AS locked,
              COALESCE(SUM(LENGTH(COALESCE(content, ''))), 0) AS chars
       FROM chapters WHERE book_id = ?`,
      [bookId]
    );

    // 索引覆盖：定稿章中无任何向量块的（与 3.2 一键重建同一缺口口径）
    const indexMissing = db.get(
      `SELECT COUNT(*) AS n FROM chapters c
       WHERE c.book_id = ? AND c.locked = 1 AND c.content != ''
         AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chapter_id = c.id)`,
      [bookId]
    ).n;

    // 抽取覆盖：定稿章中无成功抽取记录的（抽取持久化，重启可查）
    const extractionPending = db.get(
      `SELECT COUNT(*) AS n FROM chapters c
       WHERE c.book_id = ? AND c.locked = 1 AND c.content != ''
         AND NOT EXISTS (SELECT 1 FROM chapter_extraction_runs r
                         WHERE r.chapter_id = c.id AND r.status = 'success')`,
      [bookId]
    ).n;

    // 摘要健康：定稿章无总结 + 卷总结过期（4.1 传播标记）
    const lockedNoSummary = db.get(
      "SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND locked = 1 AND COALESCE(summary, '') = ''",
      [bookId]
    ).n;
    const staleVolumes = db.get(
      'SELECT COUNT(*) AS n FROM volumes WHERE book_id = ? AND summary_stale = 1',
      [bookId]
    ).n;
    // 全书摘要过期（4.1 书层传播）：story_state.book_summary 底料指纹不吻合
    const staleBookSummary = db.get(
      "SELECT COUNT(*) AS n FROM story_state WHERE book_id = ? AND kind = 'book_summary' AND stale = 1",
      [bookId]
    ).n;

    // 台账一致性（与 GET /ledger/issues 同口径计数）+ 待审提案
    const ledger = db.get(
      `SELECT
        (SELECT COUNT(*) FROM event_proposals WHERE book_id = ? AND status = 'stale') AS stale_proposals,
        (SELECT COUNT(*) FROM story_events WHERE book_id = ? AND chapter_id IS NULL AND source_revision_hash != '') AS orphan_events,
        (SELECT COUNT(*) FROM story_events WHERE book_id = ? AND source_stale = 1) AS stale_events,
        (SELECT COUNT(*) FROM event_proposals WHERE book_id = ? AND status = 'pending') AS pending_proposals`,
      [bookId, bookId, bookId, bookId]
    );

    // 最近调用失败（50 条窗口）：LLM 通道健康的粗粒度信号
    const llm = db.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
       FROM (SELECT status FROM llm_calls WHERE book_id = ? ORDER BY id DESC LIMIT 50)`,
      [bookId]
    );

    res.json({
      canon: { chapters: canon.chapters, locked: canon.locked, chars: canon.chars },
      index: { locked_missing: indexMissing },
      extraction: { locked_pending: extractionPending },
      summary: { locked_without_summary: lockedNoSummary, stale_volumes: staleVolumes, stale_book_summary: staleBookSummary },
      ledger,
      llm_recent: { window: 50, total: llm.total || 0, errors: llm.errors || 0 },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    next(err);
  }
});

module.exports = router;
