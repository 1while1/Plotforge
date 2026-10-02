// @vitest-environment jsdom
// S4-5 红测（Plan §4 H1~H10）：StyleHealthPanel 范式 A·判定 C 旧名桥——
// React 以旧名 window.StyleHealth 应答（消费点 book-read.js:111 不可触碰而非 vm 冻结），
// style-health.js（267 行）退役为死锚点（index.html :818 标签删、文件零 diff 保留）。
// 断言语义锚点＝public/legacy/style-health.js 活代码行号（Plan §4 H 表逐条）：
// H1 旧名桥与静态按钮绑定／H2 render 显隐与记态顺序／H3 体检主流程＋#modal-body id 契约坑＋
// confLabel 五档阈值（0.9/0.7/0.5/0.2，与 test/rewrite-curve.test.js:85 文档性对齐同序）／
// H4 分段渲染／H5 只看判 AI（不重新送检）／H6 复制双动作＋降级 textarea／
// H7 未保存确认门／H8 busy 纪律／H9 标本入口／H10 复核动作。
// harness（CharacterWorkbenchPanel.test.jsx 同款）：jsdom + React 19 内建 act + 裸 DOM 断言；
// 预置 Modal 五件套壳（#modal-mask/#modal-title/#modal-body/#modal-ok/#modal-cancel——
// React Modal portal 宿主为既有 #modal-body id，契约坑由 Modal.test.jsx T4 与本文件 H3 双侧钉住）、
// 阅读页静态按钮 #read-health-btn/#read-samples-btn 与 #read-editor。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import {
	mountStyleHealth,
	renderStyleHealth,
	showStyleHealthSampleList,
} from "./StyleHealthPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// S5-10 R3（Plan §5.4）：段级靶点诊断的注入缝由 window 改为**模块缝**——组件自 S5-10 起
// 直接 `import { diagnose, buildTextList, buildBrief } from "../lib/segment-targets.js"`
// （D-S4-6-01 §7 口径：React 侧 ST 守卫改 import，标签与 legacy 文件一并退役）。
// 断言语义零放宽：buildCalls 捕获序、返回值（buildTextResult/buildBriefResult）语义逐字不变；
// H6 的「ST 缺失 → toast『诊断模块未加载』」臂在静态 import 下不可达，按 charter §2 退役留案。
const stMock = vi.hoisted(() => ({
	diagnose: () => [],
	buildTextList: () => "",
	buildBrief: () => "",
}));
vi.mock("../lib/segment-targets.js", () => ({
	PROBES: [],
	diagnose: (text) => stMock.diagnose(text),
	sentenceStats: () => null,
	splitParagraphs: () => [],
	buildTextList: (segs, opts) => stMock.buildTextList(segs, opts),
	buildBrief: (segs, opts) => stMock.buildBrief(segs, opts),
}));

function freshReport() {
	return {
		overall: { conf: 0.8413, char_count: 1234, usage_tokens: 567 },
		segments: [
			{ label: 1, conf: 0.912, text: "第一段<b>加粗</b>正文" },
			{ label: 0, conf: 0.113, text: "第二段人工" },
			{ label: 2, conf: "n/a", text: "第三段疑似" },
		],
	};
}

function freshReadSamples() {
	return [
		{
			id: 21,
			detectorConf: 0.85,
			verdict: "pending",
			seenCount: 3,
			chapterTitle: "第三章 试炼",
			text: "标本正文一",
		},
		{
			id: 22,
			detectorConf: 0.31,
			verdict: "rejected",
			seenCount: 1,
			chapterTitle: "",
			text: "标本正文二",
		},
	];
}

