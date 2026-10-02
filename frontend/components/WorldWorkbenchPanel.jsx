// S5-4（Plan §2.4.3；D-S3-3-01 随块迁）：WorldWorkbenchPanel——public/legacy/world-workbench.js
// （109 行）等值迁 React，旧文件随 D-S4-9-01 迁移块 git rm 全退役（零旧名桥：使用地图实核全仓无
// window.WorldWorkbench 消费方；workspace-navigation.test.js:507 的 vm 暴露面随本片冻结转写消失）。
// 逐字等值锚点＝legacy 活代码行号：
//   :10-12 缺失实体空态（data-world-missing＋明确不自动切换）／:13 trackInput 输入即脏／
//   :14 搜索过滤（title＋content 小写包含）／:15 目录行（60 字截断/暂无内容/active）＋分页 slice
//   （MozhenPager.slice → ListPager 的 slice 直 import，S4-4 先例）／:16-20 整壳结构（world-workspace/
//   world-index/world-editor）／:21-29 搜索不重建 #world-search（IME 契约）／:30-33 bindList 选择与分页
//   ／:35 新建弹窗 opts 逐字／:44 删除 confirm 逐字／:48-67 保存三态 toast 逐字＋tracker settle
//   ／:69-80 守卫 key 'world'（clearGuards 后注册，unmount 不注销）／:82-101 load 竞态双绑＋tracker.clear
//   ／:102-108 show 三重置（missingEntityId=null/pager.page=1/installGuard）＋错误态。
// 整改 F1（Review-S5-4，2026-09-28）：可见文本一律**直接渲染原始值**（React 文本节点自带转义），不再经
// getApp().escapeHtml 预转义——legacy :11/:15 拼 innerHTML 后由浏览器解码、显示原文（& < > " ' 五字符
// 显示等值）；预转义会在 React 文本节点上二次转义（用户看到 &amp;/&quot;/&#39;）。本文件现无拼 HTML 场合。
// React 形态：模块级 state 对象 → 组件实例 ref；query 为唯一跨 show 存活字段（旧模块级 state.query），
// 以模块级变量承接；entries/selected/missingEntityId/pager.page 每次 show/load 重置与旧件一致。
// 外壳（WorkbenchPage.jsx）以 key=<module|entityId|tab> 重挂承接旧 show() 的「每次全量重拉」，
// 本组件亦按 route.bookId/entityId 变化重跑（对直渲染/属性变更形态等效）。

