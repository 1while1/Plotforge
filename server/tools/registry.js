const db = require('../db');
const bookTools = require('../bookTools');
const characters = require('../domain/characters');
const ledger = require('../domain/storyLedger');
const relations = require('../domain/relations');
const proposals = require('../domain/proposals');
const threads = require('../domain/threads');
const backfill = require('../domain/backfill');
const stateAudit = require('../domain/stateAudit');
const { searchEvidence } = require('../evidence/search');
const llm = require('../llm');
const versions = require('../versions');
const vectorStore = require('../vector/store');
const { DomainError } = require('../domain/errors');

const profiles = {
  writing: require('./profiles/writing'),
  agent: require('./profiles/agent'),
  'agent-discuss': require('./profiles/agent-discuss'),
  character: require('./profiles/character'),
};

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const integer = { type: 'integer', minimum: 1 };
const string = { type: 'string' };
const anyValue = {}; // 任意 JSON 值：old_value/new_value/metadata 可为 字符串/数组/对象/null，不收窄类型
const importanceEnum = { type: 'string', enum: ['low', 'normal', 'high', 'critical'] };
// 事件变化项：character_state（人物状态字段）或 relation（关系快照）。显式声明字段，
// 避免 AI SDK 把 changes 转成 z.object({}) 时把内容整体剥离（strict 形状才能保住 change 内容）
const changeSchema = () => objectSchema({
  change_kind: { type: 'string', enum: ['character_state', 'relation'] },
  subject_ref: string,
  field_key: string,
  old_value: anyValue,
  new_value: anyValue,
  metadata: anyValue,
}, ['change_kind', 'subject_ref', 'field_key']);
const mutationForLegacy = new Set(bookTools.WRITE_TOOLS);

const registry = new Map();

function register(descriptor) {
  if (!descriptor || !descriptor.name) throw new Error('工具必须有 name');
  if (registry.has(descriptor.name)) throw new Error(`重复工具：${descriptor.name}`);
  registry.set(descriptor.name, Object.freeze({
    title: descriptor.name,
    capability: 'legacy',
    scope: 'book',
    mutation: 'read',
    confirmation: 'none',
    ...descriptor,
  }));
}

// ---- 工具提示词三层化（对齐 pi ToolDefinition 的 description/promptSnippet 分层，M6）----
// pi 的结构：description = 完整说明；promptSnippet = 进常驻工具面的一行短描述。
// 我们的对应物：description 保留全文（确认卡 / 语义审计 / 人工核对用），
// snippet（可选，≤30 字）= 进 LLM 每次请求都常驻的工具清单短描述。
// 组装层（adapters/openai.js 与 adapters/ai-sdk.js）只序列化 promptDescription 的产物——
// 写作聊天 40 个工具的完整 description 随每条请求常驻，实测占空书请求 prompt 的九成以上
// （chat.js schemaTokens 注释），是「工具面吃上下文窗口」的主源头。
//
// promptDescription 是唯一退化口径：有 snippet 用 snippet；无则退化为 description 首句。
// 多数旧工具描述本就只有一句，退化后与原描述逐字相同（向后兼容，40+ 工具零改动可用）；
// 多句描述丢掉的是「何时用」类使用守则，那一层已由 TOOL_GUIDE（写作聊天常驻系统提示）承担，
// 与 pi 的 promptGuidelines 同位——短表层与守则层各司其职，不重复占窗口。
function firstSentence(text) {
  const s = String(text || '').trim();
  if (!s) return s;
  const m = s.match(/^[^。！？!?\n]+[。！？!?]?/);
  return m ? m[0] : s;
}

function promptDescription(tool) {
  const snippet = tool && typeof tool.snippet === 'string' ? tool.snippet.trim() : '';
  if (snippet) return snippet;
  return firstSentence(tool && tool.description);
}

// 旧 bookTools 工具（SCHEMAS 定义在 server/bookTools.js）的高频读类补 snippet：
// 只给描述最长、且首句会丢分页契约的工具补——list_chapters 等分页工具的
// 「truncated=true 时 offset=next_cursor 翻页」契约必须在短表里存活，否则
// 截断后模型不知如何续读。其余工具不填，走首句退化。
const LEGACY_SNIPPETS = {
  list_chapters: '列章节目录；truncated 时 offset 翻页',
  batch_search: '一次并发搜最多 5 个独立问题',
};

for (const schema of bookTools.SCHEMAS) {
  const fn = schema.function;
  const mutation = mutationForLegacy.has(fn.name) ? 'write' : 'read';
  register({
    name: fn.name,
    title: fn.name,
    description: fn.description,
    snippet: LEGACY_SNIPPETS[fn.name],
    capability: mutation === 'read' ? 'legacy.read' : 'legacy.write',
    mutation,
    confirmation: mutation === 'read' ? 'none' : 'required',
    inputSchema: fn.parameters || objectSchema(),
    profiles: ['writing', 'agent'],
    execute: async context => {
      const result = mutation === 'read'
        ? bookTools.executeRead(context.bookId, fn.name, context.args)
        : bookTools.executeWrite(context.bookId, fn.name, context.args);
      const settled = await result;
      // 安全网：旧工具若仍以 {error:...} 普通返回值表达业务失败（未来回归），
      // 统一执行器会把它当成功结算（审计 success / 确认 approved / Agent 续跑谎报成功）。
      // 在包装层收敛为 DomainError，保证失败永远走真实失败路径。
      if (settled && typeof settled === 'object' && !Array.isArray(settled)
          && typeof settled.error === 'string' && settled.error.trim()
          && settled.ok !== true) {
        const code = typeof settled.code === 'string' && settled.code ? settled.code : 'TOOL_BUSINESS_ERROR';
        throw new DomainError(code, settled.error, /不存在|NOT_FOUND/i.test(settled.error) ? 404 : 400);
      }
      return settled;
    },
  });
}

function native(definition) {
  register({ profiles: ['writing', 'agent'], ...definition });
}

native({
  name: 'search_evidence',
  title: '检索故事证据',
  description: '统一检索人物、关系、正式事件、线索、定稿正文和草稿正文，保留可信等级。',
  capability: 'evidence.read',
  inputSchema: objectSchema({
    query: string,
    top_k: { type: 'integer', minimum: 1, maximum: 30 },
    exclude_chapter_id: integer,
  }, ['query']),
  execute: context => searchEvidence(context.bookId, context.args.query, {
    topK: context.args.top_k,
    excludeChapterId: context.args.exclude_chapter_id,
  }),
});

native({
  name: 'find_characters',
  title: '查找人物',
  description: '按姓名、别名、类型或简介查找人物，返回稳定人物 ID。',
  capability: 'characters.read',
  inputSchema: objectSchema({ q: string, role: string, archived: { type: 'boolean' } }),
  execute: context => characters.findCharacters(context.bookId, context.args),
});

native({
  name: 'get_character_context',
  title: '读取人物上下文',
  description: '读取一个人物的档案、别名、当前状态以及关系、时间线和线索摘要。',
  capability: 'characters.read',
  inputSchema: objectSchema({ character_id: integer }, ['character_id']),
  execute: context => characters.getCharacterContext(context.bookId, context.args.character_id),
});

