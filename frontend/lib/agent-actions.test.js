// S5-9 红测 T2（Plan §4 T2）：frontend/lib/agent-actions.js —— 确认卡纯逻辑（提取信封 / 值展示 /
// 状态表 / 提案预览模型 / 卡模型 / 结算分派 / 请求体）。语义唯一事实源＝public/legacy/agent.js
// :1520-1791（逐例头注 legacy 行号锚点）；零 DOM、零 fetch；harness＝vitest node 环境。
import { describe, expect, it } from "vitest";
import {
	ACTION_STATUS_FALLBACK,
	ACTION_STATUS_META,
	actionStatusMeta,
	buildConfirmBody,
	cardClassName,
	confirmArgsText,
	confirmCardModel,
	extractConfirmation,
	fmtVal,
	normalizeActionStatus,
	proposalPreviewModel,
	settleOutcome,
	settleStartText,
} from "./agent-actions.js";

describe("T2 agent-actions（确认卡纯逻辑）", () => {
	// :1522-1527 —— 兼容 {ok,data:{status}} 包裹与裸信封两形态
	it("T2-1 extractConfirmation：裸信封/包裹两形态命中；非对象或 data 无 confirmation → null", () => {
		const conf = { id: "a-1", summary: "改标题" };
		expect(
			extractConfirmation({
				status: "confirmation_required",
				confirmation: conf,
			}),
		).toBe(conf);
		expect(
			extractConfirmation({
				ok: true,
				data: { status: "confirmation_required", confirmation: conf },
			}),
		).toBe(conf);
		expect(extractConfirmation(null)).toBe(null);
		expect(extractConfirmation("文本")).toBe(null);
		expect(
			extractConfirmation({ data: { status: "confirmation_required" } }),
		).toBe(null);
		expect(extractConfirmation({ status: "confirmation_required" })).toBe(null);
		expect(extractConfirmation({ ok: true })).toBe(null);
	});

	// :1530-1537 —— null/undefined→（空）；数组→[a、b]（嵌套递归）；对象→紧凑 JSON；其余→String
	it("T2-2 fmtVal：空值/数组（含嵌套）/对象/原始值四态", () => {
		expect(fmtVal(null)).toBe("（空）");
		expect(fmtVal(undefined)).toBe("（空）");
		expect(fmtVal(["甲", "乙"])).toBe("[甲、乙]");
		expect(fmtVal([1, ["x", null]])).toBe("[1、[x、（空）]]");
		expect(fmtVal({ a: 1 })).toBe('{"a":1}');
		expect(fmtVal(12)).toBe("12");
		expect(fmtVal(false)).toBe("false");
		const cyc = {};
		cyc.self = cyc;
		expect(fmtVal(cyc)).toBe("[object Object]");
	});

	// :1608-1620 —— 八键文案逐字＋readonly 布尔全表＋fallback
	// （Plan §4 T2-3 写「九键」＝Plan 勘误：legacy 表实测 8 键，按源码全量断言；留案 selfcheck）
	it("T2-3 ACTION_STATUS_META 八键文案逐字（含 interrupted）＋readonly 全表＋FALLBACK", () => {
		expect(Object.keys(ACTION_STATUS_META).sort()).toEqual([
			"approved",
			"executing",
			"expired",
			"failed",
			"interrupted",
			"pending",
			"rejected",
			"superseded",
		]);
		expect(ACTION_STATUS_META.pending).toEqual({ text: "", readonly: false });
		expect(ACTION_STATUS_META.executing).toEqual({
			text: "执行中…",
			readonly: true,
		});
		expect(ACTION_STATUS_META.approved).toEqual({
			text: "已执行 ✓",
			readonly: true,
		});
		expect(ACTION_STATUS_META.rejected).toEqual({
			text: "已拒绝，未做任何改动",
			readonly: true,
		});
		expect(ACTION_STATUS_META.expired).toEqual({
			text: "已过期未执行（等待确认超时）",
			readonly: true,
		});
		expect(ACTION_STATUS_META.superseded).toEqual({
			text: "已被更新的同类请求取代（未执行）",
			readonly: true,
		});
		expect(ACTION_STATUS_META.failed).toEqual({
			text: "执行失败",
			readonly: true,
		});
		expect(ACTION_STATUS_META.interrupted).toEqual({
			text: "执行中断，可能已部分生效——请核对目标内容后重新发起",
			readonly: true,
		});
		for (const key of Object.keys(ACTION_STATUS_META)) {
			if (key !== "pending")
				expect(ACTION_STATUS_META[key].readonly, key).toBe(true);
		}
		expect(ACTION_STATUS_FALLBACK).toEqual({
			text: "已结算（状态未知）",
			readonly: true,
		});
	});

	// :1622-1629
	it("T2-4 normalizeActionStatus：''/非字符串→pending；表内→原名；表外非空→unknown；meta 回落", () => {
		expect(normalizeActionStatus(undefined)).toBe("pending");
		expect(normalizeActionStatus("")).toBe("pending");
		expect(normalizeActionStatus("   ")).toBe("pending");
		expect(normalizeActionStatus(12)).toBe("pending");
		expect(normalizeActionStatus("approved")).toBe("approved");
		expect(normalizeActionStatus(" approved ")).toBe("approved");
		expect(normalizeActionStatus("wat")).toBe("unknown");
		expect(actionStatusMeta("unknown")).toBe(ACTION_STATUS_FALLBACK);
		expect(actionStatusMeta("approved").text).toBe("已执行 ✓");
	});

	// :1540-1603 —— 提案预览模型
	it("T2-5 proposalPreviewModel：warn 逐字、title/meta 位序、changes 空态、relation 分支、原文依据", () => {
		const m = proposalPreviewModel({
			kind: "event_proposal",
			version_match: false,
			expected_revision: 3,
			revision: 5,
			proposal_id: 42,
			title: "主角离开宗门",
			status: "pending",
			created_by: "model",
			chapter_title: "第三章",
			importance: "high",
			supersedes_event_id: 7,
			summary: "推开剧情",
			source_quote: "他走了",
			changes: [
				{
					change_kind: "relation",
					subject_ref: "主角",
					field_key: "师门",
					old_value: "同门",
					new_value: ["叛徒", null],
				},
				{
					change_kind: "field",
					subject_ref: "主角",
					field_key: "状态",
					old_value: null,
					new_value: "受伤",
				},
			],
		});
		expect(m.warn).toBe(
			"⚠ 版本不符：你确认的是 revision 3，但提案当前已是 revision 5。执行将被拒绝，请重新读取核对。",
		);
		expect(m.title).toBe("提案 #42：主角离开宗门");
		expect(m.meta).toBe(
			"revision 5 · 状态 pending · 来源 model · 章节 第三章 · 重要性 high · 替代事件 #7",
		);
		expect(m.summary).toBe("推开剧情");
		expect(m.changes.map((c) => c.text)).toEqual([
			"关系 主角：同门 → [叛徒、（空）]",
			"状态（主角）：（空） → 受伤",
		]);
		expect(m.quote).toBe("原文依据：「他走了」");
		// 空 changes／缺省 created_by／chapter_id 分支
		const empty = proposalPreviewModel({
			proposal_id: 1,
			revision: 2,
			status: "",
			chapter_id: 12,
			changes: [],
		});
		expect(empty.title).toBe("提案 #1：（无标题）");
		expect(empty.meta).toBe("revision 2 · 状态  · 来源 author · 章节 #12");
		expect(empty.changes.map((c) => c.text)).toEqual(["（无变化项）"]);
		expect(empty.quote).toBe(null);
		expect(empty.warn).toBe(null);
	});

	// :1659／:1674-1675 —— head 与 args pre 文本
	it("T2-6 卡模型 head 与 args：summary||toolName||conf.tool；'{}'→（无参数）；循环引用→String(args)", () => {
		const base = confirmCardModel({
			conf: { id: "a" },
			toolName: "update_chapter",
			args: {},
		});
		expect(base.head).toBe("AI 请求写操作：update_chapter");
		expect(base.argsText).toBe("（无参数）");
		expect(
			confirmCardModel({
				conf: { summary: "改标题", tool: "x" },
				args: { a: 1 },
			}).head,
		).toBe("AI 请求写操作：改标题");
		expect(
			confirmCardModel({ conf: { tool: "delete_event" }, args: { a: 1 } }).head,
		).toBe("AI 请求写操作：delete_event");
		expect(
			confirmCardModel({ conf: {}, toolName: "t", args: { a: 1 } }).head,
		).toBe("AI 请求写操作：t");
		expect(
			confirmCardModel({ conf: {}, toolName: "t", args: { a: 1 } }).argsText,
		).toBe('{\n  "a": 1\n}');
		expect(confirmArgsText(null)).toBe("（无参数）");
		const cyc = {};
		cyc.self = cyc;
		expect(() => confirmArgsText(cyc)).not.toThrow();
	});

	// :1680-1685
	it("T2-7 影响面：conf.impact 非空才产「影响能力：<join('、')>」", () => {
		expect(
			confirmCardModel({ conf: { impact: ["事件账本", "人物卡"] } }).impactText,
		).toBe("影响能力：事件账本、人物卡");
		expect(confirmCardModel({ conf: { impact: [] } }).impactText).toBe(null);
		expect(confirmCardModel({ conf: {} }).impactText).toBe(null);
	});

	// :1647-1655／:1695-1700 —— 只读判定与类名
	it("T2-8 只读判定：缺省 pending 可操作；八种非 pending 状态只读；类名逐字", () => {
		expect(confirmCardModel({ conf: {} }).key).toBe("pending");
		expect(confirmCardModel({ conf: {} }).readonly).toBe(false);
		expect(cardClassName("pending", false)).toBe("msg-action status-pending");
		for (const key of [
			"expired",
			"approved",
			"rejected",
			"superseded",
			"failed",
			"interrupted",
			"executing",
			"unknown",
		]) {
			const m = confirmCardModel({ conf: {}, status: key });
			expect(m.readonly, key).toBe(true);
			expect(m.key, key).toBe(key);
			expect(cardClassName(m.key, m.readonly)).toBe(
				`msg-action status-${key} msg-action-readonly`,
			);
		}
		expect(confirmCardModel({ conf: {}, status: "" }).key).toBe("pending");
		expect(confirmCardModel({ conf: {} }).statusText).toBe("");
		expect(confirmCardModel({ conf: {}, status: "expired" }).statusText).toBe(
			"已过期未执行（等待确认超时）",
		);
		expect(settleStartText(true)).toBe("执行中…");
		expect(settleStartText(false)).toBe("已拒绝");
	});

	// :1777-1786 —— 成功族三态都续跑
	it("T2-9 settleOutcome 成功族：rejected/failed(+错误码)/approved 三态均 forget＋shouldResume", () => {
		expect(
			settleOutcome({ ok: true, status: 200, data: { status: "rejected" } }),
		).toEqual({
			key: "rejected",
			statusText: null,
			toast: null,
			shouldResume: true,
			forget: true,
			resetButtons: false,
		});
		expect(
			settleOutcome({
				ok: true,
				status: 200,
				errCode: "E_BAD",
				data: { status: "failed" },
			}),
		).toMatchObject({
			key: "failed",
			statusText: "执行失败：E_BAD",
			shouldResume: true,
			forget: true,
		});
		expect(
			settleOutcome({ ok: true, status: 200, data: { status: "failed" } })
				.statusText,
		).toBe("执行失败");
		expect(
			settleOutcome({ ok: true, status: 200, data: { status: "approved" } }),
		).toMatchObject({ key: "approved", shouldResume: true, forget: true });
		expect(settleOutcome({ ok: true, status: 200, data: null }).key).toBe(
			"approved",
		);
	});

	// :1749-1773 —— 错误族四分支
	it("T2-10 settleOutcome 错误族：superseded/expired/interrupted（含 toast）/fail（含 reset＋toast）", () => {
		expect(
			settleOutcome({
				ok: false,
				status: 409,
				errCode: "CONFIRMATION_SUPERSEDED",
				data: null,
			}),
		).toEqual({
			key: "superseded",
			statusText: null,
			toast: null,
			shouldResume: false,
			forget: true,
			resetButtons: false,
		});
		expect(
			settleOutcome({ ok: false, status: 404, errCode: "", data: null }),
		).toMatchObject({ key: "expired", forget: true, shouldResume: false });
		expect(
			settleOutcome({
				ok: false,
				status: 400,
				errCode: "CONFIRMATION_NOT_FOUND",
				data: null,
			}),
		).toMatchObject({ key: "expired", forget: true });
		expect(
			settleOutcome({
				ok: false,
				status: 409,
				errCode: "ACTION_REQUIRES_REVIEW",
				data: { error: { message: "服务重启打断了这次执行" } },
			}),
		).toMatchObject({
			key: "interrupted",
			toast: "服务重启打断了这次执行",
			forget: true,
			shouldResume: false,
		});
		expect(
			settleOutcome({
				ok: false,
				status: 409,
				errCode: "ACTION_REQUIRES_REVIEW",
				data: null,
			}).toast,
		).toBe("执行中断，不能重放");
		const fail = settleOutcome({
			ok: false,
			status: 500,
			errCode: "BOOM",
			data: { error: { message: "服务器炸了" } },
		});
		expect(fail).toEqual({
			key: "fail",
			statusText: "确认失败",
			toast: "服务器炸了",
			shouldResume: false,
			forget: false,
			resetButtons: true,
		});
		expect(
			settleOutcome({ ok: false, status: 503, errCode: "", data: null }).toast,
		).toBe("请求失败 503");
		expect(
			settleOutcome({
				ok: false,
				status: 500,
				errCode: "BOOM",
				data: { error: { code: "BOOM" } },
			}).toast,
		).toBe("BOOM");
	});

	// 网络异常（:1745-1748）→ fail（e.message）
	it("T2-11 网络异常 → fail（resetButtons＋e.message），无 status 时兜底文案不炸", () => {
		expect(settleOutcome({ error: new Error("Failed to fetch") })).toEqual({
			key: "fail",
			statusText: "确认失败",
			toast: "Failed to fetch",
			shouldResume: false,
			forget: false,
			resetButtons: true,
		});
		expect(settleOutcome({ error: "字符串错误" }).key).toBe("fail");
		expect(settleOutcome({}).key).toBe("fail");
	});

	// :1736-1743 —— 请求体组装
	it("T2-12 buildConfirmBody：有会话→conversation_id；无→session_id（approve 原样）", () => {
		expect(buildConfirmBody(true, "c-1", "agent:1:2")).toEqual({
			approve: true,
			conversation_id: "c-1",
		});
		expect(buildConfirmBody(false, null, "agent:1:2")).toEqual({
			approve: false,
			session_id: "agent:1:2",
		});
	});
});
