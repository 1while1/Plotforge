// @vitest-environment jsdom
// S4-5 红测（Plan §4 S1~S10）：StyleLabPage 路由页范式 P——window.MozhenStyleLab 桥委托，
// style-lab.js（176 行）全退役（git rm＋index.html :819 标签删＋静态两段换 #stylelab-mount）。
// 断言语义锚点＝public/legacy/style-lab.js 活代码行号（Plan §4 S 表逐条）：
// S1 桥与挂载／S2 统计栏五计数＋高置信合并／S3 标本列表行结构与参数拼接／S4 章节下拉／
// S5 复核 PATCH／S6 删除 confirm 门／S7 导出 location.href 分路（不走 fetch）／
// S8 筛选联动／S9 曲线面板委托（S4-8 起改写：旧名桥 window.RewriteCurvePanel 由
// registerLegacyBridges 定义，消费方 StyleLabPage.jsx:356 零逻辑改动命中旧名；改写工作台静态段
// 已换 #curve-mount 由 React 面板接管，挂载语义由 RewriteCurvePanel.test.jsx R1~R15 覆盖，
// 故「静态段不被接管」断言删除）／
// S10 错误态（samples 失败 toast 不清白屏；stats 失败静默）。
// harness（CardsPage.test.jsx 同款）：jsdom + React 19 内建 act + 裸 DOM 断言（不装 @testing-library/*）。
// S7 注：jsdom 的 location 是 Unforgeable（href 赋值不生效且无法拦截，探针实测
// defineProperty 抛 TypeError），导出 URL 断言经组件导出的 setExportSink 注入捕获；
// 真实浏览器用默认实现（window.location.href = url），行为零变化。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountStyleLab, setExportSink } from "./StyleLabPage.jsx";

// P6-2 转写（Plan §2.4 T-F）：曲线面板委托已由 window 旧名桥改为模块导出直取（§2.5-D5）——
// 记参面改 `vi.mock` 该组件模块（持有 holder，逐测清空；不委托真实现，等值旧 window 桩口径）。
const rec = vi.hoisted(() => ({ curve: [] }));
vi.mock("../components/RewriteCurvePanel.jsx", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		mountRewriteCurve: (bookId) => {
			rec.curve.push(bookId);
			return undefined;
		},
	};
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 单一事实源：源码见证读的仓库根（同 ReadPage.test/CardsPage.test 口径）
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

function freshSamples() {
	return [
		{
			id: 11,
			detectorConf: 0.85,
			verdict: "pending",
			seenCount: 3,
			chapterTitle: "第三章 试炼",
			text: "这是<script>alert(1)</script>一句",
			reviewNote: "复核备注一",
		},
		{
			id: 12,
			detectorConf: 0.42,
			verdict: "ai",
			seenCount: 1,
			chapterTitle: "",
			bookId: "B1",
			text: "第二句正文",
		},
		{
			id: 13,
			detectorConf: null,
			verdict: "human",
			seenCount: 1,
			chapterTitle: "第四章 落幕",
			text: "第三句正文",
		},
	];
}

function freshStats() {
	return {
		stats: {
			total: 7,
			byVerdict: { pending: 2, ai: 3, human: 1, rejected: 1 },
			byConfidence: { veryHigh: 2, high: 1, mid: 2, low: 2 },
		},
	};
}

let samplesFixture;
let statsFixture;
let chaptersFixture;
let chaptersFail;
let samplesFail;
let statsFail;
let apiCalls;
let toasts;
let confirmCalls;
let confirmResult;
let curveShowCalls;
let exportUrls;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "GET" && path.startsWith("/api/style-lab/samples?")) {
		if (samplesFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({
			samples: samplesFixture,
			total: 9,
		});
	}
	if (method === "GET" && path.startsWith("/api/style-lab/stats?")) {
		if (statsFail) return Promise.reject(new Error("统计故障"));
		return Promise.resolve(statsFixture);
	}
	if (method === "GET" && /^\/api\/books\/[^/]+\/chapters$/.test(path)) {
		if (chaptersFail) return Promise.reject(new Error("章节故障"));
		return Promise.resolve({ chapters: chaptersFixture });
	}
	if (method === "PATCH" && /^\/api\/style-lab\/samples\/\d+$/.test(path)) {
		// 有状态 mock：复核结论落库（等价服务端持久化，重拉后读到新值）
		const id = Number(path.slice("/api/style-lab/samples/".length));
		const hit = samplesFixture.find((s) => s.id === id);
		if (hit) hit.verdict = body.verdict;
		return Promise.resolve({ sample: { id, verdict: body.verdict } });
	}
	if (method === "DELETE" && /^\/api\/style-lab\/samples\/\d+$/.test(path)) {
		const id = Number(path.slice("/api/style-lab/samples/".length));
		samplesFixture = samplesFixture.filter((s) => s.id !== id);
		return Promise.resolve({});
	}
	return Promise.resolve({});
}

