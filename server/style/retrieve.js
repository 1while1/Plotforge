// 作家卡 · 范文检索：从卡里挑出「此刻最该参照的几段字」。
//
// 两条路，同一入口（selectSamples），调用方默认不需要知道走的是哪条：
//   直出（运行时）：按 sort_order 取范文，填满额度为止。**运行时只走这一条**（方案 §3.4.0 拍板：
//     向量库只在离线期工作，运行时一律走表——`providers/style.js` 不传 query）。
//   相似度（离线）：给定**已算好的查询向量**，在本卡已索引的范文里按余弦挑最贴近的几段。
//     用于 L4 蒸馏期的「场景多样性」核对（设计 §3.4 双通道检索的内容通道）。
//
// 为什么相似度路径要收「向量」而不是「查询字符串」：本函数的调用链是同步的
// （`packs.compileCardsText` ← `providers/style.js` 的同步 build），而嵌入模型是异步的。
// 离线期先 `embedSampleQuery()` 拿到向量，再交给这里的同步检索——运行时零改动、零阻塞。
// `o.query`（字符串）在同步路径上**无法**生效：只会告警一次并回落直出，不静默假装检索过。
const db = require('../db');

// 范文字符预算：整卡额度（现 48000）里留给范文的部分。
// 2026-09-12 由 4000 提到 6000（方案 §3.5 预算表）：L4 选样器每作者产出 19 段左右（k=8 簇
// ×（medoid+远端）+ 3 个极值）、每段 400 字 ≈ 7600 字，4000 只会装下 10 段、后面 9 段白选。
// 2026-09-14 由 6000 提到 8000：让 k=8 的 19/19/17/17 段全进。
// **2026-09-19 由 8000 提到 16000（委托方指示「再提升提示词预算」）**：范文材料同批扩容——
// L4 选样 k 8→16（16 簇 × 2 + 3 极值 = 35 候选，实测四作者 33~35 段 / 13,600~14,400 字），
// 8000 会砍掉近半段；16000 让扩样后的范文全进。注意：报告 18 消融实测范文对「硬线合规率」
// 无增量，本次扩量买的是场景/语感材料的丰富度（该价值不在合规尺子上）。
// 单段超额度仍是整段跳过（截半个场景比不给还糟）。**这是第二道上限**：只抬整卡额度而不动这里，
// 范文照样被砍。
const SAMPLE_BUDGET_CHARS = 16000;
// 参与嵌入的范文上限：与 tools/distill/util.js 的向量域块尺度同值。
// 超此长度的范文进嵌入模型会被**静默截断**（510 字边界实测），索引到的只是开头一段，
// 故 indexSamples 一律跳过并计数，不写入「看起来有索引、实际是半个」的向量。
const SAMPLE_EMBED_MAX_CHARS = 500;
const VECTOR_MODEL = 'bge-small-zh-v1.5';
let queryStringWarned = false;

function toSample(row) {
  if (!row) return null;
  return {
    id: row.id,
    packId: row.pack_id,
    title: row.title,
    text: row.text,
    source: row.source,
    charCount: row.char_count,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    indexed: Boolean(row.indexed_at && row.vector_model),
  };
}

function listSamples(packId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM style_samples WHERE pack_id = ?';
  const params = [packId];
  if (o.enabledOnly !== false) sql += ' AND enabled = 1';
  sql += ' ORDER BY sort_order, id';
  return db.all(sql, params).map(toSample);
}

/**
 * 挑出要注入的范文（直出路径：按 sort_order 直出，填满额度即止）。
 * 单段超额度时整段跳过而不截断——截半个场景比不给还糟，会教出错误的语感。
 * @param {number[]} packIds 参与本卡的卡 id（主卡在前，顺序即优先级）
 * @param {{maxChars?:number, query?:string, queryVector?:Float32Array}} [opts]
 * @returns {Array<{title:string,text:string,source:string,packId:number}>}
 */
function selectSamples(packIds, opts) {
  const o = opts || {};
  const maxChars = Number.isFinite(o.maxChars) ? o.maxChars : SAMPLE_BUDGET_CHARS;
  const ids = (packIds || []).filter(Number.isFinite);
  if (!ids.length) return [];

  // 相似度路径（离线）：只在调用方**已经算好查询向量**时生效。
  // 传字符串 query 而没传向量 → 同步路径无法嵌入，告警一次并回落直出（不假装检索过）。
  if (o.queryVector) {
    const bySim = selectBySimilarity(ids, o.queryVector, { maxChars: maxChars });
    if (bySim && bySim.length) return bySim;
  } else if (o.query && !queryStringWarned) {
    queryStringWarned = true;
    console.warn('[style] selectSamples 收到字符串 query 但同步路径无法调嵌入模型：' +
      '本次回落按序直出。离线选样请先 embedSampleQuery() 再传 queryVector。');
  }

  const picked = [];
  let used = 0;
  for (const packId of ids) {
    for (const s of listSamples(packId)) {
      if (!s.text || !s.text.trim()) continue;
      const len = Array.from(s.text).length;
      if (used + len > maxChars) continue; // 跳过而非截断：整段才有语感
      picked.push({ packId: packId, title: s.title, text: s.text, source: s.source });
      used += len;
      if (used >= maxChars) break;
    }
    if (used >= maxChars) break;
  }
  return picked;
}

