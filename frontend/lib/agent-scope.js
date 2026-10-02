// S5-8（Plan §1.1 G1）：public/legacy/agent.js 块一「范围/剧情边界/模式」纯逻辑移植——
// 范式 A·判定 C 的「块一建设笔」，零生产切换（切换/旧文件退役归 S5-9；本片 public/** 零 diff）。
// 语义逐字对应 legacy 行号：
// - :45-50 存储键与两组范围类型常量、:94-136 范围读取/匹配/首个会话
// - :140-156 范围下拉选项模型（含「记住的书已删→回落 global 并写回」）
// - :158-178 剧情边界下拉选项模型（global 禁用）、:182-187 boundaryLabel、:188-191 modeLabel
// - :192-201 状态行四段文案、:531-547 模式按钮三态（global 下 execute→discuss 回落）
// - :212 会话空态文案、:250-252 边界章节失效回落、:570-588 会话选择器选项模型
// 纪律：零 DOM、零 fetch、零全局写入（storage 由调用方注入；lib 不读全局 localStorage）。
export const SCOPE_KEY = "agent_scope_v1";
export const CONVERSATION_KEY = "agent_conversation_v1";

// :46-49（与 server/resources/catalog.js 白名单一致：书内类型必须带 bookId；全局类型反之）
export const BOOK_SCOPED_TYPES = [
	"chapter",
	"outline",
	"character",
	"world",
	"ledger",
	"style",
	"task",
];
export const GLOBAL_SCOPED_TYPES = [
	"book",
	"style",
	"corpus",
	"task",
	"system",
];

export const SCOPE_GLOBAL_LABEL = "全局资源（跨书检索 · 只读讨论）";
export const BOUNDARY_ALL_BOOK = "全书（无时序边界）";
export const BOUNDARY_PICK_BOOK = "全书（先选一本书）";
// :212
export const CONVERSATION_EMPTY_HINT =
	"该范围还没有会话：发送一条消息或点「新会话」即会按当前范围新建（不会借用别的书或全局历史）。";

export function readSavedScope(storage) {
	try {
		const raw = storage.getItem(SCOPE_KEY);
		if (raw === "global") return { kind: "global", bookId: null };
		const m = /^book:(\d+)$/.exec(raw || "");
		if (m) return { kind: "book", bookId: Number(m[1]) };
	} catch (_e) {
		/* localStorage 不可用则退回全局（:100） */
	}
	return { kind: "global", bookId: null };
}

export function scopeKey(scope) {
	return scope.kind === "book" ? `book:${scope.bookId}` : "global";
}

export function saveScope(storage, scope) {
	try {
		storage.setItem(SCOPE_KEY, scopeKey(scope));
	} catch (_e) {
		/* 忽略（:107） */
	}
}

export function parseScopeValue(value) {
	if (value === "global") return { kind: "global", bookId: null };
	const m = /^book:(\d+)$/.exec(String(value || ""));
	return m ? { kind: "book", bookId: Number(m[1]) } : null;
}

export function currentBook(books, scope) {
	if (scope?.kind !== "book") return null;
	for (const b of books || []) {
		if (Number(b.id) === Number(scope.bookId)) return b;
	}
	return null;
}

export function scopeBookTitle(books, scope) {
	const b = currentBook(books, scope);
	// :123 逐字：非 book 范围（调用方不使用该分支）仍按 `'书籍 #' + bookId` 拼接
	return b ? b.title : `书籍 #${scope ? scope.bookId : ""}`;
}

export function conversationInScope(scope, c) {
	if (!c) return false;
	if (c.scope !== scope.kind) return false;
	if (scope.kind === "global") return true;
	return Number(c.book_id) === Number(scope.bookId);
}

export function firstConversationInScope(scope, conversations) {
	for (const c of conversations || []) {
		if (c.status !== "archived" && conversationInScope(scope, c)) return c;
	}
	return null;
}

