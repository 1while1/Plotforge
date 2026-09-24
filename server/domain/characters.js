const db = require('../db');
const { normalizeAlias } = require('../migrations/001-character-hub');
const { DomainError } = require('./errors');

const PROFILE_FIELDS = ['name', 'role', 'intro', 'appearance', 'personality', 'background', 'note'];
const ALIAS_TYPES = new Set(['primary', 'nickname', 'former_name', 'title', 'pen_name', 'other']);

function asPositiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DomainError('VALIDATION_ERROR', `${field} 必须是正整数`, 400, { field });
  }
  return id;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function introFor(row) {
  if (row.intro) return row.intro;
  const fallback = text(row.note);
  return fallback.length > 120 ? `${fallback.slice(0, 119)}…` : fallback;
}

function ensureBook(bookId) {
  const id = asPositiveId(bookId, 'book_id');
  if (!db.get('SELECT id FROM books WHERE id = ?', [id])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  return id;
}

function getCharacterRow(bookId, characterId) {
  const bid = asPositiveId(bookId, 'book_id');
  const cid = asPositiveId(characterId, 'character_id');
  const character = db.get('SELECT * FROM characters WHERE id = ? AND book_id = ?', [cid, bid]);
  if (!character) throw new DomainError('CHARACTER_NOT_FOUND', '人物不存在', 404);
  return character;
}

function aliasesFor(characterIds) {
  if (!characterIds.length) return new Map();
  const marks = characterIds.map(() => '?').join(',');
  const rows = db.all(
    `SELECT character_id, alias, alias_type, is_primary
     FROM character_aliases WHERE character_id IN (${marks})
     ORDER BY is_primary DESC, id`,
    characterIds
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.character_id)) grouped.set(row.character_id, []);
    grouped.get(row.character_id).push(row);
  }
  return grouped;
}

function presentCharacter(row, aliases = []) {
  return {
    ...row,
    intro: introFor(row),
    intro_fallback: !row.intro && Boolean(row.note),
    aliases: aliases.map(item => ({
      alias: item.alias,
      alias_type: item.alias_type,
      is_primary: Boolean(item.is_primary),
    })),
  };
}

function findCharacters(bookId, filters = {}) {
  const bid = ensureBook(bookId);
  const clauses = ['c.book_id = ?'];
  const params = [bid];
  const archived = filters.archived;
  if (archived === true || archived === 'true') clauses.push('c.archived_at IS NOT NULL');
  else if (archived !== 'all') clauses.push('c.archived_at IS NULL');

  const role = text(filters.role);
  if (role) {
    clauses.push('c.role = ?');
    params.push(role);
  }
  const query = text(filters.q);
  if (query) {
    const like = `%${query}%`;
    const normalized = normalizeAlias(query);
    clauses.push(`(
      c.name LIKE ? OR c.intro LIKE ? OR c.note LIKE ? OR
      EXISTS (
        SELECT 1 FROM character_aliases ca
        WHERE ca.character_id = c.id
          AND (ca.alias LIKE ? OR ca.alias_normalized = ?)
      )
    )`);
    params.push(like, like, like, like, normalized);
  }

  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  params.push(limit);
  const rows = db.all(
    `SELECT c.* FROM characters c
     WHERE ${clauses.join(' AND ')}
     ORDER BY (c.archived_at IS NOT NULL), c.name, c.id
     LIMIT ?`,
    params
  );
  const aliasMap = aliasesFor(rows.map(row => row.id));
  return rows.map(row => presentCharacter(row, aliasMap.get(row.id) || []));
}

function normalizeAliasInput(item) {
  const alias = text(typeof item === 'string' ? item : item && item.alias);
  const aliasType = text(item && typeof item === 'object' ? item.alias_type : 'other') || 'other';
  const isPrimary = Boolean(item && typeof item === 'object' && item.is_primary);
  if (!alias) throw new DomainError('VALIDATION_ERROR', '别名不能为空', 400, { field: 'aliases' });
  if (!ALIAS_TYPES.has(aliasType)) {
    throw new DomainError('VALIDATION_ERROR', '别名类型无效', 400, { field: 'alias_type' });
  }
  return { alias, alias_normalized: normalizeAlias(alias), alias_type: aliasType, is_primary: isPrimary };
}

