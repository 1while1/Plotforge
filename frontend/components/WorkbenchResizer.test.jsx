// @vitest-environment jsdom
// S3-1 红测（Plan §4 T18~T19）：WorkbenchResizer 自挂载——注入两条 .col-divider
// （dataset/role/aria/title 逐字）、bench 加 resizable、默认模板串逐字
// （DEFAULT_LEFT=260 / DEFAULT_RATIO=1/2.2 / DIVIDER_W=5）、缺子面板/缺 bench 安全
// return、幂等；拖拽 clamp（200~420）、双击复位写 localStorage、坏 JSON 回退默认、
// 折叠 class 切折叠分支模板。jsdom 几何全 0：clamp 边界经零基线+大位移确定性触发。

import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "./WorkbenchResizer.jsx";

const STORAGE_KEY = "novel-workbench-layout";

function buildBench(collapsed = false) {
	document.body.innerHTML = `<main id="book-workbench" class="workbench${collapsed ? " left-collapsed" : ""}"><aside id="panel-left" class="panel panel-left"></aside><section class="panel panel-center"></section><div class="panel panel-chat"></div></main>`;
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

beforeEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

describe("WorkbenchResizer（自挂载分栏）", () => {
	it("T18a mount：两条 divider 注入位置/dataset/role/aria/title 逐字；resizable；默认模板逐字", () => {
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
		expect(dRight.previousElementSibling.className).toContain("panel-chat");
		for (const d of dividers) {
			expect(d.getAttribute("role")).toBe("separator");
			expect(d.getAttribute("aria-orientation")).toBe("vertical");
		}
		expect(dLeft.dataset.side).toBe("left");
		expect(dLeft.title).toBe("拖拽调整侧栏宽度 · 双击恢复默认");
		expect(dRight.dataset.side).toBe("right");
		expect(dRight.title).toBe("拖拽调整聊天栏宽度 · 双击恢复默认");
		const a = 1 / 2.2;
		const b = 1 - 1 / 2.2;
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a}fr) 5px minmax(0,${b}fr)`,
		);
	});

	it("T18b 幂等；缺 .panel-left/.panel-chat 或缺 bench 时安全 return", () => {
		buildBench();
		act(() => {
			mount();
		});
		mount();
		expect(document.querySelectorAll(".col-divider").length).toBe(2);
		document.body.innerHTML = `<main id="book-workbench" class="workbench"></main>`;
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
		// 零基线 -600 → clamp 200
		drag(dLeft, 300, -300);
		expect(bench.style.gridTemplateColumns.startsWith("200px 5px ")).toBe(true);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(200);
		// 零基线 +1000 → clamp 420
		drag(dLeft, 0, 1000);
		expect(bench.style.gridTemplateColumns.startsWith("420px 5px ")).toBe(true);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(420);
	});

	it("T19b ratio clamp：右 divider 拖拽收进 0.2~0.8", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const dRight = bench.querySelector('.col-divider[data-side="right"]');
		// 伪造几何（jsdom 全 0 无法同时触达 ratio 双边界）：bench 2270 / 左栏 260 /
		// 中栏 1000 → flexTotal=2000；MIN_MIDDLE=320→320/2000=0.16 触达下界；
		// middle≤flexTotal-MIN_RIGHT=1640→1640/2000=0.82 触达上界。
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
		bench.getBoundingClientRect = () => rect(2270);
		bench.querySelector(".panel-left").getBoundingClientRect = () => rect(260);
		bench.querySelector(".panel-chat").getBoundingClientRect = () => rect(1000);
		// 大负位移：middle 收到 320 → ratio clamp 0.2
		drag(dRight, 0, -2000);
		const a1 = 0.2;
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a1}fr) 5px minmax(0,${1 - a1}fr)`,
		);
		// 大正位移：middle 收到 1640 → 0.82 → ratio clamp 0.8（b=1-0.8 浮点残差照实断言）
		drag(dRight, 0, 2000);
		const a2 = 0.8;
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a2}fr) 5px minmax(0,${1 - a2}fr)`,
		);
	});

	it("T19c 双击复位：divider 回默认并写 localStorage", () => {
		buildBench();
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const dLeft = bench.querySelector('.col-divider[data-side="left"]');
		const dRight = bench.querySelector('.col-divider[data-side="right"]');
		drag(dLeft, 0, 1000); // 先拖到 420
		expect(bench.style.gridTemplateColumns.startsWith("420px")).toBe(true);
		dLeft.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		const a = 1 / 2.2;
		const b = 1 - 1 / 2.2;
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a}fr) 5px minmax(0,${b}fr)`,
		);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).left).toBe(260);
		dRight.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).ratio).toBe(1 / 2.2);
	});

	it("T19d localStorage 坏 JSON / 非法值 → 回退默认", () => {
		buildBench();
		localStorage.setItem(STORAGE_KEY, "{bad json");
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const a = 1 / 2.2;
		const b = 1 - 1 / 2.2;
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a}fr) 5px minmax(0,${b}fr)`,
		);
		localStorage.clear();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: 300, ratio: 5 }));
		document.body.innerHTML = "";
		buildBench();
		act(() => {
			mount();
		});
		const bench2 = document.getElementById("book-workbench");
		expect(bench2.style.gridTemplateColumns.startsWith("260px")).toBe(true);
	});

	it("T19e 折叠 class：初始 left-collapsed → 折叠分支模板；移除后经 MutationObserver 切回", async () => {
		buildBench(true);
		act(() => {
			mount();
		});
		const bench = document.getElementById("book-workbench");
		const a = 1 / 2.2;
		const b = 1 - 1 / 2.2;
		expect(bench.style.gridTemplateColumns).toBe(
			`minmax(0,${a}fr) 5px minmax(0,${b}fr)`,
		);
		bench.classList.remove("left-collapsed");
		await new Promise((r) => setTimeout(r, 50));
		expect(bench.style.gridTemplateColumns).toBe(
			`260px 5px minmax(0,${a}fr) 5px minmax(0,${b}fr)`,
		);
	});
});
