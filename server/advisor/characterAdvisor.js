const crypto = require('crypto');
const db = require('../db');
const { callLLMFull, llmConfig } = require('../llm');
const characters = require('../domain/characters');
const relations = require('../domain/relations');
const ledger = require('../domain/storyLedger');
const threads = require('../domain/threads');
const proposals = require('../domain/proposals');
const { searchEvidence } = require('../evidence/search');
const { DomainError } = require('../domain/errors');

const TYPES = new Set(['A', 'B', 'C', 'D']);
// 采纳目标（方向报告 1.7）：每个 target 必须有真实去向——character_profile 改档案、
// event_proposal 生成待审提案、story_thread 建故事线；advisor_note 是唯一例外，
// 明确语义为「仅标记采纳」：建议本体已在 advisor_suggestions 持久化，可随时回看，
// 不落新实体。consult_transfer 已移除：通用参谋（consult）设计上不入库，
// 「转交」没有可落地的目标实体，此前只是把建议标记为已采纳的假闭环。
const TARGETS = new Set(['character_profile', 'event_proposal', 'story_thread', 'advisor_note']);

function text(value) { return value == null ? '' : String(value).trim(); }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch (_) { return fallback; } }
function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new DomainError('VALIDATION_ERROR', `${field} 必须是正整数`, 400);
  return id;
}

function suggestionRow(row) {
  const citations = db.all('SELECT * FROM advisor_citations WHERE suggestion_id = ? ORDER BY id', [row.id]);
  const adoptions = db.all('SELECT * FROM advisor_adoptions WHERE suggestion_id = ? ORDER BY id', [row.id]);
  return {
    ...row,
    type: row.suggestion_type,
    assumptions: parseJson(row.assumptions_json, []),
    impacts: parseJson(row.impacts_json, []),
    citations,
    adoptions,
  };
}

function getSession(bookId, characterId, sessionId) {
  const bid = positiveId(bookId, 'book_id');
  const cid = positiveId(characterId, 'character_id');
  const sid = positiveId(sessionId, 'session_id');
  const session = db.get('SELECT * FROM advisor_sessions WHERE id = ? AND book_id = ? AND character_id = ?', [sid, bid, cid]);
  if (!session) throw new DomainError('ADVISOR_SESSION_NOT_FOUND', '人物顾问会话不存在', 404);
  return { ...session, suggestions: db.all('SELECT * FROM advisor_suggestions WHERE session_id = ? ORDER BY id', [sid]).map(suggestionRow) };
}

function listSessions(bookId, characterId, options = {}) {
  const ctx = characters.getCharacterContext(bookId, characterId);
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  return db.all('SELECT * FROM advisor_sessions WHERE book_id = ? AND character_id = ? ORDER BY id DESC LIMIT ?', [ctx.character.book_id, ctx.character.id, limit])
    .map(row => getSession(ctx.character.book_id, ctx.character.id, row.id));
}

function compactEvidence(hits) {
  const final = hits.filter(hit => hit.canonicalStatus === 'canonical').slice(0, 8);
  const draft = hits.filter(hit => hit.canonicalStatus !== 'canonical').slice(0, 5);
  let used = 0;
  return [...final, ...draft].filter(hit => {
    const size = text(hit.quote || hit.context).length;
    if (used + size > 12000) return false;
    used += size;
    return true;
  });
}

// 人物中枢投影也是合法证据：关系边、故事事件、人物卡字段都注册为可引用锚点
const CARD_FIELDS = ['role', 'appearance', 'personality', 'background', 'note'];

function relationHit(row) {
  const label = (row.relation_type && (row.relation_type.label_from_focus || row.relation_type.forward_label)) || '关系';
  const quote = `${row.endpoint_a.name} —${label}— ${row.endpoint_b.name}（方向 ${row.direction}，强度 ${row.strength}，极性 ${row.polarity}${row.secrecy === 'secret' ? '，保密' : ''}${row.note ? '，备注：' + row.note : ''}）`;
  return {
    anchor: row.public_id, sourceType: 'relation', sourceId: row.public_id,
    title: `关系 · ${row.endpoint_a.name}/${row.endpoint_b.name}`,
    quote, context: quote, trustClass: 'hub_projection', canonicalStatus: 'canonical',
    relevance: 1, matchReason: '人物中枢关系投影', location: {}, stale: false,
  };
}