function insertAlias(bookId, characterId, item, createdAt) {
  db.run(
    `INSERT INTO character_aliases
     (book_id, character_id, alias, alias_normalized, alias_type, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [bookId, characterId, item.alias, item.alias_normalized, item.alias_type, item.is_primary ? 1 : 0, createdAt]
  );
}

function createCharacter(bookId, input = {}) {
  const bid = ensureBook(bookId);
  const name = text(input.name);
  if (!name) throw new DomainError('VALIDATION_ERROR', '人物姓名不能为空', 400, { field: 'name' });
  const createdAt = new Date().toISOString();
  const values = PROFILE_FIELDS.map(field => field === 'name' ? name : text(input[field]));

  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO characters
       (name, role, intro, appearance, personality, background, note, book_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, bid, createdAt]
    );
    const characterId = result.lastInsertRowid;
    insertAlias(bid, characterId, {
      alias: name,
      alias_normalized: normalizeAlias(name),
      alias_type: 'primary',
      is_primary: true,
    }, createdAt);

    const seen = new Set([normalizeAlias(name)]);
    for (const raw of Array.isArray(input.aliases) ? input.aliases : []) {
      const alias = normalizeAliasInput(raw);
      if (seen.has(alias.alias_normalized)) continue;
      seen.add(alias.alias_normalized);
      insertAlias(bid, characterId, { ...alias, is_primary: false }, createdAt);
    }
    return getCharacterContext(bid, characterId);
  });
}

function updateCharacterProfile(bookId, characterId, patch = {}) {
  const existing = getCharacterRow(bookId, characterId);
  const fields = [];
  const params = [];
  for (const field of PROFILE_FIELDS) {
    if (patch[field] === undefined) continue;
    const value = text(patch[field]);
    if (field === 'name' && !value) {
      throw new DomainError('VALIDATION_ERROR', '人物姓名不能为空', 400, { field: 'name' });
    }
    fields.push(`${field} = ?`);
    params.push(value);
  }
  if (!fields.length) return getCharacterContext(existing.book_id, existing.id);
  const updatedAt = new Date().toISOString();

  return db.transaction(() => {
    if (patch.name !== undefined && text(patch.name) !== existing.name) {
      const oldNormalized = normalizeAlias(existing.name);
      db.run(
        `UPDATE character_aliases
         SET is_primary = 0, alias_type = 'former_name'
         WHERE character_id = ? AND is_primary = 1`,
        [existing.id]
      );
      const newName = text(patch.name);
      const newNormalized = normalizeAlias(newName);
      const found = db.get(
        'SELECT id FROM character_aliases WHERE character_id = ? AND alias_normalized = ?',
        [existing.id, newNormalized]
      );
      if (found) {
        db.run(
          `UPDATE character_aliases
           SET alias = ?, alias_type = 'primary', is_primary = 1
           WHERE id = ?`,
          [newName, found.id]
        );
      } else {
        insertAlias(existing.book_id, existing.id, {
          alias: newName,
          alias_normalized: newNormalized,
          alias_type: 'primary',
          is_primary: true,
        }, updatedAt);
      }
      if (!db.get(
        'SELECT id FROM character_aliases WHERE character_id = ? AND alias_normalized = ?',
        [existing.id, oldNormalized]
      )) {
        insertAlias(existing.book_id, existing.id, {
          alias: existing.name,
          alias_normalized: oldNormalized,
          alias_type: 'former_name',
          is_primary: false,
        }, updatedAt);
      }
    }
    params.push(updatedAt, existing.id, existing.book_id);
    db.run(
      `UPDATE characters SET ${fields.join(', ')}, updated_at = ?
       WHERE id = ? AND book_id = ?`,
      params
    );
    return getCharacterContext(existing.book_id, existing.id);
  });
}

function setAliases(bookId, characterId, inputAliases) {
  const character = getCharacterRow(bookId, characterId);
  if (!Array.isArray(inputAliases)) {
    throw new DomainError('VALIDATION_ERROR', 'aliases 必须是数组', 400, { field: 'aliases' });
  }
  const aliases = inputAliases.map(normalizeAliasInput);
  const normalized = new Set();
  for (const alias of aliases) {
    if (normalized.has(alias.alias_normalized)) {
      throw new DomainError('VALIDATION_ERROR', `别名“${alias.alias}”重复`, 400, { field: 'aliases' });
    }
    normalized.add(alias.alias_normalized);
  }
  const primary = aliases.filter(alias => alias.is_primary);
  if (primary.length !== 1 || primary[0].alias !== character.name) {
    throw new DomainError('VALIDATION_ERROR', '必须且只能保留一个与当前姓名一致的主名称', 400, { field: 'aliases' });
  }

  db.transaction(() => {
    db.run('DELETE FROM character_aliases WHERE character_id = ?', [character.id]);
    const createdAt = new Date().toISOString();
    for (const alias of aliases) {
      insertAlias(character.book_id, character.id, {
        ...alias,
        alias_type: alias.is_primary ? 'primary' : alias.alias_type,
      }, createdAt);
    }
  });
  return getCharacterContext(character.book_id, character.id);
}

function archiveCharacter(bookId, characterId) {
  const character = getCharacterRow(bookId, characterId);
  if (character.archived_at) return getCharacterContext(character.book_id, character.id);
  db.run(
    'UPDATE characters SET archived_at = ?, updated_at = ? WHERE id = ? AND book_id = ?',
    [new Date().toISOString(), new Date().toISOString(), character.id, character.book_id]
  );
  return getCharacterContext(character.book_id, character.id);
}

function unarchiveCharacter(bookId, characterId) {
  const character = getCharacterRow(bookId, characterId);
  db.run(
    'UPDATE characters SET archived_at = NULL, updated_at = ? WHERE id = ? AND book_id = ?',
    [new Date().toISOString(), character.id, character.book_id]
  );
  return getCharacterContext(character.book_id, character.id);
}

function getCharacterContext(bookId, characterId) {
  const row = getCharacterRow(bookId, characterId);
  const aliasMap = aliasesFor([row.id]);
  const currentStates = db.all(
    `SELECT d.field_key, d.label, d.value_type, d.sort_order,
            v.value_json, v.source_event_id, v.last_event_id
     FROM state_field_definitions d
     LEFT JOIN character_state_values v
       ON v.book_id = d.book_id AND v.character_id = ? AND v.field_key = d.field_key
     WHERE d.book_id = ? AND d.enabled = 1
     ORDER BY d.sort_order, d.id`,
    [row.id, row.book_id]
  ).map(item => ({
    ...item,
    value: item.value_json === null || item.value_json === undefined
      ? null
      : JSON.parse(item.value_json),
  }));
  const relationSummary = db.get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN secrecy = 'secret' THEN 1 ELSE 0 END) AS secret,
       SUM(CASE WHEN lifecycle = 'ended' THEN 1 ELSE 0 END) AS ended
     FROM character_relations
     WHERE book_id = ? AND (endpoint_a = ? OR endpoint_b = ?)`,
    [row.book_id, row.id, row.id]
  );
  const timelineSummary = db.get(
    `SELECT COUNT(DISTINCT e.id) AS events, MAX(e.id) AS last_event_id
     FROM story_events e JOIN story_event_changes c ON c.event_id = e.id
     WHERE e.book_id = ? AND c.change_kind = 'character_state' AND c.subject_ref = ?`,
    [row.book_id, String(row.id)]
  );
  const threadSummary = db.get(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN t.status IN ('open','progressing') THEN 1 ELSE 0 END) AS open
     FROM story_threads t JOIN story_thread_characters tc ON tc.thread_id = t.id
     WHERE t.book_id = ? AND tc.character_id = ?`,
    [row.book_id, row.id]
  );
  return {
    character: presentCharacter(row, aliasMap.get(row.id) || []),
    aliases: aliasMap.get(row.id) || [],
    current_states: currentStates,
    relation_summary: {
      total: Number(relationSummary.total || 0),
      active: Number(relationSummary.active || 0),
      secret: Number(relationSummary.secret || 0),
      ended: Number(relationSummary.ended || 0),
    },
    timeline_summary: {
      events: Number(timelineSummary.events || 0),
      last_event_id: timelineSummary.last_event_id || null,
    },
    thread_summary: {
      total: Number(threadSummary.total || 0),
      open: Number(threadSummary.open || 0),
    },
  };
}

module.exports = {
  PROFILE_FIELDS,
  findCharacters,
  getCharacterContext,
  createCharacter,
  updateCharacterProfile,
  setAliases,
  archiveCharacter,
  unarchiveCharacter,
  getCharacterRow,
};
