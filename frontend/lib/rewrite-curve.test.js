// S4-8 红测（Plan §4 表 1，L1~L14）：rewrite-curve 纯逻辑移植对等——镜像冻结测试
// test/rewrite-curve.test.js 的 14 个用例语义（该文件 require
// '../public/legacy/rewrite-curve' 直读，范式 A·判定 B 死锚点零 diff 保留），防移植走样。
// 本文件是**新增对等测试**，不是改写存量：语义权威在 Node 侧冻结测试，这里只验 React 侧
// 逐字移植（UMD → ES export）后同一组函数行为不变。
// L1 changed 判定／L2 summarize 双口径／L3 assemble／L4 addPoint 合并／L5 addPoint 粒度／
// L6 addPoint 无分数留痕／L7 plotPoints 夹紧丢弃／L8 seriesPath／L9 describeProgress 三态／
// L10 bandOf 五档阈值／L11 草稿存留／L12 clear／L13 坏数据退化／L14 无效 id 不炸。
import { describe, expect, it } from "vitest";
import {
	addPoint,
	assemble,
	bandOf,
	CONF_BANDS,
	createDraftStore,
	createItem,
	describeProgress,
	normalizeItems,
	plotPoints,
	seriesPath,
	summarize,
} from "./rewrite-curve.js";

// 草稿存储假件（test/rewrite-curve.test.js:95-103 同款）：storage 注入面保留——
// createDraftStore 的 options.storage 注入是移植的一部分（jsdom/node 两环境自洽）。
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

