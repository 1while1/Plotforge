const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const characters = require('../../server/domain/characters');
const proposals = require('../../server/domain/proposals');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

function createBook(title) {
  const id = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.transaction(() => seedBook(db, id));
  return id;
}

test('proposal and thread REST endpoints preserve review boundary', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook('接口');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const proposal = proposals.createProposal(bookId, {
    title: '林野改变目标',
    source_type: 'chapter_summary',
    source_revision_hash: 'api-rev',
    changes: [{
      change_kind: 'character_state',
      subject_ref: characterId,
      field_key: 'goal',
      old_value: null,
      new_value: '夺回灰雁号',
    }],
  });
  const http = await listen(createApp());
  t.after(async () => {
    await http.close();
    cleanup(location);
  });

  const inbox = await json(
    http.baseUrl,
    'GET',
    `/api/books/${bookId}/ledger/proposals?status=pending`
  );
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.items.length, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);

  const edited = await json(
    http.baseUrl,
    'PATCH',
    `/api/books/${bookId}/ledger/proposals/${proposal.id}`,
    { title: '林野决定夺回灰雁号' }
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.proposal.title, '林野决定夺回灰雁号');

  const accepted = await json(
    http.baseUrl,
    'POST',
    `/api/books/${bookId}/ledger/proposals/${proposal.id}/accept`,
    {}
  );
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body.event_id);
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'accepted');

  const thread = await json(http.baseUrl, 'POST', `/api/books/${bookId}/ledger/threads`, {
    type: 'plan',
    title: '夺回灰雁号',
    status: 'open',
    character_ids: [characterId],
  });
  assert.equal(thread.status, 201);
  assert.deepEqual(thread.body.thread.character_ids, [characterId]);
});

// A-1（G5 审计 P1-1）兜底层的 REST 面：来源正文哈希不符的提案采纳必须 409 SOURCE_CHANGED，
// 且不写正典——错误码要能穿过 app 的错误映射被作者看到，而不是只在领域层抛。
test('采纳旧来源提案：REST 面返回 409 SOURCE_CHANGED 且不写正典', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = createBook('接口·来源守卫');
  const characterId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chapterId = db.run(
    "INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, '第一章', '林野留在了白塔。', 1, 1)",
    [bookId]
  ).lastInsertRowid;
  const proposal = proposals.createProposal(bookId, {
    title: '林野登船',
    source_type: 'chapter_summary',
    chapter_id: chapterId,
    source_revision_hash: '已被替换的旧正文哈希',
    changes: [{
      change_kind: 'character_state',
      subject_ref: String(characterId),
      field_key: 'location',
      old_value: null,
      new_value: '灰雁号',
    }],
  });
  const http = await listen(createApp());
  t.after(async () => {
    await http.close();
    cleanup(location);
  });

  const accepted = await json(
    http.baseUrl,
    'POST',
    `/api/books/${bookId}/ledger/proposals/${proposal.id}/accept`,
    {}
  );
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.error.code, 'SOURCE_CHANGED');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 0);
  assert.equal(proposals.getProposal(bookId, proposal.id).status, 'pending');
});
