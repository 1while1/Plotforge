// S5-3（Plan §2.4.7~§2.4.9、§2.4.11）：BookShell 写作页壳——public/legacy/book.js（206 行）
// 的等值移植（show 编排序 :171-205／renderWritingStatus :71-83／返回锚 :86-118／布局 :26-42／
// bindShellEvents :120-137／bindStatusInputs :139-150／状态条包装链 :153-163（**P6-1 已退役**：
// 三入口刷新职责内化到 React 入口 api 边界，见下方 withWritingStatusRefresh）／加载期
// bindShellEvents :168）。**book.js 已随 S5-10 死锚点退役批 git rm**（P6-1-X1 事实同步）：
// 旧 vm 锚点（run-status-ui.test.js:298／writing-workspace-state:434／workspace-navigation:480）
// 同步退役，`public/legacy/` 现存 4 件死锚点中无 book.js。
//
// P6-2（生产面去全局化）：本文件对 window.* 的取用全部内部化——
//   App→`getApp()` 单例；RunStatus→`runStatus` 直取；BookPage 名义入口→`chapterEditorApi()`；
//   聊天挂载触发点→`ChatWorkspace.bindChatEvents()`（唯一挂载入口，`{remount:false}` 语义不变）；
//   三面板（大纲/状态簿/侧栏配置）→对应组件导出直取；状态条刷新读点→`lib/writing-status.js` 渲染缝
//   （首次 mount 注册、未注册 no-op）；壳安装幂等键→模块级 `installed`（原 window 级标记退役）。
//
// React 化的形态（判定 C：真实浏览器 React 应答、vm 旧实现自洽）：
// - 壳不做可见 UI 重渲染——#page-book 静态壳由编辑器/聊天命令式治理（S5-2 先例）；
//   组件渲染 null，只以 effect 触发 show 编排。
// - 状态条包装链**已退役**（P6-1／S5-10-X1 裁定 (b)；旧名不在本文件出现——源码见证 grep 恒 0）：
//   :153-163 那条「首次 mount 包装 `window.BookPage.saveChapter|selectChapter|loadChat`」的链
//   整链删除；「入口完成即刷状态条」改由消费侧在 React 实现边界自持——`ChapterEditorPanel.controller.api` 与
//   `ChatWorkspace.buildApi` 以本文件导出的 withWritingStatusRefresh(fn) 精确包住三入口，
//   触发集与相对调用方次序与链逐条等值（Plan §2.5 对照表；红测
//   frontend/pages/writing-status-refresh.test.jsx）。
// - 壳方法最小注册（§2.4.9；**P6-2 收口**：两点均已内部化 ⇒ 本文件零 window 注册/改写）：
//   旧两点 saveWritingReturn（book-chat.js:177/:243-244）与 renderWritingStatus（workspace-state.js:389）
//   的去向——前者消费方 `use-chat-workspace.js` 改直取本模块导出、后者改走 `lib/writing-status.js`
//   渲染缝；**不注册** show/toggleLeftPanel/applyLeftPanelLayout/bindShellEvents/
//   bindStatusInputs/readWritingReturn/clearWritingReturn/restoreWritingReturn（取证：live 消费＝零），
//   保 C16「register/mount 前后窗口名面恒 undefined」。
// - 加载期副作用承接（§2.4.11）：bindShellEvents()/updateAgentReturnLink() 由 AppRouter 挂载时调一次
//   （等值 :136/:168——保证直接落在 Agent 台时返回写作页链接可见）；壳方法注册在首次 mount。
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	bindEvents as bindBookOutline,
	load as loadBookOutline,
} from "../components/BookOutlinePanel.jsx";
import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { bindChatEvents, chatApi } from "../components/ChatWorkspace.jsx";
import {
	bind as bindSidebarConfig,
	load as loadSidebarConfig,
} from "../components/SidebarConfigDialog.jsx";
import {
	bindEvents as bindStateBook,
	load as loadStateBook,
} from "../components/StateBookPanel.jsx";
import { getApp } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import {
	bindWritingStatusRenderer,
	isEditorDirty,
} from "../lib/writing-status.js";

const LAYOUT_PREFIX = "writing_layout_v1:";
const RETURN_KEY = "novel-writing-return";

let visit = 0;
// 壳安装幂等（P6-2 §2.5-D8）：原 window.__MOZHEN_BOOK_SHELL_INSTALLED__ 改为模块级标志；
// 测试复位用导出函数（生产零调用）。
let installed = false;

export function resetInstalledForTests() {
	installed = false;
}

function app() {
	return getApp();
}

function $(id) {
	return document.getElementById(id);
}

function setText(id, text) {
	const n = $(id);
	if (n) n.textContent = text;
}

// ---------- 布局折叠（:18-42） ----------
function readLayoutCollapsed(bookId) {
	try {
		return localStorage.getItem(LAYOUT_PREFIX + String(bookId)) === "collapsed";
	} catch (_e) {
		return false;
	}
}

