// S4-3（charter §3，范式 P 路由页型＋组件吸收）：CharacterTimelinePanel——人物时间线迁 React。
// 逐字等值移植 public/legacy/character-timeline.js（451 行）活代码：
// - 双模式：mode="embedded"（工作台时间线 tab 由 CharacterWorkbenchPanel 直接组合本组件）与
//   mode="full"（独立路由 #/book/:id/characters/:cid/timeline 经 window.MozhenCharacterTimeline
//   桥的 showFullPage → mountTimelineFullPage 挂载，app.js:137 单行替换）。
//   ⤢ 放大按钮仅 embedded 渲染（源码 :169-170——Plan §4 B13 正文笔误，Architect 裁决按源码，
//   台账 §S4-3 备案）。
// - 纯函数导出供直测：groupEventsByVolume / findLatestVolumeKey / formatValue / parseValue /
//   isRelevantChange（isRelevantChange 的 ctx.person.id 与 parseValue 的 el.value 显式参数化，
//   语义逐字等值）。
// - 原文依据三段定位（逐字命中→前 12 字头命中→paragraph_index 段落兜底→全章）与四个 toast 逐字；
//   修正 old_value 携带规则（编辑恒带、新建仅提供了旧值才带——避免与当前投影冲突报 409）；
//   字段值类型分型（enum/level 下拉、list 顿号、text 输入）。
// - 弹窗继续走 getApp().openModal（bodyHTML 字符串契约，legacy 运行时依赖原样保留，advisor 先例）；
//   事件变化行沿用旧版 openModal 返回后的命令式接线（addChangeRow 直接操作 #ev-changes DOM）。
// - 卷折叠 aria-expanded 由受控 state 管理（collapsedMap），等值旧 DOM class 直接切换语义；
//   每次重挂（桥 key=visit++／工作台 tab 重入）重新拉取并重置折叠态——等值旧 loadAndRender 全量重渲。

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";

const IMPORTANCE_LABEL = {
	low: "低",
	normal: "普通",
	high: "高",
	critical: "关键",
};
const ORIGIN_LABEL = {
	manual: "手动",
	proposal: "提案",
	advisor: "顾问",
	import: "导入",
};
const POLARITY_LABEL = {
	positive: "正向",
	neutral: "中性",
	negative: "负向",
	mixed: "复杂",
};
const LIFECYCLE_LABEL = { active: "活跃", dormant: "潜伏", ended: "结束" };

function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

// 值格式化：null/空→未记录；数组→顿号连接；对象→JSON；其余→字符串（:27-35 逐字）
export function formatValue(_valueType, value) {
	if (value === null || value === undefined || value === "") return "未记录";
	if (Array.isArray(value)) {
		if (!value.length) return "未记录";
		return value
			.map((v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v)))
			.join("、");
	}
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

// 一条变化是否与当前人物相关：状态变化看 subject_ref；关系变化看快照端点（:38-49 逐字，
// personId 显式参数化等值旧 ctx.person.id）
export function isRelevantChange(change, personId) {
	if (!change) return false;
	if (change.change_kind === "character_state")
		return String(change.subject_ref) === String(personId);
	if (change.change_kind === "relation") {
		const vals = [change.new_value, change.old_value];
		for (const v of vals) {
			if (
				v &&
				(Number(v.endpoint_a) === Number(personId) ||
					Number(v.endpoint_b) === Number(personId))
			) {
				return true;
			}
		}
	}
	return false;
}

