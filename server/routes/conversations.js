// S3-01 / C10-A：/api/conversations 路由（契约 §4 的 S3-01 子集）。
//   列表/创建/详情/消息分页/归档。compress、compress/restore、import-legacy-agent
//   属 S3-02/S3-04，不在本文件。
//   安全边界：POST /:id/messages 是普通聊天输入——只接受 content（可选 source 白名单），
//   任何服务端专属字段（role/toolFacts/runId/…）出现在请求体即 400：客户端不能伪造
//   system 消息、工具事实或借用其他会话的运行身份。
const express = require('express');
const db = require('../db');
const svc = require('../conversations/service');

const router = express.Router();

// 服务端专属字段黑名单：这些字段只能由 appendMessage 的服务端调用方提供
const FORBIDDEN_MESSAGE_KEYS = [
  'role', 'toolFacts', 'tool_facts', 'tool_facts_json', 'runId', 'run_id',
  'id', 'messageId', 'created_at', 'book_id', 'bookId', 'conversationId', 'conversation_id',
  'compressed', 'tools_json', 'toolsJson', 'tools', 'reasoning',
];

router.get('/', (req, res, next) => {
  try {
    const { kind, scope, bookId, status } = req.query;
    res.json(svc.listConversations({ kind, scope, bookId, status }));
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const { kind, scope, bookId, title } = req.body || {};
    const created = svc.createConversation({ kind, scope, bookId, title });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const conv = svc.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' } });
    const count = db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [conv.id]);
    res.json({ ...conv, messageCount: count.n });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/messages', (req, res, next) => {
  try {
    const result = svc.listMessages(req.params.id, {
      afterId: req.query.afterId,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages', (req, res, next) => {
  try {
    const body = req.body || {};
    const forbidden = FORBIDDEN_MESSAGE_KEYS.filter(key => key in body);
    if (forbidden.length) {
      return res.status(400).json({
        error: {
          code: 'MESSAGE_FIELD_FORBIDDEN',
          message: `请求体不允许携带服务端专属字段：${forbidden.join(', ')}`,
        },
      });
    }
    const { content, source } = body;
    // 客户端可声明的来源页白名单比服务端窄：system 是服务端续跑事件专属，客户端伪造一律拒
    if (source !== undefined && source !== null && !svc.CLIENT_SOURCES.has(source)) {
      return res.status(400).json({
        error: { code: 'INVALID_MESSAGE_SOURCE', message: "source 只能是 ''/writing/read/agent" },
      });
    }
    const created = svc.appendMessage({ conversationId: req.params.id, role: 'user', content, source });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/archive', (req, res, next) => {
  try {
    res.json(svc.archiveConversation(req.params.id));
  } catch (err) {
    next(err);
  }
});

// S3-04：会话压缩/恢复（两个空间各自独立；压缩只改组装方式不删原消息）。
// body: { expectedLastMessageId?, targetTokens? }——expectedLastMessageId 是源版本
// 乐观锁，压缩期间来了新消息 → 409 SOURCE_CHANGED。
router.post('/:id/compress', async (req, res, next) => {
  try {
    const compression = require('../conversations/compression');
    const { expectedLastMessageId, targetTokens } = req.body || {};
    const result = await compression.compressConversation({
      conversationId: req.params.id, expectedLastMessageId, targetTokens,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/compress/restore', (req, res, next) => {
  try {
    res.json(require('../conversations/compression').restoreConversation(req.params.id));
  } catch (err) {
    next(err);
  }
});

// legacy localStorage Agent 历史导入（契约 §4/§5）：作者预览后选择 global 或特定书；
// 按批次摘要幂等；导入消息无可信工具事实。导入成功后是否清理浏览器本地副本由作者决定，
// 服务端不提供「导入即清空」的合并操作。
router.post('/import-legacy-agent', (req, res, next) => {
  try {
    const { scope, bookId, title, messages } = req.body || {};
    const result = svc.importLegacyAgent({ scope, bookId, title, messages });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
