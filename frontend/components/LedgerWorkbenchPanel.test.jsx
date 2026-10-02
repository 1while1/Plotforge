// @vitest-environment jsdom
// S4-4 红测（plans/S4-4-plan-1.md §4 L1~L15）：断言语义锚点＝public/legacy/ledger-workbench.js
// 行号（Plan §4 表逐条标注）。S5-4 面板契约笔：旧壳 workbench-shell.js（217 行）与旧名桥
// window.LedgerWorkbench 随 D-S4-9-01 迁移块整体退役，本文件挂载机制由 window.LedgerWorkbench.show(route)
// 机械替换为本地 createRoot 直渲染（一次挂载＝一次全量重入重拉）；旧「shell 整块重写容器后弃旧建新」
// 前提消失，其等价保护由 WorkbenchPage.test.jsx W6（外壳 key 重挂）承接。其余断言逐字不动。
// harness＝CharacterWorkbenchPanel.test.jsx 同款：jsdom＋React 19 act＋裸 DOM 断言；
// window.WorkspaceState mock 为 workspace-state.js:210-283 守卫体系逐字语义移植
//（epochs/dirtyTracker/guards/beginRequest/isCurrent）＋beforeNavigate（workspace-state.js:255
// 逐字语义：await 全部守卫、拒绝返回 false）；window.App.openModal mock 按 legacy 弹窗壳契约
// 把 bodyHTML 渲染进 #modal-body（reject/retract/新建/回填四个 modal 的 onOk 都要读其 DOM）；
// fetch stub 按 /api/books/B1/ledger* 路由。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { setWorkspaceStateForTests } from "../lib/workspace-state.js";
import { LedgerWorkbenchPanel } from "./LedgerWorkbenchPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/books/B1";
const LG = "/api/books/B1/ledger";
const ROUTE = { bookId: "B1", module: "ledger", entityId: null, tab: null };

function makeDeferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function freshHealth() {
	return {
		canon: { chapters: 12, locked: 10, chars: 45000 },
		index: { locked_missing: 0 },
		extraction: { locked_pending: 0 },
		summary: { locked_without_summary: 0, stale_volumes: 0 },
		ledger: { stale_proposals: 0, orphan_events: 0, stale_events: 0 },
		llm_recent: { errors: 0, window: 20 },
	};
}

function freshProposals() {
	return [
		{
			id: 31,
			title: "林晚获得古城钥匙",
			summary: "在第 12 章末尾获得",
			source_type: "history_backfill",
			chapter_title: "第 12 章",
			revision: 2,
			supersedes_event_id: 7,
			importance: "high",
			source_quote: "她握紧了那把铜钥匙。",
			changes: [
				{
					change_kind: "state",
					subject_ref: 5,
					field_key: "位置",
					old_value: "北城",
					new_value: "古城",
				},
				{
					change_kind: "relation",
					subject_ref: 9,
					field_key: "与陈默",
					old_value: "陌生",
					new_value: "同盟",
				},
			],
		},
	];
}

function freshEvents() {
	return [
		{
			id: 3,
			title: "林晚抵达古城",
			chapter_title: "第 12 章",
			importance: "high",
			origin: "accept",
			changes: [
				{
					change_kind: "state",
					subject_ref: 5,
					field_key: "位置",
					old_value: "北城",
					new_value: "古城",
				},
				{
					change_kind: "state",
					subject_ref: 5,
					field_key: "随身物",
					old_value: "",
					new_value: "铜钥匙",
				},
			],
		},
	];
}

let progressFixture;
let progressFail;
let holdProgressGet;
let heldProgress;
let overviewProposals;
let proposalsTotal;
let overviewThreads;
let overviewIssues;
let backfillFixture;
let holdBackfillGet;
let heldBackfill;
let healthFixture;
let healthFail;
let proposalsPage1;
let proposalsEmptyOnPage2;
let charNamesFixture;
let eventsFixture;
let eventsTotal;
let threadsFixture;
let putProgressFail;
let deferredPut;
let acceptBehavior;
let rejectBehavior;
let retractBehavior;
let beforeNavigateAllowed;
let apiCalls;
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
		// workspace-state.js:255 beforeNavigate 逐字语义：过全部守卫，任一拒绝即 false
		async beforeNavigate(ctx) {
			seqLog.push(`ws:beforeNavigate:${ctx.from}>${ctx.to}`);
			for (const guard of guards.slice()) {
				let ok = false;
				try {
					ok = await guard.save();
				} catch {
					ok = false;
				}
				const allowed = ok === true && !guard.isDirty();
				if (!allowed) return false;
			}
			return beforeNavigateAllowed;
		},
		guards: () => guards.slice(),
		hasDirty: () =>
			guards.some((g) => typeof g.isDirty === "function" && g.isDirty()),
	};
}

