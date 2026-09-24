// A-2 / G5 审计 P2-1：章节回收「恢复方向」的卷/书总结失效链。
//
// 删除方向已有传播：deleteChapterWithRecycle 先调 lifecycle.invalidateChapter
// （chapterRecycle.js:79）——清空该章总结并把它所基于的卷总结/全书摘要标过期。
// 恢复方向此前没有对应动作：带总结的章回插后，卷/书总结的底料指纹与当前来源
// **不再吻合**，而 summary_stale 仍为 0，作者看到的是「讲着删章前故事的卷总结 +
// 没有任何过期提示」。
//
// 本切片把恢复方向补成删除方向的镜像：章回插后按当前来源重算指纹，不吻合即标过期；
// 但**恢复回来的章自身总结必须原样保留**——清空是「正文已变、旧总结与正文矛盾」的
// 语义，恢复不是正文变化，删掉作者已有总结属于误伤。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const lifecycle = require('../server/domain/chapterLifecycle');
const recycle = require('../server/domain/chapterRecycle');
const registry = require('../server/tools/registry');

async function initBook(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  const volA = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '卷一', 1)", [bookId]).lastInsertRowid;
  const volB = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '卷二', 2)", [bookId]).lastInsertRowid;
  const addChapter = (volId, title2, content, summary, sort) => db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    [bookId, volId, title2, content, summary, sort]
  ).lastInsertRowid;
  const ch1 = addChapter(volA, '第一章', '第一章正文。', '林野夺船北上。', 1);
  const ch2 = addChapter(volA, '第二章', '第二章正文。', '北境冻港遇袭。', 2);
  const ch3 = addChapter(volB, '第三章', '第三章正文。', '港城再遇旧识。', 1);
  const ch4 = addChapter(volB, '第四章', '第四章正文。', '', 2);
  return { location, bookId, volA, volB, ch1, ch2, ch3, ch4 };
}

const volRow = volumeId => db.get('SELECT summary, summary_based_on, summary_stale FROM volumes WHERE id = ?', [volumeId]);
const bookRow = bookId => db.get(
  "SELECT content, based_on, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [bookId]
);

// 走产品写入路径重新生成卷/书总结（工具与确认后执行的是同一个 execute）：
// 生成后指纹与当前来源一致、不处于过期态——即「删章之后作者已按新来源重做总结」的干净状态。
function regenerateSummaries(bookId, volA, volB) {
  const saveVolume = registry.descriptor('save_volume_summary');
  saveVolume.execute({ bookId, args: { volume_id: volA, summary: '卷一：林野北上，冻港遇袭。' } });
  saveVolume.execute({ bookId, args: { volume_id: volB, summary: '卷二：港城旧识。' } });
  registry.descriptor('update_book_progress').execute({ bookId, args: { summary: '林野北上，卷末遇袭。' } });
}

function recycleIdOf(bookId) {
  return Number(db.get('SELECT id FROM chapter_recycle WHERE book_id = ?', [bookId]).id);
}

