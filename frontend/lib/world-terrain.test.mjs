import { describe, expect, it } from "vitest";
import {
	atmosphereFor,
	coastRadius,
	createNoise2D,
	daypartOf,
	depthAt,
	formatWords,
	heightAt,
	landmarkKind,
	layoutArchipelagos,
	planArchipelago,
	poolRadius,
	seededRandom,
	settlementTier,
} from "./world-terrain.js";

const sample = {
	id: 3,
	chapters: 27,
	words: 85000,
	characters: 4,
	worldEntries: 11,
	regions: [
		{ title: "第一卷", chapters: 13, words: 40000 },
		{ title: "远航中的旅人", chapters: 9, words: 30000 },
		{ title: "海港故事", chapters: 5, words: 15000 },
	],
	cast: [
		{ name: "林野", tier: "lead" },
		{ name: "沈砚", tier: "major" },
		{ name: "路人", tier: "minor" },
		{ name: "导员", tier: "minor" },
	],
	landmarks: ["天京城", "雾港", "回溯机制", "灰雁号", "青崖山", "旧书店"],
};

describe("world-terrain 书籍数据 → 浮空群岛", () => {
	it("同一本书每次长得一样（按 id 定种子），换书则不同", () => {
		expect(planArchipelago(sample)).toEqual(planArchipelago({ ...sample }));
		expect(
			planArchipelago({ ...sample, id: 4 }).islands[0].mountain,
		).not.toEqual(planArchipelago(sample).islands[0].mountain);
		const a = seededRandom(3);
		const b = seededRandom(3);
		for (let i = 0; i < 5; i++) expect(a()).toBe(b());
		const n = createNoise2D(9);
		expect(n(0.3, 0.7)).toBe(createNoise2D(9)(0.3, 0.7));
		expect(Math.abs(n(0.3, 0.7))).toBeLessThanOrEqual(1);
	});

	it("每卷一座岛：主岛居中，其余卷绕排且互不重叠，各有吊桥连主岛", () => {
		const plan = planArchipelago(sample);
		expect(plan.islands.map((i) => i.title)).toEqual([
			"第一卷",
			"远航中的旅人",
			"海港故事",
		]);
		expect(plan.islands[0]).toMatchObject({ x: 0, z: 0, y: 0 });
		for (let i = 1; i < plan.islands.length; i++) {
			const isl = plan.islands[i];
			expect(Math.hypot(isl.x, isl.z)).toBeGreaterThan(
				plan.islands[0].radius + isl.radius,
			);
		}
		expect(plan.bridges).toEqual([
			{ from: 0, to: 1 },
			{ from: 0, to: 2 },
		]);
		expect(plan.extent).toBeGreaterThan(plan.islands[0].radius);
	});

	it("章节越多岛越大、聚落越高级；城镇以上有城墙塔楼，城池有主堡", () => {
		expect([0, 1, 3, 4, 9, 10, 19, 20].map(settlementTier)).toEqual([
			"camp",
			"hamlet",
			"hamlet",
			"village",
			"village",
			"town",
			"town",
			"city",
		]);
		const small = planArchipelago({ id: 1, regions: [{ chapters: 2 }] })
			.islands[0];
		const big = planArchipelago({ id: 1, regions: [{ chapters: 24 }] })
			.islands[0];
		expect(big.radius).toBeGreaterThan(small.radius);
		expect(big.tier).toBe("city");
		const kinds = big.buildings.map((b) => b.kind);
		expect(kinds).toContain("keep");
		expect(kinds).toContain("turret");
		expect(kinds.filter((k) => k === "house").length).toBeGreaterThan(
			small.buildings.filter((b) => b.kind === "house").length,
		);
		const camp = planArchipelago({ id: 2 }).islands[0];
		expect(camp.tier).toBe("camp");
		expect(camp.buildings.map((b) => b.kind)).toEqual(["tent", "fire"]);
		expect(camp.waterfalls).toEqual([]);
	});

	it("建筑与树都落在海岸线以内", () => {
		for (const isl of planArchipelago(sample).islands) {
			for (const p of [...isl.buildings, ...isl.trees, ...isl.rocks]) {
				const R = coastRadius(isl, Math.atan2(p.z, p.x));
				expect(Math.hypot(p.x, p.z)).toBeLessThan(R * 0.95);
			}
		}
	});

	it("人物变成走动小人：主角放主岛，最多 12 个", () => {
		const plan = planArchipelago(sample);
		expect(plan.walkers.map((w) => [w.name, w.tier])).toEqual([
			["林野", "lead"],
			["沈砚", "major"],
			["路人", "minor"],
			["导员", "minor"],
		]);
		expect(plan.walkers[0].island).toBe(0);
		const many = planArchipelago({
			id: 5,
			cast: Array.from({ length: 20 }, (_, i) => ({
				name: `人${i}`,
				tier: "minor",
			})),
		});
		expect(many.walkers.length).toBe(12);
	});

	it("设定变成挂名地标，造型按名字取，分布到各岛", () => {
		expect(
			["天京城", "青崖山", "雾港", "回溯机制", "灰雁号", "旧书店"].map(
				landmarkKind,
			),
		).toEqual(["spire", "pillar", "lighthouse", "obelisk", "ship", "shrine"]);
		const plan = planArchipelago(sample);
		expect(plan.landmarks.map((l) => l.name)).toEqual(sample.landmarks);
		expect(new Set(plan.landmarks.map((l) => l.island)).size).toBe(3);
		expect(plan.crystals.length).toBe(2);
	});

	it("地形高度有穹顶与主峰、岛根中心深边缘浅", () => {
		const isl = planArchipelago(sample).islands[0];
		const m = isl.mountain;
		expect(heightAt(isl, m.x, m.z)).toBeGreaterThan(m.h * 0.6);
		const edge = coastRadius(isl, 0) * 0.99;
		expect(heightAt(isl, edge, 0)).toBeLessThan(heightAt(isl, m.x, m.z));
		expect(depthAt(isl, 0, 0)).toBeGreaterThan(depthAt(isl, edge, 0));
	});

	it("没有卷数据时按总章节退回一座岛", () => {
		const plan = planArchipelago({ id: 8, chapters: 5, words: 3000 });
		expect(plan.islands.length).toBe(1);
		expect(plan.islands[0].tier).toBe("village");
		expect(plan.barren).toBe(false);
		expect(planArchipelago({ id: 9 }).barren).toBe(true);
	});

	it("群岛摆位不重叠，砚池能装下全部", () => {
		const extents = [5, 3, 3.5, 2.5, 2.5, 4];
		const pos = layoutArchipelagos(extents);
		expect(pos[0]).toMatchObject({ x: 0, z: 0 });
		for (let i = 0; i < pos.length; i++)
			for (let j = 0; j < i; j++)
				expect(
					Math.hypot(pos[i].x - pos[j].x, pos[i].z - pos[j].z),
				).toBeGreaterThanOrEqual(extents[i] + extents[j]);
		const R = poolRadius(pos, extents);
		pos.forEach((p, i) => {
			expect(Math.hypot(p.x, p.z) + extents[i]).toBeLessThan(R);
		});
	});

	it("天色跟时刻，天气跟最近动笔距今", () => {
		expect([3, 6, 12, 18, 22].map(daypartOf)).toEqual([
			"night",
			"dawn",
			"day",
			"dusk",
			"night",
		]);
		const now = new Date(2026, 9, 10, 18, 30);
		expect(
			atmosphereFor(now, [{ updatedAt: "2026-10-09 10:00:00" }]),
		).toMatchObject({
			daypart: "dusk",
			weather: "clear",
			label: "黄昏 · 晴",
		});
		expect(
			atmosphereFor(now, [{ updatedAt: "2026-09-20 10:00:00" }]).weather,
		).toBe("cloudy");
		expect(
			atmosphereFor(now, [{ updatedAt: "2026-01-01 10:00:00" }]).weather,
		).toBe("mist");
		expect(atmosphereFor(now, []).weather).toBe("mist");
	});

	it("字数格式化", () => {
		expect(formatWords(0)).toBe("0字");
		expect(formatWords(9999)).toBe("9999字");
		expect(formatWords(85000)).toBe("8.5万字");
		expect(formatWords(1230000)).toBe("123万字");
	});
});
