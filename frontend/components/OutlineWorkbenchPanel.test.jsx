// @vitest-environment jsdom
// S4-7 红测（plans/S4-7-plan-1.md §4 L1~L16）：OutlineWorkbenchPanel 直渲染契约。
// 断言语义锚点＝三件 legacy 行号（Plan §2.4 逐条）：outline-workbench.js / outline-timeline.js /
// outline-assistant.js。harness＝LedgerWorkbenchPanel.test.jsx / CharacterWorkbenchPanel.test.jsx
// 同款：jsdom＋React 19 act＋裸 DOM 断言；window.WorkspaceState mock 为 workspace-state.js:210-283
// 守卫体系逐字语义移植（epochs/dirtyTracker/guards/beginRequest/isCurrent）；
// window.App.openModal mock 按 legacy 弹窗壳契约把 bodyHTML 渲染进 #modal-body（缝隙/评语/采纳
// 三弹窗的按钮绑定读其 DOM）；window.ChatEventHub mock 按 chat-event-hub.js:264-333 契约
//（createAbort/isJsonResponse/newRequestId/consumeAgentStream 回调序列＋返回 {text,aborted,toolErrors}）；
// fetch stub 处理 /api/agent/chat（小助手唯一不经 window.App.api 的出口，assistant :156-162）。
// S5-4 面板契约笔：旧壳 workbench-shell.js（217 行）与旧名桥 window.OutlineWorkbench 随
// D-S4-9-01 迁移块整体退役，本文件挂载机制由 window.OutlineWorkbench.show(route) 机械替换为
// 本地 createRoot 直渲染（一次挂载＝一次全量重入重拉）；旧「shell 整块重写容器后弃旧建新」前提
// 消失，其等价保护由 WorkbenchPage.test.jsx W6（外壳 key 重挂）承接。其余断言逐字不动。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { setWorkspaceStateForTests } from "../lib/workspace-state.js";
import OutlineAssistantPanel from "./OutlineAssistantPanel.jsx";
import { OutlineTimelinePanel } from "./OutlineTimelinePanel.jsx";
import { OutlineWorkbenchPanel } from "./OutlineWorkbenchPanel.jsx";

// P6-2 转写（Plan §2.4 T-F）：小助手对 ChatEventHub 的取用已由 window 旧名改为 `lib/chat-event-hub.js`
// 具名导出直取（§2.5-D5）——harness 的旧 window.ChatEventHub 假体经 holder 转发进模块面（四名逐条同构，
// 其余导出保持真件）。
const hubHolder = vi.hoisted(() => ({ current: null }));
vi.mock("../lib/chat-event-hub.js", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		createAbort: (...a) => hubHolder.current.createAbort(...a),
		newRequestId: (...a) => hubHolder.current.newRequestId(...a),
		isJsonResponse: (...a) => hubHolder.current.isJsonResponse(...a),
		consumeAgentStream: (...a) => hubHolder.current.consumeAgentStream(...a),
	};
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/books/B1";
const BASE2 = "/api/books/B2";
const ROUTE = { bookId: "B1", module: "outline", entityId: null, tab: null };
const ROUTE2 = { bookId: "B2", module: "outline", entityId: null, tab: null };

function freshBook() {
	return { id: 7, title: "测试书", master_outline: "旧总纲" };
}

function freshTimeline() {
	return {
		volumes: [
			{
				id: 31,
				sort_order: 1,
				title: "第一卷",
				intro: "卷一目标",
				outline: "卷一大纲",
				summary: "",
			},
			{
				id: 32,
				sort_order: 2,
				title: "第二卷",
				intro: "",
				outline: "",
				summary: "已有卷总结",
			},
		],
		chapters: [
			{
				id: 101,
				volume_id: 31,
				title: "第一章 起点",
				beat: "旧拍点",
				revision: 5,
				sort_order: 1,
				content_length: 3000,
				locked: true,
				drift_status: "on_track",
			},
			{
				id: 102,
				volume_id: 31,
				title: "暗流涌动",
				beat: "",
				revision: 2,
				sort_order: 2,
				content_length: 0,
				locked: false,
				drift_status: "drifted",
			},
			{
				id: 103,
				volume_id: 32,
				title: "第三章",
				beat: "",
				revision: 1,
				sort_order: 1,
				content_length: 500,
				locked: false,
				drift_status: "on_track",
			},
			{
				id: 104,
				volume_id: null,
				title: "未归卷章",
				beat: "",
				revision: 1,
				sort_order: 1,
				content_length: 0,
				locked: false,
				drift_status: "on_track",
			},
		],
		intensity: {
			101: { event_count: 3, max_importance: 4 },
			102: { event_count: 0, max_importance: 0 },
			103: { event_count: 1, max_importance: 2 },
		},
	};
}

function freshConversations() {
	return [
		{
			id: 55,
			title: "大纲小助手 · 工作台内讨论",
			status: "active",
			kind: "agent",
		},
		{ id: 56, title: "别的会话", status: "active", kind: "agent" },
		{ id: 57, title: "大纲小助手 · 旧档", status: "archived", kind: "agent" },
	];
}

function freshMessages() {
	return {
		messages: [
			{ role: "user", content: "第一卷节奏如何" },
			{ role: "assistant", content: "整体推进稳健" },
			{ role: "system", content: "系统消息不显示" },
			{ role: "user", content: "   " },
		],
	};
}

function makeDeferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let bookFixture;
let timelineFixture;
let bookFail;
let timelineFail;
let timelineFailFromCall;
let timelineCallCount;
let holdBookGets;
let holdTimelineGets;
let heldBook;
let heldTimeline;
let volumeFailId;
let summaryFail;
let beatPutBehavior;
let beatDurable;
let deferredBookPut;
let fillGapFixture;
let fillGapFail;
let adoptFixture;
let tensionFixture;
let conversationsFixture;
let conversationsFail;
let messagesFail;
let agentStreamBehavior;
let chatHold;
let heldChat;
let stoppedReasons;
let abortHandles;
let consumeCalls;
let apiCalls;
let fetchCalls;
let toasts;
let lastModal;
let seqLog;

// WorkspaceState mock：workspace-state.js:210-283 逐字语义（守卫/竞态令牌），seqLog 记调用序
function makeWorkspaceStateMock() {
	const guards = [];
	const epochs = {};
	return {
		beginRequest(scope, target) {
			seqLog.push(`ws:beginRequest:${scope}:${target}`);
			const key = String(scope == null ? "" : scope);
			const seq = (epochs[key] || 0) + 1;
			epochs[key] = seq;
			return {
				scope: key,
				target: target == null ? "" : String(target),
				id: seq,
			};
		},
		isCurrent(token, target) {
			seqLog.push(`ws:isCurrent:${token ? token.scope : ""}`);
			if (!token) return false;
			if (epochs[token.scope] !== token.id) return false;
			if (
				target !== undefined &&
				String(target == null ? "" : String(target)) !== token.target
			)
				return false;
			return true;
		},
		dirtyTracker() {
			let generation = 0;
			let dirty = false;
			return {
				mark() {
					generation += 1;
					dirty = true;
					return generation;
				},
				snapshot() {
					return generation;
				},
				isDirty() {
					return dirty;
				},
				settle(token, ok) {
					if (ok === true && token === generation) dirty = false;
					return dirty === false;
				},
				clear() {
					dirty = false;
				},
			};
		},
		registerGuard(guard) {
			seqLog.push("ws:registerGuard");
			if (!guard?.key) return null;
			guards.push(guard);
			return guard;
		},
		clearGuards(filter) {
			seqLog.push("ws:clearGuards");
			const before = guards.length;
			for (let i = guards.length - 1; i >= 0; i--) {
				if (typeof filter === "function" ? filter(guards[i]) : true)
					guards.splice(i, 1);
			}
			return before - guards.length;
		},
		guards: () => guards.slice(),
		hasDirty: () =>
			guards.some((g) => typeof g.isDirty === "function" && g.isDirty()),
	};
}

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	seqLog.push(`api:${method}:${path}`);
	if (method === "GET" && path === BASE) {
		if (holdBookGets > 0) {
			holdBookGets -= 1;
			heldBook = makeDeferred();
			return heldBook.promise;
		}
		if (bookFail) return Promise.reject(new Error("书籍读取失败"));
		return Promise.resolve({ book: bookFixture });
	}
	if (method === "GET" && path === BASE2) {
		if (bookFail) return Promise.reject(new Error("书籍读取失败"));
		return Promise.resolve({ book: { id: 8, master_outline: "B2总纲" } });
	}
	if (
		method === "GET" &&
		(path === `${BASE}/outline/timeline` ||
			path === `${BASE2}/outline/timeline`)
	) {
		timelineCallCount += 1;
		if (holdTimelineGets > 0) {
			holdTimelineGets -= 1;
			heldTimeline = makeDeferred();
			return heldTimeline.promise;
		}
		if (timelineFail) return Promise.reject(new Error("脉络轴读取失败"));
		if (timelineFailFromCall && timelineCallCount >= timelineFailFromCall)
			return Promise.reject(new Error("脉络轴刷新失败"));
		return Promise.resolve(timelineFixture);
	}
	if (method === "PUT" && (path === BASE || path === BASE2)) {
		if (deferredBookPut) {
			const gate = deferredBookPut;
			deferredBookPut = null;
			return gate.promise;
		}
		return Promise.resolve({});
	}
	if (/^\/api\/books\/[^/]+\/volumes\/\d+$/.test(path) && method === "PUT") {
		const id = Number(path.split("/").pop());
		if (volumeFailId === id) return Promise.reject(new Error("落盘失败"));
		return Promise.resolve({});
	}
	if (
		/^\/api\/books\/[^/]+\/volumes\/\d+\/summary$/.test(path) &&
		method === "POST"
	) {
		if (summaryFail) return Promise.reject(new Error("模型超时"));
		return Promise.resolve({});
	}
	if (/^\/api\/books\/[^/]+\/chapters\/\d+$/.test(path) && method === "PUT") {
		const id = Number(path.split("/").pop());
		if (beatPutBehavior === "conflict")
			return Promise.reject(
				Object.assign(new Error("冲突"), {
					code: "CHAPTER_CONFLICT",
					status: 409,
				}),
			);
		if (beatPutBehavior === "fail")
			return Promise.reject(new Error("节拍保存失败"));
		const chapter = { id, revision: 9 };
		if (body.beat != null) chapter.beat = body.beat;
		if (body.sort_order != null) chapter.sort_order = body.sort_order;
		return Promise.resolve({
			chapter,
			persistence: { durable: beatDurable },
		});
	}
	if (/^\/api\/books\/[^/]+\/chapters$/.test(path) && method === "POST") {
		return Promise.resolve({ chapter: adoptFixture });
	}
	if (
		/^\/api\/books\/[^/]+\/outline\/fill-gap$/.test(path) &&
		method === "POST"
	) {
		if (fillGapFail) return Promise.reject(new Error("AI 推演失败"));
		return Promise.resolve({ suggestions: fillGapFixture });
	}
	if (
		/^\/api\/books\/[^/]+\/outline\/tension-review$/.test(path) &&
		method === "POST"
	) {
		return Promise.resolve(tensionFixture);
	}
	if (method === "GET" && path === "/api/conversations?kind=agent&bookId=B1") {
		if (conversationsFail) return Promise.reject(new Error("会话列表失败"));
		return Promise.resolve(conversationsFixture);
	}
	if (method === "POST" && path === "/api/conversations") {
		return Promise.resolve({ id: 55, ...body });
	}
	if (method === "GET" && path === "/api/conversations/55/messages?limit=60") {
		if (messagesFail) return Promise.reject(new Error("历史读取失败"));
		return Promise.resolve(freshMessages());
	}
	return Promise.resolve({});
}

