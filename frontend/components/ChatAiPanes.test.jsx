// @vitest-environment jsdom
// UI 优化阶段 2c：写作助手三标签、参谋独立记录、本章上下文、正文内续写预览；
// 阶段 2d：专注写作时的续写预览与回复面板。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatWorkspaceController } from "../hooks/use-chat-workspace.js";
import {
	getContinuePreview,
	isContinuationCandidate,
	resetContinuePreviewForTest,
} from "../lib/continue-preview.js";
import {
	getFocusState,
	resetFocusStateForTest,
	setFocusActive,
	setFocusChatOpen,
} from "../lib/focus-state.js";
import {
	resetWritingPrefsForTest,
	setContinueStyle,
} from "../lib/writing-prefs.js";
import { ChapterContextPane, ConsultPane } from "./ChatAiPanes.jsx";
import { ChatPanel } from "./ChatPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;

function render(el) {
	act(() => {
		root.render(el);
	});
}

function memoryStorage() {
	const data = {};
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = String(v);
		},
		removeItem: (k) => {
			delete data[k];
		},
	};
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host");
	root = createRoot(host);
	localStorage.clear();
	resetWritingPrefsForTest();
	resetContinuePreviewForTest();
	resetFocusStateForTest();
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("2c 写作助手标签", () => {
	it("三标签切换只隐藏不卸载：对话区（含 #chat-messages）始终在 DOM 中", () => {
		const onTabChange = vi.fn();
		render(
			<ChatPanel
				onTabChange={onTabChange}
				consultPane={<div className="probe-consult">参谋内容</div>}
				contextPane={<div className="probe-context">上下文内容</div>}
			/>,
		);
		const tabs = [...host.querySelectorAll(".ai-tab")];
		expect(tabs.map((t) => t.textContent)).toEqual([
			"对话",
			"参谋",
			"本章上下文",
		]);
		const chatPane = host.querySelector(".ai-pane-chat");
		const consultPane = host.querySelector(".ai-pane-consult");
		expect(chatPane.hidden).toBe(false);
		expect(consultPane.hidden).toBe(true);
		act(() => tabs[1].click());
		expect(onTabChange).toHaveBeenCalledWith("consult");
		expect(chatPane.hidden).toBe(true);
		expect(consultPane.hidden).toBe(false);
		expect(tabs[1].getAttribute("aria-selected")).toBe("true");
		expect(host.querySelector("#chat-messages")).not.toBeNull();
		expect(host.querySelector(".probe-consult").textContent).toBe("参谋内容");
		act(() => tabs[2].click());
		expect(host.querySelector(".ai-pane-context").hidden).toBe(false);
	});

	it("受控 tab：以 props 为准", () => {
		render(<ChatPanel tab="context" />);
		expect(host.querySelector(".ai-tab.on").textContent).toBe("本章上下文");
		expect(host.querySelector(".ai-pane-chat").hidden).toBe(true);
	});
});

