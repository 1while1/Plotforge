// S4-10 红测（Plan §4 表，L1~L15）：chat-event-hub 纯逻辑移植对等——镜像 Node 侧
// 冻结测试（test/run-frontend.test.js 8 例＋chat-run-policy.test.js:214-228 1 例＋
// run-status-ui.test.js:738-753 1 例）并补强行为细节。public/legacy/chat-event-hub.js
// 为范式 A 死锚点零 diff 保留（RT-A 实证移走即 6/7 Node 测试文件红），语义权威在
// Node 侧冻结测试；本文件是**新增对等测试**，只验 React 侧逐字移植（IIFE→ES export）
// 后同一组函数行为不变。
// L1 16 导出名册／L2 parseErrorBody／L3 parseResponseError／L4 normalizeError／
// L5 parseToolErrorText／L6 createAbort／L7 isAbortError／L8 readSSE 分帧／
// L9 createTranscript+foldEvent／L10 consumeBookStream／L11 consumeAgentStream／
// L12 isJsonResponse/isActiveStatus/newRequestId／L13 waitRunEvents／
// L14 tool-output-error→onToolError／L15 done 权威快照与 run 透传。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hub from "./chat-event-hub.js";

// SSE 响应构造：把字符串按 chunk（可指定字节切片）喂给 ReadableStream，
// 模拟真实 fetch 流的分帧/半包/粘包（chat-run-policy.test.js:223 同款整片构造的推广）。
function sseResponse(chunks) {
	const enc = new TextEncoder();
	const parts = chunks || [];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts) {
					// part 可以是字符串（编码为 UTF-8 字节）或已切好的 Uint8Array（半行 UTF-8 用例）
					controller.enqueue(
						typeof part === "string" ? enc.encode(part) : part,
					);
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status: status || 200,
		headers: { "Content-Type": "application/json" },
	});
}