native({
  name: 'get_character_relations',
  title: '读取人物关系',
  description: '读取人物当前或截至某章的多维关系。',
  capability: 'relations.read',
  inputSchema: objectSchema({
    character_id: integer, as_of_chapter: integer, lifecycle: string,
    secrecy: string, type: string, polarity: string,
  }, ['character_id']),
  execute: context => relations.getRelations(context.bookId, context.args.character_id, context.args),
});

native({
  name: 'get_character_timeline',
  title: '读取人物时间线',
  description: '按叙述顺序读取人物正式故事事件。返回 { items, total, next_cursor, truncated }：truncated=true 时以 offset=next_cursor 翻页取余量，不要基于不完整列表下「全书没有X」类断言。',
  snippet: '人物事件时间线，truncated 时 offset 翻页',
  capability: 'ledger.read',
  inputSchema: objectSchema({ character_id: integer, chapter_id: integer, limit: integer, offset: integer }, ['character_id']),
  execute: context => ledger.getTimelinePage(context.bookId, context.args),
});

native({
  name: 'get_story_event',
  title: '读取故事事件',
  description: '读取正式事件、变化项、证据和修正链。',
  capability: 'ledger.read',
  inputSchema: objectSchema({ event_id: integer }, ['event_id']),
  execute: context => ledger.getEvent(context.bookId, context.args.event_id),
});

native({
  name: 'get_story_threads',
  title: '读取故事线索',
  description: '读取伏笔、谜团、承诺、债务和计划。',
  capability: 'threads.read',
  inputSchema: objectSchema({ type: string, status: string, character_id: integer }),
  execute: context => threads.listThreads(context.bookId, context.args),
});

native({
  name: 'get_event_proposals',
  title: '读取待确认提案',
  description: '只读查看章节总结或顾问产生的待确认事件提案。返回 { items, total, next_cursor, truncated }：truncated=true 时以 offset=next_cursor 翻页。',
  snippet: '查待确认提案，truncated 时 offset 翻页',
  capability: 'proposals.read',
  inputSchema: objectSchema({ status: string, chapter_id: integer, source_type: string, limit: integer, offset: integer }),
  execute: context => proposals.listProposalPage(context.bookId, context.args),
});

// 读取可用的状态字段与关系类型（2026-09-10 十章实测）：
// 此前没有任何只读工具暴露「这本书允许用哪些 field_key / 关系类型」，propose_story_event
// 的 change.field_key 只能靠模型猜——实测它填了不存在的「status」，作者采纳时才 400
// STATE_FIELD_NOT_FOUND；抽取路径（chapterSummaryProposals）自己查了字段表喂模型，
// 工具路径却没有，两条路径口径不一致。补一个只读工具，让模型提交前能查到合法字段。
native({
  name: 'list_state_fields',
  title: '读取状态字段与关系类型',
  description: '读取本书可用的状态字段（field_key、显示名、值类型、是否启用）与关系类型。'
    + '提交状态/关系变化提案（propose_story_event）前应先调用本工具，field_key 必须从这里选。',
  capability: 'ledger.read',
  inputSchema: objectSchema(),
  execute: context => ({
    state_fields: ledger.listStateFields(context.bookId)
      .filter(row => row.enabled !== 0)
      .map(row => ({ field_key: row.field_key, label: row.label, value_type: row.value_type, options: row.options || [] })),
    relation_types: relations.listRelationTypes(context.bookId)
      .map(row => ({ type_key: row.type_key, label: row.label, default_direction: row.default_direction })),
  }),
});

native({
  name: 'get_story_ledger',
  title: '读取故事台账',
  description: '读取进度摘要以及线索、待确认和问题数量。',
  capability: 'ledger.read',
  inputSchema: objectSchema(),
  execute: context => {
    const summary = db.get(
      "SELECT content, updated_at FROM story_state WHERE book_id = ? AND kind = 'book_summary'",
      [context.bookId]
    ) || { content: '', updated_at: null };
    return {
      summary,
      counts: {
        open_threads: db.get(
          "SELECT COUNT(*) AS n FROM story_threads WHERE book_id = ? AND status IN ('open','progressing')",
          [context.bookId]
        ).n,
        pending_proposals: db.get(
          "SELECT COUNT(*) AS n FROM event_proposals WHERE book_id = ? AND status IN ('pending','stale')",
          [context.bookId]
        ).n,
      },
    };
  },
});

function writeNative(definition) {
  native({ mutation: 'write', confirmation: 'required', ...definition });
}

writeNative({
  name: 'create_character',
  title: '创建人物',
  description: '创建人物档案和主名称别名。',
  capability: 'characters.write',
  inputSchema: objectSchema({
    name: string, role: string, intro: string, appearance: string,
    personality: string, background: string, note: string,
  }, ['name']),
  execute: context => characters.createCharacter(context.bookId, context.args),
});

function agentRead(definition) {
  register({ profiles: ['agent'], ...definition });
}

agentRead({
  name: 'list_books',
  title: '列出书籍',
  description: '列出书架作品及章节数。',
  capability: 'books.read',
  scope: 'global',
  inputSchema: objectSchema(),
  execute: () => db.all(`
    SELECT b.id, b.title, b.intro, b.mode, b.updated_at,
      (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count
    FROM books b ORDER BY b.updated_at DESC
  `),
});

agentRead({
  name: 'get_book',
  title: '读取书籍',
  description: '读取作品详情、总纲和分卷。',
  capability: 'books.read',
  inputSchema: objectSchema(),
  execute: context => ({
    book: db.get(
      'SELECT id, title, intro, mode, master_outline FROM books WHERE id = ?',
      [context.bookId]
    ),
    volumes: db.all(
      'SELECT id, title, outline, summary FROM volumes WHERE book_id = ? ORDER BY sort_order, id',
      [context.bookId]
    ),
  }),
});

agentRead({
  name: 'get_chat_history',
  title: '读取写作对话',
  description: '读取作品最近的写作对话。',
  capability: 'chat.read',
  inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  execute: context => db.all(
    `SELECT id, role, content, reasoning, created_at FROM messages
     WHERE book_id = ? ORDER BY id DESC LIMIT ?`,
    [context.bookId, Math.min(50, Number(context.args.limit) || 20)]
  ).reverse(),
});

// S4-01a：受控资源目录工具（agent / agent-discuss 可达；writing 与 character 不加载，
// 写作页讨论默认只看本书资料，不开全局资源面）。两个工具与 GET /api/resources 共用
// server/resources/catalog.js —— 类型枚举、书归属校验、分页与脱敏只有一份实现。
// 只返回业务元数据/摘要/内部路由；不返回整章正文文件内容、settings 原文、密钥或本机路径。
const resourceCatalog = require('../resources/catalog');

