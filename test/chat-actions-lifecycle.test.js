// F2~F5a 确认卡生命周期单测（2026-09-11 真实库 chat_actions/llm_calls 取证的四项缺陷）。
//
// 零真实网络：纯 store 用例直连临时库；管线用例用 helpers/llm-stub（fetch 边界剧本 mock，
// 端点 http://llm-stub.local 占位、key 一律 sk-test-xxx），真实 chat.js 路由与 messages 落库在环内。
//
// 覆盖：
//   F2 近重复卡自动取代（含判据边界与精确去重回归）
//   F4 拒绝冷却守卫（refused 不落库 / 窗口外放行 / 跨工具跨会话不受影响 / executor 抛 DomainError）
//   F3 过期卡不静默丢意图（listExpiredUnnotified → markExpiredNotified → 系统事件落 messages）
//   F5a 结算卡可回放（settled 30 天保留边界）
//   authorize 对被取代卡返回 CONFIRMATION_SUPERSEDED（store + 路由 409）
//   契约 1/2/3/5（expiredActions / 全状态 actions / source 落库）
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen } = require('./helpers/http');
const actionStore = require('../server/actionStore');
const { requestConfirmation } = require('../server/tools/executor');
const { installFetchStub, sseStub, readStreamEvents } = require('./helpers/llm-stub');

const EXPIRED_MARK = '[系统事件·操作超时未执行]';

// 纯 store 用例：临时库 + 一本书
async function setup(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  t.after(() => cleanup(location));
  return { bookId, location };
}

// 管线用例：临时库 + 占位 LLM 设置 + fetch 剧本 mock + 真实 HTTP 服务
async function setupHttp(t, title) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const stub = installFetchStub();
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.run("INSERT INTO settings (key, value) VALUES ('base_url', 'http://llm-stub.local/v1')");
  db.run("INSERT INTO settings (key, value) VALUES ('api_key', 'sk-test-xxx')");
  db.run("INSERT INTO settings (key, value) VALUES ('model', 'agnes-2.5-flash')");
  const http = await listen(createApp());
  t.after(async () => {
    if (http.server.closeAllConnections) http.server.closeAllConnections();
    await http.close();
    stub.restore();
    cleanup(location);
  });
  return { bookId, http, stub };
}

