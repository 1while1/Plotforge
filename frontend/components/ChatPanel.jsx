// S5-5（Plan §1.1 G7）：聊天页骨架。DOM 契约唯一事实源＝frontend/index.html:136-168（id/class/文案逐字）；
// 槽位锚点＝legacy :1438-1451（横幅宿主与 #chat-messages 平级、插在 #chat-form 之前），
// ctx 仪表锚点＝:672-705（文案/占比/ctx-warn 阈值 70），composer 三态锚点＝
// bindChatEvents :1855-1857（WRITE/CONSULT placeholder）＋:1866-1878（consult-pill.mode-on／form.consult-on）。
// S5-7 接线改造（Plan §1.1 G7／§5 纪律 2/3/8）：`bare` 原位接管形态（默认仍渲染完整 `<section>`）、
// `#writing-run-card` 叶容器（内容只由 window.RunStatus.mountTaskCard 命令式写）、Ctrl+Enter（:1904-1909）、
// 发送三态（:1056/:1061/:1078/:1083/:1088）、live 槽透传（S5-6 实时气泡）、
// `.chat-scroll-wrap` 由 React 树内渲染（sub见 ChatJumpBottom.jsx 头注纪律）＋portal 落 wrap 的 JumpButton。
// 纪律：只有 props——零网络、零全局写入、零 localStorage；一切副作用经 props 回调（S5-6 填传输、
// S5-7 填接线）。
// UI 优化阶段 2c（样稿 B）：头部改为「对话／参谋／本章上下文」三标签＋图标按钮，会话选择与上下文
// 仪表下移到对话标签内；原有 id／文案（含 .pane-title 读屏标题）保持不变。
import { Eraser, MessagesSquare, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ctxMeterPercent, ctxMeterText } from "../lib/chat-render.js";
import { JumpButton } from "./ChatJumpBottom.jsx";
import { ChatMessageList } from "./ChatMessageList.jsx";

const WRITE_PLACEHOLDER = "和 AI 聊聊剧情，或让它续写正文…（Ctrl+Enter 发送）";
const CONSULT_PLACEHOLDER = "向参谋提问：剧情走向、人物行为、大纲建议…";

export const AI_TABS = [
	{ id: "chat", label: "对话", title: "写作对话：续写、改写、查设定" },
	{
		id: "consult",
		label: "参谋",
		title: "参谋：只出剧情走向/人物行为建议，不写正文（记录只存本机）",
	},
	{
		id: "context",
		label: "本章上下文",
		title: "AI 写本章时会带上的设定、大纲与前情",
	},
];

