// S4-01a / 任务书 05 + 契约 01 §6：受控资源目录（catalog）。
// HTTP 路由（server/routes/resources.js）与模型只读工具（list_resources /
// get_resource_summary）共用本模块——类型枚举、字段、分页与错误码只有一份实现，
// 路由与工具里都不再写第二份 SQL。
//
// 硬边界（任何一条都不允许为了「方便」放宽）：
//   1) type 是固定枚举，各自映射到本文件里写死的 SQL 字符串；用户输入只作为绑定参数，
//      永不进入表名/列名/路径（无字符串拼接）。非法 type 一律 400。
//   2) 只返回白名单字段（业务 id/名称/范围/状态/内部路由/摘要），不返回整章正文原文、
//      settings 原文、密钥、Authorization、真实配置路径或语料文件路径。
//   3) 书内类型必须显式给 bookId 且该书存在；引用不可跨书——跨书与不存在同为 404，
//      不泄露「这个 id 在别的书里存在」。
//   4) 已删除引用（回收站章节）返回空态 200 而不是错误；空集合返回空数组。
//   5) 全部只读：本模块不提供任何写入口，也没有「删除/改密钥」类能力。
const db = require('../db');
const { DomainError } = require('../domain/errors');

const RESOURCE_TYPES = Object.freeze([
  'book', 'chapter', 'outline', 'character', 'world', 'ledger', 'style', 'corpus', 'task', 'system',
]);
const TYPE_SET = new Set(RESOURCE_TYPES);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SUMMARY_TEXT_MAX = 300;

// id/cursor 只接受有界标识（字母数字 _ -），从根上拒绝 ../、反斜杠、引号、空格：
// 不靠「过滤特殊字符」而靠「只放行白名单字符」。
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
const NUMERIC_ID = /^[0-9]{1,18}$/;

function capText(value, max = SUMMARY_TEXT_MAX) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function charCount(value) {
  return String(value == null ? '' : value).replace(/\s/g, '').length;
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const s = String(raw).trim();
  if (!NUMERIC_ID.test(s)) throw new DomainError('INVALID_LIMIT', 'limit 必须是正整数', 400, { limit: String(raw) });
  const n = Number(s);
  if (n < 1) throw new DomainError('INVALID_LIMIT', 'limit 必须大于 0', 400, { limit: n });
  return Math.min(n, MAX_LIMIT);
}

function parseCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (!NUMERIC_ID.test(s)) throw new DomainError('INVALID_CURSOR', 'cursor 无效：请使用上一次响应返回的 nextCursor', 400, { cursor: String(raw) });
  return Number(s);
}

function assertType(raw) {
  const type = typeof raw === 'string' ? raw.trim() : '';
  if (!TYPE_SET.has(type)) {
    throw new DomainError('INVALID_RESOURCE_TYPE', `资源类型必须是：${RESOURCE_TYPES.join('、')}`, 400, { type: raw == null ? null : String(raw) });
  }
  return type;
}

// 书内类型必须显式绑定一本书；全局类型默认不接受 bookId（样式卡/任务可作为过滤器）。
function resolveBookId(spec, rawBookId) {
  const empty = rawBookId === undefined || rawBookId === null || rawBookId === '';
  if (empty) {
    if (spec.kind === 'book') {
      throw new DomainError('BOOK_REQUIRED', '该资源类型必须指定 bookId', 400, { type: spec.type });
    }
    return null;
  }
  if (spec.kind === 'global' && !spec.bookFilter) {
    throw new DomainError('RESOURCE_FIELD_FORBIDDEN', `type=${spec.type} 不接受 bookId`, 400, { field: 'bookId' });
  }
  const s = String(rawBookId).trim();
  if (!NUMERIC_ID.test(s)) throw new DomainError('INVALID_BOOK_ID', 'bookId 必须是正整数', 400, { bookId: String(rawBookId) });
  const bookId = Number(s);
  if (!db.get('SELECT id FROM books WHERE id = ?', [bookId])) {
    throw new DomainError('BOOK_NOT_FOUND', '书籍不存在', 404, { bookId });
  }
  return bookId;
}

