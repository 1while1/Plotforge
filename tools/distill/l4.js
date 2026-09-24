'use strict';
/**
 * L4 入库：选样（select.js，纯代码）→ 卫生检查 → 写进卡片（`style_samples`）
 * + 给卡挂上源集引用（`style_packs.source_refs`）。
 *
 * 为什么要「入库」这一步（方案 §3.4.0 架构拍板）：
 * 运行时走表、不走向量——`providers/style.js` 不传 query，检索后端就是 `style_samples`
 * 按 `sort_order` 直出。所以**范文必须是蒸馏期一次性选好、静态写进表里的**，
 * 否则选样代码再准也没有消费者。
 *
 * —— 四条口径（都写在这里，免得日后靠猜）——
 * ① **范文一律用掩码后原句**（方案 §3.1.5 措施 4）：`〔人名〕` 形式保留进卡，
 *    不因含专名而放弃样本（零专名块仅 5.5%，放弃等于自废 few-shot）。
 * ② **入库前做卫生检查**（第 4 步验收项）：专名 0 残留 + 占位符只用四类 + 块长在嵌入边界内。
 *    不合格的样本**不入库**并计入报告——不是「检查了就算过」。
 * ③ **重跑幂等**：本 CLI 写入的样本 `source` 一律带 `distill/` 前缀，
 *    重跑时先删掉**自己上次写的**那批再写新的；卡上人工增删改的范文（source 不带前缀）**不动**。
 * ④ **源集引用裁决**（§3.4.1 四条边界）：词表版本不符 = 拒绝、源集不存在 = 悬空跳过，
 *    两者都告警；**绝不静默全库检索**，也绝不拿旧词表掩码的文本当新卡的范文。
 *    注：CLI 侧对「本卡自己的源集」默认**告警并刷新**（重跑就是修复动作本身），
 *    「拒绝」语义由 resolveSourceRefs 的三桶裁决提供，供运行时/未来接线方使用。
 *
 * 与 `cards.js` 的关系：卡片 CRUD 走 cards.js 是运行时契约；这里是离线批处理，
 * 需要 `content_hash` / `sort_order` / 按来源前缀做幂等替换，cards.addSample 不提供这三样，
 * 故**直写库**（方案 §4 接线表已注明「蒸馏 CLI 需直写库或先扩展 cards.js」）。
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const mask = require('./mask');
const select = require('./select');

const REPO_ROOT = path.resolve(__dirname, '../..');

/** 本 CLI 写入的样本来源前缀（幂等替换的识别位；人工范文不带此前缀）。 */
const SAMPLE_SOURCE_PREFIX = 'distill/';
/** 占位符白名单：与 mask.js 的四类一一对应（多一类或少一类都是契约破坏）。 */
const PLACEHOLDER_SET = new Set(Object.values(mask.PLACEHOLDERS));
/** 参与嵌入的样本必须 ≤500 字（§1.7④ 实测 510 字后静默截断；500 是向量域既有块尺度）。 */
const EMBED_SAFE = util.VECTOR_CHUNK_SIZE;

/** 选样理由 → 给人看的标签（卡片页上要能一眼看出这段为什么进来）。 */
const REASON_LABEL = {
  medoid: '典型', far: '多样',
  'shortest-sentence': '短句', 'longest-sentence': '长句', 'most-dialog': '对白',
};

/** 词典里的专名集合（卫生检查用：范文里不该再出现这些**字面**名字）。 */
function dictNameSet(dict) {
  const out = new Set();
  for (const e of (dict && dict.entries) || []) if (e && e.name) out.add(e.name);
  return out;
}

/**
 * 修掉被切片切坏的占位符（`〔人名〕` 被切成 `〔人` 或 `名〕`）。
 * 块是按 400 字滑窗切的，切点落在占位符中间是必然事件——留着它，范文里就会出现
 * 半个方括号，模型学到的就是错的格式。规则：左边界若以孤立的 `〕` 开头就砍到它为止，
 * 右边界若有未闭合的 `〔` 就砍掉。
 * @returns {{text:string, leftTrim:number}} leftTrim 用于同步修正 charStart 溯源
 */
