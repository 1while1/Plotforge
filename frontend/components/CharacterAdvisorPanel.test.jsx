// @vitest-environment jsdom
// S4-2 红测（Plan §4 T-B）：CharacterAdvisorPanel widget 范式（window.MozhenCharacterAdvisor 桥）。
// 断言语义锚点＝public/legacy/character-advisor.js 行号（Plan §4 T-B 表逐条）：
// B1 桥与挂载/loading 态／B2 会话卡缺省与时间截断、空态卡／B3 建议卡结构、null 引用防御、
// 非活跃无 footer／B4 忽略→重拉→toast／B5 采纳弹窗 payload 分型／B6 沙盘按钮态与弹窗／
// B7 证据锚点核对（章节段缺省/失效态/空引文）与继续追问空输入不提交／B8 错误态。
// D5 同款 harness：jsdom + React 19 act + 裸 DOM 断言；window.App.openModal 记录 lastModal。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountAdvisor } from "./CharacterAdvisorPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ADV = "/api/books/B1/characters/C1/advisor";
const ROUTE = { bookId: "B1" };
const CHARACTER = { id: "C1", name: "林晚" };

function freshSessions() {
	return [
		{
			id: 7,
			trigger_kind: "auto",
			focus: "弧光检查",
			created_at: "2026-09-26T10:30:00Z",
			suggestions: [
				{
					id: 5,
					type: "A",
					title: "建议标题",
					status: "active",
					conclusion: "结论文本",
					inference: "推断文本",
					assumptions: ["假设一", "假设二"],
					impacts: ["影响一", { k: 1 }],
					citations: [
						{
							anchor: "a1",
							quote: "引文原文",
							trust_class: "high",
							canonical_status: "canonical",
						},
						null,
						{
							anchor: "a2",
							quote_snapshot: "快照优先",
							trustClass: "low",
							canonicalStatus: "stale",
						},
					],
				},
				{
					id: 6,
					type: "B",
					title: "已完成建议",
					status: "done",
					conclusion: "c",
					citations: [],
				},
				{
					id: 9,
					type: "C",
					title: "无状态建议",
					conclusion: "c2",
					citations: [],
				},
			],
		},
		{
			id: 8,
			trigger_kind: null,
			focus: null,
			created_at: "2026-09-26T11:00Z",
			suggestions: [],
		},
	];
}

let sessionsFixture;
let failSessions;
let anchorFixture;
let sandboxDeferred;
let apiCalls;
let toasts;
let lastModal;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && path === `${ADV}/sessions?limit=20`) {
		if (failSessions) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({ items: sessionsFixture });
	}
	if (method === "POST" && path === `${ADV}/sandbox`) {
		return new Promise((resolve) => {
			sandboxDeferred = resolve;
		});
	}
	if (method === "POST" && path === `${ADV}/sessions`) {
		return Promise.resolve({});
	}
	if (method === "POST" && path === `${ADV}/suggestions/5/ignore`) {
		return Promise.resolve({});
	}
	if (method === "POST" && path === `${ADV}/suggestions/5/adopt`) {
		return Promise.resolve({});
	}
	if (method === "POST" && path === `${ADV}/sessions/7/follow-up`) {
		return Promise.resolve({});
	}
	if (method === "GET" && path === "/api/books/B1/evidence/anchors/a1") {
		return Promise.resolve(anchorFixture);
	}
	return Promise.resolve({});
}

function buildTabContent() {
	document.getElementById("character-tab-content")?.remove();
	const el = document.createElement("div");
	el.id = "character-tab-content";
	document.body.appendChild(el);
	return el;
}

async function showAndLoad() {
	const el = buildTabContent();
	act(() => {
		mountAdvisor(ROUTE, CHARACTER);
	});
	await act(async () => {});
	return el;
}

