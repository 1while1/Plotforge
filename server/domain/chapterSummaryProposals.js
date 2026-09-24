const { callLLMFull, llmConfig } = require('../llm');
const proposals = require('./proposals');
const { revision } = require('../evidence/draftLexical');

const VALID_IMPORTANCE = new Set(['low', 'normal', 'high', 'critical']);

function text(value) { return value == null ? '' : String(value).trim(); }
function parse(content) {
  const raw = text(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.proposals)) throw new Error('缺少 proposals 数组');
  return value.proposals.slice(0, 12);
}

async function extractChapterProposals(book, chapter, summary, modelClient, opts = {}) {
  const database = require('../db');
  const sourceType = opts.sourceType || 'chapter_summary';
  const sourcePath = sourceType === 'history_backfill' ? 'backfill' : 'finalize';
  const skipChange = typeof opts.skipChange === 'function' ? opts.skipChange : null;
  // A-1（G5 审计 P1-1）出生时验指纹：模型请求（await）**之前**记下本章正文修订哈希，
  // await 返回后在写入 event_proposals 的同一个同步事务里重读当前正文再算一次比对，
  // 不一致则整批不创建（旧来源提案若以 pending 落库，就会被采纳写进正典＝旧异步结果洗白）。
  // 只比正文哈希：标题/移卷/总结变化不误伤（与 S5-01 sourceGuard 的严格取向相反是有意的，
  // 提案的依据就是正文本身，summary 只在输入里附带）。
  const sourceHashAtCapture = revision(chapter.content);
  const stateFields = database.all('SELECT field_key, label, value_type FROM state_field_definitions WHERE book_id = ? AND enabled = 1 ORDER BY sort_order', [book.id]);
  // 人物表（id↔姓名）随抽取一并喂给模型：subject_ref 必须落到真实数字 id，否则提案无法映射到人物、投影无从应用
  const roster = database.all('SELECT id, name, role FROM characters WHERE book_id = ? ORDER BY id', [book.id])
    .map(row => ({ id: row.id, name: row.name, role: row.role || '' }));
  const rosterIds = new Set(roster.map(row => row.id));
  const messages = [
    { role: 'system', content: '你是小说事实抽取器。只识别本章明确发生的人物状态或人物关系变化，不推测。输出严格 JSON：{"proposals":[{"title":"","summary":"","paragraph_index":0,"importance":"normal","source_quote":"原文短句","confidence":0.8,"changes":[{"change_kind":"character_state","subject_ref":人物数字id,"field_key":"允许字段","old_value":null,"new_value":"新值","metadata":{}}]}]}。subject_ref 必须填【人物表】里对应人物的数字 id（不要填人名），且该人物必须在本章正文中以姓名或明确指代真实出现——严禁把变化安到本章未出现的人物上。正文中可能出现简称或称呼（如正文写『陈婷』而人物表叫『陈婷曰』），请先判断指代再归属；对应不上且无把握时就跳过该条不要输出。field_key 只能从【状态字段】里选。关系变化必须提供系统已有的完整关系快照；不确定就不输出。不得直接写正典。' },
    { role: 'user', content: JSON.stringify({ book: { id: book.id, title: book.title }, chapter: { id: chapter.id, title: chapter.title, content: text(chapter.content).slice(0, 12000) }, summary, 人物表: roster, 状态字段: stateFields }) },
  ];
  // LLM 偶发返回截断/非法 JSON：解析失败时放宽输出预算并升温重试一次（批量回填跨多章，瞬时故障不应让整章丢失）
  const callOnce = async (maxTokens, temperature) => {
    const result = modelClient ? await modelClient(messages) : await callLLMFull(messages, { maxTokens, temperature, meta: { bookId: book.id, scope: 'chapter-extract' } });
    return parse(typeof result === 'string' ? result : result.content);
  };
  let candidates;
  try {
    candidates = await callOnce(2600, 0.15);
  } catch (firstErr) {
    try {
      candidates = await callOnce(3600, 0.35);
    } catch (secondErr) {
      return { proposals: [], warning: `状态变化提取失败：${secondErr.message}`, skippedChanges: 0 };
    }
  }
  const created = [];
  const warnings = [];
  let skippedChanges = 0;
  const inputs = [];
  for (const candidate of candidates) {
    const imp = String(candidate.importance || '').toLowerCase();
    const importance = VALID_IMPORTANCE.has(imp) ? imp : 'normal';
    let changes = Array.isArray(candidate.changes) ? candidate.changes : [];
    // 值归一化统一交给 proposals.createProposal → ledger.normalizeStateValue（评审 §1 硬化A）：
    // list 型单值包装为数组在提案落库时完成，抽取端不再各自包装，避免两处归一规则漂移。
    // 归属校验：subject_ref 必须命中人物表真实 id——LLM 偶发对无名指代填 0/不存在的 id，此类变化无法映射到角色，丢弃并计数
    // importance 白名单外一律归一化（如 medium/HIGH→normal/high）：字段小瑕疵不应让整条有效提案被丢
    changes = changes.filter(change => {
      const ref = Number(String(change.subject_ref == null ? '' : change.subject_ref));
      const invalidRef = !Number.isInteger(ref) || !rosterIds.has(ref);
      if (invalidRef) { skippedChanges++; return false; }
      if (skipChange && skipChange(change)) { skippedChanges++; return false; }
      return true;
    });
    if (!changes.length) continue;
    inputs.push({
      ...candidate,
      importance,
      changes,
      source_type: sourceType,
      chapter_id: chapter.id,
      source_revision_hash: sourceHashAtCapture,
      extraction_model: llmConfig().model,
      created_by: 'extractor',
      created_via: 'chapter_extraction',
      created_model: llmConfig().model,
      job_id: text(opts.jobId),
    });
  }
  const outcome = commitExtractedProposals({
    book,
    chapterId: chapter.id,
    sourcePath,
    sourceHashAtCapture,
    inputs,
    model: llmConfig().model,
    jobId: text(opts.jobId),
  });
  created.push(...outcome.created);
  warnings.push(...outcome.warnings);
  return {
    proposals: created,
    warning: warnings.length ? warnings.join('；') : null,
    skippedChanges,
    discarded: outcome.discarded ? [outcome.discarded] : [],
  };
}

