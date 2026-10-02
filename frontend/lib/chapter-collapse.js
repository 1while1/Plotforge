// S5-2（Plan §2.4 第 9 条）：public/legacy/chapter-collapse.js（126 行）store 语义的逐字
// ES module 移植——范式 A·判定 C：旧文件物理保留为死锚点（test/chapter-collapse.test.js:8
// require 直读＋ editor-vm.js:46 等四处 vm 装载真源码，不可移动/改名/删除），React 侧内部
// 实现走本 lib（不设 window.ChapterCollapse 桩：全仓零活消费方，旧文件 :10 的唯一消费点
// book-chapters.js:124-125 随本片死锚点化；vm 测试自载旧真文件）。
// 语义逐字对应 legacy：
// - PREFIX='novel-collapse:'（:14）、detectStorage try/catch（:16-23）、newMap=Object.create(null)
//   （:27，防 "constructor" 键读到原型值造成幻影折叠）；
// - hydrate 惰性＋坏 JSON/非数组忽略（:43-58）、persist 排序写＋空则 removeItem（:60-72）、
//   valid 守卫（:74-76）、isCollapsed/setCollapsed/toggle（返回切换后状态 :94-98）/expand/
//   collapsedIds（稳定排序 :105-114）、options.storage|prefix 注入（:31-32）。
const PREFIX = "novel-collapse:";

function detectStorage() {
	try {
		// 隐私模式/禁用存储时访问 localStorage 会抛错——退回纯内存态
		return (typeof window !== "undefined" && window.localStorage) || null;
	} catch (_e) {
		return null;
	}
}

// 无原型表：卷 id 来自用户数据，用 {} 时 "constructor" 之类的键会读到原型上的值，
// 表现为「某卷凭空是折叠的」。
function newMap() {
	return Object.create(null);
}

export function createStore(options) {
	options = options || {};
	const storage =
		options.storage !== undefined ? options.storage : detectStorage();
	const prefix = options.prefix || PREFIX;
	const byBook = newMap();
	const hydrated = newMap();

	function bucket(bookId) {
		const key = String(bookId);
		if (!byBook[key]) byBook[key] = newMap();
		return byBook[key];
	}

	// 首次访问某本书时从其持久化记录恢复；坏数据/不可用一律忽略，退化为内存态
	function hydrate(bookId) {
		const key = String(bookId);
		const map = bucket(bookId);
		if (hydrated[key]) return;
		hydrated[key] = true;
		if (!storage) return;
		try {
			const raw = storage.getItem(prefix + key);
			if (!raw) return;
			const ids = JSON.parse(raw);
			if (!Array.isArray(ids)) return;
			for (let i = 0; i < ids.length; i++) {
				if (ids[i] !== null && ids[i] !== undefined) map[String(ids[i])] = true;
			}
		} catch (_e) {
			/* 坏 JSON 或存储不可用：忽略 */
		}
	}

	function persist(bookId) {
		if (!storage) return;
		try {
			const ids = [];
			const map = bucket(bookId);
			for (const k in map) {
				if (map[k] === true) ids.push(k);
			}
			ids.sort();
			if (ids.length) {
				storage.setItem(prefix + String(bookId), JSON.stringify(ids));
			} else {
				storage.removeItem(prefix + String(bookId));
			}
		} catch (_e) {
			/* 配额/不可用：内存态仍然正确 */
		}
	}

	function valid(bookId, volumeId) {
		return (
			bookId !== null &&
			bookId !== undefined &&
			volumeId !== null &&
			volumeId !== undefined
		);
	}

	function isCollapsed(bookId, volumeId) {
		if (!valid(bookId, volumeId)) return false;
		hydrate(bookId);
		return bucket(bookId)[String(volumeId)] === true;
	}

	function setCollapsed(bookId, volumeId, collapsed) {
		if (!valid(bookId, volumeId)) return;
		hydrate(bookId);
		const map = bucket(bookId);
		if (collapsed) map[String(volumeId)] = true;
		else delete map[String(volumeId)];
		persist(bookId);
	}

	// 返回切换后的折叠态，调用方据此更新 DOM
	function toggle(bookId, volumeId) {
		const next = !isCollapsed(bookId, volumeId);
		setCollapsed(bookId, volumeId, next);
		return next;
	}

	function expand(bookId, volumeId) {
		setCollapsed(bookId, volumeId, false);
	}

	// 已折叠的卷 id 列表（稳定顺序，便于测试与调试）
	function collapsedIds(bookId) {
		if (bookId === null || bookId === undefined) return [];
		hydrate(bookId);
		const ids = [];
		const map = bucket(bookId);
		for (const k in map) {
			if (map[k] === true) ids.push(k);
		}
		return ids.sort();
	}

	return {
		isCollapsed,
		setCollapsed,
		toggle,
		expand,
		collapsedIds,
	};
}

export default { createStore };
