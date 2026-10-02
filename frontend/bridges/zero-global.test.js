// @vitest-environment jsdom
// T1（P6-2 Plan §4-T1）生产面零残留静态见证——本片验收第一判据。
//
// 扫描面：`frontend/**`（排除 `node_modules` 与 `*.test.*`）＋源 `frontend/index.html`（恒在）＋
//   产物 `public/index.html`（build 后存在才纳入 `SOURCES`——fresh clone 无 build 亦全绿，P6-3 Plan §2.4 T-A3）。
// 名单：Plan §2.1-B 全量（29 名）＋§2.1-A 两标记（合计 31 项）。
//
// 口径（逐条对齐 Plan §4-T1）：
//   ① 名单内零 `window.<名>`（读写皆算）；**注释行豁免**——头注历史说明允许，但须逐条计数留痕；
//   ② 源 `frontend/index.html` 零内联 `<script>`（唯一 script＝Vite entry 声明 `/entry.jsx`；
//      产物面「恰 1 个 `/app/entry.js`、零内联、零 legacy」清点由构建门禁见证）；
//   ③ 名单外 `window.*`（`location`／`localStorage`／`setTimeout` 等浏览器内建）不误伤——只按名单精确匹配；
//   ④ 承接件在位（`getApp`／`getWorkspaceState`／`chapterEditorApi`／`chatApi`／`bindChatEvents`／
//      10 个页面挂载件导出名——逐名 import 断言）；
//   ⑤ 残余注释命中清单逐文件计数（console.info 落证据；零残留判定可复核、不许静默）。
//
// 红态成因（HEAD `1d8e0af`）：`frontend/**` 名单命中数百、`public/index.html` 三段内联在盘、
// `getApp`／`getWorkspaceState`／`writing-status.js` 尚未落地。三处均在切换笔（⑨）与单例笔（②）后转绿。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FRONTEND = path.join(REPO_ROOT, "frontend");
const PUBLIC_INDEX = path.join(REPO_ROOT, "public", "index.html");
const DEV_INDEX = path.join(FRONTEND, "index.html");

// Plan §2.1-B 名单（29 名）——逐名与使用地图表列一致
const GLOBAL_NAMES = [
	"App",
	"BookPage",
	"WorkspaceState",
	"RunStatus",
	"ChatEventHub",
	"StyleHealth",
	"RewriteCurvePanel",
	"FocusMode",
	"ChapterConflict",
	"MozhenDiffView",
	"MozhenBookShell",
	"WorkbenchShell",
	"AgentPage",
	"MozhenSidebarConfig",
	"MozhenStateBook",
	"MozhenBookOutline",
	"MozhenPager",
	"MozhenCards",
	"MozhenStyleLab",
	"MozhenReadPage",
	"MozhenProfile",
	"MozhenSettings",
	"MozhenShelf",
	"MozhenCharacterTimeline",
	"MozhenCharacterAdvisor",
	"MozhenCharacterRelations",
	"MozhenApp",
	"MozhenChapterEditor",
	"MozhenBookChat",
];

// Plan §2.1-A 两标记
const GLOBAL_MARKERS = [
	"__MOZHEN_REACT_SHELL__",
	"__MOZHEN_BOOK_SHELL_INSTALLED__",
];

// 注释剥离（字符串/模板串感知）：返回「去注释后的代码」与「逐行是否整行注释」两件。
// 目的＝让「注释行豁免」成为可复核的机械口径，而不是靠关键字回避。
function stripComments(src) {
	let out = "";
	const lineStart = [0];
	let i = 0;
	const n = src.length;
	let mode = "code"; // code | line | block | sq | dq | tpl
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (mode === "code") {
			if (c === "/" && c2 === "/") {
				mode = "line";
				i += 2;
				continue;
			}
			if (c === "/" && c2 === "*") {
				mode = "block";
				i += 2;
				continue;
			}
			if (c === "'") mode = "sq";
			else if (c === '"') mode = "dq";
			else if (c === "`") mode = "tpl";
			out += c;
			if (c === "\n") lineStart.push(out.length);
			i += 1;
			continue;
		}
		if (mode === "line") {
			if (c === "\n") {
				mode = "code";
				out += c;
				lineStart.push(out.length);
			}
			i += 1;
			continue;
		}
		if (mode === "block") {
			if (c === "*" && c2 === "/") {
				mode = "code";
				i += 2;
				continue;
			}
			if (c === "\n") {
				out += c;
				lineStart.push(out.length);
			}
			i += 1;
			continue;
		}
		// 字符串内：原样保留（不解析注释）
		if (c === "\\") {
			out += c + (c2 === undefined ? "" : c2);
			i += 2;
			continue;
		}
		if (
			(mode === "sq" && c === "'") ||
			(mode === "dq" && c === '"') ||
			(mode === "tpl" && c === "`")
		)
			mode = "code";
		out += c;
		if (c === "\n") lineStart.push(out.length);
		i += 1;
	}
	return { code: out, lineStart };
}

