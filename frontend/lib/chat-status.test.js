// S5-7 红测 T4（Plan §4 T4）：frontend/lib/chat-status.js —— 写后刷新/上下文仪表对接状态编排纯逻辑。
// 语义唯一事实源＝public/legacy/book-chat.js :648-663 ＋ :1948-2122（逐例头注行号锚点；文件本片 git rm）。
// harness＝vitest node 环境；window.RunStatus 桩（记录调用序与参数）＋注入的 api/toast/pageVisible。
import { describe, expect, it } from "vitest";
import {
	CHAPTER_WRITE_TOOLS,
	createRunStatusController,
	isActiveRun,
	refreshAfterWrite,
	resourceKey,
	resourceNoticeFor,
} from "./chat-status.js";

function makeRS() {
	const order = [];
	const rs = {
		order,
		RESOURCE_BADGE: "资料更新",
		cardModel(input) {
			order.push(["cardModel", input]);
			return { badge: "已暂停", input };
		},
		mountTaskCard(host, model, opts) {
			order.push(["mountTaskCard", model, !!opts]);
			if (host) host.textContent = model ? model.badge || "" : "";
			return host;
		},
		async loadPersistence() {
			order.push(["loadPersistence"]);
		},
		runFromMessages(messages) {
			order.push(["runFromMessages", messages]);
			return messages.length
				? { status: "paused", reason: "output_truncated" }
				: null;
		},
		applyResourceRefresh(opts) {
			order.push(["applyResourceRefresh", opts]);
			// 等值 run-status.js:232-244：干净时才走 reload（脏稿只回 hint）
			if (!opts.dirty && typeof opts.reload === "function") opts.reload();
			return {
				applied: !opts.dirty,
				hint: opts.dirty ? "未保存的修改..." : "",
			};
		},
		observeResource(key, res) {
			order.push(["observeResource", key, res]);
			return rs.__obs;
		},
		watchers: [],
		createWatcher(cfg) {
			const w = {
				cfg,
				intervalMs: Math.max(cfg.intervalMs, 2000),
				started: false,
				stopped: false,
				start() {
					this.started = true;
				},
				stop() {
					this.stopped = true;
				},
				stopped_() {
					return this.stopped;
				},
			};
			order.push(["createWatcher", cfg]);
			rs.watchers.push(w);
			return w;
		},
		onVisibilityChange(fn) {
			order.push(["onVisibilityChange", fn]);
		},
		renderWritingSaveBadge() {},
		__obs: { changed: false, first: false, previous: null, current: null },
	};
	return rs;
}

function harness(over) {
	const o = over || {};
	const calls = [];
	const toasts = [];
	const state = { bookId: 7, chapterId: 41, conversationId: "w-7-a" };
	const rs = o.rs || makeRS();
	const host = {
		id: "writing-run-card",
		textContent: "",
		classList: { add() {}, remove() {} },
	};
	const controller = createRunStatusController({
		RS: () => (o.noRS ? null : rs),
		host: () => (o.noHost ? null : host),
		api: async (method, path, body) => {
			calls.push({ method, path, body });
			return o.api ? o.api(method, path, body) : {};
		},
		toast: (m) => toasts.push(m),
		getBookId: () => state.bookId,
		getChapterId: () => state.chapterId,
		getConversationId: () => state.conversationId,
		pageVisible: () => (o.visible === undefined ? true : o.visible),
		hasUnsavedChanges: () => !!o.dirty,
		selectChapter: (cid) => {
			calls.push({ method: "SELECT_CHAPTER", cid });
			return Promise.resolve(true);
		},
	});
	return { controller, rs, calls, toasts, host, state };
}

