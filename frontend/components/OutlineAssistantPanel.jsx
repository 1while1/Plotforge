// S4-7（charter §3，范式 A·判定 C 旧名桥组合件）：OutlineAssistantPanel——大纲小助手
// （像素胶囊＋页内对话面板）迁 React，由 OutlineWorkbenchPanel 组合渲染（挂载容器＝
// .outline-workspace，等值旧 OutlineAssistant.mount(bookId, workspace) 的 anchor）。
// 逐字等值移植 public/legacy/outline-assistant.js（254 行）活代码：
// - 通道复用 Agent 只读讨论（kind=agent、scope=book，不传 mode/book_id → discuss 只读工具，
//   与写作流并行安全，:159-160 注释逐字）；SSE 统一走 `lib/chat-event-hub.js` 的
//   `consumeAgentStream` 具名导出（P6-2 §2.5-D5 去全局化：原 window.ChatEventHub 旧名面退役），
//   不自写解析（AGENTS.md §4 铁律）。
// - 会话懒创建（:96-114）：首次打开 loadHistory 时 GET /api/conversations?kind=agent&bookId=
//   找标题前缀「大纲小助手」且 status !== 'archived' 的最新一条；无则**首次发送时**才
//   POST /api/conversations {kind:'agent', scope:'book', bookId, title:'大纲小助手 · 工作台内讨论'}。
// - 历史（:116-140）：GET /api/conversations/:id/messages?limit=60；只显示 role user/assistant
//   且文本非空；首屏无会话 → note「我是这本书的大纲小助手。我能看到总纲、卷纲、章节拍点和
//   台账节奏——写大纲卡住了就问我。」；有会话但零消息 → 「历史会话还在，但没有可显示的消息。
//   直接问我吧。」；列表失败按新会话处理（静默）；messages 失败 → note「历史加载失败：<msg>」。
// - 发送（:142-196）：sending 防重；按钮文案「停止」；POST /api/agent/chat body 恰
//   {conversation_id, content, request_id: ChatEventHub.newRequestId('oa')}＋signal；
//   isJsonResponse 时 duplicate →「（这条问题正在另一窗口回答中，请到那边查看）」，否则抛错；
//   consumeAgentStream：onDelta 累积、onToolCall → note「查阅了 <toolName||'资料''>」、
//   onDone 有 text 则整体替换、onError →「出错了：<msg>」；aborted → 正文＋「\n（已停止）」或
//   「（已停止）」；空答且无 toolErrors 无 hadError →「（小助手没有给出文字回答，换个问法试试）」；
//   toolErrors 逐条 note「工具被拒：<message||code||toolName||'未知'>」；catch →「出错了：<msg>」；
//   finally 复原按钮＋滚底。
// - 开关（:198-230）：胶囊点击 toggle .hidden，首次打开 loadHistory；关闭钮收起；芯片点击填
//   input＋focus；提交时 sending 为真 → abort.stop('user') 返回；空文本不发。
// - unmount（:243-253）：abort.stop('unmount')；state 全清。React effect cleanup 同语义
//   （#oa-root 由 React 树卸载天然移除；守卫不注销属父组件职责）。

import { useEffect, useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";
import {
	consumeAgentStream,
	createAbort,
	isJsonResponse,
	newRequestId,
} from "../lib/chat-event-hub.js";

// 16×16 像素小人（戴帽书生）：字符画 → SVG rect，crispEdges 保持像素棱角（:20-51 逐字）
const PIXEL_ROWS = [
	"................",
	".....######.....",
	"....########....",
	"..############..",
	"....ffffffff....",
	"....fefffeff....",
	"....ffffffff....",
	".....ffffff.....",
	"..rrrrrrrrrrrr..",
	".rrrrrrrrrrrrrr.",
	".rrrssssssssrrr.",
	".rrrssssssssrrr.",
	".rrrrrrrrrrrrrr.",
	".rrrrrrrrrrrrrr.",
	"....rr....rr....",
	"................",
];
const PIXEL_COLORS = {
	"#": "#2b2620",
	f: "#ecd9b0",
	e: "#2b2620",
	r: "#a63a2b",
	s: "#e3d3a8",
};

function pixelSVG() {
	const rects = [];
	for (let y = 0; y < PIXEL_ROWS.length; y++) {
		const row = PIXEL_ROWS[y];
		for (let x = 0; x < row.length; x++) {
			const c = PIXEL_COLORS[row[x]];
			if (c)
				rects.push(
					<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c} />,
				);
		}
	}
	return (
		<svg viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
			{rects}
		</svg>
	);
}

const CHIPS = [
	{
		label: "节奏体检",
		question: "这卷的节奏怎么样？有没有连续平淡或高潮过密的地方？",
	},
	{
		label: "拍点断层",
		question: "帮我看看章节拍点之间有没有断层，哪里需要补衔接章？",
	},
	{
		label: "下一章方向",
		question: "按现在的总纲和卷纲，下一章可以往哪个方向写？给我两个可选方案。",
	},
];

