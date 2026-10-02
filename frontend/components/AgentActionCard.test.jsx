// @vitest-environment jsdom
// S5-9 红测 T7（Plan §4 T7）：frontend/components/AgentActionCard.jsx —— Agent 台确认卡
// （≙ public/legacy/agent.js :1643-1789 renderConfirmCard／setConfirmCardStatus／failConfirm／
// settleAction，逐例头注 legacy 行号锚点）。harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言
// （CharacterWorkbenchPanel.test.jsx:1-19 同款）；fetch／toast／forgetPending／onResume 全注入；
// 零网络、零全局。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentActionCard from "./AgentActionCard.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONF = {
	id: "a-9",
	summary: "把第三章标题改成「旧信」",
	impact: ["章节标题", "大纲"],
};

const PROPOSAL = {
	kind: "event_proposal",
	proposal_id: 42,
	revision: 5,
	status: "pending",
	title: "主角离开宗门",
	changes: [
		{
			change_kind: "field",
			subject_ref: "主角",
			field_key: "状态",
			old_value: "正常",
			new_value: "受伤",
		},
	],
};

let container;
let root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status: status || 200,
		headers: { "Content-Type": "application/json" },
	});
}

function makeDeps(over) {
	return {
		fetchImpl: vi.fn(async () => jsonResponse({ status: "approved" })),
		toast: vi.fn(),
		forgetPending: vi.fn(),
		onResume: vi.fn(),
		pendingConversationId: () => "c-1",
		sessionId: "agent:x:y",
		...over,
	};
}

// key＝卡身份（同 S5-7 ChatActionCard.test.jsx 口径）：同一 root 内换 fixture 必须换 key，
// 否则 React 复用实例、上一例的结算态残留；同一 key 重渲＝真正的受控重渲（T7-8 后半）。
async function render(props) {
	await act(async () => {
		root.render(
			<AgentActionCard
				key={props.key === undefined ? "k" : props.key}
				conf={props.conf || CONF}
				toolName={props.toolName || "update_chapter"}
				args={props.args || { chapterId: 3, title: "旧信" }}
				status={props.status}
				deps={props.deps || makeDeps()}
			/>,
		);
	});
}

function card() {
	return container.querySelector(".msg-action");
}

function statusText() {
	return container.querySelector(".action-status").textContent;
}

