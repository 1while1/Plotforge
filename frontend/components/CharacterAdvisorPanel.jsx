// S4-2（charter §3，范式 W widget 型，list-pager/character-relations 先例）：
// CharacterAdvisorPanel 组件——人物工作台「人物顾问」tab 渲染委托给 React
//（character-workbench.js:121 经 window.MozhenCharacterAdvisor.show(route, character)）。
// 逐字等值移植 public/legacy/character-advisor.js（116 行）：
// - 会话卡（trigger_kind/focus 缺省、created_at T→空格截 16）、建议卡（type 徽标/结论/
//   推断/假设边界/潜在影响/证据 N 条、null citation 跳过不中断渲染、非活跃无 footer）
//   全部 JSX 逐字等值（红测 T-B B2/B3 钉住）。
// - 四处弹窗继续走 getApp().openModal（legacy 运行时依赖原样保留，ProfilePage 先例）；
//   其 bodyHTML 契约是 HTML 字符串——沙盘结果沿用旧 suggestionHTML 字符串版逐字移植。
// - 采纳 payload 分型（character_profile→{patch:{note}}，其余→{title,summary}）、沙盘
//   按钮态（正在核对证据…/恢复）、证据锚点核对（location 缺省 ?/stale 文案）逐字等值。
// - 锚点核对沿用旧版 document 级点击委托（advisor.js:47-68，含「沙盘弹窗里渲染的锚点
//   同样生效」设计意图）：改由组件 effect 注册、卸载清理——天然无重复绑定面，语义等价
//   旧 _bound 一次性旗标。
// - show(route, character) 即渲染 loading 态「正在读取人物顾问记录…」，GET 完成渲染
//   列表，失败渲染 .workbench-error（旧 :111-115 等值）。
// - 表单（焦点/类型/问题）受控并在每次 refresh 后重置为默认——等价旧版 refresh() 以
//   shellHTML 整块重写表单 DOM 的重建语义。

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";

function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

const FOCUS_DEFAULT = "人物弧光";
const TYPES_DEFAULT = ["A", "B", "C", "D"];

