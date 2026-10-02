// S5-7（Plan §1.1 G4）：public/legacy/book-chat.js :648-663 写后刷新 + :1948-2122 统一可见状态
// （任务卡/保存三态/资料更新/轮询）的纯逻辑移植。
// 语义逐字对应 legacy 行号：:648-663 refreshAfterWrite、:1962-1970 cardHost/isActiveRun/resourceKey、
// :1972-1985 renderRunCard、:1987-2011 onResourceRefresh、:2013-2042 checkCurrentResource、
// :2044-2061 refreshRunStatus（参数合并＋loadPersistence→checkResource→renderRunCard 次序）、
// :2064-2105 syncRunWatcher/startStatusWatchers（5000/8000＋isVisible＋terminal）、
// :2108-2116 setStatusPollingVisible 展示态开关。
// 纪律：零 fetch、零全局赋写；window.RunStatus／DOM 宿主／api／toast／页面可见性全部注入。
export const CHAPTER_WRITE_TOOLS = [
	"create_chapter",
	"append_chapter",
	"replace_chapter",
	"set_chapter_meta",
];
export const CHARACTER_WRITE_TOOLS = ["add_character", "update_character"];
export const RUN_WATCH_INTERVAL_MS = 5000; // :2073
export const RESOURCE_WATCH_INTERVAL_MS = 8000; // :2095

// :648-663 写操作落地后刷新相关面板
export function refreshAfterWrite(name, args, hooks) {
	const h = hooks || {};
	if (typeof h.hasBook !== "function" || !h.hasBook()) return;
	const a = args || {};
	if (CHAPTER_WRITE_TOOLS.includes(name)) {
		h.loadChapters?.();
		// 改动的是当前打开的章节 → 编辑器同步最新内容（:654-657）
		const cid = a.chapterId || a.chapter?.id;
		if (cid && cid === h.getChapterId?.() && h.selectChapter)
			h.selectChapter(cid);
	} else if (CHARACTER_WRITE_TOOLS.includes(name)) {
		h.loadCharacters?.();
	} else if (name === "add_worldview") {
		h.loadWorld?.();
	}
}

// :1964-1966
export function isActiveRun(run) {
	return !!(
		run &&
		(run.status === "running" || run.status === "awaiting_confirmation")
	);
}

// :1968-1970
export function resourceKey(bookId, chapterId) {
	return `writing_resource:${bookId || "?"}:${chapterId}`;
}

// :2027-2040「资料更新」提示模型（只在 changed 且非首次观察时成立；!changed 的清零由调用方处置）
export function resourceNoticeFor(RS, res, cid, bookId, obs) {
	if (!obs?.changed || obs.first) return null;
	const from =
		obs.previous?.revision != null ? obs.previous.revision : "未记录";
	const to =
		obs.current && obs.current.revision != null
			? obs.current.revision
			: "未记录";
	return {
		badge: RS.RESOURCE_BADGE,
		detail: `《${res.title || `章节 #${cid}`}》已被另一处更新（版本 ${from} → ${to}）：你的编辑器内容没有被覆盖。`,
		actions: [
			{ key: "diff", label: "查看差异", href: res.route || `#/book/${bookId}` },
			{ key: "refresh", label: "刷新" },
		],
	};
}