let reportFixture;
let samplesListFixture;
let samplesListTotal;
let samplesFail;
let postFailMsg;
let postDeferred;
let segDiagnose;
let buildTextResult;
let buildBriefResult;
let apiCalls;
let toasts;
let confirmCalls;
let confirmResult;
let clipWrites;
let clipReject;
let buildCalls;

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (method === "POST" && path === "/api/style-lab/detect-chapter") {
		if (postDeferred) return postDeferred;
		if (postFailMsg) return Promise.reject(new Error(postFailMsg));
		return Promise.resolve(reportFixture);
	}
	if (method === "GET" && path.startsWith("/api/style-lab/samples?")) {
		if (samplesFail) return Promise.reject(new Error("网络故障"));
		return Promise.resolve({
			samples: samplesListFixture,
			total: samplesListTotal,
		});
	}
	if (method === "PATCH" && /^\/api\/style-lab\/samples\/\d+$/.test(path)) {
		const id = Number(path.slice("/api/style-lab/samples/".length));
		const hit = samplesListFixture.find((s) => s.id === id);
		if (hit) hit.verdict = body.verdict;
		return Promise.resolve({ sample: { id, verdict: body.verdict } });
	}
	return Promise.resolve({});
}

function buildReadShell() {
	document.body.innerHTML = `<div id="modal-mask" class="modal-mask hidden"><div class="modal"><h3 id="modal-title"></h3><div id="modal-body"></div><div class="modal-actions"><button id="modal-cancel" class="btn btn-ghost">取消</button><button id="modal-ok" class="btn btn-primary">确定</button></div></div></div><div id="toast" class="toast hidden"></div><header><nav><button id="read-samples-btn" class="btn btn-ghost btn-small" type="button" title="看本章检出过的 AI 味标本，并复核">错题库</button><button id="read-health-btn" class="btn btn-ghost btn-small hidden" type="button">AI 味体检</button></nav></header><textarea id="read-editor" class="read-editor hidden" placeholder="在这里逐句精修本章…"></textarea>`;
}

async function detectAndOpen() {
	renderStyleHealth("B1", "C1");
	await act(async () => {
		document.getElementById("read-health-btn").click();
	});
	await act(async () => {});
}

function postCount() {
	return apiCalls.filter((c) => c.method === "POST").length;
}

