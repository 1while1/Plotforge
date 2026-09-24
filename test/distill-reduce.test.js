// L3 树状 reduce 的钉子测试（tools/distill/reduce.js）——全程 stub 掉 LLM（零真实网络）。
// 钉的是四条会静默丢数据的失效率：
//  ① 支撑计数必须由**代码**按 id 回溯算（模型自报计数不可信，这正是闸门 3 存在的理由）；
//  ② 输入超预算先切批、输出被截断要拆分重算（设计 §3.3 的静默截断防护）；
//  ③ 模型没覆盖的 id 一律登记（uncovered-by-model），不许消失；
//  ④ 调用失败时该节点全部 id 登记（reduce-call-failed），失败不等于丢数据。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reduce = require('../tools/distill/reduce');

/** 造一条观测（维度默认「标点」，countCheck 默认 ok）。 */
function obs(i, over = {}) {
  return {
    dim: over.dim || '标点', trait: over.trait || `特质${i}`, marker: over.marker === undefined ? `m${i}` : over.marker,
    evidence: over.evidence || `证据${i}`, count: 2,
    work: over.work || `书${i % 2}`, chunkIndex: over.chunkIndex === undefined ? i : over.chunkIndex,
    countCheck: over.countCheck || { status: 'ok' },
  };
}

const chatResponse = (content, finish = 'stop', usage = { prompt_tokens: 100, completion_tokens: 50 }) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }),
});

/** 剧本化 fetch：按调用序取 responder，耗尽即抛错（意外的额外调用本身是断言失败）。 */
function stubFetch(responders) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const r = responders.shift();
    if (!r) throw new Error('stub exhausted: 意料之外的 LLM 调用');
    return typeof r === 'function' ? r(calls.length - 1, init) : r;
  };
  return { calls, impl };
}

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reduce-'));
}

// ---------- 纯函数 ----------

test('leafBatches：只按维度切、逐批不超限、条目不丢不重', () => {
  const items = [];
  for (let i = 0; i < 12; i++) items.push(obs(i, { dim: i % 3 === 0 ? '词汇' : '标点' }));
  const b = reduce.leafBatches(items, { maxItems: 5 });
  assert.ok(b.every((x) => x.items.length <= 5));
  assert.equal(new Set(b.map((x) => x.dim)).size, 2);
  const ids = b.flatMap((x) => x.items.map((it) => it.trait));
  assert.equal(ids.length, 12, '切批不得丢条目');
  assert.equal(new Set(ids).size, 12);
  // 每批必须同维度（跨维度合并会污染维度白名单）
  assert.ok(b.every((x) => x.items.every((it) => it.dim === x.dim)));
});

test('leafBatches：token 预算先于条数生效', () => {
  const items = Array.from({ length: 10 }, (_, i) => obs(i, { trait: '很长的特质描述'.repeat(40) }));
  const b = reduce.leafBatches(items, { maxItems: 150, maxTokens: 500 });
  assert.ok(b.length > 1, '长条目要按 token 预算切批');
  assert.equal(b.flatMap((x) => x.items).length, 10);
});

test('validateMerge：未知 id / 维度越界 / 超长 trait 分别计数并剔除，覆盖率按申报算', () => {
  const allowed = new Set(['i0', 'i1', 'i2', 'i3']);
  const parsed = {
    traits: [
      { trait: '合法', dim: '标点', ids: ['i0'] },
      { trait: '维度越界', dim: '文风', ids: ['i1'] },          // 不在七个白名单维度里
      { trait: 'x'.repeat(200), dim: '标点', ids: ['i2'] },
      { trait: '幽灵', dim: '标点', ids: ['i9'] },              // 不属于本节点
      { trait: '串维度', dim: '词汇', ids: ['i1'] },            // id 属于别的维度
    ],
    dropped: [{ ids: ['i3'], reason: 'vague' }],
  };
  const v = reduce.validateMerge(parsed, allowed, (id) => (id === 'i1' ? '标点' : '标点'));
  assert.equal(v.traits.length, 1);
  assert.equal(v.problems.dimMismatch, 1, '「文风」不在白名单');
  assert.equal(v.problems.traitTooLong, 1);
  assert.equal(v.problems.unknownId, 2, '幽灵 id + 串维度 id');
  // 被剔除的条目（i1 维度越界、i2 超长）既不在 traits 也不在 dropped → 必须归 uncovered
  assert.deepEqual([...v.uncovered].sort(), ['i1', 'i2']);
  assert.equal(v.coverage, 0.5, '只有主动申报过的 id 才算覆盖');
});

