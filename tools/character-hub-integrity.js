// Read-only projection audit. The live database is copied before opening so this process never writes it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../server/db');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function parse(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function main() {
  const bookId = Number(arg('--book', 1));
  const source = path.resolve(arg('--db', process.env.NOVEL_DB_FILE || path.join(__dirname, '..', 'data', 'novel.db')));
  if (!fs.existsSync(source)) throw new Error(`数据库不存在：${source}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-hub-audit-'));
  const copy = path.join(dir, 'audit.db');
  fs.copyFileSync(source, copy);
  try {
    await db.init({ filePath: copy });
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) throw new Error(`书籍 ${bookId} 不存在`);
    const events = db.all(`SELECT e.id FROM story_events e WHERE e.book_id = ?
      AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
      ORDER BY e.id`, [bookId]);
    const states = new Map();
    const relations = new Map();
    for (const event of events) {
      for (const change of db.all('SELECT * FROM story_event_changes WHERE event_id = ? ORDER BY sort_order, id', [event.id])) {
        const value = parse(change.new_value_json);
        if (change.change_kind === 'character_state') {
          const key = `${change.subject_ref}:${change.field_key}`;
          if (value === null) states.delete(key); else states.set(key, value);
        } else if (change.change_kind === 'relation') {
          if (change.field_key === 'snapshot') relations.set(change.subject_ref, value);
          else if (relations.has(change.subject_ref)) relations.set(change.subject_ref, { ...relations.get(change.subject_ref), [change.field_key]: value });
        }
      }
    }
    const actualStates = new Map(db.all('SELECT character_id, field_key, value_json FROM character_state_values WHERE book_id = ?', [bookId]).map(row => [`${row.character_id}:${row.field_key}`, parse(row.value_json)]));
    const relationFields = ['endpoint_a', 'endpoint_b', 'relation_type_id', 'direction', 'strength', 'polarity', 'lifecycle', 'secrecy', 'note'];
    const actualRelations = new Map(db.all('SELECT * FROM character_relations WHERE book_id = ?', [bookId]).map(row => [row.public_id, Object.fromEntries(relationFields.map(field => [field, row[field]]))]));
    const normalizeRelations = map => new Map([...map].map(([key, value]) => [key, Object.fromEntries(relationFields.map(field => [field, value && value[field]]))]));
    function diff(expected, actual) {
      const keys = new Set([...expected.keys(), ...actual.keys()]);
      return [...keys].filter(key => stable(expected.get(key)) !== stable(actual.get(key))).map(key => ({ key, expected: expected.get(key), actual: actual.get(key) }));
    }
    const stateDrift = diff(states, actualStates);
    const relationDrift = diff(normalizeRelations(relations), actualRelations);
    const result = { bookId, effectiveEvents: events.length, states: { expected: states.size, actual: actualStates.size, drift: stateDrift }, relations: { expected: relations.size, actual: actualRelations.size, drift: relationDrift } };
    console.log(JSON.stringify(result, null, 2));
    if (stateDrift.length || relationDrift.length) process.exitCode = 1;
  } finally {
    db.close({ save: false });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