function healPlaceholderEdges(text) {
  let t = String(text);
  let leftTrim = 0;
  const closeIdx = t.indexOf('〕');
  const openIdx = t.indexOf('〔');
  if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
    leftTrim = closeIdx + 1;
    t = t.slice(leftTrim);
  }
  const lastOpen = t.lastIndexOf('〔');
  if (lastOpen !== -1 && lastOpen > t.lastIndexOf('〕')) t = t.slice(0, lastOpen);
  return { text: t, leftTrim: leftTrim };
}

/**
 * 单条范文的卫生检查（第 4 步验收口径）。
 * @param {string} text 掩码后文本
 * @param {Set<string>} names 该作者词典的全部专名
 * @returns {{chars:number, placeholders:string[], illegal:string[], nameHits:string[], problems:string[], ok:boolean}}
 */
function sampleHygiene(text, names) {
  const s = String(text || '');
  const problems = [];
  const placeholders = [];
  const illegal = [];
  for (const m of s.match(/〔[^〕]*〕/g) || []) {
    placeholders.push(m);
    if (!PLACEHOLDER_SET.has(m)) illegal.push(m);
  }
  // 括号不配对 = 被切坏的占位符（regex 抓不到半截，必须单独判）
  const opens = (s.match(/〔/g) || []).length;
  const closes = (s.match(/〕/g) || []).length;
  if (opens !== closes) problems.push(`placeholder-unbalanced(${opens}:${closes})`);
  if (illegal.length) problems.push('placeholder-illegal');
  const nameHits = [];
  if (names && names.size) {
    for (const n of names) if (s.indexOf(n) !== -1) nameHits.push(n);
  }
  if (nameHits.length) problems.push('proper-name-leak');
  const chars = util.codePoints(s);
  if (chars > EMBED_SAFE) problems.push(`too-long(${chars}>${EMBED_SAFE})`);
  return { chars: chars, placeholders: placeholders, illegal: illegal, nameHits: nameHits, problems: problems, ok: problems.length === 0 };
}

/**
 * 源集引用裁决（§3.4.1 边界，纯函数）。
 * @param {Array} refs 卡的 source_refs：[{sourceId, maskDictVersion, generation}]
 * @param {Object} sourcesById { [id]: {author, mask_dict_version, dir_path} }（corpus_sources 行）
 * @returns {{usable:Array, refused:Array, dangling:Array}}
 *   refused = 词表版本不符（拿旧词表掩码的文本当新范文 → 必须拒绝）；
 *   dangling = 源集不存在（跳过该卡并记日志，**不得**退化成扫全库）。
 */
function resolveSourceRefs(refs, sourcesById) {
  const usable = [];
  const refused = [];
  const dangling = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const id = Number(r && (r.sourceId !== undefined ? r.sourceId : r.source_id));
    if (!Number.isFinite(id)) { dangling.push({ ref: r || null, reason: 'bad-source-id' }); continue; }
    const src = (sourcesById || {})[id];
    if (!src) { dangling.push({ sourceId: id, reason: 'source-not-found' }); continue; }
    const want = String((r && r.maskDictVersion) || '');
    const have = String(src.mask_dict_version || src.maskDictVersion || '');
    if (want && have && want !== have) {
      refused.push({ sourceId: id, refVersion: want, sourceVersion: have, reason: 'mask-dict-mismatch' });
      continue;
    }
    usable.push({
      sourceId: id, author: src.author,
      maskDictVersion: have, dirPath: src.dir_path || '',
      generation: Number((r && r.generation) || 0) || null,
    });
  }
  return { usable: usable, refused: refused, dangling: dangling };
}

/**
 * 选样结果 → `style_samples` 行（含卫生过滤与溯源）。
 * @returns {{rows:Array, rejected:Array}}
 */
