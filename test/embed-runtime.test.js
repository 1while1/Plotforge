const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEmbedder, EMBED_TEXT_MAX } = require('../server/vector/embed');

function runtimeFixture() {
  const calls = [];
  const env = {};
  let loads = 0;
  const data = new Float32Array(512);
  data[0] = 1;
  const pipe = async (text, options) => {
    calls.push({ text, options });
    return { data };
  };
  return {
    env, calls, data,
    get loads() { return loads; },
    loader: async () => ({ env, pipeline: async (...args) => {
      loads += 1;
      calls.push({ pipeline: args });
      return pipe;
    } }),
  };
}

test('并发嵌入只加载一次 q8 CPU 模型，保持 mean/normalize 和查询前缀', async () => {
  const fixture = runtimeFixture();
  const runtime = createEmbedder(fixture.loader);
  const [document, query] = await Promise.all([runtime.embed('银钥匙'), runtime.embedQuery('石门')]);
  assert.equal(fixture.loads, 1);
  assert.deepEqual(fixture.calls[0].pipeline, [
    'feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8', device: 'cpu' },
  ]);
  assert.deepEqual(fixture.calls.slice(1), [
    { text: '银钥匙', options: { pooling: 'mean', normalize: true } },
    { text: '为这个句子生成表示以用于检索相关文章：石门', options: { pooling: 'mean', normalize: true } },
  ]);
  assert.ok(document instanceof Float32Array);
  assert.equal(query.length, 512);
  document[0] = 0;
  assert.equal(fixture.data[0], 1, '调用方不能修改 pipeline 复用的输出缓冲区');
  assert.equal(EMBED_TEXT_MAX, 480);
});

test('镜像实际传入 remoteHost，缓存位于依赖目录之外', async t => {
  const oldEndpoint = process.env.HF_ENDPOINT;
  const oldCache = process.env.NOVEL_EMBED_CACHE_DIR;
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = oldEndpoint;
    if (oldCache === undefined) delete process.env.NOVEL_EMBED_CACHE_DIR;
    else process.env.NOVEL_EMBED_CACHE_DIR = oldCache;
  });
  process.env.HF_ENDPOINT = 'https://mirror.example.test///';
  process.env.NOVEL_EMBED_CACHE_DIR = path.resolve('test-cache');
  const fixture = runtimeFixture();
  await createEmbedder(fixture.loader).embed('镜像');
  assert.equal(fixture.env.remoteHost, 'https://mirror.example.test/');
  assert.equal(fixture.env.cacheDir, process.env.NOVEL_EMBED_CACHE_DIR);
  assert.equal(fixture.env.allowLocalModels, true);
  delete process.env.HF_ENDPOINT;
  delete process.env.NOVEL_EMBED_CACHE_DIR;
  const defaults = runtimeFixture();
  await createEmbedder(defaults.loader).embed('默认');
  assert.equal(defaults.env.remoteHost, 'https://hf-mirror.com/');
  assert.equal(defaults.env.cacheDir, path.resolve(__dirname, '../data/embedding-cache'));
});

test('预热加载失败后重试，并发调用共享该次失败', async () => {
  const fixture = runtimeFixture();
  let attempts = 0;
  const runtime = createEmbedder(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('模拟下载失败');
    return fixture.loader();
  });
  const [warmed, failed] = await Promise.all([
    runtime.warmUp(), assert.rejects(runtime.embed('首轮'), /模拟下载失败/),
  ]);
  assert.equal(warmed, false);
  assert.equal(failed, undefined);
  assert.equal(attempts, 1);
  assert.equal(await runtime.warmUp(), true);
  assert.equal(attempts, 2);
  await runtime.embed('重试后');
  assert.equal(attempts, 2);
});

test('不兼容维度及非有限值拒绝作为持久化向量返回', async () => {
  for (const data of [new Float32Array(384), new Float32Array(512).fill(NaN)]) {
    const runtime = createEmbedder(async () => ({ env: {}, pipeline: async () => async () => ({ data }) }));
    await assert.rejects(runtime.embed('正文'), /512 维有限数值/);
  }
});
