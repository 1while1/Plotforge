// 整册备份与回收站（方向报告 3.4）：删书硬删级联清空全部作品数据且无回收站，
// 对「百万字资产」保护等级完全不匹配。方案：删除前自动导出全书 JSON 到
// data/backups/（保留 30 天），恢复时按原 id 整册回插并补建向量索引。
// 向量 BLOB 不进备份（体积大且可由定稿正文重建），恢复后 indexBookMissing 补建。
//
// 备份版本 2（S1-07/C12）：book_style_packs 随删书级联消失而旧备份不含它，
// 恢复后正文都在、作家卡绑定全丢（回落默认卡）。v2 备份附带 style 节：
// bindings = 本书绑定行原样快照；packs = 引用卡的 manifest 快照（含规则与范文文本，
// 不含向量 BLOB）。恢复策略：卡是全局共享资产——存在则只回绑定行（绝不改写卡内容，
// 不覆盖其他书正在用的卡）；已删的卡算依赖缺失，默认整单拒绝，作者在预览里
// 显式选择「仍要恢复」才落部分绑定并逐项报告缺失。旧版 v1 备份没有 style 节：
// 正文照常恢复，但预览与结果必须明确列出「作家卡绑定」不可恢复，不许静默。
const fs = require('fs');
const path = require('path');
const db = require('./db');

const RETENTION_DAYS = 30;
// 备份版本 3（S3-01）：新增 conversations/conversation_summaries 两表（仅书内会话，
// global 不入书备份）；messages 行带 conversation_id 与 tool_facts_json。旧版（v1/v2）
// 备份的 messages 没有 conversation_id——恢复时按书归入补建的 legacy 会话，不留孤儿。
// 备份版本 4（S4-04a）：新增 planning_notes / handoffs 两表（规划笔记与交接草案随书
// 导出）。旧版（v1/v2/v3）备份没有这两节：恢复时无交接可回插，不算依赖缺失。
const BACKUP_VERSION = 4;

// 依赖序（先父后子）。scope 运行时自判：表有 book_id 列直接按书过滤；
// 否则按 parent 表已导出的主键集过滤（chapter_versions/advisor_citations/advisor_adoptions）。
const TABLES = [
  { table: 'volumes' },
  { table: 'chapters' },
  { table: 'characters' },
  { table: 'character_aliases' },
  { table: 'state_field_definitions' },
  { table: 'relation_type_definitions' },
  { table: 'character_relations' },
  { table: 'chapter_recycle' },
  { table: 'agent_runs' },
  { table: 'agent_run_events', parent: 'agent_runs', fk: 'run_id' },
  { table: 'run_read_evidence', parent: 'agent_runs', fk: 'run_id' },
  // 会话按 book_id 过滤：global 会话（book_id NULL）不级联进任何书的备份；
  // conversation_summaries 无 book_id 列，按已导出会话的 TEXT 主键集过滤（须排在 conversations 之后、messages 之前）。
  { table: 'conversations' },
  { table: 'conversation_summaries', parent: 'conversations', fk: 'conversation_id' },
  // S4-04a：规划笔记与交接草案同属书内创作资产（须排在 conversations 之后）。
  //   planning_notes 按 book_id 过滤（global 讨论里的笔记 book_id 为 NULL，不入任何书备份）；
  //   handoffs 同样按 book_id（= 目标书）过滤——origin_conversation_id 可能是 global 会话，
  //   故该列有意无外键：本书恢复后来源 id 原样保留（只作审计痕迹，不再参与校验）。
  { table: 'planning_notes' },
  { table: 'handoffs' },
  { table: 'chapter_versions', parent: 'chapters', fk: 'chapter_id' },
  { table: 'story_events' },
  { table: 'story_event_changes' },
  { table: 'character_state_values' },
  { table: 'story_threads' },
  { table: 'story_thread_characters' },
  { table: 'story_state' },
  { table: 'world_entries' },
  { table: 'messages' },
  { table: 'event_proposals' },
  { table: 'event_proposal_changes' },
  { table: 'proposal_revisions' },
  { table: 'advisor_sessions' },
  { table: 'advisor_suggestions' },
  { table: 'advisor_citations', parent: 'advisor_suggestions', fk: 'suggestion_id' },
  { table: 'advisor_adoptions', parent: 'advisor_suggestions', fk: 'suggestion_id' },
  { table: 'polish_history' },
  { table: 'chapter_extraction_runs' },
  { table: 'projection_watermarks' },
  { table: 'sidebar_preferences' },
];

const columnCache = new Map();

function tableColumns(table) {
  if (!columnCache.has(table)) {
    const rows = db.all(`PRAGMA table_info(${table})`);
    columnCache.set(table, rows.map(r => r.name));
  }
  return columnCache.get(table);
}

function selectBookRows(def, bookId, exported) {
  const cols = tableColumns(def.table);
  if (cols.includes('book_id')) {
    return db.all(`SELECT * FROM ${def.table} WHERE book_id = ?`, [bookId]);
  }
  const parentIds = (exported[def.parent] || []).map(r => r.id).filter(v => v !== null && v !== undefined);
  if (!parentIds.length) return [];
  const marks = parentIds.map(() => '?').join(',');
  return db.all(`SELECT * FROM ${def.table} WHERE ${def.fk} IN (${marks})`, parentIds);
}