function parseSafeId(raw, { code = 'INVALID_RESOURCE_ID', label = 'id' } = {}) {
  const s = String(raw).trim();
  if (!SAFE_ID.test(s)) {
    throw new DomainError(code, `${label} 无效：只接受字母数字与 _-（不接受路径或通配）`, 400, { [label]: s.slice(0, 80) });
  }
  return s;
}

function notFound(type, id, bookId) {
  return new DomainError('RESOURCE_NOT_FOUND', '资源不存在或不属于当前书籍', 404, { type, id, bookId: bookId || null });
}

// 该类型是否接受 bookId：书内类型（必需）与 style/task（可选过滤器）为真。
function acceptsBookId(type) {
  const spec = TYPES[type];
  return !!spec && (spec.kind === 'book' || !!spec.bookFilter);
}

// 分页：统一按 rowid 单调游标（对 TEXT 主键的运行表同样适用）。
// 游标指向的行若已被删除，`rowid >` 比较依旧成立——续读不报错，这是「已删除引用空态」的
// 分页侧语义，而不是绕过校验。
function fetchPage(spec, { bookId, after, limit }) {
  const from = spec.from(bookId);
  // 游标列默认 rowid；带 JOIN 的类型（如作家卡绑定表）用限定列名，避免「ambiguous column name」
  const cursorColumn = spec.cursorColumn || 'rowid';
  const cmp = spec.order === 'desc' ? '<' : '>';
  const clause = after == null ? '' : ` AND ${cursorColumn} ${cmp} ?`;
  const params = after == null ? [...from.params, limit] : [...from.params, after, limit];
  const order = spec.order === 'desc' ? 'DESC' : 'ASC';
  return db.all(`SELECT ${spec.select} ${from.sql}${clause} ORDER BY ${cursorColumn} ${order} LIMIT ?`, params);
}

// 说明：每个类型的摘要查询直接用固定 SQL（见 TYPES 表），不共用拼装函数——
// 少一层间接，SQL 与返回字段在同一处可读。


