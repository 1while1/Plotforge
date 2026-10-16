// 浮空群岛的几何：照 world-terrain 的规划生成地形（岛顶＋崖壁＋垂岩岛根）、聚落、林木、地标、瀑布、吊桥与晶石。
// 静态件按材质合并成少量网格（每座岛十来个 draw call）；会动的件（瀑布、飞舟、晶石）单独成网格交给 life 驱动。
import {
	AdditiveBlending,
	BoxGeometry,
	BufferGeometry,
	CapsuleGeometry,
	CatmullRomCurve3,
	Color,
	ConeGeometry,
	CylinderGeometry,
	DodecahedronGeometry,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	IcosahedronGeometry,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	OctahedronGeometry,
	PlaneGeometry,
	Quaternion,
	ShaderMaterial,
	SphereGeometry,
	TorusGeometry,
	TubeGeometry,
	Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
	coastRadius,
	depthAt,
	heightAt,
	seededRandom,
} from "../../../lib/world-terrain.js";

const C = {
	grassA: new Color(0x7fb069),
	grassB: new Color(0x9cc47a),
	meadow: new Color(0xc2d68a),
	rock: new Color(0x9a9184),
	rockDark: new Color(0x6f675e),
	snow: new Color(0xf3f6f4),
	soil: new Color(0x8a6a4f),
	soilDark: new Color(0x5b4636),
	strataA: new Color(0x7b6a5c),
	strataB: new Color(0x5d5149),
	strataC: new Color(0x463d38),
	path: new Color(0xd8c49a),
	moss: new Color(0x5f8f5a),
};

export function createMaterials() {
	const std = (color, extra) =>
		new MeshStandardMaterial({
			color,
			roughness: 0.82,
			metalness: 0,
			flatShading: true,
			...(extra || {}),
		});
	return {
		terrain: new MeshStandardMaterial({
			vertexColors: true,
			flatShading: true,
			roughness: 0.92,
		}),
		wall: std(0xf1e6d2),
		roofs: [std(0xb5452f), std(0x2f4a6b), std(0x3f7f73), std(0x7a5a96)],
		wood: std(0x6b5442),
		stone: std(0xc8bfae),
		darkStone: std(0x3a4150),
		window: new MeshStandardMaterial({
			color: 0x3a2f22,
			emissive: 0xffbf5e,
			emissiveIntensity: 0,
			roughness: 0.6,
		}),
		fire: new MeshBasicMaterial({ color: 0xffa64a }),
		leaves: [std(0x3f6e58), std(0x5f8f4e), std(0x86a85a)],
		blossom: std(0xe8a3b4),
		rock: std(0x8a8378),
		cloth: std(0xe9dcc2),
		vermilion: std(0xc0392b),
		flag: std(0xc0392b, { side: DoubleSide }),
		gilt: new MeshStandardMaterial({
			color: 0xd4af5a,
			metalness: 0.85,
			roughness: 0.3,
			emissive: 0x6b4a10,
			emissiveIntensity: 0.5,
		}),
		rune: new MeshStandardMaterial({
			color: 0x1d2a33,
			emissive: 0x4fe0d0,
			emissiveIntensity: 1.6,
			roughness: 0.4,
		}),
		lamp: new MeshStandardMaterial({
			color: 0xfff4d6,
			emissive: 0xffd27a,
			emissiveIntensity: 2.2,
		}),
		crystal: new MeshPhysicalMaterial({
			color: 0x7fe9de,
			emissive: 0x2bc6b4,
			emissiveIntensity: 1.4,
			roughness: 0.15,
			metalness: 0.1,
			clearcoat: 1,
			flatShading: true,
		}),
		pond: new MeshStandardMaterial({
			color: 0x4f9fb4,
			roughness: 0.15,
			metalness: 0.1,
		}),
		rope: std(0x8a7158),
		hull: std(0x5a4636),
		balloon: std(0xe9d7b0),
	};
}

