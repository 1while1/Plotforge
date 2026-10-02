// S5-7（Plan §1.1 G3）：public/legacy/book-chat.js :665-827 上下文仪表/明细/压缩/还原纯逻辑移植。
// 语义逐字对应 legacy 行号：:666-669 fmtK（复用 chat-render.js 同源实现）、:672-702 仪表取值
// （clampSuffix 四分支 → 有 usage/估算两分支）、:706-794 明细 bodyHTML（bar/rows/sub/calls/来源行/
// 校准注/钳制注）、:796-817 压缩弹窗与请求体、:819-827 还原请求体。
// 纪律：零 DOM、零 fetch、零全局写；仪表数值全部由 serviceStatus（GET /context-status 响应）注入。
import { fmtK } from "./chat-render.js";

export const BREAKDOWN_TITLE = "上下文组成明细";
export const BREAKDOWN_OK_TEXT = "关闭";
export const COMPRESS_TITLE = "压缩上下文";
export const COMPRESS_OK_TEXT = "开始压缩";
export const COMPRESSING_TOAST = "正在压缩…";
export const COMPRESS_PATH = "/chat/compress";
export const RESTORE_PATH = "/chat/compress/restore";

// :680-684 窗口来源透明化（官方渠道报告 → 用户设置 → 系统默认）
export function clampSuffix(st) {
	if (!st) return "";
	const win = st.contextWindow || 128000;
	if (st.clamped) return ` · 设 ${fmtK(st.windowManual)} 被钳制为 ${fmtK(win)}`;
	if (st.officialSource === "channel_not_reported")
		return ` · 渠道未报官方上限${st.windowManual ? "，按你设置生效" : "，按系统默认"}`;
	if (st.officialSource === "not_fetched") return " · 官方源尚未拉取";
	if (st.officialSource === "channel_reported")
		return ` · 官方 ${fmtK(st.windowOfficial)}`;
	return "";
}

// :685-699 仪表输入：usage 优先，其次服务端 lastUsage，皆无则 null（走估算分支）
export function meterOf(st, usage) {
	const base = st || {};
	return { ...base, usage: usage || base.lastUsage || null };
}

// :713-731 明细模型（segs/pct/校准）
function buildModel(d) {
	const win = d.window || 128000;
	const lb = d.lastBreakdown;
	const sys = lb ? lb.system : d.system.total;
	const hist = lb ? lb.history : d.history.chatTokens;
	const tool = lb ? lb.tool : d.history.toolTokens;
	const sch = lb ? lb.schema || 0 : d.schema || 0;
	const out = lb ? lb.outputReserve : d.outputReserve;
	const usedPrompt = lb?.promptTokens || d.estimatedPrompt;
	// free 用真实尺度算：窗口 − 真实 prompt 占用 − 真实输出预留（:722-724）
	const free = Math.max(0, win - usedPrompt - out);
	const pct = (t) => (win ? Math.round((t / win) * 1000) / 10 : 0);
	const cal = d.calibration;
	const calib = (t) => (cal ? Math.round(t * cal.factor) : t);
	const calTag = cal ? "（校准）" : "";
	const segs = [
		{ name: "系统提示词", tokens: sys, color: "#5b8dd9" },
		{ name: "对话历史", tokens: hist, color: "#7fb069" },
		{ name: "工具调用结果", tokens: tool, color: "#e0a458" },
		{ name: "工具定义（schema）", tokens: sch, color: "#8d9aa5" },
		{
			name: "输出预留（max_tokens）",
			tokens: out,
			color: "#b58bd9",
			raw: true,
		},
		{ name: "剩余自由", tokens: free, color: "#d9d9d9", raw: true },
	];
	const segVal = (s) => (s.raw ? s.tokens : calib(s.tokens));
	const segTag = (s) => (s.raw ? "" : calTag);
	return { win, lb, sys, free, pct, cal, calib, calTag, segs, segVal, segTag };
}