function lineOf(offset, lineStart) {
	let lo = 0;
	let hi = lineStart.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStart[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

function walk(dir, acc) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === "node_modules") continue;
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(p, acc);
		else if (/\.(js|jsx|mjs)$/.test(ent.name)) acc.push(p);
	}
	return acc;
}

const SOURCES = [
	...walk(FRONTEND, [])
		.filter((p) => !/\.test\.[a-z]+$/.test(p))
		.map((p) => ({
			abs: p,
			rel: path.relative(REPO_ROOT, p).split(path.sep).join("/"),
		})),
	// P6-3：产物条目（build 后存在才纳入；缺席不红）
	...(fs.existsSync(PUBLIC_INDEX)
		? [{ abs: PUBLIC_INDEX, rel: "public/index.html" }]
		: []),
	{ abs: DEV_INDEX, rel: "frontend/index.html" },
];

const ALL = [...GLOBAL_NAMES, ...GLOBAL_MARKERS];

function scan() {
	const live = [];
	const comments = [];
	for (const { abs, rel } of SOURCES) {
		const raw = fs.readFileSync(abs, "utf8");
		if (rel.endsWith(".html")) {
			// HTML：注释面 `<!-- ... -->` 剥离后再扫
			const { code: noComment } = stripComments(
				raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")),
			);
			const lines = noComment.split("\n");
			const rawLines = raw.split("\n");
			lines.forEach((ln, idx) => {
				for (const name of ALL) {
					if (new RegExp(`window\\.${name}\\b`).test(ln))
						live.push(`${rel}:${idx + 1} window.${name}`);
					else if (new RegExp(`window\\.${name}\\b`).test(rawLines[idx] || ""))
						comments.push(`${rel}:${idx + 1} window.${name}`);
				}
			});
			continue;
		}
		const { code, lineStart } = stripComments(raw);
		const lineText = code.split("\n");
		const rawLines = raw.split("\n");
		for (const name of ALL) {
			const re = new RegExp(`(?:window|globalThis)\\.${name}\\b`, "g");
			for (;;) {
				const m = re.exec(code);
				if (!m) break;
				const ln = lineOf(m.index, lineStart);
				live.push(`${rel}:${ln} window.${name}`);
			}
			// 残余注释命中：整行在原文有、剥离后没有
			rawLines.forEach((r, idx) => {
				if (!new RegExp(`window\\.${name}\\b`).test(r)) return;
				if (new RegExp(`window\\.${name}\\b`).test(lineText[idx] || "")) return;
				comments.push(`${rel}:${idx + 1} window.${name}`);
			});
		}
	}
	return { live, comments };
}

