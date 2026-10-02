// @vitest-environment jsdom
// S5-3 红测 R6（Plan §4）：ShelfPage 书架页整页等值——
// 锚点 public/legacy/app.js:226-280 renderShelf（book-card 结构/escapeHtml/空态/点卡进书/
// 删除预览 confirm 文案/DELETE/重拉）＋ :397-505 init 的回收站弹窗与恢复预览全流程。
// harness：jsdom ＋ React 19 act ＋ 裸 DOM；#page-shelf 静态壳从 frontend/index.html 真实文本提取；
// window.App 五方法按 legacy 契约 mock（api/toast/openModal/closeModal/escapeHtml）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountShelf } from "./ShelfPage.jsx";

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

function buildShellHtml() {
	const shelf = STATIC_DOC.getElementById("page-shelf").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${shelf}${modal}${toast}`;
}

const byId = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeout = 2000) => {
	const t0 = Date.now();
	for (;;) {
		if (cond()) return true;
		if (Date.now() - t0 > timeout) return false;
		await act(async () => {
			await sleep(10);
		});
	}
};

let apiCalls;
let respond;
let toasts;
let modalCalls;
let lastModal;
let closeModalCalls;
let confirmCalls;
let confirmValue;

function escapeHtml(s) {
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
}

async function mockApi(method, url, body) {
	apiCalls.push({ method, path: url, body });
	return respond(method, url, body);
}

function installApp() {
	apiCalls = [];
	toasts = [];
	modalCalls = [];
	lastModal = null;
	closeModalCalls = 0;
	confirmCalls = [];
	window.App = {
		state: { currentBook: null, currentChapterId: null, currentVolumeId: null },
		api: mockApi,
		escapeHtml,
		toast(msg) {
			toasts.push(String(msg));
		},
		openModal(opts) {
			modalCalls.push(opts);
			lastModal = opts;
			byId("modal-body").innerHTML = opts.bodyHTML || "";
			byId("modal-mask").classList.remove("hidden");
		},
		closeModal() {
			closeModalCalls += 1;
			byId("modal-mask").classList.add("hidden");
		},
	};
	window.confirm = (msg) => {
		confirmCalls.push(String(msg));
		return confirmValue;
	};
}

function booksPayload() {
	return {
		books: [
			{
				id: 7,
				title: "测试<b>书",
				intro: null,
				chapter_count: 0,
				updated_at: "2026-09-01T12:00:00",
			},
			{
				id: 8,
				title: "第二本",
				intro: "简介 & 更多",
				chapter_count: 3,
				updated_at: "2026-08-20T08:00:00",
			},
		],
	};
}

function defaultRespond(method, url) {
	if (method === "GET" && url === "/api/books") return booksPayload();
	return {};
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = buildShellHtml();
	window.location.hash = "#/";
	respond = defaultRespond;
	confirmValue = true;
	installApp();
});

async function mountPage() {
	await act(async () => {
		mountShelf();
	});
	await waitFor(() => apiCalls.length > 0);
	await act(async () => {
		await sleep(20);
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
});

const cards = () =>
	Array.from(document.querySelectorAll("#book-grid .book-card"));

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("ShelfPage（legacy app.js:226-280 ＋ :397-505）", () => {
	it("R6-1 空态：books=[] → #book-grid 空、#shelf-empty 去 hidden", async () => {
		respond = (m, u) =>
			m === "GET" && u === "/api/books" ? { books: [] } : {};
		await mountPage();
		expect(byId("book-grid").children.length).toBe(0);
		expect(byId("shelf-empty").classList.contains("hidden")).toBe(false);
	});

	it("R6-2 非空态结构：book-card 逐字段（data-id/escapeHtml h3/简介兜底/meta/删除按钮）", async () => {
		await mountPage();
		expect(byId("shelf-empty").classList.contains("hidden")).toBe(true);
		const list = cards();
		expect(list.length).toBe(2);
		const c7 = document.querySelector('.book-card[data-id="7"]');
		expect(c7.querySelector("h3").textContent).toBe("测试<b>书");
		expect(c7.querySelector("h3").innerHTML).toContain("&lt;b&gt;");
		expect(c7.querySelector(".book-intro").textContent).toBe("暂无简介");
		expect(c7.querySelector(".book-meta span").textContent).toBe(
			"0 章 · 09-01",
		);
		expect(c7.querySelector("button.icon-btn.book-del").textContent).toBe("×");
		const c8 = document.querySelector('.book-card[data-id="8"]');
		expect(c8.querySelector("h3").textContent).toBe("第二本");
		expect(c8.querySelector(".book-intro").textContent).toBe("简介 & 更多");
		expect(c8.querySelector(".book-meta span").textContent).toBe(
			"3 章 · 08-20",
		);
	});

	it("R6-3 点击卡进书：location.hash='#/book/7'（:274）", async () => {
		await mountPage();
		await act(async () => {
			document.querySelector('.book-card[data-id="7"]').click();
			await sleep(5);
		});
		expect(window.location.hash).toBe("#/book/7");
	});

	it("R6-4 删除预览：请求序列＋confirm 文案逐字＋DELETE＋toast＋重拉；点删除不跳书（:258-269）", async () => {
		respond = (m, u) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "GET" && u === "/api/books/7/delete-preview")
				return {
					chapters: 3,
					words: 1200,
					characters: 5,
					events: 8,
					versions: 4,
					messages: 20,
				};
			if (m === "DELETE" && u === "/api/books/7") return {};
			return {};
		};
		await mountPage();
		const before = window.location.hash;
		await act(async () => {
			document.querySelector('.book-card[data-id="7"] .book-del').click();
			await sleep(30);
		});
		expect(apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /api/books",
			"GET /api/books/7/delete-preview",
			"DELETE /api/books/7",
			"GET /api/books",
		]);
		expect(confirmCalls[0]).toBe(
			"确定删除《测试<b>书》？\n\n将失去：3 章 · 约 1200 字 · 5 个人物 · 8 条事实事件 · 4 份版本快照 · 20 条对话\n\n删除前会自动导出整册备份进回收站（保留 30 天，可在书架右上角「回收站」恢复）。",
		);
		expect(toasts).toContain("已删除，备份已入回收站");
		expect(window.location.hash).toBe(before);
	});

	it("R6-5 取消删除：confirm 返回 false → 无 DELETE、无 toast（:265-266）", async () => {
		confirmValue = false;
		await mountPage();
		await act(async () => {
			document.querySelector('.book-card[data-id="7"] .book-del').click();
			await sleep(30);
		});
		expect(apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /api/books",
			"GET /api/books/7/delete-preview",
		]);
		expect(toasts.length).toBe(0);
	});

	it("R6-6 新建作品：空名 toast 返回 false；成功 POST 后跳 #/book/9（:399-421）", async () => {
		await mountPage();
		await act(async () => {
			byId("btn-new-book").click();
			await sleep(5);
		});
		expect(modalCalls.length).toBe(1);
		expect(lastModal.title).toBe("新建作品");
		// 空名
		let ret = await lastModal.onOk(byId("modal-body"));
		expect(ret).toBe(false);
		expect(toasts).toContain("请填写作品名称");
		// 成功
		respond = (m, u, b) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "POST" && u === "/api/books")
				return { book: { id: 9, title: b.title } };
			return {};
		};
		const titleEl = byId("nb-title");
		const introEl = byId("nb-intro");
		titleEl.value = "新书";
		introEl.value = "简介";
		await act(async () => {
			ret = await lastModal.onOk(byId("modal-body"));
			await sleep(5);
		});
		expect(ret).toBe(undefined);
		expect(apiCalls.at(-1)).toEqual({
			method: "POST",
			path: "/api/books",
			body: { title: "新书", intro: "简介" },
		});
		expect(window.location.hash).toBe("#/book/9");
	});

	it("R6-7 回收站列表：标题含 retention、条目结构与两按钮；空态文案（:469-487）", async () => {
		respond = (m, u) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "GET" && u === "/api/books/recycle-bin")
				return {
					backups: [
						{
							file: "a.zip",
							title: "旧书",
							created_at: "2026-09-01T00:00:00",
							size: 2048,
						},
					],
					retention_days: 30,
				};
			return {};
		};
		await mountPage();
		await act(async () => {
			byId("btn-recycle-bin").click();
			await sleep(30);
		});
		expect(lastModal.title).toBe("回收站（保留 30 天）");
		const item = byId("modal-body").querySelector(".recycle-item");
		expect(item.dataset.file).toBe("a.zip");
		expect(item.querySelector("strong").textContent).toBe("《旧书》");
		expect(item.querySelector("small").textContent).toContain("2 KB");
		expect(item.querySelector("[data-restore]").dataset.restore).toBe("a.zip");
		expect(item.querySelector("[data-purge]").dataset.purge).toBe("a.zip");
		// 空态
		respond = (m, u) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "GET" && u === "/api/books/recycle-bin")
				return { backups: [], retention_days: 30 };
			return {};
		};
		await act(async () => {
			byId("btn-recycle-bin").click();
			await sleep(30);
		});
		expect(byId("modal-body").textContent).toContain(
			"回收站是空的。删除书籍时会自动在这里生成整册备份。",
		);
	});

	it("R6-8 恢复预览：legacy 三态行文案＋okText＋allow_partial_style 传参＋三态 toast（:428-466）", async () => {
		let previewPayload;
		respond = (m, u) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "GET" && u === "/api/books/recycle-bin")
				return {
					backups: [
						{
							file: "a.zip",
							title: "旧书",
							created_at: "2026-09-01T00:00:00",
							size: 2048,
						},
					],
					retention_days: 30,
				};
			if (m === "POST" && u === "/api/books/recycle-bin/preview")
				return previewPayload;
			if (m === "POST" && u === "/api/books/recycle-bin/restore")
				return { style: { missing: ["卡B"], restored_bindings: 0 } };
			return {};
		};
		await mountPage();
		await act(async () => {
			byId("btn-recycle-bin").click();
			await sleep(30);
		});
		previewPayload = {
			book: { title: "旧书" },
			exported_at: new Date("2026-09-01T00:00:00").toISOString(),
			counts: { chapters: 3, chapter_versions: 2, messages: 10 },
			style: {
				legacy: false,
				bindings: [
					{ role: "main", pack_name: "卡A", exists: true },
					{ role: "aux", pack_name: "卡B", exists: false },
				],
				missing: ["卡B"],
			},
		};
		await act(async () => {
			byId("modal-body").querySelector("[data-restore]").click();
			await sleep(40);
		});
		const pvModal = modalCalls.at(-1);
		expect(pvModal.title).toBe("恢复预览");
		expect(pvModal.okText).toBe("仍要恢复（缺失绑定留空）");
		const bodyText = byId("modal-body").textContent;
		expect(bodyText).toContain("《旧书》· 备份于");
		expect(bodyText).toContain(
			"将恢复：3 章 · 2 个历史版本 · 10 条对话。向量索引在后台自动补建。",
		);
		expect(bodyText).toContain("· 主卡《卡A》 —— 已就绪");
		expect(bodyText).toContain(
			"· 辅卡《卡B》 —— 卡已删除，恢复后该绑定留空，可新建卡后重绑",
		);
		await act(async () => {
			await pvModal.onOk();
			await sleep(30);
		});
		const restoreCall = apiCalls.find(
			(c) => c.path === "/api/books/recycle-bin/restore",
		);
		expect(restoreCall.body).toEqual({
			file: "a.zip",
			allow_partial_style: true,
		});
		expect(toasts.at(-1)).toContain("（绑定缺 1 项，待新建卡重绑）");
	});

	it("R6-9 永久删除：confirm 文案＋DELETE（encode）＋toast＋关窗＋重开列表（:496-502）", async () => {
		let binHits = 0;
		respond = (m, u) => {
			if (m === "GET" && u === "/api/books") return booksPayload();
			if (m === "GET" && u === "/api/books/recycle-bin") {
				binHits += 1;
				return {
					backups: [
						{
							file: "a b.zip",
							title: "旧书",
							created_at: "2026-09-01T00:00:00",
							size: 2048,
						},
					],
					retention_days: 30,
				};
			}
			if (m === "DELETE" && u === "/api/books/recycle-bin/a%20b.zip") return {};
			return {};
		};
		await mountPage();
		await act(async () => {
			byId("btn-recycle-bin").click();
			await sleep(30);
		});
		await act(async () => {
			byId("modal-body").querySelector("[data-purge]").click();
			await sleep(40);
		});
		expect(confirmCalls.at(-1)).toBe("永久删除这份备份？删除后无法找回。");
		expect(
			apiCalls.some(
				(c) =>
					c.method === "DELETE" &&
					c.path === "/api/books/recycle-bin/a%20b.zip",
			),
		).toBe(true);
		expect(toasts).toContain("备份已永久删除");
		expect(closeModalCalls).toBeGreaterThanOrEqual(1);
		// 永久删除后重新打开列表（binBtn.click() → 第二次 GET recycle-bin）
		expect(binHits).toBe(2);
	});

	it("R6-10 模块挂载件（P6-2 ⑨ 转写：模块直取）：mountShelf 为模块导出、调用即整页挂载（等值 app.js:222 renderShelf 入口）；window.MozhenShelf 零命中", async () => {
		expect(typeof mountShelf).toBe("function");
		expect(window.MozhenShelf).toBeUndefined(); // 反向见证：旧名桥退役后零命中
		await act(async () => {
			mountShelf();
			await sleep(20);
		});
		await waitFor(() => cards().length === 2);
		expect(cards().length).toBe(2);
		expect(byId("btn-recycle-bin")).toBeTruthy();
	});
});
