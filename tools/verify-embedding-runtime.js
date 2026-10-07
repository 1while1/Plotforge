// 真实模型迁移验证：仅写显式临时库；支持 --offline、--baseline <旧向量 JSON>。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const samples = [
  '林野在北境冻港找到银钥匙，钥匙能够开启雪山深处的石门。',
  '药师用青色草叶治疗旅人的旧伤，炉火映着窗外的细雪。',
  '船长让灰雁号驶向南方海湾，货舱里装满红色香料。',
  '为这个句子生成表示以用于检索相关文章：银钥匙在哪里找到，能打开什么？',
  '为这个句子生成表示以用于检索相关文章：药师怎样治疗旅人的伤？',
  '汉'.repeat(480),
];

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

async function main() {
  const databaseFile = process.env.NOVEL_DB_FILE;
  assert.ok(databaseFile, '必须指定 NOVEL_DB_FILE 临时库');
  assert.notEqual(path.resolve(databaseFile), path.resolve(__dirname, '../data/novel.db'), '禁止使用真实库');
  // 禁止复用已有数据库，避免误把作品库当验证库写入；离线验证使用另一个新临时库。
  assert.equal(fs.existsSync(databaseFile), false, '验证必须使用不存在的新临时库路径');
  assert.ok(process.env.NOVEL_EMBED_CACHE_DIR, '必须指定隔离模型缓存 NOVEL_EMBED_CACHE_DIR');
  const offline = process.argv.includes('--offline');
  const baselineIndex = process.argv.indexOf('--baseline');
  const baseline = baselineIndex >= 0 ? JSON.parse(fs.readFileSync(process.argv[baselineIndex + 1], 'utf8')) : null;
  if (baseline) assert.deepEqual(baseline.samples, samples, '基线必须使用同一组样本');
  const originalFetch = global.fetch;
  let networkRequests = 0;
  global.fetch = (...args) => {
    networkRequests += 1;
    if (offline) throw new Error('离线验证禁止联网');
    return originalFetch(...args);
  };
  const db = require('../server/db');
  try {
    const runtime = require('../server/vector/embed');
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    assert.equal(await runtime.warmUp(), true, '真实预热应成功');
    const loaded = performance.now();
    const vectors = [];
    for (const sample of samples) vectors.push(Array.from(await runtime.embed(sample)));
    const norms = vectors.map(v => Math.sqrt(v.reduce((sum, n) => sum + n * n, 0)));
    for (const [i, vector] of vectors.entries()) {
      assert.equal(vector.length, 512);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(norms[i] - 1) < 1e-5);
    }
    const similarities = baseline ? vectors.map((v, i) => cosine(v, baseline.vectors[i])) : null;
    // 这里只验证同模型仍保持高相似度；033 迁移负责隔离运行时数值变化，绝不据此混用索引。
    if (similarities) for (const similarity of similarities) assert.ok(similarity > 0.99);
    await db.init({ filePath: databaseFile });
    const bookId = db.run("INSERT INTO books (title) VALUES ('embedding 隔离验证')").lastInsertRowid;
    const chapters = [];
    const { indexChapter } = require('../server/vector/indexer');
    for (const [i, text] of samples.slice(0, 3).entries()) {
      const chapterId = db.run('INSERT INTO chapters (book_id, title, content, locked, sort_order) VALUES (?, ?, ?, 1, ?)', [bookId, `样本 ${i}`, text.repeat(2), i]).lastInsertRowid;
      chapters.push(chapterId);
      assert.equal((await indexChapter(chapterId)).indexed, 1);
    }
    const { search } = require('../server/vector/search');
    const retrieval = [];
    for (const [i, query] of ['银钥匙在哪里找到，能打开什么？', '药师怎样治疗旅人的伤？'].entries()) {
      const hits = await search(bookId, query, { threshold: 0, topK: 3 });
      assert.equal(hits[0].chapter_id, chapters[i], '中文语义召回首位必须匹配');
      retrieval.push(hits.map(hit => ({ title: hit.chapter_title, score: hit.score })));
    }
    if (offline) assert.equal(networkRequests, 0, '旧缓存断网加载不应尝试请求');
    const report = { offline, networkRequests, loadAndWarmupMs: loaded - start, inferenceAndIndexMs: performance.now() - loaded, norms, similarities, retrieval, cpuUsage: process.cpuUsage(cpuStart), memory: process.memoryUsage() };
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    global.fetch = originalFetch;
    db.close();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
