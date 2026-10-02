// S5-8 红测 T1（Plan §4 T1）：frontend/lib/agent-scope.js —— 范围/边界/模式纯逻辑。
// 语义唯一事实源＝public/legacy/agent.js :94-201／:531-547（逐例头注 legacy 行号锚点；
// 该文件本片只读、零 diff）。harness＝vitest node 环境；storage 全注入；零新增依赖。
import { describe, expect, it } from "vitest";
import {
	boundaryLabel,
	boundaryOptions,
	CONVERSATION_EMPTY_HINT,
	conversationInScope,
	conversationOptions,
	currentBook,
	firstConversationInScope,
	modeButton,
	modeLabel,
	parseScopeValue,
	readSavedScope,
	resolveBoundaryChapterId,
	SCOPE_KEY,
	saveScope,
	scopeBookTitle,
	scopeKey,
	scopeOptions,
	scopeStatusText,
} from "./agent-scope.js";

const GLOBAL_SCOPE = { kind: "global", bookId: null };
const BOOK_SCOPE = { kind: "book", bookId: 7 };
const BOOKS = [
	{ id: 7, title: "雾港编年史" },
	{ id: 9, title: "雾港" },
];

function store(initial) {
	const map = Object.assign({}, initial);
	return {
		map,
		getItem: (k) => (k in map ? map[k] : null),
		setItem: (k, v) => {
			map[k] = v;
		},
	};
}