// 合批器：同材质的静态零件变换到岛坐标后合成一个网格
function createBatch() {
	const byMat = new Map();
	const m4 = new Matrix4();
	const q = new Quaternion();
	const up = new Vector3(0, 1, 0);
	return {
		add(geometry, material, x, y, z, opts) {
			const o = opts || {};
			q.setFromAxisAngle(up, o.turn || 0);
			if (o.tilt) {
				q.multiply(
					new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), o.tilt),
				);
			}
			const s = o.scale || 1;
			m4.compose(
				new Vector3(x, y, z),
				q,
				new Vector3(o.sx || s, o.sy || s, o.sz || s),
			);
			const g = (
				geometry.index ? geometry.toNonIndexed() : geometry.clone()
			).applyMatrix4(m4);
			g.deleteAttribute("uv");
			geometry.dispose();
			if (!byMat.has(material)) byMat.set(material, []);
			byMat.get(material).push(g);
		},
		build(group, shadows) {
			for (const [material, list] of byMat) {
				const merged = mergeGeometries(list, false);
				for (const g of list) g.dispose();
				if (!merged) continue;
				const mesh = new Mesh(merged, material);
				mesh.castShadow = shadows;
				mesh.receiveShadow = true;
				group.add(mesh);
			}
			byMat.clear();
		},
	};
}

// 岛顶（极坐标网格）＋崖壁裙边＋垂岩岛根，一张非索引网格、逐面着色
function terrainGeometry(isl, rand) {
	const rings = 13;
	const segs = Math.round(40 + isl.radius * 10);
	const top = [];
	for (let i = 0; i <= rings; i++) {
		const row = [];
		for (let j = 0; j < segs; j++) {
			const a = (j / segs) * Math.PI * 2 + (i % 2 ? Math.PI / segs : 0);
			const t = i / rings;
			const r = coastRadius(isl, a) * t;
			const x = Math.cos(a) * r;
			const z = Math.sin(a) * r;
			row.push(new Vector3(x, heightAt(isl, x, z), z));
		}
		top.push(row);
	}
	const pos = [];
	const col = [];
	const face = (a, b, c, color) => {
		pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
		for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
	};
	const shade = new Color();
	const pl = isl.plateau;
	const settled = isl.tier !== "camp";
	const topColor = (a, b, c) => {
		const cy = (a.y + b.y + c.y) / 3;
		const cx = (a.x + b.x + c.x) / 3;
		const cz = (a.z + b.z + c.z) / 3;
		const n = new Vector3()
			.subVectors(b, a)
			.cross(new Vector3().subVectors(c, a))
			.normalize();
		const slope = 1 - Math.abs(n.y);
		const tr = Math.hypot(cx, cz) / coastRadius(isl, Math.atan2(cz, cx));
		const peakK = cy / Math.max(0.3, isl.mountain.h + 0.25);
		if (cy > 1.05 && slope < 0.55) return shade.copy(C.snow);
		if (slope > 0.42 || peakK > 0.78)
			return shade.copy(C.rock).lerp(C.rockDark, rand() * 0.5);
		if (tr > 0.93) return shade.copy(C.soil).lerp(C.grassA, 0.3);
		if (settled && Math.hypot(cx - pl.x, cz - pl.z) < pl.r * 0.55)
			return shade.copy(C.path).lerp(C.meadow, 0.35 + rand() * 0.2);
		const g = rand();
		return shade
			.copy(C.grassA)
			.lerp(C.grassB, g * 0.8)
			.lerp(C.meadow, slope < 0.08 && g > 0.82 ? 0.6 : 0);
	};
	for (let i = 0; i < rings; i++) {
		const inner = top[i];
		const outer = top[i + 1];
		for (let j = 0; j < segs; j++) {
			const j1 = (j + 1) % segs;
			if (i === 0) {
				face(
					inner[j],
					outer[j1],
					outer[j],
					topColor(inner[j], outer[j1], outer[j]),
				);
				continue;
			}
			// 奇偶环错半格：三角形更匀，低多边形的面不呈放射条纹
			if (i % 2) {
				face(
					inner[j],
					outer[j1],
					outer[j],
					topColor(inner[j], outer[j1], outer[j]),
				);
				face(
					inner[j],
					inner[j1],
					outer[j1],
					topColor(inner[j], inner[j1], outer[j1]),
				);
			} else {
				face(
					inner[j],
					inner[j1],
					outer[j],
					topColor(inner[j], inner[j1], outer[j]),
				);
				face(
					inner[j1],
					outer[j1],
					outer[j],
					topColor(inner[j1], outer[j1], outer[j]),
				);
			}
		}
	}
	// 崖壁裙边：岛沿向下 0.16，草皮下露土层
	const edge = top[rings];
	const lip = edge.map((p) => new Vector3(p.x * 1.02, p.y - 0.18, p.z * 1.02));
	for (let j = 0; j < segs; j++) {
		const j1 = (j + 1) % segs;
		const c1 = shade
			.copy(C.soil)
			.lerp(C.soilDark, rand() * 0.4)
			.clone();
		face(edge[j], edge[j1], lip[j], c1);
		face(edge[j1], lip[j1], lip[j], c1);
	}
	// 岛根：从崖沿往中心收拢，深度按噪声长出垂岩，岩层按高度分带
	const under = [lip];
	const urings = 8;
	for (let i = 1; i <= urings; i++) {
		const t = 1 - i / urings;
		const row = [];
		for (let j = 0; j < segs; j++) {
			const a = (j / segs) * Math.PI * 2;
			const r = coastRadius(isl, a) * t * (0.98 - (1 - t) * 0.05);
			const x = Math.cos(a) * r;
			const z = Math.sin(a) * r;
			row.push(new Vector3(x, -0.18 - depthAt(isl, x, z) * (1 - t ** 1.6), z));
		}
		under.push(row);
	}
	const strata = [C.strataA, C.strataB, C.strataA, C.strataC];
	for (let i = 0; i < urings; i++) {
		const a0 = under[i];
		const a1 = under[i + 1];
		for (let j = 0; j < segs; j++) {
			const j1 = (j + 1) % segs;
			const cy = (a0[j].y + a1[j].y) / 2;
			const band = strata[Math.abs(Math.floor(cy * 2.2)) % strata.length];
			const c = shade
				.copy(band)
				.lerp(C.moss, i === 0 && rand() < 0.35 ? 0.5 : 0)
				.multiplyScalar(0.92 + rand() * 0.16)
				.clone();
			face(a0[j], a0[j1], a1[j], c);
			face(a0[j1], a1[j1], a1[j], c);
		}
	}
	const g = new BufferGeometry();
	g.setAttribute("position", new Float32BufferAttribute(pos, 3));
	g.setAttribute("color", new Float32BufferAttribute(col, 3));
	g.computeVertexNormals();
	g.computeBoundingSphere();
	return g;
}

