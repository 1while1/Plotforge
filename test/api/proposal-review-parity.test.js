const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const proposals = require('../../server/domain/proposals');

// 提案双轨对齐（方向报告 1.3）：普通工作台入口补齐 Agent 入口的两个硬保障——
// 乐观锁版本绑定（accept/reject 都校验 expected_revision）+ 驳回必填理由。
test('manual accept/reject enforce expected_revision and mandatory reject note', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['双轨对齐书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const charId = db.run('INSERT INTO characters (book_id, name) VALUES (?, ?)', [bookId, '林野']).lastInsertRowid;
  const created = proposals.createProposal(bookId, {
    title: '林野取得信物',
    source_type: 'manual',
    changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: 'health', old_value: null, new_value: '康健' }],
  });

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 驳回不填理由 → 400（与 Agent 入口 requireRejectNote 等价）
  const noNote = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/proposals/${created.id}/reject`, {});
  assert.equal(noNote.status, 400);

  // 驳回带理由但版本不符 → 409
  const staleReject = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/proposals/${created.id}/reject`, { review_note: '证据不足', expected_revision: 99 });
  assert.equal(staleReject.status, 409);

  // 接受版本不符 → 409（并发修改保护，此前普通入口空 body 直接跳过校验）
  const staleAccept = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/proposals/${created.id}/accept`, { expected_revision: 99 });
  assert.equal(staleAccept.status, 409);
  assert.equal(proposals.getProposal(bookId, created.id).status, 'pending', '版本冲突时不得动提案');

  // 正确版本接受 → 200 落地
  const ok = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/proposals/${created.id}/accept`, { expected_revision: created.revision });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.event_id);
});
