// 开始界面三维场景「掌中世界」：一方墨砚悬在云海里，砚池水面映着天光，每本书是池上空的一片浮空群岛
// （每卷一座岛，章节长成聚落，人物在岛上走动，设定立成地标），砚灵机器人在岛间巡游。
// 只经 StartPage 动态 import 载入，three.js 因此单独成块，不进其余页面的首屏包。
// 岛名与地标名用 DOM 按钮/标签叠在画布上（中文字形清晰、可 Tab 聚焦、读屏可读），三维物体本身不承担可访问性。
import {
	ACESFilmicToneMapping,
	Color,
	DirectionalLight,
	Fog,
	HemisphereLight,
	PCFShadowMap,
	PerspectiveCamera,
	Raycaster,
	Scene,
	SRGBColorSpace,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
	atmosphereFor,
	layoutArchipelagos,
	planArchipelago,
	poolRadius,
	seededRandom,
	TIER_NAMES,
} from "../../lib/world-terrain.js";
import {
	buildArchipelago,
	createFallMaterial,
	createMaterials,
} from "./scene/island.js";
import {
	createBirds,
	createClouds,
	createFireflies,
	createRain,
	createSmoke,
	createSplash,
	createWalkerShared,
	createWalkers,
	softTexture,
} from "./scene/life.js";
import { createPost } from "./scene/post.js";
import { buildRobot } from "./scene/robot.js";
import { createSky, keyLightDir, paletteAt } from "./scene/sky.js";
import { createInkstone, createPool } from "./scene/water.js";

const TIER_ORDER = ["high", "medium", "low"];

function disposeTree(root) {
	root.traverse((o) => {
		if (o.geometry) o.geometry.dispose();
		if (o.material) {
			const list = Array.isArray(o.material) ? o.material : [o.material];
			for (const m of list) {
				m.map?.dispose();
				m.dispose();
			}
		}
	});
}

function initialTier(renderer) {
	// 软件光栅（SwiftShader/llvmpipe 等无显卡环境）跑后期与倒影会把主线程拖到秒级一帧，开局即用低画质
	if (isSoftwareRenderer(renderer)) return "low";
	const coarse =
		typeof window.matchMedia === "function" &&
		window.matchMedia("(pointer: coarse)").matches;
	return coarse ? "medium" : "high";
}

function makeLabel(className, text, aria) {
	const el = document.createElement(aria ? "button" : "span");
	el.className = className;
	if (aria) {
		el.type = "button";
		el.setAttribute("aria-label", aria);
	} else {
		el.setAttribute("aria-hidden", "true");
	}
	el.textContent = text;
	return el;
}

