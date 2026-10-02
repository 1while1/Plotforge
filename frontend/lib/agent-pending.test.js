// S5-9 红测 T1（Plan §4 T1）：frontend/lib/agent-pending.js —— pending 确认卡持久化与重建计划、
// session id 持久化。语义唯一事实源＝public/legacy/agent.js :26-35／:1274-1340（逐例头注 legacy
// 行号锚点）；storage 全注入（含缺失/抛错容错）；harness＝vitest node 环境；零新增依赖。
import { describe, expect, it } from "vitest";
import {
	forgetPending,
	loadOrCreateSessionId,
	loadPending,
	newSessionId,
	PENDING_KEY,
	PENDING_MAX,
	pendingConversationId,
	planPendingRebuild,
	rememberPending,
	SESSION_KEY,
	savePendingList,
} from "./agent-pending.js";

function memStorage(initial) {
	const map = new Map(Object.entries(initial || {}));
	return {
		map,
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => {
			map.set(k, String(v));
		},
		removeItem: (k) => map.delete(k),
	};
}

function pendingEntry(over) {
	return {
		id: "a-1",
		conf: { id: "a-1", summary: "改标题" },
		toolName: "update_chapter",
		input: { chapterId: 1 },
		expiresAt: null,
		conversationId: "c-1",
		...over,
	};
}

