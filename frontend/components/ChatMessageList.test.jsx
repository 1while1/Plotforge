// @vitest-environment jsdom
// S5-5 红测（Plan §4 T5）：ChatMessageList（消息渲染族）。语义锚点＝public/legacy/book-chat.js
// appendMsg :871-1046（角色行 :875-886／思考块 :889-900／正文气泡与 160 折叠 :902-904、:928-929／
// 检索块 :341-365、:907-910／工具块回看 :913-915／参谋 :931-945／助手与插入 :946-988／
// 需要确认与快捷回复 :917-923、:990-1020／用户长消息 :1021-1034）＋归档组 :830-853 与插入位置
// :1600-1609＋留痕行挂载点 :1638＋scrollBottom :281-284。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-17 同款）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList, scrollBottom } from "./ChatMessageList.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;

function render(props) {
	act(() => {
		root.render(<ChatMessageList {...(props || {})} />);
	});
}

function messages() {
	return [...host.querySelectorAll(".msg")];
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
	window.confirm = vi.fn(() => true);
	globalThis.fetch = vi.fn(() => {
		throw new Error("组件内不得 fetch");
	});
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	delete globalThis.fetch;
	delete window.confirm;
});

describe("T5 ChatMessageList（legacy 行号锚点）", () => {
	it("T5-1 角色行：根类/角色文案/msg-archive/来源标签（:875-886、:855-869）", () => {
		render({
			messages: [
				{ id: 1, role: "user", content: "我先说" },
				{ id: 2, role: "consultant", content: "参谋建议" },
				{ id: 3, role: "assistant", content: "回复", source: "read" },
				{ id: 4, role: "assistant", content: "未知来源", source: "bogus" },
				{
					id: 5,
					role: "assistant",
					content: "存档摘要",
					compressed: 2,
					source: "writing",
				},
			],
		});
		const wrap = host.querySelector("#chat-messages");
		expect(wrap.classList.contains("chat-messages")).toBe(true);
		const rows = messages();
		expect(rows.length).toBe(5);
		expect(rows.map((m) => m.className)).toEqual([
			"msg user",
			"msg consultant",
			"msg assistant",
			"msg assistant",
			"msg assistant msg-archive",
		]);
		// 角色文案＝roleDiv 的首个文本节点；来源标签 append 进同一 roleDiv（:864-869），
		// 故 roleDiv.textContent ＝ 角色文案＋标签文案（legacy 同形）
		expect(
			rows.map((m) => m.querySelector(".msg-role").childNodes[0].textContent),
		).toEqual(["我", "参谋", "写作助手", "写作助手", "写作助手"]);
		expect(rows.map((m) => m.querySelector(".msg-role").textContent)).toEqual([
			"我",
			"参谋",
			"写作助手阅读页",
			"写作助手",
			"写作助手写作台",
		]);
		expect(rows[2].querySelector(".msg-source").textContent).toBe("阅读页");
		expect(rows[2].querySelector(".msg-source").className).toBe(
			"msg-source msg-source-read",
		);
		expect(rows[3].querySelector(".msg-source")).toBeNull();
		expect(rows[4].querySelector(".msg-source").textContent).toBe("写作台");
	});

	it("T5-2 思考块：仅非 user 且 trim 非空，文本为 trim 后原文（:889-900）", () => {
		render({
			messages: [
				{
					id: 1,
					role: "assistant",
					content: "正文",
					reasoning: "  想了一下  ",
				},
				{ id: 2, role: "user", content: "提问", reasoning: "不该显示" },
				{ id: 3, role: "assistant", content: "正文", reasoning: "   " },
			],
		});
		const rows = messages();
		const think = rows[0].querySelector("details.msg-reasoning");
		expect(think.querySelector("summary").textContent).toBe("思考过程");
		expect(think.querySelector(".reasoning-body").textContent).toBe("想了一下");
		expect(rows[1].querySelector(".msg-reasoning")).toBeNull();
		expect(rows[2].querySelector(".msg-reasoning")).toBeNull();
	});

	it("T5-3 正文气泡：content 原样、>160 加 clamped（:902-904、:928-929）", () => {
		const long = "长".repeat(161);
		render({
			messages: [
				{ id: 1, role: "assistant", content: long },
				{ id: 2, role: "assistant", content: "短消息" },
				{ id: 3, role: "assistant", content: "恰".repeat(160) },
			],
		});
		const rows = messages();
		expect(rows[0].querySelector(".msg-bubble").textContent).toBe(long);
		expect(
			rows[0].querySelector(".msg-bubble").classList.contains("clamped"),
		).toBe(true);
		expect(rows[1].querySelector(".msg-bubble").textContent).toBe("短消息");
		expect(
			rows[1].querySelector(".msg-bubble").classList.contains("clamped"),
		).toBe(false);
		expect(
			rows[2].querySelector(".msg-bubble").classList.contains("clamped"),
		).toBe(false);
	});

	it("T5-4 检索块：summary 与逐项 head/text（:341-365、:907-910）", () => {
		render({
			messages: [
				{
					id: 1,
					role: "assistant",
					content: "回复",
					retrieval: [
						{ chapter: "第一章", score: 0.87, text: "旧文片段" },
						{ chapter: "第二章", score: 0.5, text: "另一段" },
					],
				},
				{
					id: 2,
					role: "user",
					content: "提问",
					retrieval: [{ chapter: "第三章", score: 1, text: "x" }],
				},
				{ id: 3, role: "assistant", content: "无召回", retrieval: [] },
			],
		});
		const rows = messages();
		const box = rows[0].querySelector("details.msg-retrieval");
		expect(box.querySelector("summary").textContent).toBe(
			"参考了 2 段旧文（语义召回）",
		);
		expect(
			[...box.querySelectorAll(".retrieval-head")].map((h) => h.textContent),
		).toEqual(["《第一章》 · 相似度 0.87", "《第二章》 · 相似度 0.5"]);
		expect(
			[...box.querySelectorAll(".retrieval-text")].map((t) => t.textContent),
		).toEqual(["旧文片段", "另一段"]);
		expect(rows[1].querySelector(".msg-retrieval")).toBeNull();
		expect(rows[2].querySelector(".msg-retrieval")).toBeNull();
	});

	it("T5-5 工具块回看：非 user 逐条渲染且顺序在正文气泡之前（:913-915）", () => {
		render({
			messages: [
				{
					id: 1,
					role: "assistant",
					content: "回复",
					tools: [
						{ name: "search_story", args: { q: "雨" }, result: "命中" },
						{ name: "read_chapter", args: {}, result: 2 },
					],
				},
			],
		});
		const row = messages()[0];
		expect(row.querySelectorAll("details.tool-call").length).toBe(2);
		const classes = [...row.children].map((el) => el.className);
		expect(classes.indexOf("tool-call")).toBeGreaterThan(-1);
		expect(classes.indexOf("tool-call")).toBeLessThan(
			classes.indexOf("msg-bubble"),
		);
	});

	it("T5-6 参谋分支：仅长文给展开/收起，无插入正文（:931-945）", async () => {
		render({
			messages: [{ id: 1, role: "consultant", content: "长".repeat(161) }],
		});
		const row = messages()[0];
		const btns = [...row.querySelectorAll(".msg-actions button")];
		expect(btns.map((b) => b.textContent)).toEqual(["展开全文"]);
		expect(row.textContent).not.toContain("插入到当前章节");
		await act(async () => {
			btns[0].click();
		});
		expect(row.querySelector(".msg-bubble").classList.contains("clamped")).toBe(
			false,
		);
		expect(btns[0].textContent).toBe("收起");
		await act(async () => {
			btns[0].click();
		});
		expect(row.querySelector(".msg-bubble").classList.contains("clamped")).toBe(
			true,
		);
		expect(btns[0].textContent).toBe("展开全文");
		// 短参谋消息无按钮（:933）
		render({ messages: [{ id: 2, role: "consultant", content: "短语" }] });
		expect(messages()[0].querySelector(".msg-actions")).toBeNull();
	});

	it("T5-7 助手分支：插入正文回调／长文展开；归档态只有「还原压缩前的对话」（:946-988）", async () => {
		const onInsertToChapter = vi.fn();
		const onArchiveRestore = vi.fn();
		render({
			messages: [
				{ id: 1, role: "assistant", content: "短回复" },
				{ id: 2, role: "assistant", content: "长".repeat(161) },
			],
			onInsertToChapter,
			onArchiveRestore,
		});
		const rows = messages();
		expect(
			[...rows[0].querySelectorAll(".msg-actions button")].map(
				(b) => b.textContent,
			),
		).toEqual(["插入到当前章节"]);
		await act(async () => {
			rows[0].querySelector(".msg-actions button").click();
		});
		expect(onInsertToChapter).toHaveBeenCalledTimes(1);
		expect(onInsertToChapter).toHaveBeenCalledWith("短回复");
		expect(
			[...rows[1].querySelectorAll(".msg-actions button")].map(
				(b) => b.textContent,
			),
		).toEqual(["插入到当前章节", "展开全文"]);
		// 归档摘要：只有还原按钮，点击前 confirm 文案逐字（:951-958）
		render({
			messages: [{ id: 3, role: "assistant", content: "摘要", compressed: 2 }],
			onArchiveRestore,
		});
		const ar = messages()[0];
		const btns = [...ar.querySelectorAll(".msg-actions button")];
		expect(btns.map((b) => b.textContent)).toEqual(["还原压缩前的对话"]);
		await act(async () => {
			btns[0].click();
		});
		expect(window.confirm).toHaveBeenCalledWith(
			"还原全部已压缩的对话？（存档摘要将被移除）",
		);
		expect(onArchiveRestore).toHaveBeenCalledTimes(1);
		window.confirm.mockReturnValue(false);
		await act(async () => {
			btns[0].click();
		});
		expect(onArchiveRestore).toHaveBeenCalledTimes(1);
	});

	it("T5-8 需要确认与快捷回复：msg-confirm 类、分组标题、按钮回调（:917-923、:990-1020）", async () => {
		const onQuickReply = vi.fn();
		render({
			messages: [
				{
					id: 1,
					role: "assistant",
					content: "先这样【需要确认】1. Q1？（a/b）\n2. Q2？（c）",
				},
				{ id: 2, role: "assistant", content: "没有确认块" },
			],
			onQuickReply,
		});
		const row = messages()[0];
		expect(row.classList.contains("msg-confirm")).toBe(true);
		expect(messages()[1].classList.contains("msg-confirm")).toBe(false);
		const titles = [...row.querySelectorAll(".quick-group-title")].map(
			(t) => t.textContent,
		);
		expect(titles).toEqual(["Q1？", "Q2？"]);
		const opts = [...row.querySelectorAll(".quick-group-opts button")];
		expect(opts.map((b) => b.textContent)).toEqual(["a", "b", "c"]);
		expect(opts.every((b) => b.getAttribute("type") === "button")).toBe(true);
		await act(async () => {
			opts[0].click();
		});
		expect(onQuickReply).toHaveBeenCalledWith("a");
		// 无问题结构（loose 兜底）时不渲染标题行（:998）
		render({
			messages: [
				{ id: 3, role: "assistant", content: "【需要确认】（继续/停止）" },
			],
			onQuickReply,
		});
		const row3 = messages()[0];
		expect(row3.querySelector(".quick-group-title")).toBeNull();
		expect(
			[...row3.querySelectorAll(".quick-group-opts button")].map(
				(b) => b.textContent,
			),
		).toEqual(["继续", "停止"]);
	});

	it("T5-9 用户消息过长：仅展开/收起（:1021-1034）", async () => {
		render({ messages: [{ id: 1, role: "user", content: "长".repeat(161) }] });
		const row = messages()[0];
		const btns = [...row.querySelectorAll(".msg-actions button")];
		expect(btns.map((b) => b.textContent)).toEqual(["展开全文"]);
		await act(async () => {
			btns[0].click();
		});
		expect(row.querySelector(".msg-bubble").classList.contains("clamped")).toBe(
			false,
		);
		// 短用户消息无按钮
		render({ messages: [{ id: 2, role: "user", content: "短" }] });
		expect(messages()[0].querySelector(".msg-actions")).toBeNull();
	});

	it("T5-10 归档组：summary/角色/120 截断/插入位置（:830-853、:1600-1609）", () => {
		render({
			messages: [
				{ id: "s1", role: "assistant", content: "存档摘要", compressed: 2 },
				{ id: "a1", role: "user", content: "早".repeat(130), compressed: 1 },
				{ id: "a2", role: "assistant", content: "短", compressed: 1 },
				{ id: "m2", role: "user", content: "后续消息" },
			],
		});
		const wrap = host.querySelector("#chat-messages");
		const group = wrap.querySelector("details.msg-archived-group");
		expect(group.querySelector("summary").textContent).toBe(
			"已压缩的 2 条早期对话（点击展开查看）",
		);
		const items = [...group.querySelectorAll(".archived-item")];
		expect(
			items.map((i) => i.querySelector(".archived-role").textContent),
		).toEqual(["我", "AI"]);
		expect(items[0].textContent).toBe(`我${"早".repeat(120)}…`);
		expect(items[1].textContent).toBe("AI短");
		// 插入位置：第一条 compressed===2 之前（flow 首条）
		const order = [...wrap.children].map((el) => el.className);
		expect(order[0]).toBe("msg-archived-group");
		expect(order[1]).toBe("msg assistant msg-archive");
		expect(order[2]).toBe("msg user");
		// 无压缩摘要则插在最前（:1600-1602 的 m === flow[0] 分支）
		render({
			messages: [
				{ id: "a1", role: "user", content: "早期", compressed: 1 },
				{ id: "m1", role: "user", content: "正文" },
			],
		});
		const wrap2 = host.querySelector("#chat-messages");
		expect([...wrap2.children].map((el) => el.className)).toEqual([
			"msg-archived-group",
			"msg user",
		]);
		// 无 archived 不渲染（:1609 条件）
		render({ messages: [{ id: "m1", role: "user", content: "正文" }] });
		expect(host.querySelector(".msg-archived-group")).toBeNull();
	});

	it("T5-11 空 messages：容器空、无异常", () => {
		render({ messages: [] });
		expect(host.querySelector("#chat-messages")).not.toBeNull();
		expect(host.querySelector("#chat-messages").children.length).toBe(0);
		expect(() => render({})).not.toThrow();
		expect(host.querySelector("#chat-messages").children.length).toBe(0);
	});

	it("T5-12 卡位：pending 卡在容器末尾、留痕行挂来源消息正文下方（:1628-1638）", () => {
		render({
			messages: [
				{
					id: "m1",
					role: "assistant",
					content: "正文",
					actionLogs: [
						{
							id: 5,
							name: "append_chapter",
							status: "approved",
							args: { title: "章" },
						},
					],
				},
			],
			pendingActions: [
				{ id: 9, name: "write_story_state", status: "pending", args: {} },
			],
			cardProps: { bookId: "B1" },
		});
		const wrap = host.querySelector("#chat-messages");
		const row = messages()[0];
		const log = row.querySelector(".msg-action-log");
		expect(log.classList.contains("status-approved")).toBe(true);
		expect([...row.children].indexOf(log)).toBeGreaterThan(
			[...row.children].findIndex((el) => el.className === "msg-bubble"),
		);
		const card = wrap.querySelector(".msg-action");
		expect(card.classList.contains("status-pending")).toBe(true);
		expect(wrap.lastElementChild).toBe(card);
		expect(window.BookPage).toBeUndefined();
	});

	it("T5-14 留痕行仅随来源消息渲染：无 actionLogs 不渲染、多条按序（:1638）", () => {
		render({
			messages: [
				{ id: "m1", role: "assistant", content: "无留痕" },
				{
					id: "m2",
					role: "assistant",
					content: "两条留痕",
					actionLogs: [
						{ id: 1, name: "append_chapter", status: "approved", args: {} },
						{ id: 2, name: "write_story_state", status: "expired", args: {} },
					],
				},
			],
		});
		const rows = messages();
		expect(rows[0].querySelector(".msg-action-log")).toBeNull();
		const logs = [...rows[1].querySelectorAll(".msg-action-log")];
		expect(logs.map((l) => l.className)).toEqual([
			"msg-action-log status-approved",
			"msg-action-log status-expired",
		]);
	});

	it("T5-13 scrollBottom：置底语义与空安全（:281-284）", () => {
		const el = { scrollTop: 0, scrollHeight: 1234 };
		scrollBottom(el);
		expect(el.scrollTop).toBe(1234);
		expect(() => scrollBottom(null)).not.toThrow();
	});

	// ---------- S5-7 追加组（T7，Plan §4 T7）----------
	it("T7-1 live 槽渲染在 #chat-messages 尾部（S5-6-X1 ③，≙ 实时气泡 :1148-1157）", () => {
		render({
			messages: [{ id: 1, role: "user", content: "先说的" }],
			pendingActions: [
				{ id: "a-1", name: "append_chapter", args: {}, status: "pending" },
			],
			live: <div className="msg live-bubble">正在流出</div>,
		});
		const wrap = host.querySelector("#chat-messages");
		expect(wrap.lastElementChild.className).toContain("live-bubble");
		expect(wrap.lastElementChild.textContent).toBe("正在流出");
		// 无 live：不渲染多余节点
		render({ messages: [{ id: 1, role: "user", content: "先说的" }] });
		expect(host.querySelector("#chat-messages .live-bubble")).toBeNull();
	});

	it("T7-2 交接行：来源按钮＋引用 details 逐字，普通消息不误伤（:223-275、:1036-1041）", () => {
		const onClick = vi.fn();
		const handoff = `【来自 Agent 讨论·显式交接】来源会话：整体讨论（conv-origin-01）
摘要
来源引用：规划笔记 #n-1 revision 2`;
		render({
			messages: [
				{ id: 1, role: "assistant", content: handoff },
				{ id: 2, role: "assistant", content: "普通消息" },
			],
			onHandoffOrigin: onClick,
		});
		const rows = messages();
		// legacy DOM 序：插入到当前章节的 .msg-actions 在前、交接行 :1036-1041 在后 → 按文案定位
		const btn = [...rows[0].querySelectorAll(".msg-actions button")].find(
			(b) => b.textContent === "查看来源讨论",
		);
		expect(btn.textContent).toBe("查看来源讨论");
		expect(btn.className).toBe("btn btn-small btn-outline");
		const box = rows[0].querySelector("details.msg-handoff-refs");
		expect(box.querySelector("summary").textContent).toBe("来源与引用（1）");
		expect(box.querySelector("pre").textContent).toBe(
			"来源会话：整体讨论（conv-origin-01）\n规划笔记 #n-1 revision 2",
		);
		btn.click();
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onClick.mock.calls[0][0]).toEqual({
			originConversationId: "conv-origin-01",
			originTitle: "整体讨论",
			refs: ["规划笔记 #n-1 revision 2"],
		});
		// 普通消息：零交接入口
		expect(rows[1].querySelector(".msg-handoff-refs")).toBeNull();
		expect(
			[...rows[1].querySelectorAll("button")].some(
				(b) => b.textContent === "查看来源讨论",
			),
		).toBe(false);
	});

	it("T7-3 留痕行位于气泡之后（锚点消息内）＋ 工具块键序号兜底不重键（S5-5-X3 ②）", () => {
		render({
			messages: [
				{
					id: "m1",
					role: "assistant",
					content: "正文",
					tools: [
						{ name: "list_chapters", result: { chapters: [] } },
						{ name: "list_chapters", result: { chapters: [] } },
					],
					actionLogs: [
						{ id: 1, name: "append_chapter", status: "approved", args: {} },
					],
				},
			],
		});
		const row = messages()[0];
		const kids = [...row.children].map((n) => n.className);
		const bubbleIdx = kids.indexOf("msg-bubble");
		const logIdx = kids.indexOf("msg-action-log status-approved");
		expect(bubbleIdx).toBeGreaterThan(-1);
		expect(logIdx).toBeGreaterThan(bubbleIdx);
		expect(row.querySelectorAll(".tool-call").length).toBe(2);
	});
});