function addHouse(batch, M, b, y, chimneys, windows) {
	const s = b.size;
	const w = s * 1.45;
	const d = s * 1.05;
	const h = s * (b.tall ? 1.7 : 1);
	batch.add(new BoxGeometry(w, h, d), M.wall, b.x, y + h / 2, b.z, {
		turn: b.turn,
	});
	batch.add(
		new ConeGeometry(s * 1.12, s * 0.75, 4),
		M.roofs[b.roof % 4],
		b.x,
		y + h + s * 0.37,
		b.z,
		{
			turn: b.turn + Math.PI / 4,
			sx: 1.25,
		},
	);
	const cos = Math.cos(b.turn);
	const sin = Math.sin(b.turn);
	for (const side of [-1, 1]) {
		const ox = sin * side * (d / 2 + 0.003);
		const oz = cos * side * (d / 2 + 0.003);
		windows.add(
			new BoxGeometry(s * 0.28, s * 0.3, 0.008),
			M.window,
			b.x + ox,
			y + h * 0.55,
			b.z + oz,
			{
				turn: b.turn,
			},
		);
	}
	if (b.chimney) {
		const cx = b.x + cos * w * 0.25;
		const cz = b.z - sin * w * 0.25;
		batch.add(
			new BoxGeometry(s * 0.18, s * 0.5, s * 0.18),
			M.stone,
			cx,
			y + h + s * 0.45,
			cz,
			{ turn: b.turn },
		);
		chimneys.push(new Vector3(cx, y + h + s * 0.75, cz));
	}
}

