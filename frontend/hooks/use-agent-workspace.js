// S5-9（Plan §1.1 G8／§4 T4）：Agent 台装配 hook —— 块一编排（S5-8 未交付的那半）＋块二全部行为。
// 语义唯一事实源＝public/legacy/agent.js（注释内逐条行号锚点；旧文件在本片切换笔 git rm 全退役）。
// 分工：纯逻辑在 lib/agent-pending|actions|round|scope|resources|handoff（S5-8/S5-9 出口件），
// DOM 半在 components/AgentLiveRound|AgentActionCard（S5-9）与 S5-8 四个叶组件；本件只做编排与状态。
// 形态：mutable core＋useSyncExternalStore（S5-7 use-chat-workspace.js 同款）——异步链路（SSE／多段
// fetch）读的是最新 state，不存在陈旧闭包；React 面只有 spaceProps。
// 纪律：零 localStorage 直读（全经 deps.storage）、零 window.* 写入、SSE 只走 lib/chat-event-hub.js、
// 依赖全注入（api／fetchImpl／toast／escapeHtml／openModal／closeModal／confirm／storage／runStatus／
// readWritingReturn）。deps 对象须引用稳定（AgentWorkspace 侧用 ref 构造一次；本件按 depsRef 惰性读取）。
import {
	createElement,
	useCallback,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import AgentActionCard from "../components/AgentActionCard.jsx";
import AgentLiveRound from "../components/AgentLiveRound.jsx";
import { scrollMessagesToBottom } from "../components/AgentMessageList.jsx";
import { pickCountText, togglePick } from "../lib/agent-handoff.js";
import {
	forgetPending as forgetPendingStore,
	loadOrCreateSessionId,
	loadPending,
	pendingConversationId as pendingConversationIdOf,
	planPendingRebuild,
	rememberPending as rememberPendingStore,
	savePendingList,
} from "../lib/agent-pending.js";
import {
	normalizeResourceView,
	previewFailText,
	previewModel,
	RES_TYPE_LABELS,
	resourceDetailUrl,
	resourceListFailText,
	resourceListHint,
	resourceListUrl,
	resourceRowModel,
	resourceTypesForScope,
} from "../lib/agent-resources.js";
import {
	buildLegacyImportBody,
	buildNewConversationBody,
	buildResumePayload,
	buildSendPayload,
	createRoundAccumulator,
	isRunCardEmpty,
	legacyBarModel,
	pendingActionSummaries,
	runCardInput,
} from "../lib/agent-round.js";
import {
	boundaryOptions,
	CONVERSATION_EMPTY_HINT,
	CONVERSATION_KEY,
	conversationInScope,
	conversationOptions,
	firstConversationInScope,
	modeButton,
	parseScopeValue,
	readSavedScope,
	resolveBoundaryChapterId,
	saveScope,
	scopeKey,
	scopeOptions,
	scopeStatusText,
} from "../lib/agent-scope.js";
import {
	consumeAgentStream,
	createAbort,
	isAbortError,
	isActiveStatus,
	isJsonResponse,
	newRequestId,
	waitRunEvents,
} from "../lib/chat-event-hub.js";
import { useAgentHandoff } from "./use-agent-handoff.js";

const LEGACY_IMPORTED_KEY = "agent_legacy_imported_v1"; // :1235／:1248／:1265
const HISTORY_KEY = "agent_history_v1"; // :13／:1265

function messageOf(e) {
	return e?.message ? e.message : String(e);
}

// 控制器：状态＋动作（React 只订阅快照）——所有异步链路都在这里，读 state 即最新值
function createAgentController(depsRef, handoffRef) {
	const el = (id) =>
		typeof document === "undefined" ? null : document.getElementById(id);
	const dep = (name) => (depsRef.current ? depsRef.current[name] : undefined);

	function storage() {
		return dep("storage");
	}
	function readKey(key) {
		const s = storage();
		try {
			return s ? s.getItem(key) : null;
		} catch (_e) {
			return null;
		}
	}
	function writeKey(key, value) {
		const s = storage();
		try {
			if (s) s.setItem(key, value);
		} catch (_e) {
			/* storage 不可用：忽略（:35／:107 同口径） */
		}
	}
	function removeKey(key) {
		const s = storage();
		try {
			if (s) s.removeItem(key);
		} catch (_e) {
			/* 忽略 */
		}
	}
	function readJsonList(key) {
		try {
			const list = JSON.parse(readKey(key) || "[]");
			return Array.isArray(list) ? list : [];
		} catch (_e) {
			return [];
		}
	}
	function api(method, url, body) {
		const fn = dep("api");
		if (typeof fn !== "function")
			return Promise.reject(new Error("api 不可用"));
		return fn(method, url, body);
	}
	function fetchImpl(url, init) {
		const fn = dep("fetchImpl");
		if (typeof fn === "function") return fn(url, init);
		return globalThis.fetch(url, init);
	}
	function toast(message) {
		const fn = dep("toast");
		if (typeof fn === "function") fn(message);
	}
	function runStatus() {
		return dep("runStatus");
	}
	function scrollBottom() {
		scrollMessagesToBottom();
	}

	// :23-35 sending/inited ＋:30-35 稳定 session id
	let sending = false;
	let toolsLoaded = false;
	let agentAbort = null;
	let resumeChain = Promise.resolve();
	let roundSeq = 0;
	let lastLoadedMessageId = null; // :1186
	let lastRunSnapshot = null; // :2005
	let lastRoundTools = []; // :2007
	let lastToolErrors = []; // :2006
	const sessionId = loadOrCreateSessionId(storage(), {
		random: Math.random,
		now: Date.now,
	});

	// :17-21 legacy 本地历史（只读待导入）；:1235 已导入标记
	let state = {
		scope: readSavedScope(storage()), // :79
		books: [], // :78
		conversations: [], // :38
		currentConversation: null, // :39
		mode: "discuss", // :534
		boundaryChapterId: null, // :80
		boundaryChapters: [], // :81
		sideTab: "conversations", // :82
		resType: "", // :83
		resCursor: null, // :84
		resItems: [], // :85
		resHint: "",
		preview: { open: false, loading: false, error: null, model: null }, // :505-510
		messages: [],
		restoreVisible: false, // :645-646
		picks: [], // :87
		rounds: [], // 实时轮次（React 子树；≙ legacy :1911-1919 的 DOM 壳）
		pendingCards: [], // :1308-1338 重建的确认卡（过期在前、可操作在后）
		legacyHistory: readJsonList(HISTORY_KEY), // :17-21
		legacyImported: readKey(LEGACY_IMPORTED_KEY) === "1", // :1235
		text: "", // :1887 textarea 受控值
		sending: false,
		stopVisible: false, // :1802-1805
		tools: [], // :1377-1391
		modelText: "", // :1975-1977
	};
	const listeners = new Set();
	function setState(patch) {
		state = { ...state, ...patch };
		sending = state.sending;
		for (const cb of listeners) cb();
	}
	function getSnapshot() {
		return state;
	}
	function subscribe(cb) {
		listeners.add(cb);
		return () => listeners.delete(cb);
	}

	// :1802-1805 停止按钮以 agentAbort 是否在位推导
	function setSending(on) {
		setState({ sending: on, stopVisible: !!agentAbort });
	}

	// ---------- 实时轮次（≙ legacy :1350-1367 消息壳／:1344-1347 滚动）----------
	function newRound(userText, typingText) {
		roundSeq += 1;
		return {
			key: `round-${roundSeq}`,
			apiRef: { current: null },
			queue: [],
			userText: userText || null,
			typingText: typingText || null,
		};
	}
	// op 先入缓冲、组件挂载后由 drainOps 排空（≙ legacy 直接操作已存在的 shell）
	function pushOp(round, op) {
		if (!op || op.kind === "noop") return;
		const handle = round.apiRef.current;
		if (handle) handle.applyOp(op);
		else round.queue.push(op);
	}
	function drainOps() {
		for (const round of state.rounds) {
			const handle = round.apiRef.current;
			if (!handle || !round.queue.length) continue;
			for (const op of round.queue) handle.applyOp(op);
			round.queue.length = 0;
		}
	}
	function addRound(round) {
		setState({ rounds: [...state.rounds, round] });
		if (sending) setSending(true); // 停止按钮随轮次出现（:1802-1805）
	}
	function setTyping(round, typingText) {
		setState({
			rounds: state.rounds.map((r) =>
				r.key === round.key ? { ...r, typingText: typingText } : r,
			),
		});
	}
	// :1865／:1870／:1982／:1988 停止与出错气泡（新起一条独立气泡）
	function noticeBubble(text) {
		const round = newRound(null, null);
		addRound(round);
		pushOp(round, { kind: "bubble", text: text });
	}

	// :2021-2035 统一任务卡（叶容器内容经 RunStatus 命令式写入）
	function renderAgentRunCard() {
		const RS = runStatus();
		const host = el("agent-run-card");
		if (!RS || !host) return null;
		const model = RS.cardModel(
			runCardInput({
				run: lastRunSnapshot,
				conversationId: state.currentConversation
					? state.currentConversation.id
					: null,
				tools: lastRoundTools,
				toolErrors: lastToolErrors,
				actions: pendingActionSummaries(loadPending(storage())),
			}),
		);
		RS.mountTaskCard(host, isRunCardEmpty(model) ? null : model, {});
		return model;
	}

	// :1308-1339 刷新后重建未结算确认卡（过期先渲染为只读卡、可操作卡留在末尾）
	function rebuildPendingCards() {
		const { kept, expired } = planPendingRebuild(
			loadPending(storage()),
			Date.now(),
		);
		savePendingList(storage(), kept); // :1331 过期卡不再进存储
		setState({
			pendingCards: [
				...expired.map((entry) => ({
					key: `expired:${entry.id}`,
					entry: entry,
					status: "expired",
				})),
				...kept.map((entry) => ({
					key: `pending:${entry.id}`,
					entry: entry,
					status: undefined,
				})),
			],
		});
		if (kept.length || expired.length) scrollBottom(); // :1339
	}

	// ---------- 只读取数 ----------
	async function loadBooks() {
		// :235-240
		try {
			const data = await api("GET", "/api/books");
			setState({ books: data?.books || [] });
		} catch (_e) {
			setState({ books: [] });
		}
	}

	function rememberConversation(conv) {
		// :590-596
		setState({ currentConversation: conv || null });
		writeKey(CONVERSATION_KEY, conv ? conv.id : "");
	}

	async function loadConversations() {
		// :549-567
		try {
			const data = await api("GET", "/api/conversations?kind=agent");
			setState({ conversations: Array.isArray(data) ? data : [] });
		} catch (_e) {
			setState({ conversations: [] });
		}
		const saved = readKey(CONVERSATION_KEY);
		let hit = null;
		for (const c of state.conversations) {
			if (
				c.id === saved &&
				c.status !== "archived" &&
				conversationInScope(state.scope, c)
			) {
				hit = c;
				break;
			}
		}
		if (!hit) hit = firstConversationInScope(state.scope, state.conversations);
		setState({ currentConversation: hit });
	}

	async function loadBoundaryChapters() {
		// :243-254
		if (state.scope.kind !== "book") {
			setState({ boundaryChapters: [], boundaryChapterId: null });
			return;
		}
		let items = [];
		try {
			const data = await api(
				"GET",
				`/api/resources?type=chapter&bookId=${encodeURIComponent(state.scope.bookId)}&limit=100`,
			);
			items = data?.items || [];
		} catch (_e) {
			items = [];
		}
		// 章节已不在（被删/换书）：回全书，不猜（:250-252）
		setState({
			boundaryChapters: items,
			boundaryChapterId: resolveBoundaryChapterId(
				items,
				state.boundaryChapterId,
			),
		});
	}

	async function loadTools() {
		// :1377-1391（失败不阻塞）
		try {
			const data = await api("GET", "/api/agent/tools");
			setState({ tools: data?.tools || [] });
		} catch (_e) {
			/* 忽略 */
		}
	}

	// :283-296 类型回落（不在当前范围类型表 → 取首项并清 cursor/items）
	function normalizeResView() {
		const view = normalizeResourceView(state.scope, {
			resType: state.resType,
			resCursor: state.resCursor,
			resItems: state.resItems,
		});
		if (view.resType !== state.resType) setState(view);
	}

	async function loadResources(opts) {
		// :338-362
		const o = opts || {};
		if (o.reset) setState({ resCursor: null, resItems: [] });
		const resType = state.resType;
		if (!resType) return;
		const cursor = o.reset ? null : state.resCursor;
		let data = null;
		try {
			data = await api("GET", resourceListUrl(state.scope, resType, cursor));
		} catch (e) {
			setState({ resHint: resourceListFailText(messageOf(e)) }); // :349
			return;
		}
		const items = data?.items || [];
		const nextCursor = data?.nextCursor ? data.nextCursor : null;
		// 追加（reset 时基数为空）——≙ :353 resItems.concat(items)
		const merged = (o.reset ? [] : state.resItems).concat(items);
		setState({
			resItems: merged,
			resCursor: nextCursor,
			resHint: resourceListHint(
				state.scope,
				state.books,
				resType,
				merged.length,
				!!nextCursor,
			), // :356-361
		});
	}

	function switchSideTab(name) {
		// :512-529
		const tab = name === "resources" ? "resources" : "conversations";
		setState({ sideTab: tab });
		if (tab === "resources") {
			normalizeResView();
			loadResources({ reset: true });
		}
	}

	function showPreview(open) {
		// :505-510（with-preview 由 preview.open 推导）
		setState({ preview: { ...state.preview, open: !!open } });
	}

	async function openResource(item) {
		// :397-422
		if (!item) return;
		setState({
			preview: { open: true, loading: true, error: null, model: null },
		});
		try {
			const data = await api(
				"GET",
				resourceDetailUrl(state.scope, item.type, item.id),
			);
			setState({
				preview: {
					open: true,
					loading: false,
					error: null,
					model: previewModel(data?.resource ? data.resource : null, {}),
				},
			});
		} catch (e) {
			setState({
				preview: {
					open: true,
					loading: false,
					error: previewFailText(messageOf(e)),
					model: null,
				},
			});
		}
	}

	// :621-656 服务端历史（整段重绘；sending 期不动，迟到结果按目标丢弃）
	async function renderServerHistory() {
		setState({ picks: [] }); // :624-626 历史整段重绘 = 勾选作废
		const conv = state.currentConversation;
		if (!conv) {
			setState({ messages: [], rounds: [] });
			return;
		}
		const convId = conv.id;
		if (sending) return; // :629 正在生成：消息区归这一轮流所有
		setState({ messages: [], rounds: [] }); // :630 wrap.innerHTML=''
		let data = null;
		try {
			data = await api(
				"GET",
				`/api/conversations/${convId}/messages?limit=200`,
			);
		} catch (e) {
			if (
				sending ||
				!state.currentConversation ||
				state.currentConversation.id !== convId
			)
				return; // :635
			noticeBubble(`历史加载失败：${messageOf(e)}`); // :636-637
			return;
		}
		if (!state.currentConversation || state.currentConversation.id !== convId)
			return; // :640 目标已变
		if (sending) return; // :641 等待期间开始了新一轮
		const list = data?.messages || [];
		lastLoadedMessageId = list.length ? list[list.length - 1].id : null; // :644
		setState({
			messages: list,
			rounds: [],
			restoreVisible: list.some((m) => m.compressed === 1), // :645-646
		});
		const RS = runStatus();
		if (RS) {
			lastRunSnapshot = RS.runFromMessages(list) || null; // :650-651
			renderAgentRunCard();
		}
		scrollBottom(); // :655
	}

	// :257-277 切范围（含迟到结果丢弃的 token 守卫）
	async function switchScope(value) {
		const next = parseScopeValue(value);
		if (!next) return;
		const token = scopeKey(next);
		setState({
			scope: next,
			boundaryChapterId: null,
			boundaryChapters: [],
		});
		saveScope(storage(), next); // :264
		rememberConversation(firstConversationInScope(next, state.conversations)); // :265-266
		normalizeResView(); // :271
		await loadBoundaryChapters(); // :272
		if (scopeKey(state.scope) !== token) return; // :273 又切走：丢弃本次范围结果
		if (state.sideTab === "resources") await loadResources({ reset: true }); // :274
		if (scopeKey(state.scope) !== token) return; // :275
		await renderServerHistory(); // :276
	}

	// :531-547 模式（global 恒只读；execute 只影响发送入口，不抬权限）
	function toggleMode() {
		if (state.scope.kind !== "book") return; // 按钮 disabled（:2096）
		const next = state.mode === "execute" ? "discuss" : "execute";
		setState({ mode: next });
		toast(
			next === "execute"
				? "执行模式：AI 可发起写操作，每一步仍需你在确认卡放行"
				: "已切回只读讨论",
		); // :2099
	}

	// ---------- 会话 ----------
	async function newConversation() {
		// :599-607
		const conv = await api(
			"POST",
			"/api/conversations",
			buildNewConversationBody(state.scope, state.books),
		);
		setState({ conversations: [conv, ...state.conversations] });
		rememberConversation(conv);
		setState({ messages: [], rounds: [] }); // :605
		return conv;
	}

	async function selectConversation(id) {
		// :609-615
		if (!id) {
			rememberConversation(null);
			setState({ messages: [], rounds: [] });
			return;
		}
		const hit = state.conversations.find((c) => c.id === id);
		if (hit) rememberConversation(hit);
		await renderServerHistory();
	}

	// :2085-2089 顶部「新会话」按钮（成功/失败都 toast）
	async function newConversationFromButton() {
		try {
			await newConversation();
			toast("已在当前范围开始新会话（原会话历史保留，可从会话列表切回）");
		} catch (e) {
			toast(`新会话创建失败：${messageOf(e)}`);
		}
	}

	function setBoundary(value) {
		// :2062-2065（状态行由 scopeStatusText 推导）
		setState({ boundaryChapterId: value });
	}

	function setResType(value) {
		// :2073-2077 类型切换即 reset（清 cursor/items）
		setState({ resType: value, resCursor: null, resItems: [] });
	}

	// ---------- 勾选结论（S4-04b）----------
	function onTogglePick(m, on) {
		setState({ picks: togglePick(state.picks, m, on) }); // :718-727
	}
	function clearPick() {
		setState({ picks: [] }); // :742-747
	}

	// ---------- 压缩 / 还原（S3-04）----------
	async function compressConversation() {
		// :1189-1201
		if (!state.currentConversation) {
			toast("请先选择会话");
			return;
		}
		const confirmFn = dep("confirm");
		if (
			typeof confirmFn === "function" &&
			!confirmFn(
				"把当前会话较早的对话压缩成存档摘要？（原消息不删除，可随时还原）",
			)
		)
			return;
		try {
			toast("正在压缩…");
			const result = await api(
				"POST",
				`/api/conversations/${state.currentConversation.id}/compress`,
				{ expectedLastMessageId: lastLoadedMessageId },
			);
			toast(
				`已归档 ${result.coveredMessageIds.length} 条早期对话（估算 ${result.usageEstimate} tokens，真实占用以最近一次对话 usage 为准）`,
			);
			await renderServerHistory();
		} catch (e) {
			toast(`压缩失败：${messageOf(e)}`);
		}
	}

	async function restoreConversation() {
		// :1203-1212
		if (!state.currentConversation) return;
		try {
			const r = await api(
				"POST",
				`/api/conversations/${state.currentConversation.id}/compress/restore`,
			);
			toast(`已还原 ${r.restored} 条归档对话`);
			await renderServerHistory();
		} catch (e) {
			toast(`还原失败：${messageOf(e)}`);
		}
	}

	// ---------- legacy 本地历史导入 / 清理（:1215-1272）----------
	async function importLegacy() {
		try {
			const result = await api(
				"POST",
				"/api/conversations/import-legacy-agent",
				buildLegacyImportBody(state.legacyHistory), // :1240-1246
			);
			const conv = { id: result.conversationId, title: "导入的助手历史" }; // :1249-1250
			setState({
				legacyImported: true,
				conversations: [conv, ...state.conversations],
			});
			writeKey(LEGACY_IMPORTED_KEY, "1"); // :1248
			rememberConversation(conv);
			await renderServerHistory(); // :1252
			toast(
				result.duplicate
					? "该批次已导入过，已切换到对应会话"
					: `已导入 ${result.createdMessages} 条旧对话`,
			); // :1253
		} catch (e) {
			toast(`导入失败：${messageOf(e)}`); // :1258
		}
	}

	function cleanLocalLegacy() {
		// :1263-1272
		if (!state.legacyImported) return; // 未成功导入前不给清理口
		removeKey(HISTORY_KEY);
		removeKey(LEGACY_IMPORTED_KEY);
		setState({ legacyImported: false, legacyHistory: [] });
		toast("本地旧副本已清理（服务端历史不受影响）");
	}

	// ---------- 确认卡依赖面（AgentActionCard／AgentLiveRound 共用）----------
	function cardDeps() {
		return {
			fetchImpl: (url, init) => fetchImpl(url, init),
			toast: (m) => toast(m),
			forgetPending: (id) => forgetPendingStore(storage(), id), // :1300-1302
			onResume: (cid) => resumeAction(cid),
			pendingConversationId: (cid) =>
				pendingConversationIdOf(
					storage(),
					cid,
					state.currentConversation ? state.currentConversation.id : null,
				), // :1289-1296
			sessionId: sessionId, // :26-35
			rememberPending: (entry) => rememberPendingStore(storage(), entry), // :1297-1299
		};
	}

	// ---------- 流式消费（:1395-1518 的编排半，解析在 chat-event-hub）----------
	async function consumeStream(resp, round) {
		const acc = createRoundAccumulator();
		const out = await consumeAgentStream(resp, {
			onReasoningStart: () => pushOp(round, acc.onReasoningStart()),
			onReasoningDelta: (delta) => pushOp(round, acc.onReasoningDelta(delta)),
			onReasoningEnd: () => pushOp(round, acc.onReasoningEnd()),
			onDelta: (delta) => pushOp(round, acc.onDelta(delta)),
			onTextEnd: () => pushOp(round, acc.onTextEnd()),
			onToolCall: (tc) => pushOp(round, acc.onToolCall(tc)),
			onToolOutput: (to) =>
				pushOp(
					round,
					acc.onToolOutput(to, {
						conversationId: state.currentConversation
							? state.currentConversation.id
							: null,
					}),
				),
			onDone: (result) => pushOp(round, acc.onDone(result)),
			onError: (info) => toast(`助手出错：${info.message || "未知错误"}`), // :1494-1496
			onToolError: (info) => {
				pushOp(round, acc.onToolError(info)); // :1499-1506
				renderAgentRunCard(); // :1507
			},
		});
		if (out.run) lastRunSnapshot = out.run; // :1510
		return acc.result(out); // :1511-1517
	}

	// 幂等分流（:1828-1855／:1941-1968）：duplicate 且仍在跑 → 等待文案＋toast；
	// 非活跃 → 结束文案；其余 → 抛错走通用错误分支。
	// 等待面按 legacy 等值（整改三 F2）：signal 随本轮句柄（:1840／:1953）且 await 在本轮 try 内
	// ⇒ 等待期 sending/agentAbort 仍在位（停止钮在场，stop() 可中止等待并落「（已停止等待…）」，
	// :1845／:1958）；toast 在等待收尾后才发（:1848／:1961）。
	async function handleDuplicate(round, dup, resp, label, runAbort) {
		if (!dup?.duplicate) {
			throw new Error(
				(dup?.error && (dup.error.message || dup.error.code)) ||
					`${label}失败 ${resp.status}`,
			);
		}
		setTyping(round, null);
		const mid = label === "恢复" ? "续跑" : ""; // 「该[续跑]请求…」/「该[续跑]在另一窗口发生错误…」
		if (isActiveStatus(dup.status)) {
			pushOp(round, {
				kind: "bubble",
				text: `（该${mid}请求正在另一窗口进行，等待其结束…）`,
			});
			try {
				const fin = await waitRunEvents({
					runId: dup.runId,
					sessionKey: dup.sessionKey,
					signal: runAbort ? runAbort.signal : undefined, // :1840／:1953
					onEvent: (ev) => {
						if (ev.type === "error")
							pushOp(round, {
								kind: "bubble",
								text: `（该${mid}在另一窗口发生错误，等待收尾…）`,
							});
					},
				});
				pushOp(round, {
					kind: "bubble",
					text: `（该${mid}请求已在另一窗口${
						fin.status === "finished" ? "完成" : `结束：${fin.status}`
					}，请到发起窗口查看结果）`,
				});
			} catch (e) {
				if (isAbortError(e)) {
					// :1845／:1958：中止分支 legacy 为 `wb.textContent = …; return;`——提前收束，不落 toast。
					// 此刻另一窗口仍在处理中，「已在另一窗口处理」措辞失真（S5-9-X2 等值修正）。
					pushOp(round, {
						kind: "bubble",
						text: `（已停止等待另一窗口的${label === "恢复" ? "续跑" : "请求"}）`,
					});
					return "waited";
				}
				pushOp(round, {
					kind: "bubble",
					text: `（等待另一窗口${mid}结果失败：${messageOf(e)}，请到发起窗口查看）`,
				});
			}
			toast(`该${mid}请求已在另一窗口处理`); // :1851／:1964（等待收尾后；中止分支不达此处）
			return "waited";
		}
		pushOp(round, {
			kind: "bubble",
			text: `（该${mid}请求已在另一窗口结束，请到发起窗口查看结果）`,
		});
		toast(`该${mid}请求已在另一窗口处理`);
		return "done";
	}

	// :1807-1880 续跑（串行队列：嵌套确认时后一次等前一次流结束）
	async function runResume(cid) {
		setSending(true);
		const runAbort = createAbort();
		agentAbort = runAbort;
		setSending(true);
		const round = newRound(null, "助手正在继续…");
		addRound(round);
		scrollBottom();
		try {
			const resp = await fetchImpl(`/api/agent/actions/${cid}/resume`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					buildResumePayload({
						conversationId:
							pendingConversationIdOf(
								storage(),
								cid,
								state.currentConversation ? state.currentConversation.id : null,
							) || undefined, // :1824
						requestId: newRequestId("agent-resume"),
					}),
				),
				signal: runAbort.signal,
			});
			if (resp.ok && isJsonResponse(resp)) {
				let dup = null;
				try {
					dup = await resp.json();
				} catch (_e) {
					/* 落入通用错误（:1830） */
				}
				if (await handleDuplicate(round, dup, resp, "恢复", runAbort)) return;
			}
			if (!resp.ok) {
				let errData = null;
				try {
					errData = await resp.json();
				} catch (_e) {
					/* 忽略 */
				}
				throw new Error(
					(errData?.error && (errData.error.message || errData.error.code)) ||
						`恢复失败 ${resp.status}`,
				); // :1859
			}
			setTyping(round, null); // :1861 typing.remove()
			const result = await consumeStream(resp, round);
			lastRoundTools = result.tools || []; // :1863
			lastToolErrors = lastToolErrors.concat(result.toolErrors || []); // :1507 累积（legacy push 同效）
			renderAgentRunCard(); // :1864
			// :1865 停止气泡：真实链路 aborted 来自消费器；桩链路（流被直接关闭）由信号在位判
			if (result.aborted || runAbort.stopped())
				pushOp(round, { kind: "bubble", text: "（已停止生成）" });
		} catch (e) {
			setTyping(round, null);
			if (runAbort.stopped()) {
				pushOp(round, { kind: "bubble", text: "（已停止生成）" }); // :1870
			} else {
				pushOp(round, { kind: "bubble", text: `续跑出错了：${messageOf(e)}` }); // :1872
				toast(messageOf(e)); // :1873
			}
		} finally {
			setSending(false);
			if (agentAbort === runAbort) {
				agentAbort = null;
				setSending(false);
			}
		}
	}

	function resumeAction(cid) {
		// :1793-1798
		const run = () => runResume(cid);
		resumeChain = resumeChain.then(run, run);
		return resumeChain;
	}

	// :1883-2000 发送
	async function send() {
		if (sending) return; // :1884
		const content = String(state.text || "").trim();
		if (!content) return; // :1888
		setSending(true);
		// :1895-1905 先把会话准备好再渲染本轮气泡（newConversation 会清消息区）
		if (!state.currentConversation) {
			try {
				await newConversation();
			} catch (e) {
				setSending(false);
				toast(`新会话创建失败：${messageOf(e)}`); // :1902
				return;
			}
		}
		setState({ text: "" }); // :1906 input.value=''
		const runAbort = createAbort();
		agentAbort = runAbort;
		setSending(true);
		const round = newRound(content, "助手正在思考…"); // :1911-1919
		addRound(round);
		scrollBottom();
		try {
			const payload = buildSendPayload({
				scope: state.scope,
				mode: state.mode,
				conversationId: state.currentConversation.id,
				content: content,
				requestId: newRequestId("agent"),
				boundaryChapterId: state.boundaryChapterId,
			}); // :1924-1933
			const resp = await fetchImpl("/api/agent/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: runAbort.signal,
			});
			if (resp.ok && isJsonResponse(resp)) {
				let dup = null;
				try {
					dup = await resp.json();
				} catch (_e) {
					/* 落入通用错误（:1943） */
				}
				if (await handleDuplicate(round, dup, resp, "请求", runAbort)) return;
			}
			if (!resp.ok) {
				let errData = null;
				try {
					errData = await resp.json();
				} catch (_e) {
					/* 忽略 */
				}
				// :1972-1973 error 可能是 { code, message }：取 message/code，避免 [object Object]
				throw new Error(
					(errData?.error && (errData.error.message || errData.error.code)) ||
						`请求失败 ${resp.status}`,
				);
			}
			// :1975-1977 回执头带本轮模型标签
			const m = resp.headers.get("X-Agent-Model");
			if (m) setState({ modelText: decodeURIComponent(m) });
			setTyping(round, null); // :1978 typing.remove()
			const result = await consumeStream(resp, round);
			lastRoundTools = result.tools || []; // :1980
			lastToolErrors = lastToolErrors.concat(result.toolErrors || []); // :1507 累积（legacy push 同效）
			renderAgentRunCard(); // :1981
			// :1982 停止气泡（同 :1865 的双条件口径）
			if (result.aborted || runAbort.stopped())
				pushOp(round, { kind: "bubble", text: "（已停止生成）" });
		} catch (e) {
			setTyping(round, null);
			if (runAbort.stopped()) {
				pushOp(round, { kind: "bubble", text: "（已停止生成）" }); // :1988
			} else {
				pushOp(round, { kind: "bubble", text: `出错了：${messageOf(e)}` }); // :1990
				toast(messageOf(e)); // :1991
			}
		} finally {
			setSending(false);
			if (agentAbort === runAbort) {
				agentAbort = null;
				setSending(false);
			}
		}
	}

	function stop() {
		// :2051-2053
		if (agentAbort) agentAbort.stop("user");
	}

	// ---------- :2038-2130 页面入口 ----------
	async function show() {
		// :2039-2040 首启初始化：事件绑定在 AgentWorkspace 侧以 props 回调承接（原生非冒泡臂见 T5-5）
		state = { ...state, scope: readSavedScope(storage()) }; // :2117 入口重读范围
		await loadBooks(); // :2119
		// :152-156 记住的书已删除：明确回落全局，不猜一本书
		const so = scopeOptions(state.books, state.scope, storage());
		if (so.changed) setState({ scope: so.scope });
		await loadConversations(); // :2120
		normalizeResView(); // :2122 renderResourceTypes
		await loadBoundaryChapters(); // :2123
		await renderServerHistory(); // :2124
		rebuildPendingCards(); // :2127
		renderAgentRunCard(); // :2128
		// :2112 loadTools（列在编排尾：唯一差异是请求次序，面板渲染等价；记于 selfcheck）
		if (!toolsLoaded) {
			toolsLoaded = true;
			await loadTools();
		}
	}

	// 手交出口件（S5-8）需要在事件回调里拿到最新状态：以 getter 面封装
	function handoffCtx() {
		const bookId = state.scope.kind === "book" ? state.scope.bookId : null; // 目标书由弹窗内选定
		return {
			conversation: state.currentConversation,
			scope: state.scope,
			books: state.books,
			boundaryChapters: state.boundaryChapters,
			boundaryChapterId: state.boundaryChapterId,
			picks: state.picks,
			bookId: bookId,
			scopeTitle: scopeStatusText({
				scope: state.scope,
				books: state.books,
				currentConversation: state.currentConversation,
				boundaryChapters: state.boundaryChapters,
				boundaryChapterId: state.boundaryChapterId,
				mode: state.mode,
			}),
		};
	}

	function saveNote() {
		const h = handoffRef.current;
		if (!h) return;
		const ctx = handoffCtx();
		h.saveNote({
			conversation: ctx.conversation,
			scopeTitle: ctx.scopeTitle,
			picks: ctx.picks,
		}); // :767-806
	}
	function createHandoff() {
		const h = handoffRef.current;
		if (!h) return;
		h.createHandoff(handoffCtx()); // :941-965
	}

	return {
		subscribe,
		getSnapshot,
		drainOps,
		cardDeps,
		show,
		send,
		stop,
		resumeAction,
		switchScope,
		switchSideTab,
		selectConversation,
		newConversation: newConversationFromButton,
		toggleMode,
		setBoundary,
		setResType,
		setText: (text) => setState({ text: text }),
		loadResources,
		openResource,
		showPreview,
		onTogglePick,
		clearPick,
		compressConversation,
		restoreConversation,
		importLegacy,
		cleanLocalLegacy,
		saveNote,
		createHandoff,
	};
}

