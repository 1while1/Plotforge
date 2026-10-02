// S4-6（charter §3，范式 A·判定 C 旧名桥，S3-2 ChapterConflict/S4-3 CharacterWorkbench/
// S4-4 LedgerWorkbench/S4-5 StyleHealth 先例）：FocusModeOverlay——沉浸写作模式的
// React 版。逐字等值移植 public/legacy/focus-mode.js（267 行，本片起退役为死锚点：
// index.html :796 标签删、文件零 diff 保留）。判定 C 动因＝唯一消费点
// book-chapters.js:540 守卫调用 `if (window.FocusMode) window.FocusMode.sync();`
// 不可触碰（book-chapters.js 不在 P4 任何切片，阶段五随编辑器迁移块处置）——React 桥
// 以旧名 window.FocusMode 应答（legacy-bridge.jsx），真实浏览器由本组件应答，死锚点内
// 旧实现自洽（S4-5 同配方：消费方文件越界不可改，非 vm 冻结）。
//
// 与旧实现的关键差异（React 化的实质面，Plan §2.4 点名）：
// - 六类注入面（开关按钮/面包屑头/预览钮/背板/抽屉/引用钮）各建一个容器节点落位
//   （legacy :152-210 逐字同位），容器不挂可见样式（.focus-head 例外——类挂容器，
//   CSS :236 body.focus-mode .focus-head 才显示）；渲染树内元素类名/id/文案与 legacy
//   逐字一致，零 CSS 改动（style.css :220-336 focus 样式块原样复用）。
//   createRoot 数量勘误（Plan §2.4「各建一个容器节点再 createRoot」）＝1 root（按钮
//   容器）＋5 createPortal——ChatJumpBottom（S3-1）先例同款；六 root 需外部 store 才能
//   共享组件态，portal 对 DOM 逐字等值（六容器落位不变）。
// - 旧名桥 { sync, isActive } 经模块级镜像（mirror）读组件态（StyleHealthPanel 桥读
//   模块态 S 同款）：每次 mount 一份镜像、current 指向最新一次——sync＝active 时重拉
//   数据（等值 :260）、isActive＝返回当前 active（等值 :261）。死 API isActive 照常
//   暴露不清理（全仓零消费，D-S4-1-01 mountWorkbenchTask 同口径）。
// - mountFocusMode 四守卫（App/#book-workbench/#btn-toggle-left-panel/BookPage）逐字
//   等值 init :255——任一缺失即 no-op 且**不返回桥**，legacy-bridge.jsx 因此不定义
//   window.FocusMode（:539「模块未加载时为空操作」注释与 :540 守卫依赖此形态）；
//   另带 data-focus-mode-host 幂等标记防双注入（Plan §7 S3 停止条件）。
// - 全局监听（document mousedown/keydown、window hashchange）随挂载经 effect 注册、
//   卸载清理（原版注册后终身有效，React 版等价且不依赖清理）；Escape 分支顺序
//   （:242-246）、hashchange 正则 #/book/\d+（:17）、引用注入的 input 事件
//   bubbles:true（:146）全部逐字等值——input 事件是 legacy 聊天草稿态契约
//   （Plan §7 S5），不许降级为「仅改 value」。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import { chapterEditorApi } from "./ChapterEditorPanel.jsx";

// ---------- 段落渲染（等值 :107-111） ----------
// 按空行分段、段内换行 <br>；React 文本节点渲染天然等价 escapeHtml 语义（Plan §2.4）。
// key 用「已见内容前缀」（内容派生、位置唯一）——biome noArrayIndexKey 不用索引
//（S4-5 先例：key 去索引改内容键）。
function lineBreaks(text) {
	const lines = text.split("\n");
	const nodes = [];
	let seen = "";
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) nodes.push(<br key={seen} />);
		nodes.push(lines[i]);
		seen = seen ? `${seen}\n${lines[i]}` : lines[i];
	}
	return nodes;
}

function paragraphNodes(text) {
	const paras = text.split(/\n\s*\n/);
	const nodes = [];
	let seen = "";
	for (let i = 0; i < paras.length; i++) {
		const prefix = seen;
		nodes.push(<p key={prefix || " "}>{lineBreaks(paras[i])}</p>);
		seen = prefix ? `${prefix}\n\n${paras[i]}` : paras[i];
	}
	return nodes;
}

