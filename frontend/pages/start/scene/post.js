// 后期：高画质＝环境光遮蔽＋泛光＋移轴微缩；中画质去掉环境光遮蔽；低画质直接渲染不走合成器。
import { Vector2 } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { HorizontalTiltShiftShader } from "three/addons/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/addons/shaders/VerticalTiltShiftShader.js";

export function createPost(renderer, scene, camera, tier) {
	if (tier === "low") {
		return {
			tier,
			render() {
				renderer.render(scene, camera);
			},
			setSize() {},
			setBloom() {},
			dispose() {},
		};
	}
	const size = renderer.getSize(new Vector2());
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	let ao = null;
	if (tier === "high") {
		ao = new GTAOPass(scene, camera, size.x, size.y);
		ao.updateGtaoMaterial({
			radius: 0.35,
			distanceExponent: 1.6,
			thickness: 1.2,
			scale: 1.1,
			samples: 12,
		});
		ao.blendIntensity = 0.85;
		composer.addPass(ao);
	}
	const bloom = new UnrealBloomPass(
		new Vector2(size.x, size.y),
		0.55,
		0.55,
		0.86,
	);
	composer.addPass(bloom);
	const hTilt = new ShaderPass(HorizontalTiltShiftShader);
	const vTilt = new ShaderPass(VerticalTiltShiftShader);
	hTilt.uniforms.r.value = 0.52;
	vTilt.uniforms.r.value = 0.52;
	composer.addPass(hTilt);
	composer.addPass(vTilt);
	composer.addPass(new OutputPass());

	const setSize = (w, h) => {
		composer.setPixelRatio(renderer.getPixelRatio());
		composer.setSize(w, h);
		hTilt.uniforms.h.value = 1.6 / w;
		vTilt.uniforms.v.value = 1.6 / h;
	};
	setSize(size.x, size.y);
	return {
		tier,
		render(dt) {
			composer.render(dt);
		},
		setSize,
		// 夜里灯火多，泛光阈值放低一点，窗灯与萤火才晕得开
		setBloom(strength, threshold) {
			bloom.strength = strength;
			bloom.threshold = threshold;
		},
		dispose() {
			ao?.dispose();
			bloom.dispose();
			composer.dispose();
		},
	};
}
