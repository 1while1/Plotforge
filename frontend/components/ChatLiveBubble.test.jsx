// @vitest-environment jsdom
// S5-6 红测（Plan §4 T2，T2-1~T2-8）：实时气泡 frontend/components/ChatLiveBubble.jsx。
// 语义唯一事实源＝public/legacy/book-chat.js（零 diff 保留）：骨架 DOM 逐字 :1149-1154、
// 来源标签 :1155-1156（＝makeSourceTag :855-862）、phase 自走秒表与断连自清 :1169-1186、
// 增量按时间合并＋insertAdjacentText 追加＋滚动 200ms 节流 :1188-1216（2026-09-14 二轮诊断
// 「卡死真因」修复，性能契约＝行为契约）、思考块去 hidden :1328-1331、工具块/确认卡插在
// .msg-bubble 之前 :1338-1347、收尾 flush 与读回 :1207-1212／:1386。
// harness＝jsdom（首行声明）＋React 19 act＋createRoot＋裸 DOM 断言
// （frontend/components/CharacterWorkbenchPanel.test.jsx:1-19 同款）；零新增依赖。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ChatLiveBubble,
	FLUSH_INTERVAL_MS,
	SCROLL_THROTTLE_MS,
} from "./ChatLiveBubble.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let apiRef;

function mount(props) {
	apiRef = { current: null };
	root = createRoot(host);
	act(() => {
		root.render(<ChatLiveBubble apiRef={apiRef} {...(props || {})} />);
	});
	return apiRef.current;
}

function remount(props) {
	act(() => {
		root.unmount();
	});
	host.innerHTML = "";
	return mount(props);
}

function bubble() {
	return host.querySelector(".msg-bubble");
}