function buildPage() {
	document.getElementById("page-stylelab")?.remove();
	const page = document.createElement("div");
	page.id = "page-stylelab";
	page.innerHTML = `<header class="topbar"><div class="topbar-left"><a id="stylelab-return" href="#/profile" class="btn btn-ghost">← 返回个人中心</a><h1 id="stylelab-book-title" class="book-title">错题库</h1></div></header><main class="settings-main"><div id="stylelab-mount"></div><div id="curve-mount"></div></main>`;
	document.body.appendChild(page);
	return page;
}

async function mountAndLoad(bookId = "B1") {
	buildPage();
	act(() => {
		mountStyleLab(bookId);
	});
	await act(async () => {});
	return document.getElementById("stylelab-mount");
}

function setSelectValue(el, value) {
	el.value = value;
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function lastSamplesPath() {
	const gets = apiCalls.filter(
		(c) => c.method === "GET" && c.path.startsWith("/api/style-lab/samples?"),
	);
	return gets[gets.length - 1]?.path;
}

beforeEach(() => {
	document.body.innerHTML = "";
	samplesFixture = freshSamples();
	statsFixture = freshStats();
	chaptersFixture = [
		{ id: 5, title: "第五章 疑云" },
		{ id: 6, title: "第六章 对峙" },
	];
	chaptersFail = false;
	samplesFail = false;
	statsFail = false;
	apiCalls = [];
	toasts = [];
	confirmCalls = [];
	confirmResult = true;
	rec.curve.length = 0;
	curveShowCalls = [];
	exportUrls = [];
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
	};
	window.confirm = (...args) => {
		confirmCalls.push(args[0]);
		return confirmResult;
	};
	setExportSink((url) => {
		exportUrls.push(url);
	});
	// P6-2：委托计数由模块 mock 的 holder 承接（curveShowCalls 直接指向同一数组）
	curveShowCalls = rec.curve;
});

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("StyleLabPage 组件（路由页范式 P）", () => {
	it("S1 桥与挂载：MozhenStyleLab.show 可用（新名 P 形）；#stylelab-mount 缺失 no-op 不抛；二次 show root 复用重挂重拉", async () => {
		expect(typeof mountStyleLab).toBe("function");
		// 挂载目标缺失：no-op 不抛（CardsPage mount 同守卫）
		document.getElementById("stylelab-mount")?.remove();
		expect(() => mountStyleLab("B1")).not.toThrow();
		await act(async () => {});

		// 正常挂载：root 缓存于容器元素
		const page = buildPage();
		act(() => {
			mountStyleLab("B1");
		});
		await act(async () => {});
		const mount = document.getElementById("stylelab-mount");
		expect(mount.__mozhenStyleLabRoot).toBeTruthy();
		expect(document.getElementById("stylelab-stats").textContent).toContain(
			"共 7 条标本",
		);

		// 同容器二次 show：root 复用（不重复 createRoot）+ 重挂重拉（GET 计数重走一遍）
		const gets1 = apiCalls.filter(
			(c) => c.method === "GET" && c.path.startsWith("/api/style-lab/samples?"),
		).length;
		act(() => {
			mountStyleLab("B1");
		});
		await act(async () => {});
		expect(document.getElementById("stylelab-mount").__mozhenStyleLabRoot).toBe(
			mount.__mozhenStyleLabRoot,
		);
		const gets2 = apiCalls.filter(
			(c) => c.method === "GET" && c.path.startsWith("/api/style-lab/samples?"),
		).length;
		expect(gets2).toBe(gets1 + 1);
		expect(page).toBeTruthy();
	});

	it("S2 统计栏：五计数＋高置信合并（veryHigh+high）＋tip title 逐字；stats 缺失 no-op 保持「载入中…」", async () => {
		await mountAndLoad();
		const box = document.getElementById("stylelab-stats");
		const bs = Array.from(box.querySelectorAll("b")).map((b) => b.textContent);
		expect(bs).toEqual(["7", "2", "3", "1", "1", "3", "2", "2"]);
		expect(box.textContent).toContain(
			"共 7 条标本 · 待复核 2 · 确认 AI 3 · 确认为人写 1 · 已废弃 1",
		);
		const tip = box.querySelector(".stylelab-tip");
		expect(tip.getAttribute("title")).toBe("特征提取只用已复核且未废弃的语料");
		expect(tip.textContent).toBe("｜高置信(≥0.7) 3 · 中 2 · 低 2");

		// stats 缺失（响应无 stats 字段）：renderStats no-op 语义 → 保持初始「载入中…」
		statsFixture = {};
		await mountAndLoad();
		expect(document.getElementById("stylelab-stats").textContent).toBe(
			"载入中…",
		);
	});

	it("S3 标本列表：GET 参数拼接顺序与 encodeURIComponent；行结构五要素＋四按钮；空态文案逐字；「显示 N / M 条」", async () => {
		await mountAndLoad();
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=B1&limit=100&order=conf",
		);
		// bookId 特殊字符逐字 encodeURIComponent（style-lab.js:115）
		await mountAndLoad("a b/c");
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=a%20b%2Fc&limit=100&order=conf",
		);

		await mountAndLoad();
		const list = document.getElementById("stylelab-list");
		const items = list.querySelectorAll(".sample-item");
		expect(items.length).toBe(3);

		const item1 = list.querySelector('.sample-item[data-id="11"]');
		const conf1 = item1.querySelector(".health-seg-conf");
		expect(conf1.textContent).toBe("0.850");
		expect(conf1.className).toBe("health-seg-conf high");
		const verdict1 = item1.querySelector(".sample-verdict");
		expect(verdict1.textContent).toBe("待复核");
		expect(verdict1.className).toBe("sample-verdict verdict-pending");
		const seen1 = item1.querySelector(".sample-seen");
		expect(seen1.textContent).toBe("×3");
		expect(seen1.getAttribute("title")).toBe(
			"同一句被反复检出，重复次数本身就是最强的特征证据",
		);
		expect(item1.querySelector(".sample-src").textContent).toBe("第三章 试炼");
		// 正文转义为文本（script 不落地为元素）
		expect(item1.querySelector(".sample-text").textContent).toBe(
			"这是<script>alert(1)</script>一句",
		);
		expect(list.querySelector("script")).toBeNull();
		expect(item1.querySelector(".sample-note").textContent).toBe(
			"复核备注：复核备注一",
		);
		expect(item1.querySelectorAll(".sample-ops button").length).toBe(4);

		// 章节题缺失 → 「书 #id」兜底；conf 非数 → 「—」
		expect(
			list.querySelector('.sample-item[data-id="12"] .sample-src').textContent,
		).toBe("书 #B1");
		expect(
			list.querySelector('.sample-item[data-id="13"] .health-seg-conf')
				.textContent,
		).toBe("—");
		expect(
			list.querySelector('.sample-item[data-id="13"] .health-seg-conf')
				.className,
		).toBe("health-seg-conf unknown");
		expect(document.getElementById("stylelab-count").textContent).toBe(
			"显示 3 / 9 条",
		);

		// 空态文案逐字（style-lab.js:45）
		samplesFixture = [];
		await mountAndLoad();
		expect(
			document.querySelector("#stylelab-list .empty-hint").textContent,
		).toBe(
			"还没有标本。去阅读页点「AI 味体检」检测章节，判为 AI 的语句会自动进这里。",
		);
	});

	it("S4 章节下拉：GET chapters →「全部章节」＋选项＋筛选选中保持；失败静默下拉留空", async () => {
		await mountAndLoad();
		expect(
			apiCalls.some(
				(c) => c.method === "GET" && c.path === "/api/books/B1/chapters",
			),
		).toBe(true);
		const sel = document.getElementById("stylelab-chapter");
		expect(sel.options.length).toBe(3);
		expect(sel.options[0].textContent).toBe("全部章节");
		expect(sel.options[0].value).toBe("");
		expect(sel.options[1].textContent).toBe("第五章 疑云");
		expect(sel.value).toBe("");
		// 选中后值保持（回填语义：受控 select 值不因重渲漂移）
		await act(async () => {
			setSelectValue(sel, "5");
		});
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=B1&limit=100&chapter_id=5&order=conf",
		);
		expect(document.getElementById("stylelab-chapter").value).toBe("5");

		// 失败静默：下拉留空（style-lab.js:109 catch 注释语义——过滤是增强项）
		chaptersFail = true;
		await mountAndLoad();
		expect(document.getElementById("stylelab-chapter").options.length).toBe(0);
		expect(toasts).not.toContain("章节故障");
	});

	it("S5 复核：PATCH {verdict} → 行内 label class/text 更新＋toast「已记录复核结论」＋统计刷新", async () => {
		await mountAndLoad();
		const statsGets1 = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/style-lab/stats?book_id=B1",
		).length;
		await act(async () => {
			document
				.querySelector('.sample-item[data-id="11"] [data-review="ai"]')
				.click();
		});
		const patch = apiCalls.find(
			(c) => c.method === "PATCH" && c.path === "/api/style-lab/samples/11",
		);
		expect(patch.body).toEqual({ verdict: "ai" });
		const label = document.querySelector(
			'.sample-item[data-id="11"] .sample-verdict',
		);
		expect(label.className).toBe("sample-verdict verdict-ai");
		expect(label.textContent).toBe("确认 AI");
		expect(toasts).toContain("已记录复核结论");
		// load() 刷新统计（style-lab.js:86 注释语义）
		const statsGets2 = apiCalls.filter(
			(c) => c.method === "GET" && c.path === "/api/style-lab/stats?book_id=B1",
		).length;
		expect(statsGets2).toBe(statsGets1 + 1);
	});

	it("S6 删除：confirm 取消 → 无 DELETE；确认 → DELETE＋toast「已删除」＋行移除＋刷新", async () => {
		await mountAndLoad();
		confirmResult = false;
		await act(async () => {
			document.querySelector('.sample-item[data-id="12"] [data-del]').click();
		});
		expect(confirmCalls).toEqual(["删除这条标本？删除后无法找回。"]);
		expect(apiCalls.some((c) => c.method === "DELETE")).toBe(false);

		confirmResult = true;
		await act(async () => {
			document.querySelector('.sample-item[data-id="12"] [data-del]').click();
		});
		expect(
			apiCalls.some(
				(c) => c.method === "DELETE" && c.path === "/api/style-lab/samples/12",
			),
		).toBe(true);
		expect(toasts).toContain("已删除");
		expect(document.querySelector('.sample-item[data-id="12"]')).toBeNull();
	});

	it("S7 导出：confirm true → location.href=export URL（带 verdict）；false → &include_pending=true；不走 fetch", async () => {
		await mountAndLoad();
		const before = apiCalls.length;
		await act(async () => {
			document.getElementById("stylelab-export").click();
		});
		expect(confirmCalls).toEqual([
			"导出已复核语料（确认 AI + 确认为人写）？\n\n点「取消」则导出含待复核的全部语料。",
		]);
		expect(exportUrls).toEqual(["/api/style-lab/samples-export?book_id=B1"]);
		expect(apiCalls.length).toBe(before); // location.href 直接触发下载，不经 App.api（style-lab.js:150-151 注释语义）

		// 带 verdict 筛选
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-verdict"), "ai");
		});
		await act(async () => {
			document.getElementById("stylelab-export").click();
		});
		expect(exportUrls[1]).toBe(
			"/api/style-lab/samples-export?book_id=B1&verdict=ai",
		);

		// confirm false → include_pending（style-lab.js:156-158）
		confirmResult = false;
		await act(async () => {
			document.getElementById("stylelab-export").click();
		});
		expect(exportUrls[2]).toBe(
			"/api/style-lab/samples-export?book_id=B1&verdict=ai&include_pending=true",
		);
	});

	it("S8 筛选联动：verdict/chapter/order 三 select change → query 参数变化并重拉（拼接顺序逐字）", async () => {
		await mountAndLoad();
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-verdict"), "pending");
		});
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=B1&limit=100&verdict=pending&order=conf",
		);
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-chapter"), "6");
		});
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=B1&limit=100&verdict=pending&chapter_id=6&order=conf",
		);
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-order"), "recent");
		});
		expect(lastSamplesPath()).toBe(
			"/api/style-lab/samples?book_id=B1&limit=100&verdict=pending&chapter_id=6&order=recent",
		);
	});

	it("S9 曲线委托（P6-2 转写：模块直取）：委托恰 1 次且实参＝bookId；真值守卫退役见证", async () => {
		// ① 生产零窗口面（源码见证）：`mountRewriteCurve` 经模块导出直取；旧「桥由 registerLegacyBridges
		// 供给、消费方零逻辑改动命中旧名」口径随 §2.5-D5 内化**收窄合并**——桥注册的删除属切换笔，
		// 零残留由 T1 静态见证承担。**导出名逐字断言**（笔⑧补正：曾误植不存在的 `show` 导出，
		// 单测因 mock 掩盖而绿、构建 MISSING_EXPORT 才暴露——此处钉死真实导出名）。
		const src = fs.readFileSync(
			path.join(REPO_ROOT, "frontend", "pages", "StyleLabPage.jsx"),
			"utf8",
		);
		expect(src).toContain(
			'import { mountRewriteCurve } from "../components/RewriteCurvePanel.jsx"',
		);
		expect(src).toContain("mountRewriteCurve(newBookId)");
		// 注释行豁免（同 T1/T4-3 口径）：头注保留历史说明，活代码零命中
		const liveLines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
		expect(liveLines.join("\n")).not.toContain("window.RewriteCurvePanel");

		// ② MozhenStyleLab.show → 委托恰 1 次且实参＝bookId（记参面＝模块 mock holder）
		buildPage();
		act(() => {
			mountStyleLab("B1");
		});
		await act(async () => {});
		expect(curveShowCalls).toEqual(["B1"]);

		// ③ P6-2：`if (showRewriteCurve)` 真值守卫移除＝不可达差异备案（模块导出恒在，无缺名态可构造）；
		// 等价见证＝再调仍不抛且委托再次命中（旧断言＝守卫跳过、计数不变）
		expect(() => mountStyleLab("B1")).not.toThrow();
		await act(async () => {});
		expect(curveShowCalls).toEqual(["B1", "B1"]);
	});

	it("S10 错误态：samples 失败 → toast e.message 且旧列表不清白屏；stats 失败静默", async () => {
		await mountAndLoad();
		samplesFail = true;
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-order"), "recent");
		});
		expect(toasts).toContain("网络故障");
		// 列表不清白屏（失败路径不清 box.innerHTML，style-lab.js:121-123）
		expect(
			document.querySelectorAll("#stylelab-list .sample-item").length,
		).toBe(3);
		expect(document.getElementById("stylelab-count").textContent).toBe(
			"显示 3 / 9 条",
		);

		// stats 失败静默（style-lab.js:127 catch ignore）：samples 仍失败会再 toast 一次
		// 「网络故障」（等值 legacy 每次 load 的 samples catch），但 stats 失败不新增任何 toast
		const t0 = toasts.length;
		statsFail = true;
		await act(async () => {
			setSelectValue(document.getElementById("stylelab-order"), "seen");
		});
		expect(toasts.length).toBe(t0 + 1);
		expect(toasts.filter((t) => t === "网络故障").length).toBe(2);
		expect(toasts).not.toContain("统计故障");
		expect(document.getElementById("stylelab-stats").textContent).toContain(
			"共 7 条标本",
		);
	});
});
