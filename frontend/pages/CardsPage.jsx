// S4-2（charter §3，范式 P 路由页型，S2-2 profile 先例）：CardsPage 组件——
// #/book/:id/cards 渲染委托给 React（app.js:148 经 window.MozhenCards.show(bookId)）。
// 逐字等值移植 public/legacy/cards.js（435 行）活代码：
// - JSX 镜像 index.html #page-cards 静态壳（topbar/三个 settings-card 区文案逐字）与
//   #card-editor 宽模态静态标记（双维护已知边界，阶段五随消费页一并清理，Plan §1 非目标）。
// - 数据层逐字移植 load/saveBindings/loadPreview，走 getApp().api；删除确认仍用
//   window.confirm；toast 走 getApp().toast（legacy 运行时依赖原样保留）。
// - 换卡 PUT bindings 形态（role/sortOrder）、生效链兜底提示、**标本 pack 域删除路由**
//   （DELETE packs/:packId/samples/:id——顶层 /samples/:id 被错题库「标本」路由遮蔽，
//   2026-09-19 修复，cards.js:307-309 注释）、collectForm 表单保全语义、profile 中文冒号
//   往返正则，全部逐字等值（红测 T-A A3/A4/A7/A8/A9 钉住）。
// - 行内元素用数组下标认领归属（旧 sampleRow 第二定义 :187-196；首个被遮蔽定义
//   :174-183 与 :17 死状态 dirty 不移植——Plan §1 非目标）。
// - 受控组件即旧 collectForm+bindFieldSync 的等价物：卡级字段与行内字段直接写 state，
//   「加一条规则/加一段范文」重渲天然不丢用户输入（A8），逐次同步语义同旧 input+change 双绑。
// - 每次 mount 以 key=visit++ 重挂重拉——等价旧 show(bookId) 每次进入都 await load()。

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";

// 指纹 textarea <-> 对象：一行一条「键: 值」，空行忽略（cards.js:155-167 逐字）。
// 明文格式而非 JSON——作者要手写这个，JSON 的括号引号只会碍事。
function profileToText(profile) {
	return Object.keys(profile || {})
		.map((k) => `${k}: ${profile[k]}`)
		.join("\n");
}
function textToProfile(text) {
	const out = {};
	String(text || "")
		.split("\n")
		.forEach((line) => {
			const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*(.+?)\s*$/);
			if (m) out[m[1]] = m[2];
		});
	return out;
}

// 分级标签＝「这条规则在提示词里怎么用」，不是「是否进正文额度」（cards.js:169-172 逐字）。
const SEV_LABEL = {
	must: "必守（全文注入）",
	normal: "常规（全文注入·按情境）",
	hint: "提示（全文注入·方向性）",
};

const RULE_DEFAULT = {
	id: null,
	category: "通用",
	title: "",
	trigger: "",
	rule: "",
	good: "",
	bad: "",
	severity: "normal",
	source: "手写",
};
const SAMPLE_DEFAULT = { id: null, title: "", text: "", source: "手写" };

