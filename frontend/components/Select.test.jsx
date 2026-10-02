// @vitest-environment jsdom
// S3-1 红测（Plan §4 T9）：Select 纸墨风下拉雏形（不接线）——受控原生 <select>，
// options 逐项渲染、value 回显、change 以选中 value 调 onChange 恰 1 次、
// title/ariaLabel/disabled/className 透传、零新样式（复用全局 select 元素样式）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Select from "./Select.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
	{ value: "a", label: "甲" },
	{ value: "b", label: "乙" },
	{ value: "c", label: "丙" },
];

function mountSelect(props = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	act(() => {
		createRoot(container).render(<Select {...props} />);
	});
	return container;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("Select 雏形（受控原生下拉，不接线）", () => {
	it("T9a 渲染原生 select；options 逐项 value/label；受控 value 回显", () => {
		const c = mountSelect({ value: "b", options: OPTIONS, onChange: () => {} });
		const sel = c.querySelector("select");
		expect(sel.tagName).toBe("SELECT");
		const opts = Array.from(sel.querySelectorAll("option"));
		expect(opts.map((o) => o.value)).toEqual(["a", "b", "c"]);
		expect(opts.map((o) => o.textContent)).toEqual(["甲", "乙", "丙"]);
		expect(sel.value).toBe("b");
	});

	it("T9b change 事件以选中 value 调 onChange 恰 1 次", () => {
		const onChange = vi.fn();
		const c = mountSelect({ value: "a", options: OPTIONS, onChange });
		const sel = c.querySelector("select");
		act(() => {
			sel.value = "c";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("c");
	});

	it("T9c title/ariaLabel/disabled/className 透传", () => {
		const c = mountSelect({
			value: "a",
			options: OPTIONS,
			onChange: () => {},
			title: "挑选",
			ariaLabel: "写作会话",
			disabled: true,
			className: "extra-class",
		});
		const sel = c.querySelector("select");
		expect(sel.getAttribute("title")).toBe("挑选");
		expect(sel.getAttribute("aria-label")).toBe("写作会话");
		expect(sel.disabled).toBe(true);
		expect(sel.className).toBe("extra-class");
	});
});