test('validateMerge：未申报的 id 归 uncovered 且计入覆盖率', () => {
  const v = reduce.validateMerge({ traits: [{ trait: 'x', dim: '标点', ids: ['i0'] }] }, new Set(['i0', 'i1', 'i2', 'i3']), () => '标点');
  assert.deepEqual(v.uncovered.sort(), ['i1', 'i2', 'i3']);
  assert.equal(v.coverage, 0.25);
});

// ---------- 端到端（stub LLM） ----------

test('reduceAuthor：支撑由代码按 id 回溯算（模型只报 ids，不报计数）', async () => {
  // 4 条观测散在 2 本书 3 个块上；模型把 i0/i1 并为一条、i2/i3 并为一条
  const items = [
    obs(0, { work: '甲书', chunkIndex: 1 }), obs(1, { work: '甲书', chunkIndex: 5 }),
    obs(2, { work: '乙书', chunkIndex: 2 }), obs(3, { work: '乙书', chunkIndex: 2 }),
  ];
  const stub = stubFetch([
    chatResponse(JSON.stringify({
      traits: [
        { trait: '合并A', dim: '标点', ids: ['i0', 'i1'], markers: ['m0', 'm1'] },
        { trait: '合并B', dim: '标点', ids: ['i2', 'i3'], markers: ['m2'] },
      ],
      dropped: [],
    })),
  ]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: () => {},
    opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1', 'sk-test-k2'], provider: 'agnes', cacheDir: null, concurrency: 1 },
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(r.clusters.length, 2);
  const a = r.clusters.find((c) => c.trait === '合并A');
  assert.deepEqual(a.support, { works: 1, blocks: 2, chars: 2 * 8000, items: 2, advisoryBlocks: 0 }, '2 条落在 1 本书 2 个块上');
  assert.deepEqual(a.markerHist.map((m) => m.marker).sort(), ['m0', 'm1']);
  const b = r.clusters.find((c) => c.trait === '合并B');
  assert.equal(b.support.blocks, 1, '同块两条只算一块');
  assert.equal(b.support.items, 2);
  // usage 汇总要能对账
  assert.deepEqual(r.usage, { input: 100, output: 50 });
});

test('reduceAuthor：缓存命中时零 LLM 调用（重跑免费；缓存里 ids 是数组必须还原成 Set）', async () => {
  const items = [obs(0), obs(1)];
  const cacheDir = tmpCacheDir();
  const payload = JSON.stringify({ traits: [{ trait: '合并', dim: '标点', ids: ['i0', 'i1'], markers: [] }], dropped: [] });
  const s1 = stubFetch([chatResponse(payload)]);
  const r1 = await reduce.reduceAuthor({ items, author: '测试甲', opts: { fetchImpl: s1.impl, apiKeys: ['sk-test-k1'], cacheDir, concurrency: 1 } });
  assert.equal(s1.calls.length, 1);
  const s2 = stubFetch([]);   // 剧本为空：再有任何调用都算失败
  const r2 = await reduce.reduceAuthor({ items, author: '测试甲', opts: { fetchImpl: s2.impl, apiKeys: ['sk-test-k1'], cacheDir, concurrency: 1 } });
  assert.equal(s2.calls.length, 0, '缓存命中不得再调 LLM');
  assert.equal(r2.clusters.length, r1.clusters.length);
  assert.equal(r2.clusters[0].support.blocks, 2, '缓存还原后支撑统计仍要对');
});

test('reduceAuthor：输出被截断 → 一分为二重算，条目不丢', async () => {
  const items = [obs(0), obs(1), obs(2), obs(3)];
  const stub = stubFetch([
    chatResponse('', 'length'),                                  // 整批：截断
    chatResponse(JSON.stringify({ traits: [{ trait: '半A', dim: '标点', ids: ['i0', 'i1'] }], dropped: [] })),
    chatResponse(JSON.stringify({ traits: [{ trait: '半B', dim: '标点', ids: ['i2', 'i3'] }], dropped: [] })),
  ]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1 },
  });
  assert.equal(stub.calls.length, 3, '1 次截断 + 2 次拆分重算');
  assert.equal(r.clusters.length, 2);
  assert.equal(r.clusters.reduce((s, c) => s + c.support.items, 0), 4, '拆分后条目总数不变');
  assert.equal(r.problems.uncovered, 0);
});