describe("T4 chat-status（legacy :648-663 ＋ :1948-2122）", () => {
	it("T4-1 refreshAfterWrite：四类章节工具→loadChapters+当前章 selectChapter；人物/世界观→各自加载；其余零动作（:648-663）", () => {
		expect(CHAPTER_WRITE_TOOLS).toEqual([
			"create_chapter",
			"append_chapter",
			"replace_chapter",
			"set_chapter_meta",
		]);
		const hit = [];
		const hooks = {
			hasBook: () => true,
			getChapterId: () => 41,
			loadChapters: () => hit.push("loadChapters"),
			selectChapter: (cid) => hit.push(`selectChapter:${cid}`),
			loadCharacters: () => hit.push("loadCharacters"),
			loadWorld: () => hit.push("loadWorld"),
		};
		refreshAfterWrite("create_chapter", { chapterId: 41 }, hooks);
		expect(hit).toEqual(["loadChapters", "selectChapter:41"]);
		hit.length = 0;
		// args.chapter.id 兜底；非当前章不 selectChapter
		refreshAfterWrite("append_chapter", { chapter: { id: 42 } }, hooks);
		expect(hit).toEqual(["loadChapters"]);
		hit.length = 0;
		refreshAfterWrite("add_character", {}, hooks);
		refreshAfterWrite("update_character", {}, hooks);
		expect(hit).toEqual(["loadCharacters", "loadCharacters"]);
		hit.length = 0;
		refreshAfterWrite("add_worldview", {}, hooks);
		expect(hit).toEqual(["loadWorld"]);
		hit.length = 0;
		refreshAfterWrite("list_chapters", {}, hooks);
		expect(hit).toEqual([]);
		// 无书早退
		refreshAfterWrite("add_worldview", {}, { ...hooks, hasBook: () => false });
		expect(hit).toEqual([]);
	});

	it("T4-2 isActiveRun / resourceKey：两态真值、键逐字（:1964-1970）", () => {
		expect(isActiveRun({ status: "running" })).toBe(true);
		expect(isActiveRun({ status: "awaiting_confirmation" })).toBe(true);
		expect(isActiveRun({ status: "finished" })).toBe(false);
		expect(isActiveRun(null)).toBe(false);
		expect(resourceKey(7, 41)).toBe("writing_resource:7:41");
		expect(resourceKey(null, 41)).toBe("writing_resource:?:41");
	});

	it("T4-3 resourceNoticeFor：changed&&!first ⇒ 逐字 detail/actions；!changed ⇒ null（:2027-2040）", () => {
		const rs = makeRS();
		const res = { id: 41, title: "第 41 章", route: "#/book/7/read/41" };
		rs.__obs = {
			changed: true,
			first: false,
			previous: { revision: 3 },
			current: { revision: 4 },
		};
		const changedObs = {
			changed: true,
			first: false,
			previous: { revision: 3 },
			current: { revision: 4 },
		};
		const notice = resourceNoticeFor(rs, res, 41, 7, changedObs);
		expect(notice.badge).toBe("资料更新");
		expect(notice.detail).toBe(
			"《第 41 章》已被另一处更新（版本 3 → 4）：你的编辑器内容没有被覆盖。",
		);
		expect(notice.actions).toEqual([
			{ key: "diff", label: "查看差异", href: "#/book/7/read/41" },
			{ key: "refresh", label: "刷新" },
		]);
		// 缺 route/标题 → 兜底逐字；版本缺值「未记录」
		const bare = resourceNoticeFor(rs, { id: 41 }, 41, 7, {
			changed: true,
			first: false,
			previous: null,
			current: null,
		});
		expect(bare.detail).toBe(
			"《章节 #41》已被另一处更新（版本 未记录 → 未记录）：你的编辑器内容没有被覆盖。",
		);
		expect(bare.actions[0].href).toBe("#/book/7");
		rs.__obs = { changed: false, first: false };
		expect(resourceNoticeFor(rs, res, 41, 7)).toBe(null);
		rs.__obs = { changed: true, first: true };
		expect(resourceNoticeFor(rs, res, 41, 7)).toBe(null);
	});

	it("T4-4 refreshRunStatus 参数合并：messages→runFromMessages 命中才覆盖、各键分别覆盖、loadPersistence 先于 checkResource、末尾 renderRunCard（:2044-2061）", async () => {
		const h = harness({
			api: async () => ({
				resource: { id: 41, title: "第 41 章", meta: { revision: 4 } },
			}),
		});
		const snap = await h.controller.refreshRunStatus({
			messages: [{ id: 1 }, { id: 2 }],
			tools: [{ name: "read_chapter" }],
			toolErrors: [{ code: "X" }],
		});
		expect(snap).toEqual({ status: "paused", reason: "output_truncated" });
		const names = h.rs.order.map((x) => x[0]);
		expect(names).toEqual([
			"runFromMessages",
			"loadPersistence",
			"observeResource",
			"cardModel",
			"mountTaskCard",
		]);
		// resourceNotice!==undefined 覆盖；checkResource:false 跳过资源查询
		h.rs.order.length = 0;
		h.calls.length = 0;
		await h.controller.refreshRunStatus({
			resourceNotice: null,
			checkResource: false,
		});
		expect(h.calls.length).toBe(0);
		expect(h.rs.order.map((x) => x[0])).toEqual([
			"loadPersistence",
			"cardModel",
			"mountTaskCard",
		]);
		// messages 空数组 → runFromMessages 返回 null → 不覆盖快照
		h.rs.order.length = 0;
		await h.controller.refreshRunStatus({ messages: [] });
		expect(h.rs.order.map((x) => x[0])).toEqual([
			"runFromMessages",
			"loadPersistence",
			"observeResource",
			"cardModel",
			"mountTaskCard",
		]);
		expect(await h.controller.refreshRunStatus({ messages: [] })).toEqual({
			status: "paused",
			reason: "output_truncated",
		});
		// RS 缺失 → 全静默 null（:2046-2047）
		const h2 = harness({ noRS: true });
		expect(
			await h2.controller.refreshRunStatus({ messages: [{ id: 1 }] }),
		).toBe(null);
		expect(h2.calls.length).toBe(0);
	});

	it("T4-5 watcher 策略：非活跃不建且停旧、活跃建 5000＋isVisible＋terminal=!isActiveRun；资料 watcher 8000 常驻（:2064-2105）", async () => {
		const h = harness();
		// 无快照 → 不建
		expect(h.controller.syncRunWatcher()).toBe(null);
		expect(h.rs.order.filter((x) => x[0] === "createWatcher").length).toBe(0);
		// 活跃运行 → 建 5000
		await h.controller.refreshRunStatus({ run: { status: "running" } });
		const w = h.controller.syncRunWatcher();
		expect(w.cfg.intervalMs).toBe(5000);
		expect(w.cfg.isVisible()).toBe(true);
		expect(w.started).toBe(true);
		expect(await w.cfg.load()).toEqual({ terminal: false });
		// 同一 watcher 复用（再次 syncRunWatcher 不重复建）
		expect(h.controller.syncRunWatcher()).toBe(w);
		// 完成即停
		await h.controller.refreshRunStatus({ run: { status: "finished" } });
		expect(h.controller.syncRunWatcher()).toBe(null);
		expect(w.stopped).toBe(true);
		// 资料 watcher：8000＋terminal:false 常驻
		const rw = h.controller.startStatusWatchers();
		expect(rw.cfg.intervalMs).toBe(8000);
		expect(await rw.cfg.load()).toEqual({ terminal: false });
		expect(h.controller.startStatusWatchers()).toBe(rw);
	});

	it("T4-6 setStatusPollingVisible：可见建两 watcher、不可见双停并置 null、无 RS 静默 null（:2108-2116）", async () => {
		const h = harness();
		expect(h.controller.setStatusPollingVisible(true)).toBe(true);
		const names = h.rs.order.filter((x) => x[0] === "createWatcher").length;
		expect(names).toBe(1); // 无活跃运行 ⇒ 只建资料 watcher（等值 :2092 syncRunWatcher 早退）
		await h.controller.refreshRunStatus({ run: { status: "running" } });
		expect(h.controller.setStatusPollingVisible(true)).toBe(true);
		// 资料 watcher 已在（:2093 守卫），本条只补建运行 watcher
		expect(h.rs.order.filter((x) => x[0] === "createWatcher").length).toBe(2);
		expect(h.controller.setStatusPollingVisible(false)).toBe(false);
		// 双停：运行与资料 watcher 都被 stop（置 null 后下次可见再新建）
		expect(h.rs.watchers.length).toBeGreaterThanOrEqual(2);
		expect(h.rs.watchers.every((w) => w.stopped)).toBe(true);
		expect(h.controller.startStatusWatchers()).not.toBe(null); // 双停后仍可重启
		// 页面不可见时永远返回 false（:2109）
		const h2 = harness({ visible: false });
		expect(h2.controller.setStatusPollingVisible(true)).toBe(false);
		expect(h2.rs.order.filter((x) => x[0] === "createWatcher").length).toBe(0);
		const h3 = harness({ noRS: true });
		expect(h3.controller.setStatusPollingVisible(true)).toBe(null);
	});

	it("T4-7 onResourceRefresh：脏稿不覆盖只提示、干净重载＋观察＋重渲染（:1987-2011）", async () => {
		const h = harness({ dirty: true });
		const out = await h.controller.onResourceRefresh();
		expect(out.applied).toBe(false);
		expect(h.toasts).toEqual(["未保存的修改..."]);
		expect(h.calls.filter((c) => c.method === "SELECT_CHAPTER").length).toBe(0);
		const h2 = harness({
			api: async () => ({
				resource: { id: 41, title: "第 41 章", meta: { revision: 5 } },
			}),
		});
		const ok = await h2.controller.onResourceRefresh();
		expect(ok.applied).toBe(true);
		expect(h2.toasts).toEqual(["已按服务端版本重新加载本章"]);
		expect(
			h2.calls.filter((c) => c.method === "SELECT_CHAPTER").map((c) => c.cid),
		).toEqual([41]);
		expect(
			h2.calls.some(
				(c) => c.path === "/api/resources?type=chapter&bookId=7&id=41",
			),
		).toBe(true);
		expect(h2.rs.order.map((x) => x[0])).toContain("observeResource");
		expect(h2.rs.order.map((x) => x[0])).toContain("mountTaskCard");
		// 资源元数据读取失败：保持现状、不臆造（:2007）
		const h3 = harness({
			api: async () => {
				throw new Error("boom");
			},
		});
		const still = await h3.controller.onResourceRefresh();
		expect(still.applied).toBe(true);
		expect(h3.rs.order.filter((x) => x[0] === "observeResource").length).toBe(
			0,
		);
	});
});
