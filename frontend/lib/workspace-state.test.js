// @vitest-environment jsdom
// S5-4 红测 R1~R5（Plan §4）：frontend/lib/workspace-state.js——
// public/legacy/workspace-state.js（392 行）21 API 逐字语义移植＋parseWorkbenchRoute/WORKBENCH_MODULES
// 内部化（Plan §2.4.1；原 :60-69 对 window.WorkbenchShell.parse 的依赖改为内部函数）。
// 断言语义锚点＝legacy 活代码行号：
//   :12-24 parse（module 白名单/entityId/tab）／:57-78 parseHash 五态／:98-132 capture 三分支／
//   :134-149 href／:151-162 normalizeTarget／:165-207 返回锚与 noteDeparture／:210-243 脏守卫／
//   :252-268 beforeNavigate（leave 优先/失败文案逐字）／:271-282 beginRequest-isCurrent 双绑／
//   :285-333 verify＋notifyMissing 文案／:336-391 setHash/navigate/restore/apply。
// harness：jsdom ＋ 裸 DOM；window.App 桩（api/toast/escapeHtml/state）；localStorage/sessionStorage 真件。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chapterEditorApi } from "../components/ChapterEditorPanel.jsx";
import { chatApi } from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "./app-runtime.js";
import {
	createWorkspaceState,
	parseWorkbenchRoute,
	WORKBENCH_MODULES,
} from "./workspace-state.js";
import { bindWritingStatusRenderer } from "./writing-status.js";

const WRITING_KEY = "writing_conversation_7";

let apiCalls;
let toasts;
let apiImpl;
let ws;

function installEnv() {
	document.body.innerHTML = "";
	apiCalls = [];
	toasts = [];
	apiImpl = null;
	window.App = {
		state: {},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml(s) {
			return String(s == null ? "" : s);
		},
		async api(method, path, body) {
			apiCalls.push([method, path, body]);
			if (apiImpl) return apiImpl(method, path, body);
			throw new Error(`no stub: ${method} ${path}`);
		},
	};
	// P6-2（⑨ 切换笔）：App 取用已改 lib 单例（§2.5-D2）——harness 桩经注入缝装进单例；
	// `window.BookPage` 不再被 lib 消费（零命中由 T1 静态见证承担），故不再置桩。
	setAppForTests(window.App);
	window.location.hash = "";
	localStorage.clear();
	sessionStorage.clear();
	ws = createWorkspaceState();
}

beforeEach(() => {
	installEnv();
});

