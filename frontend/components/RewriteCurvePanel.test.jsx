// @vitest-environment jsdom
// S4-8 红测（Plan §4 表 2，R1~R15）：RewriteCurvePanel 范式 W 旧名桥全退役——
// React 以旧名 window.RewriteCurvePanel 应答（消费方 StyleLabPage.jsx:356 零逻辑改动），
// public/legacy/rewrite-curve-panel.js（313 行）git rm 全退役（index.html :789/:790 两标签删、
// 曲线静态段 :579-599 换 #curve-mount）。纯逻辑在 frontend/lib/rewrite-curve.js（L1~L14 对等）。
// 断言语义锚点＝public/legacy/rewrite-curve-panel.js 活代码行号（Plan §4 表 2 逐条）：
// R1 桥与挂载／R2 初始态与章节下拉／R3 载入本章／R4 草稿优先与 shape warn／R5 空正文／
// R6 段落渲染与诊断标签／R7 输入局部更新与 400ms autosave／R8 还原／R9 停笔自动测 3s／
// R10 测量主流程与按钮纪律／R11 5s 最小间隔顺延／R12 曲线 SVG 结构／R13 测量点列表／
// R14 复制待改段与清空草稿／R15 ST/App 缺失守卫。
// harness（StyleHealthPanel.test.jsx 同款）：jsdom + React 19 内建 act + 裸 DOM 断言；
// mock window.App（api/toast/openModal/escapeHtml）与 window.SegmentTargets
// （splitParagraphs→{index,text}、diagnose→{key,label,hint,count}、buildBrief→串）；
// confirm/clipboard mock；fake timers 管 400ms/3000ms/5000ms 三时序。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mountRewriteCurve } from "./RewriteCurvePanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// S5-10 R4（Plan §5.4）：段级靶点诊断的注入缝由 window 改为**模块缝**——组件自 S5-10 起
// 直接 `import { diagnose, splitParagraphs, buildBrief } from "../lib/segment-targets.js"`
// （D-S4-6-01 §7 口径：React 侧 ST 守卫改 import，标签与 legacy 文件一并退役）。
// 断言语义零放宽：splitCalls/buildCalls 捕获序与 segDiagnose 控制语义逐字不变；
// R15 的「ST 缺失 → show no-op」首臂在静态 import 下不可达，按 charter §2 退役留案（App 臂保留）。
const stMock = vi.hoisted(() => ({
	diagnose: () => [],
	splitParagraphs: () => [],
	buildBrief: () => "",
}));
vi.mock("../lib/segment-targets.js", () => ({
	PROBES: [],
	diagnose: (text) => stMock.diagnose(text),
	sentenceStats: () => null,
	splitParagraphs: (text) => stMock.splitParagraphs(text),
	buildBrief: (segs, opts) => stMock.buildBrief(segs, opts),
	buildTextList: () => "",
}));

// 章节 fixture：content_length 进下拉文案（:43 逐字）
let chaptersFixture;
let chaptersFail;
let chapterTitle;
let chapterContent;
let detectConf;
let detectFailMsg;
let detectDeferred;
let apiCalls;
let toasts;
let openModals;
let confirmCalls;
let confirmResult;
let clipWrites;
let clipReject;
let segDiagnose;
let buildBriefResult;
let buildCalls;
let splitCalls;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && /^\/api\/books\/[^/]+\/chapters$/.test(path)) {
		if (chaptersFail) return Promise.reject(new Error("章节故障"));
		return Promise.resolve({ chapters: chaptersFixture });
	}
	if (method === "GET" && path.startsWith("/api/style-lab/chapter-text?")) {
		return Promise.resolve({
			chapter: { title: chapterTitle, content: chapterContent },
		});
	}
	if (method === "POST" && path === "/api/style-lab/detect") {
		if (detectDeferred) return detectDeferred;
		if (detectFailMsg) return Promise.reject(new Error(detectFailMsg));
		return Promise.resolve({ overall: { conf: detectConf } });
	}
	return Promise.resolve({});
}

function buildShell() {
	document.body.innerHTML = `<div id="curve-mount"></div>`;
}

