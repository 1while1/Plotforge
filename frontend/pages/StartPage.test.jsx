// @vitest-environment jsdom
// 开始界面（#/start）：真实书籍统计驱动世界卡与三维场景、换岛、空态、WebGL 兜底、
// 砚灵对话（SSE 经 consumeBookStream 消费、409 忙闸提示）、离开即释放场景。
// 三维场景模块整体 mock（jsdom 无 WebGL），只验页面与场景之间的契约。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scene = vi.hoisted(() => ({
	created: [],
	webgl: true,
}));

vi.mock("./start/world-scene.js", () => ({
	webglAvailable: () => scene.webgl,
	createWorldScene: (container, opts) => {
		const handle = {
			container,
			opts,
			selected: [],
			guide: [],
			disposed: false,
			setSelected(id) {
				handle.selected.push(id);
			},
			setGuideState(s) {
				handle.guide.push(s);
			},
			setActive() {},
			focusLabel() {},
			dispose() {
				handle.disposed = true;
			},
		};
		scene.created.push(handle);
		return handle;
	},
}));

import { mount, unmount } from "./StartPage.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WORLDS = [
	{
		id: 18,
		title: "长夜灯",
		intro: "一座灯塔城的故事",
		updatedAt: "2026-10-04 10:00:00",
		chapters: 36,
		words: 123456,
		characters: 7,
		worldEntries: 11,
		volumes: 2,
		lastChapterTitle: "第三十六章 潮汐",
	},
	{
		id: 5,
		title: "空山",
		intro: "",
		updatedAt: "2026-09-01 08:00:00",
		chapters: 0,
		words: 0,
		characters: 0,
		worldEntries: 0,
		volumes: 0,
		lastChapterTitle: "",
	},
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 2000) {
	const t0 = Date.now();
	for (;;) {
		if (cond()) return true;
		if (Date.now() - t0 > timeout) return false;
		await act(async () => {
			await sleep(10);
		});
	}
}

