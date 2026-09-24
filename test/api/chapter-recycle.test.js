// S1-06/C05：章节回收与恢复契约。删章必须同事务落回收快照（正文+历史版本+引用清单），
// 重开库后仍可恢复；恢复 revision ≥ 快照+1；主键/卷冲突 409 给作者选择；旧确认过期；
// 恢复不触发模型调用；整册备份包含回收记录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { db, createTempLocation, cleanup } = require('../../test/helpers/temp-db');
const { createApp } = require('../../server/app');
const { listen, json } = require('../../test/helpers/http');

async function setup(t, seed) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  const bookId = db.run("INSERT INTO books (title) VALUES ('回收契约书')").lastInsertRowid;
  const volId = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '卷一', 1)", [bookId]).lastInsertRowid;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, '第一章', '原始正文', '旧总结', 1)",
    [bookId, volId]
  ).lastInsertRowid;
  const versions = [];
  if (seed !== false) {
    versions.push(db.run("INSERT INTO chapter_versions (chapter_id, title, content, reason) VALUES (?, '第一章', '版本一正文', 'before-edit')", [chapterId]).lastInsertRowid);
    versions.push(db.run("INSERT INTO chapter_versions (chapter_id, title, content, reason) VALUES (?, '第一章', '版本二正文', 'before-restore')", [chapterId]).lastInsertRowid);
  }
  return { location, http, bookId, volId, chapterId, versionIds: versions };
}