function ensureModalBody() {
	let el = document.getElementById("modal-body");
	if (!el) {
		el = document.createElement("div");
		el.id = "modal-body";
		document.body.appendChild(el);
	}
	return el;
}

function escapeHtml(value) {
	if (value == null) return "";
	return String(value).replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c],
	);
}

function buildWorkbenchContent() {
	document.getElementById("workbench-content")?.remove();
	const el = document.createElement("div");
	el.id = "workbench-content";
	document.body.appendChild(el);
	return el;
}

// S5-4 面板契约笔：挂载机制改本地 createRoot 直渲染（等值旧 window.OutlineWorkbench.show(route)：
// 每挂载一次＝一次全量重入重拉）；同一容器重挂＝旧树整个丢弃（等值旧 key=visit++ 重挂）
const mountedRoots = [];
let currentRoot = null;

function mountPanel(route, container) {
	const page = container || buildWorkbenchContent();
	if (currentRoot?.page === page) currentRoot.unmount();
	const root = createRoot(page);
	const entry = {
		page,
		root,
		alive: true,
		unmount() {
			if (!entry.alive) return;
			entry.alive = false;
			act(() => {
				root.unmount();
			});
		},
	};
	mountedRoots.push(entry);
	currentRoot = entry;
	act(() => {
		root.render(<OutlineWorkbenchPanel route={route} />);
	});
	return page;
}

afterEach(() => {
	setAppForTests(null);
	// L4（S4-7 低危残项核销）：卸载包进 act——子面板 cleanup 会经 registerApi(null) 触发父组件
	// state 更新（命令式句柄注销），在 act 外 unmount 会以「An update to … inside a test」告警污染
	// 输出（断言语义零改，纯 act 卫生）。
	while (mountedRoots.length) {
		const root = mountedRoots.pop();
		act(() => {
			root.unmount();
		});
	}
	currentRoot = null;
});

async function showAndLoad(route = ROUTE) {
	mountPanel(route);
	await act(async () => {});
	return document.getElementById("workbench-content");
}

// React 受控 input/textarea 的 jsdom 赋值必须走原生 setter（CharacterWorkbenchPanel.test.jsx 同款）
function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	// L4：受控 input 的原生 setter＋input 事件同样同步 setState（onBeatInput／onInput），
	// 派发包进 act（同上，卫生整改零断言语义改动）。
	act(() => {
		setter.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function submitForm(form) {
	form.dispatchEvent(
		new window.Event("submit", { bubbles: true, cancelable: true }),
	);
}

function fireDrag(el, type, extra) {
	// L4（S4-7 低危残项核销）：事件派发包进 act——指针/拖拽处理器会同步 setState（onMouseDown
	// 布防、onDragEnd 复位、onBeatInput 记态），在 act 外派发即「An update to … inside a test」
	// 告警来源（断言语义零改，纯 act 卫生）。
	act(() => {
		el.dispatchEvent(
			new window.MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				...(extra || {}),
			}),
		);
	});
}

beforeEach(() => {
	document.body.innerHTML = "";
	window.localStorage.clear();
	bookFixture = freshBook();
	timelineFixture = freshTimeline();
	bookFail = false;
	timelineFail = false;
	timelineFailFromCall = 0;
	timelineCallCount = 0;
	holdBookGets = 0;
	holdTimelineGets = 0;
	heldBook = null;
	heldTimeline = null;
	volumeFailId = null;
	summaryFail = false;
	beatPutBehavior = null;
	beatDurable = false;
	deferredBookPut = null;
	fillGapFixture = [
		{
			title: "衔接章甲",
			beat: "甲拍点",
			rationale: "承上启下",
		},
	];
	fillGapFail = false;
	adoptFixture = { id: 201, volume_id: 31, sort_order: 3, revision: 1 };
	tensionFixture = {
		comment: "整体推进稳健",
		chapter_scores: { 101: 5, 102: 2 },
	};
	conversationsFixture = freshConversations();
	conversationsFail = false;
	messagesFail = false;
	agentStreamBehavior = {};
	chatHold = false;
	heldChat = null;
	stoppedReasons = [];
	abortHandles = [];
	consumeCalls = [];
	apiCalls = [];
	fetchCalls = [];
	toasts = [];
	lastModal = null;
	seqLog = [];
	window.location.hash = "";
	window.App = {
		api: mockApi,
		escapeHtml: escapeHtml,
		openModal(opts) {
			lastModal = opts;
			ensureModalBody().innerHTML = opts.bodyHTML || "";
		},
		toast(msg) {
			toasts.push(String(msg));
		},
	};
	// P6-2：App 取用改 lib 单例直取（§2.5-D1），harness 经注入缝装同一桩
	setAppForTests(window.App);
	window.WorkspaceState = makeWorkspaceStateMock();
	// ChatEventHub mock：chat-event-hub.js:108-123 createAbort 与 :264-333 consumeAgentStream 契约
	window.ChatEventHub = {
		createAbort() {
			const ctl = new AbortController();
			const handle = {
				signal: ctl.signal,
				stop(why) {
					stoppedReasons.push(why || "user");
					ctl.abort(why);
				},
				stopped() {
					return ctl.signal.aborted;
				},
				reason() {
					return ctl.signal.reason;
				},
			};
			abortHandles.push(handle);
			return handle;
		},
		newRequestId(prefix) {
			return `${prefix || "req"}_mock`;
		},
		isJsonResponse(res) {
			return String(res?.headers?.get("content-type") || "").includes(
				"application/json",
			);
		},
		async consumeAgentStream(resp, handlers) {
			consumeCalls.push(resp);
			const b = agentStreamBehavior;
			let acc = "";
			if (b.delta) {
				acc += b.delta;
				handlers.onDelta?.(b.delta);
			}
			if (b.toolCall)
				handlers.onToolCall?.({ toolCallId: "t1", toolName: b.toolCall });
			if (b.error) handlers.onError?.({ message: b.error });
			const text = b.doneText || acc;
			if (text) handlers.onDone?.({ text, run: null });
			return {
				text,
				aborted: !!b.aborted,
				toolErrors: b.toolErrors || [],
			};
		},
	};
	// P6-2：同一假体接进模块 mock 的 holder（window.ChatEventHub 保留供桥旧名面口径不变）
	hubHolder.current = window.ChatEventHub;
	// fetch stub：小助手唯一直接 fetch 的出口（outline-assistant.js:156-162）
	globalThis.fetch = async (url, opts) => {
		fetchCalls.push({
			url,
			method: opts?.method,
			body: opts?.body ? JSON.parse(opts.body) : null,
			hasSignal: !!opts?.signal,
		});
		if (chatHold) {
			heldChat = makeDeferred();
			return heldChat.promise;
		}
		return {
			ok: true,
			status: 200,
			headers: {
				get: (k) =>
					String(k).toLowerCase() === "content-type"
						? "text/event-stream"
						: null,
			},
			json: async () => ({}),
		};
	};
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
	setWorkspaceStateForTests(window.WorkspaceState);
});

