// S5-9（Plan §1.1 G2）：public/legacy/agent.js 块二「确认卡与结算」纯逻辑移植（范式 A·判定 C 收尾笔）。
// 语义逐字对应 legacy 行号：
// - :1522-1527 确认信封提取（裸信封与 {ok,data:{…}} 包裹两形态）、:1530-1537 fmtVal
// - :1540-1603 提案完整差异快照模型（warn/title/meta/changes/quote）
// - :1608-1629 状态表八键＋fallback＋normalizeActionStatus（表外非空→unknown）
// - :1643-1717 卡模型（head/args pre/影响面/只读判定）
// - :1736-1743 确认请求体（有会话→conversation_id；否则→session_id）
// - :1719-1789 结算分派（成功族三态；409 SUPERSEDED／404 或 NOT_FOUND／409 REQUIRES_REVIEW／其余 fail）
// 纪律：零 DOM、零 fetch、零全局写入；文案逐字（含标点与空格），安全输出由调用方以文本节点承接。
import { agentToolLabel } from "./agent-tool-labels.js";

export const ACTION_STATUS_META = {
	pending: { text: "", readonly: false },
	executing: { text: "执行中…", readonly: true },
	approved: { text: "已执行 ✓", readonly: true },
	rejected: { text: "已拒绝，未做任何改动", readonly: true },
	expired: { text: "已过期未执行（等待确认超时）", readonly: true },
	superseded: { text: "已被更新的同类请求取代（未执行）", readonly: true },
	failed: { text: "执行失败", readonly: true },
	// S2-02：执行中断（重启/恢复期间执行到一半）——结果不确定，不给重放入口
	interrupted: {
		text: "执行中断，可能已部分生效——请核对目标内容后重新发起",
		readonly: true,
	},
};
export const ACTION_STATUS_FALLBACK = {
	text: "已结算（状态未知）",
	readonly: true,
};

// :1522-1527
export function extractConfirmation(output) {
	if (!output || typeof output !== "object") return null;
	if (output.status === "confirmation_required" && output.confirmation)
		return output.confirmation;
	if (
		output.data &&
		output.data.status === "confirmation_required" &&
		output.data.confirmation
	)
		return output.data.confirmation;
	return null;
}

// :1530-1537
export function fmtVal(v) {
	if (v === null || v === undefined) return "（空）";
	if (Array.isArray(v)) return `[${v.map(fmtVal).join("、")}]`;
	if (typeof v === "object") {
		try {
			return JSON.stringify(v);
		} catch (_e) {
			return String(v);
		}
	}
	return String(v);
}

// :1540-1603
export function proposalPreviewModel(preview) {
	const p = preview || {};
	const warn =
		p.version_match === false
			? `⚠ 版本不符：你确认的是 revision ${p.expected_revision}，但提案当前已是 revision ${p.revision}。执行将被拒绝，请重新读取核对。`
			: null;
	const metaBits = [
		`revision ${p.revision}`,
		`状态 ${p.status || ""}`,
		`来源 ${p.created_by || "author"}`,
	];
	if (p.chapter_title) metaBits.push(`章节 ${p.chapter_title}`);
	else if (p.chapter_id) metaBits.push(`章节 #${p.chapter_id}`);
	if (p.importance) metaBits.push(`重要性 ${p.importance}`);
	if (p.supersedes_event_id)
		metaBits.push(`替代事件 #${p.supersedes_event_id}`);
	const changes = (p.changes || []).map((ch) => {
		const label =
			ch.change_kind === "relation"
				? `关系 ${ch.subject_ref || ""}`
				: `${ch.field_key || ""}（${ch.subject_ref || ""}）`;
		return {
			text: `${label}：${fmtVal(ch.old_value)} → ${fmtVal(ch.new_value)}`,
		};
	});
	if (!changes.length) changes.push({ text: "（无变化项）" });
	return {
		warn: warn,
		title: `提案 #${p.proposal_id}：${p.title || "（无标题）"}`,
		meta: metaBits.join(" · "),
		summary: p.summary || null,
		changes: changes,
		quote: p.source_quote ? `原文依据：「${p.source_quote}」` : null,
	};
}

