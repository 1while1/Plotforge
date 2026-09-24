// 历史章节状态回填：把「定稿早于抽取功能上线」的章节重新过一遍事实抽取，
// 生成 history_backfill 待审提案（绝不直接改正典）；已入库的「章节+人物+字段」自动跳过，避免重复刷屏。
// 后台顺序执行（逐章 LLM 调用），start 立即返回 job_id、状态工具轮询跟进进度；采纳仍走故事台账的人工闸门。
//
// 评审 §4 长任务：
// - start/getStatus 拆分，getStatus 支持按 job_id 寻址；进程内 Map 仅本地 MVP。
// - chapter_extraction_runs 持久化每章抽取运行，提供跨重启的幂等（同章同正文修订已成功抽取则跳过）与覆盖率证据。
// - 每个任务持有自己的 AbortController，逐章之间检查取消；调用方 signal 只用于「是否启动」。
//
// 任务状态落库（方向报告 3.1 第二部分）：backfill_jobs 表是权威状态，内存 status 只是
// 活任务累加器（write-through）。重启后 getStatus 从表还原视图（不再只能报 lost）；
// resumeInterrupted 在服务启动时自动续跑死在半路的任务一次（resume_count 防崩溃循环）。
const crypto = require('crypto');
const db = require('../db');
const { extractChapterProposals, discardNote } = require('./chapterSummaryProposals');
const { revision } = require('../evidence/draftLexical');
const { DomainError } = require('./errors');

const jobs = new Map();        // bookId -> status（本进程活任务累加器；权威状态在 backfill_jobs 表）
const controllers = new Map(); // job_id -> AbortController（后台取消用，与 status 分离以保持 status 可序列化）

const BACKFILL_SOURCE = 'history_backfill';

function newJobId() {
  return `bf_${crypto.randomBytes(8).toString('hex')}`;
}

function freshStatus(bookId) {
  return {
    book_id: Number(bookId),
    job_id: null,
    running: false,
    phase: 'idle', // idle | running | done | aborted | interrupted
    total: 0,
    processed: 0,
    created: 0, // 新建提案数
    skipped_changes: 0, // 因已入库而跳过的字段变化数
    skipped_chapters: 0, // 因已成功抽取过（同正文修订）而整章跳过数
    chapters_hit: 0, // 产出了新提案的章节数
    errors: [],
    options: null,
    started_at: null,
    done_at: null,
    last_chapter_id: null,
    resume_count: 0, // 断点续跑次数（自动续跑只允许一次，防「崩溃→重启→又崩溃」循环）
  };
}

