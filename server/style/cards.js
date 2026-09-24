// 作家卡 · 写侧：建卡 / 改卡 / 删卡 / 换绑（可热插拔的落地）。
//
// 为什么单独一个文件：packs.js 是**读侧**（解析与编译，注入路径上跑，要求快且无副作用），
// 本文件是**写侧**（UI 与管理接口用），两者生命周期完全不同。
// 混在一起的话，注入路径会和 CRUD 校验纠缠，任何一次参数校验改动都在动热路径。
//
// 热插拔的三条保证：
//   ① 换卡只写 book_style_packs 一行，下一轮对话立即生效——编译路径无任何缓存（已核实
//      context/index.js 每次 assemble 都重新 build），改完不需要重启、不需要清缓存；
//   ② 停用一张卡（enabled=0）即时从卡链里消失，不需要解绑；
//   ③ 删卡由外键级联带走规则/范文/绑定，不留悬空引用。
const db = require('../db');
const packs = require('./packs');

const SEVERITIES = ['must', 'normal', 'hint'];

function nowIso() { return new Date().toISOString(); }

function cleanStr(v, max) {
  const s = v === undefined || v === null ? '' : String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

// 卡片内容指纹：用于「这张卡改过没有」的判读，不做校验用（校验靠字段级规则）
function cardStats(packId) {
  const rules = db.get('SELECT COUNT(*) AS n FROM style_rules WHERE pack_id = ?', [packId]).n;
  const must = db.get("SELECT COUNT(*) AS n FROM style_rules WHERE pack_id = ? AND severity = 'must'", [packId]).n;
  const samples = db.get('SELECT COUNT(*) AS n FROM style_samples WHERE pack_id = ?', [packId]).n;
  return { rules, must, samples };
}

/**
 * 建卡。校验只挡「结构上不可能成立」的输入，不挡内容——
 * 风格好不好是作者的事，代码不该替作者判断。
 */
function createPack(input) {
  const b = input || {};
  const name = cleanStr(b.name, 80).trim();
  if (!name) { const e = new Error('卡名必填'); e.status = 400; throw e; }
  const kind = packs.KINDS.includes(b.kind) ? b.kind : 'preset';
  const profile = b.profile && typeof b.profile === 'object' ? b.profile : {};
  const persona = cleanStr(b.persona, 4000);
  const note = cleanStr(b.note, 500);
  const bookId = Number.isFinite(Number(b.bookId)) && b.bookId !== null && b.bookId !== '' ? Number(b.bookId) : null;
  // 内置位不可由接口设置：builtin=1 的卡是代码资产，混进 UI 会被后续迁移覆盖
  const id = db.run(
    `INSERT INTO style_packs (name, kind, book_id, persona, profile_json, note, builtin, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
    [name, kind, bookId, persona, JSON.stringify(profile), note]
  ).lastInsertRowid;
  return packs.getPack(id);
}

function updatePack(id, patch) {
  const pack = packs.getPack(id);
  if (!pack) { const e = new Error('卡不存在'); e.status = 404; throw e; }
  const b = patch || {};
  const sets = [];
  const params = [];
  if (b.name !== undefined) {
    const name = cleanStr(b.name, 80).trim();
    if (!name) { const e = new Error('卡名不能为空'); e.status = 400; throw e; }
    sets.push('name = ?'); params.push(name);
  }
  if (b.persona !== undefined) { sets.push('persona = ?'); params.push(cleanStr(b.persona, 4000)); }
  if (b.note !== undefined) { sets.push('note = ?'); params.push(cleanStr(b.note, 500)); }
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
  if (b.profile !== undefined) {
    const profile = b.profile && typeof b.profile === 'object' ? b.profile : {};
    sets.push('profile_json = ?'); params.push(JSON.stringify(profile));
  }
  if (b.kind !== undefined) {
    if (!packs.KINDS.includes(b.kind)) { const e = new Error('卡类型无效'); e.status = 400; throw e; }
    sets.push('kind = ?'); params.push(b.kind);
  }
  if (!sets.length) return pack;
  sets.push('updated_at = ?'); params.push(nowIso());
  params.push(id);
  db.run(`UPDATE style_packs SET ${sets.join(', ')} WHERE id = ?`, params);
  return packs.getPack(id);
}

// 删卡：规则/范文/绑定由外键级联带走（迁移 019/021 建表时已声明 ON DELETE CASCADE）
function deletePack(id) {
  const pack = packs.getPack(id);
  if (!pack) return false;
  if (pack.builtin) { const e = new Error('内置卡不可删除，可停用或改名另存'); e.status = 400; throw e; }
  db.run('DELETE FROM style_packs WHERE id = ?', [id]);
  return true;
}

// ---- 规则条目 ----

function addRule(packId, input) {
  const pack = packs.getPack(packId);
  if (!pack) { const e = new Error('卡不存在'); e.status = 404; throw e; }
  const b = input || {};
  const title = cleanStr(b.title, 60).trim();
  const rule = cleanStr(b.rule, 2000).trim();
  if (!title) { const e = new Error('规则标题必填'); e.status = 400; throw e; }
  if (!rule) { const e = new Error('规则正文必填'); e.status = 400; throw e; }
  const severity = SEVERITIES.includes(b.severity) ? b.severity : 'normal';
  const sort = Number.isFinite(Number(b.sortOrder))
    ? Number(b.sortOrder)
    : (db.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM style_rules WHERE pack_id = ?', [packId]).n);
  const id = db.run(
    `INSERT INTO style_rules (pack_id, category, title, trigger, rule, good, bad, severity, source, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      packId, cleanStr(b.category, 20).trim() || '通用', title, cleanStr(b.trigger, 200),
      rule, cleanStr(b.good, 1000), cleanStr(b.bad, 1000), severity, cleanStr(b.source, 200), sort,
    ]
  ).lastInsertRowid;
  return packs.toRule(db.get('SELECT * FROM style_rules WHERE id = ?', [id]));
}

function updateRule(ruleId, patch) {
  const b = patch || {};
  const row = db.get('SELECT * FROM style_rules WHERE id = ?', [ruleId]);
  if (!row) { const e = new Error('规则不存在'); e.status = 404; throw e; }
  const sets = [];
  const params = [];
  if (b.title !== undefined) {
    const title = cleanStr(b.title, 60).trim();
    if (!title) { const e = new Error('规则标题不能为空'); e.status = 400; throw e; }
    sets.push('title = ?'); params.push(title);
  }
  if (b.rule !== undefined) { sets.push('rule = ?'); params.push(cleanStr(b.rule, 2000)); }
  if (b.severity !== undefined) {
    if (!SEVERITIES.includes(b.severity)) { const e = new Error('分级只能是 must/normal/hint'); e.status = 400; throw e; }
    sets.push('severity = ?'); params.push(b.severity);
  }
  for (const [key, col, max] of [['category', 'category', 20], ['trigger', 'trigger', 200],
    ['good', 'good', 1000], ['bad', 'bad', 1000], ['source', 'source', 200]]) {
    if (b[key] !== undefined) { sets.push(`${col} = ?`); params.push(cleanStr(b[key], max)); }
  }
  if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) {
    sets.push('sort_order = ?'); params.push(Number(b.sortOrder));
  }
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
  if (!sets.length) return packs.toRule(row);
  sets.push('updated_at = ?'); params.push(nowIso());
  params.push(ruleId);
  db.run(`UPDATE style_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  return packs.toRule(db.get('SELECT * FROM style_rules WHERE id = ?', [ruleId]));
}

function deleteRule(ruleId) {
  const row = db.get('SELECT id FROM style_rules WHERE id = ?', [ruleId]);
  if (!row) return false;
  db.run('DELETE FROM style_rules WHERE id = ?', [ruleId]);
  return true;
}

// ---- 范文段落 ----

function addSample(packId, input) {
  const pack = packs.getPack(packId);
  if (!pack) { const e = new Error('卡不存在'); e.status = 404; throw e; }
  const b = input || {};
  const text = cleanStr(b.text, 20000).trim();
  if (!text) { const e = new Error('范文正文必填'); e.status = 400; throw e; }
  const sort = Number.isFinite(Number(b.sortOrder))
    ? Number(b.sortOrder)
    : (db.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM style_samples WHERE pack_id = ?', [packId]).n);
  const id = db.run(
    `INSERT INTO style_samples (pack_id, title, text, source, char_count, sort_order, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, '')`,
    [packId, cleanStr(b.title, 100), text, cleanStr(b.source, 200), Array.from(text).length, sort]
  ).lastInsertRowid;
  return retrieve0(id);
}

function retrieve0(id) {
  const retrieve = require('./retrieve');
  return retrieve.toSample(db.get('SELECT * FROM style_samples WHERE id = ?', [id]));
}

function updateSample(sampleId, patch) {
  const row = db.get('SELECT * FROM style_samples WHERE id = ?', [sampleId]);
  if (!row) { const e = new Error('范文不存在'); e.status = 404; throw e; }
  const b = patch || {};
  const sets = [];
  const params = [];
  if (b.title !== undefined) { sets.push('title = ?'); params.push(cleanStr(b.title, 100)); }
  if (b.source !== undefined) { sets.push('source = ?'); params.push(cleanStr(b.source, 200)); }
  if (b.text !== undefined) {
    const text = cleanStr(b.text, 20000).trim();
    if (!text) { const e = new Error('范文正文不能为空'); e.status = 400; throw e; }
    sets.push('text = ?'); params.push(text);
    sets.push('char_count = ?'); params.push(Array.from(text).length);
    // 正文变了 → 旧向量作废（宁可退回直出，也不要拿旧向量匹配新文本）
    sets.push('vector = NULL'); sets.push('vector_model = ?'); params.push('');
    sets.push('indexed_at = NULL');
  }
  if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) {
    sets.push('sort_order = ?'); params.push(Number(b.sortOrder));
  }
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
  if (!sets.length) return retrieve0(sampleId);
  sets.push('updated_at = ?'); params.push(nowIso());
  params.push(sampleId);
  db.run(`UPDATE style_samples SET ${sets.join(', ')} WHERE id = ?`, params);
  return retrieve0(sampleId);
}

function deleteSample(sampleId) {
  const row = db.get('SELECT id FROM style_samples WHERE id = ?', [sampleId]);
  if (!row) return false;
  db.run('DELETE FROM style_samples WHERE id = ?', [sampleId]);
  return true;
}

// ---- 绑定（换卡即热插拔）----

/**
 * 给书换卡。整体替换而不是增量修改：调用方传来的是「这本书现在该用哪套卡」的完整意图，
 * 分步增删会让 UI 与后端状态在并发点击下不一致。
 * @param {object[]} bindings [{packId, role:'main'|'aux', sortOrder?}]
 */
function setBookBindings(bookId, bindings) {
  if (!Number.isFinite(bookId)) { const e = new Error('book_id 无效'); e.status = 400; throw e; }
  const list = (bindings || []).map((b, i) => ({
    packId: Number(b.packId),
    role: packs.ROLES.includes(b.role) ? b.role : 'aux',
    sortOrder: Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : i,
  })).filter(b => Number.isFinite(b.packId));

  const mains = list.filter(b => b.role === 'main');
  if (mains.length > 1) { const e = new Error('一本书只能有一张主卡'); e.status = 400; throw e; }
  const ids = list.map(b => b.packId);
  if (new Set(ids).size !== ids.length) { const e = new Error('同一张卡不能重复绑定'); e.status = 400; throw e; }
  for (const b of list) {
    if (!packs.getPack(b.packId)) { const e = new Error(`卡 #${b.packId} 不存在`); e.status = 400; throw e; }
  }

  db.run('DELETE FROM book_style_packs WHERE book_id = ?', [bookId]);
  for (const b of list) {
    db.run(
      `INSERT INTO book_style_packs (book_id, pack_id, role, sort_order, enabled)
       VALUES (?, ?, ?, ?, 1)`,
      [bookId, b.packId, b.role, b.sortOrder]
    );
  }
  // books.style_pack_id 同步为主卡镜像（历史列，兼容旧读法；读路径已统一走绑定表）
  db.run('UPDATE books SET style_pack_id = ? WHERE id = ?', [mains.length ? mains[0].packId : null, bookId]);
  return packs.bindingsForBook(bookId);
}

module.exports = {
  SEVERITIES,
  createPack, updatePack, deletePack, cardStats,
  addRule, updateRule, deleteRule,
  addSample, updateSample, deleteSample,
  setBookBindings,
};
