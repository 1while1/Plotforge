// 天穹与天色：渐变天穹（含日轮光晕与夜星）＋按时刻插值的光照调色板，天气在调色板上再做减饱和与压光。
import {
	BackSide,
	Color,
	Mesh,
	ShaderMaterial,
	SphereGeometry,
	Vector3,
} from "three";

// 关键帧按小时排布，相邻两帧线性插值；颜色全部是 sRGB 十六进制，载入时转线性
const KEYS = [
	{ h: 0, p: "night" },
	{ h: 4.6, p: "night" },
	{ h: 6.1, p: "dawn" },
	{ h: 8.2, p: "day" },
	{ h: 16, p: "day" },
	{ h: 18.2, p: "dusk" },
	{ h: 20.2, p: "night" },
	{ h: 24, p: "night" },
];

const PALETTES = {
	night: {
		top: 0x070d22,
		horizon: 0x283a66,
		bottom: 0x0a1226,
		fog: 0x1c2a4c,
		key: 0x9db4ff,
		keyI: 1.0,
		hemiSky: 0x6a80bc,
		hemiGround: 0x18203a,
		hemiI: 0.95,
		exposure: 1.12,
		stars: 1,
		lit: 1,
		glow: 0.25,
		water: 0x0b1830,
	},
	dawn: {
		top: 0x4f6aa6,
		horizon: 0xf6b68e,
		bottom: 0x6b5f78,
		fog: 0xd9b7a6,
		key: 0xffc59a,
		keyI: 1.9,
		hemiSky: 0xf2d3c4,
		hemiGround: 0x3d3a4c,
		hemiI: 1.0,
		exposure: 1.0,
		stars: 0.15,
		lit: 0.55,
		glow: 0.8,
		water: 0x233448,
	},
	day: {
		top: 0x5d9ad6,
		horizon: 0xd4ecf0,
		bottom: 0x8fb6c4,
		fog: 0xc8e2e6,
		key: 0xfff1d8,
		keyI: 2.7,
		hemiSky: 0xe8f4f6,
		hemiGround: 0x4a5a52,
		hemiI: 1.15,
		exposure: 1.0,
		stars: 0,
		lit: 0,
		glow: 0.45,
		water: 0x1d4a58,
	},
	dusk: {
		top: 0x2f3f7c,
		horizon: 0xf2875a,
		bottom: 0x4b3a5c,
		fog: 0xc98a7a,
		key: 0xff9a62,
		keyI: 1.8,
		hemiSky: 0xe7a98e,
		hemiGround: 0x2e2a40,
		hemiI: 0.95,
		exposure: 1.02,
		stars: 0.3,
		lit: 0.8,
		glow: 1,
		water: 0x2a2a46,
	},
};

const WEATHER = {
	clear: { grey: 0, keyK: 1, fogK: 1, clouds: 1, rain: 0 },
	cloudy: { grey: 0.28, keyK: 0.72, fogK: 0.85, clouds: 1.7, rain: 0 },
	mist: { grey: 0.42, keyK: 0.55, fogK: 0.55, clouds: 1.4, rain: 1 },
};

const COLOR_KEYS = [
	"top",
	"horizon",
	"bottom",
	"fog",
	"key",
	"hemiSky",
	"hemiGround",
	"water",
];
const NUM_KEYS = ["keyI", "hemiI", "exposure", "stars", "lit", "glow"];

const linear = {};
for (const [name, pal] of Object.entries(PALETTES)) {
	linear[name] = {};
	for (const k of COLOR_KEYS) linear[name][k] = new Color(pal[k]);
	for (const k of NUM_KEYS) linear[name][k] = pal[k];
}

const GREY = new Color(0x9aa6ad);

