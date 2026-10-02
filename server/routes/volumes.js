const express = require('express');
const db = require('../db');
const { callLLM } = require('../llm');
const ledger = require('../domain/storyLedger');
const lifecycle = require('../domain/chapterLifecycle');
const sourceGuard = require('../domain/sourceGuard');

const router = express.Router({ mergeParams: true });

// GET /:bookId/volumes
router.get('/:bookId/volumes', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const volumes = db.all(
      `SELECT v.*, 
              (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id) AS chapter_count
       FROM volumes v
       WHERE v.book_id = ?
       ORDER BY v.sort_order, v.id`,
      [bookId]
    );
    res.json({ volumes });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/volumes
router.post('/:bookId/volumes', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const body = req.body || {};

    if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    // 文本字段类型守卫：非字符串此前直接 .trim() 崩 500（实测 body.intro.trim is not a function）
    for (const field of ['title', 'intro', 'outline']) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
        return res.status(400).json({ error: `${field} 必须是字符串` });
      }
    }

    const countRow = db.get('SELECT COUNT(*) AS count FROM volumes WHERE book_id = ?', [bookId]);
    const nextNumber = countRow.count + 1;

    const maxRow = db.get('SELECT MAX(sort_order) AS max FROM volumes WHERE book_id = ?', [bookId]);
    const nextSortOrder = (maxRow.max || 0) + 1;

    const title = body.title && body.title.trim() ? body.title.trim() : `第${nextNumber}卷`;
    const intro = body.intro !== undefined && body.intro !== null ? body.intro.trim() : null;
    const outline = body.outline !== undefined && body.outline !== null ? body.outline.trim() : null;

    const result = db.run(
      'INSERT INTO volumes (book_id, title, intro, outline, sort_order) VALUES (?, ?, ?, ?, ?)',
      [bookId, title, intro, outline, nextSortOrder]
    );

    const volume = db.get(
      `SELECT v.*, 
              (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id) AS chapter_count
       FROM volumes v
       WHERE v.id = ?`,
      [result.lastInsertRowid]
    );

    res.status(201).json({ volume });
  } catch (err) {
    next(err);
  }
});

// GET /:bookId/volumes/:id
router.get('/:bookId/volumes/:id', (req, res, next) => {
  try {
    const { bookId, id } = req.params;
    const volume = db.get(
      `SELECT v.*, 
              (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id) AS chapter_count
       FROM volumes v
       WHERE v.id = ? AND v.book_id = ?`,
      [id, bookId]
    );

    if (!volume) {
      return res.status(404).json({ error: '卷不存在' });
    }

    res.json({ volume });
  } catch (err) {
    next(err);
  }
});

