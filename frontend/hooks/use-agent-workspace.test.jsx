// @vitest-environment jsdom
// S5-9 红测 T4（Plan §4 T4）：frontend/hooks/use-agent-workspace.js —— 装配 hook（块一编排的
// 另一半＋块二全部行为）。语义唯一事实源＝public/legacy/agent.js（逐例头注 legacy 行号锚点）。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言；探针组件渲染 AgentSpace 并回传 hook 面；
// api／fetchImpl／storage／confirm／RunStatus 全注入；零真实网络。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSpace from "../components/AgentSpace.jsx";
import { useAgentWorkspace } from "./use-agent-workspace.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
	{
		id: "c-archived",
		kind: "agent",
		scope: "book",
		book_id: 7,
		title: "旧会话",
		status: "archived",
	},
];

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

// 可控流：push 帧、close 收尾（停止/收尾用例）
function openStream() {
	let ctrl = null;
	const stream = new ReadableStream({
		start(c) {
			ctrl = c;
		},
	});
	return {
		response: new Response(stream, {
			headers: { "Content-Type": "text/event-stream" },
		}),
		push(frames) {
			const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
			ctrl.enqueue(new TextEncoder().encode(text));
		},
		close() {
			ctrl.close();
		},
	};
}

let requests;
let toasts;
let rs;
let storageMap;

function memStorage() {
	return {
		getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
		setItem: (k, v) => storageMap.set(k, String(v)),
		removeItem: (k) => storageMap.delete(k),
	};
}

function record(method, url, body) {
	const req = { method, url: String(url), body };
	requests.push(req);
	return req;
}

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
	if (req.method === "GET" && req.url.indexOf("/api/resources") === 0)
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
						status: "locked",
						meta: { sortOrder: 1 },
					},
				],
			},
		};
	if (req.method === "POST" && req.url.indexOf("/compress") >= 0)
		return {
			body: { coveredMessageIds: [1, 2, 3], usageEstimate: 1200, restored: 2 },
		};
	if (
		req.method === "POST" &&
		req.url === "/api/conversations/import-legacy-agent"
	)
		return { body: { conversationId: "c-legacy", createdMessages: 2 } };
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
	if (req.method === "POST" && req.url === "/api/agent/actions/a-9/confirm")
		return { body: { status: "approved" } };
	if (req.method === "POST" && req.url === "/api/agent/actions/a-9/resume")
		return {
			sse: [
				{ type: "text-delta", delta: "续跑回复" },
				{
					type: "finish",
					messageMetadata: {
						run: { id: "run-r", status: "finished" },
						finalContent: "续跑回复",
					},
				},
			],
		};
	return null;
}

function makeDeps(over) {
	const o = over || {};
	const storage = memStorage();
	for (const [k, v] of Object.entries(o.seed || {}))
		storageMap.set(k, String(v));
	const deps = {
		api: async (method, url, body) => {
			const req = record(method, url, body);
			const r = (o.route ? o.route(req) : null) || defaultRoute(req);
			if (!r) throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
			return r.body;
		},
		fetchImpl: async (url, init) => {
			const req = record(
				init?.method || "GET",
				url,
				init?.body ? JSON.parse(init.body) : null,
			);
			const r = (o.route ? o.route(req) : null) || defaultRoute(req);
			if (!r) return jsonResponse({ error: { code: "STUB_NO_ROUTE" } }, 404);
			if (r.sse) return sseResponse(r.sse);
			if (r.stream) return r.stream.response;
			return jsonResponse(r.body, r.status || 200);
		},
		toast: (m) => toasts.push(String(m)),
		escapeHtml: (s) => String(s == null ? "" : s),
		openModal: vi.fn(),
		closeModal: vi.fn(),
		confirm: () => true,
		storage,
		runStatus: rs,
		readWritingReturn: () => null,
	};
	if (o.api) deps.api = o.api;
	if (o.fetchImpl) deps.fetchImpl = o.fetchImpl;
	if (o.confirm) deps.confirm = o.confirm;
	return deps;
}

let container;
let root;
let ws;
let deps;

function Probe() {
	ws = useAgentWorkspace(deps);
	return <AgentSpace {...ws.spaceProps} />;
}