test('reduceAuthor：覆盖率不足先重试；重试仍不足则把未覆盖 id 登记进 dropped', async () => {
  const items = [obs(0), obs(1), obs(2), obs(3)];
  const partial = JSON.stringify({ traits: [{ trait: '只覆盖一条', dim: '标点', ids: ['i0'] }], dropped: [] });
  const stub = stubFetch([chatResponse(partial), chatResponse(partial)]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: () => {},
    opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1, coverageRetry: 1, minCoverage: 0.8 },
  });
  assert.equal(stub.calls.length, 2, '低覆盖要重试一次');
  const uncovered = r.dropped.filter((d) => d.reason === 'uncovered-by-model');
  assert.equal(uncovered.length, 1);
  assert.deepEqual(uncovered[0].ids.sort(), ['i1', 'i2', 'i3'], '未覆盖的 id 必须登记，不许消失');
});

test('reduceAuthor：纠正式重试——第二次调用把未申报的 id 点名写进提示词', async () => {
  const items = [obs(0), obs(1), obs(2), obs(3)];
  const partial = JSON.stringify({ traits: [{ trait: '只覆盖一条', dim: '标点', ids: ['i0'] }], dropped: [] });
  const full = JSON.stringify({ traits: [{ trait: '全覆盖', dim: '标点', ids: ['i0', 'i1', 'i2', 'i3'] }], dropped: [] });
  const stub = stubFetch([chatResponse(partial), chatResponse(full)]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: () => {},
    opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1, coverageRetry: 1, minCoverage: 0.8 },
  });
  assert.equal(stub.calls.length, 2);
  const second = stub.calls[1].body.messages[1].content;
  assert.ok(second.includes('上次输出的问题'), '重试必须带纠正文段');
  for (const id of ['i1', 'i2', 'i3']) assert.ok(second.includes(id), `纠正文段须点名 ${id}`);
  assert.equal(r.problems.uncovered, 0, '纠正后应无未覆盖 id');
  assert.equal(r.clusters.length, 1);
});

test('reduceAuthor：调用失败时该节点全部 id 登记为 reduce-call-failed（失败≠丢数据）', async () => {
  const items = [obs(0), obs(1)];
  const stub = stubFetch([
    { ok: false, status: 400, text: async () => 'bad request' },
  ]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: () => {},
    opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1, retry: 0 },
  });
  assert.equal(r.clusters.length, 0);
  const failed = r.dropped.filter((d) => d.reason === 'reduce-call-failed');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].ids.sort(), ['i0', 'i1']);
  assert.equal(r.levels[0].failed, 1);
});

test('reduceAuthor：冲突簇原样保留（conflict 标记 + variants），不静默取一', async () => {
  const items = [obs(0), obs(1)];
  const payload = JSON.stringify({
    traits: [{ trait: '省略号使用：说法冲突', dim: '标点', ids: ['i0', 'i1'], markers: ['……'], conflict: true, variants: ['大量使用省略号', '几乎不用省略号'] }],
    dropped: [],
  });
  const stub = stubFetch([chatResponse(payload)]);
  const r = await reduce.reduceAuthor({ items, author: '测试甲', opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1 } });
  assert.equal(r.clusters[0].conflict, true);
  assert.equal(r.clusters[0].variants.length, 2);
});

