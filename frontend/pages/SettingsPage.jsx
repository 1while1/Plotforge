// S5-3（Plan §2.4.6）：SettingsPage 设置页整页 React——public/legacy/app.js:286-671 的等值移植
// （静态壳镜像 index.html:272-427，29 个 id 逐一对位）。
//
// 等值要点（行号＝legacy app.js；渠道/Key 部分已移出本页，改由 ModelProfilesPanel 的 BYOK 服务商模型接管，
// Key 存服务端库、页面只见掩码）：
// - 渠道/Key 段（CHANNELS/detectChannel :286-298、keyStash/stashKey :301-309、渠道切换 :529-541）
//   已移出本页：BYOK 服务商由 frontend/components/ModelProfilesPanel.jsx 接管，Key 存服务端不落浏览器。
// - setCtxHint 四分支文案与 title :313-329（钳制/渠道已报/渠道未报/未拉取）。
// - renderSettings :331-372：回填顺序与掩码 placeholder 语义（AnySearch 与作家仓库同口径）；
//   system_prompt 缺省回填 default_system_prompt 并置 isDefault；
//   renderStyleLab 旁路 :376-394（GET /api/style-lab/config 读不到不打断设置页）。
// - refreshCtxWindowField :508-517（?model= 覆盖，不落库；BYOK 后一律不带 ?model=，以服务端活动模型为准）。
// - 保存设置 :551-576（三字段＋disable_thinking_models 无条件发、成功后 refreshCtxWindowField＋
//   toast「已保存」＋重拉；渠道/Key 语义已移出，见 ModelProfilesPanel）。
// - 保存搜索 :598-615（四字段＋key 条件）；保存提示词 :579-588（isDefault==='1' 发空串）；
//   重置提示词 :591-595；作家仓库保存 :656-671（mode＋layer '1'/'0'＋key 条件）。
// - 三测试按钮 :618-691（按钮态「测试中…/检测中…」与结果文案逐字＋finally 复位）；
//   btn-refresh-models :521-527；set-system-prompt input 清 isDefault :694-696。
//
// 字段一律非受控（defaultValue/命令式写值）——等值 legacy 直接写 .value，且书签/外部脚本可读写；
// React 只渲染壳结构与事件，不做受控重渲染（S5-2 编辑器先例同款）。

import { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import ModelProfilesPanel from "../components/ModelProfilesPanel.jsx";
import { getApp } from "../lib/app-runtime.js";

let visit = 0;
// 等值 legacy app.js:10 的模块级 defaultSystemPrompt（重置提示词回填用）
let defaultSystemPrompt = "";

function app() {
	return getApp();
}

function $(id) {
	return document.getElementById(id);
}

function setCtxHint(s) {
	const hint = $("ctx-window-hint");
	if (!hint) return;
	if (s.context_window_clamped) {
		hint.textContent = `被钳制：设 ${s.context_window} 超渠道官方 ${s.context_window_official}，生效 ${s.context_window_resolved}`;
		hint.title = s.context_window_note || "";
	} else if (s.context_window_official_source === "channel_reported") {
		hint.textContent = `${s.context_window_auto ? "自动" : `生效 ${s.context_window_resolved}`} · 官方 ${s.context_window_official}（渠道 /models 报告）`;
		hint.title = `拉取于 ${s.context_window_official_fetched_at || "-"}`;
	} else if (s.context_window_official_source === "channel_not_reported") {
		hint.textContent = `${s.context_window_auto ? `自动（系统默认 ${s.context_window_resolved}）` : `按你设置生效 ${s.context_window_resolved}`} · 渠道未报官方，不猜测`;
		hint.title = s.context_window_note || "";
	} else {
		hint.textContent = `${s.context_window_auto ? `自动（系统默认 ${s.context_window_resolved}）` : `已手动锁定 ${s.context_window_resolved}`} · 官方源尚未拉取`;
		hint.title = "";
	}
}

export default function SettingsPage() {
	const refreshCtxWindowField = useCallback(async () => {
		try {
			const data = await app().api("GET", "/api/settings");
			const s = data.settings || {};
			$("set-context-window").value = s.context_window || "";
			$("set-context-window").placeholder = String(
				s.context_window_resolved || 128000,
			);
			setCtxHint(s);
		} catch (_e) {
			/* 等值 legacy :516 .catch(function () {}) */
		}
	}, []);

	const renderStyleLab = useCallback(async () => {
		try {
			const data = await app().api("GET", "/api/style-lab/config");
			const c = data.config || {};
			const keyEl = $("set-zhuque-key");
			if (keyEl) {
				keyEl.value = "";
				keyEl.placeholder = c.api_key_set
					? `已配置 ${c.api_key_masked || ""}，留空则保持不变`
					: "未配置（可选，体检用）";
			}
			const epEl = $("set-zhuque-endpoint");
			if (epEl) epEl.value = c.detector_endpoint || "";
			const modeEl = $("set-healthcheck-mode");
			if (modeEl) modeEl.value = c.healthcheck_mode || "manual";
			const layerEl = $("set-style-layer-enabled");
			if (layerEl) layerEl.checked = c.style_layer_enabled !== false;
		} catch (_e) {
			/* 旁路能力：读不到就不显示，不打断设置页 */
		}
	}, []);

	const renderSettings = useCallback(async () => {
		try {
			const data = await app().api("GET", "/api/settings");
			const s = data.settings || {};
			defaultSystemPrompt = s.default_system_prompt || "";
			const asEl = $("set-anysearch-key");
			asEl.value = "";
			asEl.placeholder = s.anysearch_api_key_set
				? `已配置 ${s.anysearch_api_key_masked || ""}，留空则保持不变`
				: "未配置（可选，联网搜索用）";
			$("set-search-enabled").checked = s.search_enabled !== false;
			$("set-search-endpoint").value = s.anysearch_endpoint_effective || "";
			$("set-search-max-results").value = s.search_max_results || 5;
			$("set-search-freshness").value = s.search_freshness || "";
			$("set-search-zone").value = s.search_zone || "";
			$("set-context-window").value = s.context_window || "";
			$("set-context-window").placeholder = String(
				s.context_window_resolved || 128000,
			);
			setCtxHint(s);
			$("set-compress-ratio").value = s.compression_ratio || "0.8";
			$("set-disable-thinking").value = s.disable_thinking_models || "";
			const ta = $("set-system-prompt");
			if (s.system_prompt) {
				ta.value = s.system_prompt;
				delete ta.dataset.isDefault;
			} else {
				ta.value = defaultSystemPrompt;
				ta.dataset.isDefault = "1";
			}
			renderStyleLab();
		} catch (e) {
			app().toast(e.message);
		}
	}, [renderStyleLab]);

	useEffect(() => {
		renderSettings();
	}, [renderSettings]);

	async function onSaveSettings() {
		try {
			const settings = {
				context_window: $("set-context-window").value.trim(),
				compression_ratio: $("set-compress-ratio").value.trim(),
				// 深度思考开关：留空 = 不干预（与历史行为一致），故无条件发送空串是安全的
				disable_thinking_models: $("set-disable-thinking").value.trim(),
			};
			await app().api("PUT", "/api/settings", settings);
			refreshCtxWindowField();
			app().toast("已保存");
			renderSettings();
		} catch (e) {
			app().toast(e.message);
		}
	}

	async function onSavePrompt() {
		try {
			const ta = $("set-system-prompt");
			const system_prompt = ta.dataset.isDefault === "1" ? "" : ta.value;
			await app().api("PUT", "/api/settings", { system_prompt: system_prompt });
			app().toast("已保存");
		} catch (e) {
			app().toast(e.message);
		}
	}

	function onResetPrompt() {
		const ta = $("set-system-prompt");
		ta.value = defaultSystemPrompt;
		ta.dataset.isDefault = "1";
	}

	async function onSaveSearchSettings() {
		try {
			const settings = {
				search_enabled: $("set-search-enabled").checked,
				search_max_results: $("set-search-max-results").value.trim() || "5",
				search_freshness: $("set-search-freshness").value,
				search_zone: $("set-search-zone").value,
			};
			const asVal = $("set-anysearch-key").value.trim();
			if (asVal) settings.anysearch_api_key = asVal;
			await app().api("PUT", "/api/settings", settings);
			app().toast("搜索设置已保存");
			renderSettings();
		} catch (e) {
			app().toast(e.message);
		}
	}

	async function onTestSearch() {
		const btn = $("btn-test-search");
		const result = $("search-test-result");
		btn.disabled = true;
		btn.textContent = "测试中…";
		try {
			const data = await app().api("POST", "/api/settings/test-search");
			result.className = "test-result ok";
			result.textContent = `搜索正常 · ${String(data.snippet || "").slice(0, 80)}`;
		} catch (e) {
			result.className = "test-result fail";
			result.textContent = `搜索失败：${e.message}`;
		} finally {
			btn.disabled = false;
			btn.textContent = "测试搜索";
		}
	}

	async function onTestConn() {
		const btn = $("btn-test-conn");
		const result = $("test-result");
		btn.disabled = true;
		btn.textContent = "测试中…";
		try {
			const data = await app().api("POST", "/api/settings/test");
			result.className = "test-result ok";
			result.textContent = `连接正常 · ${data.model || ""} 回复：${data.reply || ""}`;
		} catch (e) {
			result.className = "test-result fail";
			result.textContent = `连接失败：${e.message}`;
		} finally {
			btn.disabled = false;
			btn.textContent = "测试连接";
		}
	}

	async function onSaveStyleLab() {
		try {
			const payload = {
				style_healthcheck_mode: $("set-healthcheck-mode").value,
				style_layer_enabled: $("set-style-layer-enabled").checked ? "1" : "0",
			};
			const zqVal = $("set-zhuque-key").value.trim();
			if (zqVal) payload.zhuque_api_key = zqVal;
			await app().api("PUT", "/api/style-lab/config", payload);
			app().toast("作家仓库设置已保存");
			renderStyleLab();
		} catch (e) {
			app().toast(e.message);
		}
	}

	async function onTestZhuque() {
		const btn = $("btn-test-zhuque");
		const result = $("zhuque-test-result");
		btn.disabled = true;
		btn.textContent = "检测中…";
		try {
			const data = await app().api("POST", "/api/style-lab/test");
			result.className = "test-result ok";
			const conf = typeof data.conf === "number" ? data.conf : null;
			result.textContent = `检测正常 · 该样例 AI 置信度 ${conf === null ? "—" : conf.toFixed(4)}`;
		} catch (e) {
			result.className = "test-result fail";
			result.textContent = `检测失败：${e.message}`;
		} finally {
			btn.disabled = false;
			btn.textContent = "测试检测";
		}
	}

	function onRefreshModels() {
		const rmBtn = $("btn-refresh-models");
		rmBtn.disabled = true;
		app()
			.api("POST", "/api/settings/refresh-models", {})
			.then((d) => {
				app().toast(`已拉取渠道官方模型信息 ${d.count || 0} 条`);
				renderSettings();
			})
			.catch((e) => {
				app().toast(e.message);
			})
			.finally(() => {
				rmBtn.disabled = false;
			});
	}

	return (
		<>
			<header className="topbar">
				<div className="topbar-left">
					<a href="#/" className="btn btn-ghost">
						书架
					</a>
					<h1 className="book-title">设置</h1>
				</div>
			</header>
			<main className="settings-main">
				<section className="settings-card">
					<h3>模型接口</h3>
					<ModelProfilesPanel onActivated={renderSettings} />
					<label className="field">
						<span>
							上下文窗口大小{" "}
							<small id="ctx-window-hint">自动（跟随模型）</small>
						</span>
						<input
							id="set-context-window"
							type="number"
							min="8000"
							step="1000"
							placeholder="128000"
						/>
						<button
							type="button"
							id="btn-refresh-models"
							className="btn btn-ghost btn-small"
							title="拉取渠道 /models 接口报告的上下文上限（官方第一信息源，不猜测）"
							onClick={onRefreshModels}
						>
							刷新官方源
						</button>
					</label>
					<label className="field">
						<span>
							自动压缩线{" "}
							<small>（占用达到 窗口×此比例 时自动压缩对话，0.5~0.95）</small>
						</span>
						<input
							id="set-compress-ratio"
							type="number"
							min="0.5"
							max="0.95"
							step="0.05"
							placeholder="0.8"
						/>
					</label>
					<label className="field">
						<span>
							关闭深度思考的模型{" "}
							<small>（逗号分隔；留空=不干预，* = 全部）</small>
						</span>
						<input
							id="set-disable-thinking"
							type="text"
							placeholder="留空不干预，例如 deepseek-v4-flash"
						/>
						<small className="field-hint">
							写一轮最多 4 次模型调用。个别推理模型（实测
							deepseek-v4-flash）每次先思考几千 token，一轮要等 60~77
							秒；点名后请求会带上 enable_thinking:false，实测单次 6.8 秒 → 3.9
							秒，正文与工具调用不变。换渠道后若报「未知请求字段」，清空本项即可。
						</small>
					</label>
					<div className="settings-row">
						<button
							type="button"
							id="btn-save-settings"
							className="btn btn-primary"
							onClick={onSaveSettings}
						>
							保存设置
						</button>
						<button
							type="button"
							id="btn-test-conn"
							className="btn btn-outline"
							onClick={onTestConn}
						>
							测试连接
						</button>
						<span id="test-result" className="test-result" />
					</div>
				</section>

				<section className="settings-card">
					<h3>搜索工具（AnySearch）</h3>
					<label className="field">
						<span>
							联网搜索 Key{" "}
							<small>（AnySearch · 可留空匿名使用，限额较低）</small>
						</span>
						<input
							id="set-anysearch-key"
							type="text"
							placeholder="留空则匿名"
						/>
					</label>
					<label className="field field-inline">
						<input id="set-search-enabled" type="checkbox" />
						<span>
							启用联网搜索{" "}
							<small>
								（关闭后 web_search / batch_search / web_extract / skill_search
								一律不出网）
							</small>
						</span>
					</label>
					<label className="field">
						<span>
							端点 <small>（只读）</small>
						</span>
						<input id="set-search-endpoint" type="text" readOnly />
						<small>
							端点由服务端锁定（A6 安全），改端点请设环境变量 ANYSEARCH_ENDPOINT
							后重启
						</small>
					</label>
					<label className="field">
						<span>
							默认结果条数 <small>（1-10，工具调用未指定时生效）</small>
						</span>
						<input
							id="set-search-max-results"
							type="number"
							min="1"
							max="10"
							step="1"
							placeholder="5"
						/>
					</label>
					<label className="field">
						<span>默认时效过滤</span>
						<select id="set-search-freshness">
							<option value="">不限</option>
							<option value="day">一天内</option>
							<option value="week">一周内</option>
							<option value="month">一月内</option>
							<option value="year">一年内</option>
						</select>
					</label>
					<label className="field">
						<span>默认区域</span>
						<select id="set-search-zone">
							<option value="">不限</option>
							<option value="cn">国内</option>
							<option value="intl">国际</option>
						</select>
					</label>
					<div className="settings-row">
						<button
							type="button"
							id="btn-save-search-settings"
							className="btn btn-primary"
							onClick={onSaveSearchSettings}
						>
							保存搜索设置
						</button>
						<button
							type="button"
							id="btn-test-search"
							className="btn btn-outline"
							onClick={onTestSearch}
						>
							测试搜索
						</button>
						<span id="search-test-result" className="test-result" />
					</div>
				</section>

				<section className="settings-card">
					<h3>全局系统提示词</h3>
					<p className="field-hint">
						所有书籍默认使用；单本书可在工作台「本书提示词」中覆盖。
					</p>
					<textarea
						id="set-system-prompt"
						rows="12"
						onInput={(e) => {
							// 等值 :694-696：手改输入即清除「跟随默认」标记
							delete e.currentTarget.dataset.isDefault;
						}}
					/>
					<div className="settings-row">
						<button
							type="button"
							id="btn-save-prompt"
							className="btn btn-primary"
							onClick={onSavePrompt}
						>
							保存提示词
						</button>
						<button
							type="button"
							id="btn-reset-prompt"
							className="btn btn-ghost"
							onClick={onResetPrompt}
						>
							恢复默认
						</button>
					</div>
				</section>

				<section className="settings-card">
					<h3>作家仓库</h3>
					<p className="field-hint">
						在系统提示词与写作之间的一层：<strong>文风注入</strong>
						（写之前让 AI 按风格写）+ <strong>AI 味体检</strong>
						（写完后用朱雀检测，判为 AI
						的语句进错题库）。体检完全旁路，失败不影响写作。
					</p>

					<label className="field">
						<span>
							朱雀检测 Key{" "}
							<small>
								（用于 AI 味体检；不填则体检不可用，其他功能不受影响）
							</small>
						</span>
						<input
							id="set-zhuque-key"
							type="text"
							placeholder="未配置（可选，体检用）"
						/>
					</label>
					<label className="field">
						<span>
							检测端点 <small>（只读）</small>
						</span>
						<input id="set-zhuque-endpoint" type="text" readOnly />
						<small>
							端点由服务端锁定（安全），改端点请设环境变量 ZHUQUE_ENDPOINT
							后重启
						</small>
					</label>

					<label className="field">
						<span>体检触发方式</span>
						<select id="set-healthcheck-mode">
							<option value="manual">手动（点按钮才检测）</option>
							<option value="auto">自动（每章定稿后检测一次）</option>
						</select>
						<small id="healthcheck-hint">
							朱雀免费额度约 50 万 token/月（约 80 章），自动模式请留意额度。
						</small>
					</label>

					<label className="field field-inline">
						<input id="set-style-layer-enabled" type="checkbox" />
						<span>
							启用文风注入{" "}
							<small>
								（把「怎么写的约束」注入系统提示词；关闭后写作行为回到不加风格层的状态）
							</small>
						</span>
					</label>

					<div className="settings-row">
						<button
							type="button"
							id="btn-save-style-lab"
							className="btn btn-primary"
							onClick={onSaveStyleLab}
						>
							保存作家仓库设置
						</button>
						<button
							type="button"
							id="btn-test-zhuque"
							className="btn btn-outline"
							onClick={onTestZhuque}
						>
							测试检测
						</button>
						<span id="zhuque-test-result" className="test-result" />
					</div>
				</section>
			</main>
		</>
	);
}

// 路由页范式（S4-2/S5-1 先例）：整容器接管 #page-settings，key=visit++ 每次进入重挂重拉
// （等值 app.js 每次 route() → renderSettings()）；容器缺失 no-op。
export function mount() {
	const el = document.getElementById("page-settings");
	if (!el) return;
	let root = el.__mozhenSettingsRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenSettingsRoot = root;
	}
	visit += 1;
	root.render(<SettingsPage key={visit} />);
}