// 按分卷分组（events 已是后端修正后的时序：卷序→卷内章序→id）；无卷/孤儿卷归入「未分卷」
//（:112-131 逐字）
export function groupEventsByVolume(events) {
	const groups = [];
	const byKey = {};
	(events || []).forEach((ev) => {
		const hasVol =
			ev.volume_id !== null && ev.volume_id !== undefined && ev.volume_title;
		const key = hasVol ? `v${ev.volume_id}` : "none";
		if (!byKey[key]) {
			const vs = ev.volume_sort_order;
			byKey[key] = {
				key: key,
				volumeId: hasVol ? ev.volume_id : null,
				volumeTitle: hasVol ? ev.volume_title : "未分卷",
				volumeSortOrder: hasVol
					? vs === null || vs === undefined
						? 0
						: Number(vs)
					: Number.MAX_SAFE_INTEGER,
				events: [],
			};
			groups.push(byKey[key]);
		}
		byKey[key].events.push(ev);
	});
	return groups;
}

// 最新卷 = 真实分卷中 volume_sort_order 最大者；若无真实分卷则取第一组（:134-141 逐字）
export function findLatestVolumeKey(groups) {
	let latestKey = null;
	let latestSort = -Infinity;
	groups.forEach((g) => {
		if (g.volumeId !== null && g.volumeSortOrder > latestSort) {
			latestSort = g.volumeSortOrder;
			latestKey = g.key;
		}
	});
	if (latestKey === null && groups.length) latestKey = groups[0].key;
	return latestKey;
}

// 值解析：空串→null；list 按 [、,，] 切＋去空（:345-354 逐字，el.value 显式参数化）
export function parseValue(valueType, raw) {
	const text = raw == null ? "" : String(raw).trim();
	if (text === "") return null;
	if (valueType === "list") {
		const arr = text
			.split(/[、,，]/)
			.map((s) => s.trim())
			.filter(Boolean);
		return arr.length ? arr : null;
	}
	return text;
}

