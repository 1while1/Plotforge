// S5-5 红测（Plan §4 T1，T1-1~T1-14）：frontend/lib/chat-render.js 纯逻辑对等移植。
// 语义唯一事实源＝public/legacy/book-chat.js（逐例头注 legacy 行号锚点；该文件本片零 diff）。
// harness＝vitest node 环境（vite.config.mjs test.environment='node'）；零新增依赖。
import { describe, expect, it } from "vitest";
import {
	ACTION_STATUS_FALLBACK,
	ACTION_STATUS_META,
	actionStatusMeta,
	argsSummary,
	buildConfirmPreviewArgs,
	confirmNeedsRelock,
	ctxMeterPercent,
	ctxMeterText,
	ENVELOPE_MARK,
	expiredBatchKey,
	fmtK,
	fmtTs,
	makeSourceTag,
	matchEnvelope,
	matchNearest,
	NEAREST_WINDOW_MS,
	normalizeActionStatus,
	parseLocalTs,
	parseQuickReplies,
	planActionReplay,
	pushQuickOptions,
	SOURCE_LABELS,
	sourceLabel,
	TOOL_LABELS,
	toolLabel,
} from "./chat-render.js";

// legacy :421-434 状态表逐字（本表即期望值，不引用被测实现）
const EXPECTED_STATUS_META = {
	pending: { text: "", readonly: false },
	executing: { text: "执行中…", readonly: true },
	approved: { text: "已执行 ✓", readonly: true },
	rejected: { text: "已拒绝，未做任何改动", readonly: true },
	expired: { text: "已过期未执行（等待确认超时）", readonly: true },
	superseded: { text: "已被更新的同类请求取代（未执行）", readonly: true },
	failed: { text: "执行失败", readonly: true },
	interrupted: {
		text: "执行中断，可能已部分生效——请核对目标内容后重新发起",
		readonly: true,
	},
};

// legacy :377-397 工具友好名 19 条逐字
const EXPECTED_TOOL_LABELS = {
	search_story: "语义检索旧文",
	grep_chapters: "关键词查全文",
	read_chapter: "阅读章节",
	read_chapter_range: "分段阅读章节",
	list_chapters: "列出章节",
	get_story_state: "读取状态簿",
	list_characters: "查看人物卡",
	list_worldview: "查看世界观",
	get_book_info: "查看本书信息",
	create_chapter: "新建章节",
	append_chapter: "追加章节正文",
	replace_chapter: "替换章节正文",
	set_chapter_meta: "修改章节标题/节拍",
	set_master_outline: "设置全书总纲",
	update_volume: "修改分卷",
	add_character: "新增人物卡",
	update_character: "更新人物卡",
	add_worldview: "新增世界观条目",
	write_story_state: "改写状态簿",
};