function backupsDir() {
  return path.join(path.dirname(db.getFilePath()), 'backups');
}

// G4-P2-1：标题字符规则单一事实源——导出侧替换与取用侧校验共用同一禁集，防止再漂移。
// 禁集 = Windows 非法文件名字符 + 空白 + 控制字符；取用侧标题段接受禁集之外的一切字符
// （全角标点如「，·」的历史备份由此重新可见/可恢复），仍排除路径分隔符，dirname 双保险保留。
const TITLE_FORBIDDEN_SRC = '\\u0000-\\u001f\\u007f\\\\/:*?"<>|\\s';
const BACKUP_NAME_RE = new RegExp('^book-(\\d+)-[^' + TITLE_FORBIDDEN_SRC + ']+?-(\\d{8})-(\\d{6})\\.json$');

function sanitizeTitle(title) {
  const safe = String(title || '未命名').replace(new RegExp('[' + TITLE_FORBIDDEN_SRC + ']+', 'g'), '_').slice(0, 24);
  return safe || '未命名';
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeBackupPath(file) {
  const name = String(file || '');
  // 只接受本目录内的纯文件名，杜绝路径穿越
  if (!BACKUP_NAME_RE.test(name)) return null;
  const dir = backupsDir();
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return null;
  return full;
}

function exportBookBackup(bookId) {
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  if (!book) return null;
  const exported = {};
  const data = {
    version: BACKUP_VERSION,
    kind: 'book-backup',
    exported_at: new Date().toISOString(),
    book,
    tables: exported,
    style: exportStyleSection(Number(bookId)),
  };
  for (const def of TABLES) {
    const rows = selectBookRows(def, Number(bookId), exported);
    if (rows.length) exported[def.table] = rows;
  }
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `book-${book.id}-${sanitizeTitle(book.title)}-${stamp()}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  const purged = purgeOldBackups();
  return { file, rows: Object.values(exported).reduce((n, rows) => n + rows.length, 0), purged };
}

// ---- 作家卡绑定（v2 备份的 style 节）----

// 快照引用卡：manifest（识别用）+ 规则 + 范文文本。向量 BLOB 不进 JSON
// （style_samples 的向量列当前只建不写，且向量可由文本重建，见迁移 021）。
function exportStyleSection(bookId) {
  const bindings = db.all('SELECT * FROM book_style_packs WHERE book_id = ?', [bookId]);
  if (!bindings.length) return { bindings: [], packs: [] };
  const packIds = [...new Set(bindings.map(b => b.pack_id))];
  const packRows = packIds
    .map(id => db.get('SELECT * FROM style_packs WHERE id = ?', [id]))
    .filter(Boolean);
  const packsSnap = packRows.map(row => ({
    ...row,
    rules: db.all('SELECT * FROM style_rules WHERE pack_id = ?', [row.id]),
    samples: db.all(
      `SELECT id, pack_id, title, text, source, char_count, sort_order, enabled,
              content_hash, vector_model, indexed_at, created_at, updated_at
         FROM style_samples WHERE pack_id = ?`,
      [row.id]
    ),
  }));
  return { bindings, packs: packsSnap };
}

function snapshotPackName(data, packId) {
  const snap = data.style && Array.isArray(data.style.packs)
    ? data.style.packs.find(p => p.id === packId)
    : null;
  return snap ? snap.name : `卡 #${packId}`;
}

/**
 * 恢复计划：绑定的卡哪些还在（可回绑定行）、哪些已删（依赖缺失）。
 * v1 旧备份无 style 节 → legacy，绑定列入不可恢复项。
 */
function styleRestorePlan(data) {
  if (!data.style || !Array.isArray(data.style.bindings)) {
    return { legacy: true, bindings: [], missing: [], unavailable: ['作家卡绑定（主卡/辅卡与排序）——旧版备份未包含'] };
  }
  const bindings = [];
  const missing = [];
  for (const b of data.style.bindings) {
    if (db.get('SELECT id FROM style_packs WHERE id = ?', [b.pack_id])) {
      bindings.push(b);
    } else {
      missing.push({ pack_id: b.pack_id, name: snapshotPackName(data, b.pack_id), role: b.role, sort_order: b.sort_order });
    }
  }
  return { legacy: false, bindings, missing, unavailable: [] };
}

function loadBackupData(file) {
  const full = safeBackupPath(file);
  if (!full || !fs.existsSync(full)) {
    const err = new Error('备份文件不存在'); err.status = 404; throw err;
  }
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!data || data.kind !== 'book-backup' || !data.book || !data.book.id) {
    const err = new Error('不是有效的整册备份文件'); err.status = 400; throw err;
  }
  return data;
}