describe("T1 agent-scope（范围/边界/模式纯逻辑）", () => {
	it("T1-1 readSavedScope（:94-102）：global／book:<id>／缺失与非法值／storage 抛错一律回落全局", () => {
		expect(readSavedScope(store({ [SCOPE_KEY]: "global" }))).toEqual(
			GLOBAL_SCOPE,
		);
		expect(readSavedScope(store({ [SCOPE_KEY]: "book:7" }))).toEqual(
			BOOK_SCOPE,
		);
		expect(readSavedScope(store({}))).toEqual(GLOBAL_SCOPE);
		expect(readSavedScope(store({ [SCOPE_KEY]: "" }))).toEqual(GLOBAL_SCOPE);
		expect(readSavedScope(store({ [SCOPE_KEY]: "book:abc" }))).toEqual(
			GLOBAL_SCOPE,
		);
		expect(readSavedScope(store({ [SCOPE_KEY]: "book:" }))).toEqual(
			GLOBAL_SCOPE,
		);
		expect(readSavedScope(store({ [SCOPE_KEY]: "book:0" }))).toEqual({
			kind: "book",
			bookId: 0,
		});
		expect(
			readSavedScope({
				getItem() {
					throw new Error("storage disabled");
				},
			}),
		).toEqual(GLOBAL_SCOPE);
		expect(readSavedScope(undefined)).toEqual(GLOBAL_SCOPE);
	});

	it("T1-2 scopeKey（:103-105）与 saveScope（:106-108）：恰写一个键、抛错静默", () => {
		expect(scopeKey(BOOK_SCOPE)).toBe("book:7");
		expect(scopeKey(GLOBAL_SCOPE)).toBe("global");
		const s = store({});
		saveScope(s, BOOK_SCOPE);
		expect(s.map).toEqual({ [SCOPE_KEY]: "book:7" });
		expect(() =>
			saveScope(
				{
					setItem() {
						throw new Error("quota");
					},
				},
				GLOBAL_SCOPE,
			),
		).not.toThrow();
	});

	it("T1-3 parseScopeValue（:109-113）：global／book:<id>／其余 null（逐字照 legacy 正则）", () => {
		expect(parseScopeValue("global")).toEqual(GLOBAL_SCOPE);
		expect(parseScopeValue("book:9")).toEqual({ kind: "book", bookId: 9 });
		expect(parseScopeValue("book:0")).toEqual({ kind: "book", bookId: 0 });
		expect(parseScopeValue("book:abc")).toBeNull();
		expect(parseScopeValue("")).toBeNull();
		expect(parseScopeValue(null)).toBeNull();
		expect(parseScopeValue(7)).toBeNull();
	});

	it("T1-4 currentBook／scopeBookTitle（:114-124）：命中取书；书不在列表→'书籍 #<id>'；global→null/空", () => {
		expect(currentBook(BOOKS, BOOK_SCOPE)).toEqual(BOOKS[0]);
		expect(scopeBookTitle(BOOKS, BOOK_SCOPE)).toBe("雾港编年史");
		expect(currentBook([], BOOK_SCOPE)).toBeNull();
		expect(scopeBookTitle([], BOOK_SCOPE)).toBe("书籍 #7");
		expect(currentBook(BOOKS, GLOBAL_SCOPE)).toBeNull();
		expect(scopeBookTitle(BOOKS, GLOBAL_SCOPE)).toBe("书籍 #null");
	});

	it("T1-5 conversationInScope（:125-130）：scope 不等→false；global 恒 true；book 按 Number(book_id)", () => {
		expect(
			conversationInScope(BOOK_SCOPE, { scope: "book", book_id: "7" }),
		).toBe(true);
		expect(conversationInScope(BOOK_SCOPE, { scope: "book", book_id: 9 })).toBe(
			false,
		);
		expect(
			conversationInScope(BOOK_SCOPE, { scope: "global", book_id: null }),
		).toBe(false);
		expect(
			conversationInScope(GLOBAL_SCOPE, { scope: "global", book_id: 99 }),
		).toBe(true);
		expect(
			conversationInScope(GLOBAL_SCOPE, { scope: "book", book_id: 7 }),
		).toBe(false);
		expect(conversationInScope(BOOK_SCOPE, null)).toBe(false);
	});

	it("T1-6 firstConversationInScope（:131-136）：跳过 archived 与非本范围；无命中→null", () => {
		const list = [
			{ id: "a", scope: "global", status: "active" },
			{ id: "b", scope: "book", book_id: 9, status: "active" },
			{ id: "c", scope: "book", book_id: 7, status: "archived" },
			{ id: "d", scope: "book", book_id: 7, status: "active" },
		];
		expect(firstConversationInScope(BOOK_SCOPE, list).id).toBe("d");
		expect(firstConversationInScope(GLOBAL_SCOPE, list).id).toBe("a");
		expect(firstConversationInScope(GLOBAL_SCOPE, list.slice(1))).toBeNull();
	});

	it("T1-7 scopeOptions（:140-156）：首项 global 文案逐字＋每本书《title》；记住的书已被删→回落 global 且写回", () => {
		const r = scopeOptions(BOOKS, BOOK_SCOPE, store({}));
		expect(r.options).toEqual([
			{ value: "global", label: "全局资源（跨书检索 · 只读讨论）" },
			{ value: "book:7", label: "《雾港编年史》" },
			{ value: "book:9", label: "《雾港》" },
		]);
		expect(r.scope).toEqual(BOOK_SCOPE);
		expect(r.changed).toBe(false);

		const s = store({});
		const fallback = scopeOptions(BOOKS, { kind: "book", bookId: 99 }, s);
		expect(fallback.scope).toEqual(GLOBAL_SCOPE);
		expect(fallback.changed).toBe(true);
		expect(s.map).toEqual({ [SCOPE_KEY]: "global" });
	});

	it("T1-8 boundaryOptions（:158-178）：global 仅占位项且 disabled；book 逐章（sortOrder 缺省不带前缀、title 缺省 #id）", () => {
		const g = boundaryOptions(GLOBAL_SCOPE, []);
		expect(g.disabled).toBe(true);
		expect(g.options).toEqual([{ value: "", label: "全书（先选一本书）" }]);

		const b = boundaryOptions(BOOK_SCOPE, [
			{ id: 12, title: "石碑", meta: { sortOrder: 2 } },
			{ id: 13, title: "渡口", meta: {} },
			{ id: 14, meta: { sortOrder: 4 } },
		]);
		expect(b.disabled).toBe(false);
		expect(b.options).toEqual([
			{ value: "", label: "全书（无时序边界）" },
			{ value: "12", label: "第2章 · 石碑" },
			{ value: "13", label: "渡口" },
			{ value: "14", label: "第4章 · #14" },
		]);
	});

	it("T1-9 boundaryLabel（:182-187）：命中→截至《title》；未命中但有 id→截至章节 #id；无 id→全书", () => {
		const chapters = [{ id: 12, title: "石碑" }];
		expect(boundaryLabel(chapters, 12)).toBe("截至《石碑》");
		expect(boundaryLabel(chapters, 13)).toBe("截至章节 #13");
		expect(boundaryLabel(chapters, null)).toBe("全书");
	});

	it("T1-10 modeLabel（:188-191）：global 恒只读；book 按 execute/discuss", () => {
		expect(modeLabel(GLOBAL_SCOPE, "discuss")).toBe("只读讨论（不可写）");
		expect(modeLabel(GLOBAL_SCOPE, "execute")).toBe("只读讨论（不可写）");
		expect(modeLabel(BOOK_SCOPE, "execute")).toBe("执行操作（每步需确认）");
		expect(modeLabel(BOOK_SCOPE, "discuss")).toBe("只读讨论（不可写）");
	});

	it("T1-11 scopeStatusText（:192-201）：四段以 ' · ' 连接；book 才有边界段；会话标题/未选择/未命名逐字", () => {
		const chapters = [{ id: 12, title: "石碑" }];
		expect(
			scopeStatusText({
				scope: BOOK_SCOPE,
				books: BOOKS,
				currentConversation: { id: "c1", title: "讨论甲", status: "active" },
				boundaryChapters: chapters,
				boundaryChapterId: 12,
				mode: "execute",
			}),
		).toBe(
			"范围：《雾港编年史》 · 会话：讨论甲 · 边界：截至《石碑》 · 模式：执行操作（每步需确认）",
		);
		expect(
			scopeStatusText({
				scope: GLOBAL_SCOPE,
				books: BOOKS,
				currentConversation: null,
				boundaryChapters: [],
				boundaryChapterId: null,
				mode: "discuss",
			}),
		).toBe(
			"范围：全局资源 · 会话：未选择（发送时新建） · 模式：只读讨论（不可写）",
		);
		// 归档会话不特判（:197 逐字：只用 title||'未命名会话'）
		expect(
			scopeStatusText({
				scope: BOOK_SCOPE,
				books: BOOKS,
				currentConversation: { id: "c2", title: "", status: "archived" },
				boundaryChapters: [],
				boundaryChapterId: null,
				mode: "discuss",
			}),
		).toBe(
			"范围：《雾港编年史》 · 会话：未命名会话 · 边界：全书 · 模式：只读讨论（不可写）",
		);
	});

	it("T1-12 modeButton（:535-547）：global disabled 且 execute 回落 discuss；book 两态 label/title 逐字", () => {
		const g = modeButton(GLOBAL_SCOPE, "execute");
		expect(g.mode).toBe("discuss");
		expect(g.label).toBe("只读讨论");
		expect(g.disabled).toBe(true);
		expect(g.title).toBe(
			"全局范围只读（找书与检索）；执行操作请把「范围」切到某一本书",
		);

		const be = modeButton(BOOK_SCOPE, "execute");
		expect(be.mode).toBe("execute");
		expect(be.label).toBe("执行操作");
		expect(be.disabled).toBe(false);
		expect(be.title).toBe(
			"执行操作：可发起写操作（每一步仍需作者确认）；点此切回只读讨论",
		);

		const bd = modeButton(BOOK_SCOPE, "discuss");
		expect(bd.mode).toBe("discuss");
		expect(bd.label).toBe("只读讨论");
		expect(bd.disabled).toBe(false);
		expect(bd.title).toBe("只读讨论：可检索阅读不可写；点此进入执行模式");
	});

	it("T1-13 conversationOptions（:570-588）＋resolveBoundaryChapterId（:250-252）＋空态文案（:212）逐字", () => {
		const list = [
			{
				id: "c1",
				title: "讨论甲",
				scope: "book",
				book_id: 7,
				status: "active",
			},
			{ id: "c2", title: "", scope: "book", book_id: 7, status: "archived" },
			{ id: "c3", title: "全局", scope: "global", status: "active" },
		];
		expect(conversationOptions(list, BOOK_SCOPE, list[0])).toEqual([
			{ value: "", label: "" },
			{ value: "c1", label: "讨论甲" },
			{ value: "c2", label: "未命名会话（已归档）" },
		]);
		expect(conversationOptions(list, BOOK_SCOPE, null)).toEqual([
			{ value: "", label: "（未选择会话 · 发送时按当前范围新建）" },
			{ value: "c1", label: "讨论甲" },
			{ value: "c2", label: "未命名会话（已归档）" },
		]);
		expect(conversationOptions(list, GLOBAL_SCOPE, null)).toEqual([
			{ value: "", label: "（未选择会话 · 发送时按当前范围新建）" },
			{ value: "c3", label: "全局" },
		]);

		const chapters = [{ id: 12, title: "石碑" }];
		expect(resolveBoundaryChapterId(chapters, 12)).toBe(12);
		expect(resolveBoundaryChapterId(chapters, "13")).toBeNull();
		expect(resolveBoundaryChapterId(chapters, null)).toBeNull();
		expect(resolveBoundaryChapterId([], 12)).toBeNull();

		expect(CONVERSATION_EMPTY_HINT).toBe(
			"该范围还没有会话：发送一条消息或点「新会话」即会按当前范围新建（不会借用别的书或全局历史）。",
		);
	});
});
