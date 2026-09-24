// 向量存储：embeddings 表读写。向量以 Float32Array 原始字节存 BLOB。
const db = require('../db');

function toBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

// 整章重建：先删后插（chunks: [{ idx, text, vector }]）
// 原子性由调用方持有：indexer 把「来源核验 + 本函数」放进同一个 db.transaction（db 不支持嵌套
// 事务，这里不自己 BEGIN——外层再包一层会直接抛错）。删与插之间失败不得留下半批或 A/B 混合。
function saveChunks(bookId, chapterId, chunks) {
  db.run('DELETE FROM embeddings WHERE chapter_id = ?', [chapterId]);
  for (const c of chunks) {
    db.run(
      `INSERT INTO embeddings
       (book_id, chapter_id, chunk_idx, text, vector, paragraph_start, paragraph_end,
        char_start, char_end, content_hash, source_revision_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookId, chapterId, c.idx, c.text, toBlob(c.vector),
        c.paragraphStart || 0, c.paragraphEnd || 0, c.charStart || 0, c.charEnd || 0,
        c.contentHash || '', c.sourceRevisionHash || '', new Date().toISOString(),
      ]
    );
  }
  byBookCache.delete(bookId);
}

function deleteChapter(chapterId) {
  // 先取归属再删：同步失效该书向量缓存（getByBook 缓存命中期间不能返回已删向量）
  const row = db.get('SELECT book_id FROM embeddings WHERE chapter_id = ?', [chapterId]);
  db.run('DELETE FROM embeddings WHERE chapter_id = ?', [chapterId]);
  if (row) byBookCache.delete(row.book_id);
}

// getByBook 读缓存（方向报告 2.1）：语义检索每次提问都全量读出该书向量 BLOB
// 并逐一解析（数千章 × 多块时 SQL 读出+Float32 解析线性上涨，而向量集合在
// 两次写之间是只读的）。TTL 60s 兜底章节改名等旁路写入的陈旧性；
// saveChunks/deleteChapter 主动失效。
const BY_BOOK_TTL_MS = 60_000;
const byBookCache = new Map(); // bookId -> { at, rows }

// 取某书全部向量（百万字规模约 2000 行，内存暴力余弦本身 <10ms）
function getByBook(bookId) {
  const hit = byBookCache.get(bookId);
  if (hit && Date.now() - hit.at < BY_BOOK_TTL_MS) return hit.rows;
  const rows = db.all(`
    SELECT e.chapter_id, e.chunk_idx, e.text, e.vector, e.paragraph_start, e.paragraph_end,
           e.char_start, e.char_end, e.content_hash, e.source_revision_hash,
           c.title AS chapter_title
    FROM embeddings e JOIN chapters c ON c.id = e.chapter_id
    WHERE e.book_id = ?`, [bookId])
    .map(r => ({ ...r, vector: fromBlob(r.vector) }));
  byBookCache.set(bookId, { at: Date.now(), rows });
  return rows;
}

function chapterChunkCount(chapterId) {
  const r = db.get('SELECT COUNT(*) AS n FROM embeddings WHERE chapter_id = ?', [chapterId]);
  return r ? r.n : 0;
}

function bookChunkCount(bookId) {
  const r = db.get('SELECT COUNT(*) AS n FROM embeddings WHERE book_id = ?', [bookId]);
  return r ? r.n : 0;
}

module.exports = { saveChunks, deleteChapter, getByBook, chapterChunkCount, bookChunkCount };