function localTs(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

describe("T1 chat-render 纯逻辑（legacy 行号锚点）", () => {
	it("T1-1 ACTION_STATUS_META 八条逐字＋readonly 布尔；fallback 逐字（:421-434）", () => {
		expect(Object.keys(ACTION_STATUS_META)).toEqual([
			"pending",
			"executing",
			"approved",
			"rejected",
			"expired",
			"superseded",
			"failed",
			"interrupted",
		]);
		expect(ACTION_STATUS_META).toEqual(EXPECTED_STATUS_META);
		expect(ACTION_STATUS_FALLBACK).toEqual({
			text: "已结算（状态未知）",
			readonly: true,
		});
	});

	it("T1-2 normalizeActionStatus：空/非串→pending；未知→unknown；已知原样（:436-439）", () => {
		expect(normalizeActionStatus(undefined)).toBe("pending");
		expect(normalizeActionStatus("")).toBe("pending");
		expect(normalizeActionStatus("   ")).toBe("pending");
		expect(normalizeActionStatus(null)).toBe("pending");
		expect(normalizeActionStatus(7)).toBe("pending");
		expect(normalizeActionStatus("foo")).toBe("unknown");
		expect(normalizeActionStatus(" pending ")).toBe("pending");
		expect(normalizeActionStatus("interrupted")).toBe("interrupted");
	});

	it("T1-3 actionStatusMeta：unknown 走 fallback；pending 非只读（:441-443）", () => {
		expect(actionStatusMeta("unknown")).toBe(ACTION_STATUS_FALLBACK);
		expect(actionStatusMeta("pending").readonly).toBe(false);
		expect(actionStatusMeta("approved")).toBe(ACTION_STATUS_META.approved);
	});

	it("T1-4 TOOL_LABELS 19 条逐字；toolLabel 回落与「未知操作」（:377-397、:1434-1436）", () => {
		expect(Object.keys(TOOL_LABELS).length).toBe(19);
		expect(TOOL_LABELS).toEqual(EXPECTED_TOOL_LABELS);
		expect(toolLabel("append_chapter")).toBe("追加章节正文");
		expect(toolLabel("不存在")).toBe("不存在");
		expect(toolLabel("")).toBe("未知操作");
		expect(toolLabel(undefined)).toBe("未知操作");
	});

	it("T1-5 SOURCE_LABELS 四值＋makeSourceTag 语义（:369-374、:855-863）", () => {
		expect(SOURCE_LABELS).toEqual({
			writing: "写作台",
			read: "阅读页",
			agent: "助手",
			system: "系统",
		});
		expect(sourceLabel("writing")).toBe("写作台");
		expect(sourceLabel("")).toBe("");
		expect(sourceLabel("bogus")).toBe("");
		expect(makeSourceTag("")).toBeNull();
		expect(makeSourceTag("bogus")).toBeNull();
		expect(makeSourceTag(undefined)).toBeNull();
		expect(makeSourceTag("read")).toEqual({
			className: "msg-source msg-source-read",
			textContent: "阅读页",
		});
		expect(makeSourceTag("system")).toEqual({
			className: "msg-source msg-source-system",
			textContent: "系统",
		});
	});

	it("T1-6a parseQuickReplies：多问题分组＋编号行也算问题（:306-338）", () => {
		const groups = parseQuickReplies(
			"1. 接下来怎么走？(加快节奏/放慢节奏)\n2. 林晚的态度？（强硬／示弱）",
		);
		expect(groups).toEqual([
			{ question: "接下来怎么走？", options: ["加快节奏", "放慢节奏"] },
			{ question: "林晚的态度？", options: ["强硬", "示弱"] },
		]);
		// 行首编号且带括号选项（无问号）同样按问题行处理
		expect(parseQuickReplies("1. 选择方向（前进/后退）")).toEqual([
			{ question: "选择方向", options: ["前进", "后退"] },
		]);
		expect(parseQuickReplies("一、要不要加个反派（加/不加）")).toEqual([
			{ question: "要不要加个反派", options: ["加", "不加"] },
		]);
	});

	it("T1-6b parseQuickReplies：/ 与 ／ 双分隔、尾标点去尾、空/超 20 字丢弃（:296-304）", () => {
		const long = "超".repeat(21);
		// 逐字口径：只去**最后一个**尾标点（`replace(/[。；;，,]$/, '')`）、空段跳过、>20 字跳过
		const groups = parseQuickReplies(
			`要加吗？（a。；b,／c;／/d/，/${long}/。）`,
		);
		expect(groups).toEqual([
			{ question: "要加吗？", options: ["a。；b", "c", "d"] },
		]);
		expect(parseQuickReplies("要加吗？（选A，／选B。）")).toEqual([
			{ question: "要加吗？", options: ["选A", "选B"] },
		]);
	});

	it("T1-6c parseQuickReplies：每组 ≤4、最多 3 组、超组丢弃不并入上一组（:318-333）", () => {
		const groups = parseQuickReplies(
			"1. Q1？（a/b/c/d/e/f）\n2. Q2？（g）\n3. Q3？（h）\n4. Q4？（i）",
		);
		expect(groups.length).toBe(3);
		expect(groups[0].options).toEqual(["a", "b", "c", "d"]);
		expect(groups[2].options).toEqual(["h"]);
		// 第 4 组被丢弃：绝不并进上一组
		expect(groups.every((g) => !g.options.includes("i"))).toBe(true);
	});

	it("T1-6d parseQuickReplies：loose 平铺兜底与全空（:309/:330-337）", () => {
		expect(parseQuickReplies("（继续/停止）")).toEqual([
			{ question: "", options: ["继续", "停止"] },
		]);
		expect(parseQuickReplies("（继续/停止/再想想/换个方向/不要）")).toEqual([
			{ question: "", options: ["继续", "停止", "再想想", "换个方向"] },
		]);
		expect(parseQuickReplies("没有括号也没有问题")).toEqual([]);
		expect(parseQuickReplies("")).toEqual([]);
		expect(parseQuickReplies(null)).toEqual([]);
		expect(parseQuickReplies(undefined)).toEqual([]);
	});

	it("T1-6e pushQuickOptions：去重、上限、空串跳过（:296-304）", () => {
		const arr = [];
		pushQuickOptions(arr, "a/a/b", 2);
		expect(arr).toEqual(["a", "b"]);
		const full = ["x", "y"];
		pushQuickOptions(full, "z", 2);
		expect(full).toEqual(["x", "y"]);
	});

	it("T1-7 fmtK：'—'/'0'/'999'/'1.0K'/'128.0K'（:666-669）", () => {
		expect(fmtK(null)).toBe("—");
		expect(fmtK(undefined)).toBe("—");
		expect(fmtK(0)).toBe("0");
		expect(fmtK(999)).toBe("999");
		expect(fmtK(1000)).toBe("1.0K");
		expect(fmtK(128000)).toBe("128.0K");
	});

	it("T1-8 parseLocalTs 本地时区解析／非法 NaN；fmtTs 补零与空值（:1412-1424）", () => {
		expect(parseLocalTs("2026-09-11 03:24:22")).toBe(
			new Date(2026, 8, 11, 3, 24, 22).getTime(),
		);
		expect(parseLocalTs("2026-09-11T03:24:22")).toBe(
			new Date(2026, 8, 11, 3, 24, 22).getTime(),
		);
		expect(Number.isNaN(parseLocalTs(""))).toBe(true);
		expect(Number.isNaN(parseLocalTs("2026/09/11 03:24:22"))).toBe(true);
		expect(Number.isNaN(parseLocalTs(undefined))).toBe(true);
		expect(fmtTs(0)).toBe("");
		expect(fmtTs("")).toBe("");
		expect(fmtTs(null)).toBe("");
		expect(fmtTs(new Date(2026, 0, 5, 7, 8).getTime())).toBe(
			"2026-01-05 07:08",
		);
	});

	it("T1-9 argsSummary：JSON 失败回落空串、默认 240、超限 slice+'…'（:1426-1432）", () => {
		expect(argsSummary({ a: 1 })).toBe('{"a":1}');
		expect(argsSummary(null)).toBe("{}");
		expect(argsSummary(undefined)).toBe("{}");
		const circular = {};
		circular.self = circular;
		expect(argsSummary(circular)).toBe("");
		const long = JSON.stringify({ text: "x".repeat(300) });
		expect(long.length).toBeGreaterThan(240);
		expect(argsSummary({ text: "x".repeat(300) })).toBe(
			`${long.slice(0, 240)}…`,
		);
		expect(argsSummary({ a: "x".repeat(300) }, 10)).toBe('{"a":"xxxx…');
	});

	it("T1-10 expiredBatchKey：'<bookId>|<排序 id 逗号连接>'，空 id 参与排序（:1470-1471）", () => {
		expect(expiredBatchKey("B1", [{ id: "b" }, { id: "a" }])).toBe("B1|a,b");
		expect(expiredBatchKey(null, [{ id: "" }, {}])).toBe("|,");
		expect(expiredBatchKey(7, [])).toBe("7|");
		expect(expiredBatchKey(undefined, [{ id: "x" }])).toBe("|x");
	});

	it("T1-11a planActionReplay：pending 同参只留最新一张（:1624-1635）", () => {
		const r = planActionReplay(
			[],
			[
				{
					id: 2,
					name: "append_chapter",
					status: "pending",
					args: { chapterId: 3 },
					createdAt: 200,
				},
				{
					id: 1,
					name: "append_chapter",
					status: "pending",
					args: { chapterId: 3 },
					createdAt: 100,
				},
				{
					id: 3,
					name: "write_story_state",
					status: "pending",
					args: {},
					createdAt: 300,
				},
			],
		);
		expect(r.pending.map((p) => p.action.id)).toEqual([1, 2, 3]);
		const byId = Object.fromEntries(r.pending.map((p) => [p.action.id, p]));
		expect(byId[1].key).toBe('append_chapter|{"chapterId":3}');
		expect(byId[1].key).toBe(byId[2].key);
		expect(byId[1].dropKey).toBe(true);
		expect(byId[2].dropKey).toBe(false);
		expect(byId[3].dropKey).toBe(false);
		expect(r.logs).toEqual([]);
		expect(r.unplaced).toEqual([]);
	});

	it("T1-11b planActionReplay：信封匹配（标记＋工具名＋120 字符 args 前缀，消费式）（:1539-1556）", () => {
		expect(ENVELOPE_MARK).toBe("[确认执行结果·系统事件]");
		expect(NEAREST_WINDOW_MS).toBe(30 * 60 * 1000);
		const args = { chapterId: 3, text: "正文片段" };
		const msg = {
			id: "m1",
			role: "assistant",
			created_at: localTs(1_700_000_000_000),
			content: `${ENVELOPE_MARK}\n此前你请求执行的写工具 append_chapter\n参数：${JSON.stringify(args)}`,
		};
		const a1 = {
			id: 7,
			name: "append_chapter",
			status: "approved",
			args,
			createdAt: 5,
		};
		const r = planActionReplay([msg], [a1]);
		expect(r.logs.length).toBe(1);
		expect(r.logs[0].anchorMessageId).toBe("m1");
		expect(r.logs[0].action.id).toBe(7);
		expect(r.pending).toEqual([]);
		expect(r.unplaced).toEqual([]);
		// 消费式：同一条消息不被第二张卡复用
		const a2 = {
			id: 8,
			name: "append_chapter",
			status: "approved",
			args,
			createdAt: 6,
		};
		const r2 = planActionReplay([msg], [a1, a2]);
		expect(r2.logs.map((l) => l.action.id)).toEqual([7]);
		expect(r2.unplaced).toEqual([8]);
	});

	it("T1-11c planActionReplay：就近配对 30 分钟窗口（:1558-1574）", () => {
		const base = new Date(2026, 8, 11, 3, 24, 22).getTime();
		const msg = {
			id: "m2",
			role: "assistant",
			created_at: localTs(base),
			content: "普通正文",
		};
		const near = planActionReplay(
			[msg],
			[
				{
					id: 9,
					name: "write_story_state",
					status: "approved",
					args: { a: 1 },
					settledAt: base + 10 * 60 * 1000,
				},
			],
		);
		expect(near.logs.map((l) => l.anchorMessageId)).toEqual(["m2"]);
		const far = planActionReplay(
			[msg],
			[
				{
					id: 9,
					name: "write_story_state",
					status: "approved",
					args: { a: 1 },
					settledAt: base + 40 * 60 * 1000,
				},
			],
		);
		expect(far.logs).toEqual([]);
		expect(far.unplaced).toEqual([9]);
	});

	it("T1-11d planActionReplay：都匹配不到→unplaced，不末尾堆砌（:1537-1538、:1637-1638）", () => {
		const r = planActionReplay(
			[],
			[
				{
					id: 11,
					name: "write_story_state",
					status: "rejected",
					args: {},
					createdAt: 1,
				},
			],
		);
		expect(r.logs).toEqual([]);
		expect(r.unplaced).toEqual([11]);
	});

	it("T1-12 ctxMeterText／ctxMeterPercent：usage 真实值与估算两分支（:676-699）", () => {
		expect(ctxMeterText(null)).toBe("上下文 — / —");
		expect(ctxMeterPercent(null)).toBe(0);
		expect(
			ctxMeterText({
				usage: { prompt_tokens: 64000, cache_hit_tokens: 1024 },
				contextWindow: 128000,
			}),
		).toBe("上下文 64.0K / 128.0K（50%） · 缓存命中 1.0K");
		expect(
			ctxMeterPercent({
				usage: { prompt_tokens: 64000 },
				contextWindow: 128000,
			}),
		).toBe(50);
		expect(
			ctxMeterText({
				usage: null,
				estimatedPromptTokens: 12345,
				contextWindow: 128000,
				messages: { active: 5 },
			}),
		).toBe("上下文 ≈12.3K / 128.0K（10%）· 活跃 5 条");
		expect(
			ctxMeterText({
				usage: null,
				estimatedPromptTokens: 12345,
				contextWindow: 128000,
				messages: { active: 5, archived: 7 },
			}),
		).toBe("上下文 ≈12.3K / 128.0K（10%）· 活跃 5 条 · 已归档 7 条");
		// 窗口来源透明化后缀（:680-684）
		expect(
			ctxMeterText({
				clamped: true,
				windowManual: 64000,
				contextWindow: 128000,
				usage: { prompt_tokens: 1000 },
			}),
		).toBe("上下文 1.0K / 128.0K（1%） · 设 64.0K 被钳制为 128.0K");
		expect(
			ctxMeterText({
				officialSource: "not_fetched",
				usage: { prompt_tokens: 1000 },
				contextWindow: 128000,
			}),
		).toBe("上下文 1.0K / 128.0K（1%） · 官方源尚未拉取");
		expect(
			ctxMeterText({
				officialSource: "channel_reported",
				windowOfficial: 256000,
				usage: { prompt_tokens: 1000 },
				contextWindow: 256000,
			}),
		).toBe("上下文 1.0K / 256.0K（0%） · 官方 256.0K");
		expect(
			ctxMeterText({
				officialSource: "channel_not_reported",
				windowManual: 64000,
				usage: { prompt_tokens: 1000 },
				contextWindow: 128000,
			}),
		).toBe("上下文 1.0K / 128.0K（1%） · 渠道未报官方上限，按你设置生效");
		expect(
			ctxMeterText({
				officialSource: "channel_not_reported",
				usage: { prompt_tokens: 1000 },
				contextWindow: 128000,
			}),
		).toBe("上下文 1.0K / 128.0K（1%） · 渠道未报官方上限，按系统默认");
		// 缺省窗口 128000（:678）
		expect(ctxMeterText({ usage: { prompt_tokens: 1000 } })).toBe(
			"上下文 1.0K / 128.0K（1%）",
		);
	});

	it("T1-14 matchEnvelope 直接单测：三重命中、used 消费、已消费/不符则跳过（:1542-1556）", () => {
		const args = { chapterId: 3 };
		const hit = {
			msg: {
				id: "m1",
				content: `${ENVELOPE_MARK} 此前你请求执行的写工具 append_chapter ${JSON.stringify(args)}`,
			},
			used: false,
		};
		const miss = { msg: { id: "m2", content: "普通消息" }, used: false };
		expect(matchEnvelope([miss, hit], { name: "append_chapter", args })).toBe(
			hit,
		);
		expect(hit.used).toBe(true);
		expect(miss.used).toBe(false);
		// 工具名不符
		expect(
			matchEnvelope(
				[
					{
						msg: {
							id: "m3",
							content: `${ENVELOPE_MARK} 此前你请求执行的写工具 write_story_state {"chapterId":3}`,
						},
						used: false,
					},
				],
				{ name: "append_chapter", args },
			),
		).toBeNull();
		// args 前缀不符
		expect(
			matchEnvelope(
				[
					{
						msg: {
							id: "m4",
							content: `${ENVELOPE_MARK} 此前你请求执行的写工具 append_chapter {"chapterId":9}`,
						},
						used: false,
					},
				],
				{ name: "append_chapter", args },
			),
		).toBeNull();
		// 已消费（used）不参与
		expect(
			matchEnvelope(
				[
					{
						msg: {
							id: "m5",
							content: `${ENVELOPE_MARK} 此前你请求执行的写工具 append_chapter ${JSON.stringify(args)}`,
						},
						used: true,
					},
				],
				{ name: "append_chapter", args },
			),
		).toBeNull();
		// action.args 空 → 前缀 "{}"，标记与工具名齐备即命中（:1551）
		expect(
			matchEnvelope(
				[
					{
						msg: {
							id: "m6",
							content: `${ENVELOPE_MARK} 此前你请求执行的写工具 write_story_state {}`,
						},
						used: false,
					},
				],
				{ name: "write_story_state", args: {} },
			).msg.id,
		).toBe("m6");
	});

	it("T1-15 matchNearest 直接单测：at 缺失→null、窗口边界命中、坏时间戳跳过（:1558-1574）", () => {
		const base = new Date(2026, 8, 11, 3, 24, 22).getTime();
		const e1 = { msg: { id: "m1", created_at: localTs(base) }, used: false };
		expect(
			matchNearest([e1], { name: "x", settledAt: 0, createdAt: 0 }),
		).toBeNull();
		expect(e1.used).toBe(false);
		// 恰好 30 分钟整仍在窗口内（:1571 的 `>` 判定）
		expect(
			matchNearest([e1], { name: "x", settledAt: base + NEAREST_WINDOW_MS }),
		).toBe(e1);
		expect(e1.used).toBe(true);
		const e2 = { msg: { id: "m2", created_at: "坏时间" }, used: false };
		expect(matchNearest([e2], { name: "x", settledAt: base })).toBeNull();
	});

	it("T1-16 ctxMeterText：usage 真值优先于估算（:685-693）", () => {
		expect(
			ctxMeterText({
				usage: { prompt_tokens: 1000 },
				estimatedPromptTokens: 999999,
				contextWindow: 128000,
				messages: { active: 9 },
			}),
		).toBe("上下文 1.0K / 128.0K（1%）");
		expect(ctxMeterText({ usage: {}, contextWindow: 128000 })).toBe(
			"上下文 0 / 128.0K（0%）",
		);
	});

	it("T1-13 buildConfirmPreviewArgs／confirmNeedsRelock：1500 截断与勾选可见性（:596-602、:528/:616）", () => {
		const long = "x".repeat(1600);
		expect(
			buildConfirmPreviewArgs({ text: long, content: "y", chapterId: 3 }),
		).toEqual({
			text: `${"x".repeat(1500)}…`,
			content: "y",
			chapterId: 3,
		});
		expect(buildConfirmPreviewArgs({ content: "z".repeat(1500) })).toEqual({
			content: "z".repeat(1500),
		});
		expect(buildConfirmPreviewArgs({ text: 123 })).toEqual({ text: 123 });
		expect(
			confirmNeedsRelock({ chapterLocked: true, name: "append_chapter" }),
		).toBe(true);
		expect(
			confirmNeedsRelock({ chapterLocked: true, name: "replace_chapter" }),
		).toBe(true);
		expect(
			confirmNeedsRelock({ chapterLocked: false, name: "append_chapter" }),
		).toBe(false);
		expect(
			confirmNeedsRelock({ chapterLocked: true, name: "write_story_state" }),
		).toBe(false);
		expect(confirmNeedsRelock({ chapterLocked: true })).toBe(false);
	});
});
