// POST /api/persistence/flush —— S1-01/C01：作者 UI 主动触发落盘的受控入口。
// 挂在 app 级 Host/Origin 防护之后；只把已应用到内存的数据写盘，绝不重做业务写入；
// 不注册为 LLM 工具（工具面由 server/tools/registry.js 集中治理）。
const express = require('express');
const { flushNow } = require('../persistence');

const router = express.Router();

router.post('/flush', (req, res) => {
  const flushed = flushNow();
  if (!flushed.persistence.durable) {
    return res.status(503).json({
      ok: false,
      error: '写入磁盘仍失败：改动已保留在内存中并将自动重试；请检查磁盘后重试，期间请勿关闭页面，也不要重复提交同一内容。',
      code: 'PERSISTENCE_PENDING',
      persistence: flushed.persistence,
    });
  }
  res.json({ ok: true, applied: flushed.applied, persistence: flushed.persistence });
});

module.exports = router;
