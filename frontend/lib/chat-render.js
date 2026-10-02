// S5-5（Plan §1.1 G1）：public/legacy/book-chat.js 块一渲染层的纯逻辑移植——范式 A·判定 C 的
// 「块一建设笔」（旧名桥注册与死锚点退役归 S5-7；本片 public/** 零 diff）。
// 语义逐字对应 legacy 行号：
// - 快捷回复上限 :292-294、pushQuickOptions :296-304、parseQuickReplies :306-338
// - SOURCE_LABELS :369-374、makeSourceTag :855-862、TOOL_LABELS :377-397、toolLabel :1434-1436
// - ACTION_STATUS_META :421-434、ACTION_STATUS_FALLBACK :434、normalizeActionStatus :436-439、
//   actionStatusMeta :441-443
// - 截断口径五处：正文预览 800（:500）、弹窗预览 1500（:598-600）、argsSummary 240（:1430）、
//   归档项 120（:845）、长消息 160（:928）＋args 前缀 120（:1543）
// - fmtK :666-669、ctx 仪表文案与占比 :676-699
// - 过期横幅：parseLocalTs :1412-1417、fmtTs :1419-1424、argsSummary :1426-1432、
//   expiredBatchKey :1470-1471
// - 回放匹配：ENVELOPE_MARK/NEAREST_WINDOW_MS :1539-1540、matchEnvelope :1542-1556、
//   matchNearest :1558-1574、planActionReplay ≙ loadChat 回放编排 :1615-1639
//   （pending 同参留最新／非 pending 走「信封→就近」消费式匹配／皆不中则不渲染）
// 纪律：零 DOM、零 fetch、零全局写入（唯一读＝调用方传入的入参）。

export const QUICK_MAX_GROUPS = 3;
export const QUICK_MAX_OPTS = 4;
export const QUICK_MAX_LABEL = 20; // 超长片段（正文摘录等）不当选项，沿用旧口径（:294）
export const ARGS_PREFIX_LEN = 120;
export const ARGS_SUMMARY_MAX = 240;
export const ARCHIVED_PREVIEW_MAX = 120;
export const MSG_CLAMP_LEN = 160;
export const PREVIEW_MAX = 800;
export const CONFIRM_PREVIEW_MAX = 1500;

// 消息来源标签（B5，:369-374）：空串与未知值一律不渲染（老数据静默兼容）
export const SOURCE_LABELS = {
	writing: "写作台",
	read: "阅读页",
	agent: "助手",
	system: "系统",
};

// 工具友好名（:377-397，19 条逐字）
export const TOOL_LABELS = {
	search_story: "语义检索旧文",
	grep_chapters: "关键词查全文",
	read_chapter: "阅读章节",
	read_chapter_range: "分段阅读章节",
	list_chapters: "列出章节",
	get_story_state: "读取状态簿",
	list_characters: "查看人物卡",
	list_worldview: "查看世界观",
	get_book_info: "查看本书信息",
	create_chapter: "新建章节",
	append_chapter: "追加章节正文",
	replace_chapter: "替换章节正文",
	set_chapter_meta: "修改章节标题/节拍",
	set_master_outline: "设置全书总纲",
	update_volume: "修改分卷",
	add_character: "新增人物卡",
	update_character: "更新人物卡",
	add_worldview: "新增世界观条目",
	write_story_state: "改写状态簿",
};

// 确认卡状态文案（B1，:421-434）：后端结算行保留 30 天且 /chat/actions 返回全状态，
// 前端必须把「已结算」渲染成只读历史卡（否则作者刷新后看到消失的卡或能再点一次的假 pending 卡）。
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

// 未知状态兜底（:434）：契约枚举外一律按只读历史卡渲染（宁可不给点，也不给能误点第二次的按钮）
export const ACTION_STATUS_FALLBACK = {
	text: "已结算（状态未知）",
	readonly: true,
};

export const ENVELOPE_MARK = "[确认执行结果·系统事件]";
export const NEAREST_WINDOW_MS = 30 * 60 * 1000; // 就近配对容忍窗口，与动作 TTL 同尺度（:1540）

// 从【需要确认】区块解析「问题 → 选项」分组（B4，:306-338）：按问题行切分（含问号的行，
// 或带编号的问题行），无问题结构时退化为单组平铺（向后兼容旧格式）。
export function pushQuickOptions(arr, raw, max) {
	if (!arr || arr.length >= max) return;
	for (const opt of String(raw).split(/[/／]/)) {
		if (arr.length >= max) break;
		const label = opt.trim().replace(/[。；;，,]$/, "");
		if (!label || label.length > QUICK_MAX_LABEL) continue;
		if (arr.indexOf(label) < 0) arr.push(label);
	}
}

