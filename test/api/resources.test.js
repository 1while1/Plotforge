// S4-01a / 任务书 05：受控资源目录与只读查询（GET /api/resources + list_resources/get_resource_summary）。
// 安全边界（契约 01 §6）：
//   1) type 是固定枚举 → 白名单映射到固定 SQL；用户输入绝不进表名/路径；
//   2) 非法 type、伪造字段、../ 路径、非法 cursor/limit 一律 400；
//   3) 跨书与不存在的引用 404；已删除（回收站）章节返回空态 200 不报错；
//   4) 响应 JSON 与模型工具结果不含 api_key、Authorization、真实配置路径、原始 settings（哨兵断言）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { listen, json } = require('../helpers/http');
const { listTools } = require('../../server/tools/registry');
const { executeTool } = require('../../server/tools/executor');

// 哨兵：只放在「绝不允许外泄」的位置（settings 原文、语料文件路径、运行会话键）
const SECRET_SENTINEL = 'sk-test-resource-sentinel-9f2a';
const UPSTREAM_SENTINEL = 'sentinel-upstream.invalid';
const PATH_SENTINEL = 'sentinel-private-dir';
const SETTINGS_SENTINEL = 'sentinel-raw-system-prompt';
const SESSION_SENTINEL = 'sentinel-session-key';

function assertNoSentinels(text, what) {
  assert.equal(text.includes(SECRET_SENTINEL), false, `${what} 不得包含 api_key`);
  assert.equal(text.includes('Authorization'), false, `${what} 不得包含 Authorization 头`);
  assert.equal(text.includes(UPSTREAM_SENTINEL), false, `${what} 不得包含真实上游地址`);
  assert.equal(text.includes(PATH_SENTINEL), false, `${what} 不得包含真实文件路径`);
  assert.equal(text.includes(SETTINGS_SENTINEL), false, `${what} 不得包含原始 settings`);
  assert.equal(text.includes(SESSION_SENTINEL), false, `${what} 不得包含运行会话键`);
}

function buildApp() {
  try { return require('../../server/app').createApp(); } catch { return null; }
}

