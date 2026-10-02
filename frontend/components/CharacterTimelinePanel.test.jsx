// @vitest-environment jsdom
// S4-3 红测（Plan §4 T-B）：CharacterTimelinePanel 范式 P＋组件吸收——
// 全屏页经 mountTimelineFullPage(bookId, cid) 桥承接（app.js:137 单行替换），
// 内嵌模式由 React 人物工作台时间线 tab 直接组合（S4-2 前瞻兼容注记预言形态）。
// 断言语义锚点＝public/legacy/character-timeline.js 行号（Plan §4 T-B 表逐条）。
// 勘误备案（Architect 裁决 2026-09-26）：Plan §4 B13 正文与 §10 步骤 3 写「内嵌无『⤢ 放大』、
// 全屏有」与源码 :169-170 相反（expandBtn 仅 embedded 渲染；全屏页放指向自己 full 路由的
// 链接不成立）——按源码实施，B13 断言内嵌有「⤢ 放大」＋href=full 页、全屏无。台账 §S4-3 同步记录。
// harness（CharacterAdvisorPanel.test.jsx/CardsPage.test.jsx 同款）：jsdom＋React 19 act＋裸 DOM 断言；
// window.App.openModal mock 兼容 legacy 弹窗壳契约——bodyHTML 同步渲染进 #modal-body（事件弹窗
// 在 openModal 返回后随即对 #ev-changes 命令式接线，旧 app.js openModal 同语义）。
// B7 两个守卫（无 chapter_id/无 quote）在真实 UI 不可达（source 按钮仅在 chapter_id＋source_quote
// 齐备时渲染，:80-81）——经 fixture 对象引用变异触发：eventsById 持同对象引用（:197），等值旧语义。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import {
	findLatestVolumeKey,
	formatValue,
	groupEventsByVolume,
	isRelevantChange,
	mountTimelineFullPage,
	parseValue,
	TimelinePanel,
} from "./CharacterTimelinePanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/books/B1";
const PERSON = { id: 7, name: "林晚", role: "主角" };
const ROUTE = { bookId: "B1", entityId: "7", tab: "timeline" };

function freshFields() {
	return [
		{
			field_key: "mood",
			label: "心境",
			value_type: "enum",
			options: [
				{ value: "calm", label: "平静" },
				{ value: "rage", label: "暴怒" },
			],
			enabled: 1,
		},
		{
			field_key: "power",
			label: "实力",
			value_type: "level",
			options: ["炼气", "金丹"],
			enabled: 1,
		},
		{ field_key: "skills", label: "技能", value_type: "list", enabled: 1 },
		{ field_key: "note", label: "备注", value_type: "text", enabled: 1 },
		{ field_key: "hidden", label: "停用字段", value_type: "text", enabled: 0 },
	];
}

function freshStates() {
	return [
		{ field_key: "mood", label: "心境", value: "calm", value_type: "enum" },
		{
			field_key: "skills",
			label: "技能",
			value: ["剑法", "身法"],
			value_type: "list",
		},
	];
}

function freshEvents() {
	return [
		{
			id: 11,
			title: "初入宗门",
			summary: "摘要一",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: null,
			chapter_id: 3,
			chapter_title: "第三章",
			importance: "high",
			origin: "manual",
			changes: [
				{
					change_kind: "character_state",
					subject_ref: "7",
					field_key: "mood",
					old_value: "calm",
					new_value: "rage",
				},
			],
			source_quote: "正文引文原句",
			paragraph_index: 0,
		},
		{
			id: 12,
			title: "无卷事件",
			summary: "",
			volume_id: null,
			volume_title: null,
			chapter_id: null,
			importance: "normal",
			origin: "proposal",
			changes: [
				{
					change_kind: "character_state",
					subject_ref: "999",
					field_key: "mood",
					old_value: null,
					new_value: "rage",
				},
			],
		},
		{
			id: 13,
			title: "卷二事件",
			volume_id: 2,
			volume_title: "第二卷",
			volume_sort_order: 5,
			chapter_id: null,
			importance: "low",
			origin: "import",
			source_stale: true,
			changes: [
				{
					change_kind: "relation",
					subject_ref: "7",
					field_key: null,
					old_value: {
						endpoint_a: 7,
						endpoint_b: 8,
						strength: 3,
						polarity: "positive",
						lifecycle: "active",
					},
					new_value: {
						endpoint_a: 7,
						endpoint_b: 8,
						strength: 5,
						polarity: "negative",
						lifecycle: "dormant",
					},
				},
			],
		},
	];
}

