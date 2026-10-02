// S5-7 红测 T1（Plan §4 T1）：frontend/lib/chat-session.js —— 会话存储与切换纯逻辑。
// 语义唯一事实源＝public/legacy/book-chat.js（逐例头注 legacy 行号锚点；该文件本片 git rm）。
// harness＝vitest node 环境（vite.config.mjs test.environment='node'）；零新增依赖；全注入。
import { describe, expect, it } from "vitest";
import {
	ARCHIVED_SUFFIX,
	CONV_KEY_PREFIX,
	conversationOptions,
	conversationQuery,
	convStorageKey,
	createChatSession,
	DEFAULT_CONV_OPTION_LABEL,
	NEW_CONV_OK_TOAST,
	NEW_CONV_TITLE,
	newConversationBody,
	newConversationFailToast,
	UNNAMED_CONV_LABEL,
} from "./chat-session.js";

function memoryStorage(initial) {
	const map = new Map(Object.entries(initial || {}));
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		_map: map,
	};
}

function harness(opts) {
	const o = opts || {};
	const calls = [];
	const toasts = [];
	const state = { bookId: o.bookId === undefined ? 7 : o.bookId };
	const storage = o.storage || memoryStorage();
	const apiImpl = o.api || (async () => ({}));
	const session = createChatSession({
		getBookId: () => state.bookId,
		storage,
		api: async (method, path, body) => {
			calls.push({ method, path, body });
			return apiImpl(method, path, body);
		},
		toast: (m) => toasts.push(m),
		loadChat: () => {
			calls.push({ method: "LOAD_CHAT" });
			return o.loadChat ? o.loadChat() : undefined;
		},
		refreshCtxMeter: () => {
			calls.push({ method: "REFRESH_CTX" });
		},
		onConversations: (list) => {
			calls.push({ method: "ON_CONVERSATIONS", list });
		},
	});
	return { session, calls, toasts, storage, state };
}