function seedFixtures() {
  const now = new Date().toISOString();
  const bookA = db.run("INSERT INTO books (title, intro, mode, master_outline) VALUES ('资源甲书', '甲书简介', 'collab', 'MASTER_OUTLINE_SENTINEL')").lastInsertRowid;
  const bookB = db.run("INSERT INTO books (title, intro, mode) VALUES ('资源乙书', '乙书简介', 'collab')").lastInsertRowid;

  const chapters = [];
  for (let i = 1; i <= 7; i++) {
    chapters.push(db.run(
      'INSERT INTO chapters (book_id, title, content, summary, locked, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [bookA, `第${i}章`, `甲书第${i}章正文`, i === 1 ? '第一章总结' : '', i === 1 ? 1 : 0, i]
    ).lastInsertRowid);
  }
  const otherBookChapter = db.run(
    'INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 0, 1)',
    [bookB, '乙书第一章', '乙书正文']
  ).lastInsertRowid;

  const volumeId = db.run(
    'INSERT INTO volumes (book_id, title, intro, outline, summary, sort_order) VALUES (?, ?, ?, ?, ?, 1)',
    [bookA, '第一卷', '卷简介', '卷大纲', '卷总结']
  ).lastInsertRowid;

  const characterId = db.run(
    'INSERT INTO characters (book_id, name, role, note) VALUES (?, ?, ?, ?)',
    [bookA, '林野', '主角', '人物备注']
  ).lastInsertRowid;
  db.run(
    'INSERT INTO character_aliases (book_id, character_id, alias, alias_normalized, alias_type, is_primary, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [bookA, characterId, '野哥', '野哥', 'nickname', now]
  );

  const worldId = db.run(
    'INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)',
    [bookA, '灰雁号', '一条世界设定正文']
  ).lastInsertRowid;

  const eventId = db.run(
    `INSERT INTO story_events (book_id, title, summary, chapter_id, importance, origin, created_at)
     VALUES (?, ?, ?, ?, 'high', 'manual', ?)`,
    [bookA, '主角登船', '林野登上灰雁号。', chapters[0], now]
  ).lastInsertRowid;

  // 共享作者卡：book_id 为 NULL 的全局卡，经 book_style_packs 绑定到甲书（跨书共用资产）
  const cardId = db.run(
    "INSERT INTO style_packs (name, kind, book_id, profile_json, source_refs, builtin, enabled, persona, note) VALUES ('共享卡·哨兵', 'preset', NULL, '{}', '[]', 0, 1, '人设文本', '')"
  ).lastInsertRowid;
  db.run(
    "INSERT INTO book_style_packs (book_id, pack_id, role, sort_order, enabled) VALUES (?, ?, 'main', 0, 1)",
    [bookA, cardId]
  );
  db.run(
    "INSERT INTO style_rules (pack_id, title, rule, severity, sort_order) VALUES (?, '规则一', '正文规则', 'normal', 1)",
    [cardId]
  );
  db.run(
    `INSERT INTO style_samples (pack_id, title, text, source, char_count, sort_order, enabled, content_hash, vector_model, indexed_at)
     VALUES (?, '范文一', '范文正文', 'seed', 4, 1, 1, 'h1', 'bge-small-zh', ?)`,
    [cardId, now]
  );

  // 语料元数据（离线蒸馏产物）：路径列含哨兵，绝不出现在响应里
  const sourceId = db.run(
    `INSERT INTO corpus_sources (author, works_json, han_count, sha256, fingerprint_json, mask_dict_version, dir_path)
     VALUES ('哨兵作家', '["哨兵作品"]', 12345, 'sha256:abc', '{}', 'v1', ?)`,
    [`C:\\${PATH_SENTINEL}\\corpus`]
  ).lastInsertRowid;
  db.run(
    'INSERT INTO corpus_docs (source_id, work, path, han_count, sha256) VALUES (?, ?, ?, 100, ?)',
    [sourceId, '哨兵作品', `C:\\${PATH_SENTINEL}\\corpus\\a.txt`, 'sha256:def']
  );
  db.run(
    "INSERT INTO distill_jobs (source_id, stage, status, progress_json) VALUES (?, 'map', 'done', '{}')",
    [sourceId]
  );

  // 已有任务（运行行）：session_key 是服务端内部标识，绝不出现在资源响应里
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, book_id, mode, status, created_at, finished_at)
     VALUES ('run-sentinel-1', 'req-sentinel-1', ?, NULL, 'agent', ?, 'discuss', 'finished', ?, ?)`,
    [SESSION_SENTINEL, bookA, now, now]
  );
  db.run(
    `INSERT INTO agent_runs (id, request_id, session_key, conversation_id, entry, book_id, mode, status, created_at)
     VALUES ('run-sentinel-2', 'req-sentinel-2', ?, NULL, 'chat', ?, 'write', 'paused', ?)`,
    [SESSION_SENTINEL, bookA, now]
  );

  // 原始 settings（含密钥与上游地址原文）：system 资源只允许回报脱敏后的业务状态
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?)", [SECRET_SENTINEL]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('base_url', ?)", [`https://${UPSTREAM_SENTINEL}/v1`]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('model', 'sentinel-model')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('system_prompt', ?)", [SETTINGS_SENTINEL]);

  // 已删除章节：进回收站（删除引用必须返回空态而不是报错）
  const recycledId = db.run(
    'INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 8)',
    [bookA, '被删章', '被删正文']
  ).lastInsertRowid;
  db.run(
    `INSERT INTO chapter_recycle (book_id, chapter_id, title, content, summary, revision, deleted_at)
     VALUES (?, ?, '被删章', '被删正文', '', 1, ?)`,
    [bookA, recycledId, now]
  );
  db.run('DELETE FROM chapters WHERE id = ?', [recycledId]);

  return {
    bookA, bookB, chapters, otherBookChapter, volumeId, characterId, worldId,
    eventId, cardId, sourceId, recycledId,
  };
}

async function setup(t) {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const app = buildApp();
  assert.ok(app, 'server/app.js 必须能创建应用');
  const server = await listen(app);
  t.after(() => server.close());
  const fixtures = seedFixtures();
  return { server, ...fixtures };
}

function get(server, query) {
  return json(server.baseUrl, 'GET', '/api/resources?' + query);
}

