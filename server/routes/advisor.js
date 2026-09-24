const express = require('express');
const advisor = require('../advisor/characterAdvisor');
const { sendDomainError } = require('../domain/errors');
const router = express.Router({ mergeParams: true });

function asyncRoute(work, status = 200) {
  return async (req, res, next) => {
    try { res.status(status).json(await work(req)); }
    catch (err) { if (!sendDomainError(res, err)) next(err); }
  };
}

router.post('/:bookId/characters/:characterId/advisor/sessions', asyncRoute(req => advisor.consultCharacter(req.params.bookId, req.params.characterId, req.body || {}), 201));
router.get('/:bookId/characters/:characterId/advisor/sessions', asyncRoute(req => ({ items: advisor.listSessions(req.params.bookId, req.params.characterId, req.query) })));
router.get('/:bookId/characters/:characterId/advisor/sessions/:sessionId', asyncRoute(req => advisor.getSession(req.params.bookId, req.params.characterId, req.params.sessionId)));
router.post('/:bookId/characters/:characterId/advisor/sessions/:sessionId/follow-up', asyncRoute(req => advisor.followUp(req.params.bookId, req.params.characterId, req.params.sessionId, req.body || {}), 201));
router.post('/:bookId/characters/:characterId/advisor/suggestions/:suggestionId/ignore', asyncRoute(req => advisor.ignoreSuggestion(req.params.bookId, req.params.characterId, req.params.suggestionId)));
router.post('/:bookId/characters/:characterId/advisor/suggestions/:suggestionId/adopt', asyncRoute(req => advisor.adoptSuggestion(req.params.bookId, req.params.characterId, req.params.suggestionId, req.body || {})));
router.post('/:bookId/characters/:characterId/advisor/sandbox', asyncRoute(req => advisor.sandbox(req.params.bookId, req.params.characterId, req.body || {})));

module.exports = router;
