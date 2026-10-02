// @vitest-environment jsdom
// S5-1 红测（Plan §4 R1~R14）：ReadPage 路由页范式 P（window.MozhenReadPage 桥委托）——
// public/legacy/book-read.js（709 行）等值迁 React，app.js:179 单行换名、:768 标签删、文件 git rm 全退役。
// 断言语义锚点＝public/legacy/book-read.js 活代码行号（Plan §4 表逐条）：
// R1 桥与挂载（:634-657）／R2 目录含未归卷组（:46-97）／R3 正文分段与字数（:171-193）／
// R4 导航（:195-205）／R5 偏好主题字号（:33-43/:207-229/:666-667）／R6 模式切换（:207-217）／
// R7 标题就地改名（:120-169）／R8 保存 428 重试与 409 冲突二选一（:232-284）／
// R9 侧边栏流式（:327-477）／R10 工具块与确认卡命令式槽位（:410-425）／R11 409 与重复请求（:379-401）／
// R12 选中段引用与替换＋sanitizeReply（:479-631）／R13 StyleHealth 消费（:111）／
// R14 命令式槽位与 ChatEventHub 直连 lib（全程 window.ChatEventHub 未定义）。
// harness 照抄 CardsPage.test.jsx / StyleHealthPanel.test.jsx：React 19 act ＋ 裸 DOM 断言；
// 预置 #page-read 静态壳（按 index.html:676-740 逐字）＋ #modal-mask 五件套 ＋ #toast；
// **不注册 window.ChatEventHub**（registerLegacyBridges 守卫注册后本文件删除该名——R14 证明 lib 直连）。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatApi } from "../components/ChatWorkspace.jsx";
import { setAppForTests } from "../lib/app-runtime.js";
import {
	mount as mountReadPage,
	sanitizeReply,
	splitParas,
} from "./ReadPage.jsx";

// P6-2 转写（Plan §2.4 T-F）：ReadPage 的三处 window 桩面改承接模块——
//   · App→`setAppForTests(window.App)`（§2.5-D1 单例注入缝）；
//   · 渲染器→`chatApi()`（未挂载面 NULL 占位单例）上的 spy 面（§2.5-D4）；
//   · ChapterConflict／StyleHealth→两组件模块 mock：记参并**委托真实现**（等值旧「记参包装
//     包住桥供给的真件」，保留模块态）。
const rec = vi.hoisted(() => ({ conflicts: [], styleHealth: [] }));
vi.mock("../components/ChapterConflictDialog.jsx", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		showConflictDialog: (opts) => {
			rec.conflicts.push(opts);
			return actual.showConflictDialog(opts);
		},
	};
});
vi.mock("../components/StyleHealthPanel.jsx", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		renderStyleHealth: (bid, cid) => {
			rec.styleHealth.push([bid, cid]);
			return actual.renderStyleHealth(bid, cid);
		},
	};
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// index.html:676-740 逐字（阅读 / 精修工作台静态壳）＋ :742-754 弹窗/toast 五件套
const READ_SHELL = `
<div id="page-read" class="page hidden">
  <header class="topbar read-topbar">
    <div class="topbar-left">
      <a id="read-return" href="#/" class="btn btn-ghost">← 返回写作页</a>
      <h1 id="read-book-title" class="book-title"></h1>
    </div>
    <nav class="topbar-actions">
      <span class="read-mode-switch">
        <button id="read-mode-read" class="btn btn-small mode-on" type="button">阅读</button>
        <button id="read-mode-edit" class="btn btn-small" type="button">精修</button>
      </span>
      <select id="read-theme" class="read-select" title="阅读主题">
        <option value="light">浅色</option>
        <option value="sepia">护眼</option>
        <option value="night">夜间</option>
      </select>
      <button id="read-font-minus" class="btn btn-ghost btn-small" type="button" title="缩小字号">A-</button>
      <button id="read-font-plus" class="btn btn-ghost btn-small" type="button" title="放大字号">A+</button>
      <button id="read-samples-btn" class="btn btn-ghost btn-small" type="button" title="看本章检出过的 AI 味标本，并复核">错题库</button>
      <button id="read-health-btn" class="btn btn-ghost btn-small hidden" type="button">AI 味体检</button>
      <button id="read-toggle-toc" class="btn btn-ghost btn-small" type="button">目录</button>
      <button id="read-toggle-ai" class="btn btn-ghost btn-small" type="button">AI</button>
    </nav>
  </header>
  <main class="read-main">
    <aside id="read-toc" class="read-toc">
      <div class="pane-head"><span class="pane-title">目录</span></div>
      <ul id="read-toc-list" class="item-list"></ul>
    </aside>
    <section id="read-center" class="read-center">
      <div class="read-chapter-head">
        <button id="read-prev" class="btn btn-ghost btn-small" type="button">← 上一章</button>
        <span id="read-chapter-title" class="read-chapter-title" role="button" tabindex="0" title="点击重命名本章（只改标题，不影响正文与定稿状态）"></span>
        <input id="read-chapter-title-input" class="read-chapter-title-input hidden" type="text" maxlength="120" placeholder="章节标题" autocomplete="off">
        <button id="read-next" class="btn btn-ghost btn-small" type="button">下一章 →</button>
      </div>
      <div id="read-article-wrap" class="read-article-wrap">
        <article id="read-article" class="read-article"></article>
        <textarea id="read-editor" class="read-editor hidden" placeholder="在这里逐句精修本章…"></textarea>
      </div>
      <div class="read-foot">
        <button id="read-save" class="btn btn-small hidden" type="button">保存</button>
        <button id="read-ai-revise" class="btn btn-small btn-outline hidden" type="button">让AI修改选中段</button>
        <button id="read-apply-reply" class="btn btn-small btn-outline hidden" type="button">用AI回复替换选中</button>
        <span id="read-word-count" class="word-count"></span>
      </div>
    </section>
    <aside id="read-ai" class="read-ai">
      <div class="chat-head">
        <span class="pane-title">AI 侧边栏</span>
        <span class="pane-head-btns"><button id="read-ai-clear" class="btn btn-ghost btn-small" type="button">清空</button></span>
      </div>
      <div id="read-ai-messages" class="chat-messages"></div>
      <div id="read-ai-quote" class="read-ai-quote hidden">
        <span id="read-ai-quote-text" class="read-ai-quote-text"></span>
        <button id="read-ai-quote-clear" class="icon-btn" type="button" title="清除选中段">×</button>
      </div>
      <form id="read-ai-form" class="chat-input">
        <textarea id="read-ai-text" rows="2" placeholder="选中正文后上方会显示选中段；输入你的要求（改写/更简洁/换语气/分析…）发送；未选中时即全书讨论"></textarea>
        <button type="button" id="read-ai-stop" class="btn btn-small btn-stop hidden" title="中止当前生成（已生成的部分会保留）">停止</button>
        <button type="submit" id="read-ai-send" class="btn btn-primary">发送</button>
      </form>
    </aside>
  </main>
</div>
<div id="modal-mask" class="modal-mask hidden">
  <div class="modal">
    <h3 id="modal-title"></h3>
    <div id="modal-body"></div>
    <div class="modal-actions">
      <button id="modal-cancel" class="btn btn-ghost">取消</button>
      <button id="modal-ok" class="btn btn-primary">确定</button>
    </div>
  </div>
</div>
<div id="toast" class="toast hidden"></div>
`;

