// @vitest-environment jsdom
// S5-3 红测 R2/R3（Plan §4）：AppRouter 路由壳与守卫门——
// public/legacy/app.js:119-223 路由语义＋:698-730 hashchange 守卫 的 React Router 移交。
// 断言锚点：:121-123 先全 hidden 再显目标／:125-220 委托形状（WorkbenchShell 原串、
// MozhenReadPage.show(bookId,cid)、cards/stylelab/timeline…）／:217-219 兜底重定向 push／
// :703-729 lastHash/revertingHash/守卫通过 noteDeparture、失败 location.hash=from。
// harness：jsdom ＋ React 19 act ＋ 裸 DOM；10 个 #page-* 静态壳从 frontend/index.html 真实文本提取
// （P6-3：静态壳单一事实源迁入 frontend/，Vite HTML entry；产物 public/index.html 为构建输出）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P6-2 转写（Plan §2.4 T-F）：委托面由「mock window.<名>」改为「mock 承接模块」——
// 断言对象/次数逐条不变；WorkspaceState 守卫改 spy `getWorkspaceState()` 单例（旧名桥退役）。
const rec = vi.hoisted(() => ({ calls: null }));
vi.mock("./pages/WorkbenchPage.jsx", () => ({
	mountWorkbenchPage: (h) => rec.calls.workbench.push(h),
}));
vi.mock("./components/CharacterTimelinePanel.jsx", () => ({
	mountTimelineFullPage: (b, c) => rec.calls.timeline.push([b, c]),
}));
vi.mock("./pages/CardsPage.jsx", () => ({
	mount: (b) => rec.calls.cards.push(b),
}));
vi.mock("./pages/StyleLabPage.jsx", () => ({
	mount: (b) => rec.calls.stylelab.push(b),
}));
vi.mock("./pages/ReadPage.jsx", () => ({
	mount: (b, c) => rec.calls.read.push([b, c]),
}));
vi.mock("./pages/BookShell.jsx", () => ({
	mount: (b) => rec.calls.bookShell.push(b),
	bindShellEvents: () => {},
}));
vi.mock("./pages/ProfilePage.jsx", () => ({
	mount: () => {
		rec.calls.profile += 1;
	},
}));
vi.mock("./pages/SettingsPage.jsx", () => ({
	mount: () => {
		rec.calls.settings += 1;
	},
}));
vi.mock("./pages/ShelfPage.jsx", () => ({
	mount: () => {
		rec.calls.shelf += 1;
	},
}));
vi.mock("./components/AgentWorkspace.jsx", () => ({
	showAgentWorkspace: () => {
		rec.calls.agent += 1;
	},
}));

import AppRouter from "./AppRouter.jsx";
import { getWorkspaceState } from "./lib/workspace-state.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;

const PAGE_IDS = [
	"page-shelf",
	"page-book",
	"page-workbench",
	"page-settings",
	"page-agent",
	"page-timeline",
	"page-read",
	"page-stylelab",
	"page-cards",
	"page-profile",
];