test('删章→重生成卷/书总结→恢复：卷/书总结按当前来源标过期；恢复章自身总结保留', async t => {
  const { bookId, volA, volB, ch2 } = await initBook(t, '恢复传播');
  regenerateSummaries(bookId, volA, volB);
  assert.equal(volRow(volA).summary_stale, 0);
  assert.equal(bookRow(bookId).stale, 0);

  // ① 删除带总结的章：删除方向已传播（本切片不改，作为前置与不回退守护）
  recycle.deleteChapterWithRecycle({ bookId, chapterId: ch2 });
  assert.equal(volRow(volA).summary_stale, 1, '删除方向：所在卷标过期');
  assert.equal(bookRow(bookId).stale, 1, '删除方向：全书摘要标过期');

  // ② 作者按删除后的来源重新生成卷/书总结 → 指纹吻合、不过期
  regenerateSummaries(bookId, volA, volB);
  assert.equal(volRow(volA).summary_stale, 0, '重生成后不过期');
  assert.equal(bookRow(bookId).stale, 0, '重生成后不过期');
  assert.equal(volRow(volA).summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volA), '重生成后指纹与来源一致');
  assert.equal(bookRow(bookId).based_on, lifecycle.bookSummaryFingerprint(bookId), '重生成后指纹与来源一致');

  // ③ 恢复该章：底料多回一项（带总结）→ 卷/书总结必须标过期
  recycle.restoreRecycledChapter({ bookId, recycleId: recycleIdOf(bookId) });
  assert.equal(volRow(volA).summary_stale, 1, '恢复带总结的章后，卷总结必须标过期（镜像删除方向传播）');
  assert.equal(bookRow(bookId).stale, 1, '恢复带总结的章后，全书摘要必须标过期');
  // 过期判定可核验：指纹确实与当前来源不再一致
  assert.notEqual(volRow(volA).summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volA), '指纹与来源已不吻合');
  assert.notEqual(bookRow(bookId).based_on, lifecycle.bookSummaryFingerprint(bookId), '指纹与来源已不吻合');

  // 恢复方向**不得**清掉恢复章自身总结，也不得清掉卷/书总结正文（只标过期）
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [ch2]).summary, '北境冻港遇袭。',
    '恢复回来的章自身总结必须原样保留');
  assert.equal(volRow(volA).summary, '卷一：林野北上，冻港遇袭。', '卷总结正文只标过期不清空');
  assert.equal(bookRow(bookId).content, '林野北上，卷末遇袭。', '全书摘要正文只标过期不清空');

  // 恢复后重新生成 → 过期清除（闭环可恢复）
  regenerateSummaries(bookId, volA, volB);
  assert.equal(volRow(volA).summary_stale, 0);
  assert.equal(bookRow(bookId).stale, 0);
});

test('对照组：未受影响卷不误标；恢复「无总结的章」不误标', async t => {
  const { bookId, volA, volB, ch4 } = await initBook(t, '恢复对照组');
  regenerateSummaries(bookId, volA, volB);
  const volBFingerprint = volRow(volB).summary_based_on;

  // 无总结的章：删除与恢复都不改变底料 → 卷/书总结不得被标记（无指纹变化）
  recycle.deleteChapterWithRecycle({ bookId, chapterId: ch4 });
  assert.equal(volRow(volB).summary_stale, 0, '删无总结的章不改变底料');
  recycle.restoreRecycledChapter({ bookId, recycleId: recycleIdOf(bookId) });
  assert.equal(volRow(volB).summary_stale, 0, '无总结的章恢复后底料未变，不得标过期');
  assert.equal(bookRow(bookId).stale, 0, '无总结的章恢复后全书摘要不得标过期');
  assert.equal(volRow(volA).summary_stale, 0, '未受影响卷不得误标过期');
  assert.equal(volRow(volB).summary_based_on, volBFingerprint, '未受影响卷指纹不动');

  // 带总结的章恢复：只有所在卷与书层标过期，另一卷零误伤
  const ch2 = db.get("SELECT id FROM chapters WHERE book_id = ? AND title = '第二章'", [bookId]).id;
  recycle.deleteChapterWithRecycle({ bookId, chapterId: ch2 });
  regenerateSummaries(bookId, volA, volB);
  assert.equal(volRow(volA).summary_stale, 0, '前置：按删除后的来源重生成后不过期');
  recycle.restoreRecycledChapter({ bookId, recycleId: recycleIdOf(bookId) });
  assert.equal(volRow(volA).summary_stale, 1, '恢复带总结的章：所在卷标过期');
  assert.equal(volRow(volB).summary_stale, 0, '另一卷不得被误标');
  assert.equal(volRow(volB).summary_based_on, volBFingerprint, '另一卷指纹不动');
  assert.notEqual(volRow(volA).summary_based_on, lifecycle.volumeSummaryFingerprint(bookId, volA),
    '判据核验：所在卷指纹确实已与当前来源不符');
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [ch2]).summary, '北境冻港遇袭。', '恢复章总结保留');
});

// REST 面（作者入口 POST /chapter-recycle/:id/restore 同样标过期）的断言写在
// test/api/chapter-recycle.test.js 的首个用例里——那里已有现成的隔离 HTTP 服务；
// 本文件只做领域层断言，避免为一条透传路由再起一个服务。