export default function CardsPage({ bookId }) {
	const [packs, setPacks] = useState([]);
	const [bindings, setBindings] = useState({ main_id: null, aux_ids: [] });
	const [chain, setChain] = useState([]);
	const [effectiveSource, setEffectiveSource] = useState("none");
	const [editing, setEditing] = useState(null);
	const [editorMsg, setEditorMsg] = useState("");
	const [preview, setPreview] = useState(null);
	const [previewError, setPreviewError] = useState("");
	const [listLoaded, setListLoaded] = useState(false);

	async function loadPreview() {
		try {
			const res = await getApp().api(
				"GET",
				`/api/style-lab/packs-preview?book_id=${encodeURIComponent(bookId)}`,
			);
			setPreview(res);
		} catch (e) {
			setPreviewError(e.message);
		}
	}

	async function load() {
		try {
			const res = await getApp().api(
				"GET",
				`/api/style-lab/packs?book_id=${encodeURIComponent(bookId)}`,
			);
			const nextPacks = res.packs || [];
			setPacks(nextPacks);
			setBindings({
				main_id: res.bindings?.main ? res.bindings.main.id : null,
				aux_ids: res.bindings?.aux ? res.bindings.aux.map((p) => p.id) : [],
			});
			// 生效卡链取自服务端解析结果（含内置卡兜底），不是「绑定了什么」——
			// 两者不等价：没绑任何卡时生效的是内置通用卡，UI 必须显示真实生效的那张（cards.js:140-145）。
			const chainIds = res.effective?.chain_ids || [];
			setChain(
				chainIds
					.map((id) => nextPacks.find((p) => p.id === id))
					.filter(Boolean),
			);
			setEffectiveSource(res.effective ? res.effective.source : "none");
			setListLoaded(true);
		} catch (e) {
			getApp().toast(e.message);
		}
		loadPreview();
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重拉，等价旧 show() 每次 await load()
	useEffect(() => {
		load();
	}, [bookId]);

	async function saveBindings(mainId, auxIds) {
		try {
			const nextBindings = [];
			if (mainId)
				nextBindings.push({
					packId: Number(mainId),
					role: "main",
					sortOrder: 0,
				});
			(auxIds || []).forEach((id, i) => {
				nextBindings.push({ packId: Number(id), role: "aux", sortOrder: i });
			});
			await getApp().api("PUT", `/api/style-lab/books/${bookId}/cards`, {
				bindings: nextBindings,
			});
			getApp().toast("已换卡，下一轮对话生效");
			await load();
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	function toggleAux(id, checked) {
		const aux = bindings.aux_ids.slice();
		const i = aux.indexOf(id);
		if (checked && i === -1) aux.push(id);
		if (!checked && i !== -1) aux.splice(i, 1);
		saveBindings(bindings.main_id, aux);
	}

	async function openEditor(id) {
		try {
			const res = await getApp().api("GET", `/api/style-lab/packs/${id}`);
			setEditing({
				pack: res.pack,
				rules: res.rules || [],
				samples: res.samples || [],
				profileText: profileToText(res.pack.profile),
			});
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	function openNew() {
		setEditing({
			pack: {
				id: null,
				name: "",
				kind: "preset",
				persona: "",
				profile: {},
				enabled: true,
				builtin: false,
			},
			rules: [],
			samples: [],
			profileText: "",
		});
	}

	function patchPack(patch) {
		setEditing((c) => (c ? { ...c, pack: { ...c.pack, ...patch } } : c));
	}
	function patchRule(idx, field, value) {
		setEditing((c) => {
			if (!c) return c;
			const rules = c.rules.map((r, i) =>
				i === idx ? { ...r, [field]: value } : r,
			);
			return { ...c, rules };
		});
	}
	function patchSample(idx, field, value) {
		setEditing((c) => {
			if (!c) return c;
			const samples = c.samples.map((s, i) =>
				i === idx ? { ...s, [field]: value } : s,
			);
			return { ...c, samples };
		});
	}

	async function delRule(idx) {
		if (!editing) return;
		const target = editing.rules[idx];
		if (!target) return;
		if (!window.confirm("删除这条规则？")) return;
		try {
			// 已入库的先删服务端；新建未保存的直接从数组剔除（cards.js:288）
			if (target.id)
				await getApp().api("DELETE", `/api/style-lab/rules/${target.id}`);
			setEditing((c) => {
				if (!c) return c;
				const rules = c.rules.slice();
				rules.splice(idx, 1);
				return { ...c, rules };
			});
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	async function delSample(idx) {
		if (!editing) return;
		const target = editing.samples[idx];
		if (!target) return;
		if (!window.confirm("删除这段范文？")) return;
		try {
			// 必须走 pack 域路由：顶层 DELETE /samples/:id 被先注册的错题库「标本」路由遮蔽
			// （两张不同的表），走它会 404「标本不存在」甚至误删同 id 标本（2026-09-19 修复，
			// cards.js:307-309 注释逐字）。
			if (target.id)
				await getApp().api(
					"DELETE",
					`/api/style-lab/packs/${editing.pack.id}/samples/${target.id}`,
				);
			setEditing((c) => {
				if (!c) return c;
				const samples = c.samples.slice();
				samples.splice(idx, 1);
				return { ...c, samples };
			});
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	async function saveEditor() {
		if (!editing) return;
		const payload = {
			name: (editing.pack.name || "").trim(),
			persona: editing.pack.persona || "",
			profile: textToProfile(editing.profileText),
			enabled: editing.pack.enabled !== false,
		};
		if (!editing.pack.builtin) payload.kind = editing.pack.kind || "preset";
		if (!payload.name) {
			setEditorMsg("卡名必填");
			return;
		}
		try {
			let saved;
			if (editing.pack.id) {
				saved = (
					await getApp().api(
						"PUT",
						`/api/style-lab/packs/${editing.pack.id}`,
						payload,
					)
				).pack;
			} else {
				saved = (await getApp().api("POST", "/api/style-lab/packs", payload))
					.pack;
			}
			// 规则与范文：新建的行走 POST，已有的走 PUT（改动只提交一次）（cards.js:356-371）
			for (const r of editing.rules) {
				const body = {
					category: r.category,
					title: r.title,
					trigger: r.trigger,
					rule: r.rule,
					good: r.good,
					bad: r.bad,
					severity: r.severity,
					source: r.source,
				};
				if (r.id)
					await getApp().api("PUT", `/api/style-lab/rules/${r.id}`, body);
				else
					await getApp().api(
						"POST",
						`/api/style-lab/packs/${saved.id}/rules`,
						body,
					);
			}
			for (const s of editing.samples) {
				const sbody = { title: s.title, text: s.text, source: s.source };
				if (s.id)
					await getApp().api("PUT", `/api/style-lab/samples/${s.id}`, sbody);
				else
					await getApp().api(
						"POST",
						`/api/style-lab/packs/${saved.id}/samples`,
						sbody,
					);
			}
			getApp().toast("卡片已保存，下一轮对话生效");
			await load();
			openEditor(saved.id); // 重新拉一次，新建的规则/范文拿到 id
		} catch (e) {
			setEditorMsg(e.message);
		}
	}

	async function deleteEditor() {
		if (!editing?.pack.id) return;
		if (
			!window.confirm(
				`删除卡片「${editing.pack.name}」？\n\n卡片内的规则与范文一并删除，无法找回。已绑定这张卡的书会自动解绑。`,
			)
		)
			return;
		try {
			await getApp().api("DELETE", `/api/style-lab/packs/${editing.pack.id}`);
			setEditing(null);
			getApp().toast("卡片已删除");
			await load();
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	// ---------- 渲染（JSX 镜像 index.html:485-566 静态壳，文案逐字） ----------
	return (
		<>
			<header className="topbar">
				<div className="topbar-left">
					{/* 返回枢纽是个人中心（#/profile）：作家卡页的唯一入口已迁到那里（cards.js:430-431） */}
					<a id="cards-return" href="#/profile" className="btn btn-ghost">
						← 返回个人中心
					</a>
					<h1 className="book-title">作家卡</h1>
				</div>
				<nav className="topbar-actions">
					<button
						id="cards-new"
						className="btn btn-ghost"
						type="button"
						onClick={openNew}
					>
						新建卡
					</button>
				</nav>
			</header>
			<main className="settings-main">
				<section className="settings-card">
					<h3>本书用哪几张卡</h3>
					<p className="field-hint">
						{"一张"}
						<strong>主卡</strong>
						{"是这本书的风格本体（如「古龙武侠」），若干张"}
						<strong>辅卡</strong>
						{
							"是叠加的修正层（如「去 AI 味·通用」，任何主卡都能带上）。同名规则以主卡为准。改完"
						}
						<strong>下一轮对话立即生效</strong>
						{"，不需要重启。"}
					</p>
					<div id="cards-binding" className="cards-binding">
						{listLoaded ? (
							<>
								<div className="binding-row">
									<span className="binding-role">主卡</span>
									<select
										id="cards-main-select"
										value={bindings.main_id == null ? "" : bindings.main_id}
										onChange={(e) =>
											saveBindings(e.target.value, bindings.aux_ids)
										}
									>
										<option value="">（不指定，用内置通用卡）</option>
										{packs.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name}
												{p.builtin ? "（内置）" : ""}
											</option>
										))}
									</select>
								</div>
								<div className="binding-row">
									<span className="binding-role">辅卡</span>
									<div className="binding-aux">
										{packs
											.filter((p) => p.id !== bindings.main_id)
											.map((p) => {
												const on = bindings.aux_ids.indexOf(p.id) !== -1;
												return (
													<label
														key={p.id}
														className={`binding-chip${on ? " on" : ""}`}
													>
														<input
															type="checkbox"
															data-aux={p.id}
															checked={on}
															onChange={(e) =>
																toggleAux(p.id, e.target.checked)
															}
														/>
														{p.name}
													</label>
												);
											})}
									</div>
								</div>
								<p className="field-hint">
									{"当前生效："}
									<strong>
										{chain.length
											? chain.map((c) => c.name).join(" + ")
											: "无（风格层空转）"}
									</strong>
									{effectiveSource === "basic" && !bindings.main_id ? (
										<span className="field-hint">
											（本书未绑定主卡，自动用内置通用卡兜底；选了主卡就按你选的来）
										</span>
									) : null}
								</p>
							</>
						) : (
							"载入中…"
						)}
					</div>
				</section>

				<section className="settings-card">
					<h3>作家卡库</h3>
					<p className="field-hint">
						{
							"一张卡 = 人设（第一人称自述）+ 指纹（结构化短句）+ 规则条目 + 范文段落。点卡片查看与编辑。"
						}
					</p>
					<div id="cards-list" className="cards-list">
						{listLoaded && !packs.length ? (
							<p className="empty-hint">还没有卡片。点右上角「新建卡」开始。</p>
						) : null}
						{packs.map((p) => {
							const st = p.stats || {};
							const inChain = chain.some((c) => c.id === p.id);
							return (
								// biome-ignore lint/a11y/useKeyWithClickEvents: 等值旧版纯鼠标点击的 div.card-item（cards.js:106-108），不加键盘语义
								// biome-ignore lint/a11y/noStaticElementInteractions: 同上，div onclick 原样保留
								<div
									key={p.id}
									className={`card-item${inChain ? " in-chain" : ""}${p.enabled ? "" : " disabled"}`}
									data-id={p.id}
									onClick={() => openEditor(Number(p.id))}
								>
									<div className="card-item-head">
										<span className="card-name">{p.name}</span>
										{p.builtin ? <span className="card-tag">内置</span> : null}
										{p.kind === "imprint" ? (
											<span className="card-tag">印记</span>
										) : null}
										{inChain ? (
											<span className="card-tag on">生效中</span>
										) : null}
										{p.enabled ? null : (
											<span className="card-tag off">已停用</span>
										)}
									</div>
									<div className="card-item-meta">
										{`${st.rules || 0} 条规则（${st.must || 0} 必守）· ${st.samples || 0} 段范文${p.persona ? " · 有人设" : " · 无人设"}`}
									</div>
									<div className="card-item-note">
										{(p.note || "").slice(0, 80)}
									</div>
								</div>
							);
						})}
					</div>
				</section>

				<section className="settings-card">
					<h3>注入预览</h3>
					<p className="field-hint">
						这是本书此刻真正会送进系统提示词的内容。看不到注入结果，换卡就是盲改——所以这段必须与写作时一致。
					</p>
					<div id="cards-preview-meta" className="field-hint">
						{preview ? (
							<>
								{"来源："}
								<strong>{preview.source}</strong>
								{" · 卡链："}
								{preview.chain.length
									? preview.chain.map((c) => c.name).join(" + ")
									: "无"}
								{" · "}
								<strong>{preview.chars}</strong>
								{` 字符（${preview.hanzi} 汉字） / 预算 ${preview.budget_chars} · 规则 ${preview.rule_count} 条`}
								{preview.style_layer_enabled ? null : (
									<>
										{" · "}
										<strong className="warn">风格注入已全局关闭</strong>
									</>
								)}
							</>
						) : null}
					</div>
					<pre id="cards-preview" className="cards-preview">
						{previewError
							? `预览失败：${previewError}`
							: preview
								? preview.text || "（当前无卡生效，风格层不注入任何内容）"
								: "载入中…"}
					</pre>
				</section>
			</main>

			{/* 卡片编辑器（模态）——镜像 index.html:518-566 静态标记 */}
			<div id="card-editor" className={`modal-mask${editing ? "" : " hidden"}`}>
				<div className="modal modal-wide">
					<header className="modal-head">
						<h3 id="card-editor-title">
							{editing
								? editing.pack.id
									? `编辑：${editing.pack.name}`
									: "新建卡片"
								: "编辑卡片"}
						</h3>
						<button
							id="card-editor-close"
							className="btn btn-ghost"
							type="button"
							onClick={() => setEditing(null)}
						>
							关闭
						</button>
					</header>
					<div className="modal-body">
						<label className="field">
							<span>卡名</span>
							<input
								id="card-name"
								type="text"
								placeholder="如：古龙武侠 / 盐选快爽 / 我的作者印记"
								value={editing ? editing.pack.name || "" : ""}
								onChange={(e) => patchPack({ name: e.target.value })}
							/>
						</label>
						<label className="field">
							<span>卡类型</span>
							<select
								id="card-kind"
								value={editing ? editing.pack.kind || "preset" : "preset"}
								disabled={editing ? Boolean(editing.pack.builtin) : false}
								onChange={(e) => {
									if (editing && !editing.pack.builtin)
										patchPack({ kind: e.target.value });
								}}
							>
								<option value="preset">预设（手工编写）</option>
								<option value="imprint">作者印记（从样本蒸馏）</option>
								<option value="basic">基础（去 AI 味通用）</option>
							</select>
						</label>
						<label className="field">
							<span>
								人设{" "}
								<small>
									（第一人称自述：这位作者信奉什么、怕什么。写成一整段话，会原样注入）
								</small>
							</span>
							<textarea
								id="card-persona"
								rows={5}
								placeholder="你是一位……"
								value={editing ? editing.pack.persona || "" : ""}
								onChange={(e) => patchPack({ persona: e.target.value })}
							/>
						</label>
						<label className="field">
							<span>
								风格指纹{" "}
								<small>
									{
										"（每行一条「键: 值」，键可用 stance/sentence/diction/psychology/dialogue/narrative/warning）"
									}
								</small>
							</span>
							{/* 自由文本：失焦前不做对象转换（等值旧 DOM value 读写；
								逐字符解析写回会破坏半行输入，profileText 在保存时统一 textToProfile） */}
							<textarea
								id="card-profile"
								rows={6}
								placeholder="stance: 宁可少写一句，不要多写一句。"
								value={editing ? editing.profileText : ""}
								onChange={(e) =>
									setEditing((c) =>
										c ? { ...c, profileText: e.target.value } : c,
									)
								}
							/>
						</label>
						<label className="field field-inline">
							<input
								id="card-enabled"
								type="checkbox"
								checked={editing ? editing.pack.enabled !== false : false}
								onChange={(e) => patchPack({ enabled: e.target.checked })}
							/>
							<span>
								启用{" "}
								<small>
									（停用后即时从所有引用它的书里消失，不需要逐本解绑）
								</small>
							</span>
						</label>

						<h4 className="card-sub">
							规则条目{" "}
							<small>（must = 全文注入；normal/hint = 只进规则目录）</small>
						</h4>
						<div id="card-rules" className="card-rules">
							{editing?.rules.length ? (
								editing.rules.map((r, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 行归属按数组下标（旧 data-rule-idx 语义，cards.js:202），新建行 id=null 无稳定键
									<div key={i} className="rule-row" data-rule-idx={i}>
										<div className="rule-row-head">
											<input
												className="rule-cat"
												placeholder="分类"
												size={6}
												value={r.category || ""}
												onChange={(e) =>
													patchRule(i, "category", e.target.value)
												}
											/>
											<input
												className="rule-title"
												placeholder="标题"
												value={r.title || ""}
												onChange={(e) => patchRule(i, "title", e.target.value)}
											/>
											<select
												className="rule-sev"
												value={r.severity}
												onChange={(e) =>
													patchRule(i, "severity", e.target.value)
												}
											>
												{["must", "normal", "hint"].map((s) => (
													<option key={s} value={s}>
														{SEV_LABEL[s]}
													</option>
												))}
											</select>
											<button
												className="btn btn-small btn-ghost"
												data-del-rule="1"
												type="button"
												onClick={() => delRule(i)}
											>
												删除
											</button>
										</div>
										<input
											className="rule-trigger"
											placeholder="触发词（用 | 分隔，如：悲伤|愤怒）"
											value={r.trigger || ""}
											onChange={(e) => patchRule(i, "trigger", e.target.value)}
										/>
										<textarea
											className="rule-text"
											rows={3}
											placeholder="规则正文"
											value={r.rule || ""}
											onChange={(e) => patchRule(i, "rule", e.target.value)}
										/>
										<div className="rule-examples">
											<input
												value={r.bad || ""}
												placeholder="✗ 反面例（可选）"
												onChange={(e) => patchRule(i, "bad", e.target.value)}
											/>
											<input
												value={r.good || ""}
												placeholder="✓ 正面例（可选）"
												onChange={(e) => patchRule(i, "good", e.target.value)}
											/>
										</div>
										<input
											className="rule-src-input"
											placeholder="出处（便于日后追溯）"
											value={r.source || ""}
											onChange={(e) => patchRule(i, "source", e.target.value)}
										/>
									</div>
								))
							) : editing ? (
								<p className="empty-hint">还没有规则条目。</p>
							) : null}
						</div>
						<button
							id="card-add-rule"
							className="btn btn-small btn-outline"
							type="button"
							onClick={() =>
								setEditing((c) =>
									c ? { ...c, rules: [...c.rules, { ...RULE_DEFAULT }] } : c,
								)
							}
						>
							+ 加一条规则
						</button>

						<h4 className="card-sub">
							范文段落 <small>（学习语感用；有语料才注入，整段进整段出）</small>
						</h4>
						<div id="card-samples" className="card-samples">
							{editing?.samples.length ? (
								editing.samples.map((s, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 行归属按数组下标（旧 data-sample-idx 语义，cards.js:187-196），新建行 id=null 无稳定键
									<div key={i} className="rule-row" data-sample-idx={i}>
										<div className="rule-row-head">
											<input
												className="rule-title"
												value={s.title || ""}
												placeholder="段名（可空）"
												onChange={(e) =>
													patchSample(i, "title", e.target.value)
												}
											/>
											<span className="rule-src">
												{`${s.charCount || 0} 字${s.indexed ? " · 已索引" : ""}`}
											</span>
											<button
												className="btn btn-small btn-ghost"
												data-del-sample="1"
												type="button"
												onClick={() => delSample(i)}
											>
												删除
											</button>
										</div>
										<textarea
											className="rule-text"
											rows={4}
											placeholder="粘贴一段该风格的正文样本"
											value={s.text || ""}
											onChange={(e) => patchSample(i, "text", e.target.value)}
										/>
									</div>
								))
							) : editing ? (
								<p className="empty-hint">
									还没有范文段落。（范文可选：有语料才注入）
								</p>
							) : null}
						</div>
						<button
							id="card-add-sample"
							className="btn btn-small btn-outline"
							type="button"
							onClick={() =>
								setEditing((c) =>
									c
										? { ...c, samples: [...c.samples, { ...SAMPLE_DEFAULT }] }
										: c,
								)
							}
						>
							+ 加一段范文
						</button>

						<p className="field-hint" id="card-vector-hint">
							{
								"向量检索接口已预留（style_samples.vector / vector_model / indexed_at 三列已建）：将来把整部作品灌进卡里，可按当前章节检索最相似的段落作为范文。当前未接线，按顺序直出。"
							}
						</p>
					</div>
					<footer className="modal-foot">
						<button
							id="card-save"
							className="btn btn-primary"
							type="button"
							onClick={saveEditor}
						>
							保存卡片
						</button>
						<button
							id="card-delete"
							className="btn btn-ghost"
							type="button"
							style={{ display: editing?.pack.builtin ? "none" : "" }}
							onClick={deleteEditor}
						>
							删除卡片
						</button>
						<span id="card-editor-msg" className="test-result">
							{editorMsg}
						</span>
					</footer>
				</div>
			</div>
		</>
	);
}

// ---------- 挂载（app.js:148 经 window.MozhenCards.show(bookId) 委托至此） ----------
// 目标 #page-cards；取不到即返回（安全 no-op）。root 首次创建后复用（缓存 el.__mozhenCardsRoot），
// 每次 mount 以 key=visit++ 重挂——等价旧 show(bookId) 每次重拉。
let visit = 0;

export function mount(newBookId) {
	const el = document.getElementById("page-cards");
	if (!el) return;
	let root = el.__mozhenCardsRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenCardsRoot = root;
	}
	root.render(<CardsPage key={visit++} bookId={newBookId} />);
}