const API_NAMES = [
	"consumeAgentStream",
	"consumeBookStream",
	"createAbort",
	"createTranscript",
	"error",
	"foldEvent",
	"isAbortError",
	"isActiveStatus",
	"isJsonResponse",
	"newRequestId",
	"normalizeError",
	"parseErrorBody",
	"parseResponseError",
	"parseToolErrorText",
	"readSSE",
	"waitRunEvents",
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("chat-event-hub 引擎（逐字移植，镜像 Node 侧冻结口径）", () => {
	it("L1 导出面：16 个 API 逐一在册且无多余导出", () => {
		// RT-C 实测清单（legacy :385-402 window.ChatEventHub）sort 后逐字相等
		expect(Object.keys(hub).sort()).toEqual(API_NAMES);
	});

	it("L2 parseErrorBody 三形态：字符串 error／结构化 error／顶层 code+乐观锁字段", () => {
		// 形态一：{error: '文案'}（legacy :25 历史形态）
		expect(hub.parseErrorBody({ error: "别的地方登录了" })).toEqual({
			message: "别的地方登录了",
			code: undefined,
			details: undefined,
		});
		// 形态二：{error: {code, message, details}}（chat 409 CHAT_BUSY / agent confirm）
		expect(
			hub.parseErrorBody({
				error: {
					code: "CHAT_BUSY",
					message: "已有生成在进行",
					details: { runId: "r1" },
				},
			}),
		).toEqual({
			message: "已有生成在进行",
			code: "CHAT_BUSY",
			details: { runId: "r1" },
		});
		// 形态三：code 与附加字段在顶层（chapters 409 CHAPTER_CONFLICT），
		// 乐观锁 current/expected_updated_at 进 details（legacy :41-46）
		expect(
			hub.parseErrorBody({
				error: "章节已被其他窗口修改",
				code: "CHAPTER_CONFLICT",
				current_updated_at: "2026-09-27T00:00:00.000Z",
				expected_updated_at: "2026-09-26T00:00:00.000Z",
			}),
		).toEqual({
			message: "章节已被其他窗口修改",
			code: "CHAPTER_CONFLICT",
			details: {
				current_updated_at: "2026-09-27T00:00:00.000Z",
				expected_updated_at: "2026-09-26T00:00:00.000Z",
			},
		});
		// 非对象 / 无错误字段 → null
		expect(hub.parseErrorBody(null)).toBeNull();
		expect(hub.parseErrorBody("oops")).toBeNull();
		expect(hub.parseErrorBody({ ok: true })).toBeNull();
	});

	it("L3 parseResponseError：非 2xx→带 status/code/details 的 Error；JSON 失败保留兜底文案", async () => {
		const res = jsonResponse(
			{ error: { code: "CHAT_BUSY", message: "已有生成在进行" } },
			409,
		);
		const err = await hub.parseResponseError(res);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("已有生成在进行");
		expect(err.code).toBe("CHAT_BUSY");
		expect(err.status).toBe(409);
		// JSON 解析失败：吞掉并保留兜底文案（legacy :68 空 catch）
		const broken = new Response("not json", { status: 500 });
		const err2 = await hub.parseResponseError(broken, "兜底文案");
		expect(err2.message).toBe("兜底文案");
		expect(err2.status).toBe(500);
		// 无 fallback 时兜底「请求失败 <status>」
		const err3 = await hub.parseResponseError(
			new Response("x", { status: 503 }),
		);
		expect(err3.message).toBe("请求失败 503");
	});

	it("L4 normalizeError 四级兜底：null/string/Error/plain object", () => {
		expect(hub.normalizeError(null)).toEqual({ message: "未知错误" });
		expect(hub.normalizeError("直接文案")).toEqual({ message: "直接文案" });
		const withCode = hub.error("带码错误", "SOME_CODE", { a: 1 }, 400);
		expect(hub.normalizeError(withCode)).toEqual({
			message: "带码错误",
			code: "SOME_CODE",
			details: { a: 1 },
		});
		// plain object：message→errorText→msg→JSON.stringify 四级
		expect(hub.normalizeError({ message: "m1" }).message).toBe("m1");
		expect(hub.normalizeError({ errorText: "m2" }).message).toBe("m2");
		expect(hub.normalizeError({ msg: "m3" }).message).toBe("m3");
		expect(hub.normalizeError({ foo: 1 }).message).toBe(
			JSON.stringify({ foo: 1 }),
		);
	});

	it("L5 parseToolErrorText：拆码/无码只给文本/空文本兜底", () => {
		expect(
			hub.parseToolErrorText("[TOOL_NOT_ALLOWED] 工具不在当前工具面"),
		).toEqual({ code: "TOOL_NOT_ALLOWED", message: "工具不在当前工具面" });
		// 无码只给文本
		expect(hub.parseToolErrorText("工具就是失败了")).toEqual({
			code: null,
			message: "工具就是失败了",
		});
		// 空文本兜底
		expect(hub.parseToolErrorText("")).toEqual({
			code: null,
			message: "工具调用失败",
		});
		expect(hub.parseToolErrorText(null)).toEqual({
			code: null,
			message: "工具调用失败",
		});
		// 码位不足 3 位不匹配（CODE_PREFIX 3~64 位）
		expect(hub.parseToolErrorText("[AB] x")).toEqual({
			code: null,
			message: "[AB] x",
		});
		// 有码无说明 → 说明回落为码本身（m[2] || m[1]）
		expect(hub.parseToolErrorText("[TOOL_ERROR]")).toEqual({
			code: "TOOL_ERROR",
			message: "TOOL_ERROR",
		});
	});

	it("L6 createAbort：stop 幂等（首 reason 不被覆盖）、stopped/reason、signal 透传、无环境降级不炸", () => {
		const a = hub.createAbort();
		expect(a.stopped()).toBe(false);
		expect(a.reason()).toBeNull();
		a.stop("user");
		a.stop("new-request"); // 第二次不得覆盖首 reason
		expect(a.stopped()).toBe(true);
		expect(a.reason()).toBe("user");
		expect(a.signal.aborted).toBe(true);
		// 无参 stop → 'user'
		const b = hub.createAbort();
		b.stop();
		expect(b.reason()).toBe("user");
		// 无 AbortController 环境降级：signal undefined、stop 不炸（legacy :109 守卫）
		vi.stubGlobal("AbortController", undefined);
		const c = hub.createAbort();
		expect(c.signal).toBeUndefined();
		expect(() => c.stop("user")).not.toThrow();
		expect(c.stopped()).toBe(true);
	});

	it("L7 isAbortError：AbortError 名/ABORT_ERR 码/20 码；普通 Error false", () => {
		expect(hub.isAbortError({ name: "AbortError" })).toBe(true);
		expect(hub.isAbortError({ code: "ABORT_ERR" })).toBe(true);
		expect(hub.isAbortError({ code: 20 })).toBe(true);
		expect(hub.isAbortError(new Error("boom"))).toBe(false);
		expect(hub.isAbortError(null)).toBe(false);
	});

	it("L8 readSSE 分帧：半包拼接/粘包按行切/前缀判定/注释与字段行跳过/[DONE]与空 payload 跳过/坏 JSON 静默/半行 UTF-8", async () => {
		// 半包留 buf 下一片拼
		let seen = [];
		await hub.readSSE(sseResponse(['data: {"a":', "1}\n\n"]), (ev) =>
			seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }]);
		// 粘包按行切（单换行切分是双换行切分的子集——空行分隔被跳过）
		seen = [];
		await hub.readSSE(sseResponse(['data: {"a":1}\ndata: {"b":2}\n\n']), (ev) =>
			seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
		// data: 前缀判定（无空格与多空格都吃）
		seen = [];
		await hub.readSSE(
			sseResponse(['data:{"a":1}\n\ndata:   {"b":2}\n\n']),
			(ev) => seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
		// 注释行（: 开头）与 event:/id:/retry: 字段行跳过
		seen = [];
		await hub.readSSE(
			sseResponse([
				': ping\nevent: message\nid: 7\nretry: 3000\ndata: {"a":1}\n\n',
			]),
			(ev) => seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }]);
		// [DONE] 与空 payload 跳过
		seen = [];
		await hub.readSSE(
			sseResponse(['data: [DONE]\n\ndata: \n\ndata: {"a":1}\n\n']),
			(ev) => seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }]);
		// JSON 失败行静默跳过（不抛、不透传）
		seen = [];
		await hub.readSSE(
			sseResponse(['data: {bad json\n\ndata: {"a":1}\n\n']),
			(ev) => seen.push(ev),
		);
		expect(seen).toEqual([{ a: 1 }]);
		// 半行 UTF-8 流式解码：中文按字节切成两个 chunk，decoder stream 模式拼回
		const enc = new TextEncoder();
		const bytes = enc.encode('data: {"t":"中文"}\n\n');
		const mid = 12; // 切在「中」字的字节中间
		seen = [];
		await hub.readSSE(
			sseResponse([bytes.slice(0, mid), bytes.slice(mid)]),
			(ev) => seen.push(ev),
		);
		expect(seen).toEqual([{ t: "中文" }]);
	});

	it("L9 createTranscript 初始态 13 字段；foldEvent 全事件型＋done 权威快照＋未知 type 不动", () => {
		const s = hub.createTranscript();
		expect(Object.keys(s).sort()).toEqual(
			[
				"aborted",
				"actions",
				"autoCompact",
				"content",
				"done",
				"errors",
				"finalContent",
				"reasoning",
				"recovering",
				"retrieval",
				"run",
				"tools",
				"usage",
			].sort(),
		);
		expect(s.content).toBe("");
		expect(s.run).toBeNull();
		expect(s.done).toBe(false);
		// 无 type 早退（含 null/undefined 不动 state）
		expect(hub.foldEvent(s, null)).toBe(s);
		expect(hub.foldEvent(s, {})).toBe(s);
		// 未知 type 不动 state
		const before = JSON.stringify(s);
		hub.foldEvent(s, { type: "zzz-unknown", text: "x" });
		expect(JSON.stringify(s)).toBe(before);
		// 增量事件
		hub.foldEvent(s, {
			type: "retrieval",
			hits: [{ chapter: 3, score: 0.9, text: "旧文" }],
		});
		expect(s.retrieval).toEqual([{ chapter: 3, score: 0.9, text: "旧文" }]);
		hub.foldEvent(s, {
			type: "tool",
			name: "get_outline",
			args: {},
			result: "ok",
		});
		hub.foldEvent(s, {
			type: "action",
			id: "a1",
			name: "save_chapter",
			args: { id: 1 },
		});
		expect(s.tools).toEqual([{ name: "get_outline", args: {}, result: "ok" }]);
		expect(s.actions).toEqual([
			{ id: "a1", name: "save_chapter", args: { id: 1 } },
		]);
		hub.foldEvent(s, { type: "reasoning", text: "想" });
		hub.foldEvent(s, { type: "content", text: "写" });
		hub.foldEvent(s, { type: "recovering" });
		hub.foldEvent(s, { type: "auto_compact", archived: 2 });
		expect(s.reasoning).toBe("想");
		expect(s.content).toBe("写");
		expect(s.recovering).toBe(1);
		expect(s.autoCompact).toBe(2);
		// error 事件归一进 errors
		hub.foldEvent(s, {
			type: "error",
			error: { message: "炸了", code: "BOOM" },
		});
		expect(s.errors).toEqual([{ message: "炸了", code: "BOOM" }]);
		// done 权威快照：finalContent 覆盖增量累计、run/usage 带上、reasoning 覆盖
		hub.foldEvent(s, {
			type: "done",
			content: "全文权威",
			reasoning: "权威思考",
			run: { status: "awaiting_confirmation" },
			usage: { prompt: 1, completion: 2 },
		});
		expect(s.done).toBe(true);
		expect(s.finalContent).toBe("全文权威");
		expect(s.content).toBe("写"); // 增量累计不动，权威值在 finalContent
		expect(s.reasoning).toBe("权威思考");
		expect(s.run.status).toBe("awaiting_confirmation");
		expect(s.usage).toEqual({ prompt: 1, completion: 2 });
		// done 的 reasoning 空串不覆盖（legacy :192 typeof && 非空）
		const s2 = hub.createTranscript();
		hub.foldEvent(s2, { type: "reasoning", text: "增量思考" });
		hub.foldEvent(s2, { type: "done", content: "全文" });
		expect(s2.reasoning).toBe("增量思考");
	});

	it("L10 consumeBookStream：9 类回调派发参数逐项/recovering 至多一次/abort 保留部分输出/无 done 收 onDone(null)/回调抛错隔离", async () => {
		// 9 类回调参数逐项
		const calls = [];
		const handlers = {
			onDelta: (t) => calls.push(["delta", t]),
			onReasoning: (t) => calls.push(["reasoning", t]),
			onTool: (t) => calls.push(["tool", t]),
			onAction: (a) => calls.push(["action", a]),
			onRetrieval: (h) => calls.push(["retrieval", h]),
			onRecovering: () => calls.push(["recovering"]),
			onAutoCompact: (n) => calls.push(["auto_compact", n]),
			onError: (info) => calls.push(["error", info]),
			onDone: (ev, state) => calls.push(["done", ev?.type, state.content]),
			onEvent: (ev) => calls.push(["event", ev.type]),
		};
		const state = await hub.consumeBookStream(
			sseResponse([
				`data: ${JSON.stringify({
					type: "retrieval",
					hits: [{ chapter: 1, score: 0.5, text: "旧" }],
				})}\n\n`,
				`data: ${JSON.stringify({ type: "tool", name: "t", args: { a: 1 }, result: "r" })}\n\n`,
				`data: ${JSON.stringify({ type: "action", id: "x", name: "act", args: {} })}\n\n`,
				`data: ${JSON.stringify({ type: "reasoning", text: "思" })}\n\n`,
				`data: ${JSON.stringify({ type: "content", text: "正" })}\n\n`,
				`data: ${JSON.stringify({ type: "recovering" })}\n\n`,
				`data: ${JSON.stringify({ type: "recovering" })}\n\n`,
				`data: ${JSON.stringify({ type: "auto_compact", archived: 4 })}\n\n`,
				`data: ${JSON.stringify({ type: "error", error: { message: "e", code: "C" } })}\n\n`,
				`data: ${JSON.stringify({ type: "done", content: "全文", run: { id: "r" } })}\n\n`,
			]),
			handlers,
		);
		expect(calls).toEqual([
			["retrieval", [{ chapter: 1, score: 0.5, text: "旧" }]],
			["event", "retrieval"],
			["tool", { name: "t", args: { a: 1 }, result: "r" }],
			["event", "tool"],
			["action", { id: "x", name: "act", args: {} }],
			["event", "action"],
			["reasoning", "思"],
			["event", "reasoning"],
			["delta", "正"],
			["event", "content"],
			["recovering"],
			["event", "recovering"],
			// 第二个 recovering 事件：onRecovering 不再回调（recoveringFired 守卫），onEvent 照常
			["event", "recovering"],
			["auto_compact", 4],
			["event", "auto_compact"],
			["error", { message: "e", code: "C", details: undefined }],
			["event", "error"],
			["done", "done", "正"],
			["event", "done"],
		]);
		expect(state.done).toBe(true);
		expect(state.finalContent).toBe("全文");
		// recovering 至多回调一次（两个 recovering 事件 → state.recovering=2 但回调一次）
		expect(calls.filter((c) => c[0] === "recovering").length).toBe(1);
		expect(state.recovering).toBe(2);

		// abort → aborted=true 且部分输出保留在 content（pi 中止三定律之二）
		// 流先成功吐出第一片，第二次 read 才以 AbortError 结束（pull 模式：
		// start 里 enqueue+error 会丢弃队列，首读即 reject，测不到「部分输出保留」）。
		const enc = new TextEncoder();
		let pulled = false;
		const aborting = new Response(
			new ReadableStream({
				pull(controller) {
					if (!pulled) {
						pulled = true;
						controller.enqueue(
							enc.encode(
								`data: ${JSON.stringify({ type: "content", text: "半句" })}\n\n`,
							),
						);
						return;
					}
					controller.error(
						new DOMException("The operation was aborted.", "AbortError"),
					);
				},
			}),
		);
		const st2 = await hub.consumeBookStream(aborting, {});
		expect(st2.aborted).toBe(true);
		expect(st2.content).toBe("半句");

		// 无 done 的流结束 → onDone(null, state)
		let doneArg = "unset";
		const st3 = await hub.consumeBookStream(
			sseResponse([
				`data: ${JSON.stringify({ type: "content", text: "甲" })}\n\n`,
			]),
			{
				onDone: (ev, s) => {
					doneArg = [ev, s.content];
				},
			},
		);
		expect(doneArg).toEqual([null, "甲"]);
		expect(st3.done).toBe(false);

		// 回调抛错被隔离：console 上报、不打断流解析、不传染其他回调
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const got = [];
		await hub.consumeBookStream(
			sseResponse([
				`data: ${JSON.stringify({ type: "content", text: "一" })}\n\n`,
				`data: ${JSON.stringify({ type: "content", text: "二" })}\n\n`,
				`data: ${JSON.stringify({ type: "done", content: "全" })}\n\n`,
			]),
			{
				onDelta: (t) => {
					got.push(t);
					throw new Error("页面回调炸了");
				},
			},
		);
		expect(got).toEqual(["一", "二"]); // 第二个事件的回调照常到达
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("L11 consumeAgentStream：UI-Stream 归一（reasoning/text/tool 三态/finish 覆盖/toolNames 回填/返回四字段）", async () => {
		const calls = [];
		const handlers = {
			onReasoningStart: (p) => calls.push(["reasoning-start", p]),
			onReasoningDelta: (t) => calls.push(["reasoning-delta", t]),
			onReasoningEnd: (p) => calls.push(["reasoning-end", p]),
			onDelta: (t) => calls.push(["delta", t]),
			onTextEnd: (p) => calls.push(["text-end", p]),
			onToolCall: (c) => calls.push(["tool-call", c]),
			onToolOutput: (o) => calls.push(["tool-output", o]),
			onToolError: (info) => calls.push(["tool-error", info]),
			onError: (info) => calls.push(["error", info]),
			onDone: (d) => calls.push(["done", d]),
			onEvent: (p) => calls.push(["event", p.type]),
		};
		const out = await hub.consumeAgentStream(
			sseResponse([
				`data: ${JSON.stringify({ type: "reasoning-start", id: "r0" })}\n\n`,
				`data: ${JSON.stringify({ type: "reasoning-delta", delta: "想一" })}\n\n`,
				`data: ${JSON.stringify({ type: "reasoning-delta", delta: "想二" })}\n\n`,
				`data: ${JSON.stringify({ type: "reasoning-end", id: "r0" })}\n\n`,
				`data: ${JSON.stringify({ type: "text-delta", delta: "第1章" })}\n\n`,
				`data: ${JSON.stringify({ type: "text-delta", delta: "已写入。" })}\n\n`,
				`data: ${JSON.stringify({ type: "text-end", id: "m0" })}\n\n`,
				`data: ${JSON.stringify({
					type: "tool-input-available",
					toolCallId: "t1",
					toolName: "create_character",
					input: { name: "甲" },
				})}\n\n`,
				`data: ${JSON.stringify({ type: "tool-output-available", toolCallId: "t1", output: { ok: true } })}\n\n`,
				// tool-output-error 不带 toolName：靠 tool-input-available 的 toolNames 回填
				`data: ${JSON.stringify({
					type: "tool-output-error",
					toolCallId: "t1",
					errorText: "[TOOL_NOT_ALLOWED] 工具不在当前工具面",
				})}\n\n`,
				// 另外两类归一：invalid_input / denied
				`data: ${JSON.stringify({
					type: "tool-input-error",
					toolCallId: "t2",
					toolName: "save_chapter",
					errorText: "[INVALID_INPUT] 参数不对",
				})}\n\n`,
				`data: ${JSON.stringify({
					type: "tool-output-denied",
					toolCallId: "t3",
					toolName: "write_ledger",
					errorText: "[DENIED] 未授权",
				})}\n\n`,
				`data: ${JSON.stringify({ type: "error", errorText: "流内错误" })}\n\n`,
				`data: ${JSON.stringify({
					type: "finish",
					messageMetadata: {
						run: { status: "paused" },
						finalContent: "未验证写入",
					},
				})}\n\n`,
			]),
			handlers,
		);
		expect(calls).toEqual([
			["reasoning-start", { type: "reasoning-start", id: "r0" }],
			["event", "reasoning-start"],
			["reasoning-delta", "想一"],
			["event", "reasoning-delta"],
			["reasoning-delta", "想二"],
			["event", "reasoning-delta"],
			["reasoning-end", { type: "reasoning-end", id: "r0" }],
			["event", "reasoning-end"],
			["delta", "第1章"],
			["event", "text-delta"],
			["delta", "已写入。"],
			["event", "text-delta"],
			["text-end", { type: "text-end", id: "m0" }],
			["event", "text-end"],
			[
				"tool-call",
				{
					toolCallId: "t1",
					toolName: "create_character",
					input: { name: "甲" },
				},
			],
			["event", "tool-input-available"],
			["tool-output", { toolCallId: "t1", output: { ok: true } }],
			["event", "tool-output-available"],
			[
				"tool-error",
				{
					toolCallId: "t1",
					toolName: "create_character",
					code: "TOOL_NOT_ALLOWED",
					message: "工具不在当前工具面",
					kind: "tool_error",
				},
			],
			["event", "tool-output-error"],
			[
				"tool-error",
				{
					toolCallId: "t2",
					toolName: "save_chapter",
					code: "INVALID_INPUT",
					message: "参数不对",
					kind: "invalid_input",
				},
			],
			["event", "tool-input-error"],
			[
				"tool-error",
				{
					toolCallId: "t3",
					toolName: "write_ledger",
					code: "DENIED",
					message: "未授权",
					kind: "denied",
				},
			],
			["event", "tool-output-denied"],
			["error", { message: "流内错误" }],
			["event", "error"],
			["done", { text: "未验证写入", run: { status: "paused" } }],
			["event", "finish"],
		]);
		// 返回 {text, aborted, run, toolErrors}：finalContent 覆盖增量累计、run 透传、toolErrors 累积
		expect(out.text).toBe("未验证写入");
		expect(out.aborted).toBe(false);
		expect(out.run).toEqual({ status: "paused" });
		expect(out.toolErrors.length).toBe(3);
		expect(out.toolErrors[0].toolName).toBe("create_character"); // toolNames 回填
		// abort → aborted=true（pull 模式：第一片成功读出、第二次 read 才 AbortError）
		const enc = new TextEncoder();
		let pulled = false;
		const aborting = new Response(
			new ReadableStream({
				pull(controller) {
					if (!pulled) {
						pulled = true;
						controller.enqueue(
							enc.encode(
								`data: ${JSON.stringify({ type: "text-delta", delta: "半" })}\n\n`,
							),
						);
						return;
					}
					controller.error(
						new DOMException("The operation was aborted.", "AbortError"),
					);
				},
			}),
		);
		const out2 = await hub.consumeAgentStream(aborting, {});
		expect(out2.aborted).toBe(true);
		expect(out2.text).toBe("半");
	});

	it("L12 isJsonResponse/isActiveStatus/newRequestId——与 run-frontend 冻结口径逐字", () => {
		expect(
			hub.isJsonResponse(
				new Response("{}", {
					headers: { "Content-Type": "application/json; charset=utf-8" },
				}),
			),
		).toBe(true);
		expect(
			hub.isJsonResponse(
				new Response("data: hi\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				}),
			),
		).toBe(false);
		expect(
			hub.isJsonResponse(
				new Response("", {
					status: 503,
					headers: { "Content-Type": "text/plain" },
				}),
			),
		).toBe(false);
		expect(hub.isActiveStatus("running")).toBe(true);
		expect(hub.isActiveStatus("awaiting_confirmation")).toBe(true);
		for (const s of [
			"finished",
			"failed",
			"cancelled",
			"interrupted",
			null,
			undefined,
			"",
		]) {
			expect(hub.isActiveStatus(s)).toBe(false);
		}
		const a = hub.newRequestId("write");
		const b = hub.newRequestId("write");
		expect(a.startsWith("write_")).toBe(true);
		expect(a).not.toBe(b);
		expect(hub.newRequestId()).toMatch(/^req_/);
	});

	it("L13 waitRunEvents：轮询到终态续读/网络抖动重试/abort 抛 AbortError/404·403 不无限轮询/x-session-key 头", async () => {
		// 轮询到终态：事件按序回调、afterSeq 续读不重复拉
		const calls = [];
		let round = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url) => {
				calls.push(url);
				round += 1;
				if (round === 1) {
					return jsonResponse({
						runId: "r1",
						status: "running",
						events: [
							{ runId: "r1", seq: 1, type: "phase", payload: { kind: "tool" } },
						],
						nextAfterSeq: 1,
					});
				}
				return jsonResponse({
					runId: "r1",
					status: "finished",
					events: [{ runId: "r1", seq: 2, type: "done", payload: {} }],
					nextAfterSeq: 2,
				});
			}),
		);
		const seen = [];
		const fin = await hub.waitRunEvents({
			runId: "r1",
			sessionKey: "writing:book:1",
			intervalMs: 1,
			onEvent: (ev) => seen.push(`${ev.seq}:${ev.type}`),
		});
		expect(fin.status).toBe("finished");
		expect(seen).toEqual(["1:phase", "2:done"]);
		expect(calls.length).toBe(2);
		expect(calls[1].includes("afterSeq=1")).toBe(true);

		// 网络抖动重试而非失败
		let round2 = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				round2 += 1;
				if (round2 === 1) throw new TypeError("fetch failed");
				return jsonResponse({
					runId: "r2",
					status: "cancelled",
					events: [],
					nextAfterSeq: 0,
				});
			}),
		);
		const fin2 = await hub.waitRunEvents({
			runId: "r2",
			sessionKey: "agent:x",
			intervalMs: 1,
		});
		expect(fin2.status).toBe("cancelled");
		expect(round2).toBe(2);

		// abort 以 AbortError 形态抛出
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					runId: "r3",
					status: "running",
					events: [],
					nextAfterSeq: 0,
				}),
			),
		);
		const controller = new AbortController();
		const p = hub.waitRunEvents({
			runId: "r3",
			sessionKey: "s",
			intervalMs: 1,
			signal: controller.signal,
		});
		controller.abort();
		let abortErr = null;
		try {
			await p;
		} catch (e) {
			abortErr = e;
		}
		expect(abortErr).toBeTruthy();
		expect(hub.isAbortError(abortErr)).toBe(true);

		// 404/403 抛可读错误且不无限轮询
		for (const status of [404, 403]) {
			let round3 = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					round3 += 1;
					return jsonResponse({ error: { message: "no access" } }, status);
				}),
			);
			let caught = null;
			try {
				await hub.waitRunEvents({
					runId: "r4",
					sessionKey: "s",
					intervalMs: 1,
				});
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeTruthy();
			expect(caught.message).toMatch(/no access|无法读取运行结果/);
			expect(round3).toBe(1);
		}

		// 携带会话归属头
		let header = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, opts) => {
				header = opts?.headers?.["x-session-key"];
				return jsonResponse({
					runId: "r5",
					status: "finished",
					events: [],
					nextAfterSeq: 0,
				});
			}),
		);
		await hub.waitRunEvents({
			runId: "r5",
			sessionKey: "agent:abc",
			intervalMs: 1,
		});
		expect(header).toBe("agent:abc");
	});

	it("L14 consumeAgentStream 的 tool-output-error→onToolError（TOOL_NOT_ALLOWED 可达＋toolErrors 累积）", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "tool-input-available",
				toolCallId: "t1",
				toolName: "create_character",
				input: { name: "甲" },
			})}\n\n`,
			`data: ${JSON.stringify({
				type: "tool-output-error",
				toolCallId: "t1",
				errorText:
					'[TOOL_NOT_ALLOWED] 工具 "create_character" 不在当前工具面（只读讨论模式不加载写工具，未执行任何写入）',
			})}\n\n`,
			`data: ${JSON.stringify({
				type: "finish",
				messageMetadata: { run: { status: "paused", reason: "step_budget" } },
			})}\n\n`,
		].join("");
		const resp = new Response(sse, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
		const seen = [];
		const out = await hub.consumeAgentStream(resp, {
			onToolError: (info) => seen.push(info),
		});
		expect(seen.length).toBe(
			1,
			"tool-output-error 必须回调给页面（此前被静默丢弃）",
		);
		expect(seen[0].toolName).toBe("create_character");
		expect(seen[0].code).toBe(
			"TOOL_NOT_ALLOWED",
			`错误码必须到达前端：${JSON.stringify(seen[0])}`,
		);
		expect(seen[0].message.indexOf("不在当前工具面") >= 0).toBe(true);
		expect(
			Array.isArray(out.toolErrors) && out.toolErrors.length === 1,
			"当前轮的工具错误要能被状态卡读到",
		).toBe(true);
		expect(out.toolErrors[0].code).toBe("TOOL_NOT_ALLOWED");
	});

	it("L15 foldEvent(done) 权威快照＋consumeAgentStream 的 run 透传与 finalContent 覆盖", async () => {
		const state = hub.createTranscript();
		hub.foldEvent(state, {
			type: "done",
			content: "等确认",
			run: { status: "awaiting_confirmation" },
		});
		expect(state.run.status).toBe("awaiting_confirmation");
		const frames = [
			{ type: "text-delta", delta: "第1章正文已写入。" },
			{
				type: "finish",
				messageMetadata: {
					run: { status: "paused" },
					finalContent: "未验证写入",
				},
			},
		];
		const response = new Response(
			frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
		);
		const result = await hub.consumeAgentStream(response, {});
		expect(result.text).toBe("未验证写入");
		expect(result.run.status).toBe("paused");
	});
});
