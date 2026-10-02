// S5-7 红测 T2（Plan §4 T2）：frontend/lib/chat-handoff.js —— 前情引用与交接回跳纯逻辑。
// 语义唯一事实源＝public/legacy/book-chat.js :65-275（逐例头注行号锚点；该文件本片 git rm）。
// harness＝vitest node 环境；零新增依赖；选区/弹窗文本全部注入或纯函数。
import { describe, expect, it } from "vitest";
import {
	AGENT_CONVERSATION_KEY,
	AGENT_SCOPE_KEY,
	DISCUSS_OK_TOAST_PLAIN,
	DISCUSS_OK_TOAST_WITH_TEXT,
	discussBodyHTML,
	discussFailToast,
	discussionBody,
	HANDOFF_PREFIX,
	handoffIdAnchor,
	handoffMaterial,
	handoffMessageBody,
	handoffRefs,
	handoffRefsText,
	handoffScopeKey,
	handoffTitle,
	parseHandoffSource,
	pickCharacter,
	selectedEditorText,
} from "./chat-handoff.js";

const BOOK = { id: 7, title: "雾港编年史" };
const CHAPTER = { id: 12, title: "第1章 石碑" };
const CHARACTER = { id: 5, name: "林昭" };
const escapeHtml = (s) =>
	String(s == null ? "" : s).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

function docWith(text, sel) {
	return {
		getElementById(id) {
			if (id !== "chapter-content") return null;
			return {
				value: text,
				selectionStart: sel ? sel[0] : 0,
				selectionEnd: sel ? sel[1] : 0,
			};
		},
	};
}

