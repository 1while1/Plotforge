// S5-9（Plan §4 T7／charter §3 S5-9）：Agent 台写操作确认卡——
// public/legacy/agent.js :1647-1717 renderConfirmCard／:1631-1641 setConfirmCardStatus／
// :1719-1726 failConfirm／:1729-1789 settleAction 的 React 化。
// 分工：文案与结算分派在 lib/agent-actions.js（纯逻辑，Node 侧同源断言），本件只做 DOM 与结算编排。
// 结算态存内部 state：受控重渲不得把已结算卡打回 pending（T7-8）；需要按 status prop 强制换态时
// 由父层给 key（remount，T7-3）。依赖全注入（deps：fetchImpl／toast／forgetPending／onResume／
// pendingConversationId／sessionId），组件零全局读取、零 window.* 写入。
import { useRef, useState } from "react";
import {
	actionStatusMeta,
	buildConfirmBody,
	cardClassName,
	confirmCardModel,
	settleOutcome,
	settleStartText,
} from "../lib/agent-actions.js";

// :1663-1665 ＋ :1540-1603 —— 提案完整差异快照（textContent 安全输出，不用 innerHTML）
function ProposalPreview({ model }) {
	// React key：按「同文案出现序号」定，既不用下标（noArrayIndexKey），也不怕两项文案相同
	const seen = new Map();
	const items = model.changes.map((c) => {
		const n = (seen.get(c.text) || 0) + 1;
		seen.set(c.text, n);
		return { key: `${n}-${c.text}`, text: c.text };
	});
	return (
		<div className="action-preview">
			{model.warn ? <div className="preview-warn">{model.warn}</div> : null}
			<div className="preview-title">{model.title}</div>
			<div className="preview-meta">{model.meta}</div>
			{model.summary ? (
				<div className="preview-summary">{model.summary}</div>
			) : null}
			<div className="preview-changes">
				{items.map((c) => (
					<div className="preview-change-item" key={c.key}>
						{c.text}
					</div>
				))}
			</div>
			{model.quote ? <div className="preview-quote">{model.quote}</div> : null}
		</div>
	);
}

export default function AgentActionCard({
	conf,
	toolName,
	args,
	status,
	deps,
}) {
	const d = deps || {};
	const model = confirmCardModel({ conf, toolName, args, status });
	// 结算中／结算后：key＝null 表示沿用 props 推导的 statusKey；text＝null 表示用状态表文案
	const [settleState, setSettleState] = useState({
		key: null,
		text: null,
		busy: false,
	});
	const busyRef = useRef(false);
	const statusKey = settleState.key || model.key;
	const readonly = Boolean(actionStatusMeta(statusKey).readonly);
	const statusText =
		settleState.text !== null
			? settleState.text
			: actionStatusMeta(statusKey).text;

	// :1753／:1760／:1766／:1776 ＋ :1754／:1761／:1767／:1779／:1785
	function applyOutcome(oc) {
		const cid = conf ? conf.id : null;
		if (oc.forget && typeof d.forgetPending === "function")
			d.forgetPending(cid);
		// key='fail' 是「结算失败复位」哨兵（不是状态表键）：:1721 setConfirmCardStatus(ui,'pending')
		// 把卡打回 pending（类名 status-pending），文案另写「确认失败」
		setSettleState({
			key: oc.key === "fail" ? "pending" : oc.key,
			text: oc.statusText,
			busy: false,
		});
		if (oc.toast && typeof d.toast === "function") d.toast(oc.toast);
		// :1788 无论同意/拒绝/失败，都以系统事件 resume（串行由 hook 的 resumeAction 兜）
		if (oc.shouldResume && typeof d.onResume === "function") d.onResume(cid);
	}

	async function doSettle(approve) {
		if (busyRef.current) return; // 双保险：结算中不重复发起
		busyRef.current = true;
		const cid = conf ? conf.id : null;
		// :1730-1732 点按即时：按钮禁用＋文案「执行中…」/「已拒绝」
		setSettleState({ key: null, text: settleStartText(approve), busy: true });
		let resp = null;
		let data = null;
		try {
			const pendingConv =
				typeof d.pendingConversationId === "function"
					? d.pendingConversationId(cid)
					: null;
			const fetchImpl = d.fetchImpl || globalThis.fetch;
			// :1737-1743 有会话 → conversation_id；否则回落 session_id
			resp = await fetchImpl(`/api/agent/actions/${cid}/confirm`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					buildConfirmBody(approve, pendingConv, d.sessionId),
				),
			});
			try {
				data = await resp.json();
			} catch (_e) {
				/* :1744 非 JSON 响应 */
			}
		} catch (e) {
			// :1745-1748 网络错误 → failConfirm(ui, e.message)
			busyRef.current = false;
			applyOutcome(settleOutcome({ error: e }));
			return;
		}
		busyRef.current = false;
		applyOutcome(
			settleOutcome({
				ok: Boolean(resp.ok),
				status: resp.status,
				errCode: data?.error?.code || "",
				data: data,
			}),
		);
	}

	return (
		<div
			className={cardClassName(statusKey, readonly)}
			data-action-status={statusKey}
		>
			<div className="action-head">{model.head}</div>
			{model.preview ? <ProposalPreview model={model.preview} /> : null}
			{/* :1667-1678 完整变更参数（默认展开） */}
			<details className="action-args" open>
				<summary>完整变更参数</summary>
				<pre>{model.argsText}</pre>
			</details>
			{model.impactText ? (
				<div className="action-impact">{model.impactText}</div>
			) : null}
			{/* :1687-1711 只读历史卡（:1693-1700）只留状态行，不给任何结算入口 */}
			<div className="action-ops">
				{readonly ? null : (
					<>
						<button
							type="button"
							className="btn btn-small"
							disabled={settleState.busy}
							onClick={() => doSettle(true)}
						>
							同意执行
						</button>
						<button
							type="button"
							className="btn btn-small btn-ghost"
							disabled={settleState.busy}
							onClick={() => doSettle(false)}
						>
							拒绝
						</button>
					</>
				)}
				<span className="action-status">{statusText}</span>
			</div>
		</div>
	);
}