function saveLayoutCollapsed(bookId, collapsed) {
	try {
		localStorage.setItem(
			LAYOUT_PREFIX + String(bookId),
			collapsed ? "collapsed" : "full",
		);
	} catch (_e) {
		/* 忽略 */
	}
}

export function applyLeftPanelLayout(collapsed) {
	const bench = $("book-workbench");
	if (bench) bench.classList.toggle("left-collapsed", !!collapsed);
	const btn = $("btn-toggle-left-panel");
	if (btn) {
		btn.textContent = collapsed ? "展开侧栏" : "收起侧栏";
		btn.classList.toggle("mode-on", !!collapsed);
		btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
	}
	return !!collapsed;
}

export function toggleLeftPanel() {
	const book = app().state.currentBook;
	const next = !(book && readLayoutCollapsed(book.id));
	if (book) saveLayoutCollapsed(book.id, next);
	return applyLeftPanelLayout(next);
}

// ---------- 状态条（:44-83） ----------
function writingConversationLabel() {
	const sel = $("writing-conversation-select");
	if (!sel) return "（默认：历史对话）";
	const id = String(sel.value || "");
	const opts = sel.children || [];
	let selected = null;
	for (let i = 0; i < opts.length; i++) {
		if (id && String(opts[i].value) === id) return opts[i].textContent || id;
		if (!selected && opts[i].selected) selected = opts[i];
	}
	if (selected) return selected.textContent || "（默认：历史对话）";
	return id ? `写作会话 ${id.slice(0, 8)}` : "（默认：历史对话）";
}

function currentChapterLabel() {
	const cid = app().state.currentChapterId;
	if (!cid) return "未选择章节";
	const input = $("chapter-title-input");
	const title = input ? input.value : "";
	return title ? `《${title}》` : `章节 #${cid}`;
}

