// 错题库域模块：标本入库（去重）/ 复核 / 查询 / 统计 / 导出。
// 风格相关的一切逻辑都收在 server/style/ 与 server/detectors/ 下，
// 外面只通过 routes/style-lab.js（体检接口）与 providers/style.js（注入）接触本层——
// 这是委托方「必须不能十分耦合」这条硬要求的落地方式。
const crypto = require('crypto');
const db = require('../db');

const VERDICTS = ['pending', 'ai', 'human', 'rejected'];
const SOURCES = ['chapter', 'paste', 'manual'];

// 文本归一化后取哈希：去重键。
// 归一化只做「版面噪音」层面的事（去首尾空白、折叠内部空白、去掉不可见字符），
// **不改动任何实义字符**——改字会让我们把两句不同的话当成重复丢掉。
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/[\u200b-\u200f\ufeff]/g, '') // 零宽与 BOM
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

function parseJsonSafe(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch { return fallback; }
}

// 一行 DB 记录 → 对外的标本对象（JSON 列解析、字段名 camel 化）
function toSample(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    charCount: row.char_count,
    verdict: row.verdict,
    detector: row.detector,
    detectorConf: row.detector_conf,
    detectorLabel: row.detector_label,
    labelsRatio: parseJsonSafe(row.labels_ratio, []),
    segmentIndex: row.segment_index,
    detectionId: row.detection_id,
    bookId: row.book_id,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title_snapshot,
    chapterRevision: row.chapter_revision,
    source: row.source,
    reviewNote: row.review_note,
    tags: parseJsonSafe(row.tags, []),
    reviewedAt: row.reviewed_at,
    seenCount: row.seen_count,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function newDetectionId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `det-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 入库一批检测分段（来自朱雀的 segment_labels）。
 * 去重语义（设计文档 §1.2）：text_hash 冲突时不覆盖人工复核结论——
 * verdict / review_note / tags / reviewed_at 保持原样，人工判断永远优先于机器判定；
 * 只刷新机器侧的字段（conf / labels_ratio / segment 位置）并累加 seen_count。
 *
 * @param {Array<{text:string, conf:number|null, label:number|null, position?:string}>} segments
 * @param {{detectionId?:string, bookId?:number|null, chapterId?:number|null, chapterTitle?:string,
 *          chapterRevision?:string|null, source?:string, detector?:string, minChars?:number}} meta
 * @returns {{inserted:number, merged:number, skipped:number}}
 */
function saveSegments(segments, meta) {
  const m = meta || {};
  const source = SOURCES.includes(m.source) ? m.source : 'chapter';
  const detector = m.detector === 'manual' ? 'manual' : 'zhuque';
  const detectionId = m.detectionId || newDetectionId();
  // 过短的句子没有分析价值（也不该进语料），但阈值放宽到 8 字——
  // 朱雀只在长文本上分段，能返回的段本身已是有意义的单元，这里只挡极短碎片。
  const minChars = Number.isFinite(m.minChars) ? m.minChars : 8;

  let inserted = 0;
  let merged = 0;
  let skipped = 0;
  const list = Array.isArray(segments) ? segments : [];
  db.transaction(() => {
    for (const raw of list) {
      const text = String((raw && raw.text) || '');
      const norm = normalizeText(text);
      if (norm.length < minChars) { skipped += 1; continue; }
      const hash = hashText(text);
      const conf = Number.isFinite(Number(raw && raw.conf)) ? Number(raw.conf) : null;
      const label = Number.isInteger(raw && raw.label) ? raw.label : null;
      const existing = db.get('SELECT id FROM ai_style_samples WHERE text_hash = ?', [hash]);
      if (existing) {
        db.run(
          `UPDATE ai_style_samples
             SET detector_conf = ?, detector_label = ?, seen_count = seen_count + 1,
                 last_seen_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
           WHERE id = ?`,
          [conf, label, existing.id]
        );
        merged += 1;
        continue;
      }
      db.run(
        `INSERT INTO ai_style_samples
           (text, text_hash, char_count, verdict, detector, detector_conf, detector_label,
            labels_ratio, segment_index, segment_position, detection_id,
            book_id, chapter_id, chapter_title_snapshot, chapter_revision, source, last_seen_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
        [
          text, hash, norm.length, detector, conf, label,
          Number.isInteger(raw && raw.index) ? raw.index : null,
          String((raw && raw.position) || ''), detectionId,
          Number.isFinite(m.bookId) ? m.bookId : null,
          Number.isFinite(m.chapterId) ? m.chapterId : null,
          String(m.chapterTitle || ''),
          m.chapterRevision ? String(m.chapterRevision) : null,
          source,
        ]
      );
      inserted += 1;
    }
  });
  return { inserted, merged, skipped };
}

