// S3-2 红测（Plan §4 T13~T14）：character-relations 布局引擎移植——镜像冻结测试
// test/character-relations-layout.test.js 的语义（18 卫星确定性/中心节点/19 唯一坐标/
// 多维关系共享卫星）+ 默认尺寸/自定义尺寸/clamp 有界性。uniquePeople 去重按 id 升序。
import { describe, expect, it } from "vitest";
import { computeRadialLayout, uniquePeople } from "./character-relations.js";

function relation(focus, other) {
	return { endpoint_a: focus, endpoint_b: other };
}

describe("character-relations 引擎（逐字移植）", () => {
	it("T13 移植对等：18 卫星两次调用（含乱序输入）deepEqual；中心节点；19 个唯一坐标；共享卫星；uniquePeople 去重升序", () => {
		const focus = { id: 1, name: "中心人物" };
		const relations = Array.from({ length: 18 }, (_, index) =>
			relation(focus, { id: index + 2, name: `人物${index + 2}` }),
		).reverse();
		const first = computeRadialLayout(focus, relations, 760, 460);
		const second = computeRadialLayout(
			focus,
			[...relations].reverse(),
			760,
			460,
		);
		expect(first).toEqual(second);
		expect(first.nodes[0]).toEqual({
			id: 1,
			name: "中心人物",
			x: 380,
			y: 230,
			focus: true,
		});
		expect(
			new Set(
				first.nodes.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`),
			).size,
		).toBe(19);
		// 多维关系共享卫星节点
		const focusB = { id: 1, name: "甲" };
		const otherB = { id: 2, name: "乙" };
		const layout = computeRadialLayout(focusB, [
			relation(focusB, otherB),
			relation(focusB, otherB),
		]);
		expect(layout.nodes.length).toBe(2);
		// uniquePeople：去重（Map.set 后写覆盖前写——逐字语义）+ 按 id 升序（乱序输入）
		const people = uniquePeople(focusB, [
			relation(focusB, { id: 5, name: "戊" }),
			relation(focusB, { id: 3, name: "丙" }),
			relation(focusB, { id: 3, name: "丙重复" }),
			relation({ id: 3, name: "反向" }, focusB),
		]);
		expect(people).toEqual([
			{ id: 3, name: "反向" },
			{ id: 5, name: "戊" },
		]);
	});

	it("T14 默认尺寸 760/460；自定义宽高生效；大 roster 坐标有界（clamp）", () => {
		const focus = { id: 1, name: "中心" };
		const rels = Array.from({ length: 20 }, (_, index) =>
			relation(focus, { id: index + 2, name: `人${index + 2}` }),
		);
		const def = computeRadialLayout(focus, rels);
		expect(def.width).toBe(760);
		expect(def.height).toBe(460);
		expect(def.nodes[0]).toMatchObject({ x: 380, y: 230, focus: true });
		const custom = computeRadialLayout(focus, [], 1000, 600);
		expect(custom.width).toBe(1000);
		expect(custom.height).toBe(600);
		expect(custom.nodes[0]).toMatchObject({ x: 500, y: 300, focus: true });
		// clamp：radiusX≤230+ring*62、radiusY≤145+ring*48（ring 最多 2 层：20 人）
		for (const node of def.nodes.slice(1)) {
			const ring = Math.floor((def.nodes.indexOf(node) - 1) / 8);
			expect(Math.abs(node.x - 380)).toBeLessThanOrEqual(
				230 + ring * 62 + 1e-9,
			);
			expect(Math.abs(node.y - 230)).toBeLessThanOrEqual(
				145 + ring * 48 + 1e-9,
			);
		}
	});
});
