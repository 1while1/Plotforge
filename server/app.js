const express = require('express');
const path = require('path');
const db = require('./db');
const { isAllowedHost, isAllowedOrigin } = require('./urlGuard');

function createApp() {
  const app = express();
  // A6（第二轮重审查）：DNS rebinding / 跨站简单请求防线。
  // 浏览器请求必带 Host 与 Origin（跨站时），二者必须指向本机或 NOVEL_ALLOWED_HOSTS 白名单；
  // 非浏览器客户端（curl/测试，无 Origin）不受影响。放在所有路由之前，静态资源一并保护。
  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      return res.status(403).json({ error: 'Host 不受信任，已拒绝（DNS rebinding 防护）' });
    }
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Origin 不受信任，已拒绝（跨站防护）' });
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/books', require('./routes/books'));
  app.use('/api/books', require('./routes/health'));
  app.use('/api/books', require('./routes/chapters'));
  app.use('/api/books', require('./routes/volumes'));
  app.use('/api/books', require('./routes/polish'));
  app.use('/api/books', require('./routes/state'));
  app.use('/api/books', require('./routes/characters'));
  app.use('/api/books', require('./routes/advisor'));
  app.use('/api/books', require('./routes/ledger'));
  app.use('/api/books', require('./routes/relations'));
  app.use('/api/books', require('./routes/evidence'));
  app.use('/api/books', require('./routes/sidebar'));
  app.use('/api/books', require('./routes/world'));
  app.use('/api/books', require('./routes/outline'));
  app.use('/api/books', require('./routes/chat'));
  app.use('/api/style-lab', require('./routes/styleLab'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/agent', require('./routes/agent'));
  app.use('/api/persistence', require('./routes/persistence'));
  app.use('/api/runs', require('./routes/runs'));
  app.use('/api/conversations', require('./routes/conversations'));
  // S4-01a：受控资源目录（GET /api/resources）——白名单类型 + 只读查询，与 Agent 只读工具同源
  app.use('/api/resources', require('./routes/resources'));
  // S4-04a：规划笔记（草稿）与显式交接（草案/预览/幂等采纳）。同一模块服务
  // /api/planning-notes 与 /api/handoffs 两条前缀（契约 01 §6），故挂 /api。
  app.use('/api', require('./routes/handoffs'));

  // 持久化健康度（A3）：有未落盘改动/落盘重试耗尽时，前端可据此挂“未保存”横幅，
  // 不再让“磁盘坏了但一切照常 200”的静默停摆对用户不可见。
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, persistence: db.getPersistenceStatus() });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: { code: 'API_NOT_FOUND', message: '接口不存在' },
    });
  });

  app.use((err, req, res, next) => {
    console.error('[server error]', err.message);
    if (err.code && err.status) {
      const error = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      return res.status(err.status).json({ error });
    }
    return res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

module.exports = { createApp };