async function showCurve(bookId = "B1") {
	act(() => {
		mountRewriteCurve(bookId);
	});
	await act(async () => {});
}

async function loadCurve() {
	await act(async () => {
		document.getElementById("curve-load").click();
	});
}

// React 受控 textarea 的 jsdom 赋值必须走原生 setter（LedgerWorkbenchPanel.test.jsx 同款：
// 直接赋 .value 会被 React 的 value tracker 吞掉 input 事件）
async function typeInto(idx, value) {
	const ta = document.querySelectorAll("#curve-paras .curve-para-text")[idx];
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLTextAreaElement.prototype,
		"value",
	).set;
	await act(async () => {
		setter.call(ta, value);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

// 勾选/取消 #curve-auto：走 click()（jsdom 激活行为会切 checked 并触发 change，
// StyleHealthPanel.test.jsx #health-only-ai 同款）
async function toggleAuto(on) {
	const el = document.getElementById("curve-auto");
	await act(async () => {
		if (el.checked !== on) el.click();
	});
}

function postCount() {
	return apiCalls.filter((c) => c.method === "POST").length;
}

function draftKey(bookId = "B1", chapterId = 6) {
	return `novel-rewrite:${bookId}:${chapterId}`;
}

function seedDraft(draft) {
	localStorage.setItem(draftKey(), JSON.stringify(draft));
}

function readDraft() {
	const raw = localStorage.getItem(draftKey());
	return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
	buildShell();
	chaptersFixture = [
		{ id: 5, title: "第五章 疑云", content_length: 1200 },
		{ id: 6, title: "第六章 对峙", content_length: 800 },
	];
	chaptersFail = false;
	chapterTitle = "第六章 对峙";
	chapterContent = "段一\n\n段二\n\n段三";
	detectConf = 0.6123;
	detectFailMsg = null;
	detectDeferred = null;
	apiCalls = [];
	toasts = [];
	openModals = [];
	confirmCalls = [];
	confirmResult = true;
	clipWrites = [];
	clipReject = false;
	segDiagnose = null;
	buildBriefResult = "1. 明喻：比喻句式（可指名的毛病）";
	buildCalls = [];
	splitCalls = [];
	localStorage.clear();
	window.App = {
		api: mockApi,
		escapeHtml(s) {
			if (s == null) return "";
			return String(s).replace(
				/[&<>"']/g,
				(c) =>
					({
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#39;",
					})[c],
			);
		},
		toast(msg) {
			toasts.push(String(msg));
		},
		openModal(opts) {
			openModals.push(opts);
		},
	};
	window.confirm = (...args) => {
		confirmCalls.push(args[0]);
		return confirmResult;
	};
	Object.defineProperty(window.navigator, "clipboard", {
		configurable: true,
		value: {
			writeText(text) {
				clipWrites.push(text);
				return clipReject
					? Promise.reject(new Error("浏览器拒绝剪贴板"))
					: Promise.resolve();
			},
		},
	});
	stMock.splitParagraphs = (text) => {
		splitCalls.push(text);
		return String(text || "")
			.split(/\n+/)
			.filter((t) => t.trim())
			.map((t, i) => ({ index: i, text: t }));
	};
	stMock.diagnose = (text) => (segDiagnose ? segDiagnose(text) : []);
	stMock.buildBrief = (segs, opts) => {
		buildCalls.push({ segs, opts });
		return buildBriefResult;
	};
});

afterEach(() => {
	vi.useRealTimers();
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("RewriteCurvePanel 组件（范式 W 旧名桥）", () => {
	it("R1 桥与挂载：registerLegacyBridges 后 window.RewriteCurvePanel.show 为函数；show 后 #curve-mount 内出现 .curve-paras；root 缓存 el.__mozhenRewriteCurveRoot 且二次 show 复用同 root、key=visit++ 重挂重拉；#curve-mount 缺失 no-op", async () => {
		expect(typeof mountRewriteCurve).toBe("function");

		// 挂载目标缺失：no-op 不抛
		document.getElementById("curve-mount")?.remove();
		expect(() => mountRewriteCurve("B1")).not.toThrow();
		await act(async () => {});

		buildShell();
		const mount = document.getElementById("curve-mount");
		await showCurve();
		expect(mount.__mozhenRewriteCurveRoot).toBeTruthy();
		expect(
			document.getElementById("curve-mount").querySelector(".curve-paras"),
		).not.toBeNull();
		const gets1 = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/books/B1/chapters",
		).length;

		// 同容器二次 show：root 复用（不重复 createRoot）+ 重挂重拉（章节下拉重新 GET）
		await showCurve();
		expect(
			document.getElementById("curve-mount").__mozhenRewriteCurveRoot,
		).toBe(mount.__mozhenRewriteCurveRoot);
		const gets2 = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/books/B1/chapters",
		).length;
		expect(gets2).toBe(gets1 + 1);
	});

	it("R2 show 初始态＋章节下拉：GET chapters → option「title（N 字）」逐字；空列表「（本书还没有章节）」；抛错「章节载入失败」；默认选最后一章；status 初始文案", async () => {
		await showCurve();
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === "/api/books/B1/chapters",
			),
		).toBe(true);
		const sel = document.getElementById("curve-chapter");
		expect(sel.options.length).toBe(2);
		expect(sel.options[0].textContent).toBe("第五章 疑云（1200 字）");
		expect(sel.options[1].textContent).toBe("第六章 对峙（800 字）");
		// 默认选到最后一章（:309）
		expect(sel.value).toBe("6");
		expect(document.getElementById("curve-status").textContent).toBe(
			"选一章后点「载入本章」。草稿按书/章自动保存，刷新不丢。",
		);

		// 空列表（:45）
		chaptersFixture = [];
		await showCurve();
		const emptySel = document.getElementById("curve-chapter");
		expect(emptySel.options.length).toBe(1);
		expect(emptySel.options[0].textContent).toBe("（本书还没有章节）");
		expect(emptySel.value).toBe("");

		// 章节载入失败（:47）
		chaptersFail = true;
		await showCurve();
		const failSel = document.getElementById("curve-chapter");
		expect(failSel.options.length).toBe(1);
		expect(failSel.options[0].textContent).toBe("章节载入失败");
	});

	it("R3 载入本章：GET chapter-text → ST.splitParagraphs → items；measure 按钮 enabled；「已载入「T」共 N 段。改完一段点「测一次」。」", async () => {
		await showCurve();
		await loadCurve();
		const get = apiCalls.find((c) =>
			c.path.startsWith("/api/style-lab/chapter-text?"),
		);
		expect(get.path).toBe(
			"/api/style-lab/chapter-text?book_id=B1&chapter_id=6",
		);
		expect(splitCalls).toEqual(["段一\n\n段二\n\n段三"]);
		expect(document.querySelectorAll("#curve-paras .curve-para").length).toBe(
			3,
		);
		expect(document.getElementById("curve-measure").disabled).toBe(false);
		expect(document.getElementById("curve-status").textContent).toBe(
			"已载入「第六章 对峙」共 3 段。改完一段点「测一次」。",
		);
	});

	it("R4 草稿优先＋shape 校验：同 shape 草稿 → items+series 恢复；shape 不一致 → warn 且 series 清空", async () => {
		seedDraft({
			items: [
				{ o: "段一", r: "段一改" },
				{ o: "段二", r: "段二" },
				{ o: "段三", r: "段三" },
			],
			series: [{ ratio: 0.5, conf: 0.62, chars: 12, at: "t1", n: 1 }],
			updatedAt: "2026-09-27T00:00:00.000Z",
		});
		await showCurve();
		await loadCurve();
		const tas = document.querySelectorAll("#curve-paras .curve-para-text");
		expect(tas[0].value).toBe("段一改");
		expect(tas[1].value).toBe("段二");
		expect(
			document.querySelectorAll("#curve-paras .curve-para.changed").length,
		).toBe(1);
		// series 恢复 → 曲线点渲染
		expect(document.querySelectorAll("#curve-chart .chart-dot").length).toBe(1);
		expect(document.querySelectorAll("#curve-points .curve-point").length).toBe(
			1,
		);

		// shape 不一致（原文不同）→ warn 且 series 清空（:72-76）
		seedDraft({
			items: [
				{ o: "段一", r: "段一改" },
				{ o: "段二改过了", r: "段二" },
				{ o: "段三", r: "段三" },
			],
			series: [{ ratio: 0.5, conf: 0.62, chars: 12, at: "t1", n: 1 }],
			updatedAt: "2026-09-27T00:00:00.000Z",
		});
		await showCurve();
		await loadCurve();
		expect(document.getElementById("curve-status").textContent).toBe(
			"正文与上次草稿不一致（章节可能改过），已按最新正文重新载入，草稿未套用。",
		);
		expect(document.getElementById("curve-status").className).toBe(
			"field-hint warn",
		);
		expect(document.querySelectorAll("#curve-chart .chart-dot").length).toBe(0);
		const tas2 = document.querySelectorAll("#curve-paras .curve-para-text");
		expect(tas2[0].value).toBe("段一");
	});

	it("R5 空正文：items 空 → measure disabled＋「这一章还没有正文，无法改写。」", async () => {
		chapterContent = "";
		await showCurve();
		await loadCurve();
		expect(document.querySelectorAll("#curve-paras .curve-para").length).toBe(
			0,
		);
		expect(document.getElementById("curve-measure").disabled).toBe(true);
		expect(document.getElementById("curve-status").textContent).toBe(
			"这一章还没有正文，无法改写。",
		);
	});

	it("R6 段落渲染＋诊断标签：head＝describeProgress＋复制待改段按钮；行结构（idx/字数/已改写态/tags/还原/textarea）；diagnose → .curve-tag title=hint、label ×N；textarea 值经 JSX 自动转义", async () => {
		segDiagnose = (text) =>
			text === "段一"
				? [
						{
							key: "simile",
							label: "明喻",
							count: 2,
							hint: '像<x>"一样"的比喻',
						},
						{ key: "parallel", label: "排比", count: 1, hint: "排比句式" },
					]
				: [];
		chapterContent = "段一\n\n段<b>二</b>";
		await showCurve();
		await loadCurve();
		const head = document.querySelector(".curve-paras-head");
		expect(head.textContent).toContain("共 2 段 / 11 字，尚未改写");
		const copyBtn = document.getElementById("curve-copy-targets");
		expect(copyBtn.textContent).toBe("复制待改段（不含分数）");
		expect(copyBtn.getAttribute("title")).toBe(
			"复制还没改的段落 + 该段的毛病标签（不含任何分数）",
		);
		expect(copyBtn.className).toBe("btn btn-small btn-outline");

		const rows = document.querySelectorAll("#curve-paras .curve-para");
		expect(rows.length).toBe(2);
		const row0 = rows[0];
		expect(row0.className).toBe("curve-para");
		expect(row0.querySelector(".curve-para-idx").textContent).toBe("1");
		expect(row0.querySelector(".curve-para-chars").textContent).toBe("2 字");
		expect(row0.querySelector(".curve-para-state")).toBeNull();
		expect(row0.querySelector("[data-reset]")).toBeNull();
		const tags = row0.querySelectorAll(".curve-tag");
		expect(tags.length).toBe(2);
		expect(tags[0].textContent).toBe("明喻 ×2");
		expect(tags[0].getAttribute("title")).toBe('像<x>"一样"的比喻');
		expect(tags[1].textContent).toBe("排比");
		// 正文转义为文本（禁手写 escapeHtml——JSX 自动转义）
		const ta = row0.querySelector(".curve-para-text");
		expect(ta.value).toBe("段一");
		expect(ta.rows).toBe(2);
		expect(ta.getAttribute("spellcheck")).toBe("false");
		const ta1 = rows[1].querySelector(".curve-para-text");
		expect(ta1.value).toBe("段<b>二</b>");
		expect(rows[1].querySelector(".curve-para-text b")).toBeNull();
	});

	it("R7 输入编辑：createItem(original,value) → 该行 changed/字数/head 局部更新；400ms 后 store.save", async () => {
		vi.useFakeTimers();
		await showCurve();
		await loadCurve();
		await typeInto(0, "改过的第一段内容");
		const row0 = document.querySelectorAll("#curve-paras .curve-para")[0];
		expect(row0.classList.contains("changed")).toBe(true);
		expect(row0.className).toBe("curve-para changed");
		expect(row0.querySelector(".curve-para-chars").textContent).toBe("8 字");
		expect(row0.querySelector(".curve-para-state").textContent).toBe("已改写");
		expect(row0.querySelector("[data-reset]")).not.toBeNull();
		expect(document.querySelector(".curve-paras-head").textContent).toContain(
			"已改 1/3 段",
		);
		// 未改的两行不受影响（列表不重建，React key 稳定）
		const row1 = document.querySelectorAll("#curve-paras .curve-para")[1];
		expect(row1.className).toBe("curve-para");

		expect(readDraft()).toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		const saved = readDraft();
		expect(saved.items[0]).toEqual({ o: "段一", r: "改过的第一段内容" });
		expect(saved.items.length).toBe(3);
	});

	it("R8 还原：[data-reset] → 原文回填＋态清除＋autosave", async () => {
		vi.useFakeTimers();
		await showCurve();
		await loadCurve();
		await typeInto(0, "改过的第一段内容");
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(readDraft().items[0].r).toBe("改过的第一段内容");

		await act(async () => {
			document
				.querySelectorAll("#curve-paras .curve-para")[0]
				.querySelector("[data-reset]")
				.click();
		});
		const row0 = document.querySelectorAll("#curve-paras .curve-para")[0];
		expect(row0.className).toBe("curve-para");
		expect(row0.querySelector(".curve-para-text").value).toBe("段一");
		expect(row0.querySelector(".curve-para-state")).toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(readDraft().items[0].r).toBe("段一");
	});

	it("R9 停笔自动测：勾选 #curve-auto → input 后 3000ms 触发 measure(auto)；未勾选不触发", async () => {
		vi.useFakeTimers();
		await showCurve();
		await loadCurve();
		await typeInto(0, "改过的第一段内容");
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(postCount()).toBe(0);

		await toggleAuto(true);
		await typeInto(1, "第二段也改过了");
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(postCount()).toBe(1);
		const post = apiCalls.find((c) => c.method === "POST");
		expect(post.path).toBe("/api/style-lab/detect");
		expect(post.body.save).toBe(false);
	});

	it("R10 测量主流程：POST detect body {text,save:false} → addPoint → renderChart/renderPoints → store.save → status 逐字；按钮 disabled＋「检测中…」→ finally 恢复；失败 → warn", async () => {
		await showCurve();
		await loadCurve();
		let resolvePost;
		detectDeferred = new Promise((r) => {
			resolvePost = r;
		});
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		const btn = document.getElementById("curve-measure");
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("检测中…");
		expect(document.getElementById("curve-status").textContent).toBe(
			"送检中（6 字）…",
		);
		expect(postCount()).toBe(1);
		const post = apiCalls.find((c) => c.method === "POST");
		expect(post.path).toBe("/api/style-lab/detect");
		expect(post.body).toEqual({ text: "段一\n\n段二\n\n段三", save: false });

		await act(async () => {
			resolvePost({ overall: { conf: 0.6123 } });
		});
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("测一次（花 1 次朱雀额度）");
		expect(document.getElementById("curve-status").textContent).toBe(
			"最新读数 0.6123（疑似 AI）· 共 3 段 / 6 字，尚未改写　（分数只作参考，不设达标线）",
		);
		expect(document.querySelectorAll("#curve-points .curve-point").length).toBe(
			1,
		);
		expect(document.querySelectorAll("#curve-chart .chart-dot").length).toBe(1);
		// store.save（:200）：series 随草稿持久化
		expect(readDraft().series.length).toBe(1);

		// 失败：warn 逐字＋按钮恢复可再点（:205-208）
		detectDeferred = null;
		detectFailMsg = "朱雀额度耗尽";
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		expect(document.getElementById("curve-status").textContent).toBe(
			"检测失败：朱雀额度耗尽（额度/网络问题不影响改写与草稿）",
		);
		expect(document.getElementById("curve-status").className).toBe(
			"field-hint warn",
		);
		expect(document.getElementById("curve-measure").disabled).toBe(false);
		expect(document.getElementById("curve-measure").textContent).toBe(
			"测一次（花 1 次朱雀额度）",
		);
	});

	it("R11 自动测量间隔纪律：5s 内 auto → 顺延重排不烧额度", async () => {
		vi.useFakeTimers();
		await showCurve();
		await loadCurve();
		// 先手动测一次（记 lastMeasureAt）
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		expect(postCount()).toBe(1);

		await toggleAuto(true);
		await typeInto(0, "改过的第一段内容");
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		// gap=3000 < 5000 → 顺延重排，不烧额度（:187）
		expect(postCount()).toBe(1);
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		// gap=6000 ≥ 5000 → 放行
		expect(postCount()).toBe(2);
	});

	it("R12 曲线 SVG：#curve-chart id 契约＋viewBox；五档 grid＋轴标签；人类原文区间线 0.0003~0.0159＋chart-human；x 轴「人改 0%」/「100%」；≥2 点 path.chart-line；circle.chart-dot 含 <title>", async () => {
		await showCurve();
		await loadCurve();
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		await typeInto(0, "改过的第一段内容");
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		const svg = document.getElementById("curve-chart");
		expect(svg.getAttribute("viewBox")).toBe("0 0 360 200");
		expect(svg.getAttribute("role")).toBe("img");
		expect(svg.getAttribute("aria-label")).toBe("人改比例与检测分曲线");
		// 五档 grid + x 轴线（:226/:235）
		expect(svg.querySelectorAll(".chart-grid").length).toBe(6);
		const axisTexts = Array.from(svg.querySelectorAll(".chart-axis")).map(
			(t) => t.textContent,
		);
		expect(axisTexts).toEqual([
			"很像人写的",
			"偏人工",
			"疑似 AI",
			"AI 味较重",
			"AI 味很重",
			"人类原文实测区间 0.0003~0.0159",
			"人改 0%",
			"100%",
		]);
		const humanLabel = svg.querySelector(".chart-human-label");
		expect(humanLabel.getAttribute("text-anchor")).toBe("end");
		expect(humanLabel.getAttribute("y")).toBe("167.4");
		// 两个点 → path.chart-line（:234）
		const path = svg.querySelector("path.chart-line");
		expect(path).not.toBeNull();
		expect(path.getAttribute("d").startsWith("M")).toBe(true);
		const dots = svg.querySelectorAll("circle.chart-dot");
		expect(dots.length).toBe(2);
		expect(dots[0].getAttribute("r")).toBe("3.5");
		// <title> ＝ pct → toFixed(4)（bandOf label）（:121 逐字）
		expect(dots[0].querySelector("title").textContent).toBe(
			"0% → 0.6123（疑似 AI）",
		);
		expect(dots[1].querySelector("title").textContent).toContain(
			"67% → 0.6123",
		);
	});

	it("R13 测量点列表：行（#N/人改 X%/toFixed(4)/band/×N）；空态文案逐字", async () => {
		await showCurve();
		await loadCurve();
		expect(
			document.querySelector("#curve-points .empty-hint").textContent,
		).toBe("还没有测量点。改几段后点「测一次」。");
		// 同比例同分数连续两次 → 合并为一点，n=2（:92-95）
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		await act(async () => {
			document.getElementById("curve-measure").click();
		});
		const rows = document.querySelectorAll("#curve-points .curve-point");
		expect(rows.length).toBe(1);
		expect(rows[0].querySelector(".curve-point-idx").textContent).toBe("#1");
		expect(rows[0].textContent).toContain("人改 0%");
		expect(rows[0].querySelector(".curve-point-conf").textContent).toBe(
			"0.6123",
		);
		expect(rows[0].querySelector(".curve-point-band").textContent).toBe(
			"疑似 AI",
		);
		expect(rows[0].querySelector(".curve-point-n").textContent).toBe("×2");
		expect(rows[0].querySelector(".curve-point-n").getAttribute("title")).toBe(
			"同一比例重复测量次数",
		);
	});

	it("R14 复制待改段＋清空草稿：buildBrief → clipboard → toast 逐字；全改 → 「所有段落都已改过一遍」；clipboard 拒绝 → openModal 降级；resetDraft confirm 门", async () => {
		vi.useFakeTimers();
		buildBriefResult = '1. 明喻：像<x>"一样"的比喻';
		await showCurve();
		await loadCurve();
		await act(async () => {
			document.getElementById("curve-copy-targets").click();
		});
		expect(buildCalls.length).toBe(1);
		expect(buildCalls[0].segs).toEqual([
			{ index: 0, text: "段一" },
			{ index: 0, text: "段二" },
			{ index: 0, text: "段三" },
		]);
		expect(buildCalls[0].opts).toEqual({ withText: true });
		expect(clipWrites).toEqual(['1. 明喻：像<x>"一样"的比喻']);
		expect(toasts).toContain("已复制 3 段（含毛病标签，不含任何分数）");

		// 全部改过 → 不触剪贴板（:261）
		const clipCount = clipWrites.length;
		await typeInto(0, "第一段改过的内容");
		await typeInto(1, "第二段改过的内容");
		await typeInto(2, "第三段改过的内容");
		await act(async () => {
			document.getElementById("curve-copy-targets").click();
		});
		expect(toasts).toContain("所有段落都已改过一遍");
		expect(clipWrites.length).toBe(clipCount);

		// clipboard 拒绝 → App.openModal 降级（:267-270），bodyHTML 转义后落地
		await typeInto(0, "段一");
		clipReject = true;
		await act(async () => {
			document.getElementById("curve-copy-targets").click();
		});
		expect(openModals.length).toBe(1);
		expect(openModals[0].title).toBe("手动复制（浏览器拒绝剪贴板）");
		expect(openModals[0].okText).toBe("知道了");
		expect(openModals[0].bodyHTML).toContain(
			'<textarea class="curve-copy-fallback" rows="12">',
		);
		expect(openModals[0].bodyHTML).toContain(
			"1. 明喻：像&lt;x&gt;&quot;一样&quot;的比喻",
		);

		// 清空草稿：confirm 门（:276）
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(readDraft()).not.toBeNull();
		confirmResult = false;
		await act(async () => {
			document.getElementById("curve-reset").click();
		});
		expect(confirmCalls).toEqual([
			"清空本章的改写草稿与曲线？（不影响章节正文）",
		]);
		expect(readDraft()).not.toBeNull();

		confirmResult = true;
		await act(async () => {
			document.getElementById("curve-reset").click();
		});
		expect(readDraft()).toBeNull();
		expect(
			document.querySelectorAll("#curve-paras .curve-para.changed").length,
		).toBe(0);
		expect(document.querySelectorAll("#curve-points .curve-point").length).toBe(
			0,
		);
		expect(document.getElementById("curve-status").textContent).toBe(
			"草稿已清空，章节正文未受影响。",
		);
	});

	it("R15 App 缺失守卫退役见证（P6-2 转写）：模块直取后「无 App ⇒ 不接管」臂不可达——show 恒接管 #curve-mount（ST 缺失臂随 S5-10 退役留案）", async () => {
		buildShell();
		const mount = document.getElementById("curve-mount");
		// S5-10 退役留案（Plan §5.4；charter §2 豁免流程）：原首臂「delete window.SegmentTargets
		// → show no-op」在静态 import 下**不可达**（组件不再有 ST 缺失态），随 ST 标签退役一并留案。

		// P6-2 转写（§2.5-D1）：原「delete window.App → show no-op」臂随 `if (!window.App) return`
		// 退役（App 取用改 `getApp()` 恒在，无缺名态可构造）＝不可达差异备案；
		// 等价见证＝show 恒接管容器（root 建立，原断言＝root 恒 undefined）
		mountRewriteCurve("B1");
		await act(async () => {});
		expect(mount.__mozhenRewriteCurveRoot).toBeTruthy();
	});
});
