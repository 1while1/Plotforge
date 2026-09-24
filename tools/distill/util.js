// 蒸馏管线共通件：语料读取 / 汉字统计 / 滑窗切块 / 行过滤。
//
// ★ 为什么不用 server/vector/indexer.js 的 chunkText()（P8 第三条硬性验收）：
//   indexer 是段落累积制，且首轮迭代不检查长度（单个 >512 字段落会整体成块，
//   尾部内容被嵌入模型静默丢弃，方案 §1.7④ 实测）。蒸馏侧规定的是**字符滑窗**，
//   复用会把那个缺陷一并继承过来。本文件自实现，并在切块后逐块断言长度。
//
// 块尺度域（方案 §1.7 块域总表，互不通用）：
//   400 字  —— L1 指纹统计 / 专名密度（§1.3/§1.4/§3.1.5 实测域）
//   500 字  —— 向量库生产域（距嵌入模型 510 字静默截断边界仅 10 字余量）
//   8000 字（步长 7800，含 200 重叠）—— L2 map 的 LLM 输入块（§3.2）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CJK = /[\u4e00-\u9fff]/gu;
function han(s) { return (String(s || '').match(CJK) || []).length; }

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function codePoints(s) { return Array.from(String(s || '')).length; }

// 嵌入模型的静默截断边界 ≈510 字（方案 §1.7④ 逐字逼近实测：
// N=510 cos 0.99934 → N=511 cos 1.00000 跳变，超界内容整段丢弃且不报错）。
// 向量域块尺度 500 字距边界仅 10 字——这是「错了也不知道」的失效模式，故设为硬常量。
const EMBED_SAFE_LIMIT = 510;
const VECTOR_CHUNK_SIZE = 500;
const MAP_CHUNK_SIZE = 8000;
const MAP_CHUNK_STEP = 7800; // 8,000 − 200 字重叠（§3.2/§1.7③ 口径）
const L1_CHUNK_SIZE = 400;

/**
 * 字符滑窗切块（按 UTF-16 码元切、按码点数断言——BMP 汉字两者一致，
 * 偶发代理对字符会令码元数 ≥ 码点数，断言只会更严不会更松）。
 *
 * 每块构造后立即断言码点数 ≤ size。注意断言本身在当前实现下**不可触发**（slice 取的是
 * size 个 UTF-16 码元，码点数 ≤ 码元数恒成立）——它只是「算法若被改回段落累积制」的 tripwire；
 * ≤size 的真正保证来自 slice 结构 + 常量 + 下面两道显式闸门（非法 size/step、嵌入边界）。
 *
 * @param {string} text
 * @param {{size:number, step:number, min?:number}} o step 必须 < size（重叠）或 == size（不重叠）
 * @returns {{index:number, text:string, charStart:number}[]}
 */
function slidingChunks(text, o) {
  const src = String(text || '');
  const size = o && o.size;
  const step = o && o.step;
  const min = (o && o.min) || 0;
  if (!Number.isInteger(size) || size <= 0) throw new Error(`slidingChunks: 非法 size=${size}`);
  if (!Number.isInteger(step) || step <= 0 || step > size) {
    throw new Error(`slidingChunks: 非法 step=${step}（须 0 < step <= size）`);
  }
  if (size > EMBED_SAFE_LIMIT) {
    // 只有 LLM 输入域（8000 字）允许超过嵌入边界——它不进嵌入模型；
    // 其他域超过 510 即是事故（向量块、查询侧都被静默截断）。
    if (size !== MAP_CHUNK_SIZE) {
      throw new Error(`slidingChunks: size=${size} 超过嵌入安全边界 ${EMBED_SAFE_LIMIT}，` +
        '向量域切块不得大于 500（方案 §1.7④ 硬约束）');
    }
  }
  const out = [];
  let start = 0;
  let index = 0;
  while (start < src.length) {
    const end = Math.min(start + size, src.length);
    const piece = src.slice(start, end);
    const cp = codePoints(piece);
    if (cp > size) throw new Error(`切块断言失败：块 ${index} 码点数 ${cp} > size ${size}`);
    if (piece.trim().length > min) out.push({ index: index++, text: piece, charStart: start });
    if (end >= src.length) break;
    start += step;
  }
  return out;
}

