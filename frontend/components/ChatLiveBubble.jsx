// S5-6（Plan §1.1 G2，charter §3 S5-6）：实时气泡——public/legacy/book-chat.js（零 diff 保留）
// streamChatOnce 内联片段的 React 化，语义逐字对应：
// - 骨架 DOM :1149-1154（.msg.assistant／.msg-role／details.msg-reasoning.live-reasoning.hidden[open]
//   ／.msg-phase.hidden／.msg-bubble）＋来源标签 :1155-1156（＝makeSourceTag :855-862）
// - 思考块去 hidden :1328-1331（首帧 pushReasoning）
// - phase 行「（已等待 N 秒）」自走秒表＋断连自清 :1169-1186（setPhase）
// - **性能契约**（:1188-1216，2026-09-14 二轮诊断的「卡死真因」修复，行为契约非可选）：
//   增量按**时间**（120ms）合并、insertAdjacentText **追加**落盘（不整块重写 ⇒ 不做 O(n) 字符串复制、
//   脏区域更小）、滚动节流 200ms、收尾前必须 flush（由 transport 的 commitLive 调用）。
//   **不得**用 React state 每 delta 重渲正文（等价于被诊断掉的卡死形态）。
// - 工具块/确认卡/检索块插在 .msg-bubble **之前**（:1333-1347）
// 形态：React 只管骨架与块列表（块变化是低频事件，走 state）；正文/思考/phase 三个**热节点**由 apiRef
// 暴露的命令式句柄直接写 DOM（≙ legacy 的 liveBubble/liveReasoningBody/livePhase 三个局部变量）。
// 零 fetch、零 window.* 写入、零 localStorage；SSE 事件由 transport 经 apiRef 推入。
import { useEffect, useRef, useState } from "react";
import { makeSourceTag } from "../lib/chat-render.js";
import { ChatActionCard } from "./ChatActionCard.jsx";
import { ChatToolEventBlock } from "./ChatToolEventBlock.jsx";

export const FLUSH_INTERVAL_MS = 120; // :1198
export const SCROLL_THROTTLE_MS = 200; // :1199

// 语义召回旧文折叠块（legacy renderRetrieval :341-365；S5-5 ChatMessageList.jsx 的内部 RetrievalBlock
// 为已验收件、不可改，故此处按同一 markup 复写，仅用于流式期间的临时展示）
function LiveRetrieval({ hits }) {
	if (!hits?.length) return null;
	return (
		<details className="msg-retrieval">
			<summary>{`参考了 ${hits.length} 段旧文（语义召回）`}</summary>
			<div className="retrieval-body">
				{hits.map((h) => (
					<div className="retrieval-item" key={`${h.chapter || ""}#${h.score}`}>
						<div className="retrieval-head">{`《${h.chapter || ""}》 · 相似度 ${h.score}`}</div>
						<div className="retrieval-text">
							{h.text == null ? "" : String(h.text)}
						</div>
					</div>
				))}
			</div>
		</details>
	);
}