describe("R1 捕获组：parseWorkbenchRoute/parseHash/capture/href/normalizeTarget（legacy :57-162）", () => {
	it("R1-1 parseWorkbenchRoute：四 module 白名单、entityId/tab、非工作台与畸形 hash 返回 null（:12-24）", () => {
		expect(WORKBENCH_MODULES).toEqual([
			"characters",
			"ledger",
			"outline",
			"world",
		]);
		expect(
			parseWorkbenchRoute("#/book/7/workbench/outline/5?tab=proposals"),
		).toEqual({
			bookId: "7",
			module: "outline",
			entityId: "5",
			tab: "proposals",
		});
		expect(parseWorkbenchRoute("#/book/7/workbench/world")).toEqual({
			bookId: "7",
			module: "world",
			entityId: null,
			tab: null,
		});
		expect(
			parseWorkbenchRoute("#/book/7/workbench/outline/%E4%B8%AD?tab=%E5%A4%87"),
		).toEqual({
			bookId: "7",
			module: "outline",
			entityId: "中",
			tab: "备",
		});
		// 非工作台/未知 module：null（:16 白名单判定）
		expect(parseWorkbenchRoute("#/book/7/workbench/nope")).toBeNull();
		expect(parseWorkbenchRoute("#/book/7/workbench")).toBeNull();
		expect(parseWorkbenchRoute("#/book/7")).toBeNull();
		// 畸形百分号：catch 后 null（已知对照差异·异常路径：旧件 decodeURIComponent 抛 URIError）
		expect(parseWorkbenchRoute("#/book/7/workbench/outline/%ZZ")).toBeNull();
	});

	it("R1-2 parseHash 五态分类（:57-78）", () => {
		expect(ws.parseHash("#/book/7/workbench/outline/5?tab=proposals")).toEqual({
			workspace: "workbench",
			bookId: "7",
			entityType: "outline",
			entityId: "5",
			tab: "proposals",
		});
		expect(ws.parseHash("#/book/7")).toEqual({
			workspace: "writing",
			bookId: "7",
			entityType: null,
			entityId: null,
			tab: null,
		});
		expect(ws.parseHash("#/book/7/read/12")).toEqual({
			workspace: "read",
			bookId: "7",
			entityType: null,
			entityId: null,
			tab: null,
		});
		expect(ws.parseHash("#/book/7/characters/5").workspace).toBe("read");
		expect(ws.parseHash("#/book/7/cards").workspace).toBe("read");
		expect(ws.parseHash("#/book/7/stylelab").workspace).toBe("read");
		expect(ws.parseHash("#/agent?x=1").workspace).toBe("agent");
		expect(ws.parseHash("#/profile").workspace).toBe("shelf");
		expect(ws.parseHash("").workspace).toBe("shelf");
	});

	it("R1-3 capture 写作/阅读分支：会话两来源、当前章、换书失效（:98-116）", () => {
		localStorage.setItem(WRITING_KEY, "conv-writing-1");
		window.App.state.currentChapterId = 12;
		window.location.hash = "#/book/7";
		expect(ws.capture()).toMatchObject({
			workspace: "writing",
			bookId: "7",
			conversationId: "conv-writing-1",
			chapterId: 12,
		});
		// 会话回退：localStorage 缺省时读 #writing-conversation-select，且要求 hash 前缀同书（:81-88）
		localStorage.removeItem(WRITING_KEY);
		const sel = document.createElement("select");
		sel.id = "writing-conversation-select";
		const opt = document.createElement("option");
		opt.value = "conv-from-select";
		sel.appendChild(opt);
		document.body.appendChild(sel);
		// 双条件命中（:85-87）：currentHash 以 #/book/<同书> 开头＋select 有值 → 取 select 值
		expect(ws.capture().conversationId).toBe("conv-from-select");
		window.location.hash = "#/book/9";
		expect(ws.capture().conversationId).toBe("conv-from-select");
		// 两来源皆空（无 localStorage 键、无 select）＝null（:88 尾 return null）
		sel.remove();
		expect(ws.capture().conversationId).toBeNull();
	});

	it("R1-4 capture 工作台分支：chapterOwnerBookId 跨台保留且换书失效、returnTo 来自返回锚（:117-126）", () => {
		localStorage.setItem(WRITING_KEY, "conv-writing-1");
		window.App.state.currentChapterId = 12;
		ws.capture("#/book/7");
		const inBook7 = ws.capture("#/book/7/workbench/outline");
		expect(inBook7.workspace).toBe("workbench");
		expect(inBook7.entityType).toBe("outline");
		expect(inBook7.chapterId).toBe(12); // 工作台里沿用写作页当前章（同书内有效）
		expect(inBook7.conversationId).toBe("conv-writing-1");
		expect(inBook7.returnTo).toBeNull(); // 无返回锚记录
		expect(ws.capture("#/book/9/workbench/ledger").chapterId).toBeNull(); // 换书即失效
		ws.rememberReturn({ workspace: "writing", bookId: "7", chapterId: 12 }, 7);
		expect(ws.capture("#/book/7/workbench/world").returnTo).toBe("#/book/7");
	});

	it("R1-5 capture Agent 分支两键＋href 全形态＋normalizeTarget（:127-162）", () => {
		localStorage.setItem("agent_scope_v1", "book:9");
		localStorage.setItem("agent_conversation_v1", "conv-agent-1");
		expect(ws.capture("#/agent")).toMatchObject({
			workspace: "agent",
			bookId: 9,
			conversationId: "conv-agent-1",
		});
		expect(ws.href({ workspace: "agent" })).toBe("#/agent");
		expect(ws.href({ workspace: "workbench", entityType: "outline" })).toBe(
			"#/",
		);
		expect(
			ws.href({
				workspace: "workbench",
				bookId: 7,
				entityType: "outline",
				entityId: 5,
				tab: "proposals",
			}),
		).toBe("#/book/7/workbench/outline/5?tab=proposals");
		expect(ws.href({ workspace: "workbench", bookId: 7 })).toBe(
			"#/book/7/workbench/characters",
		);
		expect(ws.href({ workspace: "read", bookId: 7, chapterId: 12 })).toBe(
			"#/book/7/read/12",
		);
		expect(ws.href({ workspace: "writing", bookId: 7 })).toBe("#/book/7");
		expect(ws.href({ workspace: "writing" })).toBe("#/");
		// normalizeTarget：shelf/缺书拒绝；非工作台清实体三字段；agent 允许无书（:151-162）
		expect(ws.normalizeTarget({ workspace: "shelf" }, null)).toBeNull();
		expect(ws.normalizeTarget({ workspace: "writing" }, null)).toBeNull();
		expect(
			ws.normalizeTarget(
				{ workspace: "agent", entityType: "x", entityId: 5, tab: "t" },
				null,
			),
		).toEqual({
			workspace: "agent",
			entityType: null,
			entityId: null,
			tab: null,
		}); // agent 不需书；非工作台清实体三字段（:157-160 逐字：缺键不补）
		const merged = ws.normalizeTarget(
			{ workspace: "workbench", entityType: "world" },
			{ workspace: "writing", bookId: 7, chapterId: 12 },
		);
		expect(merged).toEqual({
			workspace: "workbench",
			bookId: 7,
			chapterId: 12,
			entityType: "world",
		});
	});
});

