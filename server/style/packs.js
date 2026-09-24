// 作家卡域模块：卡解析 / 规则查询 / 注入文本编译。
//
// 机制与数据的边界（委托方「不能十分耦合」的落地）：本文件只提供**机制**——
// 卡怎么选、规则怎么编译成注入文本；具体卡片内容一律是数据
// （style_packs / style_rules / style_samples / book_style_packs 四张表）。
// 新增一张作家卡 = 插数据，不改代码。
//
// 术语：一张「作家卡」= style_packs 一行（人设 persona + 指纹 profile_json）
//                    + style_rules（规则条目）+ style_samples（范文段落）。
const db = require('../db');
const retrieve = require('./retrieve');

const KINDS = ['basic', 'preset', 'imprint'];
const ROLES = ['main', 'aux'];

function parseJsonSafe(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch { return fallback; }
}

function toPack(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    bookId: row.book_id,
    persona: row.persona || '',
    profile: parseJsonSafe(row.profile_json, {}),
    sourceRefs: parseJsonSafe(row.source_refs, []),
    builtin: Boolean(row.builtin),
    enabled: Boolean(row.enabled),
    note: row.note,
  };
}

function toRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    packId: row.pack_id,
    category: row.category,
    title: row.title,
    trigger: row.trigger,
    rule: row.rule,
    good: row.good,
    bad: row.bad,
    severity: row.severity,
    source: row.source,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
  };
}

// 内置卡（去 AI 味通用卡）。找不到就返回 null —— 调用方据此走「无风格层」分支。
function basicPack() {
  const row = db.get("SELECT * FROM style_packs WHERE builtin = 1 AND kind = 'basic' AND enabled = 1 ORDER BY id LIMIT 1");
  return toPack(row);
}

function getPack(id) {
  return toPack(db.get('SELECT * FROM style_packs WHERE id = ?', [id]));
}

function listPacks(opts) {
  const o = opts || {};
  const rows = db.all(
    `SELECT * FROM style_packs
      ${Number.isFinite(o.bookId) ? 'WHERE (book_id = ? OR book_id IS NULL)' : ''}
      ORDER BY enabled DESC, builtin DESC, id`,
    Number.isFinite(o.bookId) ? [o.bookId] : []
  );
  return rows.map(toPack);
}

// 某本书的绑定（主卡 + 辅卡），按角色与排序返回。
// 只返回**启用**的卡：停用一张卡即时生效，不需要解绑（可热插拔的关键）。
function bindingsForBook(bookId) {
  if (!Number.isFinite(bookId)) return { main: null, aux: [] };
  const rows = db.all(
    `SELECT p.*, b.role AS _role, b.sort_order AS _sort
       FROM book_style_packs b
       JOIN style_packs p ON p.id = b.pack_id
      WHERE b.book_id = ? AND b.enabled = 1 AND p.enabled = 1
      ORDER BY CASE b.role WHEN 'main' THEN 0 ELSE 1 END, b.sort_order, p.id`,
    [bookId]
  );
  return {
    main: toPack(rows.find(r => r._role === 'main')) || null,
    aux: rows.filter(r => r._role === 'aux').map(toPack),
  };
}

/**
 * 解析一本书实际生效的作家卡（主卡 + 辅卡）。
 *
 * 主卡优先级：绑定表里的主卡 > 本书专属卡（style_packs.book_id 命中）> 内置通用卡。
 * 辅卡：绑定表里 role='aux' 的全部卡，按 sort_order。
 * 任何一步失败都退到下一级，最终可能 main=null（= 无风格层，行为退回今天的状态）。
 *
 * @returns {{main:object|null, aux:object[], source:'bound'|'own'|'basic'|'none', chain:object[]}}
 *   chain = [主卡, ...辅卡]，即编译时的实际叠加顺序（主卡永远第一，它的同名规则赢）
 */
function resolveForBook(bookId) {
  const bound = bindingsForBook(bookId);
  if (bound.main) {
    return { main: bound.main, aux: bound.aux, source: 'bound', chain: [bound.main, ...bound.aux] };
  }
  // 绑定表无主卡：本书专属卡顶上（作者印记蒸馏产物走这条），辅卡照旧叠加
  if (Number.isFinite(bookId)) {
    const own = db.get('SELECT * FROM style_packs WHERE book_id = ? AND enabled = 1 ORDER BY id LIMIT 1', [bookId]);
    if (own) {
      const main = toPack(own);
      return { main, aux: bound.aux, source: 'own', chain: [main, ...bound.aux] };
    }
  }
  const basic = basicPack();
  if (!basic) return { main: null, aux: bound.aux, source: 'none', chain: [...bound.aux] };
  // 内置卡已在辅卡里就不重复叠加（用户显式把通用卡当辅卡绑定时会出现）
  const aux = bound.aux.filter(p => p.id !== basic.id);
  return { main: basic, aux, source: 'basic', chain: [basic, ...aux] };
}