const RESOURCE_TYPE_PROP = { type: 'string', enum: [...resourceCatalog.RESOURCE_TYPES] };
// id 允许数字或字符串（列表返回的章节 id 是数字、运行 id 是 uuid 字符串）；
// 真实取值范围由 catalog 的白名单字符校验决定，schema 只负责形态提示。
const RESOURCE_ID_PROP = { type: ['string', 'integer'] };
// 工具上下文里的当前书（模型显式传 bookId；全局会话没有默认书，必须显式指定）。
// 只有接受 bookId 的类型才带上它——system/corpus/book 这类全局资源不接受书参数。
function resourceBookId(context) {
  if (!resourceCatalog.acceptsBookId(context.args.type)) return null;
  const id = Number(context.bookId || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

agentRead({
  name: 'list_resources',
  title: '列出受控资源',
  description: `列出白名单资源的业务元数据与内部路由。type 只能是 ${resourceCatalog.RESOURCE_TYPES.join('、')}；`
    + 'chapter/outline/character/world/ledger 需要 bookId（style 可带 bookId 只看本书绑定卡）；'
    + '返回 { items, nextCursor }，翻页把 nextCursor 原样传给 cursor。只给元数据与摘要，不给整章正文或本机文件。',
  snippet: '列书籍/章节/大纲/人物/世界观/台账/作家卡/语料/任务/系统状态',
  capability: 'resources.read',
  scope: 'global',
  inputSchema: objectSchema({
    type: RESOURCE_TYPE_PROP,
    bookId: integer,
    cursor: string,
    limit: { type: 'integer', minimum: 1, maximum: resourceCatalog.MAX_LIMIT },
  }, ['type']),
  execute: context => resourceCatalog.listResources({
    type: context.args.type,
    bookId: resourceBookId(context),
    cursor: context.args.cursor,
    limit: context.args.limit,
  }),
});

agentRead({
  name: 'get_resource_summary',
  title: '读取资源摘要',
  description: `读取单个资源的业务摘要与内部路由（type 枚举同 list_resources，id 用列表返回的 id）——`
    + '返回状态、摘要与可跳转的站内路由，不返回整章正文文件、密钥、settings 原文或本机路径。'
    + '书内类型必须给 bookId；跨书引用一律按不存在处理。',
  snippet: '读单个书籍/章节/人物/作家卡/任务等资源的摘要与路由',
  capability: 'resources.read',
  scope: 'global',
  inputSchema: objectSchema({
    type: RESOURCE_TYPE_PROP,
    id: RESOURCE_ID_PROP,
    bookId: integer,
  }, ['type', 'id']),
  execute: context => resourceCatalog.getResourceSummary({
    type: context.args.type,
    id: context.args.id,
    bookId: resourceBookId(context),
  }),
});

// A-4（G4 遗留·事项A2）：规划笔记只读查询（agent 与 agent-discuss 可达；writing 与 character 不加载——
// 与受控资源目录同款边界）。笔记是作者从讨论里筛出来留存的结论草稿，库层 CHECK 把 status 锁死在
// 'draft'（迁移 029）：它没有正典效力，既不是故事事实，也不存在被工具改成事实的路径（本切片不加写工具）。
// 执行体直接调 server/conversations/handoffs.js —— 与 HTTP /api/planning-notes 是同一份实现，不写第二份 SQL。
// 范围＝本会话（context.conversationId）或当前书（会话绑定的书；未绑书的运行按显式 bookId）：
// 范围外与不存在同码（404），且没有全库出口——不做存在性确认，也不夹带其他会话/书的内容。
const planningHandoffs = require('../conversations/handoffs');

function noteScopeBookId(context) {
  const bookId = Number(context.bookId || 0);
  return Number.isInteger(bookId) && bookId > 0 ? bookId : null;
}

agentRead({
  name: 'list_planning_notes',
  title: '列出规划笔记',
  description: '列出作者从讨论里留存下来的规划笔记。笔记只是草稿（status 恒为 draft）：不写正文、'
    + '不改大纲、不进事件账本，不是故事事实，要成为事实必须走领域提案与作者确认。'
    + '默认只列本会话的笔记；Agent 会话已绑定书时列该书的笔记，未绑书的运行要列某本书的笔记须显式给 bookId。'
    + '范围外（别的会话/别的书）的笔记不会出现在结果里，也没有全库出口。'
    + '返回 { notes: [...] }，每条含 id/title/text/revision/updatedAt，id 可传给 get_planning_note 精读。',
  snippet: '列作者规划笔记草稿（非故事事实）',
  capability: 'notes.read',
  scope: 'global',
  inputSchema: objectSchema({ bookId: integer }),
  execute: context => {
    const bookId = noteScopeBookId(context);
    return {
      notes: planningHandoffs.listPlanningNotes(bookId
        ? { bookId }
        : { conversationId: context.conversationId }),
      scope: bookId ? { kind: 'book', bookId } : { kind: 'conversation' },
      notice: '规划笔记是草稿（status=draft），不是已确认的故事事实。',
    };
  },
});

agentRead({
  name: 'get_planning_note',
  title: '读取规划笔记',
  description: '读取一条规划笔记草稿的完整正文（含 revision 与状态）。默认只能读本会话的笔记；'
    + 'Agent 会话绑定书时可读该书的笔记，未绑书的运行须显式给 bookId。范围外的笔记与不存在的笔记'
    + '同样按 404 处理（不确认别处是否存在这条笔记）。返回体自带 status=draft：草稿不是故事事实。',
  snippet: '读单条规划笔记草稿（非故事事实）',
  capability: 'notes.read',
  scope: 'global',
  inputSchema: objectSchema({ noteId: string, bookId: integer }, ['noteId']),
  execute: context => {
    const note = planningHandoffs.getPlanningNote(context.args.noteId);
    const bookId = noteScopeBookId(context);
    const visible = Boolean(note) && (
      (Boolean(context.conversationId) && note.conversationId === String(context.conversationId))
      || (bookId !== null && note.bookId === bookId)
    );
    if (!visible) {
      throw new DomainError('NOTE_NOT_FOUND', '规划笔记不存在', 404, { tool: 'get_planning_note' });
    }
    return {
      note,
      notice: '这是作者留存的讨论结论草稿（status=draft），不是已确认的故事事实。',
    };
  },
});

function agentWrite(definition) {
  register({
    profiles: ['agent'],
    mutation: 'write',
    confirmation: 'required',
    ...definition,
  });
}

agentWrite({
  name: 'create_volume',
  title: '创建分卷',
  description: '在作品中创建分卷。',
  capability: 'outline.write',
  inputSchema: objectSchema({ title: string, intro: string, outline: string }, ['title']),
  execute: context => {
    const order = db.get(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM volumes WHERE book_id = ?',
      [context.bookId]
    ).n;
    const result = db.run(
      'INSERT INTO volumes (book_id, title, intro, outline, sort_order) VALUES (?, ?, ?, ?, ?)',
      [context.bookId, context.args.title.trim(), context.args.intro || '', context.args.outline || '', order]
    );
    return db.get('SELECT * FROM volumes WHERE id = ?', [result.lastInsertRowid]);
  },
});

agentWrite({
  name: 'move_chapter',
  title: '移动章节',
  description: '改变章节所属分卷与排序；换卷默认追加目标卷末尾。',
  capability: 'chapters.write',
  inputSchema: objectSchema({
    chapter_id: integer,
    volume_id: integer,
    sort_order: { type: 'integer', minimum: 0 },
    expected_revision: { type: 'integer', description: '章节版本乐观锁：确认时由系统自动绑定，模型无需提供' },
  }, ['chapter_id']),
  validate: context => require('../domain/chapterCatalog').validatePlacement(context.bookId, context.args),
  execute: context => require('../domain/chapterCatalog').moveChapter(context.bookId, context.args.chapter_id, context.args),
});

agentWrite({
  name: 'lock_chapter',
  title: '定稿章节',
  description: '将作者明确指定的章节定稿并建立长期语义索引。',
  capability: 'chapters.lock',
  inputSchema: objectSchema({ chapter_id: integer }, ['chapter_id']),
  execute: async context => {
    const chapter = db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [
      context.args.chapter_id, context.bookId,
    ]);
    if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404, { chapter_id: context.args.chapter_id });
    // 走统一定稿服务（与页面「定稿」、确认卡「写入后自动重新定稿」同一入口）：
    // 空章拒绝、清除 relock_pending、异步建索引并调度人物事实抽取。
    // 此前直接 UPDATE locked=1 + 建索引，绕过生命周期——不清待重新定稿标志、
    // 不查空章、不定稿不抽取，同一业务动作三个入口三种后果（全景报告§11.2）。
    return require('../domain/chapterLifecycle').relockChapter(context.bookId, chapter.id);
  },
});

