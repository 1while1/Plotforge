// @vitest-environment jsdom
// S5-8 红测 T5（Plan §4 T5）：frontend/components/AgentSpace.jsx —— 页壳静态装配（props 驱动）。
// DOM 契约唯一事实源＝frontend/index.html:584-673（P6-3 源迁入，行号未变；本文件真实读取该区间做 id/文案/属性断言，
// 不复制粘贴）；legacy 语义锚点＝public/legacy/agent.js（逐例头注行号）。
// harness＝jsdom＋React 19 act＋createRoot＋裸 DOM 断言（CharacterWorkbenchPanel.test.jsx:1-19 同款）。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSpace from "./AgentSpace.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 静态壳单一事实源：按 cwd（仓根）与 vitest root（frontend/）两候选定位，找不到即抛
const INDEX_PATH = [
	resolve(process.cwd(), "frontend/index.html"),
	resolve(process.cwd(), "../frontend/index.html"),
].find((f) => existsSync(f));
if (!INDEX_PATH)
	throw new Error("找不到 frontend/index.html（静态壳事实源缺失）");
const INDEX_HTML = readFileSync(INDEX_PATH, "utf8");
const SHELL = INDEX_HTML.slice(
	INDEX_HTML.indexOf("<!-- ============ AI 助手页 ============ -->"),
	INDEX_HTML.indexOf("<!-- ============ 阅读 / 精修工作台 ============ -->"),
);
const IDS = [...SHELL.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

function textOf(id) {
	const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(SHELL);
	return m ? m[1] : null;
}
function attrOf(id, attr) {
	const m = new RegExp(`id="${id}"[^>]*\\s${attr}="([^"]*)"`).exec(SHELL);
	return m ? m[1] : null;
}

// :212 空态逐字（AgentSidePanel 经 props.emptyHint 注入；lib 常量由 T1-13 对同字面量锚定）
const CONV_EMPTY_HINT =
	"该范围还没有会话：发送一条消息或点「新会话」即会按当前范围新建（不会借用别的书或全局历史）。";
// :371 资源空态逐字（组件内取自 lib/agent-resources.js 的 RES_EMPTY_HINT）
const RES_EMPTY_HINT = "该类型在当前范围内没有资源（空态，不是错误）。";

function makeProps(over = {}) {
	const base = {
		topbar: {
			returnHref: "#/book/7",
			returnHidden: true,
			modelText: "step-3.7-flash",
			onCompress: vi.fn(),
			onRestore: vi.fn(),
			restoreHidden: true,
			onNewConversation: vi.fn(),
		},
		scopeBar: {
			scopeOptions: [
				{ value: "global", label: "全局资源（跨书检索 · 只读讨论）" },
				{ value: "book:7", label: "《雾港编年史》" },
			],
			scopeValue: "book:7",
			onScopeChange: vi.fn(),
			conversationOptions: [
				{ value: "", label: "" },
				{ value: "c1", label: "讨论甲" },
			],
			conversationValue: "c1",
			onConversationChange: vi.fn(),
			boundaryOptions: [
				{ value: "", label: "全书（无时序边界）" },
				{ value: "12", label: "第2章 · 石碑" },
			],
			boundaryValue: "12",
			boundaryDisabled: false,
			onBoundaryChange: vi.fn(),
			mode: {
				label: "执行操作",
				disabled: false,
				title: "执行操作：可发起写操作（每一步仍需作者确认）；点此切回只读讨论",
				execute: true,
			},
			onToggleMode: vi.fn(),
			statusText:
				"范围：《雾港编年史》 · 会话：讨论甲 · 边界：截至《石碑》 · 模式：执行操作（每步需确认）",
		},
		sidePanel: {
			tab: "conversations",
			onTabChange: vi.fn(),
			conversations: [
				// scope＝.agent-conv-meta「书籍 / 全局」的取值来源（≙ legacy :226）
				{
					id: "c1",
					title: "讨论甲",
					scope: "book",
					archived: false,
					active: true,
				},
				{
					id: "c2",
					title: "旧会话",
					scope: "book",
					archived: true,
					active: false,
				},
			],
			onSelectConversation: vi.fn(),
			emptyHint: CONV_EMPTY_HINT,
			tools: [{ name: "list_resources", description: "列出受控资源" }],
			resources: {
				typeOptions: [
					{ value: "chapter", label: "章节" },
					{ value: "world", label: "世界观" },
				],
				typeValue: "chapter",
				onTypeChange: vi.fn(),
				onRefresh: vi.fn(),
				hint: "范围：《雾港编年史》 · 类型：章节 · 已列出 1 项。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。",
				items: [
					{
						type: "chapter",
						id: 12,
						title: "石碑 · 已定稿",
						statusLabel: "已定稿",
						metaText: "第2章",
					},
				],
				onOpen: vi.fn(),
				hasMore: true,
				onMore: vi.fn(),
			},
		},
		preview: {
			open: false,
			onClose: vi.fn(),
			loading: false,
			error: null,
			model: null,
			onSwitchScope: vi.fn(),
		},
		pickBar: {
			visible: true,
			countText: "已选 2 条讨论结论",
			disabled: false,
			onSaveNote: vi.fn(),
			onCreateHandoff: vi.fn(),
			onClear: vi.fn(),
		},
		messages: {
			items: [],
			picks: [],
			onTogglePick: vi.fn(),
			pendingSlot: null,
			liveSlot: null,
		},
		composer: {
			value: "",
			onChange: vi.fn(),
			onSubmit: vi.fn(),
			sending: false,
			stopVisible: false,
			onStop: vi.fn(),
		},
	};
	return { ...base, ...over };
}

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
});

