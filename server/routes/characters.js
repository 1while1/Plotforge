const express = require('express');
const characters = require('../domain/characters');
const { sendDomainError } = require('../domain/errors');

const router = express.Router({ mergeParams: true });

function handle(res, next, work, status = 200) {
  try {
    const value = work();
    res.status(status).json(value);
  } catch (err) {
    if (!sendDomainError(res, err)) next(err);
  }
}

router.get('/:bookId/characters', (req, res, next) => {
  handle(res, next, () => {
    const items = characters.findCharacters(req.params.bookId, {
      q: req.query.q,
      role: req.query.role,
      archived: req.query.archived,
      limit: req.query.limit,
    });
    return {
      items,
      characters: items,
      page: { cursor: null, next_cursor: null, total: items.length },
    };
  });
});

router.post('/:bookId/characters', (req, res, next) => {
  handle(res, next, () => {
    const context = characters.createCharacter(req.params.bookId, req.body || {});
    return { character: context.character, context };
  }, 201);
});

router.get('/:bookId/characters/:characterId/context', (req, res, next) => {
  handle(res, next, () => characters.getCharacterContext(
    req.params.bookId,
    req.params.characterId
  ));
});

router.get('/:bookId/characters/:characterId', (req, res, next) => {
  handle(res, next, () => characters.getCharacterContext(
    req.params.bookId,
    req.params.characterId
  ));
});

function updateHandler(req, res, next) {
  handle(res, next, () => {
    const context = characters.updateCharacterProfile(
      req.params.bookId,
      req.params.characterId,
      req.body || {}
    );
    return { character: context.character, context };
  });
}

router.patch('/:bookId/characters/:characterId', updateHandler);
router.put('/:bookId/characters/:characterId', updateHandler);

router.put('/:bookId/characters/:characterId/aliases', (req, res, next) => {
  handle(res, next, () => characters.setAliases(
    req.params.bookId,
    req.params.characterId,
    req.body && req.body.aliases
  ));
});

router.post('/:bookId/characters/:characterId/archive', (req, res, next) => {
  handle(res, next, () => characters.archiveCharacter(
    req.params.bookId,
    req.params.characterId
  ));
});

router.post('/:bookId/characters/:characterId/unarchive', (req, res, next) => {
  handle(res, next, () => characters.unarchiveCharacter(
    req.params.bookId,
    req.params.characterId
  ));
});

// 兼容旧前端：DELETE 不再物理删除，等价于归档。
router.delete('/:bookId/characters/:characterId', (req, res, next) => {
  handle(res, next, () => {
    const context = characters.archiveCharacter(req.params.bookId, req.params.characterId);
    return { ok: true, archived: true, character: context.character };
  });
});

module.exports = router;
