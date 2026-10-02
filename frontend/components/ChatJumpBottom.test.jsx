// @vitest-environment jsdom
// S3-1 红测（Plan §4 T16~T17）：ChatJumpBottom 自挂载——包 .chat-scroll-wrap、按钮
// 注入 wrap（直接子节点，等价旧 chat-jump-bottom.js 结构）、幂等、无目标安全 return、
// sync 语义（距底 >160 show / ≤160 不含，rAF 节流）与点击平滑回底参数。
// jsdom 无 rAF：测试桩 requestAnimationFrame=setTimeout；滚动值用 defineProperty mock。

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./ChatJumpBottom.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function buildChat() {
	document.body.innerHTML = `<div class="panel panel-chat"><div id="chat-messages"><p>消息</p></div></div>`;
}

function flushFrames(ms = 30) {
	return act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

beforeEach(() => {
	document.body.innerHTML = "";
	// jsdom（vitest 默认非 pretendToBeVisual）无 rAF：等价浏览器节拍的最小桩
	globalThis.requestAnimationFrame = (cb) =>
		setTimeout(() => cb(Date.now()), 0);
	return () => {
		delete globalThis.requestAnimationFrame;
	};
});

describe("ChatJumpBottom（自挂载，React 渲染按钮）", () => {
	it("T16a mount：包 wrap、按钮为 wrap 直接子节点、title/aria-label/svg、幂等", () => {
		buildChat();
		act(() => {
			mount();
		});
		const msgs = document.getElementById("chat-messages");
		const wrap = document.querySelector(".chat-scroll-wrap");
		expect(wrap).not.toBeNull();
		expect(msgs.parentElement).toBe(wrap);
		expect(wrap.parentElement.className).toBe("panel panel-chat");
		const btn = wrap.querySelector(".chat-jump-bottom");
		expect(btn).not.toBeNull();
		expect(btn.parentElement).toBe(wrap);
		expect(btn.getAttribute("type")).toBe("button");
		expect(btn.title).toBe("直达底部");
		expect(btn.getAttribute("aria-label")).toBe("直达底部");
		expect(btn.querySelector("svg")).not.toBeNull();
		mount();
		expect(document.querySelectorAll(".chat-scroll-wrap").length).toBe(1);
		expect(document.querySelectorAll(".chat-jump-bottom").length).toBe(1);
		expect(document.getElementById("chat-messages").parentElement).toBe(wrap);
	});

	it("T16b 无 #chat-messages 时安全 return（无任何痕迹）", () => {
		document.body.innerHTML = "<div>空页</div>";
		expect(() => act(() => mount())).not.toThrow();
		expect(document.querySelector(".chat-scroll-wrap")).toBeNull();
	});

	it("T17 sync 语义：距底 >160 → show；≤160 → 不含；点击 → scrollTo({top, behavior:'smooth'})", async () => {
		buildChat();
		act(() => {
			mount();
		});
		const msgs = document.getElementById("chat-messages");
		const btn = document.querySelector(".chat-jump-bottom");
		const define = (prop, value) =>
			Object.defineProperty(msgs, prop, { value, configurable: true });
		// 初始 sync：jsdom 默认全 0 → 距底 0 ≤160 → 不含 show
		await flushFrames();
		expect(btn.classList.contains("show")).toBe(false);
		// 距底 800 > 160
		define("scrollHeight", 1000);
		define("clientHeight", 200);
		define("scrollTop", 0);
		await flushFrames();
		msgs.dispatchEvent(new Event("scroll"));
		await flushFrames();
		expect(btn.classList.contains("show")).toBe(true);
		// 距底 -50 ≤ 160
		define("scrollTop", 850);
		msgs.dispatchEvent(new Event("scroll"));
		await flushFrames();
		expect(btn.classList.contains("show")).toBe(false);
		// 点击平滑回底
		const scrollTo = vi.fn();
		msgs.scrollTo = scrollTo;
		await act(async () => {
			btn.click();
		});
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
	});
});
