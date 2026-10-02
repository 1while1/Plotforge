// @vitest-environment jsdom
// S5-4 红测 R11~R13（Plan §4）：WorldWorkbenchPanel——public/legacy/world-workbench.js（109 行）
// 随 D-S4-9-01 迁移块等值迁 React（D-S3-3-01 既定「随 workbench-shell/workspace-state 一并迁」）。
// 断言语义锚点＝legacy 活代码行号：
//   :10-12 缺失实体空态／:15 目录行 60 字截断＋暂无内容／:16-20 整壳结构／:21-29 搜索不重建 input（IME 契约）／
//   :30-33 分页（MozhenPager.slice → ListPager slice 直 import）／:35 新建弹窗 opts 逐字／
//   :44 删除 confirm 逐字／:48-67 保存三态 toast 逐字＋tracker settle／:69-80 守卫 key 'world'／
//   :82-101 load 竞态双绑＋tracker.clear／:102-108 show 三重置＋错误态。
// harness：jsdom＋React 19 act＋裸 DOM（不装 @testing-library）；window.WorkspaceState＝frontend/lib 真件
// （守卫/脏标记/竞态令牌走真语义）；window.App 桩（api/toast/openModal/state），confirm 桩。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import {
	createWorkspaceState,
	setWorkspaceStateForTests,
} from "../lib/workspace-state.js";
import WorldWorkbenchPanel, {
	resetWorldQueryForTest,
} from "./WorldWorkbenchPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROUTE = { bookId: "7", module: "world", entityId: "31", tab: null };

function freshEntries() {
	return [
		{ id: 31, title: "世界规则", content: "规则正文" },
		{ id: 32, title: "第二设定", content: "" },
	];
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let apiCalls;
let toasts;
let apiImpl;
let modals;
let confirmed;
let ws;
let roots;

async function flush(n = 8) {
	for (let i = 0; i < n; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mountPanel(route = ROUTE) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(<WorldWorkbenchPanel route={route} />);
	});
	await flush();
	return { container, root };
}

function byId(id) {
	return document.getElementById(id);
}

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(form) {
	form.dispatchEvent(
		new window.Event("submit", { bubbles: true, cancelable: true }),
	);
}

