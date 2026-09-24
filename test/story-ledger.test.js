const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('one event atomically commits multiple state changes and rejects stale old values', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('灰雁号');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;

  const result = ledger.commitEvent(bookId, {
    title: '夺回灰雁号密钥',
    importance: 'high',
    changes: [
      {
        change_kind: 'character_state',
        subject_ref: characterId,
        field_key: 'health',
        old_value: null,
        new_value: '轻伤',
      },
      {
        change_kind: 'character_state',
        subject_ref: characterId,
        field_key: 'possession',
        old_value: null,
        new_value: ['灰雁号密钥'],
      },
    ],
  });

  assert.equal(result.event.changes.length, 2);
  assert.deepEqual(
    ledger.getCurrentStates(bookId, characterId)
      .filter(item => item.value !== null)
      .map(item => [item.field_key, item.value]),
    [['health', '轻伤'], ['possession', ['灰雁号密钥']]]
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_event_changes').n, 2);

  assert.throws(() => ledger.commitEvent(bookId, {
    title: '错误的旧值',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: '正常',
      new_value: '重伤',
    }],
  }), err => err.code === 'STALE_OLD_VALUE' && err.status === 409);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 1);
});

test('invalid later change leaves no partial event or projection', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('原子性');
  const characterId = characters.createCharacter(bookId, { name: '苏晚' }).character.id;

  assert.throws(() => ledger.commitEvent(bookId, {
    title: '不完整事件',
    changes: [
      {
        change_kind: 'character_state',
        subject_ref: characterId,
        field_key: 'health',
        old_value: null,
        new_value: '轻伤',
      },
      {
        change_kind: 'character_state',
        subject_ref: 999999,
        field_key: 'goal',
        old_value: null,
        new_value: '越权目标',
      },
    ],
  }), err => err.code === 'CROSS_BOOK_REFERENCE');

  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_event_changes').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM character_state_values').n, 0);
});

test('correction supersedes the old event and deterministic replay repairs projection drift', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('修正');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '林野左臂受伤',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '轻伤',
    }],
  }).event;

  const corrected = ledger.correctEvent(bookId, original.id, {
    title: '林野避开了攻击',
    summary: '原记录误判，林野没有受伤。',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '正常',
    }],
  });
  assert.equal(corrected.superseded_event_id, original.id);
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    '正常'
  );
  assert.equal(ledger.getTimeline(bookId).length, 1);
  assert.equal(ledger.getTimeline(bookId, { include_superseded: true }).length, 2);

  db.run(
    `UPDATE character_state_values SET value_json = '"漂移"' WHERE book_id = ? AND character_id = ? AND field_key = 'health'`,
    [bookId, characterId]
  );
  const rebuilt = ledger.rebuildProjections(bookId);
  assert.equal(rebuilt.projection, 'character_state');
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    '正常'
  );
  assert.equal(
    db.get(`SELECT checksum FROM projection_watermarks WHERE book_id = ? AND projection_name = 'character_state'`, [bookId]).checksum,
    rebuilt.checksum
  );
});

test('state definitions reject relation and freeze used value types', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('字段');
  const characterId = characters.createCharacter(bookId, { name: '钟离' }).character.id;

  assert.throws(
    () => ledger.createStateField(bookId, { field_key: 'relation', label: '关系' }),
    err => err.code === 'INVALID_STATE_FIELD'
  );
  const field = ledger.createStateField(bookId, {
    field_key: 'mood',
    label: '情绪',
    value_type: 'text',
  });
  assert.equal(field.field_key, 'mood');
  ledger.commitEvent(bookId, {
    title: '钟离恢复冷静',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'mood',
      old_value: null,
      new_value: '冷静',
    }],
  });
  assert.throws(
    () => ledger.updateStateField(bookId, 'mood', { value_type: 'list' }),
    err => err.code === 'STATE_FIELD_IN_USE'
  );
  assert.throws(() => ledger.commitEvent(bookId, {
    title: '关系不是状态',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'relation',
      old_value: null,
      new_value: '朋友',
    }],
  }), err => err.code === 'INVALID_STATE_FIELD');
});