function buildRows(samples, ctx) {
  const rows = [];
  const rejected = [];
  const names = ctx.names || new Set();
  samples.forEach((s, i) => {
    const healed = healPlaceholderEdges(s.text);
    const hy = sampleHygiene(healed.text, names);
    const row = {
      title: `${s.work}·${REASON_LABEL[s.reason] || s.reason}`,
      text: healed.text,
      source: `${SAMPLE_SOURCE_PREFIX}${ctx.author}/${s.work}#${s.charStart + healed.leftTrim}+${hy.chars}`,
      chars: hy.chars,
      sortOrder: i,
      reason: s.reason,
      cluster: s.cluster,
      textHash: util.sha256(healed.text),
      hygiene: hy,
    };
    if (!hy.ok) { rejected.push({ ...row, problems: hy.problems }); return; }
    rows.push(row);
  });
  return { rows: rows, rejected: rejected };
}

/** 建卡或取已存在的同名印记卡（一作家一卡，方案 §3.4.1 粒度定案）。 */
function findOrCreatePack(db, name) {
  const found = db.get("SELECT * FROM style_packs WHERE name = ? AND kind = 'imprint' ORDER BY id LIMIT 1", [name]);
  if (found) return { pack: found, created: false };
  const id = db.run(
    `INSERT INTO style_packs (name, kind, book_id, persona, profile_json, note, builtin, enabled)
     VALUES (?, 'imprint', NULL, '', '{}', '', 0, 1)`,
    [name]
  ).lastInsertRowid;
  return { pack: db.get('SELECT * FROM style_packs WHERE id = ?', [id]), created: true };
}

