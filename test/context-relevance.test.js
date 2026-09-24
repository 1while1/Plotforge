const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { assembleDetailed } = require('../server/context');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');

// 相关性排序升级（方向报告 2.3）：点名 > 当前场景登场 > 台账近期活跃 > 创建序。
test('character/worldview relevance uses named, on-stage and recent-activity signals', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['相关性书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));

  const a = characters.createCharacter(bookId, { name: '阿尔法', role: '路人甲' }).character.id;
  const b = characters.createCharacter(bookId, { name: '贝塔', role: '路人乙' }).character.id;
  const c = characters.createCharacter(bookId, { name: '伽马', role: '路人丙' }).character.id;
  db.run("INSERT INTO character_aliases (book_id, character_id, alias, alias_normalized, created_at) VALUES (?, ?, '小伽', '小伽', datetime('now'))", [bookId, c]);

  // 当前章（id 要存在）：结尾提到贝塔（登场）
  const chId = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)',
    [bookId, '当前章', '开头交代……\n\n贝塔推门走了进来。']).lastInsertRowid;
  // 伽马近 60 条事件内活跃
  ledger.commitEvent(bookId, {
    title: '伽马出手',
    changes: [{ change_kind: 'character_state', subject_ref: c, field_key: 'health', new_value: '轻伤' }],
  });

  db.run('INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)', [bookId, '黑石堡', '反派阵营的据点，位于北境。']);
  db.run('INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)', [bookId, '旧王国货币制度', '早期背景设定。']);

  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const result = await assembleDetailed({
    book, db, chapterId: chId, query: '写阿尔法和反派据点的对峙', systemTokenBudget: 20000,
  });
  const cards = result.parts.find(p => p.name === '人物卡片');
  assert.ok(cards, '人物卡片节应存在');
  const charText = result.text.split('<ctx name="人物卡片"')[1] || '';
  const posAlpha = charText.indexOf('阿尔法');
  const posBeta = charText.indexOf('贝塔');
  const posGamma = charText.indexOf('伽马');
  assert.ok(posAlpha > -1 && posBeta > -1 && posGamma > -1);
  assert.ok(posAlpha < posBeta, '问题点名的人物应排在仅场景登场者之前');
  assert.ok(posBeta < posGamma, '当前场景登场应排在仅台账活跃者之前');

  // 别名点名同样置前
  const aliasRun = await assembleDetailed({
    book, db, chapterId: chId, query: '小伽的表现', systemTokenBudget: 20000,
  });
  const aliasText = (aliasRun.text.split('<ctx name="人物卡片"')[1] || '');
  assert.ok(aliasText.indexOf('伽马') > -1);
  assert.ok(aliasText.indexOf('伽马') < aliasText.indexOf('阿尔法'), '别名点名应置前');

  // 世界观：当前场景提及的条目（黑石堡在 query 里点名；旧制度无信号）
  const worldText = (result.text.split('<ctx name="世界观设定"')[1] || '');
  assert.ok(worldText.indexOf('黑石堡') < worldText.indexOf('旧王国货币制度'), '点名设定应排在无信号设定之前');

  cleanup(location);
});
