const express = require('express');
const db = require('../db');

const router = express.Router({ mergeParams: true });

function toTrimmedString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

router.get('/:bookId/world', (req, res, next) => {
  try {
    const entries = db.all(
      'SELECT * FROM world_entries WHERE book_id = ? ORDER BY id',
      [req.params.bookId]
    );
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

router.post('/:bookId/world', (req, res, next) => {
  try {
    const title = toTrimmedString(req.body && req.body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    const content = toTrimmedString(req.body && req.body.content);
    const result = db.run(
      'INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)',
      [req.params.bookId, title, content]
    );
    const entry = db.get('SELECT * FROM world_entries WHERE id = ?', [result.lastInsertRowid]);
    return res.json({ entry });
  } catch (err) {
    return next(err);
  }
});

router.put('/:bookId/world/:id', (req, res, next) => {
  try {
    const existing = db.get(
      'SELECT * FROM world_entries WHERE id = ? AND book_id = ?',
      [req.params.id, req.params.bookId]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const fields = [];
    const values = [];
    if (req.body.title !== undefined) {
      const title = toTrimmedString(req.body.title);
      if (!title) return res.status(400).json({ error: 'title cannot be empty' });
      fields.push('title = ?');
      values.push(title);
    }
    if (req.body.content !== undefined) {
      fields.push('content = ?');
      values.push(toTrimmedString(req.body.content));
    }
    if (fields.length) {
      values.push(req.params.id, req.params.bookId);
      db.run(
        `UPDATE world_entries SET ${fields.join(', ')} WHERE id = ? AND book_id = ?`,
        values
      );
    }
    const entry = db.get(
      'SELECT * FROM world_entries WHERE id = ? AND book_id = ?',
      [req.params.id, req.params.bookId]
    );
    return res.json({ entry });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:bookId/world/:id', (req, res, next) => {
  try {
    const existing = db.get(
      'SELECT id FROM world_entries WHERE id = ? AND book_id = ?',
      [req.params.id, req.params.bookId]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.run(
      'DELETE FROM world_entries WHERE id = ? AND book_id = ?',
      [req.params.id, req.params.bookId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
