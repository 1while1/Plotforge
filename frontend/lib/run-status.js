// S5-10（Plan §2.1；charter §3 S5-10 行）：public/legacy/run-status.js（666 行）的 lib 移植——
// S4-05「统一可见状态（任务卡 / 保存三态 / 资料更新）」的纯逻辑/单例状态/命令式渲染。
//
// 语义单一来源（冻结契约 01 §8 / §3.1，逐字承自 legacy 头注）：
//   · 任务徽标只由服务端运行状态（running/awaiting_confirmation/paused/failed/interrupted/
//     cancelled/finished + reason）决定——length 截断是 paused/output_truncated，必须显示
//     「已暂停」而不是「完成」；声明完成必须带可查看的结果引用（run_finished.resultRefs）。
//   · 保存三态只由两件事决定：编辑器本地脏标记 + 服务端落盘事实（GET /api/health 的
//     persistence.lastSaveError/retryScheduled/exhausted，或 S1 的 503 PERSISTENCE_PENDING
//     响应）。任务 finished 与「当前新输入已保存」是两件事，这里不合并。
//   · 资料更新只提示、不覆盖：脏正文永远保留在编辑器里，刷新必须由作者点；聊天历史不自动加入。
//   · 未知就是未知：读不到服务端运行状态（网络中断/无权读取）显示「未知（待恢复）」，
//     绝不臆造成「失败」或「完成」。
//
// 本文件只做展示与状态推导，不写业务数据、不发写请求（唯一例外是作者点「重试落盘」时调用
// S1-01 既有的 POST /api/persistence/flush，该入口只尝试落盘、不重做业务写入）。
//
// 移植形态（与 legacy 的行号一一对应，可逐行对账）：
//   :23-150 文案表/任务徽标/保存三态/落盘观察（observeApi 猴补 window.App.api）
//   :152-198 loadPersistence/retryFlush/renderWritingSaveBadge
//   :200-244 资料更新（resourceStamp/stampChanged/observeResource/applyResourceRefresh）
//   :246-369 工具细节/确认卡会话绑定/结果引用/下一步/卡片模型（cardModel/unknownCard）
//   :371-527 渲染（ensureStyle/span/actionLink/mountTaskCard——DOM 宿主经 deps.doc 注入）
//   :529-636 服务端重建（runFromMessages/cardFromMessages/rebuildFromServer）＋低频轮询
//           （createWatcher/onVisibilityChange）
//   死 API 不移植：mountWorkbenchTask（:639-665，全仓零消费，随冻结期结束；台账 §S5-10 登记）。
//
// 依赖注入（Plan §2.1）：createRunStatus({doc, app, bookPage})——三者惰性取值。
// P6-2（生产面去全局化）：缺省自 `lib/app-runtime.js` 的模块单例取 App（等值原 globalThis window.App；
// **调用期**读取，故 runStatus.observeApi() 的猴补对经单例的调用恒生效），`d.app` 注入面保留给测试；
// 编辑器脏标记改走 `lib/writing-status.js` 的供给缝（等值原 `window.BookPage.hasUnsavedChanges?.()`）。
// 单例状态（persistenceSnapshot/savePending/resourceStamps）落在工厂闭包内＝一实例一份。

import { getApp as appGetApp } from "./app-runtime.js";
import * as writingStatus from "./writing-status.js";