// 三个预设域的便捷入口（调用方不要自己发明尺度）
const vectorChunks = (text) => slidingChunks(text, { size: VECTOR_CHUNK_SIZE, step: VECTOR_CHUNK_SIZE });
const l1Chunks = (text) => slidingChunks(text, { size: L1_CHUNK_SIZE, step: L1_CHUNK_SIZE });
const mapChunks = (text) => slidingChunks(text, { size: MAP_CHUNK_SIZE, step: MAP_CHUNK_STEP });

// 章标题行形态：第N章 / 数字开头的行（蔽霄有多章标题连排，如「第126章 众妙之门，第127章 玄黄」）
const CHAPTER_TITLE = /^(第[0-9零一二三四五六七八九十百千万两]+章|序章|楔子|番外|\d+[\s.、])/;

/** 逐行剔除章标题行后重拼接（保留其余行与换行结构）。L1/L2 统计域用它（§3.1 口径要点）。 */
function stripChapterTitles(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.filter(l => !CHAPTER_TITLE.test(l.trim())).join('\n');
}

/** 段落列表（保序、保空段占位——掩码验收①的逐段对齐要求段落数与行结构逐行对应）。 */
function paragraphsOf(text) {
  return String(text || '').split(/\r?\n/);
}

/**
 * 走读语料目录。约定结构（当前语料实测）：
 *   <题材>/<作家XXX>/作品_<书名>/<分卷>.txt   —— 一作品多文件
 *   <题材>/<作家XXX>/<书名>.txt               —— 一作品一文件
 * @returns {Array<{author:string, work:string, topic:string, file:string, rel:string}>}
 */
function readCorpus(rootDir) {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase().endsWith('.txt')) {
        const rel = path.relative(rootDir, p).replace(/\\/g, '/');
        const seg = rel.split('/');
        // 约定两形态：题材/作家/作品_<书名>/<分卷>.txt（4 层）与 题材/作家/<书名>.txt（3 层）。
        // 作者固定在第二层；作品名 4 层取目录名、3 层取文件名。
        if (seg.length < 3 || seg.length > 4) {
          throw new Error(`语料层级不合约定（期望 题材/作家/作品 3 或 4 层）: ${rel}`);
        }
        out.push({
          author: normalizeAuthor(seg[1]),
          work: normalizeWork(seg.length === 4 ? seg[2] : path.basename(e.name, '.txt')),
          topic: seg[0],
          file: p,
          rel,
        });
      }
    }
  };
  walk(rootDir, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

// 「作家白石」→「白石」
function normalizeAuthor(dirName) {
  return dirName.replace(/^作家/, '').trim();
}

// 「作品_蔽霄」→「蔽霄」；「我家老婆来自一千年前(1-399章)」→「我家老婆来自一千年前」
function normalizeWork(name) {
  return name.replace(/^作品_/, '').replace(/[(（][0-9]+[-–—][0-9]+章[)）]$/, '').trim();
}

function readUtf8(file) { return fs.readFileSync(file, 'utf8'); }

module.exports = {
  han, sha256, codePoints,
  EMBED_SAFE_LIMIT, VECTOR_CHUNK_SIZE, MAP_CHUNK_SIZE, MAP_CHUNK_STEP, L1_CHUNK_SIZE,
  slidingChunks, vectorChunks, l1Chunks, mapChunks,
  stripChapterTitles, paragraphsOf, CHAPTER_TITLE,
  readCorpus, normalizeAuthor, normalizeWork, readUtf8,
};
