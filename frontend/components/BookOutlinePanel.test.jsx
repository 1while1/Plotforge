// @vitest-environment jsdom
// S3-2 红测（Plan §4 T16~T18）：BookOutlinePanel——book-outline.js（58 行）React 化：
// JSX 镜像 index.html:102~112 静态标记（两组 pane-head/textarea/field-hint/ul，
// 含 inline margin-top:16px 与 placeholder 逐字，四 id 保留）；loadSignal 序号模式
// （等价旧 loadOutline：读 App.state.currentBook 填 textarea + 清 drift 行，无 API 调用）；
// 保存 PUT trim 值 + App.state.currentBook.master_outline 突变保留 + toast『总纲已保存』、
// textarea 不重排、失败 toast e.message；对齐检查 disabled+『检查中…』→POST
// drift-check-all → 行渲染逐字（DRIFT_LABEL 五映射/note title/note 尾注 slice(0,40)/
// drift-code）→ chapterEditorApi().loadChapters() 恰 1 次 → 按钮恢复；失败恢复按钮并 toast。
// mock window.App.api/state 与 chapterEditorApi().loadChapters（P6-2 §2.5-D1/D4 转写），零网络。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import BookOutlinePanel from "./BookOutlinePanel.jsx";
import { chapterEditorApi } from "./ChapterEditorPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let apiCalls = [];
let apiImpl = null;
let loadChaptersCalls = 0;

function mountPanel(loadSignal = 1) {
	const host = document.getElementById("book-outline-mount");
	act(() => {
		createRoot(host).render(<BookOutlinePanel loadSignal={loadSignal} />);
	});
	return act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const DRIFT_ROWS = [
	{ status: "ok", title: "第一章", note: "", code: "" },
	{
		status: "minor",
		title: "第二章",
		note: "节奏略慢于卷大纲预期节奏",
		code: "PACING",
	},
	{ status: "major", title: "第三章", note: "", code: "" },
	{ status: "failed", title: "第四章", note: "空输出", code: "EMPTY_OUTPUT" },
	{ status: "error", title: "第五章", note: "", code: "" },
];

beforeEach(() => {
	document.body.innerHTML = `<div id="book-outline-mount"></div><div id="toast" class="toast hidden"></div>`;
	apiCalls = [];
	apiImpl = null;
	loadChaptersCalls = 0;
	window.App = {
		state: { currentBook: { id: 7, master_outline: "主线：夺回王城" } },
		api: (method, path, body) => {
			apiCalls.push({ method, path, body });
			if (apiImpl) return apiImpl(method, path, body);
			return Promise.resolve({});
		},
	};
	// P6-2 转写（Plan §2.5-D4）：`window.BookPage.loadChapters` 桩面换为
	// `chapterEditorApi()`（未挂载＝NULL 占位面单例）同名方法上的 spy——计数口径与次数断言零改动。
	vi.spyOn(chapterEditorApi(), "loadChapters").mockImplementation(() => {
		loadChaptersCalls += 1;
	});
});

// P6-2 转写（Plan §2.5-D1 单例注入缝）：生产面已改 `getApp()` 直取模块单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
	vi.restoreAllMocks();
});