async function render(over) {
	const props = makeProps(over);
	await act(async () => {
		root.render(<AgentSpace {...props} />);
	});
	return props;
}

describe("T5 AgentSpace（页壳静态装配）", () => {
	// S5-9 机械转写（Plan §4 T5-1／台账 §S5-9）：AgentSpace 自本片起**只渲染内层壳**（fragment），
	// #page-agent 归静态壳自身（AppRouter 的 hideAllPages/showPage 管类名，React 只填内层，
	// ReadPage.jsx:1267-1285 同配方）——故「41 个 id 各恰一份」改为「静态壳 41 个 id 中，
	// 内层壳渲染 40 个（除 #page-agent）；#page-agent 由静态壳提供、组件内不得再出现」。
	// pageClassName prop 随之退役（T5-9 挂载件的容器类名权威由 AgentWorkspace 承接）。
	it("T5-1 DOM 契约全集（index.html:584-673 真实读取）：内层壳 40 个 id 各恰一份、关键类与文案/属性逐字", async () => {
		await render();
		expect(IDS.length).toBe(41);
		// 内层壳不含 #page-agent（容器由静态壳供给，重复渲染即双份 id）
		expect(container.querySelectorAll("#page-agent").length).toBe(0);
		const INNER_IDS = IDS.filter((id) => id !== "page-agent");
		expect(INNER_IDS.length).toBe(40);
		for (const id of INNER_IDS) {
			expect(container.querySelectorAll(`#${id}`).length, id).toBe(1);
		}
		// 无多渲染的 id（双份 id 反例的直接防线）
		const rendered = [...container.querySelectorAll("[id]")]
			.map((el) => el.id)
			.sort();
		expect(rendered).toEqual([...INNER_IDS].sort());

		expect(container.querySelector(".agent-scope-bar")).not.toBeNull();
		expect(
			container.querySelector("main#agent-main.agent-main"),
		).not.toBeNull();
		expect(container.querySelector("aside.agent-tools-panel")).not.toBeNull();
		expect(
			container.querySelector("section.panel.agent-chat-panel"),
		).not.toBeNull();
		expect(
			container.querySelector("#agent-conversation-list.item-list"),
		).not.toBeNull();
		expect(
			container.querySelector("#btn-agent-tab-conversations.tab.active"),
		).not.toBeNull();
		expect(
			container.querySelector("#agent-pane-resources.tab-pane.hidden"),
		).not.toBeNull();
		expect(container.querySelector("#agent-res-list.item-list")).not.toBeNull();

		expect(container.querySelector("#btn-agent-compress").textContent).toBe(
			textOf("btn-agent-compress"),
		);
		expect(container.querySelector("#btn-agent-restore").textContent).toBe(
			textOf("btn-agent-restore"),
		);
		expect(container.querySelector("#btn-agent-clear").textContent).toBe(
			textOf("btn-agent-clear"),
		);
		expect(container.querySelector("#agent-return-writing").textContent).toBe(
			textOf("agent-return-writing"),
		);
		expect(container.querySelector("#btn-agent-send").textContent).toBe(
			textOf("btn-agent-send"),
		);
		expect(
			container.querySelector("#btn-agent-send").getAttribute("type"),
		).toBe("submit");
		expect(
			container.querySelector("#agent-text").getAttribute("placeholder"),
		).toBe(attrOf("agent-text", "placeholder"));
		expect(
			container.querySelector("#agent-scope-select").getAttribute("title"),
		).toBe(attrOf("agent-scope-select", "title"));
		expect(
			container.querySelector("#agent-res-type").getAttribute("title"),
		).toBe(attrOf("agent-res-type", "title"));

		// 静态骨架（块二填充行为；本片只渲染结构）
		expect(
			container
				.querySelector("#agent-legacy-import")
				.classList.contains("hidden"),
		).toBe(true);
		expect(container.querySelector("#btn-agent-import").textContent).toBe(
			textOf("btn-agent-import"),
		);
		expect(
			container
				.querySelector("#btn-agent-clean-local")
				.classList.contains("hidden"),
		).toBe(true);
		const card = container.querySelector("#agent-run-card");
		expect(card.className).toBe("run-card hidden");
		expect(card.getAttribute("role")).toBe("status");
		expect(card.children.length).toBe(0);
		expect(container.querySelector("ul#agent-tool-list")).not.toBeNull();
	});

	it("T5-2 范围条：可选会话/边界下拉渲染（含选中标记）、boundaryDisabled、状态行、模式按钮透传", async () => {
		const props = await render();
		const scopeSel = container.querySelector("#agent-scope-select");
		expect([...scopeSel.options].map((o) => o.value)).toEqual([
			"global",
			"book:7",
		]);
		expect([...scopeSel.options].map((o) => o.textContent)).toEqual([
			"全局资源（跨书检索 · 只读讨论）",
			"《雾港编年史》",
		]);
		expect(scopeSel.value).toBe("book:7");
		expect(scopeSel.selectedOptions[0].value).toBe("book:7");

		const convSel = container.querySelector("#agent-conversation-select");
		expect([...convSel.options].map((o) => o.value)).toEqual(["", "c1"]);
		expect(convSel.value).toBe("c1");

		const bSel = container.querySelector("#agent-boundary-select");
		expect([...bSel.options].map((o) => o.value)).toEqual(["", "12"]);
		expect(bSel.disabled).toBe(false);
		expect(bSel.value).toBe("12");
		expect(container.querySelector("#agent-scope-status").textContent).toBe(
			props.scopeBar.statusText,
		);
		const mode = container.querySelector("#btn-agent-mode");
		expect(mode.textContent).toBe("执行操作");
		expect(mode.disabled).toBe(false);
		expect(mode.getAttribute("title")).toBe(props.scopeBar.mode.title);
		expect(mode.className).toBe("btn");

		scopeSel.value = "global";
		await act(async () => {
			scopeSel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(props.scopeBar.onScopeChange).toHaveBeenCalledWith("global");
		bSel.value = "";
		await act(async () => {
			bSel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(props.scopeBar.onBoundaryChange).toHaveBeenCalledWith("");
		convSel.value = "";
		await act(async () => {
			convSel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(props.scopeBar.onConversationChange).toHaveBeenCalledWith("");
		await act(async () => mode.click());
		expect(props.scopeBar.onToggleMode).toHaveBeenCalledTimes(1);

		// global 禁用边界 + 只读讨论态（:176-177／:542-545）
		const props2 = await render({
			scopeBar: {
				...props.scopeBar,
				boundaryDisabled: true,
				mode: {
					label: "只读讨论",
					disabled: true,
					title: "全局范围只读（找书与检索）；执行操作请把「范围」切到某一本书",
					execute: false,
				},
			},
		});
		expect(container.querySelector("#agent-boundary-select").disabled).toBe(
			true,
		);
		expect(container.querySelector("#btn-agent-mode").className).toBe(
			"btn btn-ghost",
		);
		expect(container.querySelector("#btn-agent-mode").disabled).toBe(true);
		expect(props2.scopeBar.mode.label).toBe(textOf("btn-agent-mode"));
	});

	it("T5-3 侧栏（:203-233／:283-395）：tab 切换/会话行/空态/工具清单", async () => {
		const props = await render();
		const tabConv = container.querySelector("#btn-agent-tab-conversations");
		const tabRes = container.querySelector("#btn-agent-tab-resources");
		expect(tabConv.className).toBe("tab active");
		expect(tabRes.className).toBe("tab");
		expect(tabConv.dataset.agentTab).toBe("conversations");
		expect(
			container
				.querySelector("#agent-pane-conversations")
				.classList.contains("hidden"),
		).toBe(false);
		await act(async () => tabRes.click());
		expect(props.sidePanel.onTabChange).toHaveBeenCalledWith("resources");

		const rows = container.querySelectorAll(
			"#agent-conversation-list .agent-conversation-item",
		);
		expect(rows.length).toBe(2);
		expect(rows[0].className).toBe("item-row agent-conversation-item active");
		expect(rows[0].dataset.conversationId).toBe("c1");
		expect(rows[0].querySelector(".agent-conv-title").textContent).toBe(
			"讨论甲",
		);
		expect(rows[0].querySelector(".agent-conv-meta").textContent).toBe("书籍");
		expect(rows[1].className).toBe("item-row agent-conversation-item");
		expect(rows[1].querySelector(".agent-conv-title").textContent).toBe(
			"旧会话（已归档）",
		);
		await act(async () =>
			rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		expect(props.sidePanel.onSelectConversation).toHaveBeenCalledWith("c2");

		const tools = container.querySelectorAll(
			"#agent-tool-list .agent-tool-item",
		);
		expect(tools.length).toBe(1);
		// 阶段 4c：助手能力清单对用户显示中文标签而非内部工具名
		expect(tools[0].querySelector(".agent-tool-name").textContent).toBe(
			"列出受控资源",
		);
		expect(tools[0].querySelector(".agent-tool-desc").textContent).toBe(
			"列出受控资源",
		);

		// 空列表 → li.agent-tools-hint 空态逐字（:212）
		await render({
			sidePanel: { ...props.sidePanel, conversations: [] },
		});
		const empty = container.querySelector("#agent-conversation-list");
		expect(empty.children.length).toBe(1);
		expect(empty.firstElementChild.className).toBe("agent-tools-hint");
		expect(empty.firstElementChild.textContent).toBe(CONV_EMPTY_HINT);
	});

	it("T5-4 资源面板（:283-395）：类型下拉/提示行/行模型/空态/加载更多 hidden", async () => {
		const props = await render();
		const sel = container.querySelector("#agent-res-type");
		expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
			["chapter", "章节"],
			["world", "世界观"],
		]);
		expect(sel.value).toBe("chapter");
		expect(container.querySelector("#agent-res-hint").textContent).toBe(
			props.sidePanel.resources.hint,
		);
		const rows = container.querySelectorAll("#agent-res-list .agent-res-item");
		expect(rows.length).toBe(1);
		expect(rows[0].className).toBe("item-row agent-res-item");
		expect(rows[0].dataset.resourceType).toBe("chapter");
		expect(rows[0].dataset.resourceId).toBe("12");
		expect(rows[0].querySelector(".agent-res-title").textContent).toBe(
			"石碑 · 已定稿",
		);
		expect(rows[0].querySelector(".agent-res-meta").textContent).toBe("第2章");
		await act(async () =>
			rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		expect(props.sidePanel.resources.onOpen).toHaveBeenCalledWith(
			props.sidePanel.resources.items[0],
		);

		expect(
			container
				.querySelector("#btn-agent-res-more")
				.classList.contains("hidden"),
		).toBe(false);
		await act(async () =>
			container.querySelector("#btn-agent-res-more").click(),
		);
		expect(props.sidePanel.resources.onMore).toHaveBeenCalledTimes(1);
		await act(async () =>
			container.querySelector("#btn-agent-res-refresh").click(),
		);
		expect(props.sidePanel.resources.onRefresh).toHaveBeenCalledTimes(1);

		sel.value = "world";
		await act(async () => {
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(props.sidePanel.resources.onTypeChange).toHaveBeenCalledWith(
			"world",
		);

		await render({
			sidePanel: {
				...props.sidePanel,
				resources: { ...props.sidePanel.resources, items: [], hasMore: false },
			},
		});
		const list = container.querySelector("#agent-res-list");
		expect(list.children.length).toBe(1);
		expect(list.firstElementChild.className).toBe("agent-tools-hint");
		expect(list.firstElementChild.textContent).toBe(RES_EMPTY_HINT);
		expect(
			container
				.querySelector("#btn-agent-res-more")
				.classList.contains("hidden"),
		).toBe(true);
	});

	it("T5-5 预览面板（:424-510）：hidden 与 with-preview 联动、model 渲染、route/无 route、book 型切范围回调", async () => {
		const model = {
			title: "章节 · 石碑",
			rows: [
				{ key: "状态", value: "已定稿" },
				{ key: "序号", value: "2" },
			],
			link: {
				href: "#/book/7/chapters/12",
				text: "打开工作台 →",
				title: "站内跳转：#/book/7/chapters/12",
			},
			noPageHint: null,
			isBook: false,
			switchScopeValue: null,
		};
		const props = await render({
			preview: {
				open: true,
				onClose: vi.fn(),
				loading: false,
				error: null,
				model,
				onSwitchScope: vi.fn(),
			},
		});
		const panel = container.querySelector("#agent-preview-panel");
		expect(panel.classList.contains("hidden")).toBe(false);
		expect(
			container.querySelector("#agent-main").classList.contains("with-preview"),
		).toBe(true);
		expect(panel.querySelector(".agent-preview-title").textContent).toBe(
			"章节 · 石碑",
		);
		const rows = panel.querySelectorAll(".agent-preview-row");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".agent-preview-key").textContent).toBe(
			"状态",
		);
		expect(rows[0].querySelector(".agent-preview-value").textContent).toBe(
			"已定稿",
		);
		const link = panel.querySelector("a.agent-preview-link");
		expect(link.getAttribute("href")).toBe("#/book/7/chapters/12");
		expect(link.textContent).toBe("打开工作台 →");
		expect(link.getAttribute("title")).toBe("站内跳转：#/book/7/chapters/12");
		await act(async () =>
			panel.querySelector("#btn-agent-preview-close").click(),
		);
		expect(props.preview.onClose).toHaveBeenCalledTimes(1);

		// 关闭态：hidden + 无 with-preview（:505-510）
		await render({ preview: { ...props.preview, open: false, model: null } });
		expect(
			container
				.querySelector("#agent-preview-panel")
				.classList.contains("hidden"),
		).toBe(true);
		expect(
			container.querySelector("#agent-main").classList.contains("with-preview"),
		).toBe(false);
		// 无 model 且有 route 缺省 → 空态文案
		expect(
			container.querySelector("#agent-preview-body .agent-tools-hint")
				.textContent,
		).toBe("没有可展示的摘要。");

		// 无 route → 固定提示；loading/error 分支
		const noRoute = {
			...model,
			link: null,
			noPageHint:
				"该类资源没有站内页面，这里只展示元数据与摘要（不提供文件浏览）。",
		};
		await render({
			preview: {
				...props.preview,
				open: true,
				model: noRoute,
				onSwitchScope: vi.fn(),
			},
		});
		expect(
			container.querySelector("#agent-preview-body .agent-tools-hint")
				.textContent,
		).toBe(noRoute.noPageHint);
		await render({
			preview: { ...props.preview, open: true, loading: true, model: null },
		});
		expect(
			container.querySelector("#agent-preview-body .agent-tools-hint")
				.textContent,
		).toBe("正在读取摘要…");
		await render({
			preview: {
				...props.preview,
				open: true,
				error: "摘要读取失败：boom",
				model: null,
			},
		});
		expect(
			container.querySelector("#agent-preview-body .agent-tools-hint")
				.textContent,
		).toBe("摘要读取失败：boom");

		// book 型 → 切范围按钮回调（:495-502）
		const onSwitchScope = vi.fn();
		await render({
			preview: {
				open: true,
				onClose: vi.fn(),
				loading: false,
				error: null,
				model: { ...model, isBook: true, switchScopeValue: "book:7" },
				onSwitchScope,
			},
		});
		const useBtn = container.querySelector(
			"#agent-preview-body .btn.btn-small.btn-ghost",
		);
		expect(useBtn.textContent).toBe("把交流范围切到这本书");
		expect(useBtn.getAttribute("type")).toBe("button");
		await act(async () => useBtn.click());
		expect(onSwitchScope).toHaveBeenCalledWith("book:7");
	});

	it("T5-6 勾选条（:704-716）：visible 与 countText、归档禁用、三回调", async () => {
		const props = await render();
		const bar = container.querySelector("#agent-pick-bar");
		expect(bar.classList.contains("hidden")).toBe(false);
		expect(container.querySelector("#agent-pick-count").textContent).toBe(
			"已选 2 条讨论结论",
		);
		expect(container.querySelector("#btn-agent-save-note").disabled).toBe(
			false,
		);
		expect(container.querySelector("#btn-agent-create-handoff").disabled).toBe(
			false,
		);
		await act(async () =>
			container.querySelector("#btn-agent-save-note").click(),
		);
		await act(async () =>
			container.querySelector("#btn-agent-create-handoff").click(),
		);
		await act(async () =>
			container.querySelector("#btn-agent-pick-clear").click(),
		);
		expect(props.pickBar.onSaveNote).toHaveBeenCalledTimes(1);
		expect(props.pickBar.onCreateHandoff).toHaveBeenCalledTimes(1);
		expect(props.pickBar.onClear).toHaveBeenCalledTimes(1);

		await render({
			pickBar: {
				...props.pickBar,
				visible: false,
				countText: "",
				disabled: true,
			},
		});
		expect(
			container.querySelector("#agent-pick-bar").classList.contains("hidden"),
		).toBe(true);
		expect(container.querySelector("#btn-agent-save-note").disabled).toBe(true);
		expect(container.querySelector("#btn-agent-create-handoff").disabled).toBe(
			true,
		);
	});

	it("T5-7 槽位与叶容器：messages → pendingSlot → liveSlot 顺序；#agent-run-card 空叶容器", async () => {
		const pendingSlot = <div id="pending-slot-probe" />;
		const liveSlot = <div id="live-slot-probe" />;
		await render({
			messages: {
				items: [
					{ id: 1, role: "user", content: "问", tools: [] },
					{ id: 2, role: "assistant", content: "答", tools: [] },
				],
				picks: [],
				onTogglePick: vi.fn(),
				pendingSlot,
				liveSlot,
			},
		});
		const messages = container.querySelector("#agent-messages");
		expect(messages.className).toBe("chat-messages");
		const order = [...messages.children].map((el) => el.id || el.className);
		expect(order).toEqual([
			"msg user",
			"msg assistant",
			"pending-slot-probe",
			"live-slot-probe",
		]);
	});

	it("T5-8 零副作用：渲染不 fetch／不写读 localStorage／不注册 window 监听／不写全局", async () => {
		const fetchSpy = vi.fn(() =>
			Promise.reject(new Error("no network in this test")),
		);
		const origFetch = globalThis.fetch;
		globalThis.fetch = fetchSpy;
		const getSpy = vi.spyOn(Storage.prototype, "getItem");
		const setSpy = vi.spyOn(Storage.prototype, "setItem");
		const winAdd = vi.spyOn(window, "addEventListener");
		const before = new Set(Object.keys(window));
		try {
			await render();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(getSpy).not.toHaveBeenCalled();
			expect(setSpy).not.toHaveBeenCalled();
			expect(winAdd).not.toHaveBeenCalled();
			const added = Object.keys(window).filter((k) => !before.has(k));
			expect(added).toEqual([]);
			expect(typeof window.AgentPage).toBe("undefined");
		} finally {
			globalThis.fetch = origFetch;
			getSpy.mockRestore();
			setSpy.mockRestore();
			winAdd.mockRestore();
		}
	});

	it("T5-9 #agent-return-writing：a 元素在位、href/显隐透传（BookShell.updateAgentReturnLink 的读写面）", async () => {
		await render({ topbar: { ...makeProps().topbar, returnHidden: true } });
		const link = container.querySelector("a#agent-return-writing");
		expect(link).not.toBeNull();
		expect(link.getAttribute("href")).toBe("#/book/7");
		expect(link.classList.contains("hidden")).toBe(true);
		await render({
			topbar: {
				...makeProps().topbar,
				returnHidden: false,
				returnHref: "#/book/9",
			},
		});
		const shown = container.querySelector("a#agent-return-writing");
		expect(shown.classList.contains("hidden")).toBe(false);
		expect(shown.getAttribute("href")).toBe("#/book/9");
		expect(shown.textContent).toBe("← 返回写作页");
	});
});
