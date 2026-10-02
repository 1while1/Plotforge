// @vitest-environment jsdom
// S3-1 红测（Plan §4 T13~T15）：SidebarConfigDialog——行序/勾选态渲染、行操作边界、
// 确定组装 {moduleOrder, hiddenModules, summaryFields}（等价旧 readModal 形状）、
// 桥级保存流：PUT /api/books/:id/sidebar-preferences → apply 副作用（tabs 重排/
// App.state 写入/死事件 dispatch）→ toast「侧栏布局已保存」→ Modal 关闭。
// mock window.App（api/state），弹窗壳节点同 Modal 测试桩（含 #card-editor 契约坑锚）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import SidebarConfigDialog, {
	load as sidebarConfigLoad,
	open as sidebarConfigOpen,
} from "./SidebarConfigDialog.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PREFS = {
	moduleOrder: ["chapters", "outline", "ledger", "world", "characters"],
	hiddenModules: ["world"],
	summaryFields: {
		chapters: ["title", "volume"],
		outline: ["mainPlot"],
		ledger: ["progress", "pendingCount"],
		world: ["name"],
		characters: ["name", "role", "intro", "location", "goal"],
	},
};

// 弹窗壳（同 index.html:818~829）+ 侧栏 tabs/panes（apply 副作用面）+ #toast
function buildShell() {
	document.body.innerHTML = `
<div id="modal-mask" class="modal-mask hidden"><div class="modal"><h3 id="modal-title"></h3><div id="modal-body"></div><div class="modal-actions"><button id="modal-cancel" class="btn btn-ghost">取消</button><button id="modal-ok" class="btn btn-primary">确定</button></div></div></div>
<div id="card-editor" class="modal-mask hidden"><div class="modal"><div class="modal-body card-editor-body"></div></div></div>
<div id="toast" class="toast hidden"></div>
<aside id="panel-left" class="panel panel-left"><div class="tabs"><button class="tab active" data-tab="chapters">章节</button><button class="tab" data-tab="outline">大纲</button><button class="tab" data-tab="state">状态</button><button class="tab" data-tab="world">世界观</button><button class="tab" data-tab="characters">人物</button></div>
<div id="tab-chapters" class="tab-pane"></div><div id="tab-outline" class="tab-pane"></div><div id="tab-state" class="tab-pane"></div><div id="tab-world" class="tab-pane"></div><div id="tab-characters" class="tab-pane"></div></aside>`;
}
const $ = (id) => document.getElementById(id);

function mountDialog(props) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	act(() => {
		createRoot(container).render(<SidebarConfigDialog {...props} />);
	});
	return container;
}

let apiCalls = [];
let apiImpl = null;

