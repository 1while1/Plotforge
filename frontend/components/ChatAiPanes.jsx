// 写作助手（样稿 B）的「参谋」「本章上下文」两个标签页，以及续写呈现方式菜单。
// 两个标签页只吃 props（数据与动作来自聊天控制器）；菜单读写本机写作偏好，由 ChatWorkspace 注入。
import { Settings2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useWritingPrefs } from "../hooks/use-writing-prefs.js";
import { fmtK } from "../lib/chat-render.js";
import { CONTINUE_STYLES, setContinueStyle } from "../lib/writing-prefs.js";
import { MessageRow, scrollBottom } from "./ChatMessageList.jsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.jsx";

export function ConsultPane({ records, typing, onClear }) {
	const list = Array.isArray(records) ? records : [];
	const ref = useRef(null);
	const typingOn = typing != null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 记录数或等待态变化即置底（回调内不取值）
	useEffect(() => {
		scrollBottom(ref.current);
	}, [list.length, typingOn]);
	return (
		<>
			<div className="ai-pane-note">
				<span>参谋只给剧情走向、人物行为建议，不写正文。记录只存在本机。</span>
				{list.length ? (
					<button
						type="button"
						className="ai-link-btn"
						onClick={() => onClear?.()}
					>
						清空记录
					</button>
				) : null}
			</div>
			<div className="consult-messages" ref={ref}>
				{list.length || typingOn ? null : (
					<div className="ai-empty">
						<p>还没有参谋记录</p>
						<p>
							在下方输入问题，比如「这一章的冲突够不够」「林栖接下来该怎么选」。
						</p>
					</div>
				)}
				{list.map((r) => (
					<MessageRow key={r.id} m={r} />
				))}
				{typing ?? null}
			</div>
		</>
	);
}

function ContextBody({ data }) {
	const providerParts = Array.isArray(data?.system?.parts)
		? data.system.parts
		: [];
	const extra = Number(data?.system?.additionalTokens) || 0;
	const parts =
		extra > 0
			? [...providerParts, { name: "工具历史、指南等额外注入", tokens: extra }]
			: providerParts;
	const max = parts.reduce((n, p) => Math.max(n, p.tokens || 0), 0) || 1;
	const total = data?.system?.total || 0;
	const budget = data?.system?.budget || 0;
	const hist = data?.history?.chatTokens || 0;
	const tool = data?.history?.toolTokens || 0;
	return (
		<>
			<div className="ctx-summary">
				<div>
					<span className="ctx-summary-val">≈{fmtK(total)}</span>
					<span className="ctx-summary-label">
						设定与前情{budget ? ` / 预算 ${fmtK(budget)}` : ""}
					</span>
				</div>
				<div>
					<span className="ctx-summary-val">≈{fmtK(hist + tool)}</span>
					<span className="ctx-summary-label">对话与工具结果</span>
				</div>
			</div>
			{parts.length ? (
				<ul className="ctx-parts">
					{parts.map((p) => (
						<li key={p.name} className={p.truncated ? "truncated" : ""}>
							<span className="ctx-part-name">
								{p.name}
								{p.truncated ? (
									<span className="ctx-part-tag">被预算截断</span>
								) : null}
							</span>
							<span className="ctx-part-bar" aria-hidden="true">
								<i
									style={{
										width: `${Math.max(3, Math.round(((p.tokens || 0) / max) * 100))}%`,
									}}
								></i>
							</span>
							<span className="ctx-part-val">≈{fmtK(p.tokens || 0)}</span>
						</li>
					))}
				</ul>
			) : (
				<div className="ai-empty">
					<p>本章暂时没有可带上的设定与前情</p>
				</div>
			)}
		</>
	);
}

export function ChapterContextPane({ ctx, onRefresh, onOpenDetail }) {
	const c = ctx || { status: "idle" };
	let body = null;
	if (c.status === "no-chapter") {
		body = (
			<div className="ai-empty">
				<p>先在左侧选一章</p>
				<p>这里会列出 AI 写这一章时带上的设定、大纲与前情。</p>
			</div>
		);
	} else if (c.status === "error") {
		body = (
			<div className="ai-empty">
				<p>加载失败：{c.error}</p>
			</div>
		);
	} else if (c.data) {
		body = <ContextBody data={c.data} />;
	} else {
		body = <div className="ai-empty ai-loading">正在组装本章上下文…</div>;
	}
	return (
		<>
			<div className="ai-pane-note">
				<span>AI 写本章时会带上这些资料（按优先级，超出预算的被截断）。</span>
				<span className="ai-pane-note-ops">
					<button
						type="button"
						className="ai-link-btn"
						disabled={c.status === "loading"}
						onClick={() => onRefresh?.()}
					>
						{c.status === "loading" ? "刷新中…" : "刷新"}
					</button>
					<button
						type="button"
						className="ai-link-btn"
						onClick={() => onOpenDetail?.()}
					>
						完整明细
					</button>
				</span>
			</div>
			<div className="ctx-pane-body">{body}</div>
		</>
	);
}

export function ContinueStyleMenu() {
	const prefs = useWritingPrefs();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="ai-icon-btn"
					aria-label="续写呈现方式"
					title="续写呈现：对话卡片，或在正文末尾出预览块（只存本机）"
				>
					<Settings2 aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>AI 续写呈现</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={prefs.continueStyle}
					onValueChange={(v) => setContinueStyle(v)}
				>
					{CONTINUE_STYLES.map((o) => (
						<DropdownMenuRadioItem key={o.id} value={o.id}>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
