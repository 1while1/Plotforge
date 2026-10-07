// @vitest-environment jsdom
// WorkbenchResizer 自挂载（栏序：导航 | 编辑 | 写作助手）——注入两条 .col-divider
// （dataset/role/aria/title 逐字，左条跟在导航后、右条跟在编辑区后）、bench 加 resizable、
// 默认模板（DEFAULT_LEFT=264 / DEFAULT_RATIO=0.62 / DIVIDER_W=5）、缺栏/缺 bench 安全 return、幂等；
// 拖拽 clamp（200~420、ratio 0.3~0.8）、双击复位写 localStorage、坏 JSON 回退默认、
// left-collapsed / chat-collapsed 两种折叠切模板。jsdom 几何全 0：clamp 边界经零基线＋大位移确定性触发。

import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
	chatMinWidth,
	DEFAULT_LEFT,
	DEFAULT_RATIO,
	gridTemplate,
	mount,
	STORAGE_KEY,
} from "./WorkbenchResizer.jsx";

// 模板里的 fr 是比例 ×100（见 gridTemplate 注释）
const DEFAULT_TEMPLATE = "264px 5px minmax(0,62fr) 5px minmax(0,38fr)";

function buildBench(extraClass = "") {
	document.body.innerHTML = `<main id="book-workbench" class="workbench${extraClass ? ` ${extraClass}` : ""}"><aside id="panel-left" class="panel panel-left"></aside><section class="panel panel-editor"></section><section class="panel panel-chat"></section></main>`;
}

function drag(divider, fromX, toX) {
	divider.dispatchEvent(
		new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
			clientX: fromX,
		}),
	);
	document.dispatchEvent(
		new MouseEvent("mousemove", { bubbles: true, clientX: toX }),
	);
	document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

const rect = (width) => ({
	width,
	height: 0,
	top: 0,
	left: 0,
	right: width,
	bottom: 0,
	x: 0,
	y: 0,
	toJSON() {},
});

beforeEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

