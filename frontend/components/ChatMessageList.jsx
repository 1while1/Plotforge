// S5-5（Plan §1.1 G6）：消息列表渲染族——public/legacy/book-chat.js appendMsg :871-1046 的逐字迁移，
// 另含检索块 :341-365、归档组 :830-853 与插入位置编排 :1600-1609、留痕行挂载点 :1638、置底 :281-284。
// 根元素即 #chat-messages（index.html:155 的静态壳 id 由此承接，ChatPanel 不再套一层容器）。
// 纪律：零 fetch、零 window.* 写入；一切交互经 props 回调（插入正文/快捷回复/还原压缩由 S5-6/S5-7 注入——
// legacy 的「填入 #chat-text 并发送」「直接写 #chapter-content」属接线面）。滚动为容器自身行为
// （等价 legacy appendMsg 末尾 scrollBottom），挂载/消息数变化时置底。
// 未迁面（如实备案）：S4-04b 交接消息 parseHandoffSource/renderHandoffSource（:1037-1041）已由 S5-7 补齐
// （下方 handoffInfo／「查看来源讨论」＋`details.msg-handoff-refs`；DOM 序＝legacy 末位追加）。
import { useEffect, useRef, useState } from "react";
import { handoffRefsText, parseHandoffSource } from "../lib/chat-handoff.js";
import {
	ARCHIVED_PREVIEW_MAX,
	MSG_CLAMP_LEN,
	makeSourceTag,
	parseQuickReplies,
} from "../lib/chat-render.js";
import { looksLikeProse } from "../lib/continue-preview.js";
import { attachBottomFollow, scrollToBottom } from "../lib/scroll-follow.js";
import { ChatActionCard } from "./ChatActionCard.jsx";
import { ChatActionLogRow } from "./ChatActionLogRow.jsx";
import { ChatStepItem } from "./ChatStepItem.jsx";

// 等价 legacy scrollBottom（:281-284）：把 #chat-messages 置底；屏外消息按占位高度参与布局，
// 置底后真实高度还会变，交给 scrollToBottom 逐帧补滚到稳定
export function scrollBottom(el) {
	scrollToBottom(el);
}

function asText(v) {
	return v == null ? "" : String(v);
}

// 语义召回旧文折叠块（≙ renderRetrieval :341-365）
function RetrievalBlock({ hits }) {
	if (!hits?.length) return null;
	return (
		<details className="msg-retrieval">
			<summary>{`参考了 ${hits.length} 段旧文（语义召回）`}</summary>
			<div className="retrieval-body">
				{hits.map((h) => (
					<div className="retrieval-item" key={`${h.chapter || ""}#${h.score}`}>
						<div className="retrieval-head">{`《${h.chapter || ""}》 · 相似度 ${h.score}`}</div>
						<div className="retrieval-text">{asText(h.text)}</div>
					</div>
				))}
			</div>
		</details>
	);
}

// 已归档消息的折叠组（≙ renderArchivedGroup :830-853）
function ArchivedGroup({ archived }) {
	return (
		<details className="msg-archived-group">
			<summary>{`已压缩的 ${archived.length} 条早期对话（点击展开查看）`}</summary>
			<div className="archived-body">
				{archived.map((m) => {
					const c = asText(m.content);
					return (
						<div className="archived-item" key={m.id ?? c}>
							<span className="archived-role">
								{m.role === "user" ? "我" : "AI"}
							</span>
							<span>
								{c.length > ARCHIVED_PREVIEW_MAX
									? `${c.slice(0, ARCHIVED_PREVIEW_MAX)}…`
									: c}
							</span>
						</div>
					);
				})}
			</div>
		</details>
	);
}

// 工具块键：同名同结果重复调用按出现次数兜底（S5-5-X3 ②；不用数组下标以免重渲染漂移）
function toolRows(tools) {
	const seen = new Map();
	return tools.map((tool) => {
		const base = `${tool.name}#${tool.result}`;
		const n = (seen.get(base) || 0) + 1;
		seen.set(base, n);
		return { tool, key: `${base}#${n}` };
	});
}

