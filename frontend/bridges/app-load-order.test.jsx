// @vitest-environment jsdom
// S5-3 红测 R5（Plan §4；P6-2 ⑨ 切换笔转写）：加载序与 App 供给契约端到端——
// ①（转写后）App 由 `lib/app-runtime.js` 模块单例供给：`getApp()` 五方法＋state 三字段；
//    index.html 三段内联承接桩（App 供给段／编辑器 bootstrap／聊天桩段）**零残留**；
// ② 装载序唯一样式＝模块序（`entry.jsx`：initFrontendRuntime → … → createRoot；boot-order T6 同钉）；
// ③ 六旧标签（app.js／book.js／book-chat.js／agent.js／run-status.js／segment-targets.js）引用零命中；
// ④ 端到端模块图：import entry.jsx 后 App 单例五方法、编辑器 8 名、聊天 11 名齐备；旧名面零命中；
// ⑤ `runStatus.observeApi()` 猴补语义：包装后 `getApp().api` 直达 fetch（arguments 原样）、幂等。
// 原 R5-1/R5-2（App 供给段文本与下标）与 R5-4（eval 全部经典脚本）的对象随内联段删除消失 ⇒
// 按 Plan §2.4 T-A1~T-A4 机械转写（语义升级为「同一模块单例」），零放宽。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApp, setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);
const ENTRY = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "entry.jsx"),
	"utf8",
);

const APP_METHODS = ["api", "toast", "escapeHtml", "openModal", "closeModal"];
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

function htmlScripts() {
	return INDEX_HTML.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
}

beforeEach(() => {
	// 模块图见证用真实文件 doc 壳（App.toast 需要 #toast；openModal 需要 #modal-mask）
	document.body.innerHTML = new JSDOM(
		INDEX_HTML,
	).window.document.body.innerHTML;
});