beforeEach(() => {
	buildShell();
	apiCalls = [];
	apiImpl = null;
	window.App = {
		state: { currentBook: { id: 7 }, sidebarPreferences: null },
		api: (method, path, body) => {
			apiCalls.push({ method, path, body });
			if (apiImpl) return apiImpl(method, path, body);
			return Promise.resolve({ preferences: PREFS });
		},
	};
	// P6-2：侧栏配置桥体已搬入本组件（§2.5-D5），其 App 取用改走 `lib/app-runtime.js` 单例直取，
	// 故 harness 经 setAppForTests 注入同一桩（T15b 的 put path `/api/books/7/…` 依赖 currentBook）
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("SidebarConfigDialog 组件层", () => {
	it("T13 渲染：行序===moduleOrder；label 文案逐字；字段勾选态回显 summaryFields；提示行逐字", () => {
		mountDialog({ preferences: PREFS, onConfirm: () => {} });
		const body = $("modal-body");
		const rows = Array.from(body.querySelectorAll(".sidebar-config-row"));
		expect(rows.map((r) => r.dataset.module)).toEqual([
			"chapters",
			"outline",
			"ledger",
			"world",
			"characters",
		]);
		expect(rows.map((r) => r.querySelector("strong").textContent)).toEqual([
			"章节",
			"大纲",
			"故事台账",
			"世界观",
			"人物",
		]);
		expect(body.querySelector(".field-hint").textContent).toBe(
			"调整模块顺序、显隐和速览字段。章节入口始终保留。",
		);
		// 勾选态回显：chapters 行 title/volume 勾、locked 不勾
		const chRow = rows[0];
		expect(chRow.querySelector('[data-field="title"]').checked).toBe(true);
		expect(chRow.querySelector('[data-field="volume"]').checked).toBe(true);
		expect(chRow.querySelector('[data-field="locked"]').checked).toBe(false);
		// 显示勾选态：world 未勾（hiddenModules），chapters 勾且 disabled
		const visibleByModule = Object.fromEntries(
			rows.map((r) => [r.dataset.module, r.querySelector("[data-visible]")]),
		);
		expect(visibleByModule.world.checked).toBe(false);
		expect(visibleByModule.chapters.checked).toBe(true);
		expect(visibleByModule.chapters.disabled).toBe(true);
	});

	it("T14a 行操作：index=0 ↑ disabled、末位 ↓ disabled；move-up 行序交换", () => {
		mountDialog({ preferences: PREFS, onConfirm: () => {} });
		const rows = () =>
			Array.from($("modal-body").querySelectorAll(".sidebar-config-row"));
		expect(rows()[0].querySelector(".move-up").disabled).toBe(true);
		expect(rows()[rows().length - 1].querySelector(".move-down").disabled).toBe(
			true,
		);
		expect(rows()[1].querySelector(".move-up").disabled).toBe(false);
		// 第二行上移：outline 提到首位
		act(() => {
			rows()[1].querySelector(".move-up").click();
		});
		expect(rows().map((r) => r.dataset.module)).toEqual([
			"outline",
			"chapters",
			"ledger",
			"world",
			"characters",
		]);
	});

	it("T14b 取消勾选「显示」→ hiddenModules 收录；chapters 恒 disabled；确定组装数据形状逐字段等价 readModal", () => {
		const onConfirm = vi.fn(() => Promise.resolve());
		mountDialog({ preferences: PREFS, onConfirm });
		const rows = () =>
			Array.from($("modal-body").querySelectorAll(".sidebar-config-row"));
		// 取消勾选 world 的显示（原本已 hidden → 点击变勾选 → 从 hiddenModules 移除）
		act(() => {
			rows()[3].querySelector("[data-visible]").click();
		});
		// 再取消勾选 characters 的显示 → 收录
		act(() => {
			rows()[4].querySelector("[data-visible]").click();
		});
		// 勾上 chapters 行的 locked 字段
		act(() => {
			rows()[0].querySelector('[data-field="locked"]').click();
		});
		// 同步 act（onConfirm spy 同步捕获 collect() 数据；不得返回 promise——悬空
		// act 域会与后续测试的 act 交错，T15b 曾因此断言失败）
		act(() => {
			$("modal-ok").click();
		});
		expect(onConfirm).toHaveBeenCalledTimes(1);
		const data = onConfirm.mock.calls[0][0];
		expect(Object.keys(data).sort()).toEqual([
			"hiddenModules",
			"moduleOrder",
			"summaryFields",
		]);
		expect(data.moduleOrder).toEqual([
			"chapters",
			"outline",
			"ledger",
			"world",
			"characters",
		]);
		expect(data.hiddenModules).toEqual(["characters"]);
		// summaryFields 键序随 moduleOrder、字段键序随 fields 定义键序（等价 DOM 序收集）
		expect(data.summaryFields.chapters).toEqual(["title", "volume", "locked"]);
		expect(data.summaryFields.outline).toEqual(["mainPlot"]);
		expect(data.summaryFields.ledger).toEqual(["progress", "pendingCount"]);
		expect(data.summaryFields.world).toEqual(["name"]);
		expect(data.summaryFields.characters).toEqual([
			"name",
			"role",
			"intro",
			"location",
			"goal",
		]);
	});

	it("T15 组件级：确定后 Modal 关闭（mask hidden、body 清空）", async () => {
		const onConfirm = vi.fn(() => Promise.resolve());
		mountDialog({ preferences: PREFS, onConfirm });
		await act(async () => {
			$("modal-ok").click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		expect($("modal-body").childElementCount).toBe(0);
	});
});

describe("SidebarConfigDialog 桥级（window.MozhenSidebarConfig）", () => {
	it("T15b 桥保存流：open → 确定 → PUT 形状 → apply 副作用（tabs 重排/state 写入/死事件）→ toast → 关闭", async () => {
		apiImpl = (method, _path, _body) => {
			if (method === "GET") return Promise.resolve({ preferences: PREFS });
			return Promise.resolve({
				preferences: {
					moduleOrder: ["outline", "chapters", "ledger", "world", "characters"],
					hiddenModules: ["world"],
					summaryFields: PREFS.summaryFields,
				},
			});
		};
		const deadEventSpy = vi.fn();
		document.addEventListener("sidebar-preferences-changed", deadEventSpy);
		await act(async () => {
			await sidebarConfigLoad();
		});
		// load 即 apply：GET 后 tabs 重排（PREFS 顺序 === 静态顺序，无从观察重排——以 dataset/App.state 取证）
		expect(window.App.state.sidebarPreferences).toEqual(PREFS);
		expect($("tab-outline").dataset.summaryFields).toBe("mainPlot");
		expect(deadEventSpy).toHaveBeenCalled();

		act(() => {
			sidebarConfigOpen();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		expect($("modal-title").textContent).toBe("调整写作侧栏");
		expect($("modal-ok").textContent).toBe("保存布局");

		await act(async () => {
			$("modal-ok").click();
			await new Promise((r) => setTimeout(r, 0));
		});
		const put = apiCalls.find((c) => c.method === "PUT");
		expect(put).toBeDefined();
		expect(put.path).toBe("/api/books/7/sidebar-preferences");
		expect(Object.keys(put.body).sort()).toEqual([
			"hiddenModules",
			"moduleOrder",
			"summaryFields",
		]);
		// apply(服务端 preferences)：tabs 重排——outline 提到首位、其 label 文案
		const tabs = Array.from($("panel-left").querySelectorAll(".tabs .tab"));
		expect(tabs[0].dataset.tab).toBe("outline");
		expect(tabs[0].textContent).toBe("大纲");
		expect(window.App.state.sidebarPreferences.moduleOrder[0]).toBe("outline");
		expect(deadEventSpy).toHaveBeenCalledTimes(2); // load 一次 + 保存后一次
		expect($("toast").textContent).toBe("侧栏布局已保存");
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		expect($("modal-body").childElementCount).toBe(0);
		expect(
			deadEventSpy.mock.calls.every((call) => call[0].detail !== undefined),
		).toBe(true);
	});
});
