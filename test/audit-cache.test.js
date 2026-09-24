const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const { auditCharacterStates, clearAuditCache } = require('../server/domain/stateAudit');
const characters = require('../server/domain/characters');
const ledger = require('../server/domain/storyLedger');

// 体检快照化（方向报告 2.4）：指纹缓存 + 数据变化失效。
// 翻页不再触发全量重放；事件/章节变化后结果必须即时反映。
test('audit snapshot caches per fingerprint and invalidates on data change', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['体检快照书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const charId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  ledger.commitEvent(bookId, {
    title: '受伤',
    changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: 'health', old_value: null, new_value: '轻伤' }],
  });

  clearAuditCache();
  const first = auditCharacterStates(bookId, {});
  assert.ok(first.summary.cached === true);
  assert.equal(first.summary.scanned > 0 || first.summary.total >= 0, true);
  const firstComputedAt = first.summary.computed_at;

  // 无数据变化：翻页命中同一快照（computed_at 不变）
  const second = auditCharacterStates(bookId, { limit: 1 });
  assert.equal(second.summary.computed_at, firstComputedAt, '数据未变应命中缓存');

  // 数据变化（新增事件）→ 指纹变化 → 立即重算
  ledger.commitEvent(bookId, {
    title: '加重',
    changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: 'health', old_value: '轻伤', new_value: '重伤' }],
  });
  const third = auditCharacterStates(bookId, {});
  assert.notEqual(third.summary.computed_at, firstComputedAt, '指纹变化必须触发重算');

  cleanup(location);
});