export function parseQuickReplies(text) {
	const groups = [];
	const loose = []; // 无问题结构时的平铺选项（旧行为兜底）
	let current = null; // 当前收选项的问题组；null 表示选项进 loose
	for (const rawLine of String(text == null ? "" : text).split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const parens = line.match(/（[^（）]*）|\([^()]*\)/g) || [];
		// 问题行：含问号，或行首编号（"1." / "1、" / "一、"）且带括号选项
		const numbered = /^([0-9]{1,2}|[一二三四五六七八九十])[.、)．]/.test(line);
		const isQuestion = /[？?]/.test(line) || (numbered && parens.length > 0);
		if (isQuestion) {
			if (groups.length < QUICK_MAX_GROUPS) {
				const question = line
					.replace(/^([0-9]{1,2}|[一二三四五六七八九十])[.、)．]\s*/, "")
					.replace(/（[^（）]*）|\([^()]*\)/g, "")
					.trim();
				current = { question: question || line, options: [] };
				groups.push(current);
			} else {
				// 超出组数上限：该问题的选项丢弃，绝不并进上一个问题（否则按钮归属又是错的）
				current = null;
			}
		}
		for (const p of parens) {
			if (current)
				pushQuickOptions(current.options, p.slice(1, -1), QUICK_MAX_OPTS);
			else pushQuickOptions(loose, p.slice(1, -1), QUICK_MAX_OPTS);
		}
	}
	const out = groups.filter((g) => g.options.length).slice(0, QUICK_MAX_GROUPS);
	if (out.length) return out;
	return loose.length
		? [{ question: "", options: loose.slice(0, QUICK_MAX_OPTS) }]
		: [];
}

export function sourceLabel(source) {
	return SOURCE_LABELS[source] || "";
}

// 来源标签（B5，:855-862）：未知/空来源返回 null（老数据静默兼容）
export function makeSourceTag(source) {
	const label = sourceLabel(source);
	if (!label) return null;
	return { className: `msg-source msg-source-${source}`, textContent: label };
}

export function toolLabel(name) {
	return TOOL_LABELS[name] || name || "未知操作";
}

export function normalizeActionStatus(status) {
	const s = typeof status === "string" ? status.trim() : "";
	return ACTION_STATUS_META[s] ? s : s ? "unknown" : "pending";
}

export function actionStatusMeta(status) {
	return ACTION_STATUS_META[status] || ACTION_STATUS_FALLBACK;
}

// usage: { prompt_tokens, cache_hit_tokens } 或 null（null 时拉估算，:666-669/:672-705）
export function fmtK(n) {
	if (!n && n !== 0) return "—";
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// SQLite datetime('now','localtime') → "YYYY-MM-DD HH:MM:SS"（本地时区，按本地解析不外推 UTC，:1412-1417）
export function parseLocalTs(s) {
	const m = String(s || "").match(
		/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
	);
	if (!m) return Number.NaN;
	return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

export function fmtTs(ms) {
	if (!ms) return "";
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function argsSummary(args, max) {
	let s;
	try {
		s = JSON.stringify(args == null ? {} : args);
	} catch (_e) {
		s = "";
	}
	s = String(s || "");
	const limit = max || ARGS_SUMMARY_MAX;
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// 本条横幅的批键（:1470-1471）：书 id + 过期动作 id 集合（排序）——关闭记忆与「换书/新批次重现」的判据
export function expiredBatchKey(bookId, items) {
	const ids = (Array.isArray(items) ? items : [])
		.map((a) => a?.id || "")
		.sort()
		.join(",");
	return `${bookId || ""}|${ids}`;
}

// 优先匹配「确认执行结果·系统事件」信封消息（:1542-1556）；entries 为 {msg, used}（消费式）
export function matchEnvelope(entries, action) {
	let argsPrefix = "";
	try {
		// 对照 legacy :1543：JSON.stringify 失败时旧实现会整段抛出（被 loadChat 的 try 吞掉）；
		// React 渲染期不容忍抛出，故降级为空前缀（只按标记与工具名匹配），见台账「已知对照差异」。
		argsPrefix = JSON.stringify(action.args || {}).slice(0, ARGS_PREFIX_LEN);
	} catch (_e) {
		argsPrefix = "";
	}
	const marked = `此前你请求执行的写工具 ${action.name}`;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.used) continue;
		const c = String(e.msg.content || "");
		if (c.indexOf(ENVELOPE_MARK) < 0 || c.indexOf(marked) < 0) continue;
		// args 前缀匹配：后端信封里参数被截到 400 字符，前缀一致即认定同一动作（:1550-1551）
		if (argsPrefix && c.indexOf(argsPrefix) < 0) continue;
		e.used = true;
		return e;
	}
	return null;
}

// 其次按 settledAt 与消息 created_at 就近配对（:1558-1574）
export function matchNearest(entries, action) {
	const at = Number(action.settledAt || action.createdAt || 0) || 0;
	if (!at) return null;
	let best = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.used) continue;
		const ts = parseLocalTs(e.msg.created_at);
		if (!Number.isFinite(ts)) continue;
		const gap = Math.abs(ts - at);
		if (gap < bestGap) {
			bestGap = gap;
			best = e;
		}
	}
	if (!best || bestGap > NEAREST_WINDOW_MS) return null;
	best.used = true;
	return best;
}

