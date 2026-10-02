// WorkbenchResizer（S3-1 D9，自挂载零消费）：panel-resizer.js（112 行）的 React 化。
// 三栏拖拽分栏（写作页 workbench）：左栏宽度与中:右比例可拖拽调整。
// 分隔条由 mount() 命令式注入（等价旧 panel-resizer.js:36~49：两条 .col-divider 的
// dataset.side/role/aria-orientation/title 逐字 + bench.classList.add('resizable')）、
// 列宽模板由本组件内联接管：模块未加载时页面维持 style.css 原始三栏定义，零腐化风险。
// 宽度偏好存 localStorage 'novel-workbench-layout'（屏幕空间是设备级偏好，不按书存）；
// 坏数据回退默认（DEFAULT_LEFT=260 / DEFAULT_RATIO=1/2.2）；双击分隔条恢复默认。
// 收起侧栏（left-collapsed 由 book.js 切 class）经 MutationObserver 感知，折叠时左
// 分隔条由 CSS 隐藏、模板自动改两栏。拖拽 clamp 边界与模板串逐字等价旧代码
// （MIN_LEFT=200/MAX_LEFT=420/MIN_MIDDLE=320/MIN_RIGHT=360/ratio∈[0.2,0.8]/DIVIDER_W=5）。
// React 用作挂载载体：逻辑在 mount effect 内闭包运行（与旧 IIFE 同形，拖拽高频路径
// 不经 React 渲染），组件渲染 null；旧全局 window.PanelResizer 不留 shim（全仓零
// 消费，Plan D1）。
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

const STORAGE_KEY = "novel-workbench-layout";
const DEFAULT_LEFT = 260;
const DEFAULT_RATIO = 1 / 2.2; // 中:右 = 1:1.2，与 .workbench 原始 grid 一致
const MIN_LEFT = 200,
	MAX_LEFT = 420;
const MIN_MIDDLE = 320,
	MIN_RIGHT = 360;
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

function WorkbenchResizer() {
	useEffect(() => {
		const bench = document.getElementById("book-workbench");
		if (!bench) return undefined;
		const leftPanel = bench.querySelector(".panel-left");
		const chatPanel = bench.querySelector(".panel-chat");
		if (!leftPanel || !chatPanel) return undefined;

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
		const divRight = makeDivider("right", "拖拽调整聊天栏宽度 · 双击恢复默认");
		leftPanel.after(divLeft);
		chatPanel.after(divRight);
		bench.classList.add("resizable");

		function isCollapsed() {
			return bench.classList.contains("left-collapsed");
		}
		function template() {
			const a = state.ratio,
				b = 1 - state.ratio;
			if (isCollapsed()) {
				return `minmax(0,${a}fr) ${DIVIDER_W}px minmax(0,${b}fr)`;
			}
			return `${state.left}px ${DIVIDER_W}px minmax(0,${a}fr) ${DIVIDER_W}px minmax(0,${b}fr)`;
		}
		function apply() {
			bench.style.gridTemplateColumns = template();
		}

		// 「收起侧栏」由 book.js 切 class：监听后重算模板
		const classObserver = new MutationObserver(apply);
		classObserver.observe(bench, {
			attributes: true,
			attributeFilter: ["class"],
		});

		function startDrag(side, e) {
			e.preventDefault();
			const startX = e.clientX;
			const collapsed = isCollapsed();
			const startLeft = leftPanel.getBoundingClientRect().width;
			const startMiddle = chatPanel.getBoundingClientRect().width;
			const dividerCount = collapsed ? 1 : 2;
			const flexTotal =
				bench.getBoundingClientRect().width -
				(collapsed ? 0 : startLeft) -
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
					state.ratio = clamp(middle / flexTotal, 0.2, 0.8);
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
			divLeft.removeEventListener("mousedown", onLeftDown);
			divRight.removeEventListener("mousedown", onRightDown);
			divLeft.removeEventListener("dblclick", onLeftDbl);
			divRight.removeEventListener("dblclick", onRightDbl);
			divLeft.remove();
			divRight.remove();
		};
	}, []);
	return null;
}

// 自挂载入口：幂等（bench 缺失或缺 .panel-left/.panel-chat 即 return，等价旧 :28~32）。
// root 宿主为 body 末尾空 div（#book-workbench 是 grid 容器，组件渲染 null 也不可
// 占用网格项）。旧全局 window.PanelResizer 不再暴露。
export function mount() {
	const bench = document.getElementById("book-workbench");
	if (!bench || bench.__mozhenResizerMounted) return;
	const leftPanel = bench.querySelector(".panel-left");
	const chatPanel = bench.querySelector(".panel-chat");
	if (!leftPanel || !chatPanel) return;
	bench.__mozhenResizerMounted = true;
	const host = document.createElement("div");
	document.body.appendChild(host);
	createRoot(host).render(<WorkbenchResizer />);
}
