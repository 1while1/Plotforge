// @vitest-environment jsdom
// S5-8 红测 T4（Plan §4 T4）：frontend/hooks/use-agent-handoff.js —— 笔记/交接流程执行。
// 语义唯一事实源＝public/legacy/agent.js :767-806（存笔记）／:900-939（打开后弹窗内绑定）／
// :941-1010（建草案）／:1012-1021（预览）／:1054-1107（预览弹窗三按钮）／:1110-1184（作废/接受）。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言；api/toast/openModal/closeModal/escapeHtml/
// storage/confirm 全注入；弹窗五件套按 Modal.jsx:4-12 的 id 契约自建。
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentHandoff } from "./use-agent-handoff.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const escapeHtml = (s) =>
	String(s == null ? "" : s).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

function store(initial) {
	const map = Object.assign({}, initial);
	return {
		map,
		getItem: (k) => (k in map ? map[k] : null),
		setItem: (k, v) => {
			map[k] = v;
		},
	};
}

let calls;
let routes;
let openCalls;
let toasts;
let deps;
let hook;
let root;
let host;

function apiStub(method, url, body) {
	calls.push({ method, url, body });
	const handler = routes[`${method} ${url}`];
	if (handler === undefined) {
		return Promise.reject(new Error(`无路由 ${method} ${url}`));
	}
	if (typeof handler === "function") return handler(body);
	return Promise.resolve(handler);
}

function closeModal() {
	document.getElementById("modal-mask").classList.add("hidden");
}

function openModal(opts) {
	openCalls.push(opts);
	document.getElementById("modal-title").textContent = opts.title;
	document.getElementById("modal-body").innerHTML = opts.bodyHTML;
	document.getElementById("modal-ok").textContent = opts.okText || "确定";
	document.getElementById("modal-mask").classList.remove("hidden");
	const ok = document.getElementById("modal-ok");
	ok.onclick = () => {
		if (typeof opts.onOk !== "function") {
			closeModal();
			return;
		}
		const ret = opts.onOk(document.getElementById("modal-body"));
		if (ret && typeof ret.then === "function") {
			ret.then((r) => {
				if (r !== false) closeModal();
			});
		} else if (ret !== false) {
			closeModal();
		}
	};
}

function modalBody() {
	return document.getElementById("modal-body");
}

const ACTIVE_CONV = { id: "c1", title: "讨论甲", status: "active" };
const PICKS = [
	{ id: 1, role: "user", content: "结论一" },
	{ id: 2, role: "assistant", content: "结论二" },
];