test('删章落回收快照：重开库后清单可读，恢复还原正文与历史版本', async t => {
  const { location, http, bookId, volId, chapterId } = await setup(t);
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.recycle.versions, 2);
  assert.equal(del.body.recycle.references, 0);
  // 目录查询对已删章的语义：列表不再包含
  const list1 = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapters`);
  assert.equal(list1.body.chapters.length, 0);

  // 重开临时库（持久化验证）：回收记录仍在磁盘上
  await db.close();
  await db.init({ filePath: location.filePath });
  const http2 = await listen(createApp());
  t.after(async () => { await http2.close(); });

  const bin = await json(http2.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  assert.equal(bin.status, 200);
  assert.equal(bin.body.count, 1);
  assert.equal(bin.body.items[0].title, '第一章');
  assert.equal(bin.body.items[0].versions, 2);

  // A-2（G5 审计 P2-1）：删除方向已传播卷/书总结失效（chapterRecycle.js:79 →
  // invalidateChapter）；恢复方向此前不回灌。作者按删除后的来源重生成总结后恢复本章，
  // 卷/书总结的底料多回一项 → 必须标过期，且恢复回来的章自身总结原样保留。
  const registry = require('../../server/tools/registry');
  registry.descriptor('save_volume_summary').execute({ bookId, args: { volume_id: volId, summary: '卷一：第一章。' } });
  registry.descriptor('update_book_progress').execute({ bookId, args: { summary: '全书进展：第一章。' } });
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]).summary_stale, 0, '前置：重生成后卷总结不过期');
  assert.equal(db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]).stale, 0, '前置：重生成后全书摘要不过期');

  const restored = await json(http2.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${bin.body.items[0].id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.chapter.content, '原始正文', '正文按删除时状态恢复');
  assert.equal(restored.body.chapter.summary, '旧总结', '总结一并恢复');
  assert.equal(restored.body.restored_versions, 2);
  assert.deepEqual(
    db.all('SELECT content FROM chapter_versions WHERE chapter_id = ? ORDER BY id', [chapterId]).map(r => r.content),
    ['版本一正文', '版本二正文'],
    '历史版本按序恢复'
  );
  assert.equal(restored.body.needsReview, true, '恢复结果必须标识待核对');
  assert.ok(Array.isArray(restored.body.reviewItems) && restored.body.reviewItems.length > 0);
  // A-2：REST 入口同样标过期；恢复章自身总结不被清空（正文保持删除时状态之上）
  assert.equal(db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volId]).summary_stale, 1, '恢复后卷总结标过期');
  assert.equal(db.get("SELECT stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]).stale, 1, '恢复后全书摘要标过期');
  // revision 至少为快照 revision+1，不重置为 1
  assert.equal(restored.body.chapter.revision, 2);
  // 恢复后目录可见
  const list2 = await json(http2.baseUrl, 'GET', `/api/books/${bookId}/chapters`);
  assert.equal(list2.body.chapters.length, 1);
});

test('快照写入失败则不删除（同事务回滚）', async t => {
  const { http, bookId, chapterId } = await setup(t);
  const originalRun = db.run.bind(db);
  let restoreRun;
  restoreRun = function (sql, params) {
    if (String(sql).indexOf('INSERT INTO chapter_recycle') >= 0) {
      throw new Error('AUDIT_SNAPSHOT_FAIL');
    }
    return originalRun(sql, params);
  };
  db.run = restoreRun;
  let status, body;
  try {
    const res = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
    status = res.status; body = res.body;
  } catch (e) {
    status = 500; body = { error: String(e.message) };
  } finally {
    db.run = originalRun;
  }
  assert.notEqual(status, 200, `快照失败不得返回成功（实际 ${status}）`);
  const after = db.get('SELECT id, content FROM chapters WHERE id = ?', [chapterId]);
  assert.ok(after, '章节未被删除');
  assert.equal(after.content, '原始正文', '正文原样');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapter_recycle').n, 0, '无残留回收记录');
});

test('同主键冲突 409 不覆盖；原卷已删未指定卷 409 附卷清单；显式未归卷可恢复', async t => {
  const { http, bookId, volId, chapterId } = await setup(t);
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  const bin = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  const recId = bin.body.items[0].id;

  // 同主键冲突：手工占用同一章节 id
  db.run("INSERT INTO chapters (id, book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, '占位章', 'x', 9)", [chapterId, bookId, volId]);
  const conflict = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CHAPTER_ID_CONFLICT');
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, 'x', '占位章未被覆盖');
  db.run('DELETE FROM chapters WHERE id = ?', [chapterId]);

  // 原卷已删且未指定卷 → 409 附现有卷清单
  db.run('DELETE FROM volumes WHERE id = ?', [volId]);
  const volRequired = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, {});
  assert.equal(volRequired.status, 409);
  assert.equal(volRequired.body.code, 'VOLUME_REQUIRED');
  assert.ok(Array.isArray(volRequired.body.details.volumes));

  // 显式恢复为未归卷
  const unassigned = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, { volume_id: null });
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.body.chapter.volume_id, null);
  assert.ok(unassigned.body.reviewItems.some(i => i.indexOf('未归卷') >= 0), '待核对项包含归卷提示');
});

test('指定卷恢复、同名章提示、重复恢复 404、错误书 404', async t => {
  const { http, bookId, volId, chapterId } = await setup(t);
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  const otherBookId = db.run("INSERT INTO books (title) VALUES ('别的书')").lastInsertRowid;

  // 错误书：记录属于别的书
  const wrongBook = await json(http.baseUrl, 'GET', `/api/books/${otherBookId}/chapter-recycle`);
  assert.equal(wrongBook.body.count, 0);

  const bin = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  const recId = bin.body.items[0].id;
  const wrong = await json(http.baseUrl, 'POST', `/api/books/${otherBookId}/chapter-recycle/${recId}/restore`, {});
  assert.equal(wrong.status, 404);

  // 同名章 + 指定卷恢复成功
  db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第一章', '同名的新章', 1)", [bookId, volId]);
  const restored = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, { volume_id: Number(volId) });
  assert.equal(restored.status, 200);
  assert.ok(restored.body.reviewItems.some(i => i.indexOf('同名') >= 0), '同名章列入待核对');
  assert.equal(restored.body.chapter.volume_id, Number(volId));

  // 重复恢复：记录已消费
  const again = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, {});
  assert.equal(again.status, 404);
});

test('恢复落盘失败遵守持久化契约：503 + applied=true，记录不被消费', async t => {
  const { location, http, bookId, chapterId } = await setup(t);
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  const bin = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  const recId = bin.body.items[0].id;
  db.saveNow();

  const originalWrite = fs.writeFileSync;
  const blockedPrefix = location.filePath;
  fs.writeFileSync = function (file, ...args) {
    if (String(file).startsWith(blockedPrefix)) {
      throw Object.assign(new Error('E2E_DISK_BLOCKED'), { code: 'EPERM' });
    }
    return originalWrite.call(this, file, ...args);
  };
  let result;
  try {
    result = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${recId}/restore`, {});
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(result.status, 503, '未落盘返回 503');
  assert.equal(result.body.code, 'PERSISTENCE_PENDING');
  assert.equal(result.body.applied, true, '业务已应用不得当失败重放');
  assert.equal(result.body.chapter.content, '原始正文', '返回恢复后的当前实体');
  // 恢复内存态成功：记录已消费（防重复恢复），章节已在内存
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapter_recycle').n, 0);
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]).content, '原始正文');
});

