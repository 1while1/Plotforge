// @vitest-environment jsdom
// S5-7 红测 T5（Plan §4 T5，T5-1~T5-14）：ChatWorkspace 装配与挂载（原位接管 #page-book .panel-chat）。
// 语义唯一事实源＝public/legacy/book-chat.js 块三（逐例头注行号锚点；该文件本片 git rm）＋
// S5-5/S5-6 冻结契约（ChatPanel props／useChatTransport 注入面）。
// harness＝jsdom＋React 19 act（经 ensureMounted 的真实挂载路径）＋裸 DOM 断言；
// 静态壳从 frontend/index.html 真实文本提取（单一事实源，禁复制粘贴；P6-3 源迁入）；网络全注入。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { mount as mountChatJumpBottom } from "../components/ChatJumpBottom.jsx";
import { chatApi, ensureMounted } from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "../lib/app-runtime.js";
import { handoffMaterial, handoffTitle } from "../lib/chat-handoff.js";

// P6-2 转写（Plan §2.4 T-F）：三处 window 桩面改承接模块——
//   · App→`setAppForTests(window.App)`（§2.5-D1 单例注入缝）；
//   · RunStatus→`lib/run-status.js` 模块 mock，harness 假体经 holder 注入
//     （`noRS` 变体＝holder 置 null，等值原 `window.RunStatus = undefined`）；
//   · BookPage→`chapterEditorApi()`（NULL 占位面单例）上的 spy 面，断言对象与次数逐条不变。
const rsHolder = vi.hoisted(() => ({ current: null }));
vi.mock("../lib/run-status.js", () => ({
	get runStatus() {
		return rsHolder.current;
	},
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);

// 静态壳提取（index.html:136-168 逐字；单一事实源）
function chatSection() {
	const start = INDEX_HTML.indexOf('<section class="panel panel-chat">');
	const end = INDEX_HTML.indexOf("</section>", start) + "</section>".length;
	return INDEX_HTML.slice(start, end);
}

const BOOK = { id: 7, title: "雾港编年史", mode: "collab" };
const CHAPTER_ID = 12;
const CONV_ID = "conv-writing-1";
const SELECTED = "这是作者明确选中的一段文字。";
const HANDOFF = `【来自 Agent 讨论·显式交接】来源会话：整体讨论（conv-origin-01）
摘要
来源引用：规划笔记 #n-1 revision 2`;
const CHAT_URL = `/api/books/7/chat?conversationId=${CONV_ID}`;
const WORLD_URL = "/api/books/7/world";
const CHARS_URL = "/api/books/7/characters";

function shell() {
	return (
		'<div id="page-book"><div id="book-workbench" class="workbench resizable">' +
		'<aside class="panel panel-left" id="panel-left">' +
		'<div id="tab-world"><button id="btn-add-world" class="btn btn-small">+ 新建</button><ul id="world-list" class="item-list"></ul></div>' +
		'<div id="tab-characters"><button id="btn-add-character" class="btn btn-small">+ 新建</button><ul id="character-list" class="item-list"></ul></div>' +
		"</aside>" +
		chatSection() +
		'<input id="chapter-title-input" value="第1章 石碑"><textarea id="chapter-content"></textarea><span id="word-count" class="word-count"></span>' +
		"</div></div>"
	);
}

function sseResponse(frames) {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const f of frames)
					controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

// ---------- harness ----------
let h = null;

function makeHarness(opts) {
	const o = opts || {};
	const log = [];
	const requests = [];
	const toasts = [];
	const modals = [];
	const state = {
		bookId: BOOK.id,
		chapterId: CHAPTER_ID,
		visible: true,
		dirty: false,
	};
	let fetchImpl =
		o.fetchImpl || (() => Promise.reject(new Error("测试未装 fetch 桩")));
	let lastInit = null;
	let obsNext = { changed: false, first: false, previous: null, current: null };
	let cardOptions = null;
	const rs = {
		RESOURCE_BADGE: "资料更新",
		cardModel(input) {
			log.push("RS:cardModel");
			// 等值 run-status.js:326-353：恒回模型对象（无 run 时 badge 为 null，但仍带 resourceNotice）
			const i = input || {};
			return {
				badge: i.run ? "已暂停" : null,
				resourceNotice: i.resourceNotice || null,
				input: i,
			};
		},
		mountTaskCard(host, model, options) {
			log.push("RS:mountTaskCard");
			cardOptions = options;
			if (host) {
				const notice = model ? model.resourceNotice : null;
				host.textContent = model
					? [
							model.badge,
							notice ? `${notice.badge} · ${notice.detail}` : null,
							...(notice?.actions || []).map((a) => a.label),
						]
							.filter(Boolean)
							.join(" | ")
					: "";
				host.classList.toggle("hidden", !model);
			}
			return host;
		},
		async loadPersistence() {
			log.push("RS:loadPersistence");
		},
		runFromMessages(messages) {
			log.push("RS:runFromMessages");
			return messages?.length
				? { status: "paused", reason: "output_truncated" }
				: null;
		},
		applyResourceRefresh(opt) {
			log.push("RS:applyResourceRefresh");
			// 等值 run-status.js:232-244：干净时才走 reload（脏稿只回 hint）
			if (!opt.dirty && typeof opt.reload === "function") opt.reload();
			return {
				applied: !opt.dirty,
				hint: opt.dirty ? "请先保存或复制未保存的正文" : "",
			};
		},
		observeResource(key) {
			log.push(`RS:observeResource:${key}`);
			return obsNext;
		},
		createWatcher(cfg) {
			log.push(`RS:createWatcher:${cfg.intervalMs}`);
			const w = {
				cfg,
				started: false,
				stops: 0,
				start() {
					this.started = true;
				},
				stop() {
					this.stops += 1;
				},
				stopped() {
					return this.stops > 0;
				},
			};
			watchers.push(w);
			return w;
		},
		onVisibilityChange() {},
		renderWritingSaveBadge() {},
	};
	const watchers = [];

	const routes = o.routes || {};
	async function api(method, url, body) {
		log.push(`api:${method} ${url}`);
		requests.push({ method, url, body });
		// 先精确键，再前缀键（部分用例按前缀覆盖）
		if (routes[`${method} ${url}`]) return routes[`${method} ${url}`](body);
		for (const k of Object.keys(routes)) {
			const [m, prefix] = k.split(" ");
			if (m === method && prefix !== url && url.indexOf(prefix) === 0)
				return routes[k](body);
		}
		if (url === CHAT_URL) return { conversationId: CONV_ID, messages: [] };
		if (url === "/api/books/7/chat/actions") return { actions: [] };
		if (url.indexOf("/api/resources?type=chapter") === 0)
			return {
				resource: {
					id: CHAPTER_ID,
					title: "第1章 石碑",
					meta: { revision: 4 },
				},
			};
		if (url.indexOf("/api/conversations?kind=writing") === 0)
			return [{ id: CONV_ID, title: "新写作任务", status: "active" }];
		if (url.indexOf("/api/books/7/context-status") === 0)
			return {
				contextWindow: 128000,
				estimatedPromptTokens: 12800,
				messages: { active: 2, archived: 0 },
				officialSource: "channel_reported",
				windowOfficial: 128000,
			};
		if (url.indexOf("/api/books/7/context-breakdown") === 0)
			return {
				window: 128000,
				system: { total: 1000, budget: 5000, parts: [] },
				history: { chatTokens: 2000, toolTokens: 100 },
				schema: 300,
				outputReserve: 4000,
				estimatedPrompt: 3400,
				officialSource: "channel_reported",
				windowOfficial: 128000,
			};
		if (url.indexOf(WORLD_URL) === 0)
			return {
				entries: [
					{ id: 3, title: "北境", content: "风雪与石碑的世界观说明文本" },
				],
			};
		if (url.indexOf(CHARS_URL) === 0)
			return { characters: [{ id: 5, name: "林昭", role: "主角" }] };
		if (url.indexOf("/api/conversations?kind=agent") === 0)
			return [
				{ id: "conv-origin-01", scope: "book", book_id: 7, title: "整体讨论" },
			];
		if (url === "/api/conversations" && method === "POST")
			return { id: "conv-agent-draft", kind: "agent" };
		if (url.indexOf("/api/conversations/conv-agent-draft/messages") === 0)
			return { ok: true };
		return {};
	}

	function openModal(cfg) {
		log.push(`modal:${cfg.title}`);
		modals.push(cfg);
		const body = document.createElement("div");
		body.id = "modal-body";
		const ids = [...String(cfg.bodyHTML || "").matchAll(/id="([^"]+)"/g)].map(
			(m) => m[1],
		);
		for (const id of ids) {
			let el;
			if (/preview/.test(id)) el = document.createElement("pre");
			else if (/character/.test(id)) el = document.createElement("select");
			else el = document.createElement("input");
			el.id = id;
			if (el.tagName === "INPUT" && /quote/.test(id)) el.checked = true;
			if (el.tagName === "SELECT") {
				const blank = document.createElement("option");
				blank.value = "";
				el.appendChild(blank);
				const opt = document.createElement("option");
				opt.value = "5";
				opt.textContent = "林昭";
				el.appendChild(opt);
			}
			body.appendChild(el);
		}
		const old = document.getElementById("modal-body");
		if (old) old.remove();
		document.body.appendChild(body);
		return { body };
	}

	window.App = {
		state: {
			currentBook: BOOK,
			currentChapterId: state.chapterId,
			get currentChapterIdRef() {
				return null;
			},
		},
		api,
		toast: (m) => toasts.push(String(m)),
		escapeHtml: (s) =>
			String(s == null ? "" : s).replace(
				/[&<>"']/g,
				(c) =>
					({
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#39;",
					})[c],
			),
		openModal,
		closeModal() {},
	};
	window.RunStatus = o.noRS ? undefined : rs;
	// P6-2 转写：RS 经模块 holder 注入；编辑器面＝`chapterEditorApi()`（未挂载时 NULL 占位面单例）
	// 上的 spy 面——旧 `window.BookPage` 桩的 8 名控制面逐条对应（日志标签 `BookPage:*` → `editorApi:*`）
	rsHolder.current = o.noRS ? null : rs;
	setAppForTests(window.App);
	const editorApi = chapterEditorApi();
	vi.spyOn(editorApi, "hasUnsavedChanges").mockImplementation(
		() => state.dirty,
	);
	vi.spyOn(editorApi, "clearUnsaved").mockImplementation(() => {});
	vi.spyOn(editorApi, "leaveGuard").mockResolvedValue(true);
	vi.spyOn(editorApi, "loadChapters").mockImplementation(() => {
		log.push("editorApi:loadChapters");
	});
	vi.spyOn(editorApi, "selectChapter").mockImplementation(async (id) => {
		log.push(`editorApi:selectChapter:${id}`);
		return true;
	});
	globalThis.fetch = (url, init) => {
		lastInit = init;
		requests.push({
			method: init?.method || "GET",
			url: String(url),
			body: init?.body,
		});
		return fetchImpl(url, init);
	};

	return {
		log,
		requests,
		toasts,
		modals,
		state,
		rs,
		watchers,
		editorApi,
		get lastInit() {
			return lastInit;
		},
		get cardOptions() {
			return cardOptions;
		},
		get savedReturn() {
			// P6-2 转写：返回锚写入已改 BookShell 导出直取 ⇒ 观察点＝真实副作用
			// （sessionStorage 键 `novel-writing-return`；值形状与旧桩记录的 target 逐字相同）
			try {
				return JSON.parse(sessionStorage.getItem("novel-writing-return"));
			} catch (_e) {
				return null;
			}
		},
		set obs(v) {
			obsNext = v;
		},
		setFetch(fn) {
			fetchImpl = fn;
		},
		node: (id) => document.getElementById(id),
		panel: () => document.querySelector("#page-book .panel-chat"),
		wrap: () => document.querySelector(".chat-scroll-wrap"),
		bubbles: () =>
			[...document.querySelectorAll("#chat-messages .msg-bubble")].map(
				(n) => n.textContent,
			),
		async waitFor(pred, label, ms) {
			const t0 = Date.now();
			for (;;) {
				if (pred()) return true;
				if (Date.now() - t0 > (ms || 1500))
					throw new Error(
						`等待超时：${label || "条件未满足"}｜toast=${JSON.stringify(toasts.slice(-3))}｜请求=${JSON.stringify(requests.slice(-5).map((r) => `${r.method} ${r.url}`))}`,
					);
				await new Promise((r) => setTimeout(r, 5));
			}
		},
	};
}

// 重置 DOM 与桩后按真实挂载路径装配
function reset(opts) {
	document.body.innerHTML = shell();
	h = makeHarness(opts);
	return h;
}

function mountWorkspace() {
	act(() => {
		ensureMounted();
	});
	return chatApi();
}

async function loadChat() {
	await act(async () => {
		await chatApi().loadChat();
	});
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	localStorage.setItem("writing_conversation_7", CONV_ID);
	reset();
	window.confirm = vi.fn(() => true);
});

afterEach(() => {
	document.body.innerHTML = "";
	setAppForTests(null);
	rsHolder.current = null;
	delete window.App;
	delete window.RunStatus;
	delete window.BookPage;
	delete globalThis.fetch;
	delete window.confirm;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("T5 ChatWorkspace（legacy 块三）", () => {
	it("T5-1 初始渲染＝index.html:136-168 逐字（首项/七入口/仪表初值/placeholder），无重复 id", () => {
		const api = mountWorkspace();
		expect(typeof api.loadChat).toBe("function");
		const panel = h.panel();
		expect(panel).not.toBeNull();
		expect(panel.className).toBe("panel panel-chat");
		expect(panel.parentElement.id).toBe("book-workbench");
		expect(panel.querySelector(".pane-title").textContent).toBe("写作助手");
		const sel = h.node("writing-conversation-select");
		expect(
			[...sel.querySelectorAll("option")].map((o) => o.textContent),
		).toEqual(["（默认：历史对话）"]);
		for (const id of [
			"btn-new-writing-conv",
			"btn-open-agent-discuss",
			"btn-clear-chat",
			"btn-ctx-detail",
			"btn-compress",
			"btn-consult",
			"btn-send",
		])
			expect(h.node(id), id).not.toBeNull();
		expect(h.node("ctx-text").textContent).toBe("上下文 — / —");
		expect(h.node("chat-text").placeholder).toBe(
			"和 AI 聊聊剧情，或让它续写正文…（Ctrl+Enter 发送）",
		);
		expect(document.querySelectorAll("#chat-text").length).toBe(1);
		expect(document.querySelectorAll("#chat-messages").length).toBe(1);
		expect(document.querySelectorAll(".panel-chat").length).toBe(1);
		// run 卡是叶容器：React 不写内容、class 固定 hidden（内容只由 RunStatus.mountTaskCard 写）
		expect(h.node("writing-run-card").className).toBe("run-card hidden");
		expect(h.node("writing-run-card").children.length).toBe(0);
	});

	it("T5-2 bindChatEvents → loadChat 编排调用序（:1583-1653）", async () => {
		mountWorkspace();
		await act(async () => {
			await chatApi().bindChatEvents();
		});
		await loadChat();
		const seq = h.log.filter(
			(x) =>
				x.startsWith("api:") ||
				x === "RS:runFromMessages" ||
				x === "RS:loadPersistence" ||
				x === "RS:cardModel" ||
				x === "RS:mountTaskCard" ||
				x.startsWith("RS:observeResource") ||
				x.startsWith("RS:createWatcher"),
		);
		expect(seq).toEqual([
			`api:GET ${CHAT_URL}`,
			"api:GET /api/books/7/chat/actions",
			"RS:runFromMessages",
			"RS:loadPersistence",
			`api:GET /api/resources?type=chapter&bookId=7&id=${CHAPTER_ID}`,
			`RS:observeResource:writing_resource:7:${CHAPTER_ID}`,
			"RS:cardModel",
			"RS:mountTaskCard",
			"RS:createWatcher:8000",
			"api:GET /api/conversations?kind=writing&bookId=7",
			`api:GET /api/books/7/context-status?conversationId=${CONV_ID}`,
		]);
		// data.conversationId 与服务端不一致时先 rememberConversation（:1588-1590）
		reset({
			routes: {
				"GET /api/books/7/chat": () => ({
					conversationId: "conv-server-2",
					messages: [],
				}),
			},
		});
		mountWorkspace();
		await loadChat();
		expect(localStorage.getItem("writing_conversation_7")).toBe(
			"conv-server-2",
		);
		expect(h.log.indexOf("api:GET /api/books/7/chat")).toBeLessThan(
			h.log.indexOf("RS:runFromMessages"),
		);
	});

	it("T5-3 回放：pending 同参只留最新、结算卡挂锚点消息、unplaced 不渲染（:1615-1640）", async () => {
		reset({
			routes: {
				[`GET ${CHAT_URL}`]: () => ({
					conversationId: CONV_ID,
					messages: [
						{
							id: 1,
							role: "assistant",
							content:
								'此前你请求执行的写工具 add_worldview。\n[确认执行结果·系统事件] {"title":"北境"}',
							created_at: "2026-09-28 01:00:00",
							run: null,
						},
					],
				}),
				"GET /api/books/7/chat/actions": () => ({
					actions: [
						{
							id: "a-old",
							name: "add_worldview",
							args: { title: "北境" },
							status: "pending",
							createdAt: 1,
						},
						{
							id: "a-new",
							name: "add_worldview",
							args: { title: "北境" },
							status: "pending",
							createdAt: 2,
						},
						{
							id: "a-settled",
							name: "add_worldview",
							args: { title: "北境" },
							status: "approved",
							createdAt: 3,
							settledAt: Date.parse("2026-09-28T01:00:00"),
						},
						{
							id: "a-unplaced",
							name: "set_master_outline",
							args: {},
							status: "approved",
							createdAt: 4,
							settledAt: Date.parse("2020-01-01T00:00:00"),
						},
					],
				}),
			},
		});
		mountWorkspace();
		await loadChat();
		const cards = [...document.querySelectorAll("#chat-messages .msg-action")];
		expect(cards.length).toBe(1); // 同参 pending 只留最新一张
		const logs = [
			...document.querySelectorAll("#chat-messages .msg-action-log"),
		];
		expect(logs.length).toBe(1); // 结算卡收编为锚点消息下的留痕行（unplaced 不渲染）
		const anchorMsg = logs[0].closest(".msg");
		expect(anchorMsg).not.toBeNull();
		expect(anchorMsg.contains(logs[0])).toBe(true);
		expect(anchorMsg.querySelector(".msg-bubble").textContent).toContain(
			"确认执行结果",
		);
	});

	it("T5-4 composer：submit→sendText、Ctrl+Enter、发送三态、提交清空、外部写值+input 事件（:1048-1090、:1904-1909）", async () => {
		mountWorkspace();
		let releaseStream = null;
		h.setFetch(
			() =>
				new Promise((resolve) => {
					releaseStream = () =>
						resolve(
							sseResponse([
								{ type: "content", text: "收到" },
								{ type: "done", content: "收到", run: { status: "finished" } },
							]),
						);
				}),
		);
		const text = h.node("chat-text");
		const send = h.node("btn-send");
		expect(send.textContent).toBe("发送");
		expect(send.disabled).toBe(false);
		// 外部写值 + input 事件（FocusModeOverlay.jsx:177-190 注入链）→ 受控 textarea 状态同步
		// 等值真实时序：命令式写值与随后的提交是两拍，中间必有一次 React 提交（故包在 act 内）
		await act(async () => {
			text.value = "外部写入的正文";
			text.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(text.value).toBe("外部写入的正文");
		await act(async () => {
			h.node("chat-form").dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(send.disabled).toBe(true);
		expect(send.textContent).toBe("思考中…");
		expect(text.value).toBe(""); // 提交即清空（:1057）
		expect(JSON.parse(h.lastInit.body).content).toBe("外部写入的正文");
		await act(async () => {
			releaseStream();
		});
		await h.waitFor(() => send.textContent === "发送", "发送按钮复位");
		expect(send.disabled).toBe(false);
		// Ctrl+Enter 走同一条发送路（:1904-1909）
		h.setFetch(() =>
			Promise.resolve(
				sseResponse([
					{ type: "done", content: "x", run: { status: "finished" } },
				]),
			),
		);
		await act(async () => {
			text.value = "快捷键发送";
			text.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const keyEv = new KeyboardEvent("keydown", {
			key: "Enter",
			ctrlKey: true,
			cancelable: true,
			bubbles: true,
		});
		await act(async () => {
			text.dispatchEvent(keyEv);
		});
		expect(keyEv.defaultPrevented).toBe(true);
		expect(
			h.requests.filter((r) => r.url === "/api/books/7/chat/stream").length,
		).toBe(2);
		// 参谋态：按钮/表单/placeholder 三态（:1866-1878）
		await act(async () => {
			h.node("btn-consult").click();
		});
		expect(h.node("btn-consult").className).toBe("consult-pill mode-on");
		expect(h.node("chat-form").className).toBe(
			"chat-input chat-composer consult-on",
		);
		expect(h.node("chat-text").placeholder).toBe(
			"向参谋提问：剧情走向、人物行为、大纲建议…",
		);
	});

	it("T5-5 讨论：离开守卫、弹窗 bodyHTML、onOk 请求序与落点，人物预览联动（:120-198）", async () => {
		h.setFetch(() => Promise.reject(new Error("讨论不得发流")));
		mountWorkspace();
		h.state.dirty = true;
		h.editorApi.leaveGuard.mockImplementation(async () => false);
		await act(async () => {
			await chatApi().openAgentDiscussion();
		});
		expect(h.modals.length).toBe(0);
		h.editorApi.leaveGuard.mockImplementation(async () => true);
		const content = h.node("chapter-content");
		content.value = `前文。${SELECTED}后文。`;
		content.selectionStart = 3;
		content.selectionEnd = 3 + SELECTED.length;
		await act(async () => {
			await chatApi().openAgentDiscussion();
		});
		expect(h.modals.length).toBe(1);
		const modal = h.modals[0];
		expect(modal.title).toBe("另开整体讨论（AI 助手）");
		expect(modal.okText).toBe("前往 AI 助手");
		expect(modal.bodyHTML).toContain(SELECTED);
		expect(modal.bodyHTML).toContain("整体讨论");
		// 人物预览联动（:189-196）
		const charSel = document.getElementById("agent-discuss-character");
		const preview = document.getElementById("agent-discuss-preview");
		charSel.value = "5";
		charSel.onchange();
		expect(preview.textContent).toBe(
			handoffMaterial(
				BOOK,
				{ id: CHAPTER_ID, title: "第1章 石碑" },
				{ id: 5, name: "林昭" },
				SELECTED,
			),
		);
		h.requests.length = 0;
		let ok = null;
		await act(async () => {
			ok = await modal.onOk(document.getElementById("modal-body"));
		});
		expect(ok).toBe(true);
		expect(h.requests[0]).toEqual({
			method: "POST",
			url: "/api/conversations",
			body: {
				kind: "agent",
				scope: "book",
				bookId: 7,
				title: handoffTitle(
					BOOK,
					{ id: CHAPTER_ID, title: "第1章 石碑" },
					{ id: 5, name: "林昭" },
				),
			},
		});
		expect(h.requests[1].url).toBe(
			"/api/conversations/conv-agent-draft/messages",
		);
		expect(h.requests[1].body.source).toBe("writing");
		expect(h.requests[1].body.content).toContain("bookId=7");
		expect(localStorage.getItem("agent_scope_v1")).toBe("book:7");
		expect(localStorage.getItem("agent_conversation_v1")).toBe(
			"conv-agent-draft",
		);
		expect(h.savedReturn).toEqual({ bookId: 7, chapterId: CHAPTER_ID });
		expect(window.location.hash).toBe("#/agent");
		expect(h.toasts).toContain(
			"已在 AI 助手开启整体讨论（只带了这本书与你选中的文字）",
		);
	});

	it("T5-6 资料更新：卡片文案/两动作、脏稿不覆盖、干净重载（:1987-2040）", async () => {
		mountWorkspace();
		h.obs = {
			changed: true,
			first: false,
			previous: { revision: 3 },
			current: { revision: 4 },
		};
		await act(async () => {
			await chatApi().refreshRunStatus({});
		});
		const card = h.node("writing-run-card");
		expect(card.textContent).toContain("资料更新");
		expect(card.textContent).toContain("版本 3 → 4");
		expect(card.textContent).toContain("查看差异");
		expect(card.textContent).toContain("刷新");
		expect(card.className).toBe("run-card");
		// 点「刷新」：脏稿保留只提示
		h.state.dirty = true;
		await act(async () => {
			await h.cardOptions.onRefresh();
		});
		expect(h.toasts).toContain("请先保存或复制未保存的正文");
		expect(
			h.log.filter((x) => x.startsWith("editorApi:selectChapter")).length,
		).toBe(0);
		// 干净时真正重载当前章
		h.state.dirty = false;
		await act(async () => {
			await h.cardOptions.onRefresh();
		});
		expect(h.toasts).toContain("已按服务端版本重新加载本章");
		expect(
			h.log.filter((x) => x.startsWith("editorApi:selectChapter")).length,
		).toBe(1);
	});

	it("T5-7 运行状态：RS 缺失全静默、loadChat 后按快照渲染 run 卡（:1972-1985、:2046-2047）", async () => {
		reset({ noRS: true });
		mountWorkspace();
		await loadChat();
		expect(h.bubbles()).toEqual([]);
		expect(h.node("writing-run-card").className).toBe("run-card hidden");
		reset({
			routes: {
				[`GET ${CHAT_URL}`]: () => ({
					conversationId: CONV_ID,
					messages: [
						{
							id: 1,
							role: "assistant",
							content: "半截",
							run: { status: "paused", reason: "output_truncated" },
						},
					],
				}),
			},
		});
		mountWorkspace();
		await loadChat();
		expect(h.node("writing-run-card").textContent).toContain("已暂停");
		expect(h.bubbles()).toEqual(["半截"]);
	});

	it("T5-8 可见性：visibilitychange → setStatusPollingVisible(pageVisible())，零取消零重发（:2108-2122）", async () => {
		mountWorkspace();
		await loadChat();
		await act(async () => {
			await chatApi().refreshRunStatus({ run: { status: "running" } });
		});
		const requestsBefore = h.requests.length;
		const watchersBefore = h.watchers.length;
		const stopsBefore = h.watchers.map((w) => w.stops);
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		// 隐藏：双停、不新建、零请求
		expect(h.watchers.length).toBe(watchersBefore);
		expect(h.watchers.some((w, i) => w.stops > (stopsBefore[i] || 0))).toBe(
			true,
		);
		expect(h.requests.length).toBe(requestsBefore);
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(
			h.requests.filter((r) => r.url === "/api/books/7/chat/stream").length,
		).toBe(0);
	});

	it("T5-9 压缩/还原：弹窗四节、expectedLastMessageId、toast（:796-827）", async () => {
		let compressBody = null;
		let restoreCalled = 0;
		reset({
			routes: {
				[`GET ${CHAT_URL}`]: () => ({
					conversationId: CONV_ID,
					messages: [
						{ id: 99, role: "assistant", content: "存档摘要", compressed: 2 },
					],
				}),
				"POST /api/books/7/chat/compress": (body) => {
					compressBody = body;
					return { archived: 3 };
				},
				"POST /api/books/7/chat/compress/restore": () => {
					restoreCalled += 1;
					return { restored: 2 };
				},
			},
		});
		mountWorkspace();
		await loadChat();
		act(() => {
			h.node("btn-compress").click();
		});
		expect(h.modals.length).toBe(1);
		expect(h.modals[0].title).toBe("压缩上下文");
		expect(h.modals[0].okText).toBe("开始压缩");
		for (const s of [
			"【已确认的资料与设定】",
			"【已执行的动作与结果】",
			"【未决问题】",
			"【作者尚未采纳的设想】",
		])
			expect(h.modals[0].bodyHTML).toContain(s);
		await act(async () => {
			await h.modals[0].onOk();
		});
		expect(compressBody).toEqual({
			conversationId: CONV_ID,
			expectedLastMessageId: 99,
		});
		expect(h.toasts).toContain("已压缩 3 条早期对话");
		expect(h.toasts).toContain("正在压缩…");
		// 消息区「还原压缩前的对话」→ confirm → restore 请求 + toast（:819-827）
		const restoreBtn = [
			...document.querySelectorAll("#chat-messages button"),
		].find((b) => b.textContent === "还原压缩前的对话");
		expect(restoreBtn).toBeTruthy();
		await act(async () => {
			restoreBtn.click();
		});
		expect(window.confirm).toHaveBeenCalledWith(
			"还原全部已压缩的对话？（存档摘要将被移除）",
		);
		expect(restoreCalled).toBe(1);
		expect(h.toasts).toContain("已还原 2 条归档对话");
	});

	it("T5-10 清空：confirm 文案逐字、DELETE 带会话 query、取消零请求（:1912-1921）", async () => {
		mountWorkspace();
		await loadChat();
		h.requests.length = 0;
		window.confirm = vi.fn(() => false);
		act(() => {
			h.node("btn-clear-chat").click();
		});
		expect(h.requests.length).toBe(0);
		window.confirm = vi.fn(() => true);
		await act(async () => {
			h.node("btn-clear-chat").click();
		});
		expect(window.confirm).toHaveBeenCalledWith(
			"清空当前会话的对话记录？（同书其他写作会话不受影响）",
		);
		expect(h.requests[0]).toEqual({
			method: "DELETE",
			url: CHAT_URL,
			body: undefined,
		});
		expect(
			h.requests.filter((r) => r.method === "GET" && r.url === CHAT_URL).length,
		).toBe(1); // 清空后重拉
	});

	it("T5-11 交接行：来源按钮＋引用 details、点击落点键/返回锚/hash/toast；普通消息不误伤（:223-275）", async () => {
		reset({
			routes: {
				[`GET ${CHAT_URL}`]: () => ({
					conversationId: CONV_ID,
					messages: [
						{ id: 1, role: "assistant", content: HANDOFF },
						{ id: 2, role: "assistant", content: "普通消息" },
					],
				}),
			},
		});
		mountWorkspace();
		await loadChat();
		const buttons = [
			...document.querySelectorAll("#chat-messages button"),
		].filter((b) => b.textContent === "查看来源讨论");
		expect(buttons.length).toBe(1);
		const details = document.querySelector(
			"#chat-messages details.msg-handoff-refs",
		);
		expect(details.querySelector("summary").textContent).toBe(
			"来源与引用（1）",
		);
		expect(details.querySelector("pre").textContent).toContain(
			"规划笔记 #n-1 revision 2",
		);
		expect(document.querySelector("#chat-messages").textContent).not.toContain(
			"NaN",
		);
		await act(async () => {
			buttons[0].click();
		});
		expect(localStorage.getItem("agent_scope_v1")).toBe("book:7");
		expect(localStorage.getItem("agent_conversation_v1")).toBe(
			"conv-origin-01",
		);
		expect(h.savedReturn).toEqual({ bookId: 7, chapterId: CHAPTER_ID });
		expect(window.location.hash).toBe("#/agent");
		expect(h.toasts).toContain("已跳到来源讨论（来源与引用见消息下方）");
	});

	it("T5-12 编辑器桥：快捷回复走 sendText(label)、插入当前章逐字、无章提示（:963-973、:1004-1010）", async () => {
		reset({
			routes: {
				[`GET ${CHAT_URL}`]: () => ({
					conversationId: CONV_ID,
					messages: [
						{
							id: 1,
							role: "assistant",
							content: "【需要确认】\n1. 接下来怎么写？（续写／改大纲）",
						},
					],
				}),
			},
		});
		mountWorkspace();
		await loadChat();
		h.setFetch(() =>
			Promise.resolve(
				sseResponse([
					{ type: "done", content: "好", run: { status: "finished" } },
				]),
			),
		);
		const quick = [...document.querySelectorAll(".quick-replies button")].find(
			(b) => b.textContent === "续写",
		);
		expect(quick).toBeTruthy();
		await act(async () => {
			quick.click();
		});
		await h.waitFor(
			() => h.requests.some((r) => r.url === "/api/books/7/chat/stream"),
			"快捷回复已发送",
		);
		expect(JSON.parse(h.lastInit.body).content).toBe("续写");
		expect(h.node("chat-text").value).toBe("");
		// 插入到当前章节（不 dispatch input——等值 legacy）
		const insert = [...document.querySelectorAll("#chat-messages button")].find(
			(b) => b.textContent === "插入到当前章节",
		);
		h.node("chapter-content").value = "原有正文";
		act(() => {
			insert.click();
		});
		const expectedContent =
			"原有正文\n\n【需要确认】\n1. 接下来怎么写？（续写／改大纲）";
		expect(h.node("chapter-content").value).toBe(expectedContent);
		expect(h.node("word-count").textContent).toBe(
			`共 ${expectedContent.replace(/\s/g, "").length} 字`,
		);
		expect(h.toasts).toContain("已插入，记得保存");
		// 无当前章 → 提示（:965-968）
		window.App.state.currentChapterId = null;
		act(() => {
			insert.click();
		});
		expect(h.toasts).toContain("请先在左侧选择一个章节");
	});

	it("T5-13 左栏：两入口幂等绑定、列表进 #world-list/#character-list、删除文案与保存请求体逐字（:1655-1842、:1938-1942）", async () => {
		mountWorkspace();
		await act(async () => {
			await chatApi().loadWorld();
			await chatApi().loadCharacters();
		});
		const rows = document.querySelectorAll("#world-list li.item-row");
		expect(rows.length).toBe(1);
		expect(rows[0].querySelector(".item-name").textContent).toBe("北境");
		expect(rows[0].querySelector(".item-sub").textContent).toBe(
			"风雪与石碑的世界观说明文本".slice(0, 30),
		);
		const btns = rows[0].querySelectorAll(".icon-btn");
		expect(btns[0].className).toBe("icon-btn edit-we");
		expect(btns[0].textContent).toBe("✎");
		expect(btns[1].className).toBe("icon-btn del-we");
		expect(btns[1].textContent).toBe("×");
		const charRows = document.querySelectorAll("#character-list li.item-row");
		expect(charRows.length).toBe(1);
		expect(charRows[0].querySelector(".item-name").textContent).toBe("林昭");
		expect(charRows[0].querySelector(".item-sub").textContent).toBe("主角");
		// 入口每次 bindChatEvents 重挂后仍可用
		await act(async () => {
			await chatApi().bindChatEvents();
		});
		expect(typeof h.node("btn-add-world").onclick).toBe("function");
		expect(typeof h.node("btn-add-character").onclick).toBe("function");
		act(() => {
			h.node("btn-add-world").click();
		});
		expect(h.modals[h.modals.length - 1].title).toBe("新建世界观条目");
		// 删除确认文案逐字（:1687、:1768）
		window.confirm = vi.fn(() => false);
		h.requests.length = 0;
		act(() => {
			document.querySelector("#world-list .del-we").click();
		});
		expect(window.confirm).toHaveBeenCalledWith("确定删除该世界观条目？");
		expect(h.requests.length).toBe(0);
		window.confirm = vi.fn(() => true);
		await act(async () => {
			document.querySelector("#world-list .del-we").click();
		});
		expect(h.requests[0]).toEqual({
			method: "DELETE",
			url: "/api/books/7/world/3",
			body: undefined,
		});
		h.requests.length = 0;
		await act(async () => {
			document.querySelector("#character-list .del-char").click();
		});
		expect(window.confirm).toHaveBeenCalledWith("确定删除该人物卡片？");
		expect(h.requests[0].url).toBe("/api/books/7/characters/5");
		// 编辑保存请求体逐字（:1705-1734）
		await act(async () => {
			document.querySelector("#world-list .edit-we").click();
		});
		const body = document.getElementById("modal-body");
		body.querySelector("#we-title").value = "  新北境  ";
		body.querySelector("#we-content").value = " 内容 ";
		await act(async () => {
			await h.modals[h.modals.length - 1].onOk(body);
		});
		expect(
			h.requests.find(
				(r) => r.method === "PUT" && r.url === "/api/books/7/world/3",
			),
		).toEqual({
			method: "PUT",
			url: "/api/books/7/world/3",
			body: { title: "新北境", content: "内容" },
		});
		// 人物卡片保存请求体逐字（:1786-1842）
		await act(async () => {
			document.querySelector("#character-list .edit-char").click();
		});
		const cbody = document.getElementById("modal-body");
		cbody.querySelector("#ch-name").value = " 林昭 ";
		cbody.querySelector("#ch-role").value = "主角";
		cbody.querySelector("#ch-appearance").value = "青衣";
		cbody.querySelector("#ch-personality").value = "冷静";
		cbody.querySelector("#ch-background").value = "北境";
		cbody.querySelector("#ch-note").value = "备注";
		await act(async () => {
			await h.modals[h.modals.length - 1].onOk(cbody);
		});
		expect(
			h.requests.find(
				(r) => r.method === "PUT" && r.url === "/api/books/7/characters/5",
			),
		).toEqual({
			method: "PUT",
			url: "/api/books/7/characters/5",
			body: {
				name: "林昭",
				role: "主角",
				appearance: "青衣",
				personality: "冷静",
				background: "北境",
				note: "备注",
			},
		});
		// 校验：空标题/空姓名不发请求（:1717-1720、:1817-1820）
		const before = h.requests.length;
		act(() => {
			document.querySelector("#world-list .edit-we").click();
		});
		document.getElementById("modal-body").querySelector("#we-title").value =
			"  ";
		await act(async () => {
			await h.modals[h.modals.length - 1].onOk(
				document.getElementById("modal-body"),
			);
		});
		expect(h.requests.length).toBe(before);
		expect(h.toasts[h.toasts.length - 1]).toBe("请填写标题");
	});

	it("T5-14 挂载面：拆注册期残留、wrap 恰两件、幂等、缺容器 no-op、无重复 id（:1853-1946）", async () => {
		// 模拟 entry.jsx 注册期在静态壳上留下的悬挂 root/wrap（legacy-bridge.jsx:460）
		act(() => {
			mountChatJumpBottom();
		});
		expect(document.querySelectorAll(".chat-jump-bottom").length).toBe(1);
		expect(document.querySelector(".chat-scroll-wrap")).not.toBeNull();
		const hostsBefore = document.querySelectorAll("body > div").length;

		act(() => {
			ensureMounted();
		});
		expect(document.querySelectorAll(".chat-jump-bottom").length).toBe(1);
		expect(document.querySelectorAll("body > div").length).toBe(
			hostsBefore - 1,
		);
		const wrap = h.wrap();
		expect(document.querySelectorAll(".chat-scroll-wrap").length).toBe(1);
		expect(wrap.children.length).toBe(2);
		expect(wrap.children[0].id).toBe("chat-messages");
		expect(wrap.children[1].className).toContain("chat-jump-bottom");
		// 幂等
		await act(async () => {
			await chatApi().bindChatEvents();
		});
		expect(document.querySelectorAll("#chat-messages").length).toBe(1);
		expect(document.querySelectorAll(".chat-scroll-wrap").length).toBe(1);
		expect(document.querySelectorAll("#chat-text").length).toBe(1);
		// 缺容器 no-op（不抛）
		const panel = h.panel();
		panel.remove();
		await act(async () => {
			await chatApi().bindChatEvents();
		});
		expect(document.querySelectorAll("#chat-messages").length).toBe(0);
	});

	it("T5-15 确认卡跨回合留存（legacy commitLive :1231-1238「工具块/确认卡迁移到正式消息」）：流内 action 收尾后仍在 #chat-messages 且可结算", async () => {
		mountWorkspace();
		h.setFetch(() =>
			Promise.resolve(
				sseResponse([
					{
						type: "content",
						text: "已提交操作「append_chapter」，等待作者确认，尚未生效。",
					},
					{
						type: "action",
						id: "act-live-1",
						name: "append_chapter",
						args: { chapterId: CHAPTER_ID, text: "S5-7 卡留存" },
					},
					{
						type: "done",
						content: "已提交操作「append_chapter」，等待作者确认，尚未生效。",
						run: { status: "awaiting_confirmation" },
					},
				]),
			),
		);
		await act(async () => {
			const t = h.node("chat-text");
			t.value = "请追加一句";
			t.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			h.node("chat-form").dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		await h.waitFor(
			() => h.node("btn-send").textContent === "发送",
			"回合收尾",
		);
		// 收尾后 live 槽已卸载，卡必须仍在消息区（legacy 迁移语义）；且同 id 不重复
		const cards = document.querySelectorAll("#chat-messages .msg-action");
		expect(cards.length).toBe(1);
		expect(cards[0].textContent).toContain("追加章节正文");
		const ops = [...cards[0].querySelectorAll(".action-ops button")].map(
			(b) => b.textContent,
		);
		expect(ops.some((t) => t.indexOf("同意执行") >= 0)).toBe(true);
	});

	it("T5-16 会话切换：非冒泡 change 事件也生效（等值 legacy :28-30 select.onchange 直挂；驱动 JS 原样口径）", async () => {
		reset({
			routes: {
				"GET /api/conversations?kind=writing": () => [
					{ id: CONV_ID, title: "新写作任务", status: "active" },
					{ id: "conv-other", title: "另一会话", status: "active" },
				],
			},
		});
		mountWorkspace();
		await loadChat();
		const sel = h.node("writing-conversation-select");
		const opt = [...sel.options].find((o) => o.value === "conv-other");
		expect(opt).toBeTruthy();
		// 驱动/脚本口径：直写 value + 非冒泡 change（真用户选择是冒泡事件，走 React onChange）
		sel.value = "conv-other";
		sel.dispatchEvent(new Event("change"));
		await h.waitFor(
			() => localStorage.getItem("writing_conversation_7") === "conv-other",
			"切换写入 localStorage",
		);
		await h.waitFor(
			() =>
				h.requests.some(
					(r) => String(r.url).indexOf("conversationId=conv-other") >= 0,
				),
			"切换后 loadChat 带新会话",
		);
		// 冒泡路径不得双触发（React onChange 与直挂 listener 分流）：会话本体只拉一次
		// （loadChat 尾与 switchConversation 各刷一次上下文仪表＝legacy :46-50 原样，不在本断言口径内）
		expect(
			h.requests.filter((r) =>
				String(r.url).endsWith(`/chat?conversationId=conv-other`),
			).length,
		).toBe(1);
		// 真用户选择＝冒泡 change：React onChange 承接、直挂 listener 让位——同样只拉一次
		h.requests.length = 0;
		sel.value = CONV_ID;
		sel.dispatchEvent(new Event("change", { bubbles: true }));
		await h.waitFor(
			() =>
				h.requests.some((r) =>
					String(r.url).endsWith(`/chat?conversationId=${CONV_ID}`),
				),
			"冒泡路径切换",
		);
		expect(
			h.requests.filter((r) =>
				String(r.url).endsWith(`/chat?conversationId=${CONV_ID}`),
			).length,
		).toBe(1);
	});
});