// :743-788 明细弹窗正文（bar → rows → 逐层明细 → 调用台账 → 来源行）
export function breakdownHTML(d) {
	const m = buildModel(d);
	let bar = '<div class="ctx-bd-bar">';
	for (const s of m.segs) {
		const v = m.segVal(s);
		if (v <= 0) continue;
		bar += `<div class="ctx-bd-seg" style="width:${Math.max(0.5, m.pct(v))}%;background:${s.color}" title="${s.name} ≈${fmtK(v)}${m.segTag(s)}（${m.pct(v)}%）"></div>`;
	}
	bar += "</div>";
	let rows = "";
	for (const s of m.segs) {
		const v = m.segVal(s);
		rows += `<div class="ctx-bd-row"><span class="ctx-bd-dot" style="background:${s.color}"></span><span class="ctx-bd-name">${s.name}</span><span class="ctx-bd-val">≈${fmtK(v)}${m.segTag(s)} · ${m.pct(v)}%</span></div>`;
	}
	// 系统提示逐层明细：优先用该次请求落库的组装层台账（parts_json）（:755-762）
	const hasLbParts = !!m.lb?.parts?.length;
	const parts = hasLbParts ? m.lb.parts : d.system.parts || [];
	const partsSrc = hasLbParts
		? "本次请求逐层组装台账，随调用落库"
		: "当前组装估算";
	let sub = `<div class="ctx-bd-subtitle">系统提示逐层明细（${partsSrc}，合计 ≈${fmtK(m.calib(m.sys))}${m.calTag} / 预算 ${fmtK(d.system.budget)}）</div>`;
	for (const p of parts) {
		sub += `<div class="ctx-bd-row ctx-bd-sub"><span class="ctx-bd-name">${p.name}${p.truncated ? "（被预算截断）" : ""}</span><span class="ctx-bd-val">≈${fmtK(m.calib(p.tokens))}${m.calTag} · ${m.pct(m.calib(p.tokens))}%</span></div>`;
	}
	if (!parts.length)
		sub +=
			'<div class="ctx-bd-row ctx-bd-sub"><span class="ctx-bd-name">（暂无内容）</span><span class="ctx-bd-val">0</span></div>';
	const src = m.lb
		? `数据来源：调用台账 llm_calls 最近一次真实请求（${m.lb.scope || "chat"} · ${String(
				m.lb.at || "",
			)
				.replace("T", " ")
				.slice(
					0,
					19,
				)}${m.lb.promptTokens ? `，上游 usage ${fmtK(m.lb.promptTokens)} tokens` : ""}）`
		: "数据来源：当前估算（本书暂无调用台账记录）";
	const offSrc =
		d.officialSource === "channel_reported"
			? `官方源：渠道 /models 报告 ${fmtK(d.windowOfficial)}（拉取于 ${String(
					d.officialFetchedAt || "",
				)
					.replace("T", " ")
					.slice(0, 19)}）`
			: d.officialSource === "channel_not_reported"
				? "官方源：渠道 /models 未报告上下文上限（官方缺失，不猜测）"
				: "官方源：尚未拉取（后台自动拉取中）";
	// 最近调用台账表（:771-781）
	let calls = "";
	const callList = d.recentCalls || [];
	if (callList.length) {
		calls =
			'<div class="ctx-bd-subtitle">最近调用台账（llm_calls 落库，重启不丢）</div>' +
			'<table class="ctx-bd-table"><thead><tr><th>时间</th><th>场景</th><th>输入</th><th>输出</th><th>缓存命中</th><th>耗时</th><th>结束/状态</th></tr></thead><tbody>';
		for (const c of callList) {
			calls += `<tr><td>${String(c.at || "")
				.replace("T", " ")
				.slice(
					5,
					16,
				)}</td><td>${c.scope || ""}</td><td>${c.prompt_tokens ? fmtK(c.prompt_tokens) : "—"}</td><td>${c.completion_tokens ? fmtK(c.completion_tokens) : "—"}</td><td>${c.cache_hit_tokens ? fmtK(c.cache_hit_tokens) : "—"}</td><td>${((c.duration_ms || 0) / 1000).toFixed(1)}s</td><td>${c.status === "ok" ? c.finish_reason || "ok" : `✗ ${c.status || "error"}`}</td></tr>`;
		}
		calls += "</tbody></table>";
	}
	const calNote = m.cal
		? ` · 校准 = 官方 usage ${fmtK(m.cal.promptTokens)} ÷ 本地估算 ${fmtK(m.cal.localTotal)} = ×${m.cal.factor.toFixed(3)}`
		: "";
	const note = d.clamped ? `<div class="ctx-bd-note">⚠ ${d.note}</div>` : "";
	const bodyHTML =
		note +
		bar +
		rows +
		sub +
		calls +
		`<p class="field-hint">${src} · ${offSrc} · 窗口 ${fmtK(m.win)}${d.windowManual ? `（你设置 ${fmtK(d.windowManual)}）` : "（自动跟随模型）"}${calNote}</p>`;
	return { bodyHTML, win: m.win };
}

// :802-804 四节摘要结构说明（S3-04 的 SUMMARY_SYSTEM 是唯一含义来源）
export function compressBodyHTML() {
	return (
		'<p class="field-hint">将把较早的对话（保留最近 8 条）压缩成一份存档摘要，释放上下文空间。原消息不会删除，可在存档摘要处一键还原。</p>' +
		'<p class="field-hint">存档摘要分四节：【已确认的资料与设定】【已执行的动作与结果】【未决问题】【作者尚未采纳的设想】。' +
		"最后一节里的想法仍不是事实，不会被写成既定剧情。</p>"
	);
}

export function compressTitle() {
	return COMPRESS_TITLE;
}

// :808 压缩请求体（源版本锁：压缩期间来新消息 → 服务端 409）
export function compressRequest(conversationId, expectedLastMessageId) {
	return {
		method: "POST",
		path: COMPRESS_PATH,
		body: { conversationId, expectedLastMessageId },
	};
}

// :821 还原请求体
export function restoreRequest(conversationId) {
	return { method: "POST", path: RESTORE_PATH, body: { conversationId } };
}

// :809 / :822
export function compressToast(archived) {
	return `已压缩 ${archived} 条早期对话`;
}

export function restoreToast(restored) {
	return `已还原 ${restored} 条归档对话`;
}
