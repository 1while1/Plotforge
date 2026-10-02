// @vitest-environment jsdom
// S3-2 红测（Plan §4 T8~T12）：ChapterConflictDialog——消费 Modal 基础件（接管既有
// #modal-mask 五件套壳，children 进 #modal-body）+ showToast。文案/class/countChars/
// revText 与旧 chapter-conflict.js:16~72 逐字等价：两段 field-hint（'?' 分支与
// updated_at 分支、去空白字数）、三按钮（data-act/copy/diff/reload 文案与 class 逐字）、
// conflict-diff 容器初始隐藏、copy→clipboard 三分支 toast、diff→展开 DiffBody+按钮
// disabled、reload→onReload(server) 且关闭、ok/cancel/mask 关闭不触发 onReload、
// #modal-body 契约坑（portal 目标、#card-editor 不受影响）。
// 弹窗壳桩同 Modal.test.jsx（含第二个 .modal-mask#card-editor 钉契约坑）。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showConflictDialog } from "./ChapterConflictDialog.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const $ = (id) => document.getElementById(id);

function buildShell() {
	document.body.innerHTML = `<div id="modal-mask" class="modal-mask hidden"><div class="modal"><h3 id="modal-title"></h3><div id="modal-body"></div><div class="modal-actions"><button id="modal-cancel" class="btn btn-ghost">取消</button><button id="modal-ok" class="btn btn-primary">确定</button></div></div></div><div id="card-editor" class="modal-mask hidden"><div class="modal"><div class="modal-body card-editor-body"></div></div></div><div id="toast" class="toast hidden"></div>`;
}

// 与 D7 冒烟脚本同源 fixture（含换行，验 countChars 去空白口径）
const SERVER_FIX = {
	revision: 4,
	updated_at: "2026-09-26 10:00:00",
	content: "服务端第一段：战局已定。\n服务端第二段：残部北渡。",
};
const LOCAL_FIX = { content: "本地第一段：战局未明。\n本地第二段：残部北渡。" };

function showOpts(server = SERVER_FIX, local = LOCAL_FIX, onReload = () => {}) {
	act(() => {
		showConflictDialog({ server, local, onReload });
	});
	// 等 React 渲染落定（弹窗壳填充由 Modal effect 完成）
	return act(async () => {
		await Promise.resolve();
	});
}

let savedClipboard = null;
beforeEach(() => {
	buildShell();
	savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	if (savedClipboard) delete navigator.clipboard;
});

afterEach(() => {
	delete navigator.clipboard;
	if (savedClipboard) {
		Object.defineProperty(navigator, "clipboard", savedClipboard);
		savedClipboard = null;
	}
});