function buildShellHtml() {
	const pages = PAGE_IDS.map(
		(id) => STATIC_DOC.getElementById(id).outerHTML,
	).join("");
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${pages}${modal}${toast}`;
}

const byId = (id) => document.getElementById(id);
const hidden = (id) => byId(id).classList.contains("hidden");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls;
let ws;
let roots;

function installBridgeMocks() {
	calls = {
		workbench: [],
		timeline: [],
		cards: [],
		stylelab: [],
		read: [],
		profile: 0,
		agent: 0,
		shelf: 0,
		settings: 0,
		bookShell: [],
		noteDeparture: [],
		beforeNavigate: [],
	};
	// 承接模块 mock 的记录面（模块工厂在文件顶部 vi.mock；此处只换装载记录容器）
	rec.calls = calls;
}

function installWorkspaceState() {
	const singleton = getWorkspaceState();
	singleton.clearGuards();
	ws = {
		nextResult: true,
		deferred: null,
		beforeNavigate: vi
			.spyOn(singleton, "beforeNavigate")
			.mockImplementation((arg) => {
				calls.beforeNavigate.push(arg);
				if (ws.deferred) return ws.deferred;
				return Promise.resolve(ws.nextResult);
			}),
		noteDeparture: vi
			.spyOn(singleton, "noteDeparture")
			.mockImplementation((from, to) => {
				calls.noteDeparture.push([from, to]);
			}),
	};
}

async function mountRouter(hash) {
	window.location.hash = hash;
	await sleep(5);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(<AppRouter />);
	});
	await sleep(60);
}

// jsdom 的 hashchange 迟到派发（实证 60~140ms 级）且偶发双发：等待用 act 轮询，
// 避免固定 sleep 造成的假红。
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

async function navigate(hash) {
	await act(async () => {
		window.location.hash = hash;
		await sleep(200);
	});
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = buildShellHtml();
	// 起点：hash 置为 #/ 且清空 history 长度基线不可行，用相对增量断言
	window.location.hash = "#/";
	installBridgeMocks();
	installWorkspaceState();
	vi.spyOn(console, "error").mockImplementation(() => {});
	roots = [];
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	vi.restoreAllMocks();
});

describe("AppRouter A 组：显隐/委托/once/重定向（legacy :119-223）", () => {
	it("R2-1 初始 '#/'：先全 hidden 再显 page-shelf，委托 MozhenShelf.mount；不调守卫（:121-123/:221-222/:730）", async () => {
		// 顺序证据用 classList 方法级拦截：hideAll 对 10 页逐一 add('hidden')（含目标页），
		// 之后才 showPage 目标页 remove('hidden')——精确对应 :121-123 的「先全 hidden 再显目标」。
		// （MutationObserver 回调异步、读取的是回调时的当前值，无法还原调用序，故不用。）
		const seq = [];
		for (const id of PAGE_IDS) {
			const cl = byId(id).classList;
			const origAdd = cl.add.bind(cl);
			const origRemove = cl.remove.bind(cl);
			cl.add = (...cls) => {
				if (cls.includes("hidden")) seq.push(`${id}:hide`);
				return origAdd(...cls);
			};
			cl.remove = (...cls) => {
				if (cls.includes("hidden")) seq.push(`${id}:show`);
				return origRemove(...cls);
			};
		}
		await mountRouter("#/");
		expect(hidden("page-shelf")).toBe(false);
		for (const id of PAGE_IDS) {
			if (id !== "page-shelf") expect(hidden(id), id).toBe(true);
		}
		expect(seq).toEqual([
			...PAGE_IDS.map((id) => `${id}:hide`),
			"page-shelf:show",
		]);
		expect(calls.shelf).toBe(1);
		// 初次 mount 直接提交，不带守卫（等值 :730 route()）
		expect(calls.beforeNavigate.length).toBe(0);
	});

	it("R2-2 委托形状逐 kind：workbench 原串/timeline/cards/stylelab/read/profile/agent/settings（:125-215）", async () => {
		await mountRouter("#/book/7/workbench/outline");
		expect(calls.workbench).toEqual(["#/book/7/workbench/outline"]);
		expect(hidden("page-workbench")).toBe(false);

		await navigate("#/book/7/characters/5/timeline");
		expect(calls.timeline.at(-1)).toEqual(["7", "5"]);
		expect(hidden("page-timeline")).toBe(false);

		await navigate("#/book/7/cards");
		expect(calls.cards.at(-1)).toBe("7");
		expect(hidden("page-cards")).toBe(false);

		await navigate("#/book/7/stylelab");
		expect(calls.stylelab.at(-1)).toBe("7");
		expect(hidden("page-stylelab")).toBe(false);

		await navigate("#/book/7/read/12");
		expect(calls.read.at(-1)).toEqual(["7", 12]);
		expect(hidden("page-read")).toBe(false);

		await navigate("#/book/7/read");
		expect(calls.read.at(-1)).toEqual(["7", null]);

		await navigate("#/profile");
		expect(calls.profile).toBe(1);
		expect(hidden("page-profile")).toBe(false);

		await navigate("#/agent");
		expect(calls.agent).toBe(1);
		expect(hidden("page-agent")).toBe(false);

		await navigate("#/settings");
		expect(calls.settings).toBe(1);
		expect(hidden("page-settings")).toBe(false);
	});

	it("R2-3 同 hash 重复 commit 不重复委托（once 守卫）；委托恰在显隐后（:121-129）", async () => {
		await mountRouter("#/book/7");
		expect(calls.bookShell).toEqual(["7"]);
		expect(hidden("page-book")).toBe(false);
		await act(async () => {
			window.dispatchEvent(new window.HashChangeEvent("hashchange"));
			await sleep(30);
		});
		expect(calls.bookShell).toEqual(["7"]);
		expect(calls.beforeNavigate.length).toBe(0);
	});

	it("R2-4 兜底重定向 push 语义：'#/unknown' → '#/' 且 history 长度 +2（用户导航＋重定向各一次 push）（:217-219）", async () => {
		await mountRouter("#/");
		const len0 = window.history.length;
		await navigate("#/unknown");
		// 重定向链两跳（用户导航→重定向 '#/'）且 jsdom 事件迟到：以条件轮询等待终态
		expect(
			await waitFor(
				() => window.location.hash === "#/" && !hidden("page-shelf"),
			),
		).toBe(true);
		expect(window.location.hash).toBe("#/");
		expect(hidden("page-shelf")).toBe(false);
		expect(window.history.length).toBe(len0 + 2);
	});

	it("R2-5 '#foo'（无前导斜杠）→ 重定向 '#/'；'#/book' 边界 → 重定向（:183-197/:217-219）", async () => {
		await mountRouter("#foo");
		expect(
			await waitFor(
				() => window.location.hash === "#/" && !hidden("page-shelf"),
			),
		).toBe(true);
		expect(window.location.hash).toBe("#/");
		await navigate("#/book");
		expect(
			await waitFor(
				() => window.location.hash === "#/" && !hidden("page-shelf"),
			),
		).toBe(true);
	});

	it("R2-6 book 本体前缀形态 '#/book/7/x' 与 readxyz：仍显 page-book/page-read（:164/:183-195）", async () => {
		await mountRouter("#/book/7/x");
		expect(calls.bookShell.at(-1)).toBe("7");
		await navigate("#/book/7/readxyz");
		expect(calls.read.at(-1)).toEqual(["7", null]);
		expect(hidden("page-read")).toBe(false);
	});

	it("R2-7 每次切页都先全 hidden：从 page-book 切 page-settings 后 book 隐藏（:121-123）", async () => {
		await mountRouter("#/book/7");
		await navigate("#/settings");
		expect(hidden("page-book")).toBe(true);
		expect(hidden("page-settings")).toBe(false);
	});
});

describe("AppRouter B 组：守卫门（legacy :698-730）", () => {
	it("R3-1 守卫放行：beforeNavigate({from,to,retry,discard}) → noteDeparture＋提交＋委托（:719-724）", async () => {
		await mountRouter("#/");
		ws.nextResult = true;
		await navigate("#/book/8");
		expect(calls.beforeNavigate.length).toBe(1);
		const arg = calls.beforeNavigate[0];
		expect(arg.from).toBe("#/");
		expect(arg.to).toBe("#/book/8");
		expect(typeof arg.retry).toBe("function");
		expect(typeof arg.discard).toBe("function");
		expect(calls.noteDeparture.at(-1)).toEqual(["#/", "#/book/8"]);
		expect(calls.bookShell.at(-1)).toBe("8");
		expect(hidden("page-book")).toBe(false);
	});

	it("R3-2 守卫拒绝：location.hash 回退 from，目标路由从不渲染/从不委托（:726-727）", async () => {
		await mountRouter("#/book/7");
		await act(async () => {
			window.dispatchEvent(new window.HashChangeEvent("hashchange"));
		});
		ws.nextResult = false;
		await navigate("#/book/8");
		expect(calls.bookShell).toEqual(["7"]); // 只收到初始 7，从未收到 8
		expect(window.location.hash).toBe("#/book/7");
		expect(hidden("page-book")).toBe(false);
		expect(calls.noteDeparture.length).toBe(0);
	});

	it("R3-3 from===to 短路：不跑守卫（:718）", async () => {
		await mountRouter("#/book/7");
		await act(async () => {
			window.dispatchEvent(new window.HashChangeEvent("hashchange"));
			await sleep(20);
		});
		expect(calls.beforeNavigate.length).toBe(0);
	});

	it("R3-4 单例直取（转写）：不再存在「无旧名直通」分支——守卫恒经 getWorkspaceState() 咨询（生产不可达差异备案）", async () => {
		// 转写理由：旧实现 `if (!window.WorkspaceState) return Promise.resolve(true)`；真实浏览器里
		// 旧名恒由桥供给（守卫恒真），该分支不可达 ⇒ 去全局后改为单例恒在、守卫恒被咨询。
		await mountRouter("#/");
		await navigate("#/book/9");
		expect(calls.beforeNavigate.length).toBe(1);
		expect(calls.bookShell.at(-1)).toBe("9");
		expect(hidden("page-book")).toBe(false);
	});

	it("R3-5 异步竞态令牌：守卫 pending 期间 hash 再变，迟到放行不得回切旧目标", async () => {
		await mountRouter("#/");
		let release;
		let first = true;
		ws.deferred = null;
		ws.beforeNavigate.mockImplementation((arg) => {
			calls.beforeNavigate.push(arg);
			if (first) {
				first = false;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(true);
		});
		await act(async () => {
			window.location.hash = "#/book/8";
		});
		await waitFor(() => calls.beforeNavigate.length === 1);
		await navigate("#/book/9");
		expect(calls.bookShell).toEqual(["9"]);
		await act(async () => {
			release(true);
			await sleep(50);
		});
		expect(calls.bookShell).toEqual(["9"]); // 迟到结果被令牌丢弃
		expect(window.location.hash).toBe("#/book/9");
	});

	it("R3-6 守卫失败回退后再次导航可正常放行（回退动作不循环）", async () => {
		await mountRouter("#/");
		ws.nextResult = false;
		await navigate("#/book/8");
		expect(window.location.hash).toBe("#/");
		ws.nextResult = true;
		await navigate("#/settings");
		expect(calls.settings).toBe(1);
		expect(hidden("page-settings")).toBe(false);
	});

	it("R3-7 守卫 pending 中 hash 回退到 from：迟到放行不得提交旧目标（URL 与可见页须一致）", async () => {
		await mountRouter("#/book/7");
		expect(calls.bookShell).toEqual(["7"]);
		let release;
		ws.beforeNavigate.mockImplementation((arg) => {
			calls.beforeNavigate.push(arg);
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		// 1) 发起 #/settings 导航 → 守卫在飞（beforeNavigate 恰一次）
		await act(async () => {
			window.location.hash = "#/settings";
		});
		expect(await waitFor(() => calls.beforeNavigate.length === 1)).toBe(true);
		// 2) hash 回退到 from（浏览器后退/守卫回退形态）→ from===to 短路；
		//    显式派发 hashchange 以保证该事件已被处理（jsdom 迟到派发不可依赖固定 sleep）
		await act(async () => {
			window.location.hash = "#/book/7";
			window.dispatchEvent(new window.HashChangeEvent("hashchange"));
			await sleep(30);
		});
		// 3) 迟到的 canLeave=true：不得把可见页切到 #/settings（legacy :714-724 页随 URL——
		//    route() 每次重读 location.hash，回退后 URL=#/book/7 就渲染写作页）
		await act(async () => {
			release(true);
			await sleep(80);
		});
		expect(window.location.hash).toBe("#/book/7");
		expect(hidden("page-book")).toBe(false);
		expect(hidden("page-settings")).toBe(true);
		expect(calls.settings).toBe(0); // 目标路由从不渲染/从不委托
		expect(calls.bookShell).toEqual(["7"]); // 不重复委托写作页
		expect(calls.noteDeparture).toEqual([]); // 未提交旧目标
	});
});
