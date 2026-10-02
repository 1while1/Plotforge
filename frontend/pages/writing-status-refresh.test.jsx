// @vitest-environment jsdom
// P6-1 红测（Plan §4；S5-10-X1 裁定 (b)）：三入口状态条刷新职责内化。
// 被判定的现职契约＝「保存/切章/会话三入口完成即刷新状态条」，在**无壳挂载环境**下必须成立
// （＝刷新供给不再来自 BookShell.ensureInstalled 的 wrapStatusRefresh 链，legacy book.js:153-163）。
// 反向＝守恒断言（P6-1-4）：挂壳态下三入口每次调用**恰 +1**，挡住「链＋内化」双刷。
//
// harness（先例逐条）：
// - 静态壳 `#page-book`（内含 topbar/状态条 :73-79/编辑器壳/聊天壳）＋modal-mask＋toast 三件从
//   frontend/index.html 真实文本提取（禁复制粘贴；P6-3 源迁入）——BookShell.test.jsx:23-35 同款。
// - 两段 classic 委托桩（编辑器 8 名 :773-788、聊天 11 名 :797-812）真实文本 eval——
//   ChapterEditorPanel.test.jsx:50-67／book-chat-bridges.test.jsx:47-57 同款。
// - `window.RunStatus` **先**设为真实单例 runStatus：legacy-bridge.jsx:150-153 是守卫式注册
//   （`if (!window.RunStatus)` ⇒ 桥不覆盖、`observeApi()` 不执行 ⇒ App.api 不被猴补、计数干净），
//   随后 spy `renderWritingSaveBadge` 作刷新计数器——它是 BookShell.jsx:111-112 的唯一产品调用点
//   （grep 亲验），故计数 ≡ renderWritingStatus 调用次数。
// - 关键设定：P6-1-1/2/3/5/6 一律**不调用** `window.MozhenBookShell.show()`（无壳 mount ⇒
//   ensureInstalled 未跑 ⇒ 无链），这正是「刷新职责已内化」的判据环境。
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
import { bindChatEvents, chatApi } from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import { renderWritingStatusIfBound } from "../lib/writing-status.js";
import {
	mount as mountBookShell,
	renderWritingStatus,
	resetInstalledForTests,
} from "./BookShell.jsx";

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
// 静态 doc：不执行脚本，仅供静态壳提取（单一事实源）
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;

const BOOK_ID = "B1";
const CHAPTER_ID = 101;
const BOOK_TITLE = "测试之书";

// P6-2 ⑨ 留案：P6-1 期的 `scriptsOf(INDEX_HTML)`（解析 classic 内联段的两个见证点：bootstrap 段
// 提取与聊天桩段的 11 名）随 index.html 内联段清零而对象消失——语义并入 zero-global T1／boot-order T6
// 的「零内联段」见证（本件只留 React 侧刷新计数断言，计数不缩水）。

