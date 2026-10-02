// @vitest-environment jsdom
// S4-2 红测（Plan §4 T-A）：CardsPage 路由页范式（window.MozhenCards 桥委托）。
// 断言语义锚点＝public/legacy/cards.js 活代码行号（Plan §4 T-A 表逐条）：
// A1 桥与挂载／A2 载入双 GET／A3 生效链与兜底提示逐字／A4 换卡 PUT bindings 形态／
// A5 列表标签与转义／A6 编辑器填充与 builtin 降级／A7 profile 文本↔对象往返（中文冒号）／
// A8 collectForm 语义·加规则不丢卡名人设／A9 标本 pack 域删除路由（2026-09-19 修复回归）／
// A10 保存分路（POST/PUT×规则范文）与卡名必填／A11 删除卡／A12 注入预览逐字与失败态。
// D5 同款 harness：jsdom + React 19 内建 act + 裸 DOM 断言（不装 @testing-library/*）。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountCards } from "./CardsPage.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function freshPacks() {
	return [
		{
			id: 1,
			name: "主卡·冷峻",
			builtin: false,
			kind: "preset",
			persona: "我是冷峻作者",
			enabled: true,
			note: "备注一",
			stats: { rules: 3, must: 2, samples: 1 },
		},
		{
			id: 2,
			name: "去AI味·通用",
			builtin: true,
			kind: "basic",
			persona: "",
			enabled: true,
			note: "",
			stats: { rules: 1, must: 1, samples: 0 },
		},
		{
			id: 3,
			name: "印记卡",
			builtin: false,
			kind: "imprint",
			persona: "",
			enabled: false,
			note: "停用中",
			stats: { rules: 0, must: 0, samples: 2 },
		},
		{
			id: 4,
			name: "<script>alert(1)</script>恶卡",
			builtin: false,
			kind: "preset",
			persona: "",
			enabled: true,
			note: "",
			stats: { rules: 0, must: 0, samples: 0 },
		},
	];
}

function freshPackDetail() {
	return {
		1: {
			pack: {
				id: 1,
				name: "主卡·冷峻",
				kind: "preset",
				persona: "我是冷峻作者",
				profile: { stance: "少写", diction: "短句" },
				enabled: true,
				builtin: false,
			},
			rules: [
				{
					id: 11,
					category: "通用",
					title: "短句",
					trigger: "悲伤|愤怒",
					rule: "规则正文",
					good: "",
					bad: "",
					severity: "must",
					source: "手写",
				},
			],
			samples: [
				{
					id: 21,
					title: "段名",
					text: "范文正文",
					charCount: 100,
					indexed: true,
					source: "手写",
				},
			],
		},
		2: {
			pack: {
				id: 2,
				name: "去AI味·通用",
				kind: "basic",
				persona: "",
				profile: {},
				enabled: true,
				builtin: true,
			},
			rules: [],
			samples: [],
		},
	};
}

