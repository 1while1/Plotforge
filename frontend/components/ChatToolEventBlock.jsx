// S5-5（Plan §1.1 G4）：只读工具调用块——public/legacy/book-chat.js renderToolEvent :400-416 逐字迁移。
// <details class="tool-call">＞summary「调用工具：<中文名|原名>」＋「入参：」JSON＋「结果：」字符串直出。
// 纯渲染：零 fetch、零 window 读写。
import { TOOL_LABELS } from "../lib/chat-render.js";

export function ChatToolEventBlock({ event }) {
	return (
		<details className="tool-call">
			<summary>{`调用工具：${TOOL_LABELS[event.name] || event.name}`}</summary>
			<div className="tool-call-body">
				<pre>{`入参：${JSON.stringify(event.args || {})}`}</pre>
				<pre>{`结果：${typeof event.result === "string" ? event.result : JSON.stringify(event.result)}`}</pre>
			</div>
		</details>
	);
}
