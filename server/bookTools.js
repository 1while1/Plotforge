// 写作助手的对话内工具：书本域工具集（OpenAI function-calling 原始 schema + 执行器）
// 定位：写作过程中 AI 记忆不足时按需自取——翻旧文、查设定、看大纲；也可提出写操作。
// 权限模型：
//   - 只读工具：自动执行，结果直接回给模型
//   - 写工具（WRITE_TOOLS）：不直接执行，生成「待确认动作」交给前端，作者点击同意后才执行
const db = require('./db');
const vectorSearch = require('./vector/search');
const { DomainError } = require('./domain/errors');
const { truncateChars } = require('./utils/truncate');

// 统一失败语义（对齐 pi「错误即粮食」）：业务失败一律抛 DomainError，
// 由统一执行器审计 failed / 结算 failed / 结构化回给模型。
// 此前旧工具用 {error:...} 普通返回值表达失败，会被执行器当成功结算（审计 success、
// 确认卡 approved、Agent 续跑事件谎称「已真实执行成功」）——包括 A8 乐观锁冲突。
function fail(code, message, status = 400) {
  return new DomainError(code, message, status);
}

function brief(text, max = 500) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  // 码点安全截断（内容满额 + 省略号，与旧 slice 语义一致）：
  // 旧的 UTF-16 slice 会劈开 emoji/扩展汉字的代理对
  return truncateChars(s, max, { suffix: '…' }).content;
}

// ---------------- 工具 schema（发给上游 LLM 的 tools 字段） ----------------
const READ_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_story',
      description: '语义检索已定稿章节的旧文片段（按意思找，不需精确用词）。写作中需要回忆早期剧情细节、伏笔出处、人物说过的话时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找的内容，自然语言描述' },
          topK: { type: 'number', description: '返回片段数，默认3' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_chapters',
      description: '关键词全文检索（含未定稿章节）。查某个词/名字在全部章节中出现的位置和上下文。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '精确关键词' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter',
      description: '读章节正文或tail章尾，按next_cursor用read_chapter_range续读，ID不是目录序号。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'number' },
          maxChars: { type: 'number' },
          tail: { type: 'boolean', description: '续写前设true读取衔接结尾' },
        },
        required: ['chapterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter_range',
      description: '分段读章，start透传上次next_cursor；返回实际start/end，不能按请求length推算进度。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'number' },
          start: { type: 'number', description: '起始字符位置（0起）' },
          length: { type: 'integer', description: '期望码点数，实际按结果预算分页；默认2000' },
        },
        required: ['chapterId', 'start'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_chapters',
      description: '列出本书章节目录：id、所属卷、标题、节拍、字数。返回 { items, total, next_cursor, truncated }：truncated=true 时以 offset=next_cursor 翻页，不要基于不完整目录断言「全书没有X」。',
      parameters: { type: 'object', properties: {
        limit: { type: 'integer', description: '每页数量，默认 200，上限 500' },
        offset: { type: 'integer', description: '翻页游标（next_cursor 透传），默认 0' },
        volumeId: { type: 'integer', description: '按真实卷ID过滤' },
        volumeOrdinal: { type: 'integer', description: '按目录第几卷过滤，不是卷ID' },
        order: { type: 'string', enum: ['asc', 'desc'], description: '找最近章节用desc' },
        withContent: { type: 'boolean', description: '只列已有非空正文的章节' },
      } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_chapter',
      description: '把第几卷第几章或最新有正文章解析成真实ID，位置歧义时拒绝猜测。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        chapterId: { type: 'integer', description: '真实章节ID，可省略' },
        volumeOrdinal: { type: 'integer', description: '目录第几卷' },
        chapterOrdinal: { type: 'integer', description: '该卷目录第几章' },
        latest: { type: 'boolean', description: '最后一章；找最近正文时同时设withContent' },
        withContent: { type: 'boolean' },
      } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_story_state',
      description: '读取状态簿：人物状态 / 未回收伏笔 / 全书进展摘要。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_characters',
      description: '列出本书人物卡。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_worldview',
      description: '列出本书世界观条目。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_book_info',
      description: '查看本书详情：标题、简介、全书总纲、分卷及卷大纲。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息（内置通道）：查资料、核对事实、找素材。写作需要真实背景知识（历史/地理/职业细节等）时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number', description: '结果条数，默认5，最多10' },
          freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时效过滤，可选' },
          zone: { type: 'string', enum: ['cn', 'intl'], description: '国内/国际，可选' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_extract',
      description: '抓取指定 URL 的网页正文（内置通道），用于阅读搜索到的页面全文。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_search',
      description: '通过 anysearch 技能插件（skill CLI）联网搜索，支持垂直领域（code/academic/finance 等23个领域）。内置 web_search 的增强版。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          domain: { type: 'string', description: '垂直领域，如 code/tech/academic/finance/film/music/legal/health/travel 等' },
          maxResults: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_search',
      description: '一次并发搜索 1-5 个相互独立的问题（内置通道，批量版 web_search）：为小说多维度收集素材/设定资料（如同时查时代背景、地理、职业细节）时使用，比逐条调用 web_search 更省轮次；单条失败不影响其它。',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            description: '查询列表，最多 5 条',
            items: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '搜索关键词' },
                maxResults: { type: 'number', description: '该条结果条数，默认5，最多10' },
                freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时效过滤，可选' },
                zone: { type: 'string', enum: ['cn', 'intl'], description: '国内/国际，可选' },
                domain: { type: 'string', description: '垂直领域，可选' },
              },
              required: ['query'],
            },
          },
        },
        required: ['queries'],
      },
    },
  },
];

