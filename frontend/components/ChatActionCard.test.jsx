// @vitest-environment jsdom
// S5-5 红测（Plan §4 T2＋T3 并入）：ChatActionCard（确认卡两段式确认）／ChatActionLogRow（留痕行）／
// ChatToolEventBlock（只读工具块）。语义锚点＝public/legacy/book-chat.js 行号（逐例头注）。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-17 同款）；
// window.App 为 legacy 运行时契约桩（api/openModal/toast/escapeHtml/state），escapeHtml 用真转义
// （WorkbenchPage.test.jsx:210-222 口径）——否则 T2-4 的 bodyHTML 断言会假绿。
// 说明（S5-5 事实勘误，见台账 §S5-5）：legacy :619-641 的 onOk 路径**不**把卡换成留痕行
// （replaceWith 只出现在 settle() :566/:571），故 T2-5 断言「卡留位、切只读 approved」而非「卡消失」。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { ChatActionCard } from "./ChatActionCard.jsx";
import { ChatActionLogRow } from "./ChatActionLogRow.jsx";
import { ChatToolEventBlock } from "./ChatToolEventBlock.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function realEscapeHtml(s) {
	if (s == null) return "";
	return String(s).replace(/[&<>"']/g, (c) => {
		return {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}[c];
	});
}

let host;
let root;
let appMock;
let lastModal;

// key＝action.id：同一 root 内换 fixture 即整块重挂（等价 legacy 每次 createElement 建新卡，
// 避免 React 状态被上一例残留——卡身份天然由动作 id 决定）。
function mountCard(props) {
	act(() => {
		root.render(
			<ChatActionCard key={props.key ?? props.action?.id} {...props} />,
		);
	});
}

function cardEl() {
	return host.querySelector(".msg-action");
}

function opsButtons() {
	return [...host.querySelectorAll(".action-ops button")];
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
	lastModal = null;
	appMock = {
		state: { currentBook: { id: "B1" } },
		api: vi.fn(async () => ({ relocked: false })),
		toast: vi.fn(),
		escapeHtml: realEscapeHtml,
		openModal: vi.fn((opts) => {
			lastModal = opts;
		}),
	};
	window.App = appMock;
	// P6-2 转写（Plan §2.4 T-F）：组件 App 取用已改 `lib/app-runtime.js` 单例直取（§2.5-D1），
	// harness 经注入缝装同一桩；window.App 保留供「零全局注册」断言的排除面口径不变
	setAppForTests(appMock);
	globalThis.fetch = vi.fn(() => {
		throw new Error("组件内不得 fetch");
	});
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	setAppForTests(null);
	delete window.App;
	delete globalThis.fetch;
});