describe("2c 参谋记录与本章上下文", () => {
	it("ConsultPane：空态 / 记录渲染 / 清空入口 / 等待节点", () => {
		const onClear = vi.fn();
		render(<ConsultPane records={[]} onClear={onClear} />);
		expect(host.querySelector(".ai-empty").textContent).toContain(
			"还没有参谋记录",
		);
		render(
			<ConsultPane
				records={[
					{ id: "a", role: "user", content: "冲突够吗" },
					{ id: "b", role: "consultant", content: "建议加一层误会" },
				]}
				typing={<div className="typing">参谋思考中…</div>}
				onClear={onClear}
			/>,
		);
		expect(host.querySelector(".ai-empty")).toBeNull();
		const rows = host.querySelectorAll(".consult-messages .msg");
		expect([...rows].map((r) => r.className)).toEqual([
			"msg user",
			"msg consultant",
		]);
		expect(host.querySelector(".consult-messages .typing")).not.toBeNull();
		// 参谋回复不提供插入正文
		expect(host.textContent).not.toContain("插入到当前章节");
		const clear = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "清空记录",
		);
		act(() => clear.click());
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("ChapterContextPane：按节列出、标截断、刷新/完整明细回调", () => {
		const onRefresh = vi.fn();
		const onOpenDetail = vi.fn();
		render(
			<ChapterContextPane
				ctx={{
					status: "ready",
					chapterId: 3,
					data: {
						system: {
							total: 5200,
							budget: 48000,
							parts: [
								{ name: "人物", tokens: 4000, truncated: false },
								{ name: "前情记忆", tokens: 1200, truncated: true },
							],
						},
						history: { chatTokens: 900, toolTokens: 100 },
					},
				}}
				onRefresh={onRefresh}
				onOpenDetail={onOpenDetail}
			/>,
		);
		const rows = [...host.querySelectorAll(".ctx-parts li")];
		expect(
			rows.map((r) => r.querySelector(".ctx-part-val").textContent),
		).toEqual(["≈4.0K", "≈1.2K"]);
		expect(rows[1].className).toBe("truncated");
		expect(rows[1].textContent).toContain("被预算截断");
		expect(host.querySelector(".ctx-summary").textContent).toContain("≈5.2K");
		expect(host.querySelector(".ctx-summary").textContent).toContain("≈1.0K");
		const btn = (t) =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === t);
		act(() => btn("刷新").click());
		act(() => btn("完整明细").click());
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(onOpenDetail).toHaveBeenCalledTimes(1);
		render(<ChapterContextPane ctx={{ status: "no-chapter" }} />);
		expect(host.textContent).toContain("先在左侧选一章");
	});
});

describe("2c 控制器：参谋分流与正文内预览", () => {
	function makeController(storage) {
		return createChatWorkspaceController({
			getBookId: () => 7,
			getChapterId: () => 42,
			storage,
		});
	}

	it("参谋问答进参谋记录（按书存本机），不进对话消息", () => {
		const storage = memoryStorage();
		const c = makeController(storage);
		c.appendMessage({ role: "user", content: "这段怎么写" }, { consult: true });
		c.appendMessage({ role: "consultant", content: "先写误会" });
		c.appendMessage({ role: "user", content: "续写一段" });
		const s = c.getState();
		expect(s.messages.map((m) => m.content)).toEqual(["续写一段"]);
		expect(s.consultLog.map((m) => [m.role, m.content])).toEqual([
			["user", "这段怎么写"],
			["consultant", "先写误会"],
		]);
		const saved = JSON.parse(storage.data["mozhen.consult-log.v1.7"]);
		expect(saved).toHaveLength(2);
		expect(saved[0].chapterId).toBe(42);
	});

	it("续写判定：短句/确认提问/压缩摘要不进预览", () => {
		const long = "雨".repeat(120);
		expect(isContinuationCandidate({ role: "assistant", content: long })).toBe(
			true,
		);
		expect(
			isContinuationCandidate({ role: "assistant", content: "好的" }),
		).toBe(false);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: `${long}【需要确认】走 A 还是 B？`,
			}),
		).toBe(false);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				compressed: 2,
			}),
		).toBe(false);
		expect(isContinuationCandidate({ role: "user", content: long })).toBe(
			false,
		);
	});

	it("续写判定：服务端意图标注优先于格式兜底", () => {
		const long = "雨".repeat(120);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				intent: "operation",
			}),
		).toBe(false);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				intent: "discussion",
			}),
		).toBe(false);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				intent: "prose",
			}),
		).toBe(true);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				intent: "unknown",
			}),
		).toBe(true);
		// prose 仍要过格式兜底：确认提问不算正文
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: `${long}【需要确认】走 A 还是 B？`,
				intent: "prose",
			}),
		).toBe(false);
	});

	it("续写判定：本轮有写操作确认卡、或是带列表的改稿说明，都不进预览", () => {
		const long = "雨".repeat(120);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				actions: [{ id: "a1", name: "replace_chapter", args: {} }],
			}),
		).toBe(false);
		expect(
			isContinuationCandidate({
				role: "assistant",
				content: long,
				actions: [],
				tools: [{ name: "read_chapter", args: {}, result: {} }],
			}),
		).toBe(true);
		const report = `本章（第4章）已按思路重写完成，已提交生效。${long}\n\n调整要点：\n- 删掉了之前的俏皮比喻；\n- 学校一天压缩成一两句过场；\n- 结尾收束得比较轻。\n\n如果你觉得节奏不对，告诉我，我再改。`;
		expect(
			isContinuationCandidate({ role: "assistant", content: report }),
		).toBe(false);
		const prose = `${"林栖没有马上拆信。".repeat(10)}\n\n“你回来了？”她问。\n\n- 他没说话。`;
		expect(isContinuationCandidate({ role: "assistant", content: prose })).toBe(
			true,
		);
	});

	it("写操作回合的说明回复不进正文预览（正文内预览模式下）", () => {
		setContinueStyle("inline");
		const c = makeController(memoryStorage());
		c.appendMessage({
			role: "assistant",
			content: "本章已按要求重写完成并提交生效。".repeat(8),
			actions: [{ id: "a1", name: "replace_chapter", args: {} }],
		});
		expect(getContinuePreview()).toBeNull();
		expect(c.getState().previewContent ?? null).toBeNull();
	});

	it("呈现方式＝对话卡片时不出预览；＝正文内预览时绑定当前书与章，丢弃即清除", () => {
		const c = makeController(memoryStorage());
		const content = "林栖没有马上拆信。".repeat(12);
		c.appendMessage({ role: "assistant", content });
		expect(getContinuePreview()).toBeNull();
		setContinueStyle("inline");
		c.appendMessage({ role: "assistant", content });
		const p = getContinuePreview();
		expect(p).toMatchObject({ bookId: 7, chapterId: 42, content });
		expect(c.getState().previewContent).toBe(content);
		act(() => p.discard());
		expect(getContinuePreview()).toBeNull();
		expect(c.getState().previewContent).toBeNull();
	});
});

