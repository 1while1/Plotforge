// @vitest-environment jsdom
// S5-3 红测 R8/R9（Plan §4）：BookShell 写作页壳等值——
// 锚点 public/legacy/book.js:171-205 show 编排序、:71-83 renderWritingStatus、
// :153-163 wrapStatusRefresh 包装链（P6-1 已随 S5-10-X1(b) 退役：刷新职责内化到 React 入口
// api 边界，见 frontend/pages/writing-status-refresh.test.jsx）、
// :86-118 返回锚、:26-42 布局、:120-150 bind 家族、:168 加载期副作用；
// 以及壳方法最小注册（首次 mount）与「未 mount 前不得加盖壳面」（C16 同构）。
// harness：jsdom ＋ React 19 act ＋ 裸 DOM；#page-book/#page-agent 静态壳从 frontend/index.html
// 真实文本提取；BookPage 8 桩从 index.html 的 S5-2 bootstrap 段真实提取再 eval。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import {
	bindEditorDirtyProvider,
	bindWritingStatusRenderer,
	renderWritingStatusIfBound,
} from "../lib/writing-status.js";
import {
	applyLeftPanelLayout,
	bindShellEvents,
	clearWritingReturn,
	mount as mountBookShell,
	readWritingReturn,
	renderWritingStatus,
	resetInstalledForTests,
	restoreWritingReturn,
	saveWritingReturn,
	toggleLeftPanel,
} from "./BookShell.jsx";

// P6-2 转写（Plan §2.4／§2.5 D2/D5/D8）：壳对四面板/聊天面/编辑器面的取用已由 window 名改为
// 模块导入，故 window 桩面 → `vi.mock` 记录面（断言逐条等值、零放宽）；App 注入改走
// `setAppForTests`；「RunStatus 分支」与「状态条渲染缝注册」两处在位性改以模块面见证。
const rec = vi.hoisted(() => ({
	seq: [],
	editor: null,
	chat: null,
	outline: null,
	stateBook: null,
	sidebar: null,
}));
vi.mock("../components/ChapterEditorPanel.jsx", () => ({
	chapterEditorApi: () => rec.editor,
	mountChapterEditor: () => null,
}));
vi.mock("../components/ChatWorkspace.jsx", () => ({
	bindChatEvents: () => rec.seq.push("bindChatEvents"),
	chatApi: () => rec.chat,
}));
vi.mock("../components/BookOutlinePanel.jsx", () => ({
	bindEvents: () => rec.outline.bindEvents(),
	load: () => rec.outline.load(),
}));
vi.mock("../components/StateBookPanel.jsx", () => ({
	bindEvents: () => rec.stateBook.bindEvents(),
	load: () => rec.stateBook.load(),
}));
vi.mock("../components/SidebarConfigDialog.jsx", () => ({
	bind: () => rec.sidebar.bind(),
	load: () => rec.sidebar.load(),
}));

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