export default function OutlineAssistantPanel({ bookId }) {
	// 旧 state（:9-16）逐字移植为 ref＋bump；消息列表为 React state（旧 addMsg DOM 追加）
	const [, bump] = useState(0);
	const st = useRef(null);
	if (!st.current) {
		st.current = {
			conversationId: null,
			sending: false,
			abort: null,
			opened: false,
			historyLoaded: false,
		};
	}
	const state = st.current;
	const [messages, setMessages] = useState([]);
	const [inputValue, setInputValue] = useState("");
	const messagesBoxRef = useRef(null);

	// unmount（:243-253）：abort.stop('unmount')；state 全清由卸载天然完成
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅卸载时停流，state 为稳定 ref
	useEffect(() => {
		return () => {
			if (state.abort) state.abort.stop("unmount");
			state.abort = null;
			state.sending = false;
			state.opened = false;
			state.historyLoaded = false;
			state.conversationId = null;
		};
	}, []);

	function api(method, path, body) {
		return getApp().api(method, path, body);
	}

	function addMsg(role, text) {
		setMessages((m) => [...m, { kind: "msg", role, text }]);
	}
	function addNote(text) {
		setMessages((m) => [...m, { kind: "note", text }]);
	}
	// 滚底（:80/:91/:193-194 逐字）
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages 变化即滚底，box 为 ref 读取、不构成依赖标识
	useEffect(() => {
		const box = messagesBoxRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [messages]);

	// 复用同书的小助手会话：找标题前缀「大纲小助手」的最新一条；没有就在首次发送时创建
	// （:95-114 逐字）
	async function findConversation() {
		const list = await api(
			"GET",
			`/api/conversations?kind=agent&bookId=${encodeURIComponent(bookId)}`,
		);
		const items = Array.isArray(list) ? list : [];
		for (let i = 0; i < items.length; i++) {
			if (
				(items[i].title || "").indexOf("大纲小助手") === 0 &&
				items[i].status !== "archived"
			)
				return items[i];
		}
		return null;
	}

	async function ensureConversation() {
		if (state.conversationId) return state.conversationId;
		const existing = await findConversation();
		if (existing) {
			state.conversationId = existing.id;
			return existing.id;
		}
		const conv = await api("POST", "/api/conversations", {
			kind: "agent",
			scope: "book",
			bookId,
			title: "大纲小助手 · 工作台内讨论",
		});
		state.conversationId = conv.id;
		return conv.id;
	}

	async function loadHistory() {
		if (state.historyLoaded) return;
		state.historyLoaded = true;
		let conv = null;
		try {
			conv = await findConversation();
		} catch {
			/* 列表失败按新会话处理（:120 逐字） */
		}
		if (!conv) {
			addNote(
				"我是这本书的大纲小助手。我能看到总纲、卷纲、章节拍点和台账节奏——写大纲卡住了就问我。",
			);
			return;
		}
		state.conversationId = conv.id;
		let data;
		try {
			data = await api(
				"GET",
				`/api/conversations/${conv.id}/messages?limit=60`,
			);
		} catch (e) {
			addNote(`历史加载失败：${e.message}`);
			return;
		}
		const msgs = data?.messages || [];
		let shown = 0;
		msgs.forEach((m) => {
			if (m.role === "user" || m.role === "assistant") {
				const text = typeof m.content === "string" ? m.content : "";
				if (text.trim()) {
					addMsg(m.role === "user" ? "user" : "assistant", text);
					shown++;
				}
			}
		});
		if (!shown) addNote("历史会话还在，但没有可显示的消息。直接问我吧。");
	}

	async function send(text) {
		if (state.sending) return;
		state.sending = true;
		setInputValue("");
		addMsg("user", text);
		// assistant 占位消息（:150）：流式到达时同条更新
		const replyId = `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		setMessages((m) => [
			...m,
			{ kind: "msg", role: "assistant", id: replyId, text: "…" },
		]);
		let acc = "";
		const abort = createAbort();
		state.abort = abort;
		bump((x) => x + 1);
		try {
			const convId = await ensureConversation();
			const resp = await fetch("/api/agent/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// discuss 模式：不传 mode/book_id → 只读工具，不拿写锁，与写作流并行安全（:159-160 逐字）
				body: JSON.stringify({
					conversation_id: convId,
					content: text,
					request_id: newRequestId("oa"),
				}),
				signal: abort.signal,
			});
			if (resp.ok && isJsonResponse(resp)) {
				let dup = null;
				try {
					dup = await resp.json();
				} catch {
					/* 落入通用错误（:165 逐字） */
				}
				if (dup?.duplicate) {
					setMessages((m) =>
						m.map((x) =>
							x.id === replyId
								? {
										...x,
										text: "（这条问题正在另一窗口回答中，请到那边查看）",
									}
								: x,
						),
					);
					return;
				}
				throw new Error(
					(dup?.error && (dup.error.message || dup.error.code)) ||
						`请求失败 ${resp.status}`,
				);
			}
			if (!resp.ok) {
				let errData = null;
				try {
					errData = await resp.json();
				} catch {
					/* ignore（:174 逐字） */
				}
				throw new Error(
					(errData?.error &&
						errData.error &&
						(errData.error.message || errData.error.code)) ||
						`请求失败 ${resp.status}`,
				);
			}
			let hadError = false;
			const result = await consumeAgentStream(resp, {
				onDelta(t) {
					acc += t;
					setMessages((m) =>
						m.map((x) => (x.id === replyId ? { ...x, text: acc } : x)),
					);
				},
				onToolCall(t) {
					addNote(`查阅了 ${t.toolName || "资料"}`);
				},
				onDone(ev) {
					if (ev?.text) {
						acc = ev.text;
						setMessages((m) =>
							m.map((x) => (x.id === replyId ? { ...x, text: acc } : x)),
						);
					}
				},
				onError(info) {
					hadError = true;
					setMessages((m) =>
						m.map((x) =>
							x.id === replyId ? { ...x, text: `出错了：${info.message}` } : x,
						),
					);
				},
			});
			if (result.aborted)
				setMessages((m) =>
					m.map((x) =>
						x.id === replyId
							? { ...x, text: acc ? `${acc}\n（已停止）` : "（已停止）" }
							: x,
					),
				);
			else if (!acc.trim() && !result.toolErrors.length && !hadError)
				setMessages((m) =>
					m.map((x) =>
						x.id === replyId
							? { ...x, text: "（小助手没有给出文字回答，换个问法试试）" }
							: x,
					),
				);
			result.toolErrors.forEach((te) => {
				addNote(`工具被拒：${te.message || te.code || te.toolName || "未知"}`);
			});
		} catch (e) {
			setMessages((m) =>
				m.map((x) =>
					x.id === replyId ? { ...x, text: `出错了：${e.message}` } : x,
				),
			);
		} finally {
			state.sending = false;
			state.abort = null;
			bump((x) => x + 1);
		}
	}

	function onCapsuleClick() {
		state.opened = !state.opened;
		if (state.opened) loadHistory();
		bump((x) => x + 1);
	}

	function onCloseClick() {
		state.opened = false;
		bump((x) => x + 1);
	}

	function onChipClick(question) {
		setInputValue(question);
		const input = document.getElementById("oa-input");
		if (input) input.focus();
	}

	function onSubmit(e) {
		e.preventDefault();
		if (state.sending) {
			// 发送中再提交＝停止（:221-224 逐字）
			if (state.abort) state.abort.stop("user");
			return;
		}
		const text = inputValue.trim();
		if (!text) return;
		send(text);
	}

	return (
		<div id="oa-root">
			<button
				id="oa-capsule"
				className="oa-capsule"
				type="button"
				title="大纲小助手：问我节奏、断层、下一章怎么接"
				onClick={onCapsuleClick}
			>
				{pixelSVG()}
				<span className="oa-capsule-label">小助手</span>
			</button>
			<section
				id="oa-panel"
				className={`oa-panel${state.opened ? "" : " hidden"}`}
				aria-label="大纲小助手对话面板"
			>
				<header className="oa-panel-head">
					<span className="oa-panel-title">大纲小助手</span>
					<span className="oa-panel-tag">只读讨论 · 看得到总纲/卷纲/拍点</span>
					<button
						id="oa-close"
						className="oa-close"
						type="button"
						title="收起"
						onClick={onCloseClick}
					>
						×
					</button>
				</header>
				<div id="oa-messages" className="oa-messages" ref={messagesBoxRef}>
					{messages.map((m) =>
						m.kind === "note" ? (
							<div className="oa-note" key={m.id || m.text}>
								{m.text}
							</div>
						) : (
							<div className={`oa-msg oa-${m.role}`} key={m.id || m.text}>
								{m.text}
							</div>
						),
					)}
				</div>
				<div className="oa-chips">
					{CHIPS.map((chip) => (
						<button
							key={chip.label}
							type="button"
							data-oa-chip={chip.question}
							onClick={() => onChipClick(chip.question)}
						>
							{chip.label}
						</button>
					))}
				</div>
				<form id="oa-form" className="oa-form" onSubmit={onSubmit}>
					<textarea
						id="oa-input"
						rows={2}
						placeholder="问小助手：写大纲卡住了就说话…"
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
					/>
					<button
						id="oa-send"
						className="btn btn-primary btn-small"
						type="submit"
					>
						{state.sending ? "停止" : "发送"}
					</button>
				</form>
			</section>
		</div>
	);
}