describe("ChapterConflictDialog（chapter-conflict 迁移：旧名桥判定 C）", () => {
	it("T8 show：壳去 hidden；title/okText 逐字；两段 field-hint 逐字（'?' 分支+updated_at 分支+去空白字数）；三按钮逐字；conflict-diff 初始隐藏", async () => {
		await showOpts();
		expect($("modal-mask").classList.contains("hidden")).toBe(false);
		expect($("modal-title").textContent).toBe("章节已在别处被修改");
		expect($("modal-ok").textContent).toBe("继续编辑本地稿");
		const hints = [...$("modal-body").querySelectorAll(".field-hint")].map(
			(n) => n.textContent,
		);
		expect(hints.length).toBe(2);
		expect(hints[0]).toBe(
			"服务端已是第 4 版（2026-09-26 10:00:00 保存），与编辑器里的本地稿不一致。本地稿已原样保留，两边内容都不会被自动覆盖或重发。",
		);
		expect(hints[1]).toBe(
			"本地稿约 22 字 · 服务端约 24 字。可先复制本地稿留底，再对照差异决定去留。",
		);
		const buttons = [...$("modal-body").querySelectorAll("[data-act]")].map(
			(b) => ({
				act: b.dataset.act,
				text: b.textContent,
				cls: b.className,
				type: b.getAttribute("type"),
			}),
		);
		expect(buttons).toEqual([
			{
				act: "copy",
				text: "复制本地稿",
				cls: "btn btn-outline btn-small",
				type: "button",
			},
			{
				act: "diff",
				text: "查看差异（本地 vs 服务端）",
				cls: "btn btn-outline btn-small",
				type: "button",
			},
			{
				act: "reload",
				text: "放弃本地稿，重载服务端版本",
				cls: "btn btn-outline btn-small",
				type: "button",
			},
		]);
		const pane = $("conflict-diff");
		expect(pane).not.toBeNull();
		expect(pane.className).toBe("diff-body conflict-diff");
		expect(pane.style.display).toBe("none");
	});

	it("T8b 缺 revision/updated_at：revText 走『?』分支；countChars 对空串/空白全剔除", async () => {
		await showOpts({ content: "  \n字两枚 " }, { content: null }, () => {});
		const hints = [...$("modal-body").querySelectorAll(".field-hint")].map(
			(n) => n.textContent,
		);
		expect(hints[0]).toBe(
			"服务端已是第 ? 版，与编辑器里的本地稿不一致。本地稿已原样保留，两边内容都不会被自动覆盖或重发。",
		);
		// '  \n字两枚 ' 去空白后 3 字；null → 0 字
		expect(hints[1]).toBe(
			"本地稿约 0 字 · 服务端约 3 字。可先复制本地稿留底，再对照差异决定去留。",
		);
	});

	it("T9 copy：clipboard 成功/失败/缺失三分支 toast 逐字", async () => {
		const writes = [];
		let rejectIt = false;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (text) => {
					writes.push(text);
					return rejectIt
						? Promise.reject(new Error("denied"))
						: Promise.resolve();
				},
			},
		});
		await showOpts();
		const copyBtn = $("modal-body").querySelector('[data-act="copy"]');
		await act(async () => {
			copyBtn.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(writes).toEqual([LOCAL_FIX.content]);
		expect($("toast").textContent).toBe("本地稿已复制到剪贴板");
		// 失败分支
		rejectIt = true;
		await act(async () => {
			copyBtn.click();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect($("toast").textContent).toBe("复制失败，请在编辑器中手动全选复制");
		// 无 clipboard API 分支
		delete navigator.clipboard;
		await act(async () => {
			copyBtn.click();
			await Promise.resolve();
		});
		expect($("toast").textContent).toBe(
			"浏览器不支持剪贴板，请在编辑器中手动全选复制",
		);
	});

	it("T10 diff：点击后 conflict-diff 展开且含 d-old/d-new 内容（本地=删除视角/服务端=高亮视角）；diff 按钮 disabled", async () => {
		await showOpts();
		const diffBtn = $("modal-body").querySelector('[data-act="diff"]');
		await act(async () => {
			diffBtn.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		const pane = $("conflict-diff");
		expect(pane.style.display).toBe("");
		expect(pane.querySelectorAll(".d-old").length).toBeGreaterThan(0);
		expect(pane.querySelectorAll(".d-new").length).toBeGreaterThan(0);
		expect(pane.querySelector(".d-del")).not.toBeNull();
		expect(pane.querySelector(".d-ins")).not.toBeNull();
		expect(pane.textContent).toContain("战局未明");
		expect(pane.textContent).toContain("战局已定");
		expect(diffBtn.disabled).toBe(true);
	});

	it("T11 reload：onReload(server) 恰 1 次且弹窗关闭；ok/cancel/mask 点击关闭且不触发 onReload", async () => {
		const reloads = [];
		await showOpts(SERVER_FIX, LOCAL_FIX, (srv) => reloads.push(srv));
		await act(async () => {
			$("modal-body").querySelector('[data-act="reload"]').click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(reloads.length).toBe(1);
		expect(reloads[0]).toBe(SERVER_FIX);
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		// ok（继续编辑本地稿）/cancel/mask：仅关闭
		await showOpts(SERVER_FIX, LOCAL_FIX, (srv) => reloads.push(srv));
		await act(async () => {
			$("modal-ok").click();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		await showOpts(SERVER_FIX, LOCAL_FIX, (srv) => reloads.push(srv));
		await act(async () => {
			$("modal-cancel").click();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		await showOpts(SERVER_FIX, LOCAL_FIX, (srv) => reloads.push(srv));
		await act(async () => {
			$("modal-mask").click();
			await Promise.resolve();
		});
		expect($("modal-mask").classList.contains("hidden")).toBe(true);
		expect(reloads.length).toBe(1);
	});

	it("T12 渲染进既有 #modal-body（portal 目标断言）、#card-editor 不受影响、无第二个 id=modal-body", async () => {
		await showOpts();
		const body = $("modal-body");
		const probe = body.querySelector(".conflict-actions");
		expect(probe).not.toBeNull();
		expect(probe.parentNode).toBe(body);
		expect(document.querySelectorAll("[id=modal-body]").length).toBe(1);
		expect($("card-editor").classList.contains("hidden")).toBe(true);
		expect(document.querySelector(".modal-body")).not.toBeNull();
	});
});
