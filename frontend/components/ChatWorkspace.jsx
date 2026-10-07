// S5-7（Plan §1.1 G6）：聊天页挂载件——把 React 树**原位**渲染进 `#page-book .panel-chat`
// （index.html:136-168 静态壳 id/class/文案零改、不新增 wrapper、不产生双份 id），并把 11 名
// 旧名 API（legacy `BookPage.<name>` 赋值 :2124-2132）供给 `window.MozhenBookChat` 桥。
// 挂载触发唯一入口＝桩委托命中的 `bindChatEvents`（Plan §5 纪律 1）；`ensureMounted()` 幂等、
// 缺容器 no-op，并在建 root 前先拆掉 registerLegacyBridges→mountChatJumpBottom 在静态壳上留下的
// 悬挂 root（Plan §5 纪律 8）。
// 纪律：本文件零 fetch、零 `window.BookPage` 写入（只有 `el.__mozhenChatRoot` 元素级缓存）。
import {
	createElement,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
	createChatWorkspaceController,
	useChatWorkspace,
} from "../hooks/use-chat-workspace.js";
import {
	getFocusState,
	setFocusChatOpen,
	subscribeFocusState,
} from "../lib/focus-state.js";
import { withWritingStatusRefresh } from "../pages/BookShell.jsx";
import {
	getEditorMetaSnapshot,
	subscribeEditorMeta,
} from "./ChapterEditorPanel.jsx";
import { CharacterListPanel } from "./CharacterListPanel.jsx";
import { ChatActionCard } from "./ChatActionCard.jsx";
import {
	ChapterContextPane,
	ConsultPane,
	ContinueStyleMenu,
} from "./ChatAiPanes.jsx";
import { unmount as unmountChatJumpBottom } from "./ChatJumpBottom.jsx";
import { ChatPanel } from "./ChatPanel.jsx";
import { ChatToolEventBlock } from "./ChatToolEventBlock.jsx";
import { WorldListPanel } from "./WorldListPanel.jsx";

// 桥面 11 名（legacy :2124-2132 赋值面逐名对应；顺序与 T6 G-A/G-B 清单一致）
export const CHAT_API_NAMES = [
	"openAgentDiscussion",
	"setStatusPollingVisible",
	"refreshRunStatus",
	"renderRunCard",
	"loadChat",
	"loadWorld",
	"loadCharacters",
	"bindChatEvents",
	"currentWritingConversationId",
	"renderActionCard",
	"renderToolEvent",
];

// 渲染器导出（阅读页复用面，≙ :2131-2132）：脱离挂载也能产出 DOM 节点
function renderDetached(element) {
	const host = document.createElement("div");
	const root = createRoot(host);
	flushSync(() => root.render(element));
	return host.firstElementChild;
}

// ≙ legacy renderActionCard(a, opts) 的默认口径（:479-480：onSettled→refreshAfterWrite、resume→resumeAfterConfirm）
function actionCardElement(controller, action, opts) {
	const o = opts || {};
	return createElement(ChatActionCard, {
		...o,
		action,
		bookId: o.bookId == null ? controller.getBookId() : o.bookId,
		onSettled:
			o.onSettled ||
			((name, args) => controller.refreshAfterWriteFor(name, args)),
		resume: o.resume || ((id) => controller.resumeAction(id)),
	});
}

function buildApi(controller) {
	return {
		openAgentDiscussion: () => controller.openAgentDiscussion(),
		setStatusPollingVisible: (on) => controller.setStatusPollingVisible(on),
		refreshRunStatus: (opts) => controller.refreshRunStatus(opts),
		renderRunCard: () => controller.renderRunCard(),
		// P6-1：只包 loadChat（＝名义入口 loadChat 在 React 侧的落点，等值已退役的
		// wrapStatusRefresh 链）。内部调用（切会话/新开会话/压缩/还原/传输收尾）不经此处，
		// 今日不刷——不得把刷新塞进 controller.loadChat 函数体（Plan §2.3／§2.5 注 3）。
		loadChat: withWritingStatusRefresh(controller.loadChat),
		loadWorld: () => controller.loadWorld(),
		loadCharacters: () => controller.loadCharacters(),
		bindChatEvents: () => controller.bindChatEvents(),
		currentWritingConversationId: () => controller.currentConversationId(),
		renderActionCard: (action, opts) =>
			renderDetached(actionCardElement(controller, action, opts)),
		renderToolEvent: (event) =>
			renderDetached(createElement(ChatToolEventBlock, { event })),
	};
}

// 未挂载时的只读占位面（▸ 桩在缺挂载面被调用时不得抛：T6 G-B-4 同款口径）
const NULL_API = {
	async loadChat() {},
	async loadWorld() {},
	async loadCharacters() {},
	bindChatEvents() {},
	currentWritingConversationId() {
		return null;
	},
	async openAgentDiscussion() {},
	async refreshRunStatus() {
		return null;
	},
	renderRunCard() {
		return null;
	},
	setStatusPollingVisible() {
		return null;
	},
	renderActionCard: (action, opts) =>
		renderDetached(createElement(ChatActionCard, { ...(opts || {}), action })),
	renderToolEvent: (event) =>
		renderDetached(createElement(ChatToolEventBlock, { event })),
};