// 写工具：模型发起 → 作者确认 → 才执行
const WRITE_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'create_chapter',
      description: '新建空章节，服务端自动分配卷内编号与排序；需作者确认。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '可省略；章号由服务端分配，仅需提供章节名称' },
          volumeId: { type: 'number', description: '所属卷id，省略则放最后一卷' },
          beat: { type: 'string', description: '本章节拍/写作任务' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_chapter',
      description: '把正文追加到指定章节末尾。需作者确认后生效；执行前自动留存版本快照。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'number' },
          text: { type: 'string', description: '要追加的正文' },
          expected_revision: { type: 'number', description: '章节版本乐观锁：确认时由系统自动绑定快照版本，模型无需提供' },
        },
        required: ['chapterId', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_chapter',
      description: '整体替换指定章节正文（用于改写）。需作者确认后生效；执行前自动留存版本快照。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'number' },
          content: { type: 'string', description: '替换后的完整正文' },
          expected_revision: { type: 'number', description: '章节版本乐观锁：确认时由系统自动绑定快照版本，模型无需提供' },
        },
        required: ['chapterId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_chapter_meta',
      description: '修改章节标题/节拍。需作者确认后生效。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'number' },
          title: { type: 'string' },
          beat: { type: 'string' },
          expected_revision: { type: 'number', description: '章节版本乐观锁：确认时由系统自动绑定快照版本，模型无需提供' },
        },
        required: ['chapterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_master_outline',
      description: '设置/覆盖全书总纲。需作者确认后生效。',
      parameters: {
        type: 'object',
        properties: { outline: { type: 'string' } },
        required: ['outline'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_volume',
      description: '修改分卷标题或卷大纲。需作者确认后生效。',
      parameters: {
        type: 'object',
        properties: {
          volumeId: { type: 'number' },
          title: { type: 'string' },
          outline: { type: 'string' },
        },
        required: ['volumeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_worldview',
      description: '新增世界观条目。需作者确认后生效。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
  },
  // 死工具清理（方向报告 1.10）：add_character / update_character / write_story_state
  // 已删除——旧人物卡写工具与旧状态簿直改被 create_character / update_character_profile /
  // 事件提案体系取代后长期不可达（不在任何 profile 白名单），注册表以「全部可达」为不变量。
];

const SCHEMAS = [...READ_SCHEMAS, ...WRITE_SCHEMAS];
const WRITE_TOOLS = new Set(WRITE_SCHEMAS.map(t => t.function.name));

// 设置页「启用联网搜索」总闸（默认开）。关掉后四个联网工具一律不出网、不烧付费额度。
function searchEnabled() {
  const row = db.get("SELECT value FROM settings WHERE key = 'search_enabled'");
  if (!row || String(row.value).trim() === '') return true;
  const v = String(row.value).trim().toLowerCase();
  return !(v === '0' || v === 'false');
}
const SEARCH_DISABLED_MSG = '联网搜索已在设置中停用，请到设置页开启';

// ---------------- 只读工具：立即执行 ----------------
async function executeRead(bookId, name, args) {
  switch (name) {
    case 'search_story': {
      try {
        const hits = await vectorSearch.search(bookId, args.query, { topK: args.topK || 3 });
        if (!hits.length) return { message: '未检索到相关片段（可能相关章节尚未定稿，可改用 grep_chapters 关键词查）' };
        return hits.map(h => ({ chapter: h.chapter_title, score: Number(h.score.toFixed(3)), text: h.text }));
      } catch (e) {
        throw fail('SEARCH_STORY_FAILED', '检索失败：' + e.message, 500);
      }
    }
    case 'grep_chapters': {
      // 空关键词会让 split('') 把每个字符算一次命中，返回整本书的伪结果
      const keyword = String(args.keyword || '');
      if (!keyword.trim()) throw fail('INVALID_ARGS', 'keyword 不能为空', 400);
      const chapters = db.all('SELECT c.id, c.title, c.content FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id WHERE c.book_id = ? ORDER BY COALESCE(v.sort_order, 2147483647), c.sort_order, c.id', [bookId]);
      const out = [];
      for (const ch of chapters) {
        const content = ch.content || '';
        const count = content.split(keyword).length - 1;
        if (!count) continue;
        const snippets = [];
        let idx = 0;
        while ((idx = content.indexOf(keyword, idx)) !== -1 && snippets.length < 3) {
          snippets.push('…' + content.slice(Math.max(0, idx - 40), idx + keyword.length + 40) + '…');
          idx += keyword.length;
        }
        out.push({ chapterId: ch.id, chapter: ch.title, count, snippets });
      }
      return out.length ? out : { message: `全部章节中未找到"${keyword}"` };
    }
    case 'read_chapter':
    case 'read_chapter_range':
      return require('./domain/chapterNavigation').readChapterPage(bookId, args);
    case 'list_chapters':
      return require('./domain/chapterNavigation').listChapterPage(bookId, args);
    case 'resolve_chapter':
      return require('./domain/chapterNavigation').resolveChapter(bookId, args);
    case 'get_story_state':
      return db.all('SELECT kind, content, updated_at FROM story_state WHERE book_id = ?', [bookId]);
    case 'list_characters':
      return db.all('SELECT name, role, appearance, personality, background, note FROM characters WHERE book_id = ? ORDER BY id', [bookId]);
    case 'list_worldview':
      return db.all('SELECT title, content FROM world_entries WHERE book_id = ? ORDER BY id', [bookId]);
    case 'get_book_info': {
      const book = db.get('SELECT title, intro, master_outline FROM books WHERE id = ?', [bookId]);
      const volumes = db.all('SELECT id, title, outline, summary FROM volumes WHERE book_id = ? ORDER BY sort_order, id', [bookId]);
      return { ...book, volumes };
    }
    case 'web_search': {
      if (!searchEnabled()) throw fail('SEARCH_DISABLED', SEARCH_DISABLED_MSG, 403);
      try {
        const text = await require('./websearch').search(args);
        return { results: text };
      } catch (e) {
        throw fail('WEB_SEARCH_FAILED', '联网搜索失败：' + e.message, 502);
      }
    }
    case 'web_extract': {
      if (!searchEnabled()) throw fail('SEARCH_DISABLED', SEARCH_DISABLED_MSG, 403);
      try {
        const text = await require('./websearch').extract(args.url);
        return { content: text };
      } catch (e) {
        throw fail('WEB_EXTRACT_FAILED', '网页抓取失败：' + e.message, 502);
      }
    }
    case 'skill_search': {
      if (!searchEnabled()) throw fail('SEARCH_DISABLED', SEARCH_DISABLED_MSG, 403);
      try {
        const argv = ['search', String(args.query)];
        if (args.domain) argv.push('--domain', args.domain);
        if (args.maxResults) argv.push('--max_results', String(args.maxResults));
        const text = await require('./skills').runSkillCli('anysearch', argv);
        return { results: text };
      } catch (e) {
        throw fail('SKILL_SEARCH_FAILED', '技能搜索失败：' + e.message, 502);
      }
    }
    case 'batch_search': {
      if (!searchEnabled()) throw fail('SEARCH_DISABLED', SEARCH_DISABLED_MSG, 403);
      try {
        const text = await require('./websearch').batchSearch(args.queries);
        return { results: text };
      } catch (e) {
        throw fail('BATCH_SEARCH_FAILED', '批量搜索失败：' + e.message, 502);
      }
    }
    default:
      throw fail('TOOL_NOT_FOUND', '未知工具: ' + name, 404);
  }
}

// ---------------- 写工具：作者点击「同意」后才执行 ----------------
async function executeWrite(bookId, name, args) {
  switch (name) {
    case 'create_chapter': {
      const chapter = require('./domain/chapterCatalog').createChapter(bookId, args);
      return { ok: true, chapter };
    }
    case 'append_chapter': {
      const ch = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [args.chapterId, bookId]);
      if (!ch) throw fail('CHAPTER_NOT_FOUND', '章节不存在', 404);
      // S1-03：AI 写入统一走单调版本守卫（expected_revision 由确认信封在创建时绑定注入，
      // 缺失 428、过期 409）；快照/失效/自动解锁定稿/revision 递增由领域入口同事务完成
      const sep = ch.content && !ch.content.endsWith('\n') ? '\n' : '';
      const next = (ch.content || '') + sep + args.text;
      const applied = require('./domain/chapterMutations').applyChapterMutation({
        bookId, chapterId: ch.id, expectedRevision: args.expected_revision,
        patch: { content: next }, reason: 'before-ai-append',
      });
      // 事实抽取改为「定稿」时统一触发，AI 追加正文不再即时抽取
      return { ok: true, chapterId: ch.id, newChars: next.length, revision: applied.chapter.revision, invalidated: applied.invalidated };
    }
    case 'replace_chapter': {
      const ch = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [args.chapterId, bookId]);
      if (!ch) throw fail('CHAPTER_NOT_FOUND', '章节不存在', 404);
      const applied = require('./domain/chapterMutations').applyChapterMutation({
        bookId, chapterId: ch.id, expectedRevision: args.expected_revision,
        patch: { content: args.content }, reason: 'before-ai-replace',
      });
      // 事实抽取改为「定稿」时统一触发，AI 替换正文不再即时抽取
      return { ok: true, chapterId: ch.id, newChars: args.content.length, revision: applied.chapter.revision, invalidated: applied.invalidated };
    }
    case 'set_chapter_meta': {
      const ch = db.get('SELECT id FROM chapters WHERE id = ? AND book_id = ?', [args.chapterId, bookId]);
      if (!ch) throw fail('CHAPTER_NOT_FOUND', '章节不存在', 404);
      const patch = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.beat !== undefined) patch.beat = args.beat;
      const applied = require('./domain/chapterMutations').applyChapterMutation({
        bookId, chapterId: ch.id, expectedRevision: args.expected_revision,
        patch, reason: 'before-ai-meta',
      });
      return { ok: true, chapterId: ch.id, revision: applied.chapter.revision };
    }
    case 'set_master_outline': {
      db.run('UPDATE books SET master_outline = ? WHERE id = ?', [args.outline, bookId]);
      return { ok: true };
    }
    case 'update_volume': {
      const vol = db.get('SELECT id FROM volumes WHERE id = ? AND book_id = ?', [args.volumeId, bookId]);
      if (!vol) throw fail('VOLUME_NOT_FOUND', '卷不存在', 404);
      if (args.title !== undefined) db.run('UPDATE volumes SET title = ? WHERE id = ?', [args.title, vol.id]);
      if (args.outline !== undefined) db.run('UPDATE volumes SET outline = ? WHERE id = ?', [args.outline, vol.id]);
      return { ok: true, volumeId: vol.id };
    }
    case 'add_worldview': {
      const r = db.run(
        'INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)',
        [bookId, args.title, args.content]
      );
      return { ok: true, entryId: r.lastInsertRowid };
    }
    default:
      throw fail('TOOL_NOT_FOUND', '未知写工具: ' + name, 404);
  }
}