export function renderWritingStatus() {
	const book = app().state.currentBook;
	if (!book) return;
	setText("writing-status-book", `《${book.title || `#${book.id}`}》`);
	setText("writing-status-chapter", currentChapterLabel());
	setText("writing-status-conversation", writingConversationLabel());
	// biome-ignore lint/complexity/useOptionalChain: 逐字等值 book.js:77（保值移植；含「非函数真值」边缘语义，不做 ?. 改写）
	if (runStatus && runStatus.renderWritingSaveBadge) {
		runStatus.renderWritingSaveBadge();
		return;
	}
	// 等值 book.js:81 的 `BookPage.hasUnsavedChanges()`（去全局后经 lib 供给缝读编辑器脏标记）
	setText("writing-status-save", isEditorDirty() ? "未保存修改" : "已保存");
}

// P6-1（Plan §2.5／§2.3；S5-10-X1 裁定 (b) 的解链前置）：三入口「完成即刷新状态条」职责的
// 内化载体，逐字等值 legacy book.js:153-163 包装链的语义——orig 收到同一实参序列与同一 this，
// 刷新在 promise resolve 之后、调用方 await 恢复点之前（finally，含抛错路径）。
// 落点＝**名义入口在 React 侧的边界**（ChapterEditorPanel.controller.api 的 saveChapter／
// selectChapter、ChatWorkspace.buildApi 的 loadChat），**不得塞进实现函数体**：loadChat 的内部
// 调用（切会话/新开会话/压缩/还原/传输收尾）今日不刷，塞进函数体会新增用户可见差异（Plan §2.3）。
export function withWritingStatusRefresh(fn) {
	return async function (...args) {
		try {
			return await fn.apply(this, args);
		} finally {
			renderWritingStatus();
		}
	};
}

// ---------- 返回锚（:85-118） ----------
function readReturnTarget() {
	try {
		const raw = sessionStorage.getItem(RETURN_KEY);
		if (!raw) return null;
		const t = JSON.parse(raw);
		// biome-ignore lint/complexity/useOptionalChain: 逐字等值 book.js:91（t 可为原始值；保值移植）
		return t && t.bookId ? t : null;
	} catch (_e) {
		return null;
	}
}

export function updateAgentReturnLink() {
	const link = $("agent-return-writing");
	if (!link) return;
	const t = readReturnTarget();
	link.classList.toggle("hidden", !t);
	if (t) link.href = `#/book/${t.bookId}`;
}

export function saveWritingReturn(target) {
	try {
		sessionStorage.setItem(RETURN_KEY, JSON.stringify(target || {}));
	} catch (_e) {
		/* 忽略 */
	}
	updateAgentReturnLink();
}

export function readWritingReturn() {
	return readReturnTarget();
}

export function clearWritingReturn() {
	try {
		sessionStorage.removeItem(RETURN_KEY);
	} catch (_e) {
		/* 忽略 */
	}
	updateAgentReturnLink();
}

// 回到写作页：只有同一本书才还原（换书不猜章节），一次性消费
export async function restoreWritingReturn(bookId) {
	const t = readReturnTarget();
	if (!t || Number(t.bookId) !== Number(bookId)) return false;
	clearWritingReturn();
	if (t.chapterId) await chapterEditorApi().selectChapter(t.chapterId);
	renderWritingStatus();
	return true;
}

// ---------- 绑定族（:120-150） ----------
export function bindShellEvents() {
	const btn = $("btn-toggle-left-panel");
	if (btn && !btn.dataset.shellBound) {
		btn.dataset.shellBound = "1";
		btn.onclick = () => {
			toggleLeftPanel();
		};
	}
	const link = $("agent-return-writing");
	if (link && !link.dataset.shellBound) {
		link.dataset.shellBound = "1";
		link.onclick = (ev) => {
			const t = readReturnTarget();
			if (!t) return; // 没有来源就不拦默认跳转
			// biome-ignore lint/complexity/useOptionalChain: 逐字等值 book.js:132（保值移植）
			if (ev && ev.preventDefault) ev.preventDefault();
			window.location.hash = `#/book/${t.bookId}`; // 路由 → React 壳消费返回锚
		};
	}
	updateAgentReturnLink();
}

// 编辑器输入让状态条即时跟上。顺序敏感：必须在 book-chapters.js 的脏检查监听之后注册
// （同一事件上先跑的监听读到的还是旧脏态），所以只在 show 里绑定，不在加载期绑定。
export function bindStatusInputs() {
	for (const id of ["chapter-content", "chapter-title-input", "chapter-beat"]) {
		const el = $(id);
		if (el && !el.dataset.statusBound) {
			el.dataset.statusBound = "1";
			el.addEventListener("input", () => {
				renderWritingStatus();
			});
		}
	}
}

// 首次 mount 安装（幂等 flag：模块级＝每文档一次，等值旧装载期一次；测试经 resetInstalledForTests 复位）：
// P6-2：**不再注册/改写任何 window.* 名**（状态条**渲染**读点与返回锚**写入**读点均已内部化）——
// 本模块的 renderWritingStatus 注册进 `lib/writing-status.js` 渲染缝（workspace-state.js 的 apply
// 读点经该缝；未注册 no-op ＝等值旧「page.renderWritingStatus 未定义时不刷」守卫语义）；
// 返回锚写入的消费方（`use-chat-workspace.js` 两处 `saveWritingReturn`）随聊天域一笔改直取本模块
// 导出 ⇒ 旧 `BookPage.saveWritingReturn` 注册点无消费方，随之退役。
function ensureInstalled() {
	if (installed) return;
	installed = true;
	bindWritingStatusRenderer(renderWritingStatus);
}

// ---------- show 编排（:171-205 逐字） ----------
async function runShow(bookId) {
	const App = getApp();
	try {
		App.state.currentChapterId = null;
		App.state.currentVolumeId = null;
		document.getElementById("editor-body").classList.add("hidden");
		document.getElementById("editor-empty").classList.remove("hidden");

		const data = await App.api(
			"GET",
			`/api/books/${encodeURIComponent(bookId)}`,
		);
		App.state.currentBook = data.book;
		document.getElementById("book-title").textContent = data.book.title;

		chapterEditorApi().bindChapterEvents();
		// 聊天面挂载唯一触发点（S5-7 整改契约；Plan §1.2-2）：内部走 ensureMounted({remount:false})
		bindChatEvents();
		bindBookOutline();
		bindStateBook();
		bindSidebarConfig();
		loadBookOutline();
		loadStateBook();
		await Promise.all([
			chapterEditorApi().loadChapters(),
			chatApi().loadWorld(),
			chatApi().loadCharacters(),
			chatApi().loadChat(),
			loadSidebarConfig(),
		]);
		bindShellEvents();
		bindStatusInputs();
		applyLeftPanelLayout(readLayoutCollapsed(bookId));
		renderWritingStatus();
		await restoreWritingReturn(bookId);
	} catch (e) {
		App.toast(e.message);
	}
}

function BookShell({ bookId }) {
	useEffect(() => {
		runShow(bookId);
	}, [bookId]);
	return null;
}

// 挂载：容器为 body 下的隐藏 div（React 壳节点；壳不渲染可见 UI）。容器按 id 取用并缓存在
// 元素自身（S4-2/S5-1 mount 先例：key=visit++ 每次进入重挂，故每次进入都重跑 show 编排）。
export function mount(bookId) {
	ensureInstalled();
	let container = document.getElementById("book-shell-root");
	if (!container) {
		container = document.createElement("div");
		container.style.display = "none";
		container.id = "book-shell-root";
		document.body.appendChild(container);
	}
	let root = container.__mozhenBookShellRoot;
	if (!root) {
		root = createRoot(container);
		container.__mozhenBookShellRoot = root;
	}
	visit += 1;
	root.render(<BookShell key={visit} bookId={bookId} />);
}
