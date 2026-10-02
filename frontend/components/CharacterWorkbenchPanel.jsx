// S4-3（charter §3，范式 A·S3-2 D4 ChapterConflict 判定 C 同构）：CharacterWorkbenchPanel——
// 人物工作台整体迁 React。S5-4 面板契约笔：旧壳 workbench-shell.js（217 行）与旧名桥
//（window.CharacterWorkbench）随 D-S4-9-01 迁移块整体退役，本组件由 WorkbenchPage.jsx 直接
// import 渲染（面板重挂＝外壳 key=<module|entityId|tab> 语义，等值旧 show() 全量重入重拉）。
// 逐字等值移植 public/legacy/character-workbench.js（410 行）活代码：
// - 名册（前端分页 30/页 slice 语义、搜索 220ms 防抖、归档开关、新建人物）＋档案/关系/时间线/
//   顾问四 tab；守卫先注册后加载数据（:399 注释逐字语义）。
// - WorkspaceState 深度消费原样经 window 调用：beginRequest/isCurrent 竞态令牌（书|人物双绑，
//   晚到响应丢弃）、dirtyTracker/registerGuard({key:'characters',label:'人物工作台'})/clearGuards。
//   已知等值差异（无行为回归）：旧 tracker 为模块级闭包跨 show 复用，React 每次重挂新实例——
//   脏态只可能经守卫 save/discard 收敛后离开（beforeNavigate 保证），重挂即新 tracker 无差异。
// - 文案逐字：保存失败/保存期间新输入 toast、删除人物空态、归档对方候选「（已归档）」补回、
//   关系/别名/新建弹窗标题与 payload。
// - 时间线 tab 组合本片 TimelinePanel、顾问 tab 组合 S4-2 CharacterAdvisorPanel（S4-2 前瞻兼容
//   注记预言的组件吸收形态；detailSeq key 重挂＝等值旧 CharacterTimeline.show /
//   MozhenCharacterAdvisor.show 每次全量重入）；关系 tab 直挂 RelationMap（S3-2 组件，等值旧
//   MozhenCharacterRelations.renderSVG）。
// - 弹窗继续走 getApp().openModal（bodyHTML 字符串契约，legacy 运行时依赖原样保留）；
//   关系编辑的方向/倾向/状态沿用旧版 openModal 返回后的命令式回填。
// - resize 自动长高：旧版为模块级监听，组件内 effect＋cleanup 等价；搜索框为 React 非受控节点，
//   跨重渲保留输入——等值旧「重绘不动搜索框」的中文 IME 保护意图（:357 注释）。
// 已知等值差异（红测未钉、行为无回归）：保存成功后旧版不重渲详情导航名（下一次 renderDetail
// 才更新），React 随 state.selected 即时更新。