export function createWorldScene(container, options) {
	const opts = options || {};
	const worlds = Array.isArray(opts.worlds) ? opts.worlds : [];
	const reduced = !!opts.reducedMotion;

	const renderer = new WebGLRenderer({
		antialias: true,
		powerPreference: "high-performance",
	});
	let tier = initialTier(renderer);
	const pixelRatio = () =>
		tier === "low"
			? 1
			: Math.min(window.devicePixelRatio || 1, tier === "high" ? 1.75 : 1.5);
	renderer.setPixelRatio(pixelRatio());
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.shadowMap.enabled = tier !== "low";
	renderer.shadowMap.type = PCFShadowMap;
	renderer.domElement.className = "start-canvas";
	renderer.domElement.setAttribute("aria-hidden", "true");
	container.appendChild(renderer.domElement);

	const labelLayer = document.createElement("div");
	labelLayer.className = "start-labels";
	container.appendChild(labelLayer);

	const scene = new Scene();
	scene.fog = new Fog(0xc8e2e6, 30, 120);

	const plans = worlds.map(planArchipelago);
	const extents = plans.map((p) => p.extent);
	const slots = layoutArchipelagos(extents);
	const R = poolRadius(slots, extents);

	const camera = new PerspectiveCamera(36, 1, 0.1, 900);
	const homeDist = R * 1.75 + 6;
	const homeDir = new Vector3(0, Math.sin(0.6), Math.cos(0.6));
	const homeTarget = new Vector3(0, 1.8, 0);
	camera.position.copy(homeDir).multiplyScalar(homeDist).add(homeTarget);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.enablePan = false;
	controls.minPolarAngle = 0.3;
	controls.maxPolarAngle = 1.3;
	controls.minDistance = 3;
	controls.maxDistance = homeDist * 1.6;
	controls.autoRotate = !reduced;
	controls.autoRotateSpeed = 0.25;
	controls.target.copy(homeTarget);

	const sky = createSky(600);
	scene.add(sky.mesh);
	const hemi = new HemisphereLight(0xeef6f2, 0x34424c, 1.1);
	scene.add(hemi);
	const key = new DirectionalLight(0xfff1d6, 2.4);
	key.castShadow = tier !== "low";
	key.shadow.mapSize.set(
		tier === "high" ? 2048 : 1024,
		tier === "high" ? 2048 : 1024,
	);
	const sc = key.shadow.camera;
	sc.left = -R - 1;
	sc.right = R + 1;
	sc.top = R + 1;
	sc.bottom = -R - 1;
	sc.near = 1;
	sc.far = R * 4 + 40;
	key.shadow.bias = -0.0004;
	key.shadow.normalBias = 0.02;
	scene.add(key, key.target);
	const fill = new DirectionalLight(0xbfd6ff, 0.35);
	scene.add(fill);
	// 池面反光：从下往上打一道水色弱光，岛根不至于黑成剪影
	const bounce = new DirectionalLight(0x6fb3c0, 0.9);
	bounce.position.set(0.3, -1, 0.2);
	scene.add(bounce);

	let pool = createPool(R, { reflect: tier === "high" || tier === "medium" });
	scene.add(pool.mesh);
	scene.add(createInkstone(R));

	const M = createMaterials();
	const fallMat = createFallMaterial();
	const soft = softTexture();
	const walkerShared = createWalkerShared();
	const smoke = createSmoke(soft);
	scene.add(smoke.group);
	const splash = createSplash(soft);
	scene.add(splash.group);

	let atmo = atmosphereFor(
		opts.now instanceof Date ? opts.now : new Date(),
		worlds,
	);
	const clouds = createClouds(R, atmo.weather === "clear" ? 1 : 1.6);
	scene.add(clouds.group);
	const rain = createRain(R);
	scene.add(rain.lines);
	const birds = createBirds(R, atmo.daypart === "night" ? 1 : 3);
	scene.add(birds.group);

	const archs = plans.map((plan, i) => {
		const w = worlds[i];
		const slot = slots[i];
		let deepest = 0;
		for (const isl of plan.islands)
			deepest = Math.max(deepest, isl.depth - isl.y);
		const baseY = deepest + 0.8 + slot.lift;
		const built = buildArchipelago(plan, M, {
			shadows: tier !== "low",
			fallLength: baseY + 0.6,
			fallMaterial: fallMat,
			worldId: w.id,
		});
		built.group.position.set(slot.x, baseY, slot.z);
		built.group.rotation.y = seededRandom(w.id)() * Math.PI * 2;
		scene.add(built.group);
		built.group.updateMatrixWorld(true);
		for (const f of built.falls) {
			const p = built.islands[0].parent.localToWorld(
				f.local.clone().applyMatrix4(f.mesh.parent.matrix),
			);
			splash.add(p, f.width);
		}
		const walkers = createWalkers(plan, built, walkerShared);

		const label = makeLabel(
			"start-island-label",
			"",
			`${w.title || "未命名"}，${w.chapters || 0} 章`,
		);
		label.dataset.worldId = String(w.id);
		const name = document.createElement("span");
		name.className = "start-island-name";
		name.textContent = w.title || "未命名";
		const meta = document.createElement("span");
		meta.className = "start-island-meta";
		meta.textContent = w.chapters ? `${w.chapters} 章` : "空白之岛";
		label.append(name, meta);
		label.addEventListener("click", () => choose(w.id));
		label.addEventListener("dblclick", () => opts.onEnter?.(w.id));
		label.addEventListener("focus", () => opts.onSelect?.(w.id));
		labelLayer.appendChild(label);

		// 选中后才显示的细节标签：各卷岛名＋聚落等级、地标名、主角名
		const details = [];
		const many = plan.islands.length > 1;
		built.regions.forEach((r, k) => {
			if (!many && !r.title) return;
			const text = `${r.title || "本卷"} · ${TIER_NAMES[r.tier]}`;
			details.push({
				el: makeLabel("start-detail-label is-region", text),
				anchor: r.anchor,
				local: true,
				k,
			});
		});
		for (const lm of built.landmarks) {
			details.push({
				el: makeLabel("start-detail-label is-landmark", lm.name),
				anchor: lm.anchor,
				local: true,
			});
		}
		for (const wk of walkers) {
			if (wk.tier !== "lead") continue;
			details.push({
				el: makeLabel("start-detail-label is-lead", wk.name),
				walker: wk,
			});
		}
		for (const d of details) labelLayer.appendChild(d.el);

		return {
			world: w,
			plan,
			...built,
			baseY,
			walkers,
			label,
			details,
			phase: i * 1.3,
			lift: 0,
		};
	});

	const anchors = [];
	for (const a of archs) {
		for (const isl of a.plan.islands) {
			const p = new Vector3(isl.x, isl.y + 0.2, isl.z);
			a.group.localToWorld(p);
			anchors.push({ x: p.x, y: p.y, z: p.z, r: isl.radius * 0.9 });
		}
	}
	const fireflies = createFireflies(
		soft,
		anchors.length ? anchors : [{ x: 0, y: 1, z: 0, r: R }],
	);
	scene.add(fireflies.points);

	const bot = buildRobot();
	bot.robot.scale.setScalar(1.25);
	bot.robot.position.set(0, 4, 2);
	scene.add(bot.robot);

	let post = createPost(renderer, scene, camera, tier);

	let palette = null;
	function applyAtmosphere() {
		const pal = paletteAt(atmo.hour, atmo.weather);
		const light = keyLightDir(atmo.hour);
		palette = pal;
		sky.apply(pal, light);
		pool.apply(pal, light);
		hemi.color.copy(pal.hemiSky);
		hemi.groundColor.copy(pal.hemiGround);
		hemi.intensity = pal.hemiI;
		key.color.copy(pal.key);
		key.intensity = pal.keyI;
		key.position.copy(light.dir).multiplyScalar(R * 2 + 20);
		fill.position.copy(light.dir).multiplyScalar(-30).setY(12);
		bounce.color.copy(pal.water).lerp(pal.horizon, 0.5);
		bounce.intensity = 0.6 + pal.keyI * 0.25;
		scene.fog.color.copy(pal.fog);
		scene.fog.near = homeDist * 0.9 * pal.fogK;
		scene.fog.far = homeDist * 3.2 * pal.fogK;
		renderer.toneMappingExposure = pal.exposure;
		M.window.emissiveIntensity = 0.05 + pal.lit * 2.4;
		clouds.material.color.copy(pal.hemiSky).lerp(new Color(0xffffff), 0.55);
		clouds.material.emissive.copy(pal.horizon);
		clouds.material.emissiveIntensity = 0.12 + pal.glow * 0.1;
		post.setBloom(0.45 + pal.lit * 0.35, 0.9 - pal.lit * 0.12);
		container.dataset.daypart = atmo.daypart;
		container.dataset.weather = atmo.weather;
	}
	applyAtmosphere();
	opts.onAtmosphere?.(atmo);

	let selectedId = null;
	let guideState = "idle";
	let hovered = null;
	const robotGoal = new Vector3(0, 4, 2);
	const targetGoal = homeTarget.clone();
	let distGoal = homeDist;
	let userTookCamera = false;
	// 进页时页面会自动选中第一本书；那一次只亮标签、派砚灵过去，镜头留在全景，等用户自己点岛才飞近
	let overview = true;
	let selectCount = 0;

	const archById = (id) =>
		archs.find((it) => String(it.world.id) === String(id)) || null;

	// 点的正是自动选中的那本书时，React 状态不变、不会回调 setSelected，这里直接飞过去
	function choose(id) {
		if (overview && String(id) === String(selectedId)) {
			overview = false;
			selectCount = 2;
			userTookCamera = false;
			aim();
		}
		opts.onSelect?.(id);
	}

	function aim() {
		const it = archById(selectedId);
		if (!it) {
			robotGoal.set(0, 4, Math.min(R * 0.5, 3));
			targetGoal.copy(homeTarget);
			distGoal = homeDist;
			return;
		}
		const p = it.group.position;
		const side = new Vector3(
			camera.position.x - p.x,
			0,
			camera.position.z - p.z,
		).normalize();
		const right = new Vector3(side.z, 0, -side.x);
		const mainR = it.plan.islands[0].radius;
		robotGoal.set(
			p.x + right.x * (mainR + 0.7) + side.x * 0.8,
			p.y + it.labelHeight * 0.6 + 0.5,
			p.z + right.z * (mainR + 0.7) + side.z * 0.8,
		);
		if (overview) return;
		targetGoal.set(p.x, p.y + 0.4, p.z);
		distGoal = Math.max(7, Math.min(homeDist * 0.6, it.plan.extent * 1.6 + 4));
	}

	const size = new Vector2(1, 1);
	let narrow = 1;
	function resize() {
		const w = Math.max(1, container.clientWidth);
		const h = Math.max(1, container.clientHeight);
		size.set(w, h);
		renderer.setPixelRatio(pixelRatio());
		renderer.setSize(w, h, false);
		post.setSize(w, h);
		camera.aspect = w / h;
		// 竖屏时把镜头拉远，整片群岛都能装进画面
		narrow = w / h < 1 ? 1 + (1 - w / h) * 1.5 : 1;
		camera.updateProjectionMatrix();
	}
	const ro =
		typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
	ro?.observe(container);
	resize();
	camera.position
		.sub(controls.target)
		.setLength(homeDist * narrow)
		.add(controls.target);

	const ray = new Raycaster();
	const ndc = new Vector2();
	const hitTargets = [...archs.flatMap((it) => it.hits), bot.hit];
	function pick(ev) {
		const rect = renderer.domElement.getBoundingClientRect();
		ndc.set(
			((ev.clientX - rect.left) / rect.width) * 2 - 1,
			-((ev.clientY - rect.top) / rect.height) * 2 + 1,
		);
		ray.setFromCamera(ndc, camera);
		const hits = ray.intersectObjects(hitTargets, false);
		return hits.length ? hits[0].object : null;
	}
	let down = null;
	const onDown = (ev) => {
		down = { x: ev.clientX, y: ev.clientY };
	};
	const onUp = (ev) => {
		if (!down) return;
		const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
		down = null;
		if (moved > 6) {
			userTookCamera = true;
			return;
		}
		const obj = pick(ev);
		if (!obj) return;
		if (obj.userData.robot) opts.onRobot?.();
		else choose(obj.userData.worldId);
	};
	const onDbl = (ev) => {
		const obj = pick(ev);
		if (obj && obj.userData.worldId != null)
			opts.onEnter?.(obj.userData.worldId);
	};
	const onMove = (ev) => {
		if (down) return;
		const obj = pick(ev);
		hovered =
			obj && obj.userData.worldId != null
				? obj.userData.worldId
				: obj
					? "robot"
					: null;
		renderer.domElement.style.cursor = hovered != null ? "pointer" : "grab";
	};
	const onStart = () => {
		controls.autoRotate = false;
	};
	const onWheel = () => {
		userTookCamera = true;
	};
	const canvas = renderer.domElement;
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("dblclick", onDbl);
	canvas.addEventListener("wheel", onWheel, { passive: true });
	controls.addEventListener("start", onStart);

	// 逐级降画质：高→中（去环境光遮蔽、倒影降分辨率）→低（不走后期、关阴影、水面换镜面材质）→限帧
	function setTier(next) {
		if (next === tier) return;
		tier = next;
		post.dispose();
		if (tier === "low") {
			renderer.shadowMap.enabled = false;
			key.castShadow = false;
			scene.remove(pool.mesh);
			pool.dispose();
			pool = createPool(R, { reflect: false });
			scene.add(pool.mesh);
		}
		post = createPost(renderer, scene, camera, tier);
		resize();
		applyAtmosphere();
	}
	const smokeRand = seededRandom(404);
	const tmp = new Vector3();
	const tmp2 = new Vector3();
	let raf = 0;
	let last = performance.now();
	let elapsed = 0;
	let active = true;
	let slowFrames = 0;
	let minGap = tier === "low" ? 1000 / 30 : 0;
	let smokeClock = 0;
	let atmoClock = 0;
	function degrade(cost) {
		slowFrames = cost > 42 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
		if (slowFrames < 14) return;
		slowFrames = 0;
		const i = TIER_ORDER.indexOf(tier);
		if (i < TIER_ORDER.length - 1) {
			setTier(TIER_ORDER[i + 1]);
			if (tier === "low") minGap = 1000 / 30;
		} else if (minGap < 1000 / 4) {
			minGap = Math.max(minGap * 2, 1000 / 15);
		}
	}

	function placeLabel(el, world, w, h, z) {
		tmp2.copy(world).project(camera);
		const visible =
			tmp2.z < 1 && Math.abs(tmp2.x) < 1.1 && Math.abs(tmp2.y) < 1.1;
		el.style.visibility = visible ? "visible" : "hidden";
		if (!visible) return;
		const x = (tmp2.x * 0.5 + 0.5) * w;
		const y = (-tmp2.y * 0.5 + 0.5) * h;
		el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
		el.style.zIndex = String(z + 1000 - Math.round(tmp2.z * 900));
	}

	function frame(now) {
		raf = requestAnimationFrame(frame);
		if (!active || document.hidden) {
			last = now;
			return;
		}
		if (minGap && now - last < minGap) return;
		// 帧间隔比单测 render() 耗时可靠：GPU 进程里的光栅化不计入主线程同步耗时
		const gap = now - last;
		const dt = Math.min(0.05, gap / 1000);
		last = now;
		elapsed += dt;
		const motion = reduced ? 0 : 1;
		const mdt = dt * motion;
		const ease = reduced ? 1 : 1 - Math.exp(-dt * 2.6);

		atmoClock += dt;
		if (atmoClock > 30) {
			atmoClock = 0;
			atmo = atmosphereFor(new Date(), worlds);
			applyAtmosphere();
		}

		for (const it of archs) {
			const isSel = String(it.world.id) === String(selectedId);
			const isHover = String(it.world.id) === String(hovered);
			it.lift += ((isSel ? 0.35 : isHover ? 0.15 : 0) - it.lift) * ease;
			it.group.position.y =
				it.baseY + it.lift + Math.sin(elapsed * 0.6 + it.phase) * 0.08 * motion;
			for (const c of it.crystals) {
				const u = c.userData;
				const a = u.angle + elapsed * 0.25 * motion;
				c.position.set(
					Math.cos(a) * u.radius,
					u.height + Math.sin(elapsed * 1.2 + u.angle) * 0.08,
					Math.sin(a) * u.radius,
				);
				c.rotation.y += mdt * 1.2;
			}
			for (const s of it.movers) {
				s.position.y =
					s.userData.baseY +
					Math.sin(elapsed * 0.9 + s.position.x) * 0.05 * motion;
				s.rotation.y += mdt * 0.15;
			}
			for (const f of it.flags)
				f.rotation.y = Math.sin(elapsed * 3 + f.position.x) * 0.35 * motion;
			if (motion) for (const wk of it.walkers) wk.update(dt, elapsed);
		}
		fallMat.uniforms.time.value = elapsed * motion;
		M.crystal.emissiveIntensity =
			guideState === "thinking"
				? 1.6 + Math.sin(elapsed * 6) * 0.8
				: 1.3 + Math.sin(elapsed * 1.4) * 0.2;

		smokeClock += mdt;
		if (smokeClock > 0.35) {
			smokeClock = 0;
			const it = archs[Math.floor(smokeRand() * archs.length)];
			if (it?.chimneys.length) {
				const c = it.chimneys[Math.floor(smokeRand() * it.chimneys.length)];
				smoke.spawn(it.group.localToWorld(tmp.copy(c)), smokeRand);
			}
		}
		smoke.update(mdt, palette.hemiSky);
		splash.update(elapsed * motion);
		clouds.update(mdt, elapsed * motion);
		birds.update(elapsed * motion);
		fireflies.update(elapsed * motion, Math.max(0, palette.lit - 0.2) * 1.1);
		rain.update(mdt, palette.rain);
		sky.tick(elapsed);
		pool.tick(elapsed * motion);

		bot.robot.position.lerp(robotGoal, reduced ? 1 : 1 - Math.exp(-dt * 1.6));
		bot.robot.position.y += Math.sin(elapsed * 2.1) * 0.003 * motion;
		tmp.set(camera.position.x, bot.robot.position.y, camera.position.z);
		bot.robot.lookAt(tmp);
		const thinking = guideState === "thinking";
		const talking = guideState === "talking";
		bot.drop.rotation.y += dt * (thinking ? 7 : 0.6) * motion;
		bot.head.rotation.x = talking ? Math.sin(elapsed * 9) * 0.07 * motion : 0;
		bot.eyeMat.emissiveIntensity = thinking
			? 1.2 + Math.sin(elapsed * 6) * 0.9
			: 1.8;
		const blink = !reduced && elapsed % 4.2 < 0.12;
		for (const e of bot.eyes) e.scale.y = blink ? 0.15 : 1;
		bot.halo.material.opacity = thinking ? 0.9 : 0.5;
		bot.halo.scale.setScalar(
			1 + Math.sin(elapsed * (thinking ? 5 : 1.6)) * 0.08 * motion,
		);
		for (const [i, a] of bot.arms.entries())
			a.position.y =
				0.03 + Math.sin(elapsed * 2.4 + i * Math.PI) * 0.02 * motion;

		if (!userTookCamera) {
			// 镜头与观察点一起平移，再沿视线推拉到目标距离，视角高度不变
			tmp.copy(controls.target);
			controls.target.lerp(targetGoal, ease * 0.8);
			camera.position.add(tmp.subVectors(controls.target, tmp));
			const off = tmp.subVectors(camera.position, controls.target);
			const len = off.length();
			off.setLength(len + (distGoal * narrow - len) * ease * 0.6);
			camera.position.copy(controls.target).add(off);
		}
		controls.update(dt);
		const t0 = performance.now();
		post.render(dt);
		degrade(Math.max(performance.now() - t0, gap - minGap));

		const w = size.x;
		const h = size.y;
		for (const it of archs) {
			tmp.set(0, it.labelHeight, 0);
			it.group.localToWorld(tmp);
			placeLabel(it.label, tmp, w, h, 1000);
			const isSel = !overview && String(it.world.id) === String(selectedId);
			for (const d of it.details) {
				if (!isSel) {
					d.el.style.visibility = "hidden";
					continue;
				}
				if (d.walker) {
					d.walker.group.getWorldPosition(tmp);
					tmp.y += 0.3;
				} else {
					tmp.copy(d.anchor);
					it.group.localToWorld(tmp);
				}
				placeLabel(d.el, tmp, w, h, 0);
			}
		}
	}
	raf = requestAnimationFrame(frame);

	return {
		get atmosphere() {
			return atmo;
		},
		get quality() {
			return tier;
		},
		setSelected(id) {
			if (id != null && String(id) !== String(selectedId)) selectCount += 1;
			overview = selectCount <= 1;
			selectedId = id;
			userTookCamera = false;
			for (const it of archs) {
				const on = String(it.world.id) === String(id);
				it.label.classList.toggle("is-selected", on);
				it.label.setAttribute("aria-pressed", on ? "true" : "false");
			}
			aim();
		},
		setGuideState(state) {
			guideState = state || "idle";
		},
		setActive(on) {
			active = !!on;
		},
		focusLabel(id) {
			archById(id)?.label.focus({ preventScroll: true });
		},
		dispose() {
			cancelAnimationFrame(raf);
			ro?.disconnect();
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("dblclick", onDbl);
			canvas.removeEventListener("wheel", onWheel);
			controls.removeEventListener("start", onStart);
			controls.dispose();
			post.dispose();
			pool.dispose();
			clouds.dispose();
			disposeTree(scene);
			soft.dispose();
			renderer.dispose();
			canvas.remove();
			labelLayer.remove();
		},
	};
}

function isSoftwareRenderer(renderer) {
	try {
		const gl = renderer.getContext();
		const ext = gl.getExtension("WEBGL_debug_renderer_info");
		const name = String(
			gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "",
		);
		return /swiftshader|llvmpipe|software|basic render/i.test(name);
	} catch (_e) {
		return false;
	}
}

// 探测 WebGL：不可用时开始界面退回纯列表，不让整页白屏
export function webglAvailable() {
	try {
		const c = document.createElement("canvas");
		return !!(c.getContext("webgl2") || c.getContext("webgl"));
	} catch (_e) {
		return false;
	}
}
