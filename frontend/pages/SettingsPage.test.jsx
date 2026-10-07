// @vitest-environment jsdom
// S5-3 红测 R7（Plan §4）：SettingsPage 设置页整页等值——
// 锚点 public/legacy/app.js:286-671（setCtxHint 四分支/renderSettings 回填顺序与掩码 placeholder/
// renderStyleLab 旁路/refreshCtxWindowField/保存设置三字段/六组保存按钮/三测试按钮/
// btn-refresh-models/系统提示词 isDefault 语义）。
// BYOK 改造（服务商面板）：渠道切换（legacy :529-541）、keyStash/stashKey 与 set-channel/set-base-url/
// set-api-key/set-model 四件套已移出本页（改由 components/ModelProfilesPanel.jsx 承接，独立测试）；
// 本文件的 R7-5（渠道切换）整例删除，R7-2/R7-6/R7-10/R7-11 去掉对应字段断言。
// harness：jsdom ＋ React 19 act ＋ 裸 DOM；#page-settings 静态壳从 frontend/index.html 真实文本提取。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import { mount as mountSettings } from "./SettingsPage.jsx";

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
	const settings = STATIC_DOC.getElementById("page-settings").outerHTML;
	const modal = STATIC_DOC.getElementById("modal-mask").outerHTML;
	const toast = STATIC_DOC.getElementById("toast").outerHTML;
	return `${settings}${modal}${toast}`;
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

function settingsPayload() {
	return {
		settings: {
			base_url: "https://opencode.ai/zen/go/v1",
			api_key_set: true,
			api_key_masked: "as_sk_e3b3…23d2",
			model: "deepseek-v4-flash",
			anysearch_api_key_set: false,
			anysearch_api_key_masked: "",
			search_enabled: true,
			anysearch_endpoint_effective: "https://api.anysearch.example/v1",
			search_max_results: 5,
			search_freshness: "week",
			search_zone: "cn",
			context_window: "",
			context_window_resolved: 128000,
			context_window_auto: true,
			compression_ratio: "0.8",
			disable_thinking_models: "deepseek-v4-flash",
			system_prompt: "自定义提示词",
			default_system_prompt: "默认提示词",
		},
	};
}

function styleLabPayload() {
	return {
		config: {
			api_key_set: false,
			api_key_masked: "",
			detector_endpoint: "https://zhuque.example/api",
			healthcheck_mode: "manual",
			style_layer_enabled: true,
		},
	};
}

function modelProfilesPayload() {
	return {
		profiles: [
			{
				id: "paid",
				name: "付费渠道（zen/go）",
				builtin: true,
				key_optional: false,
				base_url: "https://opencode.ai/zen/go/v1",
				api_key_set: true,
				api_key_masked: "**********…23d2",
				models: ["deepseek-v4-flash"],
				context_window: "",
			},
			{
				id: "free",
				name: "免费渠道（zen）",
				builtin: true,
				key_optional: true,
				base_url: "https://opencode.ai/zen/v1",
				api_key_set: false,
				api_key_masked: "",
				models: ["deepseek-v4-flash-free"],
				context_window: "",
			},
		],
		active_profile_id: "paid",
		active_model: "deepseek-v4-flash",
	};
}

function defaultRespond(method, url) {
	if (method === "GET" && url === "/api/settings/model-profiles")
		return modelProfilesPayload();
	if (method === "GET" && url.startsWith("/api/settings"))
		return settingsPayload();
	if (method === "GET" && url === "/api/style-lab/config")
		return styleLabPayload();
	return {};
}

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	document.body.innerHTML = buildShellHtml();
	apiCalls = [];
	toasts = [];
	respond = defaultRespond;
	localStorage.clear();
	window.App = {
		state: { currentBook: null, currentChapterId: null, currentVolumeId: null },
		api: async (method, url, body) => {
			apiCalls.push({ method, path: url, body });
			return respond(method, url, body);
		},
		toast(msg) {
			toasts.push(String(msg));
		},
		escapeHtml: (s) => String(s ?? ""),
		openModal() {},
		closeModal() {},
	};
});

