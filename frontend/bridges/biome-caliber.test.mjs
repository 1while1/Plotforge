// P6-4 红测 T1（plans/P6-4-plan-1.md §4.4）：Biome 非 legacy 全量口径契约（charter §0 裁定 1）——防回退锚。
//
// 口径（vite-index-config.test.mjs 同款：fs 读**真实**配置断言，零依赖新增）：
//   T1-1 biome.json files.includes 圈入 frontend/**、tools/**、test/** 并排除 !frontend/index.html；
//   T1-2 overrides 圈定 tools/**＋test/** 且 formatter.enabled === false
//        （行尾铁律：存量 test/ 163 件 CRLF、tools/ 31 件 CRLF，formatter 开启即强制翻转＝禁）；
//   T1-3 package.json lint-staged 三匹配（frontend/tools/test）均含 biome check（增量必须过检）；
//   T1-4 frontend/index.html 在盘（include 排除≠删除；防未来误删静态壳源）。
//
// 红态成因（HEAD ef475a9）：includes 仅 frontend/**、无 overrides、lint-staged 单匹配 ⇒
// T1-1／T1-2／T1-3 结构性红；T1-4 对现状即绿（守恒现状，防误删锚）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const biomeConfig = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "biome.json"), "utf8"),
);
const packageJson = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);

describe("T1 Biome 非 legacy 全量口径契约（charter §0 裁定 1）", () => {
	it("T1-1 files.includes 圈入 frontend/tools/test 并排除 !frontend/index.html", () => {
		const includes = biomeConfig.files.includes;
		for (const hit of ["frontend/**", "tools/**", "test/**"]) {
			expect(includes).toContain(hit);
		}
		expect(includes).toContain("!frontend/index.html");
	});

	it("T1-2 overrides 圈定 tools/test 且 formatter.enabled === false（存量 CRLF 零翻转）", () => {
		const overrides = biomeConfig.overrides || [];
		const target = overrides.find(
			(o) => o.includes.includes("tools/**") && o.includes.includes("test/**"),
		);
		expect(target).toBeTruthy();
		expect(target.formatter.enabled).toBe(false);
	});

	it("T1-3 lint-staged 三匹配均含 biome check（frontend/tools/test 增量必须过检）", () => {
		const lintStaged = packageJson["lint-staged"];
		for (const key of ["frontend/**/*", "tools/**/*", "test/**/*"]) {
			expect(Array.isArray(lintStaged[key]), `缺匹配键：${key}`).toBe(true);
			expect(lintStaged[key].join(" "), `${key} 必须含 biome check`).toContain(
				"biome check",
			);
		}
	});

	it("T1-4 frontend/index.html 在盘（include 排除≠删除）", () => {
		expect(fs.existsSync(path.join(REPO_ROOT, "frontend", "index.html"))).toBe(
			true,
		);
	});
});