const TYPES = {
  book: {
    type: 'book',
    kind: 'global',
    select: `rowid AS anchor, id, title, mode, updated_at,
      (SELECT COUNT(*) FROM chapters c WHERE c.book_id = books.id) AS chapter_count`,
    from: () => ({ sql: 'FROM books', params: [] }),
    item: row => ({
      type: 'book',
      id: row.id,
      title: row.title,
      bookId: row.id,
      status: row.mode || 'collab',
      route: `#/book/${row.id}`,
      updatedAt: row.updated_at || null,
      meta: { mode: row.mode || 'collab', chapterCount: row.chapter_count },
    }),
    summary: ({ id }) => {
      const row = db.get('SELECT id, title, intro, mode, master_outline, updated_at FROM books WHERE id = ?', [id]);
      if (!row) throw notFound('book', id, null);
      return {
        type: 'book',
        id: row.id,
        bookId: row.id,
        found: true,
        title: row.title,
        status: row.mode || 'collab',
        route: `#/book/${row.id}`,
        updatedAt: row.updated_at || null,
        meta: {
          mode: row.mode || 'collab',
          chapterCount: db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [row.id]).n,
          characterCount: db.get('SELECT COUNT(*) AS n FROM characters WHERE book_id = ?', [row.id]).n,
          volumeCount: db.get('SELECT COUNT(*) AS n FROM volumes WHERE book_id = ?', [row.id]).n,
          eventCount: db.get('SELECT COUNT(*) AS n FROM story_events WHERE book_id = ?', [row.id]).n,
        },
        details: { intro: capText(row.intro), masterOutlineChars: charCount(row.master_outline) },
      };
    },
  },

  chapter: {
    type: 'chapter',
    kind: 'book',
    select: `rowid AS anchor, id, book_id, title, sort_order, locked, revision, volume_id, updated_at,
      LENGTH(COALESCE(content, '')) AS content_chars,
      LENGTH(COALESCE(summary, '')) AS summary_chars`,
    from: bookId => ({ sql: 'FROM chapters WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'chapter',
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      status: row.locked ? 'locked' : 'draft',
      route: `#/book/${row.book_id}/read/${row.id}`,
      updatedAt: row.updated_at || null,
      meta: {
        sortOrder: row.sort_order,
        revision: row.revision,
        locked: !!row.locked,
        volumeId: row.volume_id || null,
        charCount: row.content_chars,
      },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get(
        `SELECT id, book_id, title, summary, beat, locked, revision, volume_id, drift_status, updated_at,
                LENGTH(COALESCE(content, '')) AS content_chars
         FROM chapters WHERE book_id = ? AND id = ?`,
        [bookId, id]
      );
      if (!row) {
        // 已删除引用（回收站）：返回空态而不是错误——引用还在，内容已不在正典
        const recycled = db.get(
          'SELECT title, deleted_at FROM chapter_recycle WHERE book_id = ? AND chapter_id = ?',
          [bookId, id]
        );
        if (recycled) {
          return {
            type: 'chapter',
            id: Number(id),
            bookId,
            found: false,
            deleted: true,
            recoverable: true,
            title: recycled.title,
            status: 'deleted',
            route: `#/book/${bookId}`,
            updatedAt: recycled.deleted_at || null,
            deletedAt: recycled.deleted_at || null,
            meta: {},
            details: {},
          };
        }
        throw notFound('chapter', id, bookId);
      }
      return {
        type: 'chapter',
        id: row.id,
        bookId: row.book_id,
        found: true,
        title: row.title,
        status: row.locked ? 'locked' : 'draft',
        route: `#/book/${row.book_id}/read/${row.id}`,
        updatedAt: row.updated_at || null,
        meta: {
          sortOrder: null,
          revision: row.revision,
          locked: !!row.locked,
          volumeId: row.volume_id || null,
          charCount: row.content_chars,
        },
        details: {
          summary: capText(row.summary),
          beat: capText(row.beat, 120),
          driftStatus: row.drift_status || '',
        },
      };
    },
  },

  outline: {
    type: 'outline',
    kind: 'book',
    select: `rowid AS anchor, id, book_id, title, sort_order,
      LENGTH(COALESCE(outline, '')) AS outline_chars,
      LENGTH(COALESCE(summary, '')) AS summary_chars,
      summary_stale`,
    from: bookId => ({ sql: 'FROM volumes WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'outline',
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      status: row.summary_stale ? 'stale' : 'ok',
      route: `#/book/${row.book_id}/workbench/outline`,
      updatedAt: null,
      meta: {
        sortOrder: row.sort_order,
        outlineChars: row.outline_chars,
        summaryChars: row.summary_chars,
        stale: !!row.summary_stale,
        chapterCount: db.get('SELECT COUNT(*) AS n FROM chapters WHERE volume_id = ?', [row.id]).n,
      },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get(
        'SELECT id, book_id, title, intro, outline, summary, sort_order, summary_stale FROM volumes WHERE book_id = ? AND id = ?',
        [bookId, id]
      );
      if (!row) throw notFound('outline', id, bookId);
      return {
        type: 'outline',
        id: row.id,
        bookId: row.book_id,
        found: true,
        title: row.title,
        status: row.summary_stale ? 'stale' : 'ok',
        route: `#/book/${row.book_id}/workbench/outline`,
        updatedAt: null,
        meta: {
          sortOrder: row.sort_order,
          outlineChars: charCount(row.outline),
          summaryChars: charCount(row.summary),
          stale: !!row.summary_stale,
          chapterCount: db.get('SELECT COUNT(*) AS n FROM chapters WHERE volume_id = ?', [row.id]).n,
        },
        details: { intro: capText(row.intro), outline: capText(row.outline), summary: capText(row.summary) },
      };
    },
  },

  character: {
    type: 'character',
    kind: 'book',
    select: `rowid AS anchor, id, book_id, name, role, archived_at,
      (SELECT COUNT(*) FROM character_aliases a WHERE a.character_id = characters.id) AS alias_count`,
    from: bookId => ({ sql: 'FROM characters WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'character',
      id: row.id,
      title: row.name,
      bookId: row.book_id,
      status: row.archived_at ? 'archived' : 'active',
      route: `#/book/${row.book_id}/workbench/characters/${row.id}`,
      updatedAt: null,
      meta: {
        role: row.role || '',
        archived: !!row.archived_at,
        aliasCount: row.alias_count,
        aliases: db.all('SELECT alias FROM character_aliases WHERE character_id = ? ORDER BY is_primary DESC, id', [row.id]).map(a => a.alias),
      },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get(
        'SELECT id, book_id, name, role, note, archived_at FROM characters WHERE book_id = ? AND id = ?',
        [bookId, id]
      );
      if (!row) throw notFound('character', id, bookId);
      const aliases = db.all(
        'SELECT alias FROM character_aliases WHERE character_id = ? ORDER BY is_primary DESC, id',
        [row.id]
      ).map(a => a.alias);
      return {
        type: 'character',
        id: row.id,
        bookId: row.book_id,
        found: true,
        title: row.name,
        status: row.archived_at ? 'archived' : 'active',
        route: `#/book/${row.book_id}/workbench/characters/${row.id}`,
        updatedAt: null,
        meta: {
          role: row.role || '',
          archived: !!row.archived_at,
          aliasCount: aliases.length,
          relationCount: db.get('SELECT COUNT(*) AS n FROM character_relations WHERE book_id = ? AND (endpoint_a = ? OR endpoint_b = ?)', [row.book_id, row.id, row.id]).n,
        },
        details: { note: capText(row.note), aliases },
      };
    },
  },

  world: {
    type: 'world',
    kind: 'book',
    select: `rowid AS anchor, id, book_id, title, LENGTH(COALESCE(content, '')) AS content_chars`,
    from: bookId => ({ sql: 'FROM world_entries WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'world',
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      status: 'active',
      route: `#/book/${row.book_id}/workbench/world/${row.id}`,
      updatedAt: null,
      meta: { contentChars: row.content_chars },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get('SELECT id, book_id, title, content FROM world_entries WHERE book_id = ? AND id = ?', [bookId, id]);
      if (!row) throw notFound('world', id, bookId);
      return {
        type: 'world',
        id: row.id,
        bookId: row.book_id,
        found: true,
        title: row.title,
        status: 'active',
        route: `#/book/${row.book_id}/workbench/world/${row.id}`,
        updatedAt: null,
        meta: { contentChars: charCount(row.content) },
        details: { content: capText(row.content) },
      };
    },
  },

  ledger: {
    type: 'ledger',
    kind: 'book',
    select: `rowid AS anchor, id, book_id, title, chapter_id, importance, origin, source_stale, created_at`,
    from: bookId => ({ sql: 'FROM story_events WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'ledger',
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      status: 'canonical',
      route: `#/book/${row.book_id}/workbench/ledger`,
      updatedAt: row.created_at || null,
      meta: {
        chapterId: row.chapter_id || null,
        importance: row.importance,
        origin: row.origin,
        sourceStale: !!row.source_stale,
      },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get(
        'SELECT id, book_id, title, summary, chapter_id, importance, origin, source_stale, created_at FROM story_events WHERE book_id = ? AND id = ?',
        [bookId, id]
      );
      if (!row) throw notFound('ledger', id, bookId);
      return {
        type: 'ledger',
        id: row.id,
        bookId: row.book_id,
        found: true,
        title: row.title,
        status: 'canonical',
        route: `#/book/${row.book_id}/workbench/ledger`,
        updatedAt: row.created_at || null,
        meta: {
          chapterId: row.chapter_id || null,
          importance: row.importance,
          origin: row.origin,
          sourceStale: !!row.source_stale,
          pendingProposalCount: db.get("SELECT COUNT(*) AS n FROM event_proposals WHERE book_id = ? AND status IN ('pending','stale')", [row.book_id]).n,
        },
        details: { summary: capText(row.summary) },
      };
    },
  },

  // 作家卡是全局共享资产：不带 bookId 时列全部卡；带 bookId 时只列绑定到该书的卡。
  style: {
    type: 'style',
    kind: 'global',
    bookFilter: true,
    cursorColumn: 'p.rowid',
    select: `p.rowid AS anchor, p.id, p.name, p.kind, p.book_id, p.builtin, p.enabled, p.updated_at,
      (SELECT COUNT(*) FROM style_rules r WHERE r.pack_id = p.id) AS rule_count,
      (SELECT COUNT(*) FROM style_samples s WHERE s.pack_id = p.id) AS sample_count,
      (SELECT COUNT(*) FROM style_samples s WHERE s.pack_id = p.id AND s.indexed_at IS NOT NULL) AS indexed_count,
      (SELECT MAX(s.indexed_at) FROM style_samples s WHERE s.pack_id = p.id) AS last_indexed_at,
      (SELECT s.vector_model FROM style_samples s WHERE s.pack_id = p.id AND s.indexed_at IS NOT NULL ORDER BY s.indexed_at DESC LIMIT 1) AS vector_model`,
    from: bookId => (bookId == null
      ? { sql: 'FROM style_packs p', params: [] }
      : {
        sql: `FROM style_packs p JOIN book_style_packs bp ON bp.pack_id = p.id AND bp.book_id = ?`,
        params: [bookId],
      }),
    item: (row, ctx = {}) => ({
      type: 'style',
      id: row.id,
      title: row.name,
      bookId: row.book_id || null,
      status: row.enabled ? 'enabled' : 'disabled',
      // 卡是全局资产；站内看卡需要一本书的上下文（#/book/:id/cards），
      // 全局查询下没有可跳转页面就明确给 null，不猜一本书。
      route: row.book_id ? `#/book/${row.book_id}/cards` : (ctx.bookId ? `#/book/${ctx.bookId}/cards` : null),
      updatedAt: row.updated_at || null,
      meta: {
        kind: row.kind,
        shared: !row.book_id,
        builtin: !!row.builtin,
        enabled: !!row.enabled,
        ruleCount: row.rule_count,
        sampleCount: row.sample_count,
        indexedSampleCount: row.indexed_count,
        lastIndexedAt: row.last_indexed_at || null,
      },
    }),
    summary: ({ id, bookId }) => {
      const row = db.get(
        `SELECT p.id, p.name, p.kind, p.book_id, p.builtin, p.enabled, p.note, p.persona, p.updated_at,
          (SELECT COUNT(*) FROM style_rules r WHERE r.pack_id = p.id) AS rule_count,
          (SELECT COUNT(*) FROM style_samples s WHERE s.pack_id = p.id) AS sample_count,
          (SELECT COUNT(*) FROM style_samples s WHERE s.pack_id = p.id AND s.indexed_at IS NOT NULL) AS indexed_count,
          (SELECT MAX(s.indexed_at) FROM style_samples s WHERE s.pack_id = p.id) AS last_indexed_at,
          (SELECT s.vector_model FROM style_samples s WHERE s.pack_id = p.id AND s.indexed_at IS NOT NULL ORDER BY s.indexed_at DESC LIMIT 1) AS vector_model
         FROM style_packs p WHERE p.id = ?`,
        [id]
      );
      if (!row) throw notFound('style', id, bookId);
      const boundBooks = db.all('SELECT book_id FROM book_style_packs WHERE pack_id = ? ORDER BY book_id', [row.id]).map(r => r.book_id);
      if (bookId != null && !boundBooks.includes(bookId) && row.book_id !== bookId) {
        throw notFound('style', id, bookId);
      }
      return {
        type: 'style',
        id: row.id,
        bookId: row.book_id || null,
        found: true,
        title: row.name,
        status: row.enabled ? 'enabled' : 'disabled',
        route: row.book_id ? `#/book/${row.book_id}/cards` : (bookId != null ? `#/book/${bookId}/cards` : null),
        updatedAt: row.updated_at || null,
        meta: {
          kind: row.kind,
          shared: !row.book_id,
          builtin: !!row.builtin,
          enabled: !!row.enabled,
          ruleCount: row.rule_count,
          sampleCount: row.sample_count,
          indexedSampleCount: row.indexed_count,
          lastIndexedAt: row.last_indexed_at || null,
        },
        details: {
          note: capText(row.note, 120),
          persona: capText(row.persona),
          boundBooks,
          index: {
            samples: row.sample_count,
            indexed: row.indexed_count,
            vectorModel: row.vector_model || '',
            lastIndexedAt: row.last_indexed_at || null,
          },
        },
      };
    },
  },

  // 语料只暴露元数据：登记文件路径与源集目录属于本机文件布局，绝不进响应。
  corpus: {
    type: 'corpus',
    kind: 'global',
    select: `rowid AS anchor, id, author, works_json, han_count, sha256, mask_dict_version, updated_at,
      (SELECT COUNT(*) FROM corpus_docs d WHERE d.source_id = corpus_sources.id) AS doc_count,
      (SELECT COUNT(*) FROM distill_jobs j WHERE j.source_id = corpus_sources.id) AS job_count`,
    from: () => ({ sql: 'FROM corpus_sources', params: [] }),
    item: row => ({
      type: 'corpus',
      id: row.id,
      title: row.author,
      bookId: null,
      status: row.doc_count > 0 ? 'ready' : 'empty',
      route: null,
      updatedAt: row.updated_at || null,
      meta: {
        works: safeJsonArray(row.works_json),
        hanCount: row.han_count,
        docCount: row.doc_count,
        jobCount: row.job_count,
        sha256: row.sha256 || '',
        maskDictVersion: row.mask_dict_version || '',
      },
    }),
    summary: ({ id }) => {
      const row = db.get(
        'SELECT id, author, works_json, han_count, sha256, mask_dict_version, updated_at FROM corpus_sources WHERE id = ?',
        [id]
      );
      if (!row) throw notFound('corpus', id, null);
      return {
        type: 'corpus',
        id: row.id,
        bookId: null,
        found: true,
        title: row.author,
        status: 'ready',
        route: null,
        updatedAt: row.updated_at || null,
        meta: {
          works: safeJsonArray(row.works_json),
          hanCount: row.han_count,
          docCount: db.get('SELECT COUNT(*) AS n FROM corpus_docs WHERE source_id = ?', [row.id]).n,
          sha256: row.sha256 || '',
          maskDictVersion: row.mask_dict_version || '',
        },
        details: {
          // 只给阶段与状态，不给 progress_json（可能带本机路径）
          jobs: db.all('SELECT stage, status FROM distill_jobs WHERE source_id = ? ORDER BY id', [row.id]),
          note: '离线蒸馏产物元数据；语料文件与向量在侧文件，站内不提供文件浏览',
        },
      };
    },
  },

  // 已有任务（运行行）：session_key/request_id 是服务端内部标识，绝不外泄。
  task: {
    type: 'task',
    kind: 'global',
    bookFilter: true,
    order: 'desc',
    select: `rowid AS anchor, id, entry, mode, status, book_id, conversation_id, created_at, finished_at`,
    from: bookId => (bookId == null
      ? { sql: 'FROM agent_runs', params: [] }
      : { sql: 'FROM agent_runs WHERE book_id = ?', params: [bookId] }),
    item: row => ({
      type: 'task',
      id: row.id,
      title: `${row.entry} · ${row.mode}`,
      bookId: row.book_id || null,
      status: row.status,
      route: '#/agent',
      updatedAt: row.created_at || null,
      meta: {
        entry: row.entry,
        mode: row.mode,
        finishedAt: row.finished_at || null,
        hasConversation: !!row.conversation_id,
      },
    }),
    summary: ({ id, bookId }) => {
      const row = bookId == null
        ? db.get('SELECT id, entry, mode, status, book_id, conversation_id, created_at, finished_at FROM agent_runs WHERE id = ?', [id])
        : db.get('SELECT id, entry, mode, status, book_id, conversation_id, created_at, finished_at FROM agent_runs WHERE book_id = ? AND id = ?', [bookId, id]);
      if (!row) throw notFound('task', id, bookId);
      return {
        type: 'task',
        id: row.id,
        bookId: row.book_id || null,
        found: true,
        title: `${row.entry} · ${row.mode}`,
        status: row.status,
        route: '#/agent',
        updatedAt: row.created_at || null,
        meta: {
          entry: row.entry,
          mode: row.mode,
          finishedAt: row.finished_at || null,
          hasConversation: !!row.conversation_id,
        },
        details: {
          conversationId: row.conversation_id || null,
          eventCount: db.get('SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id = ?', [row.id]).n,
        },
      };
    },
  },

  // 系统资源：只回报脱敏后的渠道/模型业务状态——密钥只报布尔（不回掩码）、
  // 不回 base_url、不回 settings 原文。单例资源，列表只有一项。
  system: {
    type: 'system',
    kind: 'global',
    listAll: () => [systemResource()],
    item: () => systemResource(),
    summary: ({ id }) => {
      if (String(id) !== '1') throw notFound('system', id, null);
      return systemResource();
    },
  },
};

function safeJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(v => String(v)).slice(0, 20) : [];
  } catch (err) {
    return [];
  }
}

function settingValue(key, dflt = '') {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row && row.value !== '' && row.value != null ? row.value : dflt;
}

function systemResource() {
  const model = settingValue('model');
  const keyConfigured = !!settingValue('api_key');
  const thinkingDisabled = settingValue('disable_thinking_models')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  return {
    type: 'system',
    id: 1,
    bookId: null,
    found: true,
    title: model || '未配置模型',
    status: keyConfigured ? 'configured' : 'unconfigured',
    route: '#/settings',
    updatedAt: null,
    meta: {
      protocol: 'openai-compatible',
      model: model || '',
      modelConfigured: !!model,
      keyConfigured,
      thinkingDisabledModels: thinkingDisabled,
      counts: {
        books: db.get('SELECT COUNT(*) AS n FROM books').n,
        chapters: db.get('SELECT COUNT(*) AS n FROM chapters').n,
      },
    },
    details: {},
  };
}

// 列表：{ type, bookId, items, nextCursor }
function listResources({ type, bookId, cursor, limit } = {}) {
  const t = assertType(type);
  const spec = TYPES[t];
  const book = resolveBookId(spec, bookId);
  const after = parseCursor(cursor);
  const lim = parseLimit(limit);
  if (typeof spec.listAll === 'function') {
    return { type: t, bookId: book, items: spec.listAll(), nextCursor: null };
  }
  const rows = fetchPage(spec, { bookId: book, after, limit: lim + 1 });
  const page = rows.slice(0, lim);
  const items = page.map(row => spec.item(row, { bookId: book }));
  const nextCursor = rows.length > lim ? String(page[page.length - 1].anchor) : null;
  return { type: t, bookId: book, items, nextCursor };
}

// 摘要：{ type, bookId, resource }
function getResourceSummary({ type, id, bookId } = {}) {
  const t = assertType(type);
  const spec = TYPES[t];
  if (id === undefined || id === null || id === '') {
    throw new DomainError('INVALID_RESOURCE_ID', '摘要请求必须提供 id', 400, { type: t });
  }
  const book = resolveBookId(spec, bookId);
  const safeId = spec.type === 'system' ? String(id).trim() : parseSafeId(id);
  if (spec.type !== 'task' && spec.type !== 'system' && !NUMERIC_ID.test(safeId)) {
    throw new DomainError('INVALID_RESOURCE_ID', 'id 必须是正整数', 400, { id: safeId.slice(0, 80) });
  }
  return { type: t, bookId: book, resource: spec.summary({ id: safeId, bookId: book }) };
}

module.exports = {
  RESOURCE_TYPES,
  listResources,
  getResourceSummary,
  // 该类型是否接受 bookId（书内类型必需；style/task 作为可选过滤器）
  acceptsBookId,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
