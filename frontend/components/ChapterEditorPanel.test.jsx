// @vitest-environment jsdom
// S5-2 红测（Plan §4 C1、C3~C18）：编辑器页范式 A·判定 C——public/legacy/book-chapters.js（938 行）与
// chapter-collapse.js（126 行）等值迁 React（P6-2 ⑨ 后的现状见末段）。
// 断言语义锚点＝public/legacy/book-chapters.js 活代码行号（Plan §4 表逐条）：
// C1 桥与挂载／C3 目录渲染 :269-346／C4 折叠回放 :294/:371-379／C5 选中章与三态 :509-544／
// C6 保存三态与代数 :623-701/:669-689／C7 5c779b9 竞态契约 :630-650／C8 409/428 :549-604／
// C9 离开闸门 :438-507／C10 回收站 :137-216／C11 重命名 :221-267／C12 绑定族 :750-938／
// C13 互操作四条 §2.5／C14 冒烟级等值 :191-215／C15 加载序红线 A／C16 加载序红线 B／
// C17 名义入口路由（补丁 B §2.5.8）／C18 端到端加载序（V2 形态）。
// harness 照抄 ReadPage.test.jsx / CardsPage.test.jsx：React 19 act ＋裸 DOM 断言；
// 静态壳（左栏 tabs/五 pane/编辑器壳/弹窗五件套/toast）**从 frontend/index.html 真实文本提取**
// （单一事实源）。
// P6-2 ⑨ 转写（Plan §2.4 T-C1~T-C4）：index.html 三段 inline classic 承接桩（App 供给／编辑器
// bootstrap／聊天桩）随切换笔清零，C15~C18 改为「零内联段＋chapterEditorApi() 8 名＋模块装载」见证；
// 编辑器自挂载（mountChapterEditor）取代原「registerLegacyBridges → window.MozhenChapterEditor」链路。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import { chapterEditorApi, mountChapterEditor } from "./ChapterEditorPanel.jsx";
import { chatApi } from "./ChatWorkspace.jsx";

// P6-2 转写（Plan §2.4 T-F）：组件侧的四个跨模块消费点改「mock 承接模块」——
// ChapterConflict→showConflictDialog／FocusMode→focusModeBridge／MozhenDiffView→DiffOverlay
// 导出面／WorkspaceState→getWorkspaceState() 单例 registerGuard；记录面与断言逐条不变。
const mod = vi.hoisted(() => ({
	conflictShows: null,
	syncCalls: 0,
	diffShows: null,
	diffBinds: 0,
	diffBound: false,
}));
vi.mock("./ChapterConflictDialog.jsx", () => ({
	showConflictDialog: (opts) => mod.conflictShows.push(opts),
}));
vi.mock("./FocusModeOverlay.jsx", () => ({
	focusModeBridge: () => ({
		sync() {
			mod.syncCalls += 1;
		},
		isActive: () => false,
	}),
	mountFocusMode: () => null,
}));
vi.mock("./DiffOverlay.jsx", () => ({
	show: (opts) => mod.diffShows.push(opts),
	hide: () => {},
	bind: () => {
		mod.diffBinds += 1;
	},
	isBound: () => mod.diffBound,
	markBound: () => {
		mod.diffBound = true;
	},
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
// 静态 doc：不执行脚本，仅供静态壳/加载序断言（单一事实源）
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;

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

const BASE = "/api/books/B1";

// 按 index.html 真实文本组装壳：左栏 tabs＋五 pane／编辑器 section／弹窗五件套／toast
function buildShellHtml() {
	const tabs = STATIC_DOC.querySelector(".panel-left .tabs").outerHTML;
	const panes = [
		"tab-chapters",
		"tab-outline",
		"tab-state",
		"tab-world",
		"tab-characters",
	]
		.map((id) => STATIC_DOC.getElementById(id).outerHTML)
		.join("");
	const editor = STATIC_DOC.querySelector("section.panel-editor").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `<div class="panel-left">${tabs}<div class="tab-panes">${panes}</div></div>${editor}${modal}${toast}`;
}

function freshVolumes() {
	return [
		{ id: 10, title: "第一卷 试炼" },
		{ id: 11, title: "第二卷 余烬", summary_stale: true },
	];
}

function freshChapters() {
	return [
		{
			id: 101,
			title: "第一章 起点",
			volume_id: 10,
			revision: 3,
			content: "第一段落。\n第二段落。\n",
			beat: "开篇",
			summary: "本章总结",
		},
		{
			id: 102,
			title: "第二章 <b>转折</b>",
			volume_id: 10,
			revision: 4,
			content: "转折正文",
			beat: "",
			summary: null,
			drift_status: "minor",
			drift_note: "偏离<说明>",
		},
		{
			id: 103,
			title: "第三章 悬空",
			volume_id: null,
			revision: 1,
			content: "",
		},
		{
			id: 104,
			title: "第四章 幽灵卷",
			volume_id: 999,
			revision: 2,
			content: "幽灵卷正文",
			locked: true,
			indexed: false,
		},
		{
			id: 105,
			title: "第五章 尾章",
			volume_id: 11,
			revision: 7,
			content: "尾章正文",
			relock_pending: true,
		},
		{
			id: 106,
			title: "第六章 偏离",
			volume_id: 11,
			revision: 8,
			content: "偏离正文",
			drift_status: "major",
			drift_note: "大纲偏离",
			locked: true,
			indexed: false,
		},
	];
}

function freshRecycleItems() {
	return [
		{
			id: 71,
			title: "被删章 <A>",
			volume_title: "第一卷 试炼",
			volume_id: 10,
			chars: 12,
			versions: 3,
			deleted_at: "2026-09-01 10:00",
		},
		{
			id: 72,
			title: "无卷章",
			volume_title: null,
			volume_id: 999,
			chars: 5,
			versions: 1,
			deleted_at: "2026-09-02 11:00",
		},
	];
}

let volumesFixture;
let chaptersFixture;
let recycleFixture;
let apiCalls;
let puts;
let toasts;
let modalCalls;
let lastModal;
let closeModalCalls;
let confirmValue;
let conflictShows;
let diffShows;
let registerGuardCalls;
let preMountSaveChapter;
// 可控注入点
let putResponder;
let getChapterHook;
let autoUnlocked;
let persistenceFlag;
let reindexResult;
let summaryResponder;
let restoreResponder;
let postChapterResponder;
let recycleGetFails;

function jsonResponse(data) {
	return data;
}

async function defaultPut(id, body) {
	const ch = chaptersFixture.find((c) => c.id === id) || {};
	if (body.title != null) ch.title = body.title;
	if (body.content != null) {
		ch.content = body.content;
		ch.revision = (Number(ch.revision) || 0) + 1;
	}
	const res = { chapter: { ...ch } };
	if (autoUnlocked) res.autoUnlocked = true;
	if (persistenceFlag) res.persistence = persistenceFlag;
	return res;
}

async function mockApi(method, url, body) {
	apiCalls.push({ method, path: url, body });
	if (method === "GET" && url === `${BASE}/volumes`) {
		return { volumes: volumesFixture };
	}
	if (method === "GET" && url === `${BASE}/chapters`) {
		return { chapters: chaptersFixture };
	}
	if (method === "GET" && url === `${BASE}/chapter-recycle`) {
		if (recycleGetFails) throw new Error("回收站加载失败");
		return { items: recycleFixture };
	}
	if (method === "GET" && /^\/api\/books\/B1\/chapters\/\d+$/.test(url)) {
		const id = Number(url.slice(`${BASE}/chapters/`.length));
		const ch = chaptersFixture.find((c) => c.id === id);
		if (getChapterHook) return getChapterHook(ch, id);
		return { chapter: { ...ch } };
	}
	if (method === "PUT" && /^\/api\/books\/B1\/chapters\/\d+$/.test(url)) {
		const id = Number(url.slice(`${BASE}/chapters/`.length));
		// 记快照副本：428 先读后写会复用同一个 payload 对象再写 expected_revision，
		// 直接存引用会让第一笔的记录被第二笔篡改
		puts.push({ id, body: { ...body } });
		if (putResponder) return putResponder(id, body, puts.length);
		return defaultPut(id, body);
	}
	if (method === "PUT" && /^\/api\/books\/B1\/volumes\/\d+$/.test(url)) {
		return { volume: {} };
	}
	if (method === "POST" && url === `${BASE}/volumes`) {
		return { volume: { id: 12, title: body.title } };
	}
	if (method === "DELETE" && /^\/api\/books\/B1\/volumes\/\d+$/.test(url)) {
		return {};
	}
	if (method === "DELETE" && /^\/api\/books\/B1\/chapters\/\d+$/.test(url)) {
		return {};
	}
	if (method === "POST" && url === `${BASE}/chapters`) {
		if (postChapterResponder) return postChapterResponder(body);
		return { chapter: { id: 107, volume_id: 10, title: "新章" } };
	}
	if (method === "POST" && url === `${BASE}/chapters/reindex`) {
		return reindexResult;
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/chapters\/\d+\/summary$/.test(url)
	) {
		if (summaryResponder) return summaryResponder(url);
		return { summary: "生成的总结" };
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/chapters\/\d+\/(lock|unlock)$/.test(url)
	) {
		return {};
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/chapters\/\d+\/polish$/.test(url)
	) {
		return { polished: "润色后的正文" };
	}
	if (
		method === "POST" &&
		/^\/api\/books\/B1\/chapter-recycle\/\d+\/restore$/.test(url)
	) {
		if (restoreResponder) return restoreResponder(url, body);
		return {
			chapter: { id: 101, title: "恢复章" },
			reviewItems: [1],
		};
	}
	return jsonResponse({});
}

function escapeHtml(s) {
	if (s == null) return "";
	return String(s).replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c],
	);
}

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function waitFor(cond, timeout) {
	const limit = timeout == null ? 1500 : timeout;
	const t0 = Date.now();
	for (;;) {
		let ok = false;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 5));
			ok = !!cond();
		});
		if (ok) return true;
		if (Date.now() - t0 > limit) return false;
	}
}