// 每章抽取运行落库（幂等键 book_id+chapter_id+revision_hash+source_type）。
// 抽取端与回填端共用，覆盖率证据统一入 chapter_extraction_runs（评审 §4/§5）。
function recordExtractionRun(bookId, chapterId, revisionHash, sourceType, jobId, fields = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO chapter_extraction_runs
       (book_id, chapter_id, revision_hash, source_type, status, job_id, proposal_count, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, chapter_id, revision_hash, source_type) DO UPDATE SET
       status = excluded.status, job_id = excluded.job_id,
       proposal_count = excluded.proposal_count, error = excluded.error, updated_at = excluded.updated_at`,
    [
      Number(bookId), Number(chapterId), String(revisionHash || ''), String(sourceType || ''),
      String(fields.status || 'success'), String(jobId || ''),
      Number(fields.proposal_count) || 0, String(fields.error || ''), now, now,
    ]
  );
}

function hasSuccessfulRun(bookId, chapterId, revisionHash, sourceType) {
  return !!db.get(
    `SELECT id FROM chapter_extraction_runs
     WHERE book_id = ? AND chapter_id = ? AND revision_hash = ? AND source_type = ? AND status = 'success'`,
    [Number(bookId), Number(chapterId), String(revisionHash || ''), String(sourceType || '')]
  );
}

// ---------- 任务状态落库（方向报告 3.1 第二部分） ----------
// write-through：内存 status 每次推进即整行落库。SQLite 单行 UPDATE 相对逐章 LLM 调用可忽略；
// 重启后 getStatus 从表还原视图、resumeInterrupted 借表断点续跑。
// started_at/done_at 存 ISO（单点写入、毫秒可排序）；updated_at 用 SQL localtime——各列单一格式。
function persistStatus(status) {
  if (!status.job_id) return;
  db.run(
    `INSERT INTO backfill_jobs
       (job_id, book_id, phase, force, total, processed, created, skipped_changes, skipped_chapters,
        chapters_hit, errors, options, started_at, done_at, last_chapter_id, resume_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(job_id) DO UPDATE SET
       phase = excluded.phase, force = excluded.force, total = excluded.total,
       processed = excluded.processed, created = excluded.created,
       skipped_changes = excluded.skipped_changes, skipped_chapters = excluded.skipped_chapters,
       chapters_hit = excluded.chapters_hit, errors = excluded.errors, options = excluded.options,
       done_at = excluded.done_at, last_chapter_id = excluded.last_chapter_id,
       resume_count = excluded.resume_count, updated_at = excluded.updated_at`,
    [
      status.job_id, Number(status.book_id), String(status.phase), status.force ? 1 : 0,
      Number(status.total) || 0, Number(status.processed) || 0, Number(status.created) || 0,
      Number(status.skipped_changes) || 0, Number(status.skipped_chapters) || 0,
      Number(status.chapters_hit) || 0,
      JSON.stringify(status.errors || []), JSON.stringify(status.options || {}),
      String(status.started_at || ''), status.done_at || null,
      status.last_chapter_id == null ? null : Number(status.last_chapter_id),
      Number(status.resume_count) || 0,
    ]
  );
}

function rowToStatus(row) {
  if (!row) return null;
  const status = {
    book_id: row.book_id,
    job_id: row.job_id,
    running: false, // 表中任务不在本进程运行（活任务走内存实时值）
    phase: row.phase,
    force: !!row.force,
    total: row.total,
    processed: row.processed,
    created: row.created,
    skipped_changes: row.skipped_changes,
    skipped_chapters: row.skipped_chapters,
    chapters_hit: row.chapters_hit,
    errors: JSON.parse(row.errors || '[]'),
    options: JSON.parse(row.options || '{}'),
    started_at: row.started_at,
    done_at: row.done_at,
    last_chapter_id: row.last_chapter_id,
    resume_count: row.resume_count,
    source: 'persisted',
  };
  if (row.phase === 'interrupted') {
    status.message = '任务因服务重启而中断，且已自动续跑过一次（防崩溃循环不再自动重试）；'
      + '可重新触发一键回填，已成功抽取且正文未变的章节会自动跳过';
  }
  return status;
}

// 按 job_id 查询：命中本进程活任务返回实时进度；否则读落库任务（3.1 第二部分，重启后视图还原）；
// 落库机制上线前的遗留 job_id 仍走抽取记录汇总的 lost 诚实回退，绝不伪装 idle/done
function getStatus(bookId, jobId) {
  const bid = Number(bookId);
  const current = jobs.get(bid);
  // 省略 job_id：返回本书当前/最近一次任务状态（UI 轮询路径，向后兼容）
  if (jobId === undefined || jobId === null || jobId === '') {
    if (current) return current;
    return rowToStatus(db.get(
      'SELECT * FROM backfill_jobs WHERE book_id = ? ORDER BY started_at DESC, job_id DESC LIMIT 1',
      [bid]
    )) || freshStatus(bid);
  }
  const wanted = String(jobId);
  if (current && current.job_id === wanted) return current;
  const persisted = rowToStatus(db.get(
    'SELECT * FROM backfill_jobs WHERE book_id = ? AND job_id = ?', [bid, wanted]
  ));
  if (persisted) return persisted;
  // 落库机制上线前的 job_id：无任务行，汇总持久化抽取记录
  const runs = db.all(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(proposal_count), 0) AS created
     FROM chapter_extraction_runs WHERE book_id = ? AND job_id = ? GROUP BY status`,
    [bid, wanted]
  );
  if (!runs.length) {
    return {
      book_id: bid, job_id: wanted, running: false, phase: 'unknown', status: 'unknown',
      total: 0, processed: 0, created: 0,
      message: '本进程无此任务记录，且无持久化抽取痕迹（可能从未存在或记录已清理）',
    };
  }
  const byStatus = {};
  let processed = 0;
  let created = 0;
  for (const row of runs) { byStatus[row.status] = row.n; processed += row.n; created += row.created; }
  return {
    book_id: bid, job_id: wanted, running: false, phase: 'lost', status: 'lost',
    total: processed, processed, created, runs_by_status: byStatus,
    message: '任务对象已不在本进程内存（多为服务重启）；以下为持久化抽取记录汇总，非实时进度',
  };
}