function ledgerOffset(path) {
	return Number(
		new URLSearchParams(path.split("?")[1] || "").get("offset") || 0,
	);
}

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	seqLog.push(`api:${method}:${path}`);
	if (method === "GET" && path === `${LG}/progress`) {
		if (holdProgressGet > 0) {
			holdProgressGet -= 1;
			heldProgress = makeDeferred();
			return heldProgress.promise;
		}
		if (progressFail) return Promise.reject(new Error("进展读取失败"));
		return Promise.resolve(progressFixture);
	}
	if (method === "GET" && path === `${LG}/proposals?status=pending`) {
		return Promise.resolve({
			items: overviewProposals,
			page: { total: proposalsTotal },
		});
	}
	if (method === "GET" && path === `${LG}/threads?status=open`) {
		return Promise.resolve({ items: overviewThreads });
	}
	if (method === "GET" && path === `${LG}/issues`) {
		return Promise.resolve({ items: overviewIssues });
	}
	if (method === "GET" && path === `${LG}/backfill`) {
		if (holdBackfillGet > 0) {
			holdBackfillGet -= 1;
			heldBackfill = makeDeferred();
			return heldBackfill.promise;
		}
		return Promise.resolve({ status: backfillFixture });
	}
	if (method === "GET" && path === `${BASE}/health`) {
		if (healthFail) return Promise.reject(new Error("健康查询失败"));
		return Promise.resolve(healthFixture);
	}
	if (
		method === "GET" &&
		path.startsWith(`${LG}/proposals?status=pending&limit=`)
	) {
		if (proposalsEmptyOnPage2 && ledgerOffset(path) > 0) {
			return Promise.resolve({ items: [], page: { total: proposalsTotal } });
		}
		return Promise.resolve({
			items: proposalsPage1,
			page: { total: proposalsTotal },
		});
	}
	if (method === "GET" && path === `${BASE}/characters?limit=200`) {
		return Promise.resolve({ characters: charNamesFixture });
	}
	if (method === "GET" && path.startsWith(`${LG}/events?limit=`)) {
		return Promise.resolve({
			items: eventsFixture,
			page: { total: eventsTotal },
		});
	}
	if (method === "GET" && path === `${LG}/threads`) {
		return Promise.resolve({ items: threadsFixture });
	}
	if (method === "PUT" && path === `${LG}/progress`) {
		if (deferredPut) {
			const gate = deferredPut;
			deferredPut = null;
			return gate.promise;
		}
		if (putProgressFail) return Promise.reject(new Error("写入失败"));
		return Promise.resolve({});
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/ledger\/proposals\/\d+\/accept$/.test(path)
	) {
		if (acceptBehavior === "conflict")
			return Promise.reject(new Error("提案版本已变化（revision conflict）"));
		if (acceptBehavior === "fail")
			return Promise.reject(new Error("接受失败原因"));
		return Promise.resolve({});
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/ledger\/proposals\/\d+\/reject$/.test(path)
	) {
		if (rejectBehavior === "conflict")
			return Promise.reject(new Error("提案版本已变化（revision conflict）"));
		if (rejectBehavior === "fail")
			return Promise.reject(new Error("拒绝失败原因"));
		return Promise.resolve({});
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/ledger\/events\/\d+\/retraction$/.test(path)
	) {
		if (retractBehavior === "superseded")
			return Promise.reject(new Error("事件已被 SUPERSEDED"));
		if (retractBehavior === "fail")
			return Promise.reject(new Error("撤销失败原因"));
		return Promise.resolve({});
	}
	if (method === "POST" && path === `${LG}/threads`) {
		return Promise.resolve({ item: { id: 77, ...body } });
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

// S5-4 面板契约笔：挂载机制改本地 createRoot 直渲染（等值旧 window.LedgerWorkbench.show(route)：
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
		root.render(<LedgerWorkbenchPanel route={route} />);
	});
	return page;
}