function listRules(packId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM style_rules WHERE pack_id = ?';
  const params = [packId];
  if (o.enabledOnly !== false) sql += ' AND enabled = 1';
  if (o.severity) { sql += ' AND severity = ?'; params.push(o.severity); }
  sql += ' ORDER BY sort_order, id';
  return db.all(sql, params).map(toRule);
}

// 指纹键顺序：先立场、再句子、再用词……最后是警示语（收尾用最重的一句压轴）
const PROFILE_ORDER = ['stance', 'sentence', 'diction', 'psychology', 'dialogue', 'narrative', 'warning'];

function profileLines(pack) {
  const out = [];
  const p = pack.profile || {};
  for (const key of PROFILE_ORDER) {
    if (typeof p[key] === 'string' && p[key].trim()) out.push(p[key].trim());
  }
  // 指纹里没有的键（未来卡自定义）也带上，避免数据写了不生效
  for (const key of Object.keys(p)) {
    if (PROFILE_ORDER.includes(key)) continue;
    if (typeof p[key] === 'string' && p[key].trim()) out.push(p[key].trim());
  }
  return out;
}

/**
 * 把一张或多张作家卡编译成注入系统提示词的文本（四节：人设指纹 / 硬线 / 技法参考 / 范文）：
 *   ① 人设与文风指纹——常驻，短而硬，不问条件一律生效；
 *   ② 硬线规则（must）全文——常驻，这些是「碰了就错」的硬线，不能等到命中才讲；
 *   ③ 技法参考（normal/hint）全文——同样常驻，但标题就写明「按情境判断，不要逐条套用」；
 *   ④ 范文段落（有语料时才有）——教语感，按额度挑选，整段进整段出。
 *
 * 为什么 ②③ 都全文注入（2026-09-12 修正原设计）：原先把 ③ 压成一行目录，引用的是
 * 手册「技巧无节制运用会变成新的 AI 味」这条警告。但那是**整本手册（15065 汉字）**尺度的警告，
 * 套到 31 条规则上不成立——31 条全量展开约 3650 字符，占 12000 预算 30%（≈3600 token，
 * 占全局预算 1.8%），省下的 800 字符毫无意义，代价却是 14 条规则完全失效（只看到标题，
 * 且当时并无任何工具能读到正文）。防「模板泛滥」的防线应该在**数据层**（只给「对就是对」的
 * 语言选择题配 good 正例，情感细节类一律只给 bad 反例）与**语义标签**（「技法参考」这个小标题
 * 本身就是给模型的指令），而不是把正文藏起来。
 *
 * 多卡叠加的冲突规则：**同名规则以主卡为准**（主卡在前，先到先得）。
 * 规则按 title 去重而不是按 id——不同卡的规则由不同卡片作者命名，
 * 标题就是「这条讲的是什么」的唯一约定，同名即同一条。
 *
 * @param {number|number[]} packIds 单卡 id 或卡链（[主卡, ...辅卡]）
 * @param {{maxChars?:number, query?:string, includeSamples?:boolean}} [opts]
 *   结果超限时按 ④③②① 的逆序丢弃（范文 → 技法参考 → 硬线），保证人设与指纹优先存活。
 *   额度按**字符（码点）**计；默认 12000 与 STYLE_BUDGET_CHARS 一致（容 10000 汉字 + 结构余量）。
 * @returns {string} 无规则时返回空串（调用方据此跳过本节）
 */