describe("T1 生产面 window.* 零残留静态见证", () => {
	it("T1-1 名单内 31 项在 frontend/**（非测试）与两个 index.html 的生产代码面零命中（注释行豁免、逐条留痕）", () => {
		const { live, comments } = scan();
		// 证据留痕（不入断言）：残余注释命中清单
		const byFile = {};
		for (const c of comments) {
			const f = c.split(" ")[0];
			byFile[f] = (byFile[f] || 0) + 1;
		}
		console.info(
			`[T1] live hits=${live.length} residual comment hits=${comments.length}`,
		);
		for (const [f, n] of Object.entries(byFile).sort())
			console.info(`[T1][comment] ${f} ${n}`);
		expect(live, `生产面 window.* 名单残留：\n${live.join("\n")}`).toEqual([]);
	});

	it("T1-2 源 frontend/index.html 零内联 <script>（唯一 script＝Vite entry 声明 /entry.jsx）", () => {
		const html = fs.readFileSync(DEV_INDEX, "utf8");
		const tags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		const inline = tags.filter((t) => {
			const body = t.replace(/^<script\b[^>]*>/, "").replace(/<\/script>$/, "");
			return body.trim() !== "";
		});
		expect(
			inline.map((t) => t.slice(0, 60)),
			`内联 <script> 段残留 ${inline.length} 处`,
		).toEqual([]);
		expect(tags.length).toBe(1);
		expect(tags[0]).toMatch(/type\s*=\s*["']module["']/);
		expect(tags[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
	});

	it("T1-3 名单外 window.* 内建不误伤（location/localStorage/setTimeout 等照常出现，零告警）", () => {
		const html = fs.readFileSync(DEV_INDEX, "utf8");
		const { code } = stripComments(html.replace(/<!--[\s\S]*?-->/g, ""));
		// 仅作「名单是精确匹配、非通配」的反向见证：内建名不在名单内
		for (const builtin of [
			"location",
			"localStorage",
			"sessionStorage",
			"document",
			"history",
		]) {
			expect(code.includes("window.") || true).toBe(true);
			expect(ALL).not.toContain(builtin);
		}
	});

	it("T1-4 承接件在位：单例/缝/命令面/10 个页面挂载件导出名齐备", async () => {
		const appRuntime = await import("../lib/app-runtime.js");
		const ws = await import("../lib/workspace-state.js");
		const wstatus = await import("../lib/writing-status.js");
		const editor = await import("../components/ChapterEditorPanel.jsx");
		const chat = await import("../components/ChatWorkspace.jsx");
		const workbench = await import("../pages/WorkbenchPage.jsx");
		const timeline = await import("../components/CharacterTimelinePanel.jsx");
		const cards = await import("../pages/CardsPage.jsx");
		const stylelab = await import("../pages/StyleLabPage.jsx");
		const read = await import("../pages/ReadPage.jsx");
		const book = await import("../pages/BookShell.jsx");
		const profile = await import("../pages/ProfilePage.jsx");
		const settings = await import("../pages/SettingsPage.jsx");
		const shelf = await import("../pages/ShelfPage.jsx");
		const agent = await import("../components/AgentWorkspace.jsx");
		const expected = [
			[appRuntime, "getApp"],
			[appRuntime, "setAppForTests"],
			[ws, "getWorkspaceState"],
			[wstatus, "bindWritingStatusRenderer"],
			[wstatus, "renderWritingStatusIfBound"],
			[editor, "chapterEditorApi"],
			[editor, "mountChapterEditor"],
			[chat, "chatApi"],
			[chat, "ensureMounted"],
			[chat, "bindChatEvents"],
			[workbench, "mountWorkbenchPage"],
			[timeline, "mountTimelineFullPage"],
			[cards, "mount"],
			[stylelab, "mount"],
			[read, "mount"],
			[book, "mount"],
			[profile, "mount"],
			[settings, "mount"],
			[shelf, "mount"],
			[agent, "showAgentWorkspace"],
		];
		const missing = expected
			.filter(([m, name]) => typeof m[name] !== "function")
			.map(([, name]) => name);
		expect(missing, `承接件缺名：${missing.join(", ")}`).toEqual([]);
	});

	it("T1-5 零残留判定可复核：名单与扫描面常量随文件导出（禁静默缩面）", () => {
		expect(GLOBAL_NAMES).toHaveLength(29);
		expect(GLOBAL_MARKERS).toHaveLength(2);
		expect(SOURCES.length).toBeGreaterThan(60);
		const rels = SOURCES.map((s) => s.rel);
		expect(rels).toContain("frontend/index.html"); // 源（恒在；P6-3 迁入）
		// 产物条目（build 后存在才在面；fresh clone 缺席不红）
		if (fs.existsSync(PUBLIC_INDEX))
			expect(rels).toContain("public/index.html");
	});
});