describe("R2 返回锚组：rememberReturn/readReturn/forgetReturn/noteDeparture（legacy :164-207）", () => {
	it("R2-1 rememberReturn 不套娃＋readReturn 取回＋forgetReturn 双键清除（:165-198）", () => {
		const copy = ws.rememberReturn(
			{ workspace: "writing", bookId: 7, chapterId: 12, returnTo: "#/x" },
			7,
		);
		expect(copy.returnTo).toBeNull();
		expect(
			JSON.parse(sessionStorage.getItem("novel-workspace-return:7")).returnTo,
		).toBeNull();
		expect(ws.readReturn(7)).toMatchObject({
			workspace: "writing",
			bookId: 7,
			chapterId: 12,
		});
		ws.forgetReturn(7);
		expect(sessionStorage.getItem("novel-workspace-return:7")).toBeNull();
		expect(ws.rememberReturn(null, 7)).toBeNull();
		expect(ws.readReturn("")).toBeNull();
	});

	it("R2-2 readReturn 旧键兼容：novel-editor-return:* 解析为导航对象（:181-190）", () => {
		sessionStorage.setItem("novel-editor-return:7", "#/book/7");
		expect(ws.readReturn(7)).toEqual({
			workspace: "writing",
			bookId: "7",
			conversationId: null,
			chapterId: null,
			entityType: null,
			entityId: null,
			tab: null,
			returnTo: null,
		});
		// 主键记录 workspace='shelf' 视为无效，继续走旧键（:178-180）
		sessionStorage.setItem(
			"novel-workspace-return:7",
			JSON.stringify({ workspace: "shelf" }),
		);
		expect(ws.readReturn(7).workspace).toBe("writing");
	});

	it("R2-3 noteDeparture：工作台之间穿梭保留最初来源、非工作台目标不记录（:201-207）", () => {
		expect(ws.noteDeparture("#/book/7", "#/book/7/read/12")).toBeNull();
		const rec = ws.noteDeparture("#/book/7", "#/book/7/workbench/outline");
		expect(rec.workspace).toBe("writing");
		expect(sessionStorage.getItem("novel-workspace-return:7")).toBeTruthy();
		// 工作台 → 工作台：已有记录则不再覆盖（保留最初来源）
		expect(
			ws.noteDeparture(
				"#/book/7/workbench/outline",
				"#/book/7/workbench/ledger",
			),
		).toBeNull();
		expect(ws.readReturn(7).workspace).toBe("writing");
	});
});

