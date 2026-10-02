// @vitest-environment jsdom
// S2-2 红测（Plan §4 T7~T11）：ProfilePage 路由页范式（window.MozhenProfile 桥委托）。
// 断言语义：加载态等价旧 setLoading、数据态 fmtWan 与用卡链 meta 逐字、HTML 转义、
// data-go/data-prompt-book 回调、连续 mount 重拉与错误态。
// D5：jsdom + React 19 内建 act + 裸 DOM 断言（不装 @testing-library/*）。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountProfile } from "../pages/ProfilePage.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PACKS = [
	{ id: "p1", name: "去 AI 味·通用" },
	{ id: "p2", name: "主卡·冷峻短句" },
];
const STATS = { total: 5, byBook: [{ bookId: "b1", count: 5 }] };
const EFFECTIVES = {
	b1: {
		chain_ids: ["p2", "p1"],
		main_id: "p2",
		aux_ids: ["p1"],
		source: "own",
	},
	b2: { chain_ids: ["p1"], main_id: null, aux_ids: ["p1"], source: "basic" },
};

function freshBooks() {
	return [
		{ id: "b1", title: "书一", system_prompt: "" },
		{
			id: "b2",
			title: "<img src=x onerror=alert(1)>evil",
			system_prompt: "自定义提示词<script>alert(2)</script>",
		},
		{ id: "b 3", title: "书三", system_prompt: "" },
	];
}

let apiCalls = [];
let toasts = [];
let lastModal = null;
let failBooks = false;
let emptyBooks = false;
let failPutBookId = null;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && path === "/api/books") {
		if (failBooks) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({ books: emptyBooks ? [] : freshBooks() });
	}
	if (method === "GET" && path === "/api/style-lab/packs")
		return Promise.resolve({ packs: PACKS });
	if (method === "GET" && path === "/api/style-lab/stats")
		return Promise.resolve({ stats: STATS });
	if (method === "GET" && /^\/api\/books\/(.+)\/delete-preview$/.test(path)) {
		const id = decodeURIComponent(
			path.match(/^\/api\/books\/(.+)\/delete-preview$/)[1],
		);
		return Promise.resolve({ words: id === "b1" ? 12345 : 0 });
	}
	if (method === "GET" && path.startsWith("/api/style-lab/packs?book_id=")) {
		const id = decodeURIComponent(
			path.slice("/api/style-lab/packs?book_id=".length),
		);
		return Promise.resolve({ effective: EFFECTIVES[id] || null });
	}
	if (method === "PUT" && /^\/api\/books\/[^/?]+$/.test(path)) {
		const id = decodeURIComponent(path.slice("/api/books/".length));
		if (failPutBookId === id) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({});
	}
	return Promise.resolve({});
}

function buildPageSkeleton() {
	// 同一时刻只保留一个 #page-profile（mount() 取 document.querySelector 第一个命中）
	document.getElementById("page-profile")?.remove();
	const page = document.createElement("div");
	page.id = "page-profile";
	const main = document.createElement("main");
	main.className = "profile-main";
	page.appendChild(main);
	document.body.appendChild(page);
	return main;
}

async function mountAndLoad() {
	const main = buildPageSkeleton();
	act(() => {
		mountProfile();
	});
	await act(async () => {});
	return main;
}

