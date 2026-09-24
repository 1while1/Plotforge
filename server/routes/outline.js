// 大纲工作台支撑路由：脉络聚合 + 两个 LLM 规划端点（只建议不落库）。
// LLM 端点不参与按书闸门（与顾问端点同口径）；客户端断开时把 signal 传给模型调用，避免白烧上游。
const express = require('express');
const outline = require('../domain/outlineAssistant');
const { sendDomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

function asyncRoute(work, status = 200) {
  return async (req, res, next) => {
    try { res.status(status).json(await work(req)); }
    catch (err) { if (!sendDomainError(res, err)) next(err); }
  };
}

// 客户端断开 → 中止上游调用（顾问链路没做这一层，新端点补上）。
// 注意必须用 res 的 close：Node 18+ 的 req 'close' 在请求体读完就会触发，
// 拿它当中止信号会把正常请求在模型调用刚开始时就掐掉（实测表现为 This operation was aborted）。
function reqSignal(req, res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded && !ac.signal.aborted) ac.abort(); });
  return ac.signal;
}

// GET /:bookId/outline/timeline —— 卷 + 章（beat/revision/字数/总结态）+ 台账烈度投影，一次出齐
router.get('/:bookId/outline/timeline', asyncRoute(req => outline.buildTimeline(req.params.bookId)));

// POST /:bookId/outline/fill-gap —— 缝隙填补建议：{ volume_id, before_chapter_id?, after_chapter_id? }
router.post('/:bookId/outline/fill-gap', asyncRoute(req =>
  outline.fillGap(req.params.bookId, req.body || {}, { signal: reqSignal(req, req.res) })));

// POST /:bookId/outline/tension-review —— 节奏评语：{ volume_id }
router.post('/:bookId/outline/tension-review', asyncRoute(req =>
  outline.tensionReview(req.params.bookId, req.body || {}, { signal: reqSignal(req, req.res) })));

module.exports = router;
