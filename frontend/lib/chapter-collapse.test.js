// S5-2 红测（Plan §4 C2）：frontend/lib/chapter-collapse.js 是 public/legacy/chapter-collapse.js
// （126 行）store 语义的逐字 ES module 移植（判定 C 死锚点：旧文件物理保留，lib 侧供 React 内部
// 实现）。本文件镜像存量 test/chapter-collapse.test.js:10-114 九个用例——按书隔离／字符串数字
// 等价／原型键陷阱／无效 id／localStorage 五组——钉住两实现语义对等。
// 纯 Node 语义（vite.config.mjs test.environment=node），不依赖 DOM。
import { describe, expect, it } from "vitest";
import { createStore } from "./chapter-collapse.js";

function fakeStorage(initial) {
	const data = { ...(initial || {}) };
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = String(v);
		},
		removeItem: (k) => {
			delete data[k];
		},
	};
}

describe("chapter-collapse lib（T1 九用例对等移植）", () => {
	it("折叠状态可设置/读取/取消，并支持切换（toggle 返回切换后状态）", () => {
		const store = createStore();
		expect(store.isCollapsed(3, 2)).toBe(false);
		store.setCollapsed(3, 2, true);
		expect(store.isCollapsed(3, 2)).toBe(true);
		store.setCollapsed(3, 2, false);
		expect(store.isCollapsed(3, 2)).toBe(false);

		expect(store.toggle(3, 2)).toBe(true);
		expect(store.isCollapsed(3, 2)).toBe(true);
		expect(store.toggle(3, 2)).toBe(false);
		expect(store.isCollapsed(3, 2)).toBe(false);

		store.setCollapsed(3, 2, true);
		store.expand(3, 2);
		expect(store.isCollapsed(3, 2)).toBe(false);
	});

	it("折叠状态按书隔离：同一卷 id 在不同书互不影响", () => {
		const store = createStore();
		store.setCollapsed(3, 2, true);
		expect(store.isCollapsed(3, 2)).toBe(true);
		expect(store.isCollapsed(2, 2)).toBe(false);
		expect(store.collapsedIds(3)).toEqual(["2"]);
		expect(store.collapsedIds(2)).toEqual([]);
	});

	it("卷 id 字符串与数字等价，不因类型不同丢状态", () => {
		const store = createStore();
		store.setCollapsed(3, "2", true);
		expect(store.isCollapsed(3, 2)).toBe(true);
		store.setCollapsed(3, 2, false);
		expect(store.isCollapsed(3, "2")).toBe(false);
	});

	it("原型键不会造成幻影折叠（constructor/toString 等）", () => {
		const store = createStore();
		expect(store.isCollapsed(3, "constructor")).toBe(false);
		expect(store.isCollapsed(3, "toString")).toBe(false);
		store.setCollapsed(3, "constructor", true);
		expect(store.isCollapsed(3, "constructor")).toBe(true);
		expect(store.isCollapsed(3, "toString")).toBe(false);
	});

	it("无效 bookId/volumeId 不写不炸", () => {
		const store = createStore();
		expect(() => store.setCollapsed(null, 2, true)).not.toThrow();
		expect(() => store.setCollapsed(3, undefined, true)).not.toThrow();
		expect(store.isCollapsed(null, 2)).toBe(false);
		expect(store.isCollapsed(3, undefined)).toBe(false);
		expect(store.collapsedIds(null)).toEqual([]);
	});

	it("折叠状态持久化：同一 store 重新创建（模拟刷新）后仍记得", () => {
		const storage = fakeStorage();
		const first = createStore({ storage });
		first.setCollapsed(3, 2, true);
		first.setCollapsed(3, 4, true);
		expect(first.collapsedIds(3)).toEqual(["2", "4"]);
		expect(storage.data["novel-collapse:3"]).toBe('["2","4"]');

		const reloaded = createStore({ storage });
		expect(reloaded.isCollapsed(3, 2)).toBe(true);
		expect(reloaded.isCollapsed(3, 4)).toBe(true);
		expect(reloaded.isCollapsed(3, 3)).toBe(false);
		expect(reloaded.isCollapsed(2, 2)).toBe(false);
	});

	it("展开后清除持久化记录，不留脏数据", () => {
		const storage = fakeStorage();
		const store = createStore({ storage });
		store.setCollapsed(3, 2, true);
		expect(storage.data["novel-collapse:3"]).toBeTruthy();
		store.setCollapsed(3, 2, false);
		expect(storage.data["novel-collapse:3"]).toBe(undefined);
		const reloaded = createStore({ storage });
		expect(reloaded.collapsedIds(3)).toEqual([]);
	});

	it("持久化数据损坏 / 类型不符 / 存储不可用时退化为内存态，不抛错", () => {
		const broken = createStore({
			storage: fakeStorage({ "novel-collapse:3": "{不是数组" }),
		});
		expect(broken.collapsedIds(3)).toEqual([]);
		expect(() => broken.setCollapsed(3, 2, true)).not.toThrow();
		expect(broken.isCollapsed(3, 2)).toBe(true);

		const notArray = createStore({
			storage: fakeStorage({ "novel-collapse:3": '{"2":true}' }),
		});
		expect(notArray.collapsedIds(3)).toEqual([]);

		const throwing = createStore({
			storage: {
				getItem: () => {
					throw new Error("denied");
				},
				setItem: () => {
					throw new Error("denied");
				},
				removeItem: () => {
					throw new Error("denied");
				},
			},
		});
		expect(() => throwing.setCollapsed(3, 2, true)).not.toThrow();
		expect(throwing.isCollapsed(3, 2)).toBe(true);

		const noStorage = createStore({ storage: null });
		noStorage.setCollapsed(3, 2, true);
		expect(noStorage.isCollapsed(3, 2)).toBe(true);
	});

	it("持久化只按书取键，不串其他书的记录；options.prefix 可注入", () => {
		const storage = fakeStorage({ "novel-collapse:2": '["1"]' });
		const store = createStore({ storage });
		expect(store.isCollapsed(3, 1)).toBe(false);
		expect(store.isCollapsed(2, 1)).toBe(true);

		const custom = createStore({ storage, prefix: "x:" });
		custom.setCollapsed(3, 9, true);
		expect(storage.data["x:3"]).toBe('["9"]');
		expect(custom.isCollapsed(3, 9)).toBe(true);
	});
});
