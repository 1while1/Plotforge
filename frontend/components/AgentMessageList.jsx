// S5-8（Plan §1.1 G6）：服务端历史「消息列表」纯渲染组件（≙ legacy :658-687 的渲染半＋
// :1349-1374 消息原语＋:1344-1347 scrollBottom）。范式 A·判定 C 的「块一建设笔」，零生产切换。
// 只做五类节点：角色行＋来源标签／系统事件后缀（' · 系统事件'）／正文气泡／工具块
// （'调用工具 · <name>（<status>）'，result 真值时 <pre class="tool-call-io"> 且 800 截断）／
// 勾选框（label.agent-pick-toggle＞input[data-message-id]＋'选入结论'）。
// 来源标签经 lib/chat-render.js 的 makeSourceTag('agent') 供给（legacy :1357-1362 同源；本片只 import）。
// props 契约＝本片冻结件（Plan §5）：items/picks（受控消息 id 数组）/onTogglePick/pendingSlot/liveSlot；
// 槽位顺序＝messages → pendingSlot → liveSlot（S5-9 的实时气泡与确认卡挂槽）。
// 纪律：零 fetch、零全局写入；一切文本走 React 文本节点（＝legacy textContent），不用 innerHTML。

import { useEffect, useRef } from "react";
import { agentToolLabel } from "../lib/agent-tool-labels.js";
import { makeSourceTag } from "../lib/chat-render.js";
import { attachBottomFollow, scrollToBottom } from "../lib/scroll-follow.js";

const AGENT_TAG = makeSourceTag("agent");
const SYSTEM_SUFFIX = " · 系统事件";
const TOOL_RESULT_MAX = 800;

function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

export function scrollMessagesToBottom() {
	if (typeof document === "undefined") return;
	scrollToBottom(document.getElementById("agent-messages"));
}

function toolBlock(t, index) {
	let text = null;
	if (t.result) {
		text = String(t.result);
		if (text.length > TOOL_RESULT_MAX)
			text = `${text.slice(0, TOOL_RESULT_MAX)}…`;
	}
	return (
		<details className="tool-call" key={`${t.name || "tool"}:${index}`}>
			<summary>{`调用工具 · ${agentToolLabel(t.name)}（${t.status || ""}）`}</summary>
			{text ? <pre className="tool-call-io">{text}</pre> : null}
		</details>
	);
}

function messageNode(m, index, picks, onTogglePick) {
	const isSystem = m.source === "system";
	const role = isSystem || m.role !== "user" ? "assistant" : "user";
	const pickable = !isSystem && m.id !== undefined && m.id !== null;
	return (
		<div
			className={`msg ${role}`}
			key={m.id !== undefined && m.id !== null ? `id:${m.id}` : `i:${index}`}
		>
			<div className="msg-role">
				{role === "user" ? "我" : "助手"}
				<span className={AGENT_TAG.className}>{AGENT_TAG.textContent}</span>
				{isSystem ? SYSTEM_SUFFIX : null}
			</div>
			<div className="msg-bubble">{m.content}</div>
			{pickable ? (
				<label className="agent-pick-toggle">
					<input
						type="checkbox"
						data-message-id={String(m.id)}
						checked={(picks || []).includes(Number(m.id))}
						onChange={(e) => call(onTogglePick, m, e.target.checked)}
					/>
					选入结论
				</label>
			) : null}
			{(m.tools || []).map((t, i) => toolBlock(t, i))}
		</div>
	);
}

export default function AgentMessageList({
	items,
	picks,
	onTogglePick,
	pendingSlot,
	liveSlot,
}) {
	const ref = useRef(null);
	useEffect(() => attachBottomFollow(ref.current), []);
	return (
		<div id="agent-messages" className="chat-messages" ref={ref}>
			{(items || []).map((m, i) => messageNode(m, i, picks, onTogglePick))}
			{pendingSlot}
			{liveSlot}
		</div>
	);
}
