// 章节版本快照：写操作前自动备份，可回滚。每章最多保留 10 版。
// S1-03 起：恢复经 chapterMutations 版本守卫——expectedRevision 必填（缺失 428、
// 不符 409），恢复只前进（revision 递增，不回退成旧值）。
const db = require('./db');

const MAX_VERSIONS = 10;

// 备份章节当前标题+正文。reason 例：'before-append' / 'before-replace' / 'before-restore'
function snapshot(chapterId, reason) {
  const ch = db.get('SELECT id, title, content FROM chapters WHERE id = ?', [chapterId]);
  if (!ch) return null;
  const r = db.run(
    'INSERT INTO chapter_versions (chapter_id, title, content, reason) VALUES (?, ?, ?, ?)',
    [chapterId, ch.title, ch.content, reason || '']
  );
  // 超出上限删最旧
  db.run(
    `DELETE FROM chapter_versions WHERE chapter_id = ? AND id NOT IN
     (SELECT id FROM chapter_versions WHERE chapter_id = ? ORDER BY id DESC LIMIT ?)`,
    [chapterId, chapterId, MAX_VERSIONS]
  );
  return r.lastInsertRowid;
}

function list(chapterId) {
  return db.all(
    `SELECT id, title, reason, LENGTH(content) AS chars, created_at
     FROM chapter_versions WHERE chapter_id = ? ORDER BY id DESC`, [chapterId]);
}

// 恢复指定版本正文（领域入口负责恢复前快照、失效传播与版本守卫；回滚本身也可回滚）
function restoreChapterVersion(bookId, chapterId, versionId, expectedRevision) {
  const v = db.get(`SELECT v.* FROM chapter_versions v JOIN chapters c ON c.id = v.chapter_id
    WHERE v.id = ? AND v.chapter_id = ? AND c.book_id = ?`, [versionId, chapterId, bookId]);
  if (!v) return { error: '版本不存在或不属于当前章节' };
  const applied = require('./domain/chapterMutations').applyChapterMutation({
    bookId,
    chapterId: v.chapter_id,
    expectedRevision,
    patch: { content: v.content },
    reason: 'before-restore',
  });
  return {
    ok: true,
    chapterId: v.chapter_id,
    revision: applied.chapter.revision,
    locked: Boolean(applied.chapter.locked),
    chars: v.content.length,
    invalidated: applied.invalidated,
  };
}

function restore(versionId, bookId, expectedRevision) {
  const version = db.get('SELECT chapter_id FROM chapter_versions WHERE id = ?', [versionId]);
  if (!version) return { error: '版本不存在' };
  const chapter = db.get('SELECT book_id FROM chapters WHERE id = ?', [version.chapter_id]);
  if (!chapter || (bookId != null && Number(bookId) !== Number(chapter.book_id))) return { error: '版本不属于当前书籍' };
  return restoreChapterVersion(chapter.book_id, version.chapter_id, versionId, expectedRevision);
}

module.exports = { snapshot, list, restore, restoreChapterVersion };
