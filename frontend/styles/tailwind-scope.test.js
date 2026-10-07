// Tailwind 与旧样式共存的守护：
//   ① 工具类不分层、不引 preflight（旧样式 base.css 等未分层，层内样式会全部输给它；preflight 会重置旧页面）；
//   ② 扫描源只限新代码目录（旧 class 名被扫到会生成同名工具类，反向污染旧页面）；
//   ③ 新代码用到、且 Tailwind 会为其生成工具类的词元，不得与旧样式的 class 名撞名
//      （唯一放行 hidden：两边都是 display:none）。是否「会生成」交给 Tailwind 编译器本身判定。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "lightningcss";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const FRONTEND = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const REPO_ROOT = path.resolve(FRONTEND, "..");
const APP_CSS = fs.readFileSync(
	path.join(FRONTEND, "styles", "app.css"),
	"utf8",
);
const CSS_CODE = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const ALLOWED_SOURCES = ["../components/ui", "../shell"];
const ALLOWED_COLLISIONS = new Set(["hidden"]);

function listFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) return listFiles(full);
		return /\.(jsx?|mjs)$/.test(ent.name) && !/\.test\./.test(ent.name)
			? [full]
			: [];
	});
}

function legacyClassTokens() {
	const tokens = new Set();
	// 旧 class 名的事实源：base.css（原 public/style.css，阶段 5 并入）＋ pages/（阶段 4 迁出）
	const pagesDir = path.join(FRONTEND, "styles", "pages");
	const cssFiles = [
		path.join(FRONTEND, "styles", "base.css"),
		...(fs.existsSync(pagesDir)
			? fs
					.readdirSync(pagesDir)
					.filter((f) => f.endsWith(".css"))
					.map((f) => path.join(pagesDir, f))
			: []),
	];
	for (const file of cssFiles) {
		const css = fs.readFileSync(file, "utf8");
		for (const m of css
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(/\.([a-zA-Z][\w-]*)/g))
			tokens.add(m[1]);
	}
	const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
	for (const m of html.matchAll(/class="([^"]*)"/g))
		for (const t of m[1].split(/\s+/)) if (t) tokens.add(t);
	return tokens;
}

function newCodeTokens() {
	const tokens = new Map();
	for (const rel of ALLOWED_SOURCES) {
		for (const file of listFiles(path.resolve(FRONTEND, "styles", rel))) {
			const src = fs.readFileSync(file, "utf8");
			for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
				for (const t of m[2].split(/\s+/)) {
					if (/^[a-z][\w-]*$/.test(t) && !tokens.has(t))
						tokens.set(t, path.relative(REPO_ROOT, file));
				}
			}
		}
	}
	return tokens;
}

describe("Tailwind 共存守护", () => {
	it("工具类不分层输出、关闭自动扫描、不引入 preflight", () => {
		expect(CSS_CODE).toMatch(
			/@import\s+"tailwindcss\/utilities\.css"\s+source\(none\);/,
		);
		expect(CSS_CODE).not.toMatch(/@import\s+["']tailwindcss["']/);
		expect(CSS_CODE).not.toMatch(/preflight/);
		expect(CSS_CODE).not.toMatch(/layer\(utilities\)/);
	});

	it("扫描源只限新代码目录", () => {
		const sources = [...CSS_CODE.matchAll(/@source\s+["']([^"']+)["']/g)].map(
			(m) => m[1],
		);
		expect(sources).toEqual(ALLOWED_SOURCES);
		expect(CSS_CODE).not.toMatch(/@source\s+not/);
	});

	it("新代码生成的工具类不与旧样式 class 撞名", async () => {
		const legacy = legacyClassTokens();
		const shared = [...newCodeTokens()].filter(
			([t]) => legacy.has(t) && !ALLOWED_COLLISIONS.has(t),
		);
		const compileApp = () =>
			compile(APP_CSS, {
				base: path.join(FRONTEND, "styles"),
				async loadStylesheet(id, base) {
					const file = id.startsWith(".")
						? path.resolve(base, id)
						: path.join(REPO_ROOT, "node_modules", "tailwindcss", "theme.css");
					return {
						path: file,
						base: path.dirname(file),
						content: fs.readFileSync(file, "utf8"),
					};
				},
			});
		// app.css 自带的手写样式（如 book-shell.css）本来就会写旧 class 名；
		// 只把「喂了候选词元后多出来的」选择器算作 Tailwind 生成的工具类。
		const baseline = (await compileApp()).build([]);
		const out = (await compileApp()).build(shared.map(([t]) => t));
		const count = (css, t) =>
			(css.match(new RegExp(`\\.${t}(?![\\w-])`, "g")) || []).length;
		const hits = shared
			.filter(([t]) => count(out, t) > count(baseline, t))
			.map(([t, file]) => `${t}（${file}）`);
		expect(hits, `与旧样式撞名：${hits.join("、")}`).toEqual([]);
	});

	it("全站 .hidden 经编译＋lightningcss 压缩后仍带 !important（不被同名工具类去重吞掉）", async () => {
		const compiled = (
			await compile(APP_CSS, {
				base: path.join(FRONTEND, "styles"),
				async loadStylesheet(id, base) {
					const file = id.startsWith(".")
						? path.resolve(base, id)
						: path.join(REPO_ROOT, "node_modules", "tailwindcss", "theme.css");
					return {
						path: file,
						base: path.dirname(file),
						content: fs.readFileSync(file, "utf8"),
					};
				},
			})
		).build(["hidden"]);
		const minified = transform({
			filename: "app.css",
			code: Buffer.from(compiled),
			minify: true,
		}).code.toString();
		expect(minified).toContain(".hidden{display:none!important}");
	});

	it("守护本身有效：旧样式里的 hidden 会被 Tailwind 生成为工具类", async () => {
		expect(legacyClassTokens().has("hidden")).toBe(true);
		const tw = await compile("@tailwind utilities;", { base: FRONTEND });
		expect(tw.build(["hidden", "tabs"])).toMatch(/\.hidden\b/);
		expect(tw.build(["tabs"])).not.toMatch(/\.tabs\b/);
	});
});
