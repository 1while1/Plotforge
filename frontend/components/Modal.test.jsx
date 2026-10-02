// @vitest-environment jsdom
// S3-1 红测（Plan §4 T1~T5）：Modal 受控接管既有 #modal-mask 五件套壳。
// 断言语义：打开填壳（title/okText/children）、onOk thenable 契约（同 app.js:94~109：
// 同步 false 不关、非 false 关、thenable resolve(false) 不关/真值关/reject 忽略、
// 无 onOk 直接关）、cancel/mask 关闭（mask 仅 e.target===mask）、danger 打开重置、
// onclick 赋值防叠加、#modal-body 契约坑专项（portal 目标===既有 id 节点、class 无
// modal-body、全文档 id 唯一、#card-editor 不受影响、关闭后 body 清空）。
// D5：jsdom + React 19 内建 act + 裸 DOM 断言（不装 @testing-library/*）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import Modal from "./Modal.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 模拟 index.html:818~829 通用弹窗壳 + index.html:546/#card-editor（页面上第二个
// .modal-mask，内含 .modal-body **class** 节点——按 class 找会绑错弹窗的契约坑源头）。
function buildShell() {
	document.body.innerHTML = `<div id="modal-mask" class="modal-mask hidden"><div class="modal"><h3 id="modal-title"></h3><div id="modal-body"></div><div class="modal-actions"><button id="modal-cancel" class="btn btn-ghost">取消</button><button id="modal-ok" class="btn btn-primary">确定</button></div></div></div><div id="card-editor" class="modal-mask hidden"><div class="modal"><div class="modal-body card-editor-body"></div></div></div><div id="toast" class="toast hidden"></div>`;
}
const $ = (id) => document.getElementById(id);

function mountModal(initial) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let props = initial;
	const render = () =>
		act(() => {
			root.render(<Modal {...props} />);
		});
	render();
	return {
		rerender(next) {
			props = { ...props, ...next };
			render();
		},
		unmount() {
			act(() => {
				root.unmount();
			});
		},
	};
}

beforeEach(() => {
	buildShell();
});

describe("Modal 基础件（受控接管既有壳）", () => {
	it("T1 打开：mask 去 hidden、title 填充、okText 默认「确定」、children 渲染进 #modal-body", () => {
		mountModal({
			open: true,
			title: "测试弹窗",
			children: <p id="probe">内容</p>,
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		expect($("modal-title").textContent).toBe("测试弹窗");
		expect($("modal-ok").textContent).toBe("确定");
		expect($("modal-body").querySelector("#probe")).not.toBeNull();
	});

	it("T1b okText 自定义透传", () => {
		mountModal({ open: true, title: "t", okText: "保存布局", children: null });
		expect($("modal-ok").textContent).toBe("保存布局");
	});

	it("T2a onOk 同步返回 false 不关；返回非 false 关", () => {
		const keep = mountModal({
			open: true,
			title: "t",
			onOk: () => false,
			children: null,
		});
		act(() => {
			$("modal-ok").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		keep.rerender({ onOk: () => true });
		act(() => {
			$("modal-ok").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("T2b onOk thenable：resolve(false) 不关、resolve(真值) 关", async () => {
		const keep = mountModal({
			open: true,
			title: "t",
			onOk: () => Promise.resolve(false),
			children: null,
		});
		await act(async () => {
			$("modal-ok").click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		keep.rerender({ onOk: () => Promise.resolve("done") });
		await act(async () => {
			$("modal-ok").click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("T2c onOk thenable：reject 被忽略且不关（无未捕获异常）", async () => {
		mountModal({
			open: true,
			title: "t",
			onOk: () => Promise.reject(new Error("保存失败")),
			children: null,
		});
		await act(async () => {
			$("modal-ok").click();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
	});

	it("T2d 无 onOk：点击 ok 直接关（纯展示弹窗）", () => {
		mountModal({ open: true, title: "t", children: null });
		act(() => {
			$("modal-ok").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("T3a cancel 点击关；mask 点击仅 e.target===mask 时关（点 body 内不关）", () => {
		const h = mountModal({
			open: true,
			title: "t",
			onCancel: undefined,
			children: <p>x</p>,
		});
		act(() => {
			$("modal-body").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		act(() => {
			$("modal-mask").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		h.rerender({ open: true });
		act(() => {
			$("modal-cancel").click();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("T3b danger→okBtn 含 btn-danger；非 danger 打开时重置移除", () => {
		const h = mountModal({
			open: true,
			title: "t",
			danger: true,
			children: null,
		});
		expect($("modal-ok").classList.contains("btn-danger")).toBe(true);
		h.rerender({ open: false });
		h.rerender({ open: true, danger: undefined, children: null });
		expect($("modal-ok").classList.contains("btn-danger")).toBe(false);
	});

	it("T4 #modal-body 契约坑专项：portal 目标===既有 id 节点、class 无 modal-body、全文档 id 唯一、#card-editor 不受影响、关闭后 body 清空", () => {
		const h = mountModal({
			open: true,
			title: "契约坑",
			children: <p id="probe">p</p>,
		});
		const body = $("modal-body");
		expect(body.querySelector("#probe").parentNode).toBe(body);
		expect(body.className).not.toContain("modal-body");
		expect(document.querySelectorAll("[id=modal-body]").length).toBe(1);
		// 壳中 #card-editor 内确有 .modal-body class 节点（陷阱真实存在），且 #card-editor 保持 hidden
		expect(document.querySelector(".modal-body")).not.toBeNull();
		expect($("card-editor").classList.contains("hidden")).toBe(true);
		h.rerender({ open: false });
		expect($("modal-body").childElementCount).toBe(0);
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("T5 连开两次：ok 点击仅触发一次 onOk（onclick 赋值防叠加）；重开后 danger/okText 不残留", () => {
		let calls = 0;
		const h = mountModal({
			open: true,
			title: "a",
			onOk: () => {
				calls += 1;
			},
			children: null,
		});
		act(() => {
			$("modal-ok").click();
		});
		expect(calls).toBe(1);
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		h.rerender({
			open: true,
			title: "b",
			onOk: () => {
				calls += 1;
			},
			children: null,
		});
		act(() => {
			$("modal-ok").click();
		});
		expect(calls).toBe(2);
		// danger/okText 重置：先 danger+自定义 okText，重开不带 → 默认「确定」无 btn-danger
		const h2 = mountModal({
			open: true,
			title: "x",
			okText: "删除",
			danger: true,
			children: null,
		});
		expect($("modal-ok").textContent).toBe("删除");
		h2.rerender({ open: false });
		h2.rerender({
			open: true,
			okText: undefined,
			danger: undefined,
			children: null,
		});
		expect($("modal-ok").textContent).toBe("确定");
		expect($("modal-ok").classList.contains("btn-danger")).toBe(false);
	});
});