function streamText(text) {
  return sseStub([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
}

async function postStream(http, bookId, body) {
  const res = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, events: await readStreamEvents(res) };
}

// ---------------- F2：近重复卡自动取代 ----------------
test('F2 近重复取代：第6章 vs 第6章：书架间的猎物 → 旧卡 superseded、新卡 pending', async t => {
  const { bookId } = await setup(t, 'F2 近重复');
  const oldCard = actionStore.create(bookId, 'create_chapter', { title: '第6章' });
  const newCard = actionStore.create(bookId, 'create_chapter', { title: '第6章：书架间的猎物' });

  assert.notEqual(newCard.id, oldCard.id, '参数不完全相同 → 精确去重按设计不合并，必须新建');
  const old = actionStore.get(oldCard.id);
  assert.equal(old.status, 'superseded', '旧卡应被标记 superseded');
  assert.equal(old.supersededBy, newCard.id, 'superseded_by 回填新卡 id');
  assert.equal(newCard.status, 'pending');
  const pending = actionStore.listPending(bookId);
  assert.deepEqual(pending.map(a => a.id), [newCard.id], '待确认列表只剩最新那张');

  // 全状态列表（契约 2 的数据源）应同时含两张：superseded 可回放
  const all = actionStore.listAll(bookId);
  assert.deepEqual(all.map(a => a.status).sort(), ['pending', 'superseded']);
});

test('F2 判据边界：不同章标题不算近重复（两张都 pending）', async t => {
  const { bookId } = await setup(t, 'F2 不同章');
  const a = actionStore.create(bookId, 'create_chapter', { title: '第6章' });
  const b = actionStore.create(bookId, 'create_chapter', { title: '第7章' });

  assert.equal(actionStore.get(a.id).status, 'pending', '互不包含 → 不是近重复，旧卡不得被取代');
  assert.equal(actionStore.get(b.id).status, 'pending');
  assert.equal(actionStore.listPending(bookId).length, 2, '合法创建多章：两张都保留');
});

test('F2 判据边界：非字符串字段、键集不同、含数组/对象一律不判近重复', async t => {
  const { bookId } = await setup(t, 'F2 边界');
  // 非字符串标量必须严格相等：volumeId 不同 → 不取代
  const v1 = actionStore.create(bookId, 'update_volume', { volumeId: 4, title: '常识修改' });
  const v2 = actionStore.create(bookId, 'update_volume', { volumeId: 5, title: '常识修改' });
  assert.equal(actionStore.get(v1.id).status, 'pending');
  assert.equal(actionStore.get(v2.id).status, 'pending');

  // 键集不同 → 不做包含式猜测
  const k1 = actionStore.create(bookId, 'set_chapter_meta', { title: '第8章' });
  const k2 = actionStore.create(bookId, 'set_chapter_meta', { title: '第8章：加长版', beat: '节拍' });
  assert.equal(actionStore.get(k1.id).status, 'pending');
  assert.equal(actionStore.get(k2.id).status, 'pending');

  // 参数字段含数组/对象 → 直接跳过近重复判定（不猜嵌套结构）
  const c1 = actionStore.create(bookId, 'propose_story_event', { summary: '甲', changes: [{ k: 'v' }] });
  const c2 = actionStore.create(bookId, 'propose_story_event', { summary: '甲与乙', changes: [{ k: 'v' }] });
  assert.equal(actionStore.get(c1.id).status, 'pending');
  assert.equal(actionStore.get(c2.id).status, 'pending');

  // 纯函数判据本身也直接断言（边界即文档）
  assert.equal(actionStore.isNearDuplicateArgs({ a: 'abc' }, { a: 'abcd' }), true);
  assert.equal(actionStore.isNearDuplicateArgs({ a: 'abc' }, { a: 'abc' }), false, '完全相同不属于近重复（走精确去重）');
  assert.equal(actionStore.isNearDuplicateArgs({ a: 'abc' }, { a: 'xyz' }), false);
  assert.equal(actionStore.isNearDuplicateArgs({ a: 1 }, { a: '1' }), false, '跨类型不猜');
});

test('F2 回归：精确去重仍复用同参卡，且不误取代', async t => {
  const { bookId } = await setup(t, 'F2 精确去重回归');
  const first = actionStore.create(bookId, 'update_volume', { volumeId: 4, title: '常识修改' });
  const again = actionStore.create(bookId, 'update_volume', { volumeId: 4, title: '常识修改' });
  assert.equal(again.id, first.id, '同参重复提交仍复用旧卡');
  assert.equal(actionStore.get(first.id).status, 'pending', '复用路径不得把卡置为 superseded');
  assert.equal(actionStore.listAll(bookId).length, 1);
});

// ---------------- F4：拒绝后不得立即重试 ----------------
test('F4 拒绝冷却：同名近重复请求被拒收（refused）且一行不落库', async t => {
  const { bookId } = await setup(t, 'F4 冷却');
  const rejected = actionStore.create(bookId, 'create_character', { name: '林野' });
  actionStore.reject(rejected.id);

  const refused = actionStore.create(bookId, 'create_character', { name: '林野（逃亡船长）' });
  assert.equal(refused.refused, true, '拒绝后换参数近重复重发应被拒收');
  assert.equal(refused.reason, 'REJECTED_RETRY');
  assert.equal(refused.priorActionId, rejected.id, '带上被拒绝的原始动作 id 供模型/前端说明');
  assert.equal(refused.id, undefined, '拒收即不创建（无 id 返回）');
  assert.equal(actionStore.listAll(bookId).length, 1, '只有被拒绝那一行，没有新卡落库');
  assert.equal(actionStore.listPending(bookId).length, 0);
});

test('F4 冷却边界：超过 10 分钟窗口放行；不同工具/不同会话不受影响', async t => {
  const { bookId } = await setup(t, 'F4 窗口');
  const rejected = actionStore.create(bookId, 'create_character', { name: '林野' });
  actionStore.reject(rejected.id);

  // 不同工具：不受同名工具冷却影响
  const otherTool = actionStore.create(bookId, 'update_character_profile', { name: '林野·改' });
  assert.equal(otherTool.refused, undefined);
  // 不同 session：隔离
  const otherSession = actionStore.create(bookId, 'create_character', { name: '林野·改' }, { sessionId: 'book:other' });
  assert.equal(otherSession.refused, undefined);

  // 冷却窗口内仍拦截
  assert.equal(actionStore.create(bookId, 'create_character', { name: '林野·改' }).refused, true);

  // 把拒绝时间拨回 11 分钟前 → 窗口外放行（假时钟：直接改 settled_at）
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 11 * 60 * 1000, rejected.id]);
  const allowed = actionStore.create(bookId, 'create_character', { name: '林野·改' });
  assert.equal(allowed.refused, undefined, '窗口外应放行');
  assert.equal(allowed.status, 'pending');
});

