// @vitest-environment jsdom
// S4-3 红测（Plan §4 T-A）：CharacterWorkbenchPanel——断言语义锚点＝
// public/legacy/character-workbench.js 行号（Plan §4 T-A 表逐条）。
// S5-4 面板契约笔：旧壳 workbench-shell.js（217 行）与旧名桥 window.CharacterWorkbench 随
// D-S4-9-01 迁移块整体退役，本文件挂载机制由 window.CharacterWorkbench.show(route) 机械替换为
// 本地 createRoot 直渲染（一次挂载＝一次全量重入重拉）；旧「shell 整块重写 #workbench-content
// 后弃旧建新」前提消失，其等价保护由 WorkbenchPage.test.jsx W6（外壳 key 重挂）承接。其余断言逐字不动。
// harness（CharacterAdvisorPanel.test.jsx/CardsPage.test.jsx 同款）：jsdom＋React 19 act＋裸 DOM 断言；
// window.WorkspaceState mock 为 workspace-state.js:210-283 的逐字语义移植（epochs/dirtyTracker/guards），
// 使守卫与竞态令牌断言走真语义而非空壳；window.App.openModal mock 同步渲染 bodyHTML 进
// #modal-body（legacy 弹窗壳契约，关系/别名/新建弹窗 onOk 后读其 DOM）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { setWorkspaceStateForTests } from "../lib/workspace-state.js";
import { CharacterWorkbenchPanel } from "./CharacterWorkbenchPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/books/B1";
const ROUTE = { bookId: "B1", entityId: "5", tab: "profile" };

function freshRoster() {
	return [
		{ id: 5, name: "林晚", role: "主角", intro: "女主角简介" },
		{ id: 6, name: "陈默", role: "配角", intro: "配角简介" },
	];
}

function freshAliases() {
	return [
		{ alias: "林晚", alias_type: "primary", is_primary: true },
		{ alias: "阿晚", alias_type: "nickname", is_primary: false },
	];
}

function freshRelations() {
	return [
		{
			public_id: "rel-1",
			endpoint_a: { id: 5, name: "林晚" },
			endpoint_b: { id: 6, name: "陈默" },
			relation_type: {
				id: 1,
				forward_label: "师徒",
				reverse_label: "徒弟",
				label_from_focus: "师父",
			},
			strength: 4,
			polarity: "positive",
			lifecycle: "active",
			secrecy: "public",
			note: "备注一",
		},
	];
}

function makeDeferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let rosterFixture;
let relationsFixture;
let charactersFail;
let patchFail;
let deferredPatch;
let holdProfileGets;
let heldProfile;
let nextCreateId;
let apiCalls;
let toasts;
let lastModal;
let seqLog;

