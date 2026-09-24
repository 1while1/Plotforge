const express = require('express');
const db = require('../db');
const { summarizeChapter, checkDriftResult } = require('../llm');
const vectorStore = require('../vector/store');
const lifecycle = require('../domain/chapterLifecycle');
const sourceGuard = require('../domain/sourceGuard');
const ledger = require('../domain/storyLedger');
const versions = require('../versions');

const router = express.Router({ mergeParams: true });

// S1-01/C01：关键写出口统一走 persistResult——业务已应用到内存后同步落盘，
// 未落盘返回 503 PERSISTENCE_PENDING（applied=true、附当前实体），绝不假成功。
function sendPersisted(res, payload) {
  const persisted = require('../persistence').persistResult(payload);
  if (!persisted.persistence.durable) {
    return res.status(503).json({
      error: '内容已保存到内存，但写入磁盘失败：系统将自动重试落盘。请勿关闭页面，也不要重复提交同一内容。',
      code: 'PERSISTENCE_PENDING',
      applied: true,
      ...persisted.result,
      persistence: persisted.persistence,
    });
  }
  return res.json({ ...persisted.result, persistence: persisted.persistence });
}

// GET /:bookId/chapters
router.get('/:bookId/chapters', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const rows = db.all(
      `SELECT c.*, v.title AS volume_title, COALESCE(v.sort_order, 2147483647) AS volume_sort_order,
              EXISTS(SELECT 1 FROM embeddings e WHERE e.chapter_id = c.id) AS indexed
       FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
       WHERE c.book_id = ?
       ORDER BY COALESCE(v.sort_order, 2147483647), COALESCE(v.id, 2147483647), c.sort_order, c.id`,
      [bookId]
    );

    const positions = new Map(require('../domain/chapterNavigation').listChapterPositions(Number(bookId)).map(chapter => [chapter.id, chapter]));
    const chapters = rows.map((row) => ({
      ...row,
      volume_ordinal: positions.get(row.id).volume_ordinal,
      chapter_ordinal: positions.get(row.id).chapter_ordinal,
      global_ordinal: positions.get(row.id).global_ordinal,
      content: row.content ? row.content.slice(0, 100) : '',
      content_length: row.content ? row.content.length : 0,
    }));

    res.json({ chapters });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/chapters
router.post('/:bookId/chapters', (req, res, next) => {
  try {
    const body = req.body || {};
    const chapter = require('../domain/chapterCatalog').createChapter(req.params.bookId, {
      volumeId: body.volume_id, title: body.title, beat: body.beat,
    });
    sendPersisted(res, { chapter });
  } catch (err) {
    if (err.code && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// GET /:bookId/chapters/:id
router.get('/:bookId/chapters/:id', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const id = req.params.id;

    const chapter = db.get(
      'SELECT * FROM chapters WHERE id = ? AND book_id = ?',
      [id, bookId]
    );

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    res.json({ chapter });
  } catch (err) {
    next(err);
  }
});

// PUT /:bookId/chapters/:id
router.put('/:bookId/chapters/:id', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const id = req.params.id;
    const body = req.body || {};

    // S1-03/C04-B：编辑统一走单调版本比较交换（S1-02 领域入口）。秒级 updated_at
    // 乐观锁已废弃（同秒双写实测双双成功）；缺 expected_revision 一律 428，不以
    // “兼容旧客户端”为由无条件写入。白名单字段在路由边界收敛，其余 body 键忽略。
    const patch = {};
    for (const key of ['title', 'content', 'summary', 'beat', 'volume_id', 'sort_order']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }

    const applied = require('../domain/chapterMutations').applyChapterMutation({
      bookId,
      chapterId: id,
      expectedRevision: body.expected_revision,
      patch,
      reason: 'before-manual-edit',
    });

    // S5-01：手改章总结与 save_chapter_summary 工具同口径——章总结是全书摘要的直接底料，
    // 手改路径必须直达书层标过期（此前只有工具路径标，REST 手改不标，同一次逻辑变更两侧不一致）
    const bookSummaryStale = body.summary !== undefined ? lifecycle.markBookSummaryStale(bookId) : false;

    // A2：正典正文/章节编辑同步落盘；S1-01 起接入持久化结果契约
    sendPersisted(res, {
      chapter: applied.chapter,
      autoUnlocked: applied.autoUnlocked,
      invalidated: applied.invalidated,
      projection_rebuilt: applied.structureChanged,
      projection: applied.projection,
      summary_stale: applied.summaryStale,
      book_summary_stale: bookSummaryStale,
    });
  } catch (err) {
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

// POST /:bookId/chapters/:id/lock —— 定稿：锁定章节并异步建立向量索引
router.post('/:bookId/chapters/:id/lock', (req, res, next) => {
  try {
    res.json(lifecycle.relockChapter(req.params.bookId, req.params.id));
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/chapters/:id/unlock —— 解除定稿：解锁并删除向量
router.post('/:bookId/chapters/:id/unlock', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const id = req.params.id;
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [id, bookId]);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });

    res.json(lifecycle.unlockChapter(bookId, id));
  } catch (err) {
    next(err);
  }
});

// GET /:bookId/vector-status —— 本书向量索引概况
router.get('/:bookId/vector-status', (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const lockedChapters = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND locked = 1', [bookId]).n;
    res.json({
      chunks: vectorStore.bookChunkCount(Number(bookId)),
      lockedChapters,
    });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/chapters/reindex —— 一键补建缺失向量索引（方向报告 3.2）
// 索引失败此前只记日志且无重试入口：该章从此不在定稿语义检索中。
// 异步执行（首章可能触发模型冷加载 10~30s），前端可轮询 vector-status。
router.post('/:bookId/chapters/reindex', (req, res, next) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      return res.status(404).json({ error: '书籍不存在' });
    }
    const missing = db.get(
      `SELECT COUNT(*) AS n FROM chapters c
       WHERE c.book_id = ? AND c.locked = 1 AND c.content != ''
         AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chapter_id = c.id)`,
      [bookId]
    ).n;
    // execute:false 供测试/预览只查缺口不真正跑模型
    const execute = !req.body || req.body.execute !== false;
    if (missing > 0 && execute) {
      require('../vector/indexer').indexBookMissing(bookId)
        .then(r => console.log(`[vector] 手动重建完成 book=${bookId} chapters=${r.chapters} chunks=${r.chunks}`))
        .catch(e => console.error('[vector] 手动重建失败:', e.message));
    }
    res.json({ started: missing > 0 && execute, missing });
  } catch (err) {
    next(err);
  }
});

// DELETE /:bookId/chapters/:id
// S1-06/C05：删章先落回收快照（同事务：快照失败则不删除），正文与历史版本可恢复
router.delete('/:bookId/chapters/:id', (req, res, next) => {
  try {
    const result = require('../domain/chapterRecycle').deleteChapterWithRecycle({
      bookId: req.params.bookId,
      chapterId: req.params.id,
      reason: ((req.body || {}).reason) || 'manual-delete',
    });
    // A2：删除同步落盘；S1-01 起接入持久化结果契约
    sendPersisted(res, result);
  } catch (err) {
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

// GET /:bookId/chapter-recycle —— 本书已删章节的回收清单（不含全文，只含元信息）
router.get('/:bookId/chapter-recycle', (req, res, next) => {
  try {
    const items = require('../domain/chapterRecycle').listRecycledChapters(req.params.bookId);
    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/chapter-recycle/:id/restore —— 恢复正文与历史版本。
// body: { volume_id?: number|null }——原卷已删时必须指定（409 附现有卷清单）；
// volume_id: null 表示明确恢复为未归卷。恢复不触发模型调用、不复活旧确认。
router.post('/:bookId/chapter-recycle/:id/restore', (req, res, next) => {
  try {
    const body = req.body || {};
    const volumeId = body.volume_id === null ? null : (body.volume_id === undefined ? undefined : Number(body.volume_id));
    const result = require('../domain/chapterRecycle').restoreRecycledChapter({
      bookId: req.params.bookId,
      recycleId: req.params.id,
      volumeId,
    });
    sendPersisted(res, result);
  } catch (err) {
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

// POST /:bookId/drift-check-all —— 当前卷全部有总结章节的批量对齐检查
router.post('/:bookId/drift-check-all', async (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) return res.status(404).json({ error: '书籍不存在' });

    // 当前卷（最新一卷）有总结的章节
    const vol = db.get('SELECT id FROM volumes WHERE book_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1', [bookId]);
    if (!vol) return res.status(400).json({ error: '还没有分卷' });

    const chapters = db.all(
      "SELECT * FROM chapters WHERE book_id = ? AND volume_id = ? AND summary != '' ORDER BY sort_order, id",
      [bookId, vol.id]
    );
    if (!chapters.length) return res.status(400).json({ error: '当前卷还没有章节总结' });

    const results = [];
    for (const ch of chapters) {
      // S5-03/R02：结果分类走 checkDriftResult——无大纲=null（未检测，整条跳过）；
      // 上游失败（空输出/解析失败）=显式 status:'failed' + code + 上游证据，不写库、不写成「符合」
      const outcome = await checkDriftResult(book, ch);
      if (!outcome) continue;
      if (outcome.status !== 'failed') {
        db.run('UPDATE chapters SET drift_status = ?, drift_note = ? WHERE id = ?', [outcome.status, outcome.note, ch.id]);
      }
      results.push({ id: ch.id, title: ch.title, ...outcome });
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /:bookId/chapters/:id/summary
router.post('/:bookId/chapters/:id/summary', async (req, res, next) => {
  try {
    const bookId = req.params.bookId;
    const id = req.params.id;

    const chapter = db.get(
      'SELECT * FROM chapters WHERE id = ? AND book_id = ?',
      [id, bookId]
    );

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    if (!chapter.content) {
      return res.status(400).json({ error: '章节内容为空，无法生成总结' });
    }

    // S5-01/C06：来源快照必须在 await 模型之前捕获（指纹含标题/正文/结构位置/配置摘要，
    // 不含 summary 自身——保存总结不会让指纹立刻过期）；最终核验与写回在同一个同步事务内，
    // 核验与写回之间无 await，模型生成期间不持有事务。
    const sourceSnapshot = sourceGuard.captureSource({ bookId, kind: 'chapter', entityId: id });
    const summary = await summarizeChapter(chapter);

    const committed = db.transaction(() => {
      // 来源已变（改稿/改名/移位/删章）→ 409 SOURCE_CHANGED；随后仍以读取时 revision 做 CAS
      sourceGuard.assertSourceCurrent(sourceSnapshot);
      const applied = require('../domain/chapterMutations').applyChapterMutationInTransaction({
        bookId,
        chapterId: id,
        expectedRevision: sourceSnapshot.refs[0] && sourceSnapshot.refs[0].revision,
        patch: { summary },
        reason: 'before-summary-generate',
      });
      // 章总结刷新 → 全书摘要若基于旧底料则标过期（卷总结过期已由领域入口联动；方向报告 4.1）
      lifecycle.markBookSummaryStale(bookId);
      return applied;
    });

    const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
    // 事实抽取改为「定稿」时统一触发；生成总结只产出摘要与偏离检查，不再即时抽取提案
    // S5-03/R02：偏离检查失败（空输出/解析失败）以 status:'failed' + code 显式返回给作者，
    // 不再只留在服务端日志里、也不再以 null 冒充「没有偏离」；失败绝不写 drift_status。
    const drift = await checkDriftResult(book, db.get('SELECT * FROM chapters WHERE id = ?', [id]));
    if (drift && drift.status !== 'failed') {
      db.run('UPDATE chapters SET drift_status = ?, drift_note = ? WHERE id = ?', [drift.status, drift.note, id]);
    } else if (drift) {
      console.error('[drift] 检查失败:', drift.code, drift.note);
    }
    res.json({
      summary,
      // S5-01：结果记录来源指纹与提交后版本（01 契约 §7）
      source_fingerprint: sourceSnapshot.fingerprint,
      committed_revision: committed.chapter.revision,
      proposals: [],
      drift,
    });
  } catch (err) {
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

router.post('/:bookId/chapters/:id/versions/:versionId/restore', (req, res, next) => {
  try {
    const result = versions.restoreChapterVersion(
      req.params.bookId, req.params.id, req.params.versionId,
      (req.body || {}).expected_revision
    );
    if (result.error) return res.status(404).json({ error: result.error });
    sendPersisted(res, result);
  } catch (err) {
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
