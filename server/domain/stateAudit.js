// 人物状态体检（只读）：把「人物状态是否可信」拆成三类确定性检查 + 弱提示候选，
// 带过滤（issue_types/character_ids/field_keys/min_severity）、分页（limit/cursor）与摘要计数，
// 避免一次性吐大量明细被工具结果上限截断（评审 §5 / §1 audit_character_states）。
//
// 三类检查（评审 §1）：
//   1) 投影完整性 projection_integrity：投影值≠叙事序重放、引用无效、last_event_id 非叙事最末。
//   2) 抽取覆盖 extraction_coverage：定稿章当前正文修订没有成功抽取记录（依赖 chapter_extraction_runs）。
//   3) 冲突候选 conflict_candidates：同角色字段多条互斥待审提案。
// 另有：证据 stale / 缺 source_quote（stale_evidence），字段新鲜度弱提示（freshness_candidate）。
// 关键：新鲜度用 last_event_id（投影 upsert 只更新 last_event_id，不更新 source_event_id），且仅作弱提示。
const db = require('../db');
const ledger = require('./storyLedger');
const { revision } = require('../evidence/draftLexical');
const { DomainError } = require('./errors');

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const SEVERITY_OF = {
  projection_mismatch: 'high',
  invalid_ref: 'high',
  stale_last_event: 'high',
  conflicting_proposals: 'medium',
  extraction_gap: 'medium',
  stale_evidence: 'low',
  freshness_candidate: 'low',
};
const ISSUE_TYPES = new Set(Object.keys(SEVERITY_OF));

function parse(value) { try { return JSON.parse(value); } catch (err) { return null; } }
function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function mk(type, fields) {
  return {
    type,
    severity: SEVERITY_OF[type],
    character_id: fields.character_id != null ? Number(fields.character_id) : null,
    field_key: fields.field_key != null ? String(fields.field_key) : null,
    chapter_id: fields.chapter_id != null ? Number(fields.chapter_id) : null,
    event_id: fields.event_id != null ? Number(fields.event_id) : null,
    message: fields.message,
    details: fields.details || {},
  };
}

// ---- 1) 投影完整性：引用有效 + 投影值/末事件与叙事序重放一致 ----
function collectProjectionIntegrity(bid, issues) {
  const characterIds = new Set(db.all('SELECT id FROM characters WHERE book_id = ?', [bid]).map(row => row.id));
  const fieldRows = db.all('SELECT field_key FROM state_field_definitions WHERE book_id = ?', [bid]);
  const fieldKeys = new Set(fieldRows.map(row => row.field_key));
  const expected = ledger.computeExpectedStates(bid); // key `${characterId}:${fieldKey}` -> {value,last_event_id}
  const projRows = db.all(
    'SELECT character_id, field_key, value_json, last_event_id FROM character_state_values WHERE book_id = ?',
    [bid]
  );
  const projMap = new Map(projRows.map(row => [`${row.character_id}:${row.field_key}`, row]));

  // 引用完整性：投影行指向的角色/字段必须存在
  for (const row of projRows) {
    if (!characterIds.has(row.character_id)) {
      issues.push(mk('invalid_ref', {
        character_id: row.character_id, field_key: row.field_key,
        message: `投影指向不存在的人物 #${row.character_id}（字段 ${row.field_key}）`,
        details: { reason: 'orphan_character' },
      }));
    } else if (!fieldKeys.has(row.field_key)) {
      issues.push(mk('invalid_ref', {
        character_id: row.character_id, field_key: row.field_key,
        message: `投影字段 "${row.field_key}" 未在字段定义中`,
        details: { reason: 'unknown_field' },
      }));
    }
  }

  // 重放对比：期望有值 → 投影缺失/值不一致/末事件不符
  for (const [key, exp] of expected) {
    if (!characterIds.has(exp.character_id) || !fieldKeys.has(exp.field_key)) continue; // 引用问题已单独报
    const proj = projMap.get(key);
    if (!proj) {
      issues.push(mk('projection_mismatch', {
        character_id: exp.character_id, field_key: exp.field_key, event_id: exp.last_event_id,
        message: `叙事重放应有值但投影缺失（字段 ${exp.field_key}）`,
        details: { reason: 'missing', expected: exp.value, actual: null, expected_event_id: exp.last_event_id },
      }));
      continue;
    }
    const projValue = parse(proj.value_json);
    if (!jsonEq(projValue, exp.value)) {
      issues.push(mk('projection_mismatch', {
        character_id: exp.character_id, field_key: exp.field_key, event_id: proj.last_event_id,
        message: `投影值与叙事序重放不一致（字段 ${exp.field_key}）`,
        details: { reason: 'value', expected: exp.value, actual: projValue, expected_event_id: exp.last_event_id, actual_event_id: proj.last_event_id },
      }));
    } else if (Number(proj.last_event_id) !== Number(exp.last_event_id)) {
      issues.push(mk('stale_last_event', {
        character_id: exp.character_id, field_key: exp.field_key, event_id: proj.last_event_id,
        message: `投影 last_event_id 非叙事序最后有效事件（字段 ${exp.field_key}）`,
        details: { expected_event_id: exp.last_event_id, actual_event_id: proj.last_event_id },
      }));
    }
  }

  // 投影有残留行但重放应为空（如乱序覆盖后未重建）
  for (const [key, proj] of projMap) {
    if (expected.has(key)) continue;
    if (!characterIds.has(proj.character_id) || !fieldKeys.has(proj.field_key)) continue;
    issues.push(mk('projection_mismatch', {
      character_id: proj.character_id, field_key: proj.field_key, event_id: proj.last_event_id,
      message: `投影存在残留值，但叙事重放应为空（字段 ${proj.field_key}）`,
      details: { reason: 'orphan_value', expected: null, actual: parse(proj.value_json), actual_event_id: proj.last_event_id },
    }));
  }
}