describe("T1 agent-pending（pending 持久化 / session id）", () => {
	// :26-35 —— 无键→生成并写回；有键→原样读；storage 抛错→内存生成不抛
	it("T1-1 loadOrCreateSessionId：生成/读回/抛错容错三态（newSessionId 形状 agent:<36 进制>:<36 进制>）", () => {
		const generated = newSessionId({ random: () => 0.5, now: () => 1296 });
		expect(/^agent:[0-9a-z]+:[0-9a-z]+$/.test(generated)).toBe(true);
		expect(generated).toBe("agent:i:100");
		const empty = memStorage();
		const first = loadOrCreateSessionId(empty, {
			random: () => 0.5,
			now: () => 1296,
		});
		expect(first).toBe("agent:i:100");
		expect(empty.map.get(SESSION_KEY)).toBe(first);
		const again = loadOrCreateSessionId(empty, {
			random: () => 0.25,
			now: () => 999,
		});
		expect(again).toBe(first);
		const broken = {
			getItem() {
				throw new Error("storage 不可用");
			},
			setItem() {
				throw new Error("storage 不可用");
			},
		};
		expect(() => loadOrCreateSessionId(broken)).not.toThrow();
		expect(
			/^agent:[0-9a-z]+:[0-9a-z]+$/.test(loadOrCreateSessionId(broken)),
		).toBe(true);
	});

	// :1312-1330 —— expiresAt ≤ now → expired（Date.parse 非法值行为逐字）；无 expiresAt → kept
	it("T1-2 planPendingRebuild 过期划分：过期入 expired、无 expiresAt 入 kept、非法日期不判过期", () => {
		const now = Date.UTC(2026, 8, 28, 0, 0, 0);
		const list = [
			pendingEntry({
				id: "p-1",
				input: { n: 1 },
				expiresAt: new Date(now - 1).toISOString(),
			}),
			pendingEntry({
				id: "p-2",
				input: { n: 2 },
				expiresAt: new Date(now).toISOString(),
			}),
			pendingEntry({ id: "p-3", input: { n: 3 }, expiresAt: null }),
			pendingEntry({ id: "p-4", input: { n: 4 }, expiresAt: "不是日期" }),
			pendingEntry({
				id: "p-5",
				input: { n: 5 },
				expiresAt: new Date(now + 60000).toISOString(),
			}),
		];
		const { kept, expired } = planPendingRebuild(list, now);
		expect(expired.map((e) => e.id)).toEqual(["p-1", "p-2"]);
		expect(kept.map((e) => e.id)).toEqual(["p-3", "p-4", "p-5"]);
	});

	// :1323-1330 —— 键＝(toolName||'')+'|'+JSON.stringify(input||{})；后者替换前者且保留在列表尾部
	it("T1-3 同参去重：后者替换前者并保留在尾部；!entry.id || !entry.conf 丢弃", () => {
		const now = Date.now();
		const list = [
			pendingEntry({ id: "old", toolName: "t", input: { a: 1 } }),
			pendingEntry({ id: "other", toolName: "t", input: { a: 2 } }),
			{ id: null, conf: {}, toolName: "t", input: {} },
			{ id: "x", conf: null, toolName: "t", input: {} },
			pendingEntry({
				id: "new",
				toolName: "t",
				input: { a: 1 },
				expiresAt: new Date(now + 60000).toISOString(),
			}),
		];
		const { kept } = planPendingRebuild(list, now);
		expect(kept.map((e) => e.id)).toEqual(["other", "new"]);
	});

	// :1316-1330 —— 返回 {kept, expired} 两数组，顺序＝原列表序
	it("T1-4 planPendingRebuild：两数组顺序＝原列表序；缺 toolName/input 时键＝'|{}'", () => {
		const now = Date.now();
		const list = [
			pendingEntry({ id: "a", toolName: undefined, input: undefined }),
			pendingEntry({ id: "b", toolName: undefined, input: undefined }),
			pendingEntry({
				id: "e-1",
				expiresAt: new Date(now - 1).toISOString(),
			}),
			pendingEntry({
				id: "e-2",
				expiresAt: new Date(now - 2).toISOString(),
			}),
		];
		const { kept, expired } = planPendingRebuild(list, now);
		expect(kept.map((e) => e.id)).toEqual(["b"]);
		expect(expired.map((e) => e.id)).toEqual(["e-1", "e-2"]);
	});

	// :1286 —— slice(-20)；JSON.stringify 抛错（循环引用）静默
	it("T1-5 savePendingList：截断 slice(-20)；循环引用静默不抛、不写坏值", () => {
		const storage = memStorage();
		const list = [];
		for (let i = 0; i < 25; i++) list.push(pendingEntry({ id: `p-${i}` }));
		savePendingList(storage, list);
		const saved = JSON.parse(storage.map.get(PENDING_KEY));
		expect(saved.map((e) => e.id)).toEqual(list.slice(-20).map((e) => e.id));
		expect(PENDING_MAX).toBe(20);
		const cyc = pendingEntry({ id: "cyc" });
		cyc.input = cyc;
		expect(() => savePendingList(storage, [cyc])).not.toThrow();
		expect(JSON.parse(storage.map.get(PENDING_KEY)).map((e) => e.id)).toEqual(
			list.slice(-20).map((e) => e.id),
		);
	});

	// :1279-1284 —— 非数组/损坏 JSON → []
	it("T1-6 loadPending：损坏 JSON、非数组、无键一律 []", () => {
		expect(loadPending(memStorage())).toEqual([]);
		expect(loadPending(memStorage({ [PENDING_KEY]: "{不是 JSON" }))).toEqual(
			[],
		);
		expect(loadPending(memStorage({ [PENDING_KEY]: '{"a":1}' }))).toEqual([]);
		expect(loadPending(memStorage({ [PENDING_KEY]: "[1,2]" }))).toEqual([1, 2]);
	});

	// :1290-1296 —— 命中返回 entry.conversationId || null（空值回落 null，不回落到当前会话）；未命中返回参数
	it("T1-7 pendingConversationId：命中取记录（空值回落 null）；未命中回落当前会话；皆无→null", () => {
		const storage = memStorage({
			[PENDING_KEY]: JSON.stringify([
				pendingEntry({ id: "hit", conversationId: "c-x" }),
				pendingEntry({ id: "nil", conversationId: "" }),
			]),
		});
		expect(pendingConversationId(storage, "hit", "c-cur")).toBe("c-x");
		expect(pendingConversationId(storage, "nil", "c-cur")).toBe(null);
		expect(pendingConversationId(storage, "miss", "c-cur")).toBe("c-cur");
		expect(pendingConversationId(storage, "miss", null)).toBe(null);
	});

	// :1297-1302
	it("T1-8 rememberPending 同 id 去重后 append；forgetPending 删除", () => {
		const storage = memStorage();
		rememberPending(storage, pendingEntry({ id: "a" }));
		rememberPending(storage, pendingEntry({ id: "b" }));
		rememberPending(storage, pendingEntry({ id: "a", toolName: "again" }));
		const list = loadPending(storage);
		expect(list.map((e) => e.id)).toEqual(["b", "a"]);
		expect(list[1].toolName).toBe("again");
		forgetPending(storage, "b");
		expect(loadPending(storage).map((e) => e.id)).toEqual(["a"]);
		forgetPending(storage, "不存在");
		expect(loadPending(storage).map((e) => e.id)).toEqual(["a"]);
	});

	// :1278／:26 —— 键名逐字
	it("T1-9 键名逐字：agent_pending_v1 与 agent_session_v1", () => {
		expect(PENDING_KEY).toBe("agent_pending_v1");
		expect(SESSION_KEY).toBe("agent_session_v1");
	});

	// 全函数 storage 缺失（undefined）容错：不抛
	it("T1-10 storage 缺失（undefined）时全函数不抛", () => {
		expect(() => loadPending(undefined)).not.toThrow();
		expect(loadPending(undefined)).toEqual([]);
		expect(() => savePendingList(undefined, [])).not.toThrow();
		expect(() => rememberPending(undefined, pendingEntry({}))).not.toThrow();
		expect(() => forgetPending(undefined, "a")).not.toThrow();
		expect(pendingConversationId(undefined, "a", null)).toBe(null);
		expect(() => planPendingRebuild(null, Date.now())).not.toThrow();
		expect(planPendingRebuild(null, Date.now())).toEqual({
			kept: [],
			expired: [],
		});
		expect(() => loadOrCreateSessionId(undefined)).not.toThrow();
	});
});
