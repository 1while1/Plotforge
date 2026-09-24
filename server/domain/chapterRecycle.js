// S1-06/C05：章节回收与恢复。单章删除此前与整书删除不等价——级联清空版本，
// 正文不可恢复。现在删除事务先落回收快照（原章节字段、历史版本、来源关联清单、
// 级联丢失项计数），再删章；恢复时整装回插并给出待核对清单。
// 约束：无 chapters 外键（删章不级联回收记录）；默认不自动清理；恢复 revision 至少
// 为快照 revision+1（不重置为 1）；旧待确认动作在恢复时显式过期（S1-03 版本绑定
// 另有 409 兜底）；既有事件/引用不自动转回，只返回受影响清单。
const db = require('../db');
const lifecycle = require('./chapterLifecycle');
const ledger = require('./storyLedger');
const runSvc = require('../runtime/run-service');

class RecycleError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

// 删除时受引用面普查（SET NULL 各表 + 级联丢失各表）——必须在 DELETE 之前收集，
// FK 的 SET NULL / CASCADE 都发生在 DELETE 瞬间。
function collectReferences(chapterId) {
  const refs = [];
  for (const row of db.all(
    'SELECT id, title FROM story_events WHERE chapter_id = ? ORDER BY id', [chapterId]
  )) refs.push({ table: 'story_events', id: row.id, label: row.title || `事件 #${row.id}` });
  for (const row of db.all(
    'SELECT id, title, status FROM event_proposals WHERE chapter_id = ? ORDER BY id', [chapterId]
  )) refs.push({ table: 'event_proposals', id: row.id, label: row.title || `提案 #${row.id}`, status: row.status });
  for (const row of db.all(
    'SELECT id, title, type FROM story_threads WHERE opened_chapter_id = ? OR target_chapter_id = ? ORDER BY id',
    [chapterId, chapterId]
  )) refs.push({ table: 'story_threads', id: row.id, label: row.title || `线索 #${row.id}`, status: row.type });
  for (const row of db.all(
    'SELECT id, suggestion_id FROM advisor_citations WHERE chapter_id = ? ORDER BY id', [chapterId]
  )) refs.push({ table: 'advisor_citations', id: row.id, label: `引用 #${row.id}（建议 ${row.suggestion_id}）`, status: null });
  return refs;
}

function collectLossyCounts(chapterId, preservedVersions) {
  return {
    // chapter_versions 已随回收快照保全；这两项 FK CASCADE 且不做保全，删除即失
    polish_history: db.get('SELECT COUNT(*) AS n FROM polish_history WHERE chapter_id = ?', [chapterId]).n,
    chapter_extraction_runs: db.get('SELECT COUNT(*) AS n FROM chapter_extraction_runs WHERE chapter_id = ?', [chapterId]).n,
    preserved_versions: preservedVersions,
  };
}