// 回放编排（≙ loadChat :1615-1639）：pending → 可操作卡（同参只留最新一张）；
// 非 pending → 留痕行挂到来源消息正文下方（信封匹配 → 就近配对）；锚点不在则不渲染（不末尾堆砌）。
export function planActionReplay(messages, actions) {
	const list = (Array.isArray(actions) ? actions.slice() : []).sort(
		(a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0),
	);
	// 锚点索引只含非归档消息（legacy :1594-1595/:1607 的 flow 面）
	const entries = (Array.isArray(messages) ? messages : [])
		.filter((m) => m && m.compressed !== 1)
		.map((m) => ({ msg: m, used: false }));
	const pending = [];
	const logs = [];
	const unplaced = [];
	const seen = new Map();
	for (const a of list) {
		const status = normalizeActionStatus(a.status);
		if (status === "pending") {
			const key = `${a.name}|${JSON.stringify(a.args || {})}`;
			const prev = seen.get(key);
			if (prev) prev.dropKey = true; // 已有同参卡：用较新的一张替换（:1630）
			const item = { action: a, key, dropKey: false };
			seen.set(key, item);
			pending.push(item);
			continue;
		}
		const hit = matchEnvelope(entries, a) || matchNearest(entries, a);
		if (hit) logs.push({ action: a, anchorMessageId: hit.msg.id });
		else unplaced.push(a.id);
	}
	return { pending, logs, unplaced };
}

// 上下文仪表（:676-699）：usage 有真值时按真值，否则按估算
function ctxWindowOf(meter) {
	return meter.contextWindow || 128000;
}

function ctxSuffixOf(meter, win) {
	// 窗口来源透明化（官方渠道报告 → 用户设置 → 系统默认）；被钳制/官方缺失时仪表直接说明原因
	if (meter.clamped)
		return ` · 设 ${fmtK(meter.windowManual)} 被钳制为 ${fmtK(win)}`;
	if (meter.officialSource === "channel_not_reported") {
		return ` · 渠道未报官方上限${meter.windowManual ? "，按你设置生效" : "，按系统默认"}`;
	}
	if (meter.officialSource === "not_fetched") return " · 官方源尚未拉取";
	if (meter.officialSource === "channel_reported")
		return ` · 官方 ${fmtK(meter.windowOfficial)}`;
	return "";
}

function ctxPercentOf(meter, win) {
	const u = meter.usage || null;
	const used = u ? u.prompt_tokens || 0 : meter.estimatedPromptTokens || 0;
	return Math.min(100, Math.round((used / win) * 100));
}

export function ctxMeterPercent(meter) {
	if (!meter) return 0;
	return ctxPercentOf(meter, ctxWindowOf(meter));
}

export function ctxMeterText(meter) {
	if (!meter) return "上下文 — / —"; // index.html:149 初值（未拉取过上下文状态）
	const win = ctxWindowOf(meter);
	const suffix = ctxSuffixOf(meter, win);
	const u = meter.usage || null;
	if (u) {
		const used = u.prompt_tokens || 0;
		let t = `上下文 ${fmtK(used)} / ${fmtK(win)}（${ctxPercentOf(meter, win)}%）`;
		if (u.cache_hit_tokens) t += ` · 缓存命中 ${fmtK(u.cache_hit_tokens)}`;
		return t + suffix;
	}
	const est = meter.estimatedPromptTokens || 0;
	const msgs = meter.messages || {};
	let t = `上下文 ≈${fmtK(est)} / ${fmtK(win)}（${ctxPercentOf(meter, win)}%）· 活跃 ${msgs.active || 0} 条`;
	if (msgs.archived) t += ` · 已归档 ${msgs.archived} 条`;
	return t + suffix;
}

// 弹窗预览参数（:596-602）：text/content 超 1500 截断加 '…'，其余键原样
export function buildConfirmPreviewArgs(a) {
	const previewArgs = {};
	Object.keys(a || {}).forEach((k) => {
		let v = a[k];
		if (
			(k === "text" || k === "content") &&
			typeof v === "string" &&
			v.length > CONFIRM_PREVIEW_MAX
		) {
			v = `${v.slice(0, CONFIRM_PREVIEW_MAX)}…`;
		}
		previewArgs[k] = v;
	});
	return previewArgs;
}

// 目标章节处于定稿态时提供「写入后自动重新定稿」勾选（:528、:616）
export function confirmNeedsRelock(action) {
	return !!(
		action?.chapterLocked &&
		(action.name === "append_chapter" || action.name === "replace_chapter")
	);
}

// 确认弹窗正文（:603-605）：bodyHTML 字符串契约（legacy 弹窗壳 window.App.openModal），
// 转义函数由调用方注入（legacy 用 A.escapeHtml；缺省为恒等，注入面由 ChatActionCard 负责）。
export function buildConfirmBodyHTML(action, escapeHtml) {
	const esc =
		typeof escapeHtml === "function"
			? escapeHtml
			: (s) => String(s == null ? "" : s);
	const label = toolLabel(action?.name);
	const preview = buildConfirmPreviewArgs(action?.args || {});
	return (
		"<p>AI 请求执行写操作，执行后将真实改动作品数据。请确认：</p>" +
		`<p><strong>${esc(label)}</strong></p>` +
		`<pre class="action-preview">${esc(JSON.stringify(preview, null, 2))}</pre>`
	);
}