function addTower(batch, M, x, y, z, s, roof, windows) {
	const h = s * 4.2;
	batch.add(
		new CylinderGeometry(s * 0.55, s * 0.68, h, 8),
		M.stone,
		x,
		y + h / 2,
		z,
	);
	batch.add(
		new CylinderGeometry(s * 0.75, s * 0.7, s * 0.35, 8),
		M.stone,
		x,
		y + h + s * 0.15,
		z,
	);
	batch.add(new ConeGeometry(s * 0.8, s * 1.6, 8), roof, x, y + h + s * 1.1, z);
	for (let k = 0; k < 3; k++) {
		const a = (k / 3) * Math.PI * 2;
		windows.add(
			new BoxGeometry(s * 0.2, s * 0.35, 0.01),
			M.window,
			x + Math.cos(a) * s * 0.57,
			y + h * 0.7,
			z + Math.sin(a) * s * 0.57,
			{
				turn: -a + Math.PI / 2,
			},
		);
	}
	return y + h + s * 1.9;
}

function addKeep(batch, M, b, y, windows, flags) {
	const s = b.size;
	batch.add(
		new BoxGeometry(s * 1.5, s * 0.9, s * 1.5),
		M.stone,
		b.x,
		y + s * 0.45,
		b.z,
		{ turn: b.turn },
	);
	for (let k = 0; k < 4; k++) {
		const a = b.turn + Math.PI / 4 + (k * Math.PI) / 2;
		const r = s * 1.06;
		addTower(
			batch,
			M,
			b.x + Math.cos(a) * r,
			y,
			b.z + Math.sin(a) * r,
			s * 0.32,
			M.roofs[1],
			windows,
		);
	}
	const top = addTower(
		batch,
		M,
		b.x,
		y + s * 0.9,
		b.z,
		s * 0.48,
		M.roofs[0],
		windows,
	);
	batch.add(
		new CylinderGeometry(0.006, 0.006, s * 0.7, 4),
		M.wood,
		b.x,
		top + s * 0.3,
		b.z,
	);
	const flag = new Mesh(new PlaneGeometry(s * 0.45, s * 0.26), M.flag);
	flag.position.set(b.x + s * 0.23, top + s * 0.52, b.z);
	flags.push(flag);
	return top;
}

function addWalls(batch, M, isl, rand) {
	if (!isl.wallRadius) return;
	const pl = isl.plateau;
	const R = isl.wallRadius;
	const steps = Math.round((Math.PI * 2 * R) / 0.11);
	const gate = rand() * steps;
	for (let k = 0; k < steps; k++) {
		if (Math.abs(k - gate) < 1.5) continue;
		const a = (k / steps) * Math.PI * 2;
		const x = pl.x + Math.cos(a) * R;
		const z = pl.z + Math.sin(a) * R;
		if (Math.hypot(x, z) > coastRadius(isl, Math.atan2(z, x)) * 0.86) continue;
		const y = heightAt(isl, x, z);
		batch.add(new BoxGeometry(0.12, 0.08, 0.035), M.stone, x, y + 0.035, z, {
			turn: -a + Math.PI / 2,
		});
	}
}

function addTree(batch, M, t, y) {
	const h = t.height;
	batch.add(
		new CylinderGeometry(0.012, 0.018, h * 0.45, 5),
		M.wood,
		t.x,
		y + h * 0.22,
		t.z,
	);
	const leaf = M.leaves[Math.floor(t.tint * 3) % 3];
	if (t.pine) {
		batch.add(
			new ConeGeometry(h * 0.36, h * 0.6, 6),
			M.leaves[0],
			t.x,
			y + h * 0.55,
			t.z,
			{ turn: t.tint * 6 },
		);
		batch.add(
			new ConeGeometry(h * 0.27, h * 0.48, 6),
			M.leaves[0],
			t.x,
			y + h * 0.82,
			t.z,
			{ turn: t.tint * 3 },
		);
	} else {
		const m = t.tint > 0.88 ? M.blossom : leaf;
		batch.add(new IcosahedronGeometry(h * 0.34, 0), m, t.x, y + h * 0.62, t.z, {
			turn: t.tint * 6,
			sy: 0.85,
		});
	}
}