agentRead({
  name: 'check_drift_all',
  title: '检查全书偏离',
  description: '检查作品章节与大纲的偏离情况。默认最多检查前 30 章（limit 可调，上限 200），可被取消。每章 status 为 ok（符合）/minor（轻度偏离）/major（严重偏离）/failed（未通过检查，看 code 如 LLM_EMPTY_OUTPUT）/skipped（无大纲未检测）——failed 与 skipped 都不是「无偏离」。',
  capability: 'analysis.read',
  inputSchema: objectSchema({ limit: integer }),
  execute: async context => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [context.bookId]);
    const all = db.all('SELECT c.* FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id WHERE c.book_id = ? ORDER BY COALESCE(v.sort_order, 2147483647), c.sort_order, c.id', [context.bookId]);
    // 有界 LLM 扇出：limit 默认 30、硬上限 200；signal 可中途取消（对齐 pi）
    const limit = Math.min(200, Math.max(1, Number(context.args.limit) || 30));
    const chapters = all.slice(0, limit);
    const results = [];
    let checked = 0;
    for (const chapter of chapters) {
      if (context.signal && context.signal.aborted) break;
      // S5-03/R02：单章失败（空输出/解析失败）分类为 failed 项，不打断整批、也不写成「符合」；
      // signal 透传到模型请求，取消后连在途调用一起停（不再等 120s 请求超时）。
      const outcome = await llm.checkDriftResult(book, chapter, { signal: context.signal });
      results.push({ chapter_id: chapter.id, ...(outcome || { status: 'skipped', reason: 'no_outline' }) });
      checked++;
      if (typeof context.onUpdate === 'function') context.onUpdate({ checked, total: chapters.length });
    }
    return {
      checked,
      total: all.length,
      truncatedByLimit: Math.max(0, all.length - chapters.length),
      aborted: !!(context.signal && context.signal.aborted),
      results,
    };
  },
});

agentRead({
  name: 'generate_volume_summary',
  title: '生成卷总结（仅生成不保存）',
  description: '根据卷内章节总结生成分卷总结。注意：本工具只返回文本、不落库，作品记忆不会因此更新；需要保存时把 summary 传给 save_volume_summary（需作者确认）。',
  capability: 'analysis.read',
  inputSchema: objectSchema({ volume_id: integer }, ['volume_id']),
  execute: async context => {
    const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [
      context.args.volume_id, context.bookId,
    ]);
    if (!volume) throw new DomainError('VOLUME_NOT_FOUND', '分卷不存在', 404, { volume_id: context.args.volume_id });
    const chapterText = db.all(
      "SELECT title, summary FROM chapters WHERE book_id = ? AND volume_id = ? AND summary != '' ORDER BY sort_order, id",
      [context.bookId, volume.id]
    ).map(row => `${row.title}：${row.summary}`).join('\n');
    const summary = await llm.callLLM([
      { role: 'system', content: '把以下章节总结凝练为分卷总结，只输出总结。' },
      { role: 'user', content: chapterText },
    ], { maxTokens: 1800, temperature: 0.3 });
    const staleRow = db.get('SELECT summary_stale FROM volumes WHERE id = ?', [volume.id]);
    return {
      volume_id: volume.id, summary, saved: false,
      note: '仅生成未保存：确认落库请用 save_volume_summary',
      // 4.1：旧卷总结基于已变化的章总结时提示作者替换
      summary_was_stale: !!(staleRow && staleRow.summary_stale),
    };
  },
});

agentWrite({
  name: 'save_volume_summary',
  title: '保存卷总结',
  description: '把卷总结写入该卷的 summary 字段（经作者确认后落库）。生成用 generate_volume_summary。',
  capability: 'volumes.write',
  inputSchema: objectSchema({
    volume_id: integer,
    summary: string,
    source_fingerprint: { type: 'string', description: '来源指纹乐观锁：确认时由系统自动绑定，模型无需提供' },
  }, ['volume_id', 'summary']),
  confirmationPreview: context => {
    const volume = db.get('SELECT title FROM volumes WHERE id = ? AND book_id = ?', [context.args.volume_id, context.bookId]);
    return {
      action: `保存卷总结 → ${volume ? volume.title : '卷#' + context.args.volume_id}`,
      summary: String(context.args.summary || '').slice(0, 400),
    };
  },
  execute: context => {
    const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [context.args.volume_id, context.bookId]);
    if (!volume) throw new DomainError('VOLUME_NOT_FOUND', '分卷不存在', 404, { volume_id: context.args.volume_id });
    const lifecycle = require('../domain/chapterLifecycle');
    const guard = require('../domain/sourceGuard');
    // S5-01：确认信封创建时由服务端绑定来源指纹（executor.bindSummarySource）；写入前在同一个
    // 同步事务内核对——等待确认期间底料变化（章总结改写/删章/换卷/调序/卷改名）→ 409
    // SOURCE_CHANGED，不把旧生成结果写成「基于新底料」的卷总结
    return db.transaction(() => {
      const snapshot = guard.captureSource({ bookId: context.bookId, kind: 'volume', entityId: volume.id });
      if (context.args.source_fingerprint) {
        guard.assertSourceCurrent({
          bookId: context.bookId, kind: 'volume', entityId: volume.id,
          fingerprint: String(context.args.source_fingerprint),
        });
      }
      db.run('UPDATE volumes SET summary = ? WHERE id = ? AND book_id = ?', [String(context.args.summary).trim(), volume.id, context.bookId]);
      // 记录底料指纹：新总结基于当前章总结生成，此后任一章总结变化即标过期（方向报告 4.1）
      lifecycle.refreshVolumeSummaryFingerprint(context.bookId, volume.id);
      // 卷总结本身是全书摘要的底料 → 变化后全书摘要若基于旧卷总结则标过期（4.1 书层传播）
      const bookStale = lifecycle.markBookSummaryStale(context.bookId);
      return {
        volume_id: volume.id,
        saved: true,
        source_fingerprint: snapshot.fingerprint,
        book_summary_stale: bookStale,
      };
    });
  },
});