describe("T2 chat-handoff（legacy :65-275）", () => {
	it("T2-1 selectedEditorText：无元素 ''、未选 ''、选区 trim、越界容错（:74-81）", () => {
		expect(selectedEditorText(null)).toBe("");
		expect(selectedEditorText({ getElementById: () => null })).toBe("");
		expect(selectedEditorText(docWith("前文选中文字后文", [2, 6]))).toBe(
			"选中文字",
		);
		expect(selectedEditorText(docWith("  空白  ", [0, 6]))).toBe("空白");
		expect(selectedEditorText(docWith("abc", [3, 3]))).toBe("");
		expect(selectedEditorText(docWith("abc", [2, 1]))).toBe("");
		// 越界：slice 自然收敛（不抛）
		expect(selectedEditorText(docWith("abcd", [2, 99]))).toBe("cd");
	});

	it("T2-2 handoffRefs/handoffIdAnchor：三态逐字与缺 title 兜底（:83-95）", () => {
		expect(handoffRefs(BOOK, null, null)).toBe("《雾港编年史》");
		expect(handoffRefs(BOOK, CHAPTER, null)).toBe(
			"《雾港编年史》 · 《第1章 石碑》",
		);
		expect(handoffRefs(BOOK, CHAPTER, CHARACTER)).toBe(
			"《雾港编年史》 · 《第1章 石碑》 · 人物：林昭",
		);
		expect(handoffRefs({ id: 9 }, { id: 3 }, null)).toBe(
			"《#9》 · 《章节 #3》",
		);
		expect(handoffIdAnchor(BOOK, null, null)).toBe("[bookId=7]");
		expect(handoffIdAnchor(BOOK, CHAPTER, CHARACTER)).toBe(
			"[bookId=7 chapterId=12 characterId=5]",
		);
	});

	it("T2-3 handoffTitle：整体讨论命名 + 章/人物后缀 + slice(0,200)（:96-101）", () => {
		expect(handoffTitle(BOOK, null, null)).toBe("《雾港编年史》· 整体讨论");
		expect(handoffTitle(BOOK, CHAPTER, null)).toBe(
			"《雾港编年史》· 整体讨论 · 自《第1章 石碑》",
		);
		expect(handoffTitle(BOOK, CHAPTER, CHARACTER)).toBe(
			"《雾港编年史》· 整体讨论 · 自《第1章 石碑》 · 人物：林昭",
		);
		const long = handoffTitle({ id: 1, title: "长".repeat(300) }, null, null);
		expect(long.length).toBe(200);
		expect(long.endsWith("…")).toBe(false);
	});

	it("T2-4 handoffMaterial：四段逐字（前缀/引用行/id 锚/缺席行/原文）（:102-105）", () => {
		expect(HANDOFF_PREFIX).toBe("【来自 Agent 讨论·显式交接】");
		const material = handoffMaterial(BOOK, CHAPTER, CHARACTER, "选中的一段");
		expect(material).toBe(
			"【来自写作页·整体讨论】《雾港编年史》 · 《第1章 石碑》 · 人物：林昭 [bookId=7 chapterId=12 characterId=5]\n" +
				"以下为作者在写作页明确选中的文字：\n选中的一段",
		);
	});

	it("T2-5 pickCharacter：String 比较、未命中 null、空值 null（:106-112）", () => {
		const list = [
			{ id: 5, name: "林昭" },
			{ id: "6", name: "沈砚" },
		];
		expect(pickCharacter(list, "5").name).toBe("林昭");
		expect(pickCharacter(list, 6).name).toBe("沈砚");
		expect(pickCharacter(list, "9")).toBe(null);
		expect(pickCharacter(list, "")).toBe(null);
		expect(pickCharacter([], "5")).toBe(null);
	});

	it("T2-6 parseHandoffSource：前缀/来源会话正则 8-64 位/来源引用按｜拆分 trim filter/缺失字段空串（:207-219）", () => {
		expect(parseHandoffSource("普通消息")).toBe(null);
		expect(parseHandoffSource("")).toBe(null);
		const content =
			"【来自 Agent 讨论·显式交接】来源会话：整体讨论（conv-12345678）\n摘要行\n来源引用：规划笔记 #n-1 revision 2 ｜ 设定 #w-9 ｜｜\n尾行";
		const info = parseHandoffSource(content);
		expect(info.originConversationId).toBe("conv-12345678");
		expect(info.originTitle).toBe("整体讨论");
		expect(info.refs).toEqual(["规划笔记 #n-1 revision 2", "设定 #w-9"]);
		// 来源会话缺失（id 太短不匹配 8-64）→ 空串 + 空 refs
		const bare = parseHandoffSource("【来自 Agent 讨论·显式交接】只有材料正文");
		expect(bare.originConversationId).toBe("");
		expect(bare.originTitle).toBe("");
		expect(bare.refs).toEqual([]);
	});

	it("T2-7 handoffScopeKey/handoffRefsText：落点键与逐字来源块（:239-241、:269-271）", () => {
		expect(AGENT_SCOPE_KEY).toBe("agent_scope_v1");
		expect(AGENT_CONVERSATION_KEY).toBe("agent_conversation_v1");
		expect(handoffScopeKey({ scope: "book", book_id: 7 })).toBe("book:7");
		expect(handoffScopeKey({ scope: "book", book_id: null })).toBe("global");
		expect(handoffScopeKey({ scope: "global" })).toBe("global");
		expect(
			handoffRefsText({
				originTitle: "整体讨论",
				originConversationId: "conv-12345678",
				refs: ["a", "b"],
			}),
		).toBe("来源会话：整体讨论（conv-12345678）\na\nb");
		expect(
			handoffRefsText({
				originTitle: "",
				originConversationId: "x",
				refs: ["a"],
			}),
		).toBe("a");
	});

	it("T2-8 讨论弹窗 bodyHTML：含/不含选中两分支 + 人物 select + escapeHtml 逐处（:144-157）", () => {
		const book = { id: 7, title: "<星尘>" };
		const withText = discussBodyHTML({
			book,
			chapter: CHAPTER,
			characters: [{ id: 5, name: "<林昭>" }],
			selected: "选中的一段",
			escapeHtml,
		});
		expect(withText).toContain("&lt;星尘&gt;");
		expect(withText).toContain("&lt;林昭&gt;");
		expect(withText).toContain('id="agent-discuss-quote" checked');
		expect(withText).toContain("带上我在正文里选中的 5 字作为初始材料");
		expect(withText).toContain('id="agent-discuss-preview"');
		expect(withText).toContain(
			escapeHtml(handoffMaterial(book, CHAPTER, null, "选中的一段")),
		);
		expect(withText).toContain('id="agent-discuss-character"');
		expect(withText).toContain('<option value="">不指定</option>');
		expect(withText).toContain("默认<strong>不带</strong>写作助手里的对话历史");
		expect(withText).not.toContain("当前没有选中文字");
		const without = discussBodyHTML({
			book: BOOK,
			chapter: null,
			characters: [],
			selected: "",
			escapeHtml,
		});
		expect(without).toContain("当前没有选中文字");
		expect(without).not.toContain("agent-discuss-quote");
		expect(without).not.toContain("agent-discuss-character");
	});

	it("T2-9 讨论请求体与 toast：专题命名 + 初始材料 source 逐字（:164-179）", () => {
		expect(discussionBody(BOOK, CHAPTER, CHARACTER)).toEqual({
			kind: "agent",
			scope: "book",
			bookId: 7,
			title: handoffTitle(BOOK, CHAPTER, CHARACTER),
		});
		expect(handoffMessageBody(BOOK, CHAPTER, null, "选段")).toEqual({
			content: handoffMaterial(BOOK, CHAPTER, null, "选段"),
			source: "writing",
		});
		expect(DISCUSS_OK_TOAST_WITH_TEXT).toBe(
			"已在 AI 助手开启整体讨论（只带了这本书与你选中的文字）",
		);
		expect(DISCUSS_OK_TOAST_PLAIN).toBe(
			"已在 AI 助手开启整体讨论（未带写作历史）",
		);
		expect(discussFailToast("磁盘暂不可用")).toBe(
			"另开整体讨论失败：磁盘暂不可用",
		);
	});
});
