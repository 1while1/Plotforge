// @vitest-environment jsdom
// S3-1 红测（Plan §4 T8）：StatusBar 雏形（不接线）——四 chip 渲染 props 文本、
// .ws-label 固定文案、容器 class/role、props 缺省时逐字渲染 index.html:74~78 缺省值。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import StatusBar from "./StatusBar.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mountStatus(props = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	act(() => {
		createRoot(container).render(<StatusBar {...props} />);
	});
	return container;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("StatusBar 雏形（镜像 index.html:73~79，不接线）", () => {
	it("T8a 四 chip 渲染 props 文本；ws-label 固定文案；容器 class/role", () => {
		const c = mountStatus({
			book: "安阳师范",
			chapter: "第 3 章",
			conversation: "会话甲",
			save: "未保存",
		});
		const bar = c.querySelector(".writing-status-bar");
		expect(bar).not.toBeNull();
		expect(bar.getAttribute("role")).toBe("status");
		const chips = Array.from(bar.querySelectorAll(".ws-chip"));
		expect(chips.length).toBe(4);
		expect(
			chips.map((chip) => chip.querySelector(".ws-label").textContent),
		).toEqual(["书", "当前章", "写作会话", "保存状态"]);
		expect(chips.map((chip) => chip.lastElementChild.textContent)).toEqual([
			"安阳师范",
			"第 3 章",
			"会话甲",
			"未保存",
		]);
	});

	it("T8b props 缺省时逐字渲染「—/未选择章节/（默认：历史对话）/已保存」", () => {
		const c = mountStatus();
		const values = Array.from(c.querySelectorAll(".ws-chip")).map(
			(chip) => chip.lastElementChild.textContent,
		);
		expect(values).toEqual(["—", "未选择章节", "（默认：历史对话）", "已保存"]);
	});
});
