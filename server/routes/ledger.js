const express = require('express');
const db = require('../db');
const ledger = require('../domain/storyLedger');
const proposals = require('../domain/proposals');
const threads = require('../domain/threads');
const backfill = require('../domain/backfill');
const { DomainError, sendDomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

function handle(res, next, work, status = 200) {
  try {
    const value = work();
    res.status(status).json(value);
  } catch (err) {
    if (!sendDomainError(res, err)) next(err);
  }
}

// progress/issues 两端点直连 SQL，不走 domain 层，这里补上与其它 18 个端点一致的书籍存在性校验
function ensureBookExists(bookId) {
  const id = Number(bookId);
  if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT id FROM books WHERE id = ?', [id])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  return id;
}

router.get('/:bookId/ledger/events', (req, res, next) => {
  handle(res, next, () => {
    // 分页信封（方向报告 2.2）：此前 cursor/next_cursor 写死 null，total 只是当页数
    const page = ledger.getTimelinePage(req.params.bookId, req.query);
    return {
      items: page.items,
      page: { cursor: Number(req.query.offset) || 0, next_cursor: page.next_cursor, total: page.total, truncated: page.truncated },
    };
  });
});

router.post('/:bookId/ledger/events', (req, res, next) => {
  handle(
    res,
    next,
    () => ledger.commitEvent(req.params.bookId, req.body || {}, 'author'),
    201
  );
});

router.get('/:bookId/ledger/events/:eventId', (req, res, next) => {
  handle(res, next, () => ({ event: ledger.getEvent(req.params.bookId, req.params.eventId) }));
});

router.post('/:bookId/ledger/events/:eventId/corrections', (req, res, next) => {
  handle(
    res,
    next,
    () => ledger.correctEvent(
      req.params.bookId,
      req.params.eventId,
      req.body || {},
      'author'
    ),
    201
  );
});

// 撤销一个本不该存在的事件（D1-08：retractEvent 此前导出却无任何调用方，I8 承诺的撤销能力不可达）。
// 追加式 retraction：原事件记录保留（append-only 可审计），但因被取代而退出有效重放，其状态变化被撤销。
router.post('/:bookId/ledger/events/:eventId/retraction', (req, res, next) => {
  handle(
    res,
    next,
    () => ledger.retractEvent(
      req.params.bookId,
      req.params.eventId,
      req.body || {},
      'author'
    ),
    201
  );
});

// 全量重建某书投影（character_state_values / character_relations）——数据修复端点（D1-03：
// rebuildProjections 此前无外部调用方）。当投影与事件账本不一致时，作者可手动触发重建对齐。
router.post('/:bookId/ledger/rebuild-projections', (req, res, next) => {
  handle(res, next, () => ({ projection: ledger.rebuildProjections(req.params.bookId) }));
});

router.get('/:bookId/characters/:characterId/states', (req, res, next) => {
  handle(res, next, () => ({
    items: ledger.getCurrentStates(req.params.bookId, req.params.characterId),
  }));
});

router.get('/:bookId/state-fields', (req, res, next) => {
  handle(res, next, () => ({ items: ledger.listStateFields(req.params.bookId) }));
});

router.post('/:bookId/state-fields', (req, res, next) => {
  handle(
    res,
    next,
    () => ({ field: ledger.createStateField(req.params.bookId, req.body || {}) }),
    201
  );
});

router.patch('/:bookId/state-fields/:fieldKey', (req, res, next) => {
  handle(res, next, () => ({
    field: ledger.updateStateField(req.params.bookId, req.params.fieldKey, req.body || {}),
  }));
});

router.get('/:bookId/ledger/proposals', (req, res, next) => {
  handle(res, next, () => {
    const page = proposals.listProposalPage(req.params.bookId, req.query);
    return {
      items: page.items,
      page: { cursor: Number(req.query.offset) || 0, next_cursor: page.next_cursor, total: page.total, truncated: page.truncated },
    };
  });
});

router.post('/:bookId/ledger/proposals', (req, res, next) => {
  handle(
    res,
    next,
    () => ({ proposal: proposals.createProposal(req.params.bookId, req.body || {}) }),
    201
  );
});

router.post('/:bookId/ledger/proposals/batch-review', (req, res, next) => {
  handle(res, next, () => ({
    results: proposals.batchReview(req.params.bookId, req.body || {}),
  }));
});

router.get('/:bookId/ledger/proposals/:proposalId', (req, res, next) => {
  handle(res, next, () => ({
    proposal: proposals.getProposal(req.params.bookId, req.params.proposalId),
  }));
});

router.patch('/:bookId/ledger/proposals/:proposalId', (req, res, next) => {
  handle(res, next, () => ({
    proposal: proposals.updateProposal(
      req.params.bookId,
      req.params.proposalId,
      req.body || {}
    ),
  }));
});

router.post('/:bookId/ledger/proposals/:proposalId/accept', (req, res, next) => {
  handle(res, next, () => proposals.acceptProposal(
    req.params.bookId,
    req.params.proposalId,
    req.body || {}
  ));
});

router.post('/:bookId/ledger/proposals/:proposalId/reject', (req, res, next) => {
  handle(res, next, () => {
    // 双轨对齐（方向报告 1.3）：Agent 入口 requireRejectNote 强制驳回理由，
    // 人工 REST 入口此前可不填——同一条业务规则在所有入口等价。
    const note = String((req.body && req.body.review_note) || '').trim();
    if (!note) {
      const err = new Error('拒绝提案必须填写理由（review_note），留档后才能追溯'); err.status = 400;
      throw err;
    }
    return proposals.rejectProposal(req.params.bookId, req.params.proposalId, req.body || {});
  });
});

router.post('/:bookId/ledger/proposals/:proposalId/merge', (req, res, next) => {
  handle(res, next, () => proposals.mergeProposal(
    req.params.bookId,
    req.params.proposalId,
    req.body && req.body.target_proposal_id,
    req.body && req.body.merged ? req.body.merged : {},
    req.body || {} // options：透传 expected_revision/expected_source_revision/actor（D1-04 乐观锁）
  ));
});

router.post('/:bookId/ledger/backfill', (req, res, next) => {
  handle(res, next, () => backfill.startBackfill(req.params.bookId, req.body || {}), 202);
});

router.get('/:bookId/ledger/backfill', (req, res, next) => {
  handle(res, next, () => ({ status: backfill.getStatus(req.params.bookId) }));
});

router.get('/:bookId/ledger/threads', (req, res, next) => {
  handle(res, next, () => ({
    items: threads.listThreads(req.params.bookId, req.query),
  }));
});

router.post('/:bookId/ledger/threads', (req, res, next) => {
  handle(
    res,
    next,
    () => ({ thread: threads.createThread(req.params.bookId, req.body || {}) }),
    201
  );
});

router.patch('/:bookId/ledger/threads/:threadId', (req, res, next) => {
  handle(res, next, () => ({
    thread: threads.updateThread(req.params.bookId, req.params.threadId, req.body || {}),
  }));
});

router.get('/:bookId/ledger/progress', (req, res, next) => {
  handle(res, next, () => {
    const bookId = ensureBookExists(req.params.bookId);
    const state = db.get(
      "SELECT content, updated_at, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'",
      [bookId]
    ) || { content: '', updated_at: null, stale: 0 };
    const current = db.get(
      `SELECT c.id, c.title, c.sort_order, v.id AS volume_id, v.title AS volume_title
       FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
       WHERE c.book_id = ? ORDER BY COALESCE(v.sort_order, 0) DESC, c.sort_order DESC, c.id DESC LIMIT 1`,
      [bookId]
    );
    return { summary: state.content, updated_at: state.updated_at, current_chapter: current || null, stale: !!state.stale };
  });
});

router.put('/:bookId/ledger/progress', (req, res, next) => {
  handle(res, next, () => {
    const bookId = ensureBookExists(req.params.bookId);
    const summary = req.body && req.body.summary !== undefined
      ? String(req.body.summary).trim()
      : '';
    // A10：story_state.updated_at 统一 SQL localtime（与 DDL 默认及工具/llm 写入点同格式）；
    // 此前 toISOString()（UTC 带 T/Z）与 localtime 混排同列，字符串排序错序（批次 B 遗留）。
    db.run(
      `INSERT INTO story_state (book_id, kind, content, updated_at)
       VALUES (?, 'book_summary', ?, datetime('now','localtime'))
       ON CONFLICT(book_id, kind) DO UPDATE SET
         content = excluded.content, updated_at = excluded.updated_at`,
      [bookId, summary]
    );
    const row = db.get("SELECT updated_at FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]);
    // 保存即刷新底料指纹（4.1 书层传播）：新摘要基于当前章/卷总结 → 清除过期标记
    require('../domain/chapterLifecycle').refreshBookSummaryFingerprint(bookId);
    return { summary, updated_at: row && row.updated_at, stale: false };
  });
});

router.get('/:bookId/ledger/issues', (req, res, next) => {
  handle(res, next, () => {
    const bookId = ensureBookExists(req.params.bookId);
    const staleProposals = db.all(
      `SELECT id, title, chapter_id, 'proposal_stale' AS type
       FROM event_proposals WHERE book_id = ? AND status = 'stale' ORDER BY id DESC`,
      [bookId]
    );
    const orphanEvents = db.all(
      `SELECT id, title, chapter_id, 'event_orphan' AS type
       FROM story_events
       WHERE book_id = ? AND chapter_id IS NULL AND source_revision_hash != ''
       ORDER BY id DESC`,
      [bookId]
    );
    const staleEvents = db.all(
      `SELECT id, title, chapter_id, 'event_evidence_stale' AS type
       FROM story_events WHERE book_id = ? AND source_stale = 1 ORDER BY id DESC`,
      [bookId]
    );
    return { items: [...staleProposals, ...staleEvents, ...orphanEvents] };
  });
});

module.exports = router;
