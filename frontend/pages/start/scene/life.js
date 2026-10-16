// 群岛上会动的一切：走动的小人、鸟群、炊烟、萤火、云海、细雨、瀑布落水处的水雾与涟漪。
import {
	AdditiveBlending,
	BufferGeometry,
	CanvasTexture,
	Color,
	ConeGeometry,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	IcosahedronGeometry,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Points,
	PointsMaterial,
	RingGeometry,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
	coastRadius,
	heightAt,
	seededRandom,
} from "../../../lib/world-terrain.js";

export function softTexture() {
	const c = document.createElement("canvas");
	c.width = 64;
	c.height = 64;
	const g = c.getContext("2d");
	const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	grad.addColorStop(0, "rgba(255,255,255,1)");
	grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
	grad.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, 64, 64);
	return new CanvasTexture(c);
}

const ROBES = {
	lead: [0xf6efe0],
	major: [0xc0392b, 0x2f6f8f, 0x4f8a5b, 0x7a5a96],
	minor: [0x8d7b68, 0x6f7a80, 0x9a8a6a, 0x7d6b7d],
};
const SCALE = { lead: 1.5, major: 1.2, minor: 1 };

// 小人：袍子＋脑袋；主角披鎏金斗篷、脚下一圈金光，配角戴斗笠
export function createWalkers(plan, arch, shared) {
	const list = [];
	const skin = shared.skin;
	plan.walkers.forEach((w, i) => {
		const isl = plan.islands[w.island] || plan.islands[0];
		const parent = arch.islands[w.island] || arch.islands[0];
		const rand = seededRandom(w.seed);
		const g = new Group();
		const palette = ROBES[w.tier];
		const robe = shared.robe(palette[i % palette.length]);
		const body = new Mesh(shared.bodyGeo, robe);
		body.position.y = 0.045;
		body.castShadow = true;
		const head = new Mesh(shared.headGeo, skin);
		head.position.y = 0.105;
		head.castShadow = true;
		g.add(body, head);
		if (w.tier === "lead") {
			const cape = new Mesh(shared.capeGeo, shared.gilt);
			cape.position.set(0, 0.05, -0.012);
			const ring = new Mesh(shared.ringGeo, shared.halo);
			ring.rotation.x = -Math.PI / 2;
			ring.position.y = 0.004;
			g.add(cape, ring);
		} else if (w.tier === "major") {
			const hat = new Mesh(shared.hatGeo, shared.straw);
			hat.position.y = 0.13;
			g.add(hat);
		}
		g.scale.setScalar(SCALE[w.tier]);
		parent.add(g);

		const pick = () => {
			const pl = isl.plateau;
			for (let k = 0; k < 20; k++) {
				let x;
				let z;
				if (rand() < 0.7) {
					const a = rand() * Math.PI * 2;
					const r = Math.sqrt(rand()) * pl.r * 1.1;
					x = pl.x + Math.cos(a) * r;
					z = pl.z + Math.sin(a) * r;
				} else {
					const a = rand() * Math.PI * 2;
					const r = coastRadius(isl, a) * (0.2 + rand() * 0.55);
					x = Math.cos(a) * r;
					z = Math.sin(a) * r;
				}
				const m = isl.mountain;
				if (Math.hypot(x - m.x, z - m.z) < m.s * 0.7) continue;
				if (Math.hypot(x, z) > coastRadius(isl, Math.atan2(z, x)) * 0.78)
					continue;
				return { x, z };
			}
			return { x: isl.plateau.x, z: isl.plateau.z };
		};
		const start = pick();
		const state = {
			x: start.x,
			z: start.z,
			goal: pick(),
			wait: rand() * 2,
			speed: (w.tier === "lead" ? 0.075 : 0.1) + rand() * 0.04,
			phase: rand() * 10,
		};
		g.position.set(state.x, heightAt(isl, state.x, state.z), state.z);
		list.push({
			name: w.name,
			tier: w.tier,
			group: g,
			update(dt, t) {
				if (state.wait > 0) {
					state.wait -= dt;
					body.position.y = 0.045;
					return;
				}
				const dx = state.goal.x - state.x;
				const dz = state.goal.z - state.z;
				const d = Math.hypot(dx, dz);
				if (d < 0.02) {
					state.goal = pick();
					state.wait = 0.8 + rand() * 2.6;
					return;
				}
				const step = Math.min(d, state.speed * dt);
				state.x += (dx / d) * step;
				state.z += (dz / d) * step;
				g.position.set(state.x, heightAt(isl, state.x, state.z), state.z);
				g.rotation.y = Math.atan2(dx, dz);
				body.position.y =
					0.045 + Math.abs(Math.sin(t * 9 + state.phase)) * 0.008;
			},
		});
	});
	return list;
}