async function loadEditor() {
	await act(async () => {
		await chapterEditorApi().loadChapters();
	});
}

async function selectEditorChapter(id) {
	await act(async () => {
		await chapterEditorApi().selectChapter(id);
	});
}

const row = (id) =>
	document.querySelector(`#chapter-list .chapter-row[data-id="${id}"]`);
const volRow = (id) =>
	document.querySelector(`#chapter-list .volume-row[data-vol="${id}"]`);
const byId = (id) => document.getElementById(id);
const modalBody = () => document.getElementById("modal-body");

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = buildShellHtml();
	volumesFixture = freshVolumes();
	chaptersFixture = freshChapters();
	recycleFixture = freshRecycleItems();
	apiCalls = [];
	puts = [];
	toasts = [];
	modalCalls = [];
	lastModal = null;
	closeModalCalls = 0;
	confirmValue = true;
	conflictShows = [];
	diffShows = [];
	registerGuardCalls = [];
	putResponder = null;
	getChapterHook = null;
	autoUnlocked = false;
	persistenceFlag = null;
	reindexResult = { missing: 0 };
	summaryResponder = null;
	restoreResponder = null;
	postChapterResponder = null;
	recycleGetFails = false;
	localStorage.clear();

	window.confirm = () => confirmValue;
	window.App = {
		state: {
			currentBook: { id: "B1", title: "测试之书" },
			currentChapterId: null,
			currentVolumeId: null,
		},
		api: mockApi,
		escapeHtml,
		toast(msg) {
			toasts.push(String(msg));
		},
		openModal(opts) {
			modalCalls.push(opts);
			lastModal = opts;
			modalBody().innerHTML = opts.bodyHTML || "";
		},
		closeModal() {
			closeModalCalls += 1;
		},
	};
	// P6-2：App 经 getApp() 单例读取 ⇒ 注入本测 App 桩
	setAppForTests(window.App);
	// P6-2：导航守卫注册改经 getWorkspaceState() 单例（旧 window.WorkspaceState mock 退役）
	vi.spyOn(getWorkspaceState(), "registerGuard").mockImplementation((g) => {
		registerGuardCalls.push(g);
		return true;
	});

	// P6-2（⑨ 切换笔）：index.html 三段内联承接桩与旧名桥同笔退役 ⇒ bootstrap 提取＋eval 退役；
	// 名义入口＝「chapterEditorApi()」（未挂载 NULL 占位面 / 挂载后真控制器），挂载经 mountChapterEditor()。
	preMountSaveChapter = chapterEditorApi().saveChapter; // C16 见证：挂载面替换 NULL 占位面（旧「桩不被桥覆盖」的等价物）
	mountChapterEditor();
	chapterEditorApi().bindChapterEvents(); // 等值 book.js:183

	// P6-2：模块级记录面接线（等值旧「桥注册后覆写 window.ChapterConflict/FocusMode/MozhenDiffView」）
	mod.conflictShows = conflictShows;
	mod.diffShows = diffShows;
	mod.diffBinds = 0;
	mod.diffBound = false;
	mod.syncCalls = 0;
});

afterEach(async () => {
	const body = document.getElementById("editor-body");
	const root = body?.__mozhenChapterEditorRoot;
	if (root) {
		try {
			await act(async () => {
				root.unmount();
			});
		} catch (_e) {
			/* 已卸载 */
		}
		delete body.__mozhenChapterEditorRoot;
	}
});

