// @vitest-environment jsdom
// S5-9 红测 T6（Plan §4 T6）：frontend/components/AgentLiveRound.jsx —— 实时轮次渲染
// （≙ public/legacy/agent.js :1395-1518 consumeStream 的 DOM 半，逐例头注 legacy 行号锚点）。
// 驱动＝agent-round 的累积器 ops 直接喂组件 applyOp（同一条真实链路）；harness＝jsdom＋React 19
// act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-19 同款）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoundAccumulator } from "../lib/agent-round.js";
import AgentLiveRound from "./AgentLiveRound.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
let ref;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	ref = { current: null };
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

async function render(props) {
	await act(async () => {
		root.render(
			<AgentLiveRound
				ref={ref}
				userText={props && props.userText !== undefined ? props.userText : null}
				typingText={props ? props.typingText : null}
				cardDeps={props?.cardDeps || undefined}
			/>,
		);
	});
}

function apply(acc, name, ...args) {
	act(() => {
		ref.current.applyOp(acc[name](...args));
	});
}

function shell() {
	return container.querySelector(".msg.assistant");
}

function _contentNodes() {
	return [...shell().children].filter((n) => !n.classList.contains("msg-role"));
}

describe("T6 AgentLiveRound（实时轮次）", () => {
	// :1401-1424 —— 思考块插在 shell 首个子节点之后
	it("T6-1 思考块：details.msg-reasoning 在 role 之后；delta 追加；end 后丢弃", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onReasoningStart");
		const details = container.querySelector("details.msg-reasoning");
		expect(details).not.toBeNull();
		expect(shell().children[0].classList.contains("msg-role")).toBe(true);
		expect(shell().children[1]).toBe(details);
		expect(details.querySelector("summary").textContent).toBe("思考过程");
		const body = details.querySelector(".reasoning-body");
		expect(body).not.toBeNull();
		apply(acc, "onReasoningDelta", "先想");
		expect(body.textContent).toBe("先想");
		apply(acc, "onReasoningDelta", "一下");
		expect(body.textContent).toBe("先想一下");
		apply(acc, "onReasoningEnd");
		apply(acc, "onReasoningDelta", "丢弃");
		expect(body.textContent).toBe("先想一下");
	});

	// :1402-1405／:1425-1431 —— 文本段：段内合并、段间新气泡
	it("T6-2 文本：onDelta 追加同一 .msg-bubble；onTextEnd 后新段新气泡", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onDelta", "甲");
		apply(acc, "onDelta", "乙");
		expect(container.querySelectorAll(".msg-bubble").length).toBe(1);
		expect(container.querySelector(".msg-bubble").textContent).toBe("甲乙");
		apply(acc, "onTextEnd");
		apply(acc, "onDelta", "丙");
		expect(container.querySelectorAll(".msg-bubble").length).toBe(2);
		expect(
			[...container.querySelectorAll(".msg-bubble")].map((b) => b.textContent),
		).toEqual(["甲乙", "丙"]);
	});

	// :1432-1458 —— 工具块结构
	it("T6-3 工具块：tool-call／name／status 执行中…／入参 pre（{} →（无））／结果 pre 初始 hidden", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onToolCall", {
			toolCallId: "t1",
			toolName: "list_chapters",
			input: { bookId: 7 },
		});
		apply(acc, "onToolCall", {
			toolCallId: "t2",
			toolName: "read",
			input: {},
		});
		const blocks = container.querySelectorAll("details.tool-call");
		expect(blocks.length).toBe(2);
		const first = blocks[0];
		// 阶段 4c：助手页对用户隐藏内部工具名，经 agentToolLabel 映射为中文标签
		expect(first.querySelector(".tool-call-name").textContent).toBe(
			"调用工具 · 列出章节",
		);
		expect(first.querySelector(".tool-call-status").textContent).toBe(
			"执行中…",
		);
		expect(first.querySelector("pre.tool-call-io").textContent).toBe(
			'入参：{\n  "bookId": 7\n}',
		);
		const resultPre = first.querySelector("pre.tool-call-result");
		expect(resultPre.classList.contains("hidden")).toBe(true);
		expect(resultPre.textContent).toBe("");
		expect(blocks[1].querySelector("pre.tool-call-io").textContent).toBe(
			"入参：（无）",
		);
	});

	// :1466-1484 —— 工具输出两分支＋确认卡挂槽
	it("T6-4 工具输出：确认信封→待作者确认＋卡；普通→完成（done 类）/未执行或失败；结果 2000 截断", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onToolCall", {
			toolCallId: "c1",
			toolName: "update_chapter",
			input: { chapterId: 3 },
		});
		apply(acc, "onToolCall", { toolCallId: "c2", toolName: "read", input: {} });
		const conf = { id: "a-9", summary: "改标题" };
		apply(acc, "onToolOutput", {
			toolCallId: "c1",
			output: {
				ok: true,
				data: { status: "confirmation_required", confirmation: conf },
			},
		});
		const blocks = () => container.querySelectorAll("details.tool-call");
		expect(blocks()[0].querySelector(".tool-call-status").textContent).toBe(
			"待作者确认",
		);
		const card = shell().querySelector(".msg-action");
		expect(card).not.toBeNull();
		expect(card.getAttribute("data-action-status")).toBe("pending");
		expect(card.querySelector(".action-head").textContent).toBe(
			"AI 请求写操作：改标题",
		);
		// 普通结果
		apply(acc, "onToolOutput", { toolCallId: "c2", output: { ok: true } });
		expect(blocks()[1].querySelector(".tool-call-status").textContent).toBe(
			"完成",
		);
		expect(
			blocks()[1].querySelector(".tool-call-status").classList.contains("done"),
		).toBe(true);
		const resultPre = blocks()[1].querySelector("pre.tool-call-result");
		expect(resultPre.classList.contains("hidden")).toBe(false);
		expect(resultPre.textContent).toBe('结果：{\n  "ok": true\n}');
		// 失败分支
		apply(acc, "onToolCall", { toolCallId: "c3", toolName: "read", input: {} });
		apply(acc, "onToolOutput", {
			toolCallId: "c3",
			output: { ok: false, error: { code: "X" } },
		});
		const third = blocks()[2];
		expect(third.querySelector(".tool-call-status").textContent).toBe(
			"未执行或失败",
		);
		expect(
			third.querySelector(".tool-call-status").classList.contains("done"),
		).toBe(false);
		// 长结果截断
		apply(acc, "onToolCall", { toolCallId: "c4", toolName: "read", input: {} });
		apply(acc, "onToolOutput", {
			toolCallId: "c4",
			output: "x".repeat(3000),
		});
		const longPre = blocks()[3].querySelector("pre.tool-call-result");
		expect(longPre.textContent.startsWith("结果：")).toBe(true);
		expect(longPre.textContent.endsWith("\n…（结果过长，已截断）")).toBe(true);
		// :1480-1481 截断的是 JSON 串本身（2000），「结果：」前缀在截断后拼上
		expect(longPre.textContent.length).toBe(
			"结果：".length + 2000 + "\n…（结果过长，已截断）".length,
		);
	});

	// :1499-1508 —— 工具错误行
	it("T6-5 onToolError → div.msg-tool-error 文案逐字（含 [CODE] 变体）", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onToolError", {
			toolCallId: "e1",
			toolName: "delete_event",
			code: "TOOL_NOT_ALLOWED",
			message: "只读讨论不能执行写操作",
		});
		apply(acc, "onToolError", { toolCallId: "e2", toolName: "read" });
		const rows = [...container.querySelectorAll(".msg-tool-error")].map(
			(n) => n.textContent,
		);
		expect(rows).toEqual([
			"工具未执行：[TOOL_NOT_ALLOWED] delete_event — 只读讨论不能执行写操作",
			"工具未执行：read",
		]);
	});

	// :1486-1492 —— onDone 全文替换
	it("T6-6 onDone 全文替换：气泡清后重写为新文本（恰 1 个）", async () => {
		await render({});
		const acc = createRoundAccumulator();
		apply(acc, "onDelta", "流式片段一");
		apply(acc, "onTextEnd");
		apply(acc, "onDelta", "片段二");
		expect(container.querySelectorAll(".msg-bubble").length).toBe(2);
		apply(acc, "onDone", { text: "服务端定稿全文" });
		const bubbles = [...container.querySelectorAll(".msg-bubble")];
		expect(bubbles.length).toBe(1);
		expect(bubbles[0].textContent).toBe("服务端定稿全文");
		// 相等 → no-op
		apply(acc, "onDone", { text: "服务端定稿全文" });
		expect(container.querySelectorAll(".msg-bubble").length).toBe(1);
	});

	// :1815-1819／:1865／:1915-1918 —— typing 与停止气泡
	it("T6-7 typing 节点（思考/继续）＋（已停止生成）气泡＋用户消息壳", async () => {
		await render({
			typingText: "助手正在思考…",
			userText: "整本书埋了哪些伏笔？",
		});
		const user = container.querySelector(".msg.user");
		expect(user).not.toBeNull();
		expect(user.querySelector(".msg-role").textContent).toContain("我");
		expect(user.querySelector(".msg-bubble").textContent).toBe(
			"整本书埋了哪些伏笔？",
		);
		const typing = shell().querySelector(".typing");
		expect(typing).not.toBeNull();
		expect(typing.textContent).toBe("助手正在思考…");
		expect(shell().children[1]).toBe(typing);
		// typing 由 props 驱动：流开始前由调用方清掉（等价 legacy typing.remove()）
		await act(async () => {
			root.render(
				<AgentLiveRound
					ref={ref}
					userText="整本书埋了哪些伏笔？"
					typingText={null}
				/>,
			);
		});
		expect(shell().querySelector(".typing")).toBeNull();
		const acc = createRoundAccumulator();
		apply(acc, "onDelta", "半个回答");
		act(() => {
			ref.current.applyOp({ kind: "bubble", text: "（已停止生成）" });
		});
		// 用户壳同样用 .msg-bubble（:1912 addBubble(userShell)），助手气泡须在助手壳内取
		const bubbles = [...shell().querySelectorAll(".msg-bubble")].map(
			(b) => b.textContent,
		);
		expect(bubbles).toEqual(["半个回答", "（已停止生成）"]);
		// role 行含来源标签（等值 addMsgShell :1350-1367）
		expect(
			shell().querySelector(".msg-role .msg-source.msg-source-agent"),
		).not.toBeNull();
		// 未给 userText 时无用户壳（续跑路径）
		await render({ typingText: "助手正在继续…" });
		expect(container.querySelector(".msg.user")).toBeNull();
		expect(shell().querySelector(".typing").textContent).toBe("助手正在继续…");
	});
});