function compileCardsText(packIds, opts) {
  const o = opts || {};
  const maxChars = Number.isFinite(o.maxChars) ? o.maxChars : 12000;
  const ids = (Array.isArray(packIds) ? packIds : [packIds]).filter(Number.isFinite);
  const packs = ids.map(getPack).filter(p => p && p.enabled);
  if (!packs.length) return '';

  const names = packs.map(p => p.name).join(' + ');
  const lines = [`【文风约束 · ${names}】`];

  // ① 人设与指纹（每张卡一段，标出卡名；单卡时不标，省得啰嗦）
  const multi = packs.length > 1;
  for (const pack of packs) {
    const block = [];
    if (typeof pack.persona === 'string' && pack.persona.trim()) block.push(pack.persona.trim());
    block.push(...profileLines(pack));
    if (!block.length) continue;
    if (multi) lines.push(`〔${pack.name}〕`);
    lines.push(...block);
  }

  // ② must 规则：跨卡合并，同名以先到者（主卡）为准
  const seen = new Map();
  for (const pack of packs) {
    for (const r of listRules(pack.id)) {
      if (seen.has(r.title)) continue;
      seen.set(r.title, r);
    }
  }
  const all = [...seen.values()];
  const must = all.filter(r => r.severity === 'must' && r.rule);
  if (must.length) {
    lines.push('');
    lines.push('【硬线规则（不可违反）】');
    must.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}：${r.rule}`);
      if (r.bad) lines.push(`   ✗ 反面：${r.bad}`);
      if (r.good) lines.push(`   ✓ 正面：${r.good}`);
    });
  }

  // ③ 其余规则：**同样全文注入**，但换一个语义标签。
  //
  // 【为什么这里不再是「只出一行目录」】原设计把非 must 规则藏进目录，理由是手册警告
  // 「消除 AI 味的技巧无节制运用本身会变成新的 AI 味」。但那是**整个手册（15065 汉字）**尺度上的
  // 警告，套到 31 条规则上不成立：实测 31 条全量展开仅约 3650 字符，占 12000 预算的 30%
  // （≈3600 token，占全局预算 1.8%），藏起来省下的 800 字符毫无意义，代价却是 14 条规则
  // **完全失效**——目录里只有标题，而当时又没有任何工具能让模型读到正文。
  //
  // 真正防「模板泛滥」的防线在数据层，不在注入层：本卡 31 条里只有 2 条给了 good 正例
  // （动词精准、拒绝书面腔这类「对就是对」的语言选择题），情感细节类**一律只给 bad 反例**
  // ——「咬下唇、肩膀抖动」那套之所以会泛滥，是因为它作为正面范例出现在素材里，拆条时已挡在门外。
  // 剩下的风险用**语义标签**兜：「技法参考」这个小标题本身就是给模型的指令（参考而非逐条套用），
  // 比把正文藏起来更直接——手册那句警告本来就是要说给模型听的。
  //
  // 分级（severity）因此改义：must = 硬线，一犯就露馅；normal/hint = 技法，按情境判断。
  // 两者都全文进提示词，区别在**标题语义**与**降级时的存活顺序**。
  const rest = all.filter(r => r.severity !== 'must' && r.rule);
  if (rest.length) {
    lines.push('');
    lines.push('【技法参考（按情境判断，不要逐条套用）】');
    rest.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}：${r.rule}`);
      if (r.bad) lines.push(`   ✗ 反面：${r.bad}`);
      if (r.good) lines.push(`   ✓ 正面：${r.good}`);
    });
  }

  // ④ 范文：有语料才出这一节（没有就不占位置，不留空壳标题）
  const sampleLines = [];
  if (o.includeSamples !== false) {
    const samples = retrieve.selectSamples(packs.map(p => p.id), { query: o.query });
    if (samples.length) {
      sampleLines.push('');
      sampleLines.push('【范文参照（学习语感，不要照抄内容或句式）】');
      samples.forEach((s, i) => {
        sampleLines.push(`例 ${i + 1}${s.title ? ` · ${s.title}` : ''}：`);
        sampleLines.push(s.text);
      });
    }
  }
  lines.push(...sampleLines);

  // 超限降级：范文 → 技法参考 → 硬线细则 → 只留人设与指纹
  let text = lines.join('\n');
  if (text.length <= maxChars) return text;

  const idxOf = (marker) => lines.findIndex(l => l === marker);
  const upTo = (marker) => {
    const i = idxOf(marker);
    return lines.slice(0, i === -1 ? lines.length : i);
  };
  const sampleStart = idxOf('【范文参照（学习语感，不要照抄内容或句式）】');
  const withoutSamples = (sampleStart === -1 ? lines : lines.slice(0, sampleStart)).join('\n');
  if (withoutSamples.length <= maxChars) return withoutSamples;

  const restStart = idxOf('【技法参考（按情境判断，不要逐条套用）】');
  const withoutRest = (restStart === -1 ? lines : lines.slice(0, restStart)).join('\n');
  if (withoutRest.length <= maxChars) return withoutRest;

  return upTo('【硬线规则（不可违反）】').join('\n').slice(0, maxChars);
}

// 单卡便捷入口（预览、测试、单卡场景）
function compilePackText(packId, opts) {
  return compileCardsText([packId], opts);
}

module.exports = {
  KINDS, ROLES,
  toPack, toRule,
  basicPack, getPack, listPacks, bindingsForBook, resolveForBook, listRules,
  compileCardsText, compilePackText,
};
