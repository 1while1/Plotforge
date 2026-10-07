// WorkbenchResizer（S3-1 D9，自挂载零消费）：写作页三栏拖拽分栏。
// 栏序（UI 优化阶段 1 起，工作台 B）：导航 .panel-left | 编辑 .panel-editor | 写作助手 .panel-chat。
// 分隔条由 mount() 命令式注入（两条 .col-divider：左＝导航宽度，右＝编辑:助手比例），
// bench.classList.add('resizable')，列宽模板由本组件内联接管；模块未加载时页面维持样式表的静态三栏定义。
// 宽度偏好存 localStorage 'novel-workbench-layout-v2'（屏幕空间是设备级偏好，不按书存）。
// v1 键的 ratio 表示「聊天栏在中间」时的中:右比例，语义已变，故换键不迁移。
// 两种折叠经 MutationObserver 感知 bench 的 class：
//   left-collapsed（BookShell 切换）——隐藏导航与左分隔条；
//   chat-collapsed（BookShell 切换，顶栏 #btn-toggle-chat-panel）——隐藏写作助手与右分隔条。
// 拖拽高频路径不经 React 渲染；React 只作挂载载体，组件渲染 null。
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	anyDrawerOpen,
	CHAT_DRAWER_QUERY,
	closeDrawers,
	isDrawer,
	isDrawerOpen,
	NAV_DRAWER_QUERY,
	syncDrawerToggles,
} from "../lib/narrow-layout.js";

export const STORAGE_KEY = "novel-workbench-layout-v2";
export const DEFAULT_LEFT = 264;
export const DEFAULT_RATIO = 0.62; // 编辑区占（编辑+助手）的比例
const MIN_LEFT = 200,
	MAX_LEFT = 420;
const MIN_MIDDLE = 420,
	MIN_RIGHT = 340;
const MIN_RATIO = 0.3,
	MAX_RATIO = 0.8;
const DIVIDER_W = 5;

function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

function load() {
	try {
		const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
		if (d && d.left > 0 && d.ratio > 0 && d.ratio < 1) return d;
	} catch {
		/* 本地偏好损坏时回退默认 */
	}
	return { left: DEFAULT_LEFT, ratio: DEFAULT_RATIO };
}
function save(d) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
	} catch {
		/* ignore */
	}
}

// 助手栏下限：按比例分到的宽度在 1024 左右的屏幕上会窄到头部换行，所以给 340px 下限，
// 再用工作台宽度的 40% 封顶，窄屏上不至于把编辑区挤没。
// 下限按实测宽度算成 px 而不写 CSS min()：jsdom 的样式解析会整条丢弃含 min() 的模板。
export function chatMinWidth(benchWidth) {
	if (!(benchWidth > 0)) return 0;
	return Math.min(MIN_RIGHT, Math.round(benchWidth * 0.4));
}

export function gridTemplate(
	state,
	{ leftCollapsed, chatCollapsed, chatMin = 0 },
) {
	// fr 放大 100 倍：助手栏触到下限被冻结后，编辑区单独的 fr 若小于 1，
	// 按规范只分到剩余空间的 fr 倍，会在两栏之间留下一条空白。
	const a = +(state.ratio * 100).toFixed(2),
		b = +((1 - state.ratio) * 100).toFixed(2);
	const left = leftCollapsed ? "" : `${state.left}px ${DIVIDER_W}px `;
	if (chatCollapsed) return `${left}minmax(0,1fr)`;
	const min = chatMin > 0 ? `${chatMin}px` : "0";
	return `${left}minmax(0,${a}fr) ${DIVIDER_W}px minmax(${min},${b}fr)`;
}

function panels(bench) {
	return {
		leftPanel: bench.querySelector(".panel-left"),
		editorPanel: bench.querySelector(".panel-editor"),
		chatPanel: bench.querySelector(".panel-chat"),
	};
}

