// @vitest-environment jsdom
// 跳转面板（Ctrl K）、快捷键一览与写作页快捷键分发（UI 优化阶段 3b/3c）。
// 编辑器模块整体打桩：只看分发是否落到 chapterEditorApi / 现有按钮上。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { resetAppearanceForTest } from "../lib/appearance.js";

const editor = vi.hoisted(() => ({
	saveChapter: vi.fn(),
	selectChapter: vi.fn(),
	model: { volumes: [], chapters: [], version: 0 },
}));

vi.mock("../components/ChapterEditorPanel.jsx", () => ({
	chapterEditorApi: () => editor,
	getEditorListModel: () => editor.model,
}));

import { buildPaletteGroups, CommandPalette } from "./CommandPalette.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

let root;
let app;
let toasts;
let apiCalls;

function buildShell({ bookVisible = true } = {}) {
	document.body.innerHTML = `
		<div id="page-book" class="${bookVisible ? "" : "hidden"}">
			<button id="btn-lock-chapter" type="button">定稿</button>
			<button id="btn-focus-mode" type="button">专注</button>
		</div>
		<div id="modal-mask" class="modal-mask hidden"></div>
		<div id="mount"></div>`;
}

function press(key, mods = {}) {
	const e = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...mods,
	});
	act(() => {
		document.dispatchEvent(e);
	});
	return e;
}

beforeEach(() => {
	buildShell();
	toasts = [];
	apiCalls = [];
	editor.saveChapter.mockClear();
	editor.selectChapter.mockClear();
	editor.model = {
		volumes: [{ id: 1, title: "第一卷" }],
		chapters: [
			{ id: 11, volume_id: 1, title: "第一章" },
			{ id: 12, volume_id: 1, title: "第二章" },
		],
		version: 1,
	};
	app = {
		state: { currentBook: { id: "B1", title: "本书" }, currentChapterId: 11 },
		api: (method, path) => {
			apiCalls.push(`${method} ${path}`);
			return Promise.resolve({
				books: [
					{ id: "B1", title: "本书" },
					{ id: "B2", title: "另一本" },
				],
			});
		},
		toast: (t) => toasts.push(t),
	};
	setAppForTests(app);
	root = createRoot(document.getElementById("mount"));
	act(() => root.render(<CommandPalette />));
});

afterEach(() => {
	act(() => root.unmount());
	setAppForTests(null);
	resetAppearanceForTest();
	localStorage.clear();
	document.body.innerHTML = "";
});

describe("buildPaletteGroups", () => {
	it("不在写作页时只给全站跳转、外观与帮助", () => {
		const groups = buildPaletteGroups({
			book: null,
			chapters: [],
			books: [{ id: "B2", title: "另一本" }],
			theme: "dark",
		});
		expect(groups.map((g) => g.heading)).toEqual([
			"前往",
			"打开作品",
			"外观",
			"帮助",
		]);
		const theme = groups.find((g) => g.heading === "外观").items;
		expect(theme.filter((t) => t.on).map((t) => t.id)).toEqual(["theme-dark"]);
	});

	it("写作页加本书操作、章节与本书页面，打开作品里去掉当前这本", () => {
		const groups = buildPaletteGroups({
			book: { id: "B1" },
			chapters: [{ id: 11, title: "第一章", volumeTitle: "第一卷" }],
			books: [
				{ id: "B1", title: "本书" },
				{ id: "B2", title: "另一本" },
			],
			theme: "light",
		});
		expect(groups.map((g) => g.heading)).toEqual([
			"本书操作",
			"跳到章节",
			"本书页面",
			"前往",
			"打开作品",
			"外观",
			"帮助",
		]);
		expect(groups[1].items[0]).toMatchObject({
			id: "chapter-11",
			label: "第一章",
			hint: "第一卷",
		});
		expect(groups[4].items.map((i) => i.id)).toEqual(["book-B2"]);
	});
});

describe("快捷键分发", () => {
	it("Ctrl+K 打开跳转面板并拉作品列表；面板开着时其他快捷键不触发", async () => {
		const e = press("k", { ctrlKey: true });
		expect(e.defaultPrevented).toBe(true);
		await act(async () => {});
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog.textContent).toContain("第二章");
		expect(dialog.textContent).toContain("另一本");
		expect(apiCalls).toEqual(["GET /api/books"]);
		press("s", { ctrlKey: true });
		expect(editor.saveChapter).not.toHaveBeenCalled();
	});

	it("Ctrl+/ 打开快捷键一览", () => {
		press("/", { ctrlKey: true });
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("快捷键");
		expect(dialog?.textContent).toContain("Ctrl+Shift+L");
	});

	it("写作页：Ctrl+S 保存，Alt+↓/↑ 切章并在到头时提示", () => {
		const e = press("s", { ctrlKey: true });
		expect(e.defaultPrevented).toBe(true);
		expect(editor.saveChapter).toHaveBeenCalledTimes(1);
		press("ArrowDown", { altKey: true });
		expect(editor.selectChapter).toHaveBeenCalledWith(12);
		press("ArrowUp", { altKey: true });
		expect(toasts).toEqual(["已经是第一章"]);
	});

	it("Ctrl+Shift+L 只定稿不解除；Ctrl+Shift+F 走专注按钮", () => {
		const lock = document.getElementById("btn-lock-chapter");
		const lockClick = vi.fn();
		lock.addEventListener("click", lockClick);
		press("L", { ctrlKey: true, shiftKey: true });
		expect(lockClick).toHaveBeenCalledTimes(1);
		lock.classList.add("mode-on");
		press("L", { ctrlKey: true, shiftKey: true });
		expect(lockClick).toHaveBeenCalledTimes(1);
		expect(toasts[0]).toContain("已定稿");

		const focusClick = vi.fn();
		document
			.getElementById("btn-focus-mode")
			.addEventListener("click", focusClick);
		press("F", { ctrlKey: true, shiftKey: true });
		expect(focusClick).toHaveBeenCalledTimes(1);
	});

	it("不在写作页或旧式弹窗开着时，写作页快捷键不拦截", () => {
		document.getElementById("modal-mask").classList.remove("hidden");
		const e1 = press("s", { ctrlKey: true });
		expect(e1.defaultPrevented).toBe(false);
		document.getElementById("modal-mask").classList.add("hidden");
		document.getElementById("page-book").classList.add("hidden");
		const e2 = press("s", { ctrlKey: true });
		expect(e2.defaultPrevented).toBe(false);
		expect(editor.saveChapter).not.toHaveBeenCalled();
	});
});