/**
 * 人工复核一条标本。verdict='pending' 表示撤回复核（清除 reviewed_at）。
 * 标签与备注始终覆盖写（复核是人的显式动作，后一次判断覆盖前一次）。
 */
function reviewSample(id, patch) {
  const sample = db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id]);
  if (!sample) return null;
  const p = patch || {};
  const sets = [];
  const values = [];
  if (p.verdict !== undefined) {
    if (!VERDICTS.includes(p.verdict)) {
      const err = new Error(`verdict 必须是 ${VERDICTS.join(' / ')} 之一`);
      err.code = 'BAD_VERDICT'; err.status = 400;
      throw err;
    }
    sets.push('verdict = ?');
    values.push(p.verdict);
    if (p.verdict === 'pending') {
      sets.push('reviewed_at = NULL');
    } else {
      sets.push("reviewed_at = datetime('now','localtime')");
    }
  }
  if (p.reviewNote !== undefined) { sets.push('review_note = ?'); values.push(String(p.reviewNote || '')); }
  if (p.tags !== undefined) {
    const tags = Array.isArray(p.tags) ? p.tags.map(String) : [];
    sets.push('tags = ?'); values.push(JSON.stringify(tags));
  }
  if (!sets.length) return toSample(sample);
  sets.push("updated_at = datetime('now','localtime')");
  values.push(id);
  db.run(`UPDATE ai_style_samples SET ${sets.join(', ')} WHERE id = ?`, values);
  return toSample(db.get('SELECT * FROM ai_style_samples WHERE id = ?', [id]));
}

function deleteSample(id) {
  const existed = db.get('SELECT id FROM ai_style_samples WHERE id = ?', [id]);
  if (!existed) return false;
  db.run('DELETE FROM ai_style_samples WHERE id = ?', [id]);
  return true;
}

/**
 * 标本列表查询。默认按置信度降序（最像 AI 的排前面，复核时先看最该看的）。
 * @param {{bookId?:number, chapterId?:number, verdict?:string, minConf?:number,
 *          maxConf?:number, q?:string, order?:string, limit?:number, offset?:number}} opts
 */
