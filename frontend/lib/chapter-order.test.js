import { describe, expect, it } from "vitest";
import { adjacentChapterId, orderedChapters } from "./chapter-order.js";

const model = {
	volumes: [
		{ id: 2, title: "第二卷" },
		{ id: 1, title: "第一卷" },
	],
	chapters: [
		{ id: 11, volume_id: 1, title: "一-1" },
		{ id: 21, volume_id: 2, title: "二-1" },
		{ id: 12, volume_id: 1, title: "一-2" },
		{ id: 90, volume_id: null, title: "散章" },
		{ id: 91, volume_id: 404, title: "孤章" },
	],
};

describe("orderedChapters", () => {
	it("按卷顺序逐卷排，卷内保持接口顺序，无卷/失卷的章排最后", () => {
		const list = orderedChapters(model);
		expect(list.map((c) => c.id)).toEqual([21, 11, 12, 90, 91]);
		expect(list[0].volumeTitle).toBe("第二卷");
		expect(list[3].volumeTitle).toBe("");
	});

	it("空模型返回空数组", () => {
		expect(orderedChapters(null)).toEqual([]);
		expect(orderedChapters({ volumes: [], chapters: [] })).toEqual([]);
	});
});

describe("adjacentChapterId", () => {
	it("跨卷取上一章/下一章", () => {
		expect(adjacentChapterId(model, 21, 1)).toBe(11);
		expect(adjacentChapterId(model, 11, -1)).toBe(21);
		expect(adjacentChapterId(model, 12, 1)).toBe(90);
	});

	it("到头或当前章未知时返回 null", () => {
		expect(adjacentChapterId(model, 21, -1)).toBeNull();
		expect(adjacentChapterId(model, 91, 1)).toBeNull();
		expect(adjacentChapterId(model, 999, 1)).toBeNull();
		expect(adjacentChapterId(model, null, 1)).toBeNull();
	});

	it("字符串 id 与数字 id 视为同一章", () => {
		expect(adjacentChapterId(model, "11", 1)).toBe(12);
	});
});