describe("R3 守卫组：dirtyTracker/registerGuard/clearGuards/hasDirty/beforeNavigate（legacy :210-268）", () => {
	it("R3-1 dirtyTracker：settle 仅当代数未前进且 ok===true 才清脏（:210-224）", () => {
		const t = ws.dirtyTracker();
		expect(t.isDirty()).toBe(false);
		const token = t.mark();
		expect(t.isDirty()).toBe(true);
		expect(t.snapshot()).toBe(token);
		expect(t.settle(token, false)).toBe(false);
		expect(t.isDirty()).toBe(true);
		t.mark(); // 保存期间又有新输入：token 过期
		expect(t.settle(token, true)).toBe(false);
		expect(t.isDirty()).toBe(true);
		const fresh = t.snapshot();
		expect(t.settle(fresh, true)).toBe(true);
		expect(t.isDirty()).toBe(false);
		t.mark();
		t.clear();
		expect(t.isDirty()).toBe(false);
	});

	it("R3-2 registerGuard/guards/clearGuards/hasDirty（:226-243）", () => {
		expect(ws.registerGuard(null)).toBeNull();
		expect(ws.registerGuard({})).toBeNull();
		const g1 = ws.registerGuard({
			key: "world",
			label: "世界观工作台",
			isDirty: () => true,
		});
		const g2 = ws.registerGuard({ key: "ledger", isDirty: () => false });
		expect(ws.guards()).toEqual([g1, g2]);
		expect(ws.hasDirty()).toBe(true);
		expect(ws.clearGuards((g) => g.key === "world")).toBe(1);
		expect(ws.guards()).toEqual([g2]);
		expect(ws.hasDirty()).toBe(false);
		expect(ws.clearGuards()).toBe(1);
		expect(ws.guards()).toEqual([]);
	});

	it("R3-3 beforeNavigate：leave 优先／save 后仍脏不放行／失败 notifyBlocked 文案逐字（:252-268）", async () => {
		const calls = [];
		ws.registerGuard({
			key: "writing-editor",
			label: "正文编辑器",
			isDirty: () => true,
			leave: async () => {
				calls.push("leave");
				return false;
			},
			save: async () => {
				calls.push("save");
				return true;
			},
		});
		expect(await ws.beforeNavigate({})).toBe(false);
		expect(calls).toEqual(["leave"]); // leave 优先，不调 save
		ws.clearGuards();
		let dirty = true;
		ws.registerGuard({
			key: "outline",
			label: "大纲工作台",
			isDirty: () => dirty,
			save: async () => {
				calls.push("save");
				return true;
			},
		});
		calls.length = 0;
		expect(await ws.beforeNavigate({})).toBe(false); // save 成功但期间又有新输入：仍脏不放行
		expect(calls).toEqual(["save"]);
		expect(toasts).toEqual([
			"保存失败，已留在「大纲工作台」：未保存的修改仍在，可重试保存或明确放弃",
		]);
		// save 抛错＝不放行（:261 catch 归 false）
		ws.clearGuards();
		ws.registerGuard({
			key: "boom",
			isDirty: () => true,
			save: async () => {
				throw new Error("504");
			},
		});
		expect(await ws.beforeNavigate({})).toBe(false);
		expect(toasts.at(-1)).toBe(
			"保存失败，已留在「当前编辑区」：未保存的修改仍在，可重试保存或明确放弃",
		);
		ws.clearGuards();
		dirty = false;
		expect(await ws.beforeNavigate({})).toBe(true);
	});
});