// 追加到系统提示词的工具使用说明
const TOOL_GUIDE = `
【可用工具】你可以主动调用工具辅助写作：
- 记忆不足、需回忆旧剧情细节 → search_story（语义）或 grep_chapters（关键词）
- 需要看某章原文 → read_chapter / read_chapter_range
- 需要确认设定/人物/大纲/伏笔 → get_story_state / list_characters / list_worldview / get_book_info
- 需要真实背景资料、核对事实、找素材 → web_search / web_extract（联网，内置通道）；多维度并行收集素材 → batch_search（一次并发查 2-5 个独立问题）；需要垂直领域搜索（学术/代码/财经等）→ skill_search（技能插件）
- 用户明确要求「上网/联网/搜索一下/查最新消息」时，必须调用 web_search（联网通道）——search_story / grep_chapters 只检索本书旧文，不能替代联网搜索，也不得声称没有联网功能
- 提案里的 old_value 不要凭印象猜：只有当你确实从 get_character_context 看到过该人物该字段的当前值时才填，否则请省略（省略即不做陈旧校验）；猜错会被 STALE_OLD_VALUE 拒绝。
- 要提交状态/关系变化提案（propose_story_event / correct_story_event）前，先调 list_state_fields 查本书可用的 field_key 与关系类型——field_key 只能从那里选，不要凭印象编字段名；subject_ref 必须填人物数字 id（先用 list_characters / find_characters 查），填人名会被拒绝。
- 用户说「第几卷/第几章」先用resolve_chapter取得真实ID，不把章号当ID；list_chapters给出卷内和全书序号；找最新正文用latest:true,withContent:true，不将界面选中旧章误当最新章
- 需要落笔改动（建章节/追加正文/改设定/改大纲）→ 调用对应写工具，写工具不会立即生效，会交给作者确认，作者同意后改动才落地；你只需照常继续回复。
- 写正文要一次交齐：用一次 replace_chapter（整章）或一次 append_chapter（续写的整段）提交完整正文，不要拆成很多次小追加；写作轮不要夹带检索调用，需要查资料请在动笔前一轮查完。
- 禁止谎报完成：只有工具真的返回了确认结果，才能说「已提交/已写入」；作者点击同意前不得声称正文已保存到章节，也不得声称调用了不存在的工具（例如 update_chapter）。本轮没提交成功就直说还差哪一步。
不要凭空编造与旧文矛盾的情节；不确定时先查再写。`;

module.exports = { SCHEMAS, WRITE_TOOLS, executeRead, executeWrite, TOOL_GUIDE };