test('finalizeClusters：禁用书的块不计支撑（约束 ①），但条目仍留在簇里并可被报告消费', () => {
  const items = [
    obs(0, { work: '蔽霄', chunkIndex: 1 }), obs(1, { work: '蔽霄', chunkIndex: 2 }),
    obs(2, { work: '太虚古界', chunkIndex: 3 }),
  ];
  const { withIds, idToItem } = reduce.assignIds(items);
  const node = { nodeKey: 'n1', level: 0, dim: '标点', ids: new Set(withIds.map((i) => i.id)),
    traits: [{ trait: '合并', dim: '标点', ids: withIds.map((i) => i.id), markers: [] }], dropped: [] };
  const all = reduce.finalizeClusters([node], idToItem);
  assert.equal(all[0].support.blocks, 3);
  const gated = reduce.finalizeClusters([node], idToItem, { disabledWorks: new Set(['蔽霄']) });
  assert.equal(gated[0].support.blocks, 1, '蔽霄的两个块要剔除');
  assert.equal(gated[0].support.works, 1);
  assert.equal(gated[0].support.advisoryBlocks, 2, '剔除要留痕');
  assert.equal(gated[0].support.items, 3, '条目本身仍在簇里（证据链不断）');
});

test('validateMerge：掩码痕迹与比例断言两条卫生规则判死条目，但 id 去向仍要申报', () => {
  const allowed = new Set(['i0', 'i1', 'i2', 'i3']);
  const parsed = {
    traits: [
      { trait: '所有专名统一以〔人名〕占位符替代', dim: '词汇', ids: ['i0'] },
      { trait: '口语俗语占比≥40%', dim: '词汇', ids: ['i1'] },
      { trait: '爱用省略号收尾', dim: '标点', ids: ['i2'] },
    ],
    dropped: [],
  };
  const v = reduce.validateMerge(parsed, allowed, (id) => (id === 'i2' ? '标点' : '词汇'));
  assert.equal(v.traits.length, 1, '两条卫生规则各判死一条，剩一条合法');
  assert.equal(v.problems.maskArtifact, 1);
  assert.equal(v.problems.quantClaim, 1);
  const art = v.dropped.find((x) => x.reason === 'mask-artifact');
  assert.deepEqual(art.ids, ['i0'], '判死也要申报 id，否则会掉进 uncovered 变成静默丢失');
  assert.deepEqual(v.uncovered, ['i3'], '只有真正没申报的 id 才算未覆盖');
});

test('validateMerge：id 写法容忍（12 / #12 / id=12 都当 i12），但编造的新号仍算未知', () => {
  const allowed = new Set(['i0', 'i12']);
  assert.equal(reduce.normalizeId('12'), 'i12');
  assert.equal(reduce.normalizeId('#12'), 'i12');
  assert.equal(reduce.normalizeId('id=12'), 'i12');
  assert.equal(reduce.normalizeId('i12'), 'i12');
  const v = reduce.validateMerge({ traits: [{ trait: 'x', dim: '标点', ids: ['12', '777'] }] }, allowed, () => '标点');
  assert.equal(v.traits[0].ids[0], 'i12');
  assert.equal(v.problems.unknownId, 1, '777 不存在');
});

test('validateMerge：markers 上限 MARKER_CAP 且掩码措辞的 marker 直接剔除', () => {
  const parsed = { traits: [{ trait: 'x', dim: '标点', ids: ['i0'],
    markers: ['a', 'b', 'c', 'd', 'e', 'f', '〔人名〕'] }] };
  const v = reduce.validateMerge(parsed, new Set(['i0']), () => '标点');
  assert.equal(v.traits[0].markers.length, reduce.MARKER_CAP);
  assert.ok(!v.traits[0].markers.includes('〔人名〕'));
});