function addLandmark(batch, windows, M, lm, y, rand, movers) {
	const { x, z } = lm;
	switch (lm.kind) {
		case "spire": {
			batch.add(
				new CylinderGeometry(0.05, 0.1, 0.7, 6),
				M.stone,
				x,
				y + 0.35,
				z,
			);
			batch.add(new TorusGeometry(0.075, 0.012, 6, 12), M.gilt, x, y + 0.5, z, {
				tilt: Math.PI / 2,
			});
			batch.add(new ConeGeometry(0.06, 0.32, 6), M.gilt, x, y + 0.86, z);
			return y + 1.05;
		}
		case "pillar": {
			let yy = y;
			for (let k = 0; k < 3; k++) {
				const h = 0.22 - k * 0.03;
				batch.add(
					new CylinderGeometry(0.09 - k * 0.012, 0.11 - k * 0.012, h, 7),
					M.rock,
					x + (rand() - 0.5) * 0.02,
					yy + h / 2,
					z,
					{
						turn: rand() * 3,
					},
				);
				yy += h;
			}
			batch.add(new ConeGeometry(0.08, 0.14, 6), M.leaves[0], x, yy + 0.07, z);
			return yy + 0.25;
		}
		case "lighthouse": {
			for (let k = 0; k < 4; k++) {
				batch.add(
					new CylinderGeometry(0.06 - k * 0.006, 0.065 - k * 0.006, 0.13, 10),
					k % 2 ? M.vermilion : M.wall,
					x,
					y + 0.065 + k * 0.13,
					z,
				);
			}
			windows.add(
				new CylinderGeometry(0.045, 0.045, 0.07, 10),
				M.lamp,
				x,
				y + 0.56,
				z,
			);
			batch.add(new ConeGeometry(0.06, 0.08, 10), M.darkStone, x, y + 0.63, z);
			return y + 0.8;
		}
		case "obelisk": {
			batch.add(
				new CylinderGeometry(0.035, 0.07, 0.62, 4),
				M.darkStone,
				x,
				y + 0.31,
				z,
				{ turn: Math.PI / 4 },
			);
			windows.add(
				new CylinderGeometry(0.052, 0.058, 0.025, 4),
				M.rune,
				x,
				y + 0.22,
				z,
				{ turn: Math.PI / 4 },
			);
			windows.add(
				new CylinderGeometry(0.043, 0.047, 0.02, 4),
				M.rune,
				x,
				y + 0.42,
				z,
				{ turn: Math.PI / 4 },
			);
			batch.add(new OctahedronGeometry(0.035), M.rune, x, y + 0.7, z);
			return y + 0.9;
		}
		case "ship": {
			// 飞舟单独成组：悬在地标上空缓缓起伏
			const ship = new Group();
			const hull = new Mesh(new CapsuleGeometry(0.05, 0.22, 4, 8), M.hull);
			hull.rotation.z = Math.PI / 2;
			hull.scale.set(1, 1, 0.75);
			const balloon = new Mesh(new SphereGeometry(0.09, 12, 8), M.balloon);
			balloon.scale.set(2.1, 0.95, 1);
			balloon.position.y = 0.17;
			const fin = new Mesh(new BoxGeometry(0.01, 0.09, 0.08), M.vermilion);
			fin.position.set(-0.17, 0.17, 0);
			ship.add(hull, balloon, fin);
			ship.position.set(x, y + 0.55, z);
			ship.rotation.y = rand() * Math.PI * 2;
			ship.userData.baseY = y + 0.55;
			for (const o of [hull, balloon, fin]) o.castShadow = true;
			movers.push(ship);
			batch.add(
				new CylinderGeometry(0.008, 0.008, 0.5, 4),
				M.wood,
				x,
				y + 0.25,
				z,
			);
			return y + 0.95;
		}
		default: {
			// 小祠：朱色牌坊＋石灯
			for (const side of [-1, 1]) {
				batch.add(
					new CylinderGeometry(0.013, 0.015, 0.26, 6),
					M.vermilion,
					x + side * 0.08,
					y + 0.13,
					z,
				);
			}
			batch.add(
				new BoxGeometry(0.24, 0.025, 0.03),
				M.vermilion,
				x,
				y + 0.27,
				z,
			);
			batch.add(
				new BoxGeometry(0.2, 0.018, 0.024),
				M.vermilion,
				x,
				y + 0.22,
				z,
			);
			batch.add(
				new CylinderGeometry(0.02, 0.025, 0.08, 6),
				M.stone,
				x,
				y + 0.04,
				z + 0.1,
			);
			windows.add(
				new BoxGeometry(0.03, 0.03, 0.03),
				M.lamp,
				x,
				y + 0.095,
				z + 0.1,
			);
			return y + 0.5;
		}
	}
}