function freshPending() {
	return [
		{
			id: 21,
			changes: [
				{
					change_kind: "character_state",
					subject_ref: "7",
					field_key: "mood",
					old_value: "calm",
					new_value: "rage",
				},
			],
		},
		{
			id: 22,
			changes: [
				{
					change_kind: "character_state",
					subject_ref: "999",
					field_key: "mood",
					old_value: null,
					new_value: "x",
				},
			],
		},
	];
}

const CHAPTER_CONTENT =
	"开篇段落。\n正文引文原句出现在这里的一句话被改掉了。\n结尾段落。";

let fieldsFixture;
let statesFixture;
let eventsFixture;
let pendingFixture;
let chaptersFixture;
let eventsFail;
let apiCalls;
let toasts;
let lastModal;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && path === `${BASE}/characters/7`) {
		return Promise.resolve({ character: { ...PERSON } });
	}
	if (
		method === "GET" &&
		path === `${BASE}/ledger/events?character_id=7&limit=200`
	) {
		if (eventsFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({ items: eventsFixture });
	}
	if (method === "GET" && path === `${BASE}/characters/7/states`) {
		return Promise.resolve({ items: statesFixture });
	}
	if (method === "GET" && path === `${BASE}/state-fields`) {
		return Promise.resolve({ items: fieldsFixture });
	}
	if (method === "GET" && path === `${BASE}/ledger/proposals?status=pending`) {
		return Promise.resolve({ items: pendingFixture });
	}
	if (method === "GET" && path === `${BASE}/chapters`) {
		return Promise.resolve({ chapters: chaptersFixture });
	}
	if (method === "GET" && path === `${BASE}/chapters/3`) {
		return Promise.resolve({
			chapter: { id: 3, title: "第三章", content: CHAPTER_CONTENT },
		});
	}
	if (method === "GET" && path === `${BASE}/chapters/4`) {
		return Promise.resolve({ chapter: { id: 4, title: "空章", content: "" } });
	}
	return Promise.resolve({});
}

// legacy 弹窗壳契约：openModal 把 bodyHTML 渲染进 #modal-body（app.js openModal 同语义），
// 随后的事件行命令式接线才有挂载点。
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

function buildTimelineFull() {
	document.getElementById("page-timeline")?.remove();
	const page = document.createElement("div");
	page.id = "page-timeline";
	page.innerHTML =
		'<header><a id="timeline-full-return" href="#/">← 返回人物</a><h1 id="timeline-full-title">事件时间线</h1></header>' +
		'<main id="timeline-full-content"></main>';
	document.body.appendChild(page);
	return page;
}

// 内嵌模式：组件直挂（workbench 时间线 tab 的组合形态）。
// 每次先移除上一宿主：jsdom 对同文档重复 id 的 querySelector("#id") 走 getElementById
// 快路径，首命中不在本子树即返回 null——单活实例也更贴合「tab 重入仅一个面板」的真实语义。
async function renderEmbedded() {
	document.querySelectorAll("[data-embed-host]").forEach((el) => {
		el.remove();
	});
	const host = document.createElement("div");
	host.setAttribute("data-embed-host", "1");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(
			<TimelinePanel mode="embedded" route={ROUTE} person={PERSON} />,
		);
	});
	await act(async () => {});
	return host;
}