export function TimelinePanel({ mode, route, person }) {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [data, setData] = useState(null);
	const [collapsedMap, setCollapsedMap] = useState({});

	function api(method, path, body) {
		return getApp().api(
			method,
			`/api/books/${encodeURIComponent(route.bookId)}${path}`,
			body,
		);
	}
	function toast(msg) {
		getApp().toast(msg);
	}
	function relationsHash() {
		return `#/book/${route.bookId}/workbench/characters/${person.id}?tab=relations`;
	}
	function proposalsHash() {
		return `#/book/${route.bookId}/workbench/ledger?tab=proposals`;
	}
	function fullPageHash() {
		return `#/book/${route.bookId}/characters/${person.id}/timeline`;
	}
	function fieldDef(fieldKey) {
		return data?.fieldByKey[fieldKey] || null;
	}
	function fieldLabel(fieldKey) {
		const d = fieldDef(fieldKey);
		return d ? d.label : fieldKey;
	}
	function fieldValueType(fieldKey) {
		const d = fieldDef(fieldKey);
		return d ? d.value_type : "text";
	}
	function currentStateValue(fieldKey) {
		const s = data ? data.stateByKey[fieldKey] : null;
		return s ? s.value : null;
	}

	// 旧 loadAndRender（:180-203）：四连 GET → 填充 ctx → 渲染工作区；失败渲染 .workbench-error。
	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++／tab 重挂即重拉，等值旧 show/showFullPage 每次 loadAndRender
	useEffect(() => {
		let alive = true;
		(async () => {
			setLoading(true);
			try {
				const results = await Promise.all([
					api("GET", `/ledger/events?character_id=${person.id}&limit=200`),
					api("GET", `/characters/${person.id}/states`),
					api("GET", "/state-fields"),
					api("GET", "/ledger/proposals?status=pending"),
				]);
				if (!alive) return;
				const events = results[0].items || [];
				const states = results[1].items || [];
				const fieldDefs = (results[2].items || []).filter(
					(f) => f.enabled !== 0,
				);
				const pending = results[3].items || [];
				const fieldByKey = {};
				const stateByKey = {};
				fieldDefs.forEach((f) => {
					fieldByKey[f.field_key] = f;
				});
				states.forEach((s) => {
					stateByKey[s.field_key] = s;
				});
				const groups = groupEventsByVolume(events);
				const latestKey = findLatestVolumeKey(groups);
				const collapsed = {};
				groups.forEach((g) => {
					collapsed[g.key] = g.key !== latestKey; // 最新卷默认展开、其余 collapsed（:143-153）
				});
				setData({
					eventList: events,
					stateList: states,
					fieldDefs,
					fieldByKey,
					stateByKey,
					pendingList: pending,
				});
				setCollapsedMap(collapsed);
				setError(null);
			} catch (e) {
				if (alive) setError(e);
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	// 依当前模式重新渲染（新增/编辑事件后刷新用，:206-214）：组件重拉等值 loadAndRender 全量重渲
	async function refresh() {
		setLoading(true);
		try {
			const results = await Promise.all([
				api("GET", `/ledger/events?character_id=${person.id}&limit=200`),
				api("GET", `/characters/${person.id}/states`),
				api("GET", "/state-fields"),
				api("GET", "/ledger/proposals?status=pending"),
			]);
			const events = results[0].items || [];
			const states = results[1].items || [];
			const fieldDefs = (results[2].items || []).filter((f) => f.enabled !== 0);
			const pending = results[3].items || [];
			const fieldByKey = {};
			const stateByKey = {};
			fieldDefs.forEach((f) => {
				fieldByKey[f.field_key] = f;
			});
			states.forEach((s) => {
				stateByKey[s.field_key] = s;
			});
			const groups = groupEventsByVolume(events);
			const latestKey = findLatestVolumeKey(groups);
			const collapsed = {};
			groups.forEach((g) => {
				collapsed[g.key] = g.key !== latestKey;
			});
			setData({
				eventList: events,
				stateList: states,
				fieldDefs,
				fieldByKey,
				stateByKey,
				pendingList: pending,
			});
			setCollapsedMap(collapsed);
			setError(null);
		} catch (e) {
			setError(e);
		} finally {
			setLoading(false);
		}
	}

	// ---------- D. 原文依据悬浮高亮（:244-286 逐字） ----------
	async function openSourcePreview(event) {
		if (!event) return;
		if (!event.chapter_id) {
			toast("该事件未绑定章节，无法定位原文");
			return;
		}
		if (!event.source_quote) {
			toast("该事件没有原文依据");
			return;
		}
		try {
			const res = await api("GET", `/chapters/${event.chapter_id}`);
			const chapter = res.chapter || {};
			const content = chapter.content || "";
			if (!content) {
				toast("该章节暂无正文");
				return;
			}
			const quote = String(event.source_quote);
			let idx = content.indexOf(quote);
			let located = idx >= 0;
			let matchLen = quote.length;
			if (!located && quote.length > 12) {
				const head = quote.slice(0, 12);
				const hi = content.indexOf(head);
				if (hi >= 0) {
					located = true;
					idx = hi;
					matchLen = head.length;
				}
			}
			let html;
			if (located) {
				html =
					esc(content.slice(0, idx)) +
					'<mark class="source-highlight">' +
					esc(content.slice(idx, idx + matchLen)) +
					"</mark>" +
					esc(content.slice(idx + matchLen));
			} else if (
				event.paragraph_index !== null &&
				event.paragraph_index !== undefined
			) {
				const paras = content.split("\n");
				const pi = Math.max(
					0,
					Math.min(paras.length - 1, Number(event.paragraph_index) || 0),
				);
				html =
					esc(paras.slice(0, pi).join("\n")) +
					'<mark class="source-highlight">' +
					esc(paras[pi] || "") +
					"</mark>" +
					esc(paras.slice(pi + 1).join("\n"));
				toast(`未能精确匹配原句，已定位到第 ${pi + 1} 段`);
			} else {
				html = esc(content);
				toast("未能精确定位，已显示全章");
			}
			html = html.replace(/\n/g, "<br>");
			getApp().openModal({
				title: `原文依据 · ${chapter.title || event.chapter_title || ""}`,
				okText: "关闭",
				bodyHTML: `<div class="chapter-preview"><div class="chapter-preview-content">${html}</div></div>`,
				onOk: () => true,
			});
			setTimeout(() => {
				const mark = document.querySelector("#modal-body .source-highlight");
				if (mark?.scrollIntoView) mark.scrollIntoView({ block: "center" });
			}, 40);
		} catch (e) {
			toast(e.message);
		}
	}

	// ---------- E. 手动新增/编辑事件（:288-450 逐字，弹窗 body 走 bodyHTML 字符串契约） ----------
	function valueFieldHTML(which, valueType, options, value) {
		const cls = `ev-${which}`;
		const hasOptions = Array.isArray(options) && options.length > 0;
		if ((valueType === "enum" || valueType === "level") && hasOptions) {
			const opts =
				'<option value=""></option>' +
				options
					.map((o) => {
						const ov =
							o && typeof o === "object"
								? o.value !== undefined
									? o.value
									: o.label
								: o;
						const ol =
							o && typeof o === "object"
								? o.label !== undefined
									? o.label
									: o.value
								: o;
						return `<option value="${esc(ov)}"${value != null && String(value) === String(ov) ? " selected" : ""}>${esc(ol)}</option>`;
					})
					.join("");
			return `<select class="${cls}">${opts}</select>`;
		}
		if (valueType === "list") {
			const lv = Array.isArray(value)
				? value.join("、")
				: value == null
					? ""
					: String(value);
			return `<input class="${cls}" placeholder="多个值用、分隔" value="${esc(lv)}">`;
		}
		const tv =
			value == null
				? ""
				: typeof value === "object"
					? JSON.stringify(value)
					: String(value);
		return `<input class="${cls}" value="${esc(tv)}">`;
	}

	function addChangeRow(container, change) {
		if (!data.fieldDefs.length) {
			container.innerHTML =
				'<div class="muted">本书还没有启用的状态字段，无法记录状态变化。</div>';
			return;
		}
		const row = document.createElement("div");
		row.className = "ev-change-row";
		let selectedKey = change ? change.field_key : data.fieldDefs[0].field_key;
		if (!data.fieldByKey[selectedKey])
			selectedKey = data.fieldDefs[0].field_key;
		const fieldOptions = data.fieldDefs
			.map(
				(f) =>
					`<option value="${esc(f.field_key)}"${f.field_key === selectedKey ? " selected" : ""}>${esc(f.label)}</option>`,
			)
			.join("");
		const def = data.fieldByKey[selectedKey];
		const vt = def ? def.value_type : "text";
		const opts = def ? def.options : [];
		const oldVal = change ? change.old_value : currentStateValue(selectedKey);
		const newVal = change ? change.new_value : null;
		row.innerHTML =
			`<select class="ev-field">${fieldOptions}</select>` +
			'<div class="ev-value-pair">' +
			`<span class="ev-value-cell ev-old-cell">${valueFieldHTML("old", vt, opts, oldVal)}</span>` +
			'<span class="ev-arrow">→</span>' +
			`<span class="ev-value-cell ev-new-cell">${valueFieldHTML("new", vt, opts, newVal)}</span>` +
			"</div>" +
			'<button type="button" class="ev-remove" title="删除此行">×</button>';
		container.appendChild(row);
		// 字段切换：旧值重置为当前态、新值清空（:331-338）
		row.querySelector(".ev-field").onchange = () => {
			const key = row.querySelector(".ev-field").value;
			const d = data.fieldByKey[key];
			const t = d ? d.value_type : "text";
			const o = d ? d.options : [];
			row.querySelector(".ev-old-cell").innerHTML = valueFieldHTML(
				"old",
				t,
				o,
				currentStateValue(key),
			);
			row.querySelector(".ev-new-cell").innerHTML = valueFieldHTML(
				"new",
				t,
				o,
				null,
			);
		};
		// 行删除：空则自动补一行（:339-342）
		row.querySelector(".ev-remove").onclick = () => {
			row.remove();
			if (!container.querySelectorAll(".ev-change-row").length)
				addChangeRow(container, null);
		};
	}

	function collectChanges(container) {
		const out = [];
		container.querySelectorAll(".ev-change-row").forEach((row) => {
			const fieldSel = row.querySelector(".ev-field");
			const fieldKey = fieldSel ? fieldSel.value : "";
			if (!fieldKey) return;
			const vt = fieldValueType(fieldKey);
			const oldEl = row.querySelector(".ev-old");
			const newEl = row.querySelector(".ev-new");
			out.push({
				change_kind: "character_state",
				subject_ref: String(person.id),
				field_key: fieldKey,
				old_value: parseValue(vt, oldEl ? oldEl.value : null),
				new_value: parseValue(vt, newEl ? newEl.value : null),
			});
		});
		return out;
	}

	async function submitEventModal(modalBody, event, relationChanges) {
		const isEdit = !!event;
		const title = modalBody.querySelector("#ev-title").value.trim();
		if (!title) {
			toast("请填写事件标题");
			return false;
		}
		const container = modalBody.querySelector("#ev-changes");
		const stateChanges = collectChanges(container);
		// 关系变化原样透传（含 metadata，:380-382）
		const carriedRelations = (relationChanges || []).map((c) => ({
			change_kind: "relation",
			subject_ref: c.subject_ref,
			field_key: c.field_key,
			old_value: c.old_value,
			new_value: c.new_value,
			metadata: c.metadata || {},
		}));
		if (!stateChanges.length && !carriedRelations.length) {
			toast("至少需要一项变化");
			return false;
		}
		const payloadChanges = stateChanges
			.map((c) => {
				const out = {
					change_kind: "character_state",
					subject_ref: c.subject_ref,
					field_key: c.field_key,
					new_value: c.new_value,
				};
				// 编辑走替代式修正（checkOld=false），旧值原样带回；新建仅在提供了旧值时带上
				//（避免与当前投影冲突报 409）（:387-388 注释逐字）
				if (isEdit || (c.old_value !== null && c.old_value !== undefined))
					out.old_value = c.old_value;
				return out;
			})
			.concat(carriedRelations);
		const chapterSel = modalBody.querySelector("#ev-chapter").value;
		const payload = {
			title: title,
			summary: modalBody.querySelector("#ev-summary").value.trim(),
			importance: modalBody.querySelector("#ev-importance").value,
			source_quote: modalBody.querySelector("#ev-quote").value.trim(),
			changes: payloadChanges,
		};
		if (chapterSel) payload.chapter_id = Number(chapterSel);
		try {
			if (isEdit) {
				await api("POST", `/ledger/events/${event.id}/corrections`, payload);
				toast("事件已修正");
			} else {
				await api("POST", "/ledger/events", payload);
				toast("事件已创建");
			}
			await refresh();
			return true;
		} catch (e) {
			toast(e.message);
			return false;
		}
	}

	async function openEventModal(event) {
		const isEdit = !!event;
		let chapters = [];
		try {
			chapters = (await api("GET", "/chapters")).chapters || [];
		} catch {
			chapters = [];
		}
		const importanceOptions = ["low", "normal", "high", "critical"]
			.map(
				(k) =>
					`<option value="${k}"${(isEdit ? event.importance : "normal") === k ? " selected" : ""}>${IMPORTANCE_LABEL[k]}</option>`,
			)
			.join("");
		const currentChapterId = isEdit ? event.chapter_id : null;
		const chapterOptions =
			`<option value=""${!currentChapterId ? " selected" : ""}>未绑定章节</option>` +
			chapters
				.map(
					(c) =>
						`<option value="${c.id}"${Number(currentChapterId) === Number(c.id) ? " selected" : ""}>${esc(c.title)}</option>`,
				)
				.join("");
		const existing = isEdit && event.changes ? event.changes : [];
		const relationChanges = existing.filter(
			(c) => c.change_kind === "relation",
		);
		// 仅本人物的状态变化预填行（:424 subject_ref 过滤）
		const stateChanges = existing.filter(
			(c) =>
				c.change_kind === "character_state" &&
				String(c.subject_ref) === String(person.id),
		);
		const relationNotice = relationChanges.length
			? `<div class="timeline-relation-notice">该事件含 ${relationChanges.length} 项关系变化，保存时将原样保留；如需修改请到<a href="${relationsHash()}">关系 tab</a>。</div>`
			: "";
		getApp().openModal({
			title: isEdit ? "编辑事件" : "新增事件",
			okText: isEdit ? "保存修正" : "创建事件",
			bodyHTML:
				'<div class="event-form">' +
				`<label>标题<span class="req">*</span><input id="ev-title" value="${esc(isEdit ? event.title : "")}" placeholder="例如：初次登场 / 身受重伤"></label>` +
				`<label>简介<textarea id="ev-summary" rows="2" placeholder="一句话说明这件事发生了什么">${esc(isEdit ? event.summary || "" : "")}</textarea></label>` +
				'<div class="form-grid"><label>重要性<select id="ev-importance">' +
				importanceOptions +
				'</select></label><label>章节<select id="ev-chapter">' +
				chapterOptions +
				'</select></label></div><label>原文依据<textarea id="ev-quote" rows="2" placeholder="粘贴对应的正文原句，便于日后核对与定位">' +
				esc(isEdit ? event.source_quote || "" : "") +
				"</textarea></label>" +
				relationNotice +
				'<div class="ev-changes-head"><span>状态变化</span><button type="button" id="ev-add-change" class="btn btn-ghost btn-small">+ 添加变化</button></div>' +
				'<div id="ev-changes" class="ev-changes"></div></div>',
			onOk: (modalBody) => submitEventModal(modalBody, event, relationChanges),
		});
		// openModal 返回后随即命令式接线（:443-449；legacy 弹窗壳已把 bodyHTML 渲染进 #modal-body）
		const container = document.getElementById("ev-changes");
		if (container) {
			if (stateChanges.length) {
				stateChanges.forEach((c) => {
					addChangeRow(container, c);
				});
			} else addChangeRow(container, null);
			const addChange = document.getElementById("ev-add-change");
			if (addChange)
				addChange.onclick = () => {
					addChangeRow(container, null);
				};
		}
	}

	// ---------- 渲染（JSX 等值旧 buildWorkspaceHTML/changeHTML/renderEvent/renderVolumeGroup） ----------
	function changeHTML(change, index) {
		if (change.change_kind === "relation") {
			const snap = change.new_value || change.old_value || {};
			const meta = [
				snap.strength ? `强度 ${snap.strength}/5` : "",
				POLARITY_LABEL[snap.polarity] || snap.polarity || "",
				LIFECYCLE_LABEL[snap.lifecycle] || snap.lifecycle || "",
			]
				.filter(Boolean)
				.join(" · ");
			return (
				<div key={index} className="timeline-change timeline-change-relation">
					<span className="timeline-change-kind">关系变化</span>
					<span className="timeline-change-body">{meta || "关系已更新"}</span>
					<a
						className="btn btn-ghost btn-small timeline-rel-jump"
						href={relationsHash()}
					>
						去关系 tab
					</a>
				</div>
			);
		}
		const vt = fieldValueType(change.field_key);
		return (
			<div key={index} className="timeline-change">
				<span className="timeline-change-field">
					{fieldLabel(change.field_key)}
				</span>
				<span className="timeline-change-old">
					{formatValue(vt, change.old_value)}
				</span>
				<span className="timeline-change-arrow">→</span>
				<span className="timeline-change-new">
					{formatValue(vt, change.new_value)}
				</span>
			</div>
		);
	}

	function renderEvent(event) {
		const changes = (event.changes || []).filter((c) =>
			isRelevantChange(c, person.id),
		);
		return (
			<article
				key={event.id}
				className={`timeline-event${event.source_stale ? " is-stale" : ""}`}
			>
				<div className="timeline-dot" />
				<div className="timeline-event-body">
					<div className="timeline-badges">
						<span className="tl-badge tl-badge-chapter">
							{event.chapter_title || "未绑定章节"}
						</span>
						<span
							className={`tl-badge tl-importance-${event.importance || "normal"}`}
						>
							{IMPORTANCE_LABEL[event.importance] || event.importance || "普通"}
						</span>
						<span className="tl-badge tl-badge-origin">
							来源·{ORIGIN_LABEL[event.origin] || event.origin || "手动"}
						</span>
						{event.source_stale ? (
							<span
								className="tl-badge tl-badge-stale"
								title="来源正文已改动，依据可能过期"
							>
								⚠ 依据已失效
							</span>
						) : null}
					</div>
					<h3>{event.title}</h3>
					{event.summary ? (
						<p className="timeline-summary">{event.summary}</p>
					) : null}
					<div className="timeline-changes">
						{changes.length ? (
							changes.map((c, i) => changeHTML(c, i))
						) : (
							<div className="timeline-change-empty">
								该事件未包含与该人物直接相关的可显示变化
							</div>
						)}
					</div>
					<div className="timeline-event-actions">
						{event.source_quote && event.chapter_id ? (
							<button
								className="btn btn-ghost btn-small timeline-source-btn"
								data-source={event.id}
								type="button"
								onClick={() => openSourcePreview(event)}
							>
								📖 原文依据
							</button>
						) : null}
						<button
							className="btn btn-ghost btn-small timeline-edit-btn"
							data-edit={event.id}
							type="button"
							onClick={() => openEventModal(event)}
						>
							编辑
						</button>
					</div>
				</div>
			</article>
		);
	}

	if (error) {
		// 旧 :202 错误态
		return <div className="workbench-error">{error.message}</div>;
	}
	if (loading || !data) {
		// 旧 :181/:229 loading 态
		return <div className="workbench-loading">正在整理人物时间线…</div>;
	}

	const events = data.eventList;
	const states = data.stateList;
	const pendingCount = data.pendingList.filter((p) =>
		(p.changes || []).some((c) => isRelevantChange(c, person.id)),
	).length;
	const banner =
		pendingCount > 0 ? (
			<div className="timeline-banner">
				<span>
					该人物有 <strong>{pendingCount}</strong> 条待审提案
				</span>
				<a className="btn btn-primary btn-small" href={proposalsHash()}>
					去故事台账审阅
				</a>
			</div>
		) : null;
	const stateCards = states.map((item) => (
		<div className="state-chip" key={item.field_key}>
			<span>{item.label}</span>
			<strong>{formatValue(item.value_type, item.value)}</strong>
		</div>
	));
	const groups = groupEventsByVolume(events);
	const _latestKey = findLatestVolumeKey(groups);
	const timelineInner = events.length ? (
		groups.map((g) => (
			<section
				key={g.key}
				className={`tl-volume${collapsedMap[g.key] ? " collapsed" : ""}`}
			>
				<button
					type="button"
					className="tl-volume-head"
					aria-expanded={collapsedMap[g.key] ? "false" : "true"}
					onClick={() =>
						setCollapsedMap((m) => ({ ...m, [g.key]: !collapsedMap[g.key] }))
					}
				>
					<span className="tl-volume-chevron">▾</span>
					<span className="tl-volume-title">{g.volumeTitle}</span>
					<span className="tl-volume-count">{g.events.length} 个事件</span>
				</button>
				<div className="tl-volume-body">
					<div className="timeline-list">
						{g.events.map((ev) => renderEvent(ev))}
					</div>
				</div>
			</section>
		))
	) : (
		<div className="workbench-empty-card">
			还没有与该人物关联的状态事件。点击「+ 新增事件」手动记录第一条。
		</div>
	);
	// ⤢ 放大仅内嵌模式渲染（源码 :169-170；全屏页无更高层级可跳）
	const expandBtn =
		mode === "embedded" ? (
			<a
				className="btn btn-ghost btn-small timeline-expand-btn"
				href={fullPageHash()}
				title="在独立页面放大查看"
			>
				⤢ 放大
			</a>
		) : null;
	return (
		<div
			className={`timeline-workspace${mode === "full" ? " timeline-workspace-full" : ""}`}
		>
			{banner}
			<section>
				<div className="relations-toolbar">
					<div>
						<span className="workbench-kicker">CURRENT STATE</span>
						<h2>{person.name}的当前状态</h2>
					</div>
				</div>
				<div className="state-chip-grid">
					{stateCards.length ? (
						stateCards
					) : (
						<span className="muted">暂无状态字段</span>
					)}
				</div>
			</section>
			<section className="timeline-section">
				<div className="relations-toolbar">
					<div>
						<span className="workbench-kicker">NARRATIVE HISTORY</span>
						<h2>事件时间线</h2>
					</div>
					<div className="timeline-section-actions">
						{expandBtn}
						<button
							id="timeline-add-event"
							className="btn btn-primary btn-small"
							type="button"
							onClick={() => openEventModal(null)}
						>
							+ 新增事件
						</button>
					</div>
				</div>
				<div
					className={`timeline-scroll${mode === "full" ? " timeline-scroll-full" : ""}`}
				>
					{timelineInner}
				</div>
			</section>
		</div>
	);
}

// ---------- 挂载（app.js:137 经 window.MozhenCharacterTimeline.showFullPage(bookId, cid) 委托至此） ----------
// 目标 #timeline-full-content；取不到即返回（安全 no-op）。app.js 路由只切 #page-timeline 显隐、
// 从不重写该容器 innerHTML——root 缓存 el.__mozhenTimelineFullRoot 跨访问安全复用，
// key=visit++ 重挂重拉，等值旧 showFullPage 每次进入先 GET 人物再 loadAndRender。
// 时序逐字等值旧 :224-241：loading（:229）→ 返回 href（:230-231，GET 之前）→ GET 人物（:233）
// → 标题（:235-236）→ 渲染全屏面板；失败渲染 .workbench-error（:238-239）。
let fullVisit = 0;

export async function mountTimelineFullPage(bookId, cid) {
	const el = document.getElementById("timeline-full-content");
	if (!el) return;
	let root = el.__mozhenTimelineFullRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenTimelineFullRoot = root;
	}
	root.render(<div className="workbench-loading">正在整理人物时间线…</div>);
	const ret = document.getElementById("timeline-full-return");
	if (ret)
		ret.href = `#/book/${encodeURIComponent(bookId)}/workbench/characters/${encodeURIComponent(cid)}?tab=timeline`;
	try {
		const res = await getApp().api(
			"GET",
			`/api/books/${encodeURIComponent(bookId)}/characters/${encodeURIComponent(cid)}`,
		);
		const nextPerson = res.character;
		const titleEl = document.getElementById("timeline-full-title");
		if (titleEl) titleEl.textContent = `${nextPerson.name} · 事件时间线`;
		fullVisit += 1;
		root.render(
			<TimelinePanel
				key={fullVisit}
				mode="full"
				route={{ bookId: bookId, tab: "timeline", entityId: String(cid) }}
				person={nextPerson}
			/>,
		);
	} catch (error) {
		root.render(<div className="workbench-error">{String(error.message)}</div>);
	}
}
