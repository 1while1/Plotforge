// 大纲工作台支撑域与 HTTP 契约（server/domain/outlineAssistant.js + server/routes/outline.js）：
//   · buildTimeline 一次出齐卷/章结构与台账烈度投影——烈度只统计「已采纳且未被取代」的事件
//     （supersedes_event_id 指向它的行不存在），按 critical=4 / high=3 / normal=2 / low=1 取最高；
//   · fillGap / tensionReview 是「只建议不落库」的 LLM 端点：模型调用经 modelClient 注入，
//     测试全程不碰真实网络；解析不出结构就按 R02 口径显式抛 OUTLINE_LLM_PARSE_FAILED，
//     不拿原始文本冒充结构化建议；
//   · HTTP 层只覆盖不需要模型的路径（timeline 聚合 + 404/400 错误分支），
//     这些错误都必须发生在模型调用之前，故无需注入即可断言。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { seedBook } = require('../server/migrations/001-character-hub');
const outline = require('../server/domain/outlineAssistant');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

async function setup(t, title = '大纲工作台测试书') {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run(
    'INSERT INTO books (title, master_outline) VALUES (?, ?)',
    [title, '总纲：林野追查灰雁号。']
  ).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  return { location, bookId };
}

function addVolume(bookId, title, sortOrder, extra = {}) {
  return db.run(
    'INSERT INTO volumes (book_id, title, intro, outline, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [bookId, title, extra.intro || '', extra.outline || '', extra.summary || '', sortOrder]
  ).lastInsertRowid;
}

