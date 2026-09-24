// 作家仓库 · 体检接口契约（/api/style-lab）：
// 不落库的纯查询 / 整章体检默认落库 / 复核接口 / JSONL 导出 / 配置开关默认手动。
// 尤其要钉住「体检是旁路」：没有 key 时返回明确错误，绝不影响其他任何接口。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['体检接口书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const chapterId = db.run(
    'INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)',
    [bookId, '第一章 体检', '这是一段用于体检的章节正文内容。他推开门，雨还在下。'.repeat(20)]
  ).lastInsertRowid;
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { bookId, chapterId, http };
}

function stubDetector(t, payload, status = 200) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    if (!String(url).includes('zhuque')) return orig(url, init);
    calls.push({ url: String(url), init });
    return { ok: status < 300, status, json: async () => payload };
  };
  t.after(() => { global.fetch = orig; });
  return calls;
}

const GOOD_PAYLOAD = {
  softmax_confidence: 0.87,
  labels_ratio: [0.09, 0, 0.91],
  segment_labels: [
    { text: '这是一段被判为疑似 AI 的完整句子，长度足够入库。', label: 2, conf: 0.93, position: '0' },
    { text: '这是另一段被判为人写的句子，同样长度足够入库。', label: 0, conf: 0.18, position: '1' },
  ],
  usage: { total_tokens: 6200 },
};

function setKey() {
  db.run("INSERT INTO settings (key, value) VALUES ('zhuque_api_key', 'sk-test-zhuque-key')");
}

test('配置：默认手动体检、风格层默认开启、无 key 时 api_key_set=false', async t => {
  const { http } = await setup(t);
  const res = await json(http.baseUrl, 'GET', '/api/style-lab/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.config.healthcheck_mode, 'manual', '默认必须是手动（额度有限 + 开发期）');
  assert.equal(res.body.config.style_layer_enabled, true, '风格层默认开启');
  assert.equal(res.body.config.api_key_set, false);
  assert.equal(res.body.config.api_key_masked, '');
  assert.equal(res.body.config.detector, 'zhuque');
  assert.ok(res.body.config.detector_endpoint.startsWith('https://'), '端点应只读可见');
});

test('配置：写入 key 后只回掩码；空串无 clear 标志不洗掉已配置的 key', async t => {
  const { http } = await setup(t);
  const put = await json(http.baseUrl, 'PUT', '/api/style-lab/config', { zhuque_api_key: 'sk-abcdef1234567890' });
  assert.equal(put.status, 200);
  assert.equal(put.body.config.api_key_set, true);
  assert.ok(!JSON.stringify(put.body).includes('sk-abcdef1234567890'), '接口绝不能回明文 key');
  assert.ok(put.body.config.api_key_masked.includes('…'), '应回掩码');

  // 无 clear 标志的空串 → 忽略（防旧版前端/缓存把 key 洗掉）
  await json(http.baseUrl, 'PUT', '/api/style-lab/config', { zhuque_api_key: '' });
  assert.equal((await json(http.baseUrl, 'GET', '/api/style-lab/config')).body.config.api_key_set, true);

  // 带 clear 标志 → 真的清
  await json(http.baseUrl, 'PUT', '/api/style-lab/config', { zhuque_api_key: '', clear_zhuque_api_key: true });
  assert.equal((await json(http.baseUrl, 'GET', '/api/style-lab/config')).body.config.api_key_set, false);
});

test('体检开关：模式写入合法值，非法值回落手动', async t => {
  const { http } = await setup(t);
  const set = await json(http.baseUrl, 'PUT', '/api/style-lab/config', { style_healthcheck_mode: 'auto' });
  assert.equal(set.body.config.healthcheck_mode, 'auto');
  const bad = await json(http.baseUrl, 'PUT', '/api/style-lab/config', { style_healthcheck_mode: 'every-minute' });
  assert.equal(bad.body.config.healthcheck_mode, 'manual', '非法模式必须回落手动，不能变成意外的高频检测');
});

test('无 key：detect 返回可读错误且不落库', async t => {
  const { http } = await setup(t);
  const res = await json(http.baseUrl, 'POST', '/api/style-lab/detect', { text: '一段文本', save: true });
  assert.equal(res.status, 400);
  // 带 code+status 的错误走 app.js 统一信封 { error: { code, message } }
  assert.equal(res.body.error.code, 'ZHUQUE_NO_KEY');
  assert.ok(/未配置朱雀检测密钥/.test(res.body.error.message));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 0);
});

