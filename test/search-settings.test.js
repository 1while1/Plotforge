// 第七轮处置（§6.10）C/D 的回归保护：batch_search 一等工具 + 设置页搜索配置区
//   C  batchSearch 入参整形（>5 截到 5 / 缺 query 报错 / maxResults 夹 10）+ bookTools 定义与执行器
//   D  search_enabled 总闸（关→四工具不出网）/ 设置默认参数生效 / /test-search 失败 502 且错误脱敏 /
//      GET /api/settings 回只读端点且不含明文 key
// 全程 NOVEL_DB_FILE 等价物（createTempLocation 临时库）+ 桩 fetch/websearch/skills，绝不打真实网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

const DEFAULT_ENDPOINT = 'https://api.anysearch.com/mcp';
const FAKE_KEY = 'as_sk_test_0123456789abcdef';

// ---------------- fetch 桩：仅拦截 AnySearch 端点，其余（测试客户端自身的 HTTP）放行 ----------------
const net = { calls: [], responder: null };
function stubFetch() {
  net.origFetch = global.fetch;
  net.calls = [];
  global.fetch = async (url, opts) => {
    if (String(url) !== DEFAULT_ENDPOINT) return net.origFetch(url, opts);
    net.calls.push({ url, body: JSON.parse(opts.body) });
    if (net.responder) return net.responder();
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '搜索结果文本' }] } }),
    };
  };
}
function restoreFetch() { global.fetch = net.origFetch; }

// ---------------- C：batchSearch 入参整形（经 fetch 桩观察真实出网参数） ----------------
test('C batchSearch：>5 条截到 5、maxResults>10 夹到 10、出网端点为锁定默认值', async () => {
  stubFetch();
  try {
    const ws = require('../server/websearch');
    const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'].map(q => ({ query: q, maxResults: 50 }));
    const text = await ws.batchSearch(queries);
    assert.equal(text, '搜索结果文本');
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, DEFAULT_ENDPOINT, '端点应锁定为默认值');
    const args = net.calls[0].body.params.arguments;
    assert.equal(net.calls[0].body.params.name, 'batch_search');
    assert.equal(args.queries.length, 5, '超过 5 条应截断到 5');
    assert.equal(args.queries[0].max_results, 10, 'maxResults>10 应夹到 10');
    assert.equal(args.queries[0].query, 'q1');
  } finally { restoreFetch(); }
});

test('C batchSearch：缺非空 query 直接报错，不出网', async () => {
  stubFetch();
  try {
    const ws = require('../server/websearch');
    await assert.rejects(
      ws.batchSearch([{ query: 'ok' }, { query: '   ' }, {}]),
      /每条查询都必须包含非空 query/
    );
    await assert.rejects(ws.batchSearch([]), /至少需要 1 条查询/);
    assert.equal(net.calls.length, 0, '校验失败不应发出任何网络请求');
  } finally { restoreFetch(); }
});

test('C batchSearch：批量结果截断到 12000', async () => {
  stubFetch();
  net.responder = () => ({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(20000) }] } }),
  });
  try {
    const ws = require('../server/websearch');
    const text = await ws.batchSearch([{ query: 'q' }]);
    assert.equal(text.length, 12000);
  } finally { restoreFetch(); net.responder = null; }
});

test('C bookTools 注册 batch_search：writing/agent profile 可见、只读、执行器接通', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['C 书']).lastInsertRowid;

  const { listTools, profiles } = require('../server/tools/registry');
  assert.equal(profiles.writing.has('batch_search'), true, 'writing profile 应包含 batch_search');
  const desc = listTools('writing').find(t => t.name === 'batch_search');
  assert.ok(desc, 'writing profile 应能列出 batch_search');
  assert.equal(desc.mutation, 'read', 'batch_search 应为只读工具（免确认）');
  assert.deepEqual(desc.inputSchema.required, ['queries']);

  // 执行器接通：桩掉 websearch.batchSearch，观察透传
  const ws = require('../server/websearch');
  const orig = ws.batchSearch;
  let seen = null;
  ws.batchSearch = async (queries) => { seen = queries; return '批量结果'; };
  try {
    const bookTools = require('../server/bookTools');
    const r = await bookTools.executeRead(bookId, 'batch_search', { queries: [{ query: '明朝海关' }, { query: '宝船形制' }] });
    assert.deepEqual(r, { results: '批量结果' });
    assert.deepEqual(seen, [{ query: '明朝海关' }, { query: '宝船形制' }]);
  } finally { ws.batchSearch = orig; }
});