describe("2d 专注写作：底部输入栏与回复面板", () => {
	function makeController() {
		return createChatWorkspaceController({
			getBookId: () => 7,
			getChapterId: () => 42,
			storage: memoryStorage(),
		});
	}

	it("专注时续写型回复一律进正文预览（即使续写方式是卡片），回复面板不弹", () => {
		setFocusActive(true);
		const c = makeController();
		const content = "林栖没有马上拆信。".repeat(12);
		c.appendMessage({ role: "assistant", content });
		expect(getContinuePreview()).toMatchObject({ chapterId: 42, content });
		expect(getFocusState().chatOpen).toBe(false);
	});

	it("专注时其余回复（确认提问、参谋建议）自动展开回复面板；用户自己的消息不展开；非专注不受影响", () => {
		const c = makeController();
		c.appendMessage({ role: "assistant", content: "好的" });
		expect(getFocusState()).toEqual({ active: false, chatOpen: false });

		setFocusActive(true);
		c.appendMessage({ role: "user", content: "续写一段" });
		expect(getFocusState().chatOpen).toBe(false);
		c.appendMessage({
			role: "assistant",
			content: "【需要确认】走 A 还是 B？",
		});
		expect(getFocusState().chatOpen).toBe(true);
		expect(getContinuePreview()).toBeNull();

		setFocusChatOpen(false);
		c.appendMessage({ role: "user", content: "问参谋" }, { consult: true });
		expect(getFocusState().chatOpen).toBe(false);
		c.appendMessage({ role: "consultant", content: "先写误会" });
		expect(getFocusState().chatOpen).toBe(true);
	});

	it("输入栏上的回复开关只在专注时出现，文案随展开态／生成中变化", () => {
		const onToggleFocusChat = vi.fn();
		render(<ChatPanel composer={{}} />);
		expect(host.querySelector(".focus-chat-toggle")).toBeNull();
		render(<ChatPanel composer={{ focus: true, onToggleFocusChat }} />);
		const btn = host.querySelector(".focus-chat-toggle");
		expect(btn.textContent).toBe("查看回复");
		expect(btn.getAttribute("aria-expanded")).toBe("false");
		act(() => btn.click());
		expect(onToggleFocusChat).toHaveBeenCalledTimes(1);
		render(<ChatPanel composer={{ focus: true, streaming: true }} />);
		expect(host.querySelector(".focus-chat-toggle").textContent).toBe(
			"AI 回复中…",
		);
		render(<ChatPanel composer={{ focus: true, focusChatOpen: true }} />);
		const open = host.querySelector(".focus-chat-toggle");
		expect(open.textContent).toBe("收起回复");
		expect(open.classList.contains("on")).toBe(true);
	});
});
