// S4-01a / 契约 01 §6：GET /api/resources —— 受控资源目录的唯一 HTTP 入口。
//   ?type=<枚举>[&bookId=<id>][&id=<id> | &cursor=<nextCursor>][&limit=<n>]
//   列表 → { type, bookId, items, nextCursor }；摘要（带 id）→ { type, bookId, resource }。
//
// 本路由只做「查询键白名单 + 参数透传给 catalog」，不含任何 SQL：
// 类型枚举、书归属校验、分页 cursor 与错误码都在 server/resources/catalog.js 一处，
// 模型工具（list_resources / get_resource_summary）走同一函数——HTTP 与工具不会漂移。
// 注意：不是文件接口，也不是 settings 接口；不接受路径、表名或任意查询键。
const express = require('express');
const catalog = require('../resources/catalog');

const router = express.Router();

// 允许的查询键（其余一律 400：伪造字段不能靠「被忽略」蒙混过关）
const ALLOWED_QUERY_KEYS = new Set(['type', 'bookId', 'id', 'cursor', 'limit']);

router.get('/', (req, res, next) => {
  try {
    const query = req.query || {};
    const unknown = Object.keys(query).filter(key => !ALLOWED_QUERY_KEYS.has(key));
    if (unknown.length) {
      return res.status(400).json({
        error: {
          code: 'RESOURCE_FIELD_FORBIDDEN',
          message: `查询参数不允许：${unknown.join(', ')}；只接受 type/bookId/id/cursor/limit`,
        },
      });
    }
    const { type, bookId, id, cursor, limit } = query;
    if (id !== undefined) {
      return res.json(catalog.getResourceSummary({ type, id, bookId }));
    }
    res.json(catalog.listResources({ type, bookId, cursor, limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