test('F4 executor 回灌：requestConfirmation 收到 refused 抛 DomainError(REJECTED_RETRY, 409)', async t => {
  const { bookId } = await setup(t, 'F4 executor');
  const context = { profile: 'writing', sessionId: `writing:book:${bookId}`, bookId, source: 'writing-chat', actor: 'author' };

  // 正对照：首次请求正常挂确认卡
  const first = await requestConfirmation(context, 'create_character', { name: '林野' });
  assert.equal(first.status, 'confirmation_required');
  actionStore.reject(first.confirmation.id);

  // 冷却期内近重复 → DomainError（错误即粮食：回灌模型自纠，不落卡）
  await assert.rejects(
    async () => requestConfirmation(context, 'create_character', { name: '林野（船长）' }),
    err => err.code === 'REJECTED_RETRY'
      && err.status === 409
      && err.details && err.details.priorActionId === first.confirmation.id
  );
  assert.equal(actionStore.listAll(bookId).length, 1);
});

// ---------------- F3：过期卡不再静默丢意图 ----------------
test('F3 待通知列表：listExpiredUnnotified 返回过期未通知卡，markExpiredNotified 后清空', async t => {
  const { bookId } = await setup(t, 'F3 待通知');
  const shortLived = actionStore.create(bookId, 'update_volume', { volumeId: 3, title: '常识修改' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(actionStore.get(shortLived.id).status, 'expired');

  const noticed = actionStore.listExpiredUnnotified(bookId, 5);
  assert.equal(noticed.length, 1, '过期卡应进入待通知列表');
  assert.equal(noticed[0].id, shortLived.id);
  assert.equal(noticed[0].expiryNotified, false);

  assert.equal(actionStore.markExpiredNotified([shortLived.id]), 1);
  assert.deepEqual(actionStore.listExpiredUnnotified(bookId, 5), [], '标记后同一批不再重复通知');
  assert.equal(actionStore.get(shortLived.id).expiryNotified, true);

  // 契约文案逐字断言（含工具名与截断后的参数）
  const text = actionStore.expiredNoticeText(actionStore.get(shortLived.id));
  assert.ok(text.startsWith(EXPIRED_MARK), '文案以系统事件标记开头');
  assert.ok(text.includes('写工具 update_volume'));
  assert.ok(text.includes('从未执行'));
  assert.ok(text.includes('请不要把它当作已完成的事实；如仍需执行，请重新发起并说明。'));
});

test('F3 管线：过期卡作为系统事件落 messages 并进入本轮 history，同一批只通知一次', async t => {
  const { bookId, http, stub } = await setupHttp(t, 'F3 管线');
  const shortLived = actionStore.create(bookId, 'update_volume', { volumeId: 3, title: '常识修改' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(actionStore.get(shortLived.id).status, 'expired');

  stub.responders.push(() => streamText('收到，那条改名从未生效。'));
  const first = await postStream(http, bookId, { content: '继续写' });
  assert.equal(first.status, 200);
  assert.ok(first.events.some(e => e.type === 'done'));

  const notices = db.all(
    "SELECT role, source, content FROM messages WHERE book_id = ? AND content LIKE ?",
    [bookId, EXPIRED_MARK + '%']
  );
  assert.equal(notices.length, 1, '过期卡应落一条系统事件消息');
  assert.equal(notices[0].role, 'user', '按约定以 user 角色落库（自然进入 history）');
  assert.equal(notices[0].source, 'system');
  assert.ok(notices[0].content.includes('update_volume'));
  assert.ok(
    JSON.stringify(stub.calls[0].body.messages).includes('操作超时未执行'),
    '本轮 history 里模型即可见该事件'
  );
  assert.deepEqual(actionStore.listExpiredUnnotified(bookId, 5), [], '已通知');

  // 第二轮不再重复通知（同一批只通知一次）
  stub.responders.push(() => streamText('好的，继续。'));
  await postStream(http, bookId, { content: '继续' });
  const after = db.all(
    "SELECT id FROM messages WHERE book_id = ? AND content LIKE ?",
    [bookId, EXPIRED_MARK + '%']
  );
  assert.equal(after.length, 1, '同一批只通知一次，不重复落事件');
});

test('F3 管线：一批多张过期卡各落一条系统事件（逐字模板按卡渲染）', async t => {
  const { bookId, http, stub } = await setupHttp(t, 'F3 多卡');
  const first = actionStore.create(bookId, 'update_volume', { volumeId: 3, title: '常识修改' }, { ttlMs: 1 });
  const second = actionStore.create(bookId, 'create_chapter', { title: '第8章' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));

  stub.responders.push(() => streamText('两条都记为未执行。'));
  await postStream(http, bookId, { content: '继续' });

  const notices = db.all(
    "SELECT content FROM messages WHERE book_id = ? AND content LIKE ? ORDER BY id",
    [bookId, EXPIRED_MARK + '%']
  );
  // 决策记录：F3 文案模板是「按单张卡」逐字给定的（含 name/args 单数），故一批 N 张即 N 条事件；
  // 「同一批只通知一次」指不重复通知，不是合并成一条。
  assert.equal(notices.length, 2, '每张未通知过期卡各落一条系统事件');
  assert.ok(notices[0].content.includes('update_volume'));
  assert.ok(notices[1].content.includes('create_chapter'));
  assert.deepEqual(actionStore.listExpiredUnnotified(bookId, 5), [], '整批一起标记为已通知');
  assert.equal(actionStore.get(first.id).expiryNotified, true);
  assert.equal(actionStore.get(second.id).expiryNotified, true);
});

// ---------------- F5a：结算卡可回放 ----------------
test('F5a 结算保留期：30 天内保留、超过 30 天删除', async t => {
  const { bookId } = await setup(t, 'F5a 保留期');
  const inside = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: '近的' });
  actionStore.settle(inside.id, 'approved', { ok: true });
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 29 * 24 * 60 * 60 * 1000, inside.id]);
  assert.ok(actionStore.get(inside.id), '29 天前的结算卡应保留（可回放）');

  const outside = actionStore.create(bookId, 'append_chapter', { chapterId: 2, text: '远的' });
  actionStore.settle(outside.id, 'approved', { ok: true });
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 31 * 24 * 60 * 60 * 1000, outside.id]);
  assert.equal(actionStore.get(outside.id), null, '超过 30 天保留期的行才被清');

  // 30 分钟不再删除（旧语义回归点）
  const recent = actionStore.create(bookId, 'append_chapter', { chapterId: 3, text: '31分钟前结算' });
  actionStore.settle(recent.id, 'rejected', undefined);
  db.run('UPDATE chat_actions SET settled_at = ? WHERE id = ?', [Date.now() - 31 * 60 * 1000, recent.id]);
  assert.ok(actionStore.get(recent.id), 'settled 卡 30 分钟内必然保留');
});