agentRead({
  name: 'list_chapter_versions',
  title: '列出章节版本',
  description: '列出章节历史快照。',
  capability: 'versions.read',
  inputSchema: objectSchema({ chapter_id: integer }, ['chapter_id']),
  execute: context => {
    const chapter = db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [
      context.args.chapter_id, context.bookId,
    ]);
    if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404, { chapter_id: context.args.chapter_id });
    return versions.list(chapter.id);
  },
});

agentWrite({
  name: 'restore_chapter',
  title: '恢复章节版本',
  description: '恢复章节历史版本；生命周期联动由统一恢复服务执行。',
  capability: 'versions.write',
  inputSchema: objectSchema({
    version_id: integer,
    expected_revision: { type: 'integer', description: '章节版本乐观锁：确认时由系统自动绑定，模型无需提供' },
  }, ['version_id']),
  execute: context => versions.restore(context.args.version_id, context.bookId, context.args.expected_revision),
});

agentRead({
  name: 'summarize_chapter',
  title: '总结章节（仅生成不保存）',
  description: '生成章节总结并抽取人物变化提案线索。注意：本工具只返回文本、不写入章节 summary；需要保存时把 summary 传给 save_chapter_summary（需作者确认），或让作者在写作页点「生成总结」。',
  capability: 'analysis.read',
  inputSchema: objectSchema({ chapter_id: integer }, ['chapter_id']),
  execute: async context => {
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [
      context.args.chapter_id, context.bookId,
    ]);
    if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404, { chapter_id: context.args.chapter_id });
    return { summary: await llm.summarizeChapter(chapter), saved: false, note: '仅生成未保存：确认落库请用 save_chapter_summary' };
  },
});

agentWrite({
  name: 'save_chapter_summary',
  title: '保存章节总结',
  description: '把章节总结写入 chapters.summary（经作者确认后落库）。生成用 summarize_chapter 或写作页「生成总结」。',
  capability: 'chapters.write',
  inputSchema: objectSchema({
    chapter_id: integer,
    summary: string,
    expected_revision: { type: 'integer', description: '章节版本乐观锁：确认时由系统自动绑定，模型无需提供' },
  }, ['chapter_id', 'summary']),
  confirmationPreview: context => {
    const chapter = db.get('SELECT title FROM chapters WHERE id = ? AND book_id = ?', [context.args.chapter_id, context.bookId]);
    return {
      action: `保存章节总结 → ${chapter ? chapter.title : '章#' + context.args.chapter_id}`,
      summary: String(context.args.summary || '').slice(0, 400),
    };
  },
  execute: context => {
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [context.args.chapter_id, context.bookId]);
    if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404, { chapter_id: context.args.chapter_id });
    const lifecycle = require('../domain/chapterLifecycle');
    const guard = require('../domain/sourceGuard');
    // S1-03：总结写入走章节版本守卫（expected_revision 由确认信封创建时绑定注入）。
    // S5-01：章总结的提交 CAS 用章节 revision（覆盖章节任何字段变化，比来源指纹更严格），
    // 结果同时记录来源指纹与提交后版本（01 契约 §7）；捕获与写回在同一同步事务内，
    // 指纹不含 summary 自身，保存后不会立刻自判过期。
    return db.transaction(() => {
      const snapshot = guard.captureSource({ bookId: context.bookId, kind: 'chapter', entityId: chapter.id });
      const applied = require('../domain/chapterMutations').applyChapterMutationInTransaction({
        bookId: context.bookId,
        chapterId: chapter.id,
        expectedRevision: context.args.expected_revision,
        patch: { summary: String(context.args.summary).trim() },
        reason: 'before-summary-save',
      });
      // 章总结变化 → 全书摘要底料指纹失效（卷总结过期已由领域入口联动；方向报告 4.1）
      const bookStale = lifecycle.markBookSummaryStale(context.bookId);
      return {
        chapter_id: chapter.id,
        saved: true,
        revision: applied.chapter.revision,
        committed_revision: applied.chapter.revision,
        source_fingerprint: snapshot.fingerprint,
        volume_summary_stale: applied.summaryStale,
        book_summary_stale: bookStale,
      };
    });
  },
});

agentRead({
  name: 'check_drift',
  title: '检查章节偏离',
  description: '检查一个章节是否偏离大纲。返回 status=ok/minor/major；失败返回 status=failed + code（如 LLM_EMPTY_OUTPUT / DRIFT_VERDICT_INVALID）——failed 不是「无偏离」，也不代表「符合」；无大纲返回 status=skipped。',
  capability: 'analysis.read',
  inputSchema: objectSchema({ chapter_id: integer }, ['chapter_id']),
  execute: async context => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [context.bookId]);
    const chapter = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [
      context.args.chapter_id, context.bookId,
    ]);
    if (!chapter) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404, { chapter_id: context.args.chapter_id });
    // S5-03/R02：失败以结构化结果返回（status=failed + code + 上游证据），而不是抛通用异常——
    // 通用异常经 serializeToolError 只降级为「工具执行失败」，模型会把它读成「无偏离」。
    return llm.checkDriftResult(book, chapter, { signal: context.signal });
  },
});

agentRead({
  name: 'consult_plot',
  title: '剧情参谋',
  description: '针对当前作品提供不落库的剧情建议。',
  capability: 'analysis.read',
  inputSchema: objectSchema({ question: string, chapter_id: integer }, ['question']),
  execute: async context => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [context.bookId]);
    return llm.consult(book, context.args.question, context.args.chapter_id || null);
  },
});

agentRead({
  name: 'polish_text',
  title: '润色文字',
  description: '在不改变剧情设定的前提下润色文字。',
  capability: 'analysis.read',
  scope: 'global',
  inputSchema: objectSchema({ text: string, requirement: string }, ['text']),
  execute: context => llm.callLLM([
    { role: 'system', content: '润色中文小说文字，不改变剧情、人物和设定，只输出润色结果。' },
    { role: 'user', content: `要求：${context.args.requirement || '保持原风格'}\n\n${context.args.text}` },
  ], { maxTokens: 8000, temperature: 0.5 }),
});

writeNative({
  name: 'update_character_profile',
  title: '更新人物档案',
  description: '按稳定人物 ID 更新静态档案，不修改动态状态。',
  capability: 'characters.write',
  inputSchema: objectSchema({
    character_id: integer,
    patch: objectSchema({
      name: string, role: string, intro: string, appearance: string,
      personality: string, background: string, note: string,
    }),
  }, ['character_id', 'patch']),
  execute: context => characters.updateCharacterProfile(
    context.bookId, context.args.character_id, context.args.patch
  ),
});

