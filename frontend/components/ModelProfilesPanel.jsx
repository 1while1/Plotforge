// BYOK 服务商面板（设置页「模型接口」卡内）：替代旧「渠道 + Base URL + API Key + 模型」四件套。
// 数据面＝/api/settings/model-profiles 五个动作；Key 只落服务端库，接口返回的 Profile 已脱敏，
// 本面板永远只显示掩码。挂载后一次性把旧 localStorage['channel_keys'] 里的浏览器明文 Key 迁进服务端，
// 全部成功才删除该键（失败保留，下次进设置页重试）。
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getApp } from "../lib/app-runtime.js";

const LIST_PATH = "/api/settings/model-profiles";
const LEGACY_KEY = "channel_keys";
// 免费渠道历史上就不存 Key（匿名可用），不参与迁移
const MIGRATE_IDS = ["paid", "agnes", "stepfun"];

const EMPTY_FORM = {
	name: "",
	base_url: "",
	api_key: "",
	models: "",
	context_window: "",
};

function app() {
	return getApp();
}

function parseModels(text) {
	return String(text || "")
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function keyStatus(p) {
	if (p.key_optional && !p.api_key_set) return "无需 Key";
	if (p.api_key_set) return `Key 已配置 ${p.api_key_masked}`;
	return "Key 未配置";
}

// 读旧键：坏 JSON/非对象一律视为「无 Key 可迁」（解析不了就不猜，直接走清理分支）
function legacyKeys(raw) {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch (_e) {
		return null;
	}
}

export default function ModelProfilesPanel({ onActivated }) {
	const [profiles, setProfiles] = useState([]);
	const [activeProfileId, setActiveProfileId] = useState(null);
	const [activeModel, setActiveModel] = useState("");
	const [busy, setBusy] = useState(false);
	const [showAdd, setShowAdd] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);
	const [editId, setEditId] = useState(null);
	const [editForm, setEditForm] = useState(EMPTY_FORM);
	const [addModelText, setAddModelText] = useState({});

	// 每个写动作的返回值都是完整列表载荷：以响应为准整体替换本地态，不做增量猜测
	const apply = useCallback((data) => {
		if (!data || typeof data !== "object") return;
		if (Array.isArray(data.profiles)) setProfiles(data.profiles);
		if ("active_profile_id" in data)
			setActiveProfileId(data.active_profile_id || null);
		if ("active_model" in data) setActiveModel(data.active_model || "");
	}, []);

	// 旧浏览器明文 Key 的一次性迁移：只迁内置 id（free 匿名无需 Key），已配置的跳过；
	// 全部成功（或本就无事可做）才删 channel_keys，任一失败保留待下次重试。
	const migrateLegacy = useCallback(
		async (list) => {
			let raw = null;
			try {
				raw = localStorage.getItem(LEGACY_KEY);
			} catch (_e) {
				return;
			}
			if (!raw) return;
			const stored = legacyKeys(raw) || {};
			const todo = list.filter(
				(p) =>
					MIGRATE_IDS.includes(p.id) &&
					!p.api_key_set &&
					typeof stored[p.id] === "string" &&
					stored[p.id].trim() !== "",
			);
			try {
				for (const p of todo) {
					apply(
						await app().api("PUT", `${LIST_PATH}/${encodeURIComponent(p.id)}`, {
							api_key: stored[p.id],
						}),
					);
				}
				localStorage.removeItem(LEGACY_KEY);
			} catch (_e) {
				// 迁移失败保留 channel_keys：下次进设置页再试，不打扰用户
			}
		},
		[apply],
	);

	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				const data = await app().api("GET", LIST_PATH);
				if (!alive) return;
				apply(data);
				await migrateLegacy(data.profiles || []);
			} catch (e) {
				if (alive) app().toast(e.message);
			}
		})();
		return () => {
			alive = false;
		};
	}, [apply, migrateLegacy]);

	async function run(fn) {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			app().toast(e.message);
		} finally {
			setBusy(false);
		}
	}

	async function onActivate(p, model) {
		await run(async () => {
			apply(
				await app().api(
					"POST",
					`${LIST_PATH}/${encodeURIComponent(p.id)}/activate`,
					{ model },
				),
			);
			app().toast(`已切换到 ${p.name} · ${model}`);
			onActivated?.();
		});
	}

	async function onAddModel(p) {
		const name = (addModelText[p.id] || "").trim();
		if (!name) return;
		if (p.models.includes(name)) {
			app().toast("模型已存在");
			return;
		}
		await run(async () => {
			apply(
				await app().api("PUT", `${LIST_PATH}/${encodeURIComponent(p.id)}`, {
					models: [...p.models, name],
				}),
			);
			setAddModelText((m) => ({ ...m, [p.id]: "" }));
		});
	}

	async function onRemoveModel(p, model) {
		await run(async () => {
			apply(
				await app().api("PUT", `${LIST_PATH}/${encodeURIComponent(p.id)}`, {
					models: p.models.filter((m) => m !== model),
				}),
			);
		});
	}

	async function onAddSubmit() {
		const payload = {
			name: form.name.trim(),
			base_url: form.base_url.trim(),
			models: parseModels(form.models),
		};
		const key = form.api_key.trim();
		if (key) payload.api_key = key;
		const ctx = form.context_window.trim();
		if (ctx) payload.context_window = ctx;
		await run(async () => {
			apply(await app().api("POST", LIST_PATH, payload));
			setShowAdd(false);
			setForm(EMPTY_FORM);
			app().toast(`已添加服务商「${payload.name}」`);
		});
	}

	async function onEditSave(p) {
		const payload = {};
		if (!p.builtin) {
			const name = editForm.name.trim();
			const base = editForm.base_url.trim();
			if (name && name !== p.name) payload.name = name;
			if (base && base !== p.base_url) payload.base_url = base;
		}
		const key = editForm.api_key.trim();
		if (key) payload.api_key = key;
		payload.context_window = String(editForm.context_window || "").trim();
		await run(async () => {
			apply(
				await app().api(
					"PUT",
					`${LIST_PATH}/${encodeURIComponent(p.id)}`,
					payload,
				),
			);
			setEditId(null);
			app().toast("已保存");
			if (p.id === activeProfileId) onActivated?.();
		});
	}

	async function onClearKey(p) {
		await run(async () => {
			apply(
				await app().api("PUT", `${LIST_PATH}/${encodeURIComponent(p.id)}`, {
					api_key: "",
					clear_api_key: true,
				}),
			);
			setEditId(null);
			app().toast("已保存");
			if (p.id === activeProfileId) onActivated?.();
		});
	}

	async function onDelete(p) {
		if (!window.confirm(`删除服务商「${p.name}」？`)) return;
		await run(async () => {
			apply(
				await app().api("DELETE", `${LIST_PATH}/${encodeURIComponent(p.id)}`),
			);
			app().toast("已删除");
		});
	}

	function openEdit(p) {
		setEditId(p.id);
		setEditForm({
			name: p.name,
			base_url: p.base_url,
			api_key: "",
			context_window: p.context_window || "",
		});
	}

	return (
		<div id="model-profiles" className="model-profiles">
			<div className="mp-head">
				<div className="mp-head-text">
					<span className="mp-label">服务商（BYOK）</span>
					<small className="mp-hint">
						点模型名即切换；Key 只存在本机服务端，页面只显示掩码
					</small>
				</div>
				<button
					id="btn-add-profile"
					type="button"
					className="btn btn-small btn-outline"
					disabled={busy}
					onClick={() => {
						setShowAdd((v) => !v);
						setForm(EMPTY_FORM);
					}}
				>
					<Plus />
					添加服务商
				</button>
			</div>

			{showAdd && (
				<form
					className="mp-form"
					onSubmit={(e) => {
						e.preventDefault();
						onAddSubmit();
					}}
				>
					<label className="field">
						<span>名称</span>
						<input
							className="mp-add-name"
							type="text"
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>Base URL</span>
						<input
							className="mp-add-base-url"
							type="text"
							placeholder="https://example.com/v1"
							value={form.base_url}
							onChange={(e) => setForm({ ...form, base_url: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>API Key</span>
						<input
							className="mp-add-api-key"
							type="password"
							value={form.api_key}
							onChange={(e) => setForm({ ...form, api_key: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>模型（每行一个，或用逗号分隔）</span>
						<textarea
							className="mp-add-models"
							rows={3}
							value={form.models}
							onChange={(e) => setForm({ ...form, models: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>上下文窗口（可选，例如 200000）</span>
						<input
							className="mp-add-context"
							type="number"
							min="8000"
							step="1000"
							value={form.context_window}
							onChange={(e) =>
								setForm({ ...form, context_window: e.target.value })
							}
						/>
					</label>
					<div className="mp-form-actions">
						<button
							type="submit"
							className="btn btn-small btn-primary mp-add-save"
							disabled={busy}
						>
							保存
						</button>
						<button
							type="button"
							className="btn btn-small btn-ghost mp-add-cancel"
							onClick={() => {
								setShowAdd(false);
								setForm(EMPTY_FORM);
							}}
						>
							取消
						</button>
					</div>
				</form>
			)}

			<ul className="mp-list">
				{profiles.map((p) => {
					const active = p.id === activeProfileId;
					return (
						<li
							key={p.id}
							className={active ? "mp-item active" : "mp-item"}
							data-profile-id={p.id}
						>
							<div className="mp-item-head">
								<span className="mp-name">{p.name}</span>
								{p.builtin && <span className="mp-badge">内置</span>}
								{active && <span className="mp-badge mp-badge-on">使用中</span>}
								<div className="mp-actions">
									<button
										type="button"
										className="btn btn-small btn-ghost mp-edit"
										disabled={busy}
										onClick={() => openEdit(p)}
									>
										<Pencil />
										编辑
									</button>
									{!p.builtin && !active && (
										<button
											type="button"
											className="btn btn-small btn-ghost mp-delete"
											disabled={busy}
											onClick={() => onDelete(p)}
										>
											<Trash2 />
											删除
										</button>
									)}
								</div>
							</div>

							{editId === p.id && (
								<div className="mp-form">
									{!p.builtin && (
										<label className="field">
											<span>名称</span>
											<input
												className="mp-edit-name"
												type="text"
												value={editForm.name}
												onChange={(e) =>
													setEditForm({ ...editForm, name: e.target.value })
												}
											/>
										</label>
									)}
									{!p.builtin && (
										<label className="field">
											<span>Base URL</span>
											<input
												className="mp-edit-base-url"
												type="text"
												value={editForm.base_url}
												onChange={(e) =>
													setEditForm({
														...editForm,
														base_url: e.target.value,
													})
												}
											/>
										</label>
									)}
									<label className="field">
										<span>API Key</span>
										<input
											className="mp-edit-api-key"
											type="password"
											value={editForm.api_key}
											placeholder={
												p.api_key_set
													? `已配置 ${p.api_key_masked}，留空则保持不变`
													: "未配置，粘贴 API Key"
											}
											onChange={(e) =>
												setEditForm({ ...editForm, api_key: e.target.value })
											}
										/>
									</label>
									<label className="field">
										<span>上下文窗口（可选）</span>
										<input
											className="mp-edit-context"
											type="number"
											min="8000"
											step="1000"
											value={editForm.context_window}
											onChange={(e) =>
												setEditForm({
													...editForm,
													context_window: e.target.value,
												})
											}
										/>
									</label>
									<div className="mp-form-actions">
										<button
											type="button"
											className="btn btn-small btn-primary mp-edit-save"
											disabled={busy}
											onClick={() => onEditSave(p)}
										>
											保存
										</button>
										<button
											type="button"
											className="btn btn-small btn-ghost mp-edit-cancel"
											onClick={() => setEditId(null)}
										>
											取消
										</button>
										{p.api_key_set && (
											<button
												type="button"
												className="btn btn-small btn-ghost mp-clear-key"
												disabled={busy}
												onClick={() => onClearKey(p)}
											>
												清除 Key
											</button>
										)}
									</div>
								</div>
							)}

							<div className="mp-meta">
								{p.base_url} · {keyStatus(p)}
								{p.context_window ? ` · 上下文 ${p.context_window}` : ""}
							</div>

							<div className="mp-chips">
								{p.models.map((m) => {
									const on = active && m === activeModel;
									return (
										<span
											key={m}
											className={on ? "mp-chip-group on" : "mp-chip-group"}
										>
											<button
												type="button"
												className={on ? "mp-chip on" : "mp-chip"}
												title="切换到此模型"
												disabled={busy}
												onClick={() => onActivate(p, m)}
											>
												{m}
											</button>
											{p.models.length > 1 && !on && (
												<button
													type="button"
													className="mp-chip-x"
													aria-label={`删除模型 ${m}`}
													disabled={busy}
													onClick={() => onRemoveModel(p, m)}
												>
													<X />
												</button>
											)}
										</span>
									);
								})}
								<input
									className="mp-add-model"
									type="text"
									placeholder="添加模型名"
									value={addModelText[p.id] || ""}
									onChange={(e) =>
										setAddModelText((m) => ({ ...m, [p.id]: e.target.value }))
									}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											onAddModel(p);
										}
									}}
								/>
								<button
									type="button"
									className="btn btn-small btn-ghost mp-add-model-btn"
									disabled={busy}
									onClick={() => onAddModel(p)}
								>
									添加
								</button>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