beforeEach(() => {
	document.body.innerHTML = `
		<div id="modal-mask" class="modal-mask hidden">
			<div id="modal-title"></div>
			<div id="modal-body"></div>
			<button id="modal-ok"></button>
			<button id="modal-cancel"></button>
		</div>
		<div id="toast" class="hidden"></div>`;
	calls = [];
	routes = {};
	openCalls = [];
	toasts = [];
	hook = null;
	deps = {
		api: apiStub,
		toast: (m) => toasts.push(m),
		openModal,
		closeModal: vi.fn(closeModal),
		escapeHtml,
		storage: store({}),
		confirm: vi.fn(() => true),
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.innerHTML = "";
});

async function mountHook() {
	function Probe() {
		hook = useAgentHandoff(deps);
		return null;
	}
	await act(async () => {
		root.render(createElement(Probe));
	});
}

describe("T4 use-agent-handoff（笔记/交接流程执行）", () => {
	it("T4-1 saveNote 前置校验（:767-770）：无会话/归档/无勾选三条 toast，零请求零弹窗", async () => {
		await mountHook();
		await act(async () =>
			hook.saveNote({ conversation: null, scopeTitle: "《甲》", picks: [] }),
		);
		expect(toasts.at(-1)).toBe("请先选择会话");
		expect(calls).toEqual([]);
		expect(openCalls).toEqual([]);

		await act(async () =>
			hook.saveNote({
				conversation: { id: "c1", status: "archived" },
				scopeTitle: "《甲》",
				picks: [],
			}),
		);
		expect(toasts.at(-1)).toBe("该会话已归档：只读，不能再新建笔记");

		await act(async () =>
			hook.saveNote({
				conversation: ACTIVE_CONV,
				scopeTitle: "《甲》",
				picks: [],
			}),
		);
		expect(toasts.at(-1)).toBe("先在讨论里勾选要沉淀的结论");
		expect(calls).toEqual([]);
		expect(openCalls).toEqual([]);
	});

	it("T4-2 saveNote 成功（:783-799）：弹窗 title/okText、POST body 逐字、成功 toast、lastPlanningNote 仅四字段", async () => {
		routes["POST /api/planning-notes"] = {
			id: 9,
			title: "纪要",
			revision: 1,
			conversationId: "c1",
			extra: "not-kept",
		};
		await mountHook();
		await act(async () =>
			hook.saveNote({
				conversation: ACTIVE_CONV,
				scopeTitle: "星尘",
				picks: PICKS,
			}),
		);
		expect(openCalls.at(-1).title).toBe("存为规划笔记（草稿）");
		expect(openCalls.at(-1).okText).toBe("存为笔记");
		const body = modalBody();
		expect(body.querySelector("#agent-note-title").value).toBe(
			"星尘 · 讨论纪要",
		);
		expect(body.querySelector("#agent-note-text").value).toBe(
			"结论一\n\n结论二",
		);

		await act(async () => {
			document.getElementById("modal-ok").click();
		});
		expect(calls.at(-1)).toEqual({
			method: "POST",
			url: "/api/planning-notes",
			body: {
				conversationId: "c1",
				title: "星尘 · 讨论纪要",
				text: "结论一\n\n结论二",
				selectedMessageIds: [1, 2],
			},
		});
		expect(toasts.at(-1)).toBe(
			"已存为规划笔记草稿（不是故事事实；创建交接时可把它作为来源引用）",
		);
		expect(hook.lastPlanningNote).toEqual({
			id: 9,
			title: "纪要",
			revision: 1,
			conversationId: "c1",
		});
		expect(Object.keys(hook.lastPlanningNote)).toEqual([
			"id",
			"title",
			"revision",
			"conversationId",
		]);
		// 弹窗关闭由 onOk 的返回值驱动（true）
		await vi.waitFor(() =>
			expect(
				document.getElementById("modal-mask").classList.contains("hidden"),
			).toBe(true),
		);
	});

	it("T4-3 saveNote 空正文（:787）：toast 逐字＋弹窗不关＋零请求", async () => {
		await mountHook();
		await act(async () =>
			hook.saveNote({
				conversation: ACTIVE_CONV,
				scopeTitle: "星尘",
				picks: PICKS,
			}),
		);
		modalBody().querySelector("#agent-note-text").value = "   ";
		await act(async () => {
			document.getElementById("modal-ok").click();
		});
		expect(toasts.at(-1)).toBe("笔记正文不能为空（服务端不接受空笔记）");
		expect(calls).toEqual([]);
		expect(
			document.getElementById("modal-mask").classList.contains("hidden"),
		).toBe(false);
	});

	it("T4-4 saveNote 失败（:800-803）：toast 前缀＋弹窗不关", async () => {
		routes["POST /api/planning-notes"] = () =>
			Promise.reject(new Error("网络炸"));
		await mountHook();
		await act(async () =>
			hook.saveNote({
				conversation: ACTIVE_CONV,
				scopeTitle: "星尘",
				picks: PICKS,
			}),
		);
		await act(async () => {
			document.getElementById("modal-ok").click();
		});
		expect(toasts.at(-1)).toBe("存笔记失败：网络炸");
		expect(
			document.getElementById("modal-mask").classList.contains("hidden"),
		).toBe(false);
	});

	it("T4-5 createHandoff 书籍范围（:941-965）：先查该书写作会话、默认目标＝remembered、快照字段逐条、不渲染目标书选择器", async () => {
		routes["GET /api/conversations?kind=writing&bookId=7"] = [
			{ id: "w1", title: "写作会话", status: "active" },
		];
		deps.storage = store({ writing_conversation_7: "w1" });
		await mountHook();
		await act(async () =>
			hook.createHandoff({
				conversation: ACTIVE_CONV,
				scope: { kind: "book", bookId: 7 },
				books: [{ id: 7, title: "星尘" }],
				boundaryChapters: [{ id: 12, title: "石碑" }],
				boundaryChapterId: 12,
				picks: PICKS,
			}),
		);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toBe("/api/conversations?kind=writing&bookId=7");
		expect(openCalls.at(-1).title).toBe("创建交接到写作（草案）");
		expect(openCalls.at(-1).okText).toBe("创建草案");
		const body = modalBody();
		expect(body.querySelector("#handoff-target-book")).toBeNull();
		expect(body.querySelector("#handoff-target-conversation").value).toBe("w1");
		expect(body.querySelector("#handoff-target-hint").textContent).toBe(
			"将交给：《星尘》· 写作会话",
		);
		expect(body.querySelector("#handoff-ref-chapter")).not.toBeNull();
		expect(body.querySelector("#handoff-ref-note")).toBeNull();
		expect(body.querySelector("#handoff-text").value).toBe("结论一\n\n结论二");
	});

	it("T4-5b createHandoff 全局范围：目标书 change 绑定生效（选书→查会话、不自动挑会话；清空→提示回落）", async () => {
		routes["GET /api/conversations?kind=writing&bookId=7"] = [
			{ id: "w1", title: "写作会话", status: "active" },
		];
		await mountHook();
		await act(async () =>
			hook.createHandoff({
				conversation: ACTIVE_CONV,
				scope: { kind: "global", bookId: null },
				books: [{ id: 7, title: "星尘" }],
				boundaryChapters: [],
				boundaryChapterId: null,
				picks: PICKS,
			}),
		);
		const body = modalBody();
		const bookSel = body.querySelector("#handoff-target-book");
		expect(bookSel).not.toBeNull();
		expect(bookSel.options[0].textContent).toBe("（请选择目标书）");
		expect(body.querySelector("#handoff-target-conversation").value).toBe("");
		expect(body.querySelector("#handoff-target-hint").textContent).toBe(
			"先选目标书，再选该书写作会话（全局讨论不自动挑书）。",
		);

		bookSel.value = "7";
		await act(async () => {
			bookSel.dispatchEvent(new Event("change"));
		});
		await vi.waitFor(() =>
			expect(body.querySelector("#handoff-target-hint").textContent).toBe(
				"将交给：《星尘》· （未选择会话）",
			),
		);
		expect(body.querySelector("#handoff-target-conversation").value).toBe("");
		expect(
			calls.filter((c) => c.url === "/api/conversations?kind=writing&bookId=7"),
		).toHaveLength(1);

		bookSel.value = "";
		await act(async () => {
			bookSel.dispatchEvent(new Event("change"));
		});
		expect(body.querySelector("#handoff-target-conversation").innerHTML).toBe(
			'<option value="">（先选择目标书）</option>',
		);
		expect(body.querySelector("#handoff-target-hint").textContent).toBe(
			"先选目标书，再选该书写作会话（全局讨论不自动挑书）。",
		);
	});

	it("T4-6 submitHandoffDraft（:967-1010）：目标未选两条 toast／材料为空／sourceRefs 条件携带／POST body 四字段／成功预览且弹窗保持", async () => {
		routes["GET /api/conversations?kind=writing&bookId=7"] = [
			{ id: "w1", title: "写作会话", status: "active" },
		];
		routes["POST /api/handoffs"] = { id: "h1" };
		routes["GET /api/handoffs/h1"] = {
			id: "h1",
			target: { title: "写作会话", busy: false },
			material: { text: "摘要" },
			sourceFingerprint: "fp1",
		};
		deps.storage = store({});
		await mountHook();
		// 先存笔记 → lastPlanningNote（note 引用只在同一会话时携带）
		routes["POST /api/planning-notes"] = {
			id: 5,
			title: "纪要",
			revision: 2,
			conversationId: "c1",
		};
		await act(async () =>
			hook.saveNote({
				conversation: ACTIVE_CONV,
				scopeTitle: "星尘",
				picks: PICKS,
			}),
		);
		await act(async () => {
			document.getElementById("modal-ok").click();
		});

		const ctx = {
			conversation: ACTIVE_CONV,
			scope: { kind: "book", bookId: 7 },
			books: [{ id: 7, title: "星尘" }],
			boundaryChapters: [{ id: 12, title: "石碑" }],
			boundaryChapterId: 12,
			picks: PICKS,
		};
		await act(async () => hook.createHandoff(ctx));
		// 目标会话未选 → 第一条互斥 toast
		modalBody().querySelector("#handoff-target-conversation").value = "";
		await act(async () => {
			document.getElementById("modal-ok").click();
		});
		await vi.waitFor(() =>
			expect(toasts.at(-1)).toBe(
				"请选择目标写作会话（交接只写入你选定的会话）",
			),
		);
		expect(
			calls.filter((c) => c.method === "POST" && c.url === "/api/handoffs"),
		).toHaveLength(0);

		// 正文与勾选皆空 → 材料为空（直接以空 picks 快照调 submitHandoffDraft：
		// createHandoff 自身在 :944 就会因无勾选提前返回，该分支只可能出现在提交期）
		const emptySnapshot = {
			bookScope: true,
			bookId: 7,
			bookTitle: "星尘",
			writingList: [{ id: "w1", title: "写作会话", status: "active" }],
			targetId: "w1",
			picks: [],
			chapterId: null,
			note: null,
		};
		modalBody().querySelector("#handoff-target-conversation").value = "w1";
		modalBody().querySelector("#handoff-text").value = "   ";
		await act(async () => {
			await hook.submitHandoffDraft(modalBody(), emptySnapshot, ACTIVE_CONV);
		});
		await vi.waitFor(() =>
			expect(toasts.at(-1)).toBe(
				"交接材料不能为空：写一句摘要或先勾选讨论结论",
			),
		);
		expect(
			calls.filter((c) => c.method === "POST" && c.url === "/api/handoffs"),
		).toHaveLength(0);

		// 正常提交：note 引用（同一会话）＋章节引用逐条携带
		await act(async () => hook.createHandoff(ctx));
		modalBody().querySelector("#handoff-target-conversation").value = "w1";
		modalBody().querySelector("#handoff-text").value = "  请接手  ";
		await act(async () => {
			document.getElementById("modal-ok").click();
		});
		await vi.waitFor(() =>
			expect(
				calls.filter((c) => c.method === "POST" && c.url === "/api/handoffs"),
			).toHaveLength(1),
		);
		expect(
			calls.find((c) => c.method === "POST" && c.url === "/api/handoffs").body,
		).toEqual({
			originConversationId: "c1",
			targetConversationId: "w1",
			selectedMessageIds: [1, 2],
			text: "请接手",
			sourceRefs: [
				{ kind: "chapter", id: 12 },
				{ kind: "planning_note", id: 5 },
			],
		});
		await vi.waitFor(() =>
			expect(openCalls.at(-1).title).toBe("交接预览（接受前请核对材料与来源）"),
		);
		expect(openCalls.at(-1).okText).toBe("关闭（不交接）");
		// 成功路径 return false：弹窗保持（不关闭）
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(
			document.getElementById("modal-mask").classList.contains("hidden"),
		).toBe(false);
		expect(modalBody().querySelector("#handoff-preview-text").textContent).toBe(
			"摘要",
		);
	});

	it("T4-6b submitHandoffDraft 失败与防重入（:992-1009）：toast 前缀、忙碌期二次调用零新增请求", async () => {
		routes["GET /api/conversations?kind=writing&bookId=7"] = [
			{ id: "w1", title: "写作会话", status: "active" },
		];
		let rejectPost;
		let resolvePost;
		routes["POST /api/handoffs"] = () =>
			new Promise((resolve, reject) => {
				resolvePost = resolve;
				rejectPost = reject;
			});
		routes["GET /api/handoffs/h1"] = {
			id: "h1",
			target: { title: "写作会话", busy: false },
			material: {},
			sourceFingerprint: "fp1",
		};
		await mountHook();
		async function openCompose() {
			await act(async () =>
				hook.createHandoff({
					conversation: ACTIVE_CONV,
					scope: { kind: "book", bookId: 7 },
					books: [{ id: 7, title: "星尘" }],
					boundaryChapters: [],
					boundaryChapterId: null,
					picks: PICKS,
				}),
			);
			modalBody().querySelector("#handoff-target-conversation").value = "w1";
			modalBody().querySelector("#handoff-text").value = "摘要";
		}
		await openCompose();
		const onOk1 = openCalls.at(-1).onOk;
		await act(async () => {
			onOk1(modalBody());
		});
		expect(calls.filter((c) => c.url === "/api/handoffs")).toHaveLength(1);
		// 防重入：飞行中第二次提交零新增请求
		await act(async () => {
			await onOk1(modalBody());
		});
		expect(calls.filter((c) => c.url === "/api/handoffs")).toHaveLength(1);
		// 失败恢复 → toast 前缀
		await act(async () => {
			rejectPost(new Error("后端 500"));
		});
		await vi.waitFor(() =>
			expect(toasts.at(-1)).toBe("创建交接草案失败：后端 500"),
		);
		// 失败后复位：可再次提交
		await openCompose();
		await act(async () => {
			openCalls.at(-1).onOk(modalBody());
		});
		expect(calls.filter((c) => c.url === "/api/handoffs")).toHaveLength(2);
		await act(async () => {
			resolvePost({ id: "h1" });
		});
		await vi.waitFor(() =>
			expect(openCalls.at(-1).title).toBe("交接预览（接受前请核对材料与来源）"),
		);
	});

	it("T4-7 acceptHandoff（:1147-1184）：busy/无指纹前置；成功写入 body 逐字＋done 弹窗＋toast；忙碌期按钮态与失败复位", async () => {
		routes["GET /api/handoffs/h1"] = {
			id: "h1",
			target: { title: "写作会话", busy: false },
			material: { text: "摘要" },
			sourceFingerprint: "fp1",
		};
		await mountHook();
		await act(async () => hook.showHandoffPreview("h1"));
		expect(openCalls.at(-1).title).toBe("交接预览（接受前请核对材料与来源）");
		const view = {
			id: "h1",
			target: { title: "写作会话", busy: false },
			material: {},
			sourceFingerprint: "fp1",
		};

		// busy 前置：零请求 + toast 逐字
		await act(async () =>
			hook.acceptHandoff(
				{ ...view, target: { title: "写作会话", busy: true } },
				null,
			),
		);
		expect(toasts.at(-1)).toBe(
			"目标会话正在运行中：等这一轮结束后点「重新预览」再交接（不会混进正在发给模型的请求）",
		);
		// 无指纹/已变更
		await act(async () => hook.acceptHandoff({ id: "h1", target: {} }, null));
		expect(toasts.at(-1)).toBe("来源已变更：请重新预览后再交接");
		expect(calls.filter((c) => c.url.endsWith("/accept"))).toHaveLength(0);

		// 成功：按钮忙碌态 → 接受 → done 弹窗
		let resolveAccept;
		routes["POST /api/handoffs/h1/accept"] = () =>
			new Promise((resolve) => {
				resolveAccept = resolve;
			});
		const btn = modalBody().querySelector("#btn-handoff-accept");
		await act(async () => {
			btn.click();
		});
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("交接中…");
		await act(async () => {
			resolveAccept({
				id: "h1",
				target: { title: "写作会话", busy: false },
				material: { text: "摘要" },
				sourceFingerprint: "fp1",
				acceptedMessageId: "m9",
				duplicate: false,
			});
		});
		expect(calls.find((c) => c.url.endsWith("/accept")).body).toEqual({
			expectedSourceFingerprint: "fp1",
		});
		await vi.waitFor(() =>
			expect(openCalls.at(-1).title).toBe("已交接（一条注明来源的消息）"),
		);
		expect(openCalls.at(-1).okText).toBe("完成");
		expect(toasts.at(-1)).toBe("已交接到写作会话（一条注明来源的消息）");

		// duplicate 分支
		routes["POST /api/handoffs/h1/accept"] = {
			id: "h1",
			target: { title: "写作会话" },
			material: {},
			sourceFingerprint: "fp1",
			duplicate: true,
		};
		await act(async () => hook.acceptHandoff(view, null));
		expect(toasts.at(-1)).toBe("该交接此前已交接（同一条消息，未重复插入）");

		// 四类错误码 + 失败复位（按钮文案/禁用态）
		const cases = [
			[
				"HANDOFF_TARGET_BUSY",
				"目标会话正在运行中：等这一轮结束后点「重新预览」再接受",
			],
			[
				"HANDOFF_SOURCE_CHANGED",
				"来源资料已更新：请点「重新预览」核对后再接受",
			],
			[
				"HANDOFF_TARGET_ARCHIVED",
				"目标写作会话已归档：请在写作页另开会话后重新创建交接",
			],
			["", "交接失败：boom"],
		];
		for (const [code, expectToast] of cases) {
			const err = new Error("boom");
			if (code) err.code = code;
			routes["POST /api/handoffs/h1/accept"] = () => Promise.reject(err);
			await act(async () => hook.showHandoffPreview("h1"));
			const mkBtn = modalBody().querySelector("#btn-handoff-accept");
			await act(async () => {
				mkBtn.click();
			});
			await vi.waitFor(() => expect(toasts.at(-1)).toBe(expectToast));
			expect(mkBtn.disabled).toBe(false);
			expect(mkBtn.textContent).toBe("接受交接（写入写作会话）");
		}
	});

	it("T4-8 cancelHandoff（:1110-1144）：accepted 前置／confirm false／成功（空体＋closeModal＋toast）／错误码复预览／按钮复位", async () => {
		routes["GET /api/handoffs/h1"] = {
			id: "h1",
			target: { title: "写作会话", busy: false },
			material: {},
			sourceFingerprint: "fp1",
		};
		await mountHook();
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "accepted" }, null),
		);
		expect(toasts.at(-1)).toBe(
			"这条交接已经写进写作会话：作废不会撤回那条消息。要换结论请重新创建草案。",
		);
		expect(calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(0);

		// confirm 返回 false：零请求
		deps.confirm = vi.fn(() => false);
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, null),
		);
		expect(deps.confirm).toHaveBeenCalledWith(
			"作废这份交接草案？\n\n只作废草案本身（未向写作会话写入任何内容）；\n已经采纳过、写进写作会话的消息不会因此撤回。",
		);
		expect(calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(0);

		// 成功：空体 {} + closeModal + toast
		deps.confirm = vi.fn(() => true);
		routes["POST /api/handoffs/h1/cancel"] = { id: "h1", status: "cancelled" };
		const btn = document.createElement("button");
		btn.textContent = "作废草案";
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, btn),
		);
		const cancelCall = calls.find((c) => c.url.endsWith("/cancel"));
		expect(cancelCall.method).toBe("POST");
		expect(cancelCall.body).toEqual({});
		expect(deps.closeModal).toHaveBeenCalled();
		expect(toasts.at(-1)).toBe("草案已作废（未向写作会话写入任何内容）");
		// legacy 成功路径不复位按钮（弹窗已关，:1122-1127）；复位只在失败分支（:1137）
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("作废中…");

		// duplicate 分支
		routes["POST /api/handoffs/h1/cancel"] = { id: "h1", duplicate: true };
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, null),
		);
		expect(toasts.at(-1)).toBe("该草案此前已作废（未向写作会话写入任何内容）");

		// 错误码：HANDOFF_ALREADY_* → toast 逐字 + 重新预览（GET 恰 1 次）
		const err1 = new Error("boom");
		err1.code = "HANDOFF_ALREADY_ACCEPTED";
		routes["POST /api/handoffs/h1/cancel"] = () => Promise.reject(err1);
		const getBefore = calls.filter((c) => c.url === "/api/handoffs/h1").length;
		const btn2 = document.createElement("button");
		btn2.textContent = "作废中…";
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, btn2),
		);
		expect(toasts.at(-1)).toBe(
			"这条交接已经写进写作会话：作废不会撤回那条消息（要换结论请重新创建草案）",
		);
		expect(btn2.disabled).toBe(false);
		expect(btn2.textContent).toBe("作废草案");
		expect(calls.filter((c) => c.url === "/api/handoffs/h1").length).toBe(
			getBefore + 1,
		);

		const err2 = new Error("boom");
		err2.code = "HANDOFF_ALREADY_SETTLED";
		routes["POST /api/handoffs/h1/cancel"] = () => Promise.reject(err2);
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, null),
		);
		expect(toasts.at(-1)).toBe("该交接刚刚已被处理：请刷新预览确认当前状态");

		// 兜底错误
		routes["POST /api/handoffs/h1/cancel"] = () =>
			Promise.reject(new Error("网络炸"));
		await act(async () =>
			hook.cancelHandoff({ id: "h1", status: "draft" }, null),
		);
		expect(toasts.at(-1)).toBe("作废失败：网络炸");
	});
});