test('GET /api/resources：十种白名单类型返回业务元数据（书内资源/共享作者卡/语料/任务/脱敏系统能力）', async t => {
  const f = await setup(t);

  const books = await get(f.server, 'type=book');
  assert.equal(books.status, 200, 'GET /api/resources 路由必须已挂载');
  assert.deepEqual(Object.keys(books.body).filter(k => ['items', 'nextCursor'].includes(k)).sort(), ['items', 'nextCursor']);
  const bookItem = books.body.items.find(item => item.id === f.bookA);
  assert.ok(bookItem, '书架资源应包含甲书');
  assert.equal(bookItem.type, 'book');
  assert.equal(bookItem.title, '资源甲书');
  assert.equal(bookItem.route, '#/book/' + f.bookA);
  assert.equal(bookItem.meta.chapterCount, 7, '被删章不计入章节数');
  assert.equal(books.body.nextCursor, null);
  assertNoSentinels(JSON.stringify(books.body), '书架资源 JSON');

  const chapters = await get(f.server, `type=chapter&bookId=${f.bookA}`);
  assert.equal(chapters.status, 200);
  assert.equal(chapters.body.items.length, 7);
  const firstChapter = chapters.body.items[0];
  assert.equal(firstChapter.type, 'chapter');
  assert.equal(firstChapter.bookId, f.bookA);
  assert.equal(firstChapter.status, 'locked');
  assert.equal(firstChapter.route, `#/book/${f.bookA}/read/${firstChapter.id}`);
  assert.equal(chapters.body.items[1].status, 'draft');

  const outline = await get(f.server, `type=outline&bookId=${f.bookA}`);
  assert.equal(outline.status, 200);
  assert.equal(outline.body.items.length, 1);
  assert.equal(outline.body.items[0].id, f.volumeId);
  assert.equal(outline.body.items[0].route, `#/book/${f.bookA}/workbench/outline`);

  const characters = await get(f.server, `type=character&bookId=${f.bookA}`);
  assert.equal(characters.status, 200);
  assert.equal(characters.body.items.length, 1);
  assert.equal(characters.body.items[0].title, '林野');
  assert.equal(characters.body.items[0].status, 'active');
  assert.equal(characters.body.items[0].route, `#/book/${f.bookA}/workbench/characters/${f.characterId}`);
  assert.deepEqual(characters.body.items[0].meta.aliases, ['野哥']);

  const world = await get(f.server, `type=world&bookId=${f.bookA}`);
  assert.equal(world.status, 200);
  assert.equal(world.body.items[0].id, f.worldId);
  assert.equal(world.body.items[0].route, `#/book/${f.bookA}/workbench/world/${f.worldId}`);

  const ledger = await get(f.server, `type=ledger&bookId=${f.bookA}`);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.items[0].id, f.eventId);
  assert.equal(ledger.body.items[0].route, `#/book/${f.bookA}/workbench/ledger`);

  const style = await get(f.server, `type=style&bookId=${f.bookA}`);
  assert.equal(style.status, 200);
  const card = style.body.items.find(item => item.id === f.cardId);
  assert.ok(card, '共享作者卡应出现在资源列表（卡是全局资产，绑定到本书）');
  assert.equal(card.meta.ruleCount, 1);
  assert.equal(card.meta.sampleCount, 1);
  assert.equal(card.meta.indexedSampleCount, 1, '索引状态必须可见');
  assert.equal(card.meta.lastIndexedAt !== null && card.meta.lastIndexedAt !== undefined, true);
  assert.equal(card.route, `#/book/${f.bookA}/cards`);
  assertNoSentinels(JSON.stringify(style.body), '作家卡资源 JSON');

  const corpus = await get(f.server, 'type=corpus');
  assert.equal(corpus.status, 200);
  assert.equal(corpus.body.items[0].title, '哨兵作家');
  assert.equal(corpus.body.items[0].meta.hanCount, 12345);
  assert.equal(corpus.body.items[0].meta.docCount, 1);
  assertNoSentinels(JSON.stringify(corpus.body), '语料元数据 JSON');

  const task = await get(f.server, `type=task&bookId=${f.bookA}`);
  assert.equal(task.status, 200);
  assert.equal(task.body.items[0].id, 'run-sentinel-2', '任务按最近优先返回');
  assert.equal(task.body.items[0].status, 'paused');
  assertNoSentinels(JSON.stringify(task.body), '任务资源 JSON');

  const system = await get(f.server, 'type=system');
  assert.equal(system.status, 200);
  assert.equal(system.body.items.length, 1);
  assert.equal(system.body.items[0].meta.model, 'sentinel-model');
  assert.equal(system.body.items[0].meta.keyConfigured, true, '只回报「是否已配置」，绝不回密钥');
  assert.equal(typeof system.body.items[0].meta.keyConfigured, 'boolean');
  assertNoSentinels(JSON.stringify(system.body), '系统资源 JSON');
});