export function createRunStatusController(deps) {
	const d = deps || {};
	const RS = d.RS || (() => null);
	const getBookId = d.getBookId || (() => null);
	const getChapterId = d.getChapterId || (() => null);
	const getConversationId = d.getConversationId || (() => null);
	const host = d.host || (() => null);
	const api = d.api || (() => Promise.resolve({}));
	const toast = d.toast || (() => {});
	const pageVisible = d.pageVisible || (() => true);
	const hasUnsavedChanges = d.hasUnsavedChanges || (() => false);
	const selectChapter = d.selectChapter || (() => null);

	let lastRunSnapshot = null;
	let lastToolErrors = [];
	let lastRoundTools = [];
	let resourceNotice = null;
	let runWatcher = null;
	let resourceWatcher = null;

	function renderCardModel() {
		const rs = RS();
		if (!rs) return null;
		return rs.cardModel({
			run: lastRunSnapshot,
			conversationId: getConversationId(),
			tools: lastRoundTools,
			toolErrors: lastToolErrors,
			resourceNotice,
		});
	}

	// :1972-1985
	function renderRunCard() {
		const rs = RS();
		const el = host();
		if (!rs || !el) return null;
		const model = renderCardModel();
		rs.mountTaskCard(el, model, { onRefresh: onResourceRefresh });
		return model;
	}

	// :1987-2011 作者点「刷新」：脏正文保留（只提示），干净时才重新从服务端加载当前章
	async function onResourceRefresh() {
		const rs = RS();
		if (!rs) return null;
		const cid = getChapterId();
		const applied = rs.applyResourceRefresh({
			dirty: !!hasUnsavedChanges(),
			reload: () => (cid ? selectChapter(cid) : null),
		});
		if (!applied.applied) {
			toast(applied.hint || "暂时不能刷新");
			return applied;
		}
		resourceNotice = null;
		toast("已按服务端版本重新加载本章");
		if (cid) {
			try {
				const bookId = getBookId();
				const data = await api(
					"GET",
					`/api/resources?type=chapter&bookId=${bookId}&id=${cid}`,
				);
				const res = data?.resource;
				if (res) rs.observeResource(resourceKey(bookId, cid), res);
			} catch (_e) {
				/* 重新加载后读不到资源元数据：保持现状，不臆造 */
			}
		}
		renderRunCard();
		return applied;
	}

	// :2013-2042 读取当前章的服务端版本，判断是否被另一空间改过（只提示，不覆盖）
	async function checkCurrentResource() {
		const rs = RS();
		const cid = getChapterId();
		const bookId = getBookId();
		if (!rs || !cid || !bookId) return null;
		let data;
		try {
			data = await api(
				"GET",
				`/api/resources?type=chapter&bookId=${bookId}&id=${cid}`,
			);
		} catch (_e) {
			return null; // 读不到资源元数据：不提示，也不臆造「没有变化」
		}
		const res = data?.resource;
		if (!res) return null;
		const obs = rs.observeResource(resourceKey(bookId, cid), res);
		const notice = resourceNoticeFor(rs, res, cid, bookId, obs);
		if (notice) resourceNotice = notice;
		else if (!obs.changed) resourceNotice = null;
		return resourceNotice;
	}

	// :2044-2061
	async function refreshRunStatus(opts) {
		const rs = RS();
		if (!rs) return null;
		const o = opts || {};
		if (Array.isArray(o.messages)) {
			const snap = rs.runFromMessages(o.messages);
			if (snap) lastRunSnapshot = snap;
		}
		if (o.run) lastRunSnapshot = o.run;
		if (o.tools) lastRoundTools = o.tools;
		if (o.toolErrors) lastToolErrors = o.toolErrors;
		if (o.resourceNotice !== undefined) resourceNotice = o.resourceNotice;
		await rs.loadPersistence();
		if (o.checkResource !== false) await checkCurrentResource();
		renderRunCard();
		return lastRunSnapshot;
	}

	// :2064-2082 活跃运行时低频补齐（完成即停）；不可见时不发请求
	function syncRunWatcher() {
		const rs = RS();
		if (!rs || !host()) return null;
		if (!isActiveRun(lastRunSnapshot)) {
			if (runWatcher) {
				runWatcher.stop();
				runWatcher = null;
			}
			return null;
		}
		if (runWatcher) return runWatcher;
		runWatcher = rs.createWatcher({
			intervalMs: RUN_WATCH_INTERVAL_MS,
			isVisible: () => pageVisible(),
			load: async () => {
				await refreshRunStatus({ checkResource: false });
				return { terminal: !isActiveRun(lastRunSnapshot) };
			},
		});
		runWatcher.start();
		return runWatcher;
	}

	// :2089-2105
	function startStatusWatchers() {
		const rs = RS();
		if (!rs) return null;
		syncRunWatcher();
		if (!resourceWatcher) {
			resourceWatcher = rs.createWatcher({
				intervalMs: RESOURCE_WATCH_INTERVAL_MS, // 资料更新检查：低频（页面可见时才查）
				isVisible: () => pageVisible(),
				load: async () => {
					await refreshRunStatus({ checkResource: true });
					return { terminal: false }; // 资料更新是常驻检查
				},
			});
			resourceWatcher.start();
		}
		return resourceWatcher;
	}

	function stopWatchers() {
		if (resourceWatcher) {
			resourceWatcher.stop();
			resourceWatcher = null;
		}
		if (runWatcher) {
			runWatcher.stop();
			runWatcher = null;
		}
	}

	// :2108-2116 展示态开关（切后台只切展示态，不调 stop、不动运行状态）
	function setStatusPollingVisible(on) {
		const rs = RS();
		if (!rs) return null;
		const visible = !!on && pageVisible();
		if (visible) startStatusWatchers();
		else stopWatchers();
		return visible;
	}

	return {
		renderRunCard,
		renderCardModel,
		onResourceRefresh,
		checkCurrentResource,
		refreshRunStatus,
		syncRunWatcher,
		startStatusWatchers,
		setStatusPollingVisible,
		stopWatchers,
		getSnapshot: () => lastRunSnapshot,
		getNotice: () => resourceNotice,
		setNotice: (v) => {
			resourceNotice = v;
		},
		refreshAfterWriteFor: (name, args) =>
			refreshAfterWrite(name, args, {
				hasBook: () => !!getBookId(),
				getChapterId,
				loadChapters: d.loadChapters,
				selectChapter,
				loadCharacters: d.loadCharacters,
				loadWorld: d.loadWorld,
			}),
	};
}
