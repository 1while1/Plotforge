// @vitest-environment jsdom
// S3-1 红测（Plan §4 T10~T12）：StateBookPanel——挂 #state-book-mount，等价旧
// book-state.js（loadState/bindStateEvents）语义：GET /api/books/:id/state 填 3 个
// 受控 textarea + 时间戳（「更新于」+ updated_at.slice(5,16) 逐字口径）、保存 PUT 全三
// kind → toast「状态簿已保存」→ 重拉、失败 toast e.message、elId 连字符契约。
// mock window.App（api/state.currentBook），零网络零 LLM。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import StateBookPanel from "./StateBookPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let apiCalls = [];
let apiImpl = null;

function mountPanel(loadSignal = 1) {
	const host = document.getElementById("state-book-mount");
	act(() => {
		createRoot(host).render(<StateBookPanel loadSignal={loadSignal} />);
	});
	// 等挂载 effect 内的 GET 与后续 setState 落定
	return act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	document.body.innerHTML = `<div id="state-book-mount"></div><div id="toast" class="toast hidden"></div>`;
	apiCalls = [];
	apiImpl = null;
	window.App = {
		state: { currentBook: { id: 7 } },
		api: (method, path, body) => {
			apiCalls.push({ method, path, body });
			if (apiImpl) return apiImpl(method, path, body);
			return Promise.resolve({ states: {} });
		},
	};
});

// P6-2 转写（Plan §2.5-D1 单例注入缝）：生产面已改 `getApp()` 直取模块单例——
// 本注入仅把 window.App 桩交给单例（各用例桩体/断言语义零改动）。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("StateBookPanel（book-state 迁移）", () => {
	it("T10 挂载拉取：GET /api/books/7/state → 3 textarea 受控值/时间戳逐字（slice(5,16) 口径）", async () => {
		apiImpl = () =>
			Promise.resolve({
				states: {
					characters: {
						content: "人物状态A",
						updated_at: "2026-08-12T20:02:33",
					},
					foreshadowing: { content: "伏笔B", updated_at: null },
					book_summary: { content: "摘要C", updated_at: "2025-01-03T08:05:00" },
				},
			});
		await mountPanel();
		expect(apiCalls[0]).toEqual({
			method: "GET",
			path: "/api/books/7/state",
			body: undefined,
		});
		expect(document.getElementById("state-characters").value).toBe("人物状态A");
		expect(document.getElementById("state-foreshadowing").value).toBe("伏笔B");
		expect(document.getElementById("state-book-summary").value).toBe("摘要C");
		expect(document.getElementById("state-characters-time").textContent).toBe(
			"更新于 08-12T20:02",
		);
		expect(
			document.getElementById("state-foreshadowing-time").textContent,
		).toBe("");
		expect(document.getElementById("state-book-summary-time").textContent).toBe(
			"更新于 01-03T08:05",
		);
	});

	it("T11 保存：编辑后点 btn-save-state → PUT 全三键、toast「状态簿已保存」、PUT 后再次 GET（重拉）", async () => {
		apiImpl = (_method, _path) => {
			if (_method === "GET") {
				return Promise.resolve({
					states: {
						characters: {
							content: "旧人物",
							updated_at: "2026-08-12T20:02:33",
						},
						foreshadowing: { content: "旧伏笔", updated_at: null },
						book_summary: { content: "旧摘要", updated_at: null },
					},
				});
			}
			return Promise.resolve({ states: {} });
		};
		await mountPanel();
		const ta = document.getElementById("state-characters");
		const setValue = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		).set;
		await act(async () => {
			setValue.call(ta, "新人物状态");
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			document.getElementById("btn-save-state").click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		const put = apiCalls.find((c) => c.method === "PUT");
		expect(put).toBeDefined();
		expect(put.path).toBe("/api/books/7/state");
		expect(Object.keys(put.body).sort()).toEqual([
			"book_summary",
			"characters",
			"foreshadowing",
		]);
		expect(put.body.characters).toBe("新人物状态");
		expect(put.body.foreshadowing).toBe("旧伏笔");
		expect(put.body.book_summary).toBe("旧摘要");
		expect(document.getElementById("toast").textContent).toBe("状态簿已保存");
		expect(apiCalls.filter((c) => c.method === "GET").length).toBe(2);
	});

	it("T12 失败：api reject → toast e.message；elId 契约：三 id 连字符且 -time 元素在场", async () => {
		apiImpl = () => Promise.reject(new Error("网络中断"));
		await mountPanel();
		expect(document.getElementById("toast").textContent).toBe("网络中断");
		for (const id of [
			"state-characters",
			"state-foreshadowing",
			"state-book-summary",
		]) {
			expect(document.getElementById(id)).not.toBeNull();
			expect(document.getElementById(`${id}-time`)).not.toBeNull();
		}
		// 连字符契约：不存在下划线 id 形态
		expect(document.getElementById("state_book_summary")).toBeNull();
	});
});