describe("rewrite-curve 引擎（逐字移植，镜像 Node 侧 14 用例）", () => {
	it("L1 changed 判定：只去空白不算人改，字数或内容变了才算", () => {
		expect(createItem("他走进屋子。", "他走进屋子。").changed).toBe(false);
		expect(createItem("他走进屋子。", "他走进屋子。 ").changed).toBe(
			false,
			"尾部空格不算改动",
		);
		expect(createItem("他走进屋子。", "他推门进屋。").changed).toBe(true);
		expect(createItem("他走进屋子。", "他进屋，目光扫过角落。").changed).toBe(
			true,
		);
	});

	it("L2 汇总按字数为准，同时给出段数口径", () => {
		const items = normalizeItems([
			"一二三四五",
			"六七八九十",
			"甲乙丙丁戊己庚辛",
		]);
		items[0].rewritten = "一二三四五六七八九十一二";
		items[0].changed = true;
		items[0].newChars = 14;
		const s = summarize(items);
		expect(s.totalCount).toBe(3);
		expect(s.changedCount).toBe(1);
		expect(s.changedChars).toBe(14);
		expect(s.ratioByChars).toBe(Math.round((14 / (14 + 5 + 8)) * 1000) / 1000);
		expect(s.ratioByCount).toBe(Math.round((1 / 3) * 1000) / 1000);
	});

	it("L3 拼回全文：已改用改写稿、未改用原文、空段丢弃", () => {
		const items = normalizeItems(["甲", "乙", ""]);
		items[1].rewritten = "乙改";
		items[1].changed = true;
		expect(assemble(items)).toBe("甲\n\n乙改");
	});

	it("L4 测量点：连续重复（同比例同分数）只记次数，不刷屏", () => {
		let series = [];
		series = addPoint(series, {
			ratio: 0.25,
			conf: 0.9999,
			chars: 3000,
			at: "t1",
		});
		series = addPoint(series, {
			ratio: 0.25,
			conf: 0.9999,
			chars: 3000,
			at: "t2",
		});
		expect(series.length).toBe(1);
		expect(series[0].n).toBe(2);
		expect(series[0].at).toBe("t2");
		series = addPoint(series, {
			ratio: 0.33,
			conf: 0.9999,
			chars: 3000,
			at: "t3",
		});
		expect(series.length).toBe(2);
	});

	it("L5 测量点：比例按 1% 粒度归并，分数保留 4 位", () => {
		const s = addPoint([], { ratio: 0.2549, conf: 0.611111, chars: 10 });
		expect(s[0].ratio).toBe(0.25);
		expect(s[0].conf).toBe(0.6111);
	});

	it("L6 测量点：无分数的点也允许记录（上游失败时留痕）", () => {
		const s = addPoint([], { ratio: 0, conf: null });
		expect(s[0].conf).toBeNull();
		expect(s[0].n).toBe(1);
	});

	it("L7 曲线坐标：落在 padding 之内，越界被夹住，无分数的点被丢弃", () => {
		const pts = plotPoints(
			[
				{ ratio: 0, conf: 0 },
				{ ratio: 1, conf: 1 },
				{ ratio: 1.4, conf: -0.2 },
				{ ratio: 0.5, conf: null },
			],
			{ width: 320, height: 160 },
		);
		expect(pts.length).toBe(3);
		expect(
			pts.every((p) => p.x >= 34 && p.x <= 310 && p.y >= 10 && p.y <= 138),
		).toBe(true);
		expect(pts[1].y < pts[0].y).toBe(true);
		expect(typeof pts[0].label).toBe("string");
		expect(pts[0].label).toContain("很像人写的");
	});

	it("L8 seriesPath 生成合法 SVG path", () => {
		const pts = plotPoints([
			{ ratio: 0, conf: 0.1 },
			{ ratio: 0.5, conf: 0.4 },
		]);
		const d = seriesPath(pts);
		expect(d.startsWith("M")).toBe(true);
		expect((d.match(/L/g) || []).length).toBe(pts.length - 1);
		expect(seriesPath([])).toBe("");
	});

	it("L9 进度文案：未改 / 已改两种口径都读得出来", () => {
		expect(describeProgress(summarize([]))).toBe("还没有载入段落");
		const empty = normalizeItems(["甲", "乙"]);
		expect(describeProgress(summarize(empty))).toContain("尚未改写");
		empty[0].rewritten = "甲改";
		empty[0].changed = true;
		const txt = describeProgress(summarize(empty));
		expect(txt).toContain("已改 1/2 段");
		expect(txt).toContain("占");
	});

	it("L10 分档与 style-health 的展示分档同序（0.2/0.5/0.7/0.9）", () => {
		expect(bandOf(0.1).label).toBe("很像人写的");
		expect(bandOf(0.3).label).toBe("偏人工");
		expect(bandOf(0.6).label).toBe("疑似 AI");
		expect(bandOf(0.8).label).toBe("AI 味较重");
		expect(bandOf(0.99).label).toBe("AI 味很重");
		expect(bandOf(null).label).toBe("—");
		// CONF_BANDS 阈值逐字（图表参考线与分档同源）
		expect(CONF_BANDS.map((b) => b.max)).toEqual([0.2, 0.5, 0.7, 0.9, 1.01]);
	});

	it("L11 草稿存留：按书+章取键，刷新（重建 store）后改写与曲线都在", () => {
		const storage = fakeStorage();
		const store = createDraftStore({ storage });
		const items = normalizeItems(["甲", "乙"]);
		items[0].rewritten = "甲改成一段人写的字";
		items[0].changed = true;
		const series = addPoint([], {
			ratio: 0.5,
			conf: 0.62,
			chars: 12,
			at: "t1",
		});
		expect(store.save(7, 3, { items, series })).toBe(true);
		expect(Object.keys(storage.data)).toEqual(["novel-rewrite:7:3"]);

		const reloaded = createDraftStore({ storage });
		const d = reloaded.load(7, 3);
		expect(d.items.length).toBe(2);
		expect(d.items[0].changed).toBe(true);
		expect(d.items[0].rewritten).toBe("甲改成一段人写的字");
		expect(d.items[1].changed).toBe(false);
		expect(d.series.length).toBe(1);
		expect(d.series[0].conf).toBe(0.62);
		expect(reloaded.load(7, 4)).toBeNull();
		expect(reloaded.load(8, 3)).toBeNull();
	});

	it("L12 草稿可清除；清掉后读回 null", () => {
		const storage = fakeStorage();
		const store = createDraftStore({ storage });
		store.save(1, 1, { items: normalizeItems(["甲"]), series: [] });
		expect(store.load(1, 1)).toBeTruthy();
		store.clear(1, 1);
		expect(store.load(1, 1)).toBeNull();
	});

	it("L13 坏数据/无存储/存储抛错一律退化为「没有草稿」，不炸", () => {
		const broken = createDraftStore({
			storage: fakeStorage({ "novel-rewrite:1:1": "{不是 JSON" }),
		});
		expect(broken.load(1, 1)).toBeNull();
		const wrongShape = createDraftStore({
			storage: fakeStorage({ "novel-rewrite:1:1": '{"items":"x"}' }),
		});
		expect(wrongShape.load(1, 1)).toBeNull();
		const none = createDraftStore({ storage: null });
		expect(none.load(1, 1)).toBeNull();
		expect(none.save(1, 1, { items: [], series: [] })).toBe(false);
		const throwing = createDraftStore({
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
		expect(throwing.load(1, 1)).toBeNull();
		expect(() => throwing.save(1, 1, { items: [], series: [] })).not.toThrow();
		expect(() => throwing.clear(1, 1)).not.toThrow();
	});

	it("L14 无效 id 不写不炸", () => {
		const store = createDraftStore({ storage: fakeStorage() });
		expect(store.load(null, 1)).toBeNull();
		expect(store.save(1, undefined, { items: [], series: [] })).toBe(false);
		expect(() => store.clear(null, null)).not.toThrow();
	});
});
