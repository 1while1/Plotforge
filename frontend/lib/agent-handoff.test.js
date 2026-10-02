// S5-8 红测 T3（Plan §4 T3）：frontend/lib/agent-handoff.js —— 勾选/笔记/交接纯逻辑与 bodyHTML。
// 语义唯一事实源＝public/legacy/agent.js :695-764／:818-898／:1023-1097（逐例头注行号锚点）。
// harness＝vitest node 环境；escapeHtml 全注入（可计数）；零新增依赖。
import { describe, expect, it } from "vitest";
import {
	activeConversationLabel,
	boundaryChapterTitle,
	clipText,
	defaultHandoffText,
	defaultTargetId,
	HANDOFF_NOTE_HINT,
	HANDOFF_WRITE_HINT,
	handoffComposeBodyHTML,
	handoffDoneBodyHTML,
	handoffMaterialHTML,
	handoffPreviewBodyHTML,
	handoffTargetHint,
	noteModalBodyHTML,
	pickCountText,
	pickedContextLine,
	togglePick,
	writingOptions,
} from "./agent-handoff.js";

const escapeHtml = (s) =>
	String(s == null ? "" : s).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

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

describe("T3 agent-handoff（勾选/笔记/交接纯逻辑）", () => {
	it("T3-1 两段提示常量逐字（:695-697）", () => {
		expect(HANDOFF_NOTE_HINT).toBe(
			"规划笔记只是草稿：不写正文、不改大纲、不进事件账本（不是故事事实）。",
		);
		expect(HANDOFF_WRITE_HINT).toBe(
			"交接只向指定写作会话追加一条注明来源的消息：不改正文/大纲/人物/世界观；要改正式资料请在讨论里提出，AI 会生成待审提案，你在确认卡里放行。",
		);
	});

	it("T3-2 clipText（:699-702）：null/undefined→''；超长 slice+'…'；等于上限不截断", () => {
		expect(clipText(null, 5)).toBe("");
		expect(clipText(undefined, 5)).toBe("");
		expect(clipText("abcdef", 5)).toBe("abcde…");
		expect(clipText("abcde", 5)).toBe("abcde");
		expect(clipText(12345, 3)).toBe("123…");
	});

	it("T3-3 togglePick（:718-727）：Number(id) 去重、on=false 移除、快照 role/content（String）、按 id 升序", () => {
		expect(
			togglePick([], { id: "3", role: "user", content: "c3" }, true),
		).toEqual([{ id: 3, role: "user", content: "c3" }]);
		expect(
			togglePick(
				[
					{ id: 3, role: "user", content: "c3" },
					{ id: 1, role: "assistant", content: null },
				],
				{ id: 2, role: "assistant", content: 42 },
				true,
			),
		).toEqual([
			// 既有条目原样保留（legacy :721 只 push 未触碰的条目，不做 content 归一）
			{ id: 1, role: "assistant", content: null },
			{ id: 2, role: "assistant", content: "42" },
			{ id: 3, role: "user", content: "c3" },
		]);
		// 同 id 重复勾选只留一条（Number 比较："3" 与 3 是同一 id）
		expect(
			togglePick(
				[{ id: 3, role: "user", content: "old" }],
				{ id: 3, role: "user", content: "new" },
				true,
			),
		).toEqual([{ id: 3, role: "user", content: "new" }]);
		expect(
			togglePick(
				[
					{ id: 1, role: "user", content: "a" },
					{ id: 2, role: "user", content: "b" },
				],
				{ id: 1, role: "user", content: "a" },
				false,
			),
		).toEqual([{ id: 2, role: "user", content: "b" }]);
		const input = [{ id: 1, role: "user", content: "a" }];
		const out = togglePick(input, { id: 2, role: "user", content: "b" }, true);
		expect(input).toHaveLength(1);
		expect(out).not.toBe(input);
	});

	it("T3-4 pickedContextLine（:749-753）：#id（我|助手）：内容（300 截断）、\\n 连接", () => {
		expect(
			pickedContextLine([
				{ id: 1, role: "user", content: "问题" },
				{ id: 2, role: "assistant", content: "x".repeat(301) },
			]),
		).toBe(`#1（我）：问题\n#2（助手）：${"x".repeat(300)}…`);
		expect(pickedContextLine([])).toBe("");
	});

	it("T3-5 defaultHandoffText（:755-758）：逐条 trim→过滤空→'\\n\\n' 连接→slice(0,4000)", () => {
		expect(
			defaultHandoffText([
				{ id: 1, content: "  a  " },
				{ id: 2, content: "   " },
				{ id: 3, content: null },
				{ id: 4, content: "b" },
			]),
		).toBe("a\n\nb");
		expect(defaultHandoffText([{ id: 1, content: "y".repeat(4001) }])).toBe(
			"y".repeat(4000),
		);
	});

	it("T3-6 activeConversationLabel（:760-764）＋ pickCountText（:710）", () => {
		expect(activeConversationLabel({ id: "c1", title: "讨论甲" })).toBe(
			"讨论甲",
		);
		expect(activeConversationLabel({ id: "c1", title: "" })).toBe("未命名会话");
		expect(activeConversationLabel(null)).toBe("（未选择会话）");
		expect(pickCountText(3)).toBe("已选 3 条讨论结论");
	});

	it("T3-7 writingOptions（:818-829）：占位项/归档 disabled＋后缀/selected/escapeHtml 逐处", () => {
		const list = [
			{ id: "w<1>", title: "写作 & 会话", status: "active" },
			{ id: "w2", title: "旧会话", status: "archived" },
		];
		const calls = [];
		const esc = (s) => {
			calls.push(String(s));
			return escapeHtml(s);
		};
		const html = writingOptions(list, "w<1>", esc);
		expect(html).toContain(
			'<option value="w&lt;1&gt;" selected>写作 &amp; 会话</option>',
		);
		expect(html).toContain(
			'<option value="w2" disabled>旧会话（已归档 · 不能交接）</option>',
		);
		expect(
			html.startsWith('<option value="">（请选择写作会话）</option>'),
		).toBe(false);
		// 未选定会话时占位项在最前（:820）
		expect(
			writingOptions(list, "", esc).startsWith(
				'<option value="">（请选择写作会话）</option>',
			),
		).toBe(true);
		expect(calls).toContain("w<1>");
		expect(calls).toContain("写作 & 会话");
		expect(calls).toContain("w2");
		expect(calls).toContain("旧会话（已归档 · 不能交接）");
		// 已选定会话时不再输出占位项
		expect(
			writingOptions([list[0]], "w<1>", escapeHtml).includes(
				"（请选择写作会话）",
			),
		).toBe(false);
	});

	it("T3-8 defaultTargetId（:833-843）：记忆键命中且非归档→它；否则首个非归档；全归档/空→''；storage 抛错静默", () => {
		const list = [
			{ id: "w1", status: "archived" },
			{ id: "w2", status: "active" },
			{ id: "w3", status: "active" },
		];
		expect(
			defaultTargetId(list, 7, store({ writing_conversation_7: "w3" })),
		).toBe("w3");
		// 记忆的是归档会话→退回首个非归档
		expect(
			defaultTargetId(list, 7, store({ writing_conversation_7: "w1" })),
		).toBe("w2");
		expect(defaultTargetId(list, 7, store({}))).toBe("w2");
		expect(
			defaultTargetId([{ id: "w1", status: "archived" }], 7, store({})),
		).toBe("");
		expect(defaultTargetId([], 7, store({}))).toBe("");
		expect(
			defaultTargetId(list, 7, {
				getItem() {
					throw new Error("storage disabled");
				},
			}),
		).toBe("w2");
	});

	it("T3-9 boundaryChapterTitle（:845-850）＋handoffTargetHint（:852-858）三分支逐字", () => {
		expect(boundaryChapterTitle([{ id: 12, title: "石碑" }], 12)).toBe("石碑");
		expect(boundaryChapterTitle([{ id: 12, title: "" }], 12)).toBe("章节 #12");
		expect(boundaryChapterTitle([], 13)).toBe("章节 #13");

		expect(
			handoffTargetHint({
				bookId: null,
				bookTitle: "",
				writingList: [],
				targetId: "",
			}),
		).toBe("先选目标书，再选该书写作会话（全局讨论不自动挑书）。");
		expect(
			handoffTargetHint({
				bookId: 7,
				bookTitle: "甲",
				writingList: [],
				targetId: "",
			}),
		).toBe(
			"这本书还没有写作会话：请先在写作页打开该书（会自动建立写作会话），再回来交接。",
		);
		expect(
			handoffTargetHint({
				bookId: 7,
				bookTitle: "甲",
				writingList: [{ id: "w1", title: "写作会话" }],
				targetId: "w1",
			}),
		).toBe("将交给：《甲》· 写作会话");
		expect(
			handoffTargetHint({
				bookId: 7,
				bookTitle: "甲",
				writingList: [{ id: "w1", title: "" }],
				targetId: "",
			}),
		).toBe("将交给：《甲》· （未选择会话）");
	});

	it("T3-10 handoffComposeBodyHTML（:860-898）：bookScope/全局目标书、目标会话、引用勾选框、材料预览逐段", () => {
		const picks = [{ id: 1, role: "user", content: "结论一" }];
		const bookScope = handoffComposeBodyHTML(
			{
				bookScope: true,
				bookId: 7,
				bookTitle: "星尘<编年史>",
				writingList: [{ id: "w1", title: "写作会话", status: "active" }],
				targetId: "w1",
				picks,
				chapterId: 12,
				note: { id: 5, title: "纪要", revision: 2, conversationId: "c1" },
			},
			{ books: [], boundaryChapters: [{ id: 12, title: "石碑" }], escapeHtml },
		);
		expect(bookScope).toContain(
			`<p class="field-hint">${escapeHtml(HANDOFF_WRITE_HINT)}</p>`,
		);
		expect(bookScope).toContain(
			'<p class="field-hint">目标书：<strong>星尘&lt;编年史&gt;</strong>（当前范围；交接不能跨书）</p>',
		);
		expect(bookScope.includes('id="handoff-target-book"')).toBe(false);
		expect(bookScope).toContain(
			'<select id="handoff-target-conversation"><option value="w1" selected>写作会话</option></select>',
		);
		expect(bookScope).toContain(
			'<p class="field-hint" id="handoff-target-hint">将交给：《星尘&lt;编年史&gt;》· 写作会话</p>',
		);
		expect(bookScope).toContain(
			'<textarea id="handoff-text" rows="4">结论一</textarea>',
		);
		expect(bookScope).toContain(
			'<input type="checkbox" id="handoff-ref-chapter" checked> 来源引用：章节《石碑》（当前剧情边界）',
		);
		expect(bookScope).toContain(
			'<input type="checkbox" id="handoff-ref-note" checked> 来源引用：规划笔记《纪要》（revision 2）',
		);
		expect(bookScope).toContain(
			'<pre class="handoff-preview" id="handoff-material">#1（我）：结论一</pre>',
		);
		expect(bookScope).toContain("材料预览（选定 1 条结论）");

		const globalScope = handoffComposeBodyHTML(
			{
				bookScope: false,
				bookId: null,
				bookTitle: "",
				writingList: [],
				targetId: "",
				picks: [],
				chapterId: null,
				note: null,
			},
			{ books: [{ id: 7, title: "星尘" }], boundaryChapters: [], escapeHtml },
		);
		expect(globalScope).toContain('<option value="">（请选择目标书）</option>');
		expect(globalScope).toContain('<option value="7">星尘</option>');
		expect(globalScope).toContain(
			'<select id="handoff-target-conversation"><option value="">（这本书还没有写作会话）</option></select>',
		);
		expect(globalScope).toContain(
			'<pre class="handoff-preview" id="handoff-material">（无选定消息：只交接摘要文本）</pre>',
		);
		expect(globalScope.includes("handoff-ref-chapter")).toBe(false);
		expect(globalScope.includes("handoff-ref-note")).toBe(false);
	});

	it("T3-11 noteModalBodyHTML（:773-782）：提示段＋默认标题（200 截断）＋正文（4000 截断）＋来源行", () => {
		const html = noteModalBodyHTML(
			"雾港编年史",
			[
				{ id: 1, content: "  结论一  " },
				{ id: 2, content: "结论二" },
			],
			escapeHtml,
		);
		expect(html).toContain(
			`<p class="field-hint">${escapeHtml(HANDOFF_NOTE_HINT)}</p>`,
		);
		expect(html).toContain(
			'<input id="agent-note-title" type="text" value="雾港编年史 · 讨论纪要">',
		);
		expect(html).toContain(
			'<textarea id="agent-note-text" rows="6">结论一\n\n结论二</textarea>',
		);
		expect(html).toContain(
			'<p class="field-hint">来源：本轮勾选的 2 条讨论消息（#1、#2）</p>',
		);
		const long = noteModalBodyHTML(
			"x".repeat(300),
			[{ id: 1, content: "y".repeat(4001) }],
			escapeHtml,
		);
		expect(long).toContain(`value="${"x".repeat(200)}…"`);
		expect(long).toContain(`${"y".repeat(4000)}</textarea>`);
		// 空正文不做过滤（:780 逐字：trim 后直接 join，与 defaultHandoffText 的过滤不同）
		expect(
			noteModalBodyHTML(
				"t",
				[
					{ id: 1, content: "a" },
					{ id: 2, content: "   " },
					{ id: 3, content: "b" },
				],
				escapeHtml,
			),
		).toContain(">a\n\n\n\nb</textarea>");
	});

	it("T3-12 handoffMaterialHTML（:1023-1052）：摘要/excerpts（500 截断＋截断标记）/sourceRefs/指纹", () => {
		const html = handoffMaterialHTML(
			{
				material: {
					text: "摘要<文本>",
					excerpts: [
						{
							messageId: 1,
							role: "user",
							excerpt: "x".repeat(501),
							truncated: true,
						},
						{
							messageId: 2,
							role: "assistant",
							excerpt: "短",
							truncated: false,
						},
					],
					sourceRefs: [
						{ kind: "general", label: "通用&资料" },
						{ kind: "chapter", id: 12, title: "石碑", revision: 3 },
						{ kind: "planning_note", id: 5, revision: 2 },
					],
				},
				sourceFingerprint: "fp<1>",
			},
			escapeHtml,
		);
		expect(html).toContain(
			'<div class="field"><span>交接摘要</span><pre class="handoff-preview" id="handoff-preview-text">摘要&lt;文本&gt;</pre></div>',
		);
		expect(html).toContain("<span>选定结论（2 条）</span>");
		// clipText 自带的 '…' ＋ truncated 标记 '……（原文更长，已截断）'（:1033-1034 逐字拼接）
		expect(html).toContain(
			`<li>#1（我）：${escapeHtml("x".repeat(500))}………（原文更长，已截断）</li>`,
		);
		expect(html).toContain("<li>#2（助手）：短</li>");
		expect(html).toContain("<li>通用资料：通用&amp;资料</li>");
		expect(html).toContain("<li>章节 #12《石碑》（revision 3）</li>");
		expect(html).toContain("<li>规划笔记 #5（revision 2）</li>");
		expect(html).toContain("来源指纹：<code>fp&lt;1&gt;</code>");

		const empty = handoffMaterialHTML({ material: {} }, escapeHtml);
		expect(empty).toContain("（无摘要文本）");
		expect(empty).toContain("<li>（无：只交接摘要文本）</li>");
		expect(empty).toContain("<li>（无引用）</li>");
		expect(empty).toContain("（来源已变更，需重新预览）");
	});

	it("T3-13 handoffPreviewBodyHTML（:1054-1097）/ handoffDoneBodyHTML（:1056-1068）：三分支头＋acceptDisabled＋三按钮＋两段尾注", () => {
		const busy = handoffPreviewBodyHTML(
			{
				id: "h1",
				target: { title: "写作会话", busy: true },
				material: {},
				sourceFingerprint: "fp",
			},
			escapeHtml,
		);
		expect(busy.acceptDisabled).toBe(true);
		expect(busy.html).toContain(
			"<strong>⚠ 目标会话正在运行中：等这一轮结束再接受</strong>（不会混进正在发给模型的请求）。运行结束后点「重新预览」再交接。",
		);
		expect(busy.html).toContain(
			'<button type="button" id="btn-handoff-accept" class="btn btn-small btn-primary" disabled>',
		);
		expect(busy.html).toContain('id="btn-handoff-refresh"');
		expect(busy.html).toContain('id="btn-handoff-cancel"');
		expect(busy.html).toContain(
			"关闭本窗口＝不交接：草案保留为草稿，不写入任何内容。",
		);
		expect(busy.html).toContain(
			"「作废草案」只作废这份还没交接的草案（未向写作会话写入任何内容，且不撤回任何已写进写作会话的消息）。",
		);

		const stale = handoffPreviewBodyHTML(
			{
				id: "h1",
				target: { busy: false },
				material: {},
				sourceChanged: true,
				sourceIssue: "章节已变",
			},
			escapeHtml,
		);
		expect(stale.acceptDisabled).toBe(true);
		expect(stale.html).toContain("<strong>⚠ 来源已变更：章节已变</strong>");
		// 无指纹也按 stale
		const noFp = handoffPreviewBodyHTML(
			{ id: "h1", target: {}, material: {} },
			escapeHtml,
		);
		expect(noFp.acceptDisabled).toBe(true);
		expect(noFp.html).toContain("需要重新预览");

		const ok = handoffPreviewBodyHTML(
			{
				id: "h1",
				target: { title: "写作会话", busy: false },
				material: {},
				sourceFingerprint: "fp",
			},
			escapeHtml,
		);
		expect(ok.acceptDisabled).toBe(false);
		expect(ok.html).toContain("目标会话空闲，可接受。");
		expect(ok.html).toContain(
			'<button type="button" id="btn-handoff-accept" class="btn btn-small btn-primary">接受交接（写入写作会话）</button>',
		);

		const done = handoffDoneBodyHTML(
			{
				target: { title: "写作<会话>" },
				acceptedMessageId: "m9",
				material: { text: "t" },
				sourceFingerprint: "fp",
			},
			escapeHtml,
		);
		expect(done).toContain(
			"已交接到 <strong>写作&lt;会话&gt;</strong>：消息 #m9（重复点击不会再插入第二条）。",
		);
		expect(done).toContain(escapeHtml(HANDOFF_WRITE_HINT));
	});
});
