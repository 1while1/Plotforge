// 作家仓库 · 体检与错题库接口（/api/style-lab）。
//
// 解耦边界：本路由是「体检层」对外的**唯一**入口，体检完全旁路写作流——
// 它只读章节、只写自己的 ai_style_samples 表，失败/超时/额度耗尽都不影响写作。
// 检测器实现收在 server/detectors/，换检测器 = 加模块 + 改这里的一行映射；
// 错题库逻辑收在 server/style/samples.js，本文件只做 HTTP 编排与参数校验。
const express = require('express');
const router = express.Router();
const db = require('../db');
const samples = require('../style/samples');
const zhuque = require('../detectors/zhuque');

// 检测器注册表：当前只有朱雀。加新检测器时在这里挂一行，
// detection.detector 字段已能区分来源，错题库不需要改表。
const DETECTORS = {
  zhuque: { detect: zhuque.detect, hasKey: zhuque.hasKey, label: '朱雀' },
};

function detectorOf(name) {
  return DETECTORS[String(name || 'zhuque')] || DETECTORS.zhuque;
}

// 体检配置：开关 + 触发方式（默认手动）。
// 为什么要开关而不是直接做自动：朱雀免费版 50 万 token/月，按单章 5809 字 ≈ 6000 token 估，
// 约 80 章/月。全量自动跑会烧穿额度，且开发期不希望每次定稿都产生外部调用与费用。
function getStyleLabConfig() {
  const rows = db.all("SELECT key, value FROM settings WHERE key IN ('zhuque_api_key','style_healthcheck_mode','style_layer_enabled')") || [];
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const rawKey = map.zhuque_api_key || '';
  const mode = String(map.style_healthcheck_mode || 'manual').trim().toLowerCase();
  return {
    detector: 'zhuque',
    detector_label: DETECTORS.zhuque.label,
    detector_endpoint: zhuque.effectiveEndpoint(),
    api_key_set: Boolean(rawKey),
    api_key_masked: maskKey(rawKey),
    // 'manual' = 只在作者点按钮时检测（默认）；'auto' = 章节定稿后自动检测一次
    healthcheck_mode: mode === 'auto' ? 'auto' : 'manual',
    style_layer_enabled: !(String(map.style_layer_enabled || '').trim().toLowerCase() === '0'
      || String(map.style_layer_enabled || '').trim().toLowerCase() === 'false'),
  };
}

// 掩码：与 settings 路由同一约定，绝不回明文
function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length < 10) return '***';
  return key.slice(0, 6) + '…' + key.slice(-4);
}

router.get('/config', (req, res) => {
  res.json({ config: getStyleLabConfig() });
});

router.put('/config', (req, res) => {
  const body = req.body || {};
  const settingKeys = ['zhuque_api_key', 'style_healthcheck_mode', 'style_layer_enabled'];
  for (const key of settingKeys) {
    if (body[key] === undefined) continue;
    const value = String(body[key]);
    // 密钥字段：空串 + clear 标志才真清（与 settings 路由同一护栏，
    // 防旧版前端/缓存把空输入框无条件发过来洗掉已配置的 key）
    if (key === 'zhuque_api_key' && value.trim() === '' && body.clear_zhuque_api_key !== true) continue;
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]
    );
  }
  db.saveNow();
  res.json({ config: getStyleLabConfig() });
});

// 检测一段文本（不落库）。save=true 时把分段逐条入库做错题库标本。
router.post('/detect', async (req, res, next) => {
  try {
    const body = req.body || {};
    const text = String(body.text || '');
    const detector = detectorOf(body.detector);
    const result = await detector.detect(text, { isMerge: false });

    let saved = { inserted: 0, merged: 0, skipped: 0 };
    if (body.save === true) {
      const bookId = Number(body.book_id);
      const chapterId = Number(body.chapter_id);
      saved = samples.saveSegments(result.segments, {
        bookId: Number.isFinite(bookId) ? bookId : null,
        chapterId: Number.isFinite(chapterId) ? chapterId : null,
        chapterTitle: body.chapter_title ? String(body.chapter_title) : '',
        chapterRevision: body.chapter_revision ? String(body.chapter_revision) : null,
        source: body.source === 'manual' ? 'manual' : 'paste',
      });
    }

    res.json({
      detection_id: samples.newDetectionId(),
      detector: 'zhuque',
      overall: {
        conf: result.conf,
        labels_ratio: result.labelsRatio,
        usage_tokens: result.usageTokens,
        char_count: text.replace(/\s/g, '').length,
      },
      // 分段粒度由长度决定：短文本只回 1 段是正常的（校准实验实测）
      segments: result.segments,
      saved,
    });
  } catch (err) {
    next(err);
  }
});