describe("T2 ChatActionCard / ChatActionLogRow（legacy 行号锚点）", () => {
	it("T2-1 pending 卡结构：头行/正文预览 800 截断/完整参数/两按钮/空状态行（:485-546）", () => {
		const action = {
			id: 7,
			name: "append_chapter",
			status: "pending",
			args: { chapterId: 3, title: "第三章", text: "正".repeat(900) },
		};
		mountCard({ action, bookId: "B1" });
		const card = cardEl();
		expect(card.classList.contains("status-pending")).toBe(true);
		expect(card.classList.contains("msg-action-readonly")).toBe(false);
		expect(card.querySelector(".action-head").textContent).toBe(
			"AI 请求写操作：追加章节正文",
		);
		const pre = card.querySelector(".action-preview");
		expect(pre.textContent.length).toBe(801);
		expect(pre.textContent).toBe(`${"正".repeat(800)}…`);
		expect(card.querySelector(".action-args > summary").textContent).toBe(
			"完整参数",
		);
		expect(card.querySelector(".action-args pre").textContent).toBe(
			JSON.stringify(action.args, null, 2),
		);
		expect(opsButtons().map((b) => b.textContent)).toEqual([
			"同意执行",
			"拒绝",
		]);
		expect(card.querySelector(".action-status").textContent).toBe("");
		// 无 text/content 参数时不渲染预览块（:497）
		mountCard({
			action: {
				id: 8,
				name: "write_story_state",
				status: "pending",
				args: { a: 1 },
			},
		});
		expect(cardEl().querySelector(".action-preview")).toBeNull();
	});

	it("T2-2 只读历史卡八类：readonly 类＋历史头行＋状态文案＋零按钮零勾选（:519-524）", () => {
		const cases = [
			["executing", "执行中…"],
			["approved", "已执行 ✓"],
			["rejected", "已拒绝，未做任何改动"],
			["expired", "已过期未执行（等待确认超时）"],
			["superseded", "已被更新的同类请求取代（未执行）"],
			["failed", "执行失败"],
			["interrupted", "执行中断，可能已部分生效——请核对目标内容后重新发起"],
			["foo", "已结算（状态未知）"],
		];
		for (let i = 0; i < cases.length; i++) {
			const [status, text] = cases[i];
			mountCard({
				action: {
					id: 100 + i,
					name: "append_chapter",
					status,
					args: {},
					chapterLocked: true,
				},
			});
			const card = cardEl();
			expect(card.classList.contains("msg-action-readonly")).toBe(true);
			expect(card.querySelector(".action-head").textContent).toBe(
				"写操作（历史）：追加章节正文",
			);
			expect(card.querySelector(".action-status").textContent).toBe(text);
			expect(card.querySelectorAll("button").length).toBe(0);
			expect(card.querySelectorAll("input[type=checkbox]").length).toBe(0);
		}
	});

	it("T2-3 relock 勾选仅 chapterLocked 且 append/replace 出现，默认未勾（:526-536）", () => {
		mountCard({
			action: {
				id: 1,
				name: "append_chapter",
				chapterLocked: true,
				status: "pending",
				args: {},
			},
		});
		const label = host.querySelector(".action-relock");
		expect(label).not.toBeNull();
		expect(label.textContent).toBe(" 写入后自动重新定稿（重建语义索引）");
		expect(label.querySelector("input[type=checkbox]").checked).toBe(false);
		mountCard({
			action: {
				id: 2,
				name: "replace_chapter",
				chapterLocked: true,
				status: "pending",
				args: {},
			},
		});
		expect(host.querySelector(".action-relock")).not.toBeNull();
		mountCard({
			action: {
				id: 3,
				name: "append_chapter",
				chapterLocked: false,
				status: "pending",
				args: {},
			},
		});
		expect(host.querySelector(".action-relock")).toBeNull();
		mountCard({
			action: {
				id: 4,
				name: "write_story_state",
				chapterLocked: true,
				status: "pending",
				args: {},
			},
		});
		expect(host.querySelector(".action-relock")).toBeNull();
	});

	it("T2-4 两段式确认第一段：openModal 入参逐字＋1500 截断＋#modal-relock，零 POST（:592-618）", () => {
		const action = {
			id: 9,
			name: "append_chapter",
			status: "pending",
			chapterLocked: true,
			args: {
				chapterId: 3,
				title: "第三章",
				text: "x".repeat(1600),
				content: "y",
			},
		};
		mountCard({ action, bookId: "B1" });
		act(() => {
			opsButtons()[0].click();
		});
		expect(appMock.openModal).toHaveBeenCalledTimes(1);
		expect(lastModal.title).toBe("确认写操作");
		expect(lastModal.okText).toBe("确认执行");
		expect(lastModal.danger).toBe(true);
		expect(lastModal.bodyHTML).toContain(
			"<p>AI 请求执行写操作，执行后将真实改动作品数据。请确认：</p>",
		);
		expect(lastModal.bodyHTML).toContain(
			"<p><strong>追加章节正文</strong></p>",
		);
		const previewArgs = { ...action.args, text: `${"x".repeat(1500)}…` };
		expect(lastModal.bodyHTML).toContain(
			`<pre class="action-preview">${realEscapeHtml(JSON.stringify(previewArgs, null, 2))}</pre>`,
		);
		expect(lastModal.bodyHTML).toContain('id="modal-relock"');
		expect(lastModal.bodyHTML).not.toContain("checked");
		// 勾选态快照随确认请求提交（:610/:617）
		act(() => {
			host.querySelector(".action-relock input").click();
		});
		act(() => {
			opsButtons()[0].click();
		});
		expect(lastModal.bodyHTML).toContain('id="modal-relock" checked');
		// 未点弹窗确认前零 POST、零 fetch
		expect(appMock.api).not.toHaveBeenCalled();
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		// 非锁定类动作不带 #modal-relock（:616-618）
		mountCard({
			action: {
				id: 10,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
			bookId: "B1",
		});
		act(() => {
			opsButtons()[0].click();
		});
		expect(lastModal.bodyHTML).not.toContain("modal-relock");
	});

	it("T2-5 第二段执行：执行中→approved、POST 逐字、toast/回调各恰 1 次（:619-641）", async () => {
		const action = {
			id: 9,
			name: "append_chapter",
			status: "pending",
			args: { chapterId: 3 },
		};
		const onSettled = vi.fn();
		const resume = vi.fn();
		let postResolve;
		appMock.api.mockImplementation(
			() =>
				new Promise((resolve) => {
					postResolve = resolve;
				}),
		);
		mountCard({ action, bookId: "B1", onSettled, resume });
		act(() => {
			opsButtons()[0].click();
		});
		let inflight;
		await act(async () => {
			inflight = lastModal.onOk();
		});
		// 飞行中：两按钮 disabled、状态行「执行中…」、根 class 切 status-executing
		expect(opsButtons().every((b) => b.disabled)).toBe(true);
		expect(cardEl().classList.contains("status-executing")).toBe(true);
		expect(cardEl().querySelector(".action-status").textContent).toBe(
			"执行中…",
		);
		expect(appMock.api).toHaveBeenCalledTimes(1);
		expect(appMock.api).toHaveBeenCalledWith(
			"POST",
			"/api/books/B1/chat-actions/9/confirm",
			{ approve: true, relock: false },
		);
		await act(async () => {
			postResolve({ relocked: false });
			await inflight;
		});
		expect(cardEl().classList.contains("status-approved")).toBe(true);
		expect(cardEl().classList.contains("msg-action-readonly")).toBe(true);
		expect(cardEl().querySelector(".action-status").textContent).toBe(
			"已执行 ✓",
		);
		expect(appMock.toast).toHaveBeenCalledWith("写操作已执行");
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledWith("append_chapter", action.args);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledWith(9);
	});

	it("T2-5b relocked 变体：状态行「已执行 ✓（已重新定稿）」＋toast 二选一逐字（:629-630）", async () => {
		appMock.api.mockResolvedValue({ relocked: true });
		mountCard({
			action: {
				id: 9,
				name: "replace_chapter",
				status: "pending",
				chapterLocked: true,
				args: {},
			},
			bookId: "B1",
		});
		act(() => {
			opsButtons()[0].click();
		});
		await act(async () => {
			await lastModal.onOk();
		});
		expect(cardEl().querySelector(".action-status").textContent).toBe(
			"已执行 ✓（已重新定稿）",
		);
		expect(appMock.toast).toHaveBeenCalledWith(
			"写操作已执行，已重新定稿（后台重建索引中）",
		);
	});

	it("T2-6 第二段失败：回 pending＋可重试＋toast＋返回 false（弹窗不关）（:633-640）", async () => {
		appMock.api.mockRejectedValue(new Error("网络断了"));
		mountCard({
			action: { id: 9, name: "append_chapter", status: "pending", args: {} },
			bookId: "B1",
		});
		act(() => {
			opsButtons()[0].click();
		});
		let ret;
		await act(async () => {
			ret = await lastModal.onOk();
		});
		expect(ret).toBe(false);
		expect(cardEl().classList.contains("status-pending")).toBe(true);
		expect(cardEl().querySelector(".action-status").textContent).toBe(
			"执行失败，可重试",
		);
		expect(opsButtons().every((b) => b.disabled)).toBe(false);
		expect(appMock.toast).toHaveBeenCalledWith("网络断了");
	});

	it("T2-7 拒绝：不弹窗、body 逐字、收编留痕行、resume 恰 1 次、afterSettled 0 次（:557-568、:644）", async () => {
		const action = {
			id: 11,
			name: "write_story_state",
			status: "pending",
			args: { a: 1 },
		};
		const onSettled = vi.fn();
		const resume = vi.fn();
		appMock.api.mockResolvedValue({});
		mountCard({ action, bookId: "B1", onSettled, resume });
		await act(async () => {
			opsButtons()[1].click();
		});
		expect(appMock.openModal).not.toHaveBeenCalled();
		expect(appMock.api).toHaveBeenCalledWith(
			"POST",
			"/api/books/B1/chat-actions/11/confirm",
			{ approve: false, relock: false },
		);
		expect(host.querySelector(".msg-action")).toBeNull();
		const log = host.querySelector(".msg-action-log");
		expect(log.classList.contains("status-rejected")).toBe(true);
		expect(log.querySelector(".log-status").textContent).toBe(
			"已拒绝，未做任何改动",
		);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledWith(11);
		expect(onSettled).toHaveBeenCalledTimes(0);
		expect(appMock.toast).toHaveBeenCalledTimes(0);
	});

	it("T2-8 拒绝路径结算失败（非中断）：回 pending＋可重试＋toast（:584-588）", async () => {
		appMock.api.mockRejectedValue(new Error("服务器 500"));
		mountCard({
			action: {
				id: 12,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
			bookId: "B1",
		});
		await act(async () => {
			opsButtons()[1].click();
		});
		expect(cardEl().classList.contains("status-pending")).toBe(true);
		expect(cardEl().querySelector(".action-status").textContent).toBe(
			"执行失败，可重试",
		);
		expect(opsButtons().every((b) => b.disabled)).toBe(false);
		expect(appMock.toast).toHaveBeenCalledWith("服务器 500");
	});

	it("T2-9 中断终态：ACTION_REQUIRES_REVIEW／CONFIRMATION_INTERRUPTED 只读不给重放（:576-583）", async () => {
		// settle 分支唯一可达入口＝拒绝（legacy :644）；中断判定在 :578 同一代码路径。
		const codes = ["ACTION_REQUIRES_REVIEW", "CONFIRMATION_INTERRUPTED"];
		for (let i = 0; i < codes.length; i++) {
			const err = new Error("执行中断，不能重放");
			err.code = codes[i];
			appMock.api.mockRejectedValue(err);
			mountCard({
				action: {
					id: 200 + i,
					name: "write_story_state",
					status: "pending",
					args: {},
				},
				bookId: "B1",
			});
			await act(async () => {
				opsButtons()[1].click();
			});
			const card = cardEl();
			expect(card.classList.contains("status-interrupted")).toBe(true);
			expect(card.classList.contains("msg-action-readonly")).toBe(true);
			expect(card.querySelector(".action-status").textContent).toBe(
				"执行中断，可能已部分生效——请核对目标内容后重新发起",
			);
			expect(opsButtons().every((b) => b.disabled)).toBe(true); // 按钮不得恢复
			expect(host.querySelector(".msg-action-log")).toBeNull();
			expect(appMock.toast).toHaveBeenCalledWith("执行中断，不能重放");
		}
	});

	it("T2-10 防重入：结算飞行中重复触发不产生第二次 POST（:558-559）", async () => {
		let postResolve;
		appMock.api.mockImplementation(
			() =>
				new Promise((resolve) => {
					postResolve = resolve;
				}),
		);
		mountCard({
			action: {
				id: 14,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
			bookId: "B1",
		});
		await act(async () => {
			opsButtons()[1].click();
		});
		const okBtn = opsButtons()[0];
		act(() => {
			okBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			opsButtons()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(appMock.api).toHaveBeenCalledTimes(1);
		expect(appMock.openModal).not.toHaveBeenCalled();
		await act(async () => {
			postResolve({});
		});
	});

	it("T2-11 留痕行：icon/文案/args.title 后缀/状态 span/title 属性（:447-468）", () => {
		const action = {
			id: 5,
			name: "append_chapter",
			status: "approved",
			args: { chapterId: 3, title: "第三章" },
		};
		act(() => {
			root.render(<ChatActionLogRow action={action} />);
		});
		const row = host.querySelector(".msg-action-log");
		expect(row.classList.contains("status-approved")).toBe(true);
		expect(row.querySelector(".log-icon").textContent).toBe("✓");
		expect(row.querySelector(".log-text").textContent).toBe(
			"追加章节正文「第三章」",
		);
		expect(row.querySelector(".log-status").textContent).toBe("已执行 ✓");
		expect(row.title).toBe(JSON.stringify(action.args, null, 2));
		act(() => {
			root.render(
				<ChatActionLogRow
					action={{
						id: 6,
						name: "write_story_state",
						status: "rejected",
						args: {},
					}}
				/>,
			);
		});
		expect(host.querySelector(".log-icon").textContent).toBe("✕");
		act(() => {
			root.render(
				<ChatActionLogRow
					action={{
						id: 6,
						name: "write_story_state",
						status: "expired",
						args: {},
					}}
				/>,
			);
		});
		expect(host.querySelector(".log-icon").textContent).toBe("·");
		// 老数据回落链 TOOL_LABELS[name] || summary || name（:457）
		act(() => {
			root.render(
				<ChatActionLogRow
					action={{
						id: 6,
						name: "旧工具名",
						status: "failed",
						summary: "摘要",
						args: {},
					}}
				/>,
			);
		});
		// 老数据回落链 TOOL_LABELS[name] || summary || name（:457）：summary 优先于原始工具名
		expect(host.querySelector(".log-text").textContent).toBe("摘要");
		act(() => {
			root.render(
				<ChatActionLogRow
					action={{ id: 6, name: "旧工具名", status: "failed", args: {} }}
				/>,
			);
		});
		expect(host.querySelector(".log-text").textContent).toBe("旧工具名");
		act(() => {
			root.render(
				<ChatActionLogRow action={{ id: 6, status: "failed", args: {} }} />,
			);
		});
		expect(host.querySelector(".log-text").textContent).toBe("");
		expect(host.querySelector(".msg-action-log").title).toBe("{}");
	});

	it("T2-12 工具块：details.tool-call／summary／入参／结果字符串直出（:400-416）", () => {
		act(() => {
			root.render(
				<ChatToolEventBlock
					event={{
						name: "search_story",
						args: { q: "雨" },
						result: "命中 2 段",
					}}
				/>,
			);
		});
		const box = host.querySelector("details.tool-call");
		expect(box).not.toBeNull();
		expect(box.querySelector("summary").textContent).toBe(
			"调用工具：语义检索旧文",
		);
		const pres = box.querySelectorAll(".tool-call-body pre");
		expect(pres[0].textContent).toBe('入参：{"q":"雨"}');
		expect(pres[1].textContent).toBe("结果：命中 2 段");
		act(() => {
			root.render(
				<ChatToolEventBlock
					event={{ name: "未知工具", args: {}, result: { ok: 1 } }}
				/>,
			);
		});
		expect(host.querySelector("summary").textContent).toBe(
			"调用工具：未知工具",
		);
		const pres2 = host.querySelectorAll(".tool-call-body pre");
		expect(pres2[0].textContent).toBe("入参：{}");
		expect(pres2[1].textContent).toBe('结果：{"ok":1}');
	});

	it("T2-13 bookId 缺省取 App.state.currentBook.id（:477）", async () => {
		appMock.api.mockResolvedValue({});
		mountCard({
			action: {
				id: 21,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
		});
		await act(async () => {
			opsButtons()[1].click();
		});
		expect(appMock.api).toHaveBeenCalledWith(
			"POST",
			"/api/books/B1/chat-actions/21/confirm",
			{ approve: false, relock: false },
		);
	});

	it("T2-14 零桥注册／零 fetch：渲染与结算都不写 window 全局（§1.2 纯渲染纪律）", async () => {
		appMock.api.mockResolvedValue({});
		mountCard({
			action: {
				id: 22,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
			bookId: "B1",
		});
		await act(async () => {
			opsButtons()[1].click();
		});
		expect(window.BookPage).toBeUndefined();
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("T2-15 status 缺省＝pending：SSE action 事件不带 status（:481-482）", () => {
		mountCard({
			action: { id: 31, name: "append_chapter", args: { chapterId: 1 } },
			bookId: "B1",
		});
		expect(cardEl().classList.contains("status-pending")).toBe(true);
		expect(cardEl().classList.contains("msg-action-readonly")).toBe(false);
		expect(opsButtons().map((b) => b.textContent)).toEqual([
			"同意执行",
			"拒绝",
		]);
	});

	it("T2-16 回调缺省安全：onSettled/resume 缺省 no-op 不抛错、零全局写入（:479-480）", async () => {
		appMock.api.mockResolvedValue({});
		mountCard({
			action: {
				id: 32,
				name: "write_story_state",
				status: "pending",
				args: {},
			},
			bookId: "B1",
		});
		await act(async () => {
			opsButtons()[1].click();
		});
		expect(host.querySelector(".msg-action-log")).not.toBeNull();
		expect(window.BookPage).toBeUndefined();
		expect(window.RunStatus).toBeUndefined();
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});
});