function addChapter(bookId, volumeId, options = {}) {
  const {
    title, sortOrder, beat = '', content = '', summary = '',
    revision = 1, locked = 0, driftStatus = '',
  } = options;
  return db.run(
    `INSERT INTO chapters (book_id, volume_id, title, content, summary, beat, sort_order, revision, locked, drift_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bookId, volumeId, title, content, summary, beat, sortOrder, revision, locked, driftStatus]
  ).lastInsertRowid;
}

// supersedesEventId 不为空 = 这条事件取代了旧的一条（被取代的那行从此不计入烈度投影）
function addEvent(bookId, chapterId, importance, supersedesEventId = null) {
  return db.run(
    `INSERT INTO story_events (book_id, title, summary, chapter_id, importance, supersedes_event_id, created_at)
     VALUES (?, ?, '', ?, ?, ?, datetime('now','localtime'))`,
    [bookId, `${importance} 事件`, chapterId, importance, supersedesEventId]
  ).lastInsertRowid;
}

// 注入式模型桩：返回固定文本；raw 只负责把「文本 → modelClient」包成 advisor 同款形状
function raw(text) {
  return async () => ({ content: text });
}

function expectParseFailed(promise) {
  return assert.rejects(promise, err => err.code === 'OUTLINE_LLM_PARSE_FAILED' && err.status === 502);
}

// ---------------------------------------------------------------------------
// buildTimeline / chapterIntensityMap
// ---------------------------------------------------------------------------

test('buildTimeline 出齐卷/章结构与台账烈度投影（只计未被取代的事件）', async t => {
  const { bookId } = await setup(t);
  const otherBookId = db.run('INSERT INTO books (title) VALUES (?)', ['另一部书']).lastInsertRowid;

  // 故意后插 sort_order=1 的卷：输出必须按 sort_order 排，而不是插入顺序
  const volB = addVolume(bookId, '卷二', 2);
  const volA = addVolume(bookId, '卷一', 1, { intro: '灰雁号余波', outline: '卷纲：追查灰雁号。' });
  const ch1 = addChapter(bookId, volA, {
    title: '第一章', sortOrder: 1, beat: '林野在车站醒来',
    content: '林野在废弃车站醒来。', summary: '林野醒来，手里只剩半张地图。',
  });
  const ch2 = addChapter(bookId, volA, { title: '第二章', sortOrder: 2, revision: 3, locked: 1, driftStatus: 'diverged' });
  const ch3 = addChapter(bookId, volB, { title: '第三章', sortOrder: 3, beat: '登船，与副官对峙' });
  const ch4 = addChapter(bookId, volB, { title: '第四章', sortOrder: 4, content: '灰雁号离港。' });

  // 章一：normal 被后来的 critical 取代（旧行不计），另有一条 low → 计数 2、最高 4
  const stale = addEvent(bookId, ch1, 'normal');
  addEvent(bookId, ch1, 'critical', stale);
  addEvent(bookId, ch1, 'low');
  // 章二：只有一条 high → 最高 3；章四：只有一条 low → 最高 1；章三：没有事件
  addEvent(bookId, ch2, 'high');
  addEvent(bookId, ch4, 'low');
  // 不挂章的事件不得进投影；他书事件（故意挂在本书章一上）也不得混入
  addEvent(bookId, null, 'critical');
  addEvent(otherBookId, ch1, 'critical');

  const timeline = outline.buildTimeline(bookId);
  assert.deepEqual(timeline.volumes.map(v => v.id), [volA, volB]);
  assert.deepEqual(timeline.volumes.map(v => v.sort_order), [1, 2]);
  assert.equal(timeline.volumes[0].title, '卷一');
  assert.equal(timeline.volumes[0].intro, '灰雁号余波');
  assert.equal(timeline.volumes[0].outline, '卷纲：追查灰雁号。');
  assert.equal(timeline.volumes[0].summary, '');

  assert.deepEqual(timeline.chapters.map(c => c.id), [ch1, ch2, ch3, ch4]);
  const first = timeline.chapters[0];
  assert.equal(first.volume_id, volA);
  assert.equal(first.title, '第一章');
  assert.equal(first.beat, '林野在车站醒来');
  assert.equal(first.sort_order, 1);
  assert.equal(first.revision, 1);
  assert.equal(first.locked, 0);
  assert.equal(first.drift_status, '');
  assert.equal(first.content_length, '林野在废弃车站醒来。'.length);
  assert.equal(first.has_summary, 1);
  const second = timeline.chapters[1];
  assert.equal(second.volume_id, volA);
  assert.equal(second.beat, '');
  assert.equal(second.revision, 3);
  assert.equal(second.locked, 1);
  assert.equal(second.drift_status, 'diverged');
  assert.equal(second.content_length, 0);
  assert.equal(second.has_summary, 0); // summary='' → 未写总结
  assert.equal(timeline.chapters[3].has_summary, 0);

  assert.deepEqual(outline.IMPORTANCE_RANK, { low: 1, normal: 2, high: 3, critical: 4 });
  assert.deepEqual(timeline.intensity[ch1], { event_count: 2, max_importance: 4 });
  assert.deepEqual(timeline.intensity[ch2], { event_count: 1, max_importance: 3 });
  assert.deepEqual(timeline.intensity[ch4], { event_count: 1, max_importance: 1 });
  assert.equal(timeline.intensity[ch3], undefined); // 无事件 → 不出现该章键
  assert.deepEqual(
    Object.keys(timeline.intensity).sort(),
    [String(ch1), String(ch2), String(ch4)].sort()
  );
  // 导出的 chapterIntensityMap 与 timeline.intensity 同源
  assert.deepEqual(outline.chapterIntensityMap(bookId), timeline.intensity);

  // buildTimeline 是同步函数：包成 async 以保证同步抛错也走 assert.rejects 的断言分支
  await assert.rejects(
    async () => outline.buildTimeline(999999),
    err => err.code === 'BOOK_NOT_FOUND' && err.status === 404
  );
});

// ---------------------------------------------------------------------------
// fillGap
// ---------------------------------------------------------------------------

test('fillGap：注入 modelClient 返回至多 3 条建议（id/title/beat/rationale 归一）', async t => {
  const { bookId } = await setup(t);
  const volumeId = addVolume(bookId, '卷一', 1, { intro: '灰雁号余波', outline: '卷纲：追查灰雁号。' });
  const ch1 = addChapter(bookId, volumeId, {
    title: '第一章', sortOrder: 1, beat: '林野醒来',
    content: '林野在废弃车站醒来。', summary: '林野醒来，手里只剩半张地图。',
  });
  const ch2 = addChapter(bookId, volumeId, { title: '第二章', sortOrder: 2, beat: '登船', content: '灰雁号离港。' });

  let seen = null;
  const modelClient = async messages => {
    seen = messages;
    return {
      content: JSON.stringify({
        suggestions: [
          { title: '  补一章追查  ', beat: '  林野顺半张地图找到车站值班室，逼问出灰雁号的航线。  ', rationale: ' 把线索钉在卷首 ' },
          { title: '', beat: '副官先一步发现地图缺角。', rationale: '制造信息差' },
          { title: '第三案', beat: '夜里有人翻进林野的车厢。', rationale: '提前加压' },
          { title: '第四案不该出现', beat: '超出 3 条的方案必须被丢弃。', rationale: '上限之外' },
        ],
      }),
    };
  };

  const result = await outline.fillGap(
    bookId,
    { volume_id: volumeId, before_chapter_id: ch1, after_chapter_id: ch2 },
    { modelClient }
  );

  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.suggestions.map(s => s.id), [1, 2, 3]);
  assert.equal(result.suggestions[0].title, '补一章追查'); // 前后空白被 trim
  assert.equal(result.suggestions[0].beat, '林野顺半张地图找到车站值班室，逼问出灰雁号的航线。');
  assert.equal(result.suggestions[0].rationale, '把线索钉在卷首');
  assert.equal(result.suggestions[1].title, '衔接方案 2'); // 标题缺失走兜底
  assert.equal(result.suggestions[2].title, '第三案');
  assert.equal(result.suggestions.some(s => s.title === '第四案不该出现'), false);
  assert.equal(result.volume_id, volumeId);
  assert.equal(result.before_chapter_id, ch1);
  assert.equal(result.after_chapter_id, ch2);

  // 提示词带上定位信息与前后章材料
  assert.equal(seen[0].role, 'system');
  const userText = seen.find(item => item.role === 'user').content;
  assert.ok(userText.includes('第1章与第2章之间'));
  assert.ok(userText.includes('第1章《第一章》'));
  assert.ok(userText.includes('第2章《第二章》'));
  assert.ok(userText.includes('林野醒来，手里只剩半张地图。'));
  assert.ok(userText.includes('【本卷已有章节】'));

  // 只建议不落库：章表一条不多
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 2);
});

test('fillGap：卷不存在或属于他书 → VOLUME_NOT_FOUND 404（不触达模型）', async t => {
  const { bookId } = await setup(t);
  const otherBookId = db.run('INSERT INTO books (title) VALUES (?)', ['另一部书']).lastInsertRowid;
  const foreignVolume = addVolume(otherBookId, '他书卷', 1);
  let calls = 0;
  const modelClient = async () => { calls += 1; return { content: '{"suggestions":[{"title":"x","beat":"y"}]}' }; };
  const expectVolumeNotFound = promise => assert.rejects(
    promise,
    err => err.code === 'VOLUME_NOT_FOUND' && err.status === 404
  );

  await expectVolumeNotFound(() => outline.fillGap(bookId, { volume_id: 999999 }, { modelClient }));
  await expectVolumeNotFound(() => outline.fillGap(bookId, { volume_id: foreignVolume }, { modelClient }));
  await assert.rejects(
    () => outline.fillGap(999999, { volume_id: foreignVolume }, { modelClient }),
    err => err.code === 'BOOK_NOT_FOUND' && err.status === 404
  );
  assert.equal(calls, 0);
});

test('fillGap：before/after_chapter_id 不在该卷 → CHAPTER_NOT_FOUND 404', async t => {
  const { bookId } = await setup(t);
  const volA = addVolume(bookId, '卷一', 1);
  const volB = addVolume(bookId, '卷二', 2);
  const inA = addChapter(bookId, volA, { title: '甲章', sortOrder: 1, beat: '起' });
  const inB = addChapter(bookId, volB, { title: '乙章', sortOrder: 2, beat: '转' });
  let calls = 0;
  const modelClient = async () => { calls += 1; return { content: '{}' }; };
  const expectChapterNotFound = promise => assert.rejects(
    promise,
    err => err.code === 'CHAPTER_NOT_FOUND' && err.status === 404
  );

  await expectChapterNotFound(() => outline.fillGap(bookId, { volume_id: volA, before_chapter_id: inB }, { modelClient }));
  await expectChapterNotFound(() => outline.fillGap(bookId, { volume_id: volA, after_chapter_id: inB }, { modelClient }));
  await expectChapterNotFound(() => outline.fillGap(bookId, { volume_id: volA, before_chapter_id: 999999 }, { modelClient }));
  assert.equal(calls, 0);

  // 只给 before（卷末方向）是合法调用，不该被这条守卫误伤
  const tail = await outline.fillGap(bookId, { volume_id: volA, before_chapter_id: inA }, {
    modelClient: raw('{"suggestions":[{"title":"卷末补章","beat":"林野在港口停船。","rationale":"收束"}]}'),
  });
  assert.equal(tail.suggestions.length, 1);
  assert.equal(tail.before_chapter_id, inA);
  assert.equal(tail.after_chapter_id, null);
});

test('fillGap：非 JSON 文本 / suggestions 不成立 → OUTLINE_LLM_PARSE_FAILED 502', async t => {
  const { bookId } = await setup(t);
  const volumeId = addVolume(bookId, '卷一', 1);
  addChapter(bookId, volumeId, { title: '第一章', sortOrder: 1, beat: '醒来' });

  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: raw('抱歉，我暂时给不出衔接方案。') }));
  // 含花括号但不是 JSON：退化路径同样必须失败，不得拿原文冒充建议
  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: raw('建议如下 {这不是 JSON 结构}') }));
  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: raw(JSON.stringify({ suggestions: '不是数组' })) }));
  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: raw(JSON.stringify({ suggestions: [] })) }));
  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: raw('') }));

  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 1);
});

test('fillGap：```json 围栏输出可解析；方案全部缺 beat → 502', async t => {
  const { bookId } = await setup(t);
  const volumeId = addVolume(bookId, '卷一', 1);

  const fenced = raw([
    '```json',
    JSON.stringify({ suggestions: [{ beat: '只有节拍：林野撬开值班室的门。' }] }),
    '```',
  ].join('\n'));
  const ok = await outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: fenced });
  assert.equal(ok.suggestions.length, 1);
  assert.equal(ok.suggestions[0].id, 1);
  assert.equal(ok.suggestions[0].title, '衔接方案 1'); // 标题缺失走兜底
  assert.equal(ok.suggestions[0].beat, '只有节拍：林野撬开值班室的门。');

  const noBeat = raw(JSON.stringify({
    suggestions: [{ title: 'A', rationale: '理由' }, { title: 'B', beat: '   ' }],
  }));
  await expectParseFailed(() => outline.fillGap(bookId, { volume_id: volumeId }, { modelClient: noBeat }));
});