// ---- 2) 抽取覆盖：定稿章当前正文修订必须有成功抽取记录 ----
function collectExtractionCoverage(bid, issues) {
  const chapters = db.all(
    `SELECT c.id, c.title, c.content FROM chapters c
     WHERE c.book_id = ? AND c.locked = 1 AND c.content IS NOT NULL AND TRIM(c.content) != ''`,
    [bid]
  );
  for (const chapter of chapters) {
    const hash = revision(chapter.content);
    const run = db.get(
      `SELECT id FROM chapter_extraction_runs
       WHERE book_id = ? AND chapter_id = ? AND revision_hash = ? AND status = 'success'`,
      [bid, chapter.id, hash]
    );
    if (!run) {
      issues.push(mk('extraction_gap', {
        chapter_id: chapter.id,
        message: `定稿章「${chapter.title}」当前正文修订没有成功抽取记录`,
        details: { revision_hash: hash },
      }));
    }
  }
}

// ---- 3) 冲突候选：同角色字段多条互斥（new_value 不同）待审提案 ----
function collectConflictingProposals(bid, issues) {
  const rows = db.all(
    `SELECT pc.subject_ref, pc.field_key, pc.new_value_json, p.id AS proposal_id, p.status, p.chapter_id
     FROM event_proposal_changes pc
     JOIN event_proposals p ON p.id = pc.proposal_id
     WHERE pc.book_id = ? AND pc.change_kind = 'character_state' AND p.status IN ('pending', 'stale')
     ORDER BY pc.subject_ref, pc.field_key, p.id`,
    [bid]
  );
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.subject_ref}:${row.field_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ proposal_id: row.proposal_id, status: row.status, chapter_id: row.chapter_id, value: parse(row.new_value_json) });
  }
  for (const [key, entries] of groups) {
    if (entries.length < 2) continue;
    const distinct = new Set(entries.map(entry => JSON.stringify(entry.value)));
    if (distinct.size < 2) continue; // 完全相同的重复提案不算互斥
    const split = key.indexOf(':');
    const subjectRef = key.slice(0, split);
    const fieldKey = key.slice(split + 1);
    issues.push(mk('conflicting_proposals', {
      character_id: Number(subjectRef), field_key: fieldKey,
      message: `人物 #${subjectRef} 字段 "${fieldKey}" 有 ${entries.length} 条互斥待审提案`,
      details: { proposal_ids: entries.map(entry => entry.proposal_id) },
    }));
  }
}