afterEach(() => {
	setAppForTests(null);
	setWorkspaceStateForTests(null);
});

describe("OutlineWorkbenchPanel 组件（范式 A·判定 C 旧名桥）", () => {
	it("L1 直渲染重挂（mount 配方退役）：组件导出契约＋两次挂载即两次全量重拉（:114-121）", async () => {
		// 组件导出契约：红态时本 import 即整文件红（Plan §4 红态语义）
		expect(typeof OutlineWorkbenchPanel).toBe("function");
		expect(typeof OutlineTimelinePanel).toBe("function");
		expect(typeof OutlineAssistantPanel).toBe("function");
		// 旧名桥/挂载目标缺失 no-op/容器重写弃旧建新三面随配方退役（接收方＝WorkbenchPage.test.jsx
		// W1 壳面 id 一致性与 W6 外壳 key 重挂）；本组保留首屏两拉＋重挂重拉的等价证据。
		await showAndLoad();
		expect(apiCalls.filter((c) => c.path === BASE).length).toBe(1);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBe(1);
		// 重挂＝外壳 key=<module|entityId|tab> 重挂（WorkbenchPage.test.jsx W6）：两次挂载两次全量重拉
		await showAndLoad();
		expect(apiCalls.filter((c) => c.path === BASE).length).toBe(2);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBe(2);
	});

	it("L2 首屏两拉＋切书过期丢弃：Promise.all 两 GET；晚到响应不写面板；加载异常 → .workbench-error（:121-127/:182）", async () => {
		// 首屏两拉（:124）＋beginRequest('outline', bookId) 令牌（:121）
		const page = await showAndLoad();
		expect(apiCalls.some((c) => c.method === "GET" && c.path === BASE)).toBe(
			true,
		);
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/outline/timeline`,
			),
		).toBe(true);
		expect(seqLog).toContain("ws:beginRequest:outline:B1");
		expect(seqLog.some((s) => s.startsWith("ws:isCurrent:outline"))).toBe(true);

		// 晚到响应丢弃（:126-127）：第一次两 GET 挂起 → 切书 B2 正常渲染 → 旧响应放行不回写
		holdBookGets = 1;
		holdTimelineGets = 1;
		const page2 = buildWorkbenchContent();
		mountPanel(ROUTE, page2);
		await act(async () => {});
		expect(heldBook).toBeTruthy();
		expect(heldTimeline).toBeTruthy();
		mountPanel(ROUTE2, page2);
		await act(async () => {});
		expect(page2.querySelector("#workbench-master-outline").value).toBe(
			"B2总纲",
		);
		await act(async () => {
			heldBook.resolve({ book: { id: 8, master_outline: "过期书总纲" } });
			heldTimeline.resolve(freshTimeline());
		});
		expect(page2.querySelector("#workbench-master-outline").value).toBe(
			"B2总纲",
		); // 过期响应不得回写
		expect(page).toBeTruthy();

		// 加载异常 → .workbench-error（:182）
		bookFail = true;
		const page3 = await showAndLoad();
		expect(page3.querySelector(".workbench-error").textContent).toBe(
			"书籍读取失败",
		);
	});

	it("L3 页面骨架与卷卡：头部/总纲/四字段卷卡/总结只读＋按钮两态；空卷态；未归卷块（:98-111/:132-134）", async () => {
		const page = await showAndLoad();
		// 头部（:132 逐字）
		expect(
			page.querySelector(".workspace-heading .workbench-kicker").textContent,
		).toBe("STORY ARCHITECTURE");
		expect(page.querySelector(".workspace-heading h2").textContent).toBe(
			"大纲工作台",
		);
		expect(page.querySelector(".workspace-heading p").textContent).toBe(
			"总纲定方向，卷纲定阶段，脉络轴上排章节、写拍点、看节奏。",
		);
		expect(page.querySelector("#outline-night-toggle")).not.toBeNull();
		expect(page.querySelector("#save-outline-workbench").textContent).toBe(
			"保存全部大纲",
		);
		// 总纲（:132）
		expect(page.querySelector("#workbench-master-outline").value).toBe(
			"旧总纲",
		);
		expect(
			page.querySelector("#workbench-master-outline").getAttribute("rows"),
		).toBe("9");
		// 卷卡四字段（:106-111）
		const cards = page.querySelectorAll(".volume-outline-card[data-volume]");
		expect(cards.length).toBe(2);
		const card1 = cards[0];
		expect(card1.getAttribute("data-volume")).toBe("31");
		expect(card1.querySelector("span").textContent).toBe("第 1 卷 · 2 章");
		expect(card1.querySelector("[data-volume-title]").value).toBe("第一卷");
		expect(card1.querySelector("[data-volume-intro]").value).toBe("卷一目标");
		expect(card1.querySelector("[data-volume-outline]").value).toBe("卷一大纲");
		const summary = card1.querySelector("[data-volume-summary]");
		expect(summary.readOnly).toBe(true);
		expect(summary.placeholder).toBe("（尚未生成）");
		expect(summary.value).toBe("");
		// 按钮两态（:110）
		expect(card1.querySelector("[data-gen-summary]").textContent).toBe(
			"生成并保存卷总结",
		);
		const card2 = cards[1];
		expect(card2.querySelector("[data-volume-summary]").value).toBe(
			"已有卷总结",
		);
		expect(card2.querySelector("[data-gen-summary]").textContent).toBe(
			"重新生成并保存卷总结",
		);
		// 未归卷块（:98-104/:133）
		const loose = page.querySelector(
			"#outline-loose-chapters .master-outline-card",
		);
		expect(loose).not.toBeNull();
		expect(loose.querySelector(".workbench-kicker").textContent).toBe(
			"未归卷章节",
		);
		expect(loose.querySelector(".field-hint").textContent).toBe(
			"这些章节不属于任何卷，不进脉络轴。到章节页把它们归卷后再回来排布。",
		);
		expect(
			Array.from(loose.querySelectorAll("li")).map((li) => li.textContent),
		).toEqual(["未归卷章"]);
		// 空卷态（:133）
		timelineFixture = { volumes: [], chapters: [], intensity: {} };
		const page2 = await showAndLoad();
		const empty = page2.querySelector(".workbench-empty-card");
		expect(empty.querySelector("h3").textContent).toBe("还没有分卷");
		expect(empty.querySelector("p").textContent).toBe(
			"到章节页创建第一卷后，这里会出现脉络轴。",
		);
	});

	it("L4 夜览开关：初始由 localStorage 决定类与文案；点击切换＋写回（:16-17/:151-156）", async () => {
		// 初始无记录 → 日间态（:17/:132）
		let page = await showAndLoad();
		expect(page.querySelector(".outline-workspace").className).not.toContain(
			"outline-night",
		);
		expect(page.querySelector("#outline-night-toggle").textContent).toBe(
			"☾ 夜览",
		);
		// 点击 → 夜览态＋localStorage 写回（:151-156）
		await act(async () => {
			page.querySelector("#outline-night-toggle").click();
		});
		expect(page.querySelector(".outline-workspace").className).toContain(
			"outline-night",
		);
		expect(page.querySelector("#outline-night-toggle").textContent).toBe(
			"☀ 日间",
		);
		expect(window.localStorage.getItem("mozhen-outline-night")).toBe("1");
		// 再点 → 回日间＋写 '0'
		await act(async () => {
			page.querySelector("#outline-night-toggle").click();
		});
		expect(page.querySelector(".outline-workspace").className).not.toContain(
			"outline-night",
		);
		expect(window.localStorage.getItem("mozhen-outline-night")).toBe("0");
		// 初始有记录 → 夜览态
		window.localStorage.setItem("mozhen-outline-night", "1");
		page = await showAndLoad();
		expect(page.querySelector(".outline-workspace").className).toContain(
			"outline-night",
		);
		expect(page.querySelector("#outline-night-toggle").textContent).toBe(
			"☀ 日间",
		);
	});

	it("L5 保存全部成功：flushBeats → PUT 总纲 → 逐卷 PUT；toast 逐字＋dirty 清（:21-51）", async () => {
		const page = await showAndLoad();
		setInputValue(page.querySelector("#workbench-master-outline"), "新总纲");
		setInputValue(
			page.querySelector('[data-volume="31"] [data-volume-title]'),
			"卷一改名",
		);
		setInputValue(
			page.querySelector('[data-volume="32"] [data-volume-outline]'),
			"卷二大纲改",
		);
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			page.querySelector("#save-outline-workbench").click();
		});
		const puts = apiCalls.filter((c) => c.method === "PUT");
		expect(puts.map((c) => c.path)).toEqual([
			BASE,
			`${BASE}/volumes/31`,
			`${BASE}/volumes/32`,
		]);
		expect(puts[0].body).toEqual({ master_outline: "新总纲" });
		expect(puts[1].body).toEqual({
			title: "卷一改名",
			intro: "卷一目标",
			outline: "卷一大纲",
		});
		expect(puts[2].body).toEqual({
			title: "第二卷",
			intro: "",
			outline: "卷二大纲改",
		});
		expect(toasts).toContain("大纲已保存");
		expect(window.WorkspaceState.hasDirty()).toBe(false); // :45-49 settle 清脏
	});

	it("L6 保存部分失败与竞态：卷 503 中断＋草稿留＋不报已保存＋不再续卷；飞行中输入 → settle false toast＋仍脏（:38-48）", async () => {
		const page = await showAndLoad();
		setInputValue(
			page.querySelector("#workbench-master-outline"),
			"改了一半的总纲",
		);
		setInputValue(
			page.querySelector('[data-volume="31"] [data-volume-title]'),
			"卷一改",
		);
		volumeFailId = 31; // :37-38 第一卷落库失败即 break
		await act(async () => {
			page.querySelector("#save-outline-workbench").click();
		});
		expect(toasts.some((t) => t.includes("保存中断（保存失败）"))).toBe(true);
		expect(toasts.some((t) => t.includes("大纲已保存"))).toBe(false);
		expect(page.querySelector("#workbench-master-outline").value).toBe(
			"改了一半的总纲",
		); // 草稿留在表单
		expect(
			page.querySelector('[data-volume="31"] [data-volume-title]').value,
		).toBe("卷一改");
		expect(
			apiCalls.some(
				(c) => c.method === "PUT" && c.path === `${BASE}/volumes/32`,
			),
		).toBe(false); // break 后续卷不发
		expect(window.WorkspaceState.hasDirty()).toBe(true); // :41-44 不清脏

		// 保存 await 期间再输入（:45-48）
		volumeFailId = null;
		const page2 = await showAndLoad();
		setInputValue(page2.querySelector("#workbench-master-outline"), "第一版");
		const gate = makeDeferred();
		deferredBookPut = gate;
		await act(async () => {
			page2.querySelector("#save-outline-workbench").click();
		});
		setInputValue(
			page2.querySelector("#workbench-master-outline"),
			"飞行中再改",
		);
		await act(async () => {
			gate.resolve({});
		});
		expect(toasts).toContain(
			"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
		);
		expect(window.WorkspaceState.hasDirty()).toBe(true);
	});

	it("L7 flushBeats 失败闸门：未落库节拍保存失败 → toast 逐字＋不发任何 PUT（:22-25）", async () => {
		const page = await showAndLoad();
		// 制造未落库节拍：input 后 900ms 防抖保存失败（非冲突）
		beatPutBehavior = "fail";
		setInputValue(page.querySelector('[data-beat="101"]'), "改不动的拍点");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 1000));
		});
		expect(page.querySelector('[data-beat-state="101"]').textContent).toBe(
			"保存失败：节拍保存失败",
		);
		// 点保存全部：flushBeats 仍失败 → 闸门文案，且总纲/卷 PUT 一律不发
		await act(async () => {
			page.querySelector("#save-outline-workbench").click();
		});
		expect(toasts).toContain(
			"有章节拍点未能保存（可能冲突），请先处理红色提示再保存大纲",
		);
		// 闸门生效：总纲/卷 PUT 一律不发；节拍 PUT 恰 2 次（首次防抖失败＋flushBeats 重试，
		// 等值旧 flushBeats 对仍脏的拍点重发——outline-timeline.js:158-165）
		const puts = apiCalls.filter((c) => c.method === "PUT");
		expect(puts.length).toBe(2);
		expect(puts.every((c) => c.path === `${BASE}/chapters/101`)).toBe(true);
		expect(apiCalls.some((c) => c.method === "PUT" && c.path === BASE)).toBe(
			false,
		);
	});

	it("L8 守卫注册与 dirty 判定：clearGuards 先＋label 逐字＋isDirty/save/discard；拍点脏计入；卸载不注销（:53-73）", async () => {
		const page = await showAndLoad();
		expect(seqLog.indexOf("ws:clearGuards")).toBeGreaterThanOrEqual(0);
		expect(seqLog.indexOf("ws:clearGuards")).toBeLessThan(
			seqLog.indexOf("ws:registerGuard"),
		);
		const guard = window.WorkspaceState.guards().find(
			(g) => g.key === "outline",
		);
		expect(guard).toBeTruthy();
		expect(guard.label).toBe("大纲工作台");
		expect(typeof guard.isDirty).toBe("function");
		expect(typeof guard.save).toBe("function");
		expect(typeof guard.discard).toBe("function");
		// 总纲字段 input → isDirty 真（:56-57/:66-67）
		setInputValue(page.querySelector("#workbench-master-outline"), "脏总纲");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		// save 等价：落库成功 true＋dirty 清
		await act(async () => {
			expect(await guard.save()).toBe(true);
		});
		expect(toasts).toContain("大纲已保存");
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		// discard 清 tracker
		setInputValue(page.querySelector("#workbench-master-outline"), "再改");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		act(() => {
			guard.discard();
		});
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		// 未落库节拍也计入（:67-68 hasDirtyBeats）
		setInputValue(page.querySelector('[data-beat="101"]'), "新拍点未保存");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		// 再 show：clearGuards 按 key 清旧 → 仍恰 1 个（:62）
		await showAndLoad();
		expect(window.WorkspaceState.guards().length).toBe(1);
		// 组件卸载不注销守卫（跨模块存续语义，LedgerWorkbenchPanel L15 同款）
		currentRoot.unmount();
		await act(async () => {});
		expect(window.WorkspaceState.guards().length).toBe(1);
		expect(window.WorkspaceState.guards()[0].key).toBe("outline");
	});

	it("L9 卷总结生成：POST /volumes/:id/summary {} → toast 逐字→整页重渲重拉；失败 toast＋按钮恢复（:164-178）", async () => {
		const page = await showAndLoad();
		const before = apiCalls.filter((c) => c.path === BASE).length;
		await act(async () => {
			page.querySelector('[data-gen-summary="31"]').click();
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/volumes/31/summary`,
		);
		expect(post.body).toEqual({});
		expect(toasts).toContain("卷总结已生成并保存");
		// :171 整页重渲＝重拉（GET book＋timeline 各 +1）
		expect(apiCalls.filter((c) => c.path === BASE).length).toBe(before + 1);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBeGreaterThan(1);
		// 失败路径：toast 逐字＋按钮恢复「生成并保存卷总结」（:173-176）
		summaryFail = true;
		const page2 = await showAndLoad();
		await act(async () => {
			page2.querySelector('[data-gen-summary="31"]').click();
		});
		expect(toasts).toContain("卷总结生成失败：模型超时");
		expect(page2.querySelector('[data-gen-summary="31"]').textContent).toBe(
			"生成并保存卷总结",
		);
		expect(page2.querySelector('[data-gen-summary="31"]').disabled).toBe(false);
	});

	it("L10 脉络轴插槽与刷新纪律：每卷 tl-slot；结构变化只重渲插槽/未归卷（卷编辑器不被重写）；刷新前先 flushBeats；失败 toast（:79-96/:138-145）", async () => {
		const page = await showAndLoad();
		// 每卷插槽（:140-142）
		expect(page.querySelector('.tl-slot[data-tl-slot="31"]')).not.toBeNull();
		expect(
			page.querySelector('.tl-slot[data-tl-slot="31"] .tl-root'),
		).not.toBeNull();
		expect(
			page.querySelector('.tl-slot[data-tl-slot="32"] .tl-root'),
		).not.toBeNull();
		// 卷编辑器输入（结构变化不得重写）
		setInputValue(
			page.querySelector("#workbench-master-outline"),
			"编辑中的总纲",
		);
		setInputValue(
			page.querySelector('[data-volume="31"] [data-volume-intro]'),
			"编辑中的阶段目标",
		);
		// dirty 拍点：结构变化前应先 flushBeats（:84 flushFirst 路径）
		beatPutBehavior = null;
		setInputValue(page.querySelector('[data-beat="101"]'), "待落库拍点");
		// 触发结构变化：把第 2 张卡（章 102）拖到第 1 张卡（章 101）上半 → drop-before
		// → reorderVolume 真重排 → onStructureChanged（:240）
		const slot31 = page.querySelector('.tl-slot[data-tl-slot="31"]');
		const cards = slot31.querySelectorAll(".tl-card");
		const node0 = cards[0].closest(".tl-node");
		node0.getBoundingClientRect = () => ({ top: 0, height: 100 });
		cards[0].getBoundingClientRect = () => ({ top: 0, height: 100 });
		fireDrag(slot31.querySelector(".tl-drag"), "mousedown");
		act(() => {
			cards[1].dispatchEvent(new window.Event("dragstart", { bubbles: true }));
		});
		await act(async () => {
			fireDrag(cards[0], "dragover", { clientY: 10 }); // 上半 → before
		});
		await act(async () => {
			cards[0].dispatchEvent(
				new window.Event("drop", { bubbles: true, cancelable: true }),
			);
		});
		await act(async () => {});
		// 重排 PUT：仅 sort_order 变化的章，自 1 起（:224-235）；排除 flushBeats 的节拍 PUT
		const orderPuts = apiCalls.filter(
			(c) =>
				c.method === "PUT" &&
				/\/chapters\/\d+$/.test(c.path) &&
				(!c.body || !Object.hasOwn(c.body, "beat")),
		);
		expect(orderPuts.map((c) => c.path)).toEqual([
			`${BASE}/chapters/102`,
			`${BASE}/chapters/101`,
		]);
		// 刷新前先 flushBeats：节拍 PUT 早于刷新 GET（:84）
		const beatPutIdx = apiCalls.findIndex(
			(c) =>
				c.method === "PUT" &&
				c.path === `${BASE}/chapters/101` &&
				c.body &&
				Object.hasOwn(c.body, "beat"),
		);
		const refreshIdx = apiCalls.reduce(
			(acc, c, i) =>
				c.method === "GET" && c.path === `${BASE}/outline/timeline` ? i : acc,
			-1,
		); // 末次（＝本次刷新）GET
		expect(beatPutIdx).toBeGreaterThanOrEqual(0);
		expect(beatPutIdx).toBeLessThan(refreshIdx);
		// 只重渲插槽与未归卷：卷编辑器值不被重写（:79-96 重渲染纪律）
		expect(page.querySelector("#workbench-master-outline").value).toBe(
			"编辑中的总纲",
		);
		expect(
			page.querySelector('[data-volume="31"] [data-volume-intro]').value,
		).toBe("编辑中的阶段目标");
		// 刷新失败 → toast 逐字（:144）
		const page2 = await showAndLoad();
		timelineFail = true;
		const slot31b = page2.querySelector('.tl-slot[data-tl-slot="31"]');
		const cards2 = slot31b.querySelectorAll(".tl-card");
		const node0b = cards2[0].closest(".tl-node");
		node0b.getBoundingClientRect = () => ({ top: 0, height: 100 });
		cards2[0].getBoundingClientRect = () => ({ top: 0, height: 100 });
		fireDrag(slot31b.querySelector(".tl-drag"), "mousedown");
		act(() => {
			cards2[1].dispatchEvent(new window.Event("dragstart", { bubbles: true }));
		});
		await act(async () => {
			fireDrag(cards2[0], "dragover", { clientY: 10 });
		});
		await act(async () => {
			cards2[0].dispatchEvent(
				new window.Event("drop", { bubbles: true, cancelable: true }),
			);
		});
		await act(async () => {});
		expect(toasts.some((t) => t.startsWith("脉络轴刷新失败："))).toBe(true);
	});

	it("L11 节拍自动保存契约：input→未保存＋900ms 防抖；PUT payload；durable false 文案；冲突/其他失败；值未变不发；blur 立即；卸载清定时器（:114-168）", async () => {
		const origSetTimeout = window.setTimeout;
		const origClearTimeout = window.clearTimeout;
		const timers = [];
		window.setTimeout = (fn, ms) => {
			const id = 900001 + timers.length;
			timers.push({ id, fn, ms });
			return id;
		};
		window.clearTimeout = (id) => {
			for (let i = timers.length - 1; i >= 0; i--) {
				if (timers[i].id === id) timers.splice(i, 1);
			}
		};
		try {
			const page = await showAndLoad();
			// input → dirty 状态位「未保存」＋900ms 防抖（:143-148）
			setInputValue(page.querySelector('[data-beat="101"]'), "新拍点甲");
			const state = page.querySelector('[data-beat-state="101"]');
			expect(state.textContent).toBe("未保存");
			expect(state.className).toContain("dirty");
			const debounce = timers.filter((t) => t.ms === 900);
			expect(debounce.length).toBe(1);
			expect(
				apiCalls.filter(
					(c) => c.method === "PUT" && c.path === `${BASE}/chapters/101`,
				).length,
			).toBe(0); // 900ms 内不发
			// 到期保存：payload 恰 {beat, expected_revision}（:123）
			await act(async () => {
				debounce[0].fn();
			});
			await act(async () => {});
			const put = apiCalls.find(
				(c) => c.method === "PUT" && c.path === `${BASE}/chapters/101`,
			);
			expect(put.body).toEqual({ beat: "新拍点甲", expected_revision: 5 });
			// durable===false → 「已保存（磁盘写入重试中）」（:126）
			expect(state.textContent).toBe("已保存（磁盘写入重试中）");
			expect(state.className).toContain("saved");
			expect(timers.filter((t) => t.ms === 900).length).toBe(0); // 定时器已清

			// 值未变 → 不发请求（:119）
			const putsBefore = apiCalls.filter((c) => c.method === "PUT").length;
			setInputValue(page.querySelector('[data-beat="101"]'), "新拍点甲");
			await act(async () => {
				timers
					.filter((t) => t.ms === 900)
					.forEach((t) => {
						t.fn();
					});
			});
			await act(async () => {});
			expect(apiCalls.filter((c) => c.method === "PUT").length).toBe(
				putsBefore,
			);
			expect(state.textContent).toBe(""); // 状态位清空

			// 冲突：CHAPTER_CONFLICT → 状态位逐字＋toast＋onConflict（:128-131）。
			// 挂起刷新 GET：先断言冲突态与守卫仍脏（节拍脏态跨刷新保留——等值旧模块态），
			// 再放行 refreshTimelines(false)（:145，冲突路径不 flushBeats）。
			beatPutBehavior = "conflict";
			holdTimelineGets = 1;
			setInputValue(page.querySelector('[data-beat="101"]'), "冲突拍点");
			await act(async () => {
				timers
					.filter((t) => t.ms === 900)
					.forEach((t) => {
						t.fn();
					});
			});
			await act(async () => {});
			expect(state.textContent).toBe("冲突：内容已在别处更新");
			expect(state.className).toContain("failed");
			expect(toasts).toContain(
				"节拍保存冲突：该章已在别处更新，正在刷新脉络轴",
			);
			expect(apiCalls[apiCalls.length - 1].path).toBe(
				`${BASE}/outline/timeline`,
			); // onConflict → refreshTimelines(false)（:145）
			// 节拍脏态跨刷新保留：守卫仍认为脏（等值旧 state.beatDirty 不被 render 清）
			expect(window.WorkspaceState.hasDirty()).toBe(true);
			await act(async () => {
				heldTimeline.resolve(freshTimeline());
			});
			expect(holdTimelineGets).toBe(0);

			// 其他失败 → 「保存失败：<msg>」（:133）
			beatPutBehavior = "fail";
			setInputValue(page.querySelector('[data-beat="101"]'), "失败拍点");
			await act(async () => {
				timers
					.filter((t) => t.ms === 900)
					.forEach((t) => {
						t.fn();
					});
			});
			await act(async () => {});
			expect(state.textContent).toBe("保存失败：节拍保存失败");

			// blur 立即保存（不等防抖）（:149-153）
			const timersBeforeBlur = timers.length;
			beatPutBehavior = null;
			setInputValue(page.querySelector('[data-beat="101"]'), "blur 拍点");
			expect(timers.length).toBe(timersBeforeBlur + 1); // 防抖定时器在
			await act(async () => {
				page
					.querySelector('[data-beat="101"]')
					.dispatchEvent(new window.Event("focusout", { bubbles: true }));
			});
			await act(async () => {});
			expect(timers.filter((t) => t.ms === 900).length).toBe(0); // blur 清掉防抖
			const blurPut = apiCalls.filter(
				(c) => c.method === "PUT" && c.path === `${BASE}/chapters/101`,
			);
			expect(blurPut[blurPut.length - 1].body.beat).toBe("blur 拍点");
			// durable 缺省/true → 「已保存」（:126 另一分支）
			beatDurable = true;
			setInputValue(page.querySelector('[data-beat="101"]'), "耐久拍点");
			await act(async () => {
				timers
					.filter((t) => t.ms === 900)
					.forEach((t) => {
						t.fn();
					});
			});
			await act(async () => {});
			expect(state.textContent).toBe("已保存");

			// 卸载清定时器（:365 effect cleanup 等值）
			setInputValue(page.querySelector('[data-beat="102"]'), "未落库就卸载");
			expect(timers.filter((t) => t.ms === 900).length).toBeGreaterThan(0);
			currentRoot.unmount();
			await act(async () => {});
			expect(timers.filter((t) => t.ms === 900).length).toBe(0);
		} finally {
			window.setTimeout = origSetTimeout;
			window.clearTimeout = origClearTimeout;
		}
	});

	it("L12 拖拽排序：仅同卷（跨卷拒绝）；把手控 draggable；drop→逐个 PUT sort_order 自 1 起仅改动章；成功/失败 toast；两路径都触发刷新（:174-241）", async () => {
		const page = await showAndLoad();
		const slot31 = page.querySelector('.tl-slot[data-tl-slot="31"]');
		const cards = slot31.querySelectorAll(".tl-card");
		const nodeA = cards[0].closest(".tl-node");
		const nodeB = cards[1].closest(".tl-node");
		nodeA.getBoundingClientRect = () => ({ top: 0, height: 100 });
		nodeB.getBoundingClientRect = () => ({ top: 0, height: 100 });
		cards[0].getBoundingClientRect = () => ({ top: 0, height: 100 });
		cards[1].getBoundingClientRect = () => ({ top: 0, height: 100 });
		// 把手控 draggable（:181-183）
		expect(cards[0].draggable).toBe(false);
		await act(async () => {
			fireDrag(slot31.querySelector(".tl-drag"), "mousedown");
		});
		expect(cards[0].draggable).toBe(true);
		await act(async () => {
			fireDrag(slot31.querySelector(".tl-drag"), "mouseup");
		});
		expect(cards[0].draggable).toBe(false);
		// dragstart 记录源章（章 102，卷内第 2 张卡）
		act(() => {
			cards[1].dispatchEvent(new window.Event("dragstart", { bubbles: true }));
		});
		// 跨卷拒绝：hover 卷 32 的卡不加 drop 类（:198）
		const slot32 = page.querySelector('.tl-slot[data-tl-slot="32"]');
		const card32 = slot32.querySelector(".tl-card");
		await act(async () => {
			fireDrag(card32, "dragover", { clientY: 10 });
		});
		expect(card32.className).not.toContain("drop-before");
		expect(card32.className).not.toContain("drop-after");
		// 同卷 hover：上半 → drop-before（:200-203）
		await act(async () => {
			fireDrag(cards[0], "dragover", { clientY: 10 });
		});
		expect(cards[0].className).toContain("drop-before");
		// drop → 102 移到 101 前：仅 sort_order 变化的章 PUT（自 1 起）（:215-235）
		await act(async () => {
			cards[0].dispatchEvent(
				new window.Event("drop", { bubbles: true, cancelable: true }),
			);
		});
		await act(async () => {});
		const orderPuts = apiCalls.filter(
			(c) => c.method === "PUT" && /\/chapters\/\d+$/.test(c.path),
		);
		expect(orderPuts.map((c) => c.path)).toEqual([
			`${BASE}/chapters/102`,
			`${BASE}/chapters/101`,
		]);
		expect(orderPuts[0].body).toEqual({ sort_order: 1, expected_revision: 2 });
		expect(orderPuts[1].body).toEqual({ sort_order: 2, expected_revision: 5 });
		expect(toasts).toContain("章节顺序已调整");
		// onStructureChanged → 刷新 GET（:240）
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBeGreaterThan(1);

		// 失败路径：toast 逐字＋仍触发刷新（:237-240）
		beatPutBehavior = "fail";
		act(() => {
			cards[1].dispatchEvent(new window.Event("dragstart", { bubbles: true }));
		});
		await act(async () => {
			fireDrag(cards[0], "dragover", { clientY: 10 });
		});
		await act(async () => {
			cards[0].dispatchEvent(
				new window.Event("drop", { bubbles: true, cancelable: true }),
			);
		});
		await act(async () => {});
		expect(toasts).toContain("排序保存失败：节拍保存失败（已恢复原顺序）");
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBeGreaterThan(2);
	});

	it("L17 拖拽取消清理（S4-7 L3 核销）：dragend 后 .tl-axis 内 drop-before/drop-after 零残留（等值 outline-timeline.js:189-191）", async () => {
		const page = await showAndLoad();
		const slot31 = page.querySelector('.tl-slot[data-tl-slot="31"]');
		const cards = slot31.querySelectorAll(".tl-card");
		// 源卡＝102（第 2 张），悬停目标卡＝101（第 1 张）——**必须是两张不同的卡**：
		// 同卡时 React 会因 dragging 类变化重写 className，掩盖残留（掩盖态不构成见证）。
		cards[0].getBoundingClientRect = () => ({ top: 0, height: 100 });
		await act(async () => {
			cards[1].dispatchEvent(new window.Event("dragstart", { bubbles: true }));
		});
		await act(async () => {
			fireDrag(cards[0], "dragover", { clientY: 10 }); // 上半 → 落 drop-before
		});
		expect(cards[0].className).toContain("drop-before");
		expect(cards[0].className).not.toContain("drop-after");
		// 取消拖拽（Esc／拖到卡外松手都会走 dragend）：指示类必须全清（legacy :189-191 全局清除）
		await act(async () => {
			cards[1].dispatchEvent(new window.Event("dragend", { bubbles: true }));
		});
		const axis = page.querySelector(".tl-axis");
		expect(axis.querySelectorAll(".drop-before,.drop-after").length).toBe(0);
		expect(cards[0].className).not.toContain("drop-before");
		expect(cards[0].className).not.toContain("drop-after");
	});

	it("L13 缝隙填补与采纳：四态按钮文案；POST fill-gap payload；推演中文案；弹窗 hint＋建议卡；采纳→建章＋整卷重排＋toast（:58-62/:83-88/:245-315）", async () => {
		timelineFixture.volumes.push({
			id: 33,
			sort_order: 3,
			title: "空卷",
			intro: "",
			outline: "",
			summary: "",
		});
		const page = await showAndLoad();
		const slot31 = page.querySelector('.tl-slot[data-tl-slot="31"]');
		// 四态按钮文案（:83-88）
		const labels = Array.from(slot31.querySelectorAll(".tl-gap")).map(
			(b) => b.textContent,
		);
		expect(labels).toEqual(["＋ 补卷首", "＋ 补衔接", "＋ 补卷末"]);
		const slot33 = page.querySelector('.tl-slot[data-tl-slot="33"]');
		expect(slot33.querySelector(".tl-gap").textContent).toBe("＋ 补第一章");
		// 补衔接（before=101, after=102）：payload（:254）
		await act(async () => {
			slot31.querySelectorAll(".tl-gap")[1].click();
		});
		const gap = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/outline/fill-gap`,
		);
		expect(gap.body).toEqual({
			volume_id: 31,
			before_chapter_id: 101,
			after_chapter_id: 102,
		});
		expect(slot31.querySelector(".tl-gap").textContent).toBe("＋ 补卷首"); // 结束恢复
		// 弹窗 hint 逐字＋建议卡（:266-274）
		expect(lastModal.title).toBe("衔接章方案");
		expect(lastModal.okText).toBe("关闭");
		const body = document.getElementById("modal-body");
		expect(body.querySelector(".field-hint").textContent).toBe(
			"AI 只给方案，不写库。点「采纳为章节」才会在该位置建章（标题与节拍可再改）。",
		);
		const card = body.querySelector(".gap-suggestion");
		expect(card.querySelector("strong").textContent).toBe("衔接章甲");
		expect(card.querySelector(".gap-beat").textContent).toBe("甲拍点");
		expect(card.querySelector(".gap-rationale").textContent).toBe("承上启下");
		expect(card.querySelector("[data-adopt-gap]").textContent).toBe(
			"采纳为章节",
		);
		// 采纳：POST /chapters payload＋before 时整卷重排＋toast 逐字（:284-309）
		await act(async () => {
			body.querySelector("[data-adopt-gap]").click();
		});
		const created = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/chapters`,
		);
		expect(created.body).toEqual({
			volume_id: 31,
			title: "衔接章甲",
			beat: "甲拍点",
		});
		const reorderPuts = apiCalls.filter(
			(c) => c.method === "PUT" && /\/chapters\/(201|102)$/.test(c.path),
		);
		expect(reorderPuts.map((c) => c.path)).toEqual([
			`${BASE}/chapters/201`,
			`${BASE}/chapters/102`,
		]);
		expect(reorderPuts[0].body).toEqual({
			sort_order: 2,
			expected_revision: 1,
		});
		expect(reorderPuts[1].body).toEqual({
			sort_order: 3,
			expected_revision: 2,
		});
		expect(toasts).toContain("已采纳并建章：《衔接章甲》");
		// onStructureChanged → 刷新（:309）
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/outline/timeline`).length,
		).toBeGreaterThan(1);
		// 失败路径（:257）
		fillGapFail = true;
		await act(async () => {
			slot31.querySelectorAll(".tl-gap")[1].click();
		});
		expect(toasts).toContain("缝隙填补失败：AI 推演失败");

		// L2（S4-7 低危残项核销）：两个 null-before 分支的 payload 直接断言——legacy
		// outline-timeline.js:252-254 对空值有显式转换（`before === '' ? null : Number(...)`），
		// 是易错点；此前只有「补衔接」（before=101, after=102）被断言。
		fillGapFail = false;
		await act(async () => {
			slot31.querySelectorAll(".tl-gap")[0].click(); // ＋ 补卷首：before=null, after=101
		});
		let gapCalls = apiCalls.filter(
			(c) => c.method === "POST" && c.path === `${BASE}/outline/fill-gap`,
		);
		expect(gapCalls[gapCalls.length - 1].body).toEqual({
			volume_id: 31,
			before_chapter_id: null,
			after_chapter_id: 101,
		});
		await act(async () => {
			slot33.querySelector(".tl-gap").click(); // 空卷 ＋ 补第一章：before=null, after=null
		});
		gapCalls = apiCalls.filter(
			(c) => c.method === "POST" && c.path === `${BASE}/outline/fill-gap`,
		);
		expect(gapCalls[gapCalls.length - 1].body).toEqual({
			volume_id: 33,
			before_chapter_id: null,
			after_chapter_id: null,
		});
	});

	it("L14 节奏评语：POST tension-review payload；分析中文案；弹窗 comment＋逐章张力行；空 scores hint；失败 toast（:319-352）", async () => {
		const page = await showAndLoad();
		await act(async () => {
			page.querySelector('[data-tension-review="31"]').click();
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/outline/tension-review`,
		);
		expect(post.body).toEqual({ volume_id: 31 });
		expect(lastModal.title).toBe("AI 节奏评语");
		expect(lastModal.okText).toBe("关闭");
		const body = document.getElementById("modal-body");
		expect(body.querySelector("blockquote.tension-comment").textContent).toBe(
			"整体推进稳健",
		);
		const rows = body.querySelectorAll(".tension-scores li");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".tl-score-dot").className).toBe(
			"tl-score-dot tier-4",
		); // clamp(5-1,1,4)=4
		expect(rows[0].textContent).toBe("第一章 起点 —— 张力 5/5");
		expect(rows[1].querySelector(".tl-score-dot").className).toBe(
			"tl-score-dot tier-1",
		); // clamp(2-1,1,4)=1
		expect(rows[1].textContent).toBe("暗流涌动 —— 张力 2/5");
		// 空 scores → hint（:350）
		tensionFixture = { comment: "无分数", chapter_scores: {} };
		const page2 = await showAndLoad();
		await act(async () => {
			page2.querySelector('[data-tension-review="31"]').click();
		});
		expect(
			document.getElementById("modal-body").querySelector(".field-hint")
				.textContent,
		).toBe("模型未给出逐章分数。");
		// 按钮恢复（:331-332）
		expect(page2.querySelector('[data-tension-review="31"]').textContent).toBe(
			"AI 节奏评语",
		);
	});

	it("L15 烈度与节奏条：tier 0-4 推导；柱高归一＋空柱；meta 与标题序号去重；strip 标题文案（:24-30/:34-56/:66-79）", async () => {
		const page = await showAndLoad();
		const slot31 = page.querySelector('.tl-slot[data-tl-slot="31"]');
		// tier：101 有 3 事件 max 4 → tier-4；102 无事件 → tier-0（:25-29）
		expect(
			slot31.querySelector('.tl-node[data-chapter="101"] .tl-dot').className,
		).toBe("tl-dot tier-4");
		expect(
			slot31.querySelector('.tl-node[data-chapter="101"] .tl-dot').title,
		).toBe("关键爆发"); // TIER_LABEL[4]（:30）
		expect(
			slot31.querySelector('.tl-node[data-chapter="102"] .tl-dot').className,
		).toBe("tl-dot tier-0");
		expect(
			slot31.querySelector('.tl-node[data-chapter="102"] .tl-dot').title,
		).toBe("无台账事件");
		// meta 拼接（:37-41）
		expect(
			slot31.querySelector('.tl-node[data-chapter="101"] .tl-meta').textContent,
		).toBe("3000 字 · 台账 3 条 · 关键爆发 · 已定稿");
		expect(
			slot31.querySelector('.tl-node[data-chapter="102"] .tl-meta').textContent,
		).toBe("偏离大纲");
		expect(
			slot31.querySelector('.tl-node[data-chapter="102"] .tl-beat-state'),
		).not.toBeNull();
		// 标题序号去重（:43-44）：已带「第N章」不重复；否则补序号
		expect(
			slot31.querySelector('.tl-node[data-chapter="101"] .tl-title')
				.textContent,
		).toBe("第一章 起点");
		expect(
			slot31.querySelector('.tl-node[data-chapter="102"] .tl-title')
				.textContent,
		).toBe("第 2 章 · 暗流涌动");
		// 节奏条（:66-79）
		const strip = slot31.querySelector(".tl-strip");
		expect(strip.querySelector(".tl-strip-label").textContent).toBe("节奏");
		expect(strip.querySelector(".tl-strip-label").title).toBe(
			"柱高=篇幅（字数），颜色=台账烈度（无事件为灰）",
		);
		const bars = strip.querySelectorAll(".tl-bar");
		expect(bars.length).toBe(2);
		expect(bars[0].className).toBe("tl-bar tier-4"); // 颜色=烈度
		expect(bars[0].style.height).toBe("40px"); // round(3000/3000*40)
		expect(bars[0].title).toBe(
			"第 1 章 第一章 起点：3000 字；台账 3 条，关键爆发",
		);
		expect(bars[1].className).toBe("tl-bar tier-0 tl-bar-empty"); // 无正文 4px 空柱
		expect(bars[1].style.height).toBe("4px");
		expect(bars[1].title).toBe(
			"第 2 章 暗流涌动：未写正文；台账 0 条，无台账事件",
		);
		// 无正文空卷无节奏条（:67 `if (!chapters.length) return ''`）
		const emptyTimeline = freshTimeline();
		emptyTimeline.volumes.push({
			id: 33,
			sort_order: 3,
			title: "第三卷",
			intro: "",
			outline: "",
			summary: "",
		});
		timelineFixture = emptyTimeline;
		const pageEmpty = await showAndLoad();
		const slot33 = pageEmpty.querySelector('.tl-slot[data-tl-slot="33"]');
		expect(slot33).not.toBeNull();
		expect(slot33.querySelector(".tl-strip")).toBeNull();
	});

	it("L16 小助手胶囊/会话/SSE：骨架文案＋芯片填入；loadHistory 前缀匹配＋未归档＋零会话 note；懒创建会话；发送 body 恰三键；onToolCall/aborted/空答/toolErrors；停止语义；卸载清理（:53-71/:96-196/:198-253）", async () => {
		const page = await showAndLoad();
		// 骨架（:53-71 逐字）
		const capsule = page.querySelector("#oa-capsule");
		expect(capsule).not.toBeNull();
		expect(capsule.title).toBe("大纲小助手：问我节奏、断层、下一章怎么接");
		expect(capsule.querySelector(".oa-capsule-label").textContent).toBe(
			"小助手",
		);
		expect(capsule.querySelector("svg").getAttribute("shape-rendering")).toBe(
			"crispEdges",
		);
		expect(capsule.querySelectorAll("rect").length).toBe(142); // PIXEL_ROWS 全量（:21-38）
		const panel = page.querySelector("#oa-panel");
		expect(panel.className).toContain("hidden"); // 初始收起
		expect(panel.querySelector(".oa-panel-title").textContent).toBe(
			"大纲小助手",
		);
		expect(panel.querySelector(".oa-panel-tag").textContent).toBe(
			"只读讨论 · 看得到总纲/卷纲/拍点",
		);
		expect(panel.querySelector("#oa-close").title).toBe("收起");
		expect(panel.querySelector("#oa-messages")).not.toBeNull();
		const chips = panel.querySelectorAll("[data-oa-chip]");
		expect(chips.length).toBe(3);
		expect(Array.from(chips).map((c) => c.textContent)).toEqual([
			"节奏体检",
			"拍点断层",
			"下一章方向",
		]);
		expect(panel.querySelector("#oa-input").placeholder).toBe(
			"问小助手：写大纲卡住了就说话…",
		);
		expect(panel.querySelector("#oa-send").textContent).toBe("发送");
		// 首次打开 → loadHistory（前缀匹配＋未归档，:96-103/:203-207）
		await act(async () => {
			capsule.click();
		});
		expect(panel.className).not.toContain("hidden");
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === "/api/conversations?kind=agent&bookId=B1",
			),
		).toBe(true);
		// 只显示 user/assistant 非空文本（:133-138）
		const msgs = Array.from(panel.querySelectorAll(".oa-msg"));
		expect(msgs.length).toBe(2);
		expect(msgs[0].className).toBe("oa-msg oa-user");
		expect(msgs[0].textContent).toBe("第一卷节奏如何");
		expect(msgs[1].className).toBe("oa-msg oa-assistant");
		expect(msgs[1].textContent).toBe("整体推进稳健");
		// 芯片填入 input（:212-218）
		await act(async () => {
			chips[0].click();
		});
		expect(panel.querySelector("#oa-input").value).toBe(
			"这卷的节奏怎么样？有没有连续平淡或高潮过密的地方？",
		);
		// 零会话 → note 逐字（:123-125）
		conversationsFixture = [];
		const page2 = await showAndLoad();
		await act(async () => {
			page2.querySelector("#oa-capsule").click();
		});
		expect(page2.querySelector("#oa-messages .oa-note").textContent).toBe(
			"我是这本书的大纲小助手。我能看到总纲、卷纲、章节拍点和台账节奏——写大纲卡住了就问我。",
		);
		// 有会话零消息 → note 逐字（:139）
		conversationsFixture = freshConversations();
		messagesFail = true;
		const page3 = await showAndLoad();
		await act(async () => {
			page3.querySelector("#oa-capsule").click();
		});
		expect(page3.querySelector("#oa-messages .oa-note").textContent).toBe(
			"历史加载失败：历史读取失败",
		);
		// 列表失败 → 按新会话处理（静默，:120）
		conversationsFail = true;
		const page4 = await showAndLoad();
		await act(async () => {
			page4.querySelector("#oa-capsule").click();
		});
		expect(page4.querySelector("#oa-messages .oa-note").textContent).toBe(
			"我是这本书的大纲小助手。我能看到总纲、卷纲、章节拍点和台账节奏——写大纲卡住了就问我。",
		);

		// 懒创建：发送前无 POST /api/conversations（:105-114）
		conversationsFail = false;
		messagesFail = false;
		conversationsFixture = [];
		const page5 = await showAndLoad();
		await act(async () => {
			page5.querySelector("#oa-capsule").click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === "/api/conversations",
			),
		).toBe(false);
		// 发送：body 恰三键＋走 consumeAgentStream（:159-163/:178）
		agentStreamBehavior = {
			delta: "第一段回答",
			toolCall: "list_planning_notes",
		};
		setInputValue(page5.querySelector("#oa-input"), "第一卷节奏如何");
		await act(async () => {
			submitForm(page5.querySelector("#oa-form"));
		});
		const convPost = apiCalls.find(
			(c) => c.method === "POST" && c.path === "/api/conversations",
		);
		expect(convPost.body).toEqual({
			kind: "agent",
			scope: "book",
			bookId: "B1",
			title: "大纲小助手 · 工作台内讨论",
		});
		const chat = fetchCalls.find((c) => c.url === "/api/agent/chat");
		expect(chat).toBeTruthy();
		expect(Object.keys(chat.body).sort()).toEqual([
			"content",
			"conversation_id",
			"request_id",
		]);
		expect(chat.body.conversation_id).toBe(55);
		expect(chat.body.content).toBe("第一卷节奏如何");
		expect(chat.body.request_id).toBe("oa_mock"); // newRequestId('oa')（:160）
		expect(chat.hasSignal).toBe(true);
		expect(consumeCalls.length).toBe(1); // 零自写 SSE 解析
		// onToolCall → note「查阅了 …」（:180）
		expect(
			Array.from(page5.querySelectorAll(".oa-note")).some((n) =>
				n.textContent.startsWith("查阅了 list_planning_notes"),
			),
		).toBe(true);
		expect(
			Array.from(page5.querySelectorAll(".oa-msg.oa-assistant")).some(
				(m) => m.textContent === "第一段回答",
			),
		).toBe(true);

		// aborted → 追加「（已停止）」（:184）
		agentStreamBehavior = { delta: "半句话", aborted: true };
		const page6 = await showAndLoad();
		await act(async () => {
			page6.querySelector("#oa-capsule").click();
		});
		setInputValue(page6.querySelector("#oa-input"), "打断的问题");
		await act(async () => {
			submitForm(page6.querySelector("#oa-form"));
		});
		expect(
			Array.from(page6.querySelectorAll(".oa-msg.oa-assistant")).some(
				(m) => m.textContent === "半句话\n（已停止）",
			),
		).toBe(true);

		// 空答 → note 逐字（:185）
		agentStreamBehavior = {};
		const page7 = await showAndLoad();
		await act(async () => {
			page7.querySelector("#oa-capsule").click();
		});
		setInputValue(page7.querySelector("#oa-input"), "空答问题");
		await act(async () => {
			submitForm(page7.querySelector("#oa-form"));
		});
		expect(
			Array.from(page7.querySelectorAll(".oa-msg.oa-assistant")).some(
				(m) => m.textContent === "（小助手没有给出文字回答，换个问法试试）",
			),
		).toBe(true);

		// toolErrors → 「工具被拒：…」（:186）
		agentStreamBehavior = {
			toolErrors: [
				{ message: "工具不可用", code: "TOOL_NOT_ALLOWED", toolName: "write" },
			],
		};
		const page8 = await showAndLoad();
		await act(async () => {
			page8.querySelector("#oa-capsule").click();
		});
		setInputValue(page8.querySelector("#oa-input"), "带工具错误的问题");
		await act(async () => {
			submitForm(page8.querySelector("#oa-form"));
		});
		expect(
			Array.from(page8.querySelectorAll(".oa-note")).some((n) =>
				n.textContent.startsWith("工具被拒：工具不可用"),
			),
		).toBe(true);

		// 发送中再提交 → stop('user')（:221-224）
		agentStreamBehavior = {};
		chatHold = true;
		const page9 = await showAndLoad();
		await act(async () => {
			page9.querySelector("#oa-capsule").click();
		});
		setInputValue(page9.querySelector("#oa-input"), "进行中的问题");
		await act(async () => {
			submitForm(page9.querySelector("#oa-form"));
		});
		expect(page9.querySelector("#oa-send").textContent).toBe("停止"); // :147
		await act(async () => {
			submitForm(page9.querySelector("#oa-form"));
		});
		expect(stoppedReasons).toContain("user");
		await act(async () => {
			heldChat.resolve({
				ok: true,
				status: 200,
				headers: { get: () => "text/event-stream" },
				json: async () => ({}),
			});
		});

		// 在途请求中卸载 → stop('unmount')＋#oa-root 移除（:243-246）
		agentStreamBehavior = {};
		chatHold = true;
		const page10 = await showAndLoad();
		await act(async () => {
			page10.querySelector("#oa-capsule").click();
		});
		setInputValue(page10.querySelector("#oa-input"), "卸载时仍在途");
		await act(async () => {
			submitForm(page10.querySelector("#oa-form"));
		});
		expect(page10.querySelector("#oa-send").textContent).toBe("停止");
		currentRoot.unmount();
		await act(async () => {});
		expect(stoppedReasons).toContain("unmount");
		expect(document.getElementById("oa-root")).toBeNull();
	});

	// P6-4 红测（plans/P6-4-plan-1.md §5）：S5-10-X4 域修正＋S5-4-X3 四处文本节点预转义直投。
	// R1 前提＝32 卷需两张卡，而共享 fixture 的 32 卷仅 1 章（:96 章 103）——各新例在**用例内局部
	// 增补** timelineFixture（beforeEach 每测重置＝共享 fixture 函数零改动、存量 17 例零影响）。
	it("L18 多卷非首卷取消拖拽清理（S5-10-X4）：第二卷 dragend 后本卷 .tl-axis 零残留；首卷轴不受牵连", async () => {
		timelineFixture.chapters.push({
			id: 105,
			volume_id: 32,
			title: "第四章乙",
			beat: "",
			revision: 1,
			sort_order: 2,
			content_length: 0,
			locked: false,
			drift_status: "on_track",
		});
		const page = await showAndLoad();
		const slot32 = page.querySelector('.tl-slot[data-tl-slot="32"]');
		const cards32 = slot32.querySelectorAll(".tl-card");
		expect(cards32.length).toBe(2); // 前提自证：32 卷两卡（源卡＋悬停卡）
		const hoverCard = cards32[0]; // 章 103（非源卡 ⇒ className prop 恒 tl-card，指示类不被重渲冲掉＝真见证）
		const sourceCard = cards32[1]; // 章 105
		hoverCard.getBoundingClientRect = () => ({ top: 0, height: 100 });
		await act(async () => {
			sourceCard.dispatchEvent(
				new window.Event("dragstart", { bubbles: true }),
			);
		});
		await act(async () => {
			fireDrag(hoverCard, "dragover", { clientY: 10 }); // 上半 → 落 drop-before
		});
		expect(hoverCard.className).toContain("drop-before");
		// 取消拖拽：清理域必须是源卡所在卷的轴（legacy bindDrag(root, volume) 逐卷作用域），
		// 不得取文档首个 .tl-axis（现实现＝31 卷轴 ⇒ 32 卷残留 ⇒ 红）
		await act(async () => {
			sourceCard.dispatchEvent(new window.Event("dragend", { bubbles: true }));
		});
		const axis32 = slot32.querySelector(".tl-axis");
		expect(axis32.querySelectorAll(".drop-before,.drop-after").length).toBe(0);
		expect(hoverCard.className).not.toContain("drop-before");
		expect(hoverCard.className).not.toContain("drop-after");
		// 首卷轴不受牵连（清理动作不得误伤他卷）
		const axis31 = page
			.querySelector('.tl-slot[data-tl-slot="31"]')
			.querySelector(".tl-axis");
		expect(axis31.querySelectorAll(".drop-before,.drop-after").length).toBe(0);
	});

	it("L19 未归卷章节标题含特殊字符直投（S5-4-X3:69）：loose <li> textContent 逐字等于原串", async () => {
		const raw = "A&B<C>D\"E'F";
		timelineFixture.chapters.push({
			id: 106,
			volume_id: null,
			title: raw,
			beat: "",
			revision: 1,
			sort_order: 1,
			content_length: 0,
			locked: false,
			drift_status: "on_track",
		});
		const page = await showAndLoad();
		const li = [...page.querySelectorAll("li")].find((n) =>
			n.textContent.includes("&"),
		);
		expect(li).toBeTruthy();
		// React 文本节点本就自动转义：esc() 预转义 ⇒ 用户看到实体串（现状）⇒ 红；直投后逐字
		expect(li.textContent).toBe(raw);
	});

	it("L20 加载失败消息含特殊字符直投（S5-4-X3:309）：.workbench-error textContent 逐字等于原串", async () => {
		const raw = "加载失败 &<B>\"D'E";
		const baseApi = window.App.api;
		window.App.api = (method, path, body) =>
			path === `${BASE}/outline/timeline`
				? Promise.reject(new Error(raw))
				: baseApi(method, path, body);
		const page = await showAndLoad();
		const err = page.querySelector(".workbench-error");
		expect(err).toBeTruthy();
		expect(err.textContent).toBe(raw);
	});

	it("L21 时间线卡标题含特殊字符直投（S5-4-X3:557）：.tl-title textContent 逐字等于原串", async () => {
		const raw = "第 2 章 &<X>\"Y'Z"; // 自带「第N章」序号 ⇒ hasOrdinal 命中，heading 逐字不加前缀
		timelineFixture.chapters.push({
			id: 107,
			volume_id: 32,
			title: raw,
			beat: "",
			revision: 1,
			sort_order: 2,
			content_length: 0,
			locked: false,
			drift_status: "on_track",
		});
		const page = await showAndLoad();
		const title = [...page.querySelectorAll(".tl-title")].find((n) =>
			n.textContent.includes("&"),
		);
		expect(title).toBeTruthy();
		expect(title.textContent).toBe(raw);
	});
});
