const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const actionStore = require('../server/actionStore');

// 确认凭证与结算结果落库（方向报告 3.1）：进程内存 Map 重启即丢——作者正要点的
// 确认卡失效、结算结果与续跑状态丢失。本文件专测持久化语义（重启恢复、过期、
// resume 字段），接口行为（authorize/settle/reject）由既有测试覆盖。

function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  return location;
}

async function reopen(location) {
  db.saveNow();
  db.close();
  await db.init({ filePath: location.filePath });
}

test('重启恢复：pending 确认卡与完整参数跨进程存活', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('落库书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 3, text: '续写段落' }, {
    toolCallId: 'call_abc', targetRevision: 7, requestedBy: 'agent', summary: '追加第三章',
    impact: ['正文变更'],
  });

  await reopen(location);

  const restored = actionStore.get(action.id);
  assert.ok(restored, '重启后确认卡应恢复，而不是「动作不存在」');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.name, 'append_chapter');
  assert.deepEqual(restored.args, { chapterId: 3, text: '续写段落' });
  assert.equal(restored.toolCallId, 'call_abc');
  assert.equal(restored.targetRevision, 7);
  assert.equal(restored.requestedBy, 'agent');
  assert.equal(restored.summary, '追加第三章');
  assert.deepEqual(restored.impact, ['正文变更']);
  assert.equal(restored.argsHash, action.argsHash, 'argsHash 应一致（authorize 校验可用）');

  // 恢复后整条确认链仍可用：authorize 校验哈希 → settle 结算
  const auth = actionStore.authorize(action.id, { bookId, name: 'append_chapter', args: restored.args });
  assert.equal(auth.ok, true, '重启后确认链应可继续');
});

test('重启恢复：结算结果与续跑状态跨进程存活', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('结算书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'x' });
  actionStore.settle(action.id, 'approved', { ok: true, appended_chars: 1 });
  actionStore.setResumeMessage(action.id, 42);
  actionStore.markResumeDone(action.id);

  const rejected = actionStore.create(bookId, 'update_character_profile', { characterId: 1 });
  actionStore.reject(rejected.id);

  await reopen(location);

  const restored = actionStore.get(action.id);
  assert.equal(restored.status, 'approved');
  assert.deepEqual(restored.result, { ok: true, appended_chars: 1 });
  assert.equal(restored.resumeDone, true, '续跑一次性标记应持久');
  assert.equal(restored.resumeMessageId, 42, '信封消息行 id 应持久');
  assert.equal(actionStore.get(rejected.id).status, 'rejected');
});

test('过期语义：pending 超时变 expired，settled 超保留期清行', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('过期书')").lastInsertRowid;

  const shortLived = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'a' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(actionStore.get(shortLived.id).status, 'expired');

  // F5a：settled 行保留期由 30 分钟改为 30 天（已结算卡刷新后可回放）——31 分钟前结算的行不再删除
  const settled = actionStore.create(bookId, 'append_chapter', { chapterId: 2, text: 'b' });
  actionStore.settle(settled.id, 'approved', { ok: true });
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 31 * 60 * 1000, settled.id]);
  assert.ok(actionStore.get(settled.id), 'settled 卡在 30 天保留期内应保留（旧语义此处会被清掉）');

  // 超过 30 天保留期才被 sweep 惰性清行
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 31 * 24 * 60 * 60 * 1000, settled.id]);
  assert.equal(actionStore.get(settled.id), null, '超过 30 天保留期的 settled 行应被惰性清理');
});

test('重复续跑防线的持久化：重启后 resumeDone 仍拦截', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('续跑书')").lastInsertRowid;
  const action = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'c' });
  actionStore.settle(action.id, 'approved', { ok: true });
  actionStore.markResumeDone(action.id);

  await reopen(location);
  assert.equal(actionStore.get(action.id).resumeDone, true, '重启后仍应判定「已续跑过」');
});

// 2026-09-11 实测：并行流把同一写动作重复提交，堆出 2 张同参 create_chapter、
// 3 张同参 update_volume 确认卡（args 逐字节相同），作者面对一堆一模一样的卡。
// 同 session 同工具同参数且仍在 pending ⇒ 同一次授权意图，复用旧卡。
test('同参去重：pending 期间重复提交同一动作只保留一张确认卡', async t => {
  const location = setup(t);
  await db.init({ filePath: location.filePath });
  const bookId = db.run("INSERT INTO books (title) VALUES ('去重书')").lastInsertRowid;
  const args = { volumeId: 4, title: '常识修改' };

  const first = actionStore.create(bookId, 'update_volume', args);
  const second = actionStore.create(bookId, 'update_volume', args);
  const third = actionStore.create(bookId, 'update_volume', args);

  assert.equal(second.id, first.id, '同参重复提交应复用同一张卡');
  assert.equal(third.id, first.id);
  assert.equal(actionStore.listPending(bookId).length, 1, '表里只应有一张 pending 卡');

  // 参数不同 → 必须新建（不能把不同动作误判为重复）
  const other = actionStore.create(bookId, 'update_volume', { volumeId: 4, title: '另一个标题' });
  assert.notEqual(other.id, first.id, '参数不同应新建卡片');
  assert.equal(actionStore.listPending(bookId).length, 2);

  // 参数键顺序不同但语义相同 → 仍视为同一动作（canonicalJson 归一化）
  const reordered = actionStore.create(bookId, 'update_volume', { title: '常识修改', volumeId: 4 });
  assert.equal(reordered.id, first.id, '键序不同不应产生第二张卡');

  // 已结算的同参动作不再复用：作者已拒绝过的动作，模型再提交应给新卡（可重新裁决）
  actionStore.reject(first.id);
  const afterReject = actionStore.create(bookId, 'update_volume', args);
  assert.notEqual(afterReject.id, first.id, '已结算的卡不应被复用（否则无法重新裁决）');

  // 过期卡不应被复用
  const shortLived = actionStore.create(bookId, 'set_master_outline', { outline: 'x' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));
  const afterExpire = actionStore.create(bookId, 'set_master_outline', { outline: 'x' });
  assert.notEqual(afterExpire.id, shortLived.id, '过期卡不应被复用');

  // 不同 session 不共享（跨会话隔离，与 authorize 的会话绑定一致）
  const s1 = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 's1' }, { sessionId: 'book:other' });
  const s2 = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 's1' });
  assert.notEqual(s1.id, s2.id, '不同 session 的同参动作应各自成卡');
});