export function createWalkerShared() {
	return {
		bodyGeo: new ConeGeometry(0.03, 0.085, 7),
		headGeo: new SphereGeometry(0.02, 10, 8),
		capeGeo: new ConeGeometry(
			0.036,
			0.075,
			7,
			1,
			true,
			Math.PI * 0.6,
			Math.PI * 0.8,
		),
		hatGeo: new ConeGeometry(0.035, 0.02, 10),
		ringGeo: new RingGeometry(0.045, 0.06, 24),
		skin: new MeshStandardMaterial({ color: 0xf0d2b4, roughness: 0.7 }),
		gilt: new MeshStandardMaterial({
			color: 0xe0b44c,
			emissive: 0x8a5a10,
			emissiveIntensity: 0.6,
			metalness: 0.6,
			roughness: 0.35,
			side: DoubleSide,
		}),
		halo: new MeshBasicMaterial({
			color: 0xffd36b,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
		straw: new MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.9 }),
		robes: new Map(),
		robe(hex) {
			if (!this.robes.has(hex))
				this.robes.set(
					hex,
					new MeshStandardMaterial({
						color: hex,
						roughness: 0.8,
						flatShading: true,
					}),
				);
			return this.robes.get(hex);
		},
	};
}

// 鸟群：剪影小鸟绕砚池盘旋，翅膀上下扇动
export function createBirds(R, flocks) {
	const group = new Group();
	const mat = new MeshBasicMaterial({ color: 0x232833, side: DoubleSide });
	const wingGeo = new BufferGeometry();
	wingGeo.setAttribute(
		"position",
		new Float32BufferAttribute([0, 0, -0.03, 0, 0, 0.03, 0.12, 0.01, -0.01], 3),
	);
	wingGeo.computeVertexNormals();
	const bodyGeo = new SphereGeometry(0.025, 6, 4);
	const birds = [];
	const rand = seededRandom(77);
	for (let f = 0; f < flocks; f++) {
		const orbit = R * (0.45 + rand() * 0.5);
		const height = 4 + rand() * 2.5;
		const speed = (0.08 + rand() * 0.06) * (rand() < 0.5 ? 1 : -1);
		const base = rand() * Math.PI * 2;
		for (let k = 0; k < 5; k++) {
			const b = new Group();
			const body = new Mesh(bodyGeo, mat);
			body.scale.set(0.7, 0.6, 1.6);
			const l = new Mesh(wingGeo, mat);
			const r = new Mesh(wingGeo, mat);
			r.scale.x = -1;
			b.add(body, l, r);
			b.scale.setScalar(1.6);
			group.add(b);
			birds.push({
				b,
				l,
				r,
				orbit: orbit + (k % 2 ? 0.25 : -0.15) * Math.ceil(k / 2),
				height: height + (rand() - 0.5) * 0.3,
				speed,
				lag: k * 0.045 * Math.sign(speed),
				base,
				flap: rand() * 6,
			});
		}
	}
	return {
		group,
		update(t) {
			for (const it of birds) {
				const a = it.base + t * it.speed - it.lag;
				it.b.position.set(
					Math.cos(a) * it.orbit,
					it.height + Math.sin(t * 0.7 + it.flap) * 0.25,
					Math.sin(a) * it.orbit,
				);
				it.b.rotation.y = -a + (it.speed > 0 ? Math.PI : 0);
				const w = Math.sin(t * 7 + it.flap) * 0.7;
				it.l.rotation.z = w;
				it.r.rotation.z = -w;
			}
		},
	};
}