// PUT /:bookId/volumes/:id
router.put('/:bookId/volumes/:id', (req, res, next) => {
  try {
    const { bookId, id } = req.params;
    const body = req.body || {};

    const existing = db.get('SELECT id FROM volumes WHERE id = ? AND book_id = ?', [id, bookId]);
    if (!existing) {
      return res.status(404).json({ error: '卷不存在' });
    }

    const allowedFields = ['title', 'intro', 'outline', 'summary', 'sort_order'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === 'sort_order') {
          const sortOrder = Number(body[field]);
          if (!Number.isInteger(sortOrder)) {
            return res.status(400).json({ error: 'sort_order 必须是整数' });
          }
          updates.push('sort_order = ?');
          values.push(sortOrder);
        } else {
          if (body[field] !== null && typeof body[field] !== 'string') {
            return res.status(400).json({ error: `${field} 必须是字符串` });
          }
          updates.push(`${field} = ?`);
          values.push(body[field] === null ? null : body[field].trim());
        }
      }
    }

    if (updates.length > 0) {
      values.push(id, bookId);
      db.run(
        `UPDATE volumes SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`,
        values
      );
    }

    // S5-01：手改卷总结同样是「基于当前底料」的保存——刷新底料指纹、清除过期标记，
    // 并让全书摘要层的底料变化生效（与 REST 生成路径、Agent 工具 save_volume_summary 同口径，
    // 此前手改路径不刷指纹不清 stale 也不传播书层）
    let summaryRefreshed = false;
    let bookSummaryStale = false;
    if (body.summary !== undefined) {
      lifecycle.refreshVolumeSummaryFingerprint(bookId, id);
      bookSummaryStale = lifecycle.markBookSummaryStale(bookId);
      summaryRefreshed = true;
    }

    // 卷调序改变叙事顺序 → 同步重建投影（方向报告 1.5）；文本字段不动叙事序，不重建
    const structureChanged = body.sort_order !== undefined;
    const projection = structureChanged
      ? ledger.rebuildProjectionsAfterStructureChange(bookId, 'volume-sort')
      : null;

    const volume = db.get(
      `SELECT v.*,
              (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id) AS chapter_count
       FROM volumes v
       WHERE v.id = ? AND v.book_id = ?`,
      [id, bookId]
    );

    res.json({
      volume,
      projection_rebuilt: Boolean(structureChanged),
      projection,
      summary_refreshed: summaryRefreshed,
      book_summary_stale: bookSummaryStale,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:bookId/volumes/:id
router.delete('/:bookId/volumes/:id', (req, res, next) => {
  try {
    const { bookId, id } = req.params;

    const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [id, bookId]);
    if (!volume) {
      return res.status(404).json({ error: '卷不存在' });
    }

    const chapterCount = db.get(
      'SELECT COUNT(*) AS count FROM chapters WHERE volume_id = ?',
      [id]
    ).count;

    if (chapterCount > 0) {
      const volumeCount = db.get(
        'SELECT COUNT(*) AS count FROM volumes WHERE book_id = ?',
        [bookId]
      ).count;

      if (volumeCount <= 1) {
        return res.status(400).json({ error: '卷内还有章节，无法删除唯一分卷' });
      }

      const targetVolume = db.get(
        'SELECT id FROM volumes WHERE book_id = ? AND id != ? ORDER BY sort_order, id LIMIT 1',
        [bookId, id]
      );

      if (targetVolume) {
        db.run(
          'UPDATE chapters SET volume_id = ?, revision = revision + 1 WHERE volume_id = ?',
          [targetVolume.id, id]
        );
      }
    }

    db.run('DELETE FROM volumes WHERE id = ?', [id]);
    // 删卷改变剩余章节的叙事分组与排序 → 同步重建投影（方向报告 1.5）
    const projection = ledger.rebuildProjectionsAfterStructureChange(bookId, 'volume-delete');
    res.json({ ok: true, projection_rebuilt: true, projection });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/volumes/:id/summary
router.post('/:bookId/volumes/:id/summary', async (req, res, next) => {
  try {
    const { bookId, id } = req.params;

    const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [id, bookId]);
    if (!volume) {
      return res.status(404).json({ error: '卷不存在' });
    }

    const chapters = db.all(
      `SELECT title, summary
       FROM chapters
       WHERE volume_id = ? AND summary IS NOT NULL AND summary != ''
       ORDER BY sort_order, id`,
      [id]
    );

    if (chapters.length === 0) {
      return res.status(400).json({ error: '本卷还没有章节总结，请先为章节生成总结' });
    }

    let chapterSummaryText = chapters
      .map(ch => `《${ch.title}》：${ch.summary}`)
      .join('\n');

    if (chapterSummaryText.length > 6000) {
      // 保尾：章总结按叙事正序拼接，卷末章的状态与悬念对卷概要最重要（系统提示也
      // 要求涵盖「卷末状态与悬念」）——此前保头截断会把卷末内容静默舍弃
      chapterSummaryText = '……（前面章节总结略）\n' + chapterSummaryText.slice(chapterSummaryText.length - 6000);
    }

    const userContent = `卷名：《${volume.title}》\n各章总结：\n${chapterSummaryText}`;

    const messages = [
      {
        role: 'system',
        content: '你是小说编辑。把一卷小说的各章总结压缩成一段卷级概要，300字以内，涵盖主线进展、关键转折、卷末状态与悬念。只输出概要正文。'
      },
      {
        role: 'user',
        content: userContent
      }
    ];

    // S5-01/C06：来源快照必须在 await 模型之前捕获（指纹含卷标题 + 卷内有总结章的有序
    // title/summary + 结构位置 + 配置摘要；不含卷总结自身，保存后不会立刻自判过期）。
    const sourceSnapshot = sourceGuard.captureSource({ bookId, kind: 'volume', entityId: id });
    // 思考模型会把推理 token 一并计入 max_tokens：500 的预算实测被推理吃光后只剩
    // 一句残句（甚至空正文报错）。300 字正文 ~600 token，预算放宽到 10000 以容纳
    // 长卷多章摘要汇总时的推理开销。
    const summary = await callLLM(messages, {
      maxTokens: 10000,
      temperature: 0.5
    });

    const trimmedSummary = summary.trim();

    // 最终核验与写回在同一个同步事务内（核验与写回之间无 await；生成期间不持有事务）
    const bookSummaryStale = db.transaction(() => {
      // 生成期间底料变化（章总结改写/删章/换卷/调序/卷改名）→ 409 SOURCE_CHANGED，
      // 不把基于旧底料的结果洗白成「基于新底料」的卷总结
      sourceGuard.assertSourceCurrent(sourceSnapshot);
      db.run(
        'UPDATE volumes SET summary = ? WHERE id = ?',
        [trimmedSummary, id]
      );
      // 记录底料指纹：新总结基于当前章总结生成，此后任一章总结变化/清空即标过期
      // （方向报告 4.1）。此前 REST 路径漏刷指纹（只有 Agent 工具 save_volume_summary
      // 刷），summary_based_on 恒为空 → markVolumeSummaryStale 的「无指纹不动」守卫
      // 让传播链在 REST 路径断裂（W13）：章总结更新后卷/书总结永不失效。
      lifecycle.refreshVolumeSummaryFingerprint(bookId, id);
      // 卷总结本身是全书摘要的底料 → 变化后全书摘要若基于旧卷总结则标过期（4.1 书层传播）
      return lifecycle.markBookSummaryStale(bookId);
    });

    res.json({
      summary: trimmedSummary,
      source_fingerprint: sourceSnapshot.fingerprint,
      book_summary_stale: bookSummaryStale,
    });
  } catch (err) {
    // S5-01：来源变化等业务错误按其 code/status 返回（与 chapters 总结路由同口径），
    // 不再走全局处理器导致 code 被包进 error 对象
    if (err.code && err.status) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
    next(err);
  }
});

module.exports = router;