describe("BookOutlinePanel（book-outline 迁移）", () => {
	it("T16 mount+loadSignal：textarea 值===currentBook.master_outline；drift 初始空；结构/placeholder/rows/inline margin-top:16px 逐字在场", async () => {
		await mountPanel();
		expect(document.getElementById("master-outline").value).toBe(
			"主线：夺回王城",
		);
		expect(document.getElementById("drift-results").childElementCount).toBe(0);
		const ta = document.getElementById("master-outline");
		expect(ta.className).toBe("outline-textarea");
		expect(ta.getAttribute("rows")).toBe("10");
		expect(ta.getAttribute("placeholder")).toBe(
			"全书的主线目标、阶段划分、核心冲突…（卷大纲在章节页各卷的 ✎ 里编辑）",
		);
		const heads = document.querySelectorAll("#book-outline-mount .pane-head");
		expect(heads.length).toBe(2);
		expect(heads[0].querySelector(".pane-title").textContent).toBe("全书总纲");
		expect(document.getElementById("btn-save-outline").textContent).toBe(
			"保存",
		);
		expect(document.getElementById("btn-save-outline").className).toBe(
			"btn btn-small",
		);
		// inline margin-top:16px 逐字在场（jsdom style 序列化含空格分号，按语义属性断言）
		expect(heads[1].getAttribute("style")).toContain("margin-top");
		expect(heads[1].style.marginTop).toBe("16px");
		expect(heads[1].querySelector(".pane-title").textContent).toBe("偏离监督");
		const driftBtn = document.getElementById("btn-drift-check");
		expect(driftBtn.textContent).toBe("全书对齐检查");
		expect(driftBtn.className).toBe("btn btn-small btn-outline");
		expect(
			document.querySelector("#book-outline-mount .field-hint").textContent,
		).toBe("每次生成章节总结时会自动检测；这里可手动批量检查当前卷。");
		expect(document.getElementById("drift-results").className).toBe(
			"item-list",
		);
		// 挂载本身不发请求（等价旧 loadOutline 无 API 调用）
		expect(apiCalls.length).toBe(0);
	});

	it("T17 保存：PUT trim 值 + currentBook 突变保留 + toast『总纲已保存』；textarea 不重排；reject → toast e.message", async () => {
		await mountPanel();
		const ta = document.getElementById("master-outline");
		const setValue = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		).set;
		await act(async () => {
			setValue.call(ta, "  新总纲稿  ");
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			document.getElementById("btn-save-outline").click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		const put = apiCalls.find((c) => c.method === "PUT");
		expect(put).toEqual({
			method: "PUT",
			path: "/api/books/7",
			body: { master_outline: "新总纲稿" },
		});
		expect(window.App.state.currentBook.master_outline).toBe("新总纲稿");
		expect(document.getElementById("toast").textContent).toBe("总纲已保存");
		// textarea 不被重排（保留输入原样，含未 trim 的空白）
		expect(document.getElementById("master-outline").value).toBe(
			"  新总纲稿  ",
		);
		// 失败分支
		apiImpl = () => Promise.reject(new Error("保存失败"));
		await act(async () => {
			document.getElementById("btn-save-outline").click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(document.getElementById("toast").textContent).toBe("保存失败");
	});

	it("T18 对齐检查：disabled+『检查中…』→POST drift-check-all→行渲染逐字→loadChapters 恰 1 次→按钮恢复；reject 恢复按钮并 toast", async () => {
		await mountPanel();
		let resolveApi;
		apiImpl = () =>
			new Promise((resolve) => {
				resolveApi = resolve;
			});
		const btn = document.getElementById("btn-drift-check");
		await act(async () => {
			btn.click();
			await Promise.resolve();
		});
		// 检查中态（挂起在 await api：disabled + 文案切换）
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("检查中…");
		await act(async () => {
			resolveApi({ results: DRIFT_ROWS });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		const post = apiCalls.find((c) => c.method === "POST");
		expect(post).toEqual({
			method: "POST",
			path: "/api/books/7/drift-check-all",
			body: undefined,
		});
		const rows = [...document.querySelectorAll("#drift-results li")];
		expect(rows.length).toBe(5);
		expect(rows.map((r) => r.className)).toEqual([
			"item-row drift-ok",
			"item-row drift-minor",
			"item-row drift-major",
			"item-row drift-failed",
			"item-row drift-error",
		]);
		const badges = rows.map((r) => r.querySelector(".drift-badge"));
		expect(badges.map((b) => b.className)).toEqual([
			"drift-badge ok",
			"drift-badge minor",
			"drift-badge major",
			"drift-badge failed",
			"drift-badge error",
		]);
		expect(badges.map((b) => b.textContent)).toEqual([
			"符合",
			"轻度偏离",
			"严重偏离",
			"检测失败",
			"检测失败",
		]);
		const names = rows.map((r) => r.querySelector(".item-name"));
		expect(names[0].textContent).toBe("第一章");
		expect(names[0].getAttribute("title")).toBe("");
		expect(names[1].textContent).toBe("第二章 — 节奏略慢于卷大纲预期节奏");
		expect(names[1].getAttribute("title")).toBe("节奏略慢于卷大纲预期节奏");
		expect(names[2].textContent).toBe("第三章");
		const codes = rows.map((r) => r.querySelector(".drift-code"));
		expect(codes[0]).toBeNull();
		expect(codes[1].textContent).toBe("PACING");
		expect(codes[2]).toBeNull();
		expect(codes[3].textContent).toBe("EMPTY_OUTPUT");
		expect(codes[4]).toBeNull();
		expect(loadChaptersCalls).toBe(1);
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("全书对齐检查");
		// 失败分支：toast + 按钮恢复
		apiImpl = () => Promise.reject(new Error("检测服务不可用"));
		await act(async () => {
			btn.click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(document.getElementById("toast").textContent).toBe("检测服务不可用");
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("全书对齐检查");
	});

	it("T18b note 超 40 字截断 slice(0,40)；ok+note 不出尾注", async () => {
		await mountPanel();
		const longNote = "长".repeat(50);
		apiImpl = () =>
			Promise.resolve({
				results: [
					{ status: "ok", title: "甲", note: longNote, code: "" },
					{ status: "minor", title: "乙", note: longNote, code: "" },
				],
			});
		await act(async () => {
			document.getElementById("btn-drift-check").click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		const rows = [...document.querySelectorAll("#drift-results li")];
		expect(rows[0].querySelector(".item-name").textContent).toBe("甲");
		expect(rows[1].querySelector(".item-name").textContent).toBe(
			`乙 — ${"长".repeat(40)}`,
		);
	});
});
