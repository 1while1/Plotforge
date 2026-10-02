// S5-5（Plan §1.1 G3）：已结算写操作的紧凑留痕行——public/legacy/book-chat.js renderActionLog
// :447-468 逐字迁移（根 .msg-action-log.status-<key>／图标 ✓（approved）✕（rejected）·（其余）／
// 文案 TOOL_LABELS[name]||summary||name，args.title 存在时追加「title」／状态 span 文案／
// title＝JSON.stringify(args||{},null,2)）。挂在来源消息正文下方，不再独立成卡。
// 纯渲染：零 fetch、零 window 读写（样式 .msg-action-log 见 public/style.css:1683+）。
import {
	actionStatusMeta,
	normalizeActionStatus,
	TOOL_LABELS,
} from "../lib/chat-render.js";

export function ChatActionLogRow({ action, statusKey }) {
	const key = statusKey || normalizeActionStatus(action.status);
	const icon = key === "approved" ? "✓" : key === "rejected" ? "✕" : "·";
	// 老数据的 summary 就是原始工具名，优先用中文标签；有章节标题参数时带上（:456-458）
	let label = TOOL_LABELS[action.name] || action.summary || action.name;
	if (action.args?.title) label += `「${String(action.args.title)}」`;
	return (
		<div
			className={`msg-action-log status-${key}`}
			title={JSON.stringify(action.args || {}, null, 2)}
		>
			<span className="log-icon">{icon}</span>
			<span className="log-text">{label}</span>
			<span className="log-status">{actionStatusMeta(key).text}</span>
		</div>
	);
}