beforeEach(() => {
	document.body.innerHTML = "";
	apiCalls = [];
	toasts = [];
	apiImpl = null;
	modals = [];
	confirmed = true;
	roots = [];
	window.App = {
		state: {},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml(s) {
			// 整改 F1（Review-S5-4）：真转义桩（照 WorkbenchPage.test.jsx:210-222 口径）——
			// 恒等桩会让「预转义后再进 React 文本节点」的双重转义在测试里结构性不可见。
			return String(s == null ? "" : s).replace(
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
		openModal(opts) {
			modals.push(opts);
		},
		async api(method, path, body) {
			apiCalls.push([method, path, body]);
			if (apiImpl) return apiImpl(method, path, body);
			throw new Error(`no stub: ${method} ${path}`);
		},
	};
	ws = createWorkspaceState();
	window.WorkspaceState = ws;
	resetWorldQueryForTest();
	window.confirm = vi.fn(() => confirmed);
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	vi.restoreAllMocks();
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
	setWorkspaceStateForTests(window.WorkspaceState);
});

afterEach(() => {
	setAppForTests(null);
	setWorkspaceStateForTests(null);
});

describe("R11 世界面板 D1~D3：列表/搜索 IME 契约/分页/新建（legacy :13-45）", () => {
	it("D1 目录列表：行结构、60 字截断、暂无内容、选中 active（:15）", async () => {
		const long = "甲".repeat(80);
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				return {
					entries: [
						{ id: 31, title: "世界规则", content: long },
						{ id: 32, title: "第二设定", content: "" },
					],
				};
			return {};
		};
		await mountPanel();
		const rows = document.querySelectorAll("#world-entry-list [data-world-id]");
		expect(rows.length).toBe(2);
		expect(rows[0].tagName).toBe("BUTTON");
		expect(rows[0].className).toBe("world-entry-row active");
		expect(rows[0].querySelector("strong").textContent).toBe("世界规则");
		expect(rows[0].querySelector("span").textContent).toBe("甲".repeat(60));
		expect(rows[1].className).toBe("world-entry-row");
		expect(rows[1].querySelector("span").textContent).toBe("暂无内容");
		// 点第二行：选中随之切换（:31 find by data-world-id → render）
		await act(async () => {
			rows[1].click();
		});
		expect(
			document.querySelector("#world-entry-list .world-entry-row.active")
				.dataset.worldId,
		).toBe("32");
		expect(byId("world-entry-title").value).toBe("第二设定");
	});

	it("D2 搜索过滤＋不重建 #world-search 节点（IME 契约，:21-29/:36）", async () => {
		apiImpl = async () => ({
			entries: [
				{ id: 31, title: "世界规则", content: "规则正文" },
				{ id: 32, title: "第二设定", content: "" },
			],
		});
		await mountPanel();
		const search = byId("world-search");
		expect(search.placeholder).toBe("搜索设定");
		await act(async () => {
			setInputValue(search, "第二");
		});
		expect(
			document.querySelectorAll("#world-entry-list [data-world-id]").length,
		).toBe(1);
		expect(byId("world-search")).toBe(search); // 同一 DOM 节点：组合中的拼音不被强制上屏
		await act(async () => {
			setInputValue(search, "");
		});
		expect(
			document.querySelectorAll("#world-entry-list [data-world-id]").length,
		).toBe(2);
	});

	it("D3 分页：>30 条 slice 收拢＋ListPager 渲染；搜索后回第 1 页（:15/:32/:36）", async () => {
		const many = Array.from({ length: 33 }, (_, i) => ({
			id: 100 + i,
			title: `设定${i}`,
			content: "x",
		}));
		apiImpl = async () => ({ entries: many });
		await mountPanel(ROUTE);
		expect(
			document.querySelectorAll("#world-entry-list [data-world-id]").length,
		).toBe(30);
		const pager = byId("world-entry-pager");
		expect(pager.querySelector(".list-pager-meta").textContent).toBe(
			"第 1 / 2 页 · 共 33 条",
		);
		await act(async () => {
			pager.querySelector("[data-page-next]").click();
		});
		await flush();
		expect(
			document.querySelector("#world-entry-list [data-world-id]").dataset
				.worldId,
		).toBe("130");
		await act(async () => {
			setInputValue(byId("world-search"), "设定1");
		});
		// 命中 11 条（设定1、设定10~设定19）≤ 一页：分页器不渲染（等值 ListPager 总数不超页时为 ''）
		expect(
			document.querySelectorAll("#world-entry-list [data-world-id]").length,
		).toBe(11);
		expect(byId("world-entry-pager").querySelector(".list-pager")).toBeNull();
	});

	it("D4 新建：openModal opts 逐字＋POST body＋tracker.clear＋load 新 id（:35）", async () => {
		const store = freshEntries();
		apiImpl = async (method, path, body) => {
			if (method === "GET" && path === "/api/books/7/world")
				return { entries: store.map((e) => ({ ...e })) };
			if (method === "POST" && path === "/api/books/7/world") {
				expect(body).toEqual({ title: "新设定", content: "" });
				const entry = { id: 33, title: "新设定", content: "" };
				store.push(entry); // legacy stub 同口径：POST 后列表含新条目
				return { entry };
			}
			return {};
		};
		await mountPanel();
		expect(modals.length).toBe(0);
		await act(async () => {
			byId("new-world-entry").click();
		});
		expect(modals.length).toBe(1);
		expect(modals[0].title).toBe("新建设定");
		expect(modals[0].okText).toBe("创建");
		expect(modals[0].bodyHTML).toBe(
			'<label>名称<input id="new-world-title"></label>',
		);
		// legacy onOk(body)：body.querySelector('#new-world-title').value
		const bodyEl = document.createElement("div");
		bodyEl.innerHTML = modals[0].bodyHTML;
		bodyEl.querySelector("#new-world-title").value = "新设定";
		await act(async () => {
			await modals[0].onOk(bodyEl);
		});
		await flush();
		expect(apiCalls.filter(([m]) => m === "POST").length).toBe(1);
		expect(byId("world-entry-title").value).toBe("新设定"); // load(res.entry.id) 选中新条目
	});
});

describe("R12 世界面板 D5~D7：删除/保存三态/空态（legacy :44-67）", () => {
	it("D5 删除：confirm 逐字＋DELETE＋load(null)；取消零请求（:44）", async () => {
		const store = freshEntries();
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				return { entries: store.map((e) => ({ ...e })) };
			if (method === "DELETE") {
				const i = store.findIndex((e) => String(e.id) === "31");
				if (i >= 0) store.splice(i, 1); // legacy stub 同口径：删后列表不含该条
				return { ok: true };
			}
			return {};
		};
		await mountPanel();
		const before = apiCalls.length;
		confirmed = false;
		await act(async () => {
			byId("delete-world-entry").click();
		});
		await flush();
		expect(window.confirm).toHaveBeenCalledWith("删除这条世界设定？");
		expect(apiCalls.length).toBe(before); // 取消：零请求
		confirmed = true;
		await act(async () => {
			byId("delete-world-entry").click();
		});
		await flush();
		expect(
			apiCalls.some(
				([m, p]) => m === "DELETE" && p === "/api/books/7/world/31",
			),
		).toBe(true);
		// load(null)：未选中时回落到剩余第一条（legacy :96 state.selected = entries[0]）
		expect(byId("world-entry-title").value).toBe("第二设定");
		expect(
			byId("world-entry-list").querySelectorAll("[data-world-id]").length,
		).toBe(1);
	});

	it("D6 保存三态：成功清脏＋toast；失败 503 保留 dirty；期间新输入 settle=false（:48-67）", async () => {
		let putImpl = async () => ({
			entry: { id: 31, title: "改", content: "改正文" },
		});
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				return { entries: [{ id: 31, title: "改", content: "改正文" }] };
			if (method === "PUT") return putImpl(method, path);
			return {};
		};
		await mountPanel();
		const guard = ws.guards().find((g) => g.key === "world");
		// 成功路径（:63-66）
		await act(async () => {
			setInputValue(byId("world-entry-title"), "改");
		});
		expect(guard.isDirty()).toBe(true);
		await act(async () => {
			submitForm(document.getElementById("world-entry-form"));
		});
		await flush();
		expect(toasts.at(-1)).toBe("世界设定已保存");
		expect(guard.isDirty()).toBe(false); // load 后 tracker.clear（:99）
		expect(byId("world-entry-title").value).toBe("改");
		// 失败路径（:54-58）
		putImpl = async () => {
			throw new Error("503 PERSISTENCE_PENDING");
		};
		await act(async () => {
			setInputValue(byId("world-entry-title"), "改2");
		});
		await act(async () => {
			submitForm(document.getElementById("world-entry-form"));
		});
		await flush();
		expect(toasts.at(-1)).toBe(
			"保存失败（世界设定未保存）：503 PERSISTENCE_PENDING，修改仍留在表单里",
		);
		expect(guard.isDirty()).toBe(true);
		expect(byId("world-entry-title").value).toBe("改2"); // 修改仍留在表单里
		// 保存期间又有新输入（settle 失败，:59-62）
		const gate = deferred();
		putImpl = async () => gate.promise;
		await act(async () => {
			submitForm(document.getElementById("world-entry-form"));
		});
		await act(async () => {
			setInputValue(byId("world-entry-title"), "改3");
		});
		await act(async () => {
			gate.resolve({ entry: { id: 31, title: "改3", content: "x" } });
		});
		await flush();
		expect(toasts.at(-1)).toBe(
			"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
		);
		expect(guard.isDirty()).toBe(true);
	});

	it("D7 空态：已删除实体 data-world-missing＋未选中空态（:10-12/:18）", async () => {
		apiImpl = async () => ({ entries: freshEntries() });
		await mountPanel({ ...ROUTE, entityId: "999" });
		const missing = document.querySelector("[data-world-missing]");
		expect(missing).not.toBeNull();
		expect(missing.getAttribute("data-world-missing")).toBe("999");
		expect(missing.textContent).toContain("这条设定已不在本书中");
		expect(missing.textContent).toContain("未自动切换到其他设定或别的书");
		expect(missing.textContent).toContain("#999");
		expect(byId("world-entry-title")).toBeNull(); // 不自动落到第一条
	});

	it("D8 未选中空态＋编辑表单节点全集（:18）", async () => {
		apiImpl = async () => ({ entries: [] });
		await mountPanel({ ...ROUTE, entityId: null });
		expect(document.querySelector(".world-editor h2").textContent).toBe(
			"选择一条设定",
		);
		expect(document.querySelector(".world-editor p").textContent).toBe(
			"在这里维护规则、地点、势力、物件与历史。",
		);
		apiImpl = async () => ({ entries: freshEntries() });
		await mountPanel();
		expect(byId("delete-world-entry").textContent).toBe("删除");
		expect(byId("world-entry-content").rows).toBe(24);
		expect(
			document.querySelector(".profile-sheet-head .workbench-kicker")
				.textContent,
		).toBe("SETTING ENTRY");
	});
});