export function ChatPanel(props) {
	const {
		bare,
		conversations,
		currentConversationId,
		onConversationChange,
		onNewConversation,
		meter,
		banners,
		messages,
		listProps,
		composer,
		messagesRef,
		onOpenCtxDetail,
		onCompress,
		onClear,
		onOpenAgentDiscuss,
		tab: tabProp,
		onTabChange,
		consultPane,
		contextPane,
		headExtra,
	} = props;
	// 受控优先；未传 tab 时组件自己记（单测与旧调用方不需要关心标签）
	const [ownTab, setOwnTab] = useState("chat");
	const tab = tabProp || ownTab;
	const selectTab = (id) => {
		if (!tabProp) setOwnTab(id);
		onTabChange?.(id);
	};
	const convs = Array.isArray(conversations) ? conversations : [];
	const c = composer || {};
	const l = listProps || {};
	const pct = ctxMeterPercent(meter);
	// wrap 内的 #chat-messages 由 ChatMessageList 渲染；拿到节点后 JumpButton 经 portal 落 wrap 末尾
	// （DOM 序＝#chat-messages 之后，等值旧 chat-jump-bottom.js 的 wrap.appendChild(btn)）
	const [msgsEl, setMsgsEl] = useState(null);
	useLayoutEffect(() => {
		setMsgsEl(messagesRef?.current || null);
	}, [messagesRef]);

	const convSelRef = useRef(null);
	const onConversationChangeRef = useRef(onConversationChange);
	onConversationChangeRef.current = onConversationChange;
	// legacy :28-30 的 `select.onchange = …` 是**直挂元素**的监听：任何 change（含脚本直写 value
	// 后派发的非冒泡事件）都命中。React 的 onChange 走根代理，只收冒泡事件——真实用户选择是冒泡的
	// （change 规范 bubbles=true），故两条路按 e.bubbles 分流、恰好触发一次；非冒泡口径（系统脚本/
	// 巡检驱动）由此 listener 承接。
	useEffect(() => {
		const el = convSelRef.current;
		if (!el) return;
		const onNativeChange = (e) => {
			if (e.bubbles) return;
			onConversationChangeRef.current?.(el.value);
		};
		el.addEventListener("change", onNativeChange);
		return () => el.removeEventListener("change", onNativeChange);
	}, []);
	const inner = (
		<>
			<div className="chat-head ai-head">
				<h2 className="pane-title mz-sr-only">写作助手</h2>
				<div className="ai-tabs" role="tablist" aria-label="写作助手">
					{AI_TABS.map((t) => (
						<button
							key={t.id}
							type="button"
							role="tab"
							className={tab === t.id ? "ai-tab on" : "ai-tab"}
							aria-selected={tab === t.id}
							title={t.title}
							onClick={() => selectTab(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
				<span className="pane-head-btns ai-head-btns">
					{headExtra ?? null}
					<button
						type="button"
						id="btn-new-writing-conv"
						className="ai-icon-btn"
						title="开始一个新的写作会话（原会话历史保留）"
						onClick={() => onNewConversation?.()}
					>
						<Plus aria-hidden="true" />
						<span className="mz-sr-only">新会话</span>
					</button>
					<button
						type="button"
						id="btn-open-agent-discuss"
						className="ai-icon-btn"
						title="到 AI 助手为本书新开一个整体讨论专题：只带这本书与当前章（可选人物），默认不带写作对话历史；从助手返回后还原同一会话同一章"
						onClick={() => onOpenAgentDiscuss?.()}
					>
						<MessagesSquare aria-hidden="true" />
						<span className="mz-sr-only">另开整体讨论</span>
					</button>
					<button
						type="button"
						id="btn-clear-chat"
						className="ai-icon-btn"
						title="清空当前会话的对话记录"
						onClick={() => onClear?.()}
					>
						<Eraser aria-hidden="true" />
						<span className="mz-sr-only">清空</span>
					</button>
				</span>
			</div>
			<div
				className="ai-pane ai-pane-chat"
				role="tabpanel"
				hidden={tab !== "chat"}
			>
				<div className="ai-sess">
					<select
						id="writing-conversation-select"
						title="切换写作会话（历史按任务隔离；默认为本书历史对话）"
						ref={convSelRef}
						value={currentConversationId ?? ""}
						onChange={(e) => onConversationChange?.(e.target.value)}
					>
						<option value="">（默认：历史对话）</option>
						{convs.map((conv) => (
							<option key={conv.id} value={conv.id}>
								{(conv.title || "未命名会话") +
									(conv.status === "archived" ? "（已归档）" : "")}
							</option>
						))}
					</select>
					<div
						className="ctx-meter"
						id="ctx-meter"
						title="上下文窗口占用（真实值来自最近一次对话的 usage；未对话时为估算）"
					>
						<div className="ctx-bar">
							<div
								className={pct > 70 ? "ctx-fill ctx-warn" : "ctx-fill"}
								id="ctx-fill"
								style={{ width: `${pct}%` }}
							/>
						</div>
						<span
							className="ctx-text"
							id="ctx-text"
							title={ctxMeterText(meter)}
						>
							{ctxMeterText(meter)}
						</span>
						<button
							type="button"
							id="btn-ctx-detail"
							className="btn btn-ghost btn-small"
							title="查看上下文详细组成（系统提示各节/对话历史/工具结果/输出预留 占比）"
							onClick={() => onOpenCtxDetail?.()}
						>
							明细
						</button>
						<button
							type="button"
							id="btn-compress"
							className="btn btn-ghost btn-small"
							title="把较早的对话压缩成存档摘要，释放上下文空间"
							onClick={() => onCompress?.()}
						>
							压缩
						</button>
					</div>
				</div>
				{/* 叶容器（Plan §5 纪律 2）：React 只渲染空 div、class 固定 run-card hidden；
				    内容与显隐一律由 window.RunStatus.mountTaskCard(host, model) 命令式写入 */}
				<div id="writing-run-card" className="run-card hidden" role="status" />
				{/* 切标签只隐藏不卸载：流中的实时气泡挂在这里，卸载会丢掉正在写入的句柄 */}
				<div className="chat-scroll-wrap">
					<ChatMessageList
						messages={messages}
						live={l.live}
						onInsertToChapter={l.onInsertToChapter}
						onQuickReply={l.onQuickReply}
						onArchiveRestore={l.onArchiveRestore}
						onHandoffOrigin={l.onHandoffOrigin}
						pendingActions={l.pendingActions}
						cardProps={l.cardProps}
						rootRef={messagesRef}
						previewContent={l.previewContent}
						onLocatePreview={l.onLocatePreview}
					/>
					{msgsEl ? <JumpButton messages={msgsEl} /> : null}
				</div>
			</div>
			<div
				className="ai-pane ai-pane-consult"
				role="tabpanel"
				hidden={tab !== "consult"}
			>
				{consultPane ?? null}
			</div>
			<div
				className="ai-pane ai-pane-context"
				role="tabpanel"
				hidden={tab !== "context"}
			>
				{contextPane ?? null}
			</div>
			{/* 横幅槽与 #chat-messages 平级、插在 #chat-form 之前（legacy bannerHost :1443-1449 的 insertBefore(form)） */}
			{banners ? (
				<div id="chat-banners" className="chat-banners">
					{banners}
				</div>
			) : null}
			<form
				id="chat-form"
				className={`chat-input chat-composer${c.consult ? " consult-on" : ""}`}
				onSubmit={(e) => {
					e.preventDefault();
					c.onSend?.();
				}}
			>
				<div className="composer-card">
					<textarea
						id="chat-text"
						rows={3}
						placeholder={c.consult ? CONSULT_PLACEHOLDER : WRITE_PLACEHOLDER}
						value={c.value ?? ""}
						onChange={(e) => c.onChange?.(e.target.value)}
						// 外部写值链（脚本写 .value 后派发 input）必须能同步状态：
						// React 的 onChange 走 ChangeEventPlugin 的「值变化」判定（实例 setter 写值会被视为未变），
						// onInput 直收 input 事件 ⇒ 命令式写值＋input 与真实键入同样生效（计划 §5 纪律 5）
						onInput={(e) => c.onChange?.(e.target.value)}
						onKeyDown={(e) => {
							// :1904-1909 Ctrl+Enter 与提交同一条发送路
							if (e.ctrlKey && e.key === "Enter") {
								e.preventDefault();
								c.onSend?.();
							}
						}}
					/>
					<div className="composer-foot">
						<button
							type="button"
							id="btn-consult"
							className={c.consult ? "consult-pill mode-on" : "consult-pill"}
							title="参谋模式：只出剧情走向/人物行为建议，不写正文"
							onClick={() => c.onToggleConsult?.()}
						>
							参谋
						</button>
						{c.focus ? (
							<button
								type="button"
								className={
									c.focusChatOpen ? "focus-chat-toggle on" : "focus-chat-toggle"
								}
								aria-expanded={!!c.focusChatOpen}
								title="展开或收起 AI 回复（Esc 收起）"
								onClick={() => c.onToggleFocusChat?.()}
							>
								{c.focusChatOpen
									? "收起回复"
									: c.streaming
										? "AI 回复中…"
										: "查看回复"}
							</button>
						) : null}
						<span className="composer-ops">
							<button
								type="button"
								id="btn-chat-stop"
								className={
									c.streaming
										? "btn btn-small btn-stop"
										: "btn btn-small btn-stop hidden"
								}
								title="中止当前生成（已生成的部分会保留）"
								onClick={() => c.onStop?.()}
							>
								停止
							</button>
							<button
								type="submit"
								id="btn-send"
								className="btn btn-primary"
								disabled={!!c.disabled}
							>
								{c.sendLabel || "发送"}
							</button>
						</span>
					</div>
				</div>
			</form>
		</>
	);
	// 原位接管形态：root 建在 .panel-chat 上，内容直接落该元素（不新增 wrapper）
	return bare ? inner : <section className="panel panel-chat">{inner}</section>;
}
