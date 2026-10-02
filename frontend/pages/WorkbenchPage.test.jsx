// @vitest-environment jsdom
// S5-4 红测 R6~R10（Plan §4）：WorkbenchPage——public/legacy/workbench-shell.js（217 行）整页外壳
// 等值迁 React（判定 C 旧名桥 window.WorkbenchShell = { show, parse } 由 legacy-bridge 守卫式供给；
// AppRouter.jsx:57 唯一生产消费点零改动）。
// 断言语义锚点＝legacy 活代码行号：
//   :5-10 labels／:12-24 parse／:27 href／:30-33 rememberEditor／:38-59 返回锚三态／:61-72 placeholder／
//   :74-84 handoff（本片改直接组合四面板）／:86-187 任务入口（fmtTime/toast 5s＋220ms 收铃铛/铃铛 toggle/
//   同 key 不重弹/无记录文案）／:189-214 show（标题/loading/nav 四链接/书题/error）。
// harness：jsdom＋React 19 act＋裸 DOM（不装 @testing-library）；#page-workbench 静态壳从
// frontend/index.html 真实文本提取（单一事实源；P6-3 源迁入）；window.WorkspaceState＝frontend/lib 真件（W8 走真链）；
// fetch 端点表＝test/workspace-navigation.test.js:290-372 defaultRoute 机械移植（book7 口径）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { chatApi } from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import {
	getWorkspaceState,
	parseWorkbenchRoute,
	setWorkspaceStateForTests,
} from "../lib/workspace-state.js";
import { bindWritingStatusRenderer } from "../lib/writing-status.js";
import {
	mountWorkbenchPage,
	resetWorkbenchShellState,
} from "./WorkbenchPage.jsx";

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
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;
const STATIC_WORKBENCH = STATIC_DOC.getElementById("page-workbench");

const BOOK7 = {
	id: 7,
	title: "雾港编年史",
	mode: "collab",
	master_outline: "原总纲",
};
const CHAPTER12 = {
	id: 12,
	title: "第1章 石碑",
	content: "石碑正文",
	revision: 3,
	volume_id: 1,
};
const VOLUME1 = { id: 1, sort_order: 1, title: "第一卷", outline: "卷大纲" };
const CHAR5 = { id: 5, name: "林昭", role: "主角", intro: "主角简介" };
const WORLD31 = { id: 31, title: "世界规则", content: "设定正文" };
const TASK_RUN = {
	type: "task",
	id: "run_9",
	title: "chat · write",
	bookId: 7,
	status: "paused",
	route: "#/agent",
	updatedAt: "2026-09-23T00:00:00.000Z",
	meta: { entry: "chat", mode: "write", reason: "output_truncated" },
};

function jsonFixture(method, url) {
	const noQuery = String(url).split("?")[0];
	if (method === "GET" && noQuery === "/api/books/7") return { book: BOOK7 };
	if (method === "GET" && noQuery === "/api/books/7/chapters/12")
		return { chapter: CHAPTER12 };
	if (method === "GET" && noQuery === "/api/books/7/world")
		return { entries: [WORLD31] };
	if (method === "GET" && noQuery === "/api/books/7/volumes")
		return { volumes: [VOLUME1] };
	if (method === "GET" && noQuery === "/api/books/7/characters")
		return { items: [CHAR5], characters: [CHAR5] };
	if (method === "GET" && noQuery === "/api/books/7/characters/5")
		return {
			character: CHAR5,
			aliases: [],
			relation_summary: { active: 0 },
			timeline_summary: { events: 0 },
			thread_summary: { open: 0 },
		};
	if (method === "GET" && noQuery === "/api/books/7/relation-types")
		return { types: [] };
	if (method === "GET" && noQuery === "/api/books/7/sidebar-preferences")
		return {
			preferences: {
				moduleOrder: ["characters", "ledger", "outline", "world", "chapters"],
				hiddenModules: [],
				summaryFields: {
					characters: ["name"],
					chapters: ["title"],
					outline: ["mainPlot"],
					ledger: ["progress"],
					world: ["name"],
				},
			},
		};
	if (method === "GET" && noQuery === "/api/books/7/outline/timeline")
		return { volumes: [VOLUME1], chapters: [CHAPTER12], intensity: {} };
	if (method === "GET" && noQuery === "/api/books/7/ledger/progress")
		return { summary: "", stale: false };
	if (method === "GET" && noQuery === "/api/books/7/ledger/proposals")
		return { items: [], page: { total: 0 } };
	if (method === "GET" && noQuery === "/api/books/7/ledger/threads")
		return { items: [] };
	if (method === "GET" && noQuery === "/api/books/7/ledger/issues")
		return { items: [] };
	if (method === "GET" && noQuery === "/api/books/7/ledger/backfill")
		return { status: null };
	if (method === "GET" && noQuery === "/api/books/7/health")
		return {
			index: { locked_missing: 0 },
			extraction: { locked_pending: 0 },
			summary: { locked_without_summary: 0, stale_volumes: 0 },
			ledger: { stale_proposals: 0, orphan_events: 0, stale_events: 0 },
			llm_recent: { errors: 0, window: 20 },
			canon: { chapters: 1, locked: 0, chars: 1 },
		};
	if (method === "GET" && noQuery === "/api/resources")
		return { items: [], nextCursor: null };
	return null;
}