// 炊烟：精灵池循环使用，从烟囱口升起、变大、淡出
export function createSmoke(tex, size = 48) {
	const group = new Group();
	const pool = [];
	for (let i = 0; i < size; i++) {
		const s = new Sprite(
			new SpriteMaterial({
				map: tex,
				color: 0xe9ecef,
				transparent: true,
				opacity: 0,
				depthWrite: false,
			}),
		);
		s.visible = false;
		group.add(s);
		pool.push({ s, life: 0, max: 1, drift: new Vector3() });
	}
	let next = 0;
	return {
		group,
		spawn(pos, rand) {
			const p = pool[next];
			next = (next + 1) % pool.length;
			p.s.position.copy(pos);
			p.life = 0;
			p.max = 2.6 + rand() * 1.4;
			p.drift.set(
				(rand() - 0.5) * 0.06,
				0.16 + rand() * 0.06,
				(rand() - 0.5) * 0.06,
			);
			p.s.visible = true;
		},
		update(dt, tint) {
			for (const p of pool) {
				if (!p.s.visible) continue;
				p.life += dt;
				const k = p.life / p.max;
				if (k >= 1) {
					p.s.visible = false;
					continue;
				}
				p.s.position.addScaledVector(p.drift, dt);
				const sc = 0.05 + k * 0.22;
				p.s.scale.set(sc, sc, sc);
				p.s.material.opacity = Math.sin(k * Math.PI) * 0.45;
				p.s.material.color.copy(tint);
			}
		},
	};
}

// 萤火：黄昏与夜里在岛间飘的小光点
export function createFireflies(tex, anchors, count = 180) {
	const positions = new Float32Array(count * 3);
	const seeds = [];
	const rand = seededRandom(91);
	for (let i = 0; i < count; i++) {
		const a = anchors[i % anchors.length];
		const ang = rand() * Math.PI * 2;
		const r = Math.sqrt(rand()) * a.r;
		seeds.push({
			x: a.x + Math.cos(ang) * r,
			y: a.y + 0.15 + rand() * 0.6,
			z: a.z + Math.sin(ang) * r,
			p: rand() * 10,
			s: 0.3 + rand() * 0.5,
		});
	}
	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
	const mat = new PointsMaterial({
		color: 0xfff1a0,
		size: 0.09,
		map: tex,
		transparent: true,
		opacity: 0,
		depthWrite: false,
		blending: AdditiveBlending,
	});
	const points = new Points(geo, mat);
	points.frustumCulled = false;
	return {
		points,
		update(t, amount) {
			mat.opacity = amount;
			points.visible = amount > 0.02;
			if (!points.visible) return;
			const p = geo.attributes.position;
			for (let i = 0; i < seeds.length; i++) {
				const s = seeds[i];
				p.setXYZ(
					i,
					s.x + Math.sin(t * s.s + s.p) * 0.25,
					s.y + Math.sin(t * s.s * 1.3 + s.p * 2) * 0.12,
					s.z + Math.cos(t * s.s * 0.8 + s.p) * 0.25,
				);
			}
			p.needsUpdate = true;
		},
	};
}

function puffGeometry(rand) {
	const parts = [];
	const n = 4 + Math.floor(rand() * 3);
	for (let i = 0; i < n; i++) {
		const r = 0.35 + rand() * 0.35;
		const g = new IcosahedronGeometry(r, 1);
		g.translate(
			(i - n / 2) * 0.32 + (rand() - 0.5) * 0.15,
			(rand() - 0.3) * 0.2 + r * 0.25,
			(rand() - 0.5) * 0.35,
		);
		parts.push(g);
	}
	const merged = mergeGeometries(parts);
	for (const g of parts) g.dispose();
	merged.computeVertexNormals();
	return merged;
}

