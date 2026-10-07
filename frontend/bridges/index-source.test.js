// P6-3 红测 T1（Plan §4 T1）：HTML 源契约——静态壳单一事实源 ＝ `frontend/index.html`（Vite HTML entry）。
//
// 口径（Plan §1.1／§2.5-D1）：
//   ① 源内唯一 `<script>` 元素＝Vite 规范的 entry 声明（`/entry.jsx`，dev 源模块，体内空白＝零内联）；
//      **「手工 script 标签清零」判据**＝源内不存在指向构建产物路径（`/app/entry.js`）的手工标签：
//      该字面量的唯一落点是 P6-2 ⑨ 的历史说明注释（恰 1 处，承 zero-global T1 的「注释行豁免」口径）；
//      「产物面恰 1 个 `/app/entry.js` 且由 Vite 注入」由构建门禁（`npm run build` 后清点）见证。
//   ② 壳 DOM 与入场 `public/index.html` 逐字等值（charter §1 红线 3）：`id=` 241 各恰一份／class 唯一
//      词元 187／11 段注释锚逐字在位；**无静态 `#app-root`**（挂载点由 `entry.jsx` 的
//      `resolveMountPoint()` 动态创建——P6-2 后生产与 dev 的统一路径，Plan §2.5-D2-3 备案）。
//   ③ 退役面零残留（`legacy/*.js` 零命中、名单内 `window.*` 注释剥离后零命中）＋样式表全部走构建
//      （UI 优化阶段 5 起源 HTML 零手工 `<link>`，`public/style.css` 已并入 `frontend/styles/base.css`）。
//   ④ 产物不入库：`.gitignore` 含 `/public/index.html`。
//
// 红态成因（HEAD `cb9b22b`）：`frontend/index.html` 为 12 行 dev 壳（静态 `#app-root`、无 11 锚、
// 无 `<link>` 行），产物路径字面量 0 处、`.gitignore` 无 `/public/index.html` ⇒ 四例结构性红。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_PATH = path.join(REPO_ROOT, "frontend", "index.html");
const INDEX_HTML = fs.readFileSync(INDEX_PATH, "utf8");
// HTML 注释剥离：注释行的历史说明豁免（与 zero-global.test.js T1／BookShell R9-2 同口径）
const NO_COMMENT = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");

// Plan §2.1-B 名单（29 名）——逐名与使用地图表列一致（与 zero-global.test.js 同表）
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
const ALL = [...GLOBAL_NAMES, ...GLOBAL_MARKERS];

// §2.5 壳基线清点：11 个段注释锚（立场＝逐字，含括注全角括号与空格）
const SHELL_ANCHORS = [
	"<!-- ============ 书架页 ============ -->",
	"<!-- ============ 书籍工作台 ============ -->",
	"<!-- ============ 专项工作台 ============ -->",
	"<!-- ============ 时间线全屏页 ============ -->",
	"<!-- ============ 设置页 ============ -->",
	"<!-- ============ 个人中心（创作者总览：作家卡 / 错题库 / 本书提示词的统筹入口，汇总+按书下钻） ============ -->",
	"<!-- ============ 作家卡页（作家仓库：卡片管理 + 本书用卡绑定 + 注入预览） ============ -->",
	"<!-- ============ 错题库页（作家仓库：朱雀判为 AI 的语句语料，供提取检测特征） ============ -->",
	"<!-- ============ AI 助手页 ============ -->",
	"<!-- ============ 阅读 / 精修工作台 ============ -->",
	"<!-- ============ 通用弹窗 ============ -->",
];