test('correction rewrites title, summary, importance and source evidence while superseding', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('修正字段');
  const characterId = characters.createCharacter(bookId, { name: '沈舟' }).character.id;
  const original = ledger.commitEvent(bookId, {
    title: '沈舟受伤',
    summary: '旧简介',
    importance: 'low',
    source_quote: '旧依据',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: null,
      new_value: '轻伤',
    }],
  }).event;

  const corrected = ledger.correctEvent(bookId, original.id, {
    title: '沈舟重伤昏迷',
    summary: '修正后的完整简介',
    importance: 'critical',
    source_quote: '他闷哼一声，栽倒在地。',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'health',
      old_value: '轻伤',
      new_value: '重伤',
    }],
  });

  const event = corrected.event;
  assert.equal(corrected.superseded_event_id, original.id);
  assert.equal(event.title, '沈舟重伤昏迷');
  assert.equal(event.summary, '修正后的完整简介');
  assert.equal(event.importance, 'critical');
  assert.equal(event.source_quote, '他闷哼一声，栽倒在地。');
  assert.equal(event.supersedes_event_id, original.id);
  // 旧事件被标记为已被替代，投影更新为新值
  assert.equal(ledger.getEvent(bookId, original.id).superseded_by_event_id, event.id);
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'health').value,
    '重伤'
  );
  assert.equal(ledger.getTimeline(bookId).length, 1);
  assert.equal(ledger.getTimeline(bookId, { include_superseded: true }).length, 2);
});

test('timeline and projection order events by volume before per-volume chapter number', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('跨卷时序');
  const characterId = characters.createCharacter(bookId, { name: '陈立' }).character.id;

  // 两卷：卷一(sort_order=1) 三章卷内序 1/2/3；卷二(sort_order=2) 一章卷内序重新从 1 开始
  const vol1 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const vol2 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  const c11 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第一章', '正文', 1)", [bookId, vol1]).lastInsertRowid;
  const c12 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第二章', '正文', 2)", [bookId, vol1]).lastInsertRowid;
  const c13 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第三章', '正文', 3)", [bookId, vol1]).lastInsertRowid;
  const c21 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第四章', '正文', 1)", [bookId, vol2]).lastInsertRowid;

  const setLoc = (title, chapterId, value) => ledger.commitEvent(bookId, {
    title,
    chapter_id: chapterId,
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'location', new_value: value }],
  }).event;

  // 故意把「卷一·第三章」放到最后提交：增量投影会停在它，但按卷时序真正最新的是卷二第一章
  setLoc('卷一·起点', c11, '卷一第一章');
  setLoc('卷一·中途', c12, '卷一第二章');
  setLoc('卷二·新篇', c21, '卷二第一章');
  setLoc('卷一·收尾', c13, '卷一第三章');

  // 1) 时间线按「卷序 → 卷内章序」排列，不再跨卷交错（旧代码按 sort_order 单键会得到 起点/新篇/中途/收尾）
  const timeline = ledger.getTimeline(bookId);
  assert.deepEqual(timeline.map(e => e.title), ['卷一·起点', '卷一·中途', '卷一·收尾', '卷二·新篇']);
  // 事件携带正确的分卷信息，供前端按卷分组
  assert.deepEqual(timeline.map(e => e.volume_title), ['第一卷', '第一卷', '第一卷', '第二卷']);
  assert.deepEqual(timeline.map(e => Number(e.volume_sort_order)), [1, 1, 1, 2]);

  // 2) 重建投影后，当前状态取「真正最新卷」的值（卷二第一章），而非按章号误判的卷一第三章
  ledger.rebuildProjections(bookId);
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'location').value,
    '卷二第一章'
  );
});

test('乱序提交事件后无需手动重建，当前状态即按叙事序（卷序→章序）取最新', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = createBook('乱序投影');
  const characterId = characters.createCharacter(bookId, { name: '陈立' }).character.id;

  const vol1 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第一卷', 1)", [bookId]).lastInsertRowid;
  const vol2 = db.run("INSERT INTO volumes (book_id, title, sort_order) VALUES (?, '第二卷', 2)", [bookId]).lastInsertRowid;
  const c13 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第三章', '正文', 3)", [bookId, vol1]).lastInsertRowid;
  const c21 = db.run("INSERT INTO chapters (book_id, volume_id, title, content, sort_order) VALUES (?, ?, '第四章', '正文', 1)", [bookId, vol2]).lastInsertRowid;

  const setLoc = (title, chapterId, value) => ledger.commitEvent(bookId, {
    title,
    chapter_id: chapterId,
    changes: [{ change_kind: 'character_state', subject_ref: characterId, field_key: 'location', new_value: value }],
  });

  // 先提交叙事更晚的「卷二第一章」，再提交叙事更早的「卷一第三章」——提交序与叙事序相反
  setLoc('卷二·新篇', c21, '卷二第一章');
  setLoc('卷一·收尾', c13, '卷一第三章');

  // 无需 rebuildProjections：commitEvent 内部的乱序守护应已重建，当前状态取叙事最末的「卷二第一章」
  assert.equal(
    ledger.getCurrentStates(bookId, characterId).find(item => item.field_key === 'location').value,
    '卷二第一章'
  );
});
