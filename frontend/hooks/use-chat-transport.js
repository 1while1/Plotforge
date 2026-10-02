// S5-6（Plan §1.1 G3，charter §3 S5-6）：装配层——把传输核心（frontend/lib/chat-transport.js，
// ≙ legacy 块二 :1048-1411）与实时气泡（frontend/components/ChatLiveBubble.jsx，≙ :1148-1254）
// 接成 S5-5 冻结的 ChatPanel composer props 面。**零生产挂载**：不 import 任何页面/桥，不注册
// window.*，不写 localStorage（只读 window.App 作缺省注入源，Plan §5⑨）。
//
// 返回面（两种读法都可用，S5-7 任选其一）：
//   · 7 个 composer 键**平铺**（Plan §4 T3-1 口径）：value/onChange/onSend/onStop/streaming/
//     consult/onToggleConsult
//   · `composer`＝同 7 键聚合对象（Plan §1.2「composer spread 进 ChatPanel 的 composer」接线形态）
//   · `live`＝实时槽节点（流中＝ChatLiveBubble；参谋等待＝.typing 节点；否则 null）
//   · `transport`/`queueLength` 诊断面（不参与 ChatPanel 契约）
//
// 注入面（opts；缺省从 window.App 读 api/toast，只读不写）：
//   api(method, path, body)   ≙ legacy :277-279 书内相对包装（缺省拼 /api/books/<bookId> 前缀）
//   toast/warn                ≙ A.toast／console.warn
//   getBookId/getChapterId/getConversationId  ≙ S.currentBook／S.currentChapterId／currentConversationId()
//   onAppendMessage(msg)      ≙ appendMsg（回放与状态合并归 S5-7）
//   onRefreshRunStatus/onSyncWatcher/onReload/onMeter  ≙ :1374／:1379／:1316-1381／:1350
//   fetchImpl/hub/toolLabels/getLastRunSnapshot/setTimer  透传给传输核心（测试与 S5-7 可覆盖）
//   scrollTarget              ≙ scrollBottom 的 #chat-messages（元素或 {current} 引用皆可）
//
// 缓冲代理（Plan §5⑧）：beginLive 返回的句柄在气泡挂载前把调用入队，气泡经 apiRef/onAttach 挂上后
// 按序 drain——真实浏览器首帧 delta 不丢。句柄 drop() 时清缓冲并卸载 live 槽。
import { createElement, useEffect, useRef, useState } from "react";
import { ChatLiveBubble } from "../components/ChatLiveBubble.jsx";
import { getApp } from "../lib/app-runtime.js";
import { TOOL_LABELS } from "../lib/chat-render.js";
import { createChatTransport } from "../lib/chat-transport.js";

// 缺省注入源：**调用期**取 App 单例（P6-2 §2.5-D1；等值原 `window.App || globalThis.App`）
function legacyApp() {
	return getApp();
}

function resolveScrollTarget(t) {
	if (!t) return null;
	return "current" in t ? t.current : t;
}

// commitMessage 载荷 → ChatMessageList 的消息形状（缺键补 legacy appendMsg 的缺省值）
function normalizeMessage(m) {
	return {
		role: m.role,
		content: m.content,
		reasoning: m.reasoning || "",
		retrieval: m.retrieval || null,
		tools: m.tools || [],
		actions: m.actions || [],
		blocks: m.blocks || [],
		note: m.note == null ? null : m.note,
		source: m.source || null,
	};
}