export function paletteAt(hour, weather) {
	const h = ((hour % 24) + 24) % 24;
	let i = 0;
	while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
	const a = KEYS[i];
	const b = KEYS[i + 1];
	const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
	const pa = linear[a.p];
	const pb = linear[b.p];
	const out = {};
	for (const k of COLOR_KEYS) out[k] = pa[k].clone().lerp(pb[k], t);
	for (const k of NUM_KEYS) out[k] = pa[k] + (pb[k] - pa[k]) * t;
	const w = WEATHER[weather] || WEATHER.clear;
	for (const k of ["top", "horizon", "bottom", "fog", "hemiSky"]) {
		const lum = out[k].r * 0.3 + out[k].g * 0.59 + out[k].b * 0.11;
		const g = GREY.clone().multiplyScalar(Math.max(0.15, lum * 1.6));
		out[k].lerp(g, w.grey);
	}
	out.keyI *= w.keyK;
	out.stars *= 1 - w.grey;
	out.glow *= 1 - w.grey * 0.7;
	out.fogK = w.fogK;
	out.clouds = w.clouds;
	out.rain = w.rain;
	return out;
}

// 太阳（白天）或月亮（夜里）方向：方位随时刻绕一圈，仰角压低到 55° 以内，保留斜光的立体感
export function keyLightDir(hour) {
	const h = ((hour % 24) + 24) % 24;
	const day = h >= 5.5 && h < 19.5;
	const k = day ? (h - 5.5) / 14 : ((h + 4.5) % 24) / 10;
	const az = -Math.PI * 0.15 + k * Math.PI * 1.1;
	const el = 0.12 + Math.sin(k * Math.PI) * (day ? 0.85 : 0.7);
	return {
		dir: new Vector3(
			Math.cos(az) * Math.cos(el),
			Math.sin(el),
			Math.sin(az) * Math.cos(el),
		).normalize(),
		moon: !day,
	};
}

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = normalize(position);
	vec4 p = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * p;
	gl_Position.z = gl_Position.w;
}`;

const fragmentShader = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float glow;
uniform float stars;
uniform float moon;
uniform float time;
varying vec3 vDir;
float hash(vec3 p) {
	p = fract(p * 0.3183099 + 0.1);
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
	vec3 d = normalize(vDir);
	float h = d.y;
	vec3 col = h > 0.0
		? mix(horizonColor, topColor, smoothstep(0.0, 0.62, pow(h, 0.8)))
		: mix(horizonColor, bottomColor, smoothstep(0.0, 0.35, -h));
	float s = max(dot(d, sunDir), 0.0);
	float disk = smoothstep(moon > 0.5 ? 0.9993 : 0.9985, 1.0, s);
	col += sunColor * (disk * (moon > 0.5 ? 2.0 : 6.0) + pow(s, 9.0) * 0.45 * glow + pow(s, 80.0) * 0.6 * glow);
	if (stars > 0.0 && h > 0.0) {
		vec3 cell = floor(d * 220.0);
		float r = hash(cell);
		float star = step(0.9965, r) * (0.6 + 0.4 * sin(time * (1.5 + r * 3.0) + r * 40.0));
		col += vec3(star) * stars * smoothstep(0.02, 0.3, h);
	}
	gl_FragColor = vec4(col, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

export function createSky(radius) {
	const material = new ShaderMaterial({
		uniforms: {
			topColor: { value: new Color() },
			horizonColor: { value: new Color() },
			bottomColor: { value: new Color() },
			sunDir: { value: new Vector3(0, 1, 0) },
			sunColor: { value: new Color() },
			glow: { value: 1 },
			stars: { value: 0 },
			moon: { value: 0 },
			time: { value: 0 },
		},
		vertexShader,
		fragmentShader,
		side: BackSide,
		depthWrite: false,
		fog: false,
	});
	const mesh = new Mesh(new SphereGeometry(radius, 48, 24), material);
	mesh.frustumCulled = false;
	mesh.renderOrder = -10;
	return {
		mesh,
		apply(pal, light) {
			const u = material.uniforms;
			u.topColor.value.copy(pal.top);
			u.horizonColor.value.copy(pal.horizon);
			u.bottomColor.value.copy(pal.bottom);
			u.sunDir.value.copy(light.dir);
			u.sunColor.value.copy(pal.key);
			u.glow.value = pal.glow;
			u.stars.value = pal.stars;
			u.moon.value = light.moon ? 1 : 0;
		},
		tick(t) {
			material.uniforms.time.value = t;
		},
	};
}