function WorkbenchResizer() {
	useEffect(() => {
		const bench = document.getElementById("book-workbench");
		if (!bench) return undefined;
		const { leftPanel, editorPanel, chatPanel } = panels(bench);
		if (!leftPanel || !editorPanel || !chatPanel) return undefined;

		const state = load();

		function makeDivider(side, hint) {
			const d = document.createElement("div");
			d.className = "col-divider";
			d.dataset.side = side;
			d.title = hint;
			d.setAttribute("role", "separator");
			d.setAttribute("aria-orientation", "vertical");
			return d;
		}
		const divLeft = makeDivider("left", "拖拽调整侧栏宽度 · 双击恢复默认");
		const divRight = makeDivider(
			"right",
			"拖拽调整写作助手宽度 · 双击恢复默认",
		);
		leftPanel.after(divLeft);
		editorPanel.after(divRight);
		bench.classList.add("resizable");

		function flags() {
			return {
				leftCollapsed: bench.classList.contains("left-collapsed"),
				chatCollapsed: bench.classList.contains("chat-collapsed"),
				chatMin: chatMinWidth(bench.getBoundingClientRect().width),
			};
		}
		function apply() {
			// 抽屉模式下列宽交还样式表的窄屏模板，拖拽偏好原样留着，拉宽窗口后恢复
			bench.style.gridTemplateColumns = isDrawer("nav")
				? ""
				: gridTemplate(state, flags());
		}

		// 窄屏抽屉：遮罩点一下、Esc、选中章节、换页、跨断点都收起
		const backdrop = document.createElement("div");
		backdrop.className = "narrow-backdrop";
		backdrop.setAttribute("aria-hidden", "true");
		bench.appendChild(backdrop);
		const onBackdrop = () => closeDrawers();
		const onKeydown = (e) => {
			// 抽屉上面还盖着弹窗时，Esc 先归弹窗
			if (e.key !== "Escape" || !anyDrawerOpen()) return;
			if (
				document.querySelector(
					'[role="dialog"][data-state="open"], .modal-mask:not(.hidden)',
				)
			)
				return;
			closeDrawers();
		};
		const onLeftClick = (e) => {
			if (isDrawerOpen("nav") && e.target.closest?.(".chapter-row")) {
				closeDrawers();
			}
		};
		const queries =
			typeof window.matchMedia === "function"
				? [NAV_DRAWER_QUERY, CHAT_DRAWER_QUERY].map((q) => window.matchMedia(q))
				: [];
		const onBreakpoint = () => {
			closeDrawers();
			syncDrawerToggles();
			apply();
		};
		backdrop.addEventListener("click", onBackdrop);
		document.addEventListener("keydown", onKeydown);
		leftPanel.addEventListener("click", onLeftClick);
		window.addEventListener("hashchange", onBackdrop);
		for (const mq of queries) mq.addEventListener?.("change", onBreakpoint);
		syncDrawerToggles();

		const classObserver = new MutationObserver(apply);
		classObserver.observe(bench, {
			attributes: true,
			attributeFilter: ["class"],
		});
		// 进书前 #page-book 是隐藏的（宽度 0），显示后与窗口缩放时都要重算助手栏下限
		const sizeObserver =
			typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
		sizeObserver?.observe(bench);

		function startDrag(side, e) {
			e.preventDefault();
			const startX = e.clientX;
			const { leftCollapsed } = flags();
			const startLeft = leftPanel.getBoundingClientRect().width;
			const startMiddle = editorPanel.getBoundingClientRect().width;
			const dividerCount = leftCollapsed ? 1 : 2;
			const flexTotal =
				bench.getBoundingClientRect().width -
				(leftCollapsed ? 0 : startLeft) -
				DIVIDER_W * dividerCount;
			const divider = side === "left" ? divLeft : divRight;
			divider.classList.add("dragging");
			document.body.classList.add("col-resizing");

			function onMove(ev) {
				const dx = ev.clientX - startX;
				if (side === "left") {
					state.left = clamp(startLeft + dx, MIN_LEFT, MAX_LEFT);
				} else {
					const middle = clamp(
						startMiddle + dx,
						MIN_MIDDLE,
						Math.max(MIN_MIDDLE, flexTotal - MIN_RIGHT),
					);
					state.ratio = clamp(middle / flexTotal, MIN_RATIO, MAX_RATIO);
				}
				apply();
			}
			function onUp() {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				divider.classList.remove("dragging");
				document.body.classList.remove("col-resizing");
				save(state);
			}
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		}

		const onLeftDown = (e) => startDrag("left", e);
		const onRightDown = (e) => startDrag("right", e);
		const onLeftDbl = () => {
			state.left = DEFAULT_LEFT;
			apply();
			save(state);
		};
		const onRightDbl = () => {
			state.ratio = DEFAULT_RATIO;
			apply();
			save(state);
		};
		divLeft.addEventListener("mousedown", onLeftDown);
		divRight.addEventListener("mousedown", onRightDown);
		divLeft.addEventListener("dblclick", onLeftDbl);
		divRight.addEventListener("dblclick", onRightDbl);

		apply();

		return () => {
			classObserver.disconnect();
			sizeObserver?.disconnect();
			divLeft.removeEventListener("mousedown", onLeftDown);
			divRight.removeEventListener("mousedown", onRightDown);
			divLeft.removeEventListener("dblclick", onLeftDbl);
			divRight.removeEventListener("dblclick", onRightDbl);
			divLeft.remove();
			divRight.remove();
			backdrop.removeEventListener("click", onBackdrop);
			document.removeEventListener("keydown", onKeydown);
			leftPanel.removeEventListener("click", onLeftClick);
			window.removeEventListener("hashchange", onBackdrop);
			for (const mq of queries)
				mq.removeEventListener?.("change", onBreakpoint);
			backdrop.remove();
		};
	}, []);
	return null;
}

// 自挂载入口：幂等（bench 缺失或缺任一栏即 return）。
// root 宿主为 body 末尾空 div（#book-workbench 是 grid 容器，组件渲染 null 也不可占用网格项）。
export function mount() {
	const bench = document.getElementById("book-workbench");
	if (!bench || bench.__mozhenResizerMounted) return;
	const { leftPanel, editorPanel, chatPanel } = panels(bench);
	if (!leftPanel || !editorPanel || !chatPanel) return;
	bench.__mozhenResizerMounted = true;
	const host = document.createElement("div");
	document.body.appendChild(host);
	createRoot(host).render(<WorkbenchResizer />);
}
