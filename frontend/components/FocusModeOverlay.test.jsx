// @vitest-environment jsdom
// 专注写作模式（UI 优化阶段 2d）：开关按钮、编辑区顶部的卷／章面包屑、共享专注状态
// （lib/focus-state.js）与 body 类、Esc／hashchange 退出、sync 桥。
// harness：jsdom + React 19 内建 act + 裸 DOM 断言；静态壳最小集＝#btn-toggle-left-panel、
// #book-workbench 内 .panel-editor 与 .panel-chat；window.App 桩经 setAppForTests 交给模块单例，
// chapterEditorApi().selectChapter 以 spy 计数。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import {
	getFocusState,
	resetFocusStateForTest,
	setFocusChatOpen,
} from "../lib/focus-state.js";
import { chapterEditorApi } from "./ChapterEditorPanel.jsx";
import {
	focusModeIsActive,
	focusModeSync,
	mountFocusMode,
} from "./FocusModeOverlay.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function freshVols() {
	return [
		{ id: 1, title: "第一卷" },
		{ id: 2, title: "第二卷" },
		{ id: 3, title: "空卷" },
	];
}

function freshChapters() {
	return [
		{ id: 11, title: "第一章", volume_id: 1 },
		{ id: 12, title: "第二章", volume_id: 1 },
		{ id: 21, title: "卷二章", volume_id: 2 },
	];
}

let volsFixture;
let chaptersFixture;
let apiFail;
let apiCalls;
let toasts;
let selectCalls;

function mockApi(method, path) {
	apiCalls.push({ method, path });
	if (apiFail) return Promise.reject(new Error("网络故障"));
	if (method === "GET" && path === "/api/books/B1/volumes") {
		return Promise.resolve({ volumes: volsFixture });
	}
	if (method === "GET" && path === "/api/books/B1/chapters") {
		return Promise.resolve({ chapters: chaptersFixture });
	}
	return Promise.resolve({});
}

function buildShell({ withAnchor = true } = {}) {
	document.body.className = "";
	document.body.innerHTML = `<button id="btn-toggle-left-panel" class="btn btn-ghost" type="button">收起侧栏</button><main id="book-workbench" class="workbench"><section class="panel panel-editor"><div id="editor-body"></div></section><section class="panel panel-chat"><textarea id="chat-text" rows="3"></textarea></section></main>`;
	if (!withAnchor) document.getElementById("btn-toggle-left-panel")?.remove();
}

