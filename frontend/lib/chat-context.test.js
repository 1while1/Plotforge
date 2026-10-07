// S5-7 红测 T3（Plan §4 T3）：frontend/lib/chat-context.js —— 上下文仪表/明细/压缩/还原纯逻辑。
// 语义唯一事实源＝public/legacy/book-chat.js :665-827（逐例头注行号锚点；该文件本片 git rm）。
// harness＝vitest node 环境；零新增依赖；全部入参注入（无 DOM/网络）。
import { describe, expect, it } from "vitest";
import {
	breakdownHTML,
	COMPRESSING_TOAST,
	clampSuffix,
	compressBodyHTML,
	compressRequest,
	compressTitle,
	compressToast,
	meterOf,
	restoreRequest,
	restoreToast,
} from "./chat-context.js";

function breakdown(over) {
	return {
		window: 1000,
		system: {
			total: 100,
			budget: 500,
			parts: [
				{ name: "基础规则", tokens: 60 },
				{ name: "前情", tokens: 40, truncated: true },
			],
		},
		history: { chatTokens: 200, toolTokens: 50 },
		schema: 30,
		outputReserve: 100,
		estimatedPrompt: 380,
		officialSource: "channel_reported",
		windowOfficial: 1000,
		officialFetchedAt: "2026-09-28T01:02:03.000Z",
		lastBreakdown: null,
		calibration: null,
		recentCalls: [],
		...(over || {}),
	};
}

