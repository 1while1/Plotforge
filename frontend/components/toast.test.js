// @vitest-environment jsdom
// S3-1 红测（Plan §4 T6~T7）：showToast 命令式接管既有 #toast（等价 app.js:52~61）。
// 断言语义：textContent 写入、去 hidden、2500ms 后加回 hidden（fake timers）、
// 接管既有节点不新建、连发重置计时（第一条的 timer 不再触发隐藏）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "./toast.js";

beforeEach(() => {
	document.body.innerHTML = `<div id="toast" class="toast hidden"></div>`;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("toast 基础件（命令式 showToast）", () => {
	it("T6 写入既有 #toast：textContent、去 hidden、2500ms 后 hidden、不新建节点", () => {
		const el = document.getElementById("toast");
		showToast("状态簿已保存");
		expect(document.getElementById("toast")).toBe(el);
		expect(el.textContent).toBe("状态簿已保存");
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(2499);
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(1);
		expect(el.classList.contains("hidden")).toBe(true);
	});

	it("T7 连发：2500ms 内再 show → 计时重置（第一条 timer 不再隐藏）", () => {
		const el = document.getElementById("toast");
		showToast("第一条");
		vi.advanceTimersByTime(2000);
		showToast("第二条");
		vi.advanceTimersByTime(2000);
		expect(el.textContent).toBe("第二条");
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(500);
		expect(el.classList.contains("hidden")).toBe(true);
	});
});