// 云海：砚台四周一圈低云托住砚身，高处再飘几朵；天气越阴云越多
export function createClouds(R, density) {
	const group = new Group();
	const rand = seededRandom(23);
	const mat = new MeshStandardMaterial({
		color: 0xffffff,
		roughness: 1,
		flatShading: true,
		emissive: 0xffffff,
		emissiveIntensity: 0.12,
	});
	const geos = [0, 1, 2, 3, 4].map(() => puffGeometry(rand));
	const items = [];
	const add = (x, y, z, s, spin) => {
		const m = new Mesh(geos[Math.floor(rand() * geos.length)], mat);
		m.position.set(x, y, z);
		m.scale.set(s * (1.2 + rand() * 0.6), s * (0.6 + rand() * 0.3), s);
		m.rotation.y = rand() * Math.PI * 2;
		group.add(m);
		items.push({ m, y, spin, phase: rand() * 6 });
	};
	const sea = Math.round(34 * Math.min(1.4, density));
	for (let i = 0; i < sea; i++) {
		const a = (i / sea) * Math.PI * 2 + rand() * 0.2;
		const r = R + 1.4 + rand() * 4.5;
		add(
			Math.cos(a) * r,
			-1.7 + rand() * 1.2,
			Math.sin(a) * r,
			1.1 + rand() * 1.2,
			0.012,
		);
	}
	for (let i = 0; i < 16; i++) {
		const a = rand() * Math.PI * 2;
		const r = rand() * R * 0.9;
		add(
			Math.cos(a) * r,
			-3.8 - rand() * 1.2,
			Math.sin(a) * r,
			2 + rand() * 1.5,
			0.008,
		);
	}
	const high = Math.round(6 * density);
	for (let i = 0; i < high; i++) {
		const a = rand() * Math.PI * 2;
		const r = R * (0.75 + rand() * 0.5);
		add(
			Math.cos(a) * r,
			4.2 + rand() * 2,
			Math.sin(a) * r,
			0.6 + rand() * 0.5,
			0.03,
		);
	}
	return {
		group,
		material: mat,
		update(dt, t) {
			group.rotation.y += dt * 0.006;
			for (const it of items)
				it.m.position.y = it.y + Math.sin(t * 0.25 + it.phase) * 0.08;
		},
		dispose() {
			for (const g of geos) g.dispose();
			mat.dispose();
		},
	};
}

// 细雨：久未动笔起雾时飘的雨丝
export function createRain(R, count = 600) {
	const pos = new Float32Array(count * 6);
	const rand = seededRandom(5);
	const drops = [];
	for (let i = 0; i < count; i++) {
		const a = rand() * Math.PI * 2;
		const r = Math.sqrt(rand()) * (R + 2);
		drops.push({
			x: Math.cos(a) * r,
			y: rand() * 9,
			z: Math.sin(a) * r,
			v: 5 + rand() * 2,
		});
	}
	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
	const mat = new LineBasicMaterial({
		color: 0xcfe0ea,
		transparent: true,
		opacity: 0,
		depthWrite: false,
	});
	const lines = new LineSegments(geo, mat);
	lines.frustumCulled = false;
	return {
		lines,
		update(dt, amount) {
			mat.opacity = amount * 0.35;
			lines.visible = amount > 0.02;
			if (!lines.visible) return;
			const p = geo.attributes.position;
			for (let i = 0; i < drops.length; i++) {
				const d = drops[i];
				d.y -= d.v * dt;
				if (d.y < 0) d.y += 9;
				p.setXYZ(i * 2, d.x, d.y, d.z);
				p.setXYZ(i * 2 + 1, d.x + 0.02, d.y + 0.16, d.z);
			}
			p.needsUpdate = true;
		},
	};
}

// 瀑布落水处：一团水雾＋一圈圈外扩的涟漪
export function createSplash(tex) {
	const group = new Group();
	const items = [];
	const ringGeo = new RingGeometry(0.9, 1, 40);
	return {
		group,
		add(pos, width) {
			const mist = new Sprite(
				new SpriteMaterial({
					map: tex,
					color: 0xeaf6f8,
					transparent: true,
					opacity: 0.5,
					depthWrite: false,
				}),
			);
			mist.position.copy(pos).setY(0.12);
			group.add(mist);
			const rings = [0, 1, 2].map((k) => {
				const m = new Mesh(
					ringGeo,
					new MeshBasicMaterial({
						color: 0xe6f4f6,
						transparent: true,
						opacity: 0,
						depthWrite: false,
					}),
				);
				m.rotation.x = -Math.PI / 2;
				m.position.copy(pos).setY(0.015);
				group.add(m);
				return { m, k };
			});
			items.push({ mist, rings, width, pos: pos.clone() });
		},
		update(t) {
			for (const it of items) {
				const s = it.width * (3 + Math.sin(t * 2.3 + it.pos.x) * 0.4);
				it.mist.scale.set(s, s * 0.6, s);
				for (const r of it.rings) {
					const k = (t * 0.5 + r.k / 3) % 1;
					const sc = it.width * (0.8 + k * 3.5);
					r.m.scale.set(sc, sc, sc);
					r.m.material.opacity = (1 - k) * 0.45;
				}
			}
		},
	};
}

export const tmpColor = new Color();