function listSamples(opts) {
  const o = opts || {};
  const where = [];
  const params = [];
  if (Number.isFinite(o.bookId)) { where.push('book_id = ?'); params.push(o.bookId); }
  if (Number.isFinite(o.chapterId)) { where.push('chapter_id = ?'); params.push(o.chapterId); }
  if (o.verdict && VERDICTS.includes(o.verdict)) { where.push('verdict = ?'); params.push(o.verdict); }
  if (Number.isFinite(o.minConf)) { where.push('detector_conf >= ?'); params.push(o.minConf); }
  if (Number.isFinite(o.maxConf)) { where.push('detector_conf <= ?'); params.push(o.maxConf); }
  if (o.q) { where.push('text LIKE ?'); params.push('%' + String(o.q) + '%'); }

  const orderMap = {
    conf: 'detector_conf DESC, id DESC',
    recent: 'id DESC',
    seen: 'seen_count DESC, detector_conf DESC',
    oldest: 'id ASC',
  };
  const order = orderMap[o.order] || orderMap.conf;

  const limit = Number.isFinite(o.limit) ? Math.min(Math.max(1, o.limit), 500) : 50;
  const offset = Number.isFinite(o.offset) && o.offset > 0 ? o.offset : 0;
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.get(`SELECT COUNT(*) AS n FROM ai_style_samples ${whereSql}`, params).n;
  const rows = db.all(
    `SELECT * FROM ai_style_samples ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params.concat([limit, offset])
  );
  return { total, limit, offset, samples: rows.map(toSample) };
}

// 统计：按 verdict / 置信度分桶 / 书目分布 —— 供前端显示「语料够不够用了」
function stats(bookId) {
  const bookFilter = Number.isFinite(bookId) ? 'WHERE book_id = ?' : '';
  const params = Number.isFinite(bookId) ? [bookId] : [];
  const byVerdict = {};
  for (const v of VERDICTS) byVerdict[v] = 0;
  for (const row of db.all(`SELECT verdict, COUNT(*) AS n FROM ai_style_samples ${bookFilter} GROUP BY verdict`, params)) {
    byVerdict[row.verdict] = row.n;
  }
  const confRows = db.all(
    `SELECT
       SUM(CASE WHEN detector_conf >= 0.9 THEN 1 ELSE 0 END) AS very_high,
       SUM(CASE WHEN detector_conf >= 0.7 AND detector_conf < 0.9 THEN 1 ELSE 0 END) AS high,
       SUM(CASE WHEN detector_conf >= 0.5 AND detector_conf < 0.7 THEN 1 ELSE 0 END) AS mid,
       SUM(CASE WHEN detector_conf IS NOT NULL AND detector_conf < 0.5 THEN 1 ELSE 0 END) AS low,
       COUNT(*) AS total
     FROM ai_style_samples ${bookFilter}`,
    params
  )[0] || {};
  const byBook = db.all(
    `SELECT book_id, COUNT(*) AS n FROM ai_style_samples WHERE book_id IS NOT NULL GROUP BY book_id ORDER BY n DESC LIMIT 50`
  );
  const topSeen = db.all(
    `SELECT id, text, seen_count, detector_conf, verdict FROM ai_style_samples
      WHERE seen_count > 1 ${Number.isFinite(bookId) ? 'AND book_id = ?' : ''}
      ORDER BY seen_count DESC LIMIT 10`,
    params
  );
  return {
    byVerdict,
    total: byVerdict.pending + byVerdict.ai + byVerdict.human + byVerdict.rejected,
    byConfidence: {
      veryHigh: confRows.very_high || 0,
      high: confRows.high || 0,
      mid: confRows.mid || 0,
      low: confRows.low || 0,
    },
    byBook: byBook.map(r => ({ bookId: r.book_id, count: r.n })),
    topRepeated: topSeen.map(r => ({
      id: r.id, text: r.text, seenCount: r.seen_count, detectorConf: r.detector_conf, verdict: r.verdict,
    })),
  };
}

/**
 * 导出语料（特征提取的输入口）。
 * format='jsonl' 每行一条标本对象（JSON 列已解析为数组）；format='json' 返回数组。
 * 默认只导「已复核且非 rejected」的标本——未复核的语料不该进分析（防污染），
 * includePending=true 才带 pending（供人工批量复核时外流）。
 */
function exportSamples(opts) {
  const o = opts || {};
  const where = [];
  const params = [];
  if (Number.isFinite(o.bookId)) { where.push('book_id = ?'); params.push(o.bookId); }
  if (o.verdict && VERDICTS.includes(o.verdict)) {
    // 显式指定状态时按状态取；但 rejected 标本本身无效，任何情况下都不导出
    where.push('verdict = ?'); params.push(o.verdict);
    if (o.verdict === 'rejected') where.push('1 = 0');
  } else if (o.includePending === true) {
    where.push("verdict != 'rejected'");
  } else {
    where.push("verdict IN ('ai', 'human')");
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.all(
    `SELECT * FROM ai_style_samples ${whereSql} ORDER BY detector_conf DESC, id DESC`,
    params
  );
  const samples = rows.map(toSample);
  if (o.format === 'json') return { format: 'json', samples };
  return {
    format: 'jsonl',
    content: samples.map(s => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''),
    count: samples.length,
  };
}

module.exports = {
  VERDICTS, SOURCES,
  normalizeText, hashText, newDetectionId,
  saveSegments, reviewSample, deleteSample, listSamples, stats, exportSamples, toSample,
};