// 驱动与测试共同依赖的关键挂点（tools/system-browser-acceptance.cjs 面 + 三个挂载件叶容器）
const SPOT_IDS = [
	"page-shelf",
	"page-book",
	"page-workbench",
	"page-settings",
	"page-agent",
	"page-read",
	"page-stylelab",
	"page-cards",
	"page-profile",
	"page-timeline",
	"toast",
	"modal-mask",
	"writing-run-card",
	"agent-run-card",
	"chat-messages",
	"chat-text",
	"btn-send",
	"curve-mount",
	"stylelab-mount",
	"writing-conversation-select",
	// UI 优化阶段 1：写作页全局导航栏挂点与写作助手折叠按钮
	"book-rail",
	"btn-toggle-chat-panel",
	// UI 优化阶段 2：章节栏筛选条、底栏与总数挂点（ChapterEditorPanel portal 落点）
	"chapter-filter",
	"chapter-foot",
	"chapter-total",
];

describe("T1 HTML 源契约（静态壳单一事实源＝frontend/index.html）", () => {
	it("T1-1 唯一 script＝Vite entry 声明（/entry.jsx）；源内无指向产物路径的手工标签", () => {
		const tags = INDEX_HTML.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
		expect(tags).toHaveLength(1);
		expect(tags[0]).toMatch(/type\s*=\s*["']module["']/);
		expect(tags[0]).toMatch(/src\s*=\s*["']\/entry\.jsx["']/);
		expect(
			tags[0]
				.replace(/^<script\b[^>]*>/, "")
				.replace(/<\/script>$/, "")
				.trim(),
		).toBe("");
		// D1 判据：注释剥离后产物路径字面量 0；全文层面恰 1 处（P6-2 ⑨ 历史说明注释，豁免留案）
		expect(NO_COMMENT.match(/\/app\/entry\.js/g) || []).toEqual([]);
		expect(INDEX_HTML.match(/\/app\/entry\.js/g) || []).toHaveLength(1);
	});

	it("T1-2 壳 DOM 不变量：241 id 各恰一份／187 class 词元／11 段注释锚；无静态 #app-root", () => {
		const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids).toHaveLength(241);
		expect(new Set(ids).size).toBe(241);
		for (const id of ids) {
			expect(
				INDEX_HTML.match(new RegExp(`id="${id}"`, "g")) || [],
				`id 必须恰一份：${id}`,
			).toHaveLength(1);
		}
		const classTokens = new Set();
		for (const m of INDEX_HTML.matchAll(/class="([^"]*)"/g)) {
			for (const token of m[1].split(/\s+/)) if (token) classTokens.add(token);
		}
		expect(classTokens.size).toBe(187);
		for (const anchor of SHELL_ANCHORS) {
			expect(INDEX_HTML, `段注释锚必须在位：${anchor}`).toContain(anchor);
		}
		for (const id of SPOT_IDS) {
			expect(ids, `挂点 id 必须在位：${id}`).toContain(id);
		}
		// 挂载点由 entry.jsx 动态创建（新壳无静态 #app-root；Plan §2.5-D2-3）
		expect(ids).not.toContain("app-root");
	});

	it("T1-3 退役面零残留＋样式表全部走构建（源 HTML 零手工 link）", () => {
		expect(INDEX_HTML.match(/legacy\/[A-Za-z0-9._-]+\.js/g) || []).toEqual([]);
		const live = ALL.filter((name) =>
			new RegExp(`window\\.${name}\\b`).test(NO_COMMENT),
		);
		expect(
			live,
			`HTML 注释剥离后名单内 window.* 残留：${live.join(", ")}`,
		).toEqual([]);
		// UI 优化阶段 5：原 public/style.css 并入 frontend/styles/base.css，由 Vite 注入唯一样式 link
		const links = INDEX_HTML.match(/<link\b[^>]*>/g) || [];
		expect(links).toEqual([]);
		expect(fs.existsSync(path.join(REPO_ROOT, "public", "style.css"))).toBe(
			false,
		);
	});

	it("T1-4 产物不入库：.gitignore 含 /public/index.html", () => {
		const lines = fs
			.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")
			.split(/\r?\n/);
		expect(lines).toContain("/public/index.html");
	});
});