let packsFixture;
let bindingsFixture;
let effectiveFixture;
let previewFixture;
let previewFail;
let packDetail;
let nextPackId;
let apiCalls;
let toasts;
let confirmCalls;
let confirmResult;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && path === "/api/style-lab/packs?book_id=B1") {
		return Promise.resolve({
			packs: packsFixture,
			bindings: bindingsFixture,
			effective: effectiveFixture,
		});
	}
	if (
		method === "GET" &&
		path.startsWith("/api/style-lab/packs-preview?book_id=")
	) {
		if (previewFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve(previewFixture);
	}
	if (method === "PUT" && path === "/api/style-lab/books/B1/cards") {
		return Promise.resolve({});
	}
	if (method === "GET" && /^\/api\/style-lab\/packs\/\d+$/.test(path)) {
		const id = Number(path.slice("/api/style-lab/packs/".length));
		if (packDetail[id]) return Promise.resolve(packDetail[id]);
		return Promise.resolve({
			pack: {
				id,
				name: "",
				kind: "preset",
				persona: "",
				profile: {},
				enabled: true,
				builtin: false,
			},
			rules: [],
			samples: [],
		});
	}
	if (method === "PUT" && /^\/api\/style-lab\/packs\/\d+$/.test(path)) {
		const id = Number(path.slice("/api/style-lab/packs/".length));
		return Promise.resolve({
			pack: {
				id,
				name: body.name,
				kind: body.kind,
				persona: body.persona,
				profile: body.profile,
				enabled: body.enabled,
				builtin: false,
			},
		});
	}
	if (method === "POST" && path === "/api/style-lab/packs") {
		const id = nextPackId++;
		return Promise.resolve({
			pack: {
				id,
				name: body.name,
				kind: body.kind,
				persona: body.persona,
				profile: body.profile,
				enabled: body.enabled,
				builtin: false,
			},
		});
	}
	if (method === "DELETE" && /^\/api\/style-lab\/packs\/\d+$/.test(path)) {
		return Promise.resolve({});
	}
	if (method === "DELETE" && /^\/api\/style-lab\/rules\/\d+$/.test(path)) {
		return Promise.resolve({});
	}
	if (
		method === "DELETE" &&
		/^\/api\/style-lab\/packs\/\d+\/samples\/\d+$/.test(path)
	) {
		return Promise.resolve({});
	}
	if (method === "PUT" && /^\/api\/style-lab\/rules\/\d+$/.test(path)) {
		return Promise.resolve({});
	}
	if (method === "PUT" && /^\/api\/style-lab\/samples\/\d+$/.test(path)) {
		return Promise.resolve({});
	}
	if (method === "POST" && /^\/api\/style-lab\/packs\/\d+\/rules$/.test(path)) {
		return Promise.resolve({});
	}
	if (
		method === "POST" &&
		/^\/api\/style-lab\/packs\/\d+\/samples$/.test(path)
	) {
		return Promise.resolve({});
	}
	return Promise.resolve({});
}

function buildPage() {
	document.getElementById("page-cards")?.remove();
	const page = document.createElement("div");
	page.id = "page-cards";
	document.body.appendChild(page);
	return page;
}

async function mountAndLoad() {
	buildPage();
	act(() => {
		mountCards("B1");
	});
	await act(async () => {});
	return document.getElementById("page-cards");
}