function live() {
	return host.querySelector(".msg.assistant");
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("T2 ChatLiveBubble（legacy :1148-1254 逐条保真）", () => {
	it("T2-1 骨架逐字与来源标签（:1149-1156）", () => {
		mount({ source: "writing" });
		expect(live()).not.toBeNull();
		expect(live().classList.contains("msg")).toBe(true);
		expect(live().classList.contains("assistant")).toBe(true);
		const role = live().querySelector(".msg-role");
		expect(role.firstChild.textContent).toBe("写作助手");
		expect(role.textContent).toBe("写作助手写作台");
		const tag = role.querySelector(".msg-source");
		expect(tag).not.toBeNull();
		expect(tag.className).toBe("msg-source msg-source-writing");
		expect(tag.textContent).toBe("写作台");
		// <details class="msg-reasoning live-reasoning hidden" open><summary>思考过程</summary><div class="reasoning-body">
		const det = live().querySelector("details.msg-reasoning.live-reasoning");
		expect(det).not.toBeNull();
		expect(det.classList.contains("hidden")).toBe(true);
		expect(det.hasAttribute("open")).toBe(true);
		expect(det.querySelector("summary").textContent).toBe("思考过程");
		expect(det.querySelector(".reasoning-body")).not.toBeNull();
		// <div class="msg-phase hidden"></div>
		const phase = live().querySelector(".msg-phase");
		expect(phase).not.toBeNull();
		expect(phase.classList.contains("hidden")).toBe(true);
		expect(phase.textContent).toBe("");
		// <div class="msg-bubble"></div>
		expect(bubble()).not.toBeNull();
		expect(bubble().textContent).toBe("");
		// 无 source 的调用静默不标（:1155-1156）
		const h = remount({});
		expect(h).not.toBeNull();
		expect(live().querySelector(".msg-source")).toBeNull();
		expect(live().querySelector(".msg-role").textContent).toBe("写作助手");
	});

	it("T2-2 增量按 120ms 合并＋追加式落盘（节点身份不变）（:1198-1216）", () => {
		const h = mount({ source: "writing" });
		act(() => {
			h.pushDelta("a");
			h.pushDelta("b");
			h.pushDelta("c");
		});
		expect(bubble().textContent).toBe(""); // 窗口内不落盘
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(bubble().textContent).toBe("abc");
		const first = bubble().firstChild;
		expect(first.nodeType).toBe(3);
		// 跨窗口再追加：首个子节点身份不变（insertAdjacentText 追加，不整块重写）
		act(() => {
			h.pushDelta("d");
		});
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(bubble().firstChild).toBe(first);
		expect(bubble().childNodes.length).toBe(2);
		expect(bubble().textContent).toBe("abcd");
	});

	it("T2-3 显式 flush 与 getText/getReasoning 读回（:1207-1212 / :1386）", () => {
		const h = mount({ source: "writing" });
		act(() => {
			h.pushDelta("x");
			h.pushReasoning("r");
		});
		expect(h.getText()).toBe(""); // 未 flush 前读回为空（等价 legacy 未 flush 的 textContent）
		act(() => {
			h.flush();
		});
		expect(bubble().textContent).toBe("x");
		expect(h.getText()).toBe("x");
		expect(h.getReasoning()).toBe("r");
	});

	it("T2-4 思考块首帧去 hidden＋合并；空串不触发（:1328-1331）", () => {
		const h = mount({ source: "writing" });
		const det = () => live().querySelector("details.msg-reasoning");
		expect(det().classList.contains("hidden")).toBe(true);
		act(() => {
			h.pushReasoning("想");
			h.pushReasoning("一下");
		});
		expect(det().classList.contains("hidden")).toBe(false); // 首帧即去 hidden
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(live().querySelector(".reasoning-body").textContent).toBe("想一下");
		// 空串不触发（Plan §4 T2-4）：新实例上 pushReasoning('') 不解 hidden、不落盘
		const h2 = remount({ source: "writing" });
		act(() => {
			h2.pushReasoning("");
		});
		expect(det().classList.contains("hidden")).toBe(true);
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(live().querySelector(".reasoning-body").textContent).toBe("");
	});

	it("T2-5 phase 行『（已等待 N 秒）』自走＋setPhase('') 清定时器＋断连自清（:1169-1186）", () => {
		const h = mount({ source: "writing" });
		const phase = () => live().querySelector(".msg-phase");
		act(() => {
			h.setPhase("正在继续处理（第 2/3 轮）…");
		});
		expect(phase().classList.contains("hidden")).toBe(false);
		expect(phase().textContent).toBe(
			"正在继续处理（第 2/3 轮）…（已等待 0 秒）",
		);
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(phase().textContent).toBe(
			"正在继续处理（第 2/3 轮）…（已等待 3 秒）",
		);
		act(() => {
			h.setPhase("");
		});
		expect(phase().classList.contains("hidden")).toBe(true);
		expect(phase().textContent).toBe("");
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(phase().textContent).toBe(""); // 定时器已清
		// 断连自清：卸载后推进不抛错、apiRef 交还
		act(() => {
			h.setPhase("再等");
		});
		act(() => {
			root.unmount();
		});
		expect(apiRef.current).toBeNull();
		expect(() => {
			vi.advanceTimersByTime(3000);
		}).not.toThrow();
		expect(host.querySelector(".msg-phase")).toBeNull();
	});

	it("T2-6 工具块/确认卡/检索块插在 .msg-bubble 之前（:1338-1347 / :1333-1337）", () => {
		const h = mount({ source: "writing", cardProps: { bookId: 7 } });
		act(() => {
			h.addRetrieval([{ chapter: "第一章", score: 0.8, text: "旧文" }]);
			h.addTool({ name: "search_story", args: { q: "1" }, result: "ok" });
			h.addAction({
				id: 3,
				name: "append_chapter",
				args: {},
				status: "pending",
			});
		});
		const kids = Array.from(live().children);
		const bubbleIdx = kids.indexOf(bubble());
		expect(bubbleIdx).toBeGreaterThan(0);
		const tool = live().querySelector(".tool-call");
		const card = live().querySelector(".msg-action");
		const retrieval = live().querySelector(".msg-retrieval");
		expect(tool).not.toBeNull();
		expect(card).not.toBeNull();
		expect(retrieval).not.toBeNull();
		for (const n of [retrieval, tool, card]) {
			expect(kids.indexOf(n)).toBeLessThan(bubbleIdx); // 全部在正文气泡之前
		}
		// 保持出现顺序（检索 → 工具 → 卡）
		expect(kids.indexOf(retrieval)).toBeLessThan(kids.indexOf(tool));
		expect(kids.indexOf(tool)).toBeLessThan(kids.indexOf(card));
	});

	it("T2-7 滚动 200ms 节流（:1201-1206）", () => {
		const target = { scrollTop: 0, scrollHeight: 500 };
		const h = mount({ source: "writing", scrollTarget: target });
		act(() => {
			h.pushDelta("a");
		});
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(target.scrollTop).toBe(500); // 首次置底
		target.scrollHeight = 900;
		act(() => {
			h.pushDelta("b");
		});
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(target.scrollTop).toBe(500); // 200ms 窗口内不重复置底
		act(() => {
			vi.advanceTimersByTime(SCROLL_THROTTLE_MS);
			h.pushDelta("c");
		});
		act(() => {
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
		});
		expect(target.scrollTop).toBe(900); // 窗口外恰第二次
	});

	it("T2-8 零副作用：零 fetch、零 window 写入、零 localStorage（Plan §3 红线）", () => {
		const origFetch = globalThis.fetch;
		const fetchSpy = vi.fn(() => {
			throw new Error("组件内不得 fetch");
		});
		globalThis.fetch = fetchSpy;
		const keysBefore = Object.keys(window).length;
		window.localStorage.clear();
		try {
			const h = mount({
				source: "writing",
				scrollTarget: { scrollTop: 0, scrollHeight: 1 },
			});
			act(() => {
				h.pushDelta("x");
				h.pushReasoning("y");
				h.setPhase("p");
				h.addRetrieval([{ chapter: "c", score: 1, text: "t" }]);
				h.addTool({ name: "search_story", args: {}, result: "ok" });
				h.addAction({
					id: 1,
					name: "append_chapter",
					args: {},
					status: "pending",
				});
				h.flush();
			});
			act(() => {
				vi.advanceTimersByTime(2000);
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(Object.keys(window).length).toBe(keysBefore);
			expect(window.localStorage.length).toBe(0);
			expect(window.ChatEventHub).toBeUndefined();
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