// 已定稿、有正文的章节，按「卷序 → 卷内章序」排列；可用 chapterIds / limit 收窄（便于小范围试跑）
function targetChapters(bookId, opts = {}) {
  const rows = db.all(
    `SELECT c.id FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE c.book_id = ? AND c.locked = 1 AND c.content IS NOT NULL AND TRIM(c.content) != ''
     ORDER BY COALESCE(v.sort_order, 2147483647), c.sort_order, c.id`,
    [Number(bookId)]
  );
  let ids = rows.map(row => row.id);
  if (Array.isArray(opts.chapterIds) && opts.chapterIds.length) {
    const wanted = new Set(opts.chapterIds.map(Number));
    ids = ids.filter(id => wanted.has(id));
  }
  if (opts.limit) ids = ids.slice(0, Math.max(1, Number(opts.limit) || 1));
  return ids;
}

// 该「章节 + 人物 + 字段」是否已有未被取代的正式事件记录过 → 回填时跳过，避免与既有正典重复
function isChangeCanonized(bookId, chapterId, change) {
  if (!change || change.change_kind !== 'character_state') return false;
  const subjectRef = change.subject_ref == null ? '' : String(change.subject_ref);
  const fieldKey = change.field_key == null ? '' : String(change.field_key);
  if (!subjectRef || !fieldKey) return false;
  return !!db.get(
    `SELECT 1 AS hit FROM story_event_changes ec
     JOIN story_events e ON e.id = ec.event_id
     WHERE ec.book_id = ? AND e.chapter_id = ? AND ec.change_kind = 'character_state'
       AND ec.subject_ref = ? AND ec.field_key = ?
       AND NOT EXISTS (SELECT 1 FROM story_events s WHERE s.supersedes_event_id = e.id)
     LIMIT 1`,
    [Number(bookId), Number(chapterId), subjectRef, fieldKey]
  );
}

function pushError(status, message) {
  status.errors.push(message);
  if (status.errors.length > 80) status.errors.shift(); // 防御：异常极多时不无限增长
}

