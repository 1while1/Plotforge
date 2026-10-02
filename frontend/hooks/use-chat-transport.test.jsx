// @vitest-environment jsdom
// S5-6 红测（Plan §4 T3，T3-1~T3-4）：装配层 frontend/hooks/use-chat-transport.js。
// 语义唯一事实源＝public/legacy/book-chat.js 块二（:1048-1411）：composer 面 ≙ sendChat
// :1048-1090（value/onChange/onSend）＋ updateStopBtn :1101-1104（streaming）＋ 参谋三态
// :1855-1878（consult/onToggleConsult）＋ stop 面 :1899（onStop）；live 槽 ≙ 实时气泡
// :1148-1157（随流出现）＋ commitLive :1226-1250（收尾移除）；onAppendMessage ≙ appendMsg。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-19 同款）；
// 探针组件模式（Plan §4 T3）；零新增依赖、零真实网络（fetch/api 全注入）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUSH_INTERVAL_MS } from "../components/ChatLiveBubble.jsx";
import {
	DROP_BOOK_TOAST,
	QUEUE_TOAST,
	STOP_TOAST,
} from "../lib/chat-transport.js";
import { useChatTransport } from "./use-chat-transport.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function ev(obj) {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseResponse(chunks) {
	const enc = new TextEncoder();
	const parts = Array.isArray(chunks) ? chunks : [chunks];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts)
					controller.enqueue(
						typeof part === "string" ? enc.encode(part) : part,
					);
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

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
			return new Promise(() => {});
		},
	});
	if (signal)
		signal.addEventListener("abort", () => {
			const e = new Error("aborted");
			e.name = "AbortError";
			try {
				ctl.error(e);
			} catch (_e) {
				/* ignore */
			}
		});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

const tick = async (n = 20) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

let host;
let root;
let probe;

// 探针（Plan §4 T3）：把 hook 返回面写到外层；live 槽可延后挂载以打缓冲代理解析路径
function Probe(props) {
	const t = useChatTransport(props.opts);
	props.onRender(t);
	return <div id="probe">{props.gate.on ? t.live : null}</div>;
}

