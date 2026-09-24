const express = require('express');
const relations = require('../domain/relations');
const { sendDomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

function handle(res, next, work, status = 200) {
  try {
    res.status(status).json(work());
  } catch (err) {
    if (!sendDomainError(res, err)) next(err);
  }
}

router.get('/:bookId/relation-types', (req, res, next) => {
  handle(res, next, () => ({ items: relations.listRelationTypes(req.params.bookId) }));
});

router.post('/:bookId/relation-types', (req, res, next) => {
  handle(
    res,
    next,
    () => ({ relation_type: relations.createRelationType(req.params.bookId, req.body || {}) }),
    201
  );
});

router.patch('/:bookId/relation-types/:typeId', (req, res, next) => {
  handle(res, next, () => ({
    relation_type: relations.updateRelationType(
      req.params.bookId,
      req.params.typeId,
      req.body || {}
    ),
  }));
});

router.get('/:bookId/characters/:characterId/relations', (req, res, next) => {
  handle(res, next, () => ({
    items: relations.getRelations(req.params.bookId, req.params.characterId, {
      ...req.query,
      lifecycle: req.query.lifecycle || 'active',
      secrecy: req.query.secrecy || 'public',
    }),
  }));
});

router.post('/:bookId/relations/changes', (req, res, next) => {
  handle(
    res,
    next,
    () => relations.recordRelationChange(req.params.bookId, req.body || {}, 'author'),
    201
  );
});

module.exports = router;