describe("R4 令牌与校验组：beginRequest/isCurrent/verify/notifyMissing（legacy :271-333）", () => {
	it("R4-1 beginRequest/isCurrent：scope 与 target 双绑，过期或换目标即丢弃（:271-282）", () => {
		const t1 = ws.beginRequest("world", "7|31");
		expect(t1).toEqual({ scope: "world", target: "7|31", id: 1 });
		expect(ws.isCurrent(t1, "7|31")).toBe(true);
		expect(ws.isCurrent(t1, "7|32")).toBe(false);
		expect(ws.isCurrent(null, "7|31")).toBe(false);
		const t2 = ws.beginRequest("world", "7|31");
		expect(ws.isCurrent(t1, "7|31")).toBe(false); // 同 scope 新令牌作废旧令牌
		expect(ws.isCurrent(t2, "7|31")).toBe(true);
		expect(ws.isCurrent(t2)).toBe(true); // target 未给出时不比对
	});

	it("R4-2 verify 四路径：ok／BOOK_MISSING／CHAPTER_MISSING／ENTITY_MISSING（:285-324）", async () => {
		expect(await ws.verify({ workspace: "shelf" })).toEqual({ ok: true }); // 非书域直接放行
		apiImpl = async () => ({ book: { id: 7 } });
		expect(await ws.verify({ workspace: "workbench", bookId: 7 })).toEqual({
			ok: true,
		});
		expect(apiCalls.at(-1).slice(0, 2)).toEqual(["GET", "/api/books/7"]);
		apiImpl = async () => {
			throw new Error("404");
		};
		expect(await ws.verify({ workspace: "workbench", bookId: 7 })).toEqual({
			ok: false,
			reason: "BOOK_MISSING",
		});
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			throw new Error("404");
		};
		expect(
			await ws.verify({ workspace: "writing", bookId: 7, chapterId: 12 }),
		).toEqual({ ok: false, reason: "CHAPTER_MISSING" });
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			if (path === "/api/books/7/chapters/12") return { chapter: { id: 12 } };
			return { entries: [{ id: 31 }] };
		};
		expect(
			await ws.verify({ workspace: "writing", bookId: 7, chapterId: 12 }),
		).toEqual({ ok: true });
		// 工作台实体校验：三类型 url/pick 逐字（characters/world/outline，:285-298）
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			if (path === "/api/books/7/characters?limit=200")
				return { items: [{ id: 5 }] };
			return {};
		};
		expect(
			await ws.verify({
				workspace: "workbench",
				bookId: 7,
				entityType: "characters",
				entityId: "5",
			}),
		).toEqual({ ok: true });
		expect(apiCalls.at(-1).slice(0, 2)).toEqual([
			"GET",
			"/api/books/7/characters?limit=200",
		]);
		expect(
			await ws.verify({
				workspace: "workbench",
				bookId: 7,
				entityType: "characters",
				entityId: "999",
			}),
		).toEqual({ ok: false, reason: "ENTITY_MISSING" });
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			if (path === "/api/books/7/world") return { entries: [{ id: 31 }] };
			if (path === "/api/books/7/volumes") return { volumes: [{ id: 1 }] };
			return {};
		};
		expect(
			await ws.verify({
				workspace: "workbench",
				bookId: 7,
				entityType: "world",
				entityId: "31",
			}),
		).toEqual({ ok: true });
		expect(
			await ws.verify({
				workspace: "workbench",
				bookId: 7,
				entityType: "outline",
				entityId: "1",
			}),
		).toEqual({ ok: true });
		expect(
			await ws.verify({
				workspace: "workbench",
				bookId: 7,
				entityType: "outline",
				entityId: "2",
			}),
		).toEqual({ ok: false, reason: "ENTITY_MISSING" });
	});

	it("R4-3 restore 校验失败：三活文案逐字，目标对象保持不变（不自动切换）（:326-333/:355-360）", async () => {
		apiImpl = async () => {
			throw new Error("404");
		};
		expect(await ws.restore({ workspace: "writing", bookId: 7 })).toBe(false);
		expect(toasts.at(-1)).toBe("要返回的作品已不存在；未自动切换到其他书籍");
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			throw new Error("404");
		};
		expect(
			await ws.restore({ workspace: "writing", bookId: 7, chapterId: 12 }),
		).toBe(false);
		expect(toasts.at(-1)).toBe(
			"要返回的章节已被删除；未自动跳到其他章节，当前对象保持不变",
		);
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			return { entries: [] };
		};
		expect(
			await ws.restore({
				workspace: "workbench",
				bookId: 7,
				entityType: "world",
				entityId: "31",
			}),
		).toBe(false);
		expect(toasts.at(-1)).toBe(
			"要返回的对象已被删除或不在本书中；未自动切换到其他对象",
		);
	});
});