function FocusModeOverlay({ mirror, hosts }) {
	const [active, setActive] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [vols, setVols] = useState([]);
	const [chapters, setChapters] = useState([]);
	const [volValue, setVolValue] = useState("");
	const [chValue, setChValue] = useState("");
	const [draft, setDraft] = useState(null); // 开抽屉时的 {title, text} 快照
	const [quote, setQuote] = useState(null); // { text, left, top } | null
	const drawerBodyRef = useRef(null);
	const quoteBtnRef = useRef(null);

	const bookId = () => {
		const app = getApp();
		return app?.state.currentBook ? app.state.currentBook.id : null;
	};
	const onBookHome = () => /^#\/book\/\d+$/.test(window.location.hash); // :17 逐字

	// ---------- 数据（等值 :20-75） ----------
	function refreshData() {
		const bid = bookId();
		if (!bid) return;
		Promise.all([
			getApp().api("GET", `/api/books/${bid}/volumes`),
			getApp().api("GET", `/api/books/${bid}/chapters`),
		])
			.then((r) => {
				const nextChapters = r[1].chapters || [];
				setVols(r[0].volumes || []);
				setChapters(nextChapters);
				syncLabels(nextChapters);
			})
			.catch(() => {
				/* 列表刷新失败不打断主流程（:31） */
			});
	}

	function syncLabels(chapterList) {
		const cid = getApp().state.currentChapterId;
		const cur = (chapterList || []).filter((c) => c.id === cid)[0];
		const vid = cur?.volume_id ? cur.volume_id : getApp().state.currentVolumeId;
		if (vid != null) setVolValue(String(vid));
		setChValue(cid ? String(cid) : "");
	}

	function chaptersOf(volId) {
		return chapters.filter((c) => String(c.volume_id || "") === String(volId));
	}

	// ---------- 模式开关（等值 :78-84） ----------
	function toggle(force) {
		const next = typeof force === "boolean" ? force : !mirror.active;
		mirror.active = next; // 立即同步镜像（连点同拍也逐拍翻转，等值 legacy 模块变量）
		setActive(next);
		if (next) refreshData();
		if (!next) closeDrawer();
	}

	// ---------- 草稿抽屉（等值 :87-112） ----------
	function openDrawer() {
		const titleEl = document.getElementById("chapter-title-input");
		const contentEl = document.getElementById("chapter-content");
		setDraft({
			title: (titleEl?.value || "").trim(),
			text: contentEl ? contentEl.value : "",
		});
		mirror.drawerOpen = true;
		setDrawerOpen(true);
	}

	function closeDrawer() {
		mirror.drawerOpen = false;
		setDrawerOpen(false);
		hideQuote();
	}

	function hideQuote() {
		setQuote(null);
	}

	// ---------- 划选引用（等值 :117-147） ----------
	function onDrawerMouseup() {
		setTimeout(() => {
			const body = drawerBodyRef.current;
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) {
				hideQuote();
				return;
			}
			const text = String(sel.toString() || "").trim();
			if (!text) {
				hideQuote();
				return;
			}
			const range = sel.getRangeAt(0);
			if (!body?.contains(range.commonAncestorContainer)) {
				hideQuote();
				return;
			}
			const rect = range.getBoundingClientRect();
			let top = rect.top - 34;
			if (top < 70) top = rect.bottom + 6;
			setQuote({
				text: sel.toString(), // 原文不 trim（等值 :125，注入按原文逐行加前缀）
				left: `${Math.max(12, rect.left)}px`,
				top: `${top}px`,
			});
		}, 0);
	}

	function insertQuote() {
		const ta = document.getElementById("chat-text");
		if (!ta || !quote?.text) return;
		const quoted = `${quote.text
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n")}\n\n`;
		const start =
			ta.selectionStart != null ? ta.selectionStart : ta.value.length;
		const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
		ta.value = ta.value.slice(0, start) + quoted + ta.value.slice(end);
		const caret = start + quoted.length;
		closeDrawer();
		ta.focus();
		try {
			ta.setSelectionRange(caret, caret);
		} catch (_e) {
			/* ignore */
		}
		// legacy 聊天草稿态依赖该 input 事件（:146，bubbles 逐字等值）
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	// ---------- 镜像同步（桥与全局监听读最新组件态） ----------
	useEffect(() => {
		mirror.active = active;
		mirror.drawerOpen = drawerOpen;
		mirror.refresh = refreshData;
	});

	// 模式类（等值 :80，幂等）。**仅最新 mount 的实例拥有共享 body 类**：旧 mount
	// 实例失联（宿主 DOM 重建）后其 active 变更不得抢写 document.body——生产单
	// mount 无差异；多 mount（测试/重复 registerLegacyBridges）防串扰。
	useEffect(() => {
		if (mirror !== current) return;
		document.body.classList.toggle("focus-mode", active);
	}, [active, mirror]);

	// 全局监听（等值 :238-251；监听随挂载注册、卸载清理，闭包只读 mirror/window/setter——
	// 数据全部经 mirror 与 getApp() 实时读取，首渲染闭包即最新语义）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 等值 legacy bind() 注册后终身有效（闭包只读 mirror/window 实时态）
	useEffect(() => {
		const onDocMouseDown = (e) => {
			const btn = quoteBtnRef.current;
			if (btn?.classList.contains("show") && !btn.contains(e.target)) {
				hideQuote();
			}
		};
		const onKeydown = (e) => {
			if (e.key !== "Escape" || !mirror.active) return;
			if (mirror.drawerOpen) closeDrawer();
			else toggle(false);
		};
		const onHashchange = () => {
			if (mirror.active && !onBookHome()) toggle(false);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onKeydown);
		window.addEventListener("hashchange", onHashchange);
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onKeydown);
			window.removeEventListener("hashchange", onHashchange);
		};
	}, []);

	// 抽屉 body scroll 隐藏引用钮（等值 :233，passive 语义保留）
	// biome-ignore lint/correctness/useExhaustiveDependencies: hideQuote 只调 setQuote(null)，等值 legacy :233 终身监听
	useEffect(() => {
		const body = drawerBodyRef.current;
		if (!body) return undefined;
		const onHide = () => hideQuote();
		body.addEventListener("scroll", onHide, { passive: true });
		return () => body.removeEventListener("scroll", onHide);
	}, []);

	// 引用钮 mousedown 原生拦截（等值 :236——必须拦在 document 之前，保住按钮点击；
	// React 合成 stopPropagation 拦不住 document 级监听，故走原生 addEventListener）
	useEffect(() => {
		const btn = quoteBtnRef.current;
		if (!btn) return undefined;
		const onMd = (e) => {
			e.preventDefault();
			e.stopPropagation();
		};
		btn.addEventListener("mousedown", onMd);
		return () => btn.removeEventListener("mousedown", onMd);
	}, []);

	const list = chaptersOf(volValue);
	// 抽屉 body（等值 :195-198/:202 结构）：划选监听 onMouseUp＝:232；
	// 抑制注释需 JS 注释位，故提为常量（CardsPage.jsx:446 先例同款注释位）
	const drawerBodyNode = (
		// biome-ignore lint/a11y/noStaticElementInteractions: 等值旧版抽屉 body 划选监听（focus-mode.js :232），文本区非交互元素原样保留
		<div
			ref={drawerBodyRef}
			className="focus-draft-body"
			onMouseUp={onDrawerMouseup}
		>
			{draft ? (
				draft.text.trim() ? (
					paragraphNodes(draft.text)
				) : (
					<p className="focus-draft-empty">当前章节还没有内容</p>
				)
			) : null}
		</div>
	);
	return (
		<>
			<button
				id="btn-focus-mode"
				className={active ? "btn btn-ghost mode-on" : "btn btn-ghost"}
				type="button"
				title="AI 专注写作模式：隐藏左右栏，对话居中；Esc 退出"
				onClick={() => toggle()}
			>
				专注模式
			</button>
			{createPortal(
				<div className="focus-crumbs">
					<span className="crumb">
						<select
							aria-label="切换分卷"
							value={volValue}
							onChange={(e) => {
								// 等值 :217-222：重建章下拉由 volValue 派生；空卷 toast＋回弹
								const value = e.target.value;
								setVolValue(value);
								const hit = chapters.filter(
									(c) => String(c.volume_id || "") === String(value),
								);
								if (!hit.length) {
									getApp().toast("该卷还没有章节");
									syncLabels(chapters);
									return;
								}
								chapterEditorApi().selectChapter(hit[0].id);
							}}
						>
							{vols.map((v) => (
								<option key={v.id} value={v.id}>
									{v.title}
								</option>
							))}
						</select>
					</span>
					<span className="crumb-sep">/</span>
					<span className="crumb">
						<select
							aria-label="切换章节"
							value={chValue}
							onChange={(e) => {
								// 等值 :223-226：占位（空值）不切换
								const value = e.target.value;
								setChValue(value);
								if (!value) return;
								chapterEditorApi().selectChapter(Number(value));
							}}
						>
							<option value="">
								{list.length ? "选择章节" : "（本卷暂无章节）"}
							</option>
							{list.map((c) => (
								<option key={c.id} value={c.id}>
									{c.title}
								</option>
							))}
						</select>
					</span>
				</div>,
				hosts.head,
			)}
			{createPortal(
				<button
					className="focus-preview-btn"
					type="button"
					title="滑出当前章草稿（Esc 或点击外侧关闭）"
					onClick={() => (mirror.drawerOpen ? closeDrawer() : openDrawer())}
				>
					📖 预览草稿
				</button>,
				hosts.preview,
			)}
			{createPortal(
				// biome-ignore lint/a11y/useKeyWithClickEvents: 等值旧版纯鼠标点击的背板（focus-mode.js :231），不加键盘语义
				// biome-ignore lint/a11y/noStaticElementInteractions: 同上，div onclick 原样保留
				<div
					className={
						drawerOpen ? "focus-draft-backdrop open" : "focus-draft-backdrop"
					}
					onClick={closeDrawer}
				/>,
				hosts.backdrop,
			)}
			{createPortal(
				<aside className={drawerOpen ? "focus-draft open" : "focus-draft"}>
					<div className="focus-draft-head">
						<span className="focus-draft-title">草稿预览</span>
						<span className="focus-draft-ch">
							{draft ? draft.title || "未选择章节" : ""}
						</span>
					</div>
					{drawerBodyNode}
				</aside>,
				hosts.drawer,
			)}
			{createPortal(
				<button
					ref={quoteBtnRef}
					className={quote ? "quote-insert-btn show" : "quote-insert-btn"}
					type="button"
					style={quote ? { left: quote.left, top: quote.top } : undefined}
					onClick={insertQuote}
				>
					↵ 引用
				</button>,
				hosts.quote,
			)}
		</>
	);
}