// ---- 证据质量：source_stale=1 或（有章节且非纯手动）缺 source_quote ----
function collectStaleEvidence(bid, issues) {
  const rows = db.all(
    `SELECT e.id, e.chapter_id, e.source_quote, e.source_stale, e.origin, ec.subject_ref, ec.field_key
     FROM story_events e
     JOIN story_event_changes ec ON ec.event_id = e.id AND ec.change_kind = 'character_state'
     WHERE e.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
       AND (e.source_stale = 1 OR (e.chapter_id IS NOT NULL AND e.origin != 'manual' AND TRIM(e.source_quote) = ''))`,
    [bid]
  );
  for (const row of rows) {
    const reasons = [];
    if (Number(row.source_stale) === 1) reasons.push('source_stale');
    if (row.chapter_id != null && String(row.source_quote || '').trim() === '') reasons.push('missing_source_quote');
    if (!reasons.length) continue;
    issues.push(mk('stale_evidence', {
      character_id: Number(row.subject_ref), field_key: row.field_key, event_id: row.id, chapter_id: row.chapter_id,
      message: `事件 #${row.id} 证据${Number(row.source_stale) === 1 ? '已标记 stale' : '缺少 source_quote'}`,
      details: { reasons, origin: row.origin },
    }));
  }
}

// ---- 新鲜度弱提示：角色在「最后更新章」之后的定稿章确实出现（正文含其名），仅候选、非必然陈旧 ----
function collectFreshnessCandidates(bid, issues) {
  const chars = db.all('SELECT id, name FROM characters WHERE book_id = ? AND archived_at IS NULL', [bid]);
  if (!chars.length) return;
  const chapters = db.all(
    `SELECT c.id, c.content, COALESCE(v.sort_order, 2147483647) AS vsort, c.sort_order AS csort
     FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE c.book_id = ? AND c.locked = 1 AND c.content IS NOT NULL AND TRIM(c.content) != ''
     ORDER BY vsort, csort, c.id`,
    [bid]
  );
  if (!chapters.length) return;
  const chapterPos = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const lastAppearance = new Map(); // characterId -> 最晚出现章位置
  for (const chapter of chapters) {
    for (const character of chars) {
      if (character.name && chapter.content.includes(character.name)) {
        const prev = lastAppearance.get(character.id);
        const pos = chapterPos.get(chapter.id);
        if (prev === undefined || pos > prev) lastAppearance.set(character.id, pos);
      }
    }
  }
  const projRows = db.all(
    `SELECT v.character_id, v.field_key, v.last_event_id, e.chapter_id
     FROM character_state_values v LEFT JOIN story_events e ON e.id = v.last_event_id
     WHERE v.book_id = ?`,
    [bid]
  );
  for (const row of projRows) {
    if (row.chapter_id == null) continue;
    const lastPos = chapterPos.get(row.chapter_id);
    const appearPos = lastAppearance.get(row.character_id);
    if (lastPos === undefined || appearPos === undefined) continue;
    if (appearPos > lastPos) {
      issues.push(mk('freshness_candidate', {
        character_id: row.character_id, field_key: row.field_key, event_id: row.last_event_id, chapter_id: row.chapter_id,
        message: `人物 #${row.character_id} 字段 "${row.field_key}" 最后更新较早，其后定稿章仍出现该人物（弱提示，非必然陈旧）`,
        details: { last_chapter_pos: lastPos, later_appearance_pos: appearPos },
      }));
    }
  }
}

function toStrSet(value) {
  if (value === undefined || value === null) return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const set = new Set(arr.map(item => String(item).trim()).filter(Boolean));
  return set.size ? set : null;
}
function toIdSet(value) {
  if (value === undefined || value === null) return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const set = new Set(arr.map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0));
  return set.size ? set : null;
}

