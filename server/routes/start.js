// 开始界面（S5 起）：沙盘世界总览 + 砚灵向导流式对话。
// 只读 worlds 用一条相关子查询 SQL（与 GET /api/books 同一书集与排序，见 books.js）；
// guide 不挂工具、不写业务库，唯一落库是 llm_calls 台账行。
const express = require('express');
const db = require('../db');
const { llmConfig, fetchChatCompletion, readChatSSEStream, STREAM_STALL_TIMEOUT_MS } = require('../llm');
const llmCallLog = require('../llmCallLog');
const runSvc = require('../runtime/run-service');

const router = express.Router();

const GUIDE_SCOPE = 'start:guide';
const MAX_HISTORY = 12;
const MAX_CONTENT_CHARS = 2000;
const MAX_INTRO_CHARS = 140;
const MAX_PROMPT_WORLDS = 12;
const MAX_REGIONS = 6;
const MAX_CAST = 12;
const MAX_LANDMARKS = 8;
const MAX_NAME_CHARS = 16;

// 人物分级只看作者写的 role 文本：主角/视点人物最醒目，配角/反派次之，龙套与空白最小
function castTier(role) {
  const r = String(role || '');
  if (/龙套|路人|群体|群众|乘客/.test(r)) return 'minor';
  if (/主角|主人公|视点/.test(r)) return 'lead';
  if (/重要|主要|配角|反派|导师|对手/.test(r)) return 'major';
  return 'minor';
}
const TIER_RANK = { lead: 0, major: 1, minor: 2 };

function clip(text) {
  return String(text || '').trim().slice(0, MAX_NAME_CHARS);
}

// 每本书的卷分区（含未归卷章节）、出场人物、设定地标：三条按书分组的查询，避免逐书 N+1
function loadWorldDetails() {
  const regions = new Map();
  const volumeRows = db.all('SELECT id, book_id, title FROM volumes ORDER BY book_id, sort_order, id');
  const chapterRows = db.all(`
    SELECT book_id, volume_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS words
    FROM chapters GROUP BY book_id, volume_id
  `);
  const tally = new Map(chapterRows.map(r => [`${r.book_id}:${r.volume_id ?? ''}`, r]));
  for (const v of volumeRows) {
    const t = tally.get(`${v.book_id}:${v.id}`);
    if (!regions.has(v.book_id)) regions.set(v.book_id, []);
    regions.get(v.book_id).push({ title: clip(v.title), chapters: Number(t?.n) || 0, words: Number(t?.words) || 0 });
  }
  for (const r of chapterRows) {
    if (r.volume_id != null && volumeRows.some(v => v.id === r.volume_id)) continue;
    if (!regions.has(r.book_id)) regions.set(r.book_id, []);
    const list = regions.get(r.book_id);
    const loose = list.find(x => x.loose);
    if (loose) {
      loose.chapters += Number(r.n) || 0;
      loose.words += Number(r.words) || 0;
    } else {
      list.push({ title: '未归卷', chapters: Number(r.n) || 0, words: Number(r.words) || 0, loose: true });
    }
  }

  const cast = new Map();
  for (const c of db.all('SELECT book_id, name, role FROM characters WHERE archived_at IS NULL ORDER BY book_id, id')) {
    if (!cast.has(c.book_id)) cast.set(c.book_id, []);
    cast.get(c.book_id).push({ name: clip(c.name), tier: castTier(c.role) });
  }
  const landmarks = new Map();
  for (const w of db.all('SELECT book_id, title FROM world_entries ORDER BY book_id, id')) {
    if (!landmarks.has(w.book_id)) landmarks.set(w.book_id, []);
    const list = landmarks.get(w.book_id);
    if (list.length < MAX_LANDMARKS) list.push(clip(w.title));
  }

  return (bookId) => ({
    regions: (regions.get(bookId) || [])
      .filter(r => r.chapters > 0 || !r.loose)
      .slice(0, MAX_REGIONS)
      .map(({ title, chapters, words }) => ({ title, chapters, words })),
    cast: (cast.get(bookId) || [])
      .map((c, i) => ({ ...c, i }))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.i - b.i)
      .slice(0, MAX_CAST)
      .map(({ name, tier }) => ({ name, tier })),
    landmarks: landmarks.get(bookId) || [],
  });
}

