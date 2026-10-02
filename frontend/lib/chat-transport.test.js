// S5-6 红测（Plan §4 T1，T1-1~T1-19）：传输核心 frontend/lib/chat-transport.js。
// 语义唯一事实源＝public/legacy/book-chat.js（2,133 行，零 diff 保留）块二 :1048-1411：
//   sendChat :1048-1090／chatBusy+chatQueue+chatAbort :1092-1099／updateStopBtn :1101-1104／
//   runChatStream（W9 入队绑定）:1106-1110／enqueueChat :1112-1127／
//   streamChatOnce（409 排队重试 :1271-1284／幂等 JSON 分支 :1285-1321／流消费 :1324-1361／
//   收尾映射 :1363-1381／abort 贯穿 :1382-1395）／resumeAfterConfirm :1401-1406。
// harness＝node 环境（vite.config.mjs test.environment='node'）＋vi.useFakeTimers()＋真
// Response/ReadableStream 造 SSE（frontend/lib/chat-event-hub.test.js:17-37 同款）；零新增依赖、
// 零真实网络（fetchImpl/api/hub 全注入）；每例头注写 legacy 行号锚点。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hubModule from "./chat-event-hub.js";
import { TOOL_LABELS } from "./chat-render.js";
import {
	autoCompactToast,
	BUSY_RETRY_DELAY_MS,
	BUSY_RETRY_TOAST,
	CONSULT_TYPING_TEXT,
	createChatTransport,
	DROP_BOOK_TOAST,
	DROP_CONV_TOAST,
	DUP_PHASE_SYNC,
	DUP_PHASE_WAIT,
	DUP_WAIT_ERROR_PHASE,
	duplicateSyncedToast,
	PERMANENT_409_FALLBACK,
	QUEUE_TOAST,
	RECOVERING_TOAST,
	RUN_STATUS_LABELS,
	roundPhaseText,
	STOP_TOAST,
	STOP_WAIT_TOAST,
	STREAM_FAIL_ERROR,
	toolPhaseText,
} from "./chat-transport.js";

// ---------- harness：SSE 响应（chat-event-hub.test.js:17-37 同款真 Response/ReadableStream） ----------
function ev(obj) {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseResponse(chunks) {
	const enc = new TextEncoder();
	const parts = Array.isArray(chunks) ? chunks : [chunks];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts) {
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

// 挂住的流：喂完已有帧后不关闭；signal 中止时按真 fetch 语义让 reader 抛 AbortError
// （legacy :1322-1361 的断流/中止路径靠真 fetch 的 abort 语义触发，注入式 fetch 必须自造）
function heldSseResponse(chunks, signal) {
	const enc = new TextEncoder();
	const parts = (Array.isArray(chunks) ? chunks : [chunks]).map((c) =>
		enc.encode(c),
	);
	let ctl = null;
	let i = 0;
	const stream = new ReadableStream({
		start(controller) {
			ctl = controller;
		},
		pull(controller) {
			if (i < parts.length) {
				controller.enqueue(parts[i]);
				i += 1;
				return;
			}
			return new Promise(() => {}); // 挂住：不再产出也不关闭
		},
	});
	if (signal) {
		signal.addEventListener("abort", () => {
			const e = new Error("aborted");
			e.name = "AbortError";
			try {
				ctl.error(e);
			} catch (_e) {
				/* 已关闭/已出错 */
			}
		});
	}
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status: status || 200,
		headers: { "Content-Type": "application/json" },
	});
}

function textResponse(body, status) {
	return new Response(String(body), {
		status: status || 200,
		headers: { "Content-Type": "text/plain" },
	});
}

// ---------- harness：假 sink 与假 live 句柄（记录调用，语义对齐真实实现） ----------
function makeLive() {
	const l = {
		text: "",
		reasoning: "",
		phase: [],
		tools: [],
		actions: [],
		retrievals: [],
		dropped: false,
		flushes: 0,
		opts: null,
	};
	l.pushDelta = (t) => {
		l.text += t;
	};
	l.pushReasoning = (t) => {
		l.reasoning += t;
	};
	l.setPhase = (t) => {
		l.phase.push(t);
	};
	l.addTool = (t) => {
		l.tools.push(t);
	};
	l.addAction = (a) => {
		l.actions.push(a);
	};
	l.addRetrieval = (h) => {
		l.retrievals.push(h);
	};
	l.flush = () => {
		l.flushes += 1;
	};
	l.getText = () => l.text;
	l.getReasoning = () => l.reasoning;
	l.drop = () => {
		l.dropped = true;
	};
	return l;
}