describe("ChapterEditorPanel 组件（范式 A·判定 C 旧名桥＋死锚点＋加载序 bootstrap）", () => {
	it("C1 模块面与挂载（P6-2 ⑨ 转写）：chapterEditorApi() 8 名齐备（旧名面 window.BookPage／window.MozhenChapterEditor 零命中）；目录与壳节点齐；容器缺失 no-op；二次挂载/二次 bind 幂等", async () => {
		for (const n of EDITOR_METHODS) {
			expect(typeof chapterEditorApi()[n]).toBe("function");
		}
		// 旧名面整体退役（P6-2 ⑨）：原「bootstrap 桩 8 名＋MozhenChapterEditor 8 名」两断言
		// **收窄合并**为「旧名零命中＋模块面 8 名」——中介对象消失，静态见证由 T1 承担
		expect(window.BookPage).toBe(undefined);
		expect(window.MozhenChapterEditor).toBe(undefined);
		// 桩是动态委托：无章无脏 → false（落到实现）
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		await loadEditor();
		expect(document.querySelectorAll("#chapter-list .chapter-row").length).toBe(
			chaptersFixture.length,
		);
		const body = byId("editor-body");
		expect(body).toBeTruthy();
		for (const id of [
			"diff-view",
			"diff-body",
			"relock-banner",
			"chapter-title-input",
			"btn-lock-chapter",
			"btn-polish-chapter",
			"btn-save-chapter",
			"btn-gen-summary",
			"chapter-beat",
			"chapter-content",
			"btn-polish-selection",
			"word-count",
			"summary-box",
			"summary-text",
			"btn-enter-refine",
		]) {
			expect(
				body.querySelector(`#${id}`),
				`#${id} 应在 React 树内`,
			).toBeTruthy();
		}

		// 二次建桥幂等：节点身份与行数不变
		const contentNode = byId("chapter-content");
		const rowsBefore = document.querySelectorAll("#chapter-list > *").length;
		mountChapterEditor();
		expect(byId("chapter-content")).toBe(contentNode);
		expect(document.querySelectorAll("#chapter-list > *").length).toBe(
			rowsBefore,
		);

		// 二次 bind 幂等（dataset.bound/selBound 守卫）
		chapterEditorApi().bindChapterEvents();
		chapterEditorApi().bindChapterEvents();
		expect(byId("chapter-content").dataset.bound).toBe("1");
		expect(byId("chapter-content").dataset.selBound).toBe("1");

		// 容器缺失：no-op 不抛
		byId("editor-body")?.remove();
		byId("chapter-list")?.remove();
		expect(() => mountChapterEditor()).not.toThrow();
	});

	it("C3 目录渲染：卷序＋卷内章＋未归卷组＋活动态＋总结点＋漂移双档＋定稿三态＋卷过期＋escapeHtml（:269-346）", async () => {
		window.App.state.currentChapterId = 101;
		await loadEditor();
		const list = byId("chapter-list");
		// 卷序（:283-303）
		expect(
			Array.from(
				list.querySelectorAll(".volume-row:not(.orphan-volume-row)"),
			).map((n) => n.dataset.vol),
		).toEqual(["10", "11"]);
		expect(volRow(10).querySelector(".vol-count").textContent).toBe("2 章");
		// 卷内章序＋未归卷组（:304-345）
		expect(
			Array.from(list.querySelectorAll(".chapter-row")).map(
				(n) => n.dataset.id,
			),
		).toEqual(["101", "102", "105", "106", "103", "104"]);
		const orphanHeader = list.querySelector("li.orphan-volume-row");
		expect(orphanHeader.querySelector(".vol-name").textContent).toBe("未归卷");
		expect(orphanHeader.querySelector(".vol-count").textContent).toBe("2 章");
		expect(row(103).dataset.vol).toBe("");
		expect(row(104).dataset.vol).toBe("");
		// 活动态（:306）
		expect(row(101).classList.contains("active")).toBe(true);
		expect(row(102).classList.contains("active")).toBe(false);
		// 总结点（:307）
		expect(row(101).querySelector(".summary-dot").className).toBe(
			"summary-dot",
		);
		expect(row(102).querySelector(".summary-dot").className).toBe(
			"summary-dot none",
		);
		// 漂移双档（:308-312）
		expect(row(102).querySelector(".drift-badge").className).toBe(
			"drift-badge minor",
		);
		expect(row(102).querySelector(".drift-badge").textContent).toBe("轻度偏离");
		expect(row(102).querySelector(".drift-badge").getAttribute("title")).toBe(
			"偏离<说明>",
		);
		expect(row(106).querySelector(".drift-badge").className).toBe(
			"drift-badge major",
		);
		expect(row(106).querySelector(".drift-badge").textContent).toBe("严重偏离");
		// 定稿三态（:313-316）：在卷章（含「·点此重建」）＋未归卷章（无「·点此重建」）
		expect(row(101).querySelectorAll(".lock-badge").length).toBe(0);
		expect(
			Array.from(row(106).querySelectorAll(".lock-badge")).map(
				(n) => n.textContent,
			),
		).toEqual(["定稿", "索引缺失·点此重建"]);
		expect(row(106).querySelector(".lock-badge.reindex-missing")).toBeTruthy();
		expect(
			Array.from(row(104).querySelectorAll(".lock-badge")).map(
				(n) => n.textContent,
			),
		).toEqual(["定稿", "索引缺失"]);
		expect(row(105).querySelector(".lock-badge.relock").textContent).toBe(
			"待重定稿",
		);
		// 卷总结过期（:290-292）
		expect(volRow(11).querySelector(".vol-stale").textContent).toBe("总结过期");
		expect(volRow(10).querySelector(".vol-stale")).toBe(null);
		// 全部用户数据过转义（:297/:319）
		expect(row(102).querySelector(".item-name").textContent).toBe(
			"第二章 <b>转折</b>",
		);
		expect(row(102).querySelector("b")).toBe(null);
		// 驱动依赖形态：li.chapter-row[data-id][data-vol]
		expect(row(101).tagName).toBe("LI");
		expect(row(101).className).toContain("chapter-row");
	});

	it("C4 折叠回放：collapsed 类＋▸＋行内 display:none；loadChapters 重建后保持；点卷头切换→store 同步；删卷清残留（:294/:371-379/:365）", async () => {
		await loadEditor();
		await act(async () => {
			volRow(10).click();
		});
		expect(volRow(10).classList.contains("collapsed")).toBe(true);
		expect(volRow(10).querySelector(".vol-toggle").textContent).toBe("▸");
		expect(row(101).style.display).toBe("none");
		expect(row(102).style.display).toBe("none");
		expect(row(105).style.display).toBe("");
		expect(localStorage.getItem("novel-collapse:B1")).toBe('["10"]');

		// 整表重建（loadChapters）后由 store 回放
		await loadEditor();
		expect(volRow(10).classList.contains("collapsed")).toBe(true);
		expect(volRow(10).querySelector(".vol-toggle").textContent).toBe("▸");
		expect(row(101).style.display).toBe("none");

		// 再点展开 → store 与持久化同步清除
		await act(async () => {
			volRow(10).click();
		});
		expect(volRow(10).classList.contains("collapsed")).toBe(false);
		expect(row(101).style.display).toBe("");
		expect(localStorage.getItem("novel-collapse:B1")).toBe(null);

		// 折叠后删卷：expand 清残留（:365）
		await act(async () => {
			volRow(10).click();
		});
		expect(localStorage.getItem("novel-collapse:B1")).toBe('["10"]');
		const deletesBefore = apiCalls.filter(
			(c) => c.method === "DELETE" && c.path === `${BASE}/volumes/10`,
		).length;
		await act(async () => {
			volRow(10).querySelector(".del-vol").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(
			apiCalls.filter(
				(c) => c.method === "DELETE" && c.path === `${BASE}/volumes/10`,
			).length,
		).toBe(deletesBefore + 1);
		expect(localStorage.getItem("novel-collapse:B1")).toBe(null);
	});

	it("C5 选中章与三态：GET 回填三输入＋hidden 切换＋锁态/重定稿条＋字数＋总结显隐；尾部 FocusMode.sync()（:509-544）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/chapters/101`,
			),
		).toBe(true);
		expect(byId("chapter-title-input").value).toBe("第一章 起点");
		expect(byId("chapter-content").value).toBe("第一段落。\n第二段落。\n");
		expect(byId("chapter-beat").value).toBe("开篇");
		expect(byId("editor-empty").classList.contains("hidden")).toBe(true);
		expect(byId("editor-body").classList.contains("hidden")).toBe(false);
		expect(byId("word-count").textContent).toBe(
			`共 ${"第一段落。\n第二段落。\n".replace(/\s/g, "").length} 字`,
		);
		expect(byId("btn-lock-chapter").textContent).toBe("定稿");
		expect(byId("btn-lock-chapter").classList.contains("mode-on")).toBe(false);
		expect(byId("relock-banner").classList.contains("hidden")).toBe(true);
		expect(byId("summary-box").classList.contains("hidden")).toBe(false);
		expect(byId("summary-text").textContent).toBe("本章总结");
		expect(window.App.state.currentVolumeId).toBe(10);
		expect(mod.syncCalls).toBe(1); // :540

		// 已定稿＋待重定稿章的锁态与总结空态
		await selectEditorChapter(105);
		expect(byId("relock-banner").classList.contains("hidden")).toBe(false);
		expect(byId("summary-box").classList.contains("hidden")).toBe(true);
		expect(window.App.state.currentVolumeId).toBe(11);
		expect(mod.syncCalls).toBe(2);

		// 目录活动态随切章（loadChapters 重拉）
		expect(row(105).classList.contains("active")).toBe(true);
		expect(row(101).classList.contains("active")).toBe(false);
	});

	it("C6 保存三态与代数：PUT body/expected_revision/未命名兜底；autoUnlocked 与 quiet toast；保存期间输入不标干净；durable=false；PERSISTENCE_PENDING（:623-701/:669-689）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		setInputValue(byId("chapter-content"), "正文一");
		expect(byId("btn-save-chapter").classList.contains("mode-on")).toBe(true);
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(puts.length).toBe(1);
		expect(puts[0].body).toEqual({
			title: "第一章 起点",
			content: "正文一",
			beat: "开篇",
			expected_revision: 3,
		});
		expect(toasts).toContain("已保存");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);
		expect(byId("btn-save-chapter").classList.contains("mode-on")).toBe(false);

		// 空标题 → 未命名（:658）
		setInputValue(byId("chapter-title-input"), "   ");
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(puts[1].body.title).toBe("未命名");
		expect(puts[1].body.expected_revision).toBe(4);

		// autoUnlocked：解除定稿 toast 逐字＋锁按钮/重定稿条（:662-665）
		autoUnlocked = true;
		setInputValue(byId("chapter-content"), "改定稿章");
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(toasts).toContain("该章原定稿，修改后已自动解除定稿");
		// 等值 legacy :662-665：autoUnlocked 分支 updateLockBtn(false)＝解锁态＋警示条显示
		expect(byId("btn-lock-chapter").textContent).toBe("定稿");
		expect(byId("btn-lock-chapter").classList.contains("mode-on")).toBe(false);
		expect(byId("relock-banner").classList.contains("hidden")).toBe(false);
		autoUnlocked = false;

		// 保存期间新输入：不标干净、不被响应覆盖（:669-678）
		let held = null;
		putResponder = () =>
			new Promise((resolve) => {
				held = resolve;
			});
		setInputValue(byId("chapter-content"), "提交快照");
		const saving = chapterEditorApi().saveChapter(true);
		setInputValue(byId("chapter-content"), "提交快照+保存期间新输入");
		await act(async () => {
			held({
				chapter: { id: 101, revision: 9 },
				persistence: { durable: true },
			});
			await saving;
		});
		expect(await saving).toBe(true);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		expect(byId("chapter-content").value).toBe("提交快照+保存期间新输入");

		// durable=false：不标干净（:672-678）
		putResponder = null;
		persistenceFlag = {
			durable: false,
			pending: true,
			code: "PERSISTENCE_PENDING",
		};
		setInputValue(byId("chapter-content"), "未落盘");
		const okDurable = await act(async () =>
			chapterEditorApi().saveChapter(true),
		);
		expect(okDurable).toBe(true);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		persistenceFlag = null;

		// PERSISTENCE_PENDING：toast 逐字＋返回 false＋不标干净＋重读刷版本（:682-689）
		putResponder = () =>
			Promise.reject(
				Object.assign(new Error("写入已应用但暂未落盘"), {
					code: "PERSISTENCE_PENDING",
					status: 503,
				}),
			);
		setInputValue(byId("chapter-content"), "拒写内容");
		const okPending = await act(async () =>
			chapterEditorApi().saveChapter(true),
		);
		expect(okPending).toBe(false);
		expect(toasts).toContain(
			"内容已保存到内存，磁盘暂不可用，系统正在自动重试落盘；请勿关闭页面",
		);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		// 磁盘自愈后的下一笔以重读版本（chaptersFixture revision 已被 mock 推进）提交
		putResponder = null;
		const putsBefore = puts.length;
		const okAfter = await act(async () => chapterEditorApi().saveChapter(true));
		expect(okAfter).toBe(true);
		expect(puts[putsBefore].body.expected_revision).toBe(
			chaptersFixture.find((c) => c.id === 101).revision - 1,
		);
	});

	it("C7 5c779b9 竞态契约：撞单飞返回 true＋飞行结束补发携最新输入＋补发笔 revision 基准＋落库后干净；失败路径不补发（:630-650）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		let resolvePut1;
		putResponder = (id, body, nth) => {
			if (nth === 1) {
				return new Promise((resolve) => {
					resolvePut1 = resolve;
				});
			}
			return defaultPut(id, body);
		};
		setInputValue(byId("chapter-content"), "快照A");
		const manual = chapterEditorApi().saveChapter();
		setInputValue(byId("chapter-content"), "快照A+新输入");
		const auto = chapterEditorApi().saveChapter(true); // 撞单飞 → pending
		await act(async () => {
			resolvePut1({
				chapter: { id: 101, revision: 2 },
				persistence: { durable: true },
			});
			await manual;
			await auto;
		});
		expect(await manual).toBe(true);
		expect(puts[0].body.content).toBe("快照A");
		expect(await auto).toBe(true);
		expect(puts.length >= 2).toBe(true);
		expect(puts[1].body.content).toBe("快照A+新输入");
		expect(puts[1].body.expected_revision).toBe(2);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		// 失败路径：不补发（:644 ok=false 不补）
		await selectEditorChapter(101);
		let resolveFail;
		let firstPut = true;
		putResponder = (id, body) => {
			if (firstPut) {
				firstPut = false;
				return new Promise((_resolve, reject) => {
					resolveFail = reject;
				});
			}
			return defaultPut(id, body);
		};
		setInputValue(byId("chapter-content"), "第一笔");
		const m2 = chapterEditorApi().saveChapter();
		setInputValue(byId("chapter-content"), "第一笔+新输入");
		const a2 = chapterEditorApi().saveChapter(true);
		const putsBefore = puts.length;
		await act(async () => {
			resolveFail(Object.assign(new Error("写入失败"), {}));
			await m2;
			await a2;
		});
		expect(await m2).toBe(false);
		expect(puts.length).toBe(putsBefore); // 未补发
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
	});

	it("C8 409/428：ChapterConflict.show 实参＋本地稿留存＋不自动重发＋onReload 回填（已切章不动）；428 恰一次先读后写；无桥 toast 逐字（:549-604）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		putResponder = () =>
			Promise.reject(
				Object.assign(new Error("冲突"), {
					code: "CHAPTER_CONFLICT",
					status: 409,
				}),
			);
		setInputValue(byId("chapter-content"), "本地稿内容");
		setInputValue(byId("chapter-title-input"), "本地标题");
		setInputValue(byId("chapter-beat"), "本地节拍");
		const okConflict = await act(async () =>
			chapterEditorApi().saveChapter(true),
		);
		expect(okConflict).toBe(false);
		expect(conflictShows.length).toBe(1);
		expect(conflictShows[0].server.id).toBe(101);
		expect(conflictShows[0].local).toEqual({
			title: "本地标题",
			content: "本地稿内容",
			beat: "本地节拍",
		});
		expect(typeof conflictShows[0].onReload).toBe("function");
		expect(puts.length).toBe(1); // 绝不自动重发
		expect(byId("chapter-content").value).toBe("本地稿内容");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);

		// onReload 回填＋版本刷新＋标干净（:588-599）
		const loadsBefore = apiCalls.filter(
			(c) => c.method === "GET" && c.path === `${BASE}/chapters`,
		).length;
		await act(async () => {
			conflictShows[0].onReload({
				title: "服务端标题",
				content: "服务端正文",
				beat: "服务端节拍",
				revision: 12,
				locked: true,
				relock_pending: false,
			});
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(byId("chapter-title-input").value).toBe("服务端标题");
		expect(byId("chapter-content").value).toBe("服务端正文");
		expect(byId("chapter-beat").value).toBe("服务端节拍");
		expect(byId("btn-lock-chapter").textContent).toBe("解除定稿");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${BASE}/chapters`,
			).length,
		).toBeGreaterThan(loadsBefore);

		// 弹窗期间已切章：onReload 不动编辑器（:589）
		window.App.state.currentChapterId = 999;
		conflictShows[0].onReload({
			title: "别的章",
			content: "别的正文",
			revision: 3,
			locked: false,
		});
		expect(byId("chapter-content").value).toBe("服务端正文");
		window.App.state.currentChapterId = 101;

		// 428：先读后写恰一次（:549-564）
		putResponder = null;
		conflictShows.length = 0;
		let getCalls = 0;
		getChapterHook = (ch) => {
			getCalls += 1;
			if (getCalls === 1) return { chapter: { ...ch, revision: undefined } };
			return { chapter: { ...ch, revision: 5 } };
		};
		await selectEditorChapter(102); // 第一次 GET → revision 非有限 ⇒ 快照 null
		const putsBefore428 = puts.length;
		let first428 = true;
		putResponder = (id, body) => {
			if (first428) {
				first428 = false;
				return Promise.reject(
					Object.assign(new Error("缺少版本"), {
						code: "CHAPTER_REVISION_REQUIRED",
						status: 428,
					}),
				);
			}
			return defaultPut(id, body);
		};
		setInputValue(byId("chapter-content"), "428 内容");
		const ok428 = await act(async () => chapterEditorApi().saveChapter(true));
		expect(ok428).toBe(true);
		expect(puts.length).toBe(putsBefore428 + 2);
		expect(puts[putsBefore428].body.expected_revision).toBe(undefined);
		expect(puts[putsBefore428 + 1].body.expected_revision).toBe(5);
		putResponder = null;
		getChapterHook = null;

		// P6-2 转写（收窄合并，逐条留案）：原「无桥 toast 逐字（:601-603）」以 `delete
		// window.ChapterConflict` 制造「桥缺失」环境；去全局后冲突弹窗由**模块恒定在位**承接
		// （import 直取，无缺失态）⇒ 该分支在生产不可达、断言对象消失。等价语义并入本用例前半
		// 「ChapterConflict.show 实参逐字」（shown 面）；缺失回落路径随桥退出历史。
		// 428 支路（上方）为「先读后写恰一次」的等价见证，不产生冲突弹窗（conflictShows 恒空）：
		expect(conflictShows.length).toBe(0);
	});

	it("C9 离开闸门：hasUnsavedChanges/clearUnsaved/beforeunload/registerGuard；保存成功且无新输入才放行；三按钮语义；saveBeforeLeave 保存期间新输入继续拦（:438-507/:471-484）", async () => {
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false); // 无章不脏（:472）
		await loadEditor();
		await selectEditorChapter(101);
		setInputValue(byId("chapter-content"), "改动");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		expect(byId("btn-save-chapter").title).toBe(
			"有未保存修改，停笔 3 秒后自动保存",
		);

		// beforeunload（:83-87）
		const unload = new window.Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);

		// registerGuard 形态（:490-507）
		const guard = registerGuardCalls.find((g) => g.key === "writing-editor");
		expect(guard.label).toBe("正文编辑器");
		expect(guard.isDirty()).toBe(true);
		guard.discard(); // 先 clearUnsaved（:495）
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		// 保存失败 → 三选一弹窗；retry/discard 回调；stay 仅关闭（:445-469）
		// 注：discard 后 editBaseline 为空（legacy clearEditState），须重新开章重建脏基线
		await selectEditorChapter(101);
		setInputValue(byId("chapter-content"), "又改动");
		putResponder = () => Promise.reject(new Error("写入失败"));
		const retrySpy = vi.fn();
		const discardSpy = vi.fn();
		let canLeave;
		await act(async () => {
			canLeave = await guard.leave({ retry: retrySpy, discard: discardSpy });
		});
		expect(canLeave).toBe(false);
		const box = document.querySelector("#modal-body .conflict-actions");
		expect(box).toBeTruthy();
		expect(
			Array.from(box.querySelectorAll("[data-act]")).map((b) => b.dataset.act),
		).toEqual(["retry", "stay", "discard"]);
		expect(modalCalls[modalCalls.length - 1].title).toBe("有未保存的修改");
		// stay：仅关闭
		const closeBefore = closeModalCalls;
		box.querySelector('[data-act="stay"]').click();
		expect(closeModalCalls).toBe(closeBefore + 1);
		expect(retrySpy).not.toHaveBeenCalled();
		expect(discardSpy).not.toHaveBeenCalled();
		// retry：回调（清脏由回调方自决）
		await act(async () => {
			await chapterEditorApi().leaveGuard({ onRetry: retrySpy });
			box.querySelector('[data-act="retry"]').click();
			await new Promise((r) => setTimeout(r, 5));
		});
		expect(retrySpy).toHaveBeenCalledTimes(1);
		// discard：先 clearUnsaved 再回调（:501-503）
		await act(async () => {
			await chapterEditorApi().leaveGuard({ onDiscard: discardSpy });
		});
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		box.querySelector('[data-act="discard"]').click();
		expect(discardSpy).toHaveBeenCalledTimes(1);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		// 保存成功且无新输入：放行（:438-443）
		// 注：discard 已 clearEditState（editBaseline 置空）→ 须重开章重建脏基线
		await selectEditorChapter(101);
		putResponder = null;
		setInputValue(byId("chapter-content"), "正常改动");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		const canLeave2 = await act(async () => chapterEditorApi().leaveGuard({}));
		expect(canLeave2).toBe(true);
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		// saveBeforeLeave：保存期间又有新输入 → 继续拦（:441）
		setInputValue(byId("chapter-content"), "拦一笔");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
		let held = null;
		putResponder = () =>
			new Promise((resolve) => {
				held = resolve;
			});
		let canLeave3;
		await act(async () => {
			const p = chapterEditorApi().leaveGuard({});
			setInputValue(byId("chapter-content"), "拦一笔+保存期间新输入");
			held({
				chapter: { id: 101, revision: 30 },
				persistence: { durable: true },
			});
			canLeave3 = await p;
		});
		expect(canLeave3).toBe(false);
		expect(
			document.querySelector("#modal-body .conflict-actions"),
		).toBeTruthy();
	});

	it("C10 回收站四态：书级路由＋data-restore＋恢复成功链路；VOLUME_REQUIRED 选卷（含未归卷）；RECYCLE_RECORD_NOT_FOUND 重开（:137-216）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		await act(async () => {
			byId("btn-chapter-recycle").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/chapter-recycle`,
			),
		).toBe(true);
		const item71 = document.querySelector(
			'#chapter-recycle-list [data-rec="71"]',
		);
		expect(item71.querySelector("strong").textContent).toBe("被删章 <A>");
		expect(item71.querySelector("small").textContent).toContain(
			"原属《第一卷 试炼》· ",
		);
		expect(item71.querySelector("small").textContent).toContain(
			"12 字 · 3 个历史版本",
		);
		const item72 = document.querySelector(
			'#chapter-recycle-list [data-rec="72"]',
		);
		expect(item72.querySelector("small").textContent).toContain("原卷已删 · ");
		expect(item72.querySelector("strong").textContent).toBe("无卷章");

		// 恢复成功：POST（无卷信息 → {}）＋toast＋closeModal＋loadChapters＋selectChapter（:176-185）
		await act(async () => {
			item71.querySelector('[data-restore="71"]').click();
			await new Promise((r) => setTimeout(r, 20));
		});
		const restoreCall = apiCalls.find(
			(c) =>
				c.method === "POST" && c.path === `${BASE}/chapter-recycle/71/restore`,
		);
		expect(restoreCall).toBeTruthy();
		expect(restoreCall.body).toEqual({});
		expect(toasts).toContain("已恢复《恢复章》，1 项待核对");
		expect(closeModalCalls).toBeGreaterThan(0);
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/chapters/101`,
			),
		).toBe(true);

		// VOLUME_REQUIRED → 选卷弹窗（含「未归卷」）＋volume_id 三态（:187-215）
		restoreResponder = () =>
			Promise.reject(
				Object.assign(new Error("原卷已删"), {
					code: "VOLUME_REQUIRED",
					details: { volumes: [{ id: 10, title: "第一卷 试炼" }] },
				}),
			);
		await act(async () => {
			item72.querySelector('[data-restore="72"]').click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(lastModal.title).toBe("选择恢复到哪一卷");
		const sel = document.getElementById("recycle-target-volume");
		expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "10"]);
		expect(sel.options[0].textContent).toBe("未归卷（稍后手动归卷）");
		await act(async () => {
			lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		const restoreCalls = apiCalls.filter(
			(c) =>
				c.method === "POST" && c.path === `${BASE}/chapter-recycle/72/restore`,
		);
		expect(restoreCalls.length).toBe(2);
		expect(restoreCalls[1].body).toEqual({ volume_id: null });
		await act(async () => {
			// 弹窗每次 openModal 都重写 #modal-body，必须重新取节点（旧引用已脱离文档）
			document.getElementById("recycle-target-volume").value = "10";
			lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(
			apiCalls.filter(
				(c) =>
					c.method === "POST" &&
					c.path === `${BASE}/chapter-recycle/72/restore`,
			)[2].body,
		).toEqual({ volume_id: 10 });

		// RECYCLE_RECORD_NOT_FOUND → toast＋重开（:189-191）
		restoreResponder = () =>
			Promise.reject(
				Object.assign(new Error("该回收记录不存在"), {
					code: "RECYCLE_RECORD_NOT_FOUND",
				}),
			);
		const getsBefore = apiCalls.filter(
			(c) => c.method === "GET" && c.path === `${BASE}/chapter-recycle`,
		).length;
		// 上一步选卷弹窗替换了 #modal-body（回收列表已不在），重开回收站弹窗再点恢复
		await act(async () => {
			byId("btn-chapter-recycle").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		await act(async () => {
			document
				.querySelector('#chapter-recycle-list [data-rec="72"] [data-restore]')
				.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(toasts).toContain("该回收记录不存在");
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${BASE}/chapter-recycle`,
			).length,
		).toBe(getsBefore + 2);
	});

	it("C11 重命名：空标题返回 false；当前章且脏先 saveChapter(true) 再 PUT title；renameRev 取当前快照；CHAPTER_CONFLICT toast 逐字＋loadChapters（:221-267）", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		row(101).querySelector(".edit-chapter").click();
		expect(lastModal.title).toBe("重命名章节");
		expect(document.getElementById("chapter-rename-title").value).toBe(
			"第一章 起点",
		);
		// 空标题：toast＋返回 false
		document.getElementById("chapter-rename-title").value = "   ";
		let emptyRet;
		await act(async () => {
			emptyRet = await lastModal.onOk(modalBody());
		});
		expect(emptyRet).toBe(false);
		expect(toasts).toContain("请填写章节标题");

		// 当前章且脏：先落库再改名（:235-237）
		setInputValue(byId("chapter-content"), "改名前的正文改动");
		row(101).querySelector(".edit-chapter").click();
		document.getElementById("chapter-rename-title").value = "新标题";
		const putsBefore = puts.length;
		await act(async () => {
			await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(puts.length).toBe(putsBefore + 2);
		expect(puts[putsBefore].body.content).toBe("改名前的正文改动");
		expect(puts[putsBefore + 1].body.title).toBe("新标题");
		expect(puts[putsBefore + 1].body.expected_revision).toBe(4); // 先落库后的新版本
		expect(byId("chapter-title-input").value).toBe("新标题");
		expect(toasts).toContain("已重命名");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);

		// 非当前章：renameRev 取列表快照 revision（:240-242）
		row(102).querySelector(".edit-chapter").click();
		document.getElementById("chapter-rename-title").value = "改名102";
		const putsBefore102 = puts.length;
		await act(async () => {
			await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(puts[putsBefore102].body).toEqual({
			title: "改名102",
			expected_revision: chaptersFixture.find((c) => c.id === 102).revision,
		});

		// CHAPTER_CONFLICT：toast 逐字＋loadChapters（:257-259）
		putResponder = () =>
			Promise.reject(
				Object.assign(new Error("冲突"), { code: "CHAPTER_CONFLICT" }),
			);
		const loadsBefore = apiCalls.filter(
			(c) => c.method === "GET" && c.path === `${BASE}/chapters`,
		).length;
		row(102).querySelector(".edit-chapter").click();
		document.getElementById("chapter-rename-title").value = "冲突名";
		let conflictRet;
		await act(async () => {
			conflictRet = await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		putResponder = null;
		expect(conflictRet).toBe(false);
		expect(toasts).toContain(
			"该章已在别处被修改，列表已刷新，请确认标题后重试",
		);
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${BASE}/chapters`,
			).length,
		).toBeGreaterThan(loadsBefore);
	});

	it("C12 绑定族：页签五 pane／新建章含折叠展开／阅读跳转／进入精修空章 toast／生成总结按钮态／润色整章与选中段（漂移回退＋找不到 toast）／bind 幂等（:750-938）", async () => {
		// 折叠预置必须在折叠 store 首次 hydrate 之前（store 惰性读一次，之后按内存态）
		localStorage.setItem("novel-collapse:B1", '["10"]');
		await loadEditor();
		// 页签切换（:751-772）
		const tabs = document.querySelectorAll(".tab[data-tab]");
		expect(tabs.length).toBe(5);
		tabs[1].click(); // outline
		expect(tabs[1].classList.contains("active")).toBe(true);
		expect(tabs[0].classList.contains("active")).toBe(false);
		expect(byId("tab-outline").classList.contains("hidden")).toBe(false);
		expect(byId("tab-chapters").classList.contains("hidden")).toBe(true);

		// 新建章节：被折卷只展开该卷（:774-787）
		expect(volRow(10).classList.contains("collapsed")).toBe(true);
		window.App.state.currentVolumeId = 10;
		await act(async () => {
			byId("btn-add-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(
			apiCalls.find((c) => c.method === "POST" && c.path === `${BASE}/chapters`)
				.body,
		).toEqual({ volume_id: 10 });
		expect(localStorage.getItem("novel-collapse:B1")).toBe(null); // expand 清记录
		await waitFor(() =>
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/chapters/107`,
			),
		);

		// 阅读/精修跳转与空章 toast（:795-805）
		window.App.state.currentChapterId = null;
		byId("btn-open-read").click();
		expect(window.location.hash).toBe("#/book/B1/read");
		byId("btn-enter-refine").click();
		expect(toasts).toContain("先在左侧选择或新建一个章节");
		await selectEditorChapter(101);
		byId("btn-open-read").click();
		expect(window.location.hash).toBe("#/book/B1/read/101");
		byId("btn-enter-refine").click();
		expect(window.location.hash).toBe("#/book/B1/read/101");

		// 生成总结（:835-855）
		let resolveSummary;
		summaryResponder = () =>
			new Promise((resolve) => {
				resolveSummary = resolve;
			});
		const summaryBtn = byId("btn-gen-summary");
		await act(async () => {
			summaryBtn.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(summaryBtn.disabled).toBe(true);
		expect(summaryBtn.textContent).toBe("生成中…");
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === `${BASE}/chapters/101/summary`,
			),
		).toBe(true);
		await act(async () => {
			resolveSummary({ summary: "新总结" });
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(summaryBtn.disabled).toBe(false);
		expect(summaryBtn.textContent).toBe("生成总结");
		expect(byId("summary-text").textContent).toBe("新总结");
		expect(byId("summary-box").classList.contains("hidden")).toBe(false);
		summaryResponder = null;

		// 润色整章：空正文 toast（:909-913）
		setInputValue(byId("chapter-content"), "   ");
		byId("btn-polish-chapter").click();
		expect(toasts).toContain("章节内容为空");
		// 非空：先保存 → POST polish → MozhenDiffView.show → onAccept 替换＋保存（:858-907）
		setInputValue(byId("chapter-content"), "待润色正文");
		byId("btn-polish-chapter").click();
		await act(async () => {
			await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === `${BASE}/chapters/101/polish`,
			),
		).toBe(true);
		expect(diffShows.length).toBe(1);
		expect(diffShows[0].scope).toBe("chapter");
		expect(diffShows[0].original).toBe("待润色正文");
		expect(diffShows[0].polished).toBe("润色后的正文");
		await act(async () => {
			await diffShows[0].onAccept("润色后的正文");
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(byId("chapter-content").value).toBe("润色后的正文");
		expect(toasts).toContain("已采纳润色并保存");

		// 选中段润色：选区监听＋偏移漂移回退重定位（:916-930/:882-891）
		setInputValue(byId("chapter-content"), "甲段落，乙段落。");
		const contentEl = byId("chapter-content");
		contentEl.selectionStart = 0;
		contentEl.selectionEnd = 3;
		contentEl.dispatchEvent(new window.Event("mouseup"));
		expect(byId("btn-polish-selection").classList.contains("hidden")).toBe(
			false,
		);
		byId("btn-polish-selection").click();
		await act(async () => {
			await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		const polishCall = apiCalls.filter(
			(c) => c.method === "POST" && c.path === `${BASE}/chapters/101/polish`,
		);
		expect(polishCall[polishCall.length - 1].body).toEqual({
			scope: "selection",
			requirement: "",
			selected_text: "甲段落",
		});
		// 正文已被改动 → slice 不符 → indexOf 回退重定位
		setInputValue(contentEl, "前缀甲段落。");
		await act(async () => {
			await diffShows[diffShows.length - 1].onAccept("改后");
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(byId("chapter-content").value).toBe("前缀改后。");
		// 找不到 → toast 逐字＋不应用（:888）
		contentEl.selectionStart = 0;
		contentEl.selectionEnd = 3;
		contentEl.dispatchEvent(new window.Event("mouseup"));
		byId("btn-polish-selection").click();
		await act(async () => {
			await lastModal.onOk(modalBody());
			await new Promise((r) => setTimeout(r, 20));
		});
		setInputValue(contentEl, "完全不同");
		await act(async () => {
			await diffShows[diffShows.length - 1].onAccept("改后");
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(toasts).toContain(
			"正文中已找不到选中段落，润色结果未应用（正文已被改动）",
		);
		expect(byId("chapter-content").value).toBe("完全不同");

		// diff 绑定幂等（:933-935）＋输入绑定幂等（:816-833）
		chapterEditorApi().bindChapterEvents();
		chapterEditorApi().bindChapterEvents();
		expect(mod.diffBinds).toBe(1);
		expect(mod.diffBound).toBe(true);
		expect(byId("chapter-content").dataset.bound).toBe("1");
		expect(byId("chapter-title-input").dataset.bound).toBe("1");
		expect(byId("chapter-beat").dataset.bound).toBe("1");
	});

	it("C13 互操作四条（§2.5）：BookPage.hasUnsavedChanges 随脏态；外部可调 loadChapters；外部写 #chapter-content/#word-count 不被重渲染覆盖；#diff-view/#diff-body 常驻且 #diff-body 无 React children", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		// 外部读（book.js:59-65 / FocusModeOverlay.jsx:100-101）
		expect(byId("chapter-title-input").value).toBe("第一章 起点");
		expect(byId("chapter-content").value).toContain("第一段落。");
		// 外部写（book-chat.js:968-972 插入到当前章节）
		const contentEl = byId("chapter-content");
		contentEl.value += "\n\nAI 插入段落";
		byId("word-count").textContent =
			`共 ${contentEl.value.replace(/\s/g, "").length} 字`;
		const diffBody = byId("diff-body");
		const diffView = byId("diff-view");
		// 触发 React 重渲染（折叠开关 → loadChapters 重建）
		volRow(10).click();
		await loadEditor();
		expect(contentEl.value).toContain("AI 插入段落");
		expect(byId("word-count").textContent).toBe(
			`共 ${contentEl.value.replace(/\s/g, "").length} 字`,
		);
		// 常驻节点身份不变
		expect(byId("chapter-content")).toBe(contentEl);
		expect(byId("diff-body")).toBe(diffBody);
		expect(byId("diff-view")).toBe(diffView);
		expect(diffBody.childNodes.length).toBe(0); // 不写 children 的叶容器
		// 脏态经名义入口可读（run-status.js:192-193 形态）
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(false);
		setInputValue(contentEl, "脏");
		expect(chapterEditorApi().hasUnsavedChanges()).toBe(true);
	});

	it("C14 冒烟级等值：updateWordCount 去空白三态；壳节点 id/类与 index.html:171-217 逐字一致（CSS 依赖）", async () => {
		await loadEditor();
		// 壳节点 id 全等（顺序一致）——在选中章之前比对：selectChapter 会按章命令式改 hidden 类
		const staticBody = STATIC_DOC.getElementById("editor-body");
		const staticIds = Array.from(staticBody.querySelectorAll("[id]")).map(
			(n) => n.id,
		);
		// 外观菜单触发钮的 id 由 Radix 运行时生成，不属于静态壳契约
		const liveIds = Array.from(byId("editor-body").querySelectorAll("[id]"))
			.map((n) => n.id)
			.filter((id) => !id.startsWith("radix-"));
		expect(liveIds).toEqual(staticIds);
		// 类名与 tag 逐字一致（样式依赖）
		for (const sel of [
			"#diff-view",
			"#diff-body",
			"#relock-banner",
			"#chapter-title-input",
			"#chapter-content",
			"#chapter-beat",
			"#word-count",
			"#summary-box",
			"#btn-enter-refine",
			"#btn-polish-selection",
			"#btn-save-chapter",
			"#btn-lock-chapter",
			".editor-toolbar",
			".editor-head",
			".editor-actions",
			".editor-canvas",
			".editor-doc",
			".editor-eyebrow",
			".chapter-beat-box",
			".editor-foot",
		]) {
			const staticNode = staticBody.querySelector(sel);
			const liveNode = byId("editor-body").querySelector(sel);
			expect(liveNode, `${sel} 应存在`).toBeTruthy();
			expect(liveNode.tagName, `${sel} tag`).toBe(staticNode.tagName);
			expect(liveNode.className, `${sel} class`).toBe(staticNode.className);
		}
		// #editor-empty 静态壳不接管
		expect(byId("editor-empty").textContent).toContain("未选择章节");
		expect(byId("editor-empty").className).toBe(
			STATIC_DOC.getElementById("editor-empty").className,
		);

		// updateWordCount 去空白计数（:13-17）
		await selectEditorChapter(101);
		setInputValue(byId("chapter-content"), "  a b\t c \n d ");
		expect(byId("word-count").textContent).toBe("共 4 字");
		setInputValue(byId("chapter-content"), "   ");
		expect(byId("word-count").textContent).toBe("共 0 字");
		setInputValue(byId("chapter-content"), "");
		expect(byId("word-count").textContent).toBe("共 0 字");
	});

	it("C15 加载序红线 A（P6-3 转写）：源 index.html 零内联段（唯一 script＝Vite entry 声明 /entry.jsx）；三段承接桩清零；两旧标签零命中", async () => {
		const scripts =
			INDEX_HTML.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/type\s*=\s*["']module["']/);
		expect(scripts[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
		expect(
			scripts[0]
				.replace(/<script\b[^>]*>/, "")
				.replace(/<\/script>$/, "")
				.trim(),
		).toBe("");
		{
			const code = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");
			expect(code).not.toContain("window.BookPage");
			expect(code).not.toContain("window.App");
			expect(code).not.toContain("window.MozhenChapterEditor");
			expect(code).not.toContain("window.MozhenBookChat");
		}
		// P6-2（⑨）：旧「App 供给段 < bootstrap 段 < 聊天桩段」三锚点序断言随三段整体删除而**收窄合并**
		// 为「零内联段＋名单内 window.* 零命中」（上方块）；承载序语义的唯一样式＝模块装载序
		// （boot-order.test.jsx T6 + entry.jsx 静态序见证）。
		expect(
			(
				INDEX_HTML.match(/legacy\/chapter-collapse|legacy\/book-chapters/g) ||
				[]
			).length,
		).toBe(0);
	});

	it("C16 加载序红线 B（P6-2 ⑨ 转写）：挂载面替换 NULL 占位面（引用改换＝旧「桩不被桥覆盖」的等价物）；编辑器面不定义 show/renderWritingStatus/loadChat；window.BookPage 零命中；不建 ChapterCollapse 桩", async () => {
		expect(chapterEditorApi().saveChapter).not.toBe(preMountSaveChapter);
		expect(chapterEditorApi().show).toBe(undefined);
		expect(chapterEditorApi().renderWritingStatus).toBe(undefined);
		expect(chapterEditorApi().loadChat).toBe(undefined);
		expect(window.BookPage).toBe(undefined);
		expect(window.ChapterCollapse).toBe(undefined);

		// P6-2 转写（Plan §2.4 T-C2）：原「桩动态委托命中」的等价物＝点击保存后
		// `chapterEditorApi().saveChapter` 直调命中恰 1 次（去全局后组件不再经桩/桥）。
		chapterEditorApi().bindChapterEvents();
		await selectEditorChapter(101);
		const saveSpy = vi.spyOn(chapterEditorApi(), "saveChapter");
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(saveSpy.mock.calls.length).toBe(1);
		saveSpy.mockRestore();
	});

	it("C17 名义入口路由（补丁 B §2.5.8）：点击保存/点章行/三秒自动保存均经 chapterEditorApi().<name>；_doSaveChapter 与 selectChapter 同经名义入口；包装链按 legacy 语义触发", async () => {
		await loadEditor();
		await selectEditorChapter(101);
		// P6-2 转写（Plan §2.4 T-C3）：原「测试自装 window.BookPage 包装链 + 计数」的等价物＝
		// 对 `chapterEditorApi()` 的同行方法装 spy（三点均达名义入口、恒 1 次）；「恰 1 次刷新」
		// 的数量约束由 frontend/pages/writing-status-refresh.test.jsx P6-1-4 守恒例承担。
		const saveSpy = vi.spyOn(chapterEditorApi(), "saveChapter");
		const doSaveSpy = vi.spyOn(chapterEditorApi(), "_doSaveChapter");
		const selectSpy = vi.spyOn(chapterEditorApi(), "selectChapter");

		setInputValue(byId("chapter-content"), "经名义入口保存");
		await act(async () => {
			byId("btn-save-chapter").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(saveSpy.mock.calls.length).toBe(1);
		expect(doSaveSpy.mock.calls.length).toBe(1);
		expect(puts.length).toBe(1);
		expect(puts[0].body.content).toBe("经名义入口保存");

		await act(async () => {
			row(102).click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(selectSpy.mock.calls.length).toBe(1);

		// 三秒自动保存路径（:62-76）经名义入口
		const wrappedBefore = saveSpy.mock.calls.length;
		vi.useFakeTimers();
		try {
			setInputValue(byId("chapter-content"), "自动保存输入");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
		} finally {
			vi.useRealTimers();
		}
		expect(saveSpy.mock.calls.length).toBe(wrappedBefore + 1);
		expect(toasts).toContain("已自动保存");
		saveSpy.mockRestore();
		doSaveSpy.mockRestore();
		selectSpy.mockRestore();
	});

	it("C18 端到端装载序（P6-2 ⑨ 转写）：index.html 零内联经典脚本（仅 module entry）→ 逐段 eval 错误 0；编辑器 8 名由模块面见证；聊天侧命令面存在；旧名面零命中", () => {
		const dom = new JSDOM(INDEX_HTML, {
			url: "http://localhost/",
			runScripts: "outside-only",
			pretendToBeVisual: true,
		});
		const scripts = Array.from(dom.window.document.querySelectorAll("script"));
		const errors = [];
		const evaluated = [];
		for (const s of scripts) {
			if (s.getAttribute("type") === "module") continue;
			const src = s.getAttribute("src");
			let code;
			let label;
			if (src) {
				const clean = src.split("?")[0].replace(/^\//, "");
				// P6-3 转写（Plan §2.4 T-A6）：解析根由 public/（产物）改 frontend/（源）——该分支同名物在
				// frontend/ 生态下不可达（唯一 script 为 module ⇒ 上方 continue），改根不影响断言。
				const file = path.join(REPO_ROOT, "frontend", clean);
				if (!fs.existsSync(file)) {
					errors.push(`${src}: 文件缺失`);
					continue;
				}
				code = fs.readFileSync(file, "utf8");
				label = clean;
			} else {
				code = s.textContent;
				label = "inline";
			}
			try {
				dom.window.eval(code);
				evaluated.push(label);
			} catch (e) {
				errors.push(`${label}: ${e.name}: ${e.message}`);
			}
		}
		expect(errors).toEqual([]);
		// S5-7／P6-2（⑨）转写：classic 段（含三段承接桩）已全删 ⇒ 逐段 eval 集合为空；
		// 承载「加载期赋值齐备」语义的唯一样式＝模块装载（本文件 beforeEach 已 mountChapterEditor）。
		expect(evaluated).toEqual([]);
		expect(scripts.filter((s) => s.getAttribute("type") !== "module")).toEqual(
			[],
		);
		for (const n of EDITOR_METHODS) {
			expect(typeof chapterEditorApi()[n], `editor.${n}`).toBe("function");
		}
		// 聊天侧 11 名（§2.5-D4：经 chatApi() 直取）⇒ §2.7 V1 ReferenceError 已消解
		expect(typeof chatApi().loadChat).toBe("function");
		expect(typeof chatApi().renderActionCard).toBe("function");
		expect(typeof chatApi().currentWritingConversationId).toBe("function");
		expect(dom.window.BookPage).toBe(undefined);
	});
});
