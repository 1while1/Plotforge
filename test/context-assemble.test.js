const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { assemble, escapeXml, truncateToTokens } = require('../server/context');

async function seededBook(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['组装测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  return db.get('SELECT * FROM books WHERE id = ?', [bookId]);
}

test('escapeXml 仅转义 & < > " \'，中文标点不动', () => {
  assert.equal(escapeXml('a<b>&"c\'d'), 'a&lt;b&gt;&amp;&quot;c&apos;d');
  assert.equal(escapeXml('中文《标题》、正文'), '中文《标题》、正文');
});

test('truncateToTokens 未超限原样返回，超限裁短', () => {
  const short = '你好';
  assert.equal(truncateToTokens(short, 9999), short);
  const long = '一二三四五六七八九十'.repeat(50); // 500 CJK ≈ 350 tokens
  const cut = truncateToTokens(long, 5);
  assert.ok(Array.from(cut).length < Array.from(long).length);
});

test('assemble 用 XML 分节并保留优先级属性', async t => {
  const book = await seededBook(t);
  const out = await assemble({ book, chapterId: null, db, query: '', systemTokenBudget: 999999 });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('<ctx '), '应使用 XML 分节');
  assert.ok(out.includes('priority="0"'), 'identity(priority 0) 必须存在');
  assert.ok(out.includes('</ctx>'));
});

test('assemble 全局 token 预算单调：预算越小输出越短', async t => {
  const book = await seededBook(t);
  const big = await assemble({ book, chapterId: null, db, query: '', systemTokenBudget: 999999 });
  const small = await assemble({ book, chapterId: null, db, query: '', systemTokenBudget: 1 });
  assert.ok(Array.from(small).length <= Array.from(big).length);
  // 预算=1 时仅保留最高优先级(identity)一节
  assert.equal((small.match(/<ctx /g) || []).length, 1);
});

// ---------------- 时间感知装配（前卷/后章不泄漏、当前章保尾、老化保最近） ----------------

async function bookWithVolumes(t) {
  const book = await seededBook(t);
  const vol = (title, sort) => db.run(
    'INSERT INTO volumes (book_id, title, intro, outline, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [book.id, title, '', '', '', sort]
  ).lastInsertRowid;
  return { book, vol };
}

test('时间感知：编辑中间卷时，未来卷总结不进入上下文，前卷总结保留', async t => {
  const { book, vol } = await bookWithVolumes(t);
  const v1 = vol('第一卷', 1), v2 = vol('第二卷', 2), v3 = vol('第三卷', 3);
  db.run('UPDATE volumes SET summary = ? WHERE id = ?', ['前情提要一', v1]);
  db.run('UPDATE volumes SET summary = ? WHERE id = ?', ['未来卷剧透三', v3]);
  const ch2 = db.run(
    "INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '二卷首章', '正文', 1)",
    [book.id, v2]
  ).lastInsertRowid;

  const out = await assemble({ book, chapterId: ch2, db, query: '', systemTokenBudget: 999999 });
  assert.ok(out.includes('前情提要一'), '前卷总结应保留');
  assert.ok(!out.includes('未来卷剧透三'), '叙事位置之后的卷总结不得泄漏（未来信息污染）');
});

test('时间感知：本卷章总结截断到当前章之前，本章之后的总结不泄漏', async t => {
  const { book, vol } = await bookWithVolumes(t);
  const v1 = vol('第一卷', 1);
  const mk = (title, summary, sort) => db.run(
    'INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [book.id, v1, title, '正文', summary, sort]
  ).lastInsertRowid;
  mk('第1章', '第一章总结', 1);
  mk('第2章', '第二章总结', 2);
  const cur = mk('第3章', '', 3); // 当前章（无总结）
  mk('第4章', '第四章后文总结', 4);
  mk('第5章', '第五章后文总结', 5);

  const out = await assemble({ book, chapterId: cur, db, query: '', systemTokenBudget: 999999 });
  assert.ok(out.includes('第一章总结') && out.includes('第二章总结'), '当前章之前的总结应保留');
  assert.ok(!out.includes('第四章后文总结') && !out.includes('第五章后文总结'),
    '当前章之后的总结不得泄漏（后文信息污染）');
});

test('当前章保尾：超长正文的结尾进入上下文、开头不整段进入', async t => {
  const { book, vol } = await bookWithVolumes(t);
  const v1 = vol('第一卷', 1);
  const headStart = '【本章开头标记】';
  const tailMark = '这是本章结尾的衔接句';
  const chId = db.run(
    'INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)',
    [book.id, v1, '长章', headStart + '填充'.repeat(2000) + tailMark, 1]
  ).lastInsertRowid;

  const out = await assemble({ book, chapterId: chId, db, query: '', systemTokenBudget: 999999 });
  assert.ok(out.includes(tailMark), '续写衔接点（本章结尾）必须进入上下文');
  assert.ok(!out.includes(headStart), '超长正文的开头标记不应出现（开头信息由摘要层承担）');
  assert.ok(out.includes('保留结尾'), '应标注保尾语义，引导模型从结尾衔接');
});

test('老化：章总结超预算时丢最旧保最近（展示仍正序）', async t => {
  const { book, vol } = await bookWithVolumes(t);
  const v1 = vol('第一卷', 1);
  const mk = (title, summary, sort) => db.run(
    'INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [book.id, v1, title, '正文', summary, sort]
  ).lastInsertRowid;
  // 30 条 × ~160 字符 ≈ 4800 字符 > 本卷章总结块预算 1800 → 只能保最近约 10 条
  for (let i = 1; i <= 29; i++) mk(`第${i}章`, `第${i}章剧情总结：`.padEnd(150, `情${i}`), i);
  const cur = mk('第30章', '', 30);

  const out = await assemble({ book, chapterId: cur, db, query: '', systemTokenBudget: 999999 });
  assert.ok(!out.includes('第1章剧情总结'), '最旧的章总结应老化出局');
  assert.ok(out.includes('第29章剧情总结'), '最近的章总结必须保留');
  assert.ok(out.indexOf('第28章') < out.indexOf('第29章'), '保留部分仍按时间正序展示');
});

// ---------------- 相关性排序（世界观/人物卡） ----------------

test('人物卡：问题点名的人物排在前面（预算紧张时不易被裁）', async t => {
  const book = await seededBook(t);
  db.run("INSERT INTO characters (book_id, name, role) VALUES (?, '张三', '路人甲')", [book.id]);
  db.run("INSERT INTO characters (book_id, name, role) VALUES (?, '李四', '主角')", [book.id]);
  const provider = require('../server/context/providers/characters');
  const text = provider.build({ book, db, query: '继续写李四在码头的戏份' });
  assert.ok(text.indexOf('李四') < text.indexOf('张三'), '被点名的人物应排在前面');
});

test('世界观：问题点名的条目排在前面', async t => {
  const book = await seededBook(t);
  db.run("INSERT INTO world_entries (book_id, title, content) VALUES (?, '货币体系', '金币本位')", [book.id]);
  db.run("INSERT INTO world_entries (book_id, title, content) VALUES (?, '魔法体系', '元素法则')", [book.id]);
  const provider = require('../server/context/providers/worldview');
  const text = provider.build({ book, db, query: '本章要用到魔法体系的设定' });
  assert.ok(text.indexOf('魔法体系') < text.indexOf('货币体系'), '被点名的条目应排在前面');
});
