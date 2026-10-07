// S5-9（Plan §4 T6／charter §3 S5-9）：实时轮次渲染——public/legacy/agent.js :1395-1518
// consumeStream 的 DOM 半（消息源＝lib/agent-round.js 的 createRoundAccumulator ops，组件只做 applyOp）。
// 形态（与 S5-6 ChatLiveBubble 同族）：正文气泡／思考块／工具块／工具错误行由 applyOp 命令式直写 DOM
// （≙ legacy 的 curText/curReason/toolBlocks 闭包变量；正文热节点不参与 React 重渲），
// 确认卡走 React（AgentActionCard 自带结算态），用 portal 挂到「工具块之后」的就地容器上
// （≙ :1470 renderConfirmCard(shell, …) 的内联位置；容器 display:contents 不入布局）。
// 逐条 legacy 锚点：思考 :1408-1424／文本 :1402-1405,:1425-1431／工具块 :1432-1458／
// 工具输出 :1460-1484／onDone 全文替换 :1486-1492／工具错误 :1499-1508／停止与出错气泡 :1865,:1982。
// 零 fetch、零 window.* 写入、零 localStorage（pending 快照经 cardDeps.rememberPending 交回 hook）。
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentToolLabel } from "../lib/agent-tool-labels.js";
import AgentActionCard from "./AgentActionCard.jsx";
// S5-8 出口件：滚动目标就是消息容器（:1344-1347）
import { scrollMessagesToBottom } from "./AgentMessageList.jsx";