afterEach(() => {
	setAppForTests(null);
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("app-load-order（R5 装载序与 App 供给契约；P6-2 ⑨ 转写）", () => {
	it("R5-1 App 模块面：getApp() 五方法齐备＋state 三字段；window.App 零命中（旧名面整体退役）", () => {
		const app = getApp();
		for (const n of APP_METHODS)
			expect(typeof app[n], `getApp().${n}`).toBe("function");
		expect(app.state).toEqual({
			currentBook: null,
			currentChapterId: null,
			currentVolumeId: null,
		});
		expect(getApp()).toBe(app); // 单例
		// 反向见证：index.html 与全局面皆无 window.App（原「App 供给段：window.App = 恰 1 处」的等价物）
		const code = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");
		expect(code.match(/window\.App\b/g) || []).toHaveLength(0);
		expect(window.App).toBe(undefined);
	});

	it("R5-2 源 index.html 零内联段：唯一 script＝Vite entry 声明 /entry.jsx（P6-3 转写）；三段承接桩（App／bootstrap／聊天）零残留", () => {
		const scripts = htmlScripts();
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/type\s*=\s*["']module["']/);
		// P6-3 转写（charter §2 豁免流程；机械转写·语义等价·逐条留案）：断言对象由「产物路径手工标签」
		// 改为「Vite entry 声明」——产物面「/app/entry.js 恰 1 且由 Vite 注入」由构建门禁见证（Plan §8④）。
		expect(scripts[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
		expect(
			scripts[0]
				.replace(/<script\b[^>]*>/, "")
				.replace(/<\/script>$/, "")
				.trim(),
		).toBe("");
		const code = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");
		for (const anchor of [
			"window.App =",
			"window.BookPage",
			"window.MozhenApp",
			"window.MozhenChapterEditor",
			"window.MozhenBookChat",
		])
			expect(code, anchor).not.toContain(anchor);
	});

	it("R5-3 六旧标签退役：引用零命中；承接面改模块导出（entry/AppRouter/编辑器/聊天）", () => {
		for (const tag of [
			"legacy/app.js",
			"legacy/book.js",
			"legacy/book-chat.js",
			"legacy/agent.js",
			"legacy/run-status.js",
			"legacy/segment-targets.js",
		])
			expect(
				INDEX_HTML.match(new RegExp(tag.replace(".", "\\."), "g")) || [],
				tag,
			).toHaveLength(0);
		// 承接面（原「相邻件仍在：window.MozhenChapterEditor」的模块等价物）
		expect(ENTRY).toContain('from "./bridges/legacy-bridge.jsx"');
		expect(ENTRY).toContain("initFrontendRuntime(");
	});

	it("R5-4 模块装载序端到端：import entry.jsx → App 单例五方法；编辑器 8 名＋聊天 11 名齐备；旧名面零命中", async () => {
		vi.resetModules();
		const dom = new JSDOM(INDEX_HTML, {
			url: "http://localhost/",
			runScripts: "outside-only",
			pretendToBeVisual: true,
		});
		// 模块图装载（等值旧「按序 eval 全部经典脚本」；classic 段已全删 ⇒ 逐段 eval 集合为空）
		const scripts = Array.from(dom.window.document.querySelectorAll("script"));
		expect(scripts.filter((s) => s.getAttribute("type") !== "module")).toEqual(
			[],
		);
		const [runtime, editor, chat, entry] = await Promise.all([
			import("../lib/app-runtime.js"),
			import("../components/ChapterEditorPanel.jsx"),
			import("../components/ChatWorkspace.jsx"),
			import("../entry.jsx"),
		]);
		expect(entry).toBeTruthy();
		const app = runtime.getApp();
		for (const n of APP_METHODS)
			expect(typeof app[n], `App.${n}`).toBe("function");
		expect(app.state).toEqual({
			currentBook: null,
			currentChapterId: null,
			currentVolumeId: null,
		});
		for (const n of EDITOR_METHODS)
			expect(typeof editor.chapterEditorApi()[n], `editor.${n}`).toBe(
				"function",
			);
		expect(typeof chat.chatApi()).toBe("object");
		for (const n of CHAT_API_NAMES)
			expect(typeof chat.chatApi()[n], `chat.${n}`).toBe("function");
		expect(typeof chat.bindChatEvents).toBe("function");
		// 旧名面零命中（原「BookPage 8 名＋聊天 11 名经桩段供给」的退役见证）
		expect(window.App).toBe(undefined);
		expect(window.BookPage).toBe(undefined);
		expect(window.MozhenChapterEditor).toBe(undefined);
		expect(window.MozhenBookChat).toBe(undefined);
	});

	describe("R5-5 运行时单例与 observeApi 猴补（模拟 entry：initFrontendRuntime 单例链）", () => {
		let fetchCalls;
		let originalFetch;

		beforeEach(() => {
			fetchCalls = [];
			originalFetch = globalThis.fetch;
			globalThis.fetch = async (...a) => {
				fetchCalls.push(a);
				return {
					ok: true,
					status: 200,
					headers: { get: () => "application/json" },
					json: async () => ({ ok: true }),
				};
			};
			// 冷单例：置空后惰建（等值旧「eval App 供给段建 window.App」）
			setAppForTests(null);
			runStatus.observeApi();
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it("getApp().api 经 observeApi 包装后直达 fetch 层（arguments 原样）；二次 observeApi 幂等", async () => {
			const r = await getApp().api("GET", "/api/x", { a: 1 });
			expect(r).toEqual({ ok: true });
			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0][0]).toBe("/api/x");
			expect(JSON.parse(fetchCalls[0][1].body)).toEqual({ a: 1 });
			// 幂等：flag 已置 ⇒ 第二次不重复包装
			const wrapped = getApp().api;
			runStatus.observeApi();
			expect(getApp().api).toBe(wrapped);
			await getApp().api("GET", "/api/y");
			expect(fetchCalls).toHaveLength(2);
		});

		it("单例五方法齐备；未挂载面编辑器/聊天面为占位面且旧名零命中（C16 兼容）", () => {
			for (const n of APP_METHODS)
				expect(typeof getApp()[n], `App.${n}`).toBe("function");
			// 原「未 mount 前不得给 window.BookPage 加盖壳面」的模块等价物：旧名面不存在，
			// 编辑器面为 NULL 占位面（8 名恒在、无壳面方法）
			expect(window.BookPage).toBe(undefined);
			expect(window.MozhenBookShell).toBe(undefined);
		});

		it("state 引用复用：两次 getApp() 同一对象且 state 同一引用（禁重建）", () => {
			const first = getApp();
			const second = getApp();
			expect(second).toBe(first);
			expect(second.state).toBe(first.state);
		});
	});
});
