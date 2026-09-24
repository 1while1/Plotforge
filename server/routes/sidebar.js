const express = require('express');
const preferences = require('../domain/sidebarPreferences');
const { sendDomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

router.get('/:bookId/sidebar-preferences', (req, res, next) => {
  try {
    res.json({ preferences: preferences.getPreferences(req.params.bookId) });
  } catch (err) {
    if (!sendDomainError(res, err)) next(err);
  }
});

router.put('/:bookId/sidebar-preferences', (req, res, next) => {
  try {
    res.json({ preferences: preferences.savePreferences(req.params.bookId, req.body || {}) });
  } catch (err) {
    if (!sendDomainError(res, err)) next(err);
  }
});

module.exports = router;