export function MessageRow({
	m,
	onInsertToChapter,
	onQuickReply,
	onArchiveRestore,
	onHandoffOrigin,
	previewContent,
	onLocatePreview,
}) {
	const role = m.role;
	const content = asText(m.content);
	const reasoning = asText(m.reasoning);
	// 长消息默认折叠，避免对话区被整段正文撑得无限下滑（:928-929）
	const isLong = content.length > MSG_CLAMP_LEN;
	const [clamped, setClamped] = useState(isLong);
	const toggleLabel = clamped ? "展开全文" : "收起";
	const toggleBtn = (
		<button
			type="button"
			className="btn btn-small btn-ghost"
			onClick={() => setClamped((c) => !c)}
		>
			{toggleLabel}
		</button>
	);
	const sourceTag = makeSourceTag(m.source);
	// 主动询问协议：检测【需要确认】，高亮并渲染快捷回复（:917-923/:990-1020）
	const confirmMatch =
		role === "assistant" ? content.match(/【需要确认】([\s\S]*?)$/) : null;
	const quickReplies = confirmMatch ? parseQuickReplies(confirmMatch[1]) : [];
	// S4-04b 交接消息（:1036-1041）：命中即加 msg-handoff 类；来源会话可识别时才给回跳入口
	const handoffInfo = parseHandoffSource(content);
	const rootClass = `msg ${role}${m.compressed === 2 ? " msg-archive" : ""}${confirmMatch ? " msg-confirm" : ""}${handoffInfo ? " msg-handoff" : ""}`;

	let actions = null;
	if (role === "consultant") {
		// 参谋建议：只提供展开/收起，不提供插入正文（:931-945）
		if (isLong) actions = <div className="msg-actions">{toggleBtn}</div>;
	} else if (role === "assistant" && m.compressed !== 2 && !looksLikeProse(m)) {
		// 提问、改稿说明、操作汇报不是正文，不给插入入口
		if (isLong) actions = <div className="msg-actions">{toggleBtn}</div>;
	} else if (role === "assistant") {
		actions = (
			<div className="msg-actions">
				{m.compressed === 2 ? (
					// 压缩存档摘要：提供一键还原，不提供插入正文（:950-958）
					<button
						type="button"
						className="btn btn-small btn-outline"
						onClick={() => {
							if (
								window.confirm("还原全部已压缩的对话？（存档摘要将被移除）")
							) {
								onArchiveRestore?.();
							}
						}}
					>
						还原压缩前的对话
					</button>
				) : (
					<>
						{previewContent && content.trim() === previewContent ? (
							<button
								type="button"
								className="btn btn-small btn-outline msg-locate"
								title="这段续写已在正文末尾预览，确认后才写入"
								onClick={() => onLocatePreview?.()}
							>
								定位到正文
							</button>
						) : null}
						<button
							type="button"
							className="btn btn-small btn-outline"
							onClick={() => onInsertToChapter?.(content)}
						>
							插入到当前章节
						</button>
						{isLong ? toggleBtn : null}
					</>
				)}
			</div>
		);
	} else if (isLong) {
		// 用户消息过长时也提供展开/收起（:1021-1034）
		actions = <div className="msg-actions">{toggleBtn}</div>;
	}

	return (
		<div className={rootClass}>
			<div className="msg-role">
				{role === "user" ? "我" : role === "consultant" ? "参谋" : "写作助手"}
				{sourceTag ? (
					<span className={sourceTag.className}>{sourceTag.textContent}</span>
				) : null}
			</div>
			{role !== "user" && reasoning.trim() ? (
				// 思考过程：默认折叠的浅色区块（:889-900）
				<details className="msg-reasoning">
					<summary>思考过程</summary>
					<div className="reasoning-body">{reasoning.trim()}</div>
				</details>
			) : null}
			{role !== "user" ? <RetrievalBlock hits={m.retrieval} /> : null}
			{role !== "user" && Array.isArray(m.tools) && m.tools.length
				? toolRows(m.tools).map(({ tool, key }) => (
						<ChatStepItem key={key} event={tool} />
					))
				: null}
			<div className={clamped ? "msg-bubble clamped" : "msg-bubble"}>
				{content}
			</div>
			{actions}
			{role === "assistant" && quickReplies.length ? (
				<div className="quick-replies">
					{quickReplies.map((group) => (
						<div
							className="quick-group"
							key={`${group.question}|${group.options.join("/")}`}
						>
							{group.question ? (
								<div className="quick-group-title">{group.question}</div>
							) : null}
							<div className="quick-group-opts">
								{group.options.map((label) => (
									<button
										type="button"
										className="btn btn-small btn-outline"
										key={label}
										onClick={() => onQuickReply?.(label)}
									>
										{label}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
			{Array.isArray(m.actionLogs) && m.actionLogs.length
				? m.actionLogs.map((a) => <ChatActionLogRow key={a.id} action={a} />)
				: null}
			{/* S4-04b 交接来源（:1036-1041 末位追加）：消息内容由服务端模板生成，这里只加回跳入口 */}
			{handoffInfo?.originConversationId ? (
				<>
					<div className="msg-actions">
						<button
							type="button"
							className="btn btn-small btn-outline"
							onClick={() => onHandoffOrigin?.(handoffInfo)}
						>
							查看来源讨论
						</button>
					</div>
					{handoffInfo.refs.length ? (
						<details className="msg-handoff-refs">
							<summary>{`来源与引用（${handoffInfo.refs.length}）`}</summary>
							<pre className="handoff-preview">
								{handoffRefsText(handoffInfo)}
							</pre>
						</details>
					) : null}
				</>
			) : null}
		</div>
	);
}

export function ChatMessageList({
	messages,
	live,
	onInsertToChapter,
	onQuickReply,
	onArchiveRestore,
	onHandoffOrigin,
	pendingActions,
	cardProps,
	rootRef,
	previewContent,
	onLocatePreview,
}) {
	const list = Array.isArray(messages) ? messages : [];
	const wrapRef = useRef(null);
	const count = list.length;
	const firstId = list[0]?.id ?? null;
	useEffect(() => attachBottomFollow(wrapRef.current), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 依存 legacy appendMsg 末尾 scrollBottom（:1044）——消息数变化或换会话（首条 id 变）即置底；依赖只作触发条件
	useEffect(() => {
		scrollBottom(wrapRef.current);
	}, [count, firstId]);
	const archived = list.filter((m) => m && m.compressed === 1);
	const flow = list.filter((m) => m && m.compressed !== 1);
	// key 只作 React 身份、不参与文案/DOM（legacy 逐条 append 无 key 概念）；缺 id 时用序号兜底
	let seq = 0;
	const rows = [];
	flow.forEach((m) => {
		rows.push({ m, key: m.id == null ? `row-${seq++}` : String(m.id) });
	});
	const nodes = [];
	let archivedRendered = false;
	let first = true;
	for (const { m, key } of rows) {
		// 归档组插在第一条压缩存档摘要之前（无存档摘要则插在最前，:1600-1602）
		if (!archivedRendered && archived.length && (m.compressed === 2 || first)) {
			nodes.push(<ArchivedGroup key="archived-group" archived={archived} />);
			archivedRendered = true;
		}
		first = false;
		nodes.push(
			<MessageRow
				key={key}
				m={m}
				onInsertToChapter={onInsertToChapter}
				onQuickReply={onQuickReply}
				onArchiveRestore={onArchiveRestore}
				onHandoffOrigin={onHandoffOrigin}
				previewContent={previewContent}
				onLocatePreview={onLocatePreview}
			/>,
		);
	}
	if (!archivedRendered && archived.length)
		nodes.push(<ArchivedGroup key="archived-group" archived={archived} />);

	return (
		<div
			id="chat-messages"
			className="chat-messages"
			ref={(el) => {
				wrapRef.current = el;
				if (rootRef) rootRef.current = el;
			}}
		>
			{nodes}
			{(Array.isArray(pendingActions) ? pendingActions : []).map((a) => (
				<ChatActionCard key={a.id} action={a} {...(cardProps || {})} />
			))}
			{/* S5-6 实时槽（S5-6-X1 ③）：流中气泡/参谋等待节点，恒在容器尾部（≙ appendMsg 末尾追加） */}
			{live ?? null}
		</div>
	);
}