describe("WorkbenchResizer（自挂载分栏）", () => {
	it("T18a mount：左条在导航后、右条在编辑区后；属性逐字；resizable；默认模板", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		expect(bench.classList.contains("resizable")).toBe(true);
		const dividers = bench.querySelectorAll(".col-divider");
		expect(dividers.length).toBe(2);
		const [dLeft, dRight] = dividers;
		expect(dLeft.previousElementSibling.className).toContain("panel-left");
		expect(dRight.previousElementSibling.className).toContain("panel-editor");
		expect(dRight.nextElementSibling.className).toContain("panel-chat");
		for (const d of dividers) {
			expect(d.getAttribute("role")).toBe("separator");
			expect(d.getAttribute("aria-orientation")).toBe("vertical");
		}
		expect(dLeft.dataset.side).toBe("left");
		expect(dLeft.title).toBe("拖拽调整侧栏宽度 · 双击恢复默认");
		expect(dRight.dataset.side).toBe("right");
		expect(dRight.title).toBe("拖拽调整写作助手宽度 · 双击恢复默认");
		expect(bench.style.gridTemplateColumns).toBe(DEFAULT_TEMPLATE);
	});

	it("T18b 幂等；缺任一栏或缺 bench 时安全 return", () => {
		buildBench();
		act(() => {
			mount();
		});
		mount();
		expect(document.querySelectorAll(".col-divider").length).toBe(2);
		document.body.innerHTML = `<main id="book-workbench" class="workbench"><aside class="panel panel-left"></aside><section class="panel panel-chat"></section></main>`;
		act(() => {
			mount();
		});
		expect(
			document.getElementById("book-workbench").classList.contains("resizable"),
		).toBe(false);
		expect(document.querySelector(".col-divider")).toBeNull();
		document.body.innerHTML = "";
		expect(() => act(() => mount())).not.toThrow();
	});

	it("T19a 拖拽 clamp：<200 收 200、>420 收 420，mouseup 持久化 localStorage", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const dLeft = bench.querySelector('.col-divider[data-side="left"]');
		drag(dLeft, 300, -300);
		expect(bench.style.gridTemplateColumns.startsWith("200px 5px ")).toBe(true);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(200);
		drag(dLeft, 0, 1000);
		expect(bench.style.gridTemplateColumns.startsWith("420px 5px ")).toBe(true);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(420);
	});

	it("T19b 比例按编辑区宽度计算，收进 0.3~0.8", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const dRight = bench.querySelector('.col-divider[data-side="right"]');
		// bench 2274 / 导航 264 / 编辑 1000 → flexTotal=2000；
		// MIN_MIDDLE=420 → 0.21 触达下界 0.3；flexTotal-MIN_RIGHT=1660 → 0.83 触达上界 0.8。
		bench.getBoundingClientRect = () => rect(2274);
		bench.querySelector(".panel-left").getBoundingClientRect = () => rect(264);
		bench.querySelector(".panel-editor").getBoundingClientRect = () =>
			rect(1000);
		// bench 有宽度后助手栏带 340px 下限（2274×40% 远大于 340）
		drag(dRight, 0, -2000);
		expect(bench.style.gridTemplateColumns).toBe(
			"264px 5px minmax(0,30fr) 5px minmax(340px,70fr)",
		);
		drag(dRight, 0, 2000);
		expect(bench.style.gridTemplateColumns).toBe(
			"264px 5px minmax(0,80fr) 5px minmax(340px,20fr)",
		);
		// 中间值：编辑区 +200 → 1200/2000
		drag(dRight, 0, 200);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).ratio).toBe(0.6);
	});

	it("T19c 双击复位：divider 回默认并写 localStorage", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const dLeft = bench.querySelector('.col-divider[data-side="left"]');
		const dRight = bench.querySelector('.col-divider[data-side="right"]');
		drag(dLeft, 0, 1000);
		expect(bench.style.gridTemplateColumns.startsWith("420px")).toBe(true);
		dLeft.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(bench.style.gridTemplateColumns).toBe(DEFAULT_TEMPLATE);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(
			DEFAULT_LEFT,
		);
		dRight.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).ratio).toBe(
			DEFAULT_RATIO,
		);
	});

	it("T19d localStorage 坏 JSON / 非法值 → 回退默认；不读 v1 旧键", () => {
		buildBench();
		localStorage.setItem(STORAGE_KEY, "{bad json");
		localStorage.setItem(
			"novel-workbench-layout",
			JSON.stringify({ left: 380, ratio: 0.3 }),
		);
		act(() => {
			mount();
		});
		expect(
			document.getElementById("book-workbench").style.gridTemplateColumns,
		).toBe(DEFAULT_TEMPLATE);
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: 300, ratio: 5 }));
		document.body.innerHTML = "";
		buildBench();
		act(() => {
			mount();
		});
		expect(
			document
				.getElementById("book-workbench")
				.style.gridTemplateColumns.startsWith("264px"),
		).toBe(true);
	});

	it("T19e 折叠 class：left-collapsed / chat-collapsed 经 MutationObserver 切模板", async () => {
		buildBench("left-collapsed");
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		expect(bench.style.gridTemplateColumns).toBe(
			"minmax(0,62fr) 5px minmax(0,38fr)",
		);
		bench.classList.add("chat-collapsed");
		await new Promise((r) => setTimeout(r, 30));
		expect(bench.style.gridTemplateColumns).toBe("minmax(0,1fr)");
		bench.classList.remove("left-collapsed");
		await new Promise((r) => setTimeout(r, 30));
		expect(bench.style.gridTemplateColumns).toBe("264px 5px minmax(0,1fr)");
		bench.classList.remove("chat-collapsed");
		await new Promise((r) => setTimeout(r, 30));
		expect(bench.style.gridTemplateColumns).toBe(DEFAULT_TEMPLATE);
	});

	it("gridTemplate 纯函数：四种折叠组合", () => {
		const s = { left: 300, ratio: 0.5 };
		expect(gridTemplate(s, {})).toBe(
			"300px 5px minmax(0,50fr) 5px minmax(0,50fr)",
		);
		expect(gridTemplate(s, { leftCollapsed: true })).toBe(
			"minmax(0,50fr) 5px minmax(0,50fr)",
		);
		expect(gridTemplate(s, { chatCollapsed: true })).toBe(
			"300px 5px minmax(0,1fr)",
		);
		expect(gridTemplate(s, { leftCollapsed: true, chatCollapsed: true })).toBe(
			"minmax(0,1fr)",
		);
	});

	it("助手栏下限：340px，且不超过工作台宽度的 40%；宽度未知（隐藏/jsdom）时不设下限", () => {
		expect(chatMinWidth(0)).toBe(0);
		expect(chatMinWidth(undefined)).toBe(0);
		expect(chatMinWidth(1540)).toBe(340);
		expect(chatMinWidth(700)).toBe(280);
		const s = { left: 264, ratio: 0.62 };
		expect(gridTemplate(s, { chatMin: 340 })).toBe(
			"264px 5px minmax(0,62fr) 5px minmax(340px,38fr)",
		);
		// 收起助手时下限不参与
		expect(gridTemplate(s, { chatCollapsed: true, chatMin: 340 })).toBe(
			"264px 5px minmax(0,1fr)",
		);
	});

	it("T20 窄屏抽屉：不写内联列宽；遮罩、Esc、点章节都收起抽屉，弹窗开着时 Esc 不抢", () => {
		const original = window.matchMedia;
		window.matchMedia = (q) => ({
			matches: true,
			media: q,
			addEventListener() {},
			removeEventListener() {},
		});
		try {
			buildBench();
			document
				.getElementById("panel-left")
				.insertAdjacentHTML(
					"beforeend",
					'<ul><li class="item-row chapter-row"><span class="item-name">第一章</span></li></ul>',
				);
			act(() => {
				mount();
			});
			const bench = document.getElementById("book-workbench");
			expect(bench.style.gridTemplateColumns).toBe("");
			const backdrop = bench.querySelector(".narrow-backdrop");
			expect(backdrop).not.toBe(null);

			bench.classList.add("nav-drawer-open");
			backdrop.click();
			expect(bench.classList.contains("nav-drawer-open")).toBe(false);

			bench.classList.add("chat-drawer-open");
			document.body.insertAdjacentHTML(
				"beforeend",
				'<div role="dialog" data-state="open" id="dlg"></div>',
			);
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			expect(bench.classList.contains("chat-drawer-open")).toBe(true);
			document.getElementById("dlg").remove();
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			expect(bench.classList.contains("chat-drawer-open")).toBe(false);

			bench.classList.add("nav-drawer-open");
			bench.querySelector(".chapter-row .item-name").click();
			expect(bench.classList.contains("nav-drawer-open")).toBe(false);
		} finally {
			window.matchMedia = original;
		}
	});
});
