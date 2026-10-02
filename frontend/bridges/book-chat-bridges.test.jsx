// @vitest-environment jsdom
// S5-7 红测 T6（Plan §4 T6；P6-2 ⑨ 切换笔转写）：聊天命令面与挂载链——
// G-A（模块面）：`chatApi()` 11 名全 function（未挂载＝NULL 占位面单例）、`bindChatEvents()` 导入即用、
//      注册期零挂载、旧名面（window.MozhenBookChat／window.BookPage）零命中。
// G-B（转写后）：index.html 聊天委托桩段已随三段承接桩原子删除 ⇒ 原「桩段形态/动态委托/未注册静默」
//      四例**收窄合并**为「零内联段＋名单内零命中＋静态聊天壳 DOM 契约在位」与「唯一挂载触发点」两组
//      等价断言（去向逐条见各例注释）；冷启动链保留（变为模块直取链）。
// harness＝jsdom＋React 19 act；静态壳从 frontend/index.html 真实文本提取（禁复制粘贴；P6-3 源迁入）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bindChatEvents,
	chatApi,
	ensureMounted,
} from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "../lib/app-runtime.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);

const CHAT_API_NAMES = [
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

function chatSection() {
	const start = INDEX_HTML.indexOf('<section class="panel panel-chat">');
	const end = INDEX_HTML.indexOf("</section>", start) + "</section>".length;
	return INDEX_HTML.slice(start, end);
}

function readSrc(rel) {
	return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const BOOK = { id: 7, title: "雾港编年史", mode: "collab" };

function installShell(withApp) {
	document.body.innerHTML =
		'<div id="page-book"><div id="book-workbench" class="workbench resizable">' +
		chatSection() +
		"</div></div>";
	if (withApp) {
		window.App = {
			state: { currentBook: BOOK, currentChapterId: 12 },
			api: async () => ({}),
			toast() {},
			escapeHtml: (s) => String(s == null ? "" : s),
			openModal() {},
			closeModal() {},
		};
		setAppForTests(window.App);
	}
	return document.querySelector("#page-book .panel-chat");
}

function cleanup() {
	document.body.innerHTML = "";
	setAppForTests(null);
	delete window.App;
	delete window.RunStatus;
	delete window.BookPage;
	delete window.MozhenBookChat;
	delete globalThis.fetch;
}

beforeEach(() => {
	localStorage.clear();
	cleanup();
});

afterEach(cleanup);

describe("T6 聊天命令面与挂载链（P6-2 ⑨ 转写：MozhenBookChat/桩段退役）", () => {
	it("G-A-1 模块面：chatApi() 11 名全 function（未挂载＝NULL 占位面）；导入 chatApi/bindChatEvents 即用；注册期零挂载；旧名面零命中", () => {
		const panel = installShell(false);
		const api = chatApi();
		for (const n of CHAT_API_NAMES)
			expect(typeof api[n], `chatApi().${n}`).toBe("function");
		expect(typeof bindChatEvents).toBe("function");
		// 导入期不挂载（等价旧「注册期不挂载」）：静态壳节点原样未被替换 + 无 root 缓存
		expect(panel.querySelector("#chat-text")).not.toBeNull();
		expect(panel.__mozhenChatRoot).toBe(undefined);
		// 反向见证：旧名面（中介对象）整体退役——原「桥禁写 window.BookPage」断言的等价物
		expect(window.BookPage).toBeUndefined();
		expect(window.MozhenBookChat).toBeUndefined();
	});

	it("G-A-2 ensureMounted 幂等、缺容器 no-op（模块面语义原样保留）", () => {
		installShell(false);
		// 缺容器：不抛、零副作用
		document.body.innerHTML =
			'<div id="page-book"><div id="book-workbench"></div></div>';
		const api = ensureMounted();
		expect(api).toBeTruthy();
		expect(document.querySelectorAll("#chat-messages").length).toBe(0);
		expect(document.querySelectorAll(".chat-scroll-wrap").length).toBe(0);
		// 有容器：幂等（同元素复用同一 controller/root）
		installShell(true);
		let first = null;
		let second = null;
		act(() => {
			first = ensureMounted();
			second = ensureMounted();
		});
		expect(first).toBe(second);
		expect(document.querySelectorAll("#chat-messages").length).toBe(1);
	});

	it("G-B-1（收窄合并：原「桩段形态」G-B-1）源 index.html 零内联段＋名单内 window.* 零命中＋静态聊天壳 DOM 契约在位（驱动依赖）", () => {
		// 原 G-B-1 断言对象（聊天委托桩段：classic/11 名/window.MozhenBookChat/晚于编辑器 bootstrap/
		// 早于 React 入口）随三段承接桩原子删除而消失 —— 去向＝①本例零内联段＋名单零命中
		// ②zero-global.test.js T1（静态全量）③boot-order.test.jsx T6-1/T6-2（装载序唯一样式）。
		const scripts =
			INDEX_HTML.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
		const code = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");
		expect(
			code.match(
				/window\.(BookPage|MozhenBookChat|MozhenChapterEditor|App)\b/g,
			) || [],
		).toHaveLength(0);
		expect(INDEX_HTML.match(/legacy\/book-chat\.js/g) || []).toHaveLength(0);
		expect(INDEX_HTML.match(/legacy\/segment-targets\.js/g) || []).toHaveLength(
			0,
		);
		// 静态聊天壳 DOM 零改动（D7 红线：驱动 ⑩-⑭ 依赖面）
		const section = chatSection();
		for (const anchor of [
			'id="chat-text"',
			'id="chat-messages"',
			'id="btn-send"',
			'id="writing-conversation-select"',
		])
			expect(section, anchor).toContain(anchor);
	});

	it("G-B-2（收窄合并：原「桩动态委托命中」G-B-2）唯一挂载触发点＝bindChatEvents（源码见证 ensureMounted({remount:false})）", () => {
		// 原 G-B-2 断言对象（桩 → window.MozhenBookChat 同名委托）消失 —— 去向＝ChatWorkspace 的
		// 模块导出面：`bindChatEvents()` 逐字等于 `ensureMounted({ remount:false }).bindChatEvents()`
		// （原桥体），且 ChatWorkspace 内 ensureMounted 的调用点仅三处（mount 导出面＋bindChatEvents）。
		const src = readSrc("frontend/components/ChatWorkspace.jsx");
		expect(src).toContain(
			"return ensureMounted({ remount: false }).bindChatEvents();",
		);
		// 注释行剔除后 ensureMounted 调用点恰三处（定义＋mount 导出面＋bindChatEvents）——
		// 无第四处旁路入口（「唯一挂载触发点」的可复核口径）
		const liveSrc = src
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		const callSites = (liveSrc.match(/ensureMounted\(/g) || []).length;
		expect(callSites).toBe(3);
		// 生产面零窗口名（同 T1 口径的局部见证）
		const live = src
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		for (const name of ["MozhenBookChat", "BookPage", "App"])
			expect(live).not.toContain(`window.${name}`);
	});

	it("G-B-3（收窄合并：原「桩委托触发挂载」G-B-3）bindChatEvents() 首挂后命令面接活控制器；未挂载面调用不抛", async () => {
		// 原 G-B-3 断言对象（window.BookPage.bindChatEvents → 桩 → 桥）消失 —— 去向＝模块链：
		// `bindChatEvents()` 触发首挂，`chatApi()` 11 名随即接活（含冷启动 2026-09-28 整改语义）。
		const panel = installShell(true);
		const staticMsgs = document.querySelector("#chat-messages");
		expect(staticMsgs).not.toBeNull();
		expect(document.querySelector("#chat-messages")).toBe(staticMsgs);
		await act(async () => {
			await bindChatEvents();
		});
		expect(document.querySelectorAll("#chat-messages").length).toBe(1);
		expect(document.querySelector("#chat-messages")).not.toBe(staticMsgs);
		expect(panel.children.length).toBeGreaterThan(0);
		expect(chatApi().currentWritingConversationId()).toBe(null);
		const card = chatApi().renderToolEvent({ name: "read_chapter" });
		expect(card).toBeTruthy();
		expect(typeof card.querySelector).toBe("function");
	});

	it("G-B-4（收窄合并：原「未注册静默不抛」G-B-4）NULL 占位面 11 名可空调用不抛（读面恒 null／写面无副作用）", async () => {
		// 原 G-B-4 断言对象（未注册 MozhenBookChat 时桩静默返回 undefined）消失 —— 去向＝
		// 未挂载 NULL 占位面语义（须用**冷模块图**取未挂载面：同文件前面用例已挂载过聊天面）。
		vi.resetModules();
		const fresh = await import("../components/ChatWorkspace.jsx");
		expect(fresh.chatApi().currentWritingConversationId()).toBe(null);
		expect(typeof fresh.chatApi().loadChat).toBe("function");
		expect(() => fresh.chatApi().setStatusPollingVisible(true)).not.toThrow();
		expect(() => fresh.chatApi().loadWorld()).not.toThrow();
		expect(() => fresh.chatApi().loadCharacters()).not.toThrow();
	});

	it("G-A-3 renderActionCard/renderToolEvent 仍产出 DOM 节点（阅读页复用面），无需挂载", () => {
		installShell(false);
		let card = null;
		let block = null;
		act(() => {
			card = chatApi().renderActionCard(
				{
					id: "a-1",
					name: "append_chapter",
					args: { chapterId: 12 },
					status: "pending",
				},
				{ bookId: 7, onSettled() {}, resume() {} },
			);
			block = chatApi().renderToolEvent({
				name: "read_chapter",
				result: "ok",
			});
		});
		expect(card.className).toContain("msg-action");
		expect(card.textContent).toContain("追加章节正文");
		expect(block.textContent).toContain("阅读章节");
		// 未挂载面 → 只读命令返回 undefined 不抛
		expect(chatApi().loadChat).toBeTruthy();
	});

	it("G-B-5 冷启动链（2026-09-28 真实渠道整改回归；P6-2 ⑨ 转写）：模块状态全冷时，仅 bindChatEvents() 完成首挂并把 11 名接到活控制器", async () => {
		// 动因：本文件 G-A-2 已调 ensureMounted()，模块单例（currentApi/mounted）被点亮 ⇒ 后续用例
		// 「假绿」；而生产链上没有任何代码直接调 ensureMounted，唯一入口是 BookShell.runShow
		// → `bindChatEvents()`。故本用例先 vi.resetModules() 取一份全新模块图（currentApi=null）
		// 再断言整条链路（原链路中的「桩 → 桥」两层随 P6-2 ⑨ 去掉，语义不变）。
		vi.resetModules();
		const [freshChat, freshReact, freshRuntime] = await Promise.all([
			import("../components/ChatWorkspace.jsx"),
			import("react"),
			import("../lib/app-runtime.js"),
		]);
		const panel = installShell(false);
		window.App = {
			state: { currentBook: BOOK, currentChapterId: 12 },
			api: async () => ({}),
			toast() {},
			escapeHtml: (s) => String(s == null ? "" : s),
			openModal() {},
			closeModal() {},
		};
		// 生产侧 App 取用已改 `lib/app-runtime.js` 单例直取（§2.5-D1），冷模块图须把本轮 harness
		// 的 window.App 桩注入**该图**的单例（否则走真 fetch＝原断言失供）
		freshRuntime.setAppForTests(window.App);
		const staticText = panel.querySelector("#chat-text");
		const calls = [];
		window.App.api = async (method, url) => {
			calls.push(`${method} ${url}`);
			if (method === "GET" && /\/chat$/.test(String(url)))
				return { messages: [], conversationId: null };
			return {};
		};
		// 冷态前置：命令面为未挂载占位（currentWritingConversationId 恒 null）
		expect(panel.querySelector("#chat-text")).toBe(staticText);
		expect(freshChat.chatApi().currentWritingConversationId()).toBe(null);
		// 生产链路（BookShell.runShow 起，无任何额外挂载调用）
		await freshReact.act(async () => {
			await freshChat.bindChatEvents();
			await freshChat.chatApi().loadChat();
		});
		// 首挂完成＝静态壳被 React 原位接管（修复前此处恒为同一静态节点 ⇒ 红）
		expect(panel.querySelector("#chat-text")).not.toBe(staticText);
		expect(panel.__mozhenChatRoot).toBeTruthy();
		expect(document.querySelectorAll("#chat-messages").length).toBe(1);
		expect(calls.some((c) => String(c).endsWith("/api/books/7/chat"))).toBe(
			true,
		);
		// 11 名已接到活控制器：读的是真 storage（未挂载占位面恒 null）
		localStorage.setItem("writing_conversation_7", "conv-42");
		expect(freshChat.chatApi().currentWritingConversationId()).toBe("conv-42");
	});
});