describe("T3 chat-context（legacy :665-827）", () => {
	it("T3-1 clampSuffix 四分支逐字（:680-684）", () => {
		expect(
			clampSuffix({ clamped: true, windowManual: 2000, contextWindow: 1000 }),
		).toBe(" · 设 2.0K 被钳制为 1.0K");
		expect(
			clampSuffix({
				officialSource: "channel_not_reported",
				windowManual: 64000,
			}),
		).toBe(" · 渠道未报官方上限，按你设置生效");
		expect(clampSuffix({ officialSource: "channel_not_reported" })).toBe(
			" · 渠道未报官方上限，按系统默认",
		);
		expect(clampSuffix({ officialSource: "not_fetched" })).toBe(
			" · 官方源尚未拉取",
		);
		expect(
			clampSuffix({
				officialSource: "channel_reported",
				windowOfficial: 128000,
			}),
		).toBe(" · 官方 128.0K");
		expect(clampSuffix({})).toBe("");
		expect(clampSuffix(null)).toBe("");
	});

	it("T3-2 meterOf：usage 优先 → 状态 lastUsage → null；字段透传给仪表（:676-699）", () => {
		const st = { contextWindow: 128000, lastUsage: { prompt_tokens: 1 } };
		expect(meterOf(st, { prompt_tokens: 2 }).usage).toEqual({
			prompt_tokens: 2,
		});
		expect(meterOf(st, null).usage).toEqual({ prompt_tokens: 1 });
		expect(meterOf({ contextWindow: 1 }, null).usage).toBe(null);
		expect(meterOf(null, null).usage).toBe(null);
	});

	it("T3-3 明细 bar/rows 片段逐字（含 width:max(0.5,pct)% 与 title 文案）（:732-754）", () => {
		const { bodyHTML, win } = breakdownHTML(breakdown());
		expect(win).toBe(1000);
		expect(bodyHTML).toContain('<div class="ctx-bd-bar">');
		expect(bodyHTML).toContain(
			'<div class="ctx-bd-seg" style="width:10%;background:#5b8dd9" title="系统提示词 ≈100（10%）"></div>',
		);
		expect(bodyHTML).toContain(
			'<div class="ctx-bd-seg" style="width:52%;background:var(--border-strong)" title="剩余自由 ≈520（52%）"></div>',
		);
		expect(bodyHTML).toContain(
			'<div class="ctx-bd-row"><span class="ctx-bd-dot" style="background:#5b8dd9"></span><span class="ctx-bd-name">系统提示词</span><span class="ctx-bd-val">≈100 · 10%</span></div>',
		);
		expect(bodyHTML).toContain(
			'<div class="ctx-bd-subtitle">系统提示逐层明细（当前组装估算，合计 ≈100 / 预算 500）</div>',
		);
		expect(bodyHTML).toContain(
			'<div class="ctx-bd-row ctx-bd-sub"><span class="ctx-bd-name">前情（被预算截断）</span><span class="ctx-bd-val">≈40 · 4%</span></div>',
		);
		expect(bodyHTML).toContain(
			"数据来源：当前估算（本书暂无调用台账记录） · 官方源：渠道 /models 报告 1.0K（拉取于 2026-09-28 01:02:03） · 窗口 1.0K（自动跟随模型）",
		);
		// 无 parts → 「（暂无内容）」；>0 的段才落 bar（:746）
		const none = breakdownHTML(
			breakdown({ system: { total: 0, budget: 500, parts: [] } }),
		);
		expect(none.bodyHTML).toContain("（暂无内容）");
		expect(none.bodyHTML).not.toContain(
			'<div class="ctx-bd-seg" style="width:0%',
		);
	});

	it("T3-4 校准 factor 只作用于四桶、out/free 用原值、free=max(0,win-usedPrompt-out)（:720-731）", () => {
		const { bodyHTML } = breakdownHTML(
			breakdown({
				calibration: { promptTokens: 500, localTotal: 400, factor: 1.25 },
				officialSource: "not_fetched",
			}),
		);
		// 四桶 ×1.25（→ 125 / 250 / 62.5→63? 逐字：Math.round）
		expect(bodyHTML).toContain(
			'<span class="ctx-bd-name">系统提示词</span><span class="ctx-bd-val">≈125（校准） · 12.5%</span>',
		);
		expect(bodyHTML).toContain(
			'<span class="ctx-bd-name">工具调用结果</span><span class="ctx-bd-val">≈63（校准） · 6.3%</span>',
		);
		// raw 段不带校准标记、用原值
		expect(bodyHTML).toContain(
			'<span class="ctx-bd-name">输出预留（max_tokens）</span><span class="ctx-bd-val">≈100 · 10%</span>',
		);
		expect(bodyHTML).toContain(
			'<span class="ctx-bd-name">剩余自由</span><span class="ctx-bd-val">≈520 · 52%</span>',
		);
		expect(bodyHTML).toContain("校准 = 官方 usage 500 ÷ 本地估算 400 = ×1.250");
		// usedPrompt 超过窗口：free 钳到 0
		const full = breakdownHTML(
			breakdown({ estimatedPrompt: 1200, outputReserve: 300 }),
		);
		expect(full.bodyHTML).toContain(
			'<span class="ctx-bd-name">剩余自由</span><span class="ctx-bd-val">≈0 · 0%</span>',
		);
	});

	it("系统提示分项显示额外注入并与总数相加", () => {
		const { bodyHTML } = breakdownHTML(
			breakdown({
				system: {
					total: 150,
					budget: 500,
					parts: [{ name: "基础规则", tokens: 100 }],
					additionalTokens: 50,
				},
			}),
		);
		expect(bodyHTML).toContain("系统提示逐层明细（当前组装估算，合计 ≈150");
		expect(bodyHTML).toContain(
			'工具历史、指南等额外注入</span><span class="ctx-bd-val">≈50',
		);
		const recorded = breakdownHTML(
			breakdown({
				lastBreakdown: {
					system: 150,
					history: 0,
					tool: 0,
					schema: 0,
					outputReserve: 100,
					parts: [{ name: "基础规则", tokens: 100 }],
				},
			}),
		);
		expect(recorded.bodyHTML).toContain(
			'工具历史、指南等额外注入</span><span class="ctx-bd-val">≈50',
		);
	});

	it("T3-5 lastBreakdown 优先 + 调用台账表七列与状态列（:715-721、:763-781）", () => {
		const { bodyHTML } = breakdownHTML(
			breakdown({
				lastBreakdown: {
					system: 111,
					history: 222,
					tool: 33,
					schema: 44,
					outputReserve: 55,
					promptTokens: 400,
					parts: [{ name: "本次层", tokens: 111 }],
					scope: "chat",
					at: "2026-09-28T02:03:04.000Z",
				},
				recentCalls: [
					{
						at: "2026-09-28T02:03:04.000Z",
						scope: "chat",
						prompt_tokens: 500,
						completion_tokens: 120,
						cache_hit_tokens: 0,
						duration_ms: 1500,
						status: "ok",
						finish_reason: "stop",
					},
					{ at: "2026-09-28T02:04:04.000Z", status: "error" },
				],
			}),
		);
		expect(bodyHTML).toContain(
			'<span class="ctx-bd-name">系统提示词</span><span class="ctx-bd-val">≈111 · 11.1%</span>',
		);
		expect(bodyHTML).toContain(
			"系统提示逐层明细（本次请求逐层组装台账，随调用落库，合计 ≈111 / 预算 500）",
		);
		expect(bodyHTML).toContain("本次层");
		expect(bodyHTML).toContain("最近调用台账（llm_calls 落库，重启不丢）");
		expect(bodyHTML).toContain(
			"<tr><td>09-28 02:03</td><td>chat</td><td>500</td><td>120</td><td>—</td><td>1.5s</td><td>stop</td></tr>",
		);
		expect(bodyHTML).toContain(
			"<tr><td>09-28 02:04</td><td></td><td>—</td><td>—</td><td>—</td><td>0.0s</td><td>✗ error</td></tr>",
		);
		expect(bodyHTML).toContain(
			"数据来源：调用台账 llm_calls 最近一次真实请求（chat · 2026-09-28 02:03:04，上游 usage 400 tokens）",
		);
	});

	it("T3-6 窗口来源三态与钳制注（:766-788）", () => {
		const clamped = breakdownHTML(
			breakdown({
				clamped: true,
				note: "你设置的上限超过模型能力",
				windowManual: 200000,
				officialSource: "channel_not_reported",
			}),
		);
		expect(clamped.bodyHTML).toContain(
			'<div class="ctx-bd-note">⚠ 你设置的上限超过模型能力</div>',
		);
		expect(clamped.bodyHTML).toContain("· 窗口 1.0K（你设置 200.0K）");
		expect(clamped.bodyHTML).toContain(
			"官方源：渠道 /models 未报告上下文上限（官方缺失，不猜测）",
		);
		const notFetched = breakdownHTML(
			breakdown({ officialSource: "not_fetched" }),
		);
		expect(notFetched.bodyHTML).toContain("官方源：尚未拉取（后台自动拉取中）");
	});

	it("T3-7 压缩弹窗四节逐字与请求体/toast（:796-827）", () => {
		const html = compressBodyHTML();
		expect(html).toContain("将把较早的对话（保留最近 8 条）压缩成一份存档摘要");
		for (const section of [
			"【已确认的资料与设定】",
			"【已执行的动作与结果】",
			"【未决问题】",
			"【作者尚未采纳的设想】",
		]) {
			expect(html).toContain(section);
		}
		expect(html).toContain("最后一节里的想法仍不是事实，不会被写成既定剧情。");
		expect(compressTitle()).toBe("压缩上下文");
		expect(COMPRESSING_TOAST).toBe("正在压缩…");
		expect(compressRequest("conv-1", 42)).toEqual({
			method: "POST",
			path: "/chat/compress",
			body: { conversationId: "conv-1", expectedLastMessageId: 42 },
		});
		expect(restoreRequest("conv-1")).toEqual({
			method: "POST",
			path: "/chat/compress/restore",
			body: { conversationId: "conv-1" },
		});
		expect(compressToast(3)).toBe("已压缩 3 条早期对话");
		expect(restoreToast(2)).toBe("已还原 2 条归档对话");
	});
});
