// S5-4（Plan §2.4.1；范式 B 状态库移植＋判定 C 旧名桥）：统一导航状态逐字移植。
// public/legacy/workspace-state.js（392 行）由本 lib 承接并 git rm 全退役；旧名
// window.WorkspaceState 的 21 个 API 由 legacy-bridge.jsx 守卫式供给——消费方
// AppRouter.jsx:121-122/:170-171（S5-3 交付物）、ChapterEditorPanel.jsx:988-989（S5-2）、
// Character/Ledger/Outline 三面板（S4-3/4/7）全部经旧名 window 读取，旧名命中使其产品代码零 diff
//（S4-8 window.RewriteCurvePanel「旧名之选」同款命名裁量）。
// 等值口径（逐条对 legacy 行号）：
//   · RETURN_PREFIX/LEGACY_RETURN_PREFIX（:24-25）；parseHash（:57-78）——原 :60-69 对
//     window.WorkbenchShell.parse 的依赖改为内部 parseWorkbenchRoute（同一套 hash 约定），
//     畸形百分号由 try/catch 收敛为 null（已知对照差异·异常路径：旧件 decodeURIComponent 抛
//     URIError 并使 show 同步抛出 → 白屏；无任何测试锚定该异常路径）。
//   · capture（:98-132）写作/阅读/工作台/agent 四分支＋chapterOwnerBookId 跨台保留与换书失效。
//   · href（:134-149）／normalizeTarget（:151-162）／返回锚三件（:165-207）／脏守卫（:210-243）／
//     beforeNavigate（:252-268，leave 优先、失败 notifyBlocked 文案逐字）／竞态令牌（:271-282）／
//     verify＋ENTITY_CHECKS（:285-324）／notifyMissing 四文案（:326-333）／
//     setHash/navigate/restore/apply（:336-391）。
//   · 全局读取（document/localStorage/sessionStorage/window.location）一律在调用期取，与旧件逐字同款；
//     App 取用（P6-2 §2.5-D2）改 lib 单例 `getApp()` 调用期读取，编辑器/聊天/状态条三读点改模块面
//     （chapterEditorApi()／chatApi()／renderWritingStatusIfBound()）——旧名桥 window.WorkspaceState
//     随 P6-2 退役，本 lib 由 `getWorkspaceState()` 单例直取。工厂 createWorkspaceState() 的闭包等价旧
//     IIFE 单例（guards/epochs/chapterOwnerBookId 在闭包内）。
// 导出的 parseWorkbenchRoute/WORKBENCH_MODULES/WORKBENCH_LABELS＝原 workbench-shell.js
// parse:12-24 的内部化（供本 lib 与 WorkbenchPage.jsx 外壳共用，不再经 window 取）。

import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { chatApi } from "../components/ChatWorkspace.jsx";
// P6-2（§2.5-D2/D3/D4）：旧名桥退役后的三处模块直取——App 单例、编辑器名义入口、聊天命令面，
// 以及写作状态条渲染缝（未注册＝no-op，等值原 `typeof page.renderWritingStatus === "function"` 守卫）。
// 依赖环：本文件 ← ChapterEditorPanel/ChatWorkspace 均已 import 本文件（`getWorkspaceState()`）；
// 两侧导出均为函数声明（hoisted）且一律**调用期**读取，无模块求值期绑定引用（T1/T3＋构建见证）。
import { getApp } from "./app-runtime.js";
import { renderWritingStatusIfBound } from "./writing-status.js";

export const RETURN_PREFIX = "novel-workspace-return:";
export const LEGACY_RETURN_PREFIX = "novel-editor-return:"; // S4-02 之前的键：旧会话仍可打开

export const WORKBENCH_LABELS = {
	characters: "人物中枢",
	ledger: "故事台账",
	outline: "大纲工作台",
	world: "世界观工作台",
};
export const WORKBENCH_MODULES = Object.keys(WORKBENCH_LABELS);