/** 点积即余弦（向量写入前已归一化，见 embed.js 的 normalize: true）。 */
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** BLOB → Float32Array（与 server/vector/store.js 同格式：Float32Array 原始字节）。
 *  这里 copy 一份再建视图（store.js 是直接建视图）：sql.js 回的 BLOB 字节偏移不保证 4 对齐，
 *  直接建视图会抛 RangeError；范文只有几十段，拷贝成本可忽略。 */
function toVector(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 4 || buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * 向量相似度检索（**离线选样辅助**，方案 §3.4.0/§3.4.1）。
 * 只在**本卡已索引的范文**里找最近邻——不跨卡、不扫全库：检索范围由 `packIds` 决定，
 * 这是多卡不串味的机制本身（`style_samples` 带 pack_id）。
 * @param {number[]} packIds
 * @param {Float32Array} queryVector 离线算好的查询向量（`embedSampleQuery()`）
 * @param {{maxChars?:number, topK?:number, minScore?:number}} [opts]
 * @returns {Array|null} null = 无索引/无向量 → 调用方回落直出路径
 */
function selectBySimilarity(packIds, queryVector, opts) {
  const o = opts || {};
  const ids = (packIds || []).filter(Number.isFinite);
  if (!ids.length || !queryVector || !queryVector.length) return null;
  const maxChars = Number.isFinite(o.maxChars) ? o.maxChars : SAMPLE_BUDGET_CHARS;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT * FROM style_samples WHERE pack_id IN (${placeholders}) AND enabled = 1
       AND vector IS NOT NULL AND vector_model <> '' ORDER BY sort_order, id`,
    ids
  );
  if (!rows.length) return null;
  const scored = [];
  for (const row of rows) {
    const v = toVector(row.vector);
    if (!v || v.length !== queryVector.length) continue;
    const score = dot(v, queryVector);
    if (Number.isFinite(o.minScore) && score < o.minScore) continue;
    scored.push({ row: row, score: score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.score - a.score) || (a.row.sort_order - b.row.sort_order));
  const limited = Number.isInteger(o.topK) && o.topK > 0 ? scored.slice(0, o.topK) : scored;
  const picked = [];
  let used = 0;
  for (const s of limited) {
    const len = Array.from(String(s.row.text || '')).length;
    if (!len || used + len > maxChars) continue; // 与直出路径同契约：整段进整段出
    picked.push({ packId: s.row.pack_id, title: s.row.title, text: s.row.text, source: s.row.source, score: +s.score.toFixed(4) });
    used += len;
  }
  return picked.length ? picked : null;
}

/** 查询文本 → 向量（离线用）：bge 检索式前缀在 embed.js 的 embedQuery 里。 */
async function embedSampleQuery(text, opts) {
  const o = opts || {};
  const embedFn = o.embedImpl || require('../vector/embed').embedQuery;
  return embedFn(String(text || ''));
}

/**
 * 把一张卡的范文向量化（**离线**，L4 蒸馏期调用一次）。
 * 超 500 字的范文**跳过并计数**——嵌入模型 510 字后静默截断，写进去的向量只代表开头一段，
 * 属于「看起来有索引、实际是半个」的失效模式，宁可不索引（该段仍可走直出注入）。
 * @returns {{indexed:number, skipped:number, reasons:Object}}
 */
async function indexSamples(packId, opts) {
  const o = opts || {};
  const embedFn = o.embedImpl || require('../vector/embed').embed;
  const rows = db.all('SELECT * FROM style_samples WHERE pack_id = ? AND enabled = 1 ORDER BY sort_order, id', [packId]);
  const reasons = {};
  let indexed = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const text = String(row.text || '').trim();
    if (!text) { skipped++; reasons.empty = (reasons.empty || 0) + 1; continue; }
    const chars = Array.from(text).length;
    if (chars > SAMPLE_EMBED_MAX_CHARS) {
      skipped++;
      reasons.tooLong = (reasons.tooLong || 0) + 1;
      console.warn(`[style] 范文 #${row.id} 长度 ${chars} > ${SAMPLE_EMBED_MAX_CHARS}，跳过索引（嵌入会静默截断）`);
      continue;
    }
    const vec = await embedFn(text);
    db.run('UPDATE style_samples SET vector = ?, vector_model = ?, indexed_at = ? WHERE id = ?',
      [Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), VECTOR_MODEL, now, row.id]);
    indexed++;
  }
  return { indexed: indexed, skipped: skipped, reasons: reasons };
}

module.exports = {
  SAMPLE_BUDGET_CHARS, SAMPLE_EMBED_MAX_CHARS, VECTOR_MODEL,
  toSample, listSamples, selectSamples, selectBySimilarity, embedSampleQuery, indexSamples,
};