export default function CharacterAdvisorPanel({ route, character }) {
	const [sessions, setSessions] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [sandboxBusy, setSandboxBusy] = useState(false);
	const [composeBusy, setComposeBusy] = useState(false);
	const [focus, setFocus] = useState(FOCUS_DEFAULT);
	const [types, setTypes] = useState(TYPES_DEFAULT.slice());
	const [question, setQuestion] = useState("");

	function api(method, path, body) {
		return getApp().api(
			method,
			`/api/books/${encodeURIComponent(route.bookId)}${path}`,
			body,
		);
	}
	function base() {
		return `/characters/${character.id}/advisor`;
	}

	// 旧 refresh（:70-75）：拉 sessions 重渲列表；旧版整块 innerHTML 重建会连带重置
	// 表单输入——受控 state 显式重置等值之。
	async function refresh() {
		const response = await api("GET", `${base()}/sessions?limit=20`);
		setSessions(response.items || []);
		setFocus(FOCUS_DEFAULT);
		setTypes(TYPES_DEFAULT.slice());
		setQuestion("");
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重拉，等价旧 show(route, character)
	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				const response = await api("GET", `${base()}/sessions?limit=20`);
				if (!alive) return;
				setSessions(response.items || []);
			} catch (e) {
				if (!alive) return;
				setError(e);
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	// 证据锚点核对（旧 bindAnchorLookup :48-68 逐字等值）：document 级点击委托，
	// 沙盘弹窗（innerHTML 渲染、不在 React 树内）里的锚点同样生效；effect 卸载清理。
	// biome-ignore lint/correctness/useExhaustiveDependencies: route 随 key 重挂注入，组件实例与宿主 tab 同生命周期
	useEffect(() => {
		function onClick(event) {
			const button = event.target.closest
				? event.target.closest(".advisor-anchor")
				: null;
			if (!button) return;
			const anchor = button.dataset.anchor;
			if (!anchor) return;
			lookupAnchor(anchor);
		}
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, []);

	function lookupAnchor(anchor) {
		getApp()
			.api(
				"GET",
				`/api/books/${encodeURIComponent(route.bookId)}/evidence/anchors/${encodeURIComponent(anchor)}`,
			)
			.then((result) => {
				const loc = result.location || {};
				getApp().openModal({
					title: "证据核对",
					okText: "关闭",
					bodyHTML:
						`<p class="field-hint">锚点 ${esc(anchor)} · 第 ${esc(loc.chapterId != null ? loc.chapterId : "?")} 章第 ${esc(loc.paragraphIndex != null ? loc.paragraphIndex : "?")} 段</p>` +
						`<blockquote>${esc(result.quote || "（当前正文中没有这一段）")}</blockquote>` +
						(result.stale
							? '<p class="test-result fail">已失效：正文在建议生成后被修改过，此引用不再对应当前内容。</p>'
							: '<p class="test-result ok">有效：与当前定稿正文一致。</p>'),
				});
			})
			.catch((err) => {
				getApp().toast(`证据核对失败：${err.message}`);
			});
	}

	// ── 建议/会话卡（JSX 等值旧 suggestionHTML/sessionHTML :13-29） ──
	function citationCard(citation, i) {
		if (!citation) return null; // 防御：脏数据里混入 null 引用时不中断整次渲染
		return (
			<li key={i}>
				<button
					className="advisor-anchor"
					data-anchor={citation.anchor}
					title="在当前正文中核对这条证据"
					type="button"
				>
					{citation.anchor}
				</button>
				<blockquote>
					{citation.quote_snapshot || citation.quote || ""}
				</blockquote>
				<span>
					{(citation.trust_class || citation.trustClass || "") +
						" · " +
						(citation.canonical_status || citation.canonicalStatus || "")}
				</span>
			</li>
		);
	}

	function suggestionCard(item) {
		// key 用 idx+值组合：与旧 DOM 数组序一致，且值可能重复不宜单独作 key
		const assumptions = (item.assumptions || []).map((value, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: 与旧 DOM 数组序一致，假设文本可能重复不宜单独作 key
			<li key={`${i}-${value}`}>{value}</li>
		));
		const impacts = (item.impacts || []).map((value, i) => {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: 与旧 DOM 数组序一致，影响项可能重复不宜单独作 key
				<li key={`${i}-${text}`}>{text}</li>
			);
		});
		const citations = (item.citations || []).map(citationCard);
		return (
			<article className="advisor-suggestion" data-suggestion-id={item.id}>
				<header>
					<span
						className={`advisor-type type-${item.type || item.suggestion_type}`}
					>
						{item.type || item.suggestion_type}
					</span>
					<div>
						<h3>{item.title}</h3>
						<small>{item.status || "active"}</small>
					</div>
				</header>
				<section>
					<h4>结论</h4>
					<p>{item.conclusion}</p>
				</section>
				{item.inference ? (
					<section>
						<h4>推断</h4>
						<p>{item.inference}</p>
					</section>
				) : null}
				{assumptions.length ? (
					<details>
						<summary>假设边界</summary>
						<ul>{assumptions}</ul>
					</details>
				) : null}
				{impacts.length ? (
					<details>
						<summary>潜在影响</summary>
						<ul>{impacts}</ul>
					</details>
				) : null}
				<details className="advisor-evidence" open>
					<summary>证据 {(item.citations || []).length} 条</summary>
					<ul>{citations}</ul>
				</details>
				{item.status === "active" || !item.status ? (
					<footer>
						<button
							className="btn btn-primary btn-small advisor-adopt"
							type="button"
							onClick={() => adopt(item.id)}
						>
							采纳到…
						</button>
						<button
							className="btn btn-ghost btn-small advisor-ignore"
							type="button"
							onClick={() => ignore(item.id)}
						>
							忽略
						</button>
					</footer>
				) : null}
			</article>
		);
	}

	function sessionCard(session) {
		return (
			<section className="advisor-session" key={session.id}>
				<div className="advisor-session-head">
					<div>
						<span className="workbench-kicker">
							{session.trigger_kind || "manual"}
						</span>
						<h2>{session.focus || "人物分析"}</h2>
					</div>
					<time>
						{(session.created_at || "").replace("T", " ").slice(0, 16)}
					</time>
				</div>
				<div className="advisor-suggestions">
					{(session.suggestions || []).map(suggestionCard)}
				</div>
				<button
					className="btn btn-ghost advisor-follow-up"
					data-session-id={session.id}
					type="button"
					onClick={() => followUp(session.id)}
				>
					继续追问
				</button>
			</section>
		);
	}

	// ── 沙盘结果弹窗 bodyHTML 契约是 HTML 字符串——沿用旧 suggestionHTML/citationHTML
	//（:8-25）字符串版逐字移植（页面内建议卡为上方 JSX 版，两条路径互不替代）。
	function citationHTML(citation) {
		if (!citation) return ""; // 防御：脏数据里混入 null 引用时不中断整次渲染
		return `<li><button class="advisor-anchor" data-anchor="${esc(citation.anchor)}" title="在当前正文中核对这条证据">${esc(citation.anchor)}</button><blockquote>${esc(citation.quote_snapshot || citation.quote || "")}</blockquote><span>${esc(citation.trust_class || citation.trustClass || "")} · ${esc(citation.canonical_status || citation.canonicalStatus || "")}</span></li>`;
	}

	function suggestionHTML(item) {
		const assumptions = (item.assumptions || [])
			.map((value) => `<li>${esc(value)}</li>`)
			.join("");
		const impacts = (item.impacts || [])
			.map(
				(value) =>
					`<li>${esc(typeof value === "string" ? value : JSON.stringify(value))}</li>`,
			)
			.join("");
		const citations = (item.citations || []).map(citationHTML).join("");
		return `<article class="advisor-suggestion" data-suggestion-id="${item.id}"><header><span class="advisor-type type-${esc(item.type || item.suggestion_type)}">${esc(item.type || item.suggestion_type)}</span><div><h3>${esc(item.title)}</h3><small>${esc(item.status || "active")}</small></div></header><section><h4>结论</h4><p>${esc(item.conclusion)}</p></section>${item.inference ? `<section><h4>推断</h4><p>${esc(item.inference)}</p></section>` : ""}${assumptions ? `<details><summary>假设边界</summary><ul>${assumptions}</ul></details>` : ""}${impacts ? `<details><summary>潜在影响</summary><ul>${impacts}</ul></details>` : ""}<details class="advisor-evidence" open><summary>证据 ${(item.citations || []).length} 条</summary><ul>${citations}</ul></details>${item.status === "active" || !item.status ? '<footer><button class="btn btn-primary btn-small advisor-adopt">采纳到…</button><button class="btn btn-ghost btn-small advisor-ignore">忽略</button></footer>' : ""}</article>`;
	}

	// ── 行为（旧 run/ignore/adopt/followUp :77-109 逐字等值） ──
	async function run(isSandbox) {
		// 按钮态走受控 state（disabled＋「正在核对证据…」→ 结束恢复文案），
		// 等值旧版 :80-81/:88 的手动 DOM 设定与恢复。
		if (isSandbox) setSandboxBusy(true);
		else setComposeBusy(true);
		try {
			const result = await api(
				"POST",
				`${base()}${isSandbox ? "/sandbox" : "/sessions"}`,
				{ focus, question, types },
			);
			if (isSandbox) {
				getApp().openModal({
					title: "非正典沙盘结果",
					okText: "关闭",
					bodyHTML: `<div class="advisor-suggestions sandbox">${result.suggestions.map(suggestionHTML).join("")}</div>`,
				});
			} else await refresh();
		} catch (err) {
			getApp().toast(err.message);
		} finally {
			if (isSandbox) setSandboxBusy(false);
			else setComposeBusy(false);
		}
	}

	async function ignore(id) {
		await api("POST", `${base()}/suggestions/${id}/ignore`, {});
		await refresh();
		getApp().toast("已忽略；证据未变化前不会重复出现");
	}

	function adopt(id) {
		getApp().openModal({
			title: "选择采纳目标",
			okText: "确认采纳",
			bodyHTML:
				'<label>写入位置<select id="advisor-target"><option value="story_thread">新建故事线</option><option value="character_profile">人物档案备注</option><option value="advisor_note">仅标记采纳（不落地实体）</option></select></label><label>标题或补充说明<textarea id="advisor-adopt-note" rows="4" placeholder="留空则使用建议的标题与结论"></textarea></label>',
			onOk: async (body) => {
				const target = body.querySelector("#advisor-target").value;
				const note = body.querySelector("#advisor-adopt-note").value.trim();
				const payload =
					target === "character_profile"
						? { patch: { note } }
						: { title: note, summary: note };
				await api("POST", `${base()}/suggestions/${id}/adopt`, {
					target,
					payload,
				});
				await refresh();
				getApp().toast("建议已采纳到指定位置");
			},
		});
	}

	function followUp(sessionId) {
		getApp().openModal({
			title: "继续追问",
			okText: "提交追问",
			bodyHTML:
				'<label>新问题<textarea id="advisor-follow-question" rows="5" placeholder="新的问题会连同上一轮结论和最新证据一起分析"></textarea></label>',
			onOk: async (body) => {
				const text = body
					.querySelector("#advisor-follow-question")
					.value.trim();
				if (!text) return false;
				await api("POST", `${base()}/sessions/${sessionId}/follow-up`, {
					question: text,
				});
				await refresh();
			},
		});
	}

	if (error) {
		// 旧 :114 错误态
		return <div className="workbench-error">{error.message}</div>;
	}
	if (loading) {
		// 旧 :113 loading 态
		return <div className="workbench-loading">正在读取人物顾问记录…</div>;
	}

	return (
		<div className="advisor-workspace">
			<header className="advisor-hero">
				<div>
					<span className="workbench-kicker">EVIDENCE-GROUNDED ADVISOR</span>
					<h2>{character.name} · 人物顾问</h2>
					<p>
						基于人物档案、关系、台账、故事线与正文证据给出建议。推断不会冒充事实。
					</p>
				</div>
				<button
					id="advisor-sandbox"
					className="btn btn-ghost"
					type="button"
					disabled={sandboxBusy}
					onClick={() => run(true)}
				>
					{sandboxBusy ? "正在核对证据…" : "沙盘推演"}
				</button>
			</header>
			<form
				id="advisor-form"
				className="advisor-compose"
				onSubmit={(e) => {
					e.preventDefault();
					run(false);
				}}
			>
				<div className="form-grid">
					<label>
						分析焦点
						<select
							id="advisor-focus"
							value={focus}
							onChange={(e) => setFocus(e.target.value)}
						>
							<option>人物弧光</option>
							<option>动机一致性</option>
							<option>关系张力</option>
							<option>行为选择</option>
						</select>
					</label>
					<label>
						建议类型
						<select
							id="advisor-types"
							multiple
							value={types}
							onChange={(e) =>
								setTypes(
									Array.from(e.target.selectedOptions).map((o) => o.value),
								)
							}
						>
							<option value="A">A · 人设一致性</option>
							<option value="B">B · 剧情机会</option>
							<option value="C">C · 风险冲突</option>
							<option value="D">D · 弧光推进</option>
						</select>
					</label>
				</div>
				<label>
					你想解决什么问题？
					<textarea
						id="advisor-question"
						rows={3}
						placeholder="例如：下一次出场怎样既推进主线，又不破坏他对权威的戒备？"
						value={question}
						onChange={(e) => setQuestion(e.target.value)}
					/>
				</label>
				<div className="advisor-compose-actions">
					<span>每条结论都可展开查看证据</span>
					<button
						className="btn btn-primary"
						type="submit"
						disabled={composeBusy}
					>
						{composeBusy ? "正在核对证据…" : "生成顾问建议"}
					</button>
				</div>
			</form>
			<div id="advisor-results">
				{sessions.length ? (
					sessions.map(sessionCard)
				) : (
					<section className="workbench-empty-card">
						<h3>还没有顾问记录</h3>
						<p>选择一个分析焦点，顾问会在固定证据包内给出可追溯建议。</p>
					</section>
				)}
			</div>
		</div>
	);
}

// ---------- 挂载（character-workbench.js:121 经 window.MozhenCharacterAdvisor.show 委托至此） ----------
// 目标 #character-tab-content（宿主 renderDetail 每次重建的动态节点）；取不到即返回（安全 no-op）。
// root 缓存该元素自身（el.__mozhenCharacterAdvisorRoot）——宿主重建即旧 root 随 DOM 回收
//（legacy-bridge.jsx MozhenPager 先例：无泄漏路径）；key=visit++ 重挂重拉，等价旧 show()。
let visit = 0;

export function mount(newRoute, newCharacter) {
	const el = document.getElementById("character-tab-content");
	if (!el) return;
	let root = el.__mozhenCharacterAdvisorRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenCharacterAdvisorRoot = root;
	}
	root.render(
		<CharacterAdvisorPanel
			key={visit++}
			route={newRoute}
			character={newCharacter}
		/>,
	);
}
