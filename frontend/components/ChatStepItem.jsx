// 写作助手消息里的工具调用，按「步骤清单」呈现：一行一步（友好名＋关键入参），展开看入参/结果原文。
// 只用于写作页聊天；阅读页与桥面导出仍用 ChatToolEventBlock 的旧呈现。
import { TOOL_LABELS } from "../lib/chat-render.js";

const HINT_KEYS = ["title", "name", "query", "keyword", "pattern", "question"];
const HINT_MAX = 24;

export function stepHint(args) {
	if (!args || typeof args !== "object") return "";
	for (const key of HINT_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) {
			const s = v.trim().replace(/\s+/g, " ");
			return s.length > HINT_MAX ? `${s.slice(0, HINT_MAX)}…` : s;
		}
	}
	return "";
}

export function ChatStepItem({ event }) {
	const label = TOOL_LABELS[event.name] || event.name || "未知操作";
	const hint = stepHint(event.args);
	return (
		<details className="tool-call step">
			<summary title={`调用工具：${event.name || ""}`}>
				<span className="step-check" aria-hidden="true">
					✓
				</span>
				<span className="step-name">{label}</span>
				{hint ? <span className="step-hint">{`「${hint}」`}</span> : null}
			</summary>
			<div className="tool-call-body">
				<pre>{`入参：${JSON.stringify(event.args || {})}`}</pre>
				<pre>{`结果：${typeof event.result === "string" ? event.result : JSON.stringify(event.result)}`}</pre>
			</div>
		</details>
	);
}