test('reduceAuthor：叶层每批各一次调用，不得按扇入把多个叶批合成一次（首轮实跑踩过的坑）', async () => {
  // 300 条、单维度、maxItems=150 → 2 个叶批 → 必须恰好 2 次调用
  const items = [];
  for (let i = 0; i < 300; i++) items.push(obs(i, { work: '书' + (i % 3) }));
  const idsOf = (n) => Array.from({ length: n }).map((_, i) => `i${i}`);
  const stub = stubFetch([
    () => chatResponse(JSON.stringify({ traits: [{ trait: 'A', dim: '标点', ids: idsOf(150) }], dropped: [] })),
    () => chatResponse(JSON.stringify({ traits: [{ trait: 'B', dim: '标点', ids: idsOf(300).slice(150) }], dropped: [] })),
    () => chatResponse(JSON.stringify({ traits: [{ trait: 'AB', dim: '标点', ids: idsOf(300) }], dropped: [] })),
  ]);
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: () => {},
    opts: { fetchImpl: stub.impl, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1 },
  });
  assert.equal(stub.calls.length, 3, '两个叶批各一次 + 上一层的 1 次合并（扇入只作用于合并后的节点）');
  assert.equal(r.levels[0].calls, 2, '叶层：每批一次调用');
  assert.equal(r.levels[1].calls, 1, '上层：2 个节点按扇入合成一次');
  assert.equal(r.clusters.length, 1);
  assert.equal(r.failedCalls, 0);
  assert.equal(r.clusters.reduce((s, c) => s + c.support.items, 0), 300);
  // 输入 token 估算必须真的在预算内（否则说明批次切分失效）
  for (const call of stub.calls) {
    const prompt = call.body.messages[1].content;
    assert.ok(reduce.estimateTokens(prompt) <= reduce.NODE_MAX_TOKENS_IN, '单次输入不得超预算');
  }
});

test('SYSTEM_PROMPT：合并契约四条必须在（同维度/申报 id 去向/冲突不取一/禁裸引号）', () => {
  const s = reduce.SYSTEM_PROMPT;
  for (const kw of ['同一维度内', 'dropped', 'conflict', '未转义的双引号', '禁止情节摘要']) {
    assert.ok(s.includes(kw), `SYSTEM_PROMPT 须含「${kw}」`);
  }
  assert.ok(s.includes('vocabulary') === false, '不该再教英文维度标签');
});

test('SYSTEM_PROMPT：冲突判定收窄（只有互相否定才算）+ 一条 trait 只说一件事', () => {
  const s = reduce.SYSTEM_PROMPT;
  // 2026-09-13 实测：溪上老翁 3 个簇全被标 conflict（variants 实为互补的不同侧面），
  // L5 按设计把冲突簇全部排除 → 整张卡 0 条规则、258 万字语料的产出被丢掉。
  assert.ok(s.includes('真正的互相否定'), '冲突定义必须是「互相否定」');
  assert.ok(s.includes('不同侧面并存不是冲突'), '要明确写出「不同侧面不是冲突」这一反例');
  assert.ok(s.includes('一条 trait 只写一个可证伪的说法'), '禁止把多个侧面塞进一条');
});

test('缓存键含提示词版本：改了 SYSTEM_PROMPT 必须 +1，否则旧缓存会把改动吃掉', async () => {
  const items = [obs(0), obs(1)];
  const cacheDir = tmpCacheDir();
  const payload = JSON.stringify({ traits: [{ trait: '合并', dim: '标点', ids: ['i0', 'i1'], markers: [] }], dropped: [] });
  const s1 = stubFetch([chatResponse(payload)]);
  await reduce.reduceAuthor({ items, author: '测试甲', opts: { fetchImpl: s1.impl, apiKeys: ['sk-test-k1'], cacheDir, concurrency: 1 } });
  const files = fs.readdirSync(cacheDir);
  assert.equal(files.length, 1, '一次叶层调用 = 一个缓存文件');
  // 缓存文件名 = sha(PROMPT_VERSION|层|维度|ids)：版本变了文件名必然不同，旧缓存自然失效
  const crypto = require('crypto');
  const expect = (pv) => crypto.createHash('sha256').update(`${pv}|0|标点|i0,i1`).digest('hex') + '.json';
  assert.ok(files.includes(expect(reduce.PROMPT_VERSION)), '缓存键必须含当前 PROMPT_VERSION');
  assert.ok(!files.includes(expect('v1-旧版本')), '换个版本号就不该命中（防「改了提示词却拿旧结果」）');
});