// ---------------------------------------------------------------------------
// tensionReview
// ---------------------------------------------------------------------------

test('tensionReview：tension 夹到 1-5，非本卷/非法 chapter_id 与分数丢弃', async t => {
  const { bookId } = await setup(t);
  const volA = addVolume(bookId, '卷一', 1, { intro: '灰雁号余波', outline: '卷纲：追查灰雁号。' });
  const volB = addVolume(bookId, '卷二', 2);
  const ch1 = addChapter(bookId, volA, {
    title: '第一章', sortOrder: 1, beat: '醒来',
    content: '林野在废弃车站醒来。', summary: '林野醒来。',
  });
  const ch2 = addChapter(bookId, volA, { title: '第二章', sortOrder: 2, beat: '登船' });
  const ch3 = addChapter(bookId, volA, { title: '第三章', sortOrder: 3, beat: '对峙' });
  const foreign = addChapter(bookId, volB, { title: '他卷章', sortOrder: 4, beat: '别卷的节拍' });
  addEvent(bookId, ch1, 'critical');

  let seen = null;
  const modelClient = async messages => {
    seen = messages;
    return {
      content: JSON.stringify({
        chapter_scores: [
          { chapter_id: ch1, tension: 7 },             // 上越界 → 5
          { chapter_id: ch2, tension: 0 },             // 下越界 → 1
          { chapter_id: String(ch3), tension: '4.4' }, // 字符串 id/分数 → 四舍五入 4
          { chapter_id: foreign, tension: 5 },         // 不在本卷 → 丢弃
          { chapter_id: 999999, tension: 5 },          // 章不存在 → 丢弃
          { chapter_id: ch2, tension: 'abc' },         // 非数字 → 丢弃，且不得覆盖上一行的 1
        ],
        comment: '  连着两章平淡，建议在第二章安排一次正面冲突。  ',
      }),
    };
  };

  const result = await outline.tensionReview(bookId, { volume_id: volA }, { modelClient });
  assert.equal(result.volume_id, volA);
  assert.equal(result.comment, '连着两章平淡，建议在第二章安排一次正面冲突。');
  assert.deepEqual(result.chapter_scores, { [ch1]: 5, [ch2]: 1, [ch3]: 4 });
  assert.equal(result.chapter_scores[foreign], undefined);

  // 提示词带上台账烈度投影与各章节拍
  const userText = seen.find(item => item.role === 'user').content;
  assert.ok(userText.includes('【各章情况】'));
  assert.ok(userText.includes(`（id=${ch1}）`));
  assert.ok(userText.includes('台账事件 1 条，最高烈度 4/4'));
  assert.equal(userText.includes('林野在废弃车站醒来。'), false); // 只给摘要与节拍，不把正文塞进提示词

  // 只建议不落库：章与事件都不动
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 4);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events').n, 1);
  assert.equal(db.get('SELECT content FROM chapters WHERE id = ?', [ch1]).content, '林野在废弃车站醒来。');
});