beforeEach(() => {
	document.body.innerHTML = "";
	apiCalls = [];
	toasts = [];
	lastModal = null;
	failBooks = false;
	emptyBooks = false;
	failPutBookId = null;
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

describe("ProfilePage 组件（路由页范式）", () => {
	it("T7 加载态：mount 后立即渲染 4 个 … stat 与 3 个 载入中… 行", async () => {
		buildPageSkeleton();
		act(() => {
			mountProfile();
		});
		const stats = document.querySelectorAll("#profile-stats .profile-stat b");
		expect(stats.length).toBe(4);
		for (const b of stats) expect(b.textContent).toBe("…");
		for (const key of ["cards", "stylelab", "prompts"]) {
			expect(document.getElementById(`profile-sum-${key}`).textContent).toBe(
				"…",
			);
			const empty = document
				.getElementById(`profile-rows-${key}`)
				.querySelector(".profile-empty");
			expect(empty).not.toBeNull();
			expect(empty.textContent).toBe("载入中…");
		}
		// 冲洗未完成的 loadAll，避免 teardown 阶段 act 警告
		await act(async () => {});
	});

	it("T8 数据态：stats 四格、fmtWan 1.2 万、用卡链 meta 逐字、chip、提示词行、空书列表", async () => {
		await mountAndLoad();
		const nums = Array.from(
			document.querySelectorAll("#profile-stats .profile-stat b"),
		).map((n) => n.textContent);
		expect(nums).toEqual(["3", "2", "5", "1.2 万"]);
		const labels = Array.from(
			document.querySelectorAll("#profile-stats .profile-stat span"),
		).map((n) => n.textContent);
		expect(labels).toEqual(["作品", "作家卡", "错题", "累计字数"]);
		expect(document.getElementById("profile-sum-cards").textContent).toBe(
			"卡库 2 张",
		);

		const cardRows = document
			.getElementById("profile-rows-cards")
			.querySelectorAll("button.profile-book-row");
		expect(
			Array.from(cardRows).map((r) => r.querySelector(".pbr-name").textContent),
		).toEqual(["书一", "<img src=x onerror=alert(1)>evil", "书三"]);
		expect(
			Array.from(cardRows).map((r) => r.querySelector(".pbr-meta").textContent),
		).toEqual(["主卡·冷峻短句 ＋1 辅", "兜底：仅 1 张辅卡", "未指定用卡"]);
		expect(cardRows[0].getAttribute("data-go")).toBe("#/book/b1/cards");
		expect(cardRows[2].getAttribute("data-go")).toBe("#/book/b%203/cards");

		expect(document.getElementById("profile-sum-stylelab").textContent).toBe(
			"共 5 条",
		);
		const labRows = document
			.getElementById("profile-rows-stylelab")
			.querySelectorAll("button.profile-book-row");
		expect(
			Array.from(labRows).map((r) => r.querySelector(".pbr-chip").textContent),
		).toEqual(["5 条", "0 条", "0 条"]);
		expect(labRows[0].querySelector(".pbr-chip").className).toBe("pbr-chip on");
		expect(labRows[1].querySelector(".pbr-chip").className).toBe(
			"pbr-chip off",
		);

		expect(document.getElementById("profile-sum-prompts").textContent).toBe(
			"1 本已覆盖",
		);
		const promptRows = document
			.getElementById("profile-rows-prompts")
			.querySelectorAll("button.profile-book-row");
		expect(
			Array.from(promptRows).map(
				(r) => r.querySelector(".pbr-chip").textContent,
			),
		).toEqual(["跟随全局", "已覆盖", "跟随全局"]);
		expect(
			Array.from(promptRows).map((r) => r.getAttribute("data-prompt-book")),
		).toEqual(["b1", "b2", "b 3"]);

		// 空书列表 → profile-empty 文案（stats 归零但全局 packs/stats 仍在）
		emptyBooks = true;
		buildPageSkeleton();
		act(() => {
			mountProfile();
		});
		await act(async () => {});
		const emptyNums = Array.from(
			document.querySelectorAll("#profile-stats .profile-stat b"),
		).map((n) => n.textContent);
		expect(emptyNums).toEqual(["0", "2", "5", "0"]);
		const empties = document.querySelectorAll(".profile-empty");
		expect(empties.length).toBe(3);
		for (const e of empties)
			expect(e.textContent).toBe("还没有作品，先去书架新建一部");
	});

	it("T9 HTML 转义：书名渲染为纯文本无 img；弹窗 bodyHTML 内 system_prompt 转义", async () => {
		await mountAndLoad();
		expect(
			document
				.querySelector("#page-profile .profile-main")
				.querySelectorAll("img").length,
		).toBe(0);
		expect(document.getElementById("profile-rows-cards").textContent).toContain(
			"<img src=x onerror=alert(1)>evil",
		);

		const promptRows = document
			.getElementById("profile-rows-prompts")
			.querySelectorAll("button.profile-book-row");
		await act(async () => {
			promptRows[1].click();
		});
		expect(lastModal).not.toBeNull();
		expect(lastModal.title).toBe(
			"本书系统提示词 · <img src=x onerror=alert(1)>evil",
		);
		expect(lastModal.bodyHTML).toContain("&lt;script&gt;");
		expect(lastModal.bodyHTML).not.toContain("<script>");
	});

	it("T10 回调：data-go 改 hash；data-prompt-book 开弹窗；onOk PUT+toast；失败返回 false", async () => {
		await mountAndLoad();
		expect(location.hash).toBe("");
		const cardRow = document.querySelector(
			'#profile-rows-cards [data-go="#/book/b1/cards"]',
		);
		await act(async () => {
			cardRow.click();
		});
		expect(location.hash).toBe("#/book/b1/cards");

		let promptRows = document
			.getElementById("profile-rows-prompts")
			.querySelectorAll("button.profile-book-row");
		await act(async () => {
			promptRows[0].click();
		});
		expect(lastModal.title).toBe("本书系统提示词 · 书一");
		const ta = document.createElement("textarea");
		ta.id = "bp-prompt";
		ta.value = "  新提示词  ";
		document.body.appendChild(ta);
		await act(async () => {
			await lastModal.onOk();
		});
		const put = apiCalls.find((c) => c.method === "PUT");
		expect(put).toEqual({
			method: "PUT",
			path: "/api/books/b1",
			body: { system_prompt: "新提示词" },
		});
		expect(toasts).toContain("已保存");
		const chips = Array.from(
			document
				.getElementById("profile-rows-prompts")
				.querySelectorAll(".pbr-chip"),
		);
		expect(chips.map((c) => c.textContent)).toEqual([
			"已覆盖",
			"已覆盖",
			"跟随全局",
		]);
		expect(document.getElementById("profile-sum-prompts").textContent).toBe(
			"2 本已覆盖",
		);

		apiCalls = [];
		toasts = [];
		failPutBookId = "b2";
		promptRows = document
			.getElementById("profile-rows-prompts")
			.querySelectorAll("button.profile-book-row");
		await act(async () => {
			promptRows[1].click();
		});
		const ta2 = document.createElement("textarea");
		ta2.id = "bp-prompt";
		ta2.value = "改动";
		document.body.appendChild(ta2);
		let rc;
		await act(async () => {
			rc = await lastModal.onOk();
		});
		expect(rc).toBe(false);
		expect(toasts).toContain("网络故障");
	});

	it("T11 重挂载语义：连续 mount 两次 GET /api/books 恰 2 次；api 拒绝进错误态", async () => {
		buildPageSkeleton();
		act(() => {
			mountProfile();
		});
		await act(async () => {});
		// 同一 .profile-main 元素上第二次 mount（key=visit++ 重挂重拉，等价旧 show() 每次重拉）
		act(() => {
			mountProfile();
		});
		await act(async () => {});
		const bookCalls = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/books",
		);
		expect(bookCalls.length).toBe(2);

		failBooks = true;
		act(() => {
			mountProfile();
		});
		await act(async () => {});
		expect(document.getElementById("profile-stats").childElementCount).toBe(0);
		for (const key of ["cards", "stylelab", "prompts"]) {
			expect(document.getElementById(`profile-sum-${key}`).textContent).toBe(
				"",
			);
			const empty = document
				.getElementById(`profile-rows-${key}`)
				.querySelector(".profile-empty");
			expect(empty.textContent).toBe("载入失败：网络故障");
		}
	});
});
