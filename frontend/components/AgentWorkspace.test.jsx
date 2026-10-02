// @vitest-environment jsdom
// S5-9 红测 T5（Plan §4 T5）：frontend/components/AgentWorkspace.jsx —— 挂载件（#page-agent 内层壳
// 原位接管＋旧名桥入口＋四个非冒泡 change 承接＋叶容器＋槽位序）。harness＝jsdom＋React 19 act＋
// createRoot＋裸 DOM 断言；静态壳＝frontend/index.html:584-673 **真实切出**（P6-3 源迁入，行号未变；禁复制粘贴）；
// 入口＝registerLegacyBridges() → window.AgentPage.show()（等价真实链路）；网络/RunStatus 全注入。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import { updateAgentReturnLink } from "../pages/BookShell.jsx";
import { showAgentWorkspace } from "./AgentWorkspace.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const INDEX_HTML = readFileSync(
	resolve(process.cwd(), "frontend/index.html"),
	"utf8",
);
const SHELL_HTML = INDEX_HTML.slice(
	INDEX_HTML.indexOf("<!-- ============ AI 助手页 ============ -->"),
	INDEX_HTML.indexOf("<!-- ============ 阅读 / 精修工作台 ============ -->"),
);
const IDS = [...SHELL_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

const BOOKS = [{ id: 7, title: "雾港编年史" }];
const CONVERSATIONS = [
	{
		id: "c-global",
		kind: "agent",
		scope: "global",
		book_id: null,
		title: "全局资源讨论",
		status: "active",
	},
	{
		id: "c-book-7",
		kind: "agent",
		scope: "book",
		book_id: 7,
		title: "雾港编年史 · 讨论",
		status: "active",
	},
];
const CHAT_REPLY = "这本书的伏笔有三处。";

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status: status || 200,
		headers: { "Content-Type": "application/json" },
	});
}
function sseResponse(frames) {
	return new Response(
		frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

let requests;
let toasts;
let rsCalls;

function defaultRoute(req) {
	if (req.method === "GET" && req.url === "/api/books")
		return { body: { books: BOOKS } };
	if (req.method === "GET" && req.url.indexOf("/api/conversations?") === 0)
		return { body: CONVERSATIONS.slice() };
	if (req.method === "GET" && req.url.indexOf("/api/conversations/") === 0)
		return {
			body: {
				messages: [
					{ id: 1, role: "user", content: "之前聊过的内容", source: "agent" },
					{
						id: 2,
						role: "assistant",
						content: "这是服务端历史回复",
						source: "agent",
						tools: [],
						run: { id: "run-h", status: "finished" },
					},
				],
			},
		};
	if (req.method === "GET" && req.url === "/api/agent/tools")
		return {
			body: { tools: [{ name: "list_resources", description: "只读查询" }] },
		};
	// 章节类型给一条真实章节（边界下拉 :243-254 与资源列表共用该目录；空表则 T5-5 无从选边界）
	if (
		req.method === "GET" &&
		req.url.indexOf("/api/resources?type=chapter") === 0
	)
		return {
			body: {
				type: "chapter",
				bookId: 7,
				nextCursor: null,
				items: [
					{
						type: "chapter",
						id: 12,
						title: "第一章 石碑",
						status: "draft",
						meta: { sortOrder: 1 },
					},
				],
			},
		};
	if (req.method === "GET" && req.url.indexOf("/api/resources") === 0)
		return { body: { type: "book", bookId: 7, nextCursor: null, items: [] } };
	if (req.method === "POST" && req.url === "/api/agent/chat")
		return {
			sse: [
				{ type: "text-delta", delta: CHAT_REPLY },
				{
					type: "finish",
					messageMetadata: {
						run: { id: "run-1", status: "finished" },
						finalContent: CHAT_REPLY,
					},
				},
			],
		};
	if (req.method === "POST" && req.url === "/api/conversations")
		return {
			status: 201,
			body: {
				id: "c-new",
				kind: "agent",
				scope: req.body.scope,
				book_id: req.body.bookId || null,
				title: req.body.title,
				status: "active",
			},
		};
	return null;
}

function installStubs() {
	requests = [];
	toasts = [];
	rsCalls = { mountTaskCard: 0, cardModel: 0, runFromMessages: 0 };
	const fetchStub = vi.fn(async (url, init) => {
		const method = init?.method || "GET";
		let body = null;
		if (init?.body) {
			try {
				body = JSON.parse(init.body);
			} catch (_e) {
				body = init.body;
			}
		}
		const req = { method, url: String(url), body };
		requests.push(req);
		const r = defaultRoute(req);
		if (!r) return jsonResponse({ error: { code: "STUB_NO_ROUTE" } }, 404);
		if (r.sse) return sseResponse(r.sse);
		return jsonResponse(r.body, r.status || 200);
	});
	globalThis.fetch = fetchStub;
	const app = {
		state: {},
		toast: (m) => toasts.push(String(m)),
		escapeHtml: (s) => String(s == null ? "" : s),
		openModal: vi.fn(),
		closeModal: vi.fn(),
		async api(method, url, body) {
			const res = await fetchStub(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (!res.ok) {
				let parsed = null;
				try {
					parsed = await res.json();
				} catch (_e) {
					/* 非 JSON */
				}
				const e2 = parsed?.error;
				const err = new Error(
					(e2 && (e2.message || e2.code)) || `请求失败 ${res.status}`,
				);
				if (e2?.code) err.code = e2.code;
				throw err;
			}
			return res.json();
		},
	};
	window.App = app;
	// P6-2 转写：RunStatus 经模块直取（§2.5-D5）⇒ harness 假体装成 spy 面（断言与实现逐字等价）
	vi.spyOn(runStatus, "cardModel").mockImplementation((input) => {
		rsCalls.cardModel += 1;
		return {
			badge: input.run ? "已完成" : null,
			pendingActions: input.actions || [],
			tools: input.tools || [],
			toolErrors: input.toolErrors || [],
		};
	});
	vi.spyOn(runStatus, "mountTaskCard").mockImplementation((host, model) => {
		rsCalls.mountTaskCard += 1;
		host.innerHTML = "";
		if (!model) {
			host.classList.add("hidden");
			return host;
		}
		host.classList.remove("hidden");
		const marker = document.createElement("div");
		marker.className = "run-head";
		marker.textContent = "任务卡（命令式）";
		host.appendChild(marker);
		return host;
	});
	vi.spyOn(runStatus, "runFromMessages").mockImplementation(() => {
		rsCalls.runFromMessages += 1;
		return { id: "run-h", status: "finished" };
	});
}

async function boot() {
	await act(async () => {});
}

// 挂载＋装载序列：React act 的刷新循环在**纯微任务链**上不推进根队列（进入 act 后立刻刷一次，
// 之后只在宏任务让路时继续），故 act 内让出一个宏任务让挂载生效，序列 promise 在 act 作用域外 await。
async function show() {
	let sequence = null;
	await act(async () => {
		sequence = showAgentWorkspace();
		await new Promise((r) => setTimeout(r, 0));
	});
	await sequence;
}

function el(id) {
	return document.getElementById(id);
}

// React 受控 textarea 的 jsdom 赋值必须走原生 setter（CardsPage.test.jsx:238-245 同款）
function setInputValue(node, value) {
	const proto =
		node.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
	node.dispatchEvent(new Event("input", { bubbles: true }));
}

function resources() {
	return requests.filter((r) => r.url.indexOf("/api/resources") === 0);
}
function chats() {
	return requests.filter((r) => r.url.indexOf("/api/agent/chat") === 0);
}

beforeEach(() => {
	document.body.innerHTML = SHELL_HTML;
	sessionStorage.clear();
	localStorage.clear();
	installStubs();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	delete window.AgentPage;
	delete window.RunStatus;
	delete window.App;
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("T5 AgentWorkspace（挂载件）", () => {
	it("T5-1 挂载接管：#page-agent 恰 1、静态壳原位清壳重绘、40 id 各恰一份、无 wrapper", async () => {
		await boot();
		expect(el("agent-messages").children.length).toBe(0);
		await show();
		expect(document.querySelectorAll("#page-agent").length).toBe(1);
		// 容器 = 静态壳自身（类名归 AppRouter），React 只填内层
		const page = el("page-agent");
		expect([...page.children].map((n) => n.tagName)).toEqual([
			"HEADER",
			"DIV",
			"MAIN",
		]);
		expect(page.children[0].classList.contains("topbar")).toBe(true);
		expect(page.children[1].classList.contains("agent-scope-bar")).toBe(true);
		expect(page.children[2].id).toBe("agent-main");
		// 内层壳不含包裹 div：40 个 id 各恰一份（#page-agent 自身由静态壳供给）
		const rendered = [...document.querySelectorAll("#page-agent [id]")]
			.map((n) => n.id)
			.sort();
		expect(rendered).toEqual(
			[...IDS].filter((id) => id !== "page-agent").sort(),
		);
		for (const id of IDS) {
			expect(document.querySelectorAll(`#${id}`).length, id).toBe(1);
		}
	});

	it("T5-2 容器类名权威：React 重渲染不复位 #page-agent 的 class（hidden 漂移防线）", async () => {
		await boot();
		await show();
		const page = el("page-agent");
		page.classList.remove("hidden");
		await act(async () => {
			const sel = el("agent-conversation-select");
			sel.value = "c-global";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(page.classList.contains("hidden")).toBe(false);
		expect(page.className).toBe("page");
	});

	it("T5-3 visit++ 重挂：两次 show() 两次装载序列＋同 root 复用；消息区随重挂重置", async () => {
		await boot();
		await show();
		const firstBooks = requests.filter((r) => r.url === "/api/books").length;
		const firstMsgs = requests.filter(
			(r) => r.url.indexOf("/messages") > 0,
		).length;
		const root = el("page-agent").__mozhenAgentRoot;
		expect(root).toBeTruthy();
		await act(async () => {
			setInputValue(el("agent-text"), "临时输入");
		});
		await show();
		expect(requests.filter((r) => r.url === "/api/books").length).toBe(
			firstBooks + 1,
		);
		expect(requests.filter((r) => r.url.indexOf("/messages") > 0).length).toBe(
			firstMsgs + 1,
		);
		expect(el("page-agent").__mozhenAgentRoot).toBe(root);
		expect(el("agent-text").value).toBe("");
	});

	it("T5-4 模块挂载入口（P6-2 ⑨ 转写：模块直取）：showAgentWorkspace 为模块导出、注册期零请求零清壳；show() 后才挂载（AppRouter 静态 import 委托面）；window.AgentPage 零命中", async () => {
		await boot();
		expect(typeof showAgentWorkspace).toBe("function");
		expect(window.AgentPage).toBeUndefined(); // 反向见证：旧名桥退役后零命中
		expect(requests.length).toBe(0);
		expect(document.getElementById("page-agent").textContent).toContain(
			"AI 助手",
		);
		expect(el("agent-messages").children.length).toBe(0);
		await show();
		expect(requests.length).toBeGreaterThan(0);
	});

	it("T5-5 非冒泡 change 承接：四个 select 非冒泡/冒泡各恰一次（不双发）", async () => {
		await boot();
		await show();
		// 范围：非冒泡 → 恰一次切范围（切到 book:7 会拉边界章节）
		const beforeBoundary = resources().length;
		const scopeSel = el("agent-scope-select");
		await act(async () => {
			scopeSel.value = "book:7";
			scopeSel.dispatchEvent(new Event("change"));
		});
		expect(el("agent-scope-select").value, "非冒泡 change 必须被承接").toBe(
			"book:7",
		);
		expect(el("agent-boundary-select").options.length).toBeGreaterThan(1);
		expect(resources().length).toBeGreaterThan(beforeBoundary);
		// 会话：冒泡 change → React onChange 恰一次
		const beforeMsgs = requests.filter(
			(r) => r.url.indexOf("/messages") > 0,
		).length;
		await act(async () => {
			const sel = el("agent-conversation-select");
			sel.value = "c-book-7";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(requests.filter((r) => r.url.indexOf("/messages") > 0).length).toBe(
			beforeMsgs + 1,
		);
		// 边界：非冒泡 → 状态行出现「截至」
		await act(async () => {
			const bsel = el("agent-boundary-select");
			bsel.value = String(bsel.options[1].value);
			bsel.dispatchEvent(new Event("change"));
		});
		expect(el("agent-scope-status").textContent).toContain("截至");
		// 资源类型：非冒泡 → 恰一次列表请求（先开资源 tab）
		await act(async () => {
			el("btn-agent-tab-resources").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		const beforeRes = resources().length;
		await act(async () => {
			const tsel = el("agent-res-type");
			tsel.value = tsel.options[1].value;
			tsel.dispatchEvent(new Event("change"));
		});
		expect(resources().length).toBe(beforeRes + 1);
		expect(resources().slice(-1)[0].url).toContain(
			`type=${el("agent-res-type").value}`,
		);
		// 冒泡对照臂：换一个值（真实用户选择是冒泡的）→ React onChange 恰一次、不双发
		await act(async () => {
			const tsel = el("agent-res-type");
			tsel.value = tsel.options[2].value;
			tsel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(resources().length).toBe(beforeRes + 2);
	});

	it("T5-6 #agent-run-card 叶容器：静态空 div；mountTaskCard 命令式写入在重渲染后仍存", async () => {
		await boot();
		await show();
		const card = el("agent-run-card");
		expect(card.getAttribute("role")).toBe("status");
		expect(rsCalls.mountTaskCard).toBeGreaterThan(0);
		// 有历史 run 快照 → 卡片显示（className 由 RunStatus 命令式改写）
		expect(card.classList.contains("hidden")).toBe(false);
		expect(card.textContent).toContain("任务卡（命令式）");
		// React 重渲染（切会话）后命令式内容仍在、类名不被复位
		await act(async () => {
			const sel = el("agent-conversation-select");
			sel.value = "c-book-7";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(card.textContent).toContain("任务卡（命令式）");
		expect(card.children.length).toBe(1);
	});

	it("T5-7 #agent-return-writing 互操作：返回锚透传＋updateAgentReturnLink 幂等", async () => {
		sessionStorage.setItem(
			"novel-writing-return",
			JSON.stringify({ bookId: 7, chapterId: 12 }),
		);
		await boot();
		await show();
		const link = el("agent-return-writing");
		expect(link.getAttribute("href")).toBe("#/book/7");
		expect(link.classList.contains("hidden")).toBe(false);
		await act(async () => {
			updateAgentReturnLink();
		});
		expect(link.getAttribute("href")).toBe("#/book/7");
		expect(link.classList.contains("hidden")).toBe(false);
		expect(document.querySelectorAll("#agent-return-writing").length).toBe(1);
		// 无返回锚时不显示
		sessionStorage.clear();
		await show();
		expect(el("agent-return-writing").classList.contains("hidden")).toBe(true);
	});

	it("T5-8 无重复 id／槽位序／表单 submit 经 React（发送按钮恰一次请求）", async () => {
		await boot();
		await show();
		const messages = el("agent-messages");
		// 历史消息在前、pending 卡与实时槽在后（本轮无 pending：仅历史 2 条）
		expect(messages.querySelectorAll(".msg").length).toBe(2);
		expect(el("agent-pick-bar").classList.contains("hidden")).toBe(true);
		// 表单提交（#btn-agent-send type=submit）
		expect(el("btn-agent-send").getAttribute("type")).toBe("submit");
		await act(async () => {
			setInputValue(el("agent-text"), "这本书埋了哪些伏笔？");
		});
		await act(async () => {
			el("agent-form").dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(chats().length).toBe(1);
		expect(chats()[0].body.content).toBe("这本书埋了哪些伏笔？");
		expect(chats()[0].body.conversation_id).toBe("c-global");
		expect(el("agent-text").value).toBe("");
	});

	it("T5-9 命令式写值等价（巡检驱动口径）：#agent-text 直写 .value＋冒泡 input 可发送；勾选框直写 .checked＋冒泡 change 可勾选", async () => {
		await boot();
		await show();
		// ① 文本框：驱动写法＝实例 setter 直写 .value ＋冒泡 input。React 的 onChange 走
		//    ChangeEventPlugin 的「值变化」判定（实例 setter 写值被判为「未变」，见 ChatPanel.jsx:186-189
		//    同款注释）⇒ 由本挂载件的元素级 input 监听按 DOM 真值补报（F1 整改：兜底落本片新建允许面，
		//    S5-8 六组件零改）。
		const before = chats().length;
		await act(async () => {
			const t = el("agent-text");
			t.value = "驱动写的提问";
			t.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			el("agent-form").dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(chats().length).toBe(before + 1);
		expect(chats()[0].body.content).toBe("驱动写的提问");
		// ② 勾选框：驱动写法＝实例 setter 直写 .checked ＋冒泡 change（React onChange 同样漏判），
		//    由本挂载件对 #agent-messages 的元素级委托 change 监听按 DOM 真值兜底（微任务判定）。
		const box = el("agent-messages").querySelector(
			'.agent-pick-toggle input[type="checkbox"]',
		);
		expect(box).toBeTruthy();
		await act(async () => {
			box.checked = true;
			box.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(el("agent-pick-bar").classList.contains("hidden")).toBe(false);
		expect(el("agent-pick-count").textContent).toBe("已选 1 条讨论结论");
	});

	// F1 整改面纪律（源扫描见证）：两处命令式写值兜底只落本片新建件；S5-8 已验收六组件零改。
	it("T5-10 兜底监听只落挂载件；S5-8 两组件（AgentMessageList/AgentSpace）零改（源扫描）", () => {
		const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");
		const mount = read("frontend/components/AgentWorkspace.jsx");
		const list = read("frontend/components/AgentMessageList.jsx");
		const space = read("frontend/components/AgentSpace.jsx");
		// 挂载件供给两处兜底（input 直写补报＋勾选框委托 change 补报）
		expect(mount).toContain('addEventListener("input"');
		expect(mount).toContain('addEventListener("change"');
		expect(mount).toContain("queueMicrotask");
		// S5-8 组件零改：无兜底痕迹（勾选框仍纯受控；输入框仍只有 React onChange 一路）
		expect(list).not.toContain("addEventListener");
		expect(list).not.toContain("queueMicrotask");
		expect(space).not.toContain("onInput");
	});
});
