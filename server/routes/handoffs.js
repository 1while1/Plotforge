// S4-04a / 契约 01 §6：/api/planning-notes 与 /api/handoffs 的唯一 HTTP 入口
// （两条前缀由同一模块提供，见契约「挂在 handoffs 路由模块」）。
//   POST/GET /api/planning-notes、PUT /api/planning-notes/:id（草稿笔记，带 revision 乐观锁）
//   POST /api/handoffs（草案）、GET /api/handoffs/:id（预览）、POST /api/handoffs/:id/accept
// 本路由只做「请求字段白名单 + 透传给服务」：状态、acceptedAt、来源指纹、revision
// 全部由服务端产生，客户端携带这些字段一律 400（不能伪造「已采纳」或别人的指纹）。
const express = require('express');
const svc = require('../conversations/handoffs');

const router = express.Router();

const NOTE_CREATE_KEYS = new Set(['conversationId', 'title', 'text', 'selectedMessageIds']);
const NOTE_UPDATE_KEYS = new Set(['expectedRevision', 'title', 'text']);
const NOTE_QUERY_KEYS = new Set(['bookId', 'conversationId']);
const HANDOFF_CREATE_KEYS = new Set([
  'originConversationId', 'targetConversationId', 'selectedMessageIds', 'text', 'sourceRefs',
]);
const HANDOFF_ACCEPT_KEYS = new Set(['expectedSourceFingerprint']);
// 作废只接受空体：状态迁移完全由服务端判断（客户端不能说「把它设成 cancelled」）
const HANDOFF_CANCEL_KEYS = new Set([]);

function rejectFields(res, body, allowed, code) {
  const unknown = Object.keys(body || {}).filter(key => !allowed.has(key));
  if (!unknown.length) return false;
  res.status(400).json({
    error: {
      code,
      message: `不允许的字段：${unknown.join(', ')}（状态/版本/指纹等由服务端产生）`,
    },
  });
  return true;
}

router.post('/planning-notes', (req, res, next) => {
  try {
    const body = req.body || {};
    if (rejectFields(res, body, NOTE_CREATE_KEYS, 'NOTE_FIELD_FORBIDDEN')) return;
    res.status(201).json(svc.createPlanningNote(body));
  } catch (err) {
    next(err);
  }
});

router.get('/planning-notes', (req, res, next) => {
  try {
    const query = req.query || {};
    const unknown = Object.keys(query).filter(key => !NOTE_QUERY_KEYS.has(key));
    if (unknown.length) {
      return res.status(400).json({
        error: { code: 'NOTE_FIELD_FORBIDDEN', message: `查询参数不允许：${unknown.join(', ')}` },
      });
    }
    res.json({ notes: svc.listPlanningNotes({ bookId: query.bookId, conversationId: query.conversationId }) });
  } catch (err) {
    next(err);
  }
});

router.put('/planning-notes/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    if (rejectFields(res, body, NOTE_UPDATE_KEYS, 'NOTE_FIELD_FORBIDDEN')) return;
    res.json(svc.updatePlanningNote({
      noteId: req.params.id,
      expectedRevision: body.expectedRevision,
      title: body.title,
      text: body.text,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/handoffs', (req, res, next) => {
  try {
    const body = req.body || {};
    if (rejectFields(res, body, HANDOFF_CREATE_KEYS, 'HANDOFF_FIELD_FORBIDDEN')) return;
    res.status(201).json(svc.createHandoff(body));
  } catch (err) {
    next(err);
  }
});

router.get('/handoffs/:id', (req, res, next) => {
  try {
    res.json(svc.getHandoffPreview(req.params.id));
  } catch (err) {
    next(err);
  }
});

// 作废草案（只对 draft 生效；已采纳 409——作废不撤回已写进写作会话的消息）
router.post('/handoffs/:id/cancel', (req, res, next) => {
  try {
    const body = req.body || {};
    if (rejectFields(res, body, HANDOFF_CANCEL_KEYS, 'HANDOFF_FIELD_FORBIDDEN')) return;
    res.json(svc.cancelHandoff({ handoffId: req.params.id }));
  } catch (err) {
    next(err);
  }
});

router.post('/handoffs/:id/accept', (req, res, next) => {
  try {
    const body = req.body || {};
    if (rejectFields(res, body, HANDOFF_ACCEPT_KEYS, 'HANDOFF_FIELD_FORBIDDEN')) return;
    res.json(svc.acceptHandoff({
      handoffId: req.params.id,
      expectedSourceFingerprint: body.expectedSourceFingerprint,
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
