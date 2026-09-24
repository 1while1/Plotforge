// 状态簿读写：人物状态 / 未回收伏笔 / 全书进展摘要
const express = require('express');
const db = require('../db');

const router = express.Router({ mergeParams: true });

const KINDS = ['characters', 'foreshadowing', 'book_summary'];

// 读写前统一校验书籍存在：此前 GET 对不存在的书返回空 200、PUT 靠 FK 异常 500，
// 且非字符串输入会被 String() 序列化成 "[object Object]" 落库
function ensureBookExists(bookId, res) {
  const id = Number(bookId);
  if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT id FROM books WHERE id = ?', [id])) {
    res.status(404).json({ error: '书籍不存在' });
    return null;
  }
  return id;
}

// GET /:bookId/state → { states: { characters: {content, updated_at}, ... } }
router.get('/:bookId/state', (req, res, next) => {
  try {
    const bookId = ensureBookExists(req.params.bookId, res);
    if (bookId === null) return;
    const rows = db.all('SELECT kind, content, updated_at FROM story_state WHERE book_id = ?', [bookId]);
    const states = {};
    for (const k of KINDS) states[k] = { content: '', updated_at: null };
    for (const r of rows) {
      if (KINDS.includes(r.kind)) states[r.kind] = { content: r.content, updated_at: r.updated_at };
    }
    res.json({ states });
  } catch (err) {
    next(err);
  }
});

// PUT /:bookId/state body { characters?, foreshadowing?, book_summary? }
router.put('/:bookId/state', (req, res, next) => {
  try {
    const bookId = ensureBookExists(req.params.bookId, res);
    if (bookId === null) return;
    // A10：story_state.updated_at 统一 SQL localtime（与 DDL 默认及 ledger/工具/llm 写入点同格式）
    let bookSummarySaved = false;
    for (const kind of KINDS) {
      if (req.body[kind] === undefined) continue;
      if (typeof req.body[kind] !== 'string') {
        return res.status(400).json({ error: `状态簿 ${kind} 字段必须是字符串` });
      }
      const content = req.body[kind].trim();
      db.run(
        "INSERT INTO story_state (book_id, kind, content, updated_at) VALUES (?, ?, ?, datetime('now','localtime')) ON CONFLICT(book_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
        [bookId, kind, content]
      );
      if (kind === 'book_summary') bookSummarySaved = true;
    }
    // 手写全书摘要也是一次「基于当前底料的保存」→ 刷新底料指纹（4.1 书层传播）
    if (bookSummarySaved) require('../domain/chapterLifecycle').refreshBookSummaryFingerprint(bookId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
