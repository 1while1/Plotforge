// S5-8 红测 T2（Plan §4 T2）：frontend/lib/agent-resources.js —— 受控资源目录纯逻辑。
// 语义唯一事实源＝public/legacy/agent.js :46-77／:280-503（逐例头注 legacy 行号锚点）。
// 两条 URL 形状逐字（列表/续读、单件摘要 id 在前 bookId 在后）；server/** 零改动。
// harness＝vitest node 环境；零新增依赖。
import { describe, expect, it, vi } from "vitest";
import {
	BOOK_ID_TYPES,
	normalizeResourceView,
	previewFailText,
	previewModel,
	RES_DETAIL_LABELS,
	RES_EMPTY_HINT,
	RES_EMPTY_TEXT,
	RES_LOADING_TEXT,
	RES_META_LABELS,
	RES_NO_PAGE_HINT,
	RES_STATUS_LABELS,
	RES_TYPE_LABELS,
	resourceDetailUrl,
	resourceListFailText,
	resourceListHint,
	resourceListUrl,
	resourceMetaText,
	resourceQuery,
	resourceRowModel,
	resourceTypesForScope,
} from "./agent-resources.js";
import { BOOK_SCOPED_TYPES, GLOBAL_SCOPED_TYPES } from "./agent-scope.js";

const BOOK_SCOPE = { kind: "book", bookId: 7 };
const GLOBAL_SCOPE = { kind: "global", bookId: null };
const BOOKS = [{ id: 7, title: "雾港编年史" }];