function eventHit(event) {
  const quote = [event.title, event.summary].filter(Boolean).join('：');
  return {
    anchor: `event:${event.id}`, sourceType: 'story_event', sourceId: String(event.id),
    title: `事件 · ${event.title}`,
    quote, context: quote, trustClass: 'hub_event', canonicalStatus: 'canonical',
    relevance: 1, matchReason: '故事事件账本',
    location: event.chapter_id ? { chapterId: event.chapter_id } : {},
    stale: !!event.source_stale,
  };
}

function cardHits(character) {
  const base = {
    anchor: `char:${character.id}`, sourceType: 'character_card', sourceId: String(character.id),
    title: `人物卡 · ${character.name}`, trustClass: 'character_card', canonicalStatus: 'canonical',
    relevance: 1, matchReason: '人物卡片资料', location: {}, stale: false,
  };
  const summary = `${character.name}：${text(character.role) || '人物'}`;
  return [
    { ...base, quote: summary, context: summary },
    ...CARD_FIELDS.filter(field => text(character[field])).map(field => ({
      ...base,
      anchor: `char:${character.id}:${field}`,
      title: `人物卡 · ${field}`,
      quote: `${field}：${text(character[field])}`,
      context: `${field}：${text(character[field])}`,
    })),
  ];
}

async function buildContext(bookId, characterId, input = {}) {
  const profile = characters.getCharacterContext(bookId, characterId);
  const relationRows = relations.getRelations(bookId, characterId, { secrecy: 'all', lifecycle: 'all' }).slice(0, 24);
  const events = ledger.getTimeline(bookId, { character_id: characterId, limit: 16 });
  const threadRows = threads.listThreads(bookId, { character_id: characterId }).slice(0, 16);
  const queries = [profile.character.name, text(input.question) || text(input.focus)].filter(Boolean);
  const retrievals = await Promise.all(queries.map(query => searchEvidence(Number(bookId), query, { topK: 16 })));
  const unique = new Map();
  retrievals.flatMap(result => result.hits || []).forEach(hit => { if (!unique.has(hit.anchor)) unique.set(hit.anchor, hit); });
  const evidence = [
    ...compactEvidence([...unique.values()]),
    ...relationRows.map(relationHit),
    ...events.map(eventHit),
    ...cardHits(profile.character),
  ];
  const revision = hash({ profile, relationRows, events, threadRows, evidence: evidence.map(hit => [hit.anchor, hit.location && hit.location.revisionHash]) });
  const evidenceRevision = hash(evidence.map(hit => [hit.anchor, hit.location && hit.location.revisionHash, hit.stale]));
  return { profile, relations: relationRows, events, threads: threadRows, evidence, anchorList: evidence.map(hit => hit.anchor), degraded: [...new Set(retrievals.flatMap(result => result.degraded || []))], revision, evidenceRevision };
}

function promptFor(context, input, correction = '') {
  const allowedTypes = (Array.isArray(input.types) ? input.types : ['A', 'B', 'C', 'D']).filter(type => TYPES.has(type));
  const evidence = context.evidence.map(hit => ({ anchor: hit.anchor, source: hit.title || hit.sourceType, quote: hit.quote || hit.context, trustClass: hit.trustClass, canonicalStatus: hit.canonicalStatus }));
  const relations = context.relations.map(row => ({
    anchor: row.public_id,
    a: row.endpoint_a && row.endpoint_a.name,
    b: row.endpoint_b && row.endpoint_b.name,
    label: row.relation_type && (row.relation_type.label_from_focus || row.relation_type.forward_label),
    direction: row.direction, strength: row.strength, polarity: row.polarity,
    lifecycle: row.lifecycle, secrecy: row.secrecy, note: row.note,
  }));
  const events = context.events.map(event => ({
    anchor: `event:${event.id}`,
    title: event.title, summary: event.summary,
    chapter: event.chapter_title, importance: event.importance,
  }));
  const card = context.profile.character || {};
  const character = Object.fromEntries(['name', 'role', 'appearance', 'personality', 'background', 'note'].map(field => [field, text(card[field])]));
  return [
    { role: 'system', content: `你是长篇小说的专用人物顾问。你没有自由工具，只能使用本消息提供的固定上下文。\n输出严格 JSON：{"suggestions":[{"type":"A|B|C|D","title":"","conclusion":"明确建议","inference":"由事实推导出的判断","assumptions":["尚未证实的前提"],"impacts":["可能影响"],"anchors":["证据锚点"]}]}。\nanchors 数组列出了全部合法锚点（char:人物卡、rel_关系、event:事件、ch:正文段落），引用必须逐字取自该数组，不得编造或改写。\n必须区分事实、推断与假设；每条建议必须引用至少一个给定锚点。类型仅可为 ${allowedTypes.join(',')}。返回 3–5 条建议。${correction}` },
    { role: 'user', content: JSON.stringify({ focus: text(input.focus), question: text(input.question), character, relations, events, threads: context.threads, evidence, anchors: context.anchorList }) },
  ];
}

