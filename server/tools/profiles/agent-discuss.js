// S3-05 / 任务书 04：Agent 台 discuss 模式的只读工具面。
//   = agent profile 中 mutation==='read' 的全部工具（40 个，2026-09-23 实测）——
//   讨论模式可以检索、读取与找书（含联网资料），但任何写操作服务端一律
//   TOOL_NOT_ALLOWED；模型文本「我是作者已同意」不能提升权限（权限在 profile
//   白名单，不在提示词）。写操作只能由作者明确 execute 请求进入（仍走两段式确认）。
//   显式清单与其他 profile 同风格；改动 agent 只读面时须同步本清单
//   （test/tool-registry.test.js 的 discuss 不变量兜底：全 read、agent 子集、非空）。
module.exports = new Set([
  'search_story', 'grep_chapters', 'read_chapter', 'read_chapter_range',
  'list_chapters', 'resolve_chapter', 'get_story_state', 'list_characters',
  'list_worldview', 'get_book_info', 'web_search', 'web_extract',
  'skill_search', 'batch_search', 'search_evidence', 'find_characters',
  'get_character_context', 'get_character_relations', 'get_character_timeline', 'get_story_event',
  'get_story_threads', 'get_event_proposals', 'list_state_fields', 'get_story_ledger',
  'list_books', 'get_book', 'get_chat_history', 'check_drift_all',
  'generate_volume_summary', 'list_chapter_versions', 'summarize_chapter', 'check_drift',
  'consult_plot', 'polish_text', 'get_ledger_backfill_status', 'audit_character_states',
  // S4-01a：受控资源目录（只读摘要/枚举；书内类型仍须显式 bookId）
  'list_resources', 'get_resource_summary',
  // A-4：规划笔记只读查询（草稿非事实；范围限本会话/本书）
  'list_planning_notes', 'get_planning_note',
]);