function freshVolumes() {
	return [
		{ id: 10, title: "第一卷 试炼" },
		{ id: 11, title: "第二卷 余烬" },
	];
}

function freshChapters() {
	// 103＝volume_id 空（未归卷）、104＝volume_id 指向不存在的卷（悬空卷，:80-91 两种兜底同组）
	return [
		{
			id: 101,
			title: "第一章 起点",
			volume_id: 10,
			revision: 3,
			content: "第一段落。\n第二段落。\n",
		},
		{
			id: 102,
			title: "第二章 转折",
			volume_id: 10,
			revision: 4,
			content: "转折正文",
		},
		{
			id: 103,
			title: "第三章 悬空",
			volume_id: null,
			revision: 1,
			content: "",
		},
		{
			id: 104,
			title: "第四章 幽灵卷",
			volume_id: 999,
			revision: 2,
			content: "幽灵卷正文",
		},
		{
			id: 105,
			title: "第五章 尾章",
			volume_id: 11,
			revision: 7,
			content: "尾章正文",
		},
	];
}

let volumesFixture;
let chaptersFixture;
let apiCalls;
let toasts;
let toolCalls;
let actionCalls;
let styleHealthCalls;
let conflictCalls;
let apiFail;
let putConflict;
let autoUnlocked;
let putFail;
let streamResponder;
let fetchCalls;
// 所有已打开的 SSE 流控制器（含 hold 场景）——afterEach 统一关闭，防未消费的流把
// 后续测试的 act 冲刷挂住（R10~R14 顺序假红的根因：R9 的两条 hold 流未收尾）。
let openStreams;

function jsonRes(status, data) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (k) =>
				String(k).toLowerCase() === "content-type" ? "application/json" : null,
		},
		json: async () => data,
		body: null,
	};
}

// SSE 响应：Node 24 全局 ReadableStream；abort 时把流打成 AbortError（等价真实 fetch 的 signal 语义）
function sseRes(events, opts) {
	const o = opts || {};
	const text =
		(events || []).map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
		(o.tail || "");
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		start(c) {
			openStreams.push(c);
			for (const line of text.split("\n\n")) {
				if (line) c.enqueue(enc.encode(`${line}\n\n`));
			}
			if (!o.hold) c.close();
			o.onStart?.(c);
		},
	});
	return {
		ok: true,
		status: 200,
		headers: {
			get: (k) =>
				String(k).toLowerCase() === "content-type" ? "text/event-stream" : null,
		},
		body: stream,
		json: async () => ({}),
	};
}

function mockApi(method, path, body) {
	apiCalls.push({ method, path, body });
	if (apiFail) return Promise.reject(Object.assign(new Error("网络故障"), {}));
	if (method === "GET" && path === "/api/books/B1") {
		return Promise.resolve({ book: { id: "B1", title: "测试之书" } });
	}
	if (method === "GET" && path === "/api/books/B1/volumes") {
		return Promise.resolve({ volumes: volumesFixture });
	}
	if (method === "GET" && path === "/api/books/B1/chapters") {
		return Promise.resolve({ chapters: chaptersFixture });
	}
	if (method === "GET" && /^\/api\/books\/B1\/chapters\/\d+$/.test(path)) {
		const id = Number(path.slice("/api/books/B1/chapters/".length));
		const ch = chaptersFixture.find((c) => c.id === id);
		return Promise.resolve({ chapter: { ...ch } });
	}
	if (method === "PUT" && /^\/api\/books\/B1\/chapters\/\d+$/.test(path)) {
		if (putFail) return Promise.reject(putFail);
		if (putConflict)
			return Promise.reject(
				Object.assign(new Error("章节已被修改，请刷新后重试"), {
					code: putConflict.code,
					status: putConflict.status,
				}),
			);
		const id = Number(path.slice("/api/books/B1/chapters/".length));
		const ch = chaptersFixture.find((c) => c.id === id) || {};
		if (body.title != null) {
			ch.title = body.title;
			return Promise.resolve({ chapter: { ...ch, title: body.title } });
		}
		ch.content = body.content;
		ch.revision = (ch.revision || 0) + 1;
		return Promise.resolve({ chapter: { ...ch }, autoUnlocked: autoUnlocked });
	}
	if (method === "POST" && path === "/api/style-lab/detect-chapter") {
		return Promise.resolve({ overall: { conf: 0.5 }, segments: [] });
	}
	if (method === "GET" && path.startsWith("/api/style-lab/samples?")) {
		return Promise.resolve({ samples: [], total: 0 });
	}
	return Promise.resolve({});
}

// React 受控 input/textarea 的 jsdom 赋值必须走原生 setter，否则 value 被覆盖回 state 值
// （CardsPage.test.jsx:237-245 同款：按 tag 分派原型——title 输入框是 <input>）
function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

// 统一冲刷：act 内等够宏任务（链式 await 在整文件并发下需更长时间落定）
async function flush(ms) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms == null ? 30 : ms));
	});
}

// 确定性等待：轮询 cond 至真（act 包裹，默认上限 1.5s）——替代固定 sleep 抗负载抖动
async function waitFor(cond, timeout) {
	const limit = timeout == null ? 1500 : timeout;
	const t0 = Date.now();
	for (;;) {
		let ok = false;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 5));
			ok = !!cond();
		});
		if (ok) return true;
		if (Date.now() - t0 > limit) return false;
	}
}

