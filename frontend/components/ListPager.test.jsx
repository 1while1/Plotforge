// @vitest-environment jsdom
// S2-2 红测（Plan §4 T1~T6）：ListPager 纯受控组件（P6-2 ⑨：window.MozhenPager 桥退役）。
// 断言语义：空态 null 渲染、meta 串逐字等值、disabled 边界、点击改 st.page 后 onChange、
// pageCount/slice 纯函数（原地写 total 与越界收拢）、挂载方自持 root 复用。
// D5：jsdom + React 19 内建 act + 裸 DOM 断言（不装 @testing-library/*）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import ListPager, { pageCount, slice } from "./ListPager.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mountPager(st, { onChange = () => {}, unit } = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	act(() => {
		const root = createRoot(container);
		root.render(<ListPager st={st} onChange={onChange} unit={unit} />);
	});
	return container;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("ListPager 组件（widget 范式）", () => {
	it("T1 空态：total<=pageSize 渲染 null（容器无 .list-pager）", () => {
		const container = mountPager({ page: 1, pageSize: 10, total: 8 });
		expect(container.querySelector(".list-pager")).toBeNull();
		expect(container.childElementCount).toBe(0);
	});

	it("T2 逐字渲染：meta 串、unit、按钮文本与结构 class", () => {
		const container = mountPager({ page: 2, pageSize: 10, total: 25 });
		const pager = container.querySelector("div.list-pager");
		expect(pager).not.toBeNull();
		const meta = pager.querySelector("span.list-pager-meta");
		expect(meta.textContent).toBe("第 2 / 3 页 · 共 25 条");
		const buttons = pager.querySelectorAll("button");
		expect(buttons.length).toBe(2);
		for (const btn of buttons) {
			expect(btn.className).toBe("btn btn-ghost btn-small");
			expect(btn.getAttribute("type")).toBe("button");
		}
		expect(buttons[0].getAttribute("data-page-prev")).not.toBeNull();
		expect(buttons[1].getAttribute("data-page-next")).not.toBeNull();
		expect(buttons[0].textContent).toBe("‹ 上一页");
		expect(buttons[1].textContent).toBe("下一页 ›");

		const withUnit = mountPager(
			{ page: 2, pageSize: 10, total: 25 },
			{ unit: "人" },
		);
		expect(withUnit.querySelector(".list-pager-meta").textContent).toBe(
			"第 2 / 3 页 · 共 25 人",
		);
	});

	it("T3 disabled 语义：首页 prev disabled/next 可点；末页反之", () => {
		const first = mountPager({ page: 1, pageSize: 10, total: 25 });
		expect(
			first.querySelector("[data-page-prev]").hasAttribute("disabled"),
		).toBe(true);
		expect(
			first.querySelector("[data-page-next]").hasAttribute("disabled"),
		).toBe(false);

		const last = mountPager({ page: 3, pageSize: 10, total: 25 });
		expect(
			last.querySelector("[data-page-prev]").hasAttribute("disabled"),
		).toBe(false);
		expect(
			last.querySelector("[data-page-next]").hasAttribute("disabled"),
		).toBe(true);
	});

	it("T4 点击回调：改 st.page 后 onChange 恰一次；边界 0 次", async () => {
		let calls = 0;
		const onChange = () => {
			calls += 1;
		};
		const st = { page: 2, pageSize: 10, total: 25 };
		const container = mountPager(st, { onChange });
		await act(async () => {
			container.querySelector("[data-page-next]").click();
		});
		expect(st.page).toBe(3);
		expect(calls).toBe(1);

		const firstSt = { page: 1, pageSize: 10, total: 25 };
		const firstPage = mountPager(firstSt, { onChange });
		await act(async () => {
			firstPage.querySelector("[data-page-prev]").click();
		});
		expect(firstSt.page).toBe(1);
		expect(calls).toBe(1);

		const lastSt = { page: 3, pageSize: 10, total: 25 };
		const lastPage = mountPager(lastSt, { onChange });
		await act(async () => {
			lastPage.querySelector("[data-page-next]").click();
		});
		expect(lastSt.page).toBe(3);
		expect(calls).toBe(1);
	});

	it("T5 纯函数：pageCount 边界与 slice 原地写 total、越界收拢、窗口正确", () => {
		expect(pageCount({ total: 0, pageSize: 10 })).toBe(1);
		expect(pageCount({ total: 23, pageSize: 10 })).toBe(3);
		expect(pageCount({ total: 20, pageSize: 10 })).toBe(2);

		const items = Array.from({ length: 25 }, (_, i) => i + 1);
		const mid = { page: 2, pageSize: 10, total: 999 };
		expect(slice(items, mid)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
		expect(mid.total).toBe(25);

		const overflow = { page: 5, pageSize: 10, total: 999 };
		expect(slice(items, overflow)).toEqual([21, 22, 23, 24, 25]);
		expect(overflow.page).toBe(3);
		expect(overflow.total).toBe(25);
	});
});

describe("ListPager 模块面（P6-2 ⑨ 转写：widget 旧名桥退役）", () => {
	it("T6 模块导出同源（pageCount/slice）＋挂载方自持 root 重渲；window.MozhenPager 零命中（反向见证）", () => {
		// ① 模块导出即旧桥体同一实现（旧断言 `window.MozhenPager.pageCount === pageCount` 的等价物）
		expect(typeof pageCount).toBe("function");
		expect(typeof slice).toBe("function");
		// ② 反向见证：旧名桥退役后零命中（对象消失 → 语义并入 T1 零残留见证）
		expect(window.MozhenPager).toBeUndefined();

		// ③ render 语义（等值旧桥体）：调用方建 root 一次、对同一元素重渲最新 st
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		act(() => {
			root.render(
				<ListPager
					st={{ page: 2, pageSize: 10, total: 25 }}
					onChange={() => {}}
				/>,
			);
		});
		expect(el.querySelector(".list-pager")).not.toBeNull();
		expect(el.querySelector(".list-pager-meta").textContent).toBe(
			"第 2 / 3 页 · 共 25 条",
		);
		act(() => {
			root.render(
				<ListPager
					st={{ page: 3, pageSize: 10, total: 25 }}
					onChange={() => {}}
				/>,
			);
		});
		expect(el.querySelector(".list-pager-meta").textContent).toBe(
			"第 3 / 3 页 · 共 25 条",
		);
	});
});