// A-1（G5 审计 P1-1）出生时验指纹的落库点：**同一个同步 db.transaction** 内
// 「重读当前正文 + 比对 + （一致才）整批创建」，核验与写入之间没有 await。
//  · 不一致 → 不创建任何 event_proposals 行，在同事务内写 030 墓碑行并返回显式作废记录
//    （三件套溯源：结构化日志 / 返回值 discarded 记录 / llm_calls 中该次调用自身留行）；
//  · 一致 → 逐条创建；单条校验失败只记警告，不毒掉整批（与旧行为一致）。
// db 不支持嵌套事务，故这里自己开事务、逐条走 proposals.createProposalInTransaction（不自行开事务）。
function commitExtractedProposals({ book, chapterId, sourcePath, sourceHashAtCapture, inputs, model, jobId }) {
  const database = require('../db');
  const warnings = [];
  // 没有任何候选（模型判定本章无状态变化）：没有 AI 结果可丢弃，因此不核验也不写墓碑——
  // 否则每次「改稿 + 定稿但无提案」都会在全局墓碑表留一行噪声，把审计事实稀释成日常噪音。
  if (!inputs.length) return { created: [], discarded: null, warnings };
  const outcome = database.transaction(() => {
    const row = database.get('SELECT content FROM chapters WHERE id = ? AND book_id = ?', [Number(chapterId), book.id]);
    const currentHash = row ? revision(row.content) : '';
    if (!row || currentHash !== sourceHashAtCapture) {
      const discarded = {
        chapterId: Number(chapterId),
        code: row ? 'SOURCE_CHANGED' : 'CHAPTER_MISSING',
        expectedHash: sourceHashAtCapture,
        currentHash,
        candidateCount: inputs.length,
      };
      recordProposalDiscard({ bookId: book.id, sourcePath, model, jobId, ...discarded });
      return { created: [], discarded };
    }
    const created = [];
    for (const input of inputs) {
      try { created.push(proposals.createProposalInTransaction(book.id, input)); }
      catch (err) { warnings.push(`${text(input.title) || '未命名提案'}：${err.message}`); }
    }
    return { created, discarded: null };
  });
  if (outcome.discarded) {
    // 三件套溯源之一：结构化日志行（时间/bookId/chapterId/候选数/旧哈希/当前哈希/原因码/触发路径）
    console.warn(
      `[人物中枢] 提案抽取作废：${new Date().toISOString()} book=${book.id} chapter=${chapterId}` +
      ` path=${sourcePath} code=${outcome.discarded.code} candidates=${inputs.length}` +
      ` expected=${String(sourceHashAtCapture).slice(0, 12)}… current=${String(outcome.discarded.currentHash || '(章节已不存在)').slice(0, 12)}…` +
      ` model=${model || '(未知)'} —— 模型调用期间依据的正文已变化，整批不创建`
    );
  }
  return { ...outcome, warnings };
}