function buildShellHtml() {
	const book = STATIC_DOC.getElementById("page-book").outerHTML;
	const agent = STATIC_DOC.getElementById("page-agent").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${book}${agent}${modal}${toast}`;
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
let seq;
let toasts;
let dirty;
let editor;
let runStatusBadgeCalls;
let runStatusBadgeSpy;
let outline;
let stateBook;
let sidebar;
let bookPayload;

function installEnv() {
	apiCalls = [];
	seq = [];
	toasts = [];
	dirty = false;
	runStatusBadgeCalls = 0;
	bookPayload = { book: { id: "B1", title: "测试之书" } };
	window.App = {
		state: { currentBook: null, currentChapterId: null, currentVolumeId: null },
		api: async (method, url, body) => {
			apiCalls.push({ method, path: url, body });
			if (method === "GET" && url === "/api/books/B1") return bookPayload;
			return {};
		},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
	// 每测＝一次「页加载」：壳安装幂等键（P6-2 已改模块级 `installed`，§2.5-D8）与两条 lib 缝
	//（渲染器/脏标记供给）逐测复位——否则前一测 mount 注册的渲染缝会残留（同文档跨测污染）。
	// P6-2（⑨ 切换笔）：index.html 三段内联承接桩退役 ⇒ bootstrap 提取＋eval 与 `window.BookPage`
	// 桩面一并退役；编辑器/聊天面改模块导入（上方 `vi.mock` 装配点 rec.editor/rec.chat）。
	resetInstalledForTests();
	bindWritingStatusRenderer(null);
	bindEditorDirtyProvider(() => dirty);
	setAppForTests(window.App);
	editor = {
		loadChapters: vi.fn(async () => {
			seq.push("loadChapters");
		}),
		selectChapter: vi.fn(async (id) => {
			seq.push(`selectChapter:${id}`);
		}),
		saveChapter: vi.fn(async () => {
			seq.push("saveChapter");
			return true;
		}),
		_doSaveChapter: vi.fn(async () => true),
		hasUnsavedChanges: vi.fn(() => dirty),
		clearUnsaved: vi.fn(),
		leaveGuard: vi.fn(async () => true),
		bindChapterEvents: vi.fn(() => {
			seq.push("bindChapterEvents");
		}),
	};
	outline = {
		bindEvents: vi.fn(() => {
			seq.push("outline.bindEvents");
		}),
		load: vi.fn(() => {
			seq.push("outline.load");
		}),
	};
	stateBook = {
		bindEvents: vi.fn(() => {
			seq.push("stateBook.bindEvents");
		}),
		load: vi.fn(() => {
			seq.push("stateBook.load");
		}),
	};
	sidebar = {
		bind: vi.fn(() => {
			seq.push("sidebar.bind");
		}),
		load: vi.fn(async () => {
			seq.push("sidebar.load");
		}),
	};
	// P6-2：四面板/聊天面改由模块导入取用（壳内 import 直取），window 名不再被壳读取——
	// 本 harness 把四个记录面挂到 mock 装配点（rec.*），window 名保留仅供 bootstrap 桩自身使用。
	rec.seq = seq;
	rec.editor = editor;
	rec.chat = {
		loadWorld: async () => {
			seq.push("loadWorld");
		},
		loadCharacters: async () => {
			seq.push("loadCharacters");
		},
		loadChat: async () => {
			seq.push("loadChat");
		},
	};
	rec.outline = outline;
	rec.stateBook = stateBook;
	rec.sidebar = sidebar;
	// P6-2 转写：window.RunStatus 桩 → `runStatus` 真模块的 spy（旧桩的「正底」文案/计数/序证据逐条保留；
	// afterEach 的 restoreAllMocks 复原真实现）
	runStatusBadgeSpy = vi
		.spyOn(runStatus, "renderWritingSaveBadge")
		.mockImplementation(() => {
			runStatusBadgeCalls += 1;
			byId("writing-status-save").textContent = "RunStatus 正底";
			seq.push("renderWritingSaveBadge");
		});
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = buildShellHtml();
	sessionStorage.clear();
	localStorage.clear();
	document.querySelector("section.panel-editor").classList.add("hidden");
	byId("editor-empty").classList.remove("hidden");
	installEnv();
});

afterEach(() => {
	// P6-2：单例注入与两条 lib 缝（渲染器/脏标记）逐测解绑，防跨测残留
	setAppForTests(null);
	bindWritingStatusRenderer(null);
	bindEditorDirtyProvider(null);
	resetInstalledForTests();
	vi.restoreAllMocks();
});

async function showBook(bookId = "B1") {
	await act(async () => {
		mountBookShell(bookId);
		await sleep(10);
	});
	await waitFor(() => apiCalls.length > 0 && seq.includes("loadChat"));
	await act(async () => {
		await sleep(20);
	});
}

describe("BookShell（legacy book.js:171-205 ＋ 壳面）", () => {
	it("R8-1 show 编排序：state 复位→editor 显隐→GET→#book-title→bind 家族→Promise.all→壳后置（:171-205）", async () => {
		await showBook();
		expect(apiCalls[0]).toEqual({ method: "GET", path: "/api/books/B1" });
		expect(window.App.state.currentBook).toEqual(bookPayload.book);
		expect(byId("book-title").textContent).toBe("测试之书");
		// 进入即复位到空态（:176-177 逐字）：壳只负责落回空态，editor-body 的显示由编辑器
		// （S5-2 面）在选章后接管——本 harness 的章节桩不选章，故 stay hidden
		expect(byId("editor-body").classList.contains("hidden")).toBe(true);
		expect(byId("editor-empty").classList.contains("hidden")).toBe(false);
		const iBindChapter = seq.indexOf("bindChapterEvents");
		expect(seq.indexOf("bindChatEvents")).toBe(iBindChapter + 1);
		expect(seq.indexOf("outline.bindEvents")).toBeGreaterThan(iBindChapter);
		expect(seq.indexOf("stateBook.bindEvents")).toBeGreaterThan(iBindChapter);
		expect(seq.indexOf("sidebar.bind")).toBeGreaterThan(iBindChapter);
		expect(seq.indexOf("outline.load")).toBeGreaterThan(iBindChapter);
		expect(seq.indexOf("stateBook.load")).toBeGreaterThan(iBindChapter);
		// Promise.all 五项全部被调
		for (const name of [
			"loadChapters",
			"loadWorld",
			"loadCharacters",
			"loadChat",
			"sidebar.load",
		]) {
			expect(seq, name).toContain(name);
		}
		// 壳后置阶段：布局/状态条/返回锚（bindStatusInputs 以 statusBound 证据）
		expect(byId("chapter-content").dataset.statusBound).toBe("1");
		expect(byId("chapter-title-input").dataset.statusBound).toBe("1");
		expect(byId("chapter-beat").dataset.statusBound).toBe("1");
		expect(window.App.state.currentChapterId).toBe(null);
	});

	it("R8-2 状态条四格：书/章/会话；RunStatus 分支优先且不覆盖 #writing-status-save（:71-83）", async () => {
		byId("writing-status-save").textContent = "外部写";
		await showBook();
		expect(byId("writing-status-book").textContent).toBe("《测试之书》");
		expect(byId("writing-status-chapter").textContent).toBe("未选择章节");
		expect(byId("writing-status-conversation").textContent).toBe(
			"（默认：历史对话）",
		);
		expect(runStatusBadgeCalls).toBeGreaterThanOrEqual(1);
		// RunStatus 分支命中后立即 return：壳不再写 已保存/未保存修改，
		// 该格文本停在 RunStatus 自己写的标记上（若走了回退分支会被覆盖）
		expect(byId("writing-status-save").textContent).toBe("RunStatus 正底");
		// 章名来源：#chapter-title-input.value → 《标题》；无值 → 章节 #id
		window.App.state.currentChapterId = 7;
		byId("chapter-title-input").value = "起点";
		renderWritingStatus();
		expect(byId("writing-status-chapter").textContent).toBe("《起点》");
		byId("chapter-title-input").value = "";
		renderWritingStatus();
		expect(byId("writing-status-chapter").textContent).toBe("章节 #7");
		// 会话名：select 选中项
		const sel = byId("writing-conversation-select");
		sel.innerHTML = '<option value="c2" selected>第二会话</option>';
		renderWritingStatus();
		expect(byId("writing-status-conversation").textContent).toBe("第二会话");
	});

	it("R8-3 无 RunStatus 徽标时脏态文案两态（:81-82）", async () => {
		// P6-2 转写：旧 `delete window.RunStatus` → 置空模块直取对象的该名；壳判据
		// `if (runStatus && runStatus.renderWritingSaveBadge)` 逐字未变，脏态经 lib 供给缝读编辑器桩
		runStatus.renderWritingSaveBadge = undefined;
		await showBook();
		expect(byId("writing-status-save").textContent).toBe("已保存");
		dirty = true;
		renderWritingStatus();
		expect(byId("writing-status-save").textContent).toBe("未保存修改");
	});

	it("R8-4 壳零改写（P6-1 转写）：show 前后三入口引用逐名同一；名义调用经桥直通实现（刷新供给已移出壳）", async () => {
		const before = {
			saveChapter: editor.saveChapter,
			selectChapter: editor.selectChapter,
			loadChat: rec.chat.loadChat,
		};
		await showBook();
		// ①壳不再替换三方法引用（旧断言＝链包装后各刷 1 次）。
		// 「刷新恰 1 次」的数量约束由 writing-status-refresh.test.jsx P6-1-4 承接。
		expect(editor.saveChapter).toBe(before.saveChapter);
		expect(editor.selectChapter).toBe(before.selectChapter);
		expect(rec.chat.loadChat).toBe(before.loadChat);
		// ②名义入口仍直通实现（桥薄透传）
		await act(async () => {
			await editor.saveChapter();
			await editor.selectChapter(12);
			await rec.chat.loadChat();
		});
		expect(editor.saveChapter).toHaveBeenCalledTimes(1);
		expect(editor.selectChapter).toHaveBeenCalledWith(12);
		expect(typeof rec.chat.loadChat).toBe("function");
	});

	it("R8-5 二次 show 幂等（P6-1 转写）：三方法引用仍逐名同一（壳零改写）；同一调用实现恰 1 次", async () => {
		const stubs = {
			saveChapter: editor.saveChapter,
			selectChapter: editor.selectChapter,
			loadChat: rec.chat.loadChat,
		};
		await showBook();
		await showBook();
		// 幂等由「引用自始至终未被改写」承接（旧断言＝不二次包装／单层包装）
		expect(editor.saveChapter).toBe(stubs.saveChapter);
		expect(editor.selectChapter).toBe(stubs.selectChapter);
		expect(rec.chat.loadChat).toBe(stubs.loadChat);
		await act(async () => {
			await editor.saveChapter();
		});
		expect(editor.saveChapter).toHaveBeenCalledTimes(1); // 零包装 ⇒ 实现恰一次
	});

	it("R8-6 返回锚：save/read/clear 三件＋链接显隐/href；restore 同书才消费（:86-118）", async () => {
		await showBook();
		// 锚用真实语义的数值型 bookId（legacy :113 是 Number(t.bookId) !== Number(bookId)，
		// 非数值 id 恒 NaN 不等 ⇒ 恒不消费；路由传入的是 hash 里的数字串）
		saveWritingReturn({ bookId: "7", chapterId: 12 });
		const raw = JSON.parse(sessionStorage.getItem("novel-writing-return"));
		expect(raw).toEqual({ bookId: "7", chapterId: 12 });
		expect(byId("agent-return-writing").classList.contains("hidden")).toBe(
			false,
		);
		expect(byId("agent-return-writing").getAttribute("href")).toBe("#/book/7");
		expect(readWritingReturn()).toEqual({
			bookId: "7",
			chapterId: 12,
		});
		// 换书不消费
		expect(await restoreWritingReturn("8")).toBe(false);
		expect(sessionStorage.getItem("novel-writing-return")).not.toBe(null);
		// 同书消费 + selectChapter + 清除
		expect(await restoreWritingReturn("7")).toBe(true);
		expect(editor.selectChapter).toHaveBeenCalledWith(12);
		expect(sessionStorage.getItem("novel-writing-return")).toBe(null);
		expect(byId("agent-return-writing").classList.contains("hidden")).toBe(
			true,
		);
		clearWritingReturn();
	});

	it("R8-7 布局：按书记忆、left-collapsed 类/按钮文案/aria/mode-on；toggle 读 currentBook（:18-42）", async () => {
		localStorage.setItem("writing_layout_v1:B1", "collapsed");
		await showBook();
		expect(byId("book-workbench").classList.contains("left-collapsed")).toBe(
			true,
		);
		expect(byId("btn-toggle-left-panel").textContent).toBe("展开侧栏");
		expect(byId("btn-toggle-left-panel").getAttribute("aria-expanded")).toBe(
			"false",
		);
		expect(byId("btn-toggle-left-panel").classList.contains("mode-on")).toBe(
			true,
		);
		// toggle：collapsed → full
		await act(async () => {
			toggleLeftPanel();
			await sleep(5);
		});
		expect(localStorage.getItem("writing_layout_v1:B1")).toBe("full");
		expect(byId("btn-toggle-left-panel").textContent).toBe("收起侧栏");
		expect(byId("btn-toggle-left-panel").getAttribute("aria-expanded")).toBe(
			"true",
		);
		// 另一本书无记录 → 默认展开
		window.App.state.currentBook = { id: "B2", title: "另一本" };
		applyLeftPanelLayout(
			localStorage.getItem("writing_layout_v1:B2") === "collapsed",
		);
		expect(byId("book-workbench").classList.contains("left-collapsed")).toBe(
			false,
		);
	});

	it("R8-8 bindShellEvents 幂等与两按钮行为：开书后点击左栏按钮切换；返回锚拦截跳转（:120-137）", async () => {
		await showBook();
		const btn = byId("btn-toggle-left-panel");
		expect(btn.dataset.shellBound).toBe("1");
		localStorage.setItem("writing_layout_v1:B1", "full");
		await act(async () => {
			btn.click();
			await sleep(5);
		});
		expect(localStorage.getItem("writing_layout_v1:B1")).toBe("collapsed");
		// 幂等：再调 bindShellEvents 不改变绑定（点击仍只切一次）
		bindShellEvents();
		expect(btn.dataset.shellBound).toBe("1");
		// 返回锚：有锚时拦截并跳 #/book/B1
		saveWritingReturn({ bookId: "B1", chapterId: 12 });
		await act(async () => {
			byId("agent-return-writing").click();
			await sleep(5);
		});
		expect(window.location.hash).toBe("#/book/B1");
	});

	it("R8-9 bindStatusInputs 顺序：脏监听先跑、状态条后读新脏值（:139-150）", async () => {
		// 模拟 book-chapters 的脏检查监听在加载期先注册（早于 mount）
		let sawDirtyWhenRendered = null;
		byId("chapter-content").addEventListener("input", () => {
			dirty = true;
		});
		await showBook();
		// P6-2 转写：壳内部直接调模块本地 renderWritingStatus，覆写 window.MozhenBookShell 名拦不住；
		// 观察点改到该渲染必然经过的 runStatus.renderWritingSaveBadge（同一渲染时点、同一脏源）
		runStatusBadgeSpy.mockImplementation(() => {
			runStatusBadgeCalls += 1;
			sawDirtyWhenRendered = dirty;
		});
		await act(async () => {
			byId("chapter-content").dispatchEvent(
				new window.Event("input", { bubbles: true }),
			);
			await sleep(10);
		});
		expect(runStatusBadgeSpy).toHaveBeenCalled();
		expect(sawDirtyWhenRendered).toBe(true);
	});

	it("R8-10 壳方法注册：状态条渲染缝首次 mount 注册；window 名面恒零写入（C16 同构）", async () => {
		// 未 mount（initFrontendRuntime 后；harness 直调模块初始化面）
		// P6-2（⑨）：旧「window.BookPage.X === undefined」逐条 → 「window.BookPage 整个旧名退役」
		expect(renderWritingStatusIfBound()).toBe(false);
		await showBook();
		expect(renderWritingStatusIfBound()).toBe(true);
		// P6-2 收尾（笔⑤）：返回锚写入读点已改 `use-chat-workspace.js` 直取 BookShell 导出
		// ⇒ `BookPage.saveWritingReturn` 旧注册点退役，mount 前后两名面恒零写入
		//（旧断言＝mount 后 typeof 为 function）。原「经 BookPage 动态委托命中」语义**收窄合并**：
		// 中介对象消失，去向＝①本行零写入见证 ②真实副作用由 ChatWorkspace.test.jsx T5-5/T5-11 的
		// `savedReturn`（sessionStorage `novel-writing-return`）逐字见证
		// 桥面退役后写入落到同一底层存储（模块导出名义入口仍可消费）
		saveWritingReturn({ bookId: "B1", chapterId: 3 });
		expect(
			JSON.parse(sessionStorage.getItem("novel-writing-return")).chapterId,
		).toBe(3);
		// P6-2（⑨）反向见证：旧名面整体零命中（动态版；静态版由 zero-global.test.js T1 承担）
		expect(window.BookPage).toBe(undefined);
	});

	it("R8-11 折叠侧栏不打断流（S5-7-X2 等价承接）：toggle 前后 #chat-messages 节点同一；loadChat 零调用；apiCalls 零增量", async () => {
		// 等值承接 test/writing-workspace-state.test.js 退役三条断言（S5-7-X2①）：
		// 壳 toggleLeftPanel 只切 #book-workbench 类，不重挂/不重渲聊天容器、零重拉会话、零重读接口。
		// rec.chat.loadChat 为纯函数桩（seq 记录面）⇒「loadChat 零调用」以 seq 计数见证。
		await showBook();
		const before = {
			node: document.getElementById("chat-messages"),
			loadChat: seq.filter((s) => s === "loadChat").length,
			apiCalls: apiCalls.length,
		};
		expect(before.node).toBeTruthy();
		await act(async () => {
			toggleLeftPanel();
			await sleep(5);
		});
		// ①节点引用同一（不重挂/不重渲容器）
		expect(document.getElementById("chat-messages")).toBe(before.node);
		// ②零重拉会话 ③零重读任何接口
		expect(seq.filter((s) => s === "loadChat").length).toBe(before.loadChat);
		expect(apiCalls.length).toBe(before.apiCalls);
	});

	it("R9-1 与 S5-2 面互不破坏（P6-1 转写）：mount 前后 8 名引用逐名不变（零包装）；经桥仍可达实现", async () => {
		const stubs = {};
		const eight = [
			"loadChapters",
			"selectChapter",
			"saveChapter",
			"_doSaveChapter",
			"hasUnsavedChanges",
			"clearUnsaved",
			"leaveGuard",
			"bindChapterEvents",
		];
		for (const n of eight) {
			stubs[n] = editor[n];
		}
		// mount 前：壳面零定义（C16 同构）＋旧名面零命中（P6-2 ⑨）
		expect(window.BookPage).toBe(undefined);
		await showBook();
		// 8 名全部逐名不变（旧断言＝6 名不变、三方法被包装链接管；壳对编辑器面零改写）
		for (const n of eight) {
			expect(editor[n], n).toBe(stubs[n]);
		}
		// 经桥仍可达实现
		await act(async () => {
			await editor.saveChapter();
		});
		expect(editor.saveChapter).toHaveBeenCalled();
		expect(window.BookPage).toBe(undefined); // 壳调用不经 BookPage.show
	});

	it("R9-2 旧标签与旧名段退役（P6-3 转写）：源 index.html 中 legacy/app.js 与 legacy/book.js 零命中；三段内联承接桩清零（唯一 script＝Vite entry 声明 /entry.jsx）；名单内 window.* 零命中", () => {
		const html = fs.readFileSync(
			path.join(REPO_ROOT, "frontend", "index.html"),
			"utf8",
		);
		expect(html.match(/legacy\/app\.js/g) || []).toHaveLength(0);
		expect(html.match(/legacy\/book\.js/g) || []).toHaveLength(0);
		// P6-2（⑨）：旧「App 供给段在位＋BookPage 桩段在位」→ 零内联段＋名单内 window.* 零命中
		const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
		// 注释面剔除后扫（与 zero-global.test.js T1 同口径：HTML 注释内允许历史说明）
		const code = html.replace(/<!--[\s\S]*?-->/g, "");
		expect(
			code.match(
				/window\.(App|BookPage|MozhenApp|MozhenChapterEditor|MozhenBookChat)\b/g,
			) || [],
		).toHaveLength(0);
	});
});
