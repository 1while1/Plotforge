const db = require('../db');
const { DomainError } = require('./errors');

const MODULES = ['chapters', 'outline', 'ledger', 'world', 'characters'];
const FIELDS = {
  chapters: ['title', 'volume', 'locked'],
  outline: ['mainPlot', 'currentVolume', 'drift'],
  ledger: ['progress', 'pendingCount', 'openThreadCount', 'issueCount'],
  world: ['name', 'summary'],
  characters: ['name', 'role', 'intro', 'location', 'goal'],
};
const MAX_FIELDS = { characters: 3, world: 2, outline: 2, ledger: 2, chapters: 3 };

const DEFAULTS = Object.freeze({
  moduleOrder: ['chapters', 'characters', 'outline', 'ledger', 'world'],
  hiddenModules: [],
  summaryFields: {
    chapters: ['title', 'volume', 'locked'],
    outline: ['mainPlot'],
    ledger: ['progress', 'pendingCount'],
    world: ['name', 'summary'],
    characters: ['name', 'role', 'intro'],
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureBook(bookId) {
  const id = Number(bookId);
  if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT id FROM books WHERE id = ?', [id])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  return id;
}

function uniqueAllowed(values, allowed) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (allowed.includes(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function normalize(input = {}) {
  const order = uniqueAllowed(input.moduleOrder, MODULES);
  for (const module of MODULES) if (!order.includes(module)) order.push(module);
  const hidden = uniqueAllowed(input.hiddenModules, MODULES).filter(module => module !== 'chapters');
  const summaryFields = {};
  for (const module of MODULES) {
    const incoming = input.summaryFields && input.summaryFields[module];
    const selected = uniqueAllowed(incoming, FIELDS[module]).slice(0, MAX_FIELDS[module]);
    summaryFields[module] = selected.length ? selected : [...DEFAULTS.summaryFields[module]];
  }
  return { moduleOrder: order, hiddenModules: hidden, summaryFields };
}

function getPreferences(bookId) {
  const id = ensureBook(bookId);
  const row = db.get('SELECT * FROM sidebar_preferences WHERE book_id = ?', [id]);
  if (!row) return clone(DEFAULTS);
  try {
    return normalize({
      moduleOrder: JSON.parse(row.module_order_json),
      hiddenModules: JSON.parse(row.hidden_modules_json),
      summaryFields: JSON.parse(row.summary_fields_json),
    });
  } catch (_) {
    return clone(DEFAULTS);
  }
}

function savePreferences(bookId, input) {
  const id = ensureBook(bookId);
  const value = normalize(input);
  db.run(
    `INSERT INTO sidebar_preferences
     (book_id, module_order_json, hidden_modules_json, summary_fields_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       module_order_json = excluded.module_order_json,
       hidden_modules_json = excluded.hidden_modules_json,
       summary_fields_json = excluded.summary_fields_json,
       updated_at = excluded.updated_at`,
    [
      id,
      JSON.stringify(value.moduleOrder),
      JSON.stringify(value.hiddenModules),
      JSON.stringify(value.summaryFields),
      new Date().toISOString(),
    ]
  );
  return value;
}

module.exports = { MODULES, FIELDS, DEFAULTS, normalize, getPreferences, savePreferences };
