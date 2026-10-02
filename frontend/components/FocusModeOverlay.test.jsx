// @vitest-environment jsdom
// S4-6 红测（Plan §4 F1~F9）：FocusModeOverlay 范式 A·判定 C 旧名桥——
// React 以旧名 window.FocusMode 应答（唯一消费点 book-chapters.js:540 守卫调用
// `if (window.FocusMode) focusModeSync();`，book-chapters.js 不在 P4 任何
// 切片、结构性不可触碰），focus-mode.js（267 行）退役为死锚点（index.html :796
// 标签删、文件零 diff 保留）。
// 断言语义锚点＝public/legacy/focus-mode.js 活代码行号（Plan §4 F 表逐条）：
// F1 守卫自挂载与旧名桥／F2 模式开关／F3 面包屑数据／F4 章节切换／F5 草稿抽屉／
// F6 划选引用与注入／F7 Escape 分支／F8 hashchange 自动退出／F9 sync 桥语义。
// harness（StyleHealthPanel.test.jsx/CardsPage.test.jsx 同款）：jsdom + React 19 内建
// act + 裸 DOM 断言（不装 @testing-library/*）；预置静态壳四守卫（#book-workbench＋
// .panel-chat／#btn-toggle-left-panel，index.html :65/:80/:137 同构最小集）与
// #chat-text（:158）/#chapter-title-input（:193）/#chapter-content（:202）；
// mock window.App（api/state/toast/escapeHtml；P6-2 §2.5-D1 经 setAppForTests 交给模块单例）
// 与 chapterEditorApi().selectChapter（§2.5-D4 桩面；selectCalls 计数器口径不变）。
// 划选用例 stub window.getSelection/getRangeAt。jsdom 零矩形口径：jsdom 无布局引擎，
// getBoundingClientRect 恒为零矩形——非零矩形用例注入手造 rect 走 :127-129 直落公式
//（top=rect.top-34=166≥70 不回落、left=max(12,30)=30）；零矩形用例断言越界回落
//（top=-34<70 → rect.bottom+6=6px、left=max(12,0)=12px），两态口径见 Plan §4 harness 注。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
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

// 静态壳：focus-mode 的注入面（四守卫＋.panel-chat/#chat-text/#chapter-title-input/
// #chapter-content；withAnchor=false 供 F1 守卫缺失用例拆掉 #btn-toggle-left-panel）
function buildShell({ withAnchor = true } = {}) {
	document.body.innerHTML = `<button id="btn-toggle-left-panel" class="btn btn-ghost" type="button">收起侧栏</button><main id="book-workbench" class="workbench"><section class="panel panel-chat"><textarea id="chat-text" rows="3"></textarea></section></main><input id="chapter-title-input" type="text" /><textarea id="chapter-content"></textarea><div id="toast" class="toast hidden"></div>`;
	if (!withAnchor) document.getElementById("btn-toggle-left-panel")?.remove();
}

function chatText() {
	return document.getElementById("chat-text");
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

const GOOD_RECT = () => ({
	top: 200,
	bottom: 240,
	left: 30,
	right: 90,
	width: 60,
	height: 40,
});

beforeEach(async () => {
	buildShell();
	volsFixture = freshVols();
	chaptersFixture = freshChapters();
	apiFail = false;
	apiCalls = [];
	toasts = [];
	selectCalls = [];
	window.App = {
		api: mockApi,
		state: {
			currentBook: { id: "B1" },
			currentChapterId: 11,
			currentVolumeId: 1,
		},
		escapeHtml(s) {
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
		},
		toast(msg) {
			toasts.push(String(msg));
		},
	};
	// P6-2 转写（Plan §2.5-D4）：`window.BookPage.selectChapter` 桩面换为
	// `chapterEditorApi()`（未挂载＝NULL 占位面单例）同名方法上的 spy——`selectCalls` 口径零改动。
	vi.spyOn(chapterEditorApi(), "selectChapter").mockImplementation((id) => {
		selectCalls.push(id);
	});
	// 默认选区：collapsed（引用钮不显形）；F5/F6 用例内按场景覆写
	window.getSelection = () => ({
		isCollapsed: true,
		toString: () => "",
		rangeCount: 0,
		getRangeAt() {
			throw new Error("no range");
		},
	});
	window.location.hash = "#/book/1";
	await act(async () => {
		mountFocusMode();
	});
});

// P6-2 转写（Plan §2.5-D1 单例注入缝）：生产面已改 `getApp()` 直取模块单例——
// 本注入仅把 window.App 桩交给单例（各用例桩体/断言语义零改动）。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
	vi.restoreAllMocks();
});

