// 砚灵：瓷白小机器人，青色眼灯，天线顶端一滴鎏金墨。
import {
	CapsuleGeometry,
	ConeGeometry,
	CylinderGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	SphereGeometry,
	TorusGeometry,
} from "three";

const EYE = 0x62e6d4;

export function buildRobot() {
	const robot = new Group();
	const porcelain = new MeshPhysicalMaterial({
		color: 0xf3f5f1,
		roughness: 0.3,
		clearcoat: 0.8,
	});
	const gilt = new MeshStandardMaterial({
		color: 0xc9a24a,
		metalness: 0.75,
		roughness: 0.32,
	});
	const eyeMat = new MeshStandardMaterial({
		color: EYE,
		emissive: EYE,
		emissiveIntensity: 1.8,
	});

	const body = new Mesh(new CapsuleGeometry(0.13, 0.14, 6, 14), porcelain);
	body.castShadow = true;
	const belt = new Mesh(new TorusGeometry(0.135, 0.016, 8, 28), gilt);
	belt.rotation.x = Math.PI / 2;
	belt.position.y = 0.02;

	const head = new Group();
	head.position.y = 0.34;
	const skull = new Mesh(new SphereGeometry(0.17, 24, 18), porcelain);
	skull.castShadow = true;
	const visor = new Mesh(
		new SphereGeometry(
			0.176,
			24,
			16,
			-Math.PI * 0.36,
			Math.PI * 0.72,
			Math.PI * 0.3,
			Math.PI * 0.36,
		),
		new MeshPhysicalMaterial({ color: 0x17202b, roughness: 0.1, clearcoat: 1 }),
	);
	// 面罩半径须大于头壳（0.17），否则被头壳整个包住看不见
	visor.rotation.y = Math.PI / 2;
	const eyes = [];
	for (const x of [-0.055, 0.055]) {
		const eye = new Mesh(new CapsuleGeometry(0.016, 0.026, 4, 8), eyeMat);
		eye.position.set(x, 0.015, 0.172);
		eyes.push(eye);
		head.add(eye);
	}
	const stalk = new Mesh(new CylinderGeometry(0.008, 0.008, 0.12, 6), gilt);
	stalk.position.y = 0.22;
	const drop = new Group();
	drop.position.y = 0.3;
	const dropBall = new Mesh(new SphereGeometry(0.03, 14, 10), gilt);
	const dropTip = new Mesh(new ConeGeometry(0.026, 0.05, 14), gilt);
	dropTip.position.y = 0.035;
	drop.add(dropBall, dropTip);
	head.add(skull, visor, stalk, drop);

	const arms = [];
	for (const side of [-1, 1]) {
		const arm = new Mesh(new SphereGeometry(0.045, 12, 10), gilt);
		arm.position.set(side * 0.18, 0.03, 0.02);
		arms.push(arm);
		robot.add(arm);
	}
	const halo = new Mesh(
		new TorusGeometry(0.17, 0.008, 6, 40),
		new MeshBasicMaterial({ color: EYE, transparent: true, opacity: 0.55 }),
	);
	halo.rotation.x = Math.PI / 2;
	halo.position.y = -0.24;

	const hit = new Mesh(
		new SphereGeometry(0.42, 8, 6),
		new MeshBasicMaterial({ visible: false }),
	);
	hit.position.y = 0.15;
	hit.userData.robot = true;

	robot.add(body, belt, head, halo, hit);
	return { robot, head, eyes, drop, arms, halo, hit, eyeMat };
}