async function mountPage() {
	await act(async () => {
		mountSettings();
		await sleep(20);
	});
	await waitFor(() => apiCalls.length > 0);
	await act(async () => {
		await sleep(20);
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

const settingsIds = () =>
	Array.from(STATIC_DOC.querySelectorAll("#page-settings [id]")).map(
		(n) => n.id,
	);

// P6-2 转写（Plan §2.4 T-F）：单例注入缝
// 生产侧 App/WorkspaceState 取用已改 lib 单例直取，harness 桩经注入缝装进单例。
beforeEach(() => {
	setAppForTests(window.App);
});

afterEach(() => {
	setAppForTests(null);
});

describe("SettingsPage（legacy app.js:286-671）", () => {
	it("R7-1 挂载后 29 个 id 齐备（与 index.html 静态壳逐 id 对位；BYOK 改造后渠道四件套退出、本页新增 #model-profiles 挂点）", async () => {
		const expected = settingsIds();
		// 实核（BYOK 改造 Worker）：#page-settings 内 [id] 共 29 个——相较改造前 34 个，
		// 删 set-channel/set-base-url/api-key-hint/set-api-key/set-model/model-options 六个，
		// 新增静态挂点 #model-profiles（React 侧按同名 id 渲染）
		expect(expected.length).toBe(29);
		await mountPage();
		const live = new Set(
			Array.from(byId("page-settings").querySelectorAll("[id]")).map(
				(n) => n.id,
			),
		);
		for (const id of expected) {
			expect(live.has(id), `缺 id ${id}`).toBe(true);
		}
	});

	it("R7-2 回填：字段/掩码 placeholder/isDefault/数值（:331-372；渠道/Key/模型三字段已移出本页）", async () => {
		await mountPage();
		expect(byId("set-anysearch-key").value).toBe("");
		expect(byId("set-anysearch-key").placeholder).toBe(
			"未配置（可选，联网搜索用）",
		);
		expect(byId("set-search-enabled").checked).toBe(true);
		expect(byId("set-search-endpoint").value).toBe(
			"https://api.anysearch.example/v1",
		);
		expect(byId("set-search-max-results").value).toBe("5");
		expect(byId("set-search-freshness").value).toBe("week");
		expect(byId("set-search-zone").value).toBe("cn");
		expect(byId("set-context-window").value).toBe("");
		expect(byId("set-context-window").placeholder).toBe("128000");
		expect(byId("set-compress-ratio").value).toBe("0.8");
		expect(byId("set-disable-thinking").value).toBe("deepseek-v4-flash");
		expect(byId("set-system-prompt").value).toBe("自定义提示词");
		expect(byId("set-system-prompt").dataset.isDefault).toBe(undefined);
		// 作家仓库旁路回填
		expect(byId("set-zhuque-key").value).toBe("");
		expect(byId("set-zhuque-key").placeholder).toBe("未配置（可选，体检用）");
		expect(byId("set-zhuque-endpoint").value).toBe(
			"https://zhuque.example/api",
		);
		expect(byId("set-healthcheck-mode").value).toBe("manual");
		expect(byId("set-style-layer-enabled").checked).toBe(true);
	});

	it("R7-3 无 system_prompt 时用 default_system_prompt 并置 isDefault=1（:360-367）", async () => {
		respond = (m, u) => {
			if (m === "GET" && u.startsWith("/api/settings")) {
				const p = settingsPayload();
				p.settings.system_prompt = "";
				return p;
			}
			if (m === "GET" && u === "/api/style-lab/config")
				return styleLabPayload();
			return {};
		};
		await mountPage();
		expect(byId("set-system-prompt").value).toBe("默认提示词");
		expect(byId("set-system-prompt").dataset.isDefault).toBe("1");
	});

	it("R7-4 setCtxHint 四分支文案逐字与 title（:313-329）", async () => {
		const cases = [
			[
				{
					context_window_clamped: true,
					context_window: 2000000,
					context_window_official: 1000000,
					context_window_resolved: 1000000,
					context_window_note: "官方上限",
				},
				"被钳制：设 2000000 超渠道官方 1000000，生效 1000000",
				"官方上限",
			],
			[
				{
					context_window_official_source: "channel_reported",
					context_window_auto: true,
					context_window_resolved: 1000000,
					context_window_official: 1000000,
					context_window_official_fetched_at: "2026-09-01 10:00",
				},
				"自动 · 官方 1000000（渠道 /models 报告）",
				"拉取于 2026-09-01 10:00",
			],
			[
				{
					context_window_official_source: "channel_not_reported",
					context_window_auto: false,
					context_window_resolved: 64000,
					context_window_note: "未报告",
				},
				"按你设置生效 64000 · 渠道未报官方，不猜测",
				"未报告",
			],
			[
				{
					context_window_auto: true,
					context_window_resolved: 128000,
				},
				"自动（系统默认 128000） · 官方源尚未拉取",
				"",
			],
		];
		for (const [patch, text, title] of cases) {
			respond = (m, u) => {
				if (m === "GET" && u.startsWith("/api/settings")) {
					const p = settingsPayload();
					Object.assign(p.settings, patch);
					return p;
				}
				if (m === "GET" && u === "/api/style-lab/config")
					return styleLabPayload();
				return {};
			};
			await act(async () => {
				mountSettings();
				await sleep(25);
			});
			const hint = byId("ctx-window-hint");
			expect(hint.textContent, JSON.stringify(patch)).toBe(text);
			expect(hint.title, JSON.stringify(patch)).toBe(title);
		}
	});

	it("R7-6 保存设置：payload 三字段＋toast＋refreshCtxWindowField＋重拉（:551-576；渠道/密钥字段已移出本页）", async () => {
		await mountPage();
		await act(async () => {
			byId("btn-save-settings").click();
			await sleep(30);
		});
		const put1 = apiCalls.find((c) => c.method === "PUT");
		expect(put1.path).toBe("/api/settings");
		expect(put1.body).toEqual({
			context_window: "",
			compression_ratio: "0.8",
			disable_thinking_models: "deepseek-v4-flash",
		});
		expect(toasts).toContain("已保存");
		// refreshCtxWindowField：BYOK 后一律不带 ?model=，只按服务端活动模型解析
		expect(
			apiCalls.some(
				(c) =>
					c.method === "GET" &&
					c.path.startsWith("/api/settings?") &&
					c.path !== "/api/settings/model-profiles",
			),
		).toBe(false);
		// 重拉一次
		expect(
			apiCalls.filter((c) => c.method === "GET" && c.path === "/api/settings")
				.length,
		).toBeGreaterThanOrEqual(2);
	});

	it("R7-7 搜索/提示词/重置：四字段＋key 条件；isDefault='1' 发空串、重置回填（:579-615）", async () => {
		await mountPage();
		setInputValue(byId("set-anysearch-key"), "as-key");
		byId("set-search-max-results").value = "9";
		await act(async () => {
			byId("btn-save-search-settings").click();
			await sleep(30);
		});
		const put = apiCalls.filter((c) => c.method === "PUT").at(-1);
		expect(put.body).toEqual({
			search_enabled: true,
			search_max_results: "9",
			search_freshness: "week",
			search_zone: "cn",
			anysearch_api_key: "as-key",
		});
		expect(toasts).toContain("搜索设置已保存");
		// 提示词：isDefault 时发空串
		await act(async () => {
			byId("btn-save-prompt").click();
			await sleep(30);
		});
		expect(apiCalls.filter((c) => c.method === "PUT").at(-1).body).toEqual({
			system_prompt: "自定义提示词",
		});
		// 重置 → 回填默认＋isDefault=1 → 再保存发空串
		await act(async () => {
			byId("btn-reset-prompt").click();
			await sleep(10);
		});
		expect(byId("set-system-prompt").value).toBe("默认提示词");
		expect(byId("set-system-prompt").dataset.isDefault).toBe("1");
		await act(async () => {
			byId("btn-save-prompt").click();
			await sleep(30);
		});
		expect(apiCalls.filter((c) => c.method === "PUT").at(-1).body).toEqual({
			system_prompt: "",
		});
		// 手改输入清除 isDefault
		setInputValue(byId("set-system-prompt"), "改过了");
		expect(byId("set-system-prompt").dataset.isDefault).toBe(undefined);
	});

	it("R7-8 作家仓库保存＋旁路失败不打断设置页（:376-394/:656-671）", async () => {
		await mountPage();
		byId("set-healthcheck-mode").value = "auto";
		byId("set-style-layer-enabled").checked = false;
		setInputValue(byId("set-zhuque-key"), "zq-key");
		await act(async () => {
			byId("btn-save-style-lab").click();
			await sleep(30);
		});
		const put = apiCalls.find(
			(c) => c.method === "PUT" && c.path === "/api/style-lab/config",
		);
		expect(put.body).toEqual({
			style_healthcheck_mode: "auto",
			style_layer_enabled: "0",
			zhuque_api_key: "zq-key",
		});
		expect(toasts).toContain("作家仓库设置已保存");
		// 旁路失败（GET config 500）不打断：页面字段仍在、无未处理异常
		respond = (m, u) => {
			if (m === "GET" && u === "/api/settings/model-profiles")
				return modelProfilesPayload();
			if (m === "GET" && u.startsWith("/api/settings"))
				return settingsPayload();
			if (m === "GET" && u === "/api/style-lab/config")
				throw new Error("配置读不到");
			return {};
		};
		await act(async () => {
			mountSettings();
			await sleep(30);
		});
		expect(byId("set-disable-thinking").value).toBe("deepseek-v4-flash");
	});

	it("R7-9 三测试按钮：按钮态「测试中…/检测中…」与成功/失败文案＋复位（:617-691）", async () => {
		let pending;
		respond = (m, u) => {
			if (m === "GET" && u.startsWith("/api/settings"))
				return settingsPayload();
			if (m === "GET" && u === "/api/style-lab/config")
				return styleLabPayload();
			if (m === "POST" && u === "/api/settings/test-search") return pending;
			if (m === "POST" && u === "/api/settings/test")
				return { model: "m1", reply: "hi" };
			if (m === "POST" && u === "/api/style-lab/test") return { conf: 0.5 };
			return {};
		};
		pending = new Promise((resolve) => {
			respond._resolveSearch = resolve;
		});
		await mountPage();
		await act(async () => {
			byId("btn-test-search").click();
			await sleep(10);
		});
		expect(byId("btn-test-search").disabled).toBe(true);
		expect(byId("btn-test-search").textContent).toBe("测试中…");
		await act(async () => {
			respond._resolveSearch({ snippet: "x".repeat(100) });
			await sleep(20);
		});
		expect(byId("btn-test-search").disabled).toBe(false);
		expect(byId("btn-test-search").textContent).toBe("测试搜索");
		expect(byId("search-test-result").className).toBe("test-result ok");
		expect(byId("search-test-result").textContent).toBe(
			`搜索正常 · ${"x".repeat(80)}`,
		);
		// 连接测试成功
		await act(async () => {
			byId("btn-test-conn").click();
			await sleep(30);
		});
		expect(byId("test-result").textContent).toBe("连接正常 · m1 回复：hi");
		expect(byId("test-result").className).toBe("test-result ok");
		// 朱雀测试成功（toFixed(4)）
		await act(async () => {
			byId("btn-test-zhuque").click();
			await sleep(30);
		});
		expect(byId("zhuque-test-result").textContent).toBe(
			"检测正常 · 该样例 AI 置信度 0.5000",
		);
		// 失败路径
		respond = (m, u) => {
			if (m === "GET" && u.startsWith("/api/settings"))
				return settingsPayload();
			if (m === "GET" && u === "/api/style-lab/config")
				return styleLabPayload();
			if (m === "POST" && u === "/api/settings/test-search")
				throw new Error("额度不足");
			if (m === "POST" && u === "/api/settings/test") throw new Error("连不上");
			return {};
		};
		await act(async () => {
			byId("btn-test-search").click();
			await sleep(30);
		});
		expect(byId("search-test-result").textContent).toBe("搜索失败：额度不足");
		expect(byId("search-test-result").className).toBe("test-result fail");
		expect(byId("btn-test-search").textContent).toBe("测试搜索");
		await act(async () => {
			byId("btn-test-conn").click();
			await sleep(30);
		});
		expect(byId("test-result").textContent).toBe("连接失败：连不上");
	});

	it("R7-10 btn-refresh-models 拉取后重拉设置（:508-527；set-model change 半边随字段移除退役）", async () => {
		let resolveRefresh;
		respond = (m, u) => {
			if (m === "GET" && u === "/api/settings/model-profiles")
				return modelProfilesPayload();
			if (m === "GET" && u.startsWith("/api/settings")) {
				const p = settingsPayload();
				p.settings.context_window_resolved = 64000;
				return p;
			}
			if (m === "GET" && u === "/api/style-lab/config")
				return styleLabPayload();
			if (m === "POST" && u === "/api/settings/refresh-models") {
				return new Promise((resolve) => {
					resolveRefresh = resolve;
				});
			}
			return {};
		};
		await mountPage();
		expect(byId("set-context-window").placeholder).toBe("64000");
		await act(async () => {
			byId("btn-refresh-models").click();
			await sleep(10);
		});
		expect(byId("btn-refresh-models").disabled).toBe(true);
		await act(async () => {
			resolveRefresh({ count: 12 });
			await sleep(30);
		});
		expect(toasts).toContain("已拉取渠道官方模型信息 12 条");
		expect(byId("btn-refresh-models").disabled).toBe(false);
	});

	it("R7-11 模块挂载件（P6-2 ⑨ 转写：模块直取）：mountSettings 为模块导出、调用即整页挂载（等值 app.js:207 renderSettings 入口）；window.MozhenSettings 零命中", async () => {
		expect(typeof mountSettings).toBe("function");
		expect(window.MozhenSettings).toBeUndefined(); // 反向见证：旧名桥退役后零命中
		await act(async () => {
			mountSettings();
			await sleep(25);
		});
		await waitFor(() => apiCalls.length > 0);
		expect(
			byId("page-settings").querySelector("#set-disable-thinking"),
		).toBeTruthy();
		expect(byId("set-disable-thinking").value).toBe("deepseek-v4-flash");
	});
});