test('detect 不落库（默认）；save=true 才入库', async t => {
  const { bookId, chapterId, http } = await setup(t);
  setKey();
  stubDetector(t, GOOD_PAYLOAD);

  const plain = await json(http.baseUrl, 'POST', '/api/style-lab/detect', { text: '一段足够长的待检测文本内容。' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.overall.conf, 0.87);
  assert.equal(plain.body.segments.length, 2);
  assert.equal(plain.body.saved.inserted, 0, '默认不落库——先看分数不该污染语料');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 0);

  const saved = await json(http.baseUrl, 'POST', '/api/style-lab/detect', {
    text: '一段足够长的待检测文本内容。', save: true, book_id: bookId, chapter_id: chapterId,
  });
  assert.equal(saved.body.saved.inserted, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 2);
  const row = db.get('SELECT * FROM ai_style_samples LIMIT 1');
  assert.equal(row.source, 'paste', '前端粘贴检测的来源标记为 paste');
});

test('整章体检：服务端自取正文、默认落库、记录章节版本快照', async t => {
  const { bookId, chapterId, http } = await setup(t);
  setKey();
  stubDetector(t, GOOD_PAYLOAD);

  const res = await json(http.baseUrl, 'POST', '/api/style-lab/detect-chapter', {
    book_id: bookId, chapter_id: chapterId,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.chapter.id, chapterId);
  assert.ok(res.body.chapter.revision, '应回送检时的章节版本');
  assert.equal(res.body.saved.inserted, 2, '整章体检是错题库主要来源，默认落库');

  const row = db.get('SELECT * FROM ai_style_samples LIMIT 1');
  assert.equal(row.chapter_id, chapterId);
  assert.equal(row.chapter_title_snapshot, '第一章 体检');
  assert.equal(row.source, 'chapter');
  assert.ok(row.chapter_revision, '必须记录送检版本，否则半年后无法复现');
});

test('整章体检：章节不存在 404、正文为空 400（都不发外部请求）', async t => {
  const { bookId, http } = await setup(t);
  setKey();
  const calls = stubDetector(t, GOOD_PAYLOAD);

  const missing = await json(http.baseUrl, 'POST', '/api/style-lab/detect-chapter', { book_id: bookId, chapter_id: 999999 });
  assert.equal(missing.status, 404);

  const emptyId = db.run(
    'INSERT INTO chapters (book_id, title, content) VALUES (?, ?, ?)', [bookId, '空章', '']
  ).lastInsertRowid;
  const empty = await json(http.baseUrl, 'POST', '/api/style-lab/detect-chapter', { book_id: bookId, chapter_id: emptyId });
  assert.equal(empty.status, 400);
  assert.equal(calls.length, 0, '本地就能判定的错误不该消耗检测额度');
});

test('取整章正文（改写工作台）：回全文、不落库、不发外部请求、不存在的章 404', async t => {
  const { bookId, chapterId, http } = await setup(t);
  setKey();
  const calls = stubDetector(t, GOOD_PAYLOAD);

  const res = await json(http.baseUrl, 'GET', `/api/style-lab/chapter-text?book_id=${bookId}&chapter_id=${chapterId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.chapter.id, chapterId);
  assert.equal(res.body.chapter.title, '第一章 体检');
  // 章节列表接口只给 content 前 100 字，工作台要按段落改字，必须拿到全文
  assert.ok(res.body.chapter.content.length > 100, '必须是完整正文而不是预览片段');
  assert.ok(res.body.chapter.content.includes('他推开门，雨还在下。'), '正文内容完整');
  assert.ok(res.body.chapter.revision, '带上版本，便于前端判断草稿是否套用得上');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_style_samples').n, 0, '取正文不落库');
  assert.equal(calls.length, 0, '取正文是纯读，不该消耗检测额度');

  const missing = await json(http.baseUrl, 'GET', `/api/style-lab/chapter-text?book_id=${bookId}&chapter_id=999999`);
  assert.equal(missing.status, 404);
  const bad = await json(http.baseUrl, 'GET', '/api/style-lab/chapter-text?book_id=abc');
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0);
});

test('错题库：列表 / 单条 / 复核 / 删除 / 统计 全链路', async t => {
  const { bookId, chapterId, http } = await setup(t);
  setKey();
  stubDetector(t, GOOD_PAYLOAD);
  await json(http.baseUrl, 'POST', '/api/style-lab/detect-chapter', { book_id: bookId, chapter_id: chapterId });

  const list = await json(http.baseUrl, 'GET', `/api/style-lab/samples?book_id=${bookId}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  assert.equal(list.body.samples[0].verdict, 'pending');

  const id = list.body.samples[0].id;
  const one = await json(http.baseUrl, 'GET', `/api/style-lab/samples/${id}`);
  assert.equal(one.body.sample.id, id);

  const reviewed = await json(http.baseUrl, 'PATCH', `/api/style-lab/samples/${id}`, {
    verdict: 'ai', reviewNote: '这句确实是我写不出来的味道', tags: ['套话'],
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.sample.verdict, 'ai');
  assert.equal(reviewed.body.sample.reviewNote, '这句确实是我写不出来的味道');
  assert.deepEqual(reviewed.body.sample.tags, ['套话']);

  const stats = await json(http.baseUrl, 'GET', `/api/style-lab/stats?book_id=${bookId}`);
  assert.equal(stats.body.stats.total, 2);
  assert.equal(stats.body.stats.byVerdict.ai, 1);

  const del = await json(http.baseUrl, 'DELETE', `/api/style-lab/samples/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await json(http.baseUrl, 'GET', `/api/style-lab/samples?book_id=${bookId}`)).body.total, 1);

  const gone = await json(http.baseUrl, 'GET', `/api/style-lab/samples/${id}`);
  assert.equal(gone.status, 404);
});

test('导出：默认只给已复核语料，JSONL 每行一条', async t => {
  const { bookId, chapterId, http } = await setup(t);
  setKey();
  stubDetector(t, GOOD_PAYLOAD);
  await json(http.baseUrl, 'POST', '/api/style-lab/detect-chapter', { book_id: bookId, chapter_id: chapterId });
  const list = await json(http.baseUrl, 'GET', `/api/style-lab/samples?book_id=${bookId}`);
  await json(http.baseUrl, 'PATCH', `/api/style-lab/samples/${list.body.samples[0].id}`, { verdict: 'ai' });

  // 默认导出：只有已复核的那条
  const res = await fetch(`${http.baseUrl}/api/style-lab/samples-export`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('ndjson'), 'JSONL 导出用 ndjson 类型');
  const lines = (await res.text()).trim().split('\n');
  assert.equal(lines.length, 1, '未复核语料不得进导出口（防污染）');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.verdict, 'ai');
  assert.ok(Array.isArray(parsed.labelsRatio));

  // include_pending=true 才带待复核
  const withPending = await json(http.baseUrl, 'GET', '/api/style-lab/samples-export?include_pending=true&format=json');
  assert.equal(withPending.body.count, 2);
});

test('连通性自测：成功回分数，失败错误可读且脱敏', async t => {
  const { http } = await setup(t);
  // 未配 key → 400 可读错误
  const noKey = await json(http.baseUrl, 'POST', '/api/style-lab/test');
  assert.equal(noKey.status, 400);
  assert.ok(/未配置朱雀检测密钥/.test(noKey.body.error));

  setKey();
  const okStub = stubDetector(t, GOOD_PAYLOAD);
  const ok = await json(http.baseUrl, 'POST', '/api/style-lab/test');
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.conf, 0.87);
  assert.equal(okStub.length, 1);

  // 上游 401 且回显 key → 错误信息必须已脱敏
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).includes('zhuque')) return origFetch(url, init);
    return { ok: false, status: 401, json: async () => ({ error: 'invalid key: sk-test-zhuque-key' }) };
  };
  const bad = await json(http.baseUrl, 'POST', '/api/style-lab/test');
  global.fetch = origFetch;
  assert.equal(bad.status, 502);
  assert.ok(!bad.body.error.includes('sk-test-zhuque-key'), '接口层也绝不能漏明文 key');
});

test('风格包接口：列出可用卡、报出生效卡链，并支持换卡与预览', async t => {
  const { bookId, http } = await setup(t);
  const res = await json(http.baseUrl, 'GET', `/api/style-lab/packs?book_id=${bookId}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.packs.length >= 1, '至少应有内置通用卡');
  assert.equal(res.body.effective.source, 'basic', '未绑定时生效的是内置卡');
  assert.ok(res.body.effective.main_id, '应报出生效主卡 id');
  assert.deepEqual(res.body.effective.chain_ids, [res.body.effective.main_id], '单卡时链只有主卡');
  assert.ok(res.body.packs[0].stats, '列表应带规则/范文计数（UI 显示用）');

  // 换卡：建一张卡 → 绑为主卡 + 内置卡为辅卡
  const created = await json(http.baseUrl, 'POST', '/api/style-lab/packs', {
    name: '接口测试卡', persona: '你是接口测试卡。', profile: { stance: '短。' },
  });
  assert.equal(created.status, 201);
  const cardId = created.body.pack.id;
  await json(http.baseUrl, 'POST', `/api/style-lab/packs/${cardId}/rules`, {
    title: '接口规则', rule: '接口规则正文。', severity: 'must', category: '总纲',
  });
  const basicId = res.body.effective.main_id;
  const bound = await json(http.baseUrl, 'PUT', `/api/style-lab/books/${bookId}/cards`, {
    bindings: [{ packId: cardId, role: 'main' }, { packId: basicId, role: 'aux', sortOrder: 0 }],
  });
  assert.equal(bound.status, 200);
  assert.deepEqual(bound.body.effective.map(p => p.name), ['接口测试卡', '去 AI 味·通用']);

  // 预览：与写作时同源，能看到两张卡的内容都进来了
  const preview = await json(http.baseUrl, 'GET', `/api/style-lab/packs-preview?book_id=${bookId}`);
  assert.equal(preview.status, 200);
  assert.ok(preview.body.text.includes('你是接口测试卡。'), '主卡人设应出现在预览里');
  assert.ok(preview.body.text.includes('接口规则正文。'), '主卡规则应出现在预览里');
  assert.ok(preview.body.text.includes('你是一位把「克制」'), '辅卡人设应出现在预览里');
  assert.ok(preview.body.hanzi > 0 && preview.body.chars >= preview.body.hanzi, '预览应报出字数');
  // 契约是「UI 看到的预算 = provider 实际用的预算」，不是某个具体数字：
  // 数字会随委托方要求变动（10000 → 25000 汉字），同源才是要不变量。
  assert.equal(
    preview.body.budget_chars,
    require('../../server/context/providers/style').STYLE_BUDGET_CHARS,
    '预算应暴露给 UI，且与 provider 同源（容 25000 汉字 + 实测结构余量）'
  );

  // 单卡详情：编辑器一次拿全（人设 + 规则 + 范文）
  const detail = await json(http.baseUrl, 'GET', `/api/style-lab/packs/${cardId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.pack.name, '接口测试卡');
  assert.equal(detail.body.rules.length, 1);
  assert.deepEqual(detail.body.samples, []);
  assert.equal(detail.body.stats.must, 1);

  // 删卡：绑定级联清理，书回落到内置卡
  const del = await json(http.baseUrl, 'DELETE', `/api/style-lab/packs/${cardId}`);
  assert.equal(del.status, 200);
  const after = await json(http.baseUrl, 'GET', `/api/style-lab/packs?book_id=${bookId}`);
  assert.equal(after.body.effective.source, 'basic', '删卡后应回落到内置卡');
});

test('删范文必须走 pack 域路由：顶层 DELETE /samples/:id 被标本路由遮蔽，不能用于卡片范文', async t => {
  const { bookId, http } = await setup(t);
  // 错题库「标本」先行占用一个 id（与卡片范文分属两张表；新库两表 id 序列都从 1 起，必然撞号）
  const chapterId = db.get('SELECT id FROM chapters WHERE book_id = ?', [bookId]).id;
  const specimenId = db.run(
    "INSERT INTO ai_style_samples (book_id, chapter_id, source, text, text_hash, verdict) VALUES (?, ?, 'chapter', '标本正文', 'hash-test', 'pending')",
    [bookId, chapterId]
  ).lastInsertRowid;
  const created = await json(http.baseUrl, 'POST', '/api/style-lab/packs', {
    name: '范文删除卡', persona: '测。', profile: {},
  });
  const cardId = created.body.pack.id;
  const added = await json(http.baseUrl, 'POST', `/api/style-lab/packs/${cardId}/samples`, {
    title: '范文A', text: '范文正文一。'.repeat(10), source: 'distill/测试/作品#0+50',
  });
  assert.equal(added.status, 201);
  const sampleId = added.body.sample.id;

  // 正确路由（pack 域）：范文行真删，标本行毫发无损
  const del = await json(http.baseUrl, 'DELETE', `/api/style-lab/packs/${cardId}/samples/${sampleId}`);
  assert.equal(del.status, 200);
  assert.ok(!db.get('SELECT id FROM style_samples WHERE id = ?', [sampleId]), '范文行已删');
  assert.ok(db.get('SELECT id FROM ai_style_samples WHERE id = ?', [specimenId]), '标本行完好');
  const cross = await json(http.baseUrl, 'DELETE', `/api/style-lab/packs/${cardId}/samples/${specimenId}`);
  assert.equal(cross.status, 404, 'pack 域路由不得删到别的表/别的卡');

  // 遮蔽语义钉子：顶层 DELETE /samples/:id 永远打到处存错题库标本的 handler——
  // 新库两表 id 都从 1 起，sampleId=1 已被上一步删掉而 specimenId=1 还在，
  // 此时顶层删除会「成功」地删掉标本行：这正是撞 id 误删错题库数据的事故形态。
  const added2 = await json(http.baseUrl, 'POST', `/api/style-lab/packs/${cardId}/samples`, {
    title: '范文B', text: '范文正文二。'.repeat(10), source: 'distill/测试/作品#500+50',
  });
  const sampleId2 = added2.body.sample.id;
  const shadow = await json(http.baseUrl, 'DELETE', `/api/style-lab/samples/${sampleId2}`);
  assert.ok(db.get('SELECT id FROM style_samples WHERE id = ?', [sampleId2]), '顶层删除删不到范文行');
  if (sampleId2 === specimenId) {
    assert.equal(shadow.status, 200, '撞 id 时标本被误删（已记录的事故形态）');
    assert.ok(!db.get('SELECT id FROM ai_style_samples WHERE id = ?', [specimenId]));
  } else {
    assert.equal(shadow.status, 404);
    assert.equal(shadow.body.error, '标本不存在');
  }
});