async function mountAndLoad(bookId, chapterId) {
	act(() => {
		mountReadPage(bookId || "B1", chapterId);
	});
	await act(async () => {});
	await flush();
}

function getChapters() {
	return apiCalls.filter(
		(c) => c.method === "GET" && c.path === "/api/books/B1/chapters",
	);
}

// 发送并等流消费收尾（确定性：等到发送按钮解禁——streamChat 的 finally 复位）。
// opts.hold＝流故意不关（停止/打断场景），只能提交后立即返回，由调用方自行 waitFor 目标态。
async function sendChat(text, opts) {
	const input = document.getElementById("read-ai-text");
	await act(async () => {
		setInputValue(input, text);
	});
	await act(async () => {
		document
			.getElementById("read-ai-form")
			.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	if (opts?.hold) {
		await flush(20);
		return;
	}
	await flush(20);
	await waitFor(() => !document.getElementById("read-ai-send")?.disabled);
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = READ_SHELL;
	volumesFixture = freshVolumes();
	chaptersFixture = freshChapters();
	apiCalls = [];
	toasts = [];
	toolCalls = [];
	actionCalls = [];
	rec.conflicts.length = 0; // P6-2：模块 mock 的记参 holder 逐测清空（等值旧逐测新建数组）
	rec.styleHealth.length = 0;
	styleHealthCalls = [];
	conflictCalls = [];
	apiFail = false;
	putConflict = null;
	autoUnlocked = false;
	putFail = null;
	fetchCalls = [];
	openStreams = [];
	streamResponder = () =>
		sseRes([
			{ type: "content", text: "回答正文" },
			{ type: "done", content: "回答正文" },
		]);
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
	};
	// P6-2 转写：App 取用改 lib 单例直取（§2.5-D1），harness 经注入缝装同一桩
	setAppForTests(window.App);
	// P6-2 转写：工具块/确认卡渲染器改 `chatApi()` 直取（§2.5-D4）——spy 面等值旧 window.BookPage 桩
	const chat = chatApi(); // 未挂载面 NULL 占位单例（本 harness 不挂聊天面）
	vi.spyOn(chat, "renderToolEvent").mockImplementation((t) => {
		toolCalls.push(t);
		const el = document.createElement("div");
		el.className = "tool-block";
		el.textContent = `工具:${t.name}`;
		return el;
	});
	vi.spyOn(chat, "renderActionCard").mockImplementation((a, opts) => {
		actionCalls.push({ a, opts });
		const el = document.createElement("div");
		el.className = "action-card";
		el.textContent = `确认卡:${a.name}`;
		return el;
	});
	// R14：全程 window.ChatEventHub 未定义（lib 直连证明）——registerLegacyBridges 的守卫注册在此删除
	delete window.ChatEventHub;
	// P6-2 转写：两记录面由 beforeEach 顶部的模块 mock 承接（conflictCalls/styleHealthCalls
	// 直接指向同一 holder 数组；旧「包住 window 旧名桥」的记参包装语义逐字保留）
	conflictCalls = rec.conflicts;
	styleHealthCalls = rec.styleHealth;
	// fetch stub：SSE（ReadPage 唯一直接 fetch 的出口＝/chat/stream）＋幂等轮询通道
	globalThis.fetch = async (url, opts) => {
		fetchCalls.push({
			url,
			method: opts?.method,
			body: opts?.body ? JSON.parse(opts.body) : null,
			hasSignal: !!opts?.signal,
		});
		if (String(url).indexOf("/api/runs/") === 0) {
			return {
				ok: true,
				status: 200,
				headers: { get: () => "application/json" },
				json: async () => ({ events: [], status: "finished", nextAfterSeq: 1 }),
			};
		}
		return streamResponder(opts);
	};
});

afterEach(async () => {
	// P6-2：单例注入与渲染器 spy 逐测复位（防跨测残留）
	setAppForTests(null);
	vi.restoreAllMocks();
	// 收尾纪律（本文件顺序假红的根因）：① 关掉所有还开着的 SSE 流——未消费的流会让下一测试的
	// act 冲刷被挂住，React 提交永不落定（R10~R14 曾因此假红而单跑全绿）；
	// ② 卸载 React root——根缓存在 #page-read 元素上，壳被重建后旧 root 的异步链会污染后续观察。
	for (const c of openStreams) {
		try {
			c.close();
		} catch (_e) {
			/* 已关闭/已出错 */
		}
	}
	openStreams = [];
	const el = document.getElementById("page-read");
	if (el?.__mozhenReadRoot) {
		try {
			await act(async () => {
				el.__mozhenReadRoot.unmount();
			});
		} catch (_e) {
			/* 已卸载 */
		}
		delete el.__mozhenReadRoot;
	}
});

