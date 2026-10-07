// @vitest-environment jsdom
// 贴底跟随：content-visibility 占位导致置底后 scrollHeight 继续增长、滚动锚定回拉的场景
// 用可写的 scrollHeight/clientHeight 模拟；jsdom 无 rAF/ResizeObserver，测试内桩出。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachBottomFollow,
	followTick,
	isFollowingBottom,
	scrollToBottom,
} from "./scroll-follow.js";

let roCallbacks = [];

function box({ scrollHeight = 1000, clientHeight = 200 } = {}) {
	const el = document.createElement("div");
	el.appendChild(document.createElement("p"));
	document.body.appendChild(el);
	const dims = { scrollHeight, clientHeight };
	Object.defineProperty(el, "scrollHeight", {
		get: () => dims.scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		get: () => dims.clientHeight,
		configurable: true,
	});
	let top = 0;
	// 与浏览器一致：scrollTop 被钳在 [0, scrollHeight - clientHeight]
	Object.defineProperty(el, "scrollTop", {
		get: () => top,
		set: (v) => {
			top = Math.max(0, Math.min(v, dims.scrollHeight - dims.clientHeight));
		},
		configurable: true,
	});
	return { el, dims };
}

const frames = (n = 1) =>
	new Promise((r) => setTimeout(r, n * 5 + 5)).then(() => undefined);

function fireResize() {
	for (const cb of roCallbacks) cb([]);
}

beforeEach(() => {
	document.body.innerHTML = "";
	roCallbacks = [];
	globalThis.requestAnimationFrame = (cb) =>
		setTimeout(() => cb(Date.now()), 0);
	globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
	globalThis.ResizeObserver = class {
		constructor(cb) {
			roCallbacks.push(cb);
		}
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(() => {
	delete globalThis.requestAnimationFrame;
	delete globalThis.cancelAnimationFrame;
	delete globalThis.ResizeObserver;
});

describe("scroll-follow", () => {
	it("无跟随器：同步置底，之后高度增长逐帧补滚到底", async () => {
		const { el, dims } = box();
		scrollToBottom(el);
		expect(el.scrollTop).toBe(800);
		// 屏外消息渲染出真实高度＋滚动锚定回拉
		dims.scrollHeight = 2400;
		el.scrollTop = 500;
		await frames(3);
		expect(el.scrollTop).toBe(2200);
	});

	it("跟随器：贴底时内容尺寸变化持续贴底", () => {
		const { el, dims } = box();
		const dispose = attachBottomFollow(el);
		scrollToBottom(el);
		dims.scrollHeight = 1800;
		fireResize();
		expect(el.scrollTop).toBe(1600);
		expect(isFollowingBottom(el)).toBe(true);
		dispose();
		expect(isFollowingBottom(el)).toBe(null);
	});

	it("用户滚轮上翻即脱离跟随：增长与流式节拍都不再拉回；pin 后恢复", () => {
		const { el, dims } = box();
		attachBottomFollow(el);
		scrollToBottom(el);
		el.dispatchEvent(new Event("wheel"));
		el.scrollTop = 100;
		el.dispatchEvent(new Event("scroll"));
		expect(isFollowingBottom(el)).toBe(false);
		dims.scrollHeight = 1500;
		fireResize();
		followTick(el);
		expect(el.scrollTop).toBe(100);
		scrollToBottom(el);
		expect(isFollowingBottom(el)).toBe(true);
		expect(el.scrollTop).toBe(1300);
	});

	it("布局引起的 scroll（无用户操作）不改变跟随状态", () => {
		const { el } = box();
		attachBottomFollow(el);
		scrollToBottom(el);
		el.scrollTop = 300; // 模拟滚动锚定回拉
		el.dispatchEvent(new Event("scroll"));
		expect(isFollowingBottom(el)).toBe(true);
		fireResize();
		expect(el.scrollTop).toBe(800);
	});

	it("空目标安全；重复挂载幂等", () => {
		expect(() => scrollToBottom(null)).not.toThrow();
		expect(() => followTick(null)).not.toThrow();
		const { el } = box();
		const d1 = attachBottomFollow(el);
		const d2 = attachBottomFollow(el);
		expect(d1).toBe(d2);
		expect(roCallbacks.length).toBe(1);
	});
});