import { useEffect, useReducer, useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import CharacterAdvisorPanel from "./CharacterAdvisorPanel.jsx";
import { TimelinePanel } from "./CharacterTimelinePanel.jsx";
import ListPager, { slice } from "./ListPager.jsx";
import RelationMap from "./RelationMap.jsx";

function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

const TAB_KEYS = ["profile", "relations", "timeline", "advisor"];
const TAB_LABELS = {
	profile: "档案",
	relations: "关系",
	timeline: "时间线",
	advisor: "人物顾问",
};
const ALIAS_LABELS = {
	primary: "主名",
	nickname: "昵称",
	former_name: "曾用名",
	title: "称号",
	pen_name: "化名",
	other: "其他",
};
const RAIL_KEY = "mozhen-character-rail-collapsed";

function railCollapsed() {
	try {
		return localStorage.getItem(RAIL_KEY) === "1";
	} catch {
		return false;
	}
}

// 角色标签色系：按常见定位词归类，沉稳低饱和；未命中走默认黛蓝（:23-28 逐字）
function roleTagClass(role) {
	if (/主角|主人公/.test(role)) return " role-lead";
	if (/反派|黑化/.test(role)) return " role-villain";
	if (/配角|龙套|路人/.test(role)) return " role-support";
	return "";
}

function fieldValue(person, key) {
	if (key === "name") return person.name;
	if (key === "role") return person.role || "未分类";
	if (key === "intro") return person.intro || "暂无简介";
	return "";
}

// 文本域随内容长高，封顶约 40vh 后转内部滚动（去掉手拖三角）（:201-210 逐字）
function autogrow(el) {
	el.style.height = "auto";
	const max = Math.max(120, Math.round(window.innerHeight * 0.4));
	const need = el.scrollHeight + 4;
	el.style.height = `${Math.min(need, max)}px`;
	el.style.overflowY = need > max ? "auto" : "hidden";
}
function autogrowAll() {
	document
		.querySelectorAll(".profile-sheet textarea[data-autogrow]")
		.forEach(autogrow);
}

export function CharacterWorkbenchPanel({ route }) {
	const [, bump] = useReducer((x) => x + 1, 0);
	// 等值移植旧闭包 state（:5）：所有 legacy 函数经 st.current 读写＋bump 重渲，避免异步闭包读到过期 state
	const st = useRef(null);
	if (!st.current) {
		st.current = {
			characters: [],
			selected: null,
			context: null,
			showArchived: false,
			query: "",
			preferences: null,
			missingEntityId: null,
			rosterPager: { page: 1, pageSize: 30, total: 0 },
			relations: null,
			relationView: "map",
			error: null,
			loaded: false,
			profileVersion: 0,
			profileDirty: false,
			detailSeq: 0,
		};
	}
	const state = st.current;
	const trackerRef = useRef(null);
	const searchTimerRef = useRef(null);
	const [railCollapsedState, setRailCollapsedState] = useState(railCollapsed);

	function api(method, path, body) {
		return getApp().api(
			method,
			`/api/books/${encodeURIComponent(route.bookId)}${path}`,
			body,
		);
	}
	function activeTab() {
		return TAB_KEYS.indexOf(route.tab) >= 0 ? route.tab : "profile";
	}

	// 守卫（:187-198 逐字）：表单可能马上就能编辑——守卫先注册，离开保护不留空窗
	function installGuard() {
		const w = getWorkspaceState();
		if (!w?.registerGuard) return;
		if (!trackerRef.current) trackerRef.current = w.dirtyTracker();
		w.clearGuards((g) => g.key === "characters");
		w.registerGuard({
			key: "characters",
			label: "人物工作台",
			isDirty: () => !!trackerRef.current && trackerRef.current.isDirty(),
			save: saveProfile,
			discard: () => {
				if (trackerRef.current) trackerRef.current.clear();
			},
		});
	}

	// 旧 show（:392-409）：壳渲染（JSX 即首帧）→ 守卫先注册 → 拉偏好与名册 → 渲染详情；
	// 任何失败渲染 .workbench-error（:406-408）
	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重跑，等值旧 show(route) 每次全量
	useEffect(() => {
		installGuard();
		let alive = true;
		(async () => {
			try {
				const pref = await api("GET", "/sidebar-preferences");
				if (!alive) return;
				state.preferences = pref.preferences;
				await loadCharacters(false);
				if (!alive) return;
				renderDetail();
			} catch (error) {
				if (!alive) return;
				state.error = error;
				bump();
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	// 视口变化时 40vh 上限会变，全局重算一次（:211）——旧版为模块级监听，组件 effect＋cleanup 等价
	useEffect(() => {
		window.addEventListener("resize", autogrowAll);
		return () => window.removeEventListener("resize", autogrowAll);
	}, []);

	// 档案渲染后首算一轮高度；网络字体就绪后文字可能换行变化，届时重算一轮（:227）
	// biome-ignore lint/correctness/useExhaustiveDependencies: profileVersion 重挂表单后需重算
	useEffect(() => {
		autogrowAll();
		if (document.fonts?.ready) document.fonts.ready.then(autogrowAll);
	}, [state.context, state.profileVersion]);

	async function loadCharacters(keepSelection) {
		const bookId = String(route.bookId);
		const entityId = route.entityId == null ? "" : String(route.entityId);
		const target = `${bookId}|${entityId}`;
		const w = getWorkspaceState();
		const token = w?.beginRequest ? w.beginRequest("characters", target) : null;
		const suffix = `?limit=200${state.showArchived ? "&archived=true" : ""}${state.query ? `&q=${encodeURIComponent(state.query)}` : ""}`;
		const response = await api("GET", `/characters${suffix}`);
		// 切书后晚到的名册：token 与书/目标对象双绑，过期即丢弃（不跨书回写）（:374-376 逐字）
		if (String(route.bookId) !== bookId) return;
		if (token && !w.isCurrent(token, target)) return;
		state.characters = response.items || [];
		if (!keepSelection || !state.selected) {
			const requested = state.characters.find(
				(person) => String(person.id) === String(route.entityId),
			);
			const current =
				state.selected &&
				state.characters.find(
					(person) => String(person.id) === String(state.selected.id),
				);
			// 指定的对象已不在本书：明确空态，绝不落到名册第一个人（:381-383 注释逐字）
			state.missingEntityId =
				!requested && !current && route.entityId
					? String(route.entityId)
					: null;
			state.selected =
				requested ||
				current ||
				(route.entityId ? null : state.characters[0] || null);
		} else {
			state.selected =
				state.characters.find(
					(person) => Number(person.id) === Number(state.selected.id),
				) || state.selected;
		}
		state.loaded = true;
		if (keepSelection) renderDetail();
		bump();
	}

	// 旧 renderDetail（:101-123）：详情区整体重渲＋按 tab 触发对应加载（profile/relations 重新拉取；
	// timeline/advisor 组件以新 key 重挂重拉）
	function renderDetail() {
		state.detailSeq += 1;
		bump();
		if (!state.selected) return;
		const tab = activeTab();
		if (tab === "relations") loadRelations();
		else if (tab === "profile") loadProfile();
	}

	async function loadProfile() {
		const bookId = String(route.bookId);
		const characterId = state.selected ? String(state.selected.id) : "";
		const target = `${bookId}|${characterId}`;
		const w = getWorkspaceState();
		const token = w?.beginRequest
			? w.beginRequest("character-profile", target)
			: null;
		const ctx = await api("GET", `/characters/${state.selected.id}`);
		// 切人物或切书后晚到的档案：token 与书/人物双绑，过期即丢弃（不把 A 的档案画到 B 上）（:140-143 逐字）
		if (!state.selected || String(state.selected.id) !== characterId) return;
		if (String(route.bookId) !== bookId) return;
		if (token && !w.isCurrent(token, target)) return;
		state.context = ctx;
		state.selected = ctx.character;
		// key 变更使非受控表单按新 ctx 重挂（等值旧 profileHTML 整块重渲后重新绑定）
		state.profileVersion += 1;
		bump();
	}

	function profilePayload(form) {
		const data = new FormData(form);
		return [
			"name",
			"role",
			"intro",
			"appearance",
			"personality",
			"background",
			"note",
		].reduce((out, key) => {
			out[key] = data.get(key) || "";
			return out;
		}, {});
	}

	// 输入即脏（:219）：tracker.mark ＋ 保存态指示
	function markProfileDirty() {
		if (trackerRef.current) trackerRef.current.mark();
		state.profileDirty = true;
		bump();
	}

	// 保存人物档案：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示（:162 注释逐字）
	async function saveProfile() {
		const tracker = trackerRef.current;
		if (!state.selected) return !tracker?.isDirty();
		if (!tracker) return true;
		const form = document.getElementById("character-profile-form");
		if (!form) return !tracker.isDirty();
		const snapshot = tracker.snapshot();
		let result;
		try {
			result = await api(
				"PATCH",
				`/characters/${state.selected.id}`,
				profilePayload(form),
			);
		} catch (e) {
			getApp().toast(
				`保存失败（人物档案未保存）：${e.message}，修改仍留在表单里`,
			);
			return false;
		}
		if (!tracker.settle(snapshot, true)) {
			state.profileDirty = true;
			bump();
			getApp().toast(
				"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
			);
			return false;
		}
		state.selected = result.character;
		await loadCharacters(false);
		state.profileDirty = false;
		bump();
		getApp().toast("人物档案已保存");
		return true;
	}

	async function toggleArchive() {
		const action = state.selected.archived_at ? "unarchive" : "archive";
		await api("POST", `/characters/${state.selected.id}/${action}`, {});
		state.showArchived = action === "archive";
		await loadCharacters(true);
		getApp().toast(action === "archive" ? "人物已归档" : "人物已恢复");
	}

	function onSearchInput(event) {
		state.query = event.target.value;
		state.rosterPager.page = 1;
		clearTimeout(searchTimerRef.current);
		searchTimerRef.current = setTimeout(() => {
			loadCharacters(true);
		}, 220);
	}

	function onArchiveToggle(event) {
		state.showArchived = event.target.checked;
		state.rosterPager.page = 1;
		loadCharacters(true);
	}

	function openCard(id) {
		window.location.hash = `#/book/${route.bookId}/workbench/characters/${id}?tab=${activeTab()}`;
	}

	function switchTab(key) {
		window.location.hash = `#/book/${route.bookId}/workbench/characters/${state.selected.id}?tab=${key}`;
	}

	async function loadRelations() {
		const response = await api(
			"GET",
			`/characters/${state.selected.id}/relations?secrecy=all&lifecycle=all`,
		);
		state.relations = response.items || [];
		state.relationView = "map";
		bump();
	}

	function switchRelationView(key) {
		state.relationView = key;
		bump();
	}

	function relationOther(relation) {
		return Number(relation.endpoint_a.id) === Number(state.selected.id)
			? relation.endpoint_b
			: relation.endpoint_a;
	}

	function editAliases() {
		const extras = state.context.aliases.filter((item) => !item.is_primary);
		const rows = extras
			.map((item) => `${item.alias}|${item.alias_type}`)
			.join("\n");
		getApp().openModal({
			title: "编辑别名与称号",
			okText: "保存别名",
			bodyHTML:
				'<p class="field-hint">每行一个，格式：别名|类型。类型可用 nickname、former_name、title、pen_name、other。</p>' +
				`<textarea id="alias-editor" class="outline-textarea" rows="9">${esc(rows)}</textarea>`,
			onOk: async (body) => {
				const aliases = [
					{
						alias: state.selected.name,
						alias_type: "primary",
						is_primary: true,
					},
				];
				body
					.querySelector("#alias-editor")
					.value.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)
					.forEach((line) => {
						const parts = line.split("|");
						aliases.push({
							alias: parts[0].trim(),
							alias_type: (parts[1] || "other").trim(),
							is_primary: false,
						});
					});
				state.context = await api(
					"PUT",
					`/characters/${state.selected.id}/aliases`,
					{ aliases: aliases },
				);
				await loadProfile();
				getApp().toast("别名已保存");
			},
		});
	}

	async function openRelationModal(existing) {
		const results = await Promise.all([
			api("GET", "/characters?limit=200"),
			api("GET", "/relation-types"),
		]);
		const people = results[0].items.filter(
			(item) => Number(item.id) !== Number(state.selected.id),
		);
		const types = results[1].items;
		const other = existing ? relationOther(existing) : people[0];
		let options = people
			.map(
				(item) =>
					`<option value="${item.id}"${other && Number(item.id) === Number(other.id) ? " selected" : ""}>${esc(item.name)}</option>`,
			)
			.join("");
		// 对方已归档时不在候选列表（默认过滤归档），补回一项并选中，避免 select 静默落到第一个人、
		// 保存即错改关系对象（:293-296 注释逐字）
		if (other && !people.some((item) => Number(item.id) === Number(other.id))) {
			options =
				`<option value="${other.id}" selected>${esc(other.name)}（已归档）</option>` +
				options;
		}
		const typeOptions = types
			.map(
				(item) =>
					`<option value="${item.id}"${existing && Number(item.id) === Number(existing.relation_type.id) ? " selected" : ""}>${esc(item.forward_label)} / ${esc(item.reverse_label)}</option>`,
			)
			.join("");
		if (!people.length) {
			getApp().toast("至少需要两个人物才能建立关系");
			return;
		}
		getApp().openModal({
			title: existing ? "编辑人物关系" : "添加人物关系",
			okText: existing ? "记录变化" : "建立关系",
			bodyHTML:
				'<div class="form-grid"><label>关系对象<select id="relation-other">' +
				options +
				'</select></label><label>关系类型<select id="relation-type">' +
				typeOptions +
				'</select></label></div><div class="form-grid"><label>方向<select id="relation-direction"><option value="both">双向</option><option value="a_to_b">我 → 对方</option><option value="b_to_a">对方 → 我</option><option value="none">无方向</option></select></label><label>强度<input id="relation-strength" type="range" min="1" max="5" value="' +
				(existing ? existing.strength : 3) +
				'"></label></div><div class="form-grid"><label>倾向<select id="relation-polarity"><option value="positive">正向</option><option value="neutral">中性</option><option value="negative">负向</option><option value="mixed">复杂</option></select></label><label>状态<select id="relation-lifecycle"><option value="active">活跃</option><option value="dormant">潜伏</option><option value="ended">结束</option></select></label></div><label class="visibility-toggle"><input id="relation-secret" type="checkbox"' +
				(existing && existing.secrecy === "secret" ? " checked" : "") +
				'> 秘密关系</label><label>关系备注<textarea id="relation-note" rows="4">' +
				esc(existing?.note || "") +
				"</textarea></label>",
			onOk: async (body) => {
				const relation = {
					// biome-ignore lint/complexity/useOptionalChain: 逐字等值旧 :307——null && x 得 null（JSON 带 "public_id": null），可选链得 undefined（键被序列化丢弃），payload 语义不同
					public_id: existing && existing.public_id,
					character_a_id: state.selected.id,
					character_b_id: Number(body.querySelector("#relation-other").value),
					relation_type_id: Number(body.querySelector("#relation-type").value),
					direction: body.querySelector("#relation-direction").value,
					strength: Number(body.querySelector("#relation-strength").value),
					polarity: body.querySelector("#relation-polarity").value,
					lifecycle: body.querySelector("#relation-lifecycle").value,
					secrecy: body.querySelector("#relation-secret").checked
						? "secret"
						: "public",
					note: body.querySelector("#relation-note").value,
				};
				await api("POST", "/relations/changes", {
					event: { title: `更新人物关系：${state.selected.name}` },
					relation: relation,
				});
				await loadRelations();
				getApp().toast("关系变化已记入故事台账");
			},
		});
		// openModal 返回后随即回填（:323-327；legacy 弹窗壳已把 bodyHTML 渲染进 #modal-body）
		if (existing) {
			document.getElementById("relation-direction").value = existing.direction;
			document.getElementById("relation-polarity").value = existing.polarity;
			document.getElementById("relation-lifecycle").value = existing.lifecycle;
		}
	}

	function openCreate() {
		getApp().openModal({
			title: "新建人物",
			okText: "创建人物",
			bodyHTML:
				'<div class="form-grid"><label>姓名<input id="new-character-name" required></label><label>类型<input id="new-character-role" placeholder="主角、配角…"></label></div><label>简介<textarea id="new-character-intro" rows="4"></textarea></label>',
			onOk: async (body) => {
				const name = body.querySelector("#new-character-name").value.trim();
				if (!name) {
					getApp().toast("请填写人物姓名");
					return false;
				}
				const result = await api("POST", "/characters", {
					name: name,
					role: body.querySelector("#new-character-role").value,
					intro: body.querySelector("#new-character-intro").value,
				});
				state.showArchived = false;
				window.location.hash = `#/book/${route.bookId}/workbench/characters/${result.character.id}?tab=profile`;
			},
		});
	}

	function toggleRail() {
		const next = !railCollapsedState;
		setRailCollapsedState(next);
		try {
			localStorage.setItem(RAIL_KEY, next ? "1" : "0");
		} catch {
			/* 私密模式下不持久化也能用（:238 注释逐字） */
		}
	}

	// ---------- 渲染（JSX 等值旧 shellHTML/rosterHTML/profileHTML/relationsHTML） ----------
	const s = state;
	const tab = activeTab();
	const selectedFields = s.preferences?.summaryFields.characters || [
		"name",
		"role",
		"intro",
	];
	// 名册前端分页：服务端列表上限 200（无 offset），真实单书人物难越此界；页内切片防堆叠（:32 注释逐字）
	const pageItems = slice(s.characters, s.rosterPager);
	const rosterCards = pageItems.map((person) => {
		const initial = (person.name || "?").trim().charAt(0) || "?";
		const hue = Math.abs(Number(person.id) || 0) % 5;
		const top = [];
		const extra = [];
		selectedFields.forEach((field, index) => {
			const value = fieldValue(person, field);
			if (!value) return;
			if (index === 0) {
				top.push(
					<strong key="name" className="character-card-name">
						{value}
					</strong>,
				);
				return;
			}
			if (field === "role") {
				top.push(
					<span key="role" className={`roster-role-tag${roleTagClass(value)}`}>
						{value}
					</span>,
				);
				return;
			}
			extra.push(
				<span key={field} className={`character-card-${field}`}>
					{value}
				</span>,
			);
		});
		return (
			<button
				key={person.id}
				type="button"
				className={`character-roster-card${s.selected && Number(s.selected.id) === Number(person.id) ? " active" : ""}`}
				data-character-id={person.id}
				onClick={() => openCard(person.id)}
			>
				<span className={`roster-avatar avatar-hue-${hue}`} aria-hidden="true">
					{initial}
				</span>
				<span className="roster-card-main">
					<span className="roster-card-top">{top}</span>
					{extra}
				</span>
			</button>
		);
	});

	const aliasChips = (s.context?.aliases || []).map((item, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: 别名按数组序静态渲染，别名文本可能重复不宜单独作 key
		<span key={i} className="alias-chip">
			{item.alias}
			<small>{ALIAS_LABELS[item.alias_type] || item.alias_type}</small>
		</span>
	));

	const profileSheet = s.context ? (
		<div
			className={`character-profile-grid${railCollapsedState ? " rail-collapsed" : ""}`}
		>
			<form
				key={s.profileVersion}
				id="character-profile-form"
				className="profile-sheet"
				onSubmit={(e) => {
					e.preventDefault();
					saveProfile();
				}}
			>
				<div className="profile-sheet-head">
					<div className="profile-title-wrap">
						<span className="workbench-kicker">人物档案</span>
						<input
							className="profile-name-input"
							name="name"
							defaultValue={s.context.character.name}
							required
							aria-label="姓名"
							title="点击直接修改姓名"
							onInput={markProfileDirty}
						/>
					</div>
				</div>
				<label className="field">
					<span className="field-label">类型</span>
					<input
						name="role"
						list="character-role-options"
						defaultValue={s.context.character.role || ""}
						placeholder="主角、配角、反派…"
						onInput={markProfileDirty}
					/>
					<datalist id="character-role-options">
						<option value="主角" />
						<option value="配角" />
						<option value="反派" />
						<option value="龙套" />
					</datalist>
				</label>
				<label className="field">
					<span className="field-label">一句话简介</span>
					<textarea
						name="intro"
						data-autogrow="true"
						rows={2}
						placeholder="这个人是谁，他在故事里承担什么作用"
						defaultValue={s.context.character.intro || ""}
						onInput={(e) => {
							markProfileDirty();
							autogrow(e.target);
						}}
					/>
				</label>
				<div className="form-grid">
					<label className="field">
						<span className="field-label">外貌</span>
						<textarea
							name="appearance"
							data-autogrow="true"
							rows={3}
							defaultValue={s.context.character.appearance || ""}
							onInput={(e) => {
								markProfileDirty();
								autogrow(e.target);
							}}
						/>
					</label>
					<label className="field">
						<span className="field-label">性格</span>
						<textarea
							name="personality"
							data-autogrow="true"
							rows={3}
							defaultValue={s.context.character.personality || ""}
							onInput={(e) => {
								markProfileDirty();
								autogrow(e.target);
							}}
						/>
					</label>
				</div>
				<label className="field">
					<span className="field-label">背景</span>
					<textarea
						name="background"
						data-autogrow="true"
						rows={4}
						defaultValue={s.context.character.background || ""}
						onInput={(e) => {
							markProfileDirty();
							autogrow(e.target);
						}}
					/>
				</label>
				<label className="field">
					<span className="field-label">创作备注</span>
					<textarea
						name="note"
						data-autogrow="true"
						rows={3}
						defaultValue={s.context.character.note || ""}
						onInput={(e) => {
							markProfileDirty();
							autogrow(e.target);
						}}
					/>
				</label>
				<div className="profile-save-bar">
					<button
						id="archive-character"
						className="btn btn-ghost"
						type="button"
						onClick={toggleArchive}
					>
						{s.context.character.archived_at ? "恢复人物" : "归档人物"}
					</button>
					<span className="save-bar-right">
						<span
							id="profile-save-state"
							className={s.profileDirty ? "save-state dirty" : "save-state"}
						>
							{s.profileDirty ? "有未保存的修改" : "已保存"}
						</span>
						<button className="btn btn-primary" type="submit">
							保存档案
						</button>
					</span>
				</div>
			</form>
			<aside className="character-context-rail">
				<button
					id="rail-toggle"
					className="rail-toggle"
					type="button"
					title={railCollapsedState ? "展开资料栏" : "收起资料栏"}
					onClick={toggleRail}
				>
					{railCollapsedState ? "«" : "»"}
				</button>
				<div className="rail-body">
					<section className="context-card">
						<div className="context-card-head">
							<h3>别名与称号</h3>
							<button
								id="edit-aliases"
								className="btn btn-ghost btn-small"
								type="button"
								onClick={editAliases}
							>
								编辑
							</button>
						</div>
						<div className="alias-list">
							{aliasChips.length ? (
								aliasChips
							) : (
								<span className="muted">暂无别名</span>
							)}
						</div>
					</section>
					<section className="context-card">
						<h3>创作概况</h3>
						<dl className="metric-list">
							<div>
								<dt>关系</dt>
								<dd>{s.context.relation_summary.active} 条活跃</dd>
							</div>
							<div>
								<dt>事件</dt>
								<dd>{s.context.timeline_summary.events} 条</dd>
							</div>
							<div>
								<dt>故事线</dt>
								<dd>{s.context.thread_summary.open} 条未结</dd>
							</div>
						</dl>
					</section>
				</div>
			</aside>
		</div>
	) : null;

	const relationRows = (s.relations || []).map((relation) => {
		const other = relationOther(relation);
		return (
			<article key={relation.public_id} className="relation-list-row">
				<div>
					<strong>{other.name}</strong>
					<span>
						{relation.relation_type.label_from_focus} · 强度 {relation.strength}
						/5
					</span>
					<small>{relation.note || "暂无关系备注"}</small>
				</div>
				<div>
					<span className={`relation-badge ${relation.polarity}`}>
						{relation.lifecycle}
						{relation.secrecy === "secret" ? " · 秘密" : ""}
					</span>
					<button
						className="btn btn-ghost btn-small edit-relation"
						data-relation={relation.public_id}
						type="button"
						onClick={() => openRelationModal(relation)}
					>
						编辑
					</button>
				</div>
			</article>
		);
	});

	const relationsView = s.relations ? (
		<div className="relations-workspace">
			<div className="relations-toolbar">
				<div>
					<span className="workbench-kicker">RELATION MAP</span>
					<h2>{s.selected.name}的人物关系</h2>
				</div>
				<button
					id="add-relation"
					className="btn btn-primary"
					type="button"
					onClick={() => openRelationModal(null)}
				>
					+ 添加关系
				</button>
			</div>
			<div className="relation-view-switch">
				<button
					className={s.relationView === "map" ? "active" : ""}
					data-relation-view="map"
					type="button"
					onClick={() => switchRelationView("map")}
				>
					关系图
				</button>
				<button
					className={s.relationView === "list" ? "active" : ""}
					data-relation-view="list"
					type="button"
					onClick={() => switchRelationView("list")}
				>
					关系列表
				</button>
			</div>
			<div
				id="relation-map-panel"
				className={`relation-map-panel${s.relationView !== "map" ? " hidden" : ""}`}
			>
				<RelationMap focus={s.selected} relations={s.relations} />
			</div>
			<div
				id="relation-list-panel"
				className={`relation-list-panel${s.relationView !== "list" ? " hidden" : ""}`}
			>
				{relationRows.length ? (
					relationRows
				) : (
					<div className="workbench-empty-card">
						还没有关系。添加第一条关系，让人物网络开始生长。
					</div>
				)}
			</div>
		</div>
	) : null;

	let detailContent = null;
	if (s.error) {
		// 旧 :406-408 错误态
		detailContent = <div className="workbench-error">{s.error.message}</div>;
	} else if (!s.selected) {
		if (s.loaded) {
			detailContent = s.missingEntityId ? (
				// 指定的对象已不在本书（被删/被移走）：明确空态，绝不自动落到名册里的其他人物（:104 注释逐字）
				<section
					className="workbench-empty"
					data-character-missing={s.missingEntityId}
				>
					<h2>这个人物已不在本书中</h2>
					<p>
						它可能已被删除（#{s.missingEntityId}
						）。未自动切换到其他人物或别的书；可从左侧名册另选一位。
					</p>
				</section>
			) : (
				<section className="workbench-empty">
					<h2>选择一个人物</h2>
					<p>从左侧名册进入档案、关系与时间线。</p>
				</section>
			);
		}
	} else {
		detailContent = (
			<>
				<header className="character-detail-nav">
					<div>
						<strong>{s.selected.name}</strong>
						<span>{s.selected.role || "未分类"}</span>
					</div>
					<nav>
						{TAB_KEYS.map((key) => (
							<button
								key={key}
								data-character-tab={key}
								className={tab === key ? "active" : ""}
								type="button"
								onClick={() => switchTab(key)}
							>
								{TAB_LABELS[key]}
							</button>
						))}
					</nav>
				</header>
				<div id="character-tab-content" className="character-tab-content">
					{tab === "profile" ? (
						s.context ? (
							profileSheet
						) : (
							<div className="workbench-loading">正在加载…</div>
						)
					) : tab === "relations" ? (
						s.relations ? (
							relationsView
						) : (
							<div className="workbench-loading">正在加载…</div>
						)
					) : tab === "timeline" ? (
						<TimelinePanel
							key={`tl-${s.detailSeq}`}
							mode="embedded"
							route={route}
							person={s.selected}
						/>
					) : (
						<CharacterAdvisorPanel
							key={`adv-${s.detailSeq}`}
							route={route}
							character={s.selected}
						/>
					)}
				</div>
			</>
		);
	}

	return (
		<div className="character-hub">
			<aside className="character-roster">
				<div className="character-roster-head">
					<div>
						<span className="workbench-kicker">CHARACTERS</span>
						<h2>人物名册</h2>
					</div>
					<button
						id="character-create"
						className="btn btn-primary btn-small"
						type="button"
						onClick={openCreate}
					>
						+ 新建
					</button>
				</div>
				{/* 只重绘名册列表与分页条：不动搜索框（中文输入法组合中重绘会断字）（:357 注释逐字）
						——React 非受控节点跨重渲保留输入 */}
				<label className="roster-search">
					<span>⌕</span>
					<input
						id="character-search"
						defaultValue={s.query}
						placeholder="搜索姓名、别名或简介"
						onInput={onSearchInput}
					/>
				</label>
				<label className="roster-archive-toggle">
					<input
						id="character-show-archived"
						type="checkbox"
						checked={s.showArchived}
						onChange={onArchiveToggle}
					/>{" "}
					查看已归档人物
				</label>
				<div id="character-roster-list" className="character-roster-list">
					{rosterCards.length ? (
						rosterCards
					) : (
						<div className="roster-empty">没有符合条件的人物</div>
					)}
				</div>
				<div id="character-roster-pager">
					<ListPager st={s.rosterPager} onChange={bump} unit="人" />
				</div>
			</aside>
			<section id="character-detail" className="character-detail">
				{detailContent}
			</section>
		</div>
	);
}