// React 受控 select 的 jsdom 赋值必须走原生 setter＋change 事件
function setSelectValue(el, value) {
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLSelectElement.prototype,
		"value",
	).set;
	setter.call(el, value);
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
	document.body.innerHTML = "";
	fieldsFixture = freshFields();
	statesFixture = freshStates();
	eventsFixture = freshEvents();
	pendingFixture = freshPending();
	chaptersFixture = [
		{ id: 3, title: "第三章" },
		{ id: 4, title: "空章" },
	];
	eventsFail = false;
	apiCalls = [];
	toasts = [];
	lastModal = null;
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
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("CharacterTimelinePanel 组件（范式 P＋组件吸收）", () => {
	it("B1 全屏桥与挂载：showFullPage 可用；容器缺失 no-op；GET 人物→标题/返回 href；root 缓存＋重挂重拉", async () => {
		expect(typeof mountTimelineFullPage).toBe("function");
		// 挂载目标缺失：no-op 不抛（:227-228）
		document.getElementById("timeline-full-content")?.remove();
		expect(() => mountTimelineFullPage("B1", "7")).not.toThrow();
		await act(async () => {});

		// 正常挂载：先 loading（:229），返回 href 在 GET 前重设（:230-231）
		const _page = buildTimelineFull();
		act(() => {
			mountTimelineFullPage("B1", "7");
		});
		expect(
			document
				.getElementById("timeline-full-content")
				.querySelector(".workbench-loading").textContent,
		).toBe("正在整理人物时间线…");
		expect(
			document.getElementById("timeline-full-return").getAttribute("href"),
		).toBe("#/book/B1/workbench/characters/7?tab=timeline");
		await act(async () => {});
		// 先 GET /characters/:cid（:233）→ 标题＝人物名 · 事件时间线（:236）
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${BASE}/characters/7`,
			),
		).toBe(true);
		expect(document.getElementById("timeline-full-title").textContent).toBe(
			"林晚 · 事件时间线",
		);
		// root 缓存容器元素
		const cached = document.getElementById(
			"timeline-full-content",
		).__mozhenTimelineFullRoot;
		expect(cached).toBeTruthy();
		// 二次 showFullPage：root 复用＋key=visit++ 重挂重拉
		act(() => {
			mountTimelineFullPage("B1", "7");
		});
		await act(async () => {});
		expect(
			document.getElementById("timeline-full-content").__mozhenTimelineFullRoot,
		).toBe(cached);
		expect(
			apiCalls.filter(
				(c) =>
					c.method === "GET" &&
					c.path === `${BASE}/ledger/events?character_id=7&limit=200`,
			).length,
		).toBe(2);
	});

	it("B2 载入四连 GET 与 loading 态逐字", async () => {
		buildTimelineFull();
		act(() => {
			mountTimelineFullPage("B1", "7");
		});
		expect(
			document
				.getElementById("timeline-full-content")
				.querySelector(".workbench-loading").textContent,
		).toBe("正在整理人物时间线…");
		await act(async () => {});
		for (const path of [
			`${BASE}/ledger/events?character_id=7&limit=200`,
			`${BASE}/characters/7/states`,
			`${BASE}/state-fields`,
			`${BASE}/ledger/proposals?status=pending`,
		]) {
			expect(apiCalls.some((c) => c.method === "GET" && c.path === path)).toBe(
				true,
			);
		}
		expect(
			document
				.getElementById("timeline-full-content")
				.querySelector(".workbench-loading"),
		).toBeNull();
	});

	it("B3 卷分组渲染：最新卷展开其余 collapsed；无卷归未分卷；纯函数导出等值", async () => {
		const host = await renderEmbedded();
		const secs = host.querySelectorAll(".tl-volume");
		expect(secs.length).toBe(3);
		// 分组顺序＝事件首现序：v1、none、v2；最新卷（sort 5）＝v2
		expect(secs[0].querySelector(".tl-volume-title").textContent).toBe(
			"第一卷",
		);
		expect(secs[1].querySelector(".tl-volume-title").textContent).toBe(
			"未分卷",
		);
		expect(secs[2].querySelector(".tl-volume-title").textContent).toBe(
			"第二卷",
		);
		expect(secs[0].querySelector(".tl-volume-count").textContent).toBe(
			"1 个事件",
		);
		// 最新卷默认展开、其余 collapsed（:143-153）
		expect(secs[0].className).toContain("collapsed");
		expect(
			secs[0].querySelector(".tl-volume-head").getAttribute("aria-expanded"),
		).toBe("false");
		expect(secs[2].className).not.toContain("collapsed");
		expect(
			secs[2].querySelector(".tl-volume-head").getAttribute("aria-expanded"),
		).toBe("true");
		// 点击折叠切换（:100-108）
		await act(async () => {
			host
				.querySelectorAll(".tl-volume")[2]
				.querySelector(".tl-volume-head")
				.click();
		});
		const after = host.querySelectorAll(".tl-volume");
		expect(after[2].className).toContain("collapsed");
		expect(
			after[2].querySelector(".tl-volume-head").getAttribute("aria-expanded"),
		).toBe("false");

		// 纯函数直测（Plan §10 步骤 3 导出面）
		const groups = groupEventsByVolume([
			{ id: 1, volume_id: 1, volume_title: "卷甲", volume_sort_order: null },
			{ id: 2, volume_id: 2, volume_title: "卷乙", volume_sort_order: 5 },
			{ id: 3, volume_id: null, volume_title: null },
		]);
		expect(groups.map((g) => g.key)).toEqual(["v1", "v2", "none"]);
		expect(groups[0].volumeSortOrder).toBe(0); // 孤儿卷 sort 缺省 0（:118-123）
		expect(groups[2].volumeSortOrder).toBe(Number.MAX_SAFE_INTEGER); // 无卷排最后（:123）
		expect(groups[2].volumeTitle).toBe("未分卷"); // 无卷归「未分卷」（:122）
		expect(findLatestVolumeKey(groups)).toBe("v2"); // 真实分卷中 sort 最大者（:134-141）
		expect(
			findLatestVolumeKey(
				groupEventsByVolume([{ id: 1, volume_id: null, volume_title: null }]),
			),
		).toBe("none");
	});

	it("B4 事件卡：徽标（章节/重要性/来源/失效）＋标题摘要＋状态变化行", async () => {
		const host = await renderEmbedded();
		const arts = host.querySelectorAll(".timeline-event");
		expect(arts.length).toBe(3);
		// ev11
		expect(arts[0].querySelector(".tl-badge-chapter").textContent).toBe(
			"第三章",
		);
		expect(arts[0].querySelector(".tl-importance-high").textContent).toBe("高");
		expect(arts[0].querySelector(".tl-badge-origin").textContent).toBe(
			"来源·手动",
		);
		expect(arts[0].querySelector("h3").textContent).toBe("初入宗门");
		expect(arts[0].querySelector(".timeline-summary").textContent).toBe(
			"摘要一",
		);
		const change = arts[0].querySelector(".timeline-change");
		expect(change.querySelector(".timeline-change-field").textContent).toBe(
			"心境",
		);
		expect(change.querySelector(".timeline-change-old").textContent).toBe(
			"calm",
		);
		expect(change.querySelector(".timeline-change-arrow").textContent).toBe(
			"→",
		);
		expect(change.querySelector(".timeline-change-new").textContent).toBe(
			"rage",
		);
		// 原文依据按钮＋编辑按钮（:80-81/:89-91）
		expect(
			arts[0].querySelector('.timeline-source-btn[data-source="11"]'),
		).not.toBeNull();
		expect(
			arts[0].querySelector('.timeline-edit-btn[data-edit="11"]'),
		).not.toBeNull();
		// ev12：章节缺省「未绑定章节」、普通、提案来源；无摘要段
		expect(arts[1].querySelector(".tl-badge-chapter").textContent).toBe(
			"未绑定章节",
		);
		expect(arts[1].querySelector(".tl-importance-normal").textContent).toBe(
			"普通",
		);
		expect(arts[1].querySelector(".tl-badge-origin").textContent).toBe(
			"来源·提案",
		);
		expect(arts[1].querySelector(".timeline-summary")).toBeNull();
		// ev13：来源·导入、低、source_stale 失效徽标＋is-stale 类（:75/:83）
		expect(arts[2].querySelector(".tl-badge-origin").textContent).toBe(
			"来源·导入",
		);
		expect(arts[2].querySelector(".tl-importance-low").textContent).toBe("低");
		expect(arts[2].querySelector(".tl-badge-stale").textContent).toBe(
			"⚠ 依据已失效",
		);
		expect(arts[2].className).toContain("is-stale");
	});

	it("B5 相关性过滤：无关变化空态逐字＋关系变化行 meta/链接；isRelevantChange 纯函数等值", async () => {
		const host = await renderEmbedded();
		// 无关变化（subject_ref 999）→ 空态逐字（:78）
		const arts = host.querySelectorAll(".timeline-event");
		expect(arts[1].querySelector(".timeline-change-empty").textContent).toBe(
			"该事件未包含与该人物直接相关的可显示变化",
		);
		// 关系变化行（:51-59）：快照取 new_value
		const rel = arts[2].querySelector(".timeline-change-relation");
		expect(rel.querySelector(".timeline-change-kind").textContent).toBe(
			"关系变化",
		);
		expect(rel.querySelector(".timeline-change-body").textContent).toBe(
			"强度 5/5 · 负向 · 潜伏",
		);
		const jump = rel.querySelector(".timeline-rel-jump");
		expect(jump.textContent).toBe("去关系 tab");
		expect(jump.getAttribute("href")).toBe(
			"#/book/B1/workbench/characters/7?tab=relations",
		);
		// 纯函数直测（:38-49 等值，personId 显式参数化）
		expect(
			isRelevantChange({ change_kind: "character_state", subject_ref: "7" }, 7),
		).toBe(true);
		expect(
			isRelevantChange(
				{ change_kind: "character_state", subject_ref: "999" },
				7,
			),
		).toBe(false);
		expect(
			isRelevantChange(
				{
					change_kind: "relation",
					new_value: { endpoint_a: 7, endpoint_b: 9 },
				},
				7,
			),
		).toBe(true);
		expect(
			isRelevantChange(
				{ change_kind: "relation", old_value: { endpoint_b: 7 } },
				7,
			),
		).toBe(true);
		expect(
			isRelevantChange(
				{
					change_kind: "relation",
					new_value: { endpoint_a: 8, endpoint_b: 9 },
				},
				7,
			),
		).toBe(false);
		expect(isRelevantChange(null, 7)).toBe(false);
	});

	it("B6 状态芯片与待审横幅：chip 渲染、N=1 横幅逐字＋href、N=0 无横幅；formatValue 直测", async () => {
		const host = await renderEmbedded();
		const chips = host.querySelectorAll(".state-chip");
		expect(chips.length).toBe(2);
		expect(chips[0].querySelector("span").textContent).toBe("心境");
		expect(chips[0].querySelector("strong").textContent).toBe("calm");
		expect(chips[1].querySelector("span").textContent).toBe("技能");
		expect(chips[1].querySelector("strong").textContent).toBe("剑法、身法");
		// 横幅（:158-160）
		const banner = host.querySelector(".timeline-banner");
		expect(banner.querySelector("strong").textContent).toBe("1");
		expect(banner.textContent).toContain("该人物有");
		expect(banner.textContent).toContain("条待审提案");
		const link = banner.querySelector("a");
		expect(link.textContent).toBe("去故事台账审阅");
		expect(link.getAttribute("href")).toBe(
			"#/book/B1/workbench/ledger?tab=proposals",
		);
		// N=0 → 无横幅
		pendingFixture = [];
		const host2 = await renderEmbedded();
		expect(host2.querySelector(".timeline-banner")).toBeNull();
		// formatValue 直测（:27-35）
		expect(formatValue("text", null)).toBe("未记录");
		expect(formatValue("text", "")).toBe("未记录");
		expect(formatValue("list", [])).toBe("未记录");
		expect(formatValue("list", ["a", "b"])).toBe("a、b");
		expect(formatValue("text", 5)).toBe("5");
		expect(formatValue("x", { a: 1 })).toBe('{"a":1}');
	});

	it("B7 原文依据·精确与头部命中＋章节暂无正文守卫＋无章节/无引文守卫", async () => {
		eventsFixture.push({
			id: 15,
			title: "长引文",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: 1,
			chapter_id: 3,
			chapter_title: "第三章",
			importance: "normal",
			origin: "manual",
			changes: [],
			source_quote: "正文引文原句出现在这里的一句话已经不在正文里了啊",
		});
		eventsFixture.push({
			id: 16,
			title: "空章事件",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: 1,
			chapter_id: 4,
			chapter_title: "空章",
			importance: "normal",
			origin: "manual",
			changes: [],
			source_quote: "引文",
		});
		const host = await renderEmbedded();
		// 精确逐字命中（:263-264）
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="11"]').click();
		});
		expect(lastModal.title).toBe("原文依据 · 第三章");
		expect(lastModal.okText).toBe("关闭");
		expect(lastModal.bodyHTML).toContain(
			'<mark class="source-highlight">正文引文原句</mark>',
		);
		// 未命中且长度>12 → 前 12 字头命中（:257-261），无 toast
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="15"]').click();
		});
		expect(lastModal.bodyHTML).toContain(
			'<mark class="source-highlight">正文引文原句出现在这里的</mark>',
		);
		// 守卫：章节无正文（:252）
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="16"]').click();
		});
		expect(toasts).toContain("该章节暂无正文");
		// 守卫：无 chapter_id（:246）——按钮渲染需两者齐备，经 eventsById 同对象引用变异触发
		const ev11 = eventsFixture.find((e) => e.id === 11);
		const keepChapter = ev11.chapter_id;
		ev11.chapter_id = null;
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="11"]').click();
		});
		expect(toasts).toContain("该事件未绑定章节，无法定位原文");
		// 守卫：无 quote（:247）
		ev11.chapter_id = keepChapter;
		ev11.source_quote = "";
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="11"]').click();
		});
		expect(toasts).toContain("该事件没有原文依据");
	});

	it("B8 原文依据·兜底：paragraph_index 段落定位与全章兜底 toast 逐字", async () => {
		eventsFixture.push({
			id: 17,
			title: "段定位",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: 1,
			chapter_id: 3,
			chapter_title: "第三章",
			importance: "normal",
			origin: "manual",
			changes: [],
			source_quote: "不在正文里的短句",
			paragraph_index: 1,
		});
		eventsFixture.push({
			id: 18,
			title: "全兜底",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: 1,
			chapter_id: 3,
			chapter_title: "第三章",
			importance: "normal",
			origin: "manual",
			changes: [],
			source_quote: "完全不在",
		});
		const host = await renderEmbedded();
		// 段落兜底（:265-269）：第 2 段高亮＋toast 逐字
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="17"]').click();
		});
		expect(toasts).toContain("未能精确匹配原句，已定位到第 2 段");
		expect(lastModal.bodyHTML).toContain(
			'<mark class="source-highlight">正文引文原句出现在这里的一句话被改掉了。</mark>',
		);
		// 全失败 → 全章＋toast 逐字（:270-272）
		await act(async () => {
			host.querySelector('.timeline-source-btn[data-source="18"]').click();
		});
		expect(toasts).toContain("未能精确定位，已显示全章");
		expect(lastModal.bodyHTML).not.toContain("<mark");
		expect(lastModal.bodyHTML).toContain("开篇段落。<br>");
	});

	it("B9 事件弹窗·新建：缺省值＋字段值类型分型（enum/level 下拉、list 顿号、text 输入）", async () => {
		const host = await renderEmbedded();
		await act(async () => {
			host.querySelector("#timeline-add-event").click();
		});
		expect(lastModal.title).toBe("新增事件");
		expect(lastModal.okText).toBe("创建事件");
		expect(
			apiCalls.some((c) => c.method === "GET" && c.path === `${BASE}/chapters`),
		).toBe(true);
		const body = document.getElementById("modal-body");
		// 重要性缺省 normal（:415-417）；章节下拉「未绑定章节」首项（:419-420）
		expect(body.querySelector("#ev-importance").value).toBe("normal");
		expect(body.querySelector("#ev-chapter").options[0].textContent).toBe(
			"未绑定章节",
		);
		expect(body.querySelector("#ev-chapter").options[0].selected).toBe(true);
		expect(body.querySelectorAll("#ev-chapter option").length).toBe(3);
		// 缺省变化行：第一启用字段 mood，旧值＝当前态 calm，新值空（:312-321）
		const row = body.querySelector(".ev-change-row");
		expect(row.querySelector(".ev-field").value).toBe("mood");
		expect(row.querySelector(".ev-old").tagName).toBe("SELECT");
		expect(row.querySelector(".ev-old").value).toBe("calm");
		expect(
			Array.from(row.querySelector(".ev-old").options).map(
				(o) => o.textContent,
			),
		).toEqual(["", "平静", "暴怒"]);
		expect(row.querySelector(".ev-new").value).toBe("");
		// level 分型：字符串 options（:292-298）
		setSelectValue(row.querySelector(".ev-field"), "power");
		expect(row.querySelector(".ev-old").tagName).toBe("SELECT");
		expect(
			Array.from(row.querySelector(".ev-old").options).map(
				(o) => o.textContent,
			),
		).toEqual(["", "炼气", "金丹"]);
		// list 分型：input＋「多个值用、分隔」（:300-303）
		setSelectValue(row.querySelector(".ev-field"), "skills");
		expect(row.querySelector(".ev-old").tagName).toBe("INPUT");
		expect(row.querySelector(".ev-old").value).toBe("剑法、身法");
		expect(row.querySelector(".ev-old").placeholder).toBe("多个值用、分隔");
		expect(row.querySelector(".ev-new").value).toBe("");
		// text 分型（:304-305）
		setSelectValue(row.querySelector(".ev-field"), "note");
		expect(row.querySelector(".ev-old").tagName).toBe("INPUT");
		expect(row.querySelector(".ev-old").placeholder).toBe("");
	});

	it("B10 修正 old_value 携带规则：编辑恒带（含 null）、新建条件带、关系变化原样透传", async () => {
		// 编辑恒带（:386-389 替代式修正）
		let host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="11"]').click();
		});
		expect(lastModal.title).toBe("编辑事件");
		expect(lastModal.okText).toBe("保存修正");
		let body = document.getElementById("modal-body");
		await act(async () => {
			await lastModal.onOk(body);
		});
		let post = apiCalls.find(
			(c) =>
				c.method === "POST" &&
				c.path === `${BASE}/ledger/events/11/corrections`,
		);
		expect(post).toBeTruthy();
		expect(post.body.changes[0]).toEqual({
			change_kind: "character_state",
			subject_ref: "7",
			field_key: "mood",
			new_value: "rage",
			old_value: "calm",
		});
		expect(toasts).toContain("事件已修正");
		// 编辑且旧值为 null → old_value 键仍在（isEdit 恒带）
		eventsFixture.push({
			id: 14,
			title: "空旧值",
			volume_id: 1,
			volume_title: "第一卷",
			volume_sort_order: 1,
			chapter_id: null,
			importance: "normal",
			origin: "manual",
			changes: [
				{
					change_kind: "character_state",
					subject_ref: "7",
					field_key: "note",
					old_value: null,
					new_value: "abc",
				},
			],
		});
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="14"]').click();
		});
		body = document.getElementById("modal-body");
		await act(async () => {
			await lastModal.onOk(body);
		});
		post = apiCalls.find(
			(c) =>
				c.method === "POST" &&
				c.path === `${BASE}/ledger/events/14/corrections`,
		);
		expect(Object.hasOwn(post.body.changes[0], "old_value")).toBe(true);
		expect(post.body.changes[0].old_value).toBeNull();
		// 新建：提供了旧值（当前态 calm）→ 带（:388 条件带）
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector("#timeline-add-event").click();
		});
		body = document.getElementById("modal-body");
		body.querySelector("#ev-title").value = "新事件";
		await act(async () => {
			await lastModal.onOk(body);
		});
		post = apiCalls.find(
			(c) => c.method === "POST" && c.path === `${BASE}/ledger/events`,
		);
		expect(post.body).toMatchObject({
			title: "新事件",
			summary: "",
			importance: "normal",
			source_quote: "",
		});
		expect("chapter_id" in post.body).toBe(false); // 未选章节不带 chapter_id（:400）
		expect(post.body.changes[0].old_value).toBe("calm");
		// 新建：未提供旧值（无当前态字段 note）→ 不带 old_value 键（409 防御）
		await act(async () => {
			host.querySelector("#timeline-add-event").click();
		});
		body = document.getElementById("modal-body");
		body.querySelector("#ev-title").value = "新事件二";
		const row = body.querySelector(".ev-change-row");
		setSelectValue(row.querySelector(".ev-field"), "note");
		row.querySelector(".ev-new").value = "xyz";
		await act(async () => {
			await lastModal.onOk(body);
		});
		post =
			apiCalls
				.filter(
					(c) => c.method === "POST" && c.path === `${BASE}/ledger/events}`,
				)
				.pop() ||
			apiCalls
				.filter(
					(c) => c.method === "POST" && c.path === `${BASE}/ledger/events`,
				)
				.pop();
		expect(post.body.changes[0].field_key).toBe("note");
		expect(post.body.changes[0].new_value).toBe("xyz");
		expect(Object.hasOwn(post.body.changes[0], "old_value")).toBe(false);
		// 关系变化原样透传（含 metadata :380-382）
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="13"]').click();
		});
		body = document.getElementById("modal-body");
		await act(async () => {
			await lastModal.onOk(body);
		});
		post = apiCalls.find(
			(c) =>
				c.method === "POST" &&
				c.path === `${BASE}/ledger/events/13/corrections`,
		);
		const relChange = post.body.changes.find(
			(c) => c.change_kind === "relation",
		);
		expect(relChange).toEqual({
			change_kind: "relation",
			subject_ref: "7",
			field_key: null,
			old_value: {
				endpoint_a: 7,
				endpoint_b: 8,
				strength: 3,
				polarity: "positive",
				lifecycle: "active",
			},
			new_value: {
				endpoint_a: 7,
				endpoint_b: 8,
				strength: 5,
				polarity: "negative",
				lifecycle: "dormant",
			},
			metadata: {},
		});
	});

	it("B11 提交守卫与解析：标题空/零变化零请求、无启用字段提示、字段切换重置、行删自动补；parseValue 直测", async () => {
		let host = await renderEmbedded();
		// 标题空：零请求（:377）
		await act(async () => {
			host.querySelector("#timeline-add-event").click();
		});
		let body = document.getElementById("modal-body");
		let postCount = apiCalls.filter((c) => c.method === "POST").length;
		let rc;
		await act(async () => {
			rc = await lastModal.onOk(body);
		});
		expect(rc).toBe(false);
		expect(toasts).toContain("请填写事件标题");
		expect(apiCalls.filter((c) => c.method === "POST").length).toBe(postCount);
		// 字段切换：旧值重置为当前态、新值清空（:331-338）
		const row = body.querySelector(".ev-change-row");
		setSelectValue(row.querySelector(".ev-field"), "skills");
		expect(row.querySelector(".ev-old").value).toBe("剑法、身法");
		expect(row.querySelector(".ev-new").value).toBe("");
		setSelectValue(row.querySelector(".ev-field"), "mood");
		expect(row.querySelector(".ev-old").value).toBe("calm");
		expect(row.querySelector(".ev-new").value).toBe("");
		// 行删除：空则自动补一行（:339-342）
		await act(async () => {
			body.querySelector("#ev-add-change").click();
		});
		expect(body.querySelectorAll(".ev-change-row").length).toBe(2);
		await act(async () => {
			body
				.querySelectorAll(".ev-change-row")[1]
				.querySelector(".ev-remove")
				.click();
		});
		expect(body.querySelectorAll(".ev-change-row").length).toBe(1);
		await act(async () => {
			body.querySelector(".ev-change-row .ev-remove").click();
		});
		expect(body.querySelectorAll(".ev-change-row").length).toBe(1);
		// 无启用字段（:309）＋零变化（:383）
		fieldsFixture = [];
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector("#timeline-add-event").click();
		});
		body = document.getElementById("modal-body");
		expect(body.querySelector("#ev-changes").textContent).toBe(
			"本书还没有启用的状态字段，无法记录状态变化。",
		);
		body.querySelector("#ev-title").value = "有标题";
		postCount = apiCalls.filter((c) => c.method === "POST").length;
		await act(async () => {
			rc = await lastModal.onOk(body);
		});
		expect(rc).toBe(false);
		expect(toasts).toContain("至少需要一项变化");
		expect(apiCalls.filter((c) => c.method === "POST").length).toBe(postCount);
		// parseValue 直测（:345-354，el.value 显式参数化）
		expect(parseValue("list", "剑法、身法，内功")).toEqual([
			"剑法",
			"身法",
			"内功",
		]);
		expect(parseValue("list", " 单项 ")).toEqual(["单项"]);
		expect(parseValue("list", "")).toBeNull();
		expect(parseValue("text", "")).toBeNull();
		expect(parseValue("text", "值")).toBe("值");
	});

	it("B12 编辑弹窗预填：五字段回填、关系提示条逐字＋链接、他人变化不预填", async () => {
		let host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="11"]').click();
		});
		let body = document.getElementById("modal-body");
		expect(body.querySelector("#ev-title").value).toBe("初入宗门");
		expect(body.querySelector("#ev-summary").value).toBe("摘要一");
		expect(body.querySelector("#ev-importance").value).toBe("high");
		expect(body.querySelector("#ev-chapter").value).toBe("3");
		expect(body.querySelector("#ev-quote").value).toBe("正文引文原句");
		expect(body.querySelectorAll(".ev-change-row").length).toBe(1);
		// 关系变化提示条（:425-426）
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="13"]').click();
		});
		body = document.getElementById("modal-body");
		const notice = body.querySelector(".timeline-relation-notice");
		expect(notice.textContent).toContain(
			"该事件含 1 项关系变化，保存时将原样保留",
		);
		expect(notice.querySelector("a").textContent).toBe("关系 tab");
		expect(notice.querySelector("a").getAttribute("href")).toBe(
			"#/book/B1/workbench/characters/7?tab=relations",
		);
		// 仅本人物的状态变化预填（:424 subject_ref 过滤）→ 只剩缺省行
		host = await renderEmbedded();
		await act(async () => {
			host.querySelector('.timeline-edit-btn[data-edit="12"]').click();
		});
		body = document.getElementById("modal-body");
		expect(body.querySelectorAll(".ev-change-row").length).toBe(1);
		expect(body.querySelector(".ev-change-row .ev-field").value).toBe("mood");
	});

	it("B13 错误态与双模式（勘误按源码 :169-170：⤢ 放大仅 embedded，全屏无）", async () => {
		// 错误态（:202）
		eventsFail = true;
		const _page = buildTimelineFull();
		act(() => {
			mountTimelineFullPage("B1", "7");
		});
		await act(async () => {});
		expect(
			document
				.getElementById("timeline-full-content")
				.querySelector(".workbench-error").textContent,
		).toBe("网络故障");
		// 内嵌模式：有「⤢ 放大」且 href 指向 full 页（:169-170）
		eventsFail = false;
		const host = await renderEmbedded();
		const expand = host.querySelector(".timeline-expand-btn");
		expect(expand).not.toBeNull();
		expect(expand.textContent).toBe("⤢ 放大");
		expect(expand.getAttribute("href")).toBe("#/book/B1/characters/7/timeline");
		expect(expand.getAttribute("title")).toBe("在独立页面放大查看");
		expect(host.querySelector(".timeline-workspace").className).toBe(
			"timeline-workspace",
		);
		expect(host.querySelector(".timeline-scroll").className).toBe(
			"timeline-scroll",
		);
		// 全屏模式：容器类 timeline-workspace-full/timeline-scroll-full，无「⤢ 放大」
		eventsFail = false;
		buildTimelineFull();
		act(() => {
			mountTimelineFullPage("B1", "7");
		});
		await act(async () => {});
		const full = document.getElementById("timeline-full-content");
		expect(full.querySelector(".timeline-workspace-full")).not.toBeNull();
		expect(full.querySelector(".timeline-scroll-full")).not.toBeNull();
		expect(full.querySelector(".timeline-expand-btn")).toBeNull();
	});
});