describe("ReadPage 组件（路由页范式 P）", () => {
	it("R1 桥与挂载：MozhenReadPage.show 可用；#page-read 缺失 no-op；二次 show 重挂重拉；书名与返回链接（:634-657）", async () => {
		expect(typeof mountReadPage).toBe("function");
		const shellHTML = document.getElementById("page-read").outerHTML;
		document.getElementById("page-read")?.remove();
		expect(() => mountReadPage("B1")).not.toThrow();
		await act(async () => {});
		document.body.insertAdjacentHTML("afterbegin", shellHTML);

		await mountAndLoad("B1", null);
		expect(document.getElementById("read-book-title").textContent).toBe(
			"测试之书",
		);
		expect(document.getElementById("read-return").getAttribute("href")).toBe(
			"#/book/B1",
		);
		// 入参缺章：回退 localStorage 进度 → 否则首章（:646-650）
		expect(apiCalls.some((c) => c.path === "/api/books/B1/chapters/101")).toBe(
			true,
		);
		expect(getChapters().length).toBe(1);

		await mountAndLoad("B1", null);
		expect(getChapters().length).toBe(2); // 重挂重拉（旧 show() 每次重置）
		// 进度键写入当前章
		expect(localStorage.getItem("novel-read:progress:B1")).toBe("101");
	});

	it("R2 目录：卷序＋卷内章节＋未归卷组（volume_id 空/悬空）＋活动态＋点击选章（:46-97）", async () => {
		await mountAndLoad("B1", null);
		const list = document.getElementById("read-toc-list");
		expect(
			Array.from(list.querySelectorAll(".read-toc-vol")).map(
				(n) => n.textContent,
			),
		).toEqual(["第一卷 试炼", "第二卷 余烬", "未归卷"]);
		const items = Array.from(list.querySelectorAll(".read-toc-item"));
		expect(items.map((n) => n.dataset.id)).toEqual([
			"101",
			"102",
			"105",
			"103",
			"104",
		]);
		// 悬空卷（104）与空 volume_id（103）同入「未归卷」组，组标题类名 read-toc-orphan
		expect(
			list.querySelector("li.read-toc-vol.read-toc-orphan").textContent,
		).toBe("未归卷");
		// 活动态＝当前章
		expect(list.querySelector('.read-toc-item[data-id="101"]').className).toBe(
			"read-toc-item active",
		);
		// 点击项 → GET /chapters/:id 并渲染
		await act(async () => {
			list.querySelector('.read-toc-item[data-id="102"]').click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(apiCalls.some((c) => c.path === "/api/books/B1/chapters/102")).toBe(
			true,
		);
		expect(document.getElementById("read-chapter-title").textContent).toBe(
			"第二章 转折",
		);
		expect(localStorage.getItem("novel-read:progress:B1")).toBe("102");
	});

	it("R3 正文与字数：data-pidx 段序＋转义、空章提示、编辑器取值、去空白计数（:171-193）", async () => {
		chaptersFixture[0].content =
			"第一段<b>粗</b>。\n\n第二段。<script>x</script>\n";
		await mountAndLoad("B1", 101);
		const art = document.getElementById("read-article");
		const ps = Array.from(art.querySelectorAll("p[data-pidx]"));
		expect(ps.map((p) => p.dataset.pidx)).toEqual(["0", "1"]);
		expect(ps[0].textContent).toBe("第一段<b>粗</b>。"); // 转义为文本，无元素
		expect(art.querySelectorAll("b,script").length).toBe(0);
		expect(ps[1].textContent).toBe("第二段。<script>x</script>");
		// 字数＝去空白计数（:31/:190-193）
		const content = chaptersFixture[0].content;
		const n = content.replace(/\s/g, "").length;
		expect(document.getElementById("read-word-count").textContent).toBe(
			`共 ${n} 字`,
		);
		expect(document.getElementById("read-editor").value).toBe(content);

		// 空章 → 「（本章还没有内容）」
		await mountAndLoad("B1", 103);
		expect(
			document.getElementById("read-article").querySelector(".read-empty")
				.textContent,
		).toBe("（本章还没有内容）");
		expect(document.getElementById("read-word-count").textContent).toBe(
			"共 0 字",
		);
	});

	it("R4 导航：首页/中间章/末章 disabled 与越界不动（:195-205）", async () => {
		await mountAndLoad("B1", 101);
		const prev = document.getElementById("read-prev");
		const next = document.getElementById("read-next");
		expect(prev.disabled).toBe(true);
		expect(next.disabled).toBe(false);
		await act(async () => {
			next.click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(document.getElementById("read-chapter-title").textContent).toBe(
			"第二章 转折",
		);
		await act(async () => {
			document.getElementById("read-prev").click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(document.getElementById("read-chapter-title").textContent).toBe(
			"第一章 起点",
		);
		// 末章（目录序末位＝104 幽灵卷）：next disabled，点击不动（stepChapter 越界）
		await mountAndLoad("B1", 104);
		await act(async () => {
			document.getElementById("read-next").click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(document.getElementById("read-next").disabled).toBe(true);
		expect(document.getElementById("read-chapter-title").textContent).toBe(
			"第四章 幽灵卷",
		);
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === "/api/books/B1/chapters/104",
			).length,
		).toBe(1);
	});

	it("R5 偏好：主题/字号读写 localStorage、三态类名、14~28 边界、两元素像素差 2（:33-43/:207-229/:666-667）", async () => {
		localStorage.setItem("novel-read:theme:B1", "night");
		localStorage.setItem("novel-read:fontSize:B1", "28");
		await mountAndLoad("B1", 101);
		const center = document.getElementById("read-center");
		expect(center.className).toContain("theme-night");
		expect(center.className).not.toContain("theme-sepia");
		expect(document.getElementById("read-theme").value).toBe("night");
		// 字号边界：28 已上限，A+ 不再加
		const art = document.getElementById("read-article");
		const ed = document.getElementById("read-editor");
		expect(art.style.fontSize).toBe("28px");
		expect(ed.style.fontSize).toBe("26px"); // max(14, 28-2)
		await act(async () => {
			document.getElementById("read-font-plus").click();
		});
		expect(localStorage.getItem("novel-read:fontSize:B1")).toBe("28");
		expect(art.style.fontSize).toBe("28px");
		// A- 落 27；再连点至 14 边界
		await act(async () => {
			document.getElementById("read-font-minus").click();
		});
		expect(localStorage.getItem("novel-read:fontSize:B1")).toBe("27");
		expect(art.style.fontSize).toBe("27px");
		expect(ed.style.fontSize).toBe("25px");
		// 主题切换：三选一类名互斥＋回填 select＋写键
		await act(async () => {
			const sel = document.getElementById("read-theme");
			sel.value = "sepia";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(document.getElementById("read-center").className).toContain(
			"theme-sepia",
		);
		expect(document.getElementById("read-center").className).not.toContain(
			"theme-night",
		);
		expect(localStorage.getItem("novel-read:theme:B1")).toBe("sepia");
	});

	it("R6 模式切换：精修显编辑器/阅读回隐藏并收起两 AI 按钮（:207-217）", async () => {
		await mountAndLoad("B1", 101);
		const editor = document.getElementById("read-editor");
		const article = document.getElementById("read-article");
		const save = document.getElementById("read-save");
		expect(editor.className).toContain("hidden");
		expect(article.className).not.toContain("hidden");
		expect(save.className).toContain("hidden");
		expect(document.getElementById("read-mode-read").className).toContain(
			"mode-on",
		);

		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		expect(editor.className).not.toContain("hidden");
		expect(article.className).toContain("hidden");
		expect(save.className).not.toContain("hidden");
		expect(document.getElementById("read-mode-edit").className).toContain(
			"mode-on",
		);

		await act(async () => {
			document.getElementById("read-mode-read").click();
		});
		expect(editor.className).toContain("hidden");
		expect(document.getElementById("read-ai-revise").className).toContain(
			"hidden",
		);
		expect(document.getElementById("read-apply-reply").className).toContain(
			"hidden",
		);
	});

	it("R7 标题改名：就地输入＋Enter 提交＋同名/空跳过＋Esc 取消＋先存正文＋失败还原不动编辑器（:120-169）", async () => {
		await mountAndLoad("B1", 101);
		const title = document.getElementById("read-chapter-title");
		const input = document.getElementById("read-chapter-title-input");
		await act(async () => {
			title.click();
		});
		expect(input.className).not.toContain("hidden");
		expect(title.className).toContain("hidden");
		expect(input.value).toBe("第一章 起点");
		// ISSUE-1（S5-1-review-1）：进入编辑态须完成 focus＋全选（等值 legacy :127-129
		// `input.focus(); input.select();`——同步两行，目标此刻已去 hidden）。
		// jsdom 与真实 Chrome 的差异已知：jsdom 对 display:none 元素仍允许 focus
		// （本片探针实测），故**选区**才是能在 jsdom 内真实转红的判别位（bug 版停在 6/6）。
		expect(document.activeElement.id).toBe("read-chapter-title-input");
		expect(`${input.selectionStart}/${input.selectionEnd}`).toBe("0/6");

		// 同名 → 不改（零 PUT）
		const puts0 = apiCalls.filter((c) => c.method === "PUT").length;
		await act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(apiCalls.filter((c) => c.method === "PUT").length).toBe(puts0);

		// 正常改名：PUT {title, expected_revision}
		await act(async () => {
			title.click();
		});
		await act(async () => {
			setInputValue(input, "第一章 起点（改）");
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 10));
		});
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/books/B1/chapters/101",
		);
		expect(put.body).toEqual({
			title: "第一章 起点（改）",
			expected_revision: 3,
		});
		expect(toasts).toContain("已重命名");
		expect(document.getElementById("read-chapter-title").textContent).toBe(
			"第一章 起点（改）",
		);
		expect(
			document
				.getElementById("read-toc-list")
				.querySelector('.read-toc-item[data-id="101"]').textContent,
		).toBe("第一章 起点（改）");

		// Esc 取消：无 PUT
		const puts1 = apiCalls.filter((c) => c.method === "PUT").length;
		await act(async () => {
			title.click();
		});
		await act(async () => {
			input.value = "不应提交";
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(apiCalls.filter((c) => c.method === "PUT").length).toBe(puts1);

		// 精修模式且正文已改未存：先 PUT 正文再 PUT 标题（:147-150）
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "手改正文");
		});
		await act(async () => {
			title.click();
		});
		await act(async () => {
			setInputValue(input, "改名并保正文");
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 20));
		});
		const putSeq = apiCalls.filter((c) => c.method === "PUT");
		expect(putSeq[putSeq.length - 2].body).toEqual({
			content: "手改正文",
			expected_revision: 3,
		});
		expect(putSeq[putSeq.length - 1].body.title).toBe("改名并保正文");

		// 失败：toast ＋ 标题还原；精修冲突时编辑器内容不被回填（:163-168）
		const before = document.getElementById("read-editor").value;
		putFail = new Error("标题保存失败");
		await act(async () => {
			title.click();
		});
		await act(async () => {
			setInputValue(input, "失败的标题");
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(toasts).toContain("标题保存失败");
		expect(document.getElementById("read-editor").value).toBe(before);
		putFail = null;
	});

	it("R8 保存：PUT 形态＋autoUnlocked 文案＋428 恰一次重读重试＋409 ChapterConflict 二选一＋无桥兜底（:232-284）", async () => {
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		// 正常保存：PUT {content, expected_revision}
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "新正文一");
		});
		await act(async () => {
			document.getElementById("read-save").click();
			await new Promise((r) => setTimeout(r, 10));
		});
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/books/B1/chapters/101",
		);
		expect(put.body.expected_revision).toBe(3);
		expect(toasts).toContain("已保存");

		// autoUnlocked 文案
		autoUnlocked = true;
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "新正文二");
		});
		await act(async () => {
			document.getElementById("read-save").click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(toasts).toContain("该章原定稿，修改后已自动解除定稿");

		// 428：本地无 revision → 重读一次再重试（恰一次），第二次 PUT 带新 revision
		chaptersFixture.find((c) => c.id === 102).revision = undefined;
		await mountAndLoad("B1", 102);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "补版本正文");
		});
		// 首 PUT 抛 428 → 组件 GET 重读（补上 revision）→ 第二次 PUT 成功；共 2 PUT + 1 重读 GET
		let firstPut = true;
		const origPut = mockApi;
		window.App.api = (method, path, body) => {
			apiCalls.push({ method, path, body });
			if (method === "PUT") {
				if (firstPut) {
					firstPut = false;
					return Promise.reject(
						Object.assign(new Error("需要版本"), {
							code: "CHAPTER_REVISION_REQUIRED",
						}),
					);
				}
				const ch = chaptersFixture.find((c) => c.id === 102);
				ch.content = body.content;
				return Promise.resolve({ chapter: { ...ch } });
			}
			if (method === "GET" && path === "/api/books/B1/chapters/102") {
				const ch = chaptersFixture.find((c) => c.id === 102);
				return Promise.resolve({ chapter: { ...ch, revision: 9 } }); // 重读补上版本
			}
			return origPut(method, path, body);
		};
		await act(async () => {
			document.getElementById("read-save").click();
		});
		await flush(60);
		const puts428 = apiCalls.filter(
			(c) => c.method === "PUT" && c.path === "/api/books/B1/chapters/102",
		);
		expect(puts428.length).toBe(2);
		expect(puts428[1].body.expected_revision).toBe(9); // 重试用重读后的 revision
		expect(
			apiCalls.filter(
				(c) => c.method === "GET" && c.path === "/api/books/B1/chapters/102",
			).length,
		).toBe(2); // 挂载选章 1 次＋428 重读 1 次

		// 409：GET 最新版 → ChapterConflict.show({server, local:{content}, onReload})
		window.App.api = mockApi;
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		putConflict = { code: "CHAPTER_CONFLICT", status: 409 };
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "冲突本地稿");
		});
		await act(async () => {
			document.getElementById("read-save").click();
		});
		await flush(60);
		putConflict = null;
		expect(conflictCalls.length).toBe(1);
		expect(conflictCalls[0].local).toEqual({ content: "冲突本地稿" });
		expect(conflictCalls[0].server.id).toBe(101);
		expect(typeof conflictCalls[0].onReload).toBe("function");
		// onReload：当前章一致才换 S.chapter 并重渲染编辑器
		await act(async () => {
			conflictCalls[0].onReload({
				...chaptersFixture[0],
				content: "服务端版本",
			});
		});
		expect(document.getElementById("read-editor").value).toBe("服务端版本");

		// P6-2 转写（§2.5-D5）:`showConflictDialog` 经模块导出直取 ⇒ 旧「无 ChapterConflict → toast
		// 兜底」臂不可达（模块面恒在，无缺名态可构造）；等价见证＝第二次 409 仍走弹窗（记参 +1），
		// 且**不再**出现兜底 toast（原断言的负向孪生，一并钉住）
		putConflict = { code: "CHAPTER_CONFLICT", status: 409 };
		await act(async () => {
			setInputValue(document.getElementById("read-editor"), "冲突本地稿二");
		});
		await act(async () => {
			document.getElementById("read-save").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		putConflict = null;
		expect(conflictCalls.length).toBe(2);
		expect(toasts).not.toContain(
			"章节已在其他窗口被修改，本地稿已保留在编辑器中，请核对后重试",
		);
	});

	it("R9 侧边栏流式：POST 形态含 source=read 与会话键、delta 累积、无选区不放行替换、停止文案（:327-477）", async () => {
		localStorage.setItem("writing_conversation_B1", "conv-9");
		streamResponder = () =>
			sseRes([
				{ type: "content", text: "第一段" },
				{ type: "content", text: "第二段" },
				{ type: "done", content: "第一段第二段" },
			]);
		await mountAndLoad("B1", 101);
		await sendChat("帮我看看这一章");

		const f = fetchCalls.find(
			(c) => String(c.url).indexOf("/chat/stream") >= 0,
		);
		expect(f.method).toBe("POST");
		expect(f.body.source).toBe("read");
		expect(f.body.chapterId).toBe(101);
		expect(f.body.content).toBe("帮我看看这一章");
		expect(f.body.conversationId).toBe("conv-9");
		expect(typeof f.body.request_id).toBe("string");
		expect(f.body.request_id.indexOf("read_")).toBe(0);
		expect(f.hasSignal).toBe(true);

		const bubbles = document.querySelectorAll("#read-ai-messages .msg-bubble");
		expect(bubbles.length).toBe(2); // userEcho ＋ assistant
		expect(bubbles[1].textContent).toBe("第一段第二段");
		// 无选区（targetSel 为 null）→ 替换按钮不放行
		expect(document.getElementById("read-apply-reply").className).toContain(
			"hidden",
		);
		// 收尾复位：发送按钮可用、停止按钮隐藏
		expect(document.getElementById("read-ai-send").disabled).toBe(false);
		expect(document.getElementById("read-ai-stop").className).toContain(
			"hidden",
		);

		// 停止：abort 文案「（已停止生成）」
		streamResponder = (opts) =>
			sseRes([{ type: "content", text: "半截输出" }], {
				hold: true,
				onStart: (c) => {
					opts?.signal?.addEventListener("abort", () => {
						try {
							c.error(new DOMException("Aborted", "AbortError"));
						} catch (_e) {
							/* ignore */
						}
					});
				},
			});
		await sendChat("长任务", { hold: true });
		expect(document.getElementById("read-ai-send").disabled).toBe(true);
		expect(document.getElementById("read-ai-stop").className).not.toContain(
			"hidden",
		);
		await act(async () => {
			document.getElementById("read-ai-stop").click();
		});
		await waitFor(() =>
			Array.from(document.querySelectorAll("#read-ai-messages .msg-bubble"))
				.map((n) => n.textContent)
				.some((t) => t.indexOf("（已停止生成）") >= 0),
		);
		const last = document.querySelectorAll("#read-ai-messages .msg-bubble");
		expect(last[last.length - 1].textContent).toContain("（已停止生成）");

		// 新提问打断：旧气泡「（本次请求已被新的提问取消）」
		// 可 abort 的 hold 流（真实 fetch 语义：signal 中止 → reader 抛 AbortError）。
		// 关键纪律：旧请求的 act 作用域必须先收尾再发第二问——同时挂两个 act 会「overlapping act()」，
		// React 内部队列就此错乱，后续测试的渲染提交全部失效（R10~R14 集体假红的真正根因）。
		const abortableHold = (opts) =>
			sseRes([{ type: "content", text: "旧回答片段" }], {
				hold: true,
				onStart: (c) => {
					opts?.signal?.addEventListener("abort", () => {
						try {
							c.error(new DOMException("Aborted", "AbortError"));
						} catch (_e) {
							/* ignore */
						}
					});
				},
			});
		streamResponder = abortableHold;
		await sendChat("第一问", { hold: true }); // 发完即回，不挂 promise
		expect(document.getElementById("read-ai-send").disabled).toBe(true);
		// 第二问在同一 act 作用域内发出并等它整链收尾（打断语义在 submit 时同步触发）
		streamResponder = () => sseRes([{ type: "done", content: "第二问回答" }]);
		await sendChat("第二问");
		const ok = await waitFor(() =>
			Array.from(document.querySelectorAll("#read-ai-messages .msg-bubble"))
				.map((n) => n.textContent)
				.some((t) => t.indexOf("（本次请求已被新的提问取消）") >= 0),
		);
		expect(ok).toBe(true);
		await flush(30); // 静默收尾：确认无残链待冲刷
	});

	it("R10 工具块/确认卡：命令式槽位——顺序在气泡前、opts 恰三键、React 重渲染后节点仍在（:410-425）", async () => {
		streamResponder = () =>
			sseRes([
				{
					type: "tool",
					name: "create_chapter",
					args: { title: "新章" },
					result: { ok: true },
				},
				{
					type: "action",
					id: 5,
					name: "replace_chapter",
					args: { chapterId: 101, content: "x" },
				},
				{ type: "content", text: "已处理" },
				{ type: "done", content: "已处理" },
			]);
		await mountAndLoad("B1", 101);
		await sendChat("写一章");
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].name).toBe("create_chapter");
		expect(actionCalls.length).toBe(1);
		expect(actionCalls[0].a.name).toBe("replace_chapter");
		expect(Object.keys(actionCalls[0].opts).sort()).toEqual([
			"bookId",
			"onSettled",
			"resume",
		]);
		expect(actionCalls[0].opts.bookId).toBe("B1");
		expect(typeof actionCalls[0].opts.onSettled).toBe("function");
		expect(typeof actionCalls[0].opts.resume).toBe("function");
		// DOM 顺序：工具块、确认卡被 insertBefore(bubble) 插进气泡所在消息 div，排在气泡前（:413/:423）；
		// source='read' 有来源标注行（:305-312），故 msg-role 在最前
		const wrap = document.getElementById("read-ai-messages");
		const assistantDiv = wrap.querySelector(".msg.assistant");
		const inner = Array.from(assistantDiv.children);
		expect(inner.map((n) => n.className)).toEqual([
			"msg-role",
			"tool-block",
			"action-card",
			"msg-bubble",
		]);
		expect(wrap.querySelectorAll(".tool-block, .action-card").length).toBe(2);
		// React 重渲染（切主题）后外来节点仍在（契约 1：React 不参与该容器 reconciliation）
		await act(async () => {
			const sel = document.getElementById("read-theme");
			sel.value = "sepia";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(wrap.querySelectorAll(".tool-block, .action-card").length).toBe(2);
		// P6-2 转写（§2.5-D4）：渲染器经 `chatApi()` 直取 ⇒ 旧「window.BookPage 缺失→静默跳过」臂
		// 不可达（模块面恒有渲染器，无缺名态可构造）；等价见证＝该轮工具块照常渲染（原 1＝首轮旧块
		// 留存且无新块，现 2＝新块入槽）
		streamResponder = () =>
			sseRes([
				{ type: "tool", name: "list_resources" },
				{ type: "done", content: "ok" },
			]);
		await sendChat("再来");
		expect(
			document.querySelectorAll("#read-ai-messages .tool-block").length,
		).toBe(2);
	});

	it("R11 409 与重复请求：不排队不重试；duplicate+active 走 waitRunEvents；非 active 直落完成文案（:379-401）", async () => {
		await mountAndLoad("B1", 101);
		streamResponder = () =>
			jsonRes(409, {
				error: { code: "CHAT_BUSY", message: "当前对话正在进行中" },
			});
		await sendChat("并发一问");
		expect(toasts).toContain("当前对话正在进行中");
		const posts = fetchCalls.filter(
			(c) => String(c.url).indexOf("/chat/stream") >= 0,
		);
		expect(posts.length).toBe(1); // 不重试

		// duplicate + active → 等待运行结果（polling /api/runs/:id/events）
		streamResponder = () =>
			jsonRes(202, {
				duplicate: true,
				status: "running",
				runId: 77,
				sessionKey: "s-1",
			});
		await sendChat("重复一问");
		const polls = fetchCalls.filter(
			(c) => String(c.url).indexOf("/api/runs/77/events") >= 0,
		);
		expect(polls.length).toBe(1);
		expect(polls[0].url).toContain("afterSeq=");
		const bubbles = Array.from(
			document.querySelectorAll("#read-ai-messages .msg-bubble"),
		).map((n) => n.textContent);
		expect(bubbles).toContain("（该请求已在另一窗口完成，结果见写作台会话）");

		// duplicate + 非 active → 不轮询，直接完成文案
		streamResponder = () =>
			jsonRes(200, {
				duplicate: true,
				status: "finished",
				runId: 78,
				sessionKey: "s-1",
			});
		const before = fetchCalls.filter(
			(c) => String(c.url).indexOf("/api/runs/") >= 0,
		).length;
		await sendChat("重复二问");
		expect(
			fetchCalls.filter((c) => String(c.url).indexOf("/api/runs/") >= 0).length,
		).toBe(before);
	});

	it("R12 选中段引用与替换：选区唤起、withSelectionPrompt 逐字、精确偏移/indexOf 回退/找不到、替换后 PUT（:479-631）", async () => {
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		const editor = document.getElementById("read-editor");
		const revise = document.getElementById("read-ai-revise");
		await act(async () => {
			editor.selectionStart = 0;
			editor.selectionEnd = 4;
			editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		expect(revise.className).not.toContain("hidden");
		expect(document.getElementById("read-ai-quote").className).not.toContain(
			"hidden",
		);
		expect(document.getElementById("read-ai-quote-text").textContent).toBe(
			"第一段落",
		);

		// withSelectionPrompt 文案逐字（三引号包裹＋尾注）
		streamResponder = () =>
			sseRes([
				{ type: "content", text: "改写后：\n改后的段落" },
				{ type: "done", content: "改写后：\n改后的段落" },
			]);
		await act(async () => {
			revise.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		const f = fetchCalls
			.filter((c) => String(c.url).indexOf("/chat/stream") >= 0)
			.pop();
		expect(f.body.content).toBe(
			'下面是我从正文中选中的段落（唯一处理对象）：\n"""\n第一段落\n"""\n\n我的要求：精修改写这一段：保持人称、剧情与设定不变；改写长度与原文相近（上下不超过三成），不要扩写、不要拆成多段、不要新增情节。\n\n若要求是改写/润色：只直接输出改后的段落正文，不要解释、不要加引号或标记；若要求是分析或讨论：正常回答。',
		);
		// 流结束：pendingSelection 未变 → 放行替换
		const apply = document.getElementById("read-apply-reply");
		expect(apply.className).not.toContain("hidden");
		await act(async () => {
			apply.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(editor.value).toBe("改后的段落。\n第二段落。\n");
		expect(
			apiCalls.filter(
				(c) => c.method === "PUT" && c.path === "/api/books/B1/chapters/101",
			).length,
		).toBe(1);
		expect(toasts).toContain("已替换选中段并保存");

		// 找不到原文 → toast 逐字（快照不吻合且 indexOf 失败）
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		const ed2 = document.getElementById("read-editor");
		await act(async () => {
			ed2.selectionStart = 0;
			ed2.selectionEnd = 4;
			ed2.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		streamResponder = () => sseRes([{ type: "done", content: "替换文本" }]);
		await act(async () => {
			document.getElementById("read-ai-revise").click();
			await new Promise((r) => setTimeout(r, 20));
		});
		// 正文被改动 → 精确偏移失效且 indexOf 找不到
		await act(async () => {
			setInputValue(ed2, "完全不同的正文");
		});
		await act(async () => {
			document.getElementById("read-apply-reply").click();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(toasts).toContain(
			"在当前章正文中找不到这段原文，无法替换（正文可能已被改动）",
		);

		// sanitizeReply 五组（:590-601）
		expect(sanitizeReply("```\n正文一\n```")).toBe("正文一");
		expect(sanitizeReply("改写后：\n正文二")).toBe("正文二");
		expect(sanitizeReply("「正文三」")).toBe("正文三");
		expect(sanitizeReply('"正文四』')).toBe('"正文四』'); // 跨族不剥（注释明示）
		expect(sanitizeReply("「他说：『走吧。』」")).toBe("他说：『走吧。』"); // 同族成对剥离一层
		// splitParas 偏移（:488-501 逐字）：start/end 指向 trim 后文本在原文的偏移
		const ps = splitParas("  甲段  \n\n乙段\n");
		expect(ps.map((p) => [p.text, p.start, p.end])).toEqual([
			["甲段", 2, 4],
			["乙段", 8, 10],
		]);
	});

	it("R13 StyleHealth 消费：选章守卫调用、按钮显隐与 title 逐字、挂载后重绑生效（:111）（P6-2：缺名臂不可达，已转写）", async () => {
		// 记参面由 beforeEach 的模块 mock 统一安装（真件＝StyleHealthPanel.jsx 导出，保留模块态）
		await mountAndLoad("B1", 101);
		expect(styleHealthCalls).toContainEqual(["B1", 101]);
		const btn = document.getElementById("read-health-btn");
		expect(btn.className).not.toContain("hidden");
		expect(btn.title).toBe("用朱雀检测本章 AI 味（结果只作参考，不设达标线）");
		// 无章：hidden 且 title 空（清进度键，避免回退到上一轮写入的章号）
		chaptersFixture = [];
		localStorage.removeItem("novel-read:progress:B1");
		await mountAndLoad("B1", null);
		expect(document.getElementById("read-health-btn").className).toContain(
			"hidden",
		);
		expect(document.getElementById("read-health-btn").title).toBe("");
		// P6-2 转写（§2.5-D5）：`renderStyleHealth` 经模块导出直取 ⇒ 旧「window.StyleHealth 缺失→
		// 不抛」臂不可达（模块面恒在）；等价见证＝选章流程照常走完（GET 102 命中）且零抛错
		chaptersFixture = freshChapters();
		await mountAndLoad("B1", 101);
		await act(async () => {
			document
				.getElementById("read-toc-list")
				.querySelector('.read-toc-item[data-id="102"]')
				.click();
		});
		await flush();
		expect(apiCalls.some((c) => c.path === "/api/books/B1/chapters/102")).toBe(
			true,
		);

		// 挂载后 mountStyleHealth() 重绑：点击两按钮触发既有流程（体检 POST／标本 GET）
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-health-btn").click();
		});
		await flush();
		const detect = apiCalls.find(
			(c) => c.method === "POST" && c.path === "/api/style-lab/detect-chapter",
		);
		expect(detect.body).toEqual({ book_id: "B1", chapter_id: 101 });
		await act(async () => {
			document.getElementById("read-samples-btn").click();
		});
		await flush();
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" && c.path.indexOf("/api/style-lab/samples?") === 0,
			),
		).toBe(true);
	});

	it("R14 命令式槽位与 lib 直连：window.ChatEventHub 全程未定义仍全绿、清空消息、两折叠按钮（:668-669/:687）", async () => {
		expect(window.ChatEventHub).toBeUndefined();
		streamResponder = () => sseRes([{ type: "done", content: "直连回答" }]);
		await mountAndLoad("B1", 101);
		await sendChat("直连一问");
		const bubbles = document.querySelectorAll("#read-ai-messages .msg-bubble");
		expect(bubbles.length).toBe(2);
		expect(bubbles[1].textContent).toBe("直连回答");

		await act(async () => {
			document.getElementById("read-ai-clear").click();
		});
		expect(document.getElementById("read-ai-messages").children.length).toBe(0);

		await act(async () => {
			document.getElementById("read-toggle-toc").click();
		});
		expect(document.getElementById("read-toc").className).toContain(
			"collapsed",
		);
		await act(async () => {
			document.getElementById("read-toggle-ai").click();
		});
		expect(document.getElementById("read-ai").className).toContain("collapsed");
	});

	it("R15 飞行中 revise 禁用与引用 title（S5-1-review-1 ISSUE-2/ISSUE-4）：disabled 起止对称、点击不新增流、#read-ai-quote-text 带 title", async () => {
		// ISSUE-2：等值 legacy book-read.js:364（起置 disabled=true）/ :473（复位 false）
		await mountAndLoad("B1", 101);
		await act(async () => {
			document.getElementById("read-mode-edit").click();
		});
		const editor = document.getElementById("read-editor");
		const revise = document.getElementById("read-ai-revise");
		await act(async () => {
			editor.selectionStart = 0;
			editor.selectionEnd = 4;
			editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		expect(revise.className).not.toContain("hidden");
		expect(revise.disabled).toBe(false); // 空闲态可点

		// 飞行中：disabled，且点击不产生第二条 /chat/stream（legacy 同观察点请求数恒 1）
		streamResponder = (opts) =>
			sseRes([{ type: "content", text: "半截回答" }], {
				hold: true,
				onStart: (c) => {
					opts?.signal?.addEventListener("abort", () => {
						try {
							c.error(new DOMException("Aborted", "AbortError"));
						} catch (_e) {
							/* ignore */
						}
					});
				},
			});
		await sendChat("飞行一问", { hold: true });
		expect(revise.disabled).toBe(true);
		const streamCalls = () =>
			fetchCalls.filter((c) => String(c.url).indexOf("/chat/stream") >= 0)
				.length;
		expect(streamCalls()).toBe(1);
		await act(async () => {
			revise.click();
		});
		await flush(20);
		expect(streamCalls()).toBe(1); // 点击无效，无第二条流

		// ISSUE-4：引用文本 title（legacy :556-558 `t.title = sel.text`；CSS 有 line-clamp 截断）
		const quoteText = document.getElementById("read-ai-quote-text");
		expect(quoteText.textContent).toBe("第一段落");
		expect(quoteText.getAttribute("title")).toBe("第一段落");

		// 收尾：停止 → 按钮 disabled 复位（legacy :473 对称复位）
		await act(async () => {
			document.getElementById("read-ai-stop").click();
		});
		await waitFor(
			() => document.getElementById("read-ai-revise").disabled === false,
		);
		expect(revise.disabled).toBe(false);
	});
});