function paginate(issues, filters = {}) {
  const typeFilter = toStrSet(filters.issue_types);
  const charFilter = toIdSet(filters.character_ids);
  const fieldFilter = toStrSet(filters.field_keys);
  const minSeverity = SEVERITY_RANK[filters.min_severity] || 0;

  const filtered = issues.filter(issue => {
    if (typeFilter && !typeFilter.has(issue.type)) return false;
    if (charFilter && (issue.character_id == null || !charFilter.has(issue.character_id))) return false;
    if (fieldFilter && (issue.field_key == null || !fieldFilter.has(issue.field_key))) return false;
    if (SEVERITY_RANK[issue.severity] < minSeverity) return false;
    return true;
  });
  filtered.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
    String(a.type).localeCompare(String(b.type)) ||
    (Number(a.character_id) || 0) - (Number(b.character_id) || 0) ||
    String(a.field_key || '').localeCompare(String(b.field_key || '')) ||
    (Number(a.event_id) || 0) - (Number(b.event_id) || 0));

  const byType = {};
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const issue of filtered) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
  }
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  const offset = Math.max(0, Number(filters.cursor) || 0);
  const items = filtered.slice(offset, offset + limit);
  const nextCursor = offset + items.length < filtered.length ? offset + items.length : null;
  return {
    summary: { total: filtered.length, scanned: issues.length, by_type: byType, by_severity: bySeverity },
    items,
    limit,
    cursor: offset,
    next_cursor: nextCursor,
    truncated: nextCursor !== null,
  };
}

function auditCharacterStates(bookId, filters = {}) {
  const bid = Number(bookId);
  if (!db.get('SELECT id FROM books WHERE id = ?', [bid])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  // 快照化（方向报告 2.4）：体检含全量叙事重放与「定稿正文×人物」扫描，
  // 此前每次调用（含每页翻页）都全量重算。改为按数据指纹缓存整套 issues，
  // 指纹变化（事件/章节/提案/人物/投影水位任一变动）或超时才重算；
  // 过滤/排序/分页始终在缓存快照上做，结果与即时重算一致。
  const fingerprint = auditFingerprint(bid);
  let entry = auditCache.get(bid);
  if (!(entry && entry.fingerprint === fingerprint
    && Date.now() - entry.computedAt < AUDIT_CACHE_TTL_MS)) {
    const issues = [];
    collectProjectionIntegrity(bid, issues);
    collectExtractionCoverage(bid, issues);
    collectConflictingProposals(bid, issues);
    collectStaleEvidence(bid, issues);
    collectFreshnessCandidates(bid, issues);
    entry = { fingerprint, issues, computedAt: Date.now() };
    auditCache.set(bid, entry);
  }
  const page = paginate(entry.issues, filters);
  page.summary.cached = true;
  page.summary.computed_at = new Date(entry.computedAt).toISOString();
  return page;
}

const AUDIT_CACHE_TTL_MS = 60_000;
const auditCache = new Map(); // bookId -> { fingerprint, issues, computedAt }

function auditFingerprint(bid) {
  return [
    db.get('SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM story_events WHERE book_id = ?', [bid]),
    db.get("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(MAX(updated_at),'') AS u FROM chapters WHERE book_id = ?", [bid]),
    db.get('SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM event_proposals WHERE book_id = ?', [bid]),
    db.get("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM characters WHERE book_id = ?", [bid]),
    db.get("SELECT COUNT(*) AS n, COALESCE(MAX(rebuilt_at),'') AS u FROM projection_watermarks WHERE book_id = ?", [bid]),
    // 投影值/水位与覆盖表也要进指纹：体检的判定输入包含这些表
    db.get("SELECT COUNT(*) AS n, COALESCE(SUM(last_event_id),0) AS s, COALESCE(SUM(LENGTH(value_json)),0) AS l FROM character_state_values WHERE book_id = ?", [bid]),
    db.get('SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM embeddings WHERE book_id = ?', [bid]),
    db.get('SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM chapter_extraction_runs WHERE book_id = ?', [bid]),
  ].map(r => JSON.stringify(r)).join('|');
}

// 测试与运维用：显式清空体检快照
function clearAuditCache() {
  auditCache.clear();
}

module.exports = { auditCharacterStates, clearAuditCache, ISSUE_TYPES, SEVERITY_OF };