test('删除时的来源引用进入回收清单；恢复不自动接回、旧确认过期', async t => {
  const { http, bookId, volId, chapterId } = await setup(t);
  // 事件引用本章（FK SET NULL 存活）
  db.run(
    "INSERT INTO story_events (book_id, chapter_id, title, summary, narrative_sequence, created_at) VALUES (?, ?, '渡河事件', '他们渡过了冰河。', 1, datetime('now','localtime'))",
    [bookId, chapterId]
  );
  // 针对本章的待确认动作
  const { requestConfirmation } = require('../../server/tools/executor');
  const ctx = { profile: 'writing', bookId, sessionId: 'recycle-test', source: 'agent', actor: 'author' };
  const conf = requestConfirmation(ctx, 'append_chapter', { chapterId, text: '待确认的追加' });
  assert.equal(conf.status, 'confirmation_required');
  const actionId = conf.confirmation.id;

  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.recycle.references, 1, '删除结果标识受影响引用数');
  assert.equal(db.get('SELECT chapter_id FROM story_events WHERE title = ?', ['渡河事件']).chapter_id, null, 'FK 置空');

  const bin = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  assert.equal(bin.body.items[0].references, 1);
  const restored = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${bin.body.items[0].id}/restore`, { volume_id: Number(volId) });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.affectedReferences.length, 1, '返回受影响引用清单');
  assert.equal(restored.body.affectedReferences[0].table, 'story_events');
  // 不自动接回
  assert.equal(db.get('SELECT chapter_id FROM story_events WHERE title = ?', ['渡河事件']).chapter_id, null);
  // 旧确认显式过期
  const action = require('../../server/actionStore').get(actionId);
  assert.equal(action.status, 'expired');
});

test('整册备份包含回收记录；删书恢复后章节仍可从回收站恢复', async t => {
  const { location, http, bookId, chapterId } = await setup(t);
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}/chapters/${chapterId}`);
  assert.equal(del.status, 200);
  db.saveNow();

  // 删书（自动整册备份，含回收记录）
  const delBook = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(delBook.status, 200);
  const backupsDir = require('node:path').join(require('node:path').dirname(location.filePath), 'backups');
  const files = fs.readdirSync(backupsDir).filter(n => n.startsWith('book-'));
  assert.equal(files.length, 1, '删书生成整册备份');

  const backup = JSON.parse(fs.readFileSync(require('node:path').join(backupsDir, files[0]), 'utf8'));
  assert.ok(backup.tables.chapter_recycle && backup.tables.chapter_recycle.length === 1, '备份含回收记录');

  // 整册恢复 → 回收记录回来 → 章节恢复成功
  const restoreBook = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: files[0] });
  assert.ok(restoreBook.status === 200 || restoreBook.status === 201, `整册恢复失败: ${restoreBook.status} ${JSON.stringify(restoreBook.body)}`);
  const bin = await json(http.baseUrl, 'GET', `/api/books/${bookId}/chapter-recycle`);
  assert.equal(bin.body.count, 1);
  const restored = await json(http.baseUrl, 'POST', `/api/books/${bookId}/chapter-recycle/${bin.body.items[0].id}/restore`, {});
  assert.equal(restored.status, 200, restored.body && restored.body.error);
  assert.equal(restored.body.chapter.content, '原始正文');
});