import { useEffect, useReducer, useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import ListPager, { slice } from "./ListPager.jsx";

// 等值 legacy state.query（:4）：搜索词跨 show 保留（外壳重挂不清搜索框内容）
let worldQuery = "";

// 测试缝：模块级 query 的跨 show 存活语义需在用例间显式复位（产品代码不调用）
export function resetWorldQueryForTest() {
	worldQuery = "";
}

export default function WorldWorkbenchPanel({ route }) {
	const routeRef = useRef(route);
	const entriesRef = useRef([]);
	const selectedRef = useRef(null);
	const trackerRef = useRef(null);
	const pagerRef = useRef({ page: 1, pageSize: 30, total: 0 });
	const [entries, setEntries] = useState([]);
	const [selected, setSelected] = useState(null);
	const [missingEntityId, setMissingEntityId] = useState(null);
	const [query, setQuery] = useState(worldQuery);
	const [error, setError] = useState(null);
	const [formSeq, setFormSeq] = useState(0);
	const [, forceRender] = useReducer((n) => n + 1, 0);

	function applySelected(next) {
		selectedRef.current = next;
		setSelected(next);
	}

	function api(method, path, body) {
		return getApp().api(
			method,
			`/api/books/${routeRef.current.bookId}/world${path}`,
			body,
		);
	}

	// 已删除/不在本书的设定：明确空态，绝不自动切到别的条目或别的书
	function missingHTML() {
		return (
			<section className="workbench-empty" data-world-missing={missingEntityId}>
				<h2>这条设定已不在本书中</h2>
				<p>
					它可能已被删除（#{missingEntityId}
					）。未自动切换到其他设定或别的书；可从左侧目录选一条继续编辑。
				</p>
			</section>
		);
	}

	function filtered() {
		const q = (query || "").toLowerCase();
		return entries.filter(
			(e) =>
				!q ||
				`${e.title || ""} ${e.content || ""}`.toLowerCase().indexOf(q) >= 0,
		);
	}

	// 保存当前设定：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示（legacy :48-67）
	async function saveEntry() {
		if (!selectedRef.current) return !trackerRef.current?.isDirty(); // 等值 legacy :49（无 tracker 视为不脏）
		if (!trackerRef.current) return true;
		const snapshot = trackerRef.current.snapshot();
		const doc = window.document;
		const body = {
			title: doc.getElementById("world-entry-title").value,
			content: doc.getElementById("world-entry-content").value,
		};
		let res;
		try {
			res = await api("PUT", `/${selectedRef.current.id}`, body);
		} catch (e) {
			getApp().toast(
				`保存失败（世界设定未保存）：${e.message}，修改仍留在表单里`,
			);
			return false;
		}
		if (!trackerRef.current.settle(snapshot, true)) {
			getApp().toast(
				"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
			);
			return false;
		}
		applySelected(res.entry);
		await load(res.entry.id);
		getApp().toast("世界设定已保存");
		return true;
	}

	function installGuard() {
		const ws = getWorkspaceState();
		if (!ws?.registerGuard) return;
		if (!trackerRef.current) trackerRef.current = ws.dirtyTracker();
		ws.clearGuards((g) => g.key === "world");
		ws.registerGuard({
			key: "world",
			label: "世界观工作台",
			isDirty: () => !!trackerRef.current && trackerRef.current.isDirty(),
			save: saveEntry,
			discard: () => {
				if (trackerRef.current) trackerRef.current.clear();
			},
		});
	}

	async function load(selectId) {
		const bookId = String(routeRef.current.bookId);
		const hasTarget =
			selectId !== null && selectId !== undefined && selectId !== "";
		const target = `${bookId}|${hasTarget ? String(selectId) : ""}`;
		const ws = getWorkspaceState();
		const token = ws?.beginRequest ? ws.beginRequest("world", target) : null;
		const res = await api("GET", "");
		// 切书或切对象后晚到的响应：token 与书/对象双绑，过期即丢弃（不跨书回写）（legacy :88-90）
		if (String(routeRef.current.bookId) !== bookId) return;
		if (token && !ws.isCurrent(token, target)) return;
		const list = res.entries || [];
		entriesRef.current = list;
		setEntries(list);
		if (hasTarget) {
			const hit = list.find((e) => String(e.id) === String(selectId)) || null;
			applySelected(hit);
			setMissingEntityId(hit ? null : String(selectId));
		} else {
			applySelected(list[0] || null);
			setMissingEntityId(null);
		}
		setError(null);
		setFormSeq((n) => n + 1);
		if (trackerRef.current) trackerRef.current.clear(); // 已按服务端内容重渲染：旧草稿不再存在，脏标记必须同步归零（:99）
	}

	function openNew() {
		getApp().openModal({
			title: "新建设定",
			okText: "创建",
			bodyHTML: '<label>名称<input id="new-world-title"></label>',
			onOk: async (body) => {
				const res = await api("POST", "", {
					title: body.querySelector("#new-world-title").value,
					content: "",
				});
				if (trackerRef.current) trackerRef.current.clear();
				await load(res.entry.id);
			},
		});
	}

	function openModalDelete() {
		return async () => {
			if (!window.confirm("删除这条世界设定？")) return;
			await api("DELETE", `/${selectedRef.current.id}`);
			if (trackerRef.current) trackerRef.current.clear();
			await load(null);
		};
	}

	function onSearch(event) {
		worldQuery = event.target.value;
		setQuery(worldQuery);
		pagerRef.current.page = 1; // legacy :36 搜索后回第 1 页
	}

	function onPick(entry) {
		applySelected(entry);
	}

	function markDirty() {
		if (trackerRef.current) trackerRef.current.mark();
	}

	// 等值旧 show()（:102-108）：三重置＋守卫先注册后加载；错误态渲染 .workbench-error（:107）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 外壳以 key 重挂等价旧 show() 每次全量；此处按 route 变化重跑（直渲染/属性变更形态）
	useEffect(() => {
		routeRef.current = route;
		setMissingEntityId(null);
		setSelected(null);
		selectedRef.current = null;
		pagerRef.current.page = 1;
		installGuard();
		load(route.entityId).catch((e) => setError(e.message));
	}, [route.bookId, route.entityId, route.tab]);

	if (error) {
		return <div className="workbench-error">{error}</div>;
	}

	const pageItems = slice(filtered(), pagerRef.current);

	return (
		<div className="world-workspace">
			<aside className="world-index">
				<div className="character-roster-head">
					<div>
						<span className="workbench-kicker">WORLD BIBLE</span>
						<h2>设定目录</h2>
					</div>
					<button
						id="new-world-entry"
						type="button"
						className="btn btn-primary btn-small"
						onClick={openNew}
					>
						+ 新建
					</button>
				</div>
				<label className="roster-search">
					<span>⌕</span>
					<input
						id="world-search"
						value={query}
						placeholder="搜索设定"
						onChange={onSearch}
					/>
				</label>
				<div id="world-entry-list">
					{pageItems.map((entry) => (
						<button
							key={entry.id}
							type="button"
							data-world-id={entry.id}
							className={`world-entry-row${selected && entry.id === selected.id ? " active" : ""}`}
							onClick={() => onPick(entry)}
						>
							<strong>{entry.title}</strong>
							<span>{(entry.content || "").slice(0, 60) || "暂无内容"}</span>
						</button>
					))}
				</div>
				<div id="world-entry-pager">
					<ListPager st={pagerRef.current} onChange={forceRender} />
				</div>
			</aside>
			<section className="world-editor">
				{missingEntityId ? (
					missingHTML()
				) : selected ? (
					<form
						key={`world-form-${selected.id}-${formSeq}`}
						id="world-entry-form"
						onSubmit={(event) => {
							event.preventDefault();
							saveEntry().catch(() => {});
						}}
					>
						<div className="profile-sheet-head">
							<div>
								<span className="workbench-kicker">SETTING ENTRY</span>
								<h2>{selected.title}</h2>
							</div>
							<div>
								<button
									id="delete-world-entry"
									type="button"
									className="btn btn-ghost"
									onClick={openModalDelete()}
								>
									删除
								</button>
								<button type="submit" className="btn btn-primary">
									保存设定
								</button>
							</div>
						</div>
						<label>
							名称
							<input
								id="world-entry-title"
								defaultValue={selected.title}
								onInput={markDirty}
							/>
						</label>
						<label>
							详细设定
							<textarea
								id="world-entry-content"
								rows={24}
								defaultValue={selected.content || ""}
								onInput={markDirty}
							/>
						</label>
					</form>
				) : (
					<section className="workbench-empty">
						<h2>选择一条设定</h2>
						<p>在这里维护规则、地点、势力、物件与历史。</p>
					</section>
				)}
			</section>
		</div>
	);
}