// 检测整章：服务端自己取正文，省得前端搬运长文本
router.post('/detect-chapter', async (req, res, next) => {
  try {
    const body = req.body || {};
    const bookId = Number(body.book_id);
    const chapterId = Number(body.chapter_id);
    if (!Number.isFinite(bookId) || !Number.isFinite(chapterId)) {
      return res.status(400).json({ error: 'book_id 与 chapter_id 必填' });
    }
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });

    const content = String(chapter.content || '');
    if (!content.trim()) return res.status(400).json({ error: '本章正文为空，无法体检' });

    const detector = detectorOf(body.detector);
    const result = await detector.detect(content, { isMerge: false });

    // 默认落库：整章体检就是错题库最主要的语料来源，不做二次点击
    let saved = { inserted: 0, merged: 0, skipped: 0 };
    if (body.save !== false) {
      saved = samples.saveSegments(result.segments, {
        bookId,
        chapterId,
        chapterTitle: chapter.title,
        // 送检时的章节版本：章节是活的，不记这一刻的 updated_at，
        // 半年后无法知道当时检测的是哪一版正文（也就无法复现）
        chapterRevision: chapter.updated_at || null,
        source: 'chapter',
      });
      db.saveNow();
    }

    res.json({
      detection_id: samples.newDetectionId(),
      detector: 'zhuque',
      chapter: { id: chapter.id, title: chapter.title, revision: chapter.updated_at },
      overall: {
        conf: result.conf,
        labels_ratio: result.labelsRatio,
        usage_tokens: result.usageTokens,
        char_count: content.replace(/\s/g, '').length,
      },
      segments: result.segments,
      saved,
    });
  } catch (err) {
    next(err);
  }
});

// 取整章正文（改写曲线工作台用）：章节列表接口的 content 只有前 100 字，
// 而改写工作台要按段落地改字。只读、不落库、不触发任何外部调用（不烧朱雀额度）。
router.get('/chapter-text', (req, res, next) => {
  try {
    const bookId = Number(req.query.book_id);
    const chapterId = Number(req.query.chapter_id);
    if (!Number.isFinite(bookId) || !Number.isFinite(chapterId)) {
      return res.status(400).json({ error: 'book_id 与 chapter_id 必填' });
    }
    const chapter = db.get(
      'SELECT id, title, content, updated_at FROM chapters WHERE id = ? AND book_id = ?',
      [chapterId, bookId]
    );
    if (!chapter) return res.status(404).json({ error: '章节不存在' });
    res.json({
      chapter: {
        id: chapter.id,
        title: chapter.title,
        content: String(chapter.content || ''),
        revision: chapter.updated_at || null,
      },
    });
  } catch (err) { next(err); }
});

// 错题库列表
router.get('/samples', (req, res) => {
  const q = req.query || {};
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  res.json(samples.listSamples({
    bookId: num(q.book_id),
    chapterId: num(q.chapter_id),
    verdict: q.verdict,
    minConf: num(q.min_conf),
    maxConf: num(q.max_conf),
    q: q.q,
    order: q.order,
    limit: num(q.limit),
    offset: num(q.offset),
  }));
});

// 单条标本
router.get('/samples/:id', (req, res) => {
  const row = db.get('SELECT * FROM ai_style_samples WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: '标本不存在' });
  res.json({ sample: samples.toSample(row) });
});

// 人工复核（防 Goodhart 的关键入口：每条标本的判定由人拍板，机器判定只作参考）
router.patch('/samples/:id', (req, res, next) => {
  try {
    const sample = samples.reviewSample(Number(req.params.id), req.body || {});
    if (!sample) return res.status(404).json({ error: '标本不存在' });
    db.saveNow();
    res.json({ sample });
  } catch (err) {
    next(err);
  }
});

router.delete('/samples/:id', (req, res) => {
  const ok = samples.deleteSample(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '标本不存在' });
  db.saveNow();
  res.json({ ok: true });
});

