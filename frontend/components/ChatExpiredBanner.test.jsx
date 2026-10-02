// @vitest-environment jsdom
// S5-5 红测（Plan §4 T4）：ChatExpiredBanner（B3 过期操作横幅）。语义锚点＝
// public/legacy/book-chat.js :1408-1532（标题行 :1478-1482／归组 :1484-1513／尾行与关闭 :1515-1529／
// 批键与关闭记忆 :1453-1456、:1470-1472／宿主平级 :1438-1451）。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-17 同款）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatExpiredBanner } from "./ChatExpiredBanner.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;

function render(props) {
	act(() => {
		root.render(<ChatExpiredBanner {...props} />);
	});
}

function banner() {
	return host.querySelector(".expired-banner");
}

function ts(y, mo, d, h, mi) {
	return new Date(y, mo - 1, d, h, mi, 0).getTime();
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
	globalThis.fetch = vi.fn(() => {
		throw new Error("组件内不得 fetch");
	});
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	delete globalThis.fetch;
});

describe("T4 ChatExpiredBanner（legacy 行号锚点）", () => {
	it("T4-1 契约降级：非数组／空数组／全假值 → 不渲染任何节点（:1466-1467）", () => {
		render({ bookId: "B1", expired: undefined, overflow: 2 });
		expect(host.innerHTML).toBe("");
		render({ bookId: "B1", expired: [], overflow: 2 });
		expect(host.innerHTML).toBe("");
		render({ bookId: "B1", expired: [null, undefined, ""], overflow: 2 });
		expect(host.innerHTML).toBe("");
		render({ bookId: "B1", expired: "有 2 个", overflow: 2 });
		expect(host.innerHTML).toBe("");
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("T4-2 标题行逐字与 overflow 降级（isFinite＋Math.floor，:1468-1482）", () => {
		const items = [{ id: "a", name: "append_chapter", args: {} }];
		render({ bookId: "B1", expired: items, overflow: 3 });
		expect(banner().querySelector(".expired-text").textContent).toBe(
			"有 1 个操作等待确认超时、从未执行：（另有 3 个未列出）",
		);
		render({ bookId: "B1", expired: items });
		expect(banner().querySelector(".expired-text").textContent).toBe(
			"有 1 个操作等待确认超时、从未执行：",
		);
		render({ bookId: "B1", expired: items, overflow: 0 });
		expect(banner().querySelector(".expired-text").textContent).not.toContain(
			"另有",
		);
		render({ bookId: "B1", expired: items, overflow: -2 });
		expect(banner().querySelector(".expired-text").textContent).not.toContain(
			"另有",
		);
		render({ bookId: "B1", expired: items, overflow: "abc" });
		expect(banner().querySelector(".expired-text").textContent).not.toContain(
			"另有",
		);
		render({ bookId: "B1", expired: items, overflow: "2.7" });
		expect(banner().querySelector(".expired-text").textContent).toContain(
			"（另有 2 个未列出）",
		);
	});

	it("T4-3 按工具名首次出现顺序归组 ×N；明细行逐字、无 expiredAt 则无括号段（:1484-1513）", () => {
		render({
			bookId: "B1",
			expired: [
				{
					id: "a",
					name: "append_chapter",
					args: { chapterId: 1 },
					expiredAt: ts(2026, 1, 5, 7, 8),
				},
				{
					id: "b",
					name: "append_chapter",
					args: { chapterId: 2 },
					expiredAt: ts(2026, 1, 5, 7, 9),
				},
				{ id: "c", name: "write_story_state", args: {}, expiredAt: 0 },
			],
		});
		const groups = [...banner().querySelectorAll(".expired-tool-group")];
		expect(groups.length).toBe(2);
		const btns = groups.map((g) => g.querySelector(".expired-tool"));
		expect(btns.map((b) => b.textContent)).toEqual([
			"追加章节正文 ×2",
			"改写状态簿",
		]);
		expect(btns.every((b) => b.getAttribute("type") === "button")).toBe(true);
		const rows0 = [...groups[0].querySelectorAll(".expired-detail-row")];
		expect(rows0.map((r) => r.textContent)).toEqual([
			'追加章节正文 · {"chapterId":1}（过期于 2026-01-05 07:08）',
			'追加章节正文 · {"chapterId":2}（过期于 2026-01-05 07:09）',
		]);
		const rows1 = [...groups[1].querySelectorAll(".expired-detail-row")];
		expect(rows1.map((r) => r.textContent)).toEqual(["改写状态簿 · {}"]);
		// 明细默认隐藏（:1501）
		expect(
			groups[0].querySelector(".expired-detail").classList.contains("hidden"),
		).toBe(true);
		// 未知工具名回落「未知操作」（toolLabel :1434-1436）
		render({ bookId: "B1", expired: [{ id: "d", name: "", args: {} }] });
		expect(banner().querySelector(".expired-tool").textContent).toBe(
			"未知操作",
		);
	});

	it("T4-4 尾行／关闭按钮 title 逐字／role 与根类（:1474-1476、:1515-1529）", () => {
		render({
			bookId: "B1",
			expired: [{ id: "a", name: "append_chapter", args: {} }],
		});
		const bar = banner();
		expect(bar.getAttribute("role")).toBe("status");
		expect(bar.classList.contains("expired-banner")).toBe(true);
		const texts = [...bar.querySelectorAll(".expired-text")];
		expect(texts[texts.length - 1].textContent).toBe(
			"（AI 已被告知，不要当成已完成）",
		);
		const close = bar.querySelector(".expired-close");
		expect(close.textContent).toBe("×");
		expect(close.title).toBe("关闭提示（仅隐藏本条，不改变操作状态）");
		expect(close.getAttribute("type")).toBe("button");
	});

	it("T4-5 关闭记忆按批键：同批不再渲染、换书或新批次重现、零请求（:1453-1456、:1470-1472）", async () => {
		const items = [{ id: "a", name: "append_chapter", args: {} }];
		render({ bookId: "B1", expired: items });
		await act(async () => {
			banner().querySelector(".expired-close").click();
		});
		expect(banner()).toBeNull();
		render({ bookId: "B1", expired: items });
		expect(banner()).toBeNull();
		render({ bookId: "B2", expired: items });
		expect(banner()).not.toBeNull();
		// 回到 B1 并出现新批次（id 集合变化）→ 重现
		render({
			bookId: "B1",
			expired: [{ id: "z", name: "append_chapter", args: {} }],
		});
		expect(banner()).not.toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("T4-7 多组展开态互相独立：各组 toggle 自己的明细（:1509）", async () => {
		render({
			bookId: "B1",
			expired: [
				{ id: "a", name: "append_chapter", args: {} },
				{ id: "b", name: "write_story_state", args: {} },
			],
		});
		const [g1, g2] = [...banner().querySelectorAll(".expired-tool-group")];
		await act(async () => {
			g1.querySelector(".expired-tool").click();
		});
		expect(
			g1.querySelector(".expired-detail").classList.contains("hidden"),
		).toBe(false);
		expect(
			g2.querySelector(".expired-detail").classList.contains("hidden"),
		).toBe(true);
	});

	it("T4-6 展开态：点工具名切换明细 hidden，再点收起（:1509）", async () => {
		render({
			bookId: "B1",
			expired: [{ id: "a", name: "append_chapter", args: {} }],
		});
		const btn = banner().querySelector(".expired-tool");
		const detail = banner().querySelector(".expired-detail");
		expect(detail.classList.contains("hidden")).toBe(true);
		await act(async () => {
			btn.click();
		});
		expect(detail.classList.contains("hidden")).toBe(false);
		await act(async () => {
			btn.click();
		});
		expect(detail.classList.contains("hidden")).toBe(true);
		expect(window.BookPage).toBeUndefined();
	});
});
