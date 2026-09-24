const express = require('express');
const { searchEvidence } = require('../evidence/search');
const { parseAnchor } = require('../evidence/anchors');
const db = require('../db');

const router = express.Router({ mergeParams: true });

router.post('/:bookId/evidence/search', async (req, res, next) => {
  try {
    const query = String(req.body && req.body.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'query 不能为空' } });
    }
    const result = await searchEvidence(Number(req.params.bookId), query, {
      topK: Math.max(1, Math.min(30, Number(req.body.top_k) || 12)),
      excludeChapterId: req.body.exclude_chapter_id,
      sourceTypes: req.body.source_types,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/:bookId/evidence/anchors/:anchor', (req, res, next) => {
  try {
    const bookId = Number(req.params.bookId);
    const rawAnchor = decodeURIComponent(req.params.anchor);
    const value = parseAnchor(rawAnchor);
    if (!value) {
      return res.status(400).json({ error: { code: 'INVALID_ANCHOR', message: '证据锚点无效' } });
    }
    if (value.type === 'chapter') {
      const chapter = db.get(
        'SELECT id, title, content, locked FROM chapters WHERE id = ? AND book_id = ?',
        [value.id, bookId]
      );
      if (!chapter) {
        return res.status(404).json({ error: { code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' } });
      }
      const draftLexical = require('../evidence/draftLexical');
      const paras = draftLexical.paragraphs(chapter.content);
      const paragraph = paras[value.paragraphIndex];
      // revisionHash 校验（D2-05）：锚点第三段携带创建时正文的 hash 前缀（见 anchors.chapterAnchor）。
      // 正文编辑后段落会错位，若只用 paragraphIndex 取当前正文，会返回错位文本却标 stale:false（引用核查假阳性）。
      // 故对比当前正文 hash 前缀与锚点记录值，不符即判 stale（无论段落是否仍存在）。
      const currentHashPrefix = draftLexical.revision(chapter.content).slice(0, 8);
      const hashMismatch = Boolean(value.hashPrefix) && value.hashPrefix !== currentHashPrefix;
      return res.json({
        anchor: rawAnchor,
        quote: paragraph ? paragraph.text : '',
        location: { chapterId: chapter.id, paragraphIndex: value.paragraphIndex, revisionHash: currentHashPrefix },
        stale: !paragraph || hashMismatch,
      });
    }
    return res.status(501).json({
      error: { code: 'ANCHOR_LOOKUP_PENDING', message: '该类型锚点将在顾问模块统一读取' },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