// workbench-shell.js:12-24 parse 的内部化（旧名桥 window.WorkbenchShell.parse 同源同实现）
export function parseWorkbenchRoute(hash) {
	try {
		const raw = (hash || "").replace(/^#/, "");
		const parts = raw.split("?");
		const segments = parts[0]
			.split("/")
			.filter(Boolean)
			.map(decodeURIComponent);
		if (
			segments[0] !== "book" ||
			segments[2] !== "workbench" ||
			!WORKBENCH_LABELS[segments[3]]
		)
			return null;
		const query = new URLSearchParams(parts[1] || "");
		return {
			bookId: segments[1],
			module: segments[3],
			entityId: segments[4] || null,
			tab: query.get("tab") || null,
		};
	} catch (_e) {
		return null;
	}
}

function win() {
	return typeof window === "undefined" ? null : window;
}
// P6-2（§2.5-D2/D5）：App 取用改模块单例（等值原 `w?.App` 调用期读取；`|| {}` 归一保留
// ——setAppForTests(null) 尚未懒建时的兜底语义不变）。
function app() {
	return getApp() || {};
}
function appState() {
	const a = getApp();
	return a?.state || {};
}
function currentHash() {
	const w = win();
	return w?.location?.hash || "#/";
}
function localStore() {
	const w = win();
	return w ? w.localStorage : null;
}
function sessionStore() {
	const w = win();
	return w ? w.sessionStorage : null;
}
function documentEl() {
	const w = win();
	return w ? w.document : null;
}
function decode(value) {
	try {
		return decodeURIComponent(value);
	} catch (_e) {
		return value;
	}
}
function readStore(store, key) {
	try {
		return store ? store.getItem(key) : null;
	} catch (_e) {
		return null;
	}
}
function writeStore(store, key, value) {
	try {
		if (store) store.setItem(key, value);
	} catch (_e) {
		/* 存储不可用：不影响导航 */
	}
}
function removeStore(store, key) {
	try {
		if (store) store.removeItem(key);
	} catch (_e) {
		/* 同上 */
	}
}
function safeParse(raw) {
	try {
		return JSON.parse(raw);
	} catch (_e) {
		return null;
	}
}
function wait(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
async function waitFor(pred, ms) {
	const deadline = Date.now() + (ms || 3000);
	for (;;) {
		try {
			if (pred()) return true;
		} catch (_e) {
			/* 节点尚未渲染：继续等 */
		}
		if (Date.now() > deadline) return false;
		await wait(10);
	}
}

// 服务端真相校验（不把过期内存当服务器真相）（:285-298 逐字）
const ENTITY_CHECKS = {
	characters: {
		url: (snap) =>
			`/api/books/${encodeURIComponent(snap.bookId)}/characters?limit=200`,
		pick: (data) => (data && (data.items || data.characters)) || [],
	},
	world: {
		url: (snap) => `/api/books/${encodeURIComponent(snap.bookId)}/world`,
		pick: (data) => data?.entries || [],
	},
	outline: {
		url: (snap) => `/api/books/${encodeURIComponent(snap.bookId)}/volumes`,
		pick: (data) => data?.volumes || [],
	},
};

export function createWorkspaceState() {
	const WS = {};
	let guards = [];
	const epochs = {};
	let chapterOwnerBookId = null; // 「当前章属于哪本书」：跨工作台保留，换书即失效

	// ---------- 路由解析（与外壳同一套 hash 约定）----------
	function parseHash(raw) {
		const out = {
			workspace: "shelf",
			bookId: null,
			entityType: null,
			entityId: null,
			tab: null,
		};
		const hash = String(raw == null ? "" : raw);
		const route = parseWorkbenchRoute(hash);
		if (route) {
			out.workspace = "workbench";
			out.bookId = route.bookId;
			out.entityType = route.module;
			out.entityId = route.entityId;
			out.tab = route.tab;
			return out;
		}
		// 五条分类正则一次求值＋按序命中（等值 :71-77 的赋值表达式链，避免 assign-in-expression）
		const agentMatch = /^#\/agent(?:$|[/?])/.exec(hash);
		const readMatch = /^#\/book\/([^/?]+)\/read(?:$|[/?])/.exec(hash);
		const charMatch = /^#\/book\/([^/?]+)\/characters\//.exec(hash);
		const cardsMatch = /^#\/book\/([^/?]+)\/(?:cards|stylelab)/.exec(hash);
		const bookMatch = /^#\/book\/([^/?]+)/.exec(hash);
		if (agentMatch) out.workspace = "agent";
		else if (readMatch) {
			out.workspace = "read";
			out.bookId = decode(readMatch[1]);
		} else if (charMatch) {
			out.workspace = "read";
			out.bookId = decode(charMatch[1]);
		} else if (cardsMatch) {
			out.workspace = "read";
			out.bookId = decode(cardsMatch[1]);
		} else if (bookMatch) {
			out.workspace = "writing";
			out.bookId = decode(bookMatch[1]);
		}
		return out;
	}
	WS.parseHash = parseHash;

	function writingConversationId(bookId) {
		if (bookId === null || bookId === undefined || bookId === "") return null;
		const saved = readStore(
			localStore(),
			`writing_conversation_${String(bookId)}`,
		);
		if (saved) return saved;
		const doc = documentEl();
		const sel = doc ? doc.getElementById("writing-conversation-select") : null;
		if (sel?.value && currentHash().indexOf(`#/book/${bookId}`) === 0)
			return String(sel.value);
		return null;
	}
	function agentScopeBookId() {
		const m = /^book:(\d+)$/.exec(
			readStore(localStore(), "agent_scope_v1") || "",
		);
		return m ? Number(m[1]) : null;
	}
	function agentConversationId() {
		return readStore(localStore(), "agent_conversation_v1") || null;
	}

	// ---------- 导航对象 ----------
	WS.capture = (rawHash) => {
		const parsed = parseHash(rawHash === undefined ? currentHash() : rawHash);
		const state = appState();
		const nav = {
			workspace: parsed.workspace,
			bookId: parsed.bookId,
			conversationId: null,
			chapterId: null,
			entityType: parsed.entityType,
			entityId: parsed.entityId,
			tab: parsed.tab,
			returnTo: null,
		};
		if (parsed.workspace === "writing" || parsed.workspace === "read") {
			nav.conversationId = writingConversationId(parsed.bookId);
			nav.chapterId =
				state.currentChapterId != null ? Number(state.currentChapterId) : null;
			chapterOwnerBookId = nav.chapterId != null ? String(parsed.bookId) : null;
			return nav;
		}
		if (parsed.workspace === "workbench") {
			nav.conversationId = writingConversationId(parsed.bookId);
			// 工作台里沿用写作页的当前章——只在同一本书内有效，避免把 A 书的章带到 B 书
			if (
				chapterOwnerBookId &&
				String(chapterOwnerBookId) === String(parsed.bookId) &&
				state.currentChapterId != null
			) {
				nav.chapterId = Number(state.currentChapterId);
			}
			const record = WS.readReturn(parsed.bookId);
			nav.returnTo = record ? WS.href(record) : null;
			return nav;
		}
		if (parsed.workspace === "agent") {
			nav.bookId = agentScopeBookId();
			nav.conversationId = agentConversationId();
		}
		return nav;
	};

	WS.href = (target) => {
		const t = target || {};
		if (t.workspace === "agent") return "#/agent";
		if (t.workspace === "workbench") {
			if (t.bookId === null || t.bookId === undefined || t.bookId === "")
				return "#/";
			let base = `#/book/${encodeURIComponent(t.bookId)}/workbench/${encodeURIComponent(t.entityType || "characters")}`;
			if (t.entityId !== null && t.entityId !== undefined && t.entityId !== "")
				base += `/${encodeURIComponent(t.entityId)}`;
			if (t.tab) base += `?tab=${encodeURIComponent(t.tab)}`;
			return base;
		}
		if (t.bookId === null || t.bookId === undefined || t.bookId === "")
			return "#/";
		if (t.workspace === "read" && t.chapterId) {
			return `#/book/${encodeURIComponent(t.bookId)}/read/${encodeURIComponent(t.chapterId)}`;
		}
		return `#/book/${encodeURIComponent(t.bookId)}`;
	};

	function normalizeTarget(target, base) {
		const out = {};
		const src = base || {};
		for (const k in src) out[k] = src[k];
		const given = target || {};
		for (const g in given) if (given[g] !== undefined) out[g] = given[g];
		if (!out.workspace || out.workspace === "shelf") return null;
		if (out.workspace !== "workbench") {
			out.entityType = null;
			out.entityId = null;
			out.tab = null;
		}
		if (
			out.workspace !== "agent" &&
			(out.bookId === null || out.bookId === undefined || out.bookId === "")
		)
			return null;
		return out;
	}
	WS.normalizeTarget = normalizeTarget;

	// ---------- 返回锚（工作台入口携带 returnTo）----------
	WS.rememberReturn = (snapshot, bookId) => {
		if (!snapshot || bookId === null || bookId === undefined || bookId === "")
			return null;
		const copy = {};
		for (const k in snapshot) copy[k] = snapshot[k];
		copy.returnTo = null; // 记录的是「来源本身」，不再套娃
		writeStore(
			sessionStore(),
			RETURN_PREFIX + String(bookId),
			JSON.stringify(copy),
		);
		return copy;
	};

	WS.readReturn = (bookId) => {
		if (bookId === null || bookId === undefined || bookId === "") return null;
		const raw = readStore(sessionStore(), RETURN_PREFIX + String(bookId));
		if (raw) {
			const nav = safeParse(raw);
			if (nav?.workspace && nav.workspace !== "shelf") return nav;
		}
		const legacy = readStore(
			sessionStore(),
			LEGACY_RETURN_PREFIX + String(bookId),
		);
		if (legacy) {
			const parsed = parseHash(legacy);
			if (parsed.workspace !== "shelf") {
				return {
					workspace: parsed.workspace,
					bookId: parsed.bookId,
					conversationId: null,
					chapterId: null,
					entityType: parsed.entityType,
					entityId: parsed.entityId,
					tab: parsed.tab,
					returnTo: null,
				};
			}
		}
		return null;
	};

	WS.forgetReturn = (bookId) => {
		if (bookId === null || bookId === undefined || bookId === "") return;
		removeStore(sessionStore(), RETURN_PREFIX + String(bookId));
		removeStore(sessionStore(), LEGACY_RETURN_PREFIX + String(bookId));
	};

	// 离开一个非工作台页面且目标进入工作台时记录来源（工作台之间穿梭保留最初来源）
	WS.noteDeparture = (fromHash, toHash) => {
		const to = parseHash(toHash === undefined ? currentHash() : toHash);
		if (to.workspace !== "workbench") return null;
		const from = WS.capture(fromHash);
		if (from.workspace === "workbench" && WS.readReturn(to.bookId)) return null;
		return WS.rememberReturn(from, to.bookId);
	};

	// ---------- 脏编辑守卫 ----------
	WS.dirtyTracker = () => {
		let generation = 0;
		let dirty = false;
		return {
			mark() {
				generation += 1;
				dirty = true;
				return generation;
			},
			snapshot() {
				return generation;
			},
			isDirty() {
				return dirty;
			},
			// 保存成功只有当「提交时的代数仍是当前代数」才标干净（保存期间的新输入仍是脏）
			settle(token, ok) {
				if (ok === true && token === generation) dirty = false;
				return dirty === false;
			},
			clear() {
				dirty = false;
			},
		};
	};

	WS.registerGuard = (guard) => {
		if (!guard?.key) return null;
		guards.push(guard);
		return guard;
	};

	WS.clearGuards = (filter) => {
		const before = guards.length;
		guards = guards.filter(
			(g) => !(typeof filter === "function" ? filter(g) : true),
		);
		return before - guards.length;
	};

	WS.guards = () => guards.slice();
	WS.hasDirty = () =>
		guards.some((g) => typeof g.isDirty === "function" && g.isDirty());

	function notifyBlocked(guard) {
		const toast = app().toast;
		if (typeof toast !== "function") return;
		toast(
			`保存失败，已留在「${guard?.label || "当前编辑区"}」：未保存的修改仍在，可重试保存或明确放弃`,
		);
	}

	// 返回 true 表示守卫全部放行（该保存的已保存）；false 表示拦下，调用方不得提交导航
	WS.beforeNavigate = async (ctx) => {
		const dirty = guards.filter(
			(g) => typeof g.isDirty === "function" && g.isDirty(),
		);
		for (const guard of dirty) {
			let allowed;
			if (typeof guard.leave === "function") {
				allowed = await guard.leave(ctx || {}); // 自带弹窗的守卫（正文编辑器三选一）
			} else {
				let ok = false;
				try {
					ok = await guard.save();
				} catch (_e) {
					ok = false;
				}
				allowed = ok === true && !guard.isDirty();
				if (!allowed) notifyBlocked(guard);
			}
			if (!allowed) return false;
		}
		return true;
	};

	// ---------- 异步结果 token ----------
	WS.beginRequest = (scope, target) => {
		const key = String(scope == null ? "" : scope);
		const seq = (epochs[key] || 0) + 1;
		epochs[key] = seq;
		return {
			scope: key,
			target: target == null ? "" : String(target),
			id: seq,
		};
	};
	WS.isCurrent = (token, target) => {
		if (!token) return false;
		if (epochs[token.scope] !== token.id) return false;
		if (
			target !== undefined &&
			String(target == null ? "" : target) !== token.target
		)
			return false;
		return true;
	};

	WS.verify = async (snap) => {
		const api = app().api;
		if (typeof api !== "function") return { ok: true };
		if (snap.workspace === "workbench" || snap.workspace === "writing") {
			try {
				await api("GET", `/api/books/${encodeURIComponent(snap.bookId)}`);
			} catch (_e) {
				return { ok: false, reason: "BOOK_MISSING" };
			}
		}
		if (snap.workspace === "writing" && snap.chapterId) {
			let chapter = null;
			try {
				chapter = await api(
					"GET",
					`/api/books/${encodeURIComponent(snap.bookId)}/chapters/${encodeURIComponent(snap.chapterId)}`,
				);
			} catch (_e) {
				return { ok: false, reason: "CHAPTER_MISSING" };
			}
			if (!chapter?.chapter) return { ok: false, reason: "CHAPTER_MISSING" };
		}
		if (snap.workspace === "workbench" && snap.entityId) {
			const spec = ENTITY_CHECKS[snap.entityType];
			if (spec) {
				let data;
				try {
					data = await api("GET", spec.url(snap));
				} catch (_e) {
					return { ok: false, reason: "ENTITY_MISSING" };
				}
				const hit = (spec.pick(data) || []).some(
					(item) => String(item.id) === String(snap.entityId),
				);
				if (!hit) return { ok: false, reason: "ENTITY_MISSING" };
			}
		}
		return { ok: true };
	};

	function notifyMissing(reason) {
		const toast = app().toast;
		if (typeof toast !== "function") return;
		if (reason === "BOOK_MISSING")
			toast("要返回的作品已不存在；未自动切换到其他书籍");
		else if (reason === "CHAPTER_MISSING")
			toast("要返回的章节已被删除；未自动跳到其他章节，当前对象保持不变");
		else if (reason === "ENTITY_MISSING")
			toast("要返回的对象已被删除或不在本书中；未自动切换到其他对象");
		else toast("要返回的位置已失效；未自动切换对象");
	}

	// ---------- 导航提交 ----------
	function setHash(hash) {
		if (currentHash() === hash) return false;
		const w = win();
		if (w?.location) w.location.hash = hash;
		return true;
	}
	WS.setHash = setHash;

	WS.navigate = async (target) => {
		const from = WS.capture();
		const to = normalizeTarget(target, from);
		if (!to) return false;
		const allowed = await WS.beforeNavigate({
			from: WS.href(from),
			to: WS.href(to),
		});
		if (!allowed) return false; // 保存失败：hash 保持原样，导航没有发生
		if (to.workspace === "workbench") WS.rememberReturn(from, to.bookId);
		setHash(WS.href(to));
		return true;
	};

	// 回到来源：先按服务端校验目标，再导航，最后把章/会话装回写作页
	WS.restore = async (snapshot) => {
		const snap = normalizeTarget(snapshot, null);
		if (!snap) return false;
		const check = await WS.verify(snap);
		if (!check.ok) {
			notifyMissing(check.reason);
			return false;
		}
		const from = WS.capture();
		const allowed = await WS.beforeNavigate({
			from: WS.href(from),
			to: WS.href(snap),
		});
		if (!allowed) return false;
		WS.forgetReturn(snap.bookId); // 返回锚一次性消费
		setHash(WS.href(snap));
		return await WS.apply(snap);
	};

	WS.apply = async (snap) => {
		if (snap.workspace !== "writing") return true;
		if (snap.conversationId)
			writeStore(
				localStore(),
				`writing_conversation_${String(snap.bookId)}`,
				snap.conversationId,
			);
		else
			removeStore(localStore(), `writing_conversation_${String(snap.bookId)}`);
		// P6-2（§2.5-D3/D4）：编辑器/聊天三读点改模块面直取——旧 `win()?.BookPage` 间接读取随桥退役。
		// 不可达差异备案：旧 `if (!page) return true` 与三处 `typeof page.X === "function"` 真值守卫
		// 在模块面恒有名（NULL 占位面为函数）⇒ 缺名态不可构造，守卫语义由「未挂载 getWorkspaceState
		// 即 no-op」与渲染缝未注册 no-op 承接。
		const editor = chapterEditorApi();
		if (snap.chapterId) {
			// 等写作页真正接上目标书（route → BookShell 先重置当前章，再装载），否则会被 show 的重置吃掉
			await waitFor(() => {
				const doc = documentEl();
				const pageEl = doc ? doc.getElementById("page-book") : null;
				const visible =
					pageEl?.classList && !pageEl.classList.contains("hidden");
				const s = appState();
				return (
					visible &&
					s.currentBook &&
					String(s.currentBook.id) === String(snap.bookId)
				);
			}, 4000);
			await editor.selectChapter(snap.chapterId);
		}
		const doc = documentEl();
		const select = doc
			? doc.getElementById("writing-conversation-select")
			: null;
		const want = snap.conversationId || "";
		if (select && String(select.value || "") !== String(want)) {
			await chatApi().loadChat();
		}
		renderWritingStatusIfBound();
		return true;
	};

	return WS;
}

// ---------- 模块单例（P6-2 Plan §2.5-D2） ----------
// 等值 legacy workspace-state.js 的 IIFE 单例（guards/epochs/return 锚全部跨调用累积）：
// 去旧名桥后由本单例承接，消费方（AppRouter／ChapterEditorPanel／三面板／WorkbenchPage）直取。
// 工厂闭包内的全局读取（window.App/document/localStorage）一律在调用期取（:17 纪律不变）。
let wsSingleton = null;

export function getWorkspaceState() {
	if (!wsSingleton) wsSingleton = createWorkspaceState();
	return wsSingleton;
}

// **仅测试注入面**（生产零调用，等值 app-runtime.js 的 setAppForTests 先例；Plan §2.4 T-F
// 「单例注入缝」）。`setWorkspaceStateForTests(null)` 复位为「下次 getWorkspaceState() 懒建真单例」。
export function setWorkspaceStateForTests(instance) {
	wsSingleton = instance || null;
	return wsSingleton;
}