afterEach(() => {
	while (mountedRoots.length) mountedRoots.pop().unmount();
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
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(form) {
	form.dispatchEvent(
		new window.Event("submit", { bubbles: true, cancelable: true }),
	);
}

beforeEach(() => {
	document.body.innerHTML = "";
	progressFixture = { summary: "旧进展", stale: false };
	progressFail = false;
	holdProgressGet = 0;
	heldProgress = null;
	overviewProposals = [{ id: 900, title: "概览提案", changes: [] }];
	proposalsTotal = 25;
	overviewThreads = [{ id: 1 }, { id: 2 }];
	overviewIssues = [{ id: 1 }];
	backfillFixture = {
		phase: "done",
		total: 3,
		created: 1,
		skipped_changes: 0,
		errors: [],
	};
	holdBackfillGet = 0;
	heldBackfill = null;
	healthFixture = freshHealth();
	healthFail = false;
	proposalsPage1 = freshProposals();
	proposalsEmptyOnPage2 = false;
	charNamesFixture = [
		{ id: 5, name: "林晚" },
		{ id: 9, name: "陈默" },
	];
	eventsFixture = freshEvents();
	eventsTotal = 1;
	threadsFixture = [
		{
			id: 1,
			type: "foreshadow",
			status: "open",
			title: "主线伏笔",
			summary: "说明",
		},
	];
	putProgressFail = false;
	deferredPut = null;
	acceptBehavior = null;
	rejectBehavior = null;
	retractBehavior = null;
	beforeNavigateAllowed = true;
	apiCalls = [];
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
	window.WorkspaceState = makeWorkspaceStateMock();
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

describe("LedgerWorkbenchPanel 组件（范式 A·判定 C 旧名桥）", () => {
	it("L1 直渲染重挂（mount 配方退役）：两次挂载即两次全量重拉；charNames 缓存随重挂重置（:3/:298-304）", async () => {
		// S5-4：旧名桥/挂载目标缺失 no-op/容器重写弃旧建新三面随配方退役（接收方＝WorkbenchPage.test.jsx
		// W1 壳面 id 一致性与 W6 外壳 key 重挂），本组保留面板侧重挂即重置的等价证据。
		expect(typeof LedgerWorkbenchPanel).toBe("function");
		// proposals 页签：挂载即拉提案＋人物名缓存（:298-304）
		const route2 = { ...ROUTE, tab: "proposals" };
		await showAndLoad(route2);
		expect(
			apiCalls.filter(
				(c) => c.path === `${LG}/proposals?status=pending&limit=20&offset=0`,
			).length,
		).toBe(1);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/characters?limit=200`).length,
		).toBe(1);
		// 重挂＝外壳 key=<module|entityId|tab> 重挂（WorkbenchPage.test.jsx W6）：新实例、charNames 不继承
		await showAndLoad(route2);
		expect(
			apiCalls.filter(
				(c) => c.path === `${LG}/proposals?status=pending&limit=20&offset=0`,
			).length,
		).toBe(2);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/characters?limit=200`).length,
		).toBe(2);
	});

	it("L2 概览六连 GET＋健康条全 0/告警双形态＋指标卡；/health 失败空健康条不白屏（:87-101/:104-107）", async () => {
		const page = await showAndLoad();
		// 六连 GET（:104-105）
		for (const p of [
			`${LG}/progress`,
			`${LG}/proposals?status=pending`,
			`${LG}/threads?status=open`,
			`${LG}/issues`,
			`${LG}/backfill`,
			`${BASE}/health`,
		]) {
			expect(apiCalls.some((c) => c.method === "GET" && c.path === p)).toBe(
				true,
			);
		}
		// 健康条全 0 → ✓ 形态（:98）
		const health = page.querySelector(".ledger-health");
		expect(health).not.toBeNull();
		expect(health.className).not.toContain("warn");
		expect(health.querySelector(".ledger-health-title").textContent).toBe(
			"✓ 作品健康",
		);
		const items = Array.from(health.querySelectorAll(".ledger-health-item"));
		expect(items.map((el) => el.textContent)).toEqual([
			"索引缺失 0",
			"抽取待补 0",
			"章总结缺 0",
			"卷总结过期 0",
			"一致性问题 0",
			"近期调用失败 0",
		]);
		expect(health.querySelector(".ledger-health-meta").textContent).toBe(
			"正典 12 章 / 定稿 10 / 45K 字",
		);
		// 指标卡三数字（:107）：提案取 page.total、故事线/问题取 items.length
		const metrics = page.querySelectorAll(".ledger-metrics article");
		expect(metrics.length).toBe(3);
		expect(metrics[0].querySelector("strong").textContent).toBe("25");
		expect(metrics[0].querySelector("span").textContent).toBe("待审提案");
		expect(metrics[1].querySelector("strong").textContent).toBe("2");
		expect(metrics[1].querySelector("span").textContent).toBe("未结故事线");
		expect(metrics[2].querySelector("strong").textContent).toBe("1");
		expect(metrics[2].querySelector("span").textContent).toBe("一致性问题");

		// 任一非 0 → warn 形态＋bad 项（:97-99）
		healthFixture = freshHealth();
		healthFixture.ledger.stale_proposals = 2;
		const page2 = await showAndLoad();
		const health2 = page2.querySelector(".ledger-health");
		expect(health2.className).toContain("warn");
		expect(health2.querySelector(".ledger-health-title").textContent).toBe(
			"⚠ 作品健康有待处理",
		);
		const badItems = Array.from(
			health2.querySelectorAll(".ledger-health-item.bad"),
		);
		expect(badItems.length).toBe(1);
		expect(badItems[0].textContent).toContain("一致性问题");
		expect(badItems[0].querySelector("strong").textContent).toBe("2");
		expect(badItems[0].title).toBe("过期提案/孤儿事件/证据过期事件");

		// /health reject → catch 返 null → 空健康条，指标卡仍渲染不白屏（:105）
		healthFail = true;
		const page3 = await showAndLoad();
		expect(page3.querySelector(".ledger-health")).toBeNull();
		expect(page3.querySelector(".ledger-metrics")).not.toBeNull();
		expect(page3.querySelector(".workbench-error")).toBeNull();
	});

	it("L3 进展摘要回填＋底料已变化标记＋input 即脏（dirtyTracker 真语义）（:109-114）", async () => {
		progressFixture = { summary: "旧的进展摘要", stale: true };
		const page = await showAndLoad();
		const node = page.querySelector("#ledger-progress");
		expect(node.value).toBe("旧的进展摘要");
		const stale = page.querySelector(".vol-stale");
		expect(stale).not.toBeNull();
		expect(stale.textContent).toBe("底料已变化");
		expect(stale.title).toBe(
			"保存后章/卷总结有更新，此摘要讲的可能是旧故事，建议重新生成",
		);
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		setInputValue(node, "改了一半");
		expect(window.WorkspaceState.hasDirty()).toBe(true); // :113-114 input→tracker.mark()
	});

	it("L4 保存成功：PUT /progress payload＋toast 逐字＋dirty 清（:59/:64/:68）", async () => {
		const page = await showAndLoad();
		setInputValue(page.querySelector("#ledger-progress"), "新的进展内容");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			submitForm(page.querySelector("#progress-form"));
		});
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === `${LG}/progress`,
		);
		expect(put.body).toEqual({ summary: "新的进展内容" });
		expect(toasts).toContain("进展摘要已保存");
		expect(window.WorkspaceState.hasDirty()).toBe(false);
	});

	it("L5 保存失败：toast 逐字＋草稿留表单＋dirty 保留＋不报已保存（:60-63；vm T5 :829-845 语义对齐）", async () => {
		putProgressFail = true;
		const page = await showAndLoad();
		const node = page.querySelector("#ledger-progress");
		setInputValue(node, "不会丢的草稿");
		await act(async () => {
			submitForm(page.querySelector("#progress-form"));
		});
		expect(toasts).toContain(
			"保存失败（进展摘要未保存）：写入失败，修改仍留在表单里",
		);
		expect(node.value).toBe("不会丢的草稿"); // 草稿留在表单
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		expect(toasts.some((t) => t.includes("进展摘要已保存"))).toBe(false);
	});

	it("L6 保存竞态：保存 await 期间再输入 → settle false → toast 逐字＋仍 dirty（:64-66）", async () => {
		const page = await showAndLoad();
		const node = page.querySelector("#ledger-progress");
		setInputValue(node, "第一版");
		const gate = makeDeferred();
		deferredPut = gate;
		await act(async () => {
			submitForm(page.querySelector("#progress-form"));
		});
		setInputValue(node, "第一版＋飞行中修改"); // 保存期间新输入
		await act(async () => {
			gate.resolve({});
		});
		expect(toasts).toContain(
			"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
		);
		expect(window.WorkspaceState.hasDirty()).toBe(true);
	});

	it("L7 页签守卫：切页签先 beforeNavigate（from/to 逐字）；拒绝则页签不切、不加载（:34-38）", async () => {
		const page = await showAndLoad();
		await act(async () => {
			page.querySelector('[data-ledger-tab="proposals"]').click();
		});
		expect(seqLog).toContain(
			"ws:beforeNavigate:ledger:overview>ledger:proposals",
		);
		expect(
			apiCalls.some(
				(c) => c.path === `${LG}/proposals?status=pending&limit=20&offset=0`,
			),
		).toBe(true);
		expect(
			page.querySelector('[data-ledger-tab="proposals"]').className,
		).toContain("active");
		// 守卫拒绝：留原页签
		beforeNavigateAllowed = false;
		await act(async () => {
			page.querySelector('[data-ledger-tab="events"]').click();
		});
		expect(seqLog).toContain(
			"ws:beforeNavigate:ledger:proposals>ledger:events",
		);
		expect(apiCalls.some((c) => c.path.startsWith(`${LG}/events?`))).toBe(
			false,
		);
		expect(
			page.querySelector('[data-ledger-tab="proposals"]').className,
		).toContain("active");
		expect(
			page.querySelector('[data-ledger-tab="events"]').className,
		).not.toContain("active");
	});

	it("L8 提案列表：服务端分页 total、卡片逐字渲染、人物名缓存翻页不重拉、末页清空回退一页（:173-198/:156-165）", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "proposals" });
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === `${LG}/proposals?status=pending&limit=20&offset=0`,
			),
		).toBe(true);
		const card = page.querySelector(".proposal-card");
		expect(card.querySelector(".proposal-kind").textContent).toBe(
			"回填 · 第 12 章 · v2 · 修正事件 #7 · high",
		);
		expect(card.querySelector("h3").textContent).toBe("林晚获得古城钥匙");
		expect(card.querySelector("p").textContent).toBe("在第 12 章末尾获得");
		expect(card.querySelector("blockquote.proposal-quote").textContent).toBe(
			"她握紧了那把铜钥匙。",
		);
		expect(card.querySelector(".proposal-supersede").title).toBe(
			"该提案用于替换一条既有事件",
		);
		const changes = card.querySelectorAll(".proposal-changes li");
		expect(changes.length).toBe(2);
		expect(changes[0].querySelector(".proposal-change-who").textContent).toBe(
			"林晚",
		);
		expect(changes[0].textContent).toBe("林晚 · 位置：北城 → 古城");
		expect(changes[1].querySelector(".proposal-change-who").textContent).toBe(
			"关系",
		);
		expect(changes[1].textContent).toBe("关系 · 与陈默：陌生 → 同盟");
		// 服务端分页 total=25 → ListPager 渲染（:176/:198）
		expect(
			page.querySelector("#ledger-pager-slot .list-pager").textContent,
		).toContain("第 1 / 2 页 · 共 25 条");
		// 人物名缓存：翻页不再拉（:156-165）
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/characters?limit=200`).length,
		).toBe(1);
		// 末页清空：page2 空 → 自动回退一页重拉 offset=0（:178）
		proposalsEmptyOnPage2 = true;
		await act(async () => {
			page.querySelector("[data-page-next]").click();
		});
		const offsets = apiCalls
			.filter((c) => c.path.startsWith(`${LG}/proposals?status=pending&limit=`))
			.map((c) => ledgerOffset(c.path));
		expect(offsets).toEqual([0, 20, 0]);
		expect(
			apiCalls.filter((c) => c.path === `${BASE}/characters?limit=200`).length,
		).toBe(1);
	});

	it("L9 接受提案：expected_revision payload＋成功刷新＋版本冲突 toast 逐字＋非冲突错误（:199-208）", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "proposals" });
		const proposalGets = () =>
			apiCalls.filter((c) =>
				c.path.startsWith(`${LG}/proposals?status=pending&limit=`),
			).length;
		const before = proposalGets();
		await act(async () => {
			page.querySelector('[data-accept="31"]').click();
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${LG}/proposals/31/accept`,
		);
		expect(post.body).toEqual({ expected_revision: 2 });
		expect(proposalGets()).toBe(before + 1); // 成功后刷新（:207）
		// 版本冲突：toast 逐字＋仍刷新（:202-205）
		acceptBehavior = "conflict";
		await act(async () => {
			page.querySelector('[data-accept="31"]').click();
		});
		expect(toasts).toContain("提案已被并发修改（版本冲突），已为你刷新列表");
		expect(proposalGets()).toBe(before + 2);
		// 非冲突错误：接受失败：＋err.message
		acceptBehavior = "fail";
		await act(async () => {
			page.querySelector('[data-accept="31"]').click();
		});
		expect(toasts).toContain("接受失败：接受失败原因");
	});

	it("L10 拒绝提案：modal 契约＋空理由不发请求且返回 false＋理由随 payload（:209-227）", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "proposals" });
		await act(async () => {
			page.querySelector('[data-reject="31"]').click();
		});
		expect(lastModal.title).toBe("拒绝提案：林晚获得古城钥匙");
		expect(lastModal.okText).toBe("确认拒绝");
		const body = document.getElementById("modal-body");
		expect(body.querySelector("#reject-note")).not.toBeNull();
		let rc;
		await act(async () => {
			rc = await lastModal.onOk(body);
		});
		expect(rc).toBe(false); // 空理由：弹窗保持（onOk false）
		expect(toasts).toContain(
			"拒绝必须填写理由：留档后作者/Agent 才能知道为什么被拒",
		);
		expect(apiCalls.some((c) => c.path === `${LG}/proposals/31/reject`)).toBe(
			false,
		);
		// 填理由：POST 带 review_note＋expected_revision（:218）
		body.querySelector("#reject-note").value = "与第 12 章剧情矛盾";
		await act(async () => {
			await lastModal.onOk(body);
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${LG}/proposals/31/reject`,
		);
		expect(post.body).toEqual({
			review_note: "与第 12 章剧情矛盾",
			expected_revision: 2,
		});
	});

	it("L11 事件撤销：列表渲染＋modal 空理由不发请求＋SUPERSEDED 冲突 toast＋成功 toast（:232-264）", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "events" });
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" && c.path === `${LG}/events?limit=20&offset=0`,
			),
		).toBe(true);
		const card = page.querySelector(".ledger-event-card");
		expect(card.querySelector("span").textContent).toBe("第 12 章 · high");
		expect(card.querySelector("h3").textContent).toBe("林晚抵达古城");
		expect(card.querySelector("p").textContent).toBe(
			"2 项事实变化 · 来源 accept",
		);
		await act(async () => {
			page.querySelector('[data-retract="3"]').click();
		});
		expect(lastModal.title).toBe("撤销事件：林晚抵达古城");
		expect(lastModal.okText).toBe("确认撤销");
		const body = document.getElementById("modal-body");
		let rc;
		await act(async () => {
			rc = await lastModal.onOk(body);
		});
		expect(rc).toBe(false);
		expect(toasts).toContain("撤销必须填写理由：撤销事件本身也会留档供审计");
		expect(apiCalls.some((c) => c.path === `${LG}/events/3/retraction`)).toBe(
			false,
		);
		// SUPERSEDED 冲突：toast 逐字＋刷新（:255-258）
		body.querySelector("#retract-reason").value = "系误抽取";
		retractBehavior = "superseded";
		await act(async () => {
			await lastModal.onOk(body);
		});
		expect(toasts).toContain("该事件已被修正或撤销，已为你刷新列表");
		// 成功：POST reason＋toast 逐字＋刷新（:254/:260-261）
		retractBehavior = null;
		await act(async () => {
			await lastModal.onOk(body);
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${LG}/events/3/retraction`,
		);
		expect(post.body).toEqual({ reason: "系误抽取" });
		expect(toasts).toContain("已撤销，投影已重建");
	});

	it("L12 故事线：GET 全量缓存＋前端切片翻页不重拉＋新建弹窗五枚举 payload＋建后刷新（:266-278/:19/:272）", async () => {
		threadsFixture = Array.from({ length: 25 }, (_, i) => ({
			type: "foreshadow",
			status: "open",
			title: `伏线${i + 1}`,
			summary: "说明",
		}));
		const page = await showAndLoad({ ...ROUTE, tab: "threads" });
		expect(
			apiCalls.filter((c) => c.method === "GET" && c.path === `${LG}/threads`)
				.length,
		).toBe(1);
		expect(page.querySelectorAll(".thread-card").length).toBe(20);
		expect(
			page.querySelector("#ledger-pager-slot .list-pager").textContent,
		).toContain("第 1 / 2 页 · 共 25 条");
		await act(async () => {
			page.querySelector("[data-page-next]").click();
		});
		expect(page.querySelectorAll(".thread-card").length).toBe(5);
		// 前端切片：翻页不重拉（:268）
		expect(
			apiCalls.filter((c) => c.method === "GET" && c.path === `${LG}/threads`)
				.length,
		).toBe(1);
		// 新建弹窗：五枚举 type（:19）
		await act(async () => {
			page.querySelector("#new-thread").click();
		});
		expect(lastModal.title).toBe("新建故事线");
		expect(lastModal.okText).toBe("创建");
		const body = document.getElementById("modal-body");
		const opts = Array.from(body.querySelectorAll("#thread-type option"));
		expect(opts.map((o) => o.value)).toEqual([
			"foreshadow",
			"mystery",
			"promise",
			"debt",
			"plan",
		]);
		expect(opts.map((o) => o.textContent)).toEqual([
			"伏笔",
			"悬念",
			"承诺",
			"亏欠",
			"计划",
		]);
		body.querySelector("#thread-type").value = "mystery";
		body.querySelector("#thread-title").value = "钥匙的下落";
		body.querySelector("#thread-summary").value = "围绕古城钥匙展开";
		await act(async () => {
			await lastModal.onOk(body);
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${LG}/threads`,
		);
		expect(post.body).toEqual({
			title: "钥匙的下落",
			summary: "围绕古城钥匙展开",
			type: "mystery",
			status: "open",
		});
		// 建后刷新（:272 → threads()）
		expect(
			apiCalls.filter((c) => c.method === "GET" && c.path === `${LG}/threads`)
				.length,
		).toBe(2);
	});

	it("L13 回填四态文案逐字＋running 禁按钮＋启动 POST→2500ms 轮询＋世代失效旧轮询静默（:117-155）", async () => {
		const origSetTimeout = window.setTimeout;
		const timers = [];
		window.setTimeout = (fn, ms) => {
			timers.push({ fn, ms });
			return 999001 + timers.length;
		};
		try {
			// 四态逐字（:117-124）＋running 时按钮 disabled（:130）
			backfillFixture = { running: true, processed: 3, total: 10, created: 5 };
			let page = await showAndLoad();
			expect(page.querySelector("#backfill-progress").textContent).toBe(
				"回填中… 3/10 章 · 已生成 5 条提案",
			);
			expect(page.querySelector("#backfill-start").disabled).toBe(true);

			backfillFixture = {
				running: false,
				phase: "done",
				total: 10,
				created: 5,
				skipped_changes: 2,
				errors: [{}, {}],
			};
			page = await showAndLoad();
			expect(page.querySelector("#backfill-progress").textContent).toBe(
				"上次回填：10 章 · 新增 5 条待审提案 · 跳过 2 项已入库变化 · 2 条提示",
			);

			backfillFixture = { phase: "aborted" };
			page = await showAndLoad();
			expect(page.querySelector("#backfill-progress").textContent).toBe(
				"上次回填已取消",
			);

			backfillFixture = { phase: "interrupted" };
			page = await showAndLoad();
			expect(page.querySelector("#backfill-progress").textContent).toBe(
				"上次回填因服务重启中断，未再自动续跑；重新点「一键回填」即可续跑（已抽取章节会自动跳过）",
			);

			// 启动流：modal → POST /backfill {} → 轮询 GET → running 文案＋2500ms 计时（:132-151）
			backfillFixture = {
				phase: "done",
				total: 4,
				created: 1,
				skipped_changes: 0,
				errors: [],
			};
			page = await showAndLoad();
			expect(page.querySelector("#backfill-start").disabled).toBe(false);
			await act(async () => {
				page.querySelector("#backfill-start").click();
			});
			expect(lastModal.title).toBe("一键回填历史章节");
			expect(lastModal.okText).toBe("开始回填");
			backfillFixture = { running: true, processed: 1, total: 4, created: 2 };
			await act(async () => {
				await lastModal.onOk(document.getElementById("modal-body"));
			});
			const post = apiCalls.find(
				(c) => c.method === "POST" && c.path === `${LG}/backfill`,
			);
			expect(post.body).toEqual({});
			expect(page.querySelector("#backfill-progress").textContent).toBe(
				"回填中… 1/4 章 · 已生成 2 条提案",
			);
			expect(page.querySelector("#backfill-start").disabled).toBe(true);
			expect(timers.length).toBe(2); // 初始 running 态 1 次＋启动后 1 次
			expect(timers[1].ms).toBe(2500);
			// 世代失效：切页签后旧轮询不再拉、不弹完成 toast（:141/:146 等价）
			backfillFixture = {
				phase: "done",
				total: 4,
				created: 99,
				skipped_changes: 0,
				errors: [],
			};
			const pollsBefore = apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${LG}/backfill`,
			).length;
			await act(async () => {
				page.querySelector('[data-ledger-tab="proposals"]').click();
			});
			await act(async () => {
				timers[1].fn();
			});
			expect(
				apiCalls.filter(
					(c) => c.method === "GET" && c.path === `${LG}/backfill`,
				).length,
			).toBe(pollsBefore);
			expect(toasts.some((t) => t.includes("回填完成：新增 99"))).toBe(false);
		} finally {
			window.setTimeout = origSetTimeout;
		}
	});

	it("L13b 卸载清理：effect cleanup 世代失效——卸载后晚到的轮询结果不写面板、不弹完成 toast（:140-155 等价）", async () => {
		backfillFixture = {
			phase: "done",
			total: 1,
			created: 0,
			skipped_changes: 0,
			errors: [],
		};
		const page = await showAndLoad();
		holdBackfillGet = 1;
		await act(async () => {
			page.querySelector("#backfill-start").click();
		});
		await act(async () => {
			await lastModal.onOk(document.getElementById("modal-body"));
		});
		expect(heldBackfill).toBeTruthy(); // 轮询 GET 已挂起
		expect(page.querySelector("#backfill-progress").textContent).toBe(
			"正在启动回填…",
		);
		// 卸载（effect cleanup：世代失效＋清 timer）
		currentRoot.unmount();
		await act(async () => {
			heldBackfill.resolve({
				status: { running: false, phase: "done", created: 9 },
			});
		});
		expect(toasts.some((t) => t.startsWith("回填完成：新增 9"))).toBe(false);
	});

	it("L14 竞态令牌：换页签后晚到响应不写面板（beginRequest/isCurrent 真语义）＋加载异常错误态（:43-51/:294/:296）", async () => {
		holdProgressGet = 1;
		const page = buildWorkbenchContent();
		mountPanel(ROUTE, page);
		await act(async () => {});
		expect(heldProgress).toBeTruthy();
		expect(seqLog).toContain("ws:beginRequest:ledger:B1|overview");
		// 切页签：新令牌（beginRequest('ledger','B1|proposals')）
		await act(async () => {
			page.querySelector('[data-ledger-tab="proposals"]').click();
		});
		expect(seqLog).toContain("ws:beginRequest:ledger:B1|proposals");
		expect(page.querySelector(".proposal-card")).not.toBeNull(); // proposals 已渲染
		// 放行晚到的 overview 响应：token 过期不写面板（不覆盖当前页签）
		await act(async () => {
			heldProgress.resolve(progressFixture);
		});
		expect(page.querySelector(".ledger-metrics")).toBeNull();
		expect(page.querySelector(".proposal-card")).not.toBeNull();
		expect(seqLog.some((s) => s.startsWith("ws:isCurrent:ledger"))).toBe(true);
		// 加载异常 → .workbench-error 渲染 err.message（:296）
		progressFail = true;
		const page2 = await showAndLoad();
		expect(page2.querySelector(".workbench-error").textContent).toBe(
			"进展读取失败",
		);
	});

	it("L15 守卫注册：先 clearGuards(key=ledger) 再 registerGuard（先于数据 GET）＋F6 等价＋卸载不注销（:72-83/:302）", async () => {
		const page = await showAndLoad();
		// 先注册后加载（:302 注释「守卫先注册」）
		expect(seqLog.indexOf("ws:registerGuard")).toBeGreaterThanOrEqual(0);
		expect(seqLog.indexOf("ws:registerGuard")).toBeLessThan(
			seqLog.indexOf("api:GET:/api/books/B1/ledger/progress"),
		);
		expect(seqLog).toContain("ws:clearGuards");
		const guard = window.WorkspaceState.guards().find(
			(g) => g.key === "ledger",
		);
		expect(guard).toBeTruthy();
		expect(guard.label).toBe("故事台账");
		expect(typeof guard.isDirty).toBe("function");
		expect(typeof guard.save).toBe("function");
		expect(typeof guard.discard).toBe("function");
		// F6 等价：input → isDirty 真；guard.save() 走 PUT → true＋dirty 清；discard 清 tracker
		const node = page.querySelector("#ledger-progress");
		setInputValue(node, "守卫输入");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			expect(await guard.save()).toBe(true);
		});
		expect(toasts).toContain("进展摘要已保存");
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		setInputValue(node, "再改一次");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			guard.discard();
		});
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		// 再 show：clearGuards 按 key 清旧 → 仍恰 1 个（:75）
		await showAndLoad();
		expect(window.WorkspaceState.guards().length).toBe(1);
		// 组件卸载不注销守卫（跨模块存续语义，Plan §2.4——旧实现守卫跨模块存续）
		currentRoot.unmount();
		await act(async () => {});
		expect(window.WorkspaceState.guards().length).toBe(1);
		expect(window.WorkspaceState.guards()[0].key).toBe("ledger");
	});
});