test('tensionReview：空卷 → VOLUME_EMPTY 400，卷不存在 → VOLUME_NOT_FOUND 404（均不触达模型）', async t => {
  const { bookId } = await setup(t);
  const emptyVolume = addVolume(bookId, '空卷', 1);
  let calls = 0;
  const modelClient = async () => { calls += 1; return { content: '{"comment":"不该被调用"}' }; };

  await assert.rejects(
    () => outline.tensionReview(bookId, { volume_id: emptyVolume }, { modelClient }),
    err => err.code === 'VOLUME_EMPTY' && err.status === 400
  );
  await assert.rejects(
    () => outline.tensionReview(bookId, { volume_id: 999999 }, { modelClient }),
    err => err.code === 'VOLUME_NOT_FOUND' && err.status === 404
  );
  await assert.rejects(
    () => outline.tensionReview(999999, { volume_id: emptyVolume }, { modelClient }),
    err => err.code === 'BOOK_NOT_FOUND' && err.status === 404
  );
  assert.equal(calls, 0);
});

test('tensionReview：缺 comment / 输出不可解析 → OUTLINE_LLM_PARSE_FAILED 502', async t => {
  const { bookId } = await setup(t);
  const volumeId = addVolume(bookId, '卷一', 1);
  const ch1 = addChapter(bookId, volumeId, { title: '第一章', sortOrder: 1, beat: '醒来' });

  await expectParseFailed(() => outline.tensionReview(
    bookId, { volume_id: volumeId },
    { modelClient: raw(JSON.stringify({ chapter_scores: [{ chapter_id: ch1, tension: 3 }] })) }
  ));
  await expectParseFailed(() => outline.tensionReview(
    bookId, { volume_id: volumeId },
    { modelClient: raw(JSON.stringify({ comment: '   ' })) }
  ));
  await expectParseFailed(() => outline.tensionReview(
    bookId, { volume_id: volumeId },
    { modelClient: raw(JSON.stringify({ comment: 12345 })) }
  ));
  await expectParseFailed(() => outline.tensionReview(
    bookId, { volume_id: volumeId },
    { modelClient: raw('这不是 JSON') }
  ));
});

