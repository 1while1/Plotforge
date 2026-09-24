const express = require('express');
const router = express.Router();
const db = require('../db');
const { seedBook } = require('../migrations/001-character-hub');
const backup = require('../bookBackup');

function parseId(str) {
  const id = Number(str);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/', (req, res, next) => {
  try {
    const books = db.all(`
      SELECT b.*,
             (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count
      FROM books b
      ORDER BY b.updated_at DESC
    `);
    res.json({ books });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      return res.status(400).json({ error: 'title 不能为空' });
    }

    const intro = typeof req.body.intro === 'string' ? req.body.intro.trim() : '';
    const systemPrompt = typeof req.body.system_prompt === 'string' ? req.body.system_prompt.trim() : '';

    // created_at/updated_at 用 SQL localtime，与 PUT 路由（datetime('now','localtime')）和 DDL 默认一致。
    // 此前 POST 用 JS toISOString()（ISO UTC，带 T/Z），与 PUT 的 localtime（空格分隔）混在同一列，
    // 书架 ORDER BY updated_at DESC 是字符串排序，两种格式混排会导致「最近更新」错序。
    const result = db.transaction(() => {
      const inserted = db.run(
        `INSERT INTO books (title, intro, system_prompt, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
        [title, intro, systemPrompt]
      );
      seedBook(db, inserted.lastInsertRowid);
      return inserted;
    });

    const book = db.get(`SELECT * FROM books WHERE id = ?`, [result.lastInsertRowid]);
    res.status(201).json({ book });
  } catch (err) {
    next(err);
  }
});

// ---- 回收站（方向报告 3.4）----
// 注意：必须定义在 GET /:id 之前，否则 'recycle-bin' 会被当作 bookId
router.get('/recycle-bin', (req, res, next) => {
  try {
    backup.purgeOldBackups();
    res.json({ backups: backup.listBackups(), retention_days: backup.RETENTION_DAYS });
  } catch (err) { next(err); }
});

// 恢复预览（S1-07/C12）：先看将恢复什么、哪些作家卡绑定依赖缺失，作者确认后再恢复
router.post('/recycle-bin/preview', (req, res, next) => {
  try {
    res.json(backup.previewBookBackup(req.body && req.body.file));
  } catch (err) { next(err); }
});
router.post('/recycle-bin/restore', (req, res, next) => {
  try {
    const result = backup.restoreBookBackup(req.body && req.body.file, { allowPartialStyle: req.body && req.body.allow_partial_style === true });
    // 向量不进备份：定稿章恢复后异步补建索引（测试可用 reindex:false 关闭）
    let reindexing = false;
    if (req.body.reindex !== false) {
      reindexing = true;
      setImmediate(() => {
        require('../vector/indexer').indexBookMissing(result.book.id)
          .catch(e => console.error('[backup] 恢复后补建向量索引失败:', e.message));
      });
    }
    res.status(201).json({ ...result, reindexing });
  } catch (err) { next(err); }
});

router.delete('/recycle-bin/:file', (req, res, next) => {
  try {
    backup.deleteBackup(req.params.file);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const book = db.get(`SELECT * FROM books WHERE id = ?`, [id]);
    if (!book) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    res.json({ book });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const existing = db.get(`SELECT * FROM books WHERE id = ?`, [id]);
    if (!existing) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const fields = [];
    const values = [];

    if (req.body.title !== undefined) {
      const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        return res.status(400).json({ error: 'title 不能为空' });
      }
      fields.push('title = ?');
      values.push(title);
    }

    if (req.body.intro !== undefined) {
      const intro = typeof req.body.intro === 'string' ? req.body.intro.trim() : '';
      fields.push('intro = ?');
      values.push(intro);
    }

    if (req.body.system_prompt !== undefined) {
      const systemPrompt = typeof req.body.system_prompt === 'string' ? req.body.system_prompt.trim() : '';
      fields.push('system_prompt = ?');
      values.push(systemPrompt);
    }

    if (req.body.mode !== undefined) {
      if (!['collab', 'direct'].includes(req.body.mode)) {
        return res.status(400).json({ error: 'mode 只能是 collab 或 direct' });
      }
      fields.push('mode = ?');
      values.push(req.body.mode);
    }

    if (req.body.master_outline !== undefined) {
      const outline = typeof req.body.master_outline === 'string' ? req.body.master_outline.trim() : '';
      fields.push('master_outline = ?');
      values.push(outline);
    }

    fields.push("updated_at = datetime('now','localtime')");

    db.run(
      `UPDATE books SET ${fields.join(', ')} WHERE id = ?`,
      [...values, id]
    );

    const book = db.get(`SELECT * FROM books WHERE id = ?`, [id]);
    res.json({ book });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const existing = db.get(`SELECT * FROM books WHERE id = ?`, [id]);
    if (!existing) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    // 删除前自动整册备份进回收站（保留 30 天，方向报告 3.4）：
    // CASCADE 会连 chapter_versions 快照一并清空，备份是唯一恢复通道
    let backupFile = null;
    try {
      backupFile = backup.exportBookBackup(id).file;
    } catch (err) {
      console.error('[backup] 删除前备份失败，中止删除以防误删不可恢复:', err.message);
      return res.status(500).json({ error: '删除前备份失败，已中止删除：' + err.message });
    }

    db.run(`DELETE FROM books WHERE id = ?`, [id]);
    db.saveNow(); // A2：整册不可逆删除同步落盘
    res.json({ ok: true, backup_file: backupFile });
  } catch (err) {
    next(err);
  }
});

// GET /:id/delete-preview —— 删除前将失去什么（方向报告 3.4：强制展示内容统计）
router.get('/:id/delete-preview', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null || !db.get('SELECT id FROM books WHERE id = ?', [id])) {
      return res.status(404).json({ error: '书籍不存在' });
    }
    const one = (sql) => db.get(sql, [id]);
    res.json({
      book: db.get('SELECT id, title FROM books WHERE id = ?', [id]),
      chapters: one('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').n,
      words: one("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM chapters WHERE book_id = ?").n,
      volumes: one('SELECT COUNT(*) AS n FROM volumes WHERE book_id = ?').n,
      characters: one('SELECT COUNT(*) AS n FROM characters WHERE book_id = ?').n,
      events: one('SELECT COUNT(*) AS n FROM story_events WHERE book_id = ?').n,
      versions: one('SELECT COUNT(*) AS n FROM chapter_versions cv JOIN chapters c ON c.id = cv.chapter_id WHERE c.book_id = ?').n,
      messages: one('SELECT COUNT(*) AS n FROM messages WHERE book_id = ?').n,
    });
  } catch (err) { next(err); }
});

module.exports = router;
