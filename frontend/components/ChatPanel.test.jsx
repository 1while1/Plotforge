// @vitest-environment jsdom
// S5-5 红测（Plan §4 T6）：ChatPanel 聊天页骨架。DOM 契约唯一事实源＝frontend/index.html:136-168
// （id/class/文案逐字；本文件不复制 legacy 逻辑，只钉静态壳与槽位/回调面）。
// 槽位锚点＝legacy :1438-1451（横幅宿主与 #chat-messages 平级、插在 #chat-form 之前）；
// ctx 仪表文案/占比锚点＝:672-705；composer 三态文案锚点＝bindChatEvents :1855-1857/:1866-1878。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-17 同款）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WRITE_PLACEHOLDER = "和 AI 聊聊剧情，或让它续写正文…（Ctrl+Enter 发送）";
const CONSULT_PLACEHOLDER = "向参谋提问：剧情走向、人物行为、大纲建议…";

let host;
let root;

function render(props) {
	act(() => {
		root.render(<ChatPanel {...(props || {})} />);
	});
}

function panel() {
	return host.querySelector("section.panel.panel-chat");
}

function setValue(el, value) {
	const proto =
		el.tagName === "SELECT"
			? window.HTMLSelectElement.prototype
			: window.HTMLTextAreaElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(
		new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
	);
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
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
});