describe("R13 世界面板 D9~D10：守卫/竞态/错误态（legacy :69-108）", () => {
	it("D9 守卫：clearGuards('world') 后注册 key/label/save/discard，输入即脏（:69-80）", async () => {
		apiImpl = async () => ({ entries: freshEntries() });
		await mountPanel();
		const guards = ws.guards();
		expect(guards.filter((g) => g.key === "world").length).toBe(1);
		expect(guards[0].label).toBe("世界观工作台");
		expect(typeof guards[0].save).toBe("function");
		expect(typeof guards[0].discard).toBe("function");
		expect(guards[0].isDirty()).toBe(false);
		await act(async () => {
			setInputValue(byId("world-entry-content"), "脏了");
		});
		expect(guards[0].isDirty()).toBe(true);
		await act(async () => {
			guards[0].discard();
		});
		expect(guards[0].isDirty()).toBe(false);
		// 重挂＝旧 show() 的 installGuard 语义：clearGuards('world') 后仍恰一条 world 守卫
		const { root, container } = await mountPanel();
		await flush();
		expect(ws.guards().filter((g) => g.key === "world").length).toBe(1);
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("D10 竞态：晚到响应丢弃（换书）＋load 后 tracker.clear（:82-101）", async () => {
		const gate7 = deferred();
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				return gate7.promise;
			if (method === "GET" && path === "/api/books/8/world")
				return { entries: [{ id: 81, title: "书八设定", content: "" }] };
			return {};
		};
		const { root } = await mountPanel();
		await flush(2);
		expect(byId("world-entry-list").textContent).toBe(""); // 仍在等书七
		await act(async () => {
			root.render(
				<WorldWorkbenchPanel
					route={{ ...ROUTE, bookId: "8", entityId: null }}
				/>,
			);
		});
		await flush();
		await act(async () => {
			gate7.resolve({ entries: [{ id: 31, title: "书七设定", content: "" }] });
		});
		await flush();
		expect(byId("world-entry-list").textContent).toContain("书八设定"); // 晚到的书七结果被丢弃
		expect(byId("world-entry-list").textContent).not.toContain("书七设定");
	});

	it("D11 错误态：GET 世界设定失败渲染 .workbench-error（:107）", async () => {
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				throw new Error("世界设定读取失败");
			return {};
		};
		await mountPanel();
		const err = document.querySelector(".workbench-error");
		expect(err).not.toBeNull();
		expect(err.textContent).toBe("世界设定读取失败");
	});

	it("D12 特殊字符不双重转义：& < > \" ' 五字符在目录/详情/错误态按原文显示（legacy :11/:15 拼 innerHTML 后由浏览器解码的等值面；整改 F1）", async () => {
		const FIVE = '龙 & "凤" <规则>';
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				return { entries: [{ id: 31, title: FIVE, content: FIVE }] };
			return {};
		};
		await mountPanel();
		const row = document.querySelector(
			"#world-entry-list [data-world-id='31']",
		);
		const strong = row.querySelector("strong");
		const span = row.querySelector("span");
		// 目录行（legacy :15 拼 innerHTML → 浏览器解码显示原文）
		expect(strong.textContent).toBe(FIVE);
		expect(span.textContent).toBe(FIVE);
		// 详情（legacy :15 详情标题同源）
		expect(document.querySelector(".world-editor h2").textContent).toBe(FIVE);
		expect(byId("world-entry-title").value).toBe(FIVE);
		// 双重转义的具体形态（&amp;/&quot;/&#39;/&lt;/&gt;）一律不得出现在可见文本里
		for (const text of [strong.textContent, span.textContent]) {
			for (const entity of ["&amp;", "&quot;", "&#39;", "&lt;", "&gt;"]) {
				expect(text).not.toContain(entity);
			}
		}
		// 错误态同口径（:107）：escapeHtml 真件下不得「先转义再进 React 文本节点」
		apiImpl = async (method, path) => {
			if (method === "GET" && path === "/api/books/7/world")
				throw new Error(FIVE);
			return {};
		};
		await mountPanel();
		expect(document.querySelector(".workbench-error").textContent).toBe(FIVE);
	});
});