function taskResource(overrides = {}) {
	return { items: [Object.assign({}, TASK_RUN, overrides)], nextCursor: null };
}

let apiCalls;
let toasts;
let apiImpl;
let taskItems;
let roots;
let ws;

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush(n = 8) {
	for (let i = 0; i < n; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function show(hash) {
	await act(async () => {
		mountWorkbenchPage(hash);
	});
}

function byId(id) {
	return document.getElementById(id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 1500) {
	const t0 = Date.now();
	for (;;) {
		if (cond()) return true;
		if (Date.now() - t0 > timeout) return false;
		await act(async () => {
			await sleep(10);
		});
	}
}

beforeEach(() => {
	document.body.innerHTML = "";
	const host = document.createElement("div");
	host.id = "page-workbench";
	host.className = "page hidden";
	host.innerHTML = STATIC_WORKBENCH.innerHTML;
	document.body.appendChild(host);
	const pageBook = document.createElement("div");
	pageBook.id = "page-book";
	pageBook.className = "page hidden";
	document.body.appendChild(pageBook);
	const sel = document.createElement("select");
	sel.id = "writing-conversation-select";
	document.body.appendChild(sel);
	const modalMask = document.createElement("div");
	modalMask.id = "modal-mask";
	modalMask.className = "modal-mask hidden";
	modalMask.innerHTML =
		'<div class="modal"><h3 id="modal-title"></h3><div id="modal-body"></div>' +
		'<div class="modal-actions"><button id="modal-cancel"></button><button id="modal-ok"></button></div></div>';
	document.body.appendChild(modalMask);
	window.location.hash = "#/";
	localStorage.clear();
	sessionStorage.clear();
	apiCalls = [];
	toasts = [];
	apiImpl = null;
	taskItems = { items: [], nextCursor: null };
	roots = [];
	resetWorkbenchShellState();
	window.App = {
		state: {},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml(s) {
			return String(s == null ? "" : s).replace(
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
		},
		openModal(opts) {
			window.__lastModal = opts;
		},
		async api(method, url, body) {
			apiCalls.push([method, url, body]);
			if (apiImpl) return apiImpl(method, url, body);
			const noQuery = String(url).split("?")[0];
			if (method === "GET" && noQuery === "/api/resources") return taskItems;
			const hit = jsonFixture(method, url);
			if (hit) return hit;
			throw new Error(`no stub: ${method} ${url}`);
		},
	};
	// P6-2 转写：RunStatus 经模块直取（§2.5-D5）⇒ harness 假体装成 spy 面（断言与实现逐字等价）
	vi.spyOn(runStatus, "taskBadge").mockImplementation(({ status, reason }) => {
		if (status === "paused" && reason === "output_truncated") return "已暂停";
		if (status === "paused") return "已暂停";
		return status;
	});
	// P6-2（⑨ 切换笔）：旧名桥退役——两旧名零命中由 T1 静态见证承担；真 lib 单例由下方注入缝
	// 复位后重建（`ws` 与生产 `getWorkspaceState()` 必须同一实例，W4 的 restore 替身才生效）。
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例；
// `ws` 取复位后重建的**同一个**单例（等值原桥供给后 `window.WorkspaceState` 的身份）。
beforeEach(() => {
	setAppForTests(window.App);
	setWorkspaceStateForTests(null);
	ws = getWorkspaceState();
});

afterEach(() => {
	setAppForTests(null);
	setWorkspaceStateForTests(null);
});

describe("R6 壳面 W1/W2：标题/书题/nav 四链接/静态 id 全集/四模块 handoff（legacy :5-33/:189-214）", () => {
	it("W1 首帧同步壳面＋静态 id 全集与 tag/类逐一等值＋GET 恰一次＋App.state.currentBook", async () => {
		const gate = deferred();
		apiImpl = async () => gate.promise;
		await show("#/book/7/workbench/outline");
		await flush(2);
		// 首帧（GET 未决前）同步给出：标题/四链接/返回锚/loading
		expect(byId("workbench-title").textContent).toBe("大纲工作台");
		expect(
			byId("workbench-content").querySelector(".workbench-loading").textContent,
		).toBe("正在打开工作台…");
		const links = [...document.querySelectorAll("#workbench-nav a")];
		expect(links.map((a) => a.textContent)).toEqual([
			"人物中枢",
			"故事台账",
			"大纲工作台",
			"世界观工作台",
		]);
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"#/book/7/workbench/characters",
			"#/book/7/workbench/ledger",
			"#/book/7/workbench/outline",
			"#/book/7/workbench/world",
		]);
		expect(links.map((a) => a.className)).toEqual([
			"workbench-nav-link",
			"workbench-nav-link",
			"workbench-nav-link active",
			"workbench-nav-link",
		]);
		expect(byId("workbench-return").textContent).toBe("← 返回写作页");
		// 书题未回前：#page-workbench 侧只有壳自身一次 book GET（handoff 尚未发生）
		expect(
			apiCalls.filter(([m, u]) => m === "GET" && u === "/api/books/7").length,
		).toBe(1);
		// 渲染面 id 全集/tag/类与 index.html #page-workbench 静态壳逐条等值（防双维护漂移）
		for (const el of STATIC_WORKBENCH.querySelectorAll("[id]")) {
			const rendered = document.getElementById(el.id);
			expect(rendered, el.id).not.toBeNull();
			expect(rendered.tagName.toLowerCase(), el.id).toBe(
				el.tagName.toLowerCase(),
			);
			expect(rendered.className, el.id).toBe(el.className);
		}
		await act(async () => {
			gate.resolve({ book: BOOK7 });
		});
		await flush();
		expect(byId("workbench-book-title").textContent).toBe("雾港编年史");
		expect(window.App.state.currentBook).toEqual(BOOK7);
	});

	it("W2 四模块 handoff：四面板真实组件组合渲染＋active 类＋?tab= 透传初值", async () => {
		await show("#/book/7/workbench/outline");
		await flush(12);
		expect(byId("save-outline-workbench")).not.toBeNull();
		await show("#/book/7/workbench/characters/5");
		await flush(12);
		expect(byId("character-profile-form")).not.toBeNull();
		await show("#/book/7/workbench/ledger?tab=proposals");
		await flush(12);
		expect(byId("ledger-panel")).not.toBeNull();
		expect(
			document.querySelector('[data-ledger-tab="proposals"]').className,
		).toContain("active");
		await show("#/book/7/workbench/world");
		await flush(12);
		expect(byId("world-entry-list")).not.toBeNull();
		expect(document.querySelector("#workbench-nav a.active").textContent).toBe(
			"世界观工作台",
		);
		// 无面板残留：上一模块的面板随 key 重挂卸载（四 handoff 只渲染当前模块）
		expect(byId("save-outline-workbench")).toBeNull();
	});

	it("W3 未知/畸形 hash：parse 为 null 时回退 '#/'（含已知对照差异 %ZZ）（:12-24/:191-194）", async () => {
		await show("#/book/7/workbench/nope");
		await flush(2);
		expect(window.location.hash).toBe("#/");
		await show("#/book/7/workbench/outline/%ZZ");
		await flush(2);
		expect(window.location.hash).toBe("#/");
		// show 后不渲染任何壳面（node 侧 parse 由 parseWorkbenchRoute 承接）
		expect(parseOf("#/book/7/workbench/world")).toBe(true);
	});
});

function parseOf(hash) {
	return parseWorkbenchRoute(hash) !== null;
}

describe("R7 返回锚三态 W4（legacy :30-59）", () => {
	it("W4-1 写作页记录：href＝WorkspaceState.href(target)＋文案＋preventDefault＋restore 实参", async () => {
		sessionStorage.setItem(
			"novel-workspace-return:7",
			JSON.stringify({
				workspace: "writing",
				bookId: 7,
				chapterId: 12,
				conversationId: "conv-writing-1",
			}),
		);
		await show("#/book/7/workbench/outline");
		await flush();
		const link = byId("workbench-return");
		expect(link.textContent).toBe("← 返回写作页");
		expect(link.getAttribute("href")).toBe("#/book/7");
		const calls = [];
		const realRestore = ws.restore.bind(ws);
		ws.restore = async (target) => {
			calls.push(target);
			return true;
		};
		const ev = new window.MouseEvent("click", {
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			link.dispatchEvent(ev);
		});
		expect(ev.defaultPrevented).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0]).toMatchObject({
			workspace: "writing",
			bookId: 7,
			chapterId: 12,
			conversationId: "conv-writing-1",
		});
		ws.restore = realRestore;
	});

	it("W4-2 Agent 记录：文案「← 返回 Agent 台」；无记录：href #/book/7 且不调 restore＋旧键写入", async () => {
		sessionStorage.setItem(
			"novel-workspace-return:7",
			JSON.stringify({ workspace: "agent", bookId: 7 }),
		);
		await show("#/book/7/workbench/ledger");
		await flush();
		expect(byId("workbench-return").textContent).toBe("← 返回 Agent 台");
		expect(byId("workbench-return").getAttribute("href")).toBe("#/agent");
		// 无新键记录：rememberEditor（:30-33）写旧键 novel-editor-return:7，而 readReturn 的旧键
		// 兼容链（:181-190）把该键解析回写作页记录——故返回锚仍是 restore 路径（legacy 逐字同款）
		sessionStorage.clear();
		const calls = [];
		const realRestore = ws.restore.bind(ws);
		ws.restore = async (t) => {
			calls.push(t);
			return true;
		};
		await show("#/book/7/workbench/ledger");
		await flush();
		expect(sessionStorage.getItem("novel-editor-return:7")).toBe("#/book/7");
		expect(byId("workbench-return").getAttribute("href")).toBe("#/book/7");
		byId("workbench-return").dispatchEvent(
			new window.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await flush(2);
		expect(calls.length).toBe(1);
		expect(calls[0]).toMatchObject({ workspace: "writing", bookId: "7" });
		// 真·第三态（旧键存在但解析为 shelf→readReturn 为 null）：href 退到旧键值、无 onclick
		sessionStorage.clear();
		sessionStorage.setItem("novel-editor-return:7", "#/profile");
		await show("#/book/7/workbench/ledger");
		await flush();
		expect(byId("workbench-return").getAttribute("href")).toBe("#/profile");
		const before = calls.length;
		byId("workbench-return").dispatchEvent(
			new window.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await flush(2);
		expect(calls.length).toBe(before); // 无 onclick：不调 restore（legacy :55-58 第三态）
		ws.restore = realRestore;
	});
});

describe("R8 任务入口 W5（legacy :86-187）", () => {
	it("W5-1 有任务：taskBadge 实参＋标题含「已暂停」＋link #/agent 可见＋铃铛去 hidden＋Toast 文案", async () => {
		taskItems = taskResource();
		await show("#/book/7/workbench/ledger");
		await flush(12);
		const title = byId("workbench-notify-title");
		expect(title.textContent).toBe("已暂停 · chat · write");
		expect(title.textContent).toContain("已暂停");
		const link = byId("workbench-notify-link");
		expect(link.getAttribute("href")).toBe("#/agent");
		expect(link.classList.contains("hidden")).toBe(false);
		expect(byId("workbench-notify").classList.contains("hidden")).toBe(false);
		const toast = byId("workbench-toast");
		expect(toast.classList.contains("hidden")).toBe(false);
		expect(toast.querySelector(".wb-toast-title").textContent).toBe(
			"已暂停 · chat · write",
		);
		expect(toast.querySelector(".wb-toast-body").textContent).toMatch(
			/^《雾港编年史》最近一次任务，更新于 \d{1,2}月\d{1,2}日 \d{2}:\d{2}。完整任务卡在写作页对话区上方。$/,
		);
	});

	it("W5-2 5 秒收铃铛：closing→hidden＋红点复现；同 key 二次 show 不重弹", async () => {
		taskItems = taskResource();
		vi.useFakeTimers();
		await show("#/book/7/workbench/ledger");
		await flush(12);
		const toast = byId("workbench-toast");
		expect(toast.classList.contains("hidden")).toBe(false);
		expect(byId("workbench-notify-dot").classList.contains("hidden")).toBe(
			true,
		);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(toast.classList.contains("closing")).toBe(true);
		await act(async () => {
			vi.advanceTimersByTime(220);
		});
		expect(toast.classList.contains("hidden")).toBe(true);
		expect(toast.classList.contains("closing")).toBe(false);
		expect(byId("workbench-notify-dot").classList.contains("hidden")).toBe(
			false,
		);
		// 同 key（书|id|updatedAt|status）二次 show：不重弹（lastToastKey 模块级跨 show 保留）
		await show("#/book/7/workbench/ledger");
		await flush(12);
		expect(byId("workbench-toast").classList.contains("hidden")).toBe(true);
		vi.useRealTimers();
	});

	it("W5-3 无运行记录：明说「没有运行记录」＋link 隐藏；RunStatus 缺失回退裸 status", async () => {
		taskItems = { items: [], nextCursor: null };
		await show("#/book/7/workbench/ledger");
		await flush(12);
		expect(byId("workbench-notify-title").textContent).toContain("没有");
		expect(byId("workbench-notify-link").classList.contains("hidden")).toBe(
			true,
		);
		// P6-2 转写：旧 `window.RunStatus = undefined` → 置空模块直取对象的该名（等价「无 taskBadge
		// 时回退裸 status」臂；afterEach 的 restoreAllMocks 复原真实现）
		taskItems = taskResource({ status: "running", meta: {} });
		runStatus.taskBadge = undefined;
		await show("#/book/7/workbench/world");
		await flush(12);
		expect(byId("workbench-notify-title").textContent).toBe(
			"running · chat · write",
		);
	});

	it("W5-4 铃铛交互：点击 toggle 弹层并清红点；文档点击外部关闭（:129-145）", async () => {
		taskItems = taskResource();
		await show("#/book/7/workbench/ledger");
		await flush(12);
		const bell = byId("workbench-notify");
		const pop = byId("workbench-notify-pop");
		await act(async () => {
			bell.click();
		});
		expect(pop.classList.contains("hidden")).toBe(false);
		expect(byId("workbench-notify-dot").classList.contains("hidden")).toBe(
			true,
		);
		await act(async () => {
			document.body.click();
		});
		expect(pop.classList.contains("hidden")).toBe(true);
	});
});

describe("R9 挂载/错误/深链 W6/W7（legacy :189-214）", () => {
	it("W6-1 book GET 失败：.workbench-error＝escapeHtml(message)（:211-213）", async () => {
		apiImpl = async (method, url) => {
			if (method === "GET" && url === "/api/books/7")
				throw new Error('5 < 6 & "x"');
			return jsonFixture(method, url) || {};
		};
		await show("#/book/7/workbench/outline");
		await flush();
		const err = document.querySelector(".workbench-error");
		expect(err).not.toBeNull();
		expect(err.textContent).toBe('5 < 6 & "x"');
		// React 文本节点只转义 &/</>（引号在文本节点无需转义）；legacy escapeHtml 转义五字符——
		// 显示等价、DOM 文本逐字一致（已知对照差异·转义形态，无可见行为变化）
		expect(err.innerHTML).toBe('5 &lt; 6 &amp; "x"');
	});

	it("W6-2 #page-workbench 缺失 no-op；连两次 show 同 root 复用＋key 重挂重拉（GET 计数 2）", async () => {
		document.getElementById("page-workbench").remove();
		expect(() =>
			mountWorkbenchPage("#/book/7/workbench/outline"),
		).not.toThrow();
		await flush(2);
		// 重建容器：背靠背两次 show → 同一 root 复用（状态不跨挂载泄漏），GET 各一次
		const host = document.createElement("div");
		host.id = "page-workbench";
		document.body.appendChild(host);
		await show("#/book/7/workbench/world"); // world 面板不请求 /api/books/7：计数＝外壳自身
		await flush(8);
		const cached = host.__mozhenWorkbenchRoot;
		expect(cached).toBeTruthy();
		expect(cached.el.isConnected).toBe(true);
		await show("#/book/7/workbench/world");
		await flush(8);
		expect(host.__mozhenWorkbenchRoot).toBe(cached);
		expect(
			apiCalls.filter(([m, u]) => m === "GET" && u === "/api/books/7").length,
		).toBe(2);
	});

	it("W7 深链首屏：world 直入＋active＋书题；无记录时返回锚回写作页（:189-208）", async () => {
		window.location.hash = "#/book/7/workbench/world";
		await show(window.location.hash);
		await flush(12);
		expect(byId("workbench-title").textContent).toBe("世界观工作台");
		expect(
			document.querySelector("#workbench-nav a.active").getAttribute("href"),
		).toBe("#/book/7/workbench/world");
		expect(byId("workbench-book-title").textContent).toBe("雾港编年史");
		expect(byId("world-entry-list").textContent).toContain("世界规则");
	});
});

describe("R10 导航链 W8（integration：真 lib＋真壳＋真面板）", () => {
	it("W8 写作页→大纲工作台→返回：navigate 提交 hash、capture 一致、restore 还原同一章/会话", async () => {
		// 写作页态：书 7、章 12、写作会话 conv-writing-1、页面可见
		window.location.hash = "#/book/7";
		localStorage.setItem("writing_conversation_7", "conv-writing-1");
		window.App.state.currentChapterId = 12;
		window.App.state.currentBook = BOOK7;
		document.getElementById("page-book").classList.remove("hidden");
		const seq = [];
		// P6-2（⑨ 切换笔）转写：旧 `window.BookPage` 三方法桩 → 模块面（§2.5-D3/D4/D2）——
		// 编辑器名义入口 spy、聊天命令面 spy、状态条渲染缝注册（未注册＝no-op，故此处注册记录器）。
		vi.spyOn(chapterEditorApi(), "selectChapter").mockImplementation(
			async (id) => {
				seq.push(`selectChapter:${id}`);
			},
		);
		vi.spyOn(chatApi(), "loadChat").mockImplementation(async () => {
			seq.push("loadChat");
		});
		bindWritingStatusRenderer(() => {
			seq.push("renderWritingStatus");
		});
		const from = ws.capture();
		expect(from).toMatchObject({
			workspace: "writing",
			bookId: "7",
			chapterId: 12,
			conversationId: "conv-writing-1",
		});
		expect(
			await ws.navigate({ workspace: "workbench", entityType: "outline" }),
		).toBe(true);
		expect(window.location.hash).toBe("#/book/7/workbench/outline");
		await show(window.location.hash);
		await flush(12);
		expect(byId("save-outline-workbench")).not.toBeNull();
		const inWorkbench = ws.capture();
		expect(inWorkbench).toMatchObject({
			workspace: "workbench",
			entityType: "outline",
			bookId: "7",
			chapterId: 12,
			returnTo: "#/book/7",
		});
		// 点返回：真 restore（verify→beforeNavigate→forgetReturn→setHash→apply）
		await act(async () => {
			byId("workbench-return").dispatchEvent(
				new window.MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});
		expect(await waitFor(() => window.location.hash === "#/book/7")).toBe(true);
		expect(await waitFor(() => seq.includes("selectChapter:12"))).toBe(true);
		expect(seq).toContain("loadChat");
		expect(seq).toContain("renderWritingStatus");
		expect(ws.readReturn(7)).toBeNull();
		const restored = ws.capture();
		expect(restored).toMatchObject({
			workspace: "writing",
			bookId: "7",
			chapterId: 12,
		});
	});
});
