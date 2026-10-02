// S5-8（Plan §1.1 G5）：Agent 台左侧「会话 / 资源」双 tab 面板 props 驱动叶组件
// （≙ legacy :203-233 会话列表／:283-395 资源视图）。DOM 契约唯一事实源＝frontend/index.html:618-642。
// props 契约＝本片冻结件（Plan §5）；conversations 项另带 scope（'book'|'global'，≙ legacy :226 的
// 「书籍 / 全局」meta，Plan §5 括注外的最小扩展，已在自检登记）。S5-9 只填实现/传参，不改语义。
// 纪律：零 fetch、零全局写入；空态文案由 props.emptyHint（会话）与 lib RES_EMPTY_HINT（资源）供给。
// S5-9（切换笔）非冒泡 change 承接：#agent-res-type 在 legacy :2073 是直挂元素监听，系统脚本直写
// value 后派发的非冒泡 change 也要命中（ChatPanel.jsx:48-64 同配方；两路按 e.bubbles 分流恰一次）。
import { useEffect, useRef } from "react";
import { RES_EMPTY_HINT } from "../lib/agent-resources.js";

function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

export default function AgentSidePanel({
	tab,
	onTabChange,
	conversations,
	onSelectConversation,
	emptyHint,
	tools,
	resources,
}) {
	const r = resources || {};
	const convOn = tab === "conversations";
	const conversationsList = conversations || [];
	const typeSelRef = useRef(null);
	const onTypeChangeRef = useRef(r.onTypeChange);
	onTypeChangeRef.current = r.onTypeChange;
	useEffect(() => {
		const el = typeSelRef.current;
		if (!el) return;
		const onNativeChange = (e) => {
			if (e.bubbles) return;
			onTypeChangeRef.current?.(el.value);
		};
		el.addEventListener("change", onNativeChange);
		return () => el.removeEventListener("change", onNativeChange);
	}, []);
	return (
		<aside className="agent-tools-panel">
			<div className="tabs agent-side-tabs">
				<button
					id="btn-agent-tab-conversations"
					className={convOn ? "tab active" : "tab"}
					type="button"
					data-agent-tab="conversations"
					onClick={() => call(onTabChange, "conversations")}
				>
					会话
				</button>
				<button
					id="btn-agent-tab-resources"
					className={convOn ? "tab" : "tab active"}
					type="button"
					data-agent-tab="resources"
					onClick={() => call(onTabChange, "resources")}
				>
					资源
				</button>
			</div>
			<div
				id="agent-pane-conversations"
				className={convOn ? "tab-pane" : "tab-pane hidden"}
			>
				<div className="pane-head">
					<span className="pane-title">本范围会话</span>
				</div>
				<ul
					id="agent-conversation-list"
					className="item-list agent-conversation-list"
				>
					{conversationsList.length ? (
						conversationsList.map((c) => (
							// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :229 的 li.onclick 纯鼠标交互，不加键盘语义
							<li
								key={c.id}
								className={
									c.active
										? "item-row agent-conversation-item active"
										: "item-row agent-conversation-item"
								}
								data-conversation-id={c.id}
								onClick={() => call(onSelectConversation, c.id)}
							>
								<span className="agent-conv-title">
									{c.title}
									{c.archived ? "（已归档）" : ""}
								</span>
								<span className="agent-conv-meta">
									{c.scope === "book" ? "书籍" : "全局"}
								</span>
							</li>
						))
					) : (
						<li className="agent-tools-hint">{emptyHint}</li>
					)}
				</ul>
				<div className="pane-head" style={{ marginTop: 14 }}>
					<span className="pane-title">助手能力</span>
				</div>
				<p className="agent-tools-hint">助手会按需自动调用以下工具</p>
				<ul id="agent-tool-list" className="agent-tool-list">
					{(tools || []).map((t) => (
						<li key={t.name} className="agent-tool-item">
							<span className="agent-tool-name">{t.name}</span>
							<span className="agent-tool-desc">{t.description}</span>
						</li>
					))}
				</ul>
			</div>
			<div
				id="agent-pane-resources"
				className={convOn ? "tab-pane hidden" : "tab-pane"}
			>
				<div className="pane-head">
					<span className="pane-title">资源</span>
					<span className="pane-head-btns">
						<select
							id="agent-res-type"
							className="agent-res-type"
							title="资源类型（与助手只读工具的同一份受控目录）"
							ref={typeSelRef}
							value={r.typeValue || ""}
							onChange={(e) => call(r.onTypeChange, e.target.value)}
						>
							{(r.typeOptions || []).map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
						<button
							id="btn-agent-res-refresh"
							className="btn btn-ghost btn-small"
							type="button"
							title="重新读取当前类型的资源列表"
							onClick={() => call(r.onRefresh)}
						>
							刷新
						</button>
					</span>
				</div>
				<p id="agent-res-hint" className="agent-tools-hint">
					{r.hint}
				</p>
				<ul id="agent-res-list" className="item-list agent-res-list">
					{(r.items || []).length ? (
						(r.items || []).map((it) => (
							// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :389 的 li.onclick 纯鼠标交互，不加键盘语义
							<li
								key={`${it.type}:${it.id}`}
								className="item-row agent-res-item"
								data-resource-type={it.type}
								data-resource-id={String(it.id)}
								onClick={() => call(r.onOpen, it)}
							>
								<span className="agent-res-title">{it.title}</span>
								<span className="agent-res-meta">{it.metaText}</span>
							</li>
						))
					) : (
						<li className="agent-tools-hint">{RES_EMPTY_HINT}</li>
					)}
				</ul>
				<button
					id="btn-agent-res-more"
					className={
						r.hasMore
							? "btn btn-ghost btn-small"
							: "btn btn-ghost btn-small hidden"
					}
					type="button"
					onClick={() => call(r.onMore)}
				>
					加载更多
				</button>
			</div>
		</aside>
	);
}