export function createRunStatus(deps) {
	const d = deps || {};
	const getDoc = () =>
		d.doc || (typeof document !== "undefined" ? document : null);
	const resolveApp = () =>
		d.app || (typeof window !== "undefined" ? appGetApp() : null);
	const readEditorDirty = () =>
		d.bookPage
			? !!d.bookPage.hasUnsavedChanges?.()
			: writingStatus.isEditorDirty();

	const RS = {};

	// ---------- 文案（唯一表）----------
	const BADGES = {
		running: "正在读取/执行",
		awaiting_confirmation: "待确认",
		paused: "已暂停",
		rejected: "已拒绝",
		failed: "失败",
		interrupted: "中断",
		cancelled: "已停止",
		finished: "完成",
		unknown: "未知（待恢复）",
	};
	const SAVE_BADGES = {
		local: "本地未保存",
		pending: "已应用未落盘",
		saved: "已保存",
	};
	const RESOURCE_BADGE = "资料更新";
	const UNKNOWN_DETAIL =
		"网络中断或读不到服务端状态：结果未知，网络恢复后自动重试。";

	RS.BADGES = BADGES;
	RS.SAVE_BADGES = SAVE_BADGES;
	RS.RESOURCE_BADGE = RESOURCE_BADGE;
	RS.MIN_INTERVAL_MS = 2000;

	// ---------- 任务徽标 ----------
	RS.taskBadge = (run) => {
		const status = run?.status ? String(run.status) : "";
		const reason = run?.reason ? String(run.reason) : "";
		if (status === "paused")
			return reason === "action_rejected" ? BADGES.rejected : BADGES.paused;
		if (Object.hasOwn(BADGES, status) && status !== "rejected")
			return BADGES[status];
		return BADGES.unknown;
	};

	RS.isTerminalStatus = (status) =>
		["finished", "paused", "failed", "interrupted", "cancelled"].indexOf(
			String(status || ""),
		) >= 0;

	// ---------- 保存三态 ----------
	// pending：本次保存明确回了「已应用未落盘」（S1 的 503 PERSISTENCE_PENDING）；
	// persistence：GET /api/health 的 persistence 快照（落盘失败/待重试 = 已应用未落盘）。
	// 落盘失败期间「已应用未落盘」优先于本地脏标记：磁盘落后是更不可见、更需要作者知道的事实。
	RS.saveBadge = (input) => {
		const i = input || {};
		const p = i.persistence || null;
		if (i.pending === true) return SAVE_BADGES.pending;
		if (p && (p.lastSaveError || p.retryScheduled || p.exhausted))
			return SAVE_BADGES.pending;
		if (i.dirty) return SAVE_BADGES.local;
		return SAVE_BADGES.saved;
	};

	let persistenceSnapshot = null; // 最近一次 GET /api/health 的 persistence
	let savePending = false; // 最近一次写请求是否回了「已应用未落盘」

	RS.persistence = () => persistenceSnapshot;
	RS.savePending = () => savePending;
	RS.notePersistence = (persistence) => {
		if (!persistence || typeof persistence !== "object")
			return persistenceSnapshot;
		persistenceSnapshot = persistence;
		if (persistence.durable === true) {
			savePending = false;
			return persistenceSnapshot;
		}
		if (persistence.durable === false) {
			savePending = true; // S1 信封：本次写已应用到内存、磁盘没写上
			return persistenceSnapshot;
		}
		// /api/health 的原始状态：只有「失败事实」才算未落盘。dirty/pending 是 db 层的
		// debounce 队列（每次正常保存都会短暂为 true，db.js 自己称其为「谎报 pending」），
		// 拿它当失败会让作者每次保存都看见一次假的「已应用未落盘」；而落盘失败一定伴随
		// lastSaveError（并安排 retryScheduled，耗尽后 exhausted），成功落盘时 db.save()
		// 会清掉这三样 —— 所以用它们做唯一判据，恢复了就自动收回徽标。
		savePending = !!(
			persistence.lastSaveError ||
			persistence.retryScheduled ||
			persistence.exhausted
		);
		return persistenceSnapshot;
	};
	// 只认「失败事实」：durable=false / code=PERSISTENCE_PENDING。这里不能看 pending——
	// S1 的响应信封（durable/pending/code）里 pending=true 等于「saveNow 试过没写下去」，
	// 而 GET /api/health 的 persistence 来自 db.getPersistenceStatus()，同名 pending 只是
	// 1s debounce 计时器排着队（每次都正常保存也会短暂为 true）。两者混用会把正常保存
	// 误报成「已应用未落盘」，所以健康快照走 notePersistence，不走这里。
	RS.noteSaveOutcome = (info) => {
		const p = info?.persistence ? info.persistence : info;
		if (!p || typeof p !== "object") return savePending;
		const failed = p.durable === false || p.code === "PERSISTENCE_PENDING";
		if (failed) {
			savePending = true;
			persistenceSnapshot = p;
		} else if (p.durable === true) {
			savePending = false;
			persistenceSnapshot = p;
		}
		return savePending;
	};

	// 落盘事实一变（读快照/重试 flush）就重画状态条徽标：磁盘恢复后不该等作者再敲一次键，
	// 页面自己的刷新（进入页面、每轮收尾、可见时低频轮询）就要把「已应用未落盘」收回去。
	function renderWritingSaveBadgeIfMounted() {
		const doc = getDoc();
		if (!doc?.getElementById("writing-status-save")) return null;
		return RS.renderWritingSaveBadge();
	}
	RS.renderWritingSaveBadgeIfMounted = renderWritingSaveBadgeIfMounted;

	// 观察 page 层的 HTTP 客户端：所有页面的写请求都经 App.api，落盘失败（200 带
	// persistence.durable=false 或 503 PERSISTENCE_PENDING）在这里被记成「已应用未落盘」。
	// 只观察不干预：原样返回结果/原样抛出错误。
	function observeApi() {
		const App = resolveApp();
		if (!App || typeof App.api !== "function" || App.__runStatusObserved)
			return false;
		const orig = App.api;
		App.api = async function (...args) {
			try {
				const res = await orig.apply(this, args);
				if (res?.persistence) {
					RS.noteSaveOutcome(res.persistence);
					renderWritingSaveBadgeIfMounted();
				}
				return res;
			} catch (e) {
				if (e && (e.code === "PERSISTENCE_PENDING" || e.details?.persistence)) {
					RS.noteSaveOutcome(
						e.code === "PERSISTENCE_PENDING"
							? { code: e.code, durable: false, pending: true }
							: e.details.persistence,
					);
					renderWritingSaveBadgeIfMounted();
				}
				throw e;
			}
		};
		App.__runStatusObserved = true;
		return true;
	}
	RS.observeApi = observeApi;

	// 读盘快照（作者 UI 只读入口，复用 S1-01 的 /api/health）
	RS.loadPersistence = async () => {
		const App = resolveApp();
		if (!App || typeof App.api !== "function") return persistenceSnapshot;
		try {
			const data = await App.api("GET", "/api/health");
			if (data?.persistence) {
				RS.notePersistence(data.persistence);
				renderWritingSaveBadgeIfMounted();
			}
		} catch (_e) {
			/* 读不到就保持上一份快照，不臆造「已保存」 */
		}
		return persistenceSnapshot;
	};

	// 重试落盘：只调 S1-01 的 flush（不重做业务写入）
	RS.retryFlush = async () => {
		const App = resolveApp();
		if (!App || typeof App.api !== "function")
			return { ok: false, message: "当前页面没有可用的接口层" };
		try {
			const data = await App.api("POST", "/api/persistence/flush", {});
			if (data?.persistence) {
				RS.notePersistence(data.persistence);
				renderWritingSaveBadgeIfMounted();
			}
			const durable = !!data?.persistence?.durable;
			return {
				ok: durable,
				message: durable
					? "已写入磁盘"
					: "磁盘仍不可用：改动已保留在内存并将自动重试，请勿关闭页面",
			};
		} catch (e) {
			if (e?.details?.persistence) {
				RS.notePersistence(e.details.persistence);
				renderWritingSaveBadgeIfMounted();
			} else if (e && e.code === "PERSISTENCE_PENDING") {
				RS.noteSaveOutcome({ code: e.code, durable: false, pending: true });
				renderWritingSaveBadgeIfMounted();
			}
			return { ok: false, message: e?.message || "重试落盘失败" };
		}
	};

	// 写作页状态条上的保存徽标（BookShell.renderWritingStatus 调用这里，单一含义来源；
	// 等值 legacy :191-198——book.js 的 renderWritingStatus 由 frontend/pages/BookShell.jsx 承接）
	RS.renderWritingSaveBadge = () => {
		const dirty = readEditorDirty();
		const badge = RS.saveBadge({
			dirty: dirty,
			pending: savePending,
			persistence: persistenceSnapshot,
		});
		const doc = getDoc();
		const el = doc ? doc.getElementById("writing-status-save") : null;
		if (el) el.textContent = badge;
		return badge;
	};

	// ---------- 资料更新（另一空间改了当前资料）----------
	const resourceStamps = {};

	RS.resourceStamp = (resource) => {
		if (!resource || typeof resource !== "object") return null;
		const meta = resource.meta || {};
		const revision =
			meta.revision != null
				? meta.revision
				: resource.revision != null
					? resource.revision
					: null;
		return {
			revision: revision == null ? null : Number(revision),
			updatedAt: resource.updatedAt || resource.updated_at || null,
			deleted: resource.status === "deleted" || resource.found === false,
		};
	};

	RS.stampChanged = (before, after) => {
		if (!before || !after) return false;
		if (before.deleted !== after.deleted) return true;
		if (before.deleted && after.deleted) return false;
		if (before.revision != null && after.revision != null)
			return before.revision !== after.revision;
		return String(before.updatedAt || "") !== String(after.updatedAt || "");
	};

	// 记录本次读到的服务端版本；返回是否相对上次发生变化（第一次只建立基线）
	RS.observeResource = (key, resource) => {
		const stamp = RS.resourceStamp(resource);
		if (!stamp)
			return { changed: false, current: null, previous: null, first: false };
		const previous = resourceStamps[key] || null;
		resourceStamps[key] = stamp;
		return {
			changed: RS.stampChanged(previous, stamp),
			current: stamp,
			previous: previous,
			first: !previous,
		};
	};

	// 刷新动作：脏正文永不被覆盖；干净时才由调用方重新从服务端取该对象
	RS.applyResourceRefresh = (input) => {
		const i = input || {};
		if (i.dirty) {
			return {
				applied: false,
				reason: "dirty_editor",
				hint: "编辑器里还有未保存的修改：已保留你的稿子，未从服务端覆盖。请先保存（或复制）后再刷新。",
			};
		}
		if (typeof i.reload === "function") {
			return { applied: true, reason: "clean", result: i.reload() };
		}
		return {
			applied: false,
			reason: "no_loader",
			hint: "当前没有可用的重新加载入口。",
		};
	};

	// ---------- 工具细节（折叠；可展开看目标与来源版本）----------
	const TARGET_KEYS = [
		"chapter_id",
		"chapterId",
		"character_id",
		"characterId",
		"entity_id",
		"world_id",
		"volume_id",
		"note_id",
		"handoff_id",
		"book_id",
		"bookId",
		"name",
	];

	RS.toolTarget = (args) => {
		if (!args || typeof args !== "object") return null;
		for (let i = 0; i < TARGET_KEYS.length; i++) {
			const v = args[TARGET_KEYS[i]];
			if (v === undefined || v === null || v === "") continue;
			return `${TARGET_KEYS[i]}=${v}`;
		}
		return null;
	};

	// 来源版本只从工具结果里已经返回的字段取（revision / sourceVersion / 指纹），没有就是 null
	RS.toolSourceVersion = (result) => {
		if (!result || typeof result !== "object") return null;
		const data =
			result.data && typeof result.data === "object" ? result.data : result;
		if (data.chapter && data.chapter.revision != null)
			return `revision ${data.chapter.revision}`;
		if (data.volume && data.volume.revision != null)
			return `revision ${data.volume.revision}`;
		if (data.revision != null) return `revision ${data.revision}`;
		if (data.sourceVersion != null)
			return `sourceVersion ${data.sourceVersion}`;
		if (data.sourceFingerprint)
			return `fingerprint ${String(data.sourceFingerprint).slice(0, 12)}`;
		return null;
	};

	RS.toolDetails = (list) =>
		(Array.isArray(list) ? list : []).map((t) => {
			const result = t?.result;
			const data =
				result?.data && typeof result.data === "object" ? result.data : result;
			return {
				name: t?.name || data?.name || "",
				target: RS.toolTarget(t?.args),
				sourceVersion: RS.toolSourceVersion(result),
				status: result && result.ok === false ? "failed" : "ok",
			};
		});

	// ---------- 确认卡与会话绑定 ----------
	// 待确认卡只属于它自己的会话：其他会话（或没有会话归属的旧卡）不显示为当前会话的待确认。
	RS.actionsForConversation = (actions, conversationId) => {
		const list = Array.isArray(actions) ? actions : [];
		const bound = [];
		const unbound = [];
		for (let i = 0; i < list.length; i++) {
			const a = list[i] || {};
			const cid = a.conversationId || a.conversation_id || null;
			if (cid && conversationId && String(cid) === String(conversationId))
				bound.push(a);
			else unbound.push(a);
		}
		return { bound: bound, unbound: unbound };
	};

	// ---------- 结果引用 ----------
	RS.resultRefsFrom = (events, run) => {
		let refs = [];
		const list = Array.isArray(events) ? events : [];
		for (let i = list.length - 1; i >= 0; i--) {
			const ev = list[i] || {};
			if (
				ev.type === "run_finished" &&
				ev.payload &&
				Array.isArray(ev.payload.resultRefs)
			) {
				refs = ev.payload.resultRefs;
				break;
			}
		}
		if (!refs.length && run && Array.isArray(run.resultRefs))
			refs = run.resultRefs;
		return refs;
	};

	RS.nextStepFor = (badge, opts) => {
		const o = opts || {};
		if (badge === BADGES.failed)
			return { label: "查看运行记录后重试", href: "#/agent" };
		if (badge === BADGES.interrupted)
			return { label: "核对目标内容后重新发起", href: "#/agent" };
		if (badge === BADGES.awaiting_confirmation)
			return { label: "回到会话处理待确认操作", href: "#/agent" };
		if (badge === BADGES.unknown)
			return { label: "重试读取运行状态", action: "retry" };
		if (badge === BADGES.paused)
			return {
				label: "按已取得的结果继续（任务未完成）",
				href: o.continueHref || "#/agent",
			};
		if (badge === BADGES.rejected)
			return { label: "重新发起需要作者先说明理由", href: "#/agent" };
		return null;
	};

	// ---------- 卡片模型 ----------
	RS.cardModel = (input) => {
		const i = input || {};
		const run = i.run || null;
		// 没有运行快照时不摆徽标（也不猜）：只有真正读到服务端状态才给徽标
		const badge = run ? RS.taskBadge(run) : null;
		const tools = RS.toolDetails(i.tools || []);
		const refs = RS.resultRefsFrom(i.events || [], run);
		const scope = RS.actionsForConversation(
			i.actions || [],
			i.conversationId || null,
		);
		const toolErrors = (i.toolErrors || []).slice();
		return {
			badge: badge,
			status: run?.status || null,
			reason: run?.reason || null,
			runId: i.runId || run?.id || null,
			conversationId: i.conversationId || null,
			unknown: badge === BADGES.unknown,
			finished: badge === BADGES.finished,
			hasRun: !!run,
			resultRefs: refs,
			hasResultRefs: refs.length > 0,
			tools: tools,
			toolErrors: toolErrors,
			pendingActions: scope.bound,
			otherConversationActions: scope.unbound.length,
			resourceNotice: i.resourceNotice || null,
			detail: i.detail || null,
			recovered: i.recovered || null,
			nextStep: RS.nextStepFor(badge, i),
		};
	};

	RS.unknownCard = (input) => {
		const i = input || {};
		const card = RS.cardModel({
			run: null,
			conversationId: i.conversationId || null,
			detail: i.detail || UNKNOWN_DETAIL,
			recovered: "unknown",
		});
		card.badge = BADGES.unknown; // 明确：读不到服务端状态＝未知（待恢复），不是失败也不是完成
		card.unknown = true;
		card.nextStep = RS.nextStepFor(BADGES.unknown, {});
		return card;
	};

	// ---------- 渲染（DOM API；模块自带样式，不改 style.css）----------
	const STYLE_ID = "run-status-style";
	function ensureStyle() {
		const doc = getDoc();
		if (!doc?.head || typeof doc.createElement !== "function") return;
		if (doc.getElementById?.(STYLE_ID)) return;
		const style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent =
			".run-card{display:flex;flex-direction:column;gap:4px;padding:6px 10px;font-size:12px;" +
			"border-bottom:1px solid rgba(127,127,127,.25);align-items:flex-start}" +
			".run-card.hidden{display:none}" +
			".run-badge{font-weight:600}" +
			".run-card .run-tools{font-size:12px}" +
			".run-card .run-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}";
		doc.head.appendChild(style);
	}

	function span(doc, className, text) {
		const el = doc.createElement("span");
		el.className = className;
		el.textContent = text;
		return el;
	}

	function actionLink(doc, label, href) {
		const a = doc.createElement("a");
		a.className = "run-action-link";
		a.href = href;
		a.textContent = label;
		return a;
	}

	// 渲染任务卡。opts.onRefresh：作者点「刷新」（资料更新）时的回调。
	RS.mountTaskCard = (target, model, opts) => {
		const o = opts || {};
		const doc = getDoc();
		if (!doc) return null;
		const host =
			typeof target === "string" ? doc.getElementById(target) : target;
		if (!host) return null;
		ensureStyle();
		host.innerHTML = "";
		if (!model) {
			host.classList.add("hidden");
			return host;
		}
		host.classList.remove("hidden");

		const head = doc.createElement("div");
		head.className = "run-head";
		if (model.badge) head.appendChild(span(doc, "run-badge", model.badge));
		if (model.detail)
			head.appendChild(span(doc, "run-detail", `· ${model.detail}`));
		host.appendChild(head);

		if (model.finished) {
			if (model.hasResultRefs) {
				const rl = doc.createElement("div");
				rl.className = "run-results";
				rl.appendChild(span(doc, "run-results-label", "结果引用："));
				model.resultRefs.forEach((r, idx) => {
					const href = r && (r.route || r.href);
					const label = (r && (r.label || r.id)) || `#${idx + 1}`;
					if (href) rl.appendChild(actionLink(doc, `查看结果 ${label}`, href));
					else rl.appendChild(span(doc, "run-result-item", String(label)));
				});
				host.appendChild(rl);
			} else {
				host.appendChild(
					span(
						doc,
						"run-no-result",
						"本轮没有可核验的结果引用：徽标只表示运行收尾，不代表已写入任何内容。",
					),
				);
			}
		}

		if (model.tools.length) {
			const details = doc.createElement("details");
			details.className = "run-tools";
			const summary = doc.createElement("summary");
			summary.textContent = `工具细节（${model.tools.length}）— 目标与来源版本`;
			details.appendChild(summary);
			const ul = doc.createElement("ul");
			model.tools.forEach((t) => {
				const li = doc.createElement("li");
				li.textContent =
					(t.name || "工具") +
					" · 目标：" +
					(t.target || "未提供") +
					" · 来源版本：" +
					(t.sourceVersion || "未提供");
				ul.appendChild(li);
			});
			details.appendChild(ul);
			host.appendChild(details);
		}

		if (model.toolErrors.length) {
			const errs = doc.createElement("details");
			errs.className = "run-tool-errors";
			const esum = doc.createElement("summary");
			esum.textContent = `被拒绝/失败的工具（${model.toolErrors.length}）`;
			errs.appendChild(esum);
			const eul = doc.createElement("ul");
			model.toolErrors.forEach((e) => {
				const li = doc.createElement("li");
				li.textContent =
					(e.code ? `[${e.code}] ` : "") +
					(e.toolName || "") +
					"：" +
					(e.message || "");
				eul.appendChild(li);
			});
			errs.appendChild(eul);
			host.appendChild(errs);
		}

		if (model.pendingActions.length || model.otherConversationActions) {
			const pl = doc.createElement("div");
			pl.className = "run-pending";
			model.pendingActions.forEach((a) => {
				pl.appendChild(
					span(
						doc,
						"run-pending-item",
						`待确认（本会话）：${a.summary || a.name || a.id}`,
					),
				);
			});
			if (model.otherConversationActions) {
				pl.appendChild(
					span(
						doc,
						"run-pending-other",
						"另有 " +
							model.otherConversationActions +
							" 张待确认卡属于其他会话，不在本会话显示。",
					),
				);
			}
			host.appendChild(pl);
		}

		if (model.resourceNotice) {
			const rn = doc.createElement("div");
			rn.className = "run-resource-notice";
			rn.appendChild(
				span(doc, "run-resource-badge", model.resourceNotice.badge),
			);
			rn.appendChild(
				span(doc, "run-resource-detail", `· ${model.resourceNotice.detail}`),
			);
			const actions = doc.createElement("div");
			actions.className = "run-actions";
			(model.resourceNotice.actions || []).forEach((a) => {
				if (a.key === "diff")
					actions.appendChild(actionLink(doc, a.label, a.href || "#"));
				else {
					const btn = doc.createElement("button");
					btn.type = "button";
					btn.className = "btn btn-small btn-outline";
					btn.id = "writing-run-card-refresh";
					btn.textContent = a.label;
					btn.onclick = () => {
						if (typeof o.onRefresh === "function") o.onRefresh();
					};
					actions.appendChild(btn);
				}
			});
			rn.appendChild(actions);
			host.appendChild(rn);
		}

		if (model.nextStep) {
			const ns = doc.createElement("div");
			ns.className = "run-next";
			if (
				model.nextStep.action === "retry" &&
				typeof o.onRetry === "function"
			) {
				const rbtn = doc.createElement("button");
				rbtn.type = "button";
				rbtn.className = "btn btn-small btn-outline";
				rbtn.id = "run-card-retry";
				rbtn.textContent = model.nextStep.label;
				rbtn.onclick = () => {
					o.onRetry();
				};
				ns.appendChild(rbtn);
			} else if (model.nextStep.href) {
				ns.appendChild(
					actionLink(
						doc,
						`下一步：${model.nextStep.label}`,
						model.nextStep.href,
					),
				);
			} else {
				ns.appendChild(
					span(doc, "run-next-label", `下一步：${model.nextStep.label}`),
				);
			}
			host.appendChild(ns);
		}
		return host;
	};

	// ---------- 从服务端重建（刷新后不靠浏览器上一条气泡）----------
	// 服务端有两个真相源：会话消息里的运行快照（GET /chat 的 message.run，写作入口与 Agent 入口
	// 都有）与运行行/事件（GET /api/runs/:id[/events]，写作入口有事件表）。两者都读不到 → 未知。
	RS.runFromMessages = (messages) => {
		const list = Array.isArray(messages) ? messages : [];
		for (let i = list.length - 1; i >= 0; i--) {
			const run = list[i]?.run;
			if (run?.status) return run;
		}
		return null;
	};

	RS.cardFromMessages = (messages, opts) => {
		const o = opts || {};
		const run = RS.runFromMessages(messages);
		if (!run) return null;
		return RS.cardModel({
			run: run,
			conversationId: o.conversationId || null,
			actions: o.actions || [],
			tools: o.tools || [],
			toolErrors: o.toolErrors || [],
			resourceNotice: o.resourceNotice || null,
			recovered: "server",
		});
	};

	RS.rebuildFromServer = async (input) => {
		const i = input || {};
		if (!i.runId)
			return {
				ok: false,
				card: RS.unknownCard({ conversationId: i.conversationId || null }),
			};
		const doFetch = i.fetchImpl || (typeof fetch === "function" ? fetch : null);
		if (!doFetch)
			return {
				ok: false,
				card: RS.unknownCard({ conversationId: i.conversationId || null }),
			};
		let res = null;
		try {
			res = await doFetch(`/api/runs/${encodeURIComponent(i.runId)}`, {
				headers: { "x-session-key": i.sessionKey || "" },
			});
		} catch (_e) {
			return {
				ok: false,
				card: RS.unknownCard({ conversationId: i.conversationId || null }),
			};
		}
		if (!res?.ok) {
			return {
				ok: false,
				card: RS.unknownCard({
					conversationId: i.conversationId || null,
					detail: `读不到运行状态（HTTP ${res?.status}）：不臆造成功或失败。`,
				}),
			};
		}
		let data = null;
		try {
			data = await res.json();
		} catch (_e) {
			data = null;
		}
		if (!data?.run)
			return {
				ok: false,
				card: RS.unknownCard({ conversationId: i.conversationId || null }),
			};
		let events = null;
		try {
			const eres = await doFetch(
				`/api/runs/${encodeURIComponent(i.runId)}/events?afterSeq=0`,
				{ headers: { "x-session-key": i.sessionKey || "" } },
			);
			if (eres?.ok) {
				const ed = await eres.json();
				events = ed?.events || null;
			}
		} catch (_e) {
			events = null; // Agent 入口本来就没有事件表：只有运行行，如实标记
		}
		return {
			ok: true,
			events: events,
			card: RS.cardModel({
				run: data.run,
				runId: data.run.id,
				conversationId: i.conversationId || data.run.conversationId || null,
				events: events || [],
				actions: i.actions || [],
				resourceNotice: i.resourceNotice || null,
				recovered: "server",
			}),
		};
	};

	// ---------- 低频轮询（按需 / 页面可见时；完成后停止）----------
	// intervalMs 有下限（RS.MIN_INTERVAL_MS）：不接受「每秒全库扫描」这类高频查询。
	RS.createWatcher = (opts) => {
		const o = opts || {};
		const interval = Math.max(Number(o.intervalMs) || 5000, RS.MIN_INTERVAL_MS);
		let timer = null;
		let isStopped = false;
		let skippedHidden = 0;
		function visible() {
			return typeof o.isVisible === "function" ? !!o.isVisible() : true;
		}
		async function tick() {
			if (isStopped) return null;
			if (!visible()) {
				skippedHidden += 1;
				return null;
			}
			const card = await o.load();
			if (o.onUpdate && card) o.onUpdate(card);
			if (card?.terminal) stop();
			return card || null;
		}
		function start() {
			if (isStopped || timer) return;
			timer = setInterval(() => {
				tick().catch(() => {
					/* 单次失败不打断轮询 */
				});
			}, interval);
		}
		function stop() {
			isStopped = true;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		}
		return {
			intervalMs: interval,
			tick: tick,
			start: start,
			stop: stop,
			stopped: () => isStopped,
			skippedHidden: () => skippedHidden,
		};
	};

	RS.onVisibilityChange = (handler) => {
		const doc = getDoc();
		if (!doc || typeof doc.addEventListener !== "function") return false;
		doc.addEventListener("visibilitychange", handler);
		return true;
	};

	return RS;
}

// 浏览器单例（等值 legacy 模块级单例；依赖惰性读 globalThis）。旧名 window.RunStatus 由
// frontend/bridges/legacy-bridge.jsx 守卫式承接（名字承接，非兼容 shim）。
export const runStatus = createRunStatus();
