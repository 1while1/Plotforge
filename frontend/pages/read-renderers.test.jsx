// @vitest-environment jsdom
// T4（P6-2 Plan §4-T4）ReadPage 渲染器内部化：`delete window.BookPage` 后工具块/确认卡仍产出节点，
// 且流式回答的 `onTool/onAction` 把节点插到气泡之前（ReadPage.jsx:628-635 的 window 取用改直取）。
// 红态成因：今日 `window.BookPage?.renderToolEvent` 缺 ⇒ 早退（无节点）、`window.App` 之外三处
// 旧名（StyleHealth／ChapterConflict／BookPage）也无法在零窗口名环境成立。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatApi } from "../components/ChatWorkspace.jsx";
import { mount as mountReadPage } from "./ReadPage.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);
const STATIC_DOC = new JSDOM(INDEX_HTML).window.document;

const BOOK_ID = "B1";
const CHAPTER_ID = 101;

function buildShellHtml() {
	const read = STATIC_DOC.getElementById("page-read").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${read}${modal}${toast}`;
}

const volumes = [{ id: 10, title: "第一卷 试炼" }];
const chapters = [
	{
		id: CHAPTER_ID,
		title: "第一章 起点",
		volume_id: 10,
		revision: 3,
		content: "第一段落。\n第二段落。\n",
	},
];

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

function sseRes(events) {
	const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		start(c) {
			for (const line of text.split("\n\n"))
				if (line) c.enqueue(enc.encode(`${line}\n\n`));
			c.close();
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

async function flush(ms) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms == null ? 30 : ms));
	});
}

async function waitFor(cond, timeout = 1500) {
	const t0 = Date.now();
	for (;;) {
		let ok = false;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 5));
			ok = !!cond();
		});
		if (ok) return true;
		if (Date.now() - t0 > timeout) return false;
	}
}

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function installEnv() {
	document.body.innerHTML = buildShellHtml();
	window.App = {
		state: { currentBook: null, currentChapterId: null, currentVolumeId: null },
		async api(method, url) {
			const p = String(url);
			if (method === "GET" && p === `/api/books/${BOOK_ID}`)
				return { book: { id: BOOK_ID, title: "测试之书" } };
			if (method === "GET" && p === `/api/books/${BOOK_ID}/volumes`)
				return { volumes };
			if (method === "GET" && p === `/api/books/${BOOK_ID}/chapters`)
				return { chapters };
			if (method === "GET" && /\/chapters\/\d+$/.test(p))
				return { chapter: { ...chapters[0] } };
			if (method === "GET" && p.startsWith("/api/style-lab/"))
				return { samples: [], total: 0, overall: { conf: 0.2 }, segments: [] };
			return {};
		},
		toast() {},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
	// 零窗口名环境：BookPage 自始不存在（T4 的判据环境）
	delete window.BookPage;
	globalThis.fetch = async (url) => {
		if (String(url).indexOf("/api/runs/") === 0)
			return jsonRes(200, { events: [], status: "finished", nextAfterSeq: 1 });
		return sseRes([
			{
				type: "tool",
				name: "read_chapter",
				args: { chapterId: CHAPTER_ID },
				result: { ok: true },
			},
			{
				type: "action",
				id: 5,
				name: "append_chapter",
				args: { chapterId: CHAPTER_ID },
			},
			{ type: "content", text: "已处理" },
			{ type: "done", content: "已处理" },
		]);
	};
}

function cleanup() {
	document.body.innerHTML = "";
	delete window.App;
	delete window.BookPage;
	delete window.MozhenReadPage;
	delete window.StyleHealth;
	delete window.ChapterConflict;
	delete window.ChatEventHub;
	delete globalThis.fetch;
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	cleanup();
	installEnv();
});

afterEach(cleanup);

describe("T4 ReadPage 渲染器内部化（零 window.BookPage）", () => {
	it("T4-1 未挂载面：chatApi().renderToolEvent / renderActionCard 仍产出真实节点（无窗口名）", () => {
		expect(window.BookPage).toBe(undefined);
		let block = null;
		let card = null;
		act(() => {
			block = chatApi().renderToolEvent({
				name: "read_chapter",
				result: "ok",
			});
			card = chatApi().renderActionCard(
				{
					id: "a-1",
					name: "append_chapter",
					args: { chapterId: CHAPTER_ID },
					status: "pending",
				},
				{ bookId: BOOK_ID, onSettled() {}, resume() {} },
			);
		});
		expect(block).toBeTruthy();
		expect(block.className).toContain("tool-call");
		expect(block.textContent).toContain("阅读章节");
		expect(card).toBeTruthy();
		expect(card.className).toContain("msg-action");
		expect(card.textContent).toContain("追加章节正文");
	});

	it("T4-2 流式回答：工具块与确认卡插到气泡之前（真实节点，非 mock 记录）", async () => {
		expect(window.BookPage).toBe(undefined);
		act(() => {
			mountReadPage(BOOK_ID, CHAPTER_ID);
		});
		await flush();
		await waitFor(
			() =>
				document.getElementById("read-book-title").textContent === "测试之书",
		);
		await flush();
		const input = document.getElementById("read-ai-text");
		act(() => {
			setInputValue(input, "写一章");
		});
		act(() => {
			document
				.getElementById("read-ai-form")
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		await flush(20);
		await waitFor(
			() =>
				document.querySelectorAll("#read-ai-messages .msg-bubble").length > 0,
		);
		await flush(20);
		const wrap = document.getElementById("read-ai-messages");
		expect(wrap.querySelectorAll(".tool-call").length).toBe(1);
		expect(wrap.querySelectorAll(".msg-action").length).toBe(1);
		// 节点插在气泡之前（等值 ReadPage.jsx:628-635 的 insertBefore(bubble)）
		const assistant = wrap.querySelector(".msg.assistant");
		const inner = Array.from(assistant.children).map((n) => n.className);
		const bubbleIdx = inner.findIndex((c) => c.includes("msg-bubble"));
		expect(bubbleIdx).toBeGreaterThan(-1);
		expect(inner.slice(0, bubbleIdx).join("|")).toContain("tool-call");
		expect(inner.slice(0, bubbleIdx).join("|")).toContain("msg-action");
	});

	it("T4-3 源码见证：ReadPage.jsx 经 chatApi() 直取渲染器，生产行零 window.BookPage（含 StyleHealth/ChapterConflict 同规）", () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, "frontend", "pages", "ReadPage.jsx"),
			"utf8",
		);
		expect(src).toMatch(
			/import\s*\{[^}]*chatApi[^}]*\}\s*from\s*"\.\.\/components\/ChatWorkspace\.jsx"/,
		);
		// 注释行/块注释粗筛后不得再有活引用（精确口径由 T1 静态见证承担）
		const lines = src.split("\n");
		let live = 0;
		let inBlock = false;
		for (const raw of lines) {
			let ln = raw;
			if (inBlock) {
				if (ln.includes("*/")) {
					ln = ln.slice(ln.indexOf("*/") + 2);
					inBlock = false;
				} else continue;
			}
			const bi = ln.indexOf("/*");
			if (bi >= 0 && !ln.includes("*/", bi)) {
				ln = ln.slice(0, bi);
				inBlock = true;
			}
			ln = ln.replace(/\/\/.*$/, "");
			if (/window\.(BookPage|StyleHealth|ChapterConflict)\b/.test(ln))
				live += 1;
		}
		expect(live, `ReadPage.jsx 仍有活 window.* 引用 ${live} 处`).toBe(0);
	});
});