const AgentLiveRound = forwardRef(function AgentLiveRound(
	{ userText, typingText, cardDeps },
	ref,
) {
	const shellRef = useRef(null);
	const curTextRef = useRef(null);
	const curReasonRef = useRef(null);
	const toolBlocksRef = useRef(new Map());
	const cardSeqRef = useRef(0);
	const [cards, setCards] = useState([]);

	// 句柄只建一次（≙ legacy 闭包局部变量）：applyOp 只读 ref 与稳定 setter，跨重渲稳定
	const handleRef = useRef(null);
	if (!handleRef.current) {
		const ensureBubble = () => {
			if (!curTextRef.current) {
				const b = document.createElement("div");
				b.className = "msg-bubble";
				shellRef.current.appendChild(b);
				curTextRef.current = b; // :1403 curText = addBubble(shell)
			}
			return curTextRef.current;
		};
		const applyOp = (op) => {
			const shell = shellRef.current;
			if (!shell || !op) return;
			switch (op.kind) {
				// :1408-1417 思考块插在 .msg-role 之后
				case "reasoning-open": {
					const det = document.createElement("details");
					det.className = "msg-reasoning";
					const sum = document.createElement("summary");
					sum.textContent = "思考过程";
					const body = document.createElement("div");
					body.className = "reasoning-body";
					det.appendChild(sum);
					det.appendChild(body);
					shell.insertBefore(det, shell.firstChild.nextSibling);
					curReasonRef.current = body;
					break;
				}
				// :1419-1422
				case "reasoning-append": {
					const body = curReasonRef.current;
					if (body) body.textContent += op.delta;
					break;
				}
				// :1424
				case "reasoning-end":
					curReasonRef.current = null;
					break;
				// :1425-1430 段内合并、段间新气泡
				case "text-append": {
					ensureBubble().textContent += op.delta;
					scrollMessagesToBottom();
					break;
				}
				// :1431
				case "text-end":
					curTextRef.current = null;
					break;
				// :1432-1458 工具块结构（入参文案由 lib 的 toolInputText 供给）
				case "tool-block": {
					const block = document.createElement("details");
					block.className = "tool-call";
					const s = document.createElement("summary");
					const label = document.createElement("span");
					label.className = "tool-call-name";
					label.textContent = `调用工具 · ${agentToolLabel(op.toolName)}`;
					const status = document.createElement("span");
					status.className = "tool-call-status";
					status.textContent = "执行中…";
					s.appendChild(label);
					s.appendChild(status);
					const inputPre = document.createElement("pre");
					inputPre.className = "tool-call-io";
					inputPre.textContent = op.inputText;
					const resultPre = document.createElement("pre");
					resultPre.className = "tool-call-io tool-call-result hidden";
					block.appendChild(s);
					block.appendChild(inputPre);
					block.appendChild(resultPre);
					shell.appendChild(block);
					toolBlocksRef.current.set(op.toolCallId, {
						statusEl: status,
						resultPre,
					});
					curTextRef.current = null; // :1457 工具调用后新起文本气泡
					scrollMessagesToBottom();
					break;
				}
				// :1460-1484 工具输出两分支
				case "tool-output": {
					const tb = toolBlocksRef.current.get(op.toolCallId);
					if (!tb) break;
					tb.statusEl.textContent = op.statusText;
					if (op.pendingEntry) {
						// :1468-1472 确认信封：状态行「待作者确认」＋就地挂确认卡＋待确认快照交回 hook
						const node = document.createElement("div");
						// 该容器只为 portal 就位：display:contents 让它不参与 .msg 的 flex 布局，
						// 卡片的间距与 legacy 直接 append 时一致（等价差异记于 selfcheck）
						node.style.display = "contents";
						shell.appendChild(node);
						cardSeqRef.current += 1;
						setCards((prev) => [
							...prev,
							{
								key: `live-card-${cardSeqRef.current}`,
								node: node,
								conf: op.pendingEntry.conf,
								toolName: op.pendingEntry.toolName,
								args: op.pendingEntry.input,
							},
						]);
						if (typeof cardDeps?.rememberPending === "function")
							cardDeps.rememberPending(op.pendingEntry);
					} else {
						if (op.done) tb.statusEl.classList.add("done");
						tb.resultPre.textContent = `结果：${op.resultText}`;
						tb.resultPre.classList.remove("hidden");
					}
					scrollMessagesToBottom();
					break;
				}
				// :1499-1505 工具错误行
				case "tool-error": {
					const notice = document.createElement("div");
					notice.className = "msg-tool-error";
					notice.textContent = op.text;
					shell.appendChild(notice);
					scrollMessagesToBottom();
					break;
				}
				// :1486-1492 onDone 全文替换（相等时 lib 已出 noop）
				case "text-replace": {
					for (const bubble of shell.querySelectorAll(".msg-bubble")) {
						bubble.remove();
					}
					curTextRef.current = null;
					ensureBubble().textContent = op.text;
					scrollMessagesToBottom();
					break;
				}
				// :1865／:1870／:1982／:1988 停止与出错气泡（新起一条独立气泡，不动 curText）
				case "bubble": {
					const b = document.createElement("div");
					b.className = "msg-bubble";
					b.textContent = op.text;
					shell.appendChild(b);
					scrollMessagesToBottom();
					break;
				}
				default:
					break;
			}
		};
		handleRef.current = { applyOp };
	}
	useImperativeHandle(ref, () => handleRef.current, []);

	return (
		<>
			{/* :1350-1367 用户消息壳（续跑路径没有 userText → 不渲染） */}
			{userText ? (
				<div className="msg user">
					<div className="msg-role">
						我<span className="msg-source msg-source-agent">助手</span>
					</div>
					<div className="msg-bubble">{userText}</div>
				</div>
			) : null}
			<div className="msg assistant" ref={shellRef}>
				{/* :1355-1362 角色行与来源标注 */}
				<div className="msg-role">
					助手
					<span className="msg-source msg-source-agent">助手</span>
				</div>
				{/* :1858／:1975 typing 节点（流开始前由调用方置空） */}
				{typingText ? <div className="typing">{typingText}</div> : null}
				{cards.map((c) =>
					createPortal(
						<AgentActionCard
							conf={c.conf}
							toolName={c.toolName}
							args={c.args}
							deps={cardDeps}
						/>,
						c.node,
						c.key,
					),
				)}
			</div>
		</>
	);
});

export default AgentLiveRound;