describe("T1 chat-session（legacy :1-63）", () => {
	it("T1-1 convStorageKey/当前会话 id：前缀逐字、无书 null、storage 抛错容错（:8-15）", () => {
		expect(CONV_KEY_PREFIX).toBe("writing_conversation_");
		expect(convStorageKey(7)).toBe("writing_conversation_7");
		expect(convStorageKey(undefined)).toBe("writing_conversation_");
		const h = harness({
			storage: memoryStorage({ writing_conversation_7: "conv-1" }),
		});
		expect(h.session.currentConversationId()).toBe("conv-1");
		h.state.bookId = null;
		expect(h.session.currentConversationId()).toBe(null);
		// storage 抛错（隐私模式）→ null，不抛
		const boom = {
			getItem() {
				throw new Error("SecurityError");
			},
			setItem() {
				throw new Error("SecurityError");
			},
			removeItem() {
				throw new Error("SecurityError");
			},
		};
		const h2 = harness({ storage: boom });
		expect(h2.session.currentConversationId()).toBe(null);
		expect(() => h2.session.rememberConversation("x")).not.toThrow();
		expect(() => h2.session.rememberConversation(null)).not.toThrow();
	});

	it("T1-2 rememberConversation：写/删 + 每次调用都触发一次会话栏刷新（:16-22）", async () => {
		const h = harness();
		await h.session.rememberConversation("conv-9");
		expect(h.storage.getItem("writing_conversation_7")).toBe("conv-9");
		expect(h.calls.filter((c) => c.method === "ON_CONVERSATIONS").length).toBe(
			1,
		);
		await h.session.rememberConversation(null);
		expect(h.storage.getItem("writing_conversation_7")).toBe(null);
		expect(h.calls.filter((c) => c.method === "ON_CONVERSATIONS").length).toBe(
			2,
		);
	});

	it("T1-3 conversationQuery：空 → ''；有值 → ?conversationId=<encodeURIComponent>（:60-63）", () => {
		const h = harness();
		expect(h.session.conversationQuery()).toBe("");
		expect(conversationQuery(null)).toBe("");
		h.storage.setItem("writing_conversation_7", "a b/c");
		expect(h.session.conversationQuery()).toBe("?conversationId=a%20b%2Fc");
		expect(conversationQuery("a b/c")).toBe("?conversationId=a%20b%2Fc");
	});

	it("T1-4 会话列表→选项映射：默认项恒首、未命名兜底、已归档后缀、选中匹配（:32-44）", () => {
		expect(DEFAULT_CONV_OPTION_LABEL).toBe("（默认：历史对话）");
		expect(UNNAMED_CONV_LABEL).toBe("未命名会话");
		expect(ARCHIVED_SUFFIX).toBe("（已归档）");
		const opts = conversationOptions(
			[
				{ id: "c1", title: "新写作任务", status: "active" },
				{ id: "c2", title: "", status: "archived" },
			],
			"c2",
		);
		expect(opts.map((o) => o.value)).toEqual(["", "c1", "c2"]);
		expect(opts.map((o) => o.label)).toEqual([
			"（默认：历史对话）",
			"新写作任务",
			"未命名会话（已归档）",
		]);
		expect(opts.map((o) => !!o.selected)).toEqual([false, false, true]);
		const none = conversationOptions([], null);
		expect(none).toEqual([
			{ value: "", label: "（默认：历史对话）", selected: true },
		]);
	});

	it("T1-5 switchConversation 调用序：rememberConversation → loadChat → refreshCtxMeter（:46-50）", async () => {
		const h = harness();
		await h.session.switchConversation("conv-3");
		expect(h.calls.map((c) => c.method)).toEqual([
			"GET", // rememberConversation 内的会话栏刷新（:21 renderConversationBar）
			"ON_CONVERSATIONS",
			"LOAD_CHAT",
			"REFRESH_CTX",
		]);
		expect(h.storage.getItem("writing_conversation_7")).toBe("conv-3");
		// 传空值＝回默认会话（rememberConversation(id || null)）
		h.calls.length = 0;
		await h.session.switchConversation("");
		expect(h.storage.getItem("writing_conversation_7")).toBe(null);
		expect(h.calls.map((c) => c.method)).toEqual([
			"GET",
			"ON_CONVERSATIONS",
			"LOAD_CHAT",
			"REFRESH_CTX",
		]);
	});

	it("T1-6 newWritingConversation：POST body 逐字 + 记住新会话 + toast 逐字（:51-59）", async () => {
		const h = harness({
			api: async (_method, _path) => ({ id: "conv-new", kind: "writing" }),
		});
		await h.session.newWritingConversation();
		expect(h.calls[0]).toEqual({
			method: "POST",
			path: "/api/conversations",
			body: {
				kind: "writing",
				scope: "book",
				bookId: 7,
				title: NEW_CONV_TITLE,
			},
		});
		expect(NEW_CONV_TITLE).toBe("新写作任务");
		expect(h.storage.getItem("writing_conversation_7")).toBe("conv-new");
		expect(h.calls.some((c) => c.method === "LOAD_CHAT")).toBe(true);
		expect(h.toasts).toEqual([NEW_CONV_OK_TOAST]);
		expect(NEW_CONV_OK_TOAST).toBe(
			"已开始新写作会话（原会话历史保留，可从切换器回到）",
		);
	});

	it("T1-7 newWritingConversation 失败：toast「新会话创建失败：<msg>」且不切会话（:58）", async () => {
		const h = harness({
			api: async () => {
				throw new Error("磁盘暂不可用");
			},
		});
		await h.session.newWritingConversation();
		expect(h.toasts).toEqual(["新会话创建失败：磁盘暂不可用"]);
		expect(newConversationFailToast("x")).toBe("新会话创建失败：x");
		expect(h.storage.getItem("writing_conversation_7")).toBe(null);
		expect(h.calls.some((c) => c.method === "LOAD_CHAT")).toBe(false);
		// 无书：不发请求、不 toast（:52）
		const h2 = harness({ bookId: null });
		await h2.session.newWritingConversation();
		expect(h2.calls).toEqual([]);
		expect(h2.toasts).toEqual([]);
	});

	it("T1-8 会话栏刷新：GET /api/conversations?kind=writing&bookId=<id>；失败空列表；无书零请求（:24-30）", async () => {
		const h = harness({
			api: async () => [{ id: "c1", title: "任务一" }],
		});
		const list = await h.session.refreshConversations();
		expect(h.calls[0]).toEqual({
			method: "GET",
			path: "/api/conversations?kind=writing&bookId=7",
			body: undefined,
		});
		expect(list.map((c) => c.id)).toEqual(["c1"]);
		expect(h.calls.filter((c) => c.method === "ON_CONVERSATIONS").length).toBe(
			1,
		);
		// api 失败 → 空列表（:30）
		const h2 = harness({
			api: async () => {
				throw new Error("boom");
			},
		});
		expect(await h2.session.refreshConversations()).toEqual([]);
		expect(h2.calls.filter((c) => c.method === "ON_CONVERSATIONS").length).toBe(
			1,
		);
		expect(h2.calls.find((c) => c.method === "ON_CONVERSATIONS").list).toEqual(
			[],
		);
		// 无书 → 零请求、零通知（:26）
		const h3 = harness({ bookId: null });
		expect(await h3.session.refreshConversations()).toEqual([]);
		expect(h3.calls).toEqual([]);
	});

	it("T1-9 bookApiPath：书内相对包装逐字（:277-279）", () => {
		const h = harness();
		expect(h.session.bookApiPath("/chat?conversationId=x")).toBe(
			"/api/books/7/chat?conversationId=x",
		);
		expect(h.session.bookApiPath("/context-status")).toBe(
			"/api/books/7/context-status",
		);
		expect(newConversationBody(7)).toEqual({
			kind: "writing",
			scope: "book",
			bookId: 7,
			title: "新写作任务",
		});
	});
});
