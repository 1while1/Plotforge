// @vitest-environment jsdom
// S5-8 红测 T6（Plan §4 T6）：frontend/components/AgentMessageList.jsx —— 服务端历史纯渲染。
// 语义唯一事实源＝public/legacy/agent.js :658-687（renderServerMessage 渲染半）＋:1349-1374
// （消息原语）＋:1344-1347（scrollBottom）；逐例头注行号锚点。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentMessageList, {
	scrollMessagesToBottom,
} from "./AgentMessageList.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SYSTEM_SUFFIX = " · 系统事件";

let container;
let root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function render(props) {
	const full = {
		items: [],
		picks: [],
		onTogglePick: vi.fn(),
		pendingSlot: null,
		liveSlot: null,
		...props,
	};
	await act(async () => {
		root.render(<AgentMessageList {...full} />);
	});
	return full;
}

describe("T6 AgentMessageList（服务端历史纯渲染）", () => {
	it("T6-1 普通消息（:666-667／:1350-1374）：根 msg user|assistant、角色行、来源标签、气泡原样", async () => {
		await render({
			items: [
				{ id: 1, role: "user", content: "<b>不转义</b>", tools: [] },
				{ id: 2, role: "assistant", content: "答" },
			],
		});
		const msgs = container.querySelectorAll("#agent-messages > .msg");
		expect(msgs.length).toBe(2);
		expect(msgs[0].className).toBe("msg user");
		expect(msgs[1].className).toBe("msg assistant");
		const role0 = msgs[0].querySelector(".msg-role");
		expect(role0.childNodes[0].textContent).toBe("我");
		const src = role0.querySelector("span.msg-source.msg-source-agent");
		expect(src).not.toBeNull();
		expect(src.textContent).toBe("助手");
		expect(msgs[1].querySelector(".msg-role").textContent).toBe("助手助手");
		const bubble = msgs[0].querySelector(".msg-bubble");
		expect(bubble.textContent).toBe("<b>不转义</b>");
		expect(bubble.querySelector("b")).toBeNull();
	});

	it("T6-2 系统事件（:659-665）：assistant 壳＋角色行尾追加 ' · 系统事件' 文本节点＋气泡正文", async () => {
		await render({
			items: [{ id: 9, source: "system", role: "system", content: "已压缩" }],
		});
		const msg = container.querySelector("#agent-messages > .msg");
		expect(msg.className).toBe("msg assistant");
		const role = msg.querySelector(".msg-role");
		expect([...role.childNodes].map((n) => n.textContent)).toEqual([
			"助手",
			"助手",
			SYSTEM_SUFFIX,
		]);
		expect(role.lastChild.nodeType).toBe(3);
		expect(msg.querySelector(".msg-bubble").textContent).toBe("已压缩");
	});

	it("T6-3 工具块（:670-686）：details.tool-call＋summary 逐字；result 真值才有 pre（800 截断）", async () => {
		await render({
			items: [
				{
					id: 3,
					role: "assistant",
					content: "工具",
					tools: [
						{ name: "list_resources", status: "ok", result: "r".repeat(801) },
						{ name: "grep_chapters", status: "failed" },
						{ name: "", status: "", result: "" },
					],
				},
			],
		});
		const blocks = container.querySelectorAll("#agent-messages .tool-call");
		expect(blocks.length).toBe(3);
		expect(blocks[0].tagName).toBe("DETAILS");
		// 阶段 4c：助手页对用户隐藏内部工具名，经 agentToolLabel 映射为中文标签
		expect(blocks[0].querySelector("summary").textContent).toBe(
			"调用工具 · 列出受控资源（ok）",
		);
		const pre = blocks[0].querySelector("pre.tool-call-io");
		expect(pre).not.toBeNull();
		expect(pre.textContent).toBe(`${"r".repeat(800)}…`);
		expect(blocks[0].querySelectorAll("pre").length).toBe(1);
		expect(blocks[1].querySelector("summary").textContent).toBe(
			"调用工具 · 关键词查全文（failed）",
		);
		expect(blocks[1].querySelector("pre")).toBeNull();
		// 空工具名回落「未知操作」（agentToolLabel 与 toolLabel 同语义）
		expect(blocks[2].querySelector("summary").textContent).toBe(
			"调用工具 · 未知操作（）",
		);
		expect(blocks[2].querySelector("pre")).toBeNull();
	});

	it("T6-4 勾选框（:729-740）：label.agent-pick-toggle＋input[data-message-id]＋'选入结论'；勾选/取消各一次回调；无 id 不渲染", async () => {
		const props = await render({
			items: [
				{ id: 5, role: "user", content: "甲" },
				{ role: "assistant", content: "无 id" },
			],
		});
		const labels = container.querySelectorAll(
			"#agent-messages label.agent-pick-toggle",
		);
		expect(labels.length).toBe(1);
		const box = labels[0].querySelector('input[type="checkbox"]');
		expect(box.dataset.messageId).toBe("5");
		expect(labels[0].textContent).toBe("选入结论");
		expect(box.checked).toBe(false);
		await act(async () => box.click());
		expect(props.onTogglePick).toHaveBeenCalledTimes(1);
		expect(props.onTogglePick.mock.calls[0][0].id).toBe(5);
		expect(props.onTogglePick.mock.calls[0][1]).toBe(true);
		// 受控：picks 未变 → DOM 复选框被 React 复位（组件不自行改状态）
		expect(box.checked).toBe(false);
	});

	it("T6-5 picks 受控：含该 id→checked；不含→不勾；取消勾选回调 false", async () => {
		const props = await render({
			items: [
				{ id: 5, role: "user", content: "甲" },
				{ id: 6, role: "assistant", content: "乙" },
			],
			picks: [5],
		});
		const boxes = container.querySelectorAll(
			"#agent-messages input[data-message-id]",
		);
		expect(boxes[0].checked).toBe(true);
		expect(boxes[1].checked).toBe(false);
		await act(async () => boxes[0].click());
		expect(props.onTogglePick).toHaveBeenCalledWith(
			expect.objectContaining({ id: 5 }),
			false,
		);
	});

	it("T6-6 槽位顺序与滚动助手（:1344-1347）：messages→pendingSlot→liveSlot；scrollMessagesToBottom 对容器生效、缺失静默", async () => {
		const pendingSlot = <div id="pending-slot" />;
		const liveSlot = <div id="live-slot" />;
		await render({
			items: [{ id: 1, role: "user", content: "甲" }],
			pendingSlot,
			liveSlot,
		});
		const wrap = container.querySelector("#agent-messages");
		expect(wrap.className).toBe("chat-messages");
		expect([...wrap.children].map((el) => el.id || el.className)).toEqual([
			"msg user",
			"pending-slot",
			"live-slot",
		]);
		Object.defineProperty(wrap, "scrollHeight", {
			configurable: true,
			value: 432,
		});
		wrap.scrollTop = 0;
		scrollMessagesToBottom();
		expect(wrap.scrollTop).toBe(432);
		// 容器缺失（换 id 模拟，避免把 React 树节点摘除导致 unmount 报错）：静默不抛
		wrap.id = "not-agent-messages";
		expect(() => scrollMessagesToBottom()).not.toThrow();
		wrap.id = "agent-messages";
	});

	it("T6-7 空态（:627／:642 清空语义）：无 items 无 slot → 容器空、不渲染占位文案", async () => {
		await render({});
		const wrap = container.querySelector("#agent-messages");
		expect(wrap).not.toBeNull();
		expect(wrap.children.length).toBe(0);
		expect(wrap.textContent).toBe("");
	});
});