function parseRefs(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * 跑一位作者的 L4：掩码语料 → 选样 → 卫生 → 建卡/取卡 → 写范文 + 挂源集引用。
 *
 * @param {{corpusRoot:string, author:string, dataRoot?:string, db:Object, packName?:string,
 *          k?:number, seed?:number, log?:Function, write?:boolean, sourcesById?:Object}} o
 * @returns {{author, packId, created, rows, rejected, hygiene, refs, dictVersion, selection}}
 */
async function runL4(o) {
  if (!o || typeof o !== 'object' || !o.author || !o.db) {
    throw new Error('runL4: 参数必须是选项对象 { corpusRoot, author, db, ... }');
  }
  const dataRoot = o.dataRoot || REPO_ROOT;
  const log = o.log || (() => {});
  const write = o.write !== false;
  const author = o.author;
  const dict = mask.loadDict(author, dataRoot);
  const names = dictNameSet(dict);
  const dictVersion = dict.version || '';

  // 掩码口径与 map/l3 逐字一致：逐作品 stripChapterTitles → '\n' 连接 → maskText
  const files = util.readCorpus(o.corpusRoot).filter((f) => f.author === author);
  if (!files.length) throw new Error(`L4：语料 ${o.corpusRoot} 下没有 author=${author} 的文件`);
  const byWork = new Map();
  for (const f of files) {
    if (!byWork.has(f.work)) byWork.set(f.work, []);
    byWork.get(f.work).push(f);
  }
  const maskedFiles = [];
  for (const [work, wf] of byWork) {
    const text = wf.map((f) => util.stripChapterTitles(util.readUtf8(f.file))).join('\n');
    maskedFiles.push({ work: work, text: mask.maskText(text, dict) });
  }
  const selection = select.selectForAuthor({
    files: maskedFiles,
    k: Number.isInteger(o.k) ? o.k : undefined,
    seed: o.seed,
    skipNonNarrative: o.skipNonNarrative,
  });
  const built = buildRows(selection.samples, { author: author, names: names });
  const hygiene = {
    candidates: selection.samples.length,
    kept: built.rows.length,
    rejected: built.rejected.length,
    healedEdges: selection.samples.filter((s) => healPlaceholderEdges(s.text).leftTrim > 0).length,
    skippedNonNarrative: selection.skippedNonNarrative || 0,
    problems: built.rejected.reduce((acc, r) => {
      for (const p of r.problems) acc[p] = (acc[p] || 0) + 1;
      return acc;
    }, {}),
  };
  log(`[l4] ${author} 选样 ${selection.samples.length} 段（${selection.clusters} 簇 / ${selection.blocks} 块；` +
    `剔除非正文块 ${hygiene.skippedNonNarrative} 块）→ 卫生通过 ${built.rows.length} 段，剔除 ${built.rejected.length} 段，` +
    `总字量 ${built.rows.reduce((s, r) => s + r.chars, 0)} 字`);

  // 源集：corpus_sources 行由 fingerprint 命令登记；这里只读不建
  const sourcesById = o.sourcesById || (() => {
    const map = {};
    for (const row of o.db.all('SELECT id, author, mask_dict_version, dir_path FROM corpus_sources')) map[row.id] = row;
    return map;
  })();
  const mine = Object.values(sourcesById).find((s) => s.author === author) || null;

  const packName = o.packName || author;
  const { pack, created } = findOrCreatePack(o.db, packName);
  const refs = resolveSourceRefs(parseRefs(pack.source_refs), sourcesById);
  if (refs.refused.length) {
    for (const r of refs.refused) {
      log(`[l4] ⚠ 卡「${packName}」引用的源集 ${r.sourceId} 词表版本不符（卡 ${r.refVersion} ≠ 源集 ${r.sourceVersion}）：` +
        `拒绝沿用旧范文，按当前词表 ${dictVersion} 重选覆盖`);
    }
  }
  if (refs.dangling.length) {
    for (const d of refs.dangling) {
      // 悬空引用：**不参与本次选样**、记日志，但**保留在卡上**——
      // 它可能是别的作者、或源集只是暂时缺表（库被重置/语料搬过地方），
      // 清理动作不该被某位作者的重跑顺手做掉（那是数据丢失，不是「修正」）。
      log(`[l4] ⚠ 卡「${packName}」引用了不存在的源集（${d.sourceId || '非法 id'}）：` +
        '本次选样跳过该引用（不扩大到全库），卡上的记录保留供人工核查');
    }
  }
  if (!mine) {
    log(`[l4] ⚠ corpus_sources 里没有 author=${author} 的源集——请先跑 fingerprint 登记；卡暂不挂 source_refs`);
  }

  const result = {
    author: author, packId: pack.id, packName: packName, created: created,
    rows: built.rows, rejected: built.rejected, hygiene: hygiene,
    dictVersion: dictVersion,
    refs: refs,
    selection: {
      k: selection.k, clusters: selection.clusters, blocks: selection.blocks,
      iterations: selection.iterations, inertia: selection.inertia, clusterSizes: selection.clusterSizes,
    },
  };
  if (!write) return result;

  // 源集引用：保留别人的引用（含悬空的——见上方注释，不顺手清理），替换本作者这一条
  // （generation 每写一次 +1：卡上的范文是第几代是可追溯的）
  const others = parseRefs(pack.source_refs).filter((r) => !mine || Number(r && r.sourceId) !== Number(mine.id));
  const prevGen = Math.max(0, ...parseRefs(pack.source_refs)
    .filter((r) => mine && Number(r && r.sourceId) === Number(mine.id))
    .map((r) => Number(r.generation) || 0));
  const newRefs = mine
    ? others.concat([{ sourceId: mine.id, maskDictVersion: dictVersion, generation: prevGen + 1 }])
    : others;
  o.db.run("UPDATE style_packs SET source_refs = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [JSON.stringify(newRefs), pack.id]);

  // 范文替换：只删自己上次写的那批（人工范文不动）
  const deleted = o.db.run('DELETE FROM style_samples WHERE pack_id = ? AND source LIKE ?',
    [pack.id, SAMPLE_SOURCE_PREFIX + '%']).changes;
  for (const r of built.rows) {
    o.db.run(
      `INSERT INTO style_samples (pack_id, title, text, source, char_count, sort_order, enabled, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [pack.id, r.title, r.text, r.source, r.chars, r.sortOrder, r.textHash]
    );
  }
  result.deleted = deleted;
  result.written = built.rows.length;
  result.sourceRefs = newRefs;
  log(`[l4] ${author} → 卡 #${pack.id}「${packName}」写入 ${built.rows.length} 段范文（覆盖旧 ${deleted} 段）` +
    (newRefs.length ? `，source_refs=${JSON.stringify(newRefs)}` : ''));
  return result;
}

module.exports = {
  REPO_ROOT, SAMPLE_SOURCE_PREFIX, PLACEHOLDER_SET, EMBED_SAFE, REASON_LABEL,
  dictNameSet, healPlaceholderEdges, sampleHygiene, resolveSourceRefs,
  buildRows, findOrCreatePack, parseRefs, runL4,
};