// 与 GET /api/books 同源口径：书集来自 books 全表、按 updated_at DESC；
// 章节已被删者在章回收时就从 chapters 移除（server/domain/chapterRecycle.js），
// 故此处计数天然不含回收站章节，与作者在章节列表看到的条数一致。
// 人物计数与人物页默认列表同口径：不含已归档人物。
function listWorlds() {
  const detailOf = loadWorldDetails();
  return db.all(`
    SELECT b.id, b.title, b.intro, b.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapters,
           (SELECT COALESCE(SUM(LENGTH(c.content)), 0) FROM chapters c WHERE c.book_id = b.id) AS words,
           (SELECT COUNT(*) FROM characters ch WHERE ch.book_id = b.id AND ch.archived_at IS NULL) AS character_count,
           (SELECT COUNT(*) FROM world_entries w WHERE w.book_id = b.id) AS world_count,
           (SELECT COUNT(*) FROM volumes v WHERE v.book_id = b.id) AS volume_count,
           (SELECT c.title FROM chapters c WHERE c.book_id = b.id
             ORDER BY c.sort_order DESC, c.id DESC LIMIT 1) AS lastChapterTitle
    FROM books b
    ORDER BY b.updated_at DESC
  `).map(row => ({
    id: row.id,
    title: row.title,
    intro: String(row.intro || '').trim().slice(0, MAX_INTRO_CHARS),
    updatedAt: row.updatedAt,
    chapters: Number(row.chapters) || 0,
    words: Number(row.words) || 0,
    characters: Number(row.character_count) || 0,
    worldEntries: Number(row.world_count) || 0,
    volumes: Number(row.volume_count) || 0,
    lastChapterTitle: row.lastChapterTitle || '',
    ...detailOf(row.id),
  }));
}

function formatWords(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

// 向导系统提示（纯函数，便于单测）：只报统计事实，不替作者改动任何内容。
function buildGuidePrompt(worlds, focusBookId) {
  const list = Array.isArray(worlds) ? worlds.slice(0, MAX_PROMPT_WORLDS) : [];
  const lines = [
    '你是砚灵，墨砚 AI 小说工坊开始界面里的一只小机器人向导，住在作者的掌中沙盘上。',
    '每本书是砚池上空的一片浮空群岛：每一卷是一座岛，章节越多岛上聚落越大（营地、村落、城镇、城池），',
    '人物是岛上走动的小人（主角最醒目），世界观设定是挂着名字的地标，每五条设定凝成一枚悬浮晶石。',
    '',
    '回答要求：',
    '- 用简短、亲切、有画面感的中文回答，一般不超过 150 字；不用表情符号。',
    '- 可以帮作者回顾各本书的进度、建议今天从哪本书继续、解释开始界面怎么用（点岛屿看详情，「进入这本书」去写作页，「进入书架」去书架）。',
    '- 不编造书里没有的数据，只引用下面的统计。',
    '- 不能替作者改动任何内容，需要动手时引导他进入对应书籍。',
    '',
    '沙盘上的世界（截至现在）：',
  ];
  if (!list.length) {
    lines.push('沙盘上还没有任何世界，鼓励作者进入书架新建第一本书。');
  } else {
    for (const w of list) {
      let line = `《${w.title}》：${w.chapters} 章，约 ${formatWords(w.words)} 字，人物 ${w.characters} 个，设定 ${w.worldEntries} 条`;
      if (w.lastChapterTitle) line += `，最近一章「${w.lastChapterTitle}」`;
      const regions = Array.isArray(w.regions) ? w.regions : [];
      if (regions.length > 1) line += `；分卷：${regions.map(r => `${r.title}（${r.chapters} 章）`).join('、')}`;
      const leads = (Array.isArray(w.cast) ? w.cast : []).filter(c => c.tier === 'lead').map(c => c.name);
      if (leads.length) line += `；主角：${leads.slice(0, 3).join('、')}`;
      lines.push(line);
    }
    const focus = list.find(w => w.id === Number(focusBookId));
    if (focus) lines.push(`作者当前选中的岛：《${focus.title}》`);
  }
  return lines.join('\n');
}

function parseHistory(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages 必须是非空数组' };
  }
  const history = [];
  for (const item of raw.slice(-MAX_HISTORY)) {
    const role = item && item.role;
    if (role !== 'user' && role !== 'assistant') {
      return { error: 'messages 每项 role 只能是 user 或 assistant' };
    }
    const content = item && typeof item.content === 'string' ? item.content : '';
    if (!content.trim()) {
      return { error: 'messages 每项 content 不能为空' };
    }
    history.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
  }
  if (history[history.length - 1].role !== 'user') {
    return { error: '最后一条消息必须是用户发言' };
  }
  return { history };
}