export function ChatLiveBubble({
	apiRef,
	source,
	scrollTarget,
	cardProps,
	onAttach,
	onDetach,
}) {
	const bubbleRef = useRef(null);
	const detRef = useRef(null);
	const reasoningRef = useRef(null);
	const phaseRef = useRef(null);
	const flushTimerRef = useRef(null);
	const phaseTimerRef = useRef(null);
	const lastScrollAtRef = useRef(0);
	const pendingRef = useRef({ text: "", reasoning: "" });
	const seqRef = useRef(0);
	// scrollTarget 为 prop：句柄只建一次，故经 ref 读取最新值
	const scrollRef = useRef(scrollTarget);
	scrollRef.current = scrollTarget;

	const [retrieval, setRetrieval] = useState(null);
	const [blocks, setBlocks] = useState([]);
	const tag = makeSourceTag(source);
	// 挂载/卸载握手回调（hook 侧缓冲代理的 attach 触发点）：经 ref 读取最新值，effect 只跑一次
	const onAttachRef = useRef(onAttach);
	onAttachRef.current = onAttach;
	const onDetachRef = useRef(onDetach);
	onDetachRef.current = onDetach;

	// 命令式句柄（≙ legacy 的闭包局部变量）：只建一次，跨重渲稳定
	const handleRef = useRef(null);
	if (!handleRef.current) {
		const scrollThrottled = () => {
			// :1201-1206（节流时钟用 Date.now()：与 :1176/:1180 秒表同源，fake timers 下确定性可控）
			const now = Date.now();
			if (now - lastScrollAtRef.current < SCROLL_THROTTLE_MS) return;
			lastScrollAtRef.current = now;
			const el = scrollRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		};
		const flushLive = () => {
			// :1207-1212
			if (flushTimerRef.current) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			const b = bubbleRef.current;
			const rb = reasoningRef.current;
			if (pendingRef.current.text && b) {
				b.insertAdjacentText("beforeend", pendingRef.current.text);
				pendingRef.current.text = "";
			}
			if (pendingRef.current.reasoning && rb) {
				rb.insertAdjacentText("beforeend", pendingRef.current.reasoning);
				pendingRef.current.reasoning = "";
			}
			scrollThrottled();
		};
		const scheduleFlush = () => {
			// :1213-1216
			if (flushTimerRef.current) return;
			flushTimerRef.current = setTimeout(() => {
				flushTimerRef.current = null;
				flushLive();
			}, FLUSH_INTERVAL_MS);
		};
		const clearPhaseTimer = () => {
			if (phaseTimerRef.current) {
				clearInterval(phaseTimerRef.current);
				phaseTimerRef.current = null;
			}
		};
		handleRef.current = {
			pushDelta(t) {
				// :1198-1216＋:1325-1327
				if (!t) return;
				pendingRef.current.text += t;
				scheduleFlush();
			},
			pushReasoning(t) {
				// :1328-1331（首帧去 hidden）；Plan §4 T2-4：空串不触发
				if (!t) return;
				const det = detRef.current;
				if (det) det.classList.remove("hidden");
				pendingRef.current.reasoning += t;
				scheduleFlush();
			},
			setPhase(text) {
				// :1169-1186
				const el = phaseRef.current;
				if (!el) return;
				if (!text) {
					clearPhaseTimer();
					el.classList.add("hidden");
					el.textContent = "";
					return;
				}
				const t0 = Date.now();
				const paint = () => {
					// 气泡被移除（收尾/中止/重试）后自清，无需在每条退出路径上手动收尾
					if (!el.isConnected) {
						clearPhaseTimer();
						return;
					}
					el.textContent = `${text}（已等待 ${Math.round((Date.now() - t0) / 1000)} 秒）`;
				};
				clearPhaseTimer();
				el.classList.remove("hidden");
				paint();
				phaseTimerRef.current = setInterval(paint, 1000);
			},
			addRetrieval(hits) {
				// :1333-1337
				if (!hits?.length) return;
				setRetrieval(hits);
				scrollThrottled();
			},
			addTool(t) {
				// :1338-1342
				seqRef.current += 1;
				const key = seqRef.current;
				setBlocks((prev) => [...prev, { kind: "tool", payload: t, key }]);
				scrollThrottled();
			},
			addAction(a) {
				// :1343-1347
				seqRef.current += 1;
				const key = seqRef.current;
				setBlocks((prev) => [...prev, { kind: "action", payload: a, key }]);
				scrollThrottled();
			},
			flush() {
				flushLive();
			},
			getText() {
				// ≙ liveBubble.textContent（:1386）
				return bubbleRef.current ? bubbleRef.current.textContent : "";
			},
			getReasoning() {
				// ≙ liveReasoningBody.textContent（:1387）
				return reasoningRef.current ? reasoningRef.current.textContent : "";
			},
			drop() {
				// ≙ live.remove()：节点卸载由 hook 的 live 槽负责，这里只清缓冲与定时器
				pendingRef.current.text = "";
				pendingRef.current.reasoning = "";
				if (flushTimerRef.current) {
					clearTimeout(flushTimerRef.current);
					flushTimerRef.current = null;
				}
				clearPhaseTimer();
			},
		};
	}
	const handle = handleRef.current;

	// 挂载即把句柄交给调用方（hook 的缓冲代理按序 drain）；卸载即交还并清定时器（断连自清）
	useEffect(() => {
		if (apiRef) apiRef.current = handle;
		if (typeof onAttachRef.current === "function") onAttachRef.current(handle);
		return () => {
			if (typeof onDetachRef.current === "function")
				onDetachRef.current(handle);
			if (apiRef) apiRef.current = null;
			if (flushTimerRef.current) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			if (phaseTimerRef.current) {
				clearInterval(phaseTimerRef.current);
				phaseTimerRef.current = null;
			}
		};
	}, [apiRef, handle]);

	return (
		<div className="msg assistant">
			{/* :1151 ＋ :1156 attachSource（无 source 静默不标） */}
			<div className="msg-role">
				写作助手
				{tag ? <span className={tag.className}>{tag.textContent}</span> : null}
			</div>
			{/* :1152 */}
			<details
				className="msg-reasoning live-reasoning hidden"
				open
				ref={detRef}
			>
				<summary>思考过程</summary>
				<div className="reasoning-body" ref={reasoningRef} />
			</details>
			{/* :1153 */}
			<div className="msg-phase hidden" ref={phaseRef} />
			{/* :1333-1347：检索块／工具块／确认卡一律插在 .msg-bubble 之前，保持出现顺序 */}
			<LiveRetrieval hits={retrieval} />
			{blocks.map((b) =>
				b.kind === "tool" ? (
					<ChatToolEventBlock key={b.key} event={b.payload} />
				) : (
					<ChatActionCard
						key={b.key}
						action={b.payload}
						{...(cardProps || {})}
					/>
				),
			)}
			{/* :1154：热节点——正文只经 insertAdjacentText 追加，不参与 React 重渲 */}
			<div className="msg-bubble" ref={bubbleRef} />
		</div>
	);
}