function makeSink() {
	const calls = {
		toast: [],
		warn: [],
		busy: [],
		commit: [],
		typing: [],
		live: [],
		meter: [],
		reload: 0,
		refreshRunStatus: [],
		syncWatcher: 0,
	};
	const sink = {
		toast: (m) => calls.toast.push(m),
		warn: (...a) => calls.warn.push(a),
		busy: (flag) => calls.busy.push(flag),
		beginLive: (opts) => {
			const l = makeLive();
			l.opts = opts;
			calls.live.push(l);
			return l;
		},
		commitMessage: (m) => calls.commit.push(m),
		typing: (flag, text) => calls.typing.push([flag, text]),
		meter: (usage) => calls.meter.push(usage),
		reload: async () => {
			calls.reload += 1;
		},
		refreshRunStatus: async (o) => {
			calls.refreshRunStatus.push(o);
		},
		syncWatcher: () => {
			calls.syncWatcher += 1;
		},
	};
	return { sink, calls };
}

const tick = async (n = 20) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

function setup(opts = {}) {
	const o = opts || {};
	const ctx = {
		bookId: 7,
		chapterId: 42,
		conversationId: "c1",
		consult: false,
		...(o.ctx || {}),
	};
	const { sink, calls } = makeSink();
	const fetches = [];
	const handler =
		o.fetchImpl ||
		(() => Promise.resolve(jsonResponse({ error: "未铺桩" }, 500)));
	const fetchImpl = (url, init) => {
		fetches.push({ url, init });
		return handler(url, init);
	};
	const apiCalls = [];
	const api =
		o.api ||
		((method, path, body) => {
			apiCalls.push({ method, path, body });
			return Promise.resolve(o.apiReply || {});
		});
	const transport = createChatTransport({
		fetchImpl,
		api,
		sink,
		context: {
			getBookId: () => ctx.bookId,
			getChapterId: () => ctx.chapterId,
			getConversationId: () => ctx.conversationId,
			getConsult: () => ctx.consult,
		},
		hub: o.hub,
		toolLabels: o.toolLabels || TOOL_LABELS,
		getLastRunSnapshot: o.getLastRunSnapshot,
	});
	return {
		transport,
		calls,
		fetches,
		apiCalls,
		ctx,
		lastLive: () => calls.live[calls.live.length - 1],
		bodyOf: (i) => JSON.parse(fetches[i].init.body),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("T1 chat-transport（legacy 块二 :1048-1411 逐条保真）", () => {
	it("T1-1 空文本不触发（:1053-1054）", async () => {
		const t = setup();
		await t.transport.sendText("");
		await t.transport.sendText("   ");
		expect(t.fetches.length).toBe(0);
		expect(t.calls.commit.length).toBe(0);
		expect(t.calls.live.length).toBe(0);
	});

	it("T1-2 主路径：用户消息落盘＋请求体逐字＋单一 abort 句柄（:1056-1089 / :1256-1267）", async () => {
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([
						ev({ type: "content", text: "好" }),
						ev({ type: "done", content: "好" }),
					]),
				),
		});
		await t.transport.sendText("写一段");
		// ①用户消息恰 1 次（:1084 appendMsg('user', content, null, null, {source})）
		expect(t.calls.commit.filter((m) => m.role === "user")).toEqual([
			{ role: "user", content: "写一段", source: "writing" },
		]);
		// ②请求逐字（:1262 URL 取当前书；:1259 request_id 前缀 write；:1261 会话随请求下发）
		expect(t.fetches.length).toBe(1);
		const f = t.fetches[0];
		expect(f.url).toBe("/api/books/7/chat/stream");
		expect(f.init.method).toBe("POST");
		expect(f.init.headers["Content-Type"]).toBe("application/json");
		const body = t.bodyOf(0);
		expect(body.content).toBe("写一段");
		expect(body.chapterId).toBe(42);
		expect(body.source).toBe("writing");
		expect(body.request_id.startsWith("write_")).toBe(true);
		expect(body.conversationId).toBe("c1");
		// ③signal 来自 createAbort（:1266 signal: runAbort.signal）
		expect(f.init.signal).toBeInstanceOf(AbortSignal);
		expect(f.init.signal.aborted).toBe(false);
		expect(t.transport.isBusy()).toBe(false);
	});

	it("T1-3 参谋模式走 /consult（非流式）＋typing 宿主（:1059-1081）", async () => {
		const t = setup({
			ctx: { consult: true },
			apiReply: {
				reply: "建议A",
				reasoning: "想一下",
				retrieval: [{ chapter: "第一章", score: 0.9, text: "旧文" }],
			},
		});
		await t.transport.sendText("这段怎么写");
		expect(t.fetches.length).toBe(0); // 零 chat/stream 请求
		expect(t.apiCalls).toEqual([
			{
				method: "POST",
				path: "/consult",
				body: { question: "这段怎么写", chapterId: 42 },
			},
		]);
		expect(t.calls.typing).toEqual([
			[true, CONSULT_TYPING_TEXT],
			[false, undefined],
		]);
		expect(t.calls.commit).toEqual([
			{ role: "user", content: "这段怎么写", source: "writing" },
			{
				role: "consultant",
				content: "建议A",
				reasoning: "想一下",
				retrieval: [{ chapter: "第一章", score: 0.9, text: "旧文" }],
				source: "writing",
			},
		]);
		// 失败分支（:1073-1076）：typing 摘除＋toast(e.message)
		const t2 = setup({
			ctx: { consult: true },
			api: () => Promise.reject(new Error("参谋失败")),
		});
		await t2.transport.sendText("问一句");
		expect(t2.calls.typing).toEqual([
			[true, CONSULT_TYPING_TEXT],
			[false, undefined],
		]);
		expect(t2.calls.toast).toEqual(["参谋失败"]);
		expect(t2.calls.commit.length).toBe(1); // 只有用户消息
	});

	it("T1-4 本地队列 FIFO 串行且任意时刻在飞 ≤1（:1112-1127）", async () => {
		const resolvers = [];
		const t = setup({
			fetchImpl: () =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		});
		const p1 = t.transport.sendText("A");
		await tick();
		expect(t.fetches.length).toBe(1); // 第一条在飞
		const p2 = t.transport.sendText("B");
		await tick();
		expect(t.calls.toast).toEqual([QUEUE_TOAST]);
		expect(t.transport.queueLength()).toBe(1);
		// 第二条排队期间仍只有一次 fetch（不并发）
		expect(t.fetches.length).toBe(1);
		expect(t.bodyOf(0).content).toBe("A");
		resolvers[0](sseResponse([ev({ type: "done", content: "答A" })]));
		await p1;
		await tick();
		expect(t.fetches.length).toBe(2); // 第一条结束后按序发出
		expect(t.bodyOf(1).content).toBe("B");
		resolvers[1](sseResponse([ev({ type: "done", content: "答B" })]));
		await p2;
		await tick();
		expect(t.transport.queueLength()).toBe(0);
		expect(t.transport.isBusy()).toBe(false);
	});

	it("T1-5 W9 切书丢弃：入队绑书、执行期校验、零 fetch（:1106-1110 / :1141-1146）", async () => {
		const resolvers = [];
		const t = setup({
			fetchImpl: () =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		});
		const p1 = t.transport.sendText("A");
		await tick();
		const p2 = t.transport.sendText("B"); // 入队于书 #7
		await tick();
		t.ctx.bookId = 8; // 排队期间切书
		resolvers[0](sseResponse([ev({ type: "done", content: "答A" })]));
		await p1;
		await p2;
		await tick();
		expect(t.fetches.length).toBe(1); // 排队项零 fetch
		expect(t.calls.warn.length).toBe(1);
		expect(String(t.calls.warn[0][0])).toContain("丢弃排队消息");
		expect(t.calls.toast).toContain(DROP_BOOK_TOAST);
		// 未切书时 URL 取**当前**书 id（:1262）
		const t2 = setup({
			fetchImpl: () => Promise.resolve(sseResponse([ev({ type: "done" })])),
		});
		await t2.transport.sendText("C");
		expect(t2.fetches[0].url).toBe("/api/books/7/chat/stream");
	});

	it("T1-6 S3-03 切会话丢弃＋conversationId=null 不触发守卫（:1136-1140）", async () => {
		const resolvers = [];
		const t = setup({
			fetchImpl: () =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		});
		const p1 = t.transport.sendText("A");
		await tick();
		const p2 = t.transport.sendText("B"); // 入队于 c1
		await tick();
		t.ctx.conversationId = "c2";
		resolvers[0](sseResponse([ev({ type: "done" })]));
		await p1;
		await p2;
		await tick();
		expect(t.fetches.length).toBe(1);
		expect(String(t.calls.warn[0][0])).toContain("丢弃排队消息");
		expect(t.calls.toast).toContain(DROP_CONV_TOAST);
		// 边界：入队 conversationId===null ⇒ `!= null` 逐字不触发（:1136）
		const t2 = setup({
			ctx: { conversationId: null },
			fetchImpl: () =>
				Promise.resolve(sseResponse([ev({ type: "done", content: "好" })])),
		});
		await t2.transport.sendText("D");
		expect(t2.fetches.length).toBe(1);
		expect("conversationId" in t2.bodyOf(0)).toBe(false); // JSON 丢弃 undefined（:1261）
		expect(t2.calls.toast).toEqual([]);
	});

	it("T1-7 409 CHAT_BUSY 2s 后重试、总请求 2 且不并发（:1271-1281）", async () => {
		let n = 0;
		const t = setup({
			fetchImpl: () => {
				n += 1;
				if (n === 1)
					return Promise.resolve(
						jsonResponse(
							{ error: { code: "CHAT_BUSY", message: "该书已有对话在进行中" } },
							409,
						),
					);
				return Promise.resolve(
					sseResponse([ev({ type: "done", content: "答" })]),
				);
			},
		});
		const p = t.transport.sendText("A");
		await tick();
		expect(t.fetches.length).toBe(1);
		await vi.advanceTimersByTimeAsync(BUSY_RETRY_DELAY_MS);
		await p;
		expect(t.fetches.length).toBe(2);
		expect(t.calls.toast).toContain(BUSY_RETRY_TOAST);
		// 首个 live 句柄被移除（:1276 live.remove()），重试帧另起一个
		expect(t.calls.live.length).toBe(2);
		expect(t.calls.live[0].dropped).toBe(true);
		// 重试帧收尾：abort 句柄身份匹配才清（:1394）⇒ busy(false) 恰 1 次
		expect(t.calls.busy).toEqual([true, true, false]);
	});

	it("T1-8 409 上限与永久性判别：busyRetry≥8 抛服务端 message／非 busy 零重试／非 JSON『请求被拒绝』（:1275-1284）", async () => {
		// (a) 上限：busyRetry 0..8 共 9 次请求后抛服务端 message
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{ error: { code: "CHAT_BUSY", message: "该书已有对话在进行中" } },
						409,
					),
				),
		});
		const p = t.transport.sendText("A");
		for (let i = 0; i < 8; i++)
			await vi.advanceTimersByTimeAsync(BUSY_RETRY_DELAY_MS);
		await p;
		expect(t.fetches.length).toBe(9); // 1 次首发 + 8 次重试
		// 第 9 帧 :1283 抛出 → :1390-1392 catch 提示服务端 message（legacy 不 rethrow：
		// streamChatOnce 恒不 reject，:1405 的 catch 因此是 no-op）
		expect(t.calls.toast[t.calls.toast.length - 1]).toBe(
			"该书已有对话在进行中",
		);
		// (b) 永久性结构化 409：零重试立即抛（服务端 message 透传）
		const t2 = setup({
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{
							error: {
								code: "ACTION_REQUIRES_REVIEW",
								message: "动作尚未结算，无法续跑",
							},
						},
						409,
					),
				),
		});
		await t2.transport.sendText("B");
		expect(t2.fetches.length).toBe(1);
		// 零重试：只把服务端 message 提示出去（:1283 抛出 → :1391 catch toast）
		expect(t2.calls.toast).toEqual(["动作尚未结算，无法续跑"]);
		expect(t2.calls.toast).not.toContain(BUSY_RETRY_TOAST);
		// (c) 字符串形态 error 的 409（:1282 payload.error.message || payload.error）
		const t3 = setup({
			fetchImpl: () =>
				Promise.resolve(jsonResponse({ error: "动作尚未结算，无法续跑" }, 409)),
		});
		await t3.transport.sendText("C");
		expect(t3.fetches.length).toBe(1);
		expect(t3.calls.toast).toEqual(["动作尚未结算，无法续跑"]);
		// (d) 非 JSON 409 ⇒ 兜底文案
		const t4 = setup({
			fetchImpl: () => Promise.resolve(textResponse("nope", 409)),
		});
		await t4.transport.sendText("D");
		expect(t4.fetches.length).toBe(1);
		expect(t4.calls.toast).toEqual([PERMANENT_409_FALLBACK]);
	});

	it("T1-9 stop 与 409 重试的时序：信号已停 ⇒ :1277 零重试＋『已停止生成』＋busy(false)（:1276-1277 / :1218-1220）", async () => {
		// (a) 信号在 409 响应处理之前被停 ⇒ :1276 先摘 live、:1277 toast『已停止生成』并 return：零重试
		const resolvers = [];
		const t = setup({
			fetchImpl: () =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		});
		const p = t.transport.sendText("A");
		await tick();
		t.transport.stop("user"); // 409 尚未到达时按停止
		resolvers[0](
			jsonResponse({ error: { code: "CHAT_BUSY", message: "忙" } }, 409),
		);
		await vi.advanceTimersByTimeAsync(BUSY_RETRY_DELAY_MS * 4);
		await p;
		expect(t.fetches.length).toBe(1); // 零重试
		expect(t.calls.live[0].dropped).toBe(true); // :1276 live.remove()
		expect(t.calls.toast).toEqual([STOP_TOAST]);
		expect(t.calls.busy).toEqual([true, false]);
		await vi.advanceTimersByTimeAsync(10000);
		expect(t.fetches.length).toBe(1); // 再无重试
		// (b) 2s 等待**期间**按停止：逐字复核 legacy :1218-1220 后确认重试帧会新建 createAbort，
		// 等待期的 stop 只停住上一帧句柄 ⇒ 重试帧照发（旧句柄不拦新帧）。Plan §4 T1-9 的措辞
		// （『2s 等待里 stop ⇒ 零重试』）与 legacy 实测不一致，本片按 legacy 逐字保真并留痕
		// （selfcheck『未按 Plan 措辞』条＋回报 out_of_scope），未改判范式/未改 legacy 语义。
		let n2 = 0;
		const t2 = setup({
			fetchImpl: () => {
				n2 += 1;
				if (n2 === 1)
					return Promise.resolve(
						jsonResponse({ error: { code: "CHAT_BUSY", message: "忙" } }, 409),
					);
				return Promise.resolve(
					sseResponse([ev({ type: "done", content: "答" })]),
				);
			},
		});
		const p2 = t2.transport.sendText("A");
		await tick();
		t2.transport.stop("user"); // 2s 等待里按停止（旧句柄）
		await vi.advanceTimersByTimeAsync(BUSY_RETRY_DELAY_MS);
		await p2;
		expect(t2.fetches.length).toBe(2); // 重试帧照发（新句柄未被旧 stop 影响）
		expect(t2.fetches[1].init.signal.aborted).toBe(false);
		expect(t2.calls.toast).toEqual([BUSY_RETRY_TOAST]);
		expect(t2.calls.busy).toEqual([true, true, false]);
		expect(t2.calls.commit[1].content).toBe("答");
	});

	it("T1-10 幂等重复（终结态）：phase→清空＋reload 恰 1 次＋零流消费（:1287-1318）", async () => {
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{
							runId: "r1",
							status: "finished",
							duplicate: true,
							sessionKey: "s1",
						},
						200,
					),
				),
		});
		await t.transport.sendText("A");
		expect(t.calls.live[0].phase).toEqual([DUP_PHASE_SYNC, ""]);
		expect(t.calls.live[0].dropped).toBe(true);
		expect(t.calls.toast).toEqual([duplicateSyncedToast("finished")]);
		expect(t.calls.reload).toBe(1);
		expect(t.calls.live[0].text).toBe(""); // 零流消费
		expect(t.fetches.length).toBe(1); // 不重发业务请求
	});

	it("T1-11 另一窗口活跃：waitRunEvents 参数原样＋phase 映射＋终态收尾（:1293-1311）", async () => {
		const waitCalls = [];
		const t = setup({
			hub: {
				...hubModule,
				waitRunEvents: (o) => {
					waitCalls.push(o);
					o.onEvent({
						type: "phase",
						payload: { kind: "tool", name: "search_story" },
					});
					o.onEvent({ type: "phase", payload: { kind: "tool" } });
					o.onEvent({ type: "error" });
					return Promise.resolve({ status: "cancelled" });
				},
			},
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{
							duplicate: true,
							status: "running",
							runId: "r7",
							sessionKey: "sk9",
						},
						202,
					),
				),
		});
		await t.transport.sendText("A");
		expect(waitCalls.length).toBe(1);
		expect(waitCalls[0].runId).toBe("r7");
		expect(waitCalls[0].sessionKey).toBe("sk9");
		expect(waitCalls[0].signal).toBeInstanceOf(AbortSignal);
		expect(t.calls.live[0].phase).toEqual([
			DUP_PHASE_WAIT,
			"另一窗口：search_story…",
			"另一窗口：tool…",
			DUP_WAIT_ERROR_PHASE,
			"",
		]);
		expect(t.calls.toast).toEqual([duplicateSyncedToast("cancelled")]);
		expect(t.calls.reload).toBe(1);
	});

	it("T1-12 等待中止（AbortError）与未知终态（:1308-1311）", async () => {
		const t = setup({
			hub: {
				...hubModule,
				waitRunEvents: () => {
					const e = new Error("等待运行结果时已停止");
					e.name = "AbortError";
					return Promise.reject(e);
				},
			},
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{ duplicate: true, status: "running", runId: "r1" },
						202,
					),
				),
		});
		await t.transport.sendText("A");
		expect(t.calls.toast).toEqual([STOP_WAIT_TOAST]);
		expect(t.calls.reload).toBe(0);
		expect(t.calls.live[0].phase).toEqual([DUP_PHASE_WAIT, ""]);
		expect(t.calls.busy[t.calls.busy.length - 1]).toBe(false);
		// 非 abort 抛错 ⇒ finalStatus='unknown' ⇒ 走「结束」分支
		const t2 = setup({
			hub: {
				...hubModule,
				waitRunEvents: () => Promise.reject(new Error("boom")),
			},
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{ duplicate: true, status: "running", runId: "r1" },
						202,
					),
				),
		});
		await t2.transport.sendText("B");
		expect(t2.calls.toast).toEqual([duplicateSyncedToast("unknown")]);
		expect(t2.calls.reload).toBe(1);
	});

	it("T1-13 非重复 JSON（非 409）：走 hub.parseResponseError 并带 code/status（:1319-1321）", async () => {
		const parseSpy = vi.fn(hubModule.parseResponseError);
		const t = setup({
			hub: { ...hubModule, parseResponseError: parseSpy },
			fetchImpl: () =>
				Promise.resolve(
					jsonResponse(
						{
							error: {
								code: "RUN_PERSIST_FAILED",
								message: "运行持久化失败",
							},
						},
						503,
					),
				),
		});
		await t.transport.sendText("A");
		expect(parseSpy.mock.calls.length).toBe(1);
		expect(parseSpy.mock.calls[0][1]).toBe("请求失败 503");
		// 结构化错误由该 lib 造（S4-10 L3 已钉其行为，本片只钉被调用＋参数）；
		// 抛出后由 :1390-1392 catch 提示 e.message
		const err = await parseSpy.mock.results[0].value;
		// legacy :1287-1289 先 await res.json() 探 duplicate，:1320 再让 parseResponseError 读同一个 res
		// ⇒ body 已被消费，message 取兜底文案（'请求失败 503'）、code 拿不到；status 仍透传 res.status。
		// 这是 legacy 既有语义（行为零变化红线），非本片缺陷，已在台账/selfcheck 留痕。
		expect(err.message).toBe("请求失败 503");
		expect(err.code).toBeUndefined();
		expect(err.status).toBe(503);
		expect(t.calls.toast).toEqual(["请求失败 503"]);
	});

	it("T1-14 流内事件映射：delta/reasoning/retrieval/tool/action/recovering/auto_compact/phase/失败（:1322-1361）", async () => {
		const retrievalHits = [{ chapter: "第一章", score: 0.8, text: "旧文" }];
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([
						ev({ type: "retrieval", hits: retrievalHits }),
						ev({ type: "reasoning", text: "想" }),
						ev({ type: "content", text: "正" }),
						ev({ type: "tool", name: "search_story", args: {}, result: "ok" }),
						ev({ type: "action", id: 9, name: "append_chapter", args: {} }),
						ev({ type: "recovering" }),
						ev({ type: "recovering" }),
						ev({ type: "auto_compact", archived: 3 }),
						ev({ type: "phase", kind: "tool", name: "append_chapter" }),
						ev({ type: "phase", kind: "tool", name: "未知工具" }),
						ev({ type: "phase", round: 2, total: 3 }),
						ev({ type: "done", content: "正文" }),
					]),
				),
		});
		await t.transport.sendText("A");
		const live = t.calls.live[0];
		expect(live.text).toBe("正");
		expect(live.reasoning).toBe("想");
		expect(live.retrievals).toEqual([retrievalHits]);
		expect(live.tools).toEqual([
			{ name: "search_story", args: {}, result: "ok" },
		]);
		expect(live.actions).toEqual([{ id: 9, name: "append_chapter", args: {} }]);
		expect(live.phase).toEqual([
			"",
			toolPhaseText("append_chapter", TOOL_LABELS),
			toolPhaseText("未知工具", TOOL_LABELS),
			roundPhaseText(2, 3),
		]);
		expect(t.calls.toast).toEqual([RECOVERING_TOAST, autoCompactToast(3)]); // recovering 每流至多一次（hub 折叠语义）
		// 非 2xx／无 body ⇒ '流式请求失败'（:1322）
		const t2 = setup({
			fetchImpl: () => Promise.resolve(textResponse("boom", 500)),
		});
		await t2.transport.sendText("B");
		expect(t2.calls.toast).toEqual([STREAM_FAIL_ERROR]);
		const t3 = setup({
			fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
		});
		await t3.transport.sendText("C");
		expect(t3.calls.toast).toEqual([STREAM_FAIL_ERROR]);
	});

	it("T1-15 usage→meter 恰 1 次；无 usage 0 次（:1350）", async () => {
		const usage = { prompt_tokens: 1000, cache_hit_tokens: 20 };
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([ev({ type: "done", content: "文", usage })]),
				),
		});
		await t.transport.sendText("A");
		expect(t.calls.meter).toEqual([usage]);
		const t2 = setup({
			fetchImpl: () =>
				Promise.resolve(sseResponse([ev({ type: "done", content: "文" })])),
		});
		await t2.transport.sendText("B");
		expect(t2.calls.meter.length).toBe(0);
	});

	it("T1-16 收尾映射：run 三值文案表／errors 只提示不落半截／refreshRunStatus 参数／syncWatcher／autoCompact（:1363-1381）", async () => {
		const table = [
			["awaiting_confirmation", RUN_STATUS_LABELS.awaiting_confirmation],
			["paused", RUN_STATUS_LABELS.paused],
			["cancelled", RUN_STATUS_LABELS.cancelled],
		];
		for (const [status, label] of table) {
			const t = setup({
				fetchImpl: () =>
					Promise.resolve(
						sseResponse([
							ev({ type: "content", text: "正文" }),
							ev({ type: "done", content: "正文", run: { status } }),
						]),
					),
			});
			await t.transport.sendText("A");
			const msg = t.calls.commit[1];
			expect(msg).toEqual({
				role: "assistant",
				content: `正文\n\n（${label}）`,
				reasoning: "",
				retrieval: [],
				tools: [],
				actions: [],
				blocks: [],
				note: label,
				source: "writing",
			});
			expect(t.calls.refreshRunStatus).toEqual([
				{ run: { status }, tools: [], toolErrors: [] },
			]);
			expect(t.calls.syncWatcher).toBe(1);
			expect(t.calls.reload).toBe(0);
		}
		// 无 run ⇒ 回落 lastRunSnapshot（:1375 state.run || lastRunSnapshot）
		const snap = { status: "paused", id: "run-1" };
		const tSnap = setup({
			getLastRunSnapshot: () => snap,
			fetchImpl: () =>
				Promise.resolve(sseResponse([ev({ type: "done", content: "文" })])),
		});
		await tSnap.transport.sendText("A");
		expect(tSnap.calls.refreshRunStatus[0].run).toBe(snap);
		// 流内 errors：只提示最后一条、不落半截消息，但收尾编排照走（:1363-1378）
		const tErr = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([
						ev({ type: "content", text: "半截" }),
						ev({ type: "error", error: { message: "第二错" } }),
						ev({ type: "error", error: "末条错" }),
						ev({ type: "done", content: "半截", run: { status: "cancelled" } }),
					]),
				),
		});
		await tErr.transport.sendText("B");
		expect(tErr.calls.toast).toEqual(["末条错"]);
		expect(tErr.calls.live[0].dropped).toBe(true);
		expect(tErr.calls.commit.filter((m) => m.role === "assistant").length).toBe(
			0,
		);
		expect(tErr.calls.refreshRunStatus.length).toBe(1);
		expect(tErr.calls.syncWatcher).toBe(1);
		// auto_compact ⇒ 收尾后再拉一次消息（:1381）
		const tCompact = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([
						ev({ type: "auto_compact", archived: 2 }),
						ev({ type: "done", content: "文" }),
					]),
				),
		});
		await tCompact.transport.sendText("C");
		expect(tCompact.calls.toast).toEqual([autoCompactToast(2)]);
		expect(tCompact.calls.reload).toBe(1);
	});

	it("T1-17 无正文退化：有工具/卡取兜底文案；皆无则仅 toast（:1226-1250）", async () => {
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(
					sseResponse([
						ev({ type: "tool", name: "search_story", args: {}, result: "ok" }),
						ev({ type: "done" }),
					]),
				),
		});
		await t.transport.sendText("A");
		const msg = t.calls.commit[1];
		expect(msg.content).toBe("（已发起操作，请查看上方确认卡）");
		expect(msg.note).toBe(null);
		expect(msg.tools).toEqual([
			{ name: "search_story", args: {}, result: "ok" },
		]);
		// 正文与块皆无 ⇒ 仅 toast（:1249）
		const t2 = setup({
			fetchImpl: () => Promise.resolve(sseResponse([ev({ type: "done" })])),
		});
		await t2.transport.sendText("B");
		expect(t2.calls.toast).toEqual(["未收到回复内容"]);
		expect(t2.calls.commit.length).toBe(1); // 只有用户消息
	});

	it("T1-18 abort 贯穿：部分输出保留＋无输出仅 toast＋句柄身份清＋busy(false) 恰 1 次（:1218-1220 / :1382-1395）", async () => {
		const abortSpy = vi.fn(hubModule.createAbort);
		const t = setup({
			hub: { ...hubModule, createAbort: abortSpy },
			fetchImpl: (_url, init) =>
				Promise.resolve(
					heldSseResponse(
						[ev({ type: "content", text: "前半段" })],
						init.signal,
					),
				),
		});
		const p = t.transport.sendText("A");
		await tick(30);
		expect(t.calls.live[0].text).toBe("前半段");
		expect(t.transport.isBusy()).toBe(true);
		t.transport.stop("user");
		await p;
		expect(abortSpy.mock.results[0].value.stopped()).toBe(true); // createAbort().stopped()
		const msg = t.calls.commit[1];
		expect(msg).toEqual({
			role: "assistant",
			content: "前半段\n\n（已停止生成）",
			reasoning: "",
			retrieval: [],
			tools: [],
			actions: [],
			blocks: [],
			note: STOP_TOAST,
			source: "writing",
		});
		expect(t.calls.refreshRunStatus).toEqual([
			{
				run: { status: "cancelled", reason: "user_abort" },
				tools: [],
				toolErrors: [],
			},
		]);
		expect(t.calls.busy).toEqual([true, false]); // 句柄身份匹配才清（:1394）
		expect(t.transport.isBusy()).toBe(false);
		// (b) fetch 级中止（尚未进入流读取、无任何输出）⇒ live 摘除＋toast（:1382-1388）
		const t2 = setup({
			fetchImpl: (_url, init) =>
				new Promise((_resolve, reject) => {
					const fail = () => {
						const e = new Error("aborted");
						e.name = "AbortError";
						reject(e);
					};
					if (init.signal?.aborted) fail();
					else init.signal?.addEventListener("abort", fail);
				}),
		});
		const p2 = t2.transport.sendText("B");
		await tick(30);
		t2.transport.stop("user");
		await p2;
		expect(t2.calls.toast).toEqual([STOP_TOAST]);
		expect(t2.calls.live[0].dropped).toBe(true);
		expect(t2.calls.busy.filter((v) => v === false).length).toBe(1);
		// (c) 读流期中止且尚无 delta：hub 把 AbortError 折成 state.aborted（:328-335）而非抛出，
		// 收尾走 commitLive('' , '', '已停止生成') ⇒ 正文取 '（已停止生成）'（:1230-1231）
		const t3 = setup({
			fetchImpl: (_url, init) =>
				Promise.resolve(heldSseResponse([], init.signal)),
		});
		const p3 = t3.transport.sendText("C");
		await tick(30);
		t3.transport.stop("user");
		await p3;
		expect(t3.calls.toast).toEqual([]);
		expect(t3.calls.commit[1].content).toBe("（已停止生成）");
		expect(t3.calls.commit[1].note).toBe(STOP_TOAST);
	});

	it("T1-19 resumeAction：系统事件长文本逐字＋续跑请求体（:1401-1406）", async () => {
		const t = setup({
			fetchImpl: () =>
				Promise.resolve(sseResponse([ev({ type: "done", content: "续" })])),
		});
		await t.transport.resumeAction(31);
		expect(t.calls.commit[0]).toEqual({
			role: "user",
			content:
				"[确认执行结果·系统事件] 已把执行结果交给 AI，继续之前的任务…（若这是长期剧情决定，建议到「故事台账 → 故事线」沉淀，对话压缩后它仍可被检索）",
			source: "writing",
		});
		const body = t.bodyOf(0);
		expect(body.resumeActionId).toBe(31);
		expect(body.chapterId).toBe(42);
		expect(body.source).toBe("writing");
		// 无当前书 ⇒ 直接 return（:1402）
		const t2 = setup({
			ctx: { bookId: null },
			fetchImpl: () => Promise.resolve(sseResponse([ev({ type: "done" })])),
		});
		await t2.transport.resumeAction(32);
		expect(t2.calls.commit.length).toBe(0);
		expect(t2.fetches.length).toBe(0);
	});
});