function setSelectValue(el, value) {
	el.value = value;
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function getCrumbs() {
	return document.querySelectorAll(".focus-crumbs select");
}

async function activate() {
	await act(async () => {
		document.getElementById("btn-focus-mode").click();
	});
	await act(async () => {});
}

const bodyHas = (cls) => document.body.classList.contains(cls);

beforeEach(async () => {
	resetFocusStateForTest();
	buildShell();
	volsFixture = freshVols();
	chaptersFixture = freshChapters();
	apiFail = false;
	apiCalls = [];
	toasts = [];
	selectCalls = [];
	setAppForTests({
		api: mockApi,
		state: {
			currentBook: { id: "B1" },
			currentChapterId: 11,
			currentVolumeId: 1,
		},
		toast(msg) {
			toasts.push(String(msg));
		},
	});
	vi.spyOn(chapterEditorApi(), "selectChapter").mockImplementation((id) => {
		selectCalls.push(id);
	});
	window.location.hash = "#/book/1";
	await act(async () => {
		mountFocusMode();
	});
});

afterEach(() => {
	setAppForTests(null);
	vi.restoreAllMocks();
});

describe("FocusModeOverlay 专注写作", () => {
	it("F1 自挂载：按钮落在 #btn-toggle-left-panel 之后；面包屑头是 .panel-editor 第一个子节点（不进 React 接管的 .panel-chat）；不再注入草稿抽屉／引用钮；锚点缺失则不挂、返回 null", async () => {
		expect(typeof focusModeSync).toBe("function");
		expect(typeof focusModeIsActive).toBe("function");
		expect(window.MozhenFocusMode).toBeUndefined();

		const anchor = document.getElementById("btn-toggle-left-panel");
		const btn = document.getElementById("btn-focus-mode");
		expect(anchor.nextElementSibling.querySelector("#btn-focus-mode")).toBe(
			btn,
		);
		expect(btn.className).toBe("btn btn-ghost");
		expect(btn.type).toBe("button");
		expect(btn.title).toBe("专注写作：只留正文和底部 AI 输入栏；Esc 退出");
		expect(btn.textContent).toBe("专注模式");
		expect(btn.getAttribute("aria-pressed")).toBe("false");

		const editor = document.querySelector("#book-workbench .panel-editor");
		const head = editor.firstElementChild;
		expect(head.className).toBe("focus-head");
		const [volSel, chSel] = head.querySelectorAll(".focus-crumbs select");
		expect(volSel.getAttribute("aria-label")).toBe("切换分卷");
		expect(chSel.getAttribute("aria-label")).toBe("切换章节");
		expect(head.querySelector(".crumb-sep").textContent).toBe("/");
		expect(document.querySelector(".panel-chat .focus-head")).toBeNull();

		expect(document.querySelector(".focus-preview-btn")).toBeNull();
		expect(document.querySelector(".focus-draft")).toBeNull();
		expect(document.querySelector(".quote-insert-btn")).toBeNull();

		buildShell({ withAnchor: false });
		expect(mountFocusMode()).toBeNull();
		expect(window.FocusMode).toBeUndefined();
		expect(document.getElementById("btn-focus-mode")).toBeNull();
		expect(document.querySelector(".focus-head")).toBeNull();
	});

	it("F1b 面包屑头在聊天面整块重渲染后仍在（阶段 1 报告记录的缺陷）", async () => {
		await activate();
		const chat = document.querySelector(".panel-chat");
		chat.innerHTML = "<form id='chat-form'></form>";
		expect(
			document.querySelector(".panel-editor > .focus-head"),
		).not.toBeNull();
		expect(getCrumbs().length).toBe(2);
	});

	it("F2 开关：点一下 → body.focus-mode、按钮 mode-on、共享状态 active；回复面板可展开（body.focus-chat-open）；再点 → 全部退出且面板收起", async () => {
		const btn = document.getElementById("btn-focus-mode");
		await activate();
		expect(bodyHas("focus-mode")).toBe(true);
		expect(btn.classList.contains("mode-on")).toBe(true);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		expect(focusModeIsActive()).toBe(true);
		expect(getFocusState()).toEqual({ active: true, chatOpen: false });

		await act(async () => setFocusChatOpen(true));
		expect(bodyHas("focus-chat-open")).toBe(true);

		await act(async () => {
			btn.click();
		});
		expect(bodyHas("focus-mode")).toBe(false);
		expect(bodyHas("focus-chat-open")).toBe(false);
		expect(btn.classList.contains("mode-on")).toBe(false);
		expect(focusModeIsActive()).toBe(false);
		expect(getFocusState()).toEqual({ active: false, chatOpen: false });

		// 非专注时展开面板是空操作
		setFocusChatOpen(true);
		expect(getFocusState().chatOpen).toBe(false);
	});

	it("F3 面包屑数据：进入专注并行拉卷与章；回填当前卷／章；拉取失败静默、保留旧选项", async () => {
		await activate();
		const gets = apiCalls.filter((c) => c.method === "GET");
		expect(gets.map((g) => g.path).sort()).toEqual([
			"/api/books/B1/chapters",
			"/api/books/B1/volumes",
		]);
		const [volSel, chSel] = getCrumbs();
		expect(volSel.options.length).toBe(3);
		expect(volSel.value).toBe("1");
		expect(volSel.options[0].textContent).toBe("第一卷");
		expect(chSel.options.length).toBe(3);
		expect(chSel.options[0].value).toBe("");
		expect(chSel.options[0].textContent).toBe("选择章节");
		expect(chSel.value).toBe("11");
		expect(chSel.options[2].textContent).toBe("第二章");

		apiFail = true;
		await act(async () => {
			document.getElementById("btn-focus-mode").click();
		});
		await activate();
		expect(toasts).toEqual([]);
		expect(getCrumbs()[0].options.length).toBe(3);
	});

	it("F4 切换：选章 → selectChapter(数字 id)；选有章的卷 → 跳到该卷首章；选空卷 → 提示并回弹、不切章", async () => {
		await activate();
		const [volSel, chSel] = getCrumbs();

		setSelectValue(chSel, "12");
		await act(async () => {});
		expect(selectCalls).toEqual([12]);

		setSelectValue(volSel, "2");
		await act(async () => {});
		expect(selectCalls).toEqual([12, 21]);

		setSelectValue(volSel, "3");
		await act(async () => {});
		expect(toasts).toEqual(["该卷还没有章节"]);
		expect(selectCalls).toEqual([12, 21]);
		expect(volSel.value).toBe("1");
		expect(chSel.value).toBe("11");
	});

	it("F7 Esc：非专注无操作；回复面板开着 → 只收面板；再按 → 退出专注", async () => {
		const esc = () =>
			act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			});
		await esc();
		expect(bodyHas("focus-mode")).toBe(false);

		await activate();
		await act(async () => setFocusChatOpen(true));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(bodyHas("focus-chat-open")).toBe(true);

		await esc();
		expect(bodyHas("focus-chat-open")).toBe(false);
		expect(bodyHas("focus-mode")).toBe(true);

		await esc();
		expect(bodyHas("focus-mode")).toBe(false);
		expect(focusModeIsActive()).toBe(false);
	});

	it("F8 hashchange：留在 #/book/<id> 不退；离开书主页 → 退出专注；非专注时无操作", async () => {
		const fireHash = () =>
			act(async () => {
				window.dispatchEvent(new Event("hashchange"));
			});
		await activate();
		window.location.hash = "#/book/12";
		await fireHash();
		expect(focusModeIsActive()).toBe(true);

		window.location.hash = "#/book/12/a";
		await fireHash();
		expect(focusModeIsActive()).toBe(false);
		expect(bodyHas("focus-mode")).toBe(false);
		expect(getFocusState().active).toBe(false);

		window.location.hash = "#/read/1";
		await fireHash();
		expect(focusModeIsActive()).toBe(false);
	});

	it("F9 sync：非专注零请求；专注时重拉卷与章；调用不抛", async () => {
		const getCnt = () => apiCalls.filter((c) => c.method === "GET").length;
		focusModeSync();
		expect(getCnt()).toBe(0);
		await activate();
		expect(getCnt()).toBe(2);
		await act(async () => {
			focusModeSync();
		});
		expect(getCnt()).toBe(4);
	});
});
