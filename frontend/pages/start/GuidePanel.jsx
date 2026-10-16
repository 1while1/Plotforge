// 砚灵对话面板：走 POST /api/start/guide/stream（服务端单飞闸门，忙时 409 CHAT_BUSY），
// SSE 统一经 chat-event-hub 的 consumeBookStream 消费。对话只活在本页内存，不落库。
import { useEffect, useRef, useState } from "react";
import {
	consumeBookStream,
	createAbort,
	parseResponseError,
} from "../../lib/chat-event-hub.js";

const GREETING =
	"我是砚灵，住在这方砚台上。点一座岛，我飞过去给你讲讲它；也可以直接问我今天从哪本书接着写。";

const QUICK = [
	"今天从哪本接着写？",
	"这些岛分别代表什么？",
	"哪本书最久没动了？",
];

const STATUS_TEXT = {
	idle: "在听",
	thinking: "想一想…",
	talking: "说着呢",
};

function errorText(err) {
	if (!err) return "砚灵没有回应，请稍后再试。";
	if (err.code === "CHAT_BUSY") return "砚灵还在回答上一句，等它说完再问。";
	if (err.code === "LLM_NOT_CONFIGURED")
		return "还没有配置模型。到设置页填写接口地址和模型后，砚灵就能开口了。";
	return `砚灵没接上话：${err.message || "未知错误"}`;
}

export function GuidePanel({
	focusBookId,
	focusTitle,
	onStateChange,
	inputRef,
}) {
	const [messages, setMessages] = useState([]);
	const [draft, setDraft] = useState("");
	const [state, setState] = useState("idle");
	const [notice, setNotice] = useState(null);
	const abortRef = useRef(null);
	const listRef = useRef(null);

	useEffect(() => {
		onStateChange?.(state);
	}, [state, onStateChange]);

	useEffect(() => () => abortRef.current?.stop("leave"), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 新消息或增量到达时滚到底
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const busy = state !== "idle";

	async function send(text) {
		const content = String(text || "").trim();
		if (!content || busy) return;
		setNotice(null);
		const history = [...messages, { role: "user", content }];
		setMessages([
			...history,
			{ role: "assistant", content: "", pending: true },
		]);
		setDraft("");
		setState("thinking");
		const ctl = createAbort();
		abortRef.current = ctl;
		const patchLast = (fn) =>
			setMessages((list) => {
				const next = list.slice();
				const i = next.length - 1;
				if (i >= 0 && next[i].role === "assistant") next[i] = fn(next[i]);
				return next;
			});
		let failure = null;
		let gotText = false;
		try {
			const res = await fetch("/api/start/guide/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: history.map((m) => ({ role: m.role, content: m.content })),
					focusBookId: focusBookId ?? undefined,
				}),
				signal: ctl.signal,
			});
			if (!res.ok) throw await parseResponseError(res, "砚灵没有回应");
			const final = await consumeBookStream(res, {
				onDelta: (t) => {
					if (t) gotText = true;
					setState("talking");
					patchLast((m) => ({ ...m, content: m.content + t }));
				},
				onError: (info) => {
					failure = info;
				},
			});
			const full = final.finalContent ?? final.content;
			patchLast((m) => ({
				...m,
				content: full,
				pending: false,
				stopped: final.aborted,
			}));
		} catch (e) {
			if (ctl.stopped()) {
				patchLast((m) => ({ ...m, pending: false, stopped: true }));
			} else {
				failure = e;
			}
		} finally {
			abortRef.current = null;
			setState("idle");
		}
		if (failure) {
			setNotice(errorText(failure));
			// 没说出一个字就失败：撤掉这一问一答，把问题放回输入框方便重发
			if (!gotText) {
				setDraft(content);
				setMessages((list) => list.slice(0, -2));
			} else {
				patchLast((m) => ({ ...m, pending: false }));
			}
		}
	}

	return (
		<section className="start-guide" aria-label="砚灵向导">
			<header className="start-guide-head">
				<span
					className="start-guide-face"
					data-state={state}
					aria-hidden="true"
				>
					<i />
					<i />
				</span>
				<div>
					<h2 className="start-guide-name">砚灵</h2>
					<p className="start-guide-status" aria-live="polite">
						{STATUS_TEXT[state]}
						{focusTitle ? ` · 正看着《${focusTitle}》` : ""}
					</p>
				</div>
			</header>
			<div className="start-guide-log" ref={listRef}>
				<p className="start-guide-msg is-guide">{GREETING}</p>
				{messages.map((m, i) => (
					<p
						// biome-ignore lint/suspicious/noArrayIndexKey: 消息只追加不重排
						key={i}
						className={`start-guide-msg ${m.role === "user" ? "is-user" : "is-guide"}${m.pending ? " is-pending" : ""}`}
					>
						{m.content || (m.pending ? "……" : "")}
						{m.stopped ? (
							<span className="start-guide-cut">（已停下）</span>
						) : null}
					</p>
				))}
			</div>
			{notice ? (
				<p className="start-guide-notice" role="status">
					{notice}
					{/LLM_NOT_CONFIGURED|没有配置模型/.test(notice) ? (
						<a href="#/settings"> 去设置</a>
					) : null}
				</p>
			) : null}
			{messages.length === 0 ? (
				<div className="start-guide-quick">
					{QUICK.map((q) => (
						<button
							key={q}
							type="button"
							onClick={() => send(q)}
							disabled={busy}
						>
							{q}
						</button>
					))}
				</div>
			) : null}
			<form
				className="start-guide-form"
				onSubmit={(e) => {
					e.preventDefault();
					send(draft);
				}}
			>
				<label className="start-sr" htmlFor="start-guide-input">
					问砚灵
				</label>
				<textarea
					id="start-guide-input"
					ref={inputRef}
					rows={1}
					value={draft}
					placeholder="问砚灵点什么…"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (
							e.key === "Enter" &&
							!e.shiftKey &&
							!e.nativeEvent.isComposing
						) {
							e.preventDefault();
							send(draft);
						}
					}}
				/>
				{busy ? (
					<button
						type="button"
						className="start-btn is-quiet"
						onClick={() => abortRef.current?.stop("user")}
					>
						停下
					</button>
				) : (
					<button
						type="submit"
						className="start-btn is-ink"
						disabled={!draft.trim()}
					>
						发送
					</button>
				)}
			</form>
		</section>
	);
}