router.get('/worlds', (req, res, next) => {
  try {
    res.json({ worlds: listWorlds() });
  } catch (err) {
    next(err);
  }
});

router.post('/guide/stream', (req, res, next) => {
  const body = req.body || {};
  const parsed = parseHistory(body.messages);
  if (parsed.error) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error } });
  }
  const focus = Number(body.focusBookId);
  const focusBookId = Number.isInteger(focus) && focus > 0 ? focus : null;

  // 沙盘统计在写流头之前读：读不出来就按普通 500 返回，绝不用「沙盘还空着」掩盖故障
  let worlds;
  try {
    worlds = listWorlds();
  } catch (err) {
    return next(err);
  }

  // AGENTS.md §4：任何触发模型流的入口都必须走单飞闸门（此闸门与写作单飞互不干扰，独立 scope）
  const owner = `guide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (!runSvc.acquireScopes([GUIDE_SCOPE], owner).ok) {
    return res.status(409).json({ error: { code: 'CHAT_BUSY', message: '砚灵还在回答上一句，请稍候再发' } });
  }

  const { baseUrl, apiKey, model } = llmConfig();
  if (!baseUrl || !model) {
    runSvc.releaseScopes([GUIDE_SCOPE], owner);
    return res.status(400).json({ error: { code: 'LLM_NOT_CONFIGURED', message: '还没有配置模型，请先到设置页填写' } });
  }

  let clientGone = false;
  const abort = new AbortController();
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    abort.abort(new Error('client disconnected'));
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  let fullText = '';
  let finishReason = '';
  let usage = null;
  let status = 'ok';
  let errorText = '';
  const startedAt = Date.now();
  const send = (ev) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  (async () => {
    try {
      const upstream = await fetchChatCompletion({
        baseUrl,
        apiKey,
        body: {
          model,
          messages: [{ role: 'system', content: buildGuidePrompt(worlds, focusBookId) }, ...parsed.history],
          max_tokens: 900,
          temperature: 0.8,
          stream: true,
          stream_options: { include_usage: true },
        },
        signal: abort.signal,
      });
      const r = await readChatSSEStream(upstream, (json, choice) => {
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) send({ type: 'reasoning', text: reasoning });
        if (delta.content) {
          fullText += delta.content;
          send({ type: 'content', text: delta.content });
        }
      }, { stallMs: STREAM_STALL_TIMEOUT_MS, signal: abort.signal });
      finishReason = r.finishReason || '';
      usage = r.usage || null;
      send({ type: 'done', content: fullText, usage });
    } catch (err) {
      if (clientGone || (err && err.__userAbort)) {
        status = 'aborted';
        errorText = '客户端断连：这次回答已中止';
      } else {
        status = 'error';
        errorText = String((err && err.message) || err).slice(0, 300);
        send({ type: 'error', error: { code: (err && err.code) || 'LLM_ERROR', message: errorText } });
      }
    } finally {
      runSvc.releaseScopes([GUIDE_SCOPE], owner);
      llmCallLog.record({
        bookId: null,
        scope: 'start-guide',
        model,
        baseUrl,
        promptTokens: usage && usage.prompt_tokens,
        completionTokens: usage && usage.completion_tokens,
        finishReason,
        status,
        error: errorText,
        durationMs: Date.now() - startedAt,
      });
      try {
        if (!res.writableEnded) res.end();
      } catch (_) { /* 客户端已断：流已关闭，无需再结束 */ }
    }
  })();
});

module.exports = router;
module.exports.buildGuidePrompt = buildGuidePrompt;
