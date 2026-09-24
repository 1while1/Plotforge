// S1-02 / C04-A：章节单调版本与领域写入口（chapters.revision + applyChapterMutation）。
// 缺陷背景：updated_at 秒级乐观锁同秒双写双双成功（审查反例 revision_collision：
// first=200 second=200，窗口B 覆盖窗口A）。本文件锁定正确行为：整数 revision
// 比较交换、同秒仍互斥、no-op 不递增、被拒请求零副作用、白名单字段映射。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const {
  applyChapterMutation,
  applyChapterMutationInTransaction,
} = require('../server/domain/chapterMutations');

function seedChapter(content = '旧正文') {
  const bookId = db.run("INSERT INTO books (title) VALUES ('版本契约书')").lastInsertRowid;
  const volId = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '第1章', ?, '旧总结', 1)",
    [bookId, volId, content]
  ).lastInsertRowid;
  db.run("INSERT INTO chapter_versions (chapter_id, title, content, reason) VALUES (?, '第1章', '更旧的正文', 'seed')", [chapterId]);
  return { bookId, volId, chapterId };
}

const versionCount = (chapterId) =>
  db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chapterId]).n;

test('迁移 024：存量无 revision 库升级——正文/版本不动，revision=1，二次 init 无额外改动', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));

  // 先造「迁移前」旧库：chapters 无 revision 列（migrateVersions:false 只跑 SCHEMA+列迁移）
  await db.init({ filePath: location.filePath, migrateVersions: false });
  const seeded = seedChapter('存量正文');
  assert.equal(db.saveNow(), true);
  db.close();

  // 正常 init → 024 应用：字段原样、版本原条数、revision 起步 1
  await db.init({ filePath: location.filePath });
  const migrated = db.get('SELECT * FROM chapters WHERE id = ?', [seeded.chapterId]);
  assert.equal(migrated.content, '存量正文', '正文不得被迁移改动');
  assert.equal(migrated.summary, '旧总结');
  assert.equal(migrated.revision, 1, '存量章节 revision 起步为 1');
  assert.equal(versionCount(seeded.chapterId), 1, '历史版本条数不变');
  const cols = db.all('PRAGMA table_info(chapters)').map(c => c.name);
  assert.ok(cols.includes('revision'), 'chapters 应有 revision 列');
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'chapter_revision_v1'").n, 1);

  // 二次 init：幂等，不再新增迁移记录/备份
  db.close();
  await db.init({ filePath: location.filePath });
  assert.equal(db.get('SELECT revision FROM chapters WHERE id = ?', [seeded.chapterId]).revision, 1);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM schema_versions WHERE version = 'chapter_revision_v1'").n, 1);
  assert.equal(fs.readdirSync(path.join(location.dir, 'backups')).length, 1, '迁移只应产生一份备份');
});

test('同一秒两次提交：第一笔 revision=2，第二笔 409 CHAPTER_CONFLICT 不覆盖', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  // 时间固定为同一秒：revision 守卫必须与时间戳无关
  db.run("UPDATE chapters SET updated_at = '2026-09-21 10:00:00' WHERE id = ?", [chapterId]);

  const first = applyChapterMutation({
    bookId, chapterId, expectedRevision: 1,
    patch: { content: '正文甲' }, reason: 'manual',
  });
  assert.equal(first.changed, true);
  assert.equal(first.chapter.revision, 2, '实际变化后 revision 前进到 2');
  assert.equal(first.chapter.content, '正文甲');
  assert.equal(versionCount(chapterId), 2, '内容变化应拍一个版本快照');

  assert.throws(
    () => applyChapterMutation({
      bookId, chapterId, expectedRevision: 1,
      patch: { content: '正文乙' }, reason: 'manual',
    }),
    err => err.code === 'CHAPTER_CONFLICT' && err.status === 409
      && err.details.currentRevision === 2,
    '同秒第二笔旧 revision 提交必须被拒并附 currentRevision'
  );
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '正文甲', '冲突笔不得覆盖第一笔');
  assert.equal(versionCount(chapterId), 2, '被拒请求不得产生版本');
});

test('缺版本 428、非法 revision 400、跨书 404、同值 no-op 不递增不产版本', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();
  const otherBookId = db.run("INSERT INTO books (title) VALUES ('另一本书')").lastInsertRowid;

  assert.throws(
    () => applyChapterMutation({ bookId, chapterId, patch: { content: 'x' } }),
    err => err.code === 'CHAPTER_REVISION_REQUIRED' && err.status === 428
      && err.details.currentRevision === 1,
    '缺 expectedRevision 必须 428'
  );
  assert.throws(
    () => applyChapterMutation({ bookId, chapterId, expectedRevision: 0, patch: { content: 'x' } }),
    err => err.code === 'INVALID_REVISION' && err.status === 400
  );
  assert.throws(
    () => applyChapterMutation({ bookId: otherBookId, chapterId, expectedRevision: 1, patch: { content: 'x' } }),
    err => err.code === 'CHAPTER_NOT_FOUND' && err.status === 404,
    '跨书章节必须 404'
  );

  const before = versionCount(chapterId);
  const beforeRow = db.get('SELECT revision, updated_at FROM chapters WHERE id = ?', [chapterId]);
  const noop = applyChapterMutation({
    bookId, chapterId, expectedRevision: 1, patch: { content: '旧正文', title: '第1章' },
  });
  assert.equal(noop.changed, false, '相同值是 no-op');
  assert.equal(noop.chapter.revision, 1, 'no-op 不递增 revision');
  assert.equal(versionCount(chapterId), before, 'no-op 不产生版本');
  const afterRow = db.get('SELECT revision, updated_at FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(afterRow.updated_at, beforeRow.updated_at, 'no-op 不动 updated_at');
});