test('GET /api/resources?type=...&id=...：单个资源摘要（内部路由 + 业务摘要）', async t => {
  const f = await setup(t);

  const chapter = await get(f.server, `type=chapter&bookId=${f.bookA}&id=${f.chapters[0]}`);
  assert.equal(chapter.status, 200);
  assert.equal(chapter.body.resource.found, true);
  assert.equal(chapter.body.resource.title, '第1章');
  assert.equal(chapter.body.resource.details.summary, '第一章总结');
  assert.equal(chapter.body.resource.route, `#/book/${f.bookA}/read/${f.chapters[0]}`);
  assert.equal(chapter.body.resource.details.content === undefined, true, '摘要接口不返回整章正文文件内容');

  const book = await get(f.server, `type=book&id=${f.bookA}`);
  assert.equal(book.status, 200);
  assert.equal(book.body.resource.details.masterOutlineChars > 0, true);

  const card = await get(f.server, `type=style&id=${f.cardId}&bookId=${f.bookA}`);
  assert.equal(card.status, 200);
  assert.equal(card.body.resource.found, true);
  assert.deepEqual(card.body.resource.details.boundBooks, [f.bookA], '共享卡可指向绑定它的书');

  const run = await get(f.server, `type=task&id=run-sentinel-1`);
  assert.equal(run.status, 200);
  assert.equal(run.body.resource.status, 'finished');
  assert.equal(run.body.resource.route, '#/agent');

  const system = await get(f.server, 'type=system&id=1');
  assert.equal(system.status, 200);
  assert.equal(system.body.resource.type, 'system');
  assertNoSentinels(JSON.stringify(system.body), '系统资源摘要 JSON');
});

test('分页：cursor 有效可续读；锚点行被删除后仍可续读（空态不报错）', async t => {
  const f = await setup(t);

  const page1 = await get(f.server, `type=chapter&bookId=${f.bookA}&limit=3`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 3);
  assert.deepEqual(page1.body.items.map(i => i.id), f.chapters.slice(0, 3));
  assert.equal(typeof page1.body.nextCursor, 'string');
  assert.notEqual(page1.body.nextCursor, null);

  // 锚点（第3章）被删除：游标仍有效，续读从下一行开始，不报错也不重复
  db.run('DELETE FROM chapters WHERE id = ?', [f.chapters[2]]);
  const page2 = await get(f.server, `type=chapter&bookId=${f.bookA}&limit=3&cursor=${page1.body.nextCursor}`);
  assert.equal(page2.status, 200);
  assert.deepEqual(page2.body.items.map(i => i.id), f.chapters.slice(3, 6));

  const page3 = await get(f.server, `type=chapter&bookId=${f.bookA}&limit=3&cursor=${page2.body.nextCursor}`);
  assert.deepEqual(page3.body.items.map(i => i.id), f.chapters.slice(6));
  assert.equal(page3.body.nextCursor, null, '末页 nextCursor 为 null');

  const afterEnd = await get(f.server, `type=chapter&bookId=${f.bookA}&cursor=999999&limit=99`);
  assert.equal(afterEnd.status, 200);
  assert.deepEqual(afterEnd.body.items, [], '游标越界/指向已不存在的锚点返回空数组，不报错');

  // 任务同为可分页资源（最近优先）
  const taskPage = await get(f.server, `type=task&bookId=${f.bookA}&limit=1`);
  assert.equal(taskPage.body.items.length, 1);
  assert.equal(taskPage.body.items[0].id, 'run-sentinel-2');
  const taskPage2 = await get(f.server, `type=task&bookId=${f.bookA}&limit=1&cursor=${taskPage.body.nextCursor}`);
  assert.equal(taskPage2.body.items[0].id, 'run-sentinel-1');
  assert.equal(taskPage2.body.nextCursor, null);
});

