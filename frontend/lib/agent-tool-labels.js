// AI 助手页（#/agent）工具名的中文标签。
// 写作页经 chat-render.js 的 TOOL_LABELS（19 条）把 search_story 这类内部名映射成中文；助手页
// 此前绕过它直出 snake_case。助手页可用工具面更宽（agent profile 共 68 个工具），本表补齐
// TOOL_LABELS 未覆盖的 52 个，标签均 ≤6 字，供 AgentSidePanel / AgentMessageList / AgentLiveRound
// / agent-actions / agent-round / run-status 复用。
// 回落语义（与 chat-render.js 的 toolLabel 一致）：先查 TOOL_LABELS，再查 AGENT_TOOL_LABELS，
// 都没有则原样返回 name；空串 / null / undefined 一律返回「未知操作」。
import { TOOL_LABELS } from "./chat-render.js";

// agent profile 独有、TOOL_LABELS 未收录的工具名（逐项对照 server/tools/registry.js 的 description）。
export const AGENT_TOOL_LABELS = {
	archive_character: "归档人物",
	audit_character_states: "体检人物状态",
	batch_search: "批量搜索",
	check_drift: "检查章节偏离",
	check_drift_all: "检查全书偏离",
	consult_plot: "剧情参谋",
	correct_story_event: "修正事件提案",
	create_character: "新增人物卡",
	create_state_field: "新建状态字段",
	create_story_thread: "新建故事线索",
	create_volume: "新建分卷",
	find_characters: "查找人物",
	generate_volume_summary: "生成卷总结",
	get_book: "查看作品详情",
	get_character_context: "人物上下文",
	get_character_relations: "读取人物关系",
	get_character_timeline: "人物时间线",
	get_chat_history: "读取写作对话",
	get_event_proposals: "待确认提案",
	get_ledger_backfill_status: "回填进度",
	get_planning_note: "读取规划笔记",
	get_resource_summary: "资源摘要",
	get_story_event: "读取故事事件",
	get_story_ledger: "读取故事台账",
	get_story_threads: "读取故事线索",
	list_books: "列出书籍",
	list_chapter_versions: "章节版本",
	list_planning_notes: "列出规划笔记",
	list_resources: "列出受控资源",
	list_state_fields: "状态字段",
	lock_chapter: "定稿章节",
	move_chapter: "移动章节",
	polish_text: "润色文字",
	propose_relation_change: "提出关系变化",
	propose_story_event: "提出故事事件",
	resolve_chapter: "解析章节",
	restore_chapter: "恢复历史版本",
	retract_event: "撤销事件",
	review_event_proposal: "评审事件提案",
	save_chapter_summary: "保存章总结",
	save_volume_summary: "保存卷总结",
	search_evidence: "检索故事证据",
	set_character_aliases: "设置人物别名",
	skill_search: "技能搜索",
	start_ledger_backfill: "启动台账回填",
	summarize_chapter: "总结章节",
	update_book_progress: "更新全书进度",
	update_character_profile: "更新人物档案",
	update_event_proposal: "更新事件提案",
	update_story_thread: "更新故事线索",
	web_extract: "抓取网页",
	web_search: "联网搜索",
};

export function agentToolLabel(name) {
	const key = name == null ? "" : String(name);
	if (!key) return "未知操作";
	return TOOL_LABELS[key] || AGENT_TOOL_LABELS[key] || key;
}
