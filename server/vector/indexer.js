const crypto = require('crypto');
const db = require('../db');
const { embed } = require('./embed');
const store = require('./store');
const { captureSource, assertSourceCurrent } = require('../domain/sourceGuard');
const { paragraphs, revision } = require('../evidence/draftLexical');

const CHUNK_SIZE = 500;
const OVERLAP = 60;
const SENTENCE_SPLIT = /(?<=[。！？!?…；;])/;   // 断句优先在句末标点后切，避免切坏词语

function hash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

/**
 * 超长段落拆成 ≤CHUNK_SIZE 的片段（保留段落下标与字符区间）。
 *
 * 为什么必须有这一步：切块内层循环的 `combined &&` 守卫让**首个段落不受长度检查**，
 * 于是一个 3,000 字不分段的章节会变成一个 3,000 字块 → 嵌入时被静默截断到 ~510 字，
 * 尾部内容从此检索不到（作者视角是「AI 想不起刚写的这段」）。这里先把超长段落按
 * 句末标点切成片段，保证「块 ≤ CHUNK_SIZE」这条不变量成立，也让 charStart/charEnd
 * 仍然指向原文真实位置。
 */
function splitOversized(paras, size) {
  const out = [];
  for (const p of paras) {
    if (p.text.length <= size) { out.push(p); continue; }
    let offset = 0;
    while (offset < p.text.length) {
      let piece = p.text.slice(offset, offset + size);
      if (offset + piece.length < p.text.length) {
        // 在片内最后一个句末标点处收尾（找不到就硬切）
        const sents = piece.split(SENTENCE_SPLIT);
        if (sents.length > 1) {
          const keep = piece.length - sents[sents.length - 1].length;
          if (keep > size * 0.3) piece = piece.slice(0, keep);
        }
      }
      out.push({
        index: p.index,
        text: piece,
        charStart: p.charStart + offset,
        charEnd: p.charStart + offset + piece.length,
      });
      offset += piece.length;
    }
  }
  return out;
}

function chunkText(content) {
  const source = String(content || '');
  const paras = splitOversized(paragraphs(source), CHUNK_SIZE);
  const chunks = [];
  let start = 0;
  while (start < paras.length) {
    let end = start;
    let combined = '';
    while (end < paras.length) {
      const candidate = combined ? `${combined}\n${paras[end].text}` : paras[end].text;
      if (combined && candidate.length > CHUNK_SIZE) break;
      combined = candidate;
      end += 1;
    }
    if (!combined && paras[start]) {
      combined = paras[start].text.slice(0, CHUNK_SIZE);
      end = start + 1;
    }
    // 不变量：块长必须落在嵌入安全边界内（splitOversized 之后这里不该再触发）
    if (combined.length > CHUNK_SIZE) combined = combined.slice(0, CHUNK_SIZE);
    if (combined.length > 30) {
      chunks.push({
        text: combined,
        paragraphStart: paras[start].index,
        paragraphEnd: paras[Math.max(start, end - 1)].index,
        charStart: paras[start].charStart,
        charEnd: paras[Math.max(start, end - 1)].charEnd,
        contentHash: hash(combined),
        sourceRevisionHash: revision(source),
      });
    }
    if (end >= paras.length) break;
    let overlapStart = end;
    let overlapChars = 0;
    while (overlapStart > start + 1 && overlapChars < OVERLAP) {
      overlapStart -= 1;
      overlapChars += paras[overlapStart].text.length;
    }
    start = overlapStart === start ? end : overlapStart;
  }
  return chunks;
}

// 用当前定稿正文重建某章向量。
// S5-04（C06 同族）：embedding 是外部 await——索引期间作者完全可能改稿（解除定稿）、移卷或删章。
// 旧实现读完章节就无条件 saveChunks，被改掉的「旧正文 A」的向量会在 await 回来之后落库，并以
// 「定稿 · 章名」进入语义检索；两次索引乱序返回时后到的旧任务还会先 DELETE 再 INSERT，把新
// 任务的向量整批清掉。现在：来源快照在 embed 之前捕获（契约 §7），写回前在**同一个同步事务**里
// 复核「章仍存在 / 仍定稿 / 正文·结构·版本与读取时一致」（复用 S5-01 的 sourceGuard），不一致
// 整批丢弃并返回明确的过期状态；核验与整批替换同事务，失败整体回滚，不允许 A/B 混合或留半批。
async function indexChapter(chapterId) {
  const chapter = db.get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) return { indexed: 0, error: '章节不存在' };
  if (!chapter.locked || !chapter.content) {
    store.deleteChapter(chapterId);
    return { indexed: 0 };
  }
  const snapshot = captureSource({ bookId: chapter.book_id, kind: 'chapter', entityId: chapter.id });
  const descriptors = chunkText(chapter.content);
  const chunks = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    chunks.push({ ...descriptors[index], idx: index, vector: await embed(descriptors[index].text) });
  }
  try {
    db.transaction(() => {
      assertSourceCurrent(snapshot);
      store.saveChunks(chapter.book_id, chapterId, chunks);
    });
  } catch (err) {
    if (!err || (err.code !== 'SOURCE_CHANGED' && err.code !== 'CHAPTER_NOT_FOUND')) throw err;
    const reason = err.details && err.details.reason ? `:${err.details.reason}` : '';
    console.warn(`[vector] 章节 ${chapterId} 的索引结果已过期（${err.code}${reason}），整批丢弃；缺口会由索引覆盖率标出，可重新定稿或一键重建`);
    return {
      indexed: 0,
      stale: true,
      code: err.code,
      error: '索引结果已过期：索引期间章节被删除/解除定稿/正文或结构已变，本批向量整批丢弃',
    };
  }
  console.log(`[vector] 章节 ${chapterId}《${chapter.title}》已索引 ${chunks.length} 块`);
  return { indexed: chunks.length };
}

// 补建全书缺失索引。S5-04：单章失败/过期不打断整批（旧实现一次抛错就让后续章全部不索引），
// 并把失败逐章记进返回值——缺口既反映在覆盖率标记上，也能在日志与返回值里追溯。
async function indexBookMissing(bookId) {
  const rows = db.all(`
    SELECT c.id FROM chapters c
    WHERE c.book_id = ? AND c.locked = 1 AND c.content != ''
      AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chapter_id = c.id)`, [bookId]);
  let total = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const result = await indexChapter(row.id);
      total += result.indexed;
      if (result.stale || result.error) {
        failures.push({ chapterId: row.id, code: result.code || 'INDEX_FAILED', error: result.error });
      }
    } catch (err) {
      failures.push({
        chapterId: row.id,
        code: (err && err.code) || 'INDEX_FAILED',
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  return { chapters: rows.length, chunks: total, stale: failures.length, failed: failures.length, errors: failures };
}

module.exports = { indexChapter, indexBookMissing, chunkText, hash };
