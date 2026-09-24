const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const memory = require('../server/context/providers/memory');
const { executeRead } = require('../server/bookTools');

// 2026-09-10 用户反馈「让它写最新章节，读取错了章节、记忆错乱」的回归保护：
// 根因三层——①上下文从不声明「当前写到哪」，模型只能数注入的章总结猜；
// ②list_chapters 只给卷名不给卷序，用户说「第三分卷」模型按 volume_id=3 匹配错卷
//（该书 id=3 实际是第二卷）；③当前章为空时无降级，「根据最近的章节内容」实际注入为空。
// 修复：memory 注入「当前进度：第N卷《名》· 第M章《名》」（按目录顺序计）+ 当前章为空
// 时取叙事序最近的上一有内容章结尾；list_chapters 卷名前置「第N卷·」。

// 复刻真实书结构：3 卷，卷 id 与卷序刻意错位（id=3 是第二卷）
async function chapterDriftBook(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['进度锚点']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const v1 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '第一卷']).lastInsertRowid;
  const v2 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 2)', [bookId, '记忆中的角色']).lastInsertRowid;
  const v3 = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 3)', [bookId, '社会常识修改']).lastInsertRowid;
  const ch = (vol, title, sort, content, summary) => db.run(
    'INSERT INTO chapters (book_id, volume_id, title, content, sort_order, locked, summary) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [bookId, vol, title, content, sort, summary || '']
  ).lastInsertRowid;
  const c11 = ch(v1, '第1章', 1, '第一卷第一章正文。', '王军初获能力。');
  ch(v1, '第2章', 2, '第一卷第二章正文。', '能力规则初探。');
  const c21 = ch(v2, '第7章', 7, '第二卷第七章正文。', '菲奥娜被擒。');
  const c31 = ch(v3, '第一章：繁华街头的猎物', 1, '第三卷第一章正文，王军当众改写现实。', '王军凌辱天辰集团千金。');
  const c32 = ch(v3, '第2章', 16, '第三卷第二章正文。', '');
  const c33 = ch(v3, '第3章', 17, '第三卷第三章正文，秦疏影登场。', '');
  const c34 = ch(v3, '第4章', 18, '第三卷第四章正文，衔接点在末尾。', '');
  const cNew = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, sort_order, locked) VALUES (?, ?, '第5章', '', 19, 0)",
    [bookId, v3]
  ).lastInsertRowid; // 待写的新章：空正文
  return { bookId, v1, v2, v3, c11, c21, c31, c32, c33, c34, cNew };
}

test('当前进度声明：卷序按目录顺序（id≠序），章节序正确，空新章可定位', async t => {
  const { bookId, v3, cNew } = await chapterDriftBook(t);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const built = memory.build({ book, chapterId: cNew, db });
  assert.ok(built.includes('当前进度'), '上下文应显式声明当前进度');
  // 关键：id=4 的卷是第三卷（按 sort_order 计），不得按 id=3 匹配成「记忆中的角色」
  assert.ok(built.includes('第3卷《社会常识修改》'), `应为第3卷《社会常识修改》，实际：${built.slice(0, 200)}`);
  assert.ok(!built.includes('第3卷《记忆中的角色》'), '不得把 id=3 的第二卷当成第三卷');
  assert.ok(built.includes('第5章《第5章》'), '应声明当前章为本卷第5章');
});

test('当前章为空：注入上一有内容章的结尾（续写衔接点），而非空上下文', async t => {
  const { bookId, cNew } = await chapterDriftBook(t);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const built = memory.build({ book, chapterId: cNew, db });
  assert.ok(built.includes('上一章（当前章还没有内容）'), '应说明当前章为空并给出降级来源');
  assert.ok(built.includes('第三卷第四章正文'), '应注入上一有内容章（第4章）的结尾');
  assert.ok(!built.includes('当前章节《第5章》已有内容'), '空章不得伪装成已有内容');
});

test('未选章（全书末尾）：注入最后一个有内容章节的结尾', async t => {
  const { bookId } = await chapterDriftBook(t);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const built = memory.build({ book, chapterId: null, db });
  assert.ok(built.includes('当前进度'), '未选章也应有进度声明（末卷末章）');
  assert.ok(built.includes('第三卷第四章正文'), '应注入最近有内容章节的结尾');
});

test('list_chapters 卷名带目录序数（第N卷·），修「第三分卷」对不上号', async t => {
  const { bookId, v3 } = await chapterDriftBook(t);
  const out = await executeRead(bookId, 'list_chapters', { limit: 50 });
  const volNames = out.items.map(i => i.volume);
  assert.ok(volNames.some(v => v === '第3卷·社会常识修改'), `应有「第3卷·社会常识修改」，实际：${JSON.stringify([...new Set(volNames)])}`);
  assert.ok(volNames.some(v => v === '第2卷·记忆中的角色'), '应有「第2卷·记忆中的角色」');
  assert.ok(volNames.some(v => v === '第1卷·第一卷'), '应有「第1卷·第一卷」');
  assert.equal(out.total, 8, '目录总数不受卷序标注影响');
});


test('连续八章以上空草稿也能取到最近正文尾部，不跨越目标章', async t => {
  const { bookId, v3 } = await chapterDriftBook(t);
  let targetId;
  for (let index = 0; index < 10; index++) targetId = db.run('INSERT INTO chapters (book_id,volume_id,title,sort_order) VALUES (?, ?, ?, ?)', [bookId, v3, '空草稿' + index, 30 + index]).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id,volume_id,title,sort_order,content) VALUES (?, ?, ?, ?, ?)', [bookId, v3, '未来章', 50, '未来秘密不得注入']);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const built = memory.build({ book, chapterId: targetId, db });
  assert.ok(built.includes('第三卷第四章正文'));
  assert.ok(!built.includes('未来秘密不得注入'));
});