function sseResponse(events) {
	const enc = new TextEncoder();
	const body = new ReadableStream({
		start(c) {
			for (const ev of events)
				c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
			c.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

let calls;
let guideReply;
let worldsReply;

beforeEach(() => {
	scene.created = [];
	scene.webgl = true;
	calls = [];
	worldsReply = () =>
		new Response(JSON.stringify({ worlds: WORLDS }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	guideReply = () =>
		sseResponse([
			{ type: "content", text: "先回《长夜灯》" },
			{ type: "content", text: "，潮汐那章还热着。" },
			{ type: "done", content: "先回《长夜灯》，潮汐那章还热着。" },
		]);
	globalThis.fetch = vi.fn(async (url, opts) => {
		calls.push({ url, opts });
		if (url === "/api/start/worlds") return worldsReply();
		if (url === "/api/start/guide/stream") return guideReply();
		throw new Error(`unexpected ${url}`);
	});
	window.location.hash = "#/start";
	document.body.innerHTML = '<div id="page-start" class="page"></div>';
});

afterEach(async () => {
	await act(async () => unmount());
	const el = document.getElementById("page-start");
	if (el) el.__mozhenStartRoot?.unmount();
	document.body.innerHTML = "";
});

const $ = (sel) => document.querySelector(sel);

async function open() {
	await act(async () => mount());
	await waitFor(
		() =>
			scene.created.length > 0 ||
			$(".start-fallback") ||
			$(".start-card.is-empty"),
	);
}

describe("开始界面 StartPage", () => {
	it("S1 读真实统计：世界卡显示最近一本，场景拿到全部书并选中第一座岛", async () => {
		await open();
		expect(calls[0].url).toBe("/api/start/worlds");
		expect($(".start-card-title").textContent).toBe("长夜灯");
		const facts = [...document.querySelectorAll(".start-fact dd b")].map(
			(b) => b.textContent,
		);
		expect(facts).toEqual(["36", "7", "11"]);
		expect($(".start-card-last").textContent).toContain("第三十六章 潮汐");
		expect($(".start-card .start-btn.is-gilt").getAttribute("href")).toBe(
			"#/book/18",
		);
		expect($(".start-shelf-link").getAttribute("href")).toBe("#/");
		const s = scene.created[0];
		expect(s.opts.worlds.map((w) => w.id)).toEqual([18, 5]);
		await waitFor(() => s.selected.includes(18));
		expect(s.selected.at(-1)).toBe(18);
	});

	it("S2 换岛：下一座按钮、方向键与场景点选都同步世界卡和场景", async () => {
		await open();
		const s = scene.created[0];
		await act(async () => $('[aria-label="下一座岛"]').click());
		expect($(".start-card-title").textContent).toBe("空山");
		expect($(".start-card-last").textContent).toContain("还没有章节");
		expect(s.selected.at(-1)).toBe(5);
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
			);
		});
		expect($(".start-card-title").textContent).toBe("长夜灯");
		await act(async () => s.opts.onSelect(5));
		expect($(".start-card-title").textContent).toBe("空山");
		await act(async () => s.opts.onEnter(18));
		expect(window.location.hash).toBe("#/book/18");
	});

	it("S3 没有书：空态引导去书架新建，场景照常铺开空砚台", async () => {
		worldsReply = () =>
			new Response(JSON.stringify({ worlds: [] }), { status: 200 });
		await open();
		await waitFor(() => $(".start-card.is-empty"));
		expect($(".start-card.is-empty .start-btn").getAttribute("href")).toBe(
			"#/",
		);
		await waitFor(() => scene.created.length === 1);
		expect(scene.created[0].opts.worlds).toEqual([]);
	});

	it("S4 WebGL 不可用：退回岛名列表，世界卡照常可用", async () => {
		scene.webgl = false;
		await open();
		await waitFor(() => $(".start-fallback"));
		expect(scene.created).toHaveLength(0);
		const items = [...document.querySelectorAll(".start-fallback button")];
		expect(items).toHaveLength(2);
		await act(async () => items[1].click());
		expect($(".start-card-title").textContent).toBe("空山");
	});

	it("S5 砚灵对话：带上当前选中的书，流式增量落到气泡，场景跟着思考/空闲", async () => {
		await open();
		const s = scene.created[0];
		await act(async () => $(".start-guide-quick button").click());
		await waitFor(() =>
			$(".start-guide-msg.is-guide:last-child")?.textContent.includes(
				"潮汐那章",
			),
		);
		const req = calls.find((c) => c.url === "/api/start/guide/stream");
		const body = JSON.parse(req.opts.body);
		expect(body.focusBookId).toBe(18);
		expect(body.messages).toEqual([
			{ role: "user", content: "今天从哪本接着写？" },
		]);
		expect($(".start-guide-msg.is-user").textContent).toBe(
			"今天从哪本接着写？",
		);
		expect(s.guide).toContain("thinking");
		expect(s.guide.at(-1)).toBe("idle");
		expect($(".start-guide-quick")).toBeNull();
	});

	it("S6 忙闸 409：提示等上一句说完，问题放回输入框，不留空气泡", async () => {
		guideReply = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "CHAT_BUSY",
						message: "砚灵还在回答上一句，请稍候再发",
					},
				}),
				{ status: 409, headers: { "Content-Type": "application/json" } },
			);
		await open();
		const input = $("#start-guide-input");
		await act(async () => $(".start-guide-quick button").click());
		await waitFor(() => $(".start-guide-notice"));
		expect($(".start-guide-notice").textContent).toContain("等它说完再问");
		expect(document.querySelectorAll(".start-guide-msg")).toHaveLength(1);
		expect(input.value).toBe("今天从哪本接着写？");
	});

	it("S7 未配置模型：提示并给出去设置的链接", async () => {
		guideReply = () =>
			new Response(
				JSON.stringify({
					error: { code: "LLM_NOT_CONFIGURED", message: "还没有配置模型" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		await open();
		await act(async () => $(".start-guide-quick button").click());
		await waitFor(() => $(".start-guide-notice"));
		expect($(".start-guide-notice a").getAttribute("href")).toBe("#/settings");
	});

	it("S8 离开开始界面：场景被释放", async () => {
		await open();
		const s = scene.created[0];
		await act(async () => unmount());
		expect(s.disposed).toBe(true);
	});
});