export default FocusModeOverlay;

// ---------- 模块态镜像与旧名桥（legacy-bridge.jsx 以旧名 window.FocusMode 注册应答） ----------
// 每次 mount 一份镜像；current 指向最新一次 mount——桥与 :540 消费形态读最新组件态
//（等值 :258-262：sync 在 active 时重拉、isActive 返回当前 active）。
let current = null;

export function focusModeSync() {
	const c = current;
	if (c?.active && typeof c.refresh === "function") c.refresh();
}

export function focusModeIsActive() {
	return current ? current.active === true : false;
}

// 守卫自挂载（等值 init :254-263）：DOM 锚任一缺失即 no-op 且**不返回桥**——
// 旧名桥仅在返回桥时定义（守卫失败旧名不出现，:539「模块未加载时为空操作」语义）。
// P6-2 §2.5-D5 内化：旧四守卫 {{App, BookPage, workbench, anchor}} 中 App/BookPage 两臂
// 改模块面直取（getApp／chapterEditorApi 恒在，NULL 面为哨兵对象）⇒ 其缺失态**不可达**，
// 留案退役；余下两臂保持 DOM 存在性判据（真实运行态判据，等价 legacy）。
export function mountFocusMode() {
	// 幂等防双注入（Plan §7 S3：重复按钮/重复抽屉即停）
	if (document.querySelector("[data-focus-mode-host]")) return null;
	const workbench = document.getElementById("book-workbench");
	const anchor = document.getElementById("btn-toggle-left-panel");
	if (!workbench || !anchor) return null;

	// 注入面容器（Plan §2.4）：各建一个容器节点落位；容器本身不挂可见样式
	//（focus-head 例外，类挂容器）。按钮容器等值 :158-159 anchor.after(btn)；
	// 面包屑头容器等值 :169-173 insertBefore(head, chatPanel.firstChild)；
	// 预览/背板/抽屉/引用四容器等值 :179-210 append 到 body。
	const btnHost = document.createElement("div");
	anchor.after(btnHost);
	const headHost = document.createElement("div");
	headHost.className = "focus-head";
	const chatPanel = workbench.querySelector(".panel-chat");
	chatPanel.insertBefore(headHost, chatPanel.firstChild);
	const previewHost = document.createElement("div");
	const backdropHost = document.createElement("div");
	const drawerHost = document.createElement("div");
	const quoteHost = document.createElement("div");
	document.body.appendChild(previewHost);
	document.body.appendChild(backdropHost);
	document.body.appendChild(drawerHost);
	document.body.appendChild(quoteHost);
	for (const host of [
		btnHost,
		headHost,
		previewHost,
		backdropHost,
		drawerHost,
		quoteHost,
	]) {
		host.setAttribute("data-focus-mode-host", "");
	}

	const mirror = { active: false, drawerOpen: false, refresh: null };
	current = mirror;
	// createRoot 数量勘误＝1 root（btnHost）＋5 portal（组件头注）
	createRoot(btnHost).render(
		<FocusModeOverlay
			mirror={mirror}
			hosts={{
				btn: btnHost,
				head: headHost,
				preview: previewHost,
				backdrop: backdropHost,
				drawer: drawerHost,
				quote: quoteHost,
			}}
		/>,
	);
	// P6-2：守卫通过才「激活」——调用方（entry 初始化）据此决定 FocusMode 桥是否在位；
	// 消费方（ChapterEditorPanel 的模块未加载即空操作）改经 focusModeBridge() 直取。
	mountedBridge = true;
	return { sync: focusModeSync, isActive: focusModeIsActive };
}

// 模块桥取值面（等值旧 `if (window.FocusMode) window.FocusMode.sync()` 守卫语义：
// 未挂载（守卫失败／重复挂载）时返回 null ⇒ 消费方 no-op）。
let mountedBridge = false;

export function focusModeBridge() {
	if (!mountedBridge) return null;
	return { sync: focusModeSync, isActive: focusModeIsActive };
}
