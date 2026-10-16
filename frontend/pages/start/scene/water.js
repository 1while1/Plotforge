// 砚台与砚池：池面在高画质下是带实时倒影的水（three Water），低画质换成同一张法线贴图的滚动镜面材质。
import {
	BoxGeometry,
	CircleGeometry,
	CylinderGeometry,
	DataTexture,
	Group,
	LatheGeometry,
	LinearMipmapLinearFilter,
	Mesh,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	RepeatWrapping,
	RGBAFormat,
	TorusGeometry,
	Vector2,
	Vector3,
} from "three";
import { Water } from "three/addons/objects/Water.js";

// 可平铺法线贴图：整数频率的正弦叠加，四边无缝
function makeWaterNormals(size = 256) {
	const data = new Uint8Array(size * size * 4);
	const waves = [
		[3, 1, 0.9, 0.3],
		[-2, 4, 0.6, 1.7],
		[5, -3, 0.35, 2.4],
		[1, 7, 0.25, 0.8],
		[-7, -2, 0.2, 4.1],
		[11, 5, 0.12, 5.3],
	];
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let dx = 0;
			let dy = 0;
			const u = (x / size) * Math.PI * 2;
			const v = (y / size) * Math.PI * 2;
			for (const [kx, ky, amp, ph] of waves) {
				const c = Math.cos(kx * u + ky * v + ph) * amp;
				dx += c * kx;
				dy += c * ky;
			}
			const n = new Vector3(-dx * 0.08, -dy * 0.08, 1).normalize();
			const i = (y * size + x) * 4;
			data[i] = (n.x * 0.5 + 0.5) * 255;
			data[i + 1] = (n.y * 0.5 + 0.5) * 255;
			data[i + 2] = (n.z * 0.5 + 0.5) * 255;
			data[i + 3] = 255;
		}
	}
	const tex = new DataTexture(data, size, size, RGBAFormat);
	tex.wrapS = RepeatWrapping;
	tex.wrapT = RepeatWrapping;
	tex.generateMipmaps = true;
	tex.minFilter = LinearMipmapLinearFilter;
	tex.needsUpdate = true;
	return tex;
}

export function createPool(radius, { reflect }) {
	const normals = makeWaterNormals();
	const geometry = new CircleGeometry(radius, 96);
	let mesh;
	let mode;
	if (reflect) {
		mesh = new Water(geometry, {
			textureWidth: 512,
			textureHeight: 512,
			waterNormals: normals,
			sunDirection: new Vector3(0.5, 0.8, 0.3),
			sunColor: 0xffffff,
			waterColor: 0x1d4a58,
			distortionScale: 1.6,
			fog: true,
		});
		mesh.material.uniforms.size.value = 2.4;
		mode = "reflect";
	} else {
		normals.repeat.set(radius / 3, radius / 3);
		mesh = new Mesh(
			geometry,
			new MeshPhysicalMaterial({
				color: 0x1d4a58,
				roughness: 0.12,
				metalness: 0.1,
				clearcoat: 1,
				clearcoatRoughness: 0.08,
				normalMap: normals,
				normalScale: new Vector2(0.35, 0.35),
			}),
		);
		mode = "simple";
	}
	mesh.rotation.x = -Math.PI / 2;
	mesh.position.y = 0;
	// Water 着色器把阴影乘在整个散射项上，岛影会在水面压成死黑的一块，所以倒影模式不收阴影
	mesh.receiveShadow = mode !== "reflect";
	return {
		mesh,
		mode,
		apply(pal, light) {
			if (mode === "reflect") {
				const u = mesh.material.uniforms;
				u.sunDirection.value.copy(light.dir);
				u.sunColor.value.copy(pal.key).multiplyScalar(light.moon ? 0.5 : 1);
				u.waterColor.value.copy(pal.water);
			} else {
				mesh.material.color.copy(pal.water);
			}
		},
		tick(t) {
			if (mode === "reflect") mesh.material.uniforms.time.value = t * 0.35;
			else normals.offset.set(t * 0.012, t * 0.008);
		},
		dispose() {
			normals.dispose();
			mesh.material.dispose();
			mesh.geometry.dispose();
			if (mode === "reflect") mesh.onBeforeRender = () => {};
		},
	};
}

// 砚台：池沿石唇＋鎏金嵌线＋向下收窄的砚身（没入云海），再斜搁一锭墨
export function createInkstone(radius) {
	const group = new Group();
	const stone = new MeshStandardMaterial({ color: 0x2c3541, roughness: 0.88 });
	const rimMat = new MeshStandardMaterial({ color: 0x3b4655, roughness: 0.72 });
	const gilt = new MeshStandardMaterial({
		color: 0xc9a24a,
		metalness: 0.85,
		roughness: 0.32,
		emissive: 0x3a2a08,
		emissiveIntensity: 0.4,
	});

	const profile = [
		new Vector2(radius - 0.05, 0.02),
		new Vector2(radius + 0.55, 0.12),
		new Vector2(radius + 0.95, 0.02),
		new Vector2(radius + 1.05, -0.4),
		new Vector2(radius + 0.7, -1.4),
		new Vector2(radius * 0.55, -2.6),
		new Vector2(radius * 0.18, -3.4),
		new Vector2(0.01, -3.55),
	];
	// LatheGeometry 的面朝向取决于轮廓点顺序：自下而上排列时法线朝外
	const body = new Mesh(new LatheGeometry(profile.reverse(), 96), stone);
	body.receiveShadow = true;
	group.add(body);
	const lip = new Mesh(new TorusGeometry(radius + 0.25, 0.2, 10, 128), rimMat);
	lip.rotation.x = Math.PI / 2;
	lip.position.y = 0.06;
	lip.receiveShadow = true;
	group.add(lip);
	const inlay = new Mesh(new TorusGeometry(radius + 0.82, 0.03, 6, 160), gilt);
	inlay.rotation.x = Math.PI / 2;
	inlay.position.y = 0.06;
	group.add(inlay);
	const floor = new Mesh(new CylinderGeometry(radius, radius, 0.2, 96), stone);
	floor.position.y = -0.5;
	group.add(floor);

	const stick = new Group();
	const bar = new Mesh(
		new BoxGeometry(0.5, 0.24, 2.4),
		new MeshStandardMaterial({ color: 0x14191f, roughness: 0.5 }),
	);
	bar.castShadow = true;
	const band = new Mesh(new BoxGeometry(0.51, 0.245, 0.55), gilt);
	band.position.z = -0.42;
	stick.add(bar, band);
	const a = -Math.PI * 0.2;
	stick.position.set(
		Math.cos(a) * (radius + 0.45),
		0.38,
		Math.sin(a) * (radius + 0.45),
	);
	stick.rotation.set(0.08, -a, 0.14);
	group.add(stick);
	return group;
}