function setup(opts = {}) {
	const o = opts || {};
	const ctx = {
		bookId: 7,
		chapterId: 42,
		conversationId: "c1",
		...(o.ctx || {}),
	};
	const fetches = [];
	const pending = [];
	const handler =
		o.fetchImpl ||
		(() =>
			new Promise((resolve) => {
				pending.push(resolve);
			}));
	const optsObj = {
		api: o.api || (() => Promise.resolve({})),
		fetchImpl: (url, init) => {
			fetches.push({ url, init });
			return handler(url, init);
		},
		toast: (m) => calls.toast.push(m),
		warn: (...a) => calls.warn.push(a),
		getBookId: () => ctx.bookId,
		getChapterId: () => ctx.chapterId,
		getConversationId: () => ctx.conversationId,
		onAppendMessage: (m) => calls.appended.push(m),
		onRefreshRunStatus: (p) => {
			calls.refreshRunStatus.push(p);
		},
		onSyncWatcher: () => {
			calls.syncWatcher += 1;
		},
		onReload: () => {
			calls.reload += 1;
		},
		onMeter: (usage) => calls.meter.push(usage),
	};
	const calls = {
		toast: [],
		warn: [],
		appended: [],
		refreshRunStatus: [],
		syncWatcher: 0,
		reload: 0,
		meter: [],
	};
	const gate = { on: true };
	const renderProbe = () => {
		act(() => {
			root.render(
				<Probe
					opts={optsObj}
					gate={gate}
					onRender={(t) => {
						probe = t;
					}}
				/>,
			);
		});
	};
	renderProbe();
	return {
		opts: optsObj,
		calls,
		fetches,
		ctx,
		gate,
		pending,
		renderProbe,
		get t() {
			return probe;
		},
		bodyOf: (i) => JSON.parse(fetches[i].init.body),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("T3 useChatTransport（装配面）", () => {
	it("T3-1 composer 契约（S5-5 冻结键）＋空文本零 fetch（:1048-1054 / :1101-1104）", () => {
		const t = setup();
		const keys = [
			"value",
			"onChange",
			"onSend",
			"onStop",
			"streaming",
			"consult",
			"onToggleConsult",
		];
		for (const k of keys) expect(k in t.t).toBe(true);
		expect(typeof t.t.onSend).toBe("function");
		expect(t.t.streaming).toBe(false); // ≙ updateStopBtn :1101-1104（无 abort 句柄即隐藏）
		expect(t.t.consult).toBe(false);
		expect(t.t.value).toBe("");
		act(() => {
			t.t.onChange("写一段");
		});
		expect(t.t.value).toBe("写一段");
		act(() => {
			t.t.onToggleConsult();
		});
		expect(t.t.consult).toBe(true);
		act(() => {
			t.t.onToggleConsult();
		});
		expect(t.t.consult).toBe(false);
		act(() => {
			t.t.onChange("   ");
		});
		act(() => {
			t.t.onSend();
		});
		expect(t.fetches.length).toBe(0);
		expect(t.calls.appended.length).toBe(0);
	});

	it("T3-2 端到端：user→assistant 消息＋streaming 真→假＋live 随流出现收尾移除（:1148-1157 / :1226-1250）", async () => {
		const t = setup(); // 默认 handler：手动 resolve，便于观察流中态
		act(() => {
			t.t.onChange("写一段");
		});
		let sendP = null;
		await act(async () => {
			sendP = t.t.onSend();
			await tick();
		});
		expect(t.t.value).toBe(""); // 提交即清空（:1057）
		expect(t.calls.appended.map((m) => m.role)).toEqual(["user"]);
		expect(t.calls.appended[0].content).toBe("写一段");
		// live 随流出现（:1157 wrap.appendChild(live)）
		expect(host.querySelector("#probe .msg.assistant")).not.toBeNull();
		expect(t.t.streaming).toBe(true);
		await act(async () => {
			t.pending[0](
				sseResponse([
					ev({ type: "content", text: "正文" }),
					ev({ type: "done", content: "正文" }),
				]),
			);
			await sendP;
			await tick();
		});
		expect(t.t.streaming).toBe(false);
		expect(host.querySelector("#probe .msg.assistant")).toBeNull(); // 收尾移除（:1228）
		expect(t.calls.appended.map((m) => m.role)).toEqual(["user", "assistant"]);
		const asst = t.calls.appended[1];
		expect(asst.content).toBe("正文");
		expect(asst.source).toBe("writing");
		expect(t.calls.refreshRunStatus.length).toBe(1); // 收尾刷任务卡（:1374）
		expect(t.calls.syncWatcher).toBe(1);
	});

	it("T3-2b 缓冲代理：live 槽晚挂 ⇒ attach 前调用入队、attach 后按序 drain（Plan §5⑧）", async () => {
		const t = setup({
			fetchImpl: (_url, init) =>
				Promise.resolve(
					heldSseResponse(
						[
							ev({ type: "reasoning", text: "想" }),
							ev({ type: "content", text: "甲" }),
							ev({ type: "content", text: "乙" }),
						],
						init.signal,
					),
				),
		});
		t.gate.on = false; // 先不挂 live 节点
		act(() => {
			t.t.onChange("写一段");
		});
		await act(async () => {
			t.t.onSend();
			await tick(30);
		});
		expect(host.querySelector("#probe .msg.assistant")).toBeNull(); // 尚未挂载
		t.gate.on = true; // 现在挂上：缓冲按序 drain 到真句柄
		await act(async () => {
			t.renderProbe();
			await tick();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS); // 合并窗口到点：增量追加落盘
		});
		const live = host.querySelector("#probe .msg.assistant");
		expect(live).not.toBeNull();
		expect(
			live.querySelector(".msg-reasoning").classList.contains("hidden"),
		).toBe(false);
		expect(live.querySelector(".reasoning-body").textContent).toBe("想");
		expect(live.querySelector(".msg-bubble").textContent).toBe("甲乙");
		await act(async () => {
			t.t.onStop();
			await tick(30);
		});
		expect(t.calls.appended.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(t.calls.appended[1].content).toBe("甲乙\n\n（已停止生成）");
	});

	it("T3-3 停止：与 T1-18 同语义（部分输出落消息／无输出仅 toast）＋streaming 回落（:1382-1395 / :1899）", async () => {
		// 无输出分支：fetch 级中止（尚未进入流读取）⇒ :1388 toast『已停止生成』（同 T1-18(b)）
		const t = setup({
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
		act(() => {
			t.t.onChange("写一段");
		});
		await act(async () => {
			t.t.onSend();
			await tick(30);
		});
		expect(t.t.streaming).toBe(true);
		await act(async () => {
			t.t.onStop();
			await tick(30);
		});
		expect(t.t.streaming).toBe(false);
		expect(t.calls.toast).toEqual([STOP_TOAST]);
		expect(host.querySelector("#probe .msg.assistant")).toBeNull();
		// 有部分输出（读流期中止）⇒ hub 折 state.aborted 落正式消息（等价 T1-18(a)/(c)）
		const t2 = setup({
			fetchImpl: (_url, init) =>
				Promise.resolve(
					heldSseResponse(
						[ev({ type: "content", text: "前半段" })],
						init.signal,
					),
				),
		});
		act(() => {
			t2.t.onChange("写一段");
		});
		await act(async () => {
			t2.t.onSend();
			await tick(30);
		});
		await act(async () => {
			t2.t.onStop();
			await tick(30);
		});
		const asst = t2.calls.appended[1];
		expect(asst.role).toBe("assistant");
		expect(asst.content).toBe("前半段\n\n（已停止生成）");
		expect(t2.calls.toast).toEqual([]);
		expect(t2.t.streaming).toBe(false);
	});

	it("T3-4 hook 面队列与切书：排队 toast＋getBookId 变化后丢弃（W9 端到端）（:1106-1127 / :1141-1146）", async () => {
		const t = setup();
		act(() => {
			t.t.onChange("A");
		});
		await act(async () => {
			t.t.onSend();
			await tick();
		});
		expect(t.fetches.length).toBe(1);
		act(() => {
			t.t.onChange("B");
		});
		await act(async () => {
			t.t.onSend();
			await tick();
		});
		expect(t.calls.toast).toContain(QUEUE_TOAST);
		t.ctx.bookId = 8; // 排队期间切书
		await act(async () => {
			t.pending[0](sseResponse([ev({ type: "done", content: "答A" })]));
			await tick(30);
		});
		expect(t.fetches.length).toBe(1); // 排队项零 fetch
		expect(t.calls.warn.length).toBe(1);
		expect(String(t.calls.warn[0][0])).toContain("丢弃排队消息");
		expect(t.calls.toast).toContain(DROP_BOOK_TOAST);
		expect(t.t.streaming).toBe(false);
	});
});