// ---------------- D：search_enabled 总闸 ----------------
test('D search_enabled=false：四个联网工具返回停用错误且绝不调用 websearch/skills', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['D 闸书']).lastInsertRowid;
  db.run("INSERT INTO settings (key, value) VALUES ('search_enabled', '0')");

  const ws = require('../server/websearch');
  const skills = require('../server/skills');
  const origSearch = ws.search, origExtract = ws.extract, origBatch = ws.batchSearch, origRun = skills.runSkillCli;
  let called = 0;
  ws.search = async () => { called++; return ''; };
  ws.extract = async () => { called++; return ''; };
  ws.batchSearch = async () => { called++; return ''; };
  skills.runSkillCli = async () => { called++; return ''; };
  t.after(() => { ws.search = origSearch; ws.extract = origExtract; ws.batchSearch = origBatch; skills.runSkillCli = origRun; });

  const bookTools = require('../server/bookTools');
  for (const [name, args] of [
    ['web_search', { query: 'x' }],
    ['web_extract', { url: 'https://example.com' }],
    ['batch_search', { queries: [{ query: 'x' }] }],
    ['skill_search', { query: 'x' }],
  ]) {
    // 业务失败统一抛 DomainError（code=SEARCH_DISABLED），不再用 {error} 返回值
    await assert.rejects(
      bookTools.executeRead(bookId, name, args),
      err => err.code === 'SEARCH_DISABLED' && /联网搜索已在设置中停用/.test(err.message),
      `${name} 应被总闸拦截`
    );
  }
  assert.equal(called, 0, '总闸关闭时不应有任何出网调用');
});

// ---------------- D：设置默认参数生效 ----------------
test('D 默认参数：settings 设 search_max_results=3 等后，工具未传参时生效、显式传参优先', async t => {
  const location = createTempLocation();
  t.after(() => cleanup(location));
  await db.init({ filePath: location.filePath });
  stubFetch();
  try {
    db.run("INSERT INTO settings (key, value) VALUES ('search_max_results', '3')");
    db.run("INSERT INTO settings (key, value) VALUES ('search_freshness', 'week')");
    db.run("INSERT INTO settings (key, value) VALUES ('search_zone', 'cn')");
    const ws = require('../server/websearch');

    await ws.search({ query: '未传参数' });
    let args = net.calls[net.calls.length - 1].body.params.arguments;
    assert.equal(args.max_results, 3);
    assert.equal(args.freshness, 'week');
    assert.equal(args.zone, 'cn');

    await ws.search({ query: '显式覆盖', maxResults: 8, freshness: 'day', zone: 'intl' });
    args = net.calls[net.calls.length - 1].body.params.arguments;
    assert.equal(args.max_results, 8, '显式传参应优先于设置默认');
    assert.equal(args.freshness, 'day');
    assert.equal(args.zone, 'intl');
  } finally { restoreFetch(); }
});

// ---------------- D：/test-search 与 GET /api/settings ----------------
async function apiSetup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });
  return { http };
}

test('D POST /test-search 上游失败回 502，错误信息经脱敏绝不含明文 key', async t => {
  const { http } = await apiSetup(t);
  db.run("INSERT INTO settings (key, value) VALUES ('anysearch_api_key', ?)", [FAKE_KEY]);
  stubFetch();
  net.responder = () => { throw new Error(`AnySearch HTTP 500: key=${FAKE_KEY} quota exceeded`); };
  try {
    const r = await json(http.baseUrl, 'POST', '/api/settings/test-search', {});
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
    assert.ok(!String(r.body.error).includes(FAKE_KEY), '错误信息不得含明文 key');
    assert.match(String(r.body.error), /\*\*\*/, '明文 key 应被替换为 ***');
  } finally { restoreFetch(); net.responder = null; }
});

test('D POST /test-search 成功回 ok 与 snippet', async t => {
  const { http } = await apiSetup(t);
  stubFetch();
  try {
    const r = await json(http.baseUrl, 'POST', '/api/settings/test-search', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.snippet, '搜索结果文本');
    const args = net.calls[0].body.params.arguments;
    assert.equal(args.query, '连接测试');
    assert.equal(args.max_results, 1);
  } finally { restoreFetch(); }
});

test('D GET /api/settings：含只读生效端点与搜索字段，绝不含明文 key', async t => {
  const { http } = await apiSetup(t);
  db.run("INSERT INTO settings (key, value) VALUES ('anysearch_api_key', ?)", [FAKE_KEY]);
  const r = await json(http.baseUrl, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  const s = r.body.settings;
  assert.equal(s.anysearch_endpoint_effective, DEFAULT_ENDPOINT);
  assert.equal(s.search_enabled, true, '缺省应为启用');
  assert.equal(s.search_max_results, 5);
  assert.equal(s.search_freshness, '');
  assert.equal(s.search_zone, '');
  assert.equal(s.anysearch_api_key_set, true);
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY), '响应任何位置不得含明文 key');
  assert.equal(s.anysearch_api_key_masked, 'as_sk_…cdef');
});