test('白名单：id/book_id/revision/locked/未知字段一律拒绝且零副作用', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();

  for (const patch of [{ revision: 9 }, { id: 123 }, { book_id: 2 }, { locked: 1 }, { evil: 'x' }, { updated_at: '2020-01-01 00:00:00' }]) {
    assert.throws(
      () => applyChapterMutation({ bookId, chapterId, expectedRevision: 1, patch }),
      err => err.code === 'INVALID_PATCH_FIELD' && err.status === 400,
      `patch ${JSON.stringify(patch)} 必须被白名单拒绝`
    );
  }
  const row = db.get('SELECT revision, title FROM chapters WHERE id = ?', [chapterId]);
  assert.equal(row.revision, 1);
  assert.equal(versionCount(chapterId), 1);
});

test('被拒请求零副作用：不失效总结、不改投影、不拍版本（事务回滚覆盖全部副作用）', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();

  // 第一笔先吃掉 revision=1（产生正常副作用），第二笔带大 patch 的旧版本提交必须整体回滚
  applyChapterMutation({ bookId, chapterId, expectedRevision: 1, patch: { content: '新正文' } });
  const volBefore = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [db.get('SELECT volume_id FROM chapters WHERE id = ?', [chapterId]).volume_id]);
  const versionsBefore = versionCount(chapterId);
  const staleOf = () => {
    const row = db.get("SELECT stale FROM story_state WHERE kind = 'book_summary' AND book_id = ?", [bookId]);
    return row ? row.stale : 0;
  };
  const stateBefore = staleOf();

  const volC = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  assert.throws(
    () => applyChapterMutation({
      bookId, chapterId, expectedRevision: 1,
      patch: { content: '又改正文', summary: '又改总结', volume_id: volC, sort_order: 1 },
    }),
    err => err.code === 'CHAPTER_CONFLICT'
  );

  assert.equal(versionCount(chapterId), versionsBefore, '被拒请求不得拍版本');
  const volAfter = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [db.get('SELECT volume_id FROM chapters WHERE id = ?', [chapterId]).volume_id]);
  assert.equal(volAfter.summary_stale, volBefore.summary_stale, '被拒请求不得失效卷总结');
  assert.equal(staleOf(), stateBefore, '被拒请求不得标过期全书摘要');
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volC]).summary_stale, 0, '目标卷不得被标过期');
  assert.equal(db.get('SELECT volume_id FROM chapters WHERE id = ?', [chapterId]).volume_id !== volC, true, '章节不得被移动');
});

test('位置变更同样递增 revision 并重建投影；正文变更拍快照、清总结、自动解锁定稿章', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, volId, chapterId } = seedChapter();

  // 位置变更：换卷 → revision 前进 + 目标卷/全书摘要标过期（story_state 行先造好，该行本为懒创建）
  db.run("INSERT INTO story_state (book_id, kind, content) VALUES (?, 'book_summary', '旧全书摘要')", [bookId]);
  const volB = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  const moved = applyChapterMutation({ bookId, chapterId, expectedRevision: 1, patch: { volume_id: volB } });
  assert.equal(moved.changed, true);
  assert.equal(moved.chapter.revision, 2);
  assert.equal(moved.chapter.volume_id, volB);
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volB]).summary_stale, 1);
  assert.equal(db.get("SELECT stale FROM story_state WHERE kind = 'book_summary' AND book_id = ?", [bookId]).stale, 1);

  // 正文变更：定稿章自动解锁 + 快照 + 总结被失效清空
  db.run("UPDATE chapters SET locked = 1, locked_at = datetime('now','localtime'), summary = '定稿总结' WHERE id = ?", [chapterId]);
  const before = versionCount(chapterId);
  const edited = applyChapterMutation({ bookId, chapterId, expectedRevision: 2, patch: { content: '改定稿正文' }, reason: 'manual' });
  assert.equal(edited.chapter.revision, 3);
  assert.equal(edited.chapter.locked, 0, '改定稿章正文应自动解锁');
  assert.equal(edited.chapter.relock_pending, 1);
  assert.equal(edited.chapter.summary, '', '正文变化后旧总结应被失效清空');
  assert.equal(versionCount(chapterId), before + 1, '正文变化拍一个版本快照');
});

test('事务两种方式：独立调用自带事务；已有持有者用同事务原语；不支持嵌套 BEGIN', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const { bookId, chapterId } = seedChapter();

  // 独立调用（内部自持事务）
  const independent = applyChapterMutation({ bookId, chapterId, expectedRevision: 1, patch: { title: '第1章（改）' } });
  assert.equal(independent.chapter.revision, 2);

  // 已有持有者：外层事务 + 同事务原语（如跨实体事务组合）
  const composed = db.transaction(() => {
    db.run("INSERT INTO books (title) VALUES ('同事务联动书')");
    return applyChapterMutationInTransaction({ bookId, chapterId, expectedRevision: 2, patch: { beat: '新节拍' } });
  });
  assert.equal(composed.chapter.revision, 3);
  assert.equal(composed.chapter.beat, '新节拍');

  // 嵌套 BEGIN 必须被拒绝
  assert.throws(
    () => db.transaction(() => applyChapterMutation({ bookId, chapterId, expectedRevision: 3, patch: { beat: 'x' } })),
    /不支持嵌套数据库事务/
  );
});
