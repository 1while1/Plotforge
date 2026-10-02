// @vitest-environment jsdom
// T2（P6-2 Plan §4-T2）路由委托改静态 import：`window.*` 全部删除后 10 条 hash 仍逐条命中挂载件，
// 实参逐字；WorkspaceState 守卫经 `getWorkspaceState()` 单例（非 window）。
// 红态成因：今日 `runDelegate` 全经 `window.<名>` 守卫读取，窗口名缺 ⇒ 10 条委托全 no-op。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mountWorkbenchPage: vi.fn(),
	mountTimelineFullPage: vi.fn(),
	mountCards: vi.fn(),
	mountStyleLab: vi.fn(),
	mountRead: vi.fn(),
	mountBookShell: vi.fn(),
	mountProfile: vi.fn(),
	mountSettings: vi.fn(),
	mountShelf: vi.fn(),
	showAgentWorkspace: vi.fn(),
	bindShellEvents: vi.fn(),
	renderWritingStatus: vi.fn(),
	withWritingStatusRefresh: vi.fn((fn) => fn),
}));

vi.mock("../pages/WorkbenchPage.jsx", () => ({
	mountWorkbenchPage: mocks.mountWorkbenchPage,
}));
vi.mock("../components/CharacterTimelinePanel.jsx", () => ({
	mountTimelineFullPage: mocks.mountTimelineFullPage,
}));
vi.mock("../pages/CardsPage.jsx", () => ({ mount: mocks.mountCards }));
vi.mock("../pages/StyleLabPage.jsx", () => ({ mount: mocks.mountStyleLab }));
vi.mock("../pages/ReadPage.jsx", () => ({ mount: mocks.mountRead }));
vi.mock("../pages/BookShell.jsx", () => ({
	mount: mocks.mountBookShell,
	bindShellEvents: mocks.bindShellEvents,
	renderWritingStatus: mocks.renderWritingStatus,
	withWritingStatusRefresh: mocks.withWritingStatusRefresh,
}));
vi.mock("../pages/ProfilePage.jsx", () => ({ mount: mocks.mountProfile }));
vi.mock("../pages/SettingsPage.jsx", () => ({ mount: mocks.mountSettings }));
vi.mock("../pages/ShelfPage.jsx", () => ({ mount: mocks.mountShelf }));
vi.mock("../components/AgentWorkspace.jsx", () => ({
	showAgentWorkspace: mocks.showAgentWorkspace,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import AppRouter from "../AppRouter.jsx";
import { getWorkspaceState } from "../lib/workspace-state.js";

const PAGE_IDS = [
	"shelf",
	"book",
	"workbench",
	"settings",
	"agent",
	"timeline",
	"read",
	"stylelab",
	"cards",
	"profile",
];

// Plan §2.1-B 全量名单（与 zero-global.test.js 同源口径）
const NAMES = [
	"App",
	"BookPage",
	"WorkspaceState",
	"RunStatus",
	"ChatEventHub",
	"StyleHealth",
	"RewriteCurvePanel",
	"FocusMode",
	"ChapterConflict",
	"MozhenDiffView",
	"MozhenBookShell",
	"WorkbenchShell",
	"AgentPage",
	"MozhenSidebarConfig",
	"MozhenStateBook",
	"MozhenBookOutline",
	"MozhenPager",
	"MozhenCards",
	"MozhenStyleLab",
	"MozhenReadPage",
	"MozhenProfile",
	"MozhenSettings",
	"MozhenShelf",
	"MozhenCharacterTimeline",
	"MozhenCharacterAdvisor",
	"MozhenCharacterRelations",
	"MozhenApp",
	"MozhenChapterEditor",
	"MozhenBookChat",
];

let container;
let root;

function installShell() {
	document.body.innerHTML = PAGE_IDS.map(
		(p) => `<div id="page-${p}" class="page hidden"></div>`,
	).join("");
}

function renderAt(hash) {
	window.location.hash = hash;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(<AppRouter />);
	});
}

function unmount() {
	if (root) {
		act(() => root.unmount());
		root = null;
	}
	if (container?.parentNode) container.parentNode.removeChild(container);
	container = null;
}

const visible = () =>
	PAGE_IDS.filter(
		(p) => !document.getElementById(`page-${p}`).classList.contains("hidden"),
	);

beforeEach(() => {
	installShell();
	delete window.__MOZHEN_BOOK_SHELL_INSTALLED__;
	for (const n of NAMES) delete window[n];
	for (const fn of Object.values(mocks)) fn.mockClear();
});

afterEach(() => {
	unmount();
	vi.restoreAllMocks();
});

describe("T2 路由委托改模块直取（零窗口名）", () => {
	it("T2-0 前置：名单 29 个全局名已全部删除，删除后仍成立（无窗口名依赖）", () => {
		for (const n of NAMES) expect(window[n], n).toBe(undefined);
	});

	it("T2-1 10 条 hash 逐条命中对应挂载件、实参逐字、目标页可见其余隐藏", () => {
		const cases = [
			[
				"#/book/7/workbench/outline",
				mocks.mountWorkbenchPage,
				["#/book/7/workbench/outline"],
				"workbench",
			],
			[
				"#/book/7/characters/5/timeline",
				mocks.mountTimelineFullPage,
				["7", "5"],
				"timeline",
			],
			["#/book/7/cards", mocks.mountCards, ["7"], "cards"],
			["#/book/7/stylelab", mocks.mountStyleLab, ["7"], "stylelab"],
			["#/book/7/read/9", mocks.mountRead, ["7", 9], "read"],
			["#/book/7", mocks.mountBookShell, ["7"], "book"],
			["#/profile", mocks.mountProfile, [], "profile"],
			["#/settings", mocks.mountSettings, [], "settings"],
			["#/agent", mocks.showAgentWorkspace, [], "agent"],
			["#/", mocks.mountShelf, [], "shelf"],
		];
		for (const [hash, fn, args, pageId] of cases) {
			for (const f of Object.values(mocks)) f.mockClear();
			renderAt(hash);
			expect(fn.mock.calls.length, `${hash} → 委托命中`).toBe(1);
			expect(fn.mock.calls[0], `${hash} 实参`).toEqual(args);
			expect(visible(), `${hash} 可见页`).toEqual([pageId]);
			unmount();
		}
	});

	it("T2-2 导航守卫经 getWorkspaceState() 单例：beforeNavigate/noteDeparture 被调（非 window）", async () => {
		const ws = getWorkspaceState();
		ws.clearGuards();
		const before = vi.spyOn(ws, "beforeNavigate").mockResolvedValue(true);
		const note = vi.spyOn(ws, "noteDeparture");
		renderAt("#/");
		for (const f of Object.values(mocks)) f.mockClear();
		await act(async () => {
			window.location.hash = "#/book/7/cards";
			window.dispatchEvent(new window.Event("hashchange"));
			await Promise.resolve();
		});
		expect(before).toHaveBeenCalledTimes(1);
		expect(before.mock.calls[0][0]).toMatchObject({
			from: "#/",
			to: "#/book/7/cards",
		});
		expect(note).toHaveBeenCalledWith("#/", "#/book/7/cards");
		expect(mocks.mountCards).toHaveBeenCalledWith("7");
		expect(visible()).toEqual(["cards"]);
	});

	it("T2-3 守卫拦截时委托不执行、hash 回退（等值 legacy 语义）", async () => {
		const ws = getWorkspaceState();
		ws.clearGuards();
		vi.spyOn(ws, "beforeNavigate").mockResolvedValue(false);
		renderAt("#/");
		for (const f of Object.values(mocks)) f.mockClear();
		await act(async () => {
			window.location.hash = "#/book/7/cards";
			window.dispatchEvent(new window.Event("hashchange"));
			await Promise.resolve();
		});
		expect(mocks.mountCards).not.toHaveBeenCalled();
		expect(window.location.hash).toBe("#/");
	});

	it("T2-4 挂载时 bindShellEvents 直取（加载期副作用承接，等值 book.js:168）", () => {
		renderAt("#/");
		expect(mocks.bindShellEvents).toHaveBeenCalled();
	});
});
