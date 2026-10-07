// 运行记录读取（S2-01 / 契约 3.1）：GET /api/runs/:id 与 /api/runs/:id/events。
// 只读接口——重复请求（duplicate JSON）的前端从这里回读原运行的事件与终态，
// 不需要重发业务请求。挂在全局 Host/Origin 防护之后；会话归属用 x-session-key
// （或 ?session_key=）比对运行所属会话，错会话 403，不信任浏览器任意字符串
// 读别人的运行。payload 在写入端已脱敏，读取端再做一层键过滤兜底。
const express = require('express');
const runService = require('../runtime/run-service');

const router = express.Router();

function sessionKeyOf(req, res) {
  const key = req.headers['x-session-key'] || (req.query && req.query.session_key) || '';
  const clean = String(key).slice(0, 128);
  if (!clean) {
    res.status(403).json({ error: { code: 'RUN_SESSION_REQUIRED', message: '缺少会话标识（x-session-key）' } });
    return null;
  }
  return clean;
}

router.get('/:id', (req, res) => {
  const sessionKey = sessionKeyOf(req, res);
  if (!sessionKey) return;
  const run = runService.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
  if (run.sessionKey !== sessionKey) {
    return res.status(403).json({ error: { code: 'RUN_ACCESS_DENIED', message: '该运行不属于当前会话' } });
  }
  res.json({ run });
});

router.get('/:id/events', (req, res) => {
  const sessionKey = sessionKeyOf(req, res);
  if (!sessionKey) return;
  const run = runService.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
  if (run.sessionKey !== sessionKey) {
    return res.status(403).json({ error: { code: 'RUN_ACCESS_DENIED', message: '该运行不属于当前会话' } });
  }
  const afterSeq = Number(req.query.afterSeq) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const events = runService.listRunEvents(run.id, { afterSeq, limit });
  res.json({
    runId: run.id,
    status: run.status,
    events,
    nextAfterSeq: events.length ? events[events.length - 1].seq : afterSeq,
    hasMore: events.length === limit,
  });
});

router.get('/:id/read-evidence', (req, res) => {
  const sessionKey = sessionKeyOf(req, res);
  if (!sessionKey) return;
  const run = runService.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
  if (run.sessionKey !== sessionKey) {
    return res.status(403).json({ error: { code: 'RUN_ACCESS_DENIED', message: '该运行不属于当前会话' } });
  }
  res.json({ runId: run.id, evidence: require('../runtime/read-evidence').listForRun(run.id) });
});

module.exports = router;
