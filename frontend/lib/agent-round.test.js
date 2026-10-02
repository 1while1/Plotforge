// S5-9 红测 T3（Plan §4 T3）：frontend/lib/agent-round.js —— 轮次累积器（SSE 事件 → 簿记/ops）、
// 请求体组装、legacy 导入条模型、统一任务卡取参。语义唯一事实源＝public/legacy/agent.js
// :1393-1518／:1882-2000／:2002-2035／:1214-1272（逐例头注 legacy 行号锚点）；
// 零 DOM、零 fetch；harness＝vitest node 环境。
import { describe, expect, it } from "vitest";
import {
	agentToolErrorMessage,
	buildLegacyImportBody,
	buildNewConversationBody,
	buildResumePayload,
	buildSendPayload,
	createRoundAccumulator,
	isRunCardEmpty,
	legacyBarModel,
	pendingActionSummaries,
	runCardInput,
	TOOL_RESULT_MAX,
	toolInputText,
	truncateToolResult,
} from "./agent-round.js";

const GLOBAL_SCOPE = { kind: "global", bookId: null };
const BOOK_SCOPE = { kind: "book", bookId: 7 };
const BOOKS = [{ id: 7, title: "雾港编年史" }];

const CONF = {
	id: "a-9",
	summary: "改标题",
	expires_at: "2026-09-28 12:00:00",
};