test('reduceAuthor：上层节点输入超预算 → 一分为二重算，不丢数据（白石「0 簇」事故回归）', async () => {
  // 事故（2026-09-13 实测）：8,287 条观测跑到 L1/L2，节点输入超 25000 token 直接抛
  // overBudget(nonRetryable)，当时**没有上层切批**——6 次调用失败 → 顶层 0 簇，整轮 L3 白跑。
  // 这里把输入预算压到 300 token：叶层每批 1 条（≈90 token）能过，上层 8 个子节点必然超，
  // 断言它一路拆到预算内，而不是整节点失败。
  const items = Array.from({ length: 8 }, (_, i) => obs(i, { trait: '这是一条足够长的风格观测条目用来把提示词撑到预算附近'.repeat(2) + i }));
  // 每次调用都按「输入里出现的 id」原样申报，模拟一个好模型
  const responder = (idx, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1].content;
    const ids = [...new Set(user.match(/i\d+/g) || [])];
    const dims = [...new Set((user.match(/维度[:：]?\s*([^\n｜]+)/g) || []).map((s) => s.replace(/.*[:：]\s*/, '').trim()))];
    const payload = JSON.stringify({
      traits: [{ trait: '合并后的观测', dim: dims[0] || '标点', ids: ids, markers: [], conflict: false, variants: [] }],
      dropped: [],
    });
    return chatResponse(payload);
  };
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    return responder(calls.length, init);
  };
  const logs = [];
  const r = await reduce.reduceAuthor({
    items, author: '测试甲', log: (m) => logs.push(m),
    opts: { fetchImpl: stub, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1, maxInputTokens: 300 },
  });
  assert.ok(logs.some((m) => m.includes('输入超预算')), `应走「超预算 → 拆分」路径，实得日志：${logs.join(' | ')}`);
  assert.equal(r.failedCalls || 0, 0, '拆分之后不该还有失败调用');
  // 观测的 id 由 reduce.assignIds 统一编号（obs 里不带 id 字段）
  const allIds = new Set(items.map((_, i) => 'i' + i));
  const kept = new Set();
  for (const c of r.clusters) for (const id of (c.items || []).map((x) => x.id)) kept.add(id);
  for (const d of r.dropped) for (const id of (d.ids || [])) kept.add(id);
  // 覆盖：所有 id 要么在簇里、要么在 dropped 里（不许因拆分消失）
  const missing = [...allIds].filter((id) => !kept.has(id));
  assert.deepEqual(missing, [], `拆分不得让 id 消失，缺：${missing.join(',')}`);
});

// ---------- 2026-09-13 修的两处「整轮 0 簇」成因（白石 19:20 / 青崖 20:43 各白跑一次） ----------

test('splitVerdict：预算刀与截断刀各自计数（预算切过 2 刀后，截断仍可再切）', () => {
  const budgetErr = { overBudget: true };
  const truncErr = { truncated: true };
  const netErr = new Error('fetch failed');
  // 老实现共用一个 depth：预算切过 2 刀后再遇截断，depth≥MAX_SPLIT_DEPTH → 不切 → 整层 0 节点 → 0 簇。
  // 新实现：预算刀看 budgetDepth、截断刀看 depth。
  const v1 = reduce.splitVerdict(truncErr, 1, 6, true);
  assert.equal(v1.canSplit, true, '预算已经切了 6 刀，截断刀自己还有额度');
  assert.equal(v1.nextDepth, 2, '只增截断计数');
  assert.equal(v1.nextBudgetDepth, 6, '不增预算计数');
  const v2 = reduce.splitVerdict(budgetErr, 2, 1, true);
  assert.equal(v2.canSplit, true, '截断切了 2 刀，预算刀自己还有额度');
  assert.equal(v2.nextDepth, 2);
  assert.equal(v2.nextBudgetDepth, 2);
  // 各自的封顶仍然生效
  assert.equal(reduce.splitVerdict(truncErr, 2, 0, true).canSplit, false, '截断刀上限 2');
  assert.equal(reduce.splitVerdict(budgetErr, 0, 6, true).canSplit, false, '预算刀上限 6');
  // 不可切的情况：不是这两种错误、或已经切不动（单条观测）
  assert.equal(reduce.splitVerdict(netErr, 0, 0, true).canSplit, false, '网络错误不许靠拆分掩盖');
  assert.equal(reduce.splitVerdict(truncErr, 0, 0, false).canSplit, false, '单条观测切不动');
});