describe("T2 agent-resources（受控资源目录纯逻辑）", () => {
	it("T2-1 四张标签表逐字（:51-77）：10／15／46／20 键＋关键中文", () => {
		expect(RES_TYPE_LABELS).toEqual({
			book: "书籍",
			chapter: "章节",
			outline: "大纲（卷）",
			character: "人物",
			world: "世界观",
			ledger: "事件账本",
			style: "作家卡",
			corpus: "语料元数据",
			task: "任务 / 运行",
			system: "系统能力",
		});
		// 注：Plan §4 T2-1 写「14 键」，legacy :55-59 实测 15 键（以源码为准，台账留勘误）
		expect(RES_STATUS_LABELS).toEqual({
			active: "在场",
			archived: "已归档",
			locked: "已定稿",
			draft: "草稿",
			stale: "已过期",
			enabled: "启用",
			disabled: "停用",
			ready: "就绪",
			empty: "空",
			canonical: "正典",
			configured: "已配置",
			unconfigured: "未配置",
			deleted: "已删除（回收站）",
			ok: "正常",
			collab: "协作模式",
		});
		expect(RES_META_LABELS).toEqual({
			sortOrder: "序号",
			revision: "版本",
			locked: "定稿",
			volumeId: "所属卷",
			charCount: "正文字数",
			summaryChars: "摘要字数",
			outlineChars: "大纲字数",
			stale: "摘要过期",
			chapterCount: "章节数",
			characterCount: "人物数",
			volumeCount: "卷数",
			eventCount: "事件数",
			role: "身份",
			archived: "已归档",
			aliasCount: "别名数",
			relationCount: "关系数",
			importance: "重要性",
			origin: "来源",
			sourceStale: "来源过期",
			pendingProposalCount: "待审提案",
			kind: "类型",
			shared: "共享卡",
			builtin: "内置",
			enabled: "启用",
			ruleCount: "规则条目",
			sampleCount: "范文段数",
			indexedSampleCount: "索引段数",
			lastIndexedAt: "最近索引时间",
			works: "作品",
			hanCount: "汉字数",
			docCount: "文档数",
			jobCount: "蒸馏任务数",
			maskDictVersion: "掩码词表",
			model: "模型",
			modelConfigured: "模型已配置",
			keyConfigured: "密钥已配置",
			thinkingDisabledModels: "关闭思考模型",
			protocol: "协议",
			entry: "入口",
			mode: "模式",
			finishedAt: "结束时间",
			hasConversation: "有会话绑定",
			intro: "简介",
			masterOutlineChars: "总纲字数",
			chapterId: "所属章",
			driftStatus: "偏离状态",
		});
		expect(RES_DETAIL_LABELS).toEqual({
			index: "索引",
			note: "备注",
			persona: "人设",
			boundBooks: "绑定书籍",
			summary: "摘要",
			beat: "节拍",
			content: "内容",
			intro: "简介",
			outline: "大纲",
			aliases: "别名",
			jobs: "蒸馏任务",
			driftStatus: "偏离状态",
			conversationId: "会话",
			eventCount: "事件数",
			vectorModel: "向量模型",
			samples: "范文段数",
			indexed: "已索引",
			lastIndexedAt: "最近索引时间",
			stage: "阶段",
			status: "状态",
		});
		expect(BOOK_ID_TYPES).toEqual({
			chapter: 1,
			outline: 1,
			character: 1,
			world: 1,
			ledger: 1,
			style: 1,
			task: 1,
		});
	});

	it("T2-2 resourceTypesForScope（:46-49／:280-282）：书内七类型／全局五类型，返回副本", () => {
		expect(resourceTypesForScope(BOOK_SCOPE)).toEqual([
			"chapter",
			"outline",
			"character",
			"world",
			"ledger",
			"style",
			"task",
		]);
		expect(resourceTypesForScope(GLOBAL_SCOPE)).toEqual([
			"book",
			"style",
			"corpus",
			"task",
			"system",
		]);
		const copy = resourceTypesForScope(BOOK_SCOPE);
		copy.push("book");
		expect(BOOK_SCOPED_TYPES).toEqual([
			"chapter",
			"outline",
			"character",
			"world",
			"ledger",
			"style",
			"task",
		]);
		expect(GLOBAL_SCOPED_TYPES).toEqual([
			"book",
			"style",
			"corpus",
			"task",
			"system",
		]);
	});

	it("T2-3 类型回落（:287）：不在当前范围类型表→取首项并清 cursor/items（返回新状态）", () => {
		const view = { resType: "book", resCursor: "c1", resItems: [{ id: 1 }] };
		expect(normalizeResourceView(BOOK_SCOPE, view)).toEqual({
			resType: "chapter",
			resCursor: null,
			resItems: [],
		});
		expect(view).toEqual({
			resType: "book",
			resCursor: "c1",
			resItems: [{ id: 1 }],
		});
		expect(
			normalizeResourceView(BOOK_SCOPE, {
				resType: "style",
				resCursor: "c2",
				resItems: [],
			}),
		).toEqual({ resType: "style", resCursor: "c2", resItems: [] });
		expect(
			normalizeResourceView(GLOBAL_SCOPE, {
				resType: "",
				resCursor: null,
				resItems: [],
			}).resType,
		).toBe("book");
	});

	it("T2-4 resourceQuery（:299-304）：type 恒在并编码；bookId 只在书籍范围且属 BOOK_ID_TYPES 时带；parts 依序追加", () => {
		expect(resourceQuery(BOOK_SCOPE, "chapter", [])).toBe(
			"type=chapter&bookId=7",
		);
		expect(resourceQuery(GLOBAL_SCOPE, "chapter", [])).toBe("type=chapter");
		expect(resourceQuery(BOOK_SCOPE, "style", [])).toBe("type=style&bookId=7");
		expect(resourceQuery(GLOBAL_SCOPE, "style", [])).toBe("type=style");
		expect(resourceQuery(BOOK_SCOPE, "task", [])).toBe("type=task&bookId=7");
		expect(resourceQuery(GLOBAL_SCOPE, "task", [])).toBe("type=task");
		// book/corpus/system 不接受 bookId（服务端 400）
		expect(resourceQuery(BOOK_SCOPE, "book", [])).toBe("type=book");
		expect(resourceQuery(BOOK_SCOPE, "corpus", [])).toBe("type=corpus");
		expect(resourceQuery(BOOK_SCOPE, "system", [])).toBe("type=system");
		expect(resourceQuery({ kind: "book", bookId: "a b" }, "chapter", [])).toBe(
			"type=chapter&bookId=a%20b",
		);
		expect(
			resourceQuery(BOOK_SCOPE, "chapter", ["cursor=c%2F1", "limit=100"]),
		).toBe("type=chapter&bookId=7&cursor=c%2F1&limit=100");
	});

	it("T2-5 resourceMetaText（:306-336）十类型逐条＋尾部更新，' · ' 连接", () => {
		expect(resourceMetaText({ type: "chapter", meta: { sortOrder: 3 } })).toBe(
			"第3章",
		);
		expect(
			resourceMetaText({
				type: "style",
				meta: {
					ruleCount: 4,
					indexedSampleCount: 9,
					sampleCount: 12,
					shared: true,
				},
			}),
		).toBe("规则 4 · 索引 9/12 · 共享卡");
		expect(resourceMetaText({ type: "style", meta: {} })).toBe(
			"规则 0 · 索引 0/0",
		);
		expect(resourceMetaText({ type: "book", meta: { chapterCount: 5 } })).toBe(
			"章节 5",
		);
		expect(resourceMetaText({ type: "book", meta: {} })).toBe("章节 0");
		expect(
			resourceMetaText({
				type: "outline",
				meta: { outlineChars: 1200, stale: true },
			}),
		).toBe("大纲 1200 字 · 卷摘要已过期");
		expect(
			resourceMetaText({ type: "character", meta: { role: "主角" } }),
		).toBe("身份 主角");
		expect(
			resourceMetaText({ type: "character", meta: { archived: true } }),
		).toBe("人物 · 已归档");
		expect(
			resourceMetaText({ type: "world", meta: { contentChars: 88 } }),
		).toBe("设定 88 字");
		expect(resourceMetaText({ type: "ledger", meta: { chapterId: 5 } })).toBe(
			"事件 · 挂第 5 章",
		);
		expect(resourceMetaText({ type: "ledger", meta: {} })).toBe("事件");
		expect(
			resourceMetaText({
				type: "task",
				meta: { entry: "run", mode: "manual" },
			}),
		).toBe("run / manual");
		expect(resourceMetaText({ type: "task", meta: {} })).toBe(" / ");
		expect(
			resourceMetaText({ type: "system", meta: { model: "step-3.7-flash" } }),
		).toBe("step-3.7-flash");
		expect(resourceMetaText({ type: "system", meta: {} })).toBe("未配置模型");
		expect(resourceMetaText({ type: "corpus", meta: { docCount: 3 } })).toBe(
			"文档 3",
		);
		expect(
			resourceMetaText({
				type: "chapter",
				meta: { sortOrder: 1 },
				updatedAt: "2026-09-28 10:00",
			}),
		).toBe("第1章 · 更新 2026-09-28 10:00");
	});

	it("T2-6 列表 URL（:344）：/api/resources?<query>；续读 cursor 追加在尾部（编码）", () => {
		expect(resourceListUrl(BOOK_SCOPE, "chapter", null)).toBe(
			"/api/resources?type=chapter&bookId=7",
		);
		expect(resourceListUrl(GLOBAL_SCOPE, "book", null)).toBe(
			"/api/resources?type=book",
		);
		expect(resourceListUrl(BOOK_SCOPE, "chapter", "c/1")).toBe(
			"/api/resources?type=chapter&bookId=7&cursor=c%2F1",
		);
	});

	it("T2-7 行模型（:364-395）：title＝(title||'#id')＋状态中文；空态文案带 agent-tools-hint（:371）", () => {
		expect(
			resourceRowModel({
				type: "chapter",
				id: 12,
				title: "石碑",
				status: "locked",
			}),
		).toEqual({
			type: "chapter",
			id: 12,
			title: "石碑 · 已定稿",
			statusLabel: "已定稿",
			metaText: "",
		});
		expect(
			resourceRowModel({ type: "chapter", id: 13, status: "weird" }),
		).toEqual({
			type: "chapter",
			id: 13,
			title: "#13 · weird",
			statusLabel: "weird",
			metaText: "",
		});
		expect(resourceRowModel({ type: "world", id: 3 })).toEqual({
			type: "world",
			id: 3,
			title: "#3",
			statusLabel: "",
			metaText: "设定 0 字",
		});
		expect(RES_EMPTY_HINT).toBe(
			"该类型在当前范围内没有资源（空态，不是错误）。",
		);
	});

	it("T2-8 列表提示行（:356-361）逐字；失败文案（:349）逐字", () => {
		expect(resourceListHint(BOOK_SCOPE, BOOKS, "chapter", 3, true)).toBe(
			"范围：《雾港编年史》 · 类型：章节 · 已列出 3 项（还有更多）。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。",
		);
		expect(resourceListHint(GLOBAL_SCOPE, BOOKS, "system", 0, false)).toBe(
			"范围：全局资源 · 类型：系统能力 · 已列出 0 项。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。",
		);
		expect(
			resourceListHint(GLOBAL_SCOPE, BOOKS, "unknown-type", 1, false),
		).toContain("类型：unknown-type");
		expect(resourceListFailText("boom")).toBe("资源读取失败：boom");
	});

	it("T2-9 摘要 URL（:408-410）：id 在前、bookId 在后；加载/失败/空态文案（:405/:419/:446）", () => {
		expect(resourceDetailUrl(BOOK_SCOPE, "chapter", 12)).toBe(
			"/api/resources?type=chapter&id=12&bookId=7",
		);
		expect(resourceDetailUrl(GLOBAL_SCOPE, "chapter", 12)).toBe(
			"/api/resources?type=chapter&id=12",
		);
		expect(resourceDetailUrl(BOOK_SCOPE, "book", 7)).toBe(
			"/api/resources?type=book&id=7",
		);
		expect(resourceDetailUrl(BOOK_SCOPE, "style", "s1")).toBe(
			"/api/resources?type=style&id=s1&bookId=7",
		);
		expect(RES_LOADING_TEXT).toBe("正在读取摘要…");
		expect(RES_EMPTY_TEXT).toBe("没有可展示的摘要。");
		expect(previewFailText("boom")).toBe("摘要读取失败：boom");
	});

	it("T2-10 预览模型（:439-503）：标题/状态行/found===false/meta/details/route/book 型切范围", () => {
		const onSwitchScope = vi.fn();
		const model = previewModel(
			{
				type: "chapter",
				id: 12,
				title: "石碑",
				status: "locked",
				meta: {
					sortOrder: 2,
					revision: 3,
					shared: false,
					emptyArr: [],
					nil: null,
					blank: "",
				},
				details: {
					note: "备注",
					aliases: ["阿石", "小石"],
					driftStatus: { status: "ok" },
					unknownKey: "原键",
				},
				route: "#/book/7/chapters/12",
			},
			{ onSwitchScope },
		);
		expect(model.title).toBe("章节 · 石碑");
		expect(model.rows).toEqual([
			{ key: "状态", value: "已定稿" },
			{ key: "序号", value: "2" },
			{ key: "版本", value: "3" },
			{ key: "共享卡", value: "false" },
			{ key: "备注", value: "备注" },
			{ key: "别名", value: "阿石、小石" },
			{ key: "偏离状态 · 状态", value: "ok" },
			// 未登记的键名回落原键（:476 `RES_DETAIL_LABELS[sk] || sk`）
			{ key: "unknownKey", value: "原键" },
		]);
		expect(model.link).toEqual({
			href: "#/book/7/chapters/12",
			text: "打开工作台 →",
			title: "站内跳转：#/book/7/chapters/12",
		});
		expect(model.noPageHint).toBeNull();
		expect(model.isBook).toBe(false);
		expect(model.found).toBe(true);

		const gone = previewModel({
			type: "world",
			id: 3,
			title: "",
			status: "",
			found: false,
			deletedAt: "2026-09-01",
		});
		expect(gone.title).toBe("世界观 · #3");
		expect(gone.rows[0]).toEqual({ key: "状态", value: "—" });
		expect(gone.rows[1]).toEqual({
			key: "说明",
			value: "该引用已不在正典（2026-09-01）",
		});
		expect(gone.link).toBeNull();
		expect(gone.noPageHint).toBe(
			"该类资源没有站内页面，这里只展示元数据与摘要（不提供文件浏览）。",
		);
		expect(RES_NO_PAGE_HINT).toBe(
			"该类资源没有站内页面，这里只展示元数据与摘要（不提供文件浏览）。",
		);

		const bookModel = previewModel(
			{ type: "book", id: 7, title: "雾港编年史" },
			{ onSwitchScope },
		);
		expect(bookModel.isBook).toBe(true);
		expect(bookModel.switchScopeValue).toBe("book:7");
		expect(bookModel.onSwitchScope).toBe(onSwitchScope);
		expect(previewModel(null)).toBeNull();
	});
});