function ChatWorkspace({ controller }) {
	const ws = useChatWorkspace(controller);
	const state = ws.state;
	const [tab, setTab] = useState("chat");
	const consultOn = !!ws.composer.consult;
	// 「参谋」标签与输入框上的参谋开关是同一个状态的两个入口：切标签即切开关，反之亦然
	const onTabChange = (next) => {
		setTab(next);
		if ((next === "consult") !== consultOn && next !== "context")
			ws.composer.onToggleConsult?.();
	};
	const composer = {
		...ws.composer,
		onToggleConsult: () => {
			ws.composer.onToggleConsult?.();
			setTab(consultOn ? "chat" : "consult");
		},
		onSend: () => {
			if (tab === "context") setTab(consultOn ? "consult" : "chat");
			return ws.composer.onSend();
		},
	};
	const typingOn = ws.typing != null;
	const focus = useSyncExternalStore(
		subscribeFocusState,
		getFocusState,
		getFocusState,
	);
	composer.focus = focus.active;
	composer.focusChatOpen = focus.chatOpen;
	composer.onToggleFocusChat = () => setFocusChatOpen(!focus.chatOpen);

	const editorChapterId = useSyncExternalStore(
		subscribeEditorMeta,
		() => getEditorMetaSnapshot()?.chapterId ?? null,
		() => null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 切到「本章上下文」或切章时重新组装（controller 稳定）
	useEffect(() => {
		if (tab === "context") controller.loadChapterContext();
	}, [tab, editorChapterId]);

	return (
		<>
			<ChatPanel
				bare
				tab={tab}
				onTabChange={onTabChange}
				headExtra={<ContinueStyleMenu />}
				consultPane={
					<ConsultPane
						records={state.consultLog}
						typing={typingOn ? ws.live : null}
						onClear={() => controller.clearConsultLog()}
					/>
				}
				contextPane={
					<ChapterContextPane
						ctx={state.chapterContext}
						onRefresh={() => controller.loadChapterContext()}
						onOpenDetail={() => controller.openCtxBreakdown()}
					/>
				}
				conversations={state.conversations}
				currentConversationId={state.currentConversationId}
				onConversationChange={(id) => controller.switchConversation(id)}
				onNewConversation={() => controller.newWritingConversation()}
				meter={state.meter}
				banners={ws.banners}
				messages={state.messages}
				messagesRef={ws.scrollRef}
				listProps={{
					onInsertToChapter: (content) => controller.insertToChapter(content),
					onQuickReply: (label) => ws.transport.sendText(label),
					onArchiveRestore: () => controller.restoreContext(),
					onHandoffOrigin: (info) => controller.openHandoffOrigin(info),
					pendingActions: state.pendingActions,
					cardProps: ws.cardProps,
					live: typingOn ? null : ws.live,
					previewContent: state.previewContent,
					onLocatePreview: () => controller.locatePreview(),
				}}
				composer={composer}
				onOpenCtxDetail={() => controller.openCtxBreakdown()}
				onCompress={() => controller.compressContext()}
				onClear={() => controller.clearChat()}
				onOpenAgentDiscuss={() => controller.openAgentDiscussion()}
			/>
			<WorldListPanel items={state.world} controller={controller} />
			<CharacterListPanel items={state.characters} controller={controller} />
		</>
	);
}

// ---------- 挂载（① 桩委托的 bindChatEvents 触发；② 测试/桥直接调用） ----------
let currentApi = null;
let mounted = null; // {el, root, controller, visit}

export function chatApi() {
	return currentApi || NULL_API;
}

function renderTree(m) {
	// 每次进书（bindChatEvents）以 key=visit++ 重挂：等值 legacy :1857-1865「重置参谋态＋占位符」
	return createElement(ChatWorkspace, {
		key: m.visit,
		controller: m.controller,
	});
}

export function ensureMounted(opts) {
	if (typeof document === "undefined") return chatApi();
	const el = document.querySelector("#page-book .panel-chat");
	if (!el) return chatApi(); // 缺容器 no-op（不抛、零副作用）
	if (mounted && mounted.el === el) {
		if (opts && opts.remount === false) return currentApi;
		mounted.visit += 1;
		flushSync(() => mounted.root.render(renderTree(mounted)));
		return currentApi;
	}
	// 注册期残留（entry.jsx:8 → legacy-bridge.jsx:460 的 mountChatJumpBottom）先拆：
	// 否则静态壳 #chat-messages 会被包进 wrap 并在 body 留一个悬挂 root（三观察者挂在脱离文档的节点）
	unmountChatJumpBottom();
	if (mounted) {
		const old = mounted;
		mounted = null;
		try {
			old.root.unmount();
		} catch (_e) {
			/* 旧元素已脱离文档：容忍 */
		}
	}
	const controller = createChatWorkspaceController({
		mount: () => ensureMounted(),
	});
	const root = createRoot(el);
	el.__mozhenChatRoot = root;
	mounted = { el, root, controller, visit: 0 };
	currentApi = buildApi(controller);
	flushSync(() => root.render(renderTree(mounted)));
	return currentApi;
}

// P6-2（Plan §2.5-D4）：聊天面挂载的**唯一触发点**（逐字等值 legacy-bridge.jsx:581-582 桥体）——
// `BookShell.runShow` 直调本函数；`{remount:false}` 只在冷启动补齐首挂，进场重挂仍由控制器内
// mount() 做恰一次（visit++）。S5-7 整改契约（真实渠道 4 条判据红的根因）由此从桥体搬入模块。
export function bindChatEvents() {
	return ensureMounted({ remount: false }).bindChatEvents();
}

export default ChatWorkspace;