// :140-156：首项＝全局资源（跨书检索 · 只读讨论）＋每本书《title》；
// 记住的书已不在列表 → 回落 global 并写回（changed=true 供调用方感知）。
export function scopeOptions(books, scope, storage) {
	const options = [{ value: "global", label: SCOPE_GLOBAL_LABEL }];
	for (const b of books || [])
		options.push({ value: `book:${b.id}`, label: `《${b.title}》` });
	const known = options.map((o) => o.value);
	if (known.indexOf(scopeKey(scope)) < 0) {
		const next = { kind: "global", bookId: null };
		saveScope(storage, next);
		return { options, scope: next, changed: true };
	}
	return { options, scope, changed: false };
}

// :158-178
export function boundaryOptions(scope, boundaryChapters) {
	const isBook = scope.kind === "book";
	const options = [
		{ value: "", label: isBook ? BOUNDARY_ALL_BOOK : BOUNDARY_PICK_BOOK },
	];
	if (isBook) {
		for (const ch of boundaryChapters || []) {
			const order =
				ch.meta && ch.meta.sortOrder != null ? ch.meta.sortOrder : null;
			options.push({
				value: String(ch.id),
				label: `${order != null ? `第${order}章 · ` : ""}${ch.title || `#${ch.id}`}`,
			});
		}
	}
	return { options, disabled: !isBook };
}

// :182-187
export function boundaryLabel(boundaryChapters, boundaryChapterId) {
	for (const ch of boundaryChapters || []) {
		if (Number(ch.id) === Number(boundaryChapterId))
			return `截至《${ch.title}》`;
	}
	return boundaryChapterId ? `截至章节 #${boundaryChapterId}` : "全书";
}

// :188-191
export function modeLabel(scope, mode) {
	if (scope.kind !== "book") return "只读讨论（不可写）";
	return mode === "execute" ? "执行操作（每步需确认）" : "只读讨论（不可写）";
}

// :192-201（四段以 ' · ' 连接；边界段仅书籍范围）
export function scopeStatusText({
	scope,
	books,
	currentConversation,
	boundaryChapters,
	boundaryChapterId,
	mode,
}) {
	const bits = [];
	bits.push(
		`范围：${scope.kind === "book" ? `《${scopeBookTitle(books, scope)}》` : "全局资源"}`,
	);
	bits.push(
		`会话：${currentConversation ? currentConversation.title || "未命名会话" : "未选择（发送时新建）"}`,
	);
	if (scope.kind === "book")
		bits.push(`边界：${boundaryLabel(boundaryChapters, boundaryChapterId)}`);
	bits.push(`模式：${modeLabel(scope, mode)}`);
	return bits.join(" · ");
}

// :535-547：global 恒 disabled 且 execute 回落 discuss；book 两态 label/title 逐字
export function modeButton(scope, mode) {
	const bookScope = scope.kind === "book";
	const effective = !bookScope && mode === "execute" ? "discuss" : mode;
	return {
		mode: effective,
		execute: effective === "execute",
		label: effective === "execute" ? "执行操作" : "只读讨论",
		disabled: !bookScope,
		title: bookScope
			? effective === "execute"
				? "执行操作：可发起写操作（每一步仍需作者确认）；点此切回只读讨论"
				: "只读讨论：可检索阅读不可写；点此进入执行模式"
			: "全局范围只读（找书与检索）；执行操作请把「范围」切到某一本书",
	};
}

// :570-588：'' 占位项文案随「是否已选会话」变化；选项只列当前范围
export function conversationOptions(conversations, scope, currentConversation) {
	const options = [
		{
			value: "",
			label: currentConversation ? "" : "（未选择会话 · 发送时按当前范围新建）",
		},
	];
	for (const c of conversations || []) {
		if (!conversationInScope(scope, c)) continue;
		options.push({
			value: c.id,
			label:
				(c.title || "未命名会话") +
				(c.status === "archived" ? "（已归档）" : ""),
		});
	}
	return options;
}

// :250-252：边界章节已不在（被删/换书）→ 回全书，不猜
export function resolveBoundaryChapterId(boundaryChapters, boundaryChapterId) {
	if (!boundaryChapterId) return null;
	const hit = (boundaryChapters || []).some(
		(c) => Number(c.id) === Number(boundaryChapterId),
	);
	return hit ? boundaryChapterId : null;
}