async function runBackfill(bookId, chapterIds, status, modelClient, controller) {
  const bid = Number(bookId);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bid]);
  if (!book) { pushError(status, '书籍不存在'); return; }
  for (const chapterId of chapterIds) {
    // 后台取消：每章之间检查本任务自己的 AbortController（评审 §4，不依赖请求级 signal）
    if (controller && controller.signal.aborted) { status.aborted = true; pushError(status, '回填已取消'); return; }
    status.last_chapter_id = Number(chapterId);
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [Number(chapterId), bid]);
    if (!chapter || !chapter.content || !String(chapter.content).trim()) { status.processed++; persistStatus(status); continue; }
    const revisionHash = revision(chapter.content);
    // 幂等：同一章节同一正文修订已成功抽取过 → 整章跳过（force 时强制重抽）
    if (!status.force && hasSuccessfulRun(bid, chapterId, revisionHash, BACKFILL_SOURCE)) {
      status.processed++;
      status.skipped_chapters++;
      persistStatus(status);
      continue;
    }
    recordExtractionRun(bid, chapterId, revisionHash, BACKFILL_SOURCE, status.job_id, { status: 'running' });
    try {
      const result = await extractChapterProposals(book, chapter, String(chapter.summary || '').trim(), modelClient || null, {
        sourceType: BACKFILL_SOURCE,
        jobId: status.job_id,
        skipChange: change => isChangeCanonized(bid, chapterId, change),
      });
      const made = (result.proposals || []).length;
      status.created += made;
      status.skipped_changes += (result.skippedChanges || 0);
      if (made) status.chapters_hit++;
      if (result.warning) pushError(status, `第 ${chapterId} 章：${result.warning}`);
      // A-1（G5 审计 P1-1）：在途窗口作废必须在回填进度里逐章可见（沿用 S5-04 索引失败表示惯例），
      // 否则「本章抽了但结果是旧正文的」会与「本章没抽」不可区分。
      const discarded = result.discarded || [];
      for (const item of discarded) pushError(status, `第 ${chapterId} 章：${discardNote([item])}`);
      // status 沿用 chapter_extraction_runs 既有枚举（013 迁移 CHECK：pending/running/success/failed）：
      // 作废＝该修订没有成功抽取（覆盖率缺口可见、重跑会重试），原因码写在 error 里
      recordExtractionRun(bid, chapterId, revisionHash, BACKFILL_SOURCE, status.job_id, {
        status: discarded.length ? 'failed' : 'success',
        proposal_count: made,
        error: discarded.length ? discardNote(discarded) : (result.warning || ''),
      });
    } catch (err) {
      pushError(status, `第 ${chapterId} 章抽取失败：${err.message}`);
      recordExtractionRun(bid, chapterId, revisionHash, BACKFILL_SOURCE, status.job_id, { status: 'failed', error: err.message });
    }
    status.processed++;
    persistStatus(status); // 每章落盘进度：重启后进度可见、断点可续
  }
}

// 同步返回、后台执行：start 立即拿到 job_id + 初始进度，状态工具/前端轮询跟进
function startBackfill(bookId, opts = {}) {
  const bid = Number(bookId);
  if (!db.get('SELECT id FROM books WHERE id = ?', [bid])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404);
  }
  const existing = jobs.get(bid);
  if (existing && existing.running) return { started: false, reason: 'busy', status: existing };

  const chapterIds = targetChapters(bid, opts);
  const modelClient = typeof opts.modelClient === 'function' ? opts.modelClient : null; // 仅供测试注入；HTTP 请求体不可能携带函数
  const status = freshStatus(bid);
  status.job_id = newJobId();
  status.running = true;
  status.phase = 'running';
  status.force = opts.force === true;
  status.total = chapterIds.length;
  status.started_at = new Date().toISOString();
  status.options = {
    skip_canonized: true,
    force: status.force,
    limit: opts.limit ? Number(opts.limit) : null,
    chapter_ids: Array.isArray(opts.chapterIds) ? opts.chapterIds.map(Number) : null,
  };
  jobs.set(bid, status);
  const controller = new AbortController();
  controllers.set(status.job_id, controller);

  if (!chapterIds.length) {
    status.running = false;
    status.phase = 'done';
    status.done_at = new Date().toISOString();
    controllers.delete(status.job_id);
    persistStatus(status); // 空任务也落库（有据可查）
    return { started: true, status };
  }

  persistStatus(status); // 任务创建即落库（3.1 第二部分）
  runBackfill(bid, chapterIds, status, modelClient, controller)
    .catch(err => pushError(status, `回填异常终止：${err.message}`))
    .finally(() => {
      status.running = false;
      status.phase = status.aborted ? 'aborted' : 'done';
      status.done_at = new Date().toISOString();
      controllers.delete(status.job_id);
      persistStatus(status);
    });
  return { started: true, status };
}