describe("R5 提交组：setHash/navigate/restore/apply（legacy :336-391）", () => {
	it("R5-1 setHash 同值不写；不同值才改 hash（:336-341）", () => {
		window.location.hash = "#/book/7";
		expect(ws.setHash("#/book/7")).toBe(false);
		expect(ws.setHash("#/book/7/workbench/outline")).toBe(true);
		expect(window.location.hash).toBe("#/book/7/workbench/outline");
	});

	it("R5-2 navigate：守卫失败 hash 与返回锚一动不动；通过才 rememberReturn＋setHash（:343-352）", async () => {
		window.location.hash = "#/book/7";
		ws.registerGuard({
			key: "outline",
			label: "大纲工作台",
			isDirty: () => true,
			save: async () => false,
		});
		expect(
			await ws.navigate({ workspace: "workbench", entityType: "outline" }),
		).toBe(false);
		expect(window.location.hash).toBe("#/book/7");
		expect(sessionStorage.getItem("novel-workspace-return:7")).toBeNull();
		ws.clearGuards();
		expect(
			await ws.navigate({ workspace: "workbench", entityType: "outline" }),
		).toBe(true);
		expect(window.location.hash).toBe("#/book/7/workbench/outline");
		expect(
			JSON.parse(sessionStorage.getItem("novel-workspace-return:7")).workspace,
		).toBe("writing");
		expect(await ws.navigate({ workspace: "shelf" })).toBe(false); // 非法目标直接拒绝
	});

	it("R5-3 restore 序：verify→beforeNavigate→forgetReturn→setHash→apply（:355-366）", async () => {
		window.location.hash = "#/book/9/workbench/world";
		localStorage.setItem(WRITING_KEY, "conv-writing-1");
		sessionStorage.setItem(
			"novel-workspace-return:7",
			JSON.stringify({
				workspace: "writing",
				bookId: 7,
				chapterId: 12,
				conversationId: "conv-writing-1",
			}),
		);
		apiImpl = async (_method, path) => {
			if (path === "/api/books/7") return { book: { id: 7 } };
			if (path === "/api/books/7/chapters/12") return { chapter: { id: 12 } };
			return {};
		};
		window.App.state.currentBook = { id: 7 };
		const pageEl = document.createElement("div");
		pageEl.id = "page-book";
		document.body.appendChild(pageEl);
		const sel = document.createElement("select");
		sel.id = "writing-conversation-select";
		document.body.appendChild(sel);
		const seq = [];
		let apiCountAtGuard = null;
		// P6-2（⑨）转写：编辑器/聊天/状态条三读点改模块面（spy＋渲染缝注册）
		vi.spyOn(chapterEditorApi(), "selectChapter").mockImplementation(
			async (id) => {
				seq.push(`selectChapter:${id}`);
			},
		);
		vi.spyOn(chatApi(), "loadChat").mockImplementation(async () => {
			seq.push("loadChat");
		});
		const unbindRenderer = bindWritingStatusRenderer(() => {
			seq.push("renderWritingStatus");
		});
		let guardDirty = true;
		ws.registerGuard({
			key: "outline",
			label: "大纲工作台",
			isDirty: () => guardDirty,
			save: async () => {
				apiCountAtGuard = apiCalls.length; // verify 已发生（book＋chapter 两次 GET）
				guardDirty = false; // 保存成功且期间无新输入才放行（:262 ok===true && !isDirty()）
				return true;
			},
		});
		const token = ws.beginRequest("outline", "9|");
		expect(ws.isCurrent(token, "9|")).toBe(true);
		expect(await ws.restore(ws.readReturn(7))).toBe(true); // 返回锚记录即 restore 载荷
		expect(apiCountAtGuard).toBe(2); // 守卫在 verify 之后
		expect(ws.readReturn(7)).toBeNull(); // 返回锚一次性消费
		expect(window.location.hash).toBe("#/book/7");
		expect(localStorage.getItem(WRITING_KEY)).toBe("conv-writing-1");
		expect(seq).toEqual([
			"selectChapter:12",
			"loadChat",
			"renderWritingStatus",
		]);
		unbindRenderer();
		vi.restoreAllMocks();
		pageEl.remove();
		sel.remove();
	});

	it("R5-4 apply（P6-2 ⑨ 转写：模块面直取）：非写作页直通；无章不调 selectChapter；会话值相等不调 loadChat；状态条刷新经渲染缝（:368-391）", async () => {
		expect(await ws.apply({ workspace: "workbench" })).toBe(true);
		localStorage.setItem(WRITING_KEY, "conv-old");
		expect(
			await ws.apply({ workspace: "writing", bookId: 7, conversationId: null }),
		).toBe(true);
		expect(localStorage.getItem(WRITING_KEY)).toBeNull(); // conversationId 为空即删键（:371）
		const seq = [];
		// P6-2（⑨）转写：编辑器/聊天/状态条三读点改模块面——不可达差异备案：旧「无 BookPage 直通」
		// （`if (!page) return true`）与三处缺名守卫在模块面恒有名（NULL 占位面为函数）⇒ 无缺名态。
		vi.spyOn(chapterEditorApi(), "selectChapter").mockImplementation(
			async (id) => {
				seq.push(`selectChapter:${id}`);
			},
		);
		vi.spyOn(chatApi(), "loadChat").mockImplementation(async () => {
			seq.push("loadChat");
		});
		const unbindRenderer = bindWritingStatusRenderer(() => {
			seq.push("renderWritingStatus");
		});
		const sel = document.createElement("select");
		sel.id = "writing-conversation-select";
		document.body.appendChild(sel);
		expect(await ws.apply({ workspace: "writing", bookId: 7 })).toBe(true);
		expect(seq).toEqual(["renderWritingStatus"]); // 无章、会话值相等（空 select）：只剩状态条刷新
		const opt = document.createElement("option");
		opt.value = "conv-other";
		sel.appendChild(opt);
		sel.value = "conv-other";
		expect(
			await ws.apply({
				workspace: "writing",
				bookId: 7,
				conversationId: "conv-x",
			}),
		).toBe(true);
		expect(seq).toEqual([
			"renderWritingStatus",
			"loadChat",
			"renderWritingStatus",
		]);
		sel.remove();
		unbindRenderer();
		vi.restoreAllMocks();
	});
});
