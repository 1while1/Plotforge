// S5-7（Plan §1.1 G6）：聊天页装配层——把 S5-6 `useChatTransport` 与五个纯逻辑 lib（G1~G5）
// 接成「命令式控制器＋React props 面」。语义唯一事实源＝public/legacy/book-chat.js 块三：
//   :1-63 会话存储/切换（经 chat-session）、:65-275 讨论与交接回跳（经 chat-handoff）、
//   :277-279 书内相对 api、:648-827 ctx 仪表/明细/压缩/还原（经 chat-context）、
//   :1583-1653 loadChat 编排、:1655-1842 世界/人物列表（经 chat-side-lists）、
//   :1853-1946 bindChatEvents（React 侧只剩左栏/模式这些 .panel-chat 之外的按钮＋挂载触发）、
//   :1948-2132 运行状态卡与轮询（经 chat-status）。
// 纪律（Plan §5）：组件内零 fetch（api 全经 window.App 注入面）、零 `window.BookPage` 写入、
// 零 localStorage 直读（经 chat-session 注入）、SSE 只走 S5-6 transport（本文件不碰 chat-event-hub）。
import {
	createElement,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { ChatExpiredBanner } from "../components/ChatExpiredBanner.jsx";
import { getApp } from "../lib/app-runtime.js";
import {
	BREAKDOWN_OK_TEXT,
	BREAKDOWN_TITLE,
	breakdownHTML,
	COMPRESS_OK_TEXT,
	COMPRESS_TITLE,
	COMPRESSING_TOAST,
	compressBodyHTML,
	compressRequest,
	compressToast,
	meterOf,
	restoreRequest,
	restoreToast,
} from "../lib/chat-context.js";
import {
	AGENT_CONVERSATION_KEY,
	AGENT_SCOPE_KEY,
	DISCUSS_OK_TOAST_PLAIN,
	DISCUSS_OK_TOAST_WITH_TEXT,
	discussBodyHTML,
	discussFailToast,
	discussionBody,
	handoffMaterial,
	handoffMessageBody,
	handoffScopeKey,
	loadHandoffCharacters,
	NO_ORIGIN_TOAST,
	ORIGIN_GONE_TOAST,
	ORIGIN_JUMP_TOAST,
	parseHandoffSource,
	pickCharacter,
	selectedEditorText,
} from "../lib/chat-handoff.js";
import { planActionReplay } from "../lib/chat-render.js";
import {
	bookApiPath,
	conversationQuery,
	createChatSession,
} from "../lib/chat-session.js";
import {
	CHARACTER_DELETE_CONFIRM,
	CHARACTER_NAME_REQUIRED_TOAST,
	characterFormValues,
	characterModalBodyHTML,
	characterModalTitle,
	characterSaveRequest,
	WORLD_DELETE_CONFIRM,
	WORLD_TITLE_REQUIRED_TOAST,
	worldFormValues,
	worldModalBodyHTML,
	worldModalTitle,
	worldSaveRequest,
} from "../lib/chat-side-lists.js";
import { createRunStatusController } from "../lib/chat-status.js";
import {
	clearContinuePreview,
	getContinuePreview,
	isContinuationCandidate,
	showContinuePreview,
} from "../lib/continue-preview.js";
import { getFocusState, setFocusChatOpen } from "../lib/focus-state.js";
import { runStatus } from "../lib/run-status.js";
import { getWritingPrefs } from "../lib/writing-prefs.js";
// P6-2 §2.5-D5：返回锚写入改为 BookShell 导出直取（原 `window.BookPage.saveWritingReturn`，
// legacy book-chat.js:177/:243-244 两点）。hooks→pages 的反向 import 仅**调用期**使用
// （saveWritingReturn 在函数体内调用），无顶层求值＝无 TDZ；该环与 BookShell→ChatWorkspace→hooks 同源。
import { saveWritingReturn } from "../pages/BookShell.jsx";
import { useChatTransport } from "./use-chat-transport.js";

const CLEAR_CONFIRM = "清空当前会话的对话记录？（同书其他写作会话不受影响）";

// 缺省注入源：**调用期**取 App 单例（P6-2 §2.5-D1；等值原 `window.App || globalThis.App`）。
// 调用期读取＝`runStatus.observeApi()` 的猴补对经本函数的 api 调用恒生效。
function legacyApp() {
	return getApp();
}

// :2084-2087 页面可见性（切后台只切展示态）
function pageVisible() {
	const doc = typeof document === "undefined" ? null : document;
	return doc?.visibilityState !== "hidden";
}

// ---------- 命令式控制器（挂载期创建一次；React 组件只做展示） ----------
// deps.mount ≙ ensureMounted（由 ChatWorkspace.jsx 注入，避免 hooks→components 反向 import）
export function createChatWorkspaceController(deps) {
	const d = deps || {};
	const mount = d.mount || (() => null);
	const doc = () => (typeof document === "undefined" ? null : document);
	const RS = () => runStatus;
	const getBookId =
		d.getBookId ||
		(() => {
			const app = legacyApp();
			return app?.state?.currentBook ? app.state.currentBook.id : null;
		});
	const getChapterId =
		d.getChapterId ||
		(() => {
			const app = legacyApp();
			return app?.state ? (app.state.currentChapterId ?? null) : null;
		});
	const storage =
		d.storage || (typeof localStorage === "undefined" ? null : localStorage);
	// :277-279 两种形态：api＝全路径（App.api 原样）、bookApi＝书内相对（补 /api/books/<bookId>）
	const api = (method, path, body) => {
		const app = legacyApp();
		if (!app || typeof app.api !== "function")
			return Promise.reject(new Error("api 未就绪"));
		return app.api(method, path, body);
	};
	const bookApi = (method, path, body) =>
		api(method, bookApiPath(getBookId(), path), body);
	const toast = (msg) => {
		const app = legacyApp();
		if (app && typeof app.toast === "function") app.toast(msg);
	};
	const escapeHtml = (s) => {
		const app = legacyApp();
		return app && typeof app.escapeHtml === "function"
			? app.escapeHtml(s)
			: String(s == null ? "" : s);
	};
	const openModal = (cfg) => {
		const app = legacyApp();
		return app && typeof app.openModal === "function"
			? app.openModal(cfg)
			: null;
	};

	// ---------- 状态（不可变快照：React 经 useSyncExternalStore 订阅） ----------
	let state = {
		conversations: [],
		currentConversationId: null,
		messages: [],
		pendingActions: [],
		expired: [],
		expiredOverflow: 0,
		meter: null,
		world: [],
		characters: [],
		lastLoadedMessageId: null,
		consultLog: [],
		chapterContext: { status: "idle", chapterId: null, data: null },
		previewContent: null,
	};
	const listeners = new Set();
	function getState() {
		return state;
	}
	function setState(patch) {
		state = { ...state, ...patch };
		for (const cb of listeners) cb();
	}
	function subscribe(cb) {
		listeners.add(cb);
		return () => listeners.delete(cb);
	}

	// ---------- :1-63 会话（经 G1 lib） ----------
	const session = createChatSession({
		getBookId,
		storage,
		api,
		toast,
		loadChat: () => loadChat(),
		refreshCtxMeter: () => refreshCtxMeter(null),
		onConversations: (list) =>
			setState({
				conversations: list,
				currentConversationId: session.currentConversationId(),
			}),
	});
	function currentConversationId() {
		return session.currentConversationId();
	}

	// ---------- :1948-2132 运行状态（经 G4 lib；宿主＝叶容器 #writing-run-card） ----------
	const status = createRunStatusController({
		RS,
		host: () => doc()?.getElementById("writing-run-card") || null,
		api,
		toast,
		getBookId,
		getChapterId,
		getConversationId: currentConversationId,
		pageVisible,
		// P6-2 §2.5-D3：编辑器三点经 `chapterEditorApi()` 直取（等值原 `window.BookPage.*`；
		// hasUnsavedChanges/loadChapters 不在 P6-1 刷新名单，selectChapter 经 api 自带刷新）
		hasUnsavedChanges: () => chapterEditorApi().hasUnsavedChanges(),
		selectChapter: (cid) => chapterEditorApi().selectChapter(cid),
		loadChapters: () => chapterEditorApi().loadChapters(),
		loadCharacters: () => loadCharacters(),
		loadWorld: () => loadWorld(),
	});

	// legacy :2120-2122 同款订阅（每控制器一次；RunStatus 缺失即静默）
	if (typeof RS()?.onVisibilityChange === "function") {
		RS().onVisibilityChange(() => {
			status.setStatusPollingVisible(pageVisible());
		});
	}

	// ---------- :1583-1653 loadChat ----------
	async function loadChat() {
		const preview = getContinuePreview();
		if (preview && preview.bookId !== getBookId()) {
			clearContinuePreview();
			setState({ previewContent: null });
		}
		loadConsultLog();
		try {
			const data = await bookApi(
				"GET",
				`/chat${conversationQuery(currentConversationId())}`,
			);
			if (
				data.conversationId &&
				data.conversationId !== currentConversationId()
			) {
				await session.rememberConversation(data.conversationId);
			}
			const msgs = Array.isArray(data.messages) ? data.messages : [];
			let actions = [];
			try {
				const act = await bookApi("GET", "/chat/actions");
				actions = Array.isArray(act.actions) ? act.actions : [];
			} catch (_e) {
				/* 动作列表拉取失败不影响会话渲染（:1640） */
			}
			// :1615-1640 回放：pending 卡（同参去重留最新）＋结算卡收编为锚点消息下的留痕行
			const replay = planActionReplay(msgs, actions);
			const logsByAnchor = new Map();
			for (const row of replay.logs) {
				const list = logsByAnchor.get(row.anchorMessageId) || [];
				list.push(row.action);
				logsByAnchor.set(row.anchorMessageId, list);
			}
			setState({
				messages: msgs.map((m) => ({
					...m,
					actionLogs: logsByAnchor.get(m.id) || [],
				})),
				pendingActions: replay.pending
					.filter((p) => !p.dropKey)
					.map((p) => p.action),
				expired: Array.isArray(data.expiredActions) ? data.expiredActions : [],
				expiredOverflow: data.expiredActionsOverflow || 0,
				lastLoadedMessageId: msgs.length ? msgs[msgs.length - 1].id : null,
			});
			await status.refreshRunStatus({ messages: msgs });
			status.setStatusPollingVisible(pageVisible());
			// :1646-1648 首屏也要能看到「当前写作会话」
			await session.refreshConversations();
			await refreshCtxMeter(null);
		} catch (e) {
			toast(e?.message);
		}
	}

	// :672-702 仪表（失败不影响聊天）
	async function refreshCtxMeter(usage) {
		try {
			const st = await bookApi(
				"GET",
				`/context-status${conversationQuery(currentConversationId())}`,
			);
			setState({ meter: meterOf(st, usage) });
		} catch (_e) {
			/* 仪表失败不影响聊天（:701） */
		}
	}

	// :706-794 明细弹窗
	async function openCtxBreakdown() {
		if (!getBookId()) return;
		try {
			const cidQ = conversationQuery(currentConversationId());
			const cid = getChapterId();
			const q =
				(cid ? `?chapterId=${cid}` : cidQ) +
				(cid && cidQ ? cidQ.replace("?", "&") : "");
			const data = await bookApi("GET", `/context-breakdown${q}`);
			const built = breakdownHTML(data);
			openModal({
				title: BREAKDOWN_TITLE,
				okText: BREAKDOWN_OK_TEXT,
				bodyHTML: built.bodyHTML,
				onOk: () => true,
			});
		} catch (e) {
			toast(e?.message);
		}
	}

	// :796-817 压缩
	function compressContext() {
		openModal({
			title: COMPRESS_TITLE,
			okText: COMPRESS_OK_TEXT,
			bodyHTML: compressBodyHTML(),
			onOk: async () => {
				try {
					toast(COMPRESSING_TOAST);
					const req = compressRequest(
						currentConversationId(),
						state.lastLoadedMessageId,
					);
					const data = await bookApi(req.method, req.path, req.body);
					toast(compressToast(data.archived));
					await loadChat();
				} catch (e) {
					toast(e?.message);
					return false;
				}
				return undefined;
			},
		});
	}

	// :819-827 还原压缩前的对话
	async function restoreContext() {
		try {
			const req = restoreRequest(currentConversationId());
			const data = await bookApi(req.method, req.path, req.body);
			toast(restoreToast(data.restored));
			await loadChat();
		} catch (e) {
			toast(e?.message);
		}
	}

	// :121-197 另开整体讨论
	async function openAgentDiscussion() {
		const app = legacyApp();
		if (!getBookId()) return;
		// P6-2 §2.5-D3：编辑器脏态守卫经 api 直取（真值守卫移除＝不可达差异备案：api 恒有该三方法）
		if (chapterEditorApi().hasUnsavedChanges()) {
			const canLeave = await chapterEditorApi().leaveGuard({
				onRetry: () => openAgentDiscussion(),
				onDiscard: () => {
					chapterEditorApi().clearUnsaved();
					openAgentDiscussion();
				},
			});
			if (!canLeave) return; // 留在本章：不交接、不跳转（:131）
		}
		const book = app.state.currentBook;
		const chapterId = getChapterId();
		const titleInput = doc()?.getElementById("chapter-title-input");
		const chapter = chapterId
			? { id: chapterId, title: titleInput?.value || "" }
			: null;
		const characters = await loadHandoffCharacters(getBookId(), api);
		const selected = selectedEditorText(doc());
		openModal({
			title: "另开整体讨论（AI 助手）",
			okText: "前往 AI 助手",
			bodyHTML: discussBodyHTML({
				book,
				chapter,
				characters,
				selected,
				escapeHtml,
			}),
			onOk: async (body) => {
				const quoteEl = body?.querySelector
					? body.querySelector("#agent-discuss-quote")
					: null;
				const charEl = body?.querySelector
					? body.querySelector("#agent-discuss-character")
					: null;
				const character = charEl
					? pickCharacter(characters, charEl.value)
					: null;
				const includeText = !!(selected && (!quoteEl || quoteEl.checked));
				try {
					const conv = await api(
						"POST",
						"/api/conversations",
						discussionBody(book, chapter, character),
					);
					if (includeText) {
						const msg = handoffMessageBody(book, chapter, character, selected);
						await api(
							"POST",
							`/api/conversations/${encodeURIComponent(conv.id)}/messages`,
							msg,
						);
					}
					try {
						localStorage.setItem(AGENT_SCOPE_KEY, `book:${book.id}`);
						localStorage.setItem(AGENT_CONVERSATION_KEY, conv.id);
					} catch (_e) {
						/* 存储不可用：Agent 台退回自己的范围（:176） */
					}
					// P6-2 §2.5-D5：返回锚写入＝BookShell 导出直取（真值守卫移除＝不可达差异备案：
					// 模块导出恒在，且 saveWritingReturn 自身不依赖壳挂载）
					saveWritingReturn({ bookId: book.id, chapterId });
					location.hash = "#/agent";
					toast(
						includeText ? DISCUSS_OK_TOAST_WITH_TEXT : DISCUSS_OK_TOAST_PLAIN,
					);
					return true;
				} catch (e) {
					toast(discussFailToast(e?.message));
					return false;
				}
			},
		});
		// :189-196 选定人物后预览来源行同步更新（真实 DOM；拿不到节点即保持无人物预览）
		const modalBody = doc()?.getElementById("modal-body");
		const charSel = modalBody?.querySelector
			? modalBody.querySelector("#agent-discuss-character")
			: null;
		const preview = modalBody?.querySelector
			? modalBody.querySelector("#agent-discuss-preview")
			: null;
		if (charSel && preview && selected) {
			charSel.onchange = () => {
				preview.textContent = handoffMaterial(
					book,
					chapter,
					pickCharacter(characters, charSel.value),
					selected,
				);
			};
		}
	}

	// :223-248 交接消息来源回跳
	async function openHandoffOrigin(info) {
		if (!info?.originConversationId) {
			toast(NO_ORIGIN_TOAST);
			return;
		}
		let list = [];
		try {
			list = await api("GET", "/api/conversations?kind=agent");
		} catch (_e) {
			list = [];
		}
		let origin = null;
		for (const conv of Array.isArray(list) ? list : []) {
			if (conv.id === info.originConversationId) origin = conv;
		}
		if (!origin) {
			toast(ORIGIN_GONE_TOAST);
			return;
		}
		try {
			localStorage.setItem(AGENT_SCOPE_KEY, handoffScopeKey(origin));
			localStorage.setItem(AGENT_CONVERSATION_KEY, origin.id);
		} catch (_e) {
			/* 存储不可用：跳转本身仍然发生（:242） */
		}
		// P6-2 §2.5-D5：同上（BookShell 导出直取，守卫移除＝不可达差异备案）
		saveWritingReturn({ bookId: getBookId(), chapterId: getChapterId() });
		location.hash = "#/agent";
		toast(ORIGIN_JUMP_TOAST);
	}

	// :963-973 插入到当前章节。legacy 只改 value、不派发 input：编辑器脏标记与 3 秒自动保存都不触发，
	// 状态条仍显示「已保存」，切章/关页会丢掉插入的内容——这里补派发 input（与手打同一条保存链）。
	function insertToChapter(content) {
		if (!getChapterId()) {
			toast("请先在左侧选择一个章节");
			return;
		}
		const c = doc()?.getElementById("chapter-content");
		if (!c) return;
		c.value += `\n\n${content}`;
		const wc = doc()?.getElementById("word-count");
		if (wc) wc.textContent = `共 ${c.value.replace(/\s/g, "").length} 字`;
		c.dispatchEvent(new Event("input", { bubbles: true }));
		toast("已插入，停笔 3 秒后自动保存");
	}

	// 参谋问答不进服务端会话（/consult 不落库），单独按书存本机，供「参谋」标签回看
	const CONSULT_LOG_PREFIX = "mozhen.consult-log.v1.";
	const CONSULT_LOG_MAX = 60;
	function consultLogKey() {
		const bid = getBookId();
		return bid == null ? null : `${CONSULT_LOG_PREFIX}${bid}`;
	}
	function loadConsultLog() {
		const key = consultLogKey();
		let list = [];
		try {
			const raw = key && storage ? storage.getItem(key) : null;
			const parsed = raw ? JSON.parse(raw) : [];
			list = Array.isArray(parsed) ? parsed : [];
		} catch (_e) {
			list = [];
		}
		setState({ consultLog: list });
	}
	function saveConsultLog(list) {
		const key = consultLogKey();
		if (!key || !storage) return;
		try {
			storage.setItem(key, JSON.stringify(list));
		} catch (_e) {
			/* 配额满或隐私模式：本次会话照常显示 */
		}
	}
	let consultSeq = 0;
	function appendConsult(msg) {
		consultSeq += 1;
		const entry = {
			id: `consult-${Date.now()}-${consultSeq}`,
			role: msg.role === "consultant" ? "consultant" : "user",
			content: msg.content || "",
			reasoning: msg.reasoning || "",
			retrieval: msg.retrieval || null,
			chapterId: getChapterId(),
			at: Date.now(),
		};
		const list = [...state.consultLog, entry].slice(-CONSULT_LOG_MAX);
		setState({ consultLog: list });
		saveConsultLog(list);
	}
	function clearConsultLog() {
		if (!window.confirm("清空本书的参谋记录？（只存在本机，清空后无法恢复）"))
			return;
		setState({ consultLog: [] });
		saveConsultLog([]);
	}

	// 「本章上下文」标签：与明细弹窗同一接口，按当前章组装（不调 LLM）
	let contextSeq = 0;
	async function loadChapterContext() {
		if (!getBookId()) return;
		const cid = getChapterId();
		if (!cid) {
			setState({
				chapterContext: { status: "no-chapter", chapterId: null, data: null },
			});
			return;
		}
		contextSeq += 1;
		const seq = contextSeq;
		setState({
			chapterContext: {
				status: "loading",
				chapterId: cid,
				data:
					state.chapterContext.chapterId === cid
						? state.chapterContext.data
						: null,
			},
		});
		try {
			const conv = conversationQuery(currentConversationId()).replace("?", "&");
			const data = await bookApi(
				"GET",
				`/context-breakdown?chapterId=${cid}${conv}`,
			);
			if (seq !== contextSeq) return;
			setState({ chapterContext: { status: "ready", chapterId: cid, data } });
		} catch (e) {
			if (seq !== contextSeq) return;
			setState({
				chapterContext: {
					status: "error",
					chapterId: cid,
					data: null,
					error: e?.message || "加载失败",
				},
			});
		}
	}

	// 「正文内预览」呈现：本轮新到的续写型回复交给编辑区预览，作者接受后才写入正文
	const REWRITE_PROMPT = "重写刚才这段续写：情节走向不变，换一种写法。";
	// 专注写作时聊天记录收起，续写只能落在正文里看，所以不论续写方式设置都走预览
	function offerContinuePreview(msg, id) {
		if (getWritingPrefs().continueStyle !== "inline" && !getFocusState().active)
			return false;
		if (!isContinuationCandidate(msg)) return false;
		const chapterId = getChapterId();
		if (!chapterId) return false;
		const content = String(msg.content).trim();
		showContinuePreview({
			id,
			bookId: getBookId(),
			chapterId,
			content,
			accept: () => {
				insertToChapter(content);
				clearContinuePreview(id);
				setState({ previewContent: null });
			},
			discard: () => {
				clearContinuePreview(id);
				setState({ previewContent: null });
			},
			rewrite: () => {
				clearContinuePreview(id);
				setState({ previewContent: null });
				if (transport && typeof transport.sendText === "function")
					transport.sendText(REWRITE_PROMPT);
			},
		});
		setState({ previewContent: content });
		return true;
	}
	function locatePreview() {
		const el = doc()?.querySelector("#page-book .continue-preview");
		if (el && typeof el.scrollIntoView === "function")
			el.scrollIntoView({ block: "center", behavior: "smooth" });
	}

	// :871-1046 appendMsg 的状态面（DOM 由 ChatMessageList 渲染；流中提交与回放同源）
	let localSeq = 0;
	function appendMessage(msg, opts) {
		if (msg?.role === "consultant" || opts?.consult) {
			appendConsult(msg);
			if (getFocusState().active && msg?.role !== "user")
				setFocusChatOpen(true);
			return;
		}
		localSeq += 1;
		const patch = {
			messages: [...state.messages, { ...msg, id: `live-${localSeq}` }],
		};
		// legacy commitLive（:1231-1238）把流内「工具块/确认卡」节点迁移进正式消息——React 侧以
		// pendingActions 槽承接（与 loadChat 的 planActionReplay 回放槽同源、按 id 去重）：本轮
		// 收到的 action 事件在收尾（live 槽卸载）后仍留在消息区，可直接结算；不迁移则卡只在实时
		// 气泡里存在，随 live 槽一起消失（真实渠道 S5-7-real-r1 判据③复现）。
		const incoming = Array.isArray(msg?.actions) ? msg.actions : [];
		if (incoming.length) {
			const seen = new Set(state.pendingActions.map((a) => a?.id));
			const merged = state.pendingActions.slice();
			for (const a of incoming) {
				if (a?.id && !seen.has(a.id)) {
					seen.add(a.id);
					merged.push(a);
				}
			}
			patch.pendingActions = merged;
		}
		setState(patch);
		const previewed = offerContinuePreview(msg, `live-${localSeq}`);
		// 专注时没进正文预览的回复（提问、确认卡、报错）要让作者看见：展开输入栏上方的回复面板
		if (!previewed && msg?.role !== "user" && getFocusState().active)
			setFocusChatOpen(true);
	}

	// :1912-1921 清空当前会话
	function clearChat() {
		if (!window.confirm(CLEAR_CONFIRM)) return;
		bookApi("DELETE", `/chat${conversationQuery(currentConversationId())}`)
			.then(loadChat)
			.catch((e) => toast(e?.message));
	}

	// ---------- :1655-1842 世界/人物（列表数据进 controller，DOM 由两个 panel portal 渲染） ----------
	async function loadWorld() {
		if (!doc()?.getElementById("world-list")) return;
		try {
			const data = await bookApi("GET", "/world");
			setState({ world: Array.isArray(data.entries) ? data.entries : [] });
		} catch (e) {
			toast(e?.message);
		}
	}

	async function loadCharacters() {
		if (!doc()?.getElementById("character-list")) return;
		try {
			const data = await bookApi("GET", "/characters");
			setState({
				characters: Array.isArray(data.characters) ? data.characters : [],
			});
		} catch (e) {
			toast(e?.message);
		}
	}

	function worldModal(entry) {
		const e = entry || {};
		openModal({
			title: worldModalTitle(e),
			bodyHTML: worldModalBodyHTML(e, escapeHtml),
			onOk: async () => {
				const values = worldFormValues(doc());
				if (!values.title) {
					toast(WORLD_TITLE_REQUIRED_TOAST);
					return false;
				}
				try {
					const req = worldSaveRequest(e, values);
					await bookApi(req.method, req.path, req.body);
					await loadWorld();
				} catch (err) {
					toast(err?.message);
					return false;
				}
				return undefined;
			},
		});
	}

	function characterModal(c) {
		const ch = c || {};
		openModal({
			title: characterModalTitle(ch),
			bodyHTML: characterModalBodyHTML(ch, escapeHtml),
			onOk: async () => {
				const values = characterFormValues(doc());
				if (!values.name) {
					toast(CHARACTER_NAME_REQUIRED_TOAST);
					return false;
				}
				try {
					const req = characterSaveRequest(ch, values);
					await bookApi(req.method, req.path, req.body);
					await loadCharacters();
				} catch (err) {
					toast(err?.message);
					return false;
				}
				return undefined;
			},
		});
	}

	function deleteWorldEntry(entry) {
		if (!window.confirm(WORLD_DELETE_CONFIRM)) return;
		bookApi("DELETE", `/world/${entry.id}`)
			.then(loadWorld)
			.catch((e) => toast(e?.message));
	}

	function deleteCharacter(c) {
		if (!window.confirm(CHARACTER_DELETE_CONFIRM)) return;
		bookApi("DELETE", `/characters/${c.id}`)
			.then(loadCharacters)
			.catch((e) => toast(e?.message));
	}

	// :1844-1851 写作模式按钮（.panel-chat 之外的静态壳按钮 → 命令式绑定）
	function refreshModeBtn() {
		const b = doc()?.getElementById("btn-mode");
		const app = legacyApp();
		if (!b || !app?.state?.currentBook) return;
		const collab = app.state.currentBook.mode !== "direct";
		b.textContent = collab ? "协作模式" : "直接写模式";
		b.classList.toggle("mode-on", collab);
	}

	// :1853-1946：React 侧只剩「挂载触发＋左栏/模式按钮」这些静态壳节点的绑定
	// （表单/Ctrl+Enter/参谋/清空/压缩/会话切换/讨论/明细已在 React props 面）
	function bindChatEvents() {
		mount(); // 挂载由桩委托的 bindChatEvents 触发（Plan §5 纪律 1）
		const worldBtn = doc()?.getElementById("btn-add-world");
		if (worldBtn) worldBtn.onclick = () => worldModal(null);
		const charBtn = doc()?.getElementById("btn-add-character");
		if (charBtn) charBtn.onclick = () => characterModal(null);
		const modeBtn = doc()?.getElementById("btn-mode");
		if (modeBtn) {
			refreshModeBtn();
			modeBtn.onclick = async () => {
				const app = legacyApp();
				if (!app?.state?.currentBook) return;
				const next =
					app.state.currentBook.mode === "direct" ? "collab" : "direct";
				try {
					await api("PUT", `/api/books/${app.state.currentBook.id}`, {
						mode: next,
					});
					app.state.currentBook.mode = next;
					refreshModeBtn();
					toast(
						next === "collab"
							? "协作模式：AI 拿不准会主动问你"
							: "直接写模式：AI 直接成文",
					);
				} catch (e) {
					toast(e?.message);
				}
			};
		}
		return undefined;
	}

	// S5-6 传输句柄（由 useChatWorkspace 在布局期接上；续跑/快捷回复共用同一实例）
	let transport = null;
	function attachTransport(t) {
		transport = t;
	}
	function resumeAction(id) {
		if (transport && typeof transport.resumeAction === "function") {
			transport.resumeAction(id);
		}
	}

	let visibilityBound = false;
	function startVisibilitySync() {
		if (visibilityBound || typeof document === "undefined") return;
		visibilityBound = true;
		// :2108-2122 切后台只切展示态（与 RunStatus.onVisibilityChange 同款口径，幂等）
		document.addEventListener("visibilitychange", onVisibilityChange);
	}
	function stopVisibilitySync() {
		if (!visibilityBound || typeof document === "undefined") return;
		visibilityBound = false;
		document.removeEventListener("visibilitychange", onVisibilityChange);
	}
	function onVisibilityChange() {
		status.setStatusPollingVisible(pageVisible());
	}

	return {
		// ---- React 面 ----
		subscribe,
		getState,
		appendMessage,
		attachTransport,
		startVisibilitySync,
		stopVisibilitySync,
		// ---- 命令面（11 名桥的落点） ----
		loadChat,
		loadWorld,
		loadCharacters,
		bindChatEvents,
		currentConversationId,
		openAgentDiscussion,
		openHandoffOrigin,
		refreshRunStatus: (opts) => status.refreshRunStatus(opts),
		renderRunCard: () => status.renderRunCard(),
		renderCardModel: () => status.renderCardModel(),
		setStatusPollingVisible: (on) => status.setStatusPollingVisible(on),
		syncRunWatcher: () => status.syncRunWatcher(),
		refreshAfterWriteFor: (name, args) =>
			status.refreshAfterWriteFor(name, args),
		resumeAction,
		// ---- 面板/列表交互 ----
		switchConversation: (id) => session.switchConversation(id),
		newWritingConversation: () => session.newWritingConversation(),
		refreshCtxMeter,
		openCtxBreakdown,
		compressContext,
		restoreContext,
		insertToChapter,
		clearChat,
		clearConsultLog,
		loadChapterContext,
		locatePreview,
		worldModal,
		characterModal,
		deleteWorldEntry,
		deleteCharacter,
		// ---- 其余读面 ----
		getBookId,
		getChapterId,
		bookApi,
		toast,
		parseHandoffSource,
	};
}

// ---------- React 绑定 ----------
export function useChatWorkspace(controller) {
	const subscribe = useCallback((cb) => controller.subscribe(cb), [controller]);
	const getSnapshot = useCallback(() => controller.getState(), [controller]);
	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	const scrollRef = useRef(null);
	const [submitting, setSubmitting] = useState(false);
	// 参谋问题在发送时同步提交，按当时的参谋开关分流到参谋记录（回复本身带 consultant 角色）
	const consultNowRef = useRef(false);
	const cardProps = {
		bookId: controller.getBookId(),
		onSettled: (name, args) => controller.refreshAfterWriteFor(name, args),
		resume: (id) => controller.resumeAction(id),
	};

	const t = useChatTransport({
		api: (method, path, body) => controller.bookApi(method, path, body),
		toast: (msg) => controller.toast(msg),
		getBookId: () => controller.getBookId(),
		getChapterId: () => controller.getChapterId(),
		getConversationId: () => controller.currentConversationId(),
		onAppendMessage: (msg) =>
			controller.appendMessage(msg, { consult: consultNowRef.current }),
		onRefreshRunStatus: (payload) => controller.refreshRunStatus(payload),
		onSyncWatcher: () => controller.syncRunWatcher(),
		onReload: () => controller.loadChat(),
		onMeter: (usage) => controller.refreshCtxMeter(usage),
		scrollTarget: scrollRef,
		cardProps,
	});
	consultNowRef.current = !!t.consult;

	useLayoutEffect(() => {
		controller.attachTransport(t.transport);
		controller.startVisibilitySync();
		return () => controller.stopVisibilitySync();
	}, [controller, t.transport]);

	// :1048-1090 发送三态：提交期 disabled＋文案「思考中…」/「参谋思考中…」，结束复位「发送」
	const busy = !!t.streaming || submitting;
	const sendLabel = busy ? (t.consult ? "参谋思考中…" : "思考中…") : "发送";
	const onSend = () => {
		const pending = t.onSend();
		if (!pending || typeof pending.then !== "function") return pending;
		setSubmitting(true);
		return pending.finally(() => setSubmitting(false));
	};

	return {
		state,
		composer: { ...t.composer, onSend, disabled: busy, sendLabel },
		banners: state.expired.length
			? createElement(ChatExpiredBanner, {
					bookId: controller.getBookId(),
					expired: state.expired,
					overflow: state.expiredOverflow,
				})
			: null,
		live: t.live,
		typing: t.typing ?? null,
		cardProps,
		scrollRef,
		transport: t.transport,
	};
}