describe("FocusModeOverlay 组件（范式 A·判定 C 旧名桥）", () => {
	it("F1 守卫自挂载与模块面（P6-2 ⑨ 转写）：mountFocusMode() 后 focusModeSync/focusModeIsActive 可用；按钮注入于 #btn-toggle-left-panel 之后（等值 :158-159）；.focus-head 为 .panel-chat firstChild（等值 :172-173）；body 含 preview/backdrop/drawer/quote 四件（:179-210）；守卫缺失 → 不注入且返回 null、旧名 window.FocusMode 零命中（等值 init :255 早退——:539「模块未加载时为空操作」语义红线）", async () => {
		expect(typeof focusModeSync).toBe("function");
		expect(typeof focusModeIsActive).toBe("function");
		expect(window.MozhenFocusMode).toBeUndefined(); // 反向见证：模块面不外泄新窗口名

		const anchor = document.getElementById("btn-toggle-left-panel");
		const btn = document.getElementById("btn-focus-mode");
		expect(btn).not.toBeNull();
		expect(anchor.nextElementSibling.querySelector("#btn-focus-mode")).toBe(
			btn,
		);
		expect(btn.className).toBe("btn btn-ghost");
		expect(btn.type).toBe("button");
		expect(btn.title).toBe("AI 专注写作模式：隐藏左右栏，对话居中；Esc 退出");
		expect(btn.textContent).toBe("专注模式");

		const chatPanel = document.querySelector("#book-workbench .panel-chat");
		const head = chatPanel.firstElementChild;
		expect(head.className).toBe("focus-head"); // focus-head 类挂容器（Plan §2.4 注入面策略）
		const crumbs = head.querySelector(".focus-crumbs");
		expect(crumbs).not.toBeNull();
		const [volSel, chSel] = crumbs.querySelectorAll("select");
		expect(volSel.getAttribute("aria-label")).toBe("切换分卷");
		expect(chSel.getAttribute("aria-label")).toBe("切换章节");
		expect(head.querySelector(".crumb-sep").textContent).toBe("/");

		const preview = document.querySelector(".focus-preview-btn");
		expect(preview.type).toBe("button");
		expect(preview.textContent).toBe("📖 预览草稿");
		expect(preview.title).toBe("滑出当前章草稿（Esc 或点击外侧关闭）");
		expect(document.querySelector(".focus-draft-backdrop")).not.toBeNull();
		const drawer = document.querySelector("aside.focus-draft");
		expect(drawer).not.toBeNull();
		expect(drawer.querySelector(".focus-draft-title").textContent).toBe(
			"草稿预览",
		);
		expect(drawer.querySelector(".focus-draft-ch")).not.toBeNull();
		expect(drawer.querySelector(".focus-draft-body")).not.toBeNull();
		const qb = document.querySelector(".quote-insert-btn");
		expect(qb.type).toBe("button");
		expect(qb.textContent).toBe("↵ 引用");
		expect(qb.classList.contains("show")).toBe(false);

		// 守卫缺失：换无锚点新壳，mountFocusMode 直调返回 null 且零注入；
		// registerLegacyBridges 后旧名不出现（:539 注释与 :540 守卫依赖此形态）
		buildShell({ withAnchor: false });
		expect(mountFocusMode()).toBeNull();
		await act(async () => {
			mountFocusMode();
		});
		expect(window.FocusMode).toBeUndefined();
		expect(document.getElementById("btn-focus-mode")).toBeNull();
		expect(document.querySelector(".focus-head")).toBeNull();
		expect(document.querySelector(".focus-preview-btn")).toBeNull();
		expect(document.querySelector(".focus-draft")).toBeNull();
		expect(document.querySelector(".quote-insert-btn")).toBeNull();
	});

	it("F2 模式开关：click → body.focus-mode＋按钮 mode-on＋isActive true（:78-84）；再点 → 两态皆退＋抽屉关闭（:83 closeDrawer）", async () => {
		const btn = document.getElementById("btn-focus-mode");
		await act(async () => {
			btn.click();
		});
		await act(async () => {});
		expect(document.body.classList.contains("focus-mode")).toBe(true);
		expect(btn.classList.contains("mode-on")).toBe(true);
		expect(focusModeIsActive()).toBe(true);

		await act(async () => {
			document.querySelector(".focus-preview-btn").click();
		});
		const drawer = document.querySelector(".focus-draft");
		const backdrop = document.querySelector(".focus-draft-backdrop");
		expect(drawer.classList.contains("open")).toBe(true);
		expect(backdrop.classList.contains("open")).toBe(true);

		await act(async () => {
			btn.click();
		});
		await act(async () => {});
		expect(document.body.classList.contains("focus-mode")).toBe(false);
		expect(btn.classList.contains("mode-on")).toBe(false);
		expect(drawer.classList.contains("open")).toBe(false);
		expect(backdrop.classList.contains("open")).toBe(false);
		expect(focusModeIsActive()).toBe(false);
	});

	it("F3 面包屑数据：active 化 → 并行两 GET（:23-25）→ 卷选项/章下拉渲染＋占位文案逐字（:55-57）；syncLabels 回填 currentChapterId/currentVolumeId（:67-75）；GET 失败静默不炸（:31）", async () => {
		await activate();
		const gets = apiCalls.filter((c) => c.method === "GET");
		expect(gets.map((g) => g.path).sort()).toEqual([
			"/api/books/B1/chapters",
			"/api/books/B1/volumes",
		]);
		const [volSel, chSel] = getCrumbs();
		expect(volSel.options.length).toBe(3);
		expect(volSel.value).toBe("1"); // cur 章 11 → volume_id 1（:71）
		expect(volSel.options[0].textContent).toBe("第一卷");
		expect(volSel.options[2].textContent).toBe("空卷");
		expect(chSel.options.length).toBe(3); // 占位＋卷 1 两章（:54-64）
		expect(chSel.options[0].value).toBe("");
		expect(chSel.options[0].textContent).toBe("选择章节");
		expect(chSel.value).toBe("11"); // currentChapterId 回填（:74）
		expect(chSel.options[1].textContent).toBe("第一章");
		expect(chSel.options[2].textContent).toBe("第二章");

		// GET 失败：catch 静默（:31）——零 toast、零抛错，既有选项不被清空（等值 legacy 闭包变量不被覆盖）
		apiFail = true;
		await act(async () => {
			document.getElementById("btn-focus-mode").click(); // 先退出
		});
		await act(async () => {
			document.getElementById("btn-focus-mode").click(); // 再激活（本次拉取失败）
		});
		await act(async () => {});
		expect(toasts).toEqual([]);
		const [volSel2] = getCrumbs();
		expect(volSel2.options.length).toBe(3);
	});

	it("F4 章节切换：章 change → selectChapter(Number(value))（:223-226）；卷 change 有章 → selectChapter(首章) 恰调 1 次（:216-222）；空卷 → toast「该卷还没有章节」＋syncLabels 回弹、不调 selectChapter（:220）", async () => {
		await activate();
		const [volSel, chSel] = getCrumbs();

		// 章 change：Number 传参（:225）
		setSelectValue(chSel, "12");
		await act(async () => {});
		expect(selectCalls).toEqual([12]);
		expect(Number.isInteger(selectCalls[0])).toBe(true);

		// 卷 change 有章：首章 id 原样传参（:221）
		setSelectValue(volSel, "2");
		await act(async () => {});
		expect(selectCalls).toEqual([12, 21]);

		// 空卷：toast＋回弹（:220），不调 selectChapter
		setSelectValue(volSel, "3");
		await act(async () => {});
		expect(toasts).toEqual(["该卷还没有章节"]);
		expect(selectCalls).toEqual([12, 21]);
		expect(volSel.value).toBe("1"); // syncLabels 回弹（cur.volume_id，:71-72）
		expect(chSel.value).toBe("11"); // chSel 回填（:74）
		expect(chSel.options[0].textContent).toBe("选择章节"); // 回弹后重建占位（:57），非「（本卷暂无章节）」
	});

	it("F5 草稿抽屉：预览 click → open 类＋快照重读；空标题 → 「未选择章节」（:102）；空正文 → 「当前章节还没有内容」（:103-105）；有正文 → 空行分段 <p>＋段内 <br>（:107-111）；backdrop click → 关（:231）；scroll → 引用按钮隐藏（:233）", async () => {
		await activate();
		const preview = document.querySelector(".focus-preview-btn");
		const titleInput = document.getElementById("chapter-title-input");
		const content = document.getElementById("chapter-content");

		// 空标题＋有正文：ch span「未选择章节」＋两段渲染
		titleInput.value = "";
		content.value = "段落一A\n段落一B\n\n段落二";
		await act(async () => {
			preview.click();
		});
		const drawer = document.querySelector(".focus-draft");
		expect(drawer.classList.contains("open")).toBe(true);
		expect(document.querySelector(".focus-draft-ch").textContent).toBe(
			"未选择章节",
		);
		const ps = drawer.querySelectorAll(".focus-draft-body p");
		expect(ps.length).toBe(2);
		expect(ps[0].textContent).toBe("段落一A段落一B");
		expect(ps[0].querySelectorAll("br").length).toBe(1);
		expect(ps[1].textContent).toBe("段落二");

		// backdrop click → 关（:231）
		await act(async () => {
			document.querySelector(".focus-draft-backdrop").click();
		});
		expect(drawer.classList.contains("open")).toBe(false);

		// 再开重读快照（renderDraft 每次开抽屉重读，:87-88）：标题进 ch span
		titleInput.value = "第三章 试炼";
		await act(async () => {
			preview.click();
		});
		expect(document.querySelector(".focus-draft-ch").textContent).toBe(
			"第三章 试炼",
		);

		// 空正文（纯空白）→ 空态文案（:103-105）
		content.value = "   ";
		await act(async () => {
			document.querySelector(".focus-draft-backdrop").click();
		});
		await act(async () => {
			preview.click();
		});
		expect(document.querySelector(".focus-draft-empty").textContent).toBe(
			"当前章节还没有内容",
		);

		// scroll → 引用按钮隐藏（:233，passive 语义保留）——先造出 show 态
		content.value = "正文若干";
		await act(async () => {
			document.querySelector(".focus-draft-backdrop").click();
		});
		const drawerBody = document.querySelector(".focus-draft-body");
		window.getSelection = () => ({
			isCollapsed: false,
			toString: () => "选中文本",
			rangeCount: 1,
			getRangeAt: () => ({
				commonAncestorContainer: drawerBody,
				getBoundingClientRect: GOOD_RECT,
			}),
		});
		await act(async () => {
			drawerBody.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 5));
		});
		const qb = document.querySelector(".quote-insert-btn");
		expect(qb.classList.contains("show")).toBe(true);
		await act(async () => {
			drawerBody.dispatchEvent(new Event("scroll"));
		});
		expect(qb.classList.contains("show")).toBe(false);
	});

	it("F6 划选引用与注入：mouseup＋选区命中 drawerBody → 显形＋定位公式（:117-133）；引用钮 mousedown 保点击（:236）；点击 → #chat-text 按 selectionStart/End 拼接 '> ' 逐行前缀＋'\\n\\n'、input 事件恰一次且 bubbles、抽屉关闭（:135-147）；document mousedown 点外隐藏（:238-240）；collapsed/空文本/选区在抽屉外 → 不显形（:120-124）；零矩形回落 top=rect.bottom+6/left=max(12,·)（jsdom 口径见头注）", async () => {
		await activate();
		const preview = document.querySelector(".focus-preview-btn");
		await act(async () => {
			preview.click();
		});
		const drawerBody = document.querySelector(".focus-draft-body");
		const ta = chatText();
		const inputEvents = [];
		ta.addEventListener("input", (e) => inputEvents.push(e));

		function stubSelection(overrides) {
			window.getSelection = () => ({
				isCollapsed: false,
				toString: () => "第一行\n第二行",
				rangeCount: 1,
				getRangeAt: () => ({
					commonAncestorContainer: drawerBody,
					getBoundingClientRect: GOOD_RECT,
				}),
				...overrides,
			});
		}
		async function fireMouseup() {
			await act(async () => {
				drawerBody.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				await new Promise((r) => setTimeout(r, 5));
			});
		}

		// 命中显形＋定位（:126-130：top=200-34=166≥70 直落；left=max(12,30)=30）
		stubSelection({});
		await fireMouseup();
		const qb = document.querySelector(".quote-insert-btn");
		expect(qb.classList.contains("show")).toBe(true);
		expect(qb.style.left).toBe("30px");
		expect(qb.style.top).toBe("166px");

		// 引用钮 mousedown：preventDefault＋stopPropagation（:236）——document 级隐藏器不触发
		const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		qb.dispatchEvent(md);
		expect(md.defaultPrevented).toBe(true);
		expect(qb.classList.contains("show")).toBe(true);

		// 点击注入（:135-147）：按 selectionStart/End 拼接＋caret＋关抽屉
		ta.value = "开头";
		ta.setSelectionRange(2, 2);
		await act(async () => {
			qb.click();
		});
		const quoted = "> 第一行\n> 第二行\n\n";
		expect(ta.value).toBe(`开头${quoted}`);
		expect(inputEvents.length).toBe(1);
		expect(inputEvents[0].bubbles).toBe(true);
		expect(ta.selectionStart).toBe(2 + quoted.length);
		expect(ta.selectionEnd).toBe(ta.selectionStart);
		expect(
			document.querySelector(".focus-draft").classList.contains("open"),
		).toBe(false);
		expect(qb.classList.contains("show")).toBe(false);

		// document mousedown 点外 → 隐藏（:238-240）：重开抽屉重造 show
		await act(async () => {
			preview.click();
		});
		stubSelection({});
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(true);
		await act(async () => {
			document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(qb.classList.contains("show")).toBe(false);

		// collapsed → 隐藏（:120）
		await fireMouseup(); // 上一步已隐藏；先用好选区再造 show
		stubSelection({});
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(true);
		stubSelection({ isCollapsed: true });
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(false);

		// 空文本（trim 后）→ 隐藏（:121-122）
		stubSelection({ toString: () => "   " });
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(false);

		// 选区在抽屉外 → 隐藏（:124）
		stubSelection({
			getRangeAt: () => ({
				commonAncestorContainer: document.body,
				getBoundingClientRect: GOOD_RECT,
			}),
		});
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(false);

		// 零矩形回落（jsdom 口径，头注）：top=-34<70 → rect.bottom+6=6；left=max(12,0)=12
		stubSelection({
			toString: () => "零矩形",
			getRangeAt: () => ({
				commonAncestorContainer: drawerBody,
				getBoundingClientRect: () => ({
					top: 0,
					bottom: 0,
					left: 0,
					right: 0,
					width: 0,
					height: 0,
				}),
			}),
		});
		await fireMouseup();
		expect(qb.classList.contains("show")).toBe(true);
		expect(qb.style.left).toBe("12px");
		expect(qb.style.top).toBe("6px");
		expect(inputEvents.length).toBe(1); // 全程 input 恰好一次（:146）
	});

	it("F7 Escape 分支：非 active → 无操作（:243 早退）；非 Escape 键不拦；active＋drawerOpen → 关抽屉不退模式（:244）；active＋抽屉关 → 退模式（:245）", async () => {
		// document 级原生监听里的 setState 经 act 包裹刷出（F5 scroll 同款）
		const esc = () =>
			act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			});
		// 非 active：无操作
		await esc();
		expect(document.body.classList.contains("focus-mode")).toBe(false);

		await activate();
		await act(async () => {
			document.querySelector(".focus-preview-btn").click();
		});
		// 非 Escape 键不拦（:243）
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(
			document.querySelector(".focus-draft").classList.contains("open"),
		).toBe(true);
		// active＋drawerOpen → 只关抽屉（:244）
		await esc();
		expect(
			document.querySelector(".focus-draft").classList.contains("open"),
		).toBe(false);
		expect(document.body.classList.contains("focus-mode")).toBe(true);
		expect(focusModeIsActive()).toBe(true);
		// active＋抽屉关 → 退模式（:245）
		await esc();
		expect(document.body.classList.contains("focus-mode")).toBe(false);
		expect(focusModeIsActive()).toBe(false);
	});

	it("F8 hashchange 自动退出：active 离开 #/book/\\d+ → 退模式＋抽屉关（:249-251）；#/book/12 停留；#/book/12/a 不算 book home（正则 :17 逐字）；inactive 时 hash 变 → 无操作", async () => {
		const fireHash = () =>
			act(async () => {
				window.dispatchEvent(new Event("hashchange"));
			});
		await activate();
		await act(async () => {
			document.querySelector(".focus-preview-btn").click();
		});
		// 书主页（#/book/\d+$ 命中）：不退
		window.location.hash = "#/book/12";
		await fireHash();
		expect(focusModeIsActive()).toBe(true);
		expect(
			document.querySelector(".focus-draft").classList.contains("open"),
		).toBe(true);
		// #/book/12/a：正则 ^#/book/\d+$ 不匹配 → 退模式＋抽屉关
		window.location.hash = "#/book/12/a";
		await fireHash();
		expect(focusModeIsActive()).toBe(false);
		expect(document.body.classList.contains("focus-mode")).toBe(false);
		expect(
			document.querySelector(".focus-draft").classList.contains("open"),
		).toBe(false);
		// inactive：无操作
		window.location.hash = "#/read/1";
		await fireHash();
		expect(focusModeIsActive()).toBe(false);
	});

	it("F9 sync 桥语义：非 active → 零请求；active → 重拉两 GET（:260 重拉等值）；桥存在且 sync 可空操作调用不抛（book-chapters.js:540 消费形态）", async () => {
		const getCnt = () => apiCalls.filter((c) => c.method === "GET").length;
		focusModeSync();
		expect(getCnt()).toBe(0); // 非 active：零请求（:260 条件等值）
		await activate();
		expect(getCnt()).toBe(2);
		await act(async () => {
			focusModeSync();
		});
		expect(getCnt()).toBe(4); // active：重拉（:260）
		await act(async () => {
			expect(() => focusModeSync()).not.toThrow();
		});
	});
});