// ---------------------------------------------------------------------------
// HTTP 层（只走不需要模型的路径：timeline 聚合与两个错误分支）
// ---------------------------------------------------------------------------

test('HTTP：GET /outline/timeline 返回 200 与卷/章/烈度结构', async t => {
  const { bookId } = await setup(t);
  const volA = addVolume(bookId, '卷一', 1, { intro: '灰雁号余波' });
  const ch1 = addChapter(bookId, volA, {
    title: '第一章', sortOrder: 1, beat: '林野在车站醒来',
    content: '林野在废弃车站醒来。', summary: '林野醒来，手里只剩半张地图。',
  });
  const ch2 = addChapter(bookId, volA, { title: '第二章', sortOrder: 2, beat: '登船' });
  const stale = addEvent(bookId, ch1, 'normal');
  addEvent(bookId, ch1, 'high', stale);
  addEvent(bookId, ch2, 'low');

  const http = await listen(createApp());
  t.after(() => http.close());

  const response = await json(http.baseUrl, 'GET', `/api/books/${bookId}/outline/timeline`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.volumes.map(v => v.id), [volA]);
  assert.equal(response.body.volumes[0].title, '卷一');
  assert.deepEqual(response.body.chapters.map(c => c.id), [ch1, ch2]);
  const first = response.body.chapters[0];
  assert.equal(first.volume_id, volA);
  assert.equal(first.title, '第一章');
  assert.equal(first.beat, '林野在车站醒来');
  assert.equal(first.sort_order, 1);
  assert.equal(first.revision, 1);
  assert.equal(first.content_length, '林野在废弃车站醒来。'.length);
  assert.equal(first.has_summary, 1);
  assert.equal(response.body.chapters[1].has_summary, 0);
  assert.deepEqual(response.body.intensity[ch1], { event_count: 1, max_importance: 3 }); // normal 已被取代
  assert.deepEqual(response.body.intensity[ch2], { event_count: 1, max_importance: 1 });

  const missingBook = await json(http.baseUrl, 'GET', '/api/books/999999/outline/timeline');
  assert.equal(missingBook.status, 404);
  assert.equal(missingBook.body.error.code, 'BOOK_NOT_FOUND');
});

test('HTTP：POST /outline/fill-gap 卷不存在 → 404 VOLUME_NOT_FOUND', async t => {
  const { bookId } = await setup(t);
  const http = await listen(createApp());
  t.after(() => http.close());

  // volume_id 校验发生在模型调用之前：这里不可能触达真实 LLM（真触达会是 5xx 而非 404）
  const response = await json(http.baseUrl, 'POST', `/api/books/${bookId}/outline/fill-gap`, { volume_id: 999999 });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'VOLUME_NOT_FOUND');
  assert.ok(String(response.body.error.message).length > 0);
});

test('HTTP：POST /outline/tension-review 空卷 → 400 VOLUME_EMPTY', async t => {
  const { bookId } = await setup(t);
  const emptyVolume = addVolume(bookId, '空卷', 1);
  const http = await listen(createApp());
  t.after(() => http.close());

  const response = await json(http.baseUrl, 'POST', `/api/books/${bookId}/outline/tension-review`, { volume_id: emptyVolume });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VOLUME_EMPTY');
  assert.ok(String(response.body.error.message).length > 0);
});