// 030 墓碑台账（全局表：不挂书级外键、不进 bookBackup、删书留作痕）。
// 只在 commitExtractedProposals 的事务内调用，与「整批不创建」同一次提交。
function recordProposalDiscard({ bookId, chapterId, code, expectedHash, currentHash, candidateCount, sourcePath, model, jobId }) {
  const database = require('../db');
  database.run(
    `INSERT INTO proposal_discards
       (book_id, chapter_id, source_path, reason, expected_hash, current_hash, candidate_count, model, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(bookId), Number(chapterId), sourcePath, code,
      text(expectedHash), text(currentHash), Number(candidateCount) || 0,
      text(model), jobId ? text(jobId) : null, new Date().toISOString(),
    ]
  );
}

// 作废的显式文案（定稿路径与回填路径共用，措辞里带上原因码与双哈希前缀，便于从覆盖率/错误列表反查墓碑行）
function discardNote(discarded) {
  return discarded
    .map(item => `${item.code}：模型调用期间本章正文已变化，候选 ${item.candidateCount} 条整批作废`
      + `（expected ${String(item.expectedHash).slice(0, 12)}… / current ${String(item.currentHash || '(章节已不存在)').slice(0, 12)}…）`)
    .join('；');
}

module.exports = { extractChapterProposals, parse, scheduleChapterExtraction, discardNote };

// ---------------- 后台调度：正文变化后自动抽取状态提案 ----------------
// 提案仍是 pending，进账本工作台等作者审核；抽取失败只记日志，不影响写作主流程
const extractTimers = new Map();
const extractRunning = new Set();

function scheduleChapterExtraction(bookId, chapterId, delayMs = 6000) {
  const key = `${Number(bookId)}:${Number(chapterId)}`;
  if (extractRunning.has(key)) return 'busy';
  if (extractTimers.has(key)) clearTimeout(extractTimers.get(key));
  const timer = setTimeout(() => {
    extractTimers.delete(key);
    extractRunning.add(key);
    (async () => {
      const database = require('../db');
      const backfill = require('./backfill'); // 运行时 lazy require，避免与 backfill 的顶层循环依赖
      const chapter = database.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [Number(chapterId), Number(bookId)]);
      const book = chapter && database.get('SELECT * FROM books WHERE id = ?', [Number(bookId)]);
      if (!chapter || !book || !chapter.content) return;
      const revisionHash = revision(chapter.content);
      // 覆盖率留痕：定稿自动抽取也写入 chapter_extraction_runs，供体检区分「从未抽取」与「抽取失败」
      backfill.recordExtractionRun(bookId, chapterId, revisionHash, 'chapter_summary', '', { status: 'running' });
      try {
        const created = await extractChapterProposals(book, chapter, text(chapter.summary));
        const discarded = created.discarded || [];
        // A-1：在途窗口作废的显式表示（沿用 S5-04 索引失败表示惯例）——覆盖率面板据此显示
        // 「本章当前修订仍无成功抽取」，缺口可见、可重定稿或一键回填，不静默。
        // 注意 status 只能用 chapter_extraction_runs 既有枚举（013 迁移的 CHECK：pending/running/success/failed）：
        // 作废对覆盖率而言就是「该修订没有成功抽取」，故记 failed，原因码与双哈希写在 error 里，
        // 并在 030 墓碑表留独立行。
        backfill.recordExtractionRun(bookId, chapterId, revisionHash, 'chapter_summary', '', {
          status: discarded.length ? 'failed' : 'success',
          proposal_count: created.proposals.length,
          error: discarded.length ? discardNote(discarded) : (created.warning || ''),
        });
        console.log(`[人物中枢] 第 ${chapterId} 章后台状态抽取完成：${created.proposals.length} 条提案${created.warning ? `（${created.warning}）` : ''}`);
      } catch (err) {
        backfill.recordExtractionRun(bookId, chapterId, revisionHash, 'chapter_summary', '', { status: 'failed', error: err.message });
        console.error(`[人物中枢] 第 ${chapterId} 章后台状态抽取失败：${err.message}`);
      }
    })().catch(err => {
      console.error(`[人物中枢] 第 ${chapterId} 章后台状态抽取异常：${err.message}`);
    }).finally(() => {
      extractRunning.delete(key);
    });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  extractTimers.set(key, timer);
  return 'scheduled';
}