function deleteChapterWithRecycleInTransaction({ bookId, chapterId, reason }) {
  const book = Number(bookId);
  const chId = Number(chapterId);
  const ch = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [chId, book]);
  if (!ch) throw new RecycleError('CHAPTER_NOT_FOUND', '章节不存在', 404);

  const versions = db.all(
    'SELECT id, title, content, reason, created_at FROM chapter_versions WHERE chapter_id = ? ORDER BY id',
    [chId]
  );
  const references = collectReferences(chId);
  const lossy = collectLossyCounts(chId, versions.length);

  // 回收快照与删除同事务：INSERT 失败（异常）即整体回滚，章节不动
  const inserted = db.run(
    `INSERT INTO chapter_recycle (
       book_id, chapter_id, volume_id, title, content, summary, beat, sort_order,
       locked, locked_at, relock_pending, revision, drift_status, drift_note,
       updated_at_src, versions_json, references_json, lossy_json, deleted_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      book, ch.id, ch.volume_id, ch.title, ch.content, ch.summary || '', ch.beat || '',
      ch.sort_order || 0, ch.locked ? 1 : 0, ch.locked_at || null, ch.relock_pending ? 1 : 0,
      Number(ch.revision) || 1, ch.drift_status || null, ch.drift_note || null, ch.updated_at,
      JSON.stringify(versions), JSON.stringify(references), JSON.stringify(lossy),
      String(reason || 'manual-delete'),
    ]
  );
  const recycleId = Number(inserted.lastInsertRowid);

  const invalidated = lifecycle.invalidateChapter(book, chId, '来源章节已删除，保留快照供人工核对');
  db.run('DELETE FROM chapters WHERE id = ? AND book_id = ?', [chId, book]);
  // 事务内核版：外层已在 db.transaction 内，AfterStructureChange 包装会再开事务（嵌套拒绝）
  const projection = ledger.rebuildProjectionsInTransaction(book);

  return {
    ok: true,
    recycle: {
      id: recycleId,
      chapter_id: ch.id,
      title: ch.title,
      versions: versions.length,
      references: references.length,
    },
    invalidated,
    projection_rebuilt: true,
    projection,
  };
}

function listRecycledChapters(bookId) {
  const book = Number(bookId);
  return db.all(
    `SELECT r.id, r.chapter_id, r.title, r.volume_id, r.revision, r.deleted_at, r.deleted_reason,
            r.references_json, r.versions_json, r.lossy_json,
            length(r.content) AS chars,
            (SELECT title FROM volumes v WHERE v.id = r.volume_id AND v.book_id = r.book_id) AS volume_title
     FROM chapter_recycle r WHERE r.book_id = ? ORDER BY r.deleted_at DESC, r.id DESC`,
    [book]
  ).map(row => ({
    id: row.id,
    chapter_id: row.chapter_id,
    title: row.title,
    chars: row.chars || 0,
    volume_id: row.volume_id,
    volume_title: row.volume_title === null ? null : row.volume_title,
    volume_exists: row.volume_title !== null,
    revision: row.revision,
    deleted_at: row.deleted_at,
    deleted_reason: row.deleted_reason,
    versions: JSON.parse(row.versions_json).length,
    references: JSON.parse(row.references_json).length,
    lossy: JSON.parse(row.lossy_json),
  }));
}

function expirePendingActionsForChapter(bookId, chapterId, runIds = null) {
  // 恢复后旧确认不误命中：显式过期 pending 动作（S1-03 信封 revision 绑定另有 409 兜底）。
  // json_extract 精确比对，避免 LIKE 误伤 chapterId 前缀相同的其他章。
  const rows = db.all(
    `SELECT id, run_id FROM chat_actions
     WHERE book_id = ? AND status = 'pending'
       AND (json_extract(args_json, '$.chapterId') = ?
         OR json_extract(args_json, '$.chapter_id') = ?)`,
    [Number(bookId), Number(chapterId), Number(chapterId)]
  );
  for (const row of rows) {
    db.run("UPDATE chat_actions SET status = 'expired', settled_at = ? WHERE id = ?", [Date.now(), row.id]);
    // R1 / G6 审计 P2-1：这些 pending 卡离开「未结算」集合后，其运行行若停在 awaiting_confirmation
    // 须按契约 3.1 终态化（否则会话永久 409）。本函数跑在外层事务里，而终态化会调用
    // db.saveNow()→db.export()，会中止进行中的事务（实测「cannot commit - no transaction is active」）
    // ——因此只收集运行行，由 restoreRecycledChapter 在事务提交后统一终态化。
    if (runIds && row.run_id) runIds.push(row.run_id);
  }
  return rows.length;
}

function restoreRecycledChapterInTransaction({ bookId, recycleId, volumeId }, settledRunIds = null) {
  const book = Number(bookId);
  const rec = db.get('SELECT * FROM chapter_recycle WHERE id = ? AND book_id = ?', [Number(recycleId), book]);
  if (!rec) {
    throw new RecycleError('RECYCLE_RECORD_NOT_FOUND',
      '回收记录不存在（可能已恢复过或属于其他书籍）；已恢复的记录不会重复出现', 404);
  }

  // 同主键冲突：不自动覆盖同 id 资产（AUTOINCREMENT 通常不复用 id，此处防御性校验）
  if (db.get('SELECT id FROM chapters WHERE id = ?', [rec.chapter_id])) {
    throw new RecycleError('CHAPTER_ID_CONFLICT',
      `章节主键 ${rec.chapter_id} 已被占用，拒绝覆盖；请人工处理`, 409);
  }

  // 目标卷裁定：显式 null=恢复为未归卷；指定卷必须存在；未指定且原卷已删 → 409 给作者选择
  const volumes = db.all('SELECT id, title FROM volumes WHERE book_id = ? ORDER BY sort_order, id', [book]);
  let targetVolumeId;
  const needsReview = [];
  if (volumeId === null) {
    targetVolumeId = null;
    needsReview.push('按作者选择恢复为未归卷，请在目录中重新归卷');
  } else if (volumeId !== undefined) {
    const vol = volumes.find(v => v.id === Number(volumeId));
    if (!vol) {
      throw new RecycleError('VOLUME_NOT_FOUND', '指定的目标卷不存在', 409, { volumes });
    }
    targetVolumeId = vol.id;
    if (vol.id !== rec.volume_id) needsReview.push(`已恢复到指定卷《${vol.title}》（原卷位置可能不同）`);
  } else if (rec.volume_id != null && volumes.some(v => v.id === rec.volume_id)) {
    targetVolumeId = Number(rec.volume_id);
  } else {
    throw new RecycleError('VOLUME_REQUIRED', '原卷已删除，请选择恢复到哪一卷（或明确恢复为未归卷）', 409, { volumes });
  }

  // 追加到目标卷末尾，不覆盖既有位置、不重排全书（同 sort_order 不做唯一假设，仅提示）
  let targetSort = 0;
  if (targetVolumeId != null) {
    const max = db.get('SELECT MAX(sort_order) AS m FROM chapters WHERE book_id = ? AND volume_id = ?', [book, targetVolumeId]).m;
    targetSort = (max || 0) + 1;
    if (rec.sort_order !== targetSort) needsReview.push(`已恢复到卷末第 ${targetSort} 位（原位置 ${rec.sort_order}）`);
  }

  // 同名章不阻断恢复（标题本无唯一约束），但列入待核对
  if (db.get('SELECT id FROM chapters WHERE book_id = ? AND title = ? AND id != ?', [book, rec.title, rec.chapter_id])) {
    needsReview.push('本书已有同名章节，请核对标题避免混淆');
  }

  const restoredRevision = Number(rec.revision) + 1;
  db.run(
    `INSERT INTO chapters (id, book_id, volume_id, title, content, summary, beat,
       sort_order, locked, locked_at, relock_pending, revision, drift_status, drift_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, datetime('now','localtime'))`,
    [rec.chapter_id, book, targetVolumeId, rec.title, rec.content, rec.summary || '', rec.beat || '',
      targetSort, rec.relock_pending ? 1 : 0, restoredRevision, rec.drift_status || null, rec.drift_note || null]
  );

  const versions = JSON.parse(rec.versions_json);
  for (const v of versions) {
    db.run(
      'INSERT INTO chapter_versions (chapter_id, title, content, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      [rec.chapter_id, v.title || '', v.content || '', v.reason || '', v.created_at]
    );
  }

  // A-2（G5 审计 P2-1）：章回插后把卷/书总结标记过期——镜像删除方向的传播语义
  // （chapterRecycle.js:79 的 invalidateChapter → chapterLifecycle.js:105 传播链）。
  // 恢复回插的章带着总结回到卷里，卷/书总结的底料指纹与当前来源不再吻合；不标过期，
  // 作者看到的就是「讲着删章前故事的卷总结 + 没有任何过期提示」。这里只按当前来源
  // 重算指纹、不吻合才标（幂等，无总结/无指纹不动），**不清空恢复章自身总结**：
  // 清空是「正文已变、旧总结与正文矛盾」的语义，恢复不是正文变化，清掉属误伤。
  lifecycle.markVolumeSummaryStale(book, rec.chapter_id);
  lifecycle.markBookSummaryStale(book);

  const expiredActions = expirePendingActionsForChapter(book, rec.chapter_id, settledRunIds);
  if (expiredActions) needsReview.push(`${expiredActions} 个针对本章的待确认动作已过期，请重新发起`);

  const references = JSON.parse(rec.references_json);
  if (references.length) needsReview.push(`删除前有 ${references.length} 条事件/提案/线索引用了本章，恢复后不会自动接回，请人工核对`);

  needsReview.push('正文与历史版本已恢复；定稿状态与向量索引需重新定稿重建');

  const projection = ledger.rebuildProjectionsInTransaction(book);

  // 恢复成功即消费回收记录（重复恢复返回 404）；不触发任何模型调用
  db.run('DELETE FROM chapter_recycle WHERE id = ?', [rec.id]);

  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [rec.chapter_id]);
  return {
    ok: true,
    chapter,
    restored_versions: versions.length,
    restored_revision: restoredRevision,
    needsReview: true,
    reviewItems: needsReview,
    affectedReferences: references,
    projection,
  };
}

function deleteChapterWithRecycle(input) {
  return db.transaction(() => deleteChapterWithRecycleInTransaction(input));
}

function restoreRecycledChapter(input) {
  const settledRunIds = [];
  const result = db.transaction(() => restoreRecycledChapterInTransaction(input, settledRunIds));
  // R1 / G6 审计 P2-1：运行行终态化必须发生在事务提交之后（见 expirePendingActionsForChapter 注释）。
  for (const runId of settledRunIds) runSvc.settleRunAfterConfirmation(runId, 'action_settled');
  return result;
}

module.exports = { deleteChapterWithRecycle, restoreRecycledChapter, listRecycledChapters, RecycleError };