export function useAgentWorkspace(deps) {
	const depsRef = useRef(deps);
	depsRef.current = deps;
	// 手交 hook（S5-8 出口件）经 ref 让控制器在回调期读到最新出口面
	const handoffRef = useRef(null);
	const ctrlRef = useRef(null);
	if (!ctrlRef.current)
		ctrlRef.current = createAgentController(depsRef, handoffRef);
	const ctrl = ctrlRef.current;
	// S5-8 出口件：deps 以委托对象传入（挂载时建一次），deps.api 等在被替换后仍读到最新值
	const handoffDepsRef = useRef(null);
	if (!handoffDepsRef.current) {
		const d = () => depsRef.current || {};
		handoffDepsRef.current = {
			api: (...a) => d().api(...a),
			toast: (m) =>
				typeof d().toast === "function" ? d().toast(m) : undefined,
			escapeHtml: (s) => d().escapeHtml(s),
			openModal: (o) =>
				typeof d().openModal === "function" ? d().openModal(o) : undefined,
			closeModal: () =>
				typeof d().closeModal === "function" ? d().closeModal() : undefined,
			confirm: (m) =>
				typeof d().confirm === "function" ? d().confirm(m) : true,
			storage: {
				getItem: (k) => d().storage?.getItem(k) ?? null,
				setItem: (k, v) => d().storage?.setItem(k, v),
				removeItem: (k) => d().storage?.removeItem(k),
			},
		};
	}
	handoffRef.current = useAgentHandoff(handoffDepsRef.current);

	const subscribe = useCallback((cb) => ctrl.subscribe(cb), [ctrl]);
	const state = useSyncExternalStore(
		subscribe,
		() => ctrl.getSnapshot(),
		() => ctrl.getSnapshot(),
	);
	// 轮次先入 state、组件后挂载：挂载前的 op 缓冲在建树后排空（每次提交后执行，代价 O(轮次数)）
	useEffect(() => {
		ctrl.drainOps();
	});

	const cardDeps = ctrl.cardDeps();
	const scopeBars = scopeOptions(state.books, state.scope, null);
	const boundary = boundaryOptions(state.scope, state.boundaryChapters);
	const types = resourceTypesForScope(state.scope);
	const previewReturn =
		(deps?.readWritingReturn ? deps.readWritingReturn() : null) || null;

	const spaceProps = {
		// :2038-2130 ＋ S5-8 冻结 props 契约（Plan §5）
		topbar: {
			modelText: state.modelText,
			restoreHidden: !state.restoreVisible,
			returnHref: previewReturn ? `#/book/${previewReturn.bookId}` : "#/",
			returnHidden: !previewReturn,
			onCompress: () => ctrl.compressConversation(),
			onRestore: () => ctrl.restoreConversation(),
			onNewConversation: () => ctrl.newConversation(), // :2085-2089
		},
		scopeBar: {
			scopeOptions: scopeBars.options,
			scopeValue: scopeKey(state.scope),
			onScopeChange: (value) => ctrl.switchScope(value),
			conversationOptions: conversationOptions(
				state.conversations,
				state.scope,
				state.currentConversation,
			),
			conversationValue: state.currentConversation
				? state.currentConversation.id
				: "",
			onConversationChange: (id) => ctrl.selectConversation(id),
			boundaryOptions: boundary.options,
			boundaryValue:
				state.boundaryChapterId != null ? String(state.boundaryChapterId) : "",
			boundaryDisabled: boundary.disabled,
			onBoundaryChange: (value) =>
				ctrl.setBoundary(value ? Number(value) : null), // :2062-2065
			mode: modeButton(state.scope, state.mode),
			onToggleMode: () => ctrl.toggleMode(),
			statusText: scopeStatusText({
				scope: state.scope,
				books: state.books,
				currentConversation: state.currentConversation,
				boundaryChapters: state.boundaryChapters,
				boundaryChapterId: state.boundaryChapterId,
				mode: state.mode,
			}),
		},
		sidePanel: {
			tab: state.sideTab,
			onTabChange: (name) => ctrl.switchSideTab(name),
			conversations: state.conversations
				.filter((c) => conversationInScope(state.scope, c))
				.map((c) => ({
					id: c.id,
					title: c.title || "未命名会话",
					archived: c.status === "archived",
					scope: c.scope,
					active: !!(
						state.currentConversation && state.currentConversation.id === c.id
					),
				})),
			onSelectConversation: (id) => ctrl.selectConversation(id),
			emptyHint: CONVERSATION_EMPTY_HINT, // :212
			tools: state.tools,
			resources: {
				typeValue: state.resType,
				typeOptions: types.map((t) => ({
					value: t,
					label: RES_TYPE_LABELS[t] || t,
				})),
				hint: state.resHint,
				items: state.resItems.map(resourceRowModel),
				hasMore: !!state.resCursor,
				onTypeChange: (value) => {
					// :2073-2077 类型切换 reset（清 cursor/items）
					ctrl.setResType(value);
					ctrl.loadResources({ reset: true });
				},
				onRefresh: () => ctrl.loadResources({ reset: true }), // :2080
				onMore: () => ctrl.loadResources({}), // :2082
				onOpen: (item) => ctrl.openResource(item), // :389
			},
		},
		preview: {
			open: state.preview.open,
			loading: state.preview.loading,
			error: state.preview.error,
			model: state.preview.model,
			onClose: () => ctrl.showPreview(false), // :2084
			onSwitchScope: (value) => ctrl.switchScope(value), // :500
		},
		pickBar: {
			visible: state.picks.length > 0, // :707
			countText: pickCountText(state.picks.length), // :710
			disabled: !!(
				state.currentConversation &&
				state.currentConversation.status !== "active"
			), // :711-715
			onSaveNote: () => ctrl.saveNote(), // :2107
			onCreateHandoff: () => ctrl.createHandoff(), // :2109
			onClear: () => ctrl.clearPick(), // :2111
		},
		messages: {
			items: state.messages,
			picks: state.picks.map((p) => Number(p.id)),
			onTogglePick: (m, on) => ctrl.onTogglePick(m, on),
			// :1308-1338 重建的确认卡（过期只读在前、可操作在后）
			pendingSlot: state.pendingCards.length
				? state.pendingCards.map((pc) =>
						createElement(AgentActionCard, {
							key: pc.key,
							conf: pc.entry.conf,
							toolName: pc.entry.toolName,
							args: pc.entry.input,
							status: pc.status,
							deps: cardDeps,
						}),
					)
				: null,
			// :1911-1919／:1814-1818 实时轮次（每轮一个实例，收尾后保留到下次历史重绘）
			liveSlot: state.rounds.length
				? state.rounds.map((r) =>
						createElement(AgentLiveRound, {
							key: r.key,
							ref: r.apiRef,
							userText: r.userText,
							typingText: r.typingText,
							cardDeps: cardDeps,
						}),
					)
				: null,
		},
		composer: {
			value: state.text,
			onChange: (value) => ctrl.setText(value),
			onSubmit: () => ctrl.send(), // :2041-2044
			sending: state.sending, // :1891-1892
			stopVisible: state.stopVisible, // :1802-1805
			onStop: () => ctrl.stop(), // :2051-2053
		},
		// ⑦ 接入：legacy 本地历史条（:1215-1232 ＋ :2090-2093）
		legacyBar: {
			...legacyBarModel(state.legacyHistory, state.legacyImported),
			onImport: () => ctrl.importLegacy(),
			onClean: () => ctrl.cleanLocalLegacy(),
		},
	};

	return {
		spaceProps,
		show: ctrl.show,
		submit: ctrl.send, // Ctrl/Cmd+Enter 直挂监听用（AgentWorkspace.jsx）
		resumeAction: ctrl.resumeAction,
	};
}