// React 受控 input/textarea 的 jsdom 赋值必须走原生 setter，否则 value 被覆盖回 state 值
function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(el, value) {
	el.value = value;
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
	document.body.innerHTML = "";
	packsFixture = freshPacks();
	bindingsFixture = { main: { id: 1 }, aux: [{ id: 2 }] };
	effectiveFixture = { source: "own", chain_ids: [1, 2] };
	previewFixture = {
		source: "own",
		chain: [{ id: 1, name: "主卡·冷峻" }],
		chars: 1234,
		hanzi: 1000,
		budget_chars: 10000,
		rule_count: 2,
		style_layer_enabled: true,
		text: "预览正文ABC",
	};
	previewFail = false;
	packDetail = freshPackDetail();
	nextPackId = 100;
	apiCalls = [];
	toasts = [];
	confirmCalls = [];
	confirmResult = true;
	window.App = {
		api: mockApi,
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
	window.confirm = (...args) => {
		confirmCalls.push(args[0]);
		return confirmResult;
	};
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("CardsPage 组件（路由页范式 P）", () => {
	it("A1 桥与挂载：MozhenCards.show 可用；#page-cards 缺失 no-op；root 缓存容器元素", async () => {
		expect(typeof mountCards).toBe("function");
		// 挂载目标缺失：no-op 不抛（ProfilePage mount 同守卫）
		document.getElementById("page-cards")?.remove();
		expect(() => mountCards("B1")).not.toThrow();
		await act(async () => {});

		// 正常挂载：root 缓存于容器元素
		const page = buildPage();
		act(() => {
			mountCards("B1");
		});
		await act(async () => {});
		const root1 = page.__mozhenCardsRoot;
		expect(root1).toBeTruthy();
		// 同元素第二次 show：root 复用（不重复 createRoot）+ 重拉
		act(() => {
			mountCards("B1");
		});
		await act(async () => {});
		expect(page.__mozhenCardsRoot).toBe(root1);
		const gets = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/style-lab/packs?book_id=B1",
		);
		expect(gets.length).toBe(2);
	});

	it("A2 载入：绑定区（主卡 select＋首选项）＋辅卡 chip 排除主卡＋卡库列表＋预览；两 GET 发生", async () => {
		await mountAndLoad();
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" && c.path === "/api/style-lab/packs?book_id=B1",
			),
		).toBe(true);
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path === "/api/style-lab/packs-preview?book_id=B1",
			),
		).toBe(true);

		const sel = document.getElementById("cards-main-select");
		expect(sel).not.toBeNull();
		expect(sel.options[0].textContent).toBe("（不指定，用内置通用卡）");
		expect(sel.value).toBe("1"); // 绑定了主卡 id=1
		expect(sel.options.length).toBe(5); // 首选项 + 4 张卡

		// 辅卡 chip：排除主卡 id=1 → 2/3/4 三枚
		const chips = document.querySelectorAll("#cards-binding [data-aux]");
		expect(chips.length).toBe(3);
		expect(Array.from(chips).map((c) => c.dataset.aux)).toEqual([
			"2",
			"3",
			"4",
		]);
		const chipOn = document
			.querySelector('[data-aux="2"]')
			.closest(".binding-chip");
		expect(chipOn.className).toBe("binding-chip on");
		expect(chipOn.querySelector("input").checked).toBe(true);

		// 卡库列表 4 张
		expect(document.querySelectorAll("#cards-list .card-item").length).toBe(4);

		// 预览两区有内容（A12 逐字断言）
		expect(document.getElementById("cards-preview").textContent).toBe(
			"预览正文ABC",
		);
	});

	it("A3 生效链：effective.chain_ids 卡渲染「生效中」＋in-chain；basic 未绑主卡兜底提示逐字", async () => {
		effectiveFixture = { source: "basic", chain_ids: [2] };
		bindingsFixture = { main: null, aux: [] };
		await mountAndLoad();

		const item = document.querySelector('#cards-list .card-item[data-id="2"]');
		expect(item.className).toBe("card-item in-chain");
		const tags = Array.from(item.querySelectorAll(".card-tag")).map(
			(t) => t.textContent,
		);
		expect(tags).toContain("内置");
		expect(tags).toContain("生效中");

		// 兜底提示逐字（cards.js:49-50）
		const binding = document.getElementById("cards-binding");
		expect(binding.textContent).toContain(
			"（本书未绑定主卡，自动用内置通用卡兜底；选了主卡就按你选的来）",
		);
		// 生效链 strong = 真实生效卡（服务端解析结果），不是「绑定了什么」
		expect(binding.querySelector("strong").textContent).toBe("去AI味·通用");
	});

	it("A4 换卡：主卡 change → PUT bindings 形态；辅卡增减依序 sortOrder；toast＋重拉", async () => {
		await mountAndLoad();
		const sel = document.getElementById("cards-main-select");
		await act(async () => {
			setSelectValue(sel, "3");
		});
		const put1 = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/style-lab/books/B1/cards",
		);
		expect(put1.body).toEqual({
			bindings: [
				{ packId: 3, role: "main", sortOrder: 0 },
				{ packId: 2, role: "aux", sortOrder: 0 },
			],
		});
		expect(toasts).toContain("已换卡，下一轮对话生效");
		// 重拉：GET packs 第二次
		expect(
			apiCalls.filter((c) => c.path === "/api/style-lab/packs?book_id=B1")
				.length,
		).toBe(2);

		// 重拉后（fixture 恒定 main=1, aux=[2]）取消勾选辅卡 2 → 无 aux
		// （React 对 checkbox 的 onChange 由 click 事件驱动）
		const cb = document.querySelector('[data-aux="2"]');
		await act(async () => {
			cb.click();
		});
		const put2 = apiCalls
			.filter(
				(c) => c.method === "PUT" && c.path === "/api/style-lab/books/B1/cards",
			)
			.pop();
		expect(put2.body).toEqual({
			bindings: [{ packId: 1, role: "main", sortOrder: 0 }],
		});

		// 勾选两张辅卡 → 依数组序 sortOrder=0/1
		await act(async () => {
			document.querySelector('[data-aux="3"]').click();
		});
		const put3 = apiCalls
			.filter(
				(c) => c.method === "PUT" && c.path === "/api/style-lab/books/B1/cards",
			)
			.pop();
		expect(put3.body).toEqual({
			bindings: [
				{ packId: 1, role: "main", sortOrder: 0 },
				{ packId: 2, role: "aux", sortOrder: 0 },
				{ packId: 3, role: "aux", sortOrder: 1 },
			],
		});
	});

	it("A5 列表标签与转义：内置/印记/已停用、meta 逐字、script 卡名转义为文本", async () => {
		await mountAndLoad();
		const list = document.getElementById("cards-list");
		// 转义：无 script 元素，卡名为纯文本
		expect(list.querySelectorAll("script").length).toBe(0);
		const names = Array.from(list.querySelectorAll(".card-name")).map(
			(n) => n.textContent,
		);
		expect(names).toContain("<script>alert(1)</script>恶卡");

		const item1 = list.querySelector('.card-item[data-id="1"]');
		const tags1 = Array.from(item1.querySelectorAll(".card-tag")).map(
			(t) => t.textContent,
		);
		expect(tags1).toEqual(["生效中"]); // own 链 [1,2]；非 builtin 非 imprint
		expect(item1.querySelector(".card-item-meta").textContent).toBe(
			"3 条规则（2 必守）· 1 段范文 · 有人设",
		);
		expect(item1.querySelector(".card-item-note").textContent).toBe("备注一");

		const item2 = list.querySelector('.card-item[data-id="2"]');
		expect(
			Array.from(item2.querySelectorAll(".card-tag")).map((t) => t.textContent),
		).toEqual(["内置", "生效中"]);

		const item3 = list.querySelector('.card-item[data-id="3"]');
		expect(item3.className).toBe("card-item disabled");
		expect(
			Array.from(item3.querySelectorAll(".card-tag")).map((t) => t.textContent),
		).toEqual(["印记", "已停用"]);
		expect(item3.querySelector(".card-item-meta").textContent).toBe(
			"0 条规则（0 必守）· 2 段范文 · 无人设",
		);
	});

	it("A6 编辑器打开：GET packs/:id → 表单填充；builtin 卡 kind disabled＋删除按钮隐藏", async () => {
		await mountAndLoad();
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === "/api/style-lab/packs/1",
			),
		).toBe(true);
		expect(document.getElementById("card-editor").className).not.toContain(
			"hidden",
		);
		expect(document.getElementById("card-editor-title").textContent).toBe(
			"编辑：主卡·冷峻",
		);
		expect(document.getElementById("card-name").value).toBe("主卡·冷峻");
		expect(document.getElementById("card-kind").value).toBe("preset");
		expect(document.getElementById("card-kind").disabled).toBe(false);
		expect(document.getElementById("card-persona").value).toBe("我是冷峻作者");
		expect(document.getElementById("card-profile").value).toBe(
			"stance: 少写\ndiction: 短句",
		);
		expect(document.getElementById("card-enabled").checked).toBe(true);
		expect(document.getElementById("card-delete").style.display).not.toBe(
			"none",
		);
		// 规则行与范文行
		const ruleRow = document.querySelector('#card-rules [data-rule-idx="0"]');
		expect(ruleRow.querySelector(".rule-cat").value).toBe("通用");
		expect(ruleRow.querySelector(".rule-title").value).toBe("短句");
		expect(ruleRow.querySelector(".rule-sev").value).toBe("must");
		expect(ruleRow.querySelector(".rule-trigger").value).toBe("悲伤|愤怒");
		expect(ruleRow.querySelector(".rule-text").value).toBe("规则正文");
		const sampleRow = document.querySelector(
			'#card-samples [data-sample-idx="0"]',
		);
		expect(sampleRow.querySelector(".rule-title").value).toBe("段名");
		expect(sampleRow.querySelector(".rule-src").textContent).toBe(
			"100 字 · 已索引",
		);

		// builtin 卡：kind disabled ＋ 删除按钮隐藏
		await act(async () => {
			document.querySelector('#cards-list [data-id="2"]').click();
		});
		expect(document.getElementById("card-kind").disabled).toBe(true);
		expect(document.getElementById("card-delete").style.display).toBe("none");
	});

	it("A7 profile 文本↔对象往返：profileToText 渲染；textToProfile 解析（含中文冒号与键名正则）", async () => {
		await mountAndLoad();
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});
		// 文本化（对象 → 「键: 值」多行）已在 A6 断言；此处断言反向解析写入 payload
		await act(async () => {
			setInputValue(
				document.getElementById("card-profile"),
				"stance: y\n：无效行\nbad-key: z\ngood_key：中文值",
			);
		});
		await act(async () => {
			document.getElementById("card-save").click();
		});
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/style-lab/packs/1",
		);
		expect(put.body.profile).toEqual({ stance: "y", good_key: "中文值" });
	});

	it("A8 表单保全（collectForm 语义）：输入卡名/人设后点加规则，卡名与人设不丢", async () => {
		await mountAndLoad();
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});
		await act(async () => {
			setInputValue(document.getElementById("card-name"), "刚敲的卡名");
			setInputValue(document.getElementById("card-persona"), "刚敲的人设");
			document.getElementById("card-add-rule").click();
		});
		expect(document.getElementById("card-name").value).toBe("刚敲的卡名");
		expect(document.getElementById("card-persona").value).toBe("刚敲的人设");
		// 新规则行已追加（idx=1）
		expect(
			document.querySelectorAll("#card-rules [data-rule-idx]").length,
		).toBe(2);
	});

	it("A9 标本 pack 域删除路由：已有范文 DELETE packs/:packId/samples/:id；已有规则 DELETE rules/:id；未入库行零请求", async () => {
		await mountAndLoad();
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});

		// 删已有范文：必须走 pack 域路由（不是 /api/style-lab/samples/:id——错题库标本遮蔽，2026-09-19 修复）
		await act(async () => {
			document
				.querySelector('#card-samples [data-sample-idx="0"] [data-del-sample]')
				.click();
		});
		expect(confirmCalls).toEqual(["删除这段范文？"]);
		expect(
			apiCalls.some(
				(c) =>
					c.method === "DELETE" &&
					c.path === "/api/style-lab/packs/1/samples/21",
			),
		).toBe(true);
		expect(
			apiCalls.some(
				(c) => c.method === "DELETE" && c.path === "/api/style-lab/samples/21",
			),
		).toBe(false);
		// 行已剔除 → 空态提示逐字
		expect(
			document.querySelector("#card-samples .empty-hint").textContent,
		).toBe("还没有范文段落。（范文可选：有语料才注入）");

		// 删已有规则：顶层 rules 域路由
		await act(async () => {
			document
				.querySelector('#card-rules [data-rule-idx="0"] [data-del-rule]')
				.click();
		});
		expect(confirmCalls).toEqual(["删除这段范文？", "删除这条规则？"]);
		expect(
			apiCalls.some(
				(c) => c.method === "DELETE" && c.path === "/api/style-lab/rules/11",
			),
		).toBe(true);
		expect(document.querySelector("#card-rules .empty-hint").textContent).toBe(
			"还没有规则条目。",
		);

		// 未入库行（id=null）：confirm 后直接从数组剔除，零请求
		await act(async () => {
			document.getElementById("card-add-sample").click();
		});
		const before = apiCalls.length;
		await act(async () => {
			document
				.querySelector('#card-samples [data-sample-idx="0"] [data-del-sample]')
				.click();
		});
		expect(apiCalls.length).toBe(before);
		expect(
			document.querySelectorAll("#card-samples [data-sample-idx]").length,
		).toBe(0);
	});

	it("A10 保存：新建 POST packs＋规则/范文 POST pack 域；更新 PUT＋已有走 PUT；重拉重开；卡名空零请求", async () => {
		// ── 新建卡 ──
		await mountAndLoad();
		await act(async () => {
			document.getElementById("cards-new").click();
		});
		expect(document.getElementById("card-editor-title").textContent).toBe(
			"新建卡片",
		);
		await act(async () => {
			setInputValue(document.getElementById("card-name"), "新卡");
			document.getElementById("card-save").click();
			await new Promise((r) => setTimeout(r, 20)); // saveEditor→load→openEditor 长链在 act 内落定
		});
		const post = apiCalls.find(
			(c) => c.method === "POST" && c.path === "/api/style-lab/packs",
		);
		expect(post.body).toEqual({
			name: "新卡",
			persona: "",
			profile: {},
			enabled: true,
			kind: "preset",
		});
		expect(toasts).toContain("卡片已保存，下一轮对话生效");
		// 保存后重拉＋重开编辑器（GET packs/100 拿 id）
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === "/api/style-lab/packs/100",
			),
		).toBe(true);

		// ── 更新已有卡：已有规则/范文走 PUT，新加的走 pack 域 POST ──
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});
		await act(async () => {
			setInputValue(document.getElementById("card-name"), "改名卡");
			document.getElementById("card-add-rule").click();
		});
		await act(async () => {
			setInputValue(
				document.querySelector('#card-rules [data-rule-idx="1"] .rule-title'),
				"新规则标题",
			);
		});
		await act(async () => {
			document.getElementById("card-save").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		const putPack = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/style-lab/packs/1",
		);
		expect(putPack.body).toEqual({
			name: "改名卡",
			persona: "我是冷峻作者",
			profile: { stance: "少写", diction: "短句" },
			enabled: true,
			kind: "preset",
		});
		expect(
			apiCalls.find(
				(c) => c.method === "PUT" && c.path === "/api/style-lab/rules/11",
			).body,
		).toEqual({
			category: "通用",
			title: "短句",
			trigger: "悲伤|愤怒",
			rule: "规则正文",
			good: "",
			bad: "",
			severity: "must",
			source: "手写",
		});
		expect(
			apiCalls.find(
				(c) =>
					c.method === "POST" &&
					/^\/api\/style-lab\/packs\/1\/rules$/.test(c.path),
			).body.title,
		).toBe("新规则标题");
		expect(
			apiCalls.some(
				(c) => c.method === "PUT" && c.path === "/api/style-lab/samples/21",
			),
		).toBe(true);

		// ── 卡名空：「卡名必填」且零请求 ──
		await act(async () => {
			document.getElementById("cards-new").click();
		});
		const before = apiCalls.length;
		await act(async () => {
			document.getElementById("card-save").click();
		});
		expect(document.getElementById("card-editor-msg").textContent).toBe(
			"卡名必填",
		);
		expect(apiCalls.length).toBe(before);
	});

	it("A11 删除卡：confirm true → DELETE packs/:id → 编辑器关闭＋toast＋重拉", async () => {
		await mountAndLoad();
		await act(async () => {
			document.querySelector('#cards-list [data-id="1"]').click();
		});
		await act(async () => {
			document.getElementById("card-delete").click();
		});
		expect(confirmCalls).toEqual([
			"删除卡片「主卡·冷峻」？\n\n卡片内的规则与范文一并删除，无法找回。已绑定这张卡的书会自动解绑。",
		]);
		expect(
			apiCalls.some(
				(c) => c.method === "DELETE" && c.path === "/api/style-lab/packs/1",
			),
		).toBe(true);
		expect(document.getElementById("card-editor").className).toContain(
			"hidden",
		);
		expect(toasts).toContain("卡片已删除");
		expect(
			apiCalls.filter((c) => c.path === "/api/style-lab/packs?book_id=B1")
				.length,
		).toBe(2); // show + 删除后重拉
	});

	it("A12 预览：meta 逐字、warn 关闭态、空 text 兜底、失败态逐字", async () => {
		await mountAndLoad();
		expect(document.getElementById("cards-preview-meta").textContent).toBe(
			"来源：own · 卡链：主卡·冷峻 · 1234 字符（1000 汉字） / 预算 10000 · 规则 2 条",
		);
		expect(
			document.getElementById("cards-preview-meta").querySelector(".warn"),
		).toBeNull();

		// style_layer_enabled=false → 追加 warn
		previewFixture = { ...previewFixture, style_layer_enabled: false };
		await mountAndLoad();
		const meta = document.getElementById("cards-preview-meta");
		expect(meta.querySelector("strong.warn").textContent).toBe(
			"风格注入已全局关闭",
		);
		expect(meta.textContent).toBe(
			"来源：own · 卡链：主卡·冷峻 · 1234 字符（1000 汉字） / 预算 10000 · 规则 2 条 · 风格注入已全局关闭",
		);

		// 卡链空 + text 空 → 「无」与兜底文案
		previewFixture = {
			...previewFixture,
			chain: [],
			text: "",
		};
		await mountAndLoad();
		expect(document.getElementById("cards-preview-meta").textContent).toBe(
			"来源：own · 卡链：无 · 1234 字符（1000 汉字） / 预算 10000 · 规则 2 条 · 风格注入已全局关闭",
		);
		expect(document.getElementById("cards-preview").textContent).toBe(
			"（当前无卡生效，风格层不注入任何内容）",
		);

		// 预览失败 → 「预览失败：…」
		previewFail = true;
		await mountAndLoad();
		expect(document.getElementById("cards-preview").textContent).toBe(
			"预览失败：网络故障",
		);
	});
});