beforeEach(() => {
	document.body.innerHTML = "";
	sessionsFixture = freshSessions();
	failSessions = false;
	anchorFixture = {
		location: { chapterId: 3, paragraphIndex: 4 },
		quote: "正文引文",
		stale: false,
	};
	sandboxDeferred = null;
	apiCalls = [];
	toasts = [];
	lastModal = null;
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
		openModal(opts) {
			lastModal = opts;
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

describe("CharacterAdvisorPanel 组件（widget 范式 W）", () => {
	it("B1 桥与挂载：show 可用；#character-tab-content 缺失 no-op；show 即渲染 loading 态", async () => {
		expect(typeof mountAdvisor).toBe("function");
		// 挂载目标缺失：no-op 不抛
		document.getElementById("character-tab-content")?.remove();
		expect(() => mountAdvisor(ROUTE, CHARACTER)).not.toThrow();
		await act(async () => {});

		// show 即渲染 loading（advisor.js:113 逐字）——同步 act 提交首帧后断言
		const el = buildTabContent();
		act(() => {
			mountAdvisor(ROUTE, CHARACTER);
		});
		expect(el.querySelector(".workbench-loading").textContent).toBe(
			"正在读取人物顾问记录…",
		);
		await act(async () => {});
		// 加载完成后 loading 态消失
		expect(el.querySelector(".workbench-loading")).toBeNull();
	});

	it("B2 会话渲染：trigger_kind/focus 缺省、created_at T→空格截 16、空列表空态卡", async () => {
		const el = await showAndLoad();
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === `${ADV}/sessions?limit=20`,
			),
		).toBe(true);
		const cards = el.querySelectorAll(".advisor-session");
		expect(cards.length).toBe(2);
		// session 7
		expect(cards[0].querySelector(".workbench-kicker").textContent).toBe(
			"auto",
		);
		expect(cards[0].querySelector("h2").textContent).toBe("弧光检查");
		expect(cards[0].querySelector("time").textContent).toBe("2026-09-26 10:30");
		// session 8：缺省 manual / 人物分析
		expect(cards[1].querySelector(".workbench-kicker").textContent).toBe(
			"manual",
		);
		expect(cards[1].querySelector("h2").textContent).toBe("人物分析");
		expect(cards[1].querySelector("time").textContent).toBe("2026-09-26 11:00");

		// 空列表 → 空态卡逐字（advisor.js:34）
		sessionsFixture = [];
		await showAndLoad();
		const empty = document.querySelector("#character-tab-content");
		expect(empty.querySelector(".workbench-empty-card h3").textContent).toBe(
			"还没有顾问记录",
		);
		expect(empty.querySelector(".workbench-empty-card p").textContent).toBe(
			"选择一个分析焦点，顾问会在固定证据包内给出可追溯建议。",
		);
	});

	it("B3 建议卡：type 徽标/标题/结论/推断/假设边界/潜在影响/证据 N 条；null 引用跳过；非活跃无 footer", async () => {
		const el = await showAndLoad();
		const arts = el.querySelectorAll(".advisor-suggestion");
		expect(arts.length).toBe(3);

		const a = arts[0];
		expect(a.dataset.suggestionId).toBe("5");
		expect(a.querySelector(".advisor-type").className).toBe(
			"advisor-type type-A",
		);
		expect(a.querySelector(".advisor-type").textContent).toBe("A");
		expect(a.querySelector("h3").textContent).toBe("建议标题");
		expect(a.querySelector("header small").textContent).toBe("active");
		expect(a.querySelector("section p").textContent).toBe("结论文本");
		// 推断 section
		const sections = Array.from(a.querySelectorAll("section"));
		expect(sections[1].querySelector("h4").textContent).toBe("推断");
		expect(sections[1].querySelector("p").textContent).toBe("推断文本");
		// details 两个
		const details = Array.from(a.querySelectorAll("details")).filter(
			(d) => !d.classList.contains("advisor-evidence"),
		);
		expect(details[0].querySelector("summary").textContent).toBe("假设边界");
		expect(details[0].querySelectorAll("li").length).toBe(2);
		expect(details[1].querySelector("summary").textContent).toBe("潜在影响");
		const impactLis = Array.from(details[1].querySelectorAll("li")).map(
			(li) => li.textContent,
		);
		expect(impactLis).toEqual(["影响一", '{"k":1}']);
		// 证据 details 默认展开、3 条引用、null 跳过不中断
		const evidence = a.querySelector("details.advisor-evidence");
		expect(evidence.hasAttribute("open")).toBe(true);
		expect(evidence.querySelector("summary").textContent).toBe("证据 3 条");
		const lis = evidence.querySelectorAll("li");
		expect(lis.length).toBe(2);
		expect(lis[0].querySelector(".advisor-anchor").dataset.anchor).toBe("a1");
		expect(lis[0].querySelector("blockquote").textContent).toBe("引文原文");
		expect(lis[1].querySelector("blockquote").textContent).toBe("快照优先");
		// 活跃 → footer 两按钮
		expect(a.querySelector("footer .advisor-adopt").textContent).toBe(
			"采纳到…",
		);
		expect(a.querySelector("footer .advisor-ignore").textContent).toBe("忽略");

		// status='done' → 无 footer
		const b = arts[1];
		expect(b.dataset.suggestionId).toBe("6");
		expect(b.querySelector("footer")).toBeNull();
		// 无 status → footer 有（!item.status 分支）
		expect(arts[2].querySelector("footer")).not.toBeNull();
	});

	it("B4 忽略：POST ignore → 重拉 → toast 逐字", async () => {
		await showAndLoad();
		await act(async () => {
			document
				.querySelector(
					'.advisor-suggestion[data-suggestion-id="5"] .advisor-ignore',
				)
				.click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === `${ADV}/suggestions/5/ignore`,
			),
		).toBe(true);
		// 重拉：GET sessions 第二次
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === `${ADV}/sessions?limit=20`,
			).length,
		).toBe(2);
		expect(toasts).toContain("已忽略；证据未变化前不会重复出现");
	});

	it("B5 采纳：openModal 弹「选择采纳目标」；payload 分型（character_profile→patch，其余→title/summary）", async () => {
		await showAndLoad();
		await act(async () => {
			document
				.querySelector(
					'.advisor-suggestion[data-suggestion-id="5"] .advisor-adopt',
				)
				.click();
		});
		expect(lastModal).not.toBeNull();
		expect(lastModal.title).toBe("选择采纳目标");
		expect(lastModal.okText).toBe("确认采纳");

		// target=character_profile → { patch: { note } }
		const body1 = document.createElement("div");
		body1.innerHTML =
			'<select id="advisor-target"><option value="story_thread">新建故事线</option><option value="character_profile">人物档案备注</option></select>' +
			'<textarea id="advisor-adopt-note">备注内容</textarea>';
		body1.querySelector("#advisor-target").value = "character_profile";
		await act(async () => {
			await lastModal.onOk(body1);
		});
		expect(
			apiCalls.find(
				(c) => c.method === "POST" && c.path === `${ADV}/suggestions/5/adopt`,
			).body,
		).toEqual({
			target: "character_profile",
			payload: { patch: { note: "备注内容" } },
		});
		expect(toasts).toContain("建议已采纳到指定位置");

		// target=story_thread → { title, summary }
		await act(async () => {
			document
				.querySelector(
					'.advisor-suggestion[data-suggestion-id="5"] .advisor-adopt',
				)
				.click();
		});
		const body2 = document.createElement("div");
		body2.innerHTML =
			'<select id="advisor-target"><option value="story_thread">新建故事线</option></select>' +
			'<textarea id="advisor-adopt-note">故事线条目</textarea>';
		await act(async () => {
			await lastModal.onOk(body2);
		});
		expect(
			apiCalls
				.filter(
					(c) => c.method === "POST" && c.path === `${ADV}/suggestions/5/adopt`,
				)
				.pop().body,
		).toEqual({
			target: "story_thread",
			payload: { title: "故事线条目", summary: "故事线条目" },
		});
	});

	it("B6 沙盘：POST sandbox → openModal「非正典沙盘结果」；飞行中按钮 disabled＋文案、结束恢复", async () => {
		const el = await showAndLoad();
		const btn = el.ownerDocument.getElementById("advisor-sandbox");
		await act(async () => {
			btn.click();
		});
		// 飞行中：disabled + 文案逐字（advisor.js:81）
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("正在核对证据…");
		// 结束：恢复
		await act(async () => {
			sandboxDeferred({
				suggestions: [
					{
						id: 99,
						type: "D",
						title: "沙盘建议标题",
						conclusion: "c",
						citations: [],
					},
				],
			});
		});
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("沙盘推演");
		// 弹窗逐字（advisor.js:85）
		expect(lastModal.title).toBe("非正典沙盘结果");
		expect(lastModal.okText).toBe("关闭");
		expect(lastModal.bodyHTML).toContain(
			'<div class="advisor-suggestions sandbox">',
		);
		expect(lastModal.bodyHTML).toContain("沙盘建议标题");
	});

	it("B7 证据锚点：GET anchors/:anchor → openModal「证据核对」逐字；stale/缺省变体；继续追问空输入不提交", async () => {
		const el = await showAndLoad();
		// 有效态
		await act(async () => {
			el.querySelector('.advisor-anchor[data-anchor="a1"]').click();
		});
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" && c.path === "/api/books/B1/evidence/anchors/a1",
			),
		).toBe(true);
		expect(lastModal.title).toBe("证据核对");
		expect(lastModal.okText).toBe("关闭");
		expect(lastModal.bodyHTML).toContain("锚点 a1 · 第 3 章第 4 段");
		expect(lastModal.bodyHTML).toContain("<blockquote>正文引文</blockquote>");
		expect(lastModal.bodyHTML).toContain("有效：与当前定稿正文一致。");

		// 失效态
		anchorFixture = { ...anchorFixture, stale: true };
		await act(async () => {
			el.querySelector('.advisor-anchor[data-anchor="a1"]').click();
		});
		expect(lastModal.bodyHTML).toContain(
			"已失效：正文在建议生成后被修改过，此引用不再对应当前内容。",
		);

		// location 缺失 + quote 空 → 「?」与兜底文案
		anchorFixture = { location: null, quote: "", stale: false };
		await act(async () => {
			el.querySelector('.advisor-anchor[data-anchor="a1"]').click();
		});
		expect(lastModal.bodyHTML).toContain("锚点 a1 · 第 ? 章第 ? 段");
		expect(lastModal.bodyHTML).toContain("（当前正文中没有这一段）");

		// 继续追问：空输入不提交（onOk 返回 false、零请求）；非空提交
		await act(async () => {
			el.querySelector('.advisor-follow-up[data-session-id="7"]').click();
		});
		expect(lastModal.title).toBe("继续追问");
		expect(lastModal.okText).toBe("提交追问");
		const emptyBody = document.createElement("div");
		emptyBody.innerHTML = '<textarea id="advisor-follow-question"></textarea>';
		let rc;
		await act(async () => {
			rc = await lastModal.onOk(emptyBody);
		});
		expect(rc).toBe(false);
		expect(
			apiCalls.some(
				(c) => c.method === "POST" && c.path === `${ADV}/sessions/7/follow-up`,
			),
		).toBe(false);
		const filled = document.createElement("div");
		filled.innerHTML =
			'<textarea id="advisor-follow-question">新的问题</textarea>';
		await act(async () => {
			await lastModal.onOk(filled);
		});
		expect(
			apiCalls.find(
				(c) => c.method === "POST" && c.path === `${ADV}/sessions/7/follow-up`,
			).body,
		).toEqual({ question: "新的问题" });
	});

	it("B8 错误态：sessions GET reject → .workbench-error 渲染 error.message", async () => {
		failSessions = true;
		const el = buildTabContent();
		act(() => {
			mountAdvisor(ROUTE, CHARACTER);
		});
		await act(async () => {});
		expect(el.querySelector(".workbench-error").textContent).toBe("网络故障");
	});
});
