// @vitest-environment jsdom
// BYOK 服务商面板（frontend/components/ModelProfilesPanel.jsx）红测：
// 列表/徽章/掩码、模型 chip 切换与增删、添加服务商（models 解析）、删除门（内置/使用中不可删）、
// 编辑保存的字段裁剪与「清除 Key」、旧 localStorage['channel_keys'] 一次性迁移、明文 Key 不渲染。
// harness：jsdom ＋ React 19 act ＋ createRoot ＋ 裸 DOM（WorldWorkbenchPanel.test.jsx 同款）；
// api 桩＝有状态假服务端（返回契约与 server/modelProfiles.js listPayload 同形）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppForTests } from "../lib/app-runtime.js";
import ModelProfilesPanel from "./ModelProfilesPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PREFIX = "/api/settings/model-profiles";
// 明文哨兵：只存在于「假服务端的内部状态」，绝不进任何返回载荷以外的地方
const SECRET = "sk-test-abcdefghijklmnop";

function freshProfiles() {
	return [
		{
			id: "paid",
			name: "付费渠道（zen/go）",
			builtin: true,
			key_optional: false,
			base_url: "https://opencode.ai/zen/go/v1",
			api_key_set: true,
			api_key_masked: "sk-tes…23d2",
			models: ["deepseek-v4-flash", "deepseek-v4-pro"],
			context_window: "200000",
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
		{
			id: "agnes",
			name: "Agnes（apihub）",
			builtin: true,
			key_optional: false,
			base_url: "https://apihub.agnes-ai.com/v1",
			api_key_set: true,
			api_key_masked: "sk-tes…nes1",
			models: ["agnes-2.5-flash"],
			context_window: "",
		},
		{
			id: "custom-1",
			name: "自建中转",
			builtin: false,
			key_optional: false,
			base_url: "https://example.com/v1",
			api_key_set: false,
			api_key_masked: "",
			models: ["gpt-x"],
			context_window: "",
		},
	];
}

let container;
let root;
let calls;
let toasts;
let activated;
let server;
let failWhen;
let confirmResult;
let confirmCalls;

function payload() {
	return {
		profiles: server.profiles.map((p) => ({ ...p })),
		active_profile_id: server.activeId,
		active_model: server.activeModel,
	};
}

function find(id) {
	return server.profiles.find((p) => p.id === id);
}

async function api(method, path, body) {
	calls.push({ method, path, body });
	if (failWhen?.(method, path, body)) throw new Error("后端拒绝");
	const rest = path.startsWith(`${PREFIX}/`)
		? path.slice(PREFIX.length + 1)
		: "";
	if (method === "GET" && path === PREFIX) return payload();
	if (method === "POST" && path === PREFIX) {
		const created = {
			id: "p_new",
			name: body.name,
			builtin: false,
			key_optional: false,
			base_url: body.base_url,
			api_key_set: !!body.api_key,
			api_key_masked: body.api_key ? "sk-tes…new" : "",
			models: body.models.slice(),
			context_window: body.context_window || "",
		};
		server.profiles.push(created);
		return { profile: created, ...payload() };
	}
	if (method === "PUT" && rest) {
		const p = find(rest);
		if (body.name !== undefined) p.name = body.name;
		if (body.base_url !== undefined) p.base_url = body.base_url;
		if (body.models !== undefined) p.models = body.models.slice();
		if (body.context_window !== undefined)
			p.context_window = body.context_window;
		if (body.api_key !== undefined) {
			p.api_key_set = body.clear_api_key === true ? false : !!body.api_key;
			p.api_key_masked = p.api_key_set ? "sk-tes…new" : "";
		}
		return payload();
	}
	if (method === "DELETE" && rest) {
		server.profiles = server.profiles.filter((p) => p.id !== rest);
		return payload();
	}
	if (method === "POST" && rest.endsWith("/activate")) {
		server.activeId = rest.slice(0, -"/activate".length);
		server.activeModel = body.model;
		return { settings: {}, ...payload() };
	}
	throw new Error(`未桩住：${method} ${path}`);
}

function byId(id) {
	return document.getElementById(id);
}

function item(id) {
	return container.querySelector(`li[data-profile-id="${id}"]`);
}

function setInputValue(el, value) {
	const proto =
		el.tagName === "TEXTAREA"
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function flush(n = 8) {
	for (let i = 0; i < n; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function click(el) {
	await act(async () => {
		el.click();
	});
	await flush();
}

async function type(el, value) {
	await act(async () => {
		setInputValue(el, value);
	});
}

async function mount() {
	await act(async () => {
		root.render(
			<ModelProfilesPanel
				onActivated={() => {
					activated += 1;
				}}
			/>,
		);
	});
	await flush();
}

beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	container = byId("host");
	root = createRoot(container);
	calls = [];
	toasts = [];
	activated = 0;
	server = {
		profiles: freshProfiles(),
		activeId: "paid",
		activeModel: "deepseek-v4-flash",
	};
	// 内部明文：面板只应显示 api_key_masked
	find("paid").api_key = SECRET;
	failWhen = null;
	confirmResult = true;
	confirmCalls = [];
	localStorage.clear();
	window.App = {
		api,
		toast(msg) {
			toasts.push(String(msg));
		},
	};
	setAppForTests(window.App);
	window.confirm = (msg) => {
		confirmCalls.push(msg);
		return confirmResult;
	};
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	document.body.innerHTML = "";
	setAppForTests(null);
	vi.restoreAllMocks();
});

function putCalls() {
	return calls.filter((c) => c.method === "PUT");
}

describe("ModelProfilesPanel 列表与徽章", () => {
	it("列表：四条服务商、内置/使用中徽章、掩码 Key、无需 Key、上下文；明文 Key 不渲染、编辑框不回填", async () => {
		await mount();
		expect(calls[0]).toEqual({ method: "GET", path: PREFIX, body: undefined });
		expect(container.querySelectorAll("li.mp-item")).toHaveLength(4);
		expect(byId("model-profiles").className).toBe("model-profiles");

		const paid = item("paid");
		expect(paid.classList.contains("active")).toBe(true);
		expect(paid.querySelector(".mp-name").textContent).toBe(
			"付费渠道（zen/go）",
		);
		const badges = [...paid.querySelectorAll(".mp-badge")].map(
			(n) => n.textContent,
		);
		expect(badges).toEqual(["内置", "使用中"]);
		expect(paid.querySelector(".mp-meta").textContent).toBe(
			"https://opencode.ai/zen/go/v1 · Key 已配置 sk-tes…23d2 · 上下文 200000",
		);

		const free = item("free");
		expect(free.classList.contains("active")).toBe(false);
		expect(free.querySelector(".mp-meta").textContent).toBe(
			"https://opencode.ai/zen/v1 · 无需 Key",
		);

		const custom = item("custom-1");
		expect(custom.querySelector(".mp-meta").textContent).toBe(
			"https://example.com/v1 · Key 未配置",
		);
		expect([...custom.querySelectorAll(".mp-badge")]).toEqual([]);

		// 明文哨兵不出现在 DOM；编辑框 value 为空（只给 placeholder 提示掩码）
		expect(container.innerHTML).not.toContain(SECRET);
		await click(paid.querySelector(".mp-edit"));
		const keyInput = paid.querySelector(".mp-edit-api-key");
		expect(keyInput.value).toBe("");
		expect(keyInput.placeholder).toBe("已配置 sk-tes…23d2，留空则保持不变");
		// 内置服务商不可改名称/Base URL → 这两个输入框不渲染
		expect(paid.querySelector(".mp-edit-name")).toBe(null);
		expect(paid.querySelector(".mp-edit-base-url")).toBe(null);
	});

	it("错误路径：列表拉取失败 toast e.message，且不渲染任何条目", async () => {
		failWhen = (m, p) => m === "GET" && p === PREFIX;
		await mount();
		expect(toasts).toEqual(["后端拒绝"]);
		expect(container.querySelectorAll("li.mp-item")).toHaveLength(0);
	});
});

describe("ModelProfilesPanel 模型 chip", () => {
	it("点 chip → activate POST body {model}＋toast＋onActivated；使用中的 chip 带 on 类", async () => {
		await mount();
		const paid = item("paid");
		const [cur, other] = [...paid.querySelectorAll(".mp-chip")];
		expect(cur.textContent).toBe("deepseek-v4-flash");
		expect(cur.className).toBe("mp-chip on");
		expect(other.className).toBe("mp-chip");
		expect(other.title).toBe("切换到此模型");

		await click(other);
		const post = calls.find(
			(c) => c.method === "POST" && c.path === `${PREFIX}/paid/activate`,
		);
		expect(post.body).toEqual({ model: "deepseek-v4-pro" });
		expect(toasts).toContain("已切换到 付费渠道（zen/go） · deepseek-v4-pro");
		expect(activated).toBe(1);
		// 激活后本地态取自返回载荷
		expect(item("paid").querySelector(".mp-chip.on").textContent).toBe(
			"deepseek-v4-pro",
		);
	});

	it("× 只在多模型且非当前模型时出现；删除发 PUT {models 去掉该项}", async () => {
		await mount();
		const paid = item("paid");
		expect(
			paid.querySelector('button[aria-label="删除模型 deepseek-v4-flash"]'),
		).toBe(null);
		const cross = paid.querySelector(
			'button[aria-label="删除模型 deepseek-v4-pro"]',
		);
		expect(cross).not.toBe(null);
		// 单模型服务商无 ×
		expect(item("free").querySelector(".mp-chip-x")).toBe(null);

		await click(cross);
		expect(putCalls().at(-1).body).toEqual({
			models: ["deepseek-v4-flash"],
		});
		expect(item("paid").querySelectorAll(".mp-chip")).toHaveLength(1);
		expect(item("paid").querySelector(".mp-chip-x")).toBe(null);
	});

	it("内联加模型：PUT {models: [..., newName]}；重复或空白不出请求、重复 toast「模型已存在」", async () => {
		await mount();
		const paid = item("paid");
		await type(paid.querySelector(".mp-add-model"), "deepseek-v4-new");
		await click(paid.querySelector(".mp-add-model-btn"));
		expect(putCalls()).toHaveLength(1);
		expect(putCalls()[0].path).toBe(`${PREFIX}/paid`);
		expect(putCalls()[0].body).toEqual({
			models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-new"],
		});
		// 成功清空输入
		expect(item("paid").querySelector(".mp-add-model").value).toBe("");

		await type(item("paid").querySelector(".mp-add-model"), "deepseek-v4-pro");
		await click(item("paid").querySelector(".mp-add-model-btn"));
		expect(putCalls()).toHaveLength(1);
		expect(toasts).toContain("模型已存在");

		await type(item("paid").querySelector(".mp-add-model"), "   ");
		await click(item("paid").querySelector(".mp-add-model-btn"));
		expect(putCalls()).toHaveLength(1);
	});

	it("Enter 提交加模型", async () => {
		await mount();
		const input = item("paid").querySelector(".mp-add-model");
		await type(input, "deepseek-v4-enter");
		await act(async () => {
			input.dispatchEvent(
				new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		await flush();
		expect(putCalls().at(-1).body.models).toContain("deepseek-v4-enter");
	});
});

describe("ModelProfilesPanel 添加服务商", () => {
	it("表单提交：POST payload 四字段＋models 按换行/逗号切分去空；成功后收起＋toast", async () => {
		await mount();
		expect(container.querySelector(".mp-form")).toBe(null);
		await click(byId("btn-add-profile"));
		const form = container.querySelector("form.mp-form, .mp-form");
		expect(form).not.toBe(null);
		await type(form.querySelector(".mp-add-name"), "  新中转  ");
		await type(
			form.querySelector(".mp-add-base-url"),
			" https://new.example.com/v1 ",
		);
		await type(form.querySelector(".mp-add-api-key"), "sk-test-new");
		await type(form.querySelector(".mp-add-models"), "a\nb, c\n\n , d ");
		await type(form.querySelector(".mp-add-context"), "128000");
		await click(form.querySelector(".mp-add-save"));

		const post = calls.find((c) => c.method === "POST" && c.path === PREFIX);
		expect(post.body).toEqual({
			name: "新中转",
			base_url: "https://new.example.com/v1",
			models: ["a", "b", "c", "d"],
			api_key: "sk-test-new",
			context_window: "128000",
		});
		expect(toasts).toContain("已添加服务商「新中转」");
		expect(container.querySelectorAll("li.mp-item")).toHaveLength(5);
		expect(container.querySelector(".mp-form")).toBe(null);
	});

	it("空 Key／空上下文不下发该字段；取消收起表单", async () => {
		await mount();
		await click(byId("btn-add-profile"));
		const form = container.querySelector(".mp-form");
		await type(form.querySelector(".mp-add-name"), "无 Key 服务商");
		await type(
			form.querySelector(".mp-add-base-url"),
			"https://nokey.example.com/v1",
		);
		await type(form.querySelector(".mp-add-models"), "m1");
		await click(form.querySelector(".mp-add-save"));
		const post = calls.find((c) => c.method === "POST" && c.path === PREFIX);
		expect(post.body).toEqual({
			name: "无 Key 服务商",
			base_url: "https://nokey.example.com/v1",
			models: ["m1"],
		});
		// 再开一次 → 取消
		await click(byId("btn-add-profile"));
		expect(container.querySelector(".mp-form")).not.toBe(null);
		await click(container.querySelector(".mp-add-cancel"));
		expect(container.querySelector(".mp-form")).toBe(null);
	});

	it("添加失败：toast e.message 且表单保留（不吞掉用户输入）", async () => {
		await mount();
		failWhen = (m, p) => m === "POST" && p === PREFIX;
		await click(byId("btn-add-profile"));
		const form = container.querySelector(".mp-form");
		await type(form.querySelector(".mp-add-name"), "会失败");
		await type(
			form.querySelector(".mp-add-base-url"),
			"https://bad.example.com/v1",
		);
		await type(form.querySelector(".mp-add-models"), "m1");
		await click(form.querySelector(".mp-add-save"));
		expect(toasts).toContain("后端拒绝");
		expect(container.querySelector(".mp-form")).not.toBe(null);
		expect(container.querySelector(".mp-add-name").value).toBe("会失败");
	});
});

describe("ModelProfilesPanel 删除", () => {
	it("自定义且未使用中：确认后 DELETE＋toast「已删除」；内置/使用中不出删除按钮", async () => {
		await mount();
		expect(item("paid").querySelector(".mp-delete")).toBe(null);
		expect(item("free").querySelector(".mp-delete")).toBe(null);
		const del = item("custom-1").querySelector(".mp-delete");
		expect(del).not.toBe(null);
		await click(del);
		expect(confirmCalls).toEqual(["删除服务商「自建中转」？"]);
		const req = calls.find((c) => c.method === "DELETE");
		expect(req.path).toBe(`${PREFIX}/custom-1`);
		expect(toasts).toContain("已删除");
		expect(container.querySelectorAll("li.mp-item")).toHaveLength(3);
	});

	it("确认框取消 → 不出 DELETE", async () => {
		await mount();
		confirmResult = false;
		await click(item("custom-1").querySelector(".mp-delete"));
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(container.querySelectorAll("li.mp-item")).toHaveLength(4);
	});

	it("使用中的自定义服务商也不出删除按钮（避免删掉当前渠道）", async () => {
		server.activeId = "custom-1";
		server.activeModel = "gpt-x";
		await mount();
		expect(item("custom-1").classList.contains("active")).toBe(true);
		expect(item("custom-1").querySelector(".mp-delete")).toBe(null);
	});
});

describe("ModelProfilesPanel 编辑", () => {
	it("保存：只发改动/非空字段；context_window 总是以字符串发；未填 Key 不发 api_key", async () => {
		await mount();
		const paid = item("paid");
		await click(paid.querySelector(".mp-edit"));
		await type(paid.querySelector(".mp-edit-context"), "300000");
		await click(paid.querySelector(".mp-edit-save"));
		expect(putCalls().at(-1).body).toEqual({ context_window: "300000" });
		expect(toasts).toContain("已保存");
		expect(item("paid").querySelector(".mp-edit")).not.toBe(null);
		// 编辑的是活动服务商 → 通知父级重读设置
		expect(activated).toBe(1);
	});

	it("填了 Key 才发 api_key；「清除 Key」发 api_key:''＋clear_api_key:true", async () => {
		await mount();
		let paid = item("paid");
		await click(paid.querySelector(".mp-edit"));
		await type(paid.querySelector(".mp-edit-api-key"), "sk-test-typed");
		await click(paid.querySelector(".mp-edit-save"));
		expect(putCalls().at(-1).body).toEqual({
			context_window: "200000",
			api_key: "sk-test-typed",
		});

		// 清 Key：只在 api_key_set 时出现
		paid = item("paid");
		await click(paid.querySelector(".mp-edit"));
		expect(item("free")).not.toBe(null);
		const clear = paid.querySelector(".mp-clear-key");
		expect(clear).not.toBe(null);
		await click(clear);
		expect(putCalls().at(-1).body).toEqual({
			api_key: "",
			clear_api_key: true,
		});
		expect(item("paid").querySelector(".mp-edit-api-key")).toBe(null);
	});

	it("未配置 Key 的服务商：无「清除 Key」按钮，placeholder 为「未配置，粘贴 API Key」", async () => {
		await mount();
		const custom = item("custom-1");
		await click(custom.querySelector(".mp-edit"));
		expect(custom.querySelector(".mp-clear-key")).toBe(null);
		expect(custom.querySelector(".mp-edit-api-key").placeholder).toBe(
			"未配置，粘贴 API Key",
		);
	});

	it("非内置服务商：改名称与 Base URL 才发对应字段", async () => {
		await mount();
		const custom = item("custom-1");
		await click(custom.querySelector(".mp-edit"));
		await type(custom.querySelector(".mp-edit-name"), "  改名后  ");
		await type(
			custom.querySelector(".mp-edit-base-url"),
			"https://new.example.com/v2",
		);
		await click(custom.querySelector(".mp-edit-save"));
		expect(putCalls().at(-1).body).toEqual({
			name: "改名后",
			base_url: "https://new.example.com/v2",
			context_window: "",
		});
		// 非活动服务商编辑不通知父级
		expect(activated).toBe(0);
		// 取消失效：编辑态收起
		expect(item("custom-1").querySelector(".mp-edit-name")).toBe(null);
	});

	it("取消编辑不出请求", async () => {
		await mount();
		const paid = item("paid");
		await click(paid.querySelector(".mp-edit"));
		await type(paid.querySelector(".mp-edit-context"), "999999");
		await click(paid.querySelector(".mp-edit-cancel"));
		expect(putCalls()).toHaveLength(0);
		expect(item("paid").querySelector(".mp-edit-context")).toBe(null);
	});
});

describe("ModelProfilesPanel 旧 Key 迁移", () => {
	it("channel_keys 里的付费/agnes Key 逐个 PUT，全成功则删除该键；free 不迁", async () => {
		server.profiles = server.profiles.map((p) => ({
			...p,
			api_key_set: false,
			api_key_masked: "",
		}));
		localStorage.setItem(
			"channel_keys",
			JSON.stringify({
				paid: "sk-test-paid",
				agnes: "sk-test-agnes",
				free: "sk-test-free",
			}),
		);
		await mount();
		const puts = putCalls();
		expect(puts.map((c) => c.path)).toEqual([
			`${PREFIX}/paid`,
			`${PREFIX}/agnes`,
		]);
		expect(puts.map((c) => c.body)).toEqual([
			{ api_key: "sk-test-paid" },
			{ api_key: "sk-test-agnes" },
		]);
		expect(localStorage.getItem("channel_keys")).toBe(null);
	});

	it("已配置 Key 的内置服务商跳过；无 channel_keys 时不发 PUT", async () => {
		server.profiles = server.profiles.map((p) =>
			p.id === "agnes"
				? { ...p, api_key_set: false, api_key_masked: "" }
				: { ...p, api_key_set: true, api_key_masked: "sk-tes…23d2" },
		);
		localStorage.setItem(
			"channel_keys",
			JSON.stringify({ paid: "sk-test-paid", agnes: "sk-test-agnes" }),
		);
		await mount();
		expect(putCalls()).toHaveLength(1);
		expect(putCalls()[0].path).toBe(`${PREFIX}/agnes`);

		localStorage.clear();
		calls = [];
		await mount();
		expect(putCalls()).toHaveLength(0);
	});

	it("任一 PUT 失败则保留 channel_keys（下次进设置页重试）", async () => {
		server.profiles = server.profiles.map((p) => ({
			...p,
			api_key_set: false,
			api_key_masked: "",
		}));
		localStorage.setItem(
			"channel_keys",
			JSON.stringify({ paid: "sk-test-paid", agnes: "sk-test-agnes" }),
		);
		failWhen = (m, p) => m === "PUT" && p === `${PREFIX}/agnes`;
		await mount();
		expect(localStorage.getItem("channel_keys")).not.toBe(null);
		// 失败不弹错：迁移是静默兼容动作
		expect(toasts).toEqual([]);
	});

	it("坏 JSON 不抛：不迁移，按「无可迁项」清理该垃圾键", async () => {
		localStorage.setItem("channel_keys", "{{{ 坏掉的");
		await mount();
		expect(putCalls()).toHaveLength(0);
		expect(toasts).toEqual([]);
		expect(localStorage.getItem("channel_keys")).toBe(null);
	});
});