writeNative({
  name: 'set_character_aliases',
  title: '设置人物别名',
  description: '替换人物的主名称和别名清单。',
  capability: 'characters.write',
  inputSchema: objectSchema({
    character_id: integer,
    aliases: {
      type: 'array',
      items: objectSchema({
        alias: string, alias_type: string, is_primary: { type: 'boolean' },
      }, ['alias']),
    },
  }, ['character_id', 'aliases']),
  execute: context => characters.setAliases(
    context.bookId, context.args.character_id, context.args.aliases
  ),
});

writeNative({
  name: 'archive_character',
  title: '归档人物',
  description: '归档人物并保留历史事件、关系和引用。',
  capability: 'characters.archive',
  mutation: 'archive',
  inputSchema: objectSchema({ character_id: integer }, ['character_id']),
  execute: context => characters.archiveCharacter(context.bookId, context.args.character_id),
});

writeNative({
  name: 'propose_story_event',
  title: '提出故事事件',
  description: '创建待确认事件提案，不直接改变正典。source_quote 填变化对应的正文原句，作为可核对的依据；changes 每项给出人物状态或关系变化。',
  capability: 'proposals.write',
  inputSchema: objectSchema({
    title: string, summary: string, chapter_id: integer,
    importance: importanceEnum, source_quote: string,
    changes: { type: 'array', items: changeSchema() },
  }, ['title', 'changes']),
  execute: context => proposals.createProposal(context.bookId, {
    ...context.args, source_type: 'manual',
    created_by: 'agent', created_via: 'propose_story_event',
    created_session_id: context.sessionId, created_model: context.model,
  }),
});

writeNative({
  name: 'correct_story_event',
  title: '修正故事事件（提案）',
  description: '针对已存在的正典事件提出【修正提案】，不直接改写正典：生成一条 supersedes_event_id 指向目标事件的待确认提案，作者采纳后才走修正事务生成替代事件并重建投影。replacement 需给出修正后的完整事件：标题、简介、重要性、章节、原文依据与全部变化项（缺失的变化项会被视为删除）。',
  capability: 'proposals.write',
  inputSchema: objectSchema({
    event_id: integer,
    replacement: objectSchema({
      title: string, summary: string, chapter_id: integer,
      importance: importanceEnum, source_quote: string,
      changes: { type: 'array', items: changeSchema() },
    }, ['title', 'changes']),
  }, ['event_id', 'replacement']),
  execute: context => proposals.createProposal(context.bookId, {
    ...context.args.replacement,
    source_type: 'manual',
    supersedes_event_id: context.args.event_id,
    created_by: 'agent', created_via: 'correct_story_event',
    created_session_id: context.sessionId, created_model: context.model,
  }),
});

writeNative({
  name: 'propose_relation_change',
  title: '提出关系变化',
  description: '把人物关系变化写成待确认事件提案。',
  capability: 'relations.write',
  inputSchema: objectSchema({
    title: string,
    relation: { type: 'object' },
  }, ['title', 'relation']),
  execute: context => {
    const publicId = context.args.relation.public_id || relations.generatePublicId();
    const normalized = relations.normalizeRelationChange(context.bookId, {
      change_kind: 'relation', subject_ref: publicId, field_key: 'snapshot',
      old_value: null, new_value: context.args.relation,
    }, { checkOld: false });
    return proposals.createProposal(context.bookId, {
      title: context.args.title,
      summary: context.args.summary || '',
      source_type: 'manual',
      changes: [normalized],
      created_by: 'agent', created_via: 'propose_relation_change',
      created_session_id: context.sessionId, created_model: context.model,
    });
  },
});

// 提案评审/更新工具的确认卡差异快照：读取提案当前完整内容（含每项 old→new），
// 供作者在执行前独立核对（评审 §1“确认卡必须展示提案完整差异” / §3“绑定具体版本的完整 diff”）。
function proposalPreview(bookId, proposalId, expectedRevision) {
  const proposal = proposals.getProposal(bookId, proposalId);
  const revision = Number(proposal.revision || 1);
  const preview = {
    kind: 'event_proposal',
    proposal_id: proposal.id,
    revision,
    status: proposal.status,
    created_by: proposal.created_by || 'author',
    title: proposal.title,
    summary: proposal.summary || '',
    chapter_id: proposal.chapter_id,
    chapter_title: proposal.chapter_title || '',
    importance: proposal.importance,
    source_quote: proposal.source_quote || '',
    supersedes_event_id: proposal.supersedes_event_id || null,
    changes: (proposal.changes || []).map(change => ({
      change_kind: change.change_kind,
      subject_ref: change.subject_ref,
      field_key: change.field_key,
      old_value: change.old_value === undefined ? null : change.old_value,
      new_value: change.new_value === undefined ? null : change.new_value,
    })),
  };
  if (expectedRevision !== undefined && expectedRevision !== null) {
    preview.expected_revision = Number(expectedRevision);
    preview.version_match = Number(expectedRevision) === revision;
  }
  return preview;
}

// reject 必须带理由：在请求确认前（validate）与执行时（execute）均强制，避免直接 execute 调用绕过
function requireRejectNote(args) {
  if (args.action === 'reject' && !String(args.review_note || '').trim()) {
    throw new DomainError('VALIDATION_ERROR', '驳回提案必须填写 review_note 说明理由', 400, { field: 'review_note' });
  }
}

agentWrite({
  name: 'update_event_proposal',
  title: '更新事件提案',
  description: '修改一条待确认(pending/stale)事件提案，不直接改动正典。注意 changes 是【全量替换】而非局部补丁：传入的 changes 会整体覆盖提案原有全部变化项，未包含的原变化项将被删除；只想改标题/依据时不要传 changes。必须带 expected_revision 做乐观锁——若提案在此期间被他人编辑导致 revision 不符，会返回 PROPOSAL_VERSION_CONFLICT，请重新读取最新提案后再改。',
  capability: 'proposals.write',
  inputSchema: objectSchema({
    proposal_id: integer,
    expected_revision: integer,
    title: string, summary: string, chapter_id: integer,
    importance: importanceEnum, source_quote: string, review_note: string,
    changes: { type: 'array', items: changeSchema() },
  }, ['proposal_id', 'expected_revision']),
  confirmationPreview: context => proposalPreview(context.bookId, context.args.proposal_id, context.args.expected_revision),
  execute: context => proposals.updateProposal(context.bookId, context.args.proposal_id, {
    title: context.args.title,
    summary: context.args.summary,
    chapter_id: context.args.chapter_id,
    importance: context.args.importance,
    source_quote: context.args.source_quote,
    review_note: context.args.review_note,
    changes: context.args.changes,
  }, {
    expected_revision: context.args.expected_revision,
    edited_by: 'agent',
    edit_note: context.args.review_note || '',
  }),
});