// :1622-1629
export function normalizeActionStatus(status) {
	const s = typeof status === "string" ? status.trim() : "";
	return ACTION_STATUS_META[s] ? s : s ? "unknown" : "pending";
}

export function actionStatusMeta(status) {
	return ACTION_STATUS_META[status] || ACTION_STATUS_FALLBACK;
}

// :1674-1675
export function confirmArgsText(args) {
	let text = "";
	try {
		text = JSON.stringify(args || {}, null, 2);
	} catch (_e) {
		text = String(args);
	}
	return text === "{}" ? "（无参数）" : text;
}

// :1659／:1680-1685／:1663-1665 —— 卡模型（DOM 结构由 AgentActionCard.jsx 渲染）
export function confirmCardModel(input) {
	const i = input || {};
	const conf = i.conf || {};
	const key = normalizeActionStatus(i.status);
	const meta = actionStatusMeta(key);
	return {
		key: key,
		readonly: !!meta.readonly,
		statusText: meta.text,
		head: `AI 请求写操作：${conf.summary || agentToolLabel(i.toolName || conf.tool)}`,
		argsText: confirmArgsText(i.args),
		impactText: conf.impact?.length
			? `影响能力：${conf.impact.join("、")}`
			: null,
		preview:
			conf.preview && conf.preview.kind === "event_proposal"
				? proposalPreviewModel(conf.preview)
				: null,
	};
}

// :1631-1641 —— 类名与只读后缀（React 侧由状态推导）
export function cardClassName(key, readonly) {
	return `msg-action status-${key}${readonly ? " msg-action-readonly" : ""}`;
}

// :1737-1743
export function buildConfirmBody(approve, conversationId, sessionId) {
	return conversationId
		? { approve: approve, conversation_id: conversationId }
		: { approve: approve, session_id: sessionId };
}

// :1732 —— 点按即时状态文案（结算前）
export function settleStartText(approve) {
	return approve ? "执行中…" : "已拒绝";
}

function outcome(key, extra) {
	return {
		key: key,
		statusText: null,
		toast: null,
		shouldResume: false,
		forget: false,
		resetButtons: false,
		...(extra || {}),
	};
}

function messageFromData(data) {
	if (!data?.error) return "";
	return data.error.message || data.error.code || "";
}

// :1719-1789 的结算分派（DOM 切换与 toast 由 AgentActionCard.jsx 执行）
export function settleOutcome(input) {
	const i = input || {};
	if (i.error !== undefined && i.error !== null) {
		return outcome("fail", {
			statusText: "确认失败",
			toast: i.error.message ? i.error.message : String(i.error),
			resetButtons: true,
		});
	}
	const data = i.data || null;
	const errCode = i.errCode || data?.error?.code || "";
	if (i.ok === true) {
		const settled = data?.status ? data.status : "";
		if (settled === "rejected")
			return outcome("rejected", { shouldResume: true, forget: true });
		if (settled === "failed")
			return outcome("failed", {
				statusText: errCode ? `执行失败：${errCode}` : "执行失败",
				shouldResume: true,
				forget: true,
			});
		return outcome("approved", { shouldResume: true, forget: true });
	}
	// M7 F2：被更新的同类请求取代（409）→ 只读历史卡，不报「确认失败」、不 toast、不再 resume
	if (i.status === 409 && errCode === "CONFIRMATION_SUPERSEDED")
		return outcome("superseded", { forget: true });
	// 已过期/凭证不存在（404 或 CONFIRMATION_NOT_FOUND）→ 只读 status-expired 卡
	if (i.status === 404 || errCode === "CONFIRMATION_NOT_FOUND")
		return outcome("expired", { forget: true });
	// S2-02：执行中断（结果不确定，可能已部分生效）→ 只读 interrupted 卡，不给重放入口
	if (i.status === 409 && errCode === "ACTION_REQUIRES_REVIEW")
		return outcome("interrupted", {
			forget: true,
			toast: messageFromData(data) || "执行中断，不能重放",
		});
	return outcome("fail", {
		statusText: "确认失败",
		toast:
			messageFromData(data) ||
			(i.status === undefined || i.status === null
				? "请求失败"
				: `请求失败 ${i.status}`),
		resetButtons: true,
	});
}