test('错误类型、伪造字段、路径遍历与非法游标一律拒绝（400）', async t => {
  const f = await setup(t);
  const booksBefore = db.get('SELECT COUNT(*) AS n FROM books').n;

  const invalidTypeResponse = await get(f.server, 'type=../../etc/passwd');
  assert.equal(invalidTypeResponse.status, 400);
  assert.equal(invalidTypeResponse.body.error.code, 'INVALID_RESOURCE_TYPE');

  for (const query of [
    'type=books',
    'type=book;DROP TABLE books',
    'type=sqlite_master',
    '',
  ]) {
    const resp = await get(f.server, query);
    assert.equal(resp.status, 400, `非法 type 请求必须 400：${query}`);
    assert.equal(resp.body.error.code, 'INVALID_RESOURCE_TYPE');
  }

  // 伪造字段：不在白名单里的查询键一律拒绝
  const forgedField = await get(f.server, `type=chapter&bookId=${f.bookA}&sql=SELECT%20*%20FROM%20sqlite_master`);
  assert.equal(forgedField.status, 400);
  assert.equal(forgedField.body.error.code, 'RESOURCE_FIELD_FORBIDDEN');
  const forgedTable = await get(f.server, `type=chapter&bookId=${f.bookA}&table=messages`);
  assert.equal(forgedTable.status, 400);
  // 全局类型不接受 bookId（含 system/corpus/book）
  for (const type of ['book', 'corpus', 'system']) {
    const resp = await get(f.server, `type=${type}&bookId=${f.bookA}`);
    assert.equal(resp.status, 400, `type=${type} 不接受 bookId`);
  }

  // 路径遍历：id / cursor 同样只能是有界标识
  for (const query of [
    `type=chapter&bookId=${f.bookA}&id=../../etc/passwd`,
    `type=chapter&bookId=${f.bookA}&id=..%2F..%2Fnovel.db`,
    `type=chapter&bookId=${f.bookA}&cursor=../../`,
    `type=chapter&bookId=${f.bookA}&cursor=1;DROP%20TABLE%20chapters`,
    `type=task&id=..%5C..%5Cwindows%5Csystem32`,
  ]) {
    const resp = await get(f.server, query);
    assert.equal(resp.status, 400, `路径遍历请求必须 400：${query}`);
  }

  const badLimit = await get(f.server, `type=chapter&bookId=${f.bookA}&limit=abc`);
  assert.equal(badLimit.status, 400);
  const zeroLimit = await get(f.server, `type=chapter&bookId=${f.bookA}&limit=0`);
  assert.equal(zeroLimit.status, 400);

  assert.equal(db.get('SELECT COUNT(*) AS n FROM books').n, booksBefore, '被拒请求不得改动数据库');
});

test('跨书/不存在引用 404；已删除引用返回空态 200；空集合是空数组不报错', async t => {
  const f = await setup(t);

  const crossBookResult = await get(f.server, `type=chapter&bookId=${f.bookB}&id=${f.chapters[0]}`);
  assert.equal(crossBookResult.status, 404, '甲书章节在乙书上下文必须 404（不泄露存在性）');
  assert.equal(crossBookResult.body.error.code, 'RESOURCE_NOT_FOUND');

  const crossBookList = await get(f.server, `type=character&bookId=${f.bookB}`);
  assert.equal(crossBookList.status, 200);
  assert.deepEqual(crossBookList.body.items, [], '乙书没有人物 → 空态而非报错');

  const missingBook = await get(f.server, 'type=chapter&bookId=987654');
  assert.equal(missingBook.status, 404);
  assert.equal(missingBook.body.error.code, 'BOOK_NOT_FOUND');

  const missingBookId = await get(f.server, 'type=chapter');
  assert.equal(missingBookId.status, 400);
  assert.equal(missingBookId.body.error.code, 'BOOK_REQUIRED');

  const missingId = await get(f.server, `type=character&bookId=${f.bookA}&id=987654`);
  assert.equal(missingId.status, 404);

  const deleted = await get(f.server, `type=chapter&bookId=${f.bookA}&id=${f.recycledId}`);
  assert.equal(deleted.status, 200, '已删除（回收站）引用返回空态，不报错');
  assert.equal(deleted.body.resource.found, false);
  assert.equal(deleted.body.resource.deleted, true);
  assert.equal(deleted.body.resource.recoverable, true);

  const missingTask = await get(f.server, 'type=task&id=run-does-not-exist');
  assert.equal(missingTask.status, 404);
});