agentWrite({
  name: 'review_event_proposal',
  title: '评审事件提案',
  description: '对一条待确认事件提案做出采纳(accept)或驳回(reject)，需作者在确认卡核对提案完整差异后放行，禁止后台自动采纳或批量自采。accept 会把提案写入正典（修正提案走修正事务并重建投影）；reject 仅标记驳回。必须带 expected_revision 绑定所确认的提案版本——确认期间若提案被编辑导致 revision 不符，返回 PROPOSAL_VERSION_CONFLICT，须重新读取核对后再评审。action=reject 时 review_note 必填，说明驳回理由。',
  capability: 'proposals.write',
  inputSchema: objectSchema({
    proposal_id: integer,
    action: { type: 'string', enum: ['accept', 'reject'] },
    expected_revision: integer,
    review_note: string,
  }, ['proposal_id', 'action', 'expected_revision']),
  validate: context => requireRejectNote(context.args),
  confirmationPreview: context => proposalPreview(context.bookId, context.args.proposal_id, context.args.expected_revision),
  execute: context => {
    requireRejectNote(context.args);
    const action = context.args.action;
    const note = String(context.args.review_note || '').trim();
    return action === 'accept'
      ? proposals.acceptProposal(context.bookId, context.args.proposal_id, {
        expected_revision: context.args.expected_revision,
        review_note: note,
        actor: context.actor || 'author',
      })
      : proposals.rejectProposal(context.bookId, context.args.proposal_id, {
        expected_revision: context.args.expected_revision,
        review_note: note,
      });
  },
});

agentWrite({
  name: 'start_ledger_backfill',
  title: '启动台账回填',
  description: '对本书所有已定稿章节后台重新抽取人物事实，生成 history_backfill 待审提案（绝不直接改正典，采纳仍需逐条人工确认）。本工具立即返回 job_id 且不等待完成；随后请用 get_ledger_backfill_status 轮询进度，不要在同一轮里紧密轮询。已成功抽取且正文未变的章节、以及已入库的字段会自动跳过（force=true 强制重抽）。',
  capability: 'ledger.backfill',
  inputSchema: objectSchema({
    chapter_ids: { type: 'array', items: integer },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    force: { type: 'boolean' },
  }),
  execute: context => {
    // signal 只用于「是否启动」：请求已取消则不启动后台任务（评审 §4）
    if (context.signal && context.signal.aborted) {
      throw new DomainError('BACKFILL_ABORTED', '请求已取消，未启动回填', 409);
    }
    const result = backfill.startBackfill(context.bookId, {
      chapterIds: context.args.chapter_ids,
      limit: context.args.limit,
      force: context.args.force === true,
    });
    const status = result.status || {};
    return {
      started: result.started === true,
      reason: result.reason || null,
      job_id: status.job_id || null,
      phase: status.phase || null,
      total: status.total || 0,
      message: result.started
        ? `回填已开始（共 ${status.total || 0} 章），后台运行中；请用 get_ledger_backfill_status 携 job_id 查询进度，勿紧密轮询。`
        : '本书已有回填任务在运行，未重复启动。',
    };
  },
});

agentRead({
  name: 'get_ledger_backfill_status',
  title: '查询台账回填进度',
  description: '按 job_id 查询回填任务进度。任务在本进程运行时返回实时 phase/processed/total/created；若服务重启导致任务对象丢失，返回 phase=lost（有持久化抽取记录）或 unknown（无任何记录），不会伪装成 idle。省略 job_id 则返回本书当前/最近一次任务状态。',
  capability: 'ledger.backfill',
  inputSchema: objectSchema({ job_id: string }),
  execute: context => backfill.getStatus(context.bookId, context.args.job_id),
});

agentRead({
  name: 'audit_character_states',
  title: '体检人物状态',
  description: '只读体检本书人物状态可信度，返回摘要计数 + 分页明细。三类确定性检查：投影完整性（投影值≠叙事序重放、引用无效、last_event_id 非叙事最末）、抽取覆盖（定稿章当前修订无成功抽取记录）、冲突候选（同角色字段多条互斥待审提案）；另有证据 stale/缺 source_quote 与新鲜度弱提示。先体检再取证修复：用 issue_types/character_ids/field_keys/min_severity 过滤，limit/cursor 分页。freshness_candidate 仅为弱提示，不代表必然陈旧。',
  snippet: '体检人物状态可信度，limit/cursor 分页',
  capability: 'ledger.audit',
  inputSchema: objectSchema({
    issue_types: { type: 'array', items: { type: 'string', enum: [...stateAudit.ISSUE_TYPES] } },
    character_ids: { type: 'array', items: integer },
    field_keys: { type: 'array', items: string },
    min_severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: 'integer', minimum: 0 },
  }),
  execute: context => {
    const result = stateAudit.auditCharacterStates(context.bookId, {
      issue_types: context.args.issue_types,
      character_ids: context.args.character_ids,
      field_keys: context.args.field_keys,
      min_severity: context.args.min_severity,
      limit: Math.min(50, Number(context.args.limit) || 15),
      cursor: context.args.cursor,
    });
    // 输出预算：确保 JSON 不被 3000 字上限截成损坏结构（capToolResult 裸切会破坏 JSON）。
    // 逐级降级——完整明细 → 去 details（保留计数与定位）→ 再对半裁剪条数；summary 始终含全量计数，
    // 裁剪后重算 next_cursor/truncated，模型仍可据 summary 与游标继续翻页。
    const BUDGET = 2800;
    const slimItem = item => ({
      type: item.type, severity: item.severity, character_id: item.character_id,
      field_key: item.field_key, chapter_id: item.chapter_id, event_id: item.event_id, message: item.message,
    });
    const envelope = (items, keptCount) => {
      const nextCursor = result.cursor + keptCount < result.summary.total ? result.cursor + keptCount : null;
      return {
        summary: result.summary, limit: result.limit, cursor: result.cursor,
        next_cursor: nextCursor, truncated: nextCursor !== null, items,
      };
    };
    let out = envelope(result.items, result.items.length);
    if (JSON.stringify(out).length > BUDGET) out = envelope(result.items.map(slimItem), result.items.length);
    let kept = result.items.length;
    while (JSON.stringify(out).length > BUDGET && kept > 1) {
      kept = Math.max(1, Math.floor(kept / 2));
      out = envelope(result.items.slice(0, kept).map(slimItem), kept);
    }
    return out;
  },
});

// 建字段前置校验（评审 §1 强限制）：reason 必填；enum/level 必须给非空 options。
// 在请求确认前（validate）抛错，避免浪费作者的一次确认；domain createStateField 再次强制，防直接 execute 绕过。
function requireFieldReason(args) {
  if (!String(args.reason || '').trim()) {
    throw new DomainError('VALIDATION_ERROR', '新建状态字段必须填写 reason 说明为何现有字段不足', 400, { field: 'reason' });
  }
  const valueType = String(args.value_type || '');
  const options = Array.isArray(args.options) ? args.options.map(option => String(option).trim()).filter(Boolean) : [];
  if ((valueType === 'enum' || valueType === 'level') && !options.length) {
    throw new DomainError('VALIDATION_ERROR', `${valueType} 类型字段必须提供非空 options 候选项`, 400, {
      field: 'options', value_type: valueType,
    });
  }
}