describe("T3 agent-round（轮次累积 / 请求体 / 任务卡取参）", () => {
	// :1402-1431 —— 文本段
	it("T3-1 onDelta 累加 fullText＋当前文本段；onTextEnd 关段；result().text＝trim 的 out.text||fullText", () => {
		const acc = createRoundAccumulator();
		expect(acc.onDelta("甲")).toEqual({ kind: "text-append", delta: "甲" });
		acc.onDelta("乙");
		expect(acc.fullText).toBe("甲乙");
		expect(acc.textSegments).toEqual(["甲乙"]);
		acc.onTextEnd();
		acc.onDelta("丙");
		expect(acc.fullText).toBe("甲乙丙");
		expect(acc.textSegments).toEqual(["甲乙", "丙"]);
		expect(acc.result({}).text).toBe("甲乙丙");
		expect(acc.result({ text: "  服务端定稿  " }).text).toBe("服务端定稿");
		expect(acc.result({ toolErrors: [{ code: "X" }] }).toolErrors).toEqual([
			{ code: "X" },
		]);
		expect(acc.result({ tools: [{ name: "t" }] }).tools).toEqual([
			{ name: "t" },
		]);
	});

	// :1401-1424 —— 思考块
	it("T3-2 思考块：onReasoningStart→delta 累加→end 清引用（后续 delta 丢弃）", () => {
		const acc = createRoundAccumulator();
		expect(acc.onReasoningStart()).toEqual({ kind: "reasoning-open" });
		expect(acc.onReasoningDelta("想")).toEqual({
			kind: "reasoning-append",
			delta: "想",
		});
		acc.onReasoningDelta("一下");
		expect(acc.reasoningText).toBe("想一下");
		expect(acc.onReasoningEnd()).toEqual({ kind: "reasoning-end" });
		expect(acc.onReasoningDelta("丢弃")).toEqual({ kind: "noop" });
		expect(acc.reasoningText).toBe("想一下");
	});

	// :1432-1465 —— 工具块簿记与回填（最后一个同 name 且 result 为 null）
	it("T3-3 onToolCall 入 roundTools；onToolOutput 回填最后一个同 name 未回填项", () => {
		const acc = createRoundAccumulator();
		acc.onToolCall({
			toolCallId: "t2",
			toolName: "list_chapters",
			input: { a: 1 },
		});
		acc.onToolCall({
			toolCallId: "t1",
			toolName: "list_chapters",
			input: { a: 2 },
		});
		expect(acc.roundTools).toEqual([
			{ name: "list_chapters", args: { a: 1 }, result: null },
			{ name: "list_chapters", args: { a: 2 }, result: null },
		]);
		const op = acc.onToolOutput({
			toolCallId: "t2",
			output: { ok: true, n: 1 },
		});
		expect(op).toMatchObject({ kind: "tool-output", toolCallId: "t2" });
		// legacy :1463-1465 回填口径＝「最后一个同 name 且 result 为 null」的项（不按 toolCallId 定位）
		expect(acc.roundTools[1].result).toEqual({ ok: true, n: 1 });
		expect(acc.roundTools[0].result).toBe(null);
		acc.onToolOutput({ toolCallId: "t1", output: "第二条" });
		expect(acc.roundTools[0].result).toBe("第二条");
	});

	// :1461-1462 —— 无匹配 toolCallId → 忽略（不改任何状态）
	it("T3-4 onToolOutput 无匹配 toolCallId → noop（不改状态）", () => {
		const acc = createRoundAccumulator();
		acc.onToolCall({ toolCallId: "t1", toolName: "t", input: {} });
		const before = JSON.stringify(acc.roundTools);
		expect(
			acc.onToolOutput({ toolCallId: "missing", output: { ok: true } }),
		).toEqual({ kind: "noop" });
		expect(JSON.stringify(acc.roundTools)).toBe(before);
	});

	// :1466-1484 —— 确认信封分支 / 普通结果分支（2000 截断）
	it("T3-5 确认信封→待作者确认＋pending 条目快照；普通结果→完成/未执行或失败＋2000 截断", () => {
		const acc = createRoundAccumulator();
		acc.onToolCall({
			toolCallId: "c1",
			toolName: "update_chapter",
			input: { x: 1 },
		});
		const confOp = acc.onToolOutput(
			{
				toolCallId: "c1",
				output: {
					ok: true,
					data: { status: "confirmation_required", confirmation: CONF },
				},
			},
			{ conversationId: "c-conv" },
		);
		expect(confOp).toMatchObject({
			kind: "tool-output",
			statusText: "待作者确认",
			done: false,
			confirm: CONF,
		});
		expect(confOp.pendingEntry).toEqual({
			id: "a-9",
			conf: CONF,
			toolName: "update_chapter",
			input: { x: 1 },
			expiresAt: "2026-09-28 12:00:00",
			conversationId: "c-conv",
		});
		expect(acc.pendingEntries).toEqual([confOp.pendingEntry]);

		acc.onToolCall({ toolCallId: "c2", toolName: "read", input: {} });
		const failOp = acc.onToolOutput({
			toolCallId: "c2",
			output: { ok: false },
		});
		expect(failOp).toMatchObject({ statusText: "未执行或失败", done: false });
		// legacy :1478-1482：失败分支同样写结果 pre（只有 done 类不加）
		expect(failOp.resultText).toBe('{\n  "ok": false\n}');

		acc.onToolCall({ toolCallId: "c3", toolName: "read", input: {} });
		const longText = `"${"x".repeat(3000)}"`;
		const okOp = acc.onToolOutput({ toolCallId: "c3", output: longText });
		expect(okOp).toMatchObject({ statusText: "完成", done: true });
		expect(okOp.resultText.length).toBe(
			TOOL_RESULT_MAX + "\n…（结果过长，已截断）".length,
		);
		expect(okOp.resultText.endsWith("\n…（结果过长，已截断）")).toBe(true);
		expect(
			acc.onToolOutput({ toolCallId: "c3", output: longText }).resultText
				.length,
		).toBeLessThan(TOOL_RESULT_MAX + 20);
	});

	// :1486-1492 —— onDone 全文替换
	it("T3-6 onDone：result.text !== fullText → text-replace；相等 → noop", () => {
		const acc = createRoundAccumulator();
		acc.onDelta("流式");
		expect(acc.onDone({ text: "流式" })).toEqual({ kind: "noop" });
		expect(acc.onDone({ text: "服务端定稿全文" })).toEqual({
			kind: "text-replace",
			text: "服务端定稿全文",
		});
		expect(acc.fullText).toBe("服务端定稿全文");
		expect(acc.onDone({ text: "服务端定稿全文" })).toEqual({ kind: "noop" });
	});

	// :1499-1508 —— 工具错误文案
	it("T3-7 onToolError：入 toolErrors；文案＝工具未执行：＋[码] ＋名＋ — 消息", () => {
		const acc = createRoundAccumulator();
		const info = {
			toolCallId: "e1",
			toolName: "delete_event",
			code: "TOOL_NOT_ALLOWED",
			message: "只读讨论不能执行写操作",
		};
		const op = acc.onToolError(info);
		expect(op).toEqual({
			kind: "tool-error",
			text: "工具未执行：[TOOL_NOT_ALLOWED] delete_event — 只读讨论不能执行写操作",
			info,
		});
		expect(acc.toolErrors).toEqual([info]);
		expect(agentToolErrorMessage({ toolName: "t" })).toBe("工具未执行：t");
		expect(agentToolErrorMessage({ code: "E", toolName: "t" })).toBe(
			"工具未执行：[E] t",
		);
		expect(agentToolErrorMessage({ toolName: "t", message: "原因" })).toBe(
			"工具未执行：t — 原因",
		);
	});

	// :1924-1933 —— 发送体
	it("T3-8 buildSendPayload：恒带会话/内容/请求号；mode/book_id 仅 book+execute；chapterId 仅 book", () => {
		const base = {
			conversationId: "c-1",
			content: "问一句",
			requestId: "agent_x",
		};
		expect(
			buildSendPayload({
				...base,
				scope: GLOBAL_SCOPE,
				mode: "execute",
				boundaryChapterId: 12,
			}),
		).toEqual({
			conversation_id: "c-1",
			content: "问一句",
			request_id: "agent_x",
		});
		expect(
			buildSendPayload({ ...base, scope: BOOK_SCOPE, mode: "discuss" }),
		).toEqual({
			conversation_id: "c-1",
			content: "问一句",
			request_id: "agent_x",
		});
		expect(
			buildSendPayload({
				...base,
				scope: BOOK_SCOPE,
				mode: "execute",
				boundaryChapterId: 12,
			}),
		).toEqual({
			conversation_id: "c-1",
			content: "问一句",
			request_id: "agent_x",
			mode: "execute",
			book_id: 7,
			chapterId: 12,
		});
		expect(
			buildSendPayload({
				...base,
				scope: BOOK_SCOPE,
				mode: "discuss",
				boundaryChapterId: null,
			}).chapterId,
		).toBe(undefined);
	});

	// :1824 —— 续跑体：conversation_id 有值才带
	it("T3-9 buildResumePayload：conversation_id 缺失整键省略（逐字 || undefined）", () => {
		expect(
			buildResumePayload({ conversationId: "c-1", requestId: "r1" }),
		).toEqual({ conversation_id: "c-1", request_id: "r1" });
		expect(buildResumePayload({ conversationId: "", requestId: "r1" })).toEqual(
			{
				request_id: "r1",
			},
		);
		expect(
			Object.keys(
				buildResumePayload({ conversationId: null, requestId: "r1" }),
			).sort(),
		).toEqual(["request_id"]);
	});

	// :600-601 —— 新会话体
	it("T3-10 buildNewConversationBody：title 逐字（书 →「<书名> · 讨论」）＋book 才带 bookId", () => {
		expect(buildNewConversationBody(BOOK_SCOPE, BOOKS)).toEqual({
			kind: "agent",
			scope: "book",
			title: "雾港编年史 · 讨论",
			bookId: 7,
		});
		expect(buildNewConversationBody(GLOBAL_SCOPE, BOOKS)).toEqual({
			kind: "agent",
			scope: "global",
			title: "全局资源讨论",
		});
		expect(buildNewConversationBody(BOOK_SCOPE, []).title).toBe(
			"书籍 #7 · 讨论",
		);
	});

	// :1240-1246 —— 导入体过滤
	it("T3-11 buildLegacyImportBody：role 过滤＋content 字符串且 trim 非空", () => {
		expect(
			buildLegacyImportBody([
				{ role: "user", content: "甲" },
				{ role: "assistant", content: "  " },
				{ role: "system", content: "忽略" },
				{ role: "assistant", content: 12 },
				{ role: "assistant", content: "乙", extra: 1 },
				null,
			]),
		).toEqual({
			scope: "global",
			title: "导入的助手历史",
			messages: [
				{ role: "user", content: "甲" },
				{ role: "assistant", content: "乙" },
			],
		});
		expect(buildLegacyImportBody(null).messages).toEqual([]);
	});

	// :1215-1232 —— 导入条两态
	it("T3-12 legacyBarModel：空历史隐藏；未导入带头条截断；已导入换文案＋按钮三态", () => {
		expect(legacyBarModel([], false).visible).toBe(false);
		const notImported = legacyBarModel(
			[{ content: "这是一条超过二十四个字的旧助手历史首条内容用于截断断言" }],
			false,
		);
		expect(notImported.visible).toBe(true);
		expect(notImported.importHidden).toBe(false);
		expect(notImported.cleanHidden).toBe(true);
		expect(notImported.text).toContain("检测到浏览器本地旧助手历史 1 条");
		expect(notImported.text).toContain(
			"（首条：「这是一条超过二十四个字的旧助手历史首条内容用于截…」）",
		);
		expect(notImported.text).toContain("不会带入任何工具证据");
		const imported = legacyBarModel([{ content: "甲" }], true);
		expect(imported.visible).toBe(true);
		expect(imported.importHidden).toBe(true);
		expect(imported.cleanHidden).toBe(false);
		expect(imported.text).toContain("已导入服务端");
		expect(imported.text).toContain("本地旧助手历史 1 条");
	});

	// :2009-2034 —— 任务卡取参
	it("T3-13 runCardInput／pendingActionSummaries／isRunCardEmpty：形状与空判定", () => {
		const summaries = pendingActionSummaries([
			{ id: "a", toolName: "update_chapter", conversationId: "c1" },
			{ id: "b", toolName: "", conversationId: "" },
		]);
		expect(summaries).toEqual([
			{
				id: "a",
				conversationId: "c1",
				summary: "update_chapter（等你在会话里确认）",
			},
			{ id: "b", conversationId: null, summary: "写操作（等你在会话里确认）" },
		]);
		expect(pendingActionSummaries(null)).toEqual([]);
		const input = runCardInput({
			run: { id: "r1" },
			conversationId: null,
			tools: null,
			toolErrors: null,
			actions: summaries,
		});
		expect(input).toEqual({
			run: { id: "r1" },
			conversationId: null,
			tools: [],
			toolErrors: [],
			actions: summaries,
		});
		expect(
			isRunCardEmpty({
				badge: null,
				pendingActions: [],
				tools: [],
				toolErrors: [],
			}),
		).toBe(true);
		expect(
			isRunCardEmpty({
				badge: { kind: "finished" },
				pendingActions: [],
				tools: [],
				toolErrors: [],
			}),
		).toBe(false);
		expect(
			isRunCardEmpty({
				badge: null,
				pendingActions: [{ id: "a" }],
				tools: [],
				toolErrors: [],
			}),
		).toBe(false);
		expect(
			isRunCardEmpty({
				badge: null,
				pendingActions: [],
				tools: [{ name: "t" }],
				toolErrors: [],
			}),
		).toBe(false);
		expect(
			isRunCardEmpty({
				badge: null,
				pendingActions: [],
				tools: [],
				toolErrors: [{ code: "X" }],
			}),
		).toBe(false);
	});

	// :1444-1448／:1478-1480 —— 文本助手
	it("T3-14 toolInputText：'{}'→（无）；truncateToolResult 2000 边界", () => {
		expect(toolInputText({})).toBe("入参：（无）");
		expect(toolInputText({ a: 1 })).toBe('入参：{\n  "a": 1\n}');
		const cyc = {};
		cyc.self = cyc;
		expect(() => toolInputText(cyc)).not.toThrow();
		expect(truncateToolResult("x".repeat(TOOL_RESULT_MAX))).toBe(
			"x".repeat(TOOL_RESULT_MAX),
		);
		expect(truncateToolResult("x".repeat(TOOL_RESULT_MAX + 1))).toBe(
			`${"x".repeat(TOOL_RESULT_MAX)}\n…（结果过长，已截断）`,
		);
	});
});