beforeEach(() => {
	buildReadShell();
	reportFixture = freshReport();
	samplesListFixture = freshReadSamples();
	samplesListTotal = 2;
	samplesFail = false;
	postFailMsg = null;
	postDeferred = null;
	segDiagnose = null;
	buildTextResult = "段落正文一\n段落正文二";
	buildBriefResult = "1. 明喻：比喻句式（可指名的毛病）";
	apiCalls = [];
	toasts = [];
	confirmCalls = [];
	confirmResult = true;
	clipWrites = [];
	clipReject = false;
	buildCalls = [];
	window.App = {
		api: mockApi,
		state: { currentChapter: { content: "已保存正文" } },
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
	// P6-2 转写：组件 App 取用改 lib 单例直取（§2.5-D1），harness 经注入缝装同一桩
	setAppForTests(window.App);
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
	stMock.diagnose = (text) => (segDiagnose ? segDiagnose(text) : []);
	stMock.buildTextList = (segs, opts) => {
		buildCalls.push({ kind: "text", segs, opts });
		return buildTextResult;
	};
	stMock.buildBrief = (segs, opts) => {
		buildCalls.push({ kind: "brief", segs, opts });
		return buildBriefResult;
	};
	// P6-2（⑨ 切换笔）：旧名桥退役后自挂载件由 initFrontendRuntime() 唯一调用；
	// harness 等价直调 mountStyleHealth()（等值原 registerLegacyBridges→mountStyleHealth）。
	mountStyleHealth();
});

afterEach(() => {
	setAppForTests(null);
});

describe("StyleHealthPanel 组件（范式 A·判定 C 旧名桥）", () => {
	it("H1 自挂载与绑定（P6-2 ⑨ 转写：模块直取）：renderStyleHealth/showStyleHealthSampleList 为模块导出；两静态按钮 onclick 已绑（mountStyleHealthPanel 直调）；按钮缺失 no-op；零窗口新名", () => {
		expect(typeof renderStyleHealth).toBe("function");
		expect(typeof showStyleHealthSampleList).toBe("function");
		expect(window.MozhenStyleHealth).toBeUndefined(); // 反向见证：模块面不外泄新窗口名
		expect(typeof document.getElementById("read-health-btn").onclick).toBe(
			"function",
		);
		expect(typeof document.getElementById("read-samples-btn").onclick).toBe(
			"function",
		);
		// 按钮缺失：重新注册（等价 init :255-260 的守卫绑定）不抛
		document.getElementById("read-health-btn")?.remove();
		document.getElementById("read-samples-btn")?.remove();
		expect(() => mountStyleHealth()).not.toThrow();
	});

	it("H2 render 显隐：chapterId 有值 → 去 hidden＋title 逐字；null → 加 hidden＋title 清空；按钮缺失仍先记态（:247-248 顺序）", async () => {
		const btn = document.getElementById("read-health-btn");
		renderStyleHealth("B1", 9);
		expect(btn.classList.contains("hidden")).toBe(false);
		expect(btn.title).toBe("用朱雀检测本章 AI 味（结果只作参考，不设达标线）");
		renderStyleHealth("B1", null);
		expect(btn.classList.contains("hidden")).toBe(true);
		expect(btn.title).toBe("");

		// 按钮缺失：render 仍先记模块态——samples 按钮以记录态发 GET（等值 :246-248）
		document.getElementById("read-health-btn")?.remove();
		renderStyleHealth("B9", "C9");
		await act(async () => {
			document.getElementById("read-samples-btn").click();
		});
		const get = apiCalls.find(
			(c) => c.method === "GET" && c.path.startsWith("/api/style-lab/samples?"),
		);
		expect(get.path).toBe(
			"/api/style-lab/samples?book_id=B9&chapter_id=C9&limit=100&order=conf",
		);
	});

	it("H3 体检主流程：POST detect-chapter 逐字 body → 报告渲染进 #modal-body（id 契约坑）；分数 toFixed(4)＋confLabel 五档阈值；meta 与 HUMAN_REF 提示逐字", async () => {
		await detectAndOpen();
		const post = apiCalls.find((c) => c.method === "POST");
		expect(post.path).toBe("/api/style-lab/detect-chapter");
		expect(post.body).toEqual({ book_id: "B1", chapter_id: "C1" });
		const body = document.getElementById("modal-body");
		expect(body.querySelector(".health-summary")).not.toBeNull();
		// #modal-body 契约坑：id 命中、class 选择器不命中（style-health.js:88-92 语义）
		expect(document.querySelector(".modal-body .health-summary")).toBeNull();
		expect(body.querySelector(".health-score").textContent).toBe("0.8413");
		expect(body.querySelector(".health-score").className).toBe(
			"health-score high",
		);
		expect(body.querySelector(".health-label").textContent).toBe("AI 味较重");
		expect(body.querySelector(".health-meta").textContent).toBe(
			"1234 字 · 567 tokens",
		);

		// confLabel 五档阈值逐档（style-health.js:21-28，与 rewrite-curve.test.js:85 同序）
		const cases = [
			[0.9, "0.9000", "AI 味很重", "high"],
			[0.7, "0.7000", "AI 味较重", "high"],
			[0.5, "0.5000", "疑似 AI", "mid"],
			[0.2, "0.2000", "偏人工", "low"],
			[0.1, "0.1000", "很像人写的", "low"],
			[null, "—", "—", "unknown"],
		];
		for (const [conf, score, text, cls] of cases) {
			reportFixture = { overall: { conf, char_count: 10 }, segments: [] };
			await detectAndOpen();
			const b = document.getElementById("modal-body");
			expect(b.querySelector(".health-score").textContent).toBe(score);
			expect(b.querySelector(".health-score").className).toBe(
				`health-score ${cls}`,
			);
			expect(b.querySelector(".health-label").textContent).toBe(text);
		}

		// meta：无 usage_tokens → 只有字数（:65-66 逐字形态）
		reportFixture = { overall: { conf: 0.4, char_count: 88 }, segments: [] };
		await detectAndOpen();
		expect(
			document.getElementById("modal-body").querySelector(".health-meta")
				.textContent,
		).toBe("88 字 · ");

		// HUMAN_REF 提示逐字（:62-71，含 strong ×3 与 <br> 形态）
		const hint = document
			.getElementById("modal-body")
			.querySelector("p.field-hint");
		expect(hint.textContent).toContain(
			"参考区间：人类原文实测 0.0003~0.0159。整篇分是篇章级聚合——同一章里 ~700 字的窗口通常只有 0.68~0.89，",
		);
		expect(hint.textContent).toContain(
			"所以别只盯这一个数，看下面哪几段判 AI。",
		);
		expect(hint.textContent).toContain(
			"别把分数贴给模型让它改：实测贴了不降反更碎（0.9999 → 0.9999，句子被拆成一句一段）；",
		);
		expect(hint.textContent).toContain(
			"分数也不进模型上下文（项目铁律，Goodhart）。要改就用下面的「复制待改段 / 改稿目标」（都不含分数）。",
		);
		expect(
			Array.from(hint.querySelectorAll("strong")).map((s) => s.textContent),
		).toEqual(["篇章级聚合", "哪几段判 AI", "别把分数贴给模型让它改"]);
		expect(hint.querySelector("br")).not.toBeNull();

		// 弹窗壳：title/okText（:159-164）
		expect(document.getElementById("modal-title").textContent).toBe(
			"AI 味体检结果",
		);
		expect(document.getElementById("modal-ok").textContent).toBe("知道了");
	});

	it("H4 分段渲染：label 文案/CLS 映射、conf toFixed(3) 与「—」、diagnose tags（title/×N）、正文转义；工具栏判 AI 计数与按钮 title 逐字", async () => {
		segDiagnose = (text) =>
			text.includes("第一段")
				? [
						{ label: "明喻", count: 2, hint: '像<x>"一样"的比喻' },
						{ label: "排比", count: 1, hint: "排比句式" },
					]
				: [];
		await detectAndOpen();
		const body = document.getElementById("modal-body");
		const segs = body.querySelectorAll(".health-seg");
		expect(segs.length).toBe(3);

		const s1 = segs[0];
		expect(s1.dataset.label).toBe("1");
		expect(s1.className).toBe("health-seg high");
		expect(s1.querySelector(".health-seg-label").textContent).toBe("AI");
		expect(s1.querySelector(".health-seg-label").className).toBe(
			"health-seg-label label-high",
		);
		expect(s1.querySelector(".health-seg-conf").textContent).toBe("0.912");
		const tags = s1.querySelectorAll(".curve-tag");
		expect(tags.length).toBe(2);
		expect(tags[0].textContent).toBe("明喻 ×2");
		expect(tags[0].getAttribute("title")).toBe('像<x>"一样"的比喻');
		expect(tags[1].textContent).toBe("排比");
		// 正文转义（script/b 标签不落地）
		expect(s1.querySelector(".health-seg-text").textContent).toBe(
			"第一段<b>加粗</b>正文",
		);
		expect(body.querySelector(".health-seg-text b")).toBeNull();

		const s2 = segs[1];
		expect(s2.dataset.label).toBe("0");
		expect(s2.className).toBe("health-seg low");
		expect(s2.querySelector(".health-seg-label").textContent).toBe("人工");
		expect(s2.querySelector(".health-seg-label").className).toBe(
			"health-seg-label label-low",
		);
		expect(s2.querySelectorAll(".curve-tag").length).toBe(0);

		const s3 = segs[2];
		expect(s3.dataset.label).toBe("2");
		expect(s3.className).toBe("health-seg unknown");
		expect(s3.querySelector(".health-seg-label").textContent).toBe("疑似");
		expect(s3.querySelector(".health-seg-conf").textContent).toBe("—");

		// 工具栏（:75-81）
		expect(
			body.querySelector("#health-only-ai").closest("label").textContent,
		).toContain("只看判 AI 的段（1）");
		expect(body.querySelector("#health-copy-text").getAttribute("title")).toBe(
			"只复制段落正文，便于人改",
		);
		expect(body.querySelector("#health-copy-brief").getAttribute("title")).toBe(
			"段落 + 可指名的毛病标签，不含任何分数",
		);
		// 尾注逐字（:84）
		expect(body.textContent).toContain(
			"判为 AI 的语句已自动进错题库，可在「错题库」页复核——你的复核结论决定它是否进入特征提取语料。",
		);
	});

	it("H5 只看判 AI：勾选 → 只剩 label===1 段＋「显示 N / M 段」；全筛空 → 空态文案逐字；筛选期间无第二次 detect POST", async () => {
		await detectAndOpen();
		expect(postCount()).toBe(1);
		const body = document.getElementById("modal-body");
		expect(body.querySelector("#health-seg-count").textContent).toBe(
			"显示 3 / 3 段",
		);
		await act(async () => {
			body.querySelector("#health-only-ai").click();
		});
		const remain = body.querySelectorAll("#health-segs .health-seg");
		expect(remain.length).toBe(1);
		expect(remain[0].dataset.label).toBe("1");
		expect(body.querySelector("#health-seg-count").textContent).toBe(
			"显示 1 / 3 段",
		);
		expect(postCount()).toBe(1); // 筛选不重新送检（不烧额度，:87 注释语义）

		// 全筛空 → 空态文案逐字（:103）
		reportFixture = {
			overall: { conf: 0.5, char_count: 50 },
			segments: [
				{ label: 0, conf: 0.1, text: "人写段" },
				{ label: 2, conf: 0.6, text: "疑似段" },
			],
		};
		await detectAndOpen();
		await act(async () => {
			document
				.getElementById("modal-body")
				.querySelector("#health-only-ai")
				.click();
		});
		expect(
			document
				.getElementById("modal-body")
				.querySelector("#health-segs .empty-hint").textContent,
		).toBe("没有判为「AI」的段——这章的分段里没有整段被判 AI 的。");
		expect(postCount()).toBe(2);
	});

	it("H6 复制双动作：buildTextList/buildBrief 透传 {onlyAi}（brief 带 withText）；成功 toast 逐字；空文本不触剪贴板；writeText 拒绝 → 降级 textarea 弹窗（ST 缺失臂已随 S5-10 退役留案）", async () => {
		await detectAndOpen();
		const body = document.getElementById("modal-body");
		await act(async () => {
			body.querySelector("#health-copy-text").click();
		});
		expect(buildCalls[0].kind).toBe("text");
		expect(buildCalls[0].segs).toEqual(reportFixture.segments);
		expect(buildCalls[0].opts).toEqual({ onlyAi: false });
		expect(clipWrites).toEqual(["段落正文一\n段落正文二"]);
		expect(toasts).toContain("已复制——不含任何检测分数");

		await act(async () => {
			body.querySelector("#health-copy-brief").click();
		});
		expect(buildCalls[1].kind).toBe("brief");
		expect(buildCalls[1].opts).toEqual({ withText: true, onlyAi: false });
		expect(clipWrites.length).toBe(2);

		// 勾选 onlyAi → 透传 true＋toast 变体（:122）
		await act(async () => {
			body.querySelector("#health-only-ai").click();
		});
		await act(async () => {
			body.querySelector("#health-copy-text").click();
		});
		expect(buildCalls[2].opts).toEqual({ onlyAi: true });
		expect(toasts).toContain("已复制（只含判 AI 的段）——不含任何检测分数");

		// 空文本：toast 且不触剪贴板（:119）
		const clipCount = clipWrites.length;
		buildTextResult = "  ";
		await act(async () => {
			body.querySelector("#health-copy-text").click();
		});
		expect(toasts).toContain("没有可复制的段落");
		expect(clipWrites.length).toBe(clipCount);

		// S5-10 退役留案（Plan §5.4；charter §2 豁免流程）：原「SegmentTargets 缺失 → toast
		// 『诊断模块未加载』且不触 build（:113）」臂在静态 import 下**不可达**——组件不再有
		// 「诊断模块缺失」态，故随 ST 标签退役一并留案（不改其余行为断言）。

		// writeText 拒绝 → 降级 textarea 弹窗（:124-129），内容等值转义（value＝原文）
		clipReject = true;
		await act(async () => {
			document
				.getElementById("modal-body")
				.querySelector("#health-copy-brief")
				.click();
		});
		const ta = document.querySelector("#modal-body .curve-copy-fallback");
		expect(ta).not.toBeNull();
		expect(ta.rows).toBe(12);
		expect(ta.value).toBe(buildBriefResult);
		expect(document.getElementById("modal-title").textContent).toBe(
			"手动复制（浏览器拒绝剪贴板）",
		);
		expect(document.getElementById("modal-ok").textContent).toBe("知道了");
	});

	it("H7 未保存确认门：#read-editor 可见且 value≠state.content → confirm 门（false 无 POST／true POST）；编辑器隐藏或值相同 → 无 confirm 直发", async () => {
		renderStyleHealth("B1", "C1");
		const btn = document.getElementById("read-health-btn");
		const editor = document.getElementById("read-editor");
		editor.classList.remove("hidden");
		editor.value = "未保存草稿";
		confirmResult = false;
		await act(async () => {
			btn.click();
		});
		expect(confirmCalls).toEqual([
			"精修区有未保存的改动，体检的是已保存的正文。继续？",
		]);
		expect(postCount()).toBe(0);

		confirmResult = true;
		await act(async () => {
			btn.click();
		});
		expect(postCount()).toBe(1);

		// 编辑器隐藏 → 无 confirm 直发（:149 hidden 判定）
		confirmCalls = [];
		editor.classList.add("hidden");
		await act(async () => {
			btn.click();
		});
		expect(confirmCalls).toEqual([]);
		expect(postCount()).toBe(2);

		// 值与已保存正文相同 → 无 confirm 直发（:152）
		editor.classList.remove("hidden");
		editor.value = "已保存正文";
		await act(async () => {
			btn.click();
		});
		expect(confirmCalls).toEqual([]);
		expect(postCount()).toBe(3);
	});

	it("H8 busy 纪律：POST 悬挂期再 click 恰 1 次 POST；按钮「体检中…」＋disabled；reject → toast「体检未完成：…」＋busy 复位可再点", async () => {
		renderStyleHealth("B1", "C1");
		const btn = document.getElementById("read-health-btn");
		let resolvePost;
		postDeferred = new Promise((r) => {
			resolvePost = r;
		});
		await act(async () => {
			btn.click();
		});
		expect(btn.textContent).toBe("体检中…");
		expect(btn.disabled).toBe(true);
		expect(postCount()).toBe(1);
		// 悬挂期再点：busy 门（S.running，:147）→ 恰 1 次 POST
		await act(async () => {
			btn.click();
		});
		expect(postCount()).toBe(1);
		await act(async () => {
			resolvePost(freshReport());
		});
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("AI 味体检");
		expect(
			document.getElementById("modal-body").querySelector(".health-summary"),
		).not.toBeNull();

		// reject → toast 逐字前缀＋复位可再点（:166-171）
		postDeferred = null;
		postFailMsg = "朱雀额度耗尽";
		await act(async () => {
			btn.click();
		});
		expect(toasts).toContain("体检未完成：朱雀额度耗尽");
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe("AI 味体检");
		await act(async () => {
			btn.click();
		});
		expect(postCount()).toBe(3);
	});

	it("H9 标本入口：GET ?book_id&chapter_id&limit=100&order=conf → 标题「本章错题库标本（N 条）」；行结构＋复核三按钮（无删除）；空列表 → 空态弹窗逐字", async () => {
		renderStyleHealth("B1", "C1");
		await act(async () => {
			document.getElementById("read-samples-btn").click();
		});
		const get = apiCalls.find(
			(c) => c.method === "GET" && c.path.startsWith("/api/style-lab/samples?"),
		);
		expect(get.path).toBe(
			"/api/style-lab/samples?book_id=B1&chapter_id=C1&limit=100&order=conf",
		);
		expect(document.getElementById("modal-title").textContent).toBe(
			"本章错题库标本（2 条）",
		);
		const body = document.getElementById("modal-body");
		const items = body.querySelectorAll(".sample-item");
		expect(items.length).toBe(2);
		expect(body.querySelectorAll("[data-review]").length).toBe(6);
		expect(body.querySelector("[data-del]")).toBeNull();

		const item1 = items[0];
		const conf1 = item1.querySelector(".health-seg-conf");
		expect(conf1.textContent).toBe("0.850");
		expect(conf1.className).toBe("health-seg-conf high");
		expect(item1.querySelector(".sample-verdict").textContent).toBe("待复核");
		const seen1 = item1.querySelector(".sample-seen");
		expect(seen1.textContent).toBe("×3");
		expect(seen1.getAttribute("title")).toBe("同一句被反复检出");
		expect(item1.querySelector(".sample-src").textContent).toBe("第三章 试炼");
		expect(item1.querySelector(".sample-text").textContent).toBe("标本正文一");
		// conf 0.31 → low 档；章节题缺失 → src 空（:206 无书号兜底，与错题库页不同）
		const conf2 = items[1].querySelector(".health-seg-conf");
		expect(conf2.textContent).toBe("0.310");
		expect(conf2.className).toBe("health-seg-conf low");
		expect(items[1].querySelector(".sample-src").textContent).toBe("");

		// 空列表 → 空态弹窗逐字（:189-197）
		samplesListFixture = [];
		samplesListTotal = 0;
		await act(async () => {
			document.getElementById("read-samples-btn").click();
		});
		expect(document.getElementById("modal-title").textContent).toBe(
			"本章错题库标本（0 条）",
		);
		expect(
			document.getElementById("modal-body").querySelector(".empty-hint")
				.textContent,
		).toBe("还没有标本。点「AI 味体检」检测本章后，判为 AI 的语句会自动进来。");
		expect(document.getElementById("modal-ok").textContent).toBe("知道了");
	});

	it("H10 复核动作：PATCH {verdict} → 行内 label class/text 更新＋toast「已记录复核结论」；弹窗内容宿主命中 #modal-body（:223 契约坑第二现场）", async () => {
		renderStyleHealth("B1", "C1");
		await act(async () => {
			document.getElementById("read-samples-btn").click();
		});
		await act(async () => {
			document
				.querySelector(
					'#modal-body .sample-item[data-id="21"] [data-review="human"]',
				)
				.click();
		});
		const patch = apiCalls.find((c) => c.method === "PATCH");
		expect(patch.path).toBe("/api/style-lab/samples/21");
		expect(patch.body).toEqual({ verdict: "human" });
		const label = document.querySelector(
			'#modal-body .sample-item[data-id="21"] .sample-verdict',
		);
		expect(label.className).toBe("sample-verdict verdict-human");
		expect(label.textContent).toBe("确认为人写");
		expect(toasts).toContain("已记录复核结论");
		// 宿主契约第二现场：sample-item 在 #modal-body（id）内，不在 .modal-body（class）内
		expect(document.querySelector(".modal-body .sample-item")).toBeNull();
		expect(
			document.getElementById("modal-body").querySelector(".sample-item"),
		).not.toBeNull();
	});
});