async function clickButton(label) {
	const btn = [...container.querySelectorAll(".action-ops button")].find(
		(b) => b.textContent === label,
	);
	expect(btn, `按钮「${label}」必须存在`).toBeTruthy();
	await act(async () => {
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	return btn;
}

describe("T7 AgentActionCard（确认卡）", () => {
	// :1647-1717 —— pending 卡结构
	it("T7-1 pending 卡结构：类名/data/head/参数 details[open]/按钮/影响面", async () => {
		await render({});
		const c = card();
		expect(c.className).toBe("msg-action status-pending");
		expect(c.getAttribute("data-action-status")).toBe("pending");
		expect(container.querySelector(".action-head").textContent).toBe(
			"AI 请求写操作：把第三章标题改成「旧信」",
		);
		const detail = container.querySelector("details.action-args");
		expect(detail.open).toBe(true);
		expect(detail.querySelector("summary").textContent).toBe("完整变更参数");
		expect(detail.querySelector("pre").textContent).toBe(
			'{\n  "chapterId": 3,\n  "title": "旧信"\n}',
		);
		const buttons = [...container.querySelectorAll(".action-ops button")].map(
			(b) => b.textContent,
		);
		expect(buttons).toEqual(["同意执行", "拒绝"]);
		expect(statusText()).toBe("");
		expect(container.querySelector(".action-impact").textContent).toBe(
			"影响能力：章节标题、大纲",
		);
		// `（无参数）` 分支与无 impact 分支
		await act(async () => {
			root.render(
				<AgentActionCard
					conf={{ id: "a-1" }}
					toolName="read"
					args={{}}
					deps={makeDeps()}
				/>,
			);
		});
		expect(container.querySelector("details.action-args pre").textContent).toBe(
			"（无参数）",
		);
		expect(container.querySelector(".action-impact")).toBeNull();
		expect(container.querySelector(".action-head").textContent).toBe(
			"AI 请求写操作：read",
		);
	});

	// :1663-1665／:1540-1602 —— 提案预览全块
	it("T7-2 提案预览：event_proposal 时 .action-preview 全块（warn/title/meta/changes/quote）", async () => {
		await render({
			conf: {
				...CONF,
				preview: {
					...PROPOSAL,
					version_match: false,
					expected_revision: 3,
					source_quote: "他走了",
				},
			},
		});
		const box = container.querySelector(".action-preview");
		expect(box).not.toBeNull();
		expect(box.querySelector(".preview-warn").textContent).toBe(
			"⚠ 版本不符：你确认的是 revision 3，但提案当前已是 revision 5。执行将被拒绝，请重新读取核对。",
		);
		expect(box.querySelector(".preview-title").textContent).toBe(
			"提案 #42：主角离开宗门",
		);
		expect(box.querySelector(".preview-meta").textContent).toBe(
			"revision 5 · 状态 pending · 来源 author",
		);
		expect(box.querySelector(".preview-change-item").textContent).toBe(
			"状态（主角）：正常 → 受伤",
		);
		expect(box.querySelector(".preview-quote").textContent).toBe(
			"原文依据：「他走了」",
		);
		// 非 event_proposal 预览不渲染
		await act(async () => {
			root.render(
				<AgentActionCard
					conf={{ ...CONF, preview: { kind: "other" } }}
					toolName="t"
					args={{}}
					deps={makeDeps()}
				/>,
			);
		});
		expect(container.querySelector(".action-preview")).toBeNull();
	});

	// :1647-1655／:1693-1700 —— 只读历史卡：零按钮、状态行文案
	it("T7-3 只读卡：msg-action-readonly＋零按钮＋九态状态行逐条", async () => {
		// [status, 类名/data 用的状态键, 状态行文案]——表外非空值经 :1622-1625 normalizeActionStatus
		// 归一到 'unknown'（类名与 data-action-status 都用归一值），文案取 fallback
		const cases = [
			["executing", "executing", "执行中…"],
			["approved", "approved", "已执行 ✓"],
			["rejected", "rejected", "已拒绝，未做任何改动"],
			["expired", "expired", "已过期未执行（等待确认超时）"],
			["superseded", "superseded", "已被更新的同类请求取代（未执行）"],
			["failed", "failed", "执行失败"],
			[
				"interrupted",
				"interrupted",
				"执行中断，可能已部分生效——请核对目标内容后重新发起",
			],
			["wat", "unknown", "已结算（状态未知）"],
		];
		for (const [key, classKey, text] of cases) {
			await render({ status: key, key });
			const c = card();
			expect(c.className, key).toBe(
				`msg-action status-${classKey} msg-action-readonly`,
			);
			expect(c.getAttribute("data-action-status"), key).toBe(classKey);
			expect(container.querySelectorAll(".action-ops button").length, key).toBe(
				0,
			);
			expect(statusText(), key).toBe(text);
		}
	});

	// :1729-1789 —— 同意 → approved → resume
	it("T7-4 同意：按钮禁用＋执行中… → 200 approved → 只读 approved＋已执行 ✓；onResume 恰 1 次", async () => {
		const deps = makeDeps();
		await render({ deps });
		const okBtn = await clickButton("同意执行");
		// 请求体：approve:true + conversation_id（pendingConversationId 有值）
		expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = deps.fetchImpl.mock.calls[0];
		expect(url).toBe("/api/agent/actions/a-9/confirm");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({
			approve: true,
			conversation_id: "c-1",
		});
		// 结算后
		expect(card().className).toBe(
			"msg-action status-approved msg-action-readonly",
		);
		expect(statusText()).toBe("已执行 ✓");
		expect(deps.forgetPending).toHaveBeenCalledWith("a-9");
		expect(deps.onResume).toHaveBeenCalledTimes(1);
		expect(deps.onResume).toHaveBeenCalledWith("a-9");
		expect(okBtn.disabled).toBe(true);
		expect(deps.toast).not.toHaveBeenCalled();
	});

	// :1778-1779
	it("T7-5 拒绝：approve:false → status-rejected＋「已拒绝，未做任何改动」", async () => {
		const deps = makeDeps({
			fetchImpl: vi.fn(async () => jsonResponse({ status: "rejected" })),
		});
		await render({ deps });
		await clickButton("拒绝");
		expect(JSON.parse(deps.fetchImpl.mock.calls[0][1].body)).toEqual({
			approve: false,
			conversation_id: "c-1",
		});
		expect(card().className).toBe(
			"msg-action status-rejected msg-action-readonly",
		);
		expect(statusText()).toBe("已拒绝，未做任何改动");
		expect(deps.onResume).toHaveBeenCalledTimes(1);
	});

	// :1750-1770 —— 三错误码分支
	it("T7-6 409 SUPERSEDED／404 与 NOT_FOUND／409 ACTION_REQUIRES_REVIEW 三分支", async () => {
		const sup = makeDeps({
			fetchImpl: vi.fn(async () =>
				jsonResponse({ error: { code: "CONFIRMATION_SUPERSEDED" } }, 409),
			),
		});
		await render({ deps: sup, key: "sup" });
		await clickButton("同意执行");
		expect(card().className).toBe(
			"msg-action status-superseded msg-action-readonly",
		);
		expect(sup.toast).not.toHaveBeenCalled();
		expect(sup.onResume).not.toHaveBeenCalled();
		expect(sup.forgetPending).toHaveBeenCalledWith("a-9");

		const gone = makeDeps({
			fetchImpl: vi.fn(async () =>
				jsonResponse({ error: { code: "CONFIRMATION_NOT_FOUND" } }, 404),
			),
		});
		await render({ deps: gone, key: "gone" });
		await clickButton("同意执行");
		expect(card().className).toBe(
			"msg-action status-expired msg-action-readonly",
		);
		expect(statusText()).toBe("已过期未执行（等待确认超时）");
		expect(gone.onResume).not.toHaveBeenCalled();

		const interrupted = makeDeps({
			fetchImpl: vi.fn(async () =>
				jsonResponse(
					{
						error: {
							code: "ACTION_REQUIRES_REVIEW",
							message: "服务重启打断了这次执行",
						},
					},
					409,
				),
			),
		});
		await render({ deps: interrupted, key: "interrupted" });
		await clickButton("同意执行");
		expect(card().className).toBe(
			"msg-action status-interrupted msg-action-readonly",
		);
		expect(interrupted.toast).toHaveBeenCalledWith("服务重启打断了这次执行");
		expect(interrupted.onResume).not.toHaveBeenCalled();
	});

	// :1719-1726 —— failConfirm 复位
	it("T7-7 其余错误／网络抛错：确认失败＋按钮复位可点＋toast；卡不置只读", async () => {
		const fail = makeDeps({
			fetchImpl: vi.fn(async () =>
				jsonResponse({ error: { message: "服务器炸了" } }, 500),
			),
		});
		await render({ deps: fail });
		const okBtn = await clickButton("同意执行");
		expect(statusText()).toBe("确认失败");
		expect(okBtn.disabled).toBe(false);
		expect(
			[...container.querySelectorAll(".action-ops button")].every(
				(b) => !b.disabled,
			),
		).toBe(true);
		expect(card().className).toBe("msg-action status-pending");
		expect(fail.toast).toHaveBeenCalledWith("服务器炸了");
		expect(fail.forgetPending).not.toHaveBeenCalled();
		expect(fail.onResume).not.toHaveBeenCalled();

		const net = makeDeps({
			fetchImpl: vi.fn(async () => {
				throw new Error("Failed to fetch");
			}),
		});
		await render({ deps: net });
		await clickButton("拒绝");
		expect(statusText()).toBe("确认失败");
		expect(net.toast).toHaveBeenCalledWith("Failed to fetch");
	});

	// :1740-1743／:1290-1296 —— 无会话回落 session_id；结算后卡仍恰一张
	it("T7-8 无会话 → session_id 体；结算后受控重渲染仍恰 1 张卡（forgetPending 计数）", async () => {
		const deps = makeDeps({ pendingConversationId: () => null });
		await render({ deps });
		await clickButton("同意执行");
		expect(JSON.parse(deps.fetchImpl.mock.calls[0][1].body)).toEqual({
			approve: true,
			session_id: "agent:x:y",
		});
		expect(deps.forgetPending).toHaveBeenCalledTimes(1);
		// 受控重渲染（父层新 props）不得复制卡，也不得回退已结算态
		await act(async () => {
			root.render(
				// 同 key＝同卡（受控重渲，不重挂）：父层新 props 不得回退已结算态
				<AgentActionCard
					key="k"
					conf={CONF}
					toolName="update_chapter"
					args={{ chapterId: 3, title: "旧信" }}
					deps={deps}
				/>,
			);
		});
		expect(container.querySelectorAll(".msg-action").length).toBe(1);
		expect(card().className).toBe(
			"msg-action status-approved msg-action-readonly",
		);
		expect(deps.forgetPending).toHaveBeenCalledTimes(1);
	});
});
