// @vitest-environment jsdom
// T5（P6-2 Plan §4-T5）编辑器名义入口内部化：`delete window.BookPage` 后（**不装载 index.html 的
// 编辑器 bootstrap 桩**），点击保存/点章行仍经 `chapterEditorApi()` 命中，且三入口刷新计数守恒。
//
// 断言要点（Plan §4-T5）：
//   · mountChapterEditor() 在零窗口名环境可用（8 名齐备）；
//   · 点保存按钮 → chapterEditorApi().saveChapter 恰 1 次且刷新 +1；
//   · 点章行 → selectChapter 恰 1 次且刷新 +1；
//   · loadChapters()／_doSaveChapter() 调用**不新增刷新**（计数不变，等值 P6-1 包装名单）。
//
// 红态成因：今日内建调用全经 `window.BookPage.*`（ChapterEditorPanel.jsx 40 处）——缺名即抛/早退。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chapterEditorApi,
	mountChapterEditor,
} from "../components/ChapterEditorPanel.jsx";
import { setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";

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

const BOOK_ID = "B1";
const CHAPTER_ID = 101;
const EDITOR_METHODS = [
	"loadChapters",
	"selectChapter",
	"saveChapter",
	"_doSaveChapter",
	"hasUnsavedChanges",
	"clearUnsaved",
	"leaveGuard",
	"bindChapterEvents",
];

function buildShellHtml() {
	const book = STATIC_DOC.getElementById("page-book").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${book}${modal}${toast}`;
}

let apiCalls;
let badgeSpy;

function installEnv() {
	apiCalls = [];
	window.App = {
		state: {
			currentBook: { id: BOOK_ID, title: "测试之书" },
			currentChapterId: null,
			currentVolumeId: null,
		},
		async api(method, url) {
			const p = String(url);
			apiCalls.push({ method, path: p });
			if (method === "GET" && p === `/api/books/${BOOK_ID}/volumes`)
				return { volumes: [{ id: 10, title: "第一卷 试炼" }] };
			if (method === "GET" && p === `/api/books/${BOOK_ID}/chapters`)
				return {
					chapters: [
						{
							id: CHAPTER_ID,
							title: "第一章 起点",
							volume_id: 10,
							revision: 3,
							content: "第一段落。\n第二段落。\n",
						},
						{
							id: 102,
							title: "第二章 转折",
							volume_id: 10,
							revision: 4,
							content: "转折正文",
						},
					],
				};
			if (method === "GET" && /\/chapters\/\d+$/.test(p))
				return {
					chapter: {
						id: CHAPTER_ID,
						title: "第一章 起点",
						content: "第一段落。\n第二段落。\n",
						revision: 3,
					},
				};
			if (method === "PUT" && /\/chapters\/\d+$/.test(p))
				return { chapter: { id: CHAPTER_ID, revision: 4 } };
			return {};
		},
		toast() {},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
	// 零窗口名环境：BookPage / WorkspaceState / FocusMode / ChapterConflict / MozhenDiffView 全不存在
	delete window.BookPage;
	delete window.WorkspaceState;
	delete window.FocusMode;
	delete window.ChapterConflict;
	delete window.MozhenDiffView;
	// P6-2：App 取用已改 `lib/app-runtime.js` 单例直取，harness 经 setAppForTests 注入桩
	setAppForTests(window.App);
	// 计数干净：RunStatus 先设真实单例（守卫式桥不覆盖）
	window.RunStatus = runStatus;
}

const byId = (id) => document.getElementById(id);
const row = (id) =>
	document.querySelector(`#chapter-list .chapter-row[data-id="${id}"]`);

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function flush(ms) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms == null ? 20 : ms));
	});
}

function cleanup() {
	document.body.innerHTML = "";
	setAppForTests(null);
	delete window.App;
	delete window.RunStatus;
	delete window.BookPage;
	delete window.MozhenChapterEditor;
}

const badgeCalls = () => badgeSpy.mock.calls.length;

async function bootstrapEditor() {
	await act(async () => {
		mountChapterEditor();
	});
	await act(async () => {
		chapterEditorApi().bindChapterEvents();
	});
	await act(async () => {
		await chapterEditorApi().loadChapters();
	});
	badgeSpy = vi.spyOn(runStatus, "renderWritingSaveBadge");
}

beforeEach(async () => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	cleanup();
	document.body.innerHTML = buildShellHtml();
	localStorage.clear();
	sessionStorage.clear();
	installEnv();
});

afterEach(async () => {
	vi.restoreAllMocks();
	cleanup();
});

describe("T5 编辑器名义入口内部化（零 window.BookPage）", () => {
	it("T5-1 挂载面：零窗口名环境 mountChapterEditor() 可用，chapterEditorApi() 8 名齐备", async () => {
		expect(window.BookPage).toBe(undefined);
		let api = null;
		await act(async () => {
			api = mountChapterEditor();
		});
		expect(api).toBeTruthy();
		expect(chapterEditorApi()).toBe(api);
		for (const n of EDITOR_METHODS)
			expect(typeof chapterEditorApi()[n], n).toBe("function");
		expect(document.querySelectorAll("#chapter-list .chapter-row").length).toBe(
			0,
		);
	});

	it("T5-2 保存入口：点 #btn-save-chapter → chapterEditorApi().saveChapter 恰 1 次且刷新恰 +1", async () => {
		await bootstrapEditor();
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);
		const saveSpy = vi.spyOn(chapterEditorApi(), "saveChapter");
		const doSpy = vi.spyOn(chapterEditorApi(), "_doSaveChapter");
		const base = badgeCalls();
		await act(async () => {
			setInputValue(byId("chapter-content"), "经名义入口保存");
		});
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(saveSpy.mock.calls.length).toBe(1);
		expect(doSpy.mock.calls.length).toBe(1);
		const puts = apiCalls.filter((c) => c.method === "PUT");
		expect(puts.length).toBe(1);
		expect(badgeCalls()).toBe(base + 1);
	});

	it("T5-3 切章入口：点章行 → chapterEditorApi().selectChapter 恰 1 次且刷新恰 +1", async () => {
		await bootstrapEditor();
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		const selectSpy = vi.spyOn(chapterEditorApi(), "selectChapter");
		const base = badgeCalls();
		await act(async () => {
			row(102).click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(selectSpy.mock.calls.length).toBe(1);
		expect(window.App.state.currentChapterId).toBe(102);
		expect(badgeCalls()).toBe(base + 1);
	});

	it("T5-4 不新增刷新：loadChapters()／_doSaveChapter() 直调不动刷新计数（P6-1 包装名单守恒）", async () => {
		await bootstrapEditor();
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		const base = badgeCalls();
		await act(async () => {
			await chapterEditorApi().loadChapters();
		});
		expect(badgeCalls()).toBe(base);
		await act(async () => {
			await chapterEditorApi()._doSaveChapter(true);
		});
		expect(badgeCalls()).toBe(base);
		await flush(10);
	});
});