// ---------- 抗短连加固包 E（2026-09-30）：流 POST 网络级幂等重试一次 ----------
// 契约：初始 fetchImpl 本身 reject（网络级，非 AbortError）且未停止、尚未重试过 ⇒ 同一 body
//（request_id 不变，幂等由服务端 duplicate JSON 兜底）原样重发一次；二次失败走既有 catch
//（toast 错误路径）。已拿到 Response（任何状态码）一律不重试（409 有自己的语义）。
describe("抗短连 E：streamChatOnce 流 POST 网络级重试一次（STREAM_FETCH_RETRIES=1）", () => {
	it("E-1 首次 fetch reject(TypeError)、二次成功 → 流正常消费，恰 2 次请求且 request_id 不变", async () => {
		let n = 0;
		const t = setup({
			fetchImpl: () => {
				n += 1;
				if (n === 1) return Promise.reject(new TypeError("fetch failed"));
				return Promise.resolve(
					sseResponse([ev({ type: "done", content: "答" })]),
				);
			},
		});
		await t.transport.sendText("A");
		expect(n).toBe(2);
		expect(t.fetches.length).toBe(2);
		// 同一 body 原样重发：request_id 不变（幂等由服务端 duplicate JSON 兜底）
		expect(t.bodyOf(0).request_id).toBe(t.bodyOf(1).request_id);
		expect(t.bodyOf(1).content).toBe("A");
		// 流正常消费：assistant 消息落盘、无错误 toast
		expect(t.calls.commit[1].content).toBe("答");
		expect(t.calls.toast).toEqual([]);
	});

	it("E-2 首次与二次都 reject → 走既有 catch 错误路径（toast e.message）且 fetch 恰 2 次", async () => {
		let n = 0;
		const t = setup({
			fetchImpl: () => {
				n += 1;
				return Promise.reject(new TypeError("网络断了"));
			},
		});
		await t.transport.sendText("A");
		expect(n).toBe(2);
		expect(t.fetches.length).toBe(2);
		expect(t.calls.toast).toEqual(["网络断了"]);
		expect(t.calls.live[0].dropped).toBe(true);
		expect(t.calls.commit.filter((m) => m.role === "assistant").length).toBe(0);
	});

	it("E-3 AbortError（用户停止）不网络级重试：恰 1 次请求", async () => {
		let n = 0;
		const t = setup({
			fetchImpl: () => {
				n += 1;
				const e = new Error("aborted");
				e.name = "AbortError";
				return Promise.reject(e);
			},
		});
		await t.transport.sendText("A");
		expect(n).toBe(1);
		expect(t.fetches.length).toBe(1);
	});
});