beforeEach(() => {
	requests = [];
	toasts = [];
	storageMap = new Map();
	rs = {
		cardModel: vi.fn(() => ({
			badge: null,
			pendingActions: [],
			tools: [],
			toolErrors: [],
		})),
		mountTaskCard: vi.fn(),
		runFromMessages: vi.fn(() => null),
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	deps = null;
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals(); // waitRunEvents 走全局 fetch（lib 内直调），等待面用例自备桩
});

async function boot(over) {
	deps = makeDeps(over);
	await act(async () => {
		root.render(<Probe />);
	});
	await act(async () => {
		await ws.show();
	});
	return deps;
}

// 重新装载（换桩后复跑编排）
async function reload() {
	await act(async () => {
		await ws.show();
	});
}

const $ = (id) => document.getElementById(id);
const matched = (suffix) => requests.filter((r) => r.url.indexOf(suffix) >= 0);
const bubbles = () =>
	[...container.querySelectorAll("#agent-messages .msg-bubble")].map(
		(b) => b.textContent,
	);
const chatBodies = () =>
	requests
		.filter((r) => r.url === "/api/agent/chat")
		// fetch 路径的桩已 JSON.parse 过 init.body；api 路径记录的是原始字符串
		.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body));

async function setText(text) {
	const box = $("agent-text");
	Object.getOwnPropertyDescriptor(
		window.HTMLTextAreaElement.prototype,
		"value",
	).set.call(box, text);
	box.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(text) {
	await setText(text);
	await act(async () => {
		$("agent-form").dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});
}

function flat(list) {
	return list.map((m) => String(m)).join("|");
}

describe("T4 use-agent-workspace（装配）", () => {
	// :2038-2130 —— show 序列
	it("T4-1 show 序列：books→conversations→边界→messages→pending→任务卡→tools（序与次数）", async () => {
		await boot({ seed: { agent_scope_v1: "book:7" } });
		const order = requests.map(
			(r) => `${r.method} ${r.url.replace(/[?].*/, "?")}`,
		);
		expect(order[0]).toBe("GET /api/books");
		expect(order[1]).toBe("GET /api/conversations?");
		// order 把 query 归一成「?」，故资源请求按原始 url 断言（边界章节：:247 limit=100）
		expect(
			requests.some(
				(r) => r.url.indexOf("/api/resources?type=chapter&bookId=7") === 0,
			),
		).toBe(true);
		const msgsIdx = order.findIndex((o) => o.indexOf("/messages") > 0);
		const toolsIdx = order.findIndex((o) => o.indexOf("/api/agent/tools") > 0);
		expect(msgsIdx).toBeGreaterThan(1);
		expect(toolsIdx).toBeGreaterThan(msgsIdx);
		expect(matched("/api/agent/tools").length).toBe(1);
		expect(rs.mountTaskCard).toHaveBeenCalled();
		// 任务卡叶容器：React 不写 children（命令式面喂桩）
		expect($("agent-run-card").children.length).toBe(0);
	});

	// :549-567 —— 会话恢复纪律
	it("T4-2 会话恢复：命中且非归档且属范围→选中；归档/跨范围不被复用", async () => {
		await boot({
			seed: { agent_scope_v1: "book:7", agent_conversation_v1: "c-book-7" },
		});
		expect($("agent-conversation-select").value).toBe("c-book-7");
		storageMap.set("agent_conversation_v1", "c-archived");
		await reload();
		expect($("agent-conversation-select").value).toBe("c-book-7");
		storageMap.set("agent_scope_v1", "global");
		storageMap.set("agent_conversation_v1", "c-book-7");
		await reload();
		expect($("agent-conversation-select").value).toBe("c-global");
	});

	// :257-277 —— 切范围＋token 竞态（迟到边界结果丢弃）
	it("T4-3 切范围：清边界/写 scope 与会话键；飞行中再切→迟到结果丢弃（不覆盖新范围）", async () => {
		let releaseBoundary;
		const held = new Promise((r) => {
			releaseBoundary = r;
		});
		await boot({
			api: async (method, url, body) => {
				const req = record(method, url, body);
				if (req.url.indexOf("/api/resources?type=chapter&bookId=7") === 0) {
					await held;
					return {
						type: "chapter",
						bookId: 7,
						nextCursor: null,
						items: [
							{
								type: "chapter",
								id: 12,
								title: "迟到章节",
								status: "draft",
								meta: {},
							},
						],
					};
				}
				const r = defaultRoute(req);
				if (!r)
					throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
				return r.body;
			},
		});
		const sel = $("agent-scope-select");
		let switching;
		// 冒泡 change＝React onChange 臂（非冒泡承接臂由 T5-5 四 select 专测，两臂同源语义）
		await act(async () => {
			sel.value = "book:7";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
			switching = Promise.resolve();
		});
		// 边界请求在飞行中：再切回全局
		await act(async () => {
			sel.value = "global";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			releaseBoundary();
			await switching;
		});
		expect(storageMap.get("agent_scope_v1")).toBe("global");
		expect($("agent-boundary-select").disabled).toBe(true);
		expect(
			[...$("agent-boundary-select").options].map((o) => o.textContent),
		).toEqual(["全书（先选一本书）"]);
		// 迟到边界结果不得写进新范围（若写入，上面两项会被「迟到章节」覆盖）；
		// 新范围的历史照常装载（:276）
		expect(
			matched("/api/conversations/c-global/messages").length,
		).toBeGreaterThan(0);
	});

	// :338-395 —— 资源面板
	it("T4-4 资源：首读无 cursor、续读带 cursor 累加、hint 两态、失败文案、类型切换 reset", async () => {
		await boot({ seed: { agent_scope_v1: "book:7" } });
		await act(async () => {
			$("btn-agent-tab-resources").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		// 列表请求与边界章节请求同前缀（:247 带 limit=100），按无 limit 过滤
		const first = requests.filter(
			(r) =>
				r.url.indexOf("/api/resources?type=chapter") === 0 &&
				r.url.indexOf("limit=") < 0,
		);
		expect(first.length).toBe(1);
		expect(first[0].url.indexOf("cursor=")).toBe(-1);
		expect($("agent-res-hint").textContent).toContain("已列出 1 项");
		expect($("agent-res-hint").textContent.indexOf("（还有更多）")).toBe(-1);
		// 续读：nextCursor → 追加请求
		deps.api = async (method, url, body) => {
			const req = record(method, url, body);
			if (req.url.indexOf("/api/resources?type=chapter") === 0) {
				const has = req.url.indexOf("cursor=CUR-1") >= 0;
				return {
					type: "chapter",
					bookId: 7,
					nextCursor: has ? null : "CUR-1",
					items: [
						{
							type: "chapter",
							id: has ? 13 : 12,
							title: has ? "第二章" : "第一章",
							status: "draft",
							meta: {},
						},
					],
				};
			}
			const r = defaultRoute(req);
			if (!r) throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
			return r.body;
		};
		await act(async () => {
			$("btn-agent-res-refresh").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		await act(async () => {
			$("btn-agent-res-more").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		const withCursor = requests.filter(
			(r) => r.url.indexOf("cursor=CUR-1") >= 0,
		);
		expect(withCursor.length).toBe(1);
		expect($("agent-res-hint").textContent).toContain("已列出 2 项");
		// :354-360 hint 用**更新后**的 cursor 计算：尾追读完（nextCursor=null）不再提示「还有更多」
		expect($("agent-res-hint").textContent.indexOf("（还有更多）")).toBe(-1);
		expect($("btn-agent-res-more").classList.contains("hidden")).toBe(true);
		// 类型切换 → reset（清 cursor/items，请求不带 cursor）
		await act(async () => {
			const tsel = $("agent-res-type");
			tsel.value = "character";
			tsel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const reset = requests.filter(
			(r) => r.url.indexOf("/api/resources?type=character") === 0,
		);
		expect(reset.length).toBe(1);
		expect(reset[0].url.indexOf("cursor=")).toBe(-1);
		// 失败文案
		deps.api = async () => {
			throw new Error("boom");
		};
		await act(async () => {
			$("btn-agent-res-refresh").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect($("agent-res-hint").textContent).toBe("资源读取失败：boom");
	});

	// :397-422 —— 摘要预览
	it("T4-5 摘要预览：点击行→detail URL；失败/空态；book 型切范围；收起", async () => {
		await boot({ seed: { agent_scope_v1: "book:7" } });
		await act(async () => {
			$("btn-agent-tab-resources").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		const row = container.querySelector("#agent-res-list li.agent-res-item");
		expect(row).not.toBeNull();
		await act(async () => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const detail = requests.filter((r) => r.url.indexOf("id=12") >= 0);
		expect(detail.length).toBe(1);
		expect(detail[0].url).toContain("type=chapter");
		expect(detail[0].url.indexOf("bookId=7")).toBeGreaterThan(0);
		expect($("agent-preview-panel").classList.contains("hidden")).toBe(false);
		// 失败态
		deps.api = async () => {
			throw new Error("摘要炸了");
		};
		await act(async () => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect($("agent-preview-body").textContent).toBe("摘要读取失败：摘要炸了");
		// 空态
		deps.api = async () => ({ resource: null });
		await act(async () => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect($("agent-preview-body").textContent).toContain("没有可展示的摘要");
		// 收起
		await act(async () => {
			$("btn-agent-preview-close").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect($("agent-preview-panel").classList.contains("hidden")).toBe(true);
		// book 型 → 切范围按钮
		deps.api = async (method, url) => {
			record(method, url, null);
			return {
				resource: {
					type: "book",
					id: 9,
					title: "另一部",
					status: "collab",
					meta: {},
					details: {},
					route: null,
				},
			};
		};
		await act(async () => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const useBtn = [...$("agent-preview-body").querySelectorAll("button")].find(
			(b) => b.textContent.indexOf("把交流范围切到这本书") >= 0,
		);
		expect(useBtn).toBeTruthy();
		await act(async () => {
			useBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(storageMap.get("agent_scope_v1")).toBe("book:9");
	});

	// :621-656 —— 历史渲染守卫
	it("T4-6 历史守卫：还原按钮显隐、runFromMessages→任务卡、目标变更丢弃、sending 零清空零请求", async () => {
		deps = makeDeps({ seed: { agent_scope_v1: "global" } });
		await act(async () => {
			root.render(<Probe />);
		});
		await reload();
		expect($("btn-agent-restore").classList.contains("hidden")).toBe(true);
		deps.api = async (method, url, body) => {
			const req = record(method, url, body);
			if (req.url.indexOf("/messages") > 0)
				return {
					messages: [
						{
							id: 1,
							role: "user",
							content: "甲",
							source: "agent",
							compressed: 1,
						},
						{
							id: 2,
							role: "assistant",
							content: "乙",
							source: "agent",
							compressed: 0,
							run: { id: "run-x", status: "finished" },
						},
					],
				};
			const r = defaultRoute(req);
			if (!r) throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
			return r.body;
		};
		await reload();
		expect($("btn-agent-restore").classList.contains("hidden")).toBe(false);
		expect(rs.runFromMessages).toHaveBeenCalled();
		expect(rs.mountTaskCard).toHaveBeenCalled();
		// 目标变更丢弃：切到书（历史被挂起）→ 未回先切回全局（:640 目标已变即丢弃）
		// 会话选择器只列当前范围的会话，故跨范围切换必须走「范围」选择器
		let resolveA;
		const heldA = new Promise((r) => {
			resolveA = r;
		});
		deps.api = async (method, url, body) => {
			const req = record(method, url, body);
			if (req.url.indexOf("/messages") > 0) {
				const book = req.url.indexOf("c-book-7") > 0;
				if (book) await heldA;
				return {
					messages: [
						{
							id: 99,
							role: "assistant",
							content: `来源=/api/conversations/${book ? "c-book-7" : "c-global"}/messages`,
							source: "agent",
						},
					],
				};
			}
			const r = defaultRoute(req);
			if (!r) throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
			return r.body;
		};
		const scopeSel = $("agent-scope-select");
		let switchA;
		await act(async () => {
			scopeSel.value = "book:7";
			scopeSel.dispatchEvent(new Event("change", { bubbles: true }));
			switchA = Promise.resolve();
		});
		await act(async () => {
			scopeSel.value = "global";
			scopeSel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			resolveA();
			await switchA;
		});
		expect(flat(bubbles())).toContain(
			"来源=/api/conversations/c-global/messages",
		);
		expect(flat(bubbles())).not.toContain(
			"来源=/api/conversations/c-book-7/messages",
		);
		// sending 期：零清空零请求
		const stream = openStream();
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/api/agent/chat") === 0) return stream.response;
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		void submit("流式进行中");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		const beforeCount = requests.filter(
			(r) => r.url.indexOf("/messages") > 0,
		).length;
		const beforeBubbles = bubbles().length;
		await act(async () => {
			const s2 = $("agent-conversation-select");
			s2.value = "c-global";
			s2.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(requests.filter((r) => r.url.indexOf("/messages") > 0).length).toBe(
			beforeCount,
		);
		expect(bubbles().length).toBeGreaterThanOrEqual(beforeBubbles);
		await act(async () => {
			$("btn-agent-stop").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
			stream.close();
			await new Promise((r) => setTimeout(r, 20));
		});
	});

	// :1883-2000 —— 发送
	it("T4-7 发送：空内容零请求；无会话先建会话再渲染本轮气泡；发送体；X-Agent-Model 文本", async () => {
		await boot({
			seed: { agent_scope_v1: "book:7" },
			api: async (method, url, body) => {
				const req = record(method, url, body);
				if (
					req.method === "GET" &&
					req.url.indexOf("/api/conversations?") === 0
				)
					return [];
				if (req.method === "POST" && req.url === "/api/conversations")
					return {
						id: "c-new",
						kind: "agent",
						scope: req.body.scope,
						book_id: req.body.bookId,
						title: req.body.title,
						status: "active",
					};
				const r = defaultRoute(req);
				if (!r)
					throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
				return r.body;
			},
		});
		requests.length = 0;
		await submit("   ");
		expect(requests.length).toBe(0);
		await submit("这本书的开头怎么改？");
		const postIdx = requests.findIndex((r) => r.url === "/api/conversations");
		const chatIdx = requests.findIndex((r) => r.url === "/api/agent/chat");
		expect(postIdx).toBeGreaterThan(-1);
		expect(chatIdx).toBeGreaterThan(postIdx);
		const body = chatBodies()[0];
		expect(body.conversation_id).toBe("c-new");
		expect(body.content).toBe("这本书的开头怎么改？");
		expect(body.mode).toBe(undefined);
		expect(body.book_id).toBe(undefined);
		expect(typeof body.request_id).toBe("string");
		expect(flat(bubbles())).toContain("这本书的开头怎么改？");
		expect($("agent-text").value).toBe("");
	});

	// :1828-1855／:1941-1968 —— 幂等分流（等待面按 legacy 等值：等待计入本轮 sending ⇒ 停止钮在场、
	// 可中止；toast 在等待收尾后 :1848／:1961）
	it("T4-8 幂等分流：duplicate 活跃→等待（闸门持有/停止钮在场→终态落完成文案）；非活跃→结束文案；非 duplicate→错误气泡", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		let duplicate = {
			duplicate: true,
			status: "running",
			runId: "run-9",
			sessionKey: "k",
		};
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/api/agent/chat") === 0)
				return jsonResponse(duplicate);
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		// 运行事件通道（waitRunEvents 走全局 fetch）：闸门式响应，用于检验等待期状态
		let releaseRunEvents = null;
		vi.stubGlobal("fetch", (url, init) => {
			record(init?.method || "GET", String(url), null);
			return new Promise((resolve) => {
				releaseRunEvents = () =>
					resolve(
						jsonResponse({ status: "finished", events: [], nextAfterSeq: 0 }),
					);
			});
		});
		void submit("问一句");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(flat(bubbles())).toContain("等待");
		// legacy 等值：等待期仍在本轮运行内（agentAbort 在位）⇒ 停止钮在场；toast 未发（收尾后发）
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(false);
		expect(toasts).not.toContain("该请求已在另一窗口处理");
		releaseRunEvents();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(flat(bubbles())).toContain("已在另一窗口完成");
		expect(toasts).toContain("该请求已在另一窗口处理");
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(true);
		duplicate = {
			duplicate: true,
			status: "finished",
			runId: "run-9",
			sessionKey: "k",
		};
		requests.length = 0;
		await submit("再问一句");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(flat(bubbles())).toContain("已在另一窗口结束");
		duplicate = { error: { message: "忙碌中" } };
		await submit("第三句");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(flat(bubbles())).toContain("出错了：忙碌中");
	});

	// F2 整改专项（legacy :1840-1845／:1953-1958）：等待期 stop() 中止等待 → 「（已停止等待另一窗口的请求）」
	it("T4-16 duplicate 等待可中止：stop()→「（已停止等待另一窗口的请求）」且不落「（已停止生成）」", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/api/agent/chat") === 0)
				return jsonResponse({
					duplicate: true,
					status: "running",
					runId: "run-9",
					sessionKey: "k",
				});
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		let runEventsAborted = false;
		vi.stubGlobal("fetch", (url, init) => {
			record(init?.method || "GET", String(url), null);
			return new Promise((_resolve, reject) => {
				const s = init?.signal;
				const onAbort = () => {
					runEventsAborted = true;
					const e = new Error("等待运行结果时已停止");
					e.name = "AbortError";
					reject(e);
				};
				if (s) {
					if (s.aborted) onAbort();
					else s.addEventListener("abort", onAbort);
				}
			});
		});
		void submit("问一句");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(false);
		await act(async () => {
			$("btn-agent-stop").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(runEventsAborted).toBe(true);
		expect(flat(bubbles())).toContain("（已停止等待另一窗口的请求）");
		expect(flat(bubbles())).not.toContain("（已停止生成）");
		// S5-9-X2 负断言（legacy :1845／:1958 等值）：中止分支提前 return，不落「已在另一窗口处理」toast
		expect(toasts).not.toContain("该请求已在另一窗口处理");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(toasts).not.toContain("该请求已在另一窗口处理");
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(true);
	});

	// :1800-1805／:2051-2053 —— 停止
	it("T4-9 停止：飞行期停止按钮显示；stop()→（已停止生成）＋按钮复位", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		const stream = openStream();
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/api/agent/chat") === 0) return stream.response;
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		void submit("问题");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(false);
		await act(async () => {
			$("btn-agent-stop").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		await act(async () => {
			stream.close();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(flat(bubbles())).toContain("（已停止生成）");
		expect($("btn-agent-stop").classList.contains("hidden")).toBe(true);
		expect($("btn-agent-send").disabled).toBe(false);
	});

	// :1793-1880 —— resume 串行队列
	it("T4-10 resume 串行：两次严格串行；错误分支「续跑出错了」", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		const resolvers = [];
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/resume") >= 0) {
				return new Promise((resolve) => {
					resolvers.push(() =>
						resolve(
							sseResponse([
								{ type: "text-delta", delta: "续跑" },
								{
									type: "finish",
									messageMetadata: {
										run: { id: "r", status: "finished" },
										finalContent: "续跑",
									},
								},
							]),
						),
					);
				});
			}
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		let p1;
		let p2;
		await act(async () => {
			p1 = ws.resumeAction("a-9");
			p2 = ws.resumeAction("a-9");
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(matched("/resume").length).toBe(1);
		await act(async () => {
			resolvers[0]();
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(matched("/resume").length).toBe(2);
		await act(async () => {
			resolvers[1]();
			await Promise.all([p1, p2]);
		});
		deps.fetchImpl = async (url, init) => {
			const req = record(init?.method || "GET", url, null);
			if (req.url.indexOf("/resume") >= 0)
				return jsonResponse({ error: { message: "恢复炸了" } }, 500);
			const r = defaultRoute(req);
			return r ? jsonResponse(r.body) : jsonResponse({}, 404);
		};
		await act(async () => {
			await ws.resumeAction("a-9");
		});
		expect(flat(bubbles())).toContain("续跑出错了：恢复炸了");
	});

	// :1308-1340／:1728-1789 —— pending 重建与结算接线
	it("T4-11 pending 重建＋结算：过期只读卡先、可操作卡后；同意→confirm＋resume 恰一次", async () => {
		const now = Date.now();
		storageMap.set(
			"agent_pending_v1",
			JSON.stringify([
				{
					id: "a-old",
					conf: { id: "a-old", summary: "过期动作" },
					toolName: "update_chapter",
					input: {},
					expiresAt: new Date(now - 1000).toISOString(),
					conversationId: "c-global",
				},
				{
					id: "a-9",
					conf: { id: "a-9", summary: "待确认动作" },
					toolName: "update_chapter",
					input: { chapterId: 3 },
					expiresAt: null,
					conversationId: "c-global",
				},
			]),
		);
		await boot({ seed: { agent_scope_v1: "global" } });
		const cards = [
			...container.querySelectorAll("#agent-messages .msg-action"),
		];
		expect(cards.length).toBe(2);
		expect(cards[0].getAttribute("data-action-status")).toBe("expired");
		expect(cards[0].classList.contains("msg-action-readonly")).toBe(true);
		expect(cards[0].querySelectorAll("button").length).toBe(0);
		expect(cards[1].getAttribute("data-action-status")).toBe("pending");
		expect(
			JSON.parse(storageMap.get("agent_pending_v1")).map((e) => e.id),
		).toEqual(["a-9"]);
		const messagesEl = $("agent-messages");
		expect(messagesEl.scrollTop).toBe(messagesEl.scrollHeight);
		// 同意执行 → confirm + resume 恰一次；状态切 approved
		requests.length = 0;
		const okBtn = [...container.querySelectorAll(".msg-action button")].find(
			(b) => b.textContent === "同意执行",
		);
		await act(async () => {
			okBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 40));
		});
		expect(matched("/confirm").length).toBe(1);
		expect(matched("/resume").length).toBe(1);
		// 过期卡在最前（:1332-1335）；结算后的卡按状态定位（卡片自带结算态）
		expect(
			[...container.querySelectorAll("#agent-messages .msg-action")].map((c) =>
				c.getAttribute("data-action-status"),
			),
		).toEqual(["expired", "approved"]);
		expect(JSON.parse(storageMap.get("agent_pending_v1"))).toEqual([]);
		expect(flat(bubbles())).toContain("续跑回复");
	});

	// :1189-1212 —— 压缩/还原
	it("T4-13 压缩/还原：请求体、成功 toast、confirm 拒绝零请求、无会话提示", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		requests.length = 0;
		await act(async () => {
			$("btn-agent-compress").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		const compress = matched("/compress");
		expect(compress.length).toBe(1);
		// api 桩记录的 body 已是对象（fetch 桩才会 JSON.parse）
		const compressBody =
			typeof compress[0].body === "string"
				? JSON.parse(compress[0].body)
				: compress[0].body;
		expect(Object.keys(compressBody)).toEqual(["expectedLastMessageId"]);
		expect(toasts.some((t) => t.indexOf("已归档 3 条早期对话") >= 0)).toBe(
			true,
		);
		requests.length = 0;
		await act(async () => {
			$("btn-agent-restore").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(matched("/compress/restore").length).toBe(1);
		expect(toasts.some((t) => t.indexOf("已还原 2 条归档对话") >= 0)).toBe(
			true,
		);
		deps.confirm = () => false;
		requests.length = 0;
		await act(async () => {
			$("btn-agent-compress").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(matched("/compress").length).toBe(0);
		// 无会话 → 提示；零请求
		deps.api = async (method, url, body) => {
			const req = record(method, url, body);
			if (req.method === "GET" && req.url.indexOf("/api/conversations?") === 0)
				return [];
			const r = defaultRoute(req);
			if (!r) throw Object.assign(new Error("STUB_NO_ROUTE"), { status: 404 });
			return r.body;
		};
		await reload();
		deps.confirm = () => true;
		requests.length = 0;
		await act(async () => {
			$("btn-agent-compress").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(toasts).toContain("请先选择会话");
		expect(matched("/compress").length).toBe(0);
	});

	// :1215-1272 —— legacy 导入与清理
	it("T4-14 legacy 导入与清理：条状渲染、导入体、按钮三态、清理守卫与落地", async () => {
		storageMap.set(
			"agent_history_v1",
			JSON.stringify([{ role: "user", content: "旧消息一回" }]),
		);
		await boot({ seed: { agent_scope_v1: "global" } });
		expect($("agent-legacy-import").classList.contains("hidden")).toBe(false);
		expect($("agent-legacy-text").textContent).toContain(
			"检测到浏览器本地旧助手历史 1 条",
		);
		expect($("btn-agent-clean-local").classList.contains("hidden")).toBe(true);
		requests.length = 0;
		await act(async () => {
			$("btn-agent-import").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		const importReq = requests.find(
			(r) => r.url === "/api/conversations/import-legacy-agent",
		);
		expect(importReq).toBeTruthy();
		// api 桩记录的 body 已是对象（fetch 桩才会 JSON.parse）
		const importBody =
			typeof importReq.body === "string"
				? JSON.parse(importReq.body)
				: importReq.body;
		expect(importBody).toEqual({
			scope: "global",
			title: "导入的助手历史",
			messages: [{ role: "user", content: "旧消息一回" }],
		});
		expect(storageMap.get("agent_legacy_imported_v1")).toBe("1");
		expect($("agent-legacy-text").textContent).toContain("已导入服务端");
		expect($("btn-agent-import").classList.contains("hidden")).toBe(true);
		expect($("btn-agent-clean-local").classList.contains("hidden")).toBe(false);
		await act(async () => {
			$("btn-agent-clean-local").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(storageMap.get("agent_history_v1")).toBe(undefined);
		expect(toasts).toContain("本地旧副本已清理（服务端历史不受影响）");
		expect($("agent-legacy-import").classList.contains("hidden")).toBe(true);
	});

	// :531-547／:2095-2100 —— 模式与权限回落
	it("T4-15 模式：全局禁用且点击无效；书籍范围切执行两态 toast 逐字；切回全局回落", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		expect($("btn-agent-mode").disabled).toBe(true);
		await act(async () => {
			$("btn-agent-mode").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect($("agent-scope-status").textContent).toContain("只读讨论");
		await act(async () => {
			const sel = $("agent-scope-select");
			sel.value = "book:7";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect($("btn-agent-mode").disabled).toBe(false);
		expect($("btn-agent-mode").textContent).toBe("只读讨论");
		await act(async () => {
			$("btn-agent-mode").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(toasts).toContain(
			"执行模式：AI 可发起写操作，每一步仍需你在确认卡放行",
		);
		expect($("btn-agent-mode").textContent).toBe("执行操作");
		await act(async () => {
			$("btn-agent-mode").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(toasts).toContain("已切回只读讨论");
		expect($("agent-scope-status").textContent).toContain("只读讨论");
		// 切回全局：模式回落 discuss（状态行只读）
		await act(async () => {
			const sel = $("agent-scope-select");
			sel.value = "global";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect($("agent-scope-status").textContent).toContain("只读讨论");
	});

	// I7 承接：退役见证 test/agent-workspace-ui.test.js:536（范围纪律）两条负断言的等价新钉——
	// 「浏览不建会话（切范围/选会话/资源浏览零 POST /api/conversations）」＋「全程无 PUT/PATCH」。
	it("T4-17 范围纪律：切范围/选会话/资源浏览零 POST /api/conversations、零 PUT/PATCH（正控＝新会话恰一次 POST）", async () => {
		await boot({ seed: { agent_scope_v1: "global" } });
		requests.length = 0;
		await act(async () => {
			const sel = $("agent-scope-select");
			sel.value = "book:7";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			const csel = $("agent-conversation-select");
			csel.value = "c-book-7";
			csel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			const tsel = $("agent-res-type");
			tsel.value = "chapter";
			tsel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(requests.length).toBeGreaterThan(0); // 非空转前置：确有三步浏览请求发生
		expect(
			requests.filter(
				(r) => r.method === "POST" && r.url === "/api/conversations",
			).length,
		).toBe(0);
		expect(
			requests.filter((r) => r.method === "PUT" || r.method === "PATCH").length,
		).toBe(0);
		// 正控：显式「新会话」才发 POST，证明上面的零断言非空转
		await act(async () => {
			$("btn-agent-clear").dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(
			requests.filter(
				(r) => r.method === "POST" && r.url === "/api/conversations",
			).length,
		).toBe(1);
		expect(
			requests.filter((r) => r.method === "PUT" || r.method === "PATCH").length,
		).toBe(0);
	});
});