// 恢复预览（不落库）：作者看到将恢复什么、哪些绑定依赖缺失，再决定是否继续。
function previewBookBackup(file) {
  const data = loadBackupData(file);
  const plan = styleRestorePlan(data);
  const bindings = (data.style && Array.isArray(data.style.bindings) ? data.style.bindings : [])
    .map(b => ({
      pack_id: b.pack_id,
      pack_name: snapshotPackName(data, b.pack_id),
      role: b.role,
      sort_order: b.sort_order,
      exists: plan.bindings.some(x => x.pack_id === b.pack_id),
    }));
  return {
    book: { id: Number(data.book.id), title: data.book.title },
    exported_at: data.exported_at,
    version: data.version || 1,
    counts: Object.fromEntries(Object.entries(data.tables || {}).map(([t, rows]) => [t, rows.length])),
    style: { legacy: plan.legacy, bindings, missing: plan.missing, unavailable: plan.unavailable },
  };
}

function insertRow(table, row, cols) {
  const names = cols.filter(c => row[c] !== undefined);
  if (!names.length) return;
  db.run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map(c => row[c])
  );
}

function restoreBookBackup(file, opts) {
  const data = loadBackupData(file);
  const bookId = Number(data.book.id);
  if (db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
    const err = new Error('同 id 书籍已存在（可能已恢复过），拒绝覆盖'); err.status = 409; throw err;
  }
  const plan = styleRestorePlan(data);
  // 依赖缺失默认整单拒绝：不留「正文回来了、绑定静默半恢复」的状态。
  // 作者在预览里确认过后带 allow_partial_style 才落部分绑定。
  if (plan.missing.length && !(opts && opts.allowPartialStyle)) {
    const err = new Error('备份引用的作家卡已被删除，绑定无法恢复');
    err.status = 409; err.code = 'BACKUP_STYLE_DEPENDENCY_MISSING';
    err.details = { missing: plan.missing };
    throw err;
  }
  db.transaction(() => {
    insertRow('books', data.book, tableColumns('books'));
    for (const def of TABLES) {
      const cols = tableColumns(def.table);
      for (const row of data.tables[def.table] || []) insertRow(def.table, row, cols);
    }
    for (const b of plan.bindings) insertRow('book_style_packs', b, tableColumns('book_style_packs'));
    // 旧版备份（无 conversations 节）恢复的 messages 没有 conversation_id：
    // 与 028 迁移同口径按书归入补建的 legacy 会话，不留无归属消息。
    const { assignOrphanMessages } = require('./migrations/028-conversations');
    assignOrphanMessages(db, bookId);
    // 契约 5：运行归档只作只读记录恢复——running/awaiting_confirmation 的运行在本库
    // 里已不存在（进程没了/确认卡未随备份），恢复成 interrupted 而不是假装还活着。
    db.run(
      "UPDATE agent_runs SET status = 'interrupted', reason = 'restored_from_backup' WHERE book_id = ? AND status IN ('running', 'awaiting_confirmation')",
      [bookId]
    );
    // S2-02：该书正卡在 executing 的确认卡（确认执行与备份恢复并发时可能残留）结果
    // 不确定——书内容已回到备份时刻，执行到一半的动作同样标 interrupted，不给重放口。
    db.run(
      "UPDATE chat_actions SET status = 'interrupted', settled_at = ?, recovery_reason = 'restored_from_backup' WHERE book_id = ? AND status = 'executing'",
      [Date.now(), bookId]
    );
  });
  db.saveNow();
  const counts = Object.fromEntries(Object.entries(data.tables || {}).map(([t, rows]) => [t, rows.length]));
  return {
    book: db.get('SELECT * FROM books WHERE id = ?', [bookId]),
    counts,
    style: {
      legacy: plan.legacy,
      restored_bindings: plan.bindings.length,
      missing: plan.missing,
      unavailable: plan.unavailable,
    },
  };
}

function listBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => BACKUP_NAME_RE.test(name))
    .map(name => {
      const m = name.match(BACKUP_NAME_RE);
      const stat = fs.statSync(path.join(dir, name));
      return {
        file: name,
        book_id: m ? Number(m[1]) : null,
        title: m ? m[2].replace(/_/g, ' ') : '',
        size: stat.size,
        created_at: stat.mtime.toISOString(),
        expires_at: new Date(stat.mtime.getTime() + RETENTION_DAYS * 86400e3).toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function purgeOldBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86400e3;
  let purged = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^book-\d+/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtime.getTime() < cutoff) { fs.unlinkSync(full); purged++; }
    } catch (_) { /* 并发删除等异常忽略 */ }
  }
  if (purged) console.log(`[backup] 回收站清理：${purged} 个超 ${RETENTION_DAYS} 天的备份已过期删除`);
  return purged;
}

function deleteBackup(file) {
  const full = safeBackupPath(file);
  if (!full || !fs.existsSync(full)) {
    const err = new Error('备份文件不存在'); err.status = 404; throw err;
  }
  fs.unlinkSync(full);
  return true;
}

module.exports = { exportBookBackup, restoreBookBackup, previewBookBackup, listBackups, deleteBackup, purgeOldBackups, RETENTION_DAYS };