test('reduceTree 降级：整组失败改用输入节点（条目不丢），不再登记为 reduce-call-failed', async () => {
  // 叶层（2 个维度各 1 批）成功；上层那 1 次调用永久失败 → 该组降级为它的 2 个输入节点
  const items = [obs(0, { dim: '标点' }), obs(1, { dim: '标点' }), obs(2, { dim: '词汇' }), obs(3, { dim: '词汇' })];
  const leafOk = (i, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1].content;
    // 叶层提示词的条目行长这样：`- id=i0 ｜ 标点 ｜ marker=m0 ｜ 特质0 ｜ count=2`
    // （维度就写在行里，**没有**「维度：」前缀——按前缀抓会抓到空，dim 落成默认值，
    //  trait 被 validateMerge 判 dimMismatch 丢掉，于是这条测试根本走不到降级路径）
    const dims = [...new Set([...user.matchAll(/id=(\S+) ｜ ([^｜]+) ｜/g)].map((m) => m[2].trim()))];
    const traits = dims.map((dim) => ({
      trait: `叶层观测·${dim}`, dim: dim, markers: [], conflict: false, variants: [],
      ids: [...new Set([...user.matchAll(/id=(\S+) ｜ ([^｜]+) ｜/g)]
        .filter((m) => m[2].trim() === dim).map((m) => m[1]))],
    }));
    return chatResponse(JSON.stringify({ traits: traits, dropped: [] }));
  };
  let n = 0;
  const stub = async (url, init) => {
    n++;
    if (n <= 2) return leafOk(n, init);            // 两个叶批各一次调用
    const e = new Error('StepFun content 为空且 finish_reason=length：max_tokens=32000 预算被思考耗尽');
    e.nonRetryable = true; e.truncated = true;      // 上层永久失败（真实事故的报错形态）
    throw e;
  };
  const logs = [];
  const r = await reduce.reduceAuthor({
    items, author: '测试乙', log: (m) => logs.push(m),
    opts: { fetchImpl: stub, apiKeys: ['sk-test-k1'], cacheDir: null, concurrency: 1 },
  });
  assert.ok(r.clusters.length > 0, '降级后必须仍有簇（0 簇 = 作者被丢掉）');
  assert.equal(r.levels[1].degradedGroups, 1, '降级组数要写进该层统计（summary.reduce.levels）');
  assert.equal(r.degradedAt, null, '单组降级不是整层降级：degradedAt 只记「整层空」那种');
  assert.ok(logs.some((m) => m.includes('降级')), `降级必须留日志，实得：${logs.join(' | ')}`);
  assert.ok(!r.dropped.some((d) => d.reason === 'reduce-call-failed'),
    '降级成功时不得再登记 reduce-call-failed（否则同一批 id 既在簇里又被记为「失败丢数据」）');
  // id 不变式在降级路径上同样成立：所有 id 要么在簇里、要么在 dropped 里
  const kept = new Set();
  for (const c of r.clusters) for (const it of (c.items || [])) kept.add(it.id);
  for (const d of r.dropped) for (const id of (d.ids || [])) kept.add(id);
  const missing = ['i0', 'i1', 'i2', 'i3'].filter((id) => !kept.has(id));
  assert.deepEqual(missing, [], `降级不得让 id 消失，缺：${missing.join(',')}`);
});
