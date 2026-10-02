// P6-3 红测 T2（Plan §4 T2）：Vite HTML 入口配置契约——`index.html` 改由 Vite 生成/注入。
//
// 口径：读**真实** `vite.config.mjs`（dev-proxy.test.mjs:76 同款 import），断言语义（Plan §3-2）：
//   ① `root:'frontend'`／`base:'/'`／`build.outDir:'../public'`（解析为仓根 `public/`）；
//   ② 产物命名 `assetsDir:'app/assets'`／`entryFileNames:'app/entry.js'` ⇒ 服务面 URL 仍
//      `/app/entry.js`（与入场逐字相同，驱动零改）；
//   ③ **安全联锁**：`emptyOutDir !== true`——置 true 会清掉 `public/legacy/**`（4 件死锚点）与
//      `public/style.css`（灾难面，Plan §1.2-5）；且 outDir 解析不得为仓根。
//   ④ dev 代理键零改（5 条存量路径正则键，dev-proxy.test.mjs T2 同口径）。
//
// 红态成因（HEAD `cb9b22b`）：`base:'/app/'`／`outDir:'../public/app'`／`emptyOutDir:true`
// ⇒ T2-1／T2-3 结构性红；T2-2（代理键）对旧配置即绿（守恒现状，防本片误改 dev 面）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const loadedConfig = (await import("../../vite.config.mjs")).default;

describe("T2 Vite HTML 入口配置契约（index.html 产物化）", () => {
	it("T2-1 形状：root/base/outDir/assetsDir/entryFileNames/publicDir 逐条", () => {
		expect(loadedConfig.root).toBe("frontend");
		expect(loadedConfig.base).toBe("/");
		expect(
			path.resolve(REPO_ROOT, loadedConfig.root, loadedConfig.build.outDir),
		).toBe(path.join(REPO_ROOT, "public"));
		expect(loadedConfig.build.emptyOutDir).toBe(false);
		expect(loadedConfig.build.assetsDir).toBe("app/assets");
		expect(loadedConfig.build.rollupOptions.output.entryFileNames).toBe(
			"app/entry.js",
		);
		expect(loadedConfig.publicDir).toBe(false);
	});

	it("T2-2 dev 代理键零改：恰 1 条正则键覆盖 5 条存量路径，不拦 /app/ 与 /@vite/", () => {
		const keys = Object.keys(loadedConfig.server.proxy);
		expect(keys).toHaveLength(1);
		const re = new RegExp(keys[0]);
		for (const hit of [
			"/api/health",
			"/legacy/x.js",
			"/index.html",
			"/style.css",
			"/favicon.ico",
		]) {
			expect(re.test(hit), `代理键必须命中：${hit}`).toBe(true);
		}
		for (const miss of ["/app/entry.js", "/@vite/client"]) {
			expect(re.test(miss), `代理键不得命中：${miss}`).toBe(false);
		}
	});

	it("T2-3 安全联锁：emptyOutDir 非 true（防清 public/legacy 与 public/style.css）；outDir 解析不为仓根", () => {
		expect(loadedConfig.build.emptyOutDir).not.toBe(true);
		const resolved = path.resolve(
			REPO_ROOT,
			loadedConfig.root,
			loadedConfig.build.outDir,
		);
		expect(resolved).not.toBe(REPO_ROOT);
	});
});
