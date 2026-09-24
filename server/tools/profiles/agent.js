const writing = require('./writing');

module.exports = new Set([
  ...writing,
  'list_books', 'get_book', 'create_volume', 'move_chapter', 'lock_chapter',
  'get_chat_history', 'check_drift_all', 'generate_volume_summary',
  'list_chapter_versions', 'restore_chapter', 'summarize_chapter',
  'check_drift', 'consult_plot', 'polish_text',
  'update_event_proposal', 'review_event_proposal',
  'start_ledger_backfill', 'get_ledger_backfill_status', 'audit_character_states',
  'create_state_field', 'save_volume_summary', 'save_chapter_summary',
  'retract_event',
  // S4-01a：受控资源目录（只读；与 GET /api/resources 同源）
  'list_resources', 'get_resource_summary',
  // A-4：规划笔记只读查询（草稿非事实；范围限本会话/本书，无全库出口）
  'list_planning_notes', 'get_planning_note',
]);
