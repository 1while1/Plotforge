// S1-02 / C04-A：章节单调版本与原子修改守卫（01-架构与接口契约 §2）。
// 所有章节编辑入口经此比较交换：expectedRevision 缺失 428 CHAPTER_REVISION_REQUIRED，
// 与当前不符 409 CHAPTER_CONFLICT（附 currentRevision）；同值 no-op 不递增、不产副作用；
// 实际变化 revision + 1 只前进不回退。复用 versions.snapshot / chapterLifecycle /
// chapterCatalog 的既有语义（版本快照、失效传播、投影重建、编号校验），不重复实现。
// 副作用（快照/失效/投影）与条件更新同处一个同步事务：被拒绝的请求全部回滚。
const db = require('../db');
const { DomainError } = require('./errors');
const versions = require('../versions');
const catalog = require('./chapterCatalog');
const lifecycle = require('./chapterLifecycle');

// 调用者可写的章节字段白名单；id/book_id/revision/locked 等由系统或专门生命周期入口管理，
// 直接出现在 patch 里一律拒绝，防止调用者绕过版本守卫覆盖标识或状态
const PATCH_FIELDS = ['title', 'content', 'summary', 'beat', 'volume_id', 'sort_order'];

function requireText(value, field) {
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_PATCH', `字段 ${field} 必须是字符串`, 400, { field });
  }
  return value;
}

function currentChapter(chapterId) {
  return db.get('SELECT * FROM chapters WHERE id = ?', [Number(chapterId)]);
}

// 同事务原语：调用方必须已持有数据库事务（事务已有持有者模式）。
// 返回 { chapter, changed, autoUnlocked, invalidated, summaryStale, structureChanged, projection }。
function applyChapterMutationInTransaction({ bookId, chapterId, expectedRevision, patch = {}, reason = '' }) {
  const book = catalog.requireBook(bookId);
  const id = Number(chapterId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);
  }
  const existing = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [id, book]);
  if (!existing) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);

  if (expectedRevision === undefined || expectedRevision === null) {
    throw new DomainError('CHAPTER_REVISION_REQUIRED',
      '缺少 expectedRevision：请先读取章节当前 revision 再提交修改', 428,
      { currentRevision: Number(existing.revision) });
  }
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new DomainError('INVALID_REVISION', 'expectedRevision 必须是正整数', 400);
  }
  if (Number(existing.revision) !== expected) {
    throw new DomainError('CHAPTER_CONFLICT',
      `章节已在别处被修改（期望 revision ${expected}，当前 ${Number(existing.revision)}），本次提交被拒绝以免覆盖新内容`,
      409, { currentRevision: Number(existing.revision) });
  }

  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.includes(key)) {
      throw new DomainError('INVALID_PATCH_FIELD', `不支持的字段: ${key}`, 400, { field: key });
    }
  }

  const placement = catalog.validatePlacement(book, patch, existing);

  // no-op 判定：所有提供字段与现值相同 → 不递增、不拍快照、不失效、不动 updated_at
  const changes = {};
  if (patch.title !== undefined) {
    const value = requireText(patch.title, 'title');
    if (value !== existing.title) changes.title = value;
  }
  if (patch.content !== undefined) {
    const value = requireText(patch.content, 'content');
    if (value !== existing.content) changes.content = value;
  }
  if (patch.summary !== undefined) {
    const value = requireText(patch.summary, 'summary');
    if (value !== existing.summary) changes.summary = value;
  }
  if (patch.beat !== undefined) {
    const value = requireText(patch.beat, 'beat');
    if (value !== existing.beat) changes.beat = value;
  }
  if (placement.volume_id !== undefined && placement.volume_id !== existing.volume_id) {
    changes.volume_id = placement.volume_id;
  }
  if (placement.sort_order !== undefined && placement.sort_order !== existing.sort_order) {
    changes.sort_order = placement.sort_order;
  }

  if (Object.keys(changes).length === 0) {
    return { chapter: existing, changed: false, autoUnlocked: false, invalidated: null, summaryStale: false, structureChanged: false, projection: null };
  }

  const contentChanged = 'content' in changes;
  let invalidated = null;
  if (contentChanged) {
    versions.snapshot(id, reason || 'before-edit');
    invalidated = lifecycle.invalidateChapter(book, id, '章节正文已编辑，请重新核对来源');
  }

  const sets = [];
  const values = [];
  for (const field of PATCH_FIELDS) {
    if (field in changes) {
      sets.push(`${field} = ?`);
      values.push(changes[field]);
    }
  }
  // 定稿章节被修改正文：自动解除定稿并标记待重定稿（与既有 PUT 语义一致）
  let autoUnlocked = false;
  if (contentChanged && existing.locked) {
    sets.push('locked = 0', 'locked_at = NULL', 'relock_pending = 1');
    autoUnlocked = true;
  }
  sets.push("updated_at = datetime('now','localtime')", 'revision = revision + 1');
  values.push(id, book, expected);
  const update = db.run(
    `UPDATE chapters SET ${sets.join(', ')} WHERE id = ? AND book_id = ? AND revision = ?`,
    values
  );
  if (update.changes === 0) {
    const fresh = currentChapter(id);
    throw new DomainError('CHAPTER_CONFLICT',
      `章节已在别处被修改，本次提交被拒绝以免覆盖新内容`,
      409, { currentRevision: fresh ? Number(fresh.revision) : null });
  }

  const structureChanged = 'volume_id' in changes || 'sort_order' in changes;
  let projection = null;
  if (structureChanged) {
    projection = catalog.applyStructureChangeInTransaction(book, [existing.volume_id, changes.volume_id]);
  }
  let summaryStale = false;
  if ('summary' in changes) {
    summaryStale = lifecycle.markVolumeSummaryStale(book, id);
  }

  return {
    chapter: currentChapter(id),
    changed: true,
    autoUnlocked,
    invalidated,
    summaryStale,
    structureChanged,
    projection,
  };
}

// 独立调用模式：自带事务。已有事务的持有者请用 applyChapterMutationInTransaction（不支持嵌套 BEGIN）。
function applyChapterMutation(input) {
  return db.transaction(() => applyChapterMutationInTransaction(input));
}

module.exports = { applyChapterMutation, applyChapterMutationInTransaction };