// 统计：语料够不够用、都集中在哪本书
router.get('/stats', (req, res) => {
  const bookId = req.query && req.query.book_id !== undefined && req.query.book_id !== ''
    ? Number(req.query.book_id) : undefined;
  res.json({ stats: samples.stats(Number.isFinite(bookId) ? bookId : undefined) });
});

// 导出（特征提取的输入口）：默认只导已复核且非 rejected 的标本——
// 未复核的语料不该进分析，这是防污染的第一道闸门。
router.get('/samples-export', (req, res) => {
  const q = req.query || {};
  const bookId = q.book_id !== undefined && q.book_id !== '' ? Number(q.book_id) : undefined;
  const result = samples.exportSamples({
    bookId: Number.isFinite(bookId) ? bookId : undefined,
    verdict: q.verdict,
    includePending: q.include_pending === 'true' || q.include_pending === '1',
    format: q.format === 'json' ? 'json' : 'jsonl',
  });
  if (result.format === 'json') return res.json({ samples: result.samples, count: result.samples.length });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ai-style-samples.jsonl"');
  res.send(result.content);
});

// 连通性自测：用极短文本打一次真实请求，确认 key/网络可用
router.post('/test', async (req, res) => {
  try {
    const detector = detectorOf('zhuque');
    const result = await detector.detect('今天天气不错，我们出门走了走。', { isMerge: false });
    res.json({
      ok: true,
      detector: 'zhuque',
      conf: result.conf,
      labels_ratio: result.labelsRatio,
      usage_tokens: result.usageTokens,
    });
  } catch (err) {
    // 错误信息由 detector 层脱敏（绝不含明文 key）
    res.status(err.status || 502).json({ ok: false, error: err.message || String(err), code: err.code });
  }
});

// 风格包/作家卡列表（供前端选卡；实际注入在 providers/style.js）
router.get('/packs', (req, res) => {
  const packs = require('../style/packs');
  const cards = require('../style/cards');
  const bookId = req.query && req.query.book_id !== '' && req.query.book_id !== undefined
    ? Number(req.query.book_id) : undefined;
  const resolved = Number.isFinite(bookId) ? packs.resolveForBook(bookId) : null;
  const list = packs.listPacks({ bookId: Number.isFinite(bookId) ? bookId : undefined })
    .map(p => ({ ...p, stats: cards.cardStats(p.id) }));
  res.json({
    packs: list,
    // effective：这本书实际生效的卡链（主卡在前），UI 用它显示「现在用的是哪几张」
    effective: resolved ? {
      main_id: resolved.main ? resolved.main.id : null,
      aux_ids: resolved.aux.map(p => p.id),
      chain_ids: resolved.chain.map(p => p.id),
      source: resolved.source,
    } : null,
    bindings: Number.isFinite(bookId) ? packs.bindingsForBook(bookId) : null,
  });
});

// 单卡详情：整卡（人设 + 指纹 + 规则 + 范文），编辑器一次拿全
router.get('/packs/:id', (req, res) => {
  const packs = require('../style/packs');
  const cards = require('../style/cards');
  const retrieve = require('../style/retrieve');
  const pack = packs.getPack(Number(req.params.id));
  if (!pack) return res.status(404).json({ error: '卡片不存在' });
  res.json({
    pack,
    rules: packs.listRules(pack.id, { enabledOnly: false }),
    samples: retrieve.listSamples(pack.id, { enabledOnly: false }),
    stats: cards.cardStats(pack.id),
  });
});

// 建卡
router.post('/packs', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const pack = cards.createPack(req.body || {});
    db.saveNow();
    res.status(201).json({ pack });
  } catch (err) { next(err); }
});

// 改卡（不含规则：规则有独立端点）
router.put('/packs/:id', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const pack = cards.updatePack(Number(req.params.id), req.body || {});
    db.saveNow();
    res.json({ pack });
  } catch (err) { next(err); }
});

