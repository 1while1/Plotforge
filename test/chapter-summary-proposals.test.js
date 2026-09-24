const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const { extractChapterProposals } = require('../server/domain/chapterSummaryProposals');

test('chapter extraction creates review proposals without mutating canonical state', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['提案测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野登上灰雁号。', 1)", [bookId]).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  const model = async () => ({ content: JSON.stringify({ proposals: [{ title: '林野登船', summary: '位置发生变化', source_quote: '林野登上灰雁号。', confidence: 0.95, changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'location', old_value: null, new_value: '灰雁号' }] }] }) });
  const result = await extractChapterProposals(book, chapter, '林野登船。', model);
  assert.equal(result.warning, null);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, 'pending');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM character_state_values').n, 0);
});

test('chapter extraction failure keeps summary workflow recoverable', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['失败测试']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const chapter = { id: db.run("INSERT INTO chapters (book_id, title, content) VALUES (?, '第一章', '正文')", [bookId]).lastInsertRowid, title: '第一章', content: '正文' };
  const result = await extractChapterProposals(db.get('SELECT * FROM books WHERE id = ?', [bookId]), chapter, '总结仍有效', async () => ({ content: 'not-json' }));
  assert.equal(result.proposals.length, 0);
  assert.match(result.warning, /提取失败/);
});

test('抽取归属校验：subject_ref 非人物表真实 id（0/不存在）的变化被丢弃且不入库', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['归属校验']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野登上灰雁号。', 1)", [bookId]).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  const proposalsBefore = db.get('SELECT COUNT(*) AS n FROM event_proposals').n;
  // 三条候选：subj=0 无效、subj=999 不存在、subj=真实 id 有效
  const model = async () => ({ content: JSON.stringify({ proposals: [
    { title: '无名指代', changes: [{ change_kind: 'character_state', subject_ref: '0', field_key: 'health', old_value: null, new_value: '崩溃' }] },
    { title: '幽灵角色', changes: [{ change_kind: 'character_state', subject_ref: '999', field_key: 'goal', old_value: null, new_value: '复仇' }] },
    { title: '有效变化', changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'location', old_value: null, new_value: '灰雁号' }] },
  ] }) });
  const result = await extractChapterProposals(book, chapter, '林野登船。', model);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].title, '有效变化');
  assert.equal(result.skippedChanges, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM event_proposals').n, proposalsBefore + 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM character_state_values').n, 0);
});

test('importance 白名单外值归一化（medium→normal、HIGH→high）而非丢弃提案', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['重要性归一']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野登上灰雁号。', 1)", [bookId]).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  const change = { change_kind: 'character_state', subject_ref: String(characterId), field_key: 'location', old_value: null, new_value: '灰雁号' };
  const model = async () => ({ content: JSON.stringify({ proposals: [
    { title: '中优先级', importance: 'medium', changes: [{ ...change, field_key: 'goal', new_value: '复仇' }] },
    { title: '大优先级', importance: 'HIGH', changes: [{ ...change, field_key: 'possession', new_value: '罗盘' }] },
    { title: '正常', changes: [{ ...change, field_key: 'health', new_value: '完好' }] },
  ] }) });
  const result = await extractChapterProposals(book, chapter, '林野登船。', model);
  assert.equal(result.proposals.length, 3);
  assert.equal(result.warning, null);
  const byTitle = Object.fromEntries(result.proposals.map(p => [p.title, p.importance]));
  assert.equal(byTitle['中优先级'], 'normal');
  assert.equal(byTitle['大优先级'], 'high');
  assert.equal(byTitle['正常'], 'normal');
});

test('list 型字段（关键持有物）的单值自动包装为数组，接受时不再被拒', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['列表归一']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run("INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, '第一章', '林野登上灰雁号。', 1)", [bookId]).lastInsertRowid;
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  const model = async () => ({ content: JSON.stringify({ proposals: [
    { title: '持有物单值', changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'possession', old_value: null, new_value: '罗盘' }] },
    { title: '持有物数组', changes: [{ change_kind: 'character_state', subject_ref: String(characterId), field_key: 'possession', old_value: null, new_value: ['罗盘', '海图'] }] },
  ] }) });
  const result = await extractChapterProposals(book, chapter, '林野登船。', model);
  assert.equal(result.proposals.length, 2);
  const byTitle = Object.fromEntries(result.proposals.map(p => [p.title, p]));
  assert.deepEqual(byTitle['持有物单值'].changes[0].new_value, ['罗盘']);
  assert.deepEqual(byTitle['持有物数组'].changes[0].new_value, ['罗盘', '海图']);
});