// WorkspaceState mock：workspace-state.js:210-283 逐字语义（守卫/竞态令牌），seqLog 记调用序
function makeWorkspaceStateMock() {
	const guards = [];
	const epochs = {};
	return {
		beginRequest(scope, target) {
			seqLog.push(`ws:beginRequest:${scope}:${target}`);
			const key = String(scope == null ? "" : scope);
			const seq = (epochs[key] || 0) + 1;
			epochs[key] = seq;
			return {
				scope: key,
				target: target == null ? "" : String(target),
				id: seq,
			};
		},
		isCurrent(token, target) {
			seqLog.push(`ws:isCurrent:${token ? token.scope : ""}`);
			if (!token) return false;
			if (epochs[token.scope] !== token.id) return false;
			if (
				target !== undefined &&
				String(target == null ? "" : String(target)) !== token.target
			)
				return false;
			return true;
		},
		dirtyTracker() {
			let generation = 0;
			let dirty = false;
			return {
				mark() {
					generation += 1;
					dirty = true;
					return generation;
				},
				snapshot() {
					return generation;
				},
				isDirty() {
					return dirty;
				},
				settle(token, ok) {
					if (ok === true && token === generation) dirty = false;
					return dirty === false;
				},
				clear() {
					dirty = false;
				},
			};
		},
		registerGuard(guard) {
			seqLog.push("ws:registerGuard");
			if (!guard?.key) return null;
			guards.push(guard);
			return guard;
		},
		clearGuards(filter) {
			seqLog.push("ws:clearGuards");
			const before = guards.length;
			for (let i = guards.length - 1; i >= 0; i--) {
				if (typeof filter === "function" ? filter(guards[i]) : true)
					guards.splice(i, 1);
			}
			return before - guards.length;
		},
		guards: () => guards.slice(),
		hasDirty: () =>
			guards.some((g) => typeof g.isDirty === "function" && g.isDirty()),
	};
}

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	seqLog.push(`api:${method}:${path}`);
	if (method === "GET" && path === `${BASE}/sidebar-preferences`) {
		return Promise.resolve({
			preferences: { summaryFields: { characters: ["name", "role", "intro"] } },
		});
	}
	if (method === "GET" && path === `${BASE}/characters?limit=200`) {
		if (charactersFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({ items: rosterFixture });
	}
	if (
		method === "GET" &&
		path === `${BASE}/characters?limit=200&archived=true`
	) {
		if (charactersFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({ items: rosterFixture });
	}
	if (
		method === "GET" &&
		path === `${BASE}/characters?limit=200&q=${encodeURIComponent("人物13")}`
	) {
		return Promise.resolve({ items: rosterFixture });
	}
	if (method === "GET" && /^\/api\/books\/B1\/characters\/\d+$/.test(path)) {
		if (holdProfileGets > 0) {
			holdProfileGets -= 1;
			heldProfile = makeDeferred();
			return heldProfile.promise;
		}
		const id = Number(path.split("/").pop());
		const found = rosterFixture.find((p) => Number(p.id) === id);
		return Promise.resolve({
			character: found
				? {
						...found,
						intro: "一句话简介",
						appearance: "外貌描写",
						personality: "性格描写",
						background: "背景描写",
						note: "备注内容",
					}
				: { id, name: "未知人物" },
			aliases: id === 5 ? freshAliases() : [],
			relation_summary: { active: 2 },
			timeline_summary: { events: 3 },
			thread_summary: { open: 1 },
		});
	}
	if (method === "PATCH" && /^\/api\/books\/B1\/characters\/\d+$/.test(path)) {
		if (deferredPatch) {
			const gate = deferredPatch;
			deferredPatch = null;
			return gate.promise;
		}
		if (patchFail) return Promise.reject(new Error("写入失败"));
		return Promise.resolve({ character: { ...body, id: 5 } });
	}
	if (method === "POST" && path === `${BASE}/characters`) {
		const id = nextCreateId;
		nextCreateId += 1;
		return Promise.resolve({ character: { id, name: body.name } });
	}
	if (method === "POST" && path === `${BASE}/characters/5/archive`) {
		const found = rosterFixture.find((p) => p.id === 5);
		if (found) found.archived_at = "2026-09-26T00:00:00Z";
		return Promise.resolve({});
	}
	if (method === "POST" && path === `${BASE}/characters/5/unarchive`) {
		const found = rosterFixture.find((p) => p.id === 5);
		if (found) delete found.archived_at;
		return Promise.resolve({});
	}
	if (method === "PUT" && path === `${BASE}/characters/5/aliases`) {
		return Promise.resolve({
			character: { id: 5, name: "林晚", role: "主角" },
			aliases: body.aliases,
			relation_summary: { active: 2 },
			timeline_summary: { events: 3 },
			thread_summary: { open: 1 },
		});
	}
	if (
		method === "GET" &&
		path === `${BASE}/characters/5/relations?secrecy=all&lifecycle=all`
	) {
		return Promise.resolve({ items: relationsFixture });
	}
	if (method === "GET" && path === `${BASE}/relation-types`) {
		return Promise.resolve({
			items: [{ id: 1, forward_label: "师徒", reverse_label: "徒弟" }],
		});
	}
	if (method === "POST" && path === `${BASE}/relations/changes`) {
		return Promise.resolve({});
	}
	if (
		method === "GET" &&
		path === `${BASE}/characters/5/advisor/sessions?limit=20`
	) {
		return Promise.resolve({ items: [] });
	}
	if (
		method === "GET" &&
		path === `${BASE}/ledger/events?character_id=5&limit=200`
	) {
		return Promise.resolve({ items: [] });
	}
	if (method === "GET" && path === `${BASE}/characters/5/states`) {
		return Promise.resolve({ items: [] });
	}
	if (method === "GET" && path === `${BASE}/state-fields`) {
		return Promise.resolve({ items: [] });
	}
	if (method === "GET" && path === `${BASE}/ledger/proposals?status=pending`) {
		return Promise.resolve({ items: [] });
	}
	return Promise.resolve({});
}

function ensureModalBody() {
	let el = document.getElementById("modal-body");
	if (!el) {
		el = document.createElement("div");
		el.id = "modal-body";
		document.body.appendChild(el);
	}
	return el;
}

function escapeHtml(value) {
	if (value == null) return "";
	return String(value).replace(
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

function buildWorkbenchContent() {
	document.getElementById("workbench-content")?.remove();
	const el = document.createElement("div");
	el.id = "workbench-content";
	document.body.appendChild(el);
	return el;
}

// S5-4 面板契约笔：挂载机制改本地 createRoot 直渲染（等值旧 window.CharacterWorkbench.show(route)：
// 每挂载一次＝一次全量重入重拉）；同一容器重挂＝旧树整个丢弃（等值旧 key=visit++ 重挂）
const mountedRoots = [];
let currentRoot = null;

function mountPanel(route, container) {
	const page = container || buildWorkbenchContent();
	if (currentRoot?.page === page) currentRoot.unmount();
	const root = createRoot(page);
	const entry = {
		page,
		root,
		alive: true,
		unmount() {
			if (!entry.alive) return;
			entry.alive = false;
			act(() => {
				root.unmount();
			});
		},
	};
	mountedRoots.push(entry);
	currentRoot = entry;
	act(() => {
		root.render(<CharacterWorkbenchPanel route={route} />);
	});
	return page;
}

afterEach(() => {
	while (mountedRoots.length) mountedRoots.pop().unmount();
	currentRoot = null;
});

async function showAndLoad(route = ROUTE) {
	mountPanel(route);
	await act(async () => {});
	return document.getElementById("workbench-content");
}

// React 受控 input/textarea 的 jsdom 赋值必须走原生 setter（CardsPage.test.jsx 同款）
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
	rosterFixture = freshRoster();
	relationsFixture = freshRelations();
	charactersFail = false;
	patchFail = false;
	deferredPatch = null;
	holdProfileGets = 0;
	heldProfile = null;
	nextCreateId = 42;
	apiCalls = [];
	toasts = [];
	lastModal = null;
	seqLog = [];
	window.location.hash = "";
	window.App = {
		api: mockApi,
		escapeHtml: escapeHtml,
		openModal(opts) {
			lastModal = opts;
			ensureModalBody().innerHTML = opts.bodyHTML || "";
		},
		toast(msg) {
			toasts.push(String(msg));
		},
	};
	window.WorkspaceState = makeWorkspaceStateMock();
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

describe("CharacterWorkbenchPanel 组件（范式 A·判定 C 旧名桥）", () => {
	it("A2 壳与名册：shell 渲染＋GET /sidebar-preferences 与 /characters?limit=200 发生", async () => {
		const page = await showAndLoad();
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/sidebar-preferences`,
			),
		).toBe(true);
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/characters?limit=200`,
			),
		).toBe(true);
		expect(page.querySelector(".character-hub")).not.toBeNull();
		expect(page.querySelector(".character-roster h2").textContent).toBe(
			"人物名册",
		);
		expect(page.querySelector("#character-create").textContent).toBe("+ 新建");
		expect(page.querySelector("#character-search").placeholder).toBe(
			"搜索姓名、别名或简介",
		);
		expect(page.querySelector("#character-show-archived")).not.toBeNull();
		const cards = page.querySelectorAll(".character-roster-card");
		expect(cards.length).toBe(2);
		expect(cards[0].dataset.characterId).toBe("5");
		expect(cards[0].querySelector(".roster-avatar").textContent).toBe("林");
		expect(cards[0].querySelector(".character-card-name").textContent).toBe(
			"林晚",
		);
		expect(cards[0].querySelector(".roster-role-tag").textContent).toBe("主角");
		expect(cards[0].querySelector(".character-card-intro").textContent).toBe(
			"女主角简介",
		);
		expect(page.querySelector("#character-detail")).not.toBeNull();
		// ROUTE 指定 entityId=5、tab=profile → 档案表单渲染
		expect(page.querySelector("#character-profile-form")).not.toBeNull();
	});

	it("A3 守卫先注册后加载：label 逐字「人物工作台」、clearGuards 按 key 清旧、F6 等价（isDirty/save/discard）", async () => {
		await showAndLoad();
		// 先注册后加载（:399 注释语义）：registerGuard 先于首次名册 GET
		expect(seqLog.indexOf("ws:registerGuard")).toBeGreaterThanOrEqual(0);
		expect(seqLog.indexOf("ws:registerGuard")).toBeLessThan(
			seqLog.indexOf("api:GET:/api/books/B1/characters?limit=200"),
		);
		// 形态断言（:191-197）
		let guard = window.WorkspaceState.guards().find(
			(g) => g.key === "characters",
		);
		expect(guard).toBeTruthy();
		expect(guard.label).toBe("人物工作台");
		expect(typeof guard.isDirty).toBe("function");
		expect(typeof guard.save).toBe("function");
		expect(typeof guard.discard).toBe("function");
		// clearGuards 按 key 清旧：再 show 仍恰 1 个（:190）
		const page = await showAndLoad();
		expect(window.WorkspaceState.guards().length).toBe(1);
		guard = window.WorkspaceState.guards().find((g) => g.key === "characters");
		// F6 等价回归：表单 input → isDirty 真；save 返回 saveProfile 结果；discard 清 tracker
		const form = page.querySelector("#character-profile-form");
		setInputValue(form.querySelector('[name="name"]'), "守卫输入");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			expect(await guard.save()).toBe(true);
		});
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		setInputValue(form.querySelector('[name="name"]'), "再改一次");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		await act(async () => {
			guard.discard();
		});
		expect(window.WorkspaceState.hasDirty()).toBe(false);
	});

	it("A4 档案表单：七字段＋datalist；竞态令牌：晚到档案不回写（beginRequest/isCurrent 双绑）", async () => {
		const page = buildWorkbenchContent();
		holdProfileGets = 1; // 第一次档案 GET 挂起
		mountPanel(ROUTE, page);
		await act(async () => {});
		expect(page.querySelector(".character-roster-card")).not.toBeNull(); // 名册已渲染
		// 经搜索触发第二次档案加载（loadCharacters(true)→renderDetail→loadProfile，:346/:389）
		setInputValue(page.querySelector("#character-search"), "林");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 260));
		});
		const form = page.querySelector("#character-profile-form");
		expect(form).not.toBeNull();
		// 放行晚到的第一次响应：token 过期不得回写（:140-143）
		await act(async () => {
			heldProfile.resolve({
				character: {
					id: 5,
					name: "过期档案",
					role: "过期",
					intro: "过期",
					appearance: "",
					personality: "",
					background: "",
					note: "",
				},
				aliases: [],
				relation_summary: { active: 0 },
				timeline_summary: { events: 0 },
				thread_summary: { open: 0 },
			});
		});
		expect(form.querySelector('[name="name"]').value).toBe("林晚");
		// token 与书/人物双绑被调（:138/:143）
		expect(seqLog).toContain("ws:beginRequest:character-profile:B1|5");
		expect(
			seqLog.some((s) => s.startsWith("ws:isCurrent:character-profile")),
		).toBe(true);
		// 七字段渲染（:70-79）＋datalist 角色选项（:74）
		expect(form.querySelector('[name="role"]').value).toBe("主角");
		expect(form.querySelector("#character-role-options").children.length).toBe(
			4,
		);
		expect(form.querySelector('[name="intro"]').value).toBe("一句话简介");
		expect(form.querySelector('[name="appearance"]')).not.toBeNull();
		expect(form.querySelector('[name="personality"]')).not.toBeNull();
		expect(form.querySelector('[name="background"]')).not.toBeNull();
		expect(form.querySelector('[name="note"]')).not.toBeNull();
	});

	it("A5 保存流：成功 settle＋toast 逐字＋重拉名册；失败脏保留 toast 逐字；保存期间新输入 toast 逐字", async () => {
		const page = await showAndLoad();
		const form = page.querySelector("#character-profile-form");
		const nameInput = form.querySelector('[name="name"]');
		// 成功（:170-184）
		setInputValue(nameInput, "林晚（改）");
		expect(page.querySelector("#profile-save-state").textContent).toBe(
			"有未保存的修改",
		);
		await act(async () => {
			submitForm(form);
		});
		const patch = apiCalls.find(
			(c) => c.method === "PATCH" && c.path === `${BASE}/characters/5`,
		);
		expect(patch.body).toEqual({
			name: "林晚（改）",
			role: "主角",
			intro: "一句话简介",
			appearance: "外貌描写",
			personality: "性格描写",
			background: "背景描写",
			note: "备注内容",
		});
		expect(toasts).toContain("人物档案已保存");
		expect(window.WorkspaceState.hasDirty()).toBe(false);
		expect(page.querySelector("#profile-save-state").textContent).toBe(
			"已保存",
		);
		// 重拉名册：GET /characters?limit=200 第二次（:181）
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${BASE}/characters?limit=200`,
			).length,
		).toBe(2);
		// 失败（:171-174 toast 逐字、表单值保留、仍 dirty）
		patchFail = true;
		setInputValue(nameInput, "再改一次");
		await act(async () => {
			submitForm(form);
		});
		expect(toasts).toContain(
			"保存失败（人物档案未保存）：写入失败，修改仍留在表单里",
		);
		expect(nameInput.value).toBe("再改一次");
		expect(window.WorkspaceState.hasDirty()).toBe(true);
		expect(page.querySelector("#profile-save-state").textContent).toBe(
			"有未保存的修改",
		);
		// 保存期间新输入（:175-179 toast 逐字、返回 false 语义＝仍 dirty 不清）
		patchFail = false;
		const gate = makeDeferred();
		deferredPatch = gate; // mock 消费后会把模块变量置 null，测试持本地引用以便放行
		setInputValue(nameInput, "飞行中输入");
		await act(async () => {
			submitForm(form);
		});
		setInputValue(nameInput, "飞行中再改");
		await act(async () => {
			gate.resolve({ character: { id: 5, name: "已保存值" } });
		});
		expect(toasts).toContain(
			"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
		);
		expect(window.WorkspaceState.hasDirty()).toBe(true);
	});

	it("A6 空态双形态：删除人物空态逐字（F7 等价）＋无选中空态逐字", async () => {
		// 指定的对象已不在本书（:105-106 逐字）
		const page = await showAndLoad({ ...ROUTE, entityId: "99" });
		const empty = page.querySelector('[data-character-missing="99"]');
		expect(empty).not.toBeNull();
		expect(empty.querySelector("h2").textContent).toBe("这个人物已不在本书中");
		expect(empty.querySelector("p").textContent).toBe(
			"它可能已被删除（#99）。未自动切换到其他人物或别的书；可从左侧名册另选一位。",
		);
		// 不自动落到名册其他人物：无导航/表单渲染
		expect(page.querySelector("#character-profile-form")).toBeNull();
		expect(page.querySelector(".character-detail-nav")).toBeNull();
		// 无 entityId＋空名册 → 「选择一个人物」（:107 逐字）
		rosterFixture = [];
		const page2 = await showAndLoad({ bookId: "B1" });
		expect(page2.querySelector(".workbench-empty h2").textContent).toBe(
			"选择一个人物",
		);
		expect(page2.querySelector(".workbench-empty p").textContent).toBe(
			"从左侧名册进入档案、关系与时间线。",
		);
	});

	it("A7 tab 导航：四 tab 点击改写 hash＋active 类切换", async () => {
		const page = await showAndLoad();
		const tabs = page.querySelectorAll("[data-character-tab]");
		expect(Array.from(tabs).map((b) => b.textContent)).toEqual([
			"档案",
			"关系",
			"时间线",
			"人物顾问",
		]);
		expect(
			page.querySelector('[data-character-tab="profile"]').className,
		).toContain("active");
		// 点击 → hash 改写（:127-131）
		await act(async () => {
			page.querySelector('[data-character-tab="relations"]').click();
		});
		expect(window.location.hash).toBe(
			"#/book/B1/workbench/characters/5?tab=relations",
		);
		// active 切换＝旧 hashchange→route→show 循环的等价重入（新路由重 show）
		const page2 = await showAndLoad({ ...ROUTE, tab: "relations" });
		expect(
			page2.querySelector('[data-character-tab="relations"]').className,
		).toContain("active");
		expect(
			page2.querySelector('[data-character-tab="profile"]').className,
		).not.toContain("active");
	});

	it("A8 关系 tab：行渲染逐字＋图/列表视图互斥切换＋关系图 SVG", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "relations" });
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === `${BASE}/characters/5/relations?secrecy=all&lifecycle=all`,
			),
		).toBe(true);
		const row = page.querySelector(".relation-list-row");
		expect(row.querySelector("strong").textContent).toBe("陈默");
		expect(row.querySelector("span").textContent).toBe("师父 · 强度 4/5");
		expect(row.querySelector("small").textContent).toBe("备注一");
		const badge = row.querySelector(".relation-badge");
		expect(badge.className).toBe("relation-badge positive");
		expect(badge.textContent).toBe("active");
		expect(
			row.querySelector(".edit-relation").getAttribute("data-relation"),
		).toBe("rel-1");
		// 关系图（RelationMap 直挂，等值旧 MozhenCharacterRelations.renderSVG :273）
		expect(
			page.querySelector("#relation-map-panel svg.relation-map"),
		).not.toBeNull();
		// 视图切换互斥（:274-280）
		expect(page.querySelector("#relation-map-panel").className).not.toContain(
			"hidden",
		);
		expect(page.querySelector("#relation-list-panel").className).toContain(
			"hidden",
		);
		await act(async () => {
			page.querySelector('[data-relation-view="list"]').click();
		});
		expect(page.querySelector("#relation-map-panel").className).toContain(
			"hidden",
		);
		expect(page.querySelector("#relation-list-panel").className).not.toContain(
			"hidden",
		);
		expect(
			page.querySelector('[data-relation-view="list"]').className,
		).toContain("active");
		// 空关系（:98 逐字）
		relationsFixture = [];
		const page2 = await showAndLoad({ ...ROUTE, tab: "relations" });
		expect(
			page2.querySelector("#relation-list-panel .workbench-empty-card")
				.textContent,
		).toBe("还没有关系。添加第一条关系，让人物网络开始生长。");
	});

	it("A9 关系弹窗：双 GET＋payload 分型＋归档对方候选补回＋编辑回填", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "relations" });
		// 添加：双 GET（:288）
		await act(async () => {
			page.querySelector("#add-relation").click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/characters?limit=200`,
			),
		).toBe(true);
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/relation-types`,
			),
		).toBe(true);
		expect(lastModal.title).toBe("添加人物关系");
		expect(lastModal.okText).toBe("建立关系");
		const body = document.getElementById("modal-body");
		body.querySelector("#relation-note").value = "新备注";
		await act(async () => {
			await lastModal.onOk(body);
		});
		// payload 分型（:306-318）
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/relations/changes`,
		);
		expect(post.body).toEqual({
			event: { title: "更新人物关系：林晚" },
			relation: {
				public_id: null,
				character_a_id: 5,
				character_b_id: 6,
				relation_type_id: 1,
				direction: "both",
				strength: 3,
				polarity: "positive",
				lifecycle: "active",
				secrecy: "public",
				note: "新备注",
			},
		});
		expect(toasts).toContain("关系变化已记入故事台账");
		// 归档对方补回候选首项「（已归档）」selected（:293-296 历史修复回归）
		relationsFixture.push({
			public_id: "rel-arch",
			endpoint_a: { id: 5, name: "林晚" },
			endpoint_b: { id: 7, name: "归档人" },
			relation_type: {
				id: 1,
				forward_label: "师徒",
				reverse_label: "徒弟",
				label_from_focus: "师父",
			},
			strength: 2,
			polarity: "neutral",
			lifecycle: "dormant",
			direction: "b_to_a",
			secrecy: "public",
			note: "",
		});
		const page2 = await showAndLoad({ ...ROUTE, tab: "relations" });
		await act(async () => {
			page2.querySelectorAll(".edit-relation")[1].click();
		});
		expect(lastModal.title).toBe("编辑人物关系");
		expect(lastModal.okText).toBe("记录变化");
		const body2 = document.getElementById("modal-body");
		const otherSel = body2.querySelector("#relation-other");
		expect(otherSel.options[0].textContent).toBe("归档人（已归档）");
		expect(otherSel.options[0].selected).toBe(true);
		// 编辑回填（:323-327 命令式 set）
		expect(body2.querySelector("#relation-direction").value).toBe("b_to_a");
		expect(body2.querySelector("#relation-polarity").value).toBe("neutral");
		expect(body2.querySelector("#relation-lifecycle").value).toBe("dormant");
	});

	it("A10 别名编辑：多行解析、primary 恒首项、空行过滤、保存后重拉档案", async () => {
		const page = await showAndLoad();
		await act(async () => {
			page.querySelector("#edit-aliases").click();
		});
		expect(lastModal.title).toBe("编辑别名与称号");
		expect(lastModal.okText).toBe("保存别名");
		const body = document.getElementById("modal-body");
		expect(body.querySelector("#alias-editor").value).toBe("阿晚|nickname");
		body.querySelector("#alias-editor").value =
			"阿晚|nickname\n\n曾用名|former_name\n化名笔名";
		await act(async () => {
			await lastModal.onOk(body);
		});
		// PUT aliases body 首项 primary（:258-262）；空行过滤
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === `${BASE}/characters/5/aliases`,
		);
		expect(put.body).toEqual({
			aliases: [
				{ alias: "林晚", alias_type: "primary", is_primary: true },
				{ alias: "阿晚", alias_type: "nickname", is_primary: false },
				{ alias: "曾用名", alias_type: "former_name", is_primary: false },
				{ alias: "化名笔名", alias_type: "other", is_primary: false },
			],
		});
		expect(toasts).toContain("别名已保存");
		// 保存后 loadProfile 重拉档案（:263）
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${BASE}/characters/5`,
			).length,
		).toBe(2);
	});

	it("A11 名册交互：分页 30/页、卡点击 hash、搜索 220ms 防抖、归档开关、新建人物、归档/恢复", async () => {
		rosterFixture = Array.from({ length: 35 }, (_, i) => ({
			id: 101 + i,
			name: `人物${101 + i}`,
			role: "配角",
			intro: "",
		}));
		const page = await showAndLoad({ bookId: "B1" }); // 无 entityId → 自动选第一个
		// 分页：page/pageSize 30 语义（:5/:363）
		expect(
			page.querySelector("#character-roster-pager .list-pager").textContent,
		).toContain("第 1 / 2 页 · 共 35 人");
		expect(page.querySelectorAll(".character-roster-card").length).toBe(30);
		await act(async () => {
			page.querySelector("[data-page-next]").click();
		});
		expect(page.querySelectorAll(".character-roster-card").length).toBe(5);
		expect(
			page
				.querySelector(".character-roster-card")
				.getAttribute("data-character-id"),
		).toBe("131");
		// 卡点击 → hash 带 activeTab（:352-354）
		await act(async () => {
			page
				.querySelector('.character-roster-card[data-character-id="131"]')
				.click();
		});
		expect(window.location.hash).toBe(
			"#/book/B1/workbench/characters/131?tab=profile",
		);
		// 搜索 220ms 防抖后带 q= 重拉（:348-351）
		setInputValue(page.querySelector("#character-search"), "人物13");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 260));
		});
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path ===
						`${BASE}/characters?limit=200&q=${encodeURIComponent("人物13")}`,
			),
		).toBe(true);
		// 归档开关 → archived=true＋page 重置（:346）；此前搜索设下的 q= 仍随请求携带（等值旧 state.query 持续语义）
		await act(async () => {
			page.querySelector("#character-show-archived").click();
		});
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path.startsWith(`${BASE}/characters?limit=200&archived=true`),
			),
		).toBe(true);
		// 新建人物（:330-342）：空名守卫＋POST＋hash 跳新 id?tab=profile
		await act(async () => {
			page.querySelector("#character-create").click();
		});
		expect(lastModal.title).toBe("新建人物");
		expect(lastModal.okText).toBe("创建人物");
		const body = document.getElementById("modal-body");
		let rc;
		await act(async () => {
			rc = await lastModal.onOk(body);
		});
		expect(rc).toBe(false);
		expect(toasts).toContain("请填写人物姓名");
		body.querySelector("#new-character-name").value = "新人物";
		body.querySelector("#new-character-role").value = "主角";
		body.querySelector("#new-character-intro").value = "新简介";
		await act(async () => {
			await lastModal.onOk(body);
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/characters`,
		);
		expect(post.body).toEqual({
			name: "新人物",
			role: "主角",
			intro: "新简介",
		});
		expect(window.location.hash).toBe(
			"#/book/B1/workbench/characters/42?tab=profile",
		);
		// 归档/恢复（:242-248）
		rosterFixture = [{ id: 5, name: "林晚", role: "主角", intro: "" }];
		const page2 = await showAndLoad();
		await act(async () => {
			page2.querySelector("#archive-character").click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === `${BASE}/characters/5/archive`,
			),
		).toBe(true);
		expect(toasts).toContain("人物已归档");
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === `${BASE}/characters?limit=200&archived=true`,
			),
		).toBe(true);
		await act(async () => {
			page2.querySelector("#archive-character").click();
		});
		expect(
			apiCalls.some(
				(c) =>
					c.method === "POST" && c.path === `${BASE}/characters/5/unarchive`,
			),
		).toBe(true);
		expect(toasts).toContain("人物已恢复");
	});

	it("A12 顾问/时间线 tab 组合：advisor 渲染 CharacterAdvisorPanel、timeline 渲染 TimelinePanel", async () => {
		const page = await showAndLoad({ ...ROUTE, tab: "timeline" });
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === `${BASE}/ledger/events?character_id=5&limit=200`,
			),
		).toBe(true);
		expect(
			page.querySelector("#character-tab-content .timeline-workspace"),
		).not.toBeNull();
		const page2 = await showAndLoad({ ...ROUTE, tab: "advisor" });
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === `${BASE}/characters/5/advisor/sessions?limit=20`,
			),
		).toBe(true);
		expect(
			page2.querySelector("#character-tab-content .advisor-workspace"),
		).not.toBeNull();
	});

	it("A13 错误态：/characters GET reject → .workbench-error 渲染 error.message（:407）", async () => {
		charactersFail = true;
		mountPanel(ROUTE);
		await act(async () => {});
		expect(
			document.querySelector("#workbench-content .workbench-error").textContent,
		).toBe("网络故障");
	});
});