async function invokeModel(bookId, messages, modelClient) {
  const result = modelClient
    ? await (typeof modelClient === 'function' ? modelClient(messages) : modelClient.call(messages))
    : await callLLMFull(messages, { maxTokens: 3000, temperature: 0.35, meta: { bookId, scope: 'advisor' } });
  return typeof result === 'string' ? result : result.content;
}

// 锚点后缀容错：模型可能写成 rel_xxx:备注 / char:10:intro:补充，逐级去掉尾部片段匹配
function resolveAnchor(anchor, allowed) {
  if (allowed.has(anchor)) return anchor;
  const parts = anchor.split(':');
  for (let end = parts.length - 1; end >= 1; end -= 1) {
    const candidate = parts.slice(0, end).join(':');
    if (allowed.has(candidate)) return candidate;
  }
  return null;
}

function parseOutput(content, context) {
  const raw = text(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw new DomainError('ADVISOR_INVALID_OUTPUT', '人物顾问返回的结构无法解析', 502); }
  const allowed = new Map(context.evidence.map(hit => [hit.anchor, hit]));
  if (!value || !Array.isArray(value.suggestions) || !value.suggestions.length) throw new DomainError('ADVISOR_INVALID_OUTPUT', '人物顾问没有返回建议', 502);
  return value.suggestions.slice(0, 5).map(item => {
    const type = text(item.type);
    const anchors = [...new Set(Array.isArray(item.anchors) ? item.anchors.map(text).filter(Boolean).map(anchor => resolveAnchor(anchor, allowed)).filter(Boolean) : [])];
    if (!TYPES.has(type) || !text(item.title) || !text(item.conclusion) || !anchors.length) {
      throw new DomainError('ADVISOR_INVALID_CITATION', '人物顾问引用了未知证据或建议字段不完整', 502, { anchors });
    }
    return { type, title: text(item.title), conclusion: text(item.conclusion), inference: text(item.inference), assumptions: Array.isArray(item.assumptions) ? item.assumptions : [], impacts: Array.isArray(item.impacts) ? item.impacts : [], anchors, citationHits: anchors.map(anchor => allowed.get(anchor)) };
  });
}

async function generate(bookId, context, input, modelClient) {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return parseOutput(await invokeModel(bookId, promptFor(context, input, attempt ? `\n上次输出不合法：${firstError.message}。只能引用给定锚点，请完整重写 JSON。` : ''), modelClient), context); }
    catch (err) {
      if (!(err instanceof DomainError) || !['ADVISOR_INVALID_CITATION', 'ADVISOR_INVALID_OUTPUT'].includes(err.code)) throw err;
      firstError = err;
    }
  }
  throw firstError;
}

function persist(bookId, characterId, input, context, generated) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const sessionId = db.run('INSERT INTO advisor_sessions (book_id, character_id, trigger_kind, focus, context_revision, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [Number(bookId), Number(characterId), text(input.trigger_kind) || 'manual', text(input.focus || input.question), context.revision, text(input.model) || llmConfig().model, now]).lastInsertRowid;
    for (const item of generated) {
      const fingerprint = hash([item.type, item.title, item.conclusion]);
      const suppressed = db.get("SELECT 1 FROM advisor_suggestions WHERE book_id = ? AND character_id = ? AND fingerprint = ? AND evidence_revision = ? AND status = 'ignored'", [Number(bookId), Number(characterId), fingerprint, context.evidenceRevision]);
      if (suppressed) continue;
      const suggestionId = db.run('INSERT INTO advisor_suggestions (session_id, book_id, character_id, suggestion_type, title, conclusion, inference, assumptions_json, impacts_json, status, fingerprint, evidence_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', ?, ?, ?, ?)', [sessionId, Number(bookId), Number(characterId), item.type, item.title, item.conclusion, item.inference, JSON.stringify(item.assumptions), JSON.stringify(item.impacts), fingerprint, context.evidenceRevision, now, now]).lastInsertRowid;
      for (const hit of item.citationHits) {
        const loc = hit.location || {};
        db.run('INSERT INTO advisor_citations (suggestion_id, anchor, source_type, source_id, quote_snapshot, trust_class, canonical_status, chapter_id, paragraph_index, char_start, char_end, revision_hash, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [suggestionId, hit.anchor, hit.sourceType, text(hit.sourceId), text(hit.quote || hit.context), text(hit.trustClass), text(hit.canonicalStatus), loc.chapterId || null, loc.paragraphIndex ?? null, loc.charStart ?? null, loc.charEnd ?? null, text(loc.revisionHash), hit.stale ? 1 : 0]);
      }
    }
    return getSession(bookId, characterId, sessionId);
  });
}