// 瀑布：从岸沿垂到砚池的一条带状面，流纹在着色器里向下滚动，上下两端渐隐
export function createFallMaterial() {
	return new ShaderMaterial({
		uniforms: { time: { value: 0 }, tint: { value: new Color(0xd8f2f6) } },
		vertexShader: /* glsl */ `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: /* glsl */ `
			uniform float time;
			uniform vec3 tint;
			varying vec2 vUv;
			float n(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
			void main() {
				float cols = floor(vUv.x * 9.0);
				float speed = 1.4 + n(vec2(cols, 1.0)) * 0.8;
				float streak = fract(vUv.y * 3.0 + time * speed + n(vec2(cols, 7.0)));
				float line = smoothstep(0.0, 0.5, streak) * (1.0 - smoothstep(0.55, 1.0, streak));
				float edge = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
				float fade = smoothstep(0.0, 0.06, 1.0 - vUv.y) * (0.35 + 0.65 * smoothstep(0.0, 0.35, vUv.y));
				float a = (0.35 + 0.55 * line) * edge * fade;
				gl_FragColor = vec4(tint * (0.85 + 0.35 * line), a * 0.85);
			}`,
		transparent: true,
		depthWrite: false,
		side: DoubleSide,
		blending: AdditiveBlending,
	});
}

function addFall(group, isl, f, length, fallMat, pondBatch, M, falls) {
	const R = coastRadius(isl, f.angle);
	const ex = Math.cos(f.angle);
	const ez = Math.sin(f.angle);
	const topY = heightAt(isl, ex * R * 0.97, ez * R * 0.97);
	// 瀑口小潭：岸边一洼水，看起来是从岛上流出来的
	const px = ex * R * 0.82;
	const pz = ez * R * 0.82;
	pondBatch.add(
		new CylinderGeometry(f.width * 1.5, f.width * 1.3, 0.02, 10),
		M.pond,
		px,
		heightAt(isl, px, pz) + 0.01,
		pz,
		{
			sz: 0.7,
			turn: -f.angle,
		},
	);
	const geo = new PlaneGeometry(f.width, length, 1, 18);
	const p = geo.attributes.position;
	for (let i = 0; i < p.count; i++) {
		// 浮点误差会让 v 略超 [0,1]，负数开方得 NaN，包围球随之报错
		const v = Math.min(1, Math.max(0, (p.getY(i) + length / 2) / length));
		// 先略向外抛再垂落：抛物线式外鼓
		p.setZ(i, (1 - v) ** 0.5 * 0.22 * (1 - v));
	}
	geo.computeVertexNormals();
	const mesh = new Mesh(geo, fallMat);
	mesh.position.set(ex * R * 1.01, topY - length / 2, ez * R * 1.01);
	mesh.rotation.y = -f.angle + Math.PI / 2;
	mesh.renderOrder = 2;
	group.add(mesh);
	falls.push({
		mesh,
		local: new Vector3(ex * (R + 0.15), 0, ez * (R + 0.15)),
		width: f.width,
	});
}

function bridgeBetween(batch, M, a, b, ga, gb) {
	const ang = Math.atan2(gb.z - ga.z, gb.x - ga.x);
	const ra = coastRadius(a, ang) * 0.9;
	const rb = coastRadius(b, ang + Math.PI) * 0.9;
	const pa = new Vector3(Math.cos(ang) * ra, 0, Math.sin(ang) * ra);
	pa.y = heightAt(a, pa.x, pa.z) + 0.02;
	pa.add(ga);
	const pb = new Vector3(
		Math.cos(ang + Math.PI) * rb,
		0,
		Math.sin(ang + Math.PI) * rb,
	);
	pb.y = heightAt(b, pb.x, pb.z) + 0.02;
	pb.add(gb);
	const mid = pa.clone().lerp(pb, 0.5);
	mid.y -= 0.18 + pa.distanceTo(pb) * 0.06;
	const curve = new CatmullRomCurve3([pa, mid, pb]);
	const len = curve.getLength();
	const planks = Math.max(6, Math.round(len / 0.07));
	for (let k = 0; k <= planks; k++) {
		const p = curve.getPoint(k / planks);
		batch.add(new BoxGeometry(0.05, 0.012, 0.12), M.wood, p.x, p.y, p.z, {
			turn: -ang,
		});
	}
	const side = new Vector3(-Math.sin(ang), 0, Math.cos(ang)).multiplyScalar(
		0.065,
	);
	for (const s of [-1, 1]) {
		const off = side.clone().multiplyScalar(s);
		const rope = new CatmullRomCurve3([
			pa
				.clone()
				.add(off)
				.setY(pa.y + 0.08),
			mid
				.clone()
				.add(off)
				.setY(mid.y + 0.07),
			pb
				.clone()
				.add(off)
				.setY(pb.y + 0.08),
		]);
		batch.add(new TubeGeometry(rope, 24, 0.006, 4, false), M.rope, 0, 0, 0);
	}
}

// 一本书 → 一组浮空群岛（坐标原点＝主岛中心，y＝0 是岛基准面）
export function buildArchipelago(plan, M, opts) {
	const shadows = !!opts.shadows;
	const fallLength = opts.fallLength;
	const group = new Group();
	const rand = seededRandom(plan.id * 13 + 3);
	const batch = createBatch();
	const chimneys = [];
	const falls = [];
	const flags = [];
	const movers = [];
	const hits = [];
	const landmarks = [];
	const regions = [];
	const fallMat = opts.fallMaterial;

	const terrains = [];
	for (const isl of plan.islands) {
		const g = new Group();
		g.position.set(isl.x, isl.y, isl.z);
		group.add(g);
		const terrain = new Mesh(terrainGeometry(isl, rand), M.terrain);
		terrain.castShadow = shadows;
		terrain.receiveShadow = true;
		g.add(terrain);
		terrains.push(g);

		const local = createBatch();
		const localGlow = createBatch();
		const smokes = [];
		let regionTop = 0.5;
		for (const b of isl.buildings) {
			const y = heightAt(isl, b.x, b.z) - 0.01;
			if (b.kind === "house") addHouse(local, M, b, y, smokes, localGlow);
			else if (b.kind === "keep")
				regionTop = addKeep(local, M, b, y, localGlow, flags);
			else if (b.kind === "tower")
				regionTop = addTower(
					local,
					M,
					b.x,
					y,
					b.z,
					b.size,
					M.roofs[1],
					localGlow,
				);
			else if (b.kind === "turret") {
				local.add(
					new CylinderGeometry(b.size * 0.6, b.size * 0.7, b.size * 2.2, 7),
					M.stone,
					b.x,
					y + b.size * 1.1,
					b.z,
				);
				local.add(
					new ConeGeometry(b.size * 0.75, b.size * 1.1, 7),
					M.roofs[1],
					b.x,
					y + b.size * 2.75,
					b.z,
				);
			} else if (b.kind === "well") {
				local.add(
					new CylinderGeometry(0.05, 0.055, 0.05, 8),
					M.stone,
					b.x,
					y + 0.025,
					b.z,
				);
				local.add(
					new ConeGeometry(0.07, 0.05, 4),
					M.roofs[0],
					b.x,
					y + 0.14,
					b.z,
					{ turn: Math.PI / 4 },
				);
				for (const s of [-1, 1])
					local.add(
						new BoxGeometry(0.008, 0.1, 0.008),
						M.wood,
						b.x + s * 0.04,
						y + 0.07,
						b.z,
					);
			} else if (b.kind === "tent") {
				local.add(
					new ConeGeometry(b.size, b.size * 1.2, 6),
					M.cloth,
					b.x,
					y + b.size * 0.6,
					b.z,
					{ turn: b.turn },
				);
			} else if (b.kind === "fire") {
				for (let k = 0; k < 5; k++) {
					const a = (k / 5) * Math.PI * 2;
					local.add(
						new DodecahedronGeometry(0.018),
						M.rock,
						b.x + Math.cos(a) * 0.05,
						y + 0.01,
						b.z + Math.sin(a) * 0.05,
					);
				}
				localGlow.add(
					new ConeGeometry(0.03, 0.08, 5),
					M.fire,
					b.x,
					y + 0.04,
					b.z,
				);
				smokes.push(new Vector3(b.x, y + 0.08, b.z));
			}
		}
		for (const p of smokes) chimneys.push(p.add(g.position));
		addWalls(local, M, isl, rand);
		for (const t of isl.trees)
			addTree(local, M, t, heightAt(isl, t.x, t.z) - 0.01);
		for (const r of isl.rocks) {
			local.add(
				new DodecahedronGeometry(r.size, 0),
				M.rock,
				r.x,
				heightAt(isl, r.x, r.z) + r.size * 0.3,
				r.z,
				{
					turn: r.turn,
					sy: 0.6,
				},
			);
		}
		for (const f of isl.waterfalls)
			addFall(g, isl, f, fallLength + isl.y, fallMat, local, M, falls);
		for (const lm of plan.landmarks.filter((l) => l.island === isl.index)) {
			const top = addLandmark(
				local,
				localGlow,
				M,
				lm,
				heightAt(isl, lm.x, lm.z) - 0.01,
				rand,
				movers,
			);
			landmarks.push({
				name: lm.name,
				kind: lm.kind,
				anchor: new Vector3(lm.x, top, lm.z).add(g.position),
			});
		}
		for (const ship of movers) {
			if (!ship.parent) g.add(ship);
		}
		for (const flag of flags) {
			if (!flag.parent) g.add(flag);
		}
		local.build(g, shadows);
		localGlow.build(g, false);

		const hitR = coastRadius(isl, 0) * 1.08;
		const hit = new Mesh(
			new CylinderGeometry(
				hitR,
				hitR * 0.5,
				isl.depth + isl.mountain.h + 0.6,
				12,
			),
			new MeshBasicMaterial({ visible: false }),
		);
		hit.position.y = (isl.mountain.h + 0.6 - isl.depth) / 2;
		hit.userData.worldId = opts.worldId;
		g.add(hit);
		hits.push(hit);
		regions.push({
			title: isl.title,
			tier: isl.tier,
			chapters: isl.chapters,
			anchor: new Vector3(
				isl.plateau.x,
				Math.max(regionTop, 0.55) + 0.12,
				isl.plateau.z,
			).add(g.position),
		});
	}
	for (const br of plan.bridges) {
		bridgeBetween(
			batch,
			M,
			plan.islands[br.from],
			plan.islands[br.to],
			terrains[br.from].position,
			terrains[br.to].position,
		);
	}
	batch.build(group, shadows);

	const crystals = plan.crystals.map((c) => {
		const mesh = new Mesh(new OctahedronGeometry(c.size, 0), M.crystal);
		mesh.scale.y = 1.7;
		mesh.userData = { ...c };
		mesh.castShadow = shadows;
		group.add(mesh);
		return mesh;
	});

	const main = plan.islands[0];
	return {
		group,
		hits,
		chimneys,
		falls,
		flags,
		movers,
		crystals,
		landmarks,
		regions,
		islands: terrains,
		labelHeight: main.mountain.h + 0.75,
	};
}