test('只读工具 list_resources/get_resource_summary：agent 与 agent-discuss 可达，writing/character 不可达', () => {
  const names = profile => listTools(profile).map(tool => tool.name);
  for (const profile of ['agent', 'agent-discuss']) {
    assert.ok(names(profile).includes('list_resources'), `${profile} 应可达 list_resources`);
    assert.ok(names(profile).includes('get_resource_summary'), `${profile} 应可达 get_resource_summary`);
    for (const name of ['list_resources', 'get_resource_summary']) {
      const tool = listTools(profile).find(item => item.name === name);
      assert.equal(tool.mutation, 'read', `${name} 必须是只读工具`);
      assert.equal(tool.confirmation, 'none', `${name} 不得要求确认`);
      assert.equal(tool.scope, 'global', `${name} 是全局资源目录（书内类型由 bookId 参数限定）`);
      assert.ok(tool.inputSchema.properties.type, '工具参数必须声明 type 枚举');
      assert.deepEqual(tool.inputSchema.properties.type.enum, [
        'book', 'chapter', 'outline', 'character', 'world', 'ledger', 'style', 'corpus', 'task', 'system',
      ]);
      assert.equal(tool.inputSchema.additionalProperties, false, '伪造字段由 schema 层兜底');
    }
  }
  for (const profile of ['writing', 'character']) {
    assert.equal(names(profile).includes('list_resources'), false, `${profile} 不得加载全局资源工具`);
    assert.equal(names(profile).includes('get_resource_summary'), false, `${profile} 不得加载全局资源工具`);
  }
});

test('工具调用与 HTTP 同源：返回业务元数据，非法类型/跨书/伪造字段被拒且无凭证外泄', async t => {
  const f = await setup(t);
  const context = { profile: 'agent', sessionId: 'agent:test', bookId: f.bookA, source: 'test', actor: 'author' };

  const listed = await executeTool(context, 'list_resources', { type: 'chapter', bookId: f.bookA, limit: 2 });
  const resourceJson = JSON.stringify(listed);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.type, 'chapter');
  assert.equal(resourceJson.includes(SECRET_SENTINEL), false);
  assertNoSentinels(resourceJson, '模型工具结果');

  const summary = await executeTool(context, 'get_resource_summary', { type: 'character', id: f.characterId, bookId: f.bookA });
  assert.equal(summary.resource.title, '林野');
  assertNoSentinels(JSON.stringify(summary), '模型工具摘要');

  const systemSummary = await executeTool(context, 'get_resource_summary', { type: 'system', id: 1 });
  assert.equal(systemSummary.resource.meta.keyConfigured, true);
  assertNoSentinels(JSON.stringify(systemSummary), '系统资源工具摘要');

  await assert.rejects(
    executeTool(context, 'list_resources', { type: '../../etc/passwd' }),
    err => err.code === 'INVALID_RESOURCE_TYPE' && err.status === 400
  );
  await assert.rejects(
    executeTool({ ...context, bookId: null }, 'get_resource_summary', { type: 'chapter', id: f.chapters[0], bookId: f.bookB }),
    err => err.code === 'RESOURCE_NOT_FOUND' && err.status === 404
  );
  await assert.rejects(
    executeTool(context, 'list_resources', { type: 'chapter', bookId: f.bookA, table: 'messages' }),
    err => err.code === 'INVALID_ARGS'
  );
  // 直调同样不得借道写工具：这两个工具本身是只读的
  const descriptor = listTools('agent').find(tool => tool.name === 'list_resources');
  assert.equal(descriptor.capability, 'resources.read');
});