describe("T6 ChatPanel（index.html:136-168 DOM 契约＋槽位＋回调）", () => {
	it("T6-1 区域与 DOM 契约逐字（index.html:136-168）", () => {
		render({
			conversations: [
				{ id: "c1", title: "新写作任务", status: "active" },
				{ id: "c2", title: "旧任务", status: "archived" },
			],
			currentConversationId: "c1",
		});
		expect(panel()).not.toBeNull();
		expect(panel().querySelector(".pane-title").textContent).toBe("写作助手");
		expect(panel().querySelector(".pane-head-btns")).not.toBeNull();
		const sel = host.querySelector("#writing-conversation-select");
		expect(sel.tagName).toBe("SELECT");
		expect(sel.title).toBe(
			"切换写作会话（历史按任务隔离；默认为本书历史对话）",
		);
		expect(
			[...sel.querySelectorAll("option")].map((o) => o.textContent),
		).toEqual(["（默认：历史对话）", "新写作任务", "旧任务（已归档）"]);
		expect([...sel.querySelectorAll("option")].map((o) => o.value)).toEqual([
			"",
			"c1",
			"c2",
		]);
		expect(sel.value).toBe("c1");
		const head = [
			[
				"#btn-new-writing-conv",
				"新会话",
				"开始一个新的写作会话（原会话历史保留）",
			],
			[
				"#btn-open-agent-discuss",
				"另开整体讨论",
				"到 AI 助手为本书新开一个整体讨论专题：只带这本书与当前章（可选人物），默认不带写作对话历史；从助手返回后还原同一会话同一章",
			],
			["#btn-clear-chat", "清空", "清空当前会话的对话记录"],
		];
		for (const [id, text, title] of head) {
			const b = host.querySelector(id);
			expect(b.textContent).toBe(text);
			expect(b.title).toBe(title);
			expect(b.getAttribute("type")).toBe("button");
		}
		const meter = host.querySelector("#ctx-meter");
		expect(meter.title).toBe(
			"上下文窗口占用（真实值来自最近一次对话的 usage；未对话时为估算）",
		);
		expect(host.querySelector("#ctx-fill").className).toBe("ctx-fill");
		expect(host.querySelector("#ctx-text").textContent).toBe("上下文 — / —");
		expect(host.querySelector("#btn-ctx-detail").textContent).toBe("明细");
		expect(host.querySelector("#btn-ctx-detail").title).toBe(
			"查看上下文详细组成（系统提示各节/对话历史/工具结果/输出预留 占比）",
		);
		expect(host.querySelector("#btn-compress").textContent).toBe("压缩");
		expect(host.querySelector("#btn-compress").title).toBe(
			"把较早的对话压缩成存档摘要，释放上下文空间",
		);
		const runCard = host.querySelector("#writing-run-card");
		expect(runCard.className).toBe("run-card hidden");
		expect(runCard.getAttribute("role")).toBe("status");
		const wrap = host.querySelector("#chat-messages");
		expect(wrap.className).toBe("chat-messages");
		const form = host.querySelector("#chat-form");
		expect(form.className).toBe("chat-input chat-composer");
		const ta = host.querySelector("#chat-text");
		expect(ta.tagName).toBe("TEXTAREA");
		expect(ta.getAttribute("rows")).toBe("3");
		expect(ta.placeholder).toBe(WRITE_PLACEHOLDER);
		const consult = host.querySelector("#btn-consult");
		expect(consult.className).toBe("consult-pill");
		expect(consult.textContent).toBe("参谋");
		expect(consult.title).toBe("参谋模式：只出剧情走向/人物行为建议，不写正文");
		const stop = host.querySelector("#btn-chat-stop");
		expect(stop.className).toBe("btn btn-small btn-stop hidden");
		expect(stop.textContent).toBe("停止");
		expect(stop.title).toBe("中止当前生成（已生成的部分会保留）");
		const send = host.querySelector("#btn-send");
		expect(send.textContent).toBe("发送");
		expect(send.getAttribute("type")).toBe("submit");
	});

	it("T6-1b 槽位内容与 ctx 仪表数值（:676-699）", () => {
		render({
			meter: {
				usage: { prompt_tokens: 64000, cache_hit_tokens: 1024 },
				contextWindow: 128000,
			},
			runCard: <span className="task-badge">任务中</span>,
		});
		expect(host.querySelector("#ctx-text").textContent).toBe(
			"上下文 64.0K / 128.0K（50%） · 缓存命中 1.0K",
		);
		expect(host.querySelector("#ctx-fill").style.width).toBe("50%");
		expect(host.querySelector("#ctx-fill").classList.contains("ctx-warn")).toBe(
			false,
		);
		// S5-7：`#writing-run-card` 是叶容器——runCard 传参不再渲染，内容只由
		// window.RunStatus.mountTaskCard(host, model) 命令式写入（Plan §5 纪律 2）
		const card = host.querySelector("#writing-run-card");
		expect(card.className).toBe("run-card hidden");
		expect(card.children.length).toBe(0);
		expect(card.textContent).toBe("");
		render({
			meter: { usage: { prompt_tokens: 100000 }, contextWindow: 128000 },
		});
		expect(host.querySelector("#ctx-fill").style.width).toBe("78%");
		expect(host.querySelector("#ctx-fill").classList.contains("ctx-warn")).toBe(
			true,
		);
	});

	it("T6-2 横幅槽与消息区/输入区平级且位于两者之间（:1438-1451）", () => {
		render({
			banners: <div className="expired-banner">过期提示</div>,
			messages: [{ id: 1, role: "user", content: "内容" }],
		});
		const slot = panel().querySelector(".chat-banners");
		expect(slot).not.toBeNull();
		expect(slot.parentElement).toBe(panel());
		expect(panel().querySelector("#chat-messages").contains(slot)).toBe(false);
		const kids = [...panel().children];
		expect(kids.indexOf(slot)).toBeGreaterThan(
			kids.indexOf(panel().querySelector("#chat-messages")),
		);
		expect(kids.indexOf(slot)).toBeLessThan(
			kids.indexOf(panel().querySelector("#chat-form")),
		);
		expect(panel().querySelector(".expired-banner")).not.toBeNull();
		expect(panel().querySelector("#chat-messages .expired-banner")).toBeNull();
		render({ messages: [{ id: 1, role: "user", content: "内容" }] });
		expect(panel().querySelector(".chat-banners")).toBeNull();
	});

	it("T6-3 props 接线：会话/新会话/讨论/清空/明细/压缩/发送/停止/参谋/输入（冻结契约）", async () => {
		const onConversationChange = vi.fn();
		const onNewConversation = vi.fn();
		const onOpenAgentDiscuss = vi.fn();
		const onClear = vi.fn();
		const onOpenCtxDetail = vi.fn();
		const onCompress = vi.fn();
		const onSend = vi.fn();
		const onStop = vi.fn();
		const onToggleConsult = vi.fn();
		const onChange = vi.fn();
		render({
			conversations: [{ id: "c1", title: "会话一", status: "active" }],
			currentConversationId: "c1",
			composer: {
				value: "草稿",
				onChange,
				onSend,
				onStop,
				streaming: true,
				consult: false,
				onToggleConsult,
			},
			onConversationChange,
			onNewConversation,
			onOpenAgentDiscuss,
			onClear,
			onOpenCtxDetail,
			onCompress,
		});
		expect(host.querySelector("#chat-text").value).toBe("草稿");
		await act(async () => {
			setValue(host.querySelector("#writing-conversation-select"), "c1");
		});
		expect(onConversationChange).toHaveBeenCalledWith("c1");
		await act(async () => {
			setValue(host.querySelector("#chat-text"), "下一句");
		});
		expect(onChange).toHaveBeenCalledWith("下一句");
		for (const [sel, spy] of [
			["#btn-new-writing-conv", onNewConversation],
			["#btn-open-agent-discuss", onOpenAgentDiscuss],
			["#btn-clear-chat", onClear],
			["#btn-ctx-detail", onOpenCtxDetail],
			["#btn-compress", onCompress],
			["#btn-consult", onToggleConsult],
			["#btn-chat-stop", onStop],
		]) {
			await act(async () => {
				host.querySelector(sel).click();
			});
			expect(spy).toHaveBeenCalledTimes(1);
		}
		// 流式中停止按钮可见（legacy bindChatEvents 的 hidden 切换等价面）
		expect(host.querySelector("#btn-chat-stop").className).toBe(
			"btn btn-small btn-stop",
		);
		await act(async () => {
			host
				.querySelector("#chat-form")
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(onSend).toHaveBeenCalledTimes(1);
		// 参谋态：按钮 mode-on、表单 consult-on、placeholder 切参谋文案（:1866-1878）
		render({ composer: { value: "", consult: true } });
		expect(host.querySelector("#btn-consult").className).toBe(
			"consult-pill mode-on",
		);
		expect(host.querySelector("#chat-form").className).toBe(
			"chat-input chat-composer consult-on",
		);
		expect(host.querySelector("#chat-text").placeholder).toBe(
			CONSULT_PLACEHOLDER,
		);
		expect(host.querySelector("#btn-chat-stop").className).toBe(
			"btn btn-small btn-stop hidden",
		);
	});

	it("T6-4 零副作用：渲染不 fetch、不写 window.*、不读 localStorage", () => {
		const getItem = vi.spyOn(Storage.prototype, "getItem");
		const setItem = vi.spyOn(Storage.prototype, "setItem");
		try {
			render({
				bookId: "B1",
				conversations: [{ id: "c1", title: "会话一", status: "active" }],
				currentConversationId: "c1",
				messages: [{ id: 1, role: "assistant", content: "回复" }],
				banners: <div className="expired-banner">x</div>,
				runCard: <span>任务</span>,
			});
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			expect(window.BookPage).toBeUndefined();
			expect(getItem).not.toHaveBeenCalled();
			expect(setItem).not.toHaveBeenCalled();
			expect(host.querySelector(".msg")).not.toBeNull();
		} finally {
			getItem.mockRestore();
			setItem.mockRestore();
		}
	});
});
