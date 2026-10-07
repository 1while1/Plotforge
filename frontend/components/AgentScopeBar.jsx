// S5-8（Plan §1.1 G5）：Agent 台「范围条」props 驱动叶组件（≙ legacy :138-201／:531-547）。
// DOM 契约唯一事实源＝frontend/index.html:600-615（id/class/文案/title 逐字）；frontend/styles/pages/agent.css
// 的既有选择器按同结构生效。props 契约＝本片冻结件（Plan §5）；S5-9 只填实现/传参，不改语义。
// 纪律：零 fetch、零全局写入、零 localStorage——一切经 props 注入。
// S5-9（切换笔）非冒泡 change 承接：legacy :2055／:2060／:2062 是 select.onchange 直挂元素，
// 系统脚本直写 value 后派发的非冒泡 change 也命中；React onChange 走根代理只收冒泡事件。
// 故三个 select 各加一条只处理 !e.bubbles 的原生监听（ChatPanel.jsx:48-64 同配方，S5-7 214a7d9 先例），
// 两路按 e.bubbles 分流、恰好触发一次，不双发。
import { useEffect, useRef } from "react";

function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

// 非冒泡 change 承接：挂载时绑一次（ref 恒稳），回调经 ref 读最新 props
function useNativeChangeFallback(ref, handler) {
	const fnRef = useRef(handler);
	fnRef.current = handler;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onNativeChange = (e) => {
			if (e.bubbles) return;
			fnRef.current?.(el.value);
		};
		el.addEventListener("change", onNativeChange);
		return () => el.removeEventListener("change", onNativeChange);
	}, [ref]);
}

export default function AgentScopeBar({
	scopeOptions,
	scopeValue,
	onScopeChange,
	conversationOptions,
	conversationValue,
	onConversationChange,
	boundaryOptions,
	boundaryValue,
	boundaryDisabled,
	onBoundaryChange,
	mode,
	onToggleMode,
	statusText,
}) {
	const m = mode || {};
	const scopeSelRef = useRef(null);
	const convSelRef = useRef(null);
	const boundarySelRef = useRef(null);
	useNativeChangeFallback(scopeSelRef, onScopeChange);
	useNativeChangeFallback(convSelRef, onConversationChange);
	useNativeChangeFallback(boundarySelRef, onBoundaryChange);
	return (
		<div className="agent-scope-bar">
			<label className="agent-scope-field">
				<span className="agent-scope-label">范围</span>
				<select
					id="agent-scope-select"
					title="交流范围：全局资源（跨书检索与找书）或某一本书（剧情讨论与执行）"
					ref={scopeSelRef}
					value={scopeValue || ""}
					onChange={(e) => call(onScopeChange, e.target.value)}
				>
					{(scopeOptions || []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			<label className="agent-scope-field">
				<span className="agent-scope-label">会话</span>
				<select
					id="agent-conversation-select"
					title="当前会话（历史按会话隔离；切换范围只选择或新建，不改写原会话归属）"
					ref={convSelRef}
					value={conversationValue || ""}
					onChange={(e) => call(onConversationChange, e.target.value)}
				>
					{(conversationOptions || []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			<label className="agent-scope-field">
				<span className="agent-scope-label">剧情边界</span>
				<select
					id="agent-boundary-select"
					title="资料快照的时序边界：截至某一章或全书（仅书籍范围可用；不选择则不沿用上一轮边界）"
					ref={boundarySelRef}
					disabled={!!boundaryDisabled}
					value={boundaryValue || ""}
					onChange={(e) => call(onBoundaryChange, e.target.value)}
				>
					{(boundaryOptions || []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			<button
				id="btn-agent-mode"
				className={m.execute ? "btn" : "btn btn-ghost"}
				type="button"
				title={m.title}
				disabled={!!m.disabled}
				onClick={() => call(onToggleMode)}
			>
				{m.label}
			</button>
			<span id="agent-scope-status" className="agent-scope-status">
				{statusText}
			</span>
		</div>
	);
}