// 取消本书正在运行的回填：触发其 AbortController，runBackfill 在下一章之间停下
function cancelBackfill(bookId) {
  const current = jobs.get(Number(bookId));
  if (!current || !current.running) return { cancelled: false, reason: 'not_running' };
  const controller = controllers.get(current.job_id);
  if (controller) controller.abort();
  current.aborted = true;
  return { cancelled: true, job_id: current.job_id };
}

// 启动断点续跑（3.1 第二部分，index.js 在 db.init 后调用）：
// 表中 phase='running' = 上次进程死在半路。先标 interrupted（重启≠还在跑），
// resume_count=0 的自动续跑一次（同 job_id、同 options）：非 force 只跑「无成功抽取记录」
// 的剩余章（失败章获得重试机会，processed 可能对重试章重复计数——诚实换取重试）；
// force 重抽语义下计数重置。resume_count≥1 不再自动续跑，防「崩溃→重启→又崩溃」循环。
// modelClient 仅供测试注入；生产不传，走默认 LLM 通道（与 startBackfill 相同）。
async function resumeInterrupted(opts = {}) {
  const rows = db.all("SELECT * FROM backfill_jobs WHERE phase = 'running'");
  const resumed = [];
  for (const row of rows) {
    const live = jobs.get(row.book_id);
    if (live && live.running && live.job_id === row.job_id) continue; // 本进程仍活着（非真重启）
    db.run(
      "UPDATE backfill_jobs SET phase = 'interrupted', updated_at = datetime('now','localtime') WHERE job_id = ?",
      [row.job_id]
    );
    if (row.resume_count >= 1) continue;

    const status = rowToStatus({ ...row, phase: 'interrupted' });
    const options = status.options || {};
    // 落库 options 用 snake（chapter_ids，对外展示口径）；targetChapters 读 camel，这里映射回来
    const targets = targetChapters(row.book_id, {
      limit: options.limit || null,
      chapterIds: Array.isArray(options.chapter_ids) ? options.chapter_ids : null,
    });
    let remaining = targets;
    if (!status.force) {
      remaining = targets.filter(id => {
        const chapter = db.get('SELECT content FROM chapters WHERE id = ? AND book_id = ?', [Number(id), row.book_id]);
        const hash = chapter && chapter.content ? revision(chapter.content) : '';
        return !hasSuccessfulRun(row.book_id, id, hash, BACKFILL_SOURCE);
      });
    } else {
      status.processed = 0;
      status.created = 0;
      status.skipped_changes = 0;
      status.skipped_chapters = 0;
      status.chapters_hit = 0;
    }
    status.total = targets.length;
    status.errors = [];
    status.running = true;
    status.phase = 'running';
    status.done_at = null;
    status.resume_count = (Number(row.resume_count) || 0) + 1;
    jobs.set(row.book_id, status);
    const controller = new AbortController();
    controllers.set(status.job_id, controller);
    persistStatus(status);
    resumed.push(status.job_id);
    runBackfill(row.book_id, remaining, status, opts.modelClient || null, controller)
      .catch(err => pushError(status, `续跑异常终止：${err.message}`))
      .finally(() => {
        status.running = false;
        status.phase = status.aborted ? 'aborted' : 'done';
        status.done_at = new Date().toISOString();
        controllers.delete(status.job_id);
        persistStatus(status);
      });
  }
  return { interrupted: rows.length, resumed };
}

module.exports = {
  startBackfill,
  getStatus,
  cancelBackfill,
  resumeInterrupted,
  targetChapters,
  isChangeCanonized,
  recordExtractionRun,
  hasSuccessfulRun,
};