router.delete('/packs/:id', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    if (!cards.deletePack(Number(req.params.id))) return res.status(404).json({ error: '卡片不存在' });
    db.saveNow();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 注入预览：这本书现在实际会注入什么——改完卡当场看见效果，不用去写作页试。
// 这是「可热插拔」的可见性保证：不给你看注入结果，热插拔就是盲改。
router.get('/packs-preview', (req, res) => {
  const packs = require('../style/packs');
  const styleProvider = require('../context/providers/style');
  const bookId = Number(req.query.book_id);
  const resolved = Number.isFinite(bookId) ? packs.resolveForBook(bookId) : null;
  const chainIds = resolved ? resolved.chain.map(p => p.id) : [];
  const text = chainIds.length
    ? packs.compileCardsText(chainIds, { maxChars: styleProvider.STYLE_BUDGET_CHARS })
    : '';
  const rules = chainIds.reduce((n, id) => n + packs.listRules(id).length, 0);
  res.json({
    style_layer_enabled: styleProvider.styleLayerEnabled(db),
    chain: resolved ? resolved.chain.map(p => ({ id: p.id, name: p.name, kind: p.kind })) : [],
    source: resolved ? resolved.source : 'none',
    text,
    chars: Array.from(text).length,
    hanzi: (text.match(/[\u4e00-\u9fff]/g) || []).length,
    rule_count: rules,
    budget_chars: styleProvider.STYLE_BUDGET_CHARS,
  });
});

// ---- 卡内规则条目 ----

router.post('/packs/:id/rules', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const rule = cards.addRule(Number(req.params.id), req.body || {});
    db.saveNow();
    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

router.put('/rules/:ruleId', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const rule = cards.updateRule(Number(req.params.ruleId), req.body || {});
    db.saveNow();
    res.json({ rule });
  } catch (err) { next(err); }
});

router.delete('/rules/:ruleId', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    if (!cards.deleteRule(Number(req.params.ruleId))) return res.status(404).json({ error: '规则不存在' });
    db.saveNow();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- 卡内范文段落 ----

router.post('/packs/:id/samples', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const sample = cards.addSample(Number(req.params.id), req.body || {});
    db.saveNow();
    res.status(201).json({ sample });
  } catch (err) { next(err); }
});

// 删一段卡内范文（pack 域路由）。卡片范文在 style_samples 表，与错题库「标本」（ai_style_samples，
// 见上方 DELETE /samples/:id）不是同一张表；顶层 DELETE /samples/:id 被先注册的标本路由遮蔽
// （Express 取先注册者），范文删除走它会 404「标本不存在」，若 id 撞上标本行还会误删错题库数据。
// 2026-09-19 推卡实撞（报告 19），UI 与 push-cards-to-api.js 一律改走本路由。
router.delete('/packs/:id/samples/:sid', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const sid = Number(req.params.sid);
    const row = db.get('SELECT pack_id FROM style_samples WHERE id = ?', [sid]);
    if (!row || row.pack_id !== Number(req.params.id)) return res.status(404).json({ error: '范文不存在' });
    if (!cards.deleteSample(sid)) return res.status(404).json({ error: '范文不存在' });
    db.saveNow();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.put('/samples/:sampleId', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const sample = cards.updateSample(Number(req.params.sampleId), req.body || {});
    db.saveNow();
    res.json({ sample });
  } catch (err) { next(err); }
});

router.delete('/samples/:sampleId', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    if (!cards.deleteSample(Number(req.params.sampleId))) return res.status(404).json({ error: '范文不存在' });
    db.saveNow();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- 换卡：给书绑定主卡与辅卡（热插拔入口）----

router.put('/books/:bookId/cards', (req, res, next) => {
  try {
    const cards = require('../style/cards');
    const packs = require('../style/packs');
    const bookId = Number(req.params.bookId);
    if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
      return res.status(404).json({ error: '书不存在' });
    }
    const bindings = cards.setBookBindings(bookId, (req.body && req.body.bindings) || []);
    db.saveNow();
    res.json({ bindings, effective: packs.resolveForBook(bookId).chain.map(p => ({ id: p.id, name: p.name })) });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.getStyleLabConfig = getStyleLabConfig;
module.exports.DETECTORS = DETECTORS;