export function useChatTransport(opts) {
	const o = opts || {};
	// 所有可变外部依赖经 ref 读取：传输核心只建一次（≙ legacy 的模块级闭包）
	const optsRef = useRef(o);
	optsRef.current = o;

	const [value, setValue] = useState(
		o.initialValue == null ? "" : String(o.initialValue),
	);
	const [consult, setConsult] = useState(!!o.initialConsult);
	const [streaming, setStreaming] = useState(false);
	const [live, setLive] = useState(null); // null | {source, key}
	const [typing, setTyping] = useState(null); // null | 文案

	const valueRef = useRef(value);
	valueRef.current = value;
	const consultRef = useRef(consult);
	consultRef.current = consult;
	// 交给 ChatLiveBubble 的 apiRef（句柄由气泡在挂载 effect 内写入）
	const liveApi = useRef(null);
	if (!liveApi.current) liveApi.current = { current: null };
	const liveEntryRef = useRef(null); // 当前未挂载的缓冲代理条目
	const liveSeqRef = useRef(0);

	const beginLive = (liveOpts) => {
		const entry = { buffer: [], handle: null, dropped: false };
		const route = (name, args) => {
			if (entry.handle) entry.handle[name](...args);
			else entry.buffer.push([name, args]);
		};
		const proxy = {
			pushDelta: (t) => route("pushDelta", [t]),
			pushReasoning: (t) => route("pushReasoning", [t]),
			setPhase: (t) => route("setPhase", [t]),
			addRetrieval: (h) => route("addRetrieval", [h]),
			addTool: (t) => route("addTool", [t]),
			addAction: (a) => route("addAction", [a]),
			flush: () => route("flush", []),
			getText: () => (entry.handle ? entry.handle.getText() : ""),
			getReasoning: () => (entry.handle ? entry.handle.getReasoning() : ""),
			drop: () => {
				entry.dropped = true;
				entry.handle = null;
				entry.buffer.length = 0;
				if (liveEntryRef.current === entry) liveEntryRef.current = null;
				setLive(null);
			},
		};
		liveEntryRef.current = entry;
		liveSeqRef.current += 1;
		setLive({
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1156 body && body.source 的取值形态
			source: (liveOpts && liveOpts.source) || null,
			key: liveSeqRef.current, // 每次 beginLive 换 key：等价 legacy 每帧新建 live 节点
		});
		return proxy;
	};

	// 气泡挂载握手（Plan §5⑧）：attach 前入队、attach 后按序 drain
	const handleAttach = (handle) => {
		const entry = liveEntryRef.current;
		if (!handle || !entry || entry.handle === handle) return;
		entry.handle = handle;
		const pending = entry.buffer.splice(0);
		for (const [name, args] of pending) handle[name](...args);
	};

	const transportRef = useRef(null);
	if (!transportRef.current) {
		const callToast = (msg) => {
			const cb = optsRef.current.toast;
			if (typeof cb === "function") {
				cb(msg);
				return;
			}
			const app = legacyApp();
			if (app && typeof app.toast === "function") app.toast(msg);
		};
		const context = {
			getBookId: () => {
				const f = optsRef.current.getBookId;
				return typeof f === "function" ? f() : null;
			},
			getChapterId: () => {
				const f = optsRef.current.getChapterId;
				return typeof f === "function" ? f() : null;
			},
			getConversationId: () => {
				const f = optsRef.current.getConversationId;
				return typeof f === "function" ? f() : null;
			},
			getConsult: () => consultRef.current,
		};
		transportRef.current = createChatTransport({
			fetchImpl: (url, init) => {
				const f = optsRef.current.fetchImpl || globalThis.fetch;
				return f(url, init);
			},
			// 传输核心按 legacy :1070 的**书内相对**形态调用 api；这里补 /api/books/<bookId> 前缀
			api: (method, path, body) => {
				const f = optsRef.current.api;
				if (typeof f === "function") return f(method, path, body);
				const app = legacyApp();
				if (!app || typeof app.api !== "function")
					return Promise.reject(new Error("api 未注入"));
				return app.api(
					method,
					`/api/books/${context.getBookId() == null ? "" : context.getBookId()}${path}`,
					body,
				);
			},
			context,
			sink: {
				toast: callToast,
				warn: (...args) => {
					const cb = optsRef.current.warn;
					if (typeof cb === "function") cb(...args);
					else console.warn(...args);
				},
				busy: (flag) => setStreaming(!!flag),
				beginLive: (liveOpts) => beginLive(liveOpts),
				commitMessage: (msg) => {
					const cb = optsRef.current.onAppendMessage;
					if (typeof cb === "function") cb(normalizeMessage(msg));
				},
				typing: (flag, text) => setTyping(flag ? text || "" : null),
				meter: (usage) => {
					const cb = optsRef.current.onMeter;
					if (typeof cb === "function") cb(usage);
				},
				reload: async () => {
					const cb = optsRef.current.onReload;
					if (typeof cb === "function") await cb();
				},
				refreshRunStatus: async (payload) => {
					const cb = optsRef.current.onRefreshRunStatus;
					if (typeof cb === "function") await cb(payload);
				},
				syncWatcher: () => {
					const cb = optsRef.current.onSyncWatcher;
					if (typeof cb === "function") cb();
				},
			},
			hub: optsRef.current.hub,
			toolLabels: optsRef.current.toolLabels || TOOL_LABELS,
			getLastRunSnapshot: optsRef.current.getLastRunSnapshot,
			setTimer: optsRef.current.setTimer,
		});
	}
	const transport = transportRef.current;

	// 兜底：若气泡已挂载而条目仍待 attach（例如同一帧内 drop→重建），随 live 变化补一次 drain
	// biome-ignore lint/correctness/useExhaustiveDependencies: live 是 drain 触发条件（句柄由子组件挂载 effect 写入 apiRef）
	useEffect(() => {
		const handle = liveApi.current.current;
		if (handle) handleAttach(handle);
	}, [live]);

	const onChange = (v) => setValue(v == null ? "" : String(v));
	const onSend = () => {
		const content = String(
			valueRef.current == null ? "" : valueRef.current,
		).trim();
		if (!content) return undefined; // ≙ :1053-1054 空文本不触发
		setValue(""); // ≙ :1057 提交即清空
		return transport.sendText(content);
	};
	const onStop = () => transport.stop("user"); // ≙ :1899 chatAbort.stop('user')
	const onToggleConsult = () => setConsult((c) => !c);

	// live 槽：参谋等待 = .typing 节点（≙ :1064-1067）；流中 = 实时气泡（≙ :1157）；否则不渲染
	// 注：本文件按 Plan 定名 .js（不改 vite.config），故不用 JSX 字面量而走 createElement。
	const scrollTarget = resolveScrollTarget(optsRef.current.scrollTarget);
	let liveNode = null;
	if (typing != null) {
		liveNode = createElement("div", { className: "typing" }, typing);
	} else if (live) {
		liveNode = createElement(ChatLiveBubble, {
			key: live.key,
			apiRef: liveApi.current,
			source: live.source,
			scrollTarget,
			cardProps: optsRef.current.cardProps,
			onAttach: handleAttach,
			onDetach: () => {},
		});
	}

	const composer = {
		value,
		onChange,
		onSend,
		onStop,
		streaming,
		consult,
		onToggleConsult,
	};

	return {
		...composer,
		composer,
		live: liveNode,
		transport,
		queueLength: () => transport.queueLength(),
	};
}
