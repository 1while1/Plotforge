// AnySearch 内联错误识别回归（2026-09-10 真实回测发现）：
// 鉴权/配额类错误不走 HTTP 状态码或 JSON-RPC error，而是 HTTP 200 + 正文短文本
// 「invalid_api_key Invalid API key.」。此前被当成功结果返回——模型收到假搜索结果、
// 设置页「测试搜索」误报正常。修复后必须转成异常（工具层结构化错误 / 502）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const { createApp } = require('../server/app');
const { listen, json } = require('./helpers/http');

const ENDPOINT = 'https://api.anysearch.com/mcp';

function stubInlineError() {
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url) !== ENDPOINT) return orig(url, opts);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: 'invalid_api_key Invalid API key.' }] },
      }),
    };
  };
  return () => { global.fetch = orig; };
}

function stubNormal() {
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url) !== ENDPOINT) return orig(url, opts);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: '## Search Results (1 results, 10ms)\n### 1. 正常结果\n- **URL**: https://example.com\n- 摘要内容'.repeat(3) }] },
      }),
    };
  };
  return () => { global.fetch = orig; };
}

test('search：HTTP 200 正文内联 invalid_api_key 必须抛错，不得当结果返回', async () => {
  const restore = stubInlineError();
  try {
    const ws = require('../server/websearch');
    await assert.rejects(
      ws.search({ query: 'x', maxResults: 1 }),
      err => /AnySearch 调用失败/.test(err.message) && /invalid_api_key/.test(err.message)
    );
  } finally { restore(); }
});

test('batchSearch：内联错误同样抛错（共享 callTool 路径）', async () => {
  const restore = stubInlineError();
  try {
    const ws = require('../server/websearch');
    await assert.rejects(ws.batchSearch([{ query: 'x' }]), /invalid_api_key/);
  } finally { restore(); }
});

test('正常短结果（## 开头）不误伤', async () => {
  const restore = stubNormal();
  try {
    const ws = require('../server/websearch');
    const r = await ws.search({ query: 'x', maxResults: 1 });
    assert.match(r, /^## Search Results/);
  } finally { restore(); }
});

test('端到端：/api/settings/test-search 在无效 key 下回 502 且错误可读（此前误报 ok）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  db.run("INSERT INTO settings (key, value) VALUES ('anysearch_api_key', 'as_sk_definitely_invalid')");
  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const restore = stubInlineError();
  try {
    const r = await json(http.baseUrl, 'POST', '/api/settings/test-search', {});
    assert.equal(r.status, 502, "status=" + r.status + " body=" + JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /invalid_api_key/);
  } finally { restore(); }
});