async function consultCharacter(bookId, characterId, input = {}, modelClient) {
  const context = await buildContext(bookId, characterId, input);
  if (!context.evidence.length) throw new DomainError('ADVISOR_NO_EVIDENCE', '当前没有可引用的证据，请先补充人物资料或正文', 409);
  const generated = await generate(bookId, context, input, modelClient);
  const session = persist(bookId, characterId, input, context, generated);
  return { session, suggestions: session.suggestions, degraded: context.degraded };
}

async function sandbox(bookId, characterId, input = {}, modelClient) {
  const context = await buildContext(bookId, characterId, input);
  if (!context.evidence.length) throw new DomainError('ADVISOR_NO_EVIDENCE', '当前没有可引用的证据', 409);
  const generated = await generate(bookId, context, input, modelClient);
  return { canonicalStatus: 'noncanonical', suggestions: generated.map(item => ({ ...item, citations: item.citationHits })), degraded: context.degraded };
}

async function followUp(bookId, characterId, sessionId, input = {}, modelClient) {
  const previous = getSession(bookId, characterId, sessionId);
  const prior = previous.suggestions.map(item => `${item.title}：${item.conclusion}`).join('\n');
  return consultCharacter(bookId, characterId, { ...input, trigger_kind: 'follow_up', focus: input.focus || previous.focus, question: `${text(input.question)}\n此前建议：\n${prior}` }, modelClient);
}

function findSuggestion(bookId, characterId, suggestionId) {
  const row = db.get('SELECT * FROM advisor_suggestions WHERE id = ? AND book_id = ? AND character_id = ?', [positiveId(suggestionId, 'suggestion_id'), positiveId(bookId, 'book_id'), positiveId(characterId, 'character_id')]);
  if (!row) throw new DomainError('ADVISOR_SUGGESTION_NOT_FOUND', '人物顾问建议不存在', 404);
  return suggestionRow(row);
}

function ignoreSuggestion(bookId, characterId, suggestionId) {
  const item = findSuggestion(bookId, characterId, suggestionId);
  db.run("UPDATE advisor_suggestions SET status = 'ignored', updated_at = ? WHERE id = ?", [new Date().toISOString(), item.id]);
  return findSuggestion(bookId, characterId, item.id);
}

function adoptSuggestion(bookId, characterId, suggestionId, input = {}) {
  const item = findSuggestion(bookId, characterId, suggestionId);
  const target = text(input.target);
  if (!TARGETS.has(target)) throw new DomainError('VALIDATION_ERROR', '采纳目标无效', 400);
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  let entity = null;
  if (target === 'character_profile') entity = characters.updateCharacterProfile(bookId, characterId, payload.patch || payload);
  if (target === 'event_proposal') entity = proposals.createProposal(bookId, { ...payload, title: text(payload.title) || item.title, summary: text(payload.summary) || item.conclusion, source_type: 'advisor', created_by: 'advisor', created_via: 'character_advisor' });
  if (target === 'story_thread') entity = threads.createThread(bookId, { type: payload.type || 'plan', title: text(payload.title) || item.title, summary: text(payload.summary) || item.conclusion, importance: payload.importance || 'normal', character_ids: [Number(characterId), ...(payload.character_ids || [])] });
  const entityId = entity && (entity.id || (entity.character && entity.character.id));
  db.transaction(() => {
    db.run("UPDATE advisor_suggestions SET status = 'adopted', updated_at = ? WHERE id = ?", [new Date().toISOString(), item.id]);
    db.run('INSERT INTO advisor_adoptions (suggestion_id, target_type, target_entity_type, target_entity_id, confirmation_actor, created_at) VALUES (?, ?, ?, ?, ?, ?)', [item.id, target, target, entityId == null ? '' : String(entityId), text(input.actor) || 'author', new Date().toISOString()]);
  });
  return { suggestion: findSuggestion(bookId, characterId, item.id), target, entity };
}

module.exports = { consultCharacter, sandbox, followUp, listSessions, getSession, ignoreSuggestion, adoptSuggestion, buildContext, parseOutput };
