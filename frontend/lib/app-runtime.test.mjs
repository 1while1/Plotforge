// @vitest-environment jsdom
// S5-3 红测 R4（Plan §4）：App 运行时五方法等值——public/legacy/app.js:13-116 逐字。
// 断言锚点：:13-49 api（错误信封/status/body 序列化条件）、:52-60 toast（2500ms 单例 timer）、
// :63-74 escapeHtml（五字符映射与 null 边界）、:77-116 openModal（默认 okText/danger/
// onOk 非函数/返回 false/thenable resolve-reject/取消/mask 自点）。
// harness 照 ChapterEditorPanel.test.jsx：jsdom ＋ 裸 DOM 断言；弹窗五件套/toast 从
// frontend/index.html 真实文本提取（单一事实源；P6-3 源迁入）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRuntime } from "./app-runtime.js";

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

function modalShellHtml() {
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${modal}${toast}`;
}

let fetchCalls;
let fetchResponder;

function jsonRes(status, data) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
	};
}

function installFetch() {
	fetchCalls = [];
	fetchResponder = () => jsonRes(200, {});
	globalThis.fetch = async (url, opts) => {
		fetchCalls.push({ url, opts });
		return fetchResponder(url, opts);
	};
}

const byId = (id) => document.getElementById(id);

beforeEach(() => {
	document.body.innerHTML = modalShellHtml();
	installFetch();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("app-runtime（legacy app.js:13-116 等值）", () => {
	it("R4-1 api 成功：GET/POST 透传、headers 恒 Content-Type、body 仅 !==undefined 时序列化（:13-19/:48）", async () => {
		const rt = createAppRuntime();
		fetchResponder = () => jsonRes(200, { ok: true });
		const data = await rt.api("GET", "/api/x");
		expect(data).toEqual({ ok: true });
		expect(fetchCalls[0].opts.method).toBe("GET");
		expect(fetchCalls[0].opts.headers).toEqual({
			"Content-Type": "application/json",
		});
		expect("body" in fetchCalls[0].opts).toBe(false);

		await rt.api("POST", "/api/x", { a: 1 });
		expect(fetchCalls[1].opts.body).toBe('{"a":1}');
		await rt.api("PUT", "/api/x", null);
		expect(fetchCalls[2].opts.body).toBe("null");
	});

	it("R4-2 api 字符串 error → Error(message=data.error)＋status 保留（:20-46）", async () => {
		const rt = createAppRuntime();
		fetchResponder = () => jsonRes(400, { error: "坏请求" });
		await expect(rt.api("GET", "/api/x")).rejects.toMatchObject({
			message: "坏请求",
			status: 400,
		});
	});

	it("R4-3 api 结构化 error{code,message,details} → 三件保留（:30-34/:43-45）", async () => {
		const rt = createAppRuntime();
		fetchResponder = () =>
			jsonRes(409, {
				error: { code: "CHAT_BUSY", message: "正在生成", details: { run: 1 } },
			});
		try {
			await rt.api("POST", "/api/x", {});
			throw new Error("应当抛错");
		} catch (e) {
			expect(e.message).toBe("正在生成");
			expect(e.code).toBe("CHAT_BUSY");
			expect(e.details).toEqual({ run: 1 });
			expect(e.status).toBe(409);
		}
	});

	it("R4-4 api 非 JSON 响应体 → 吞解析错误、msg 恒 '请求失败'（:20-41）", async () => {
		const rt = createAppRuntime();
		fetchResponder = () => ({
			ok: false,
			status: 500,
			json: async () => {
				throw new Error("not json");
			},
		});
		await expect(rt.api("GET", "/api/x")).rejects.toMatchObject({
			message: "请求失败",
			status: 500,
		});
	});

	it("R4-5 api error 为对象但非结构化文案时 JSON.stringify 兜底（:36-38）", async () => {
		const rt = createAppRuntime();
		fetchResponder = () => jsonRes(500, { error: { foo: 1 } });
		await expect(rt.api("GET", "/api/x")).rejects.toMatchObject({
			message: '{"foo":1}',
			status: 500,
		});
	});

	it("R4-6 escapeHtml：null/undefined→''；五字符映射；数字 String 化（:63-74）", () => {
		const rt = createAppRuntime();
		expect(rt.escapeHtml(null)).toBe("");
		expect(rt.escapeHtml(undefined)).toBe("");
		expect(rt.escapeHtml(0)).toBe("0");
		expect(rt.escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
		expect(rt.escapeHtml("a<b>c")).toBe("a&lt;b&gt;c");
	});

	it("R4-7 toast：文案＋去 hidden；2500ms 后加回 hidden（单例 timer）（:52-60）", () => {
		vi.useFakeTimers();
		const rt = createAppRuntime();
		const el = byId("toast");
		expect(el.classList.contains("hidden")).toBe(true);
		rt.toast("你好");
		expect(el.textContent).toBe("你好");
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(2499);
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(1);
		expect(el.classList.contains("hidden")).toBe(true);
		// 单例 timer：第二次 toast 清掉第一次的定时器
		rt.toast("一");
		vi.advanceTimersByTime(2000);
		rt.toast("二");
		vi.advanceTimersByTime(2000);
		expect(el.classList.contains("hidden")).toBe(false);
		vi.advanceTimersByTime(500);
		expect(el.classList.contains("hidden")).toBe(true);
	});

	it("R4-8 openModal：title/bodyHTML/默认 okText「确定」/mask 显隐；纯展示点确定即关（:77-110）", () => {
		const rt = createAppRuntime();
		rt.openModal({ title: "标题", bodyHTML: "<p>正文</p>" });
		expect(byId("modal-mask").classList.contains("hidden")).toBe(false);
		expect(byId("modal-title").textContent).toBe("标题");
		expect(byId("modal-body").innerHTML).toBe("<p>正文</p>");
		expect(byId("modal-ok").textContent).toBe("确定");
		byId("modal-ok").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("R4-9 openModal danger：加 btn-danger；下一次普通弹窗重置回退（:88-92）", () => {
		const rt = createAppRuntime();
		rt.openModal({ title: "危险", bodyHTML: "", danger: true });
		expect(byId("modal-ok").classList.contains("btn-danger")).toBe(true);
		rt.openModal({ title: "普通", bodyHTML: "" });
		expect(byId("modal-ok").classList.contains("btn-danger")).toBe(false);
	});

	it("R4-10 openModal onOk 返回 false 不关；返回真值关（:94-104）", () => {
		const rt = createAppRuntime();
		rt.openModal({
			title: "t",
			bodyHTML: "",
			onOk: () => false,
		});
		byId("modal-ok").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(false);
		rt.openModal({ title: "t2", bodyHTML: "", onOk: () => true });
		byId("modal-ok").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("R4-11 openModal thenable：resolve(非 false) 关、resolve(false) 不关、reject 静默不关（:98-101）", async () => {
		const rt = createAppRuntime();
		rt.openModal({
			title: "t",
			bodyHTML: "",
			onOk: () => Promise.resolve(true),
		});
		byId("modal-ok").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);

		rt.openModal({
			title: "t",
			bodyHTML: "",
			onOk: () => Promise.resolve(false),
		});
		byId("modal-ok").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(byId("modal-mask").classList.contains("hidden")).toBe(false);

		rt.openModal({
			title: "t",
			bodyHTML: "",
			onOk: () => Promise.reject(new Error("x")),
		});
		byId("modal-ok").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(byId("modal-mask").classList.contains("hidden")).toBe(false);
	});

	it("R4-12 openModal 取消/mask 自点关闭；mask 内部点击不关（:106-109）", () => {
		const rt = createAppRuntime();
		rt.openModal({ title: "t", bodyHTML: "<p>x</p>" });
		byId("modal-cancel").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);

		rt.openModal({ title: "t", bodyHTML: "" });
		byId("modal-body").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(false);
		byId("modal-mask").click();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);
	});

	it("R4-13 closeModal 单件（:113-115）与 state 引用复用（禁重建对象）", () => {
		const state = {
			currentBook: null,
			currentChapterId: 1,
			currentVolumeId: 2,
		};
		const rt = createAppRuntime({ state });
		expect(rt.state).toBe(state);
		rt.openModal({ title: "t", bodyHTML: "" });
		rt.closeModal();
		expect(byId("modal-mask").classList.contains("hidden")).toBe(true);
	});
});