// ---------------- authorize / 路由：被取代卡不得执行 ----------------
test('F2 authorize：被取代卡返回 CONFIRMATION_SUPERSEDED，不再走 pending 路径', async t => {
  const { bookId } = await setup(t, 'F2 authorize');
  const oldCard = actionStore.create(bookId, 'create_chapter', { title: '第6章' });
  actionStore.create(bookId, 'create_chapter', { title: '第6章：书架间的猎物' });

  const auth = actionStore.authorize(oldCard.id, {
    bookId, name: 'create_chapter', args: { title: '第6章' },
    sessionId: actionStore.get(oldCard.id).sessionId,
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 'CONFIRMATION_SUPERSEDED');

  // executor 路径：授权阶段拿到该 code → DomainError(INVALID_CONFIRMATION, details.reason)，
  // 由 routes 侧映射为 409 CONFIRMATION_SUPERSEDED（见下一条用例）
  const { executeTool } = require('../server/tools/executor');
  await assert.rejects(
    async () => executeTool({
      profile: 'writing', sessionId: actionStore.get(oldCard.id).sessionId, bookId,
      source: 'writing-chat-confirm', actor: 'author',
    }, 'create_chapter', { title: '第6章' }, oldCard.id),
    err => err.code === 'INVALID_CONFIRMATION' && err.details && err.details.reason === 'CONFIRMATION_SUPERSEDED'
  );
});

test('F2 路由：确认被取代卡 → 409 + CONFIRMATION_SUPERSEDED（写作页确认路由）', async t => {
  const { bookId, http } = await setupHttp(t, 'F2 路由映射');
  const oldCard = actionStore.create(bookId, 'create_chapter', { title: '第6章' });
  actionStore.create(bookId, 'create_chapter', { title: '第6章：书架间的猎物' });

  const res = await fetch(`${http.baseUrl}/api/books/${bookId}/chat-actions/${oldCard.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'CONFIRMATION_SUPERSEDED');
  assert.ok(body.error.includes('已被更新的同类请求取代'));
});

// ---------------- 契约 1/2/3/5 ----------------
test('契约 2：GET /chat/actions 返回 {actions, expiredUnnotified} 全状态列表', async t => {
  const { bookId, http } = await setupHttp(t, '契约2 全状态');
  const pending = actionStore.create(bookId, 'create_chapter', { title: '第9章' });
  const settled = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'x' });
  actionStore.settle(settled.id, 'approved', { ok: true });
  const rejected = actionStore.create(bookId, 'update_volume', { volumeId: 1, title: '甲卷' });
  actionStore.reject(rejected.id);
  const expired = actionStore.create(bookId, 'set_master_outline', { outline: '略' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));

  const data = await fetch(`${http.baseUrl}/api/books/${bookId}/chat/actions`).then(r => r.json());
  assert.ok(Array.isArray(data.actions) && Array.isArray(data.expiredUnnotified), '响应形状为 {actions, expiredUnnotified}');
  const byId = new Map(data.actions.map(a => [a.id, a]));
  assert.equal(data.actions.length, 4, '全部状态的卡都返回（含已结算/已过期）');
  assert.ok(data.actions.every((a, i, arr) => i === 0 || arr[i - 1].createdAt <= a.createdAt), '按 created_at 升序');
  for (const key of ['id', 'name', 'args', 'summary', 'impact', 'status', 'createdAt', 'expiresAt', 'settledAt', 'result', 'supersededBy']) {
    assert.ok(key in byId.get(pending.id), `动作项应含字段 ${key}`);
  }
  assert.equal(byId.get(settled.id).status, 'approved');
  assert.deepEqual(byId.get(settled.id).result, { ok: true }, '结算结果可回放');
  assert.equal(byId.get(rejected.id).status, 'rejected');
  assert.equal(byId.get(expired.id).status, 'expired');
  assert.equal(byId.get(pending.id).result, null, '未结算项 result 为 null');

  assert.deepEqual(data.expiredUnnotified.map(a => a.id), [expired.id]);
  assert.equal(data.expiredUnnotified[0].name, 'set_master_outline');
  assert.ok(data.expiredUnnotified[0].expiredAt > 0);
});

test('契约 1/5：GET /chat 返回 expiredActions，messages 每条带 source', async t => {
  const { bookId, http, stub } = await setupHttp(t, '契约1 会话');
  const expired = actionStore.create(bookId, 'update_volume', { volumeId: 3, title: '常识修改' }, { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 5));

  // 先看会话接口：过期未通知卡随会话返回（尚未被 stream 消费）
  const before = await fetch(`${http.baseUrl}/api/books/${bookId}/chat`).then(r => r.json());
  assert.ok(Array.isArray(before.expiredActions), '响应含 expiredActions');
  assert.deepEqual(before.expiredActions.map(a => a.id), [expired.id]);
  for (const key of ['id', 'name', 'args', 'summary', 'expiredAt']) {
    assert.ok(key in before.expiredActions[0], `过期卡应含字段 ${key}`);
  }
  assert.equal(before.expiredActions[0].name, 'update_volume');
  assert.equal(typeof before.expiredActions[0].summary, 'string');
  assert.deepEqual(before.expiredActions[0].args, { volumeId: 3, title: '常识修改' });
  assert.ok(before.expiredActions[0].expiredAt > 0);

  stub.responders.push(() => streamText('按未改名处理。'));
  await postStream(http, bookId, { content: '继续', source: 'read' });

  const data = await fetch(`${http.baseUrl}/api/books/${bookId}/chat`).then(r => r.json());
  assert.ok(data.messages.length >= 3, '系统事件 + 用户消息 + 助手回复');
  assert.ok(data.messages.every(m => typeof m.source === 'string'), '每条消息都带 source 字段');
  const userMsg = data.messages.find(m => m.role === 'user' && m.content.startsWith('继续'));
  assert.equal(userMsg.source, 'read', '来源页 source 透传');
  const assistantMsg = data.messages.find(m => m.role === 'assistant');
  assert.equal(assistantMsg.source, 'read');
  const notice = data.messages.find(m => m.content.startsWith(EXPIRED_MARK));
  assert.equal(notice.source, 'system');
  // stream 已把该批过期卡标记为已通知 → 会话接口不再重复推送（同一批只通知一次）
  assert.deepEqual(data.expiredActions, [], '已通知的过期卡不再随会话返回');
});

test('契约 3/5：source 缺省为空串；续跑信封消息写来源页 source，无则 system', async t => {
  const { bookId, http, stub } = await setupHttp(t, '契约3 source');

  stub.responders.push(() => streamText('不指定来源页的回复。'));
  await postStream(http, bookId, { content: '无来源页' });
  const noSource = db.get("SELECT source FROM messages WHERE book_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1", [bookId]);
  assert.equal(noSource.source, '', '未传 source → 落库空串');

  // 续跑信封：带来源页 → 写该页
  const withSource = actionStore.create(bookId, 'append_chapter', { chapterId: 1, text: 'y' });
  actionStore.settle(withSource.id, 'approved', { ok: true });
  stub.responders.push(() => streamText('续跑完成。'));
  await postStream(http, bookId, { resumeActionId: withSource.id, source: 'agent' });
  const envelope = db.get(
    "SELECT source, content FROM messages WHERE book_id = ? AND role = 'user' AND content LIKE '%[确认执行结果·系统事件]%' ORDER BY id DESC LIMIT 1",
    [bookId]
  );
  assert.equal(envelope.source, 'agent');

  // 续跑信封：不带来源页 → 'system'
  const noSourceResume = actionStore.create(bookId, 'append_chapter', { chapterId: 2, text: 'z' });
  actionStore.settle(noSourceResume.id, 'approved', { ok: true });
  stub.responders.push(() => streamText('续跑完成二。'));
  await postStream(http, bookId, { resumeActionId: noSourceResume.id });
  const envelope2 = db.get(
    "SELECT source FROM messages WHERE book_id = ? AND role = 'user' AND content LIKE '%[确认执行结果·系统事件]%' ORDER BY id DESC LIMIT 1",
    [bookId]
  );
  assert.equal(envelope2.source, 'system');
});

// ---------------- M9-A：拒绝写审计 + 过期通知溢出提示（M7 未做项 #1/#4 收口） ----------------
// 1) countExpiredUnnotified 与 listExpiredUnnotified 同口径（先 sweep、同一 WHERE，无 LIMIT）
test('M9-A countExpiredUnnotified：6 张过期 → 计数 6；通知 5 张 → 1；通知完 → 0', async t => {
  const { bookId } = await setup(t, 'M9-A 计数');
  for (let i = 1; i <= 6; i++) {
    actionStore.create(bookId, 'create_chapter', { title: `第${i}章` }, { ttlMs: 1 });
  }
  await new Promise(r => setTimeout(r, 5));

  assert.equal(actionStore.countExpiredUnnotified(bookId), 6, '6 张过期未通知卡全量计数（不受 list 的 LIMIT 5 影响）');
  const firstBatch = actionStore.listExpiredUnnotified(bookId, 5);
  assert.equal(firstBatch.length, 5, '批次列表仍是 5 张上限');
  assert.equal(actionStore.markExpiredNotified(firstBatch.map(a => a.id)), 5);
  assert.equal(actionStore.countExpiredUnnotified(bookId), 1, '通知 5 张后剩 1');
  const rest = actionStore.listExpiredUnnotified(bookId, 5);
  assert.equal(rest.length, 1);
  actionStore.markExpiredNotified(rest.map(a => a.id));
  assert.equal(actionStore.countExpiredUnnotified(bookId), 0, '全部通知后归零');
  // 边界：无卡 / 他书不串号
  assert.equal(actionStore.countExpiredUnnotified(bookId), 0);
  assert.equal(actionStore.countExpiredUnnotified(999999), 0);
});

test('M9-A 契约：GET /chat 新增 expiredActionsOverflow（无溢出时为 0）', async t => {
  const { bookId, http } = await setupHttp(t, 'M9-A 会话溢出字段');
  for (let i = 1; i <= 6; i++) {
    actionStore.create(bookId, 'update_volume', { volumeId: i, title: `第${i}卷` }, { ttlMs: 1 });
  }
  await new Promise(r => setTimeout(r, 5));

  const before = await fetch(`${http.baseUrl}/api/books/${bookId}/chat`).then(r => r.json());
  assert.equal(typeof before.expiredActionsOverflow, 'number', '响应体含 number 字段 expiredActionsOverflow');
  assert.equal(before.expiredActions.length, 5, 'expiredActions 保持原上限 5 条');
  assert.equal(before.expiredActionsOverflow, 1, '溢出 = 总数 6 - 返回 5');

  // 无溢出场景：只剩 1 张未通知 → 溢出 0（不出现负值）
  actionStore.markExpiredNotified(before.expiredActions.map(a => a.id));
  const after = await fetch(`${http.baseUrl}/api/books/${bookId}/chat`).then(r => r.json());
  assert.equal(after.expiredActions.length, 1);
  assert.equal(after.expiredActionsOverflow, 0);
});

// 2) 溢出行管线级断言：真实 chat/stream 路由 + fetch 边界剧本 mock，messages 落库与模型可见性都在环内
test('M9-A 管线：>5 张过期卡首批 5 条通知尾附溢出提示，第二批补通知且不再有溢出行', async t => {
  const { bookId, http, stub } = await setupHttp(t, 'M9-A 溢出管线');
  for (let i = 1; i <= 6; i++) {
    actionStore.create(bookId, 'create_chapter', { title: `第${i}章` }, { ttlMs: 1 });
  }
  await new Promise(r => setTimeout(r, 5));

  stub.responders.push(() => streamText('收到，这些操作都按未执行处理。'));
  const first = await postStream(http, bookId, { content: '继续写' });
  assert.equal(first.status, 200);
  assert.ok(first.events.some(e => e.type === 'done'));

  const OVERFLOW = '（另有 1 个操作同样超时未执行，将在后续对话中提醒。）';
  const notices = db.all(
    "SELECT id, content FROM messages WHERE book_id = ? AND content LIKE ? ORDER BY id",
    [bookId, EXPIRED_MARK + '%']
  );
  assert.equal(notices.length, 5, '单批最多落 5 条系统事件');
  assert.ok(notices[4].content.includes(OVERFLOW), '溢出提示追加在最后一条通知尾部（\n 分隔）');
  assert.ok(notices[4].content.includes('\n' + OVERFLOW), '与正文之间以换行分隔');
  for (const n of notices.slice(0, 4)) {
    assert.ok(!n.content.includes('另有'), '仅最后一条带溢出提示');
  }
  assert.equal(actionStore.countExpiredUnnotified(bookId), 1, '第 6 张仍过期未通知');
  assert.ok(
    JSON.stringify(stub.calls[0].body.messages).includes('另有 1 个操作同样超时未执行'),
    '本轮 history 里模型即可见溢出提示'
  );

  // 第二轮：补通知第 6 张，且无剩余 → 不再追加溢出行
  stub.responders.push(() => streamText('好的，继续。'));
  await postStream(http, bookId, { content: '再来' });
  const all = db.all(
    "SELECT id, content FROM messages WHERE book_id = ? AND content LIKE ? ORDER BY id",
    [bookId, EXPIRED_MARK + '%']
  );
  assert.equal(all.length, 6, '第二批补通知第 6 张（不重复前 5 张）');
  assert.ok(!all[5].content.includes('另有'), '无剩余时不再附溢出提示');
  assert.equal(actionStore.countExpiredUnnotified(bookId), 0, '全部通知完毕');
});

// 3) 拒绝写审计：API harness（真实 createApp + 真实 HTTP + 真库），走写作页 confirm 路由
test('M9-A 拒绝审计：写作页 confirm approve:false → 响应不变且 tool_audit_logs 新增 rejected 行', async t => {
  const { bookId, http } = await setupHttp(t, 'M9-A 拒绝审计');
  const conf = requestConfirmation({
    profile: 'writing',
    sessionId: `writing:book:${bookId}`,
    bookId,
    source: 'writing-chat',
    actor: 'author',
  }, 'create_character', { name: '沈舟' }).confirmation;
  const actionId = conf.id;
  const auditCount = () => db.get(
    "SELECT COUNT(*) AS n FROM tool_audit_logs WHERE confirmation_id = ? AND status = 'rejected'",
    [actionId]
  ).n;
  assert.equal(auditCount(), 0, '拒绝前无 rejected 审计行');

  const res = await fetch(`${http.baseUrl}/api/books/${bookId}/chat-actions/${actionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: false }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: 'rejected' }, '响应体保持 {ok,status} 不变');

  const row = db.get(
    'SELECT tool_name, status, confirmed_by, requested_by, source FROM tool_audit_logs WHERE confirmation_id = ? ORDER BY id DESC LIMIT 1',
    [actionId]
  );
  assert.ok(row, '应写入 rejected 审计行');
  assert.equal(row.tool_name, 'create_character');
  assert.equal(row.status, 'rejected');
  assert.equal(row.confirmed_by, 'author', '作者确认方');
  assert.equal(row.requested_by, 'writing-chat', '原始发起方取自创建时固化值');
  assert.equal(auditCount(), 1);

  // 重复拒绝：S2-02 注入点③——结算已落盘、响应未送达的重发幂等返回同一结果（200 replayed），
  // 不重复写审计也不改状态
  const again = await fetch(`${http.baseUrl}/api/books/${bookId}/chat-actions/${actionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: false }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).replayed, true, '重复结算幂等回放');
  assert.equal(auditCount(), 1, '不重复审计');
});
