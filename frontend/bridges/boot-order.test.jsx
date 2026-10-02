// @vitest-environment jsdom
// T6（P6-2 Plan §4-T6）模块装载序契约：
//   ① 源 `frontend/index.html` 零内联段（唯一 script＝Vite entry 声明 `/entry.jsx`；产物面 script 由 Vite 注入）；
//   ② `frontend/entry.jsx` 源码序＝取得 App 单例 → `runStatus.observeApi()`/运行时初始化 → 自挂载件 → `createRoot`；
//   ③ 导入 `entry.jsx` 模块图（jsdom 壳）后：App 单例可用、`#toast` 文案路径可用、
//      编辑器 8 名与聊天 11 名命令面齐备（T3 的端到端版）。
//
// 红态成因（HEAD `1d8e0af`）：entry.jsx 序为 `registerLegacyBridges()/registerAppBridges()`；
// index.html 三段内联在盘；`getApp`／`bindChatEvents` 未落地。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);
const ENTRY = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "entry.jsx"),
	"utf8",
);
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;

const CHAT_API_NAMES = [
	"openAgentDiscussion",
	"setStatusPollingVisible",
	"refreshRunStatus",
	"renderRunCard",
	"loadChat",
	"loadWorld",
	"loadCharacters",
	"bindChatEvents",
	"currentWritingConversationId",
	"renderActionCard",
	"renderToolEvent",
];
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
	const appRoot = '<div id="app-root"></div>';
	const book = STATIC_DOC.getElementById("page-book").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${appRoot}${book}${modal}${toast}`;
}

function cleanup() {
	document.body.innerHTML = "";
	delete window.App;
	delete window.BookPage;
	delete window.MozhenApp;
	delete window.MozhenBookChat;
	delete window.MozhenChapterEditor;
	delete window.MozhenBookShell;
	delete window.MozhenBookOutline;
	delete window.MozhenStateBook;
	delete window.MozhenSidebarConfig;
	delete window.MozhenShelf;
	delete window.MozhenSettings;
	delete window.StyleHealth;
	delete window.ChapterConflict;
	delete window.ChatEventHub;
	delete window.RunStatus;
	delete globalThis.fetch;
}

beforeEach(() => {
	cleanup();
	document.body.innerHTML = buildShellHtml();
	localStorage.clear();
	sessionStorage.clear();
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		headers: { get: () => "application/json" },
		json: async () => ({}),
		body: null,
	});
	window.App = {
		state: { currentBook: null, currentChapterId: null, currentVolumeId: null },
		async api() {
			return {};
		},
		toast() {},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
});

afterEach(cleanup);

describe("T6 模块装载序契约（桥/桩退役后的唯一样式）", () => {
	it("T6-1 源 frontend/index.html 零内联段：唯一 script＝Vite entry 声明 /entry.jsx（P6-3 转写）", () => {
		const tags = INDEX_HTML.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		const inline = tags.filter(
			(t) =>
				t
					.replace(/^<script\b[^>]*>/, "")
					.replace(/<\/script>$/, "")
					.trim() !== "",
		);
		expect(inline.length).toBe(0);
		expect(tags.length).toBe(1);
		expect(tags[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
	});

	it("T6-2 entry.jsx 源码序：取得运行时（含 observeApi）→ 自挂载件 → createRoot", () => {
		const iCreate = ENTRY.indexOf("createRoot(");
		expect(iCreate).toBeGreaterThan(-1);
		// 运行时初始化入口＝initFrontendRuntime（⑨ 切换笔形态：桥/桩退役后唯一初始化函数，
		// 调用点必须在 createRoot 之前）。HEAD 上仍是 registerLegacyBridges/registerAppBridges
		// ⇒ 本条为真红（非「必然绿」），切换笔转绿。
		const iInit = ENTRY.indexOf("initFrontendRuntime(");
		expect(
			iInit,
			"entry.jsx 未调 initFrontendRuntime（⑨ 切换笔尚未落地）",
		).toBeGreaterThan(-1);
		expect(iInit).toBeLessThan(iCreate);
		// 自挂载件与 observeApi 必须在 createRoot 之前（模块执行序承接 legacy 加载期副作用）
		const bridge = fs.readFileSync(
			path.join(REPO_ROOT, "frontend", "bridges", "legacy-bridge.jsx"),
			"utf8",
		);
		const iObserve = bridge.indexOf("observeApi()");
		const iMountChat = bridge.indexOf("mountChatJumpBottom()");
		expect(iObserve).toBeGreaterThan(-1);
		expect(iMountChat).toBeGreaterThan(-1);
		// 运行时初始化体在 bridges 侧导出（⑨ 笔：legacy-bridge.jsx 重构为纯初始化函数）
		expect(bridge).toMatch(/export function initFrontendRuntime/);
		// 运行时初始化内部：observeApi 早于自挂载件（等值 legacy 装载期一次猴补）
		expect(iObserve).toBeLessThan(iMountChat);
	});

	it("T6-3 模块图见证：导入 entry.jsx 后 App 单例/命令面/提示路径齐备，且零窗口名", async () => {
		vi.resetModules();
		const runtime = await import("../lib/app-runtime.js");
		const editor = await import("../components/ChapterEditorPanel.jsx");
		const chat = await import("../components/ChatWorkspace.jsx");
		await import("../entry.jsx");
		// App 单例（与 entry 同一模块图）
		const app = runtime.getApp();
		expect(app).toBeTruthy();
		for (const m of ["api", "toast", "escapeHtml", "openModal", "closeModal"])
			expect(typeof app[m], m).toBe("function");
		// #toast 文案路径可用（等值 App.toast）
		app.toast("装载序见证");
		expect(document.getElementById("toast").textContent).toBe("装载序见证");
		// 编辑器 8 名与聊天 11 名命令面齐备
		for (const n of EDITOR_METHODS)
			expect(typeof editor.chapterEditorApi()[n], `editor.${n}`).toBe(
				"function",
			);
		expect(typeof chat.chatApi()).toBe("object");
		for (const n of CHAT_API_NAMES)
			expect(typeof chat.chatApi()[n], `chat.${n}`).toBe("function");
		expect(typeof chat.bindChatEvents).toBe("function");
		// 零窗口名（入口装载后也不得回填）
		expect(window.BookPage).toBe(undefined);
		expect(window.MozhenChapterEditor).toBe(undefined);
		expect(window.MozhenBookChat).toBe(undefined);
	});
});