// 建字段确认卡快照：展示将创建的字段与理由，供作者独立核对（评审 §1）
function fieldPreview(args) {
  const valueType = String(args.value_type || 'text');
  const options = Array.isArray(args.options) ? args.options.map(option => String(option).trim()).filter(Boolean) : [];
  const preview = {
    action: 'create_state_field',
    field_key: String(args.field_key || ''),
    label: String(args.label || ''),
    value_type: valueType,
    reason: String(args.reason || ''),
  };
  if (options.length) preview.options = options;
  return preview;
}

agentWrite({
  name: 'create_state_field',
  title: '新建状态字段（受限）',
  description: '为本书人物状态新增一个字段分类。这是受限工具：STATE_FIELD_NOT_FOUND 通常意味着字段名写错，应优先读取现有字段并映射到最贴切的既有 field_key，只有在作者明确要求新增分类时才调用。必须给出 reason 说明为何现有字段不足；value_type=enum 或 level 时必须提供非空 options 候选项。需作者在确认卡核对后放行，不会自动生效。',
  capability: 'ledger.write',
  inputSchema: objectSchema({
    field_key: string,
    label: string,
    value_type: { type: 'string', enum: ['text', 'enum', 'list', 'level'] },
    options: { type: 'array', items: string },
    reason: string,
    sort_order: { type: 'integer', minimum: 0 },
  }, ['field_key', 'label', 'value_type', 'reason']),
  validate: context => requireFieldReason(context.args),
  confirmationPreview: context => fieldPreview(context.args),
  execute: context => {
    requireFieldReason(context.args);
    return ledger.createStateField(context.bookId, {
      field_key: context.args.field_key,
      label: context.args.label,
      value_type: context.args.value_type,
      options: context.args.options,
      sort_order: context.args.sort_order,
    });
  },
});

// 事件撤销入口（方向报告 1.6）：retractEvent 此前只有普通路由（D1-08），Agent 侧不可达——
// 作者让 AI 撤一条错误事件时只能绕「修正提案」。补齐走确认卡的写工具，
// 与台账工作台人工撤销同一领域函数，同一 append-only 语义。
agentWrite({
  name: 'retract_event',
  title: '撤销事实事件',
  description: '撤销一条本不该存在的正典事实事件（追加式 retraction）：原事件记录保留可审计，但退出有效重放，其状态变化不再生效，人物状态与关系投影自动全量重建。仅用于「事件本身不该存在」的场景（如误抽取、与正文不符）；事件内容部分有误应走修正提案（supersede）而非整体撤销。必须填写 reason 说明撤销依据。',
  capability: 'ledger.write',
  inputSchema: objectSchema({
    event_id: integer,
    reason: string,
    importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
  }, ['event_id', 'reason']),
  validate: context => {
    if (!String(context.args.reason || '').trim()) {
      throw new DomainError('VALIDATION_ERROR', '撤销事件必须填写 reason 说明依据', 400, { field: 'reason' });
    }
    // 目标事件的存在性在确认前暴露，避免作者确认后才报 404
    ledger.getEvent(context.bookId, context.args.event_id);
  },
  confirmationPreview: context => {
    const original = ledger.getEvent(context.bookId, context.args.event_id);
    return {
      action: 'retract_event',
      event_id: context.args.event_id,
      event_title: original.title,
      chapter_title: original.chapter_title || null,
      change_count: (original.changes || []).length,
      reason: String(context.args.reason || ''),
    };
  },
  execute: context => ledger.retractEvent(context.bookId, context.args.event_id, {
    reason: context.args.reason,
    importance: context.args.importance,
  }),
});

writeNative({
  name: 'create_story_thread',
  title: '创建故事线索',
  description: '创建伏笔、谜团、承诺、债务或计划。',
  capability: 'threads.write',
  inputSchema: objectSchema({
    type: string, title: string, summary: string, status: string,
    importance: string, character_ids: { type: 'array', items: integer },
  }, ['type', 'title']),
  execute: context => threads.createThread(context.bookId, context.args),
});

writeNative({
  name: 'update_story_thread',
  title: '更新故事线索',
  description: '按稳定 ID 更新故事线索。',
  capability: 'threads.write',
  inputSchema: objectSchema({ thread_id: integer, patch: { type: 'object' } }, ['thread_id', 'patch']),
  execute: context => threads.updateThread(context.bookId, context.args.thread_id, context.args.patch),
});

writeNative({
  name: 'update_book_progress',
  title: '更新全书进度',
  description: '更新故事台账中的全书进展摘要。',
  capability: 'ledger.write',
  inputSchema: objectSchema({
    summary: string,
    source_fingerprint: { type: 'string', description: '来源指纹乐观锁：确认时由系统自动绑定，模型无需提供' },
  }, ['summary']),
  execute: context => {
    const lifecycle = require('../domain/chapterLifecycle');
    const guard = require('../domain/sourceGuard');
    // S5-01：确认信封创建时绑定全书来源指纹（executor.bindSummarySource）；等待确认期间
    // 卷/章总结变化 → 409 SOURCE_CHANGED，不把旧结果写成「基于新底料」的全书摘要。
    // 核验、写入、指纹刷新在同一个同步事务内，之间无 await。
    return db.transaction(() => {
      const snapshot = guard.captureSource({ bookId: context.bookId, kind: 'book', entityId: context.bookId });
      if (context.args.source_fingerprint) {
        guard.assertSourceCurrent({
          bookId: context.bookId, kind: 'book', entityId: context.bookId,
          fingerprint: String(context.args.source_fingerprint),
        });
      }
      // A10：story_state.updated_at 统一 SQL localtime（与 DDL 默认及其它写入点同格式）
      db.run(
        `INSERT INTO story_state (book_id, kind, content, updated_at)
         VALUES (?, 'book_summary', ?, datetime('now','localtime'))
         ON CONFLICT(book_id, kind) DO UPDATE SET
           content = excluded.content, updated_at = excluded.updated_at`,
        [context.bookId, String(context.args.summary).trim()]
      );
      const row = db.get('SELECT updated_at FROM story_state WHERE book_id = ? AND kind = ?', [context.bookId, 'book_summary']);
      // 新摘要基于当前底料生成 → 刷新指纹、清除过期标记（方向报告 4.1 书层传播）
      lifecycle.refreshBookSummaryFingerprint(context.bookId);
      return {
        summary: String(context.args.summary).trim(),
        updated_at: row && row.updated_at,
        source_fingerprint: snapshot.fingerprint,
      };
    });
  },
});

function descriptor(name) {
  return registry.get(name) || null;
}

function listTools(profile = 'writing') {
  const allowed = profiles[profile];
  if (!allowed) throw new Error(`未知工具 profile：${profile}`);
  return [...registry.values()].filter(item => allowed.has(item.name));
}

// 全量注册表（不过 profile 过滤）：供「全部可达」不变量测试与注册中心自检使用。
// 死工具清理（方向报告 1.10）：每个注册工具必须至少进入一个 profile 白名单，
// 否则模型工具目录与审查报告会被不可达死代码污染。
function listAllTools() {
  return [...registry.values()];
}

module.exports = { register, descriptor, listTools, listAllTools, profiles, objectSchema, promptDescription, firstSentence };
