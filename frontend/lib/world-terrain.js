// 开始界面「掌中世界」：把一本书的真实数据翻译成一片浮空群岛的规划（纯函数，三维场景只负责照着画）。
// 映射语义（界面图例与砚灵提示词同口径）：每卷一座浮空岛；章节越多岛越大、聚落越高级
// （营地→小村→村落→城镇→城池）；人物是岛上走动的小人（主角最醒目）；设定条目是挂名地标；
// 每五条设定凝成一枚悬浮晶石；字数越多山越高。同一本书每次打开长得一样（按书 id 定种子）。

const MAX_ISLANDS = 6;
const MAX_WALKERS = 12;
const MAX_LANDMARKS = 8;
const MAX_CRYSTALS = 6;

export function seededRandom(seed) {
	let s =
		(Math.abs(Math.floor(Number(seed) || 0)) * 2654435761 + 1013904223) >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function count(v) {
	const n = Math.floor(Number(v) || 0);
	return n > 0 ? n : 0;
}

export function formatWords(words) {
	const n = count(words);
	if (n >= 10000) {
		const w = n / 10000;
		return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}万字`;
	}
	return `${n}字`;
}

// 二维梯度噪声（simplex），按种子打乱置换表；岛屿海岸线、起伏、岛根都由它决定
const GRAD = [
	[1, 1],
	[-1, 1],
	[1, -1],
	[-1, -1],
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
export function createNoise2D(seed) {
	const rand = seededRandom(seed);
	const p = new Uint8Array(256);
	for (let i = 0; i < 256; i++) p[i] = i;
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	const perm = new Uint8Array(512);
	for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
	return (x, y) => {
		const s = (x + y) * F2;
		const i = Math.floor(x + s);
		const j = Math.floor(y + s);
		const t = (i + j) * G2;
		const x0 = x - (i - t);
		const y0 = y - (j - t);
		const i1 = x0 > y0 ? 1 : 0;
		const j1 = x0 > y0 ? 0 : 1;
		const x1 = x0 - i1 + G2;
		const y1 = y0 - j1 + G2;
		const x2 = x0 - 1 + 2 * G2;
		const y2 = y0 - 1 + 2 * G2;
		const ii = i & 255;
		const jj = j & 255;
		let n = 0;
		const corner = (gx, gy, cx, cy) => {
			const tt = 0.5 - cx * cx - cy * cy;
			if (tt < 0) return 0;
			const g = GRAD[perm[gx + perm[gy]] & 7];
			return tt ** 4 * (g[0] * cx + g[1] * cy);
		};
		n += corner(ii, jj, x0, y0);
		n += corner(ii + i1, jj + j1, x1, y1);
		n += corner(ii + 1, jj + 1, x2, y2);
		return 70 * n;
	};
}

const noiseCache = new Map();
function noiseFor(seed) {
	let n = noiseCache.get(seed);
	if (!n) {
		n = createNoise2D(seed);
		if (noiseCache.size > 64) noiseCache.clear();
		noiseCache.set(seed, n);
	}
	return n;
}

export const TIERS = ["camp", "hamlet", "village", "town", "city"];
export const TIER_NAMES = {
	camp: "营地",
	hamlet: "小村",
	village: "村落",
	town: "城镇",
	city: "城池",
};

export function settlementTier(chapters) {
	const n = count(chapters);
	if (n >= 20) return "city";
	if (n >= 10) return "town";
	if (n >= 4) return "village";
	if (n >= 1) return "hamlet";
	return "camp";
}

// 地标造型只看条目名里的字：城宫殿→尖塔，山峰岭→石柱，海港湖河→灯塔，
// 门阵法机制系统→符文碑，舰船号→悬空飞舟，其余→小祠
export function landmarkKind(name) {
	const s = String(name || "");
	if (/[舰船艇]|号$/.test(s)) return "ship";
	if (/[城宫殿都京塔楼阁]/.test(s)) return "spire";
	if (/[山峰岭崖谷]/.test(s)) return "pillar";
	if (/[海港湖河江湾岛]/.test(s)) return "lighthouse";
	if (/[门阵法术机制系统规则律]/.test(s)) return "obelisk";
	return "shrine";
}

// 海岸线半径：岛屿不是正圆，按角度起伏
export function coastRadius(island, angle) {
	const n = noiseFor(island.seed);
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return (
		island.radius *
		(1 + 0.13 * n(c * 1.1 + 7, s * 1.1 + 7) + 0.06 * n(c * 2.6 - 3, s * 2.6))
	);
}

// 岛顶高度（相对岛基准面，单位与场景一致）：缓穹顶＋起伏＋主峰，聚落处整平成台地
export function heightAt(island, x, z) {
	const n = noiseFor(island.seed);
	const r = Math.hypot(x, z);
	const R = coastRadius(island, Math.atan2(z, x));
	const t = Math.min(1, r / R);
	const dome = 0.2 * (1 - t * t);
	const rolling =
		(0.07 * n(x * 0.9 + 11, z * 0.9 - 5) + 0.035 * n(x * 2.3, z * 2.3 + 9)) *
		(1 - t);
	const m = island.mountain;
	const dm = Math.hypot(x - m.x, z - m.z);
	const ridge = 1 + 0.25 * n(x * 1.7 - 21, z * 1.7 + 4);
	const mountain = m.h * Math.exp(-((dm / m.s) ** 2) * ridge);
	let h = dome + rolling + mountain;
	const pl = island.plateau;
	const dp = Math.hypot(x - pl.x, z - pl.z);
	if (dp < pl.r * 1.5) {
		const k = dp < pl.r ? 1 : 1 - (dp - pl.r) / (pl.r * 0.5);
		h = h * (1 - k * k * (3 - 2 * k)) + pl.h * (k * k * (3 - 2 * k));
	}
	// 岸边收成一道浅崖口，岛顶不会薄到穿帮
	const lip = t > 0.88 ? (t - 0.88) / 0.12 : 0;
	return h * (1 - lip * 0.55) + 0.04;
}

// 岛根深度（向下为正）：中心最深，按噪声长出几根垂岩
export function depthAt(island, x, z) {
	const n = noiseFor(island.seed + 101);
	const r = Math.hypot(x, z);
	const R = coastRadius(island, Math.atan2(z, x));
	const t = Math.min(1, r / R);
	const lobes = 0.75 + 0.45 * n(x * 1.4, z * 1.4) + 0.2 * n(x * 3.1, z * 3.1);
	return island.depth * (1 - t) ** 0.75 * Math.max(0.25, lobes) + 0.04;
}

function islandRadius(chapters, words, satellite) {
	const base = 1.2 + Math.min(count(chapters) / 26, 1) * 1.05;
	const bonus = Math.min(count(words) / 400000, 1) * 0.25;
	return (base + bonus) * (satellite ? 0.82 : 1);
}

function placeAround(rand, island, minT, maxT, gap, used, avoid) {
	for (let tries = 0; tries < 40; tries++) {
		const a = rand() * Math.PI * 2;
		const t = minT + rand() * (maxT - minT);
		const r = coastRadius(island, a) * t;
		const x = Math.cos(a) * r;
		const z = Math.sin(a) * r;
		if (avoid?.(x, z)) continue;
		if (used.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 >= gap * gap)) {
			const p = { x, z };
			used.push(p);
			return p;
		}
	}
	return null;
}

// 聚落：按等级在台地上排房屋；城镇以上有城墙与塔楼，城池中央是主堡
function planSettlement(island, rand, used) {
	const pl = island.plateau;
	const out = [];
	const tier = island.tier;
	const at = (x, z) => ({ x: pl.x + x, z: pl.z + z });
	if (tier === "camp") {
		out.push({ kind: "tent", ...at(0.05, 0), size: 0.16, turn: rand() * 6 });
		out.push({ kind: "fire", ...at(-0.22, 0.1), size: 0.06, turn: 0 });
		used.push(at(0, 0));
		return out;
	}
	const houses = { hamlet: 3, village: 6, town: 10, city: 14 }[tier];
	const core =
		tier === "city"
			? "keep"
			: tier === "town"
				? "tower"
				: tier === "village"
					? "well"
					: null;
	if (core) {
		out.push({
			kind: core,
			...at(0, 0),
			size: core === "keep" ? 0.3 : core === "tower" ? 0.13 : 0.06,
			turn: rand() * Math.PI,
		});
	}
	used.push(at(0, 0));
	const ringStart = core === "keep" ? 0.42 : core ? 0.26 : 0.16;
	let placed = 0;
	for (let ring = 0; placed < houses && ring < 4; ring++) {
		const rr = ringStart + ring * 0.2;
		const slots = Math.max(3, Math.floor((Math.PI * 2 * rr) / 0.23));
		const off = rand() * Math.PI * 2;
		for (let k = 0; k < slots && placed < houses; k++) {
			const a = off + (k / slots) * Math.PI * 2 + (rand() - 0.5) * 0.2;
			const p = at(Math.cos(a) * rr, Math.sin(a) * rr);
			const R = coastRadius(island, Math.atan2(p.z, p.x));
			if (Math.hypot(p.x, p.z) > R * 0.8) continue;
			if (
				Math.hypot(p.x - island.mountain.x, p.z - island.mountain.z) <
				island.mountain.s * 0.75
			)
				continue;
			out.push({
				kind: "house",
				...p,
				size: 0.1 + rand() * 0.035 + (tier === "city" ? 0.015 : 0),
				turn: a + Math.PI / 2,
				tall: tier === "city" || tier === "town" ? rand() < 0.4 : false,
				chimney: rand() < 0.55,
				roof: Math.floor(rand() * 4),
			});
			used.push(p);
			placed++;
		}
	}
	if (tier === "town" || tier === "city") {
		const wallR = ringStart + Math.ceil(placed / 6) * 0.2 + 0.12;
		const posts = tier === "city" ? 6 : 4;
		const off = rand() * Math.PI;
		for (let k = 0; k < posts; k++) {
			const a = off + (k / posts) * Math.PI * 2;
			const p = at(Math.cos(a) * wallR, Math.sin(a) * wallR);
			const R = coastRadius(island, Math.atan2(p.z, p.x));
			if (Math.hypot(p.x, p.z) > R * 0.86) continue;
			out.push({ kind: "turret", ...p, size: 0.07, turn: a });
		}
		out.wallRadius = wallR;
	}
	return out;
}

function planIsland(region, index, seed, satellite) {
	const rand = seededRandom(seed);
	const chapters = count(region.chapters);
	const words = count(region.words);
	const radius = islandRadius(chapters, words, satellite);
	const ma = rand() * Math.PI * 2;
	const md = radius * (0.32 + rand() * 0.18);
	const island = {
		index,
		title: String(region.title || ""),
		chapters,
		words,
		seed,
		radius,
		depth: 1.1 + radius * 0.75,
		tier: settlementTier(chapters),
		mountain: {
			x: Math.cos(ma) * md,
			z: Math.sin(ma) * md,
			h: 0.35 + Math.min(words / 160000, 1) * 1.05 + (satellite ? 0 : 0.15),
			s: radius * 0.42,
		},
		plateau: {
			x: -Math.cos(ma) * radius * 0.18,
			z: -Math.sin(ma) * radius * 0.18,
			r: radius * (0.32 + Math.min(chapters / 30, 1) * 0.12),
			h: 0.2,
		},
	};
	const used = [];
	const built = planSettlement(island, rand, used);
	island.buildings = built.slice();
	island.wallRadius = built.wallRadius || 0;

	const nearPlateau = (x, z) =>
		Math.hypot(x - island.plateau.x, z - island.plateau.z) <
		island.plateau.r * 1.05;
	const trees = [];
	const treeCount = Math.round(radius * radius * 6 + 4);
	for (let i = 0; i < treeCount; i++) {
		const p = placeAround(rand, island, 0.12, 0.86, 0.13, used, nearPlateau);
		if (!p) continue;
		trees.push({
			...p,
			height: 0.16 + rand() * 0.16,
			pine: rand() < 0.55,
			tint: rand(),
		});
	}
	island.trees = trees;
	const rocks = [];
	for (let i = 0; i < Math.round(radius * 3); i++) {
		const p = placeAround(rand, island, 0.3, 0.9, 0.1, used, nearPlateau);
		if (p) rocks.push({ ...p, size: 0.05 + rand() * 0.06, turn: rand() * 6 });
	}
	island.rocks = rocks;
	const falls = [];
	const fallCount = chapters === 0 ? 0 : chapters >= 8 ? 2 : 1;
	for (let i = 0; i < fallCount; i++) {
		falls.push({
			angle: ma + Math.PI * (0.55 + i * 0.7) + (rand() - 0.5) * 0.4,
			width: 0.12 + Math.min(chapters / 30, 1) * 0.14,
		});
	}
	island.waterfalls = falls;
	island.used = used;
	return island;
}

// 一本书 → 一片群岛规划。regions 缺省时（老接口/空书）按总章节退回一座岛。
export function planArchipelago(world) {
	const w = world || {};
	const id = Number(w.id) || 0;
	let regions = Array.isArray(w.regions) ? w.regions.slice(0, MAX_ISLANDS) : [];
	if (!regions.length) {
		regions = [
			{ title: "", chapters: count(w.chapters), words: count(w.words) },
		];
	}
	const rand = seededRandom(id * 31 + 5);
	const islands = regions.map((r, i) =>
		planIsland(r, i, id * 97 + i * 13 + 1, i > 0),
	);

	// 主岛居中，各卷小岛绕主岛错落排开，高低不一，用吊桥相连
	const main = islands[0];
	main.x = 0;
	main.z = 0;
	main.y = 0;
	const start = rand() * Math.PI * 2;
	for (let i = 1; i < islands.length; i++) {
		const isl = islands[i];
		const a = start + ((i - 1) / Math.max(1, islands.length - 1)) * Math.PI * 2;
		const d = main.radius + isl.radius + 0.75 + rand() * 0.4;
		isl.x = Math.cos(a) * d;
		isl.z = Math.sin(a) * d;
		isl.y = (rand() - 0.35) * 0.9;
	}
	const bridges = islands.slice(1).map((isl) => ({ from: 0, to: isl.index }));

	const cast = Array.isArray(w.cast) ? w.cast.slice(0, MAX_WALKERS) : [];
	const walkers = cast.map((c, i) => ({
		name: String(c.name || ""),
		tier: c.tier === "lead" || c.tier === "major" ? c.tier : "minor",
		island: c.tier === "lead" ? 0 : i % islands.length,
		seed: id * 7 + i * 3 + 2,
	}));

	const names = Array.isArray(w.landmarks)
		? w.landmarks.slice(0, MAX_LANDMARKS)
		: [];
	const landmarks = [];
	names.forEach((name, i) => {
		const isl = islands[i % islands.length];
		const lr = seededRandom(isl.seed + 500 + i);
		const p = placeAround(
			lr,
			isl,
			0.5,
			0.78,
			0.3,
			isl.used,
			(x, z) =>
				Math.hypot(x - isl.plateau.x, z - isl.plateau.z) <
				Math.max(isl.plateau.r, isl.wallRadius) + 0.12,
		);
		if (p)
			landmarks.push({
				name: String(name),
				kind: landmarkKind(name),
				island: isl.index,
				...p,
			});
	});

	const crystalCount = Math.min(
		MAX_CRYSTALS,
		Math.floor(count(w.worldEntries) / 5),
	);
	const crystals = [];
	for (let i = 0; i < crystalCount; i++) {
		crystals.push({
			angle: start + (i / crystalCount) * Math.PI * 2,
			radius: main.radius + 0.35 + rand() * 0.35,
			height: 0.7 + rand() * 0.7,
			size: 0.09 + rand() * 0.05,
		});
	}

	let extent = 0;
	for (const isl of islands) {
		extent = Math.max(extent, Math.hypot(isl.x, isl.z) + isl.radius * 1.2);
	}
	for (const isl of islands) delete isl.used;

	return {
		id,
		barren: count(w.chapters) === 0 && cast.length === 0 && !names.length,
		islands,
		bridges,
		walkers,
		landmarks,
		crystals,
		extent,
	};
}

// 群岛摆位：第 0 位（最近更新的书）居中，其余沿黄金角螺旋向外找不重叠的位置
export function layoutArchipelagos(extents, gap = 0.9) {
	const out = [];
	const golden = Math.PI * (3 - Math.sqrt(5));
	extents.forEach((e, i) => {
		if (i === 0) {
			out.push({ x: 0, z: 0, lift: 0 });
			return;
		}
		for (let k = 0; ; k++) {
			const a = i * golden + k * 0.37;
			const r = 1.5 + k * 0.22;
			const x = Math.cos(a) * r;
			const z = Math.sin(a) * r;
			const ok = out.every(
				(p, j) => Math.hypot(p.x - x, p.z - z) >= extents[j] + e + gap,
			);
			if (ok || k > 600) {
				out.push({ x, z, lift: ((i * 7) % 3) * 0.35 });
				return;
			}
		}
	});
	return out;
}

export function poolRadius(positions, extents) {
	let r = 4;
	positions.forEach((p, i) => {
		r = Math.max(r, Math.hypot(p.x, p.z) + extents[i] + 1.2);
	});
	return r;
}

// 天色与天气：天色跟本机时刻走；天气跟写作状态走（最近一次动笔距今多久）
export const DAYPART_NAMES = {
	night: "夜",
	dawn: "破晓",
	day: "白昼",
	dusk: "黄昏",
};
export const WEATHER_NAMES = { clear: "晴", cloudy: "多云", mist: "起雾" };

export function daypartOf(hour) {
	const h = ((Number(hour) % 24) + 24) % 24;
	if (h >= 5 && h < 7.5) return "dawn";
	if (h >= 7.5 && h < 17) return "day";
	if (h >= 17 && h < 19.5) return "dusk";
	return "night";
}

function parseLocal(text) {
	if (!text) return null;
	const t = new Date(String(text).replace(" ", "T"));
	return Number.isNaN(t.getTime()) ? null : t;
}

export function atmosphereFor(now, worlds) {
	const date = now instanceof Date ? now : new Date();
	const hour = date.getHours() + date.getMinutes() / 60;
	let latest = null;
	for (const w of Array.isArray(worlds) ? worlds : []) {
		const t = parseLocal(w?.updatedAt);
		if (t && (!latest || t > latest)) latest = t;
	}
	const idleDays = latest
		? Math.max(0, (date.getTime() - latest.getTime()) / 86400000)
		: Number.POSITIVE_INFINITY;
	const weather = idleDays <= 3 ? "clear" : idleDays <= 30 ? "cloudy" : "mist";
	const daypart = daypartOf(hour);
	return {
		hour,
		daypart,
		weather,
		idleDays,
		label: `${DAYPART_NAMES[daypart]} · ${WEATHER_NAMES[weather]}`,
	};
}