function buildShellHtml() {
	const book = STATIC_DOC.getElementById("page-book").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${book}${modal}${toast}`;
}

const byId = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeout = 2000) => {
	const t0 = Date.now();
	for (;;) {
		if (cond()) return true;
		if (Date.now() - t0 > timeout) return false;
		await act(async () => {
			await sleep(10);
		});
	}
};

let apiCalls;
let toasts;
let badgeSpy;

// 三件自挂载侧栏桥（show 编排会调）：置为 no-op，避免无关面把 runShow 带进 catch
// （BookShell.test.jsx:131-157 同款三件桩）；壳链安装与 runShow 成败无关。
function stubSidePanels() {
	const noop = {
		bindEvents() {},
		load() {},
		bind() {},
	};
	window.MozhenBookOutline = noop;
	window.MozhenStateBook = noop;
	window.MozhenSidebarConfig = noop;
}

function installEnv() {
	apiCalls = [];
	toasts = [];
	window.App = {
		state: {
			currentBook: { id: BOOK_ID, title: BOOK_TITLE },
			currentChapterId: null,
			currentVolumeId: null,
		},
		api: async (method, url, body) => {
			apiCalls.push({ method, path: url, body });
			const p = String(url);
			if (method === "GET" && p === `/api/books/${BOOK_ID}`)
				return { book: { id: BOOK_ID, title: BOOK_TITLE } };
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
						},
					],
				};
			if (
				method === "GET" &&
				p === `/api/books/${BOOK_ID}/chapters/${CHAPTER_ID}`
			)
				return {
					chapter: {
						id: CHAPTER_ID,
						title: "第一章 起点",
						content: "第一段落。\n第二段落。\n",
						beat: "",
						revision: 3,
					},
				};
			if (
				method === "PUT" &&
				p === `/api/books/${BOOK_ID}/chapters/${CHAPTER_ID}`
			)
				return {
					chapter: { id: CHAPTER_ID, revision: 4 },
					persistence: { durable: true },
				};
			if (method === "GET" && p.indexOf(`/api/books/${BOOK_ID}/chat`) === 0) {
				if (p.indexOf("/chat/actions") >= 0) return { actions: [] };
				return { messages: [], conversationId: null };
			}
			if (method === "GET" && p.indexOf("/api/conversations?") === 0) return [];
			// P6-2 转写：三面板/壳的接线改模块直取后，其装载请求落在同一 App 桩上（原由测试的
			// window.Mozhen* 桩吞掉）——按真实响应形状供给
			if (p.indexOf("/sidebar-preferences") >= 0)
				return {
					preferences: {
						moduleOrder: [
							"chapters",
							"outline",
							"ledger",
							"world",
							"characters",
						],
						hiddenModules: [],
						summaryFields: {
							chapters: [],
							outline: [],
							ledger: [],
							world: [],
							characters: [],
						},
					},
				};
			if (p.indexOf("/outline") >= 0)
				return { outline: { mainPlot: "", volumeNotes: [] } };
			if (p.indexOf("/state") >= 0) return { states: {} };
			return {};
		},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
	// 每测＝一次「页加载」：BookPage 取新对象（等值 index.html:776 首次建对象）＋壳安装幂等键复位
	// P6-2：App 改经 `getApp()` 单例读取 ⇒ 把本测的 App 桩注入单例（等值旧 `window.App` 全局）；
	// 壳安装幂等键改模块级（`resetInstalledForTests`）。
	setAppForTests(window.App);
	resetInstalledForTests();
	// P6-2（⑨ 切换笔）：index.html 两段 classic 承接桩与旧名桥同笔退役 ⇒ 桩段提取＋eval 退役；
	// 编辑器/聊天面改模块直取。**本 harness 不执行 initFrontendRuntime 的 observeApi 猴补**
	// ——等值旧口径（旧 harness 预置 window.RunStatus 使守卫式桥不调 observeApi），
	// 故 badge 计数与 P6-1 基线逐字一致（猴补在生产照常经 initFrontendRuntime 启用）。
}

async function registerAll() {
	await act(async () => {
		mountChapterEditor();
		bindChatEvents();
	});
	badgeSpy = vi.spyOn(runStatus, "renderWritingSaveBadge");
}

const badgeCalls = () => badgeSpy.mock.calls.length;

// show 编排不可 await（mount 无返回）：以「状态条书格被 show 收尾写入」为装载静默信号
// （BookShell.jsx:290 在 Promise.all 之后，故见该文案＝全部装载已完成）
async function showBook(bookId = BOOK_ID) {
	await act(async () => {
		mountBookShell(bookId);
		await sleep(10);
	});
	await waitFor(
		() => byId("writing-status-book").textContent === `《${BOOK_TITLE}》`,
	);
	await act(async () => {
		await sleep(20);
	});
}

function cleanup() {
	document.body.innerHTML = "";
	setAppForTests(null);
	delete window.App;
	delete window.RunStatus;
	delete window.BookPage;
	delete window.MozhenApp;
	delete window.MozhenBookShell;
	delete window.MozhenChapterEditor;
	delete window.MozhenBookChat;
	delete window.MozhenBookOutline;
	delete window.MozhenStateBook;
	delete window.MozhenSidebarConfig;
	delete window.__MOZHEN_BOOK_SHELL_INSTALLED__;
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	cleanup();
	document.body.innerHTML = buildShellHtml();
	sessionStorage.clear();
	localStorage.clear();
	installEnv();
});

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

describe("P6-1 三入口状态条刷新职责内化（S5-10-X1(b)）", () => {
	it("P6-1-1 切章入口：无壳环境下 selectChapter 后章格跟上（计数恰 +1）", async () => {
		await registerAll();
		// 无壳 mount 环境自证：壳方法注册与包装链都没跑过
		expect(window.BookPage).toBe(undefined); // P6-2（⑨）：旧名面整体退役（原＝未注册 renderWritingStatus）
		expect(byId("writing-status-chapter").textContent).toBe("未选择章节");
		const base = badgeCalls();
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		expect(byId("writing-status-chapter").textContent).toBe("《第一章 起点》");
		expect(badgeCalls()).toBe(base + 1);
		expect(window.App.state.currentChapterId).toBe(CHAPTER_ID);
	});

	it("P6-1-2 保存入口：无壳环境下 saveChapter 后保存格＝已保存、脏标记清（计数恰 +1）", async () => {
		await registerAll();
		await act(async () => {
			await chapterEditorApi().bindChapterEvents();
		});
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		await act(async () => {
			const el = byId("chapter-content");
			el.value = `${el.value}新增一行。`;
			el.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		renderWritingStatus(); // 显式刷新（非链）：让脏态上条，作保存前后对照
		expect(byId("writing-status-save").textContent).toBe("本地未保存");
		const base = badgeCalls();
		await act(async () => {
			await chapterEditorApi().saveChapter(true);
		});
		expect(badgeCalls()).toBe(base + 1);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);
		expect(byId("writing-status-save").textContent).toBe("已保存");
	});

	it("P6-1-3 会话入口：bindChatEvents 冷启动首挂后 loadChat 刷新会话格（计数恰 +1；不断言新会话名）", async () => {
		await registerAll();
		const staticMsgs = document.querySelector("#chat-messages");
		await act(async () => {
			await bindChatEvents();
		});
		// 首挂自证：静态节点已被 React 原位接管（G-B-5 同款）
		expect(document.querySelector("#chat-messages")).not.toBe(staticMsgs);
		byId("writing-status-conversation").textContent = "STALE";
		const base = badgeCalls();
		await act(async () => {
			await chatApi().loadChat();
		});
		expect(byId("writing-status-conversation").textContent).not.toBe("STALE");
		// 空会话列表下的会话格文案（只断言「被刷新」，不断言新会话名——§2.5 注 3）
		expect(byId("writing-status-conversation").textContent).toBe(
			"（默认：历史对话）",
		);
		expect(badgeCalls()).toBe(base + 1);
	});

	it("P6-1-4 守恒：挂壳态下三入口各恰 +1（禁双刷；现状绿、迁移后仍须绿）", async () => {
		await registerAll();
		stubSidePanels();
		await showBook();
		// 装载完成自证：状态条书格已由 show 收尾写入，聊天装载请求已发出
		expect(byId("writing-status-book").textContent).toBe(`《${BOOK_TITLE}》`);
		expect(apiCalls.some((c) => c.path === `/api/books/${BOOK_ID}/chat`)).toBe(
			true,
		);
		let base = badgeCalls();
		await act(async () => {
			await chapterEditorApi().selectChapter(CHAPTER_ID);
		});
		expect(badgeCalls()).toBe(base + 1);
		expect(byId("writing-status-chapter").textContent).toBe("《第一章 起点》");
		base = badgeCalls();
		await act(async () => {
			await chapterEditorApi().saveChapter(true);
		});
		expect(badgeCalls()).toBe(base + 1);
		expect(byId("writing-status-save").textContent).toBe("已保存");
		base = badgeCalls();
		await act(async () => {
			await chatApi().loadChat();
		});
		expect(badgeCalls()).toBe(base + 1);
	});

	it("P6-1-5 退役见证：show 前后三入口引用逐名同一（壳不再改写 BookPage 方法）", async () => {
		await registerAll();
		stubSidePanels();
		const before = {
			saveChapter: chapterEditorApi().saveChapter,
			selectChapter: chapterEditorApi().selectChapter,
			loadChat: chatApi().loadChat,
		};
		await showBook();
		expect(chapterEditorApi().saveChapter).toBe(before.saveChapter);
		expect(chapterEditorApi().selectChapter).toBe(before.selectChapter);
		expect(chatApi().loadChat).toBe(before.loadChat);
		// P6-2 转写：壳不再改写 window.BookPage 任何名（桩退净面）——「壳面仍在位」改为
		// 「首次 mount 已把 renderWritingStatus 注册进 lib 渲染缝」的等价见证
		// （原断言：typeof chapterEditorApi().renderWritingStatus === "function"）
		expect(renderWritingStatusIfBound()).toBe(true);
	});

	it("P6-1-6 源码见证：BookShell.jsx 无 wrapStatusRefresh；renderWritingStatus／withWritingStatusRefresh 两导出在位", () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, "frontend", "pages", "BookShell.jsx"),
			"utf8",
		);
		expect(src.includes("wrapStatusRefresh")).toBe(false);
		expect(src.includes("export function renderWritingStatus")).toBe(true);
		expect(src.includes("export function withWritingStatusRefresh")).toBe(true);
	});
});
