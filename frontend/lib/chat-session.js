// S5-7（Plan §1.1 G1）：public/legacy/book-chat.js :1-63 会话存储与切换纯逻辑移植。
// 语义逐字对应 legacy 行号：:8-15 convStorageKey/currentConversationId（含 storage 抛错容错）、
// :16-22 rememberConversation（写/删 + 每次触发一次会话栏刷新）、:24-44 renderConversationBar
// （→ refreshConversations + conversationOptions 映射）、:46-50 switchConversation 调用序、
// :51-59 newWritingConversation（POST body 与 toast 逐字、失败不切会话）、:60-63 conversationQuery、
// :277-279 书内相对 api 包装（bookApiPath）。
// 纪律：零 DOM、零全局读取；storage/api/toast/loadChat/refreshCtxMeter/onConversations 全部注入。
export const CONV_KEY_PREFIX = "writing_conversation_";
export const DEFAULT_CONV_OPTION_LABEL = "（默认：历史对话）";
export const UNNAMED_CONV_LABEL = "未命名会话";
export const ARCHIVED_SUFFIX = "（已归档）";
export const NEW_CONV_TITLE = "新写作任务";
export const NEW_CONV_OK_TOAST =
	"已开始新写作会话（原会话历史保留，可从切换器回到）";

// :8-10（无书时 S.currentBook 为空 ⇒ 键退化为前缀本身）
export function convStorageKey(bookId) {
	return CONV_KEY_PREFIX + (bookId == null ? "" : String(bookId));
}

// :60-63
export function conversationQuery(conversationId) {
	return conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
}

// :32-44 会话列表 → 选项模型（默认项恒首、未命名兜底、已归档后缀、选中匹配）
export function conversationOptions(list, currentId) {
	const cur = currentId == null ? "" : String(currentId);
	const options = [
		{ value: "", label: DEFAULT_CONV_OPTION_LABEL, selected: cur === "" },
	];
	for (const conv of Array.isArray(list) ? list : []) {
		const value = String(conv.id);
		options.push({
			value,
			label:
				(conv.title || UNNAMED_CONV_LABEL) +
				(conv.status === "archived" ? ARCHIVED_SUFFIX : ""),
			selected: value === cur,
		});
	}
	return options;
}

// :54
export function newConversationBody(bookId) {
	return { kind: "writing", scope: "book", bookId, title: NEW_CONV_TITLE };
}

// :58
export function newConversationFailToast(message) {
	return `新会话创建失败：${message}`;
}

// :277-279 书内相对包装
export function bookApiPath(bookId, path) {
	return `/api/books/${bookId}${path}`;
}

export function createChatSession(deps) {
	const d = deps || {};
	const getBookId = d.getBookId || (() => null);
	const storage =
		d.storage || (typeof localStorage !== "undefined" ? localStorage : null);
	const api = d.api || (() => Promise.resolve({}));
	const toast = d.toast || (() => {});
	const loadChat = d.loadChat || (() => Promise.resolve());
	const refreshCtxMeter = d.refreshCtxMeter || (() => {});
	const onConversations = d.onConversations || (() => {});

	// :12-15（缺书 null；storage 不可用容错）
	function currentConversationId() {
		const bookId = getBookId();
		if (!bookId) return null;
		try {
			return storage.getItem(convStorageKey(bookId)) || null;
		} catch (_e) {
			return null;
		}
	}

	// :24-30 会话栏数据源（GET 失败 → 空列表）
	async function refreshConversations() {
		const bookId = getBookId();
		if (!bookId) return [];
		let list = [];
		try {
			list = await api(
				"GET",
				`/api/conversations?kind=writing&bookId=${bookId}`,
			);
		} catch (_e) {
			list = [];
		}
		const out = Array.isArray(list) ? list : [];
		onConversations(out);
		return out;
	}

	// :16-22 写/删 + 会话栏刷新（刷新是异步的：调用方按需 await）
	function rememberConversation(id) {
		const bookId = getBookId();
		try {
			if (id) storage.setItem(convStorageKey(bookId), id);
			else storage.removeItem(convStorageKey(bookId));
		} catch (_e) {
			/* 忽略 */
		}
		return refreshConversations();
	}

	// :46-50
	async function switchConversation(id) {
		await rememberConversation(id || null);
		await loadChat();
		refreshCtxMeter();
	}

	// :51-59
	async function newWritingConversation() {
		const bookId = getBookId();
		if (!bookId) return;
		try {
			const conv = await api(
				"POST",
				"/api/conversations",
				newConversationBody(bookId),
			);
			await rememberConversation(conv.id);
			await loadChat();
			toast(NEW_CONV_OK_TOAST);
		} catch (e) {
			// 失败不切会话（:58）
			toast(newConversationFailToast(e?.message));
		}
	}

	return {
		convStorageKey: () => convStorageKey(getBookId()),
		currentConversationId,
		rememberConversation,
		conversationQuery: () => conversationQuery(currentConversationId()),
		bookApiPath: (path) => bookApiPath(getBookId(), path),
		refreshConversations,
		switchConversation,
		newWritingConversation,
	};
}
