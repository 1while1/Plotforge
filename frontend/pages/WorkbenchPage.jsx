// S5-4（Plan §2.4.2；范式 P＋判定 C 旧名桥）：工作台外壳整页迁 React。
// public/legacy/workbench-shell.js（217 行）由本页承接并 git rm 全退役；旧名
// window.WorkbenchShell = { show, parse } 的守卫式供给面已随 P6-2 桥退役——AppRouter 改模块直取本页
// mountWorkbenchPage（AppRouter.jsx:38 import／:73 调用；S5-3 交付的 AppRouter.jsx:57 经桥消费点即此退役面；S4-8 window.RewriteCurvePanel「旧名之选」
// 同款命名裁量；AppRouter.test.jsx:74 的委托形状断言零改动）。
// 等值口径（逐条对 legacy 行号）：
//   · labels（:5-10）→ lib 的 WORKBENCH_LABELS/WORKBENCH_MODULES（parse :12-24 已内部化）。
//   · href（:27）／rememberEditor（:30-33，旧键 novel-editor-return:<bookId> 仅在缺省时写）／
//     bindReturn 三态（:42-59：有记录→WorkspaceState.href(target)＋文案＋preventDefault＋restore；
//     无记录→旧键兜底 `#/book/<id>`＋无 onclick）。
//   · renderPlaceholder（:61-72）等值保留（静态 import 恒有面板，React 下结构性不可达）。
//   · handoff（:74-84）改为直接组合四面板组件（本片新契约：面板重挂由 key=<module|entityId|tab>
//     承接＝旧 show() 每次重挂重拉）。
//   · 任务入口（:86-187）：fmtTime／铃铛 pop toggle＋看过清红点＋文档点击外部关闭／Toast 5 秒后 220ms
//     收进铃铛（clearTimeout 单例）／badge 经 runStatus.taskBadge 缺失回退裸 status／
//     link href=latest.route||`#/book/<bookId>`、无记录 hidden／lastToastKey 模块级（跨 show 不重弹）。
//   · show（:189-214）：parse 为 null→location.hash='#/'；标题=labels[module]；#workbench-content
//     先 loading；GET /api/books/<id> → App.state.currentBook＋书题 → handoff → 任务入口；
//     catch→.workbench-error＝escapeHtml(error.message)。
// 已知对照差异（无行为回归）：文档级点击监听改为 effect 注册/清理（旧件 dataset.bound 幂等只在同一
// 文档绑一次；React 版卸载即解绑，不留残留监听）；畸形百分号 hash 走 parseWorkbenchRoute 的 null →
// location.hash='#/'（旧件 decodeURIComponent 抛 URIError 使 show 同步抛出、页面白屏；无测试锚定）。

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CharacterWorkbenchPanel } from "../components/CharacterWorkbenchPanel.jsx";
import { LedgerWorkbenchPanel } from "../components/LedgerWorkbenchPanel.jsx";
import { OutlineWorkbenchPanel } from "../components/OutlineWorkbenchPanel.jsx";
import WorldWorkbenchPanel from "../components/WorldWorkbenchPanel.jsx";
import { getApp } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import {
	getWorkspaceState,
	parseWorkbenchRoute,
	WORKBENCH_LABELS,
	WORKBENCH_MODULES,
} from "../lib/workspace-state.js";

const PLACEHOLDER_NOTES = {
	characters: "集中管理人物档案、别名、关系、时间线与人物专属顾问。",
	ledger: "审阅事实提案、追踪状态变化、伏笔与故事线。",
	outline: "从全书到卷章组织结构，并检查写作偏离。",
	world: "用分类与条目维护世界规则、地点、势力和设定。",
};

// lastToastKey 模块级（legacy :90）：同一内容不重复弹 Toast（模块间切换不打扰）
let lastToastKey = null;
let toastTimer = null;
let visit = 0;

// 测试缝：模块级 Toast 去重键与单例定时器复位（产品代码不调用）
export function resetWorkbenchShellState() {
	lastToastKey = null;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = null;
}

function fmtTime(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso || "时间未记录";
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function href(route, module) {
	return `#/book/${encodeURIComponent(route.bookId)}/workbench/${module}`;
}

function rememberEditor(route) {
	const key = `novel-editor-return:${route.bookId}`;
	// 幂等：仅在缺省时写（legacy :30-33）；等值旧 show() 的「parse → rememberEditor → bindReturn」序
	try {
		if (!sessionStorage.getItem(key))
			sessionStorage.setItem(key, `#/book/${encodeURIComponent(route.bookId)}`);
	} catch (_e) {
		/* 存储不可用：不影响导航 */
	}
}

function renderPlaceholder(module) {
	return (
		<section className="workbench-empty">
			<span className="workbench-kicker">专项编辑空间</span>
			<h2>{WORKBENCH_LABELS[module]}</h2>
			<p>{PLACEHOLDER_NOTES[module]}</p>
			<div className="workbench-empty-card">
				模块正在载入；此页面不会挤占章节写作区。
			</div>
		</section>
	);
}

function WorkbenchPanel({ route }) {
	const key = `${route.module}|${route.entityId || ""}|${route.tab || ""}`;
	if (route.module === "characters")
		return <CharacterWorkbenchPanel key={key} route={route} />;
	if (route.module === "ledger")
		return <LedgerWorkbenchPanel key={key} route={route} />;
	if (route.module === "outline")
		return <OutlineWorkbenchPanel key={key} route={route} />;
	if (route.module === "world")
		return <WorldWorkbenchPanel key={key} route={route} />;
	return renderPlaceholder(route.module);
}

export default function WorkbenchPage({ hash }) {
	const route = parseWorkbenchRoute(hash);
	const [book, setBook] = useState(null);
	const [error, setError] = useState(null);
	const [notify, setNotify] = useState({ title: "", body: "" });
	const [toastPhase, setToastPhase] = useState("hidden");
	const [bellHidden, setBellHidden] = useState(true);
	const [dotHidden, setDotHidden] = useState(true);
	const [popHidden, setPopHidden] = useState(true);
	const [link, setLink] = useState({ href: "#", hidden: true });
	const popRef = useRef(null);
	const bellRef = useRef(null);

	// 返回锚三态（legacy :42-59）：同步计算，首帧即得 href/文案（与旧件同步绑返回锚一致）
	let returnAnchor = { href: "#/", text: "← 返回写作页", target: null };
	if (route) {
		rememberEditor(route);
		const ws = getWorkspaceState();
		const target = ws ? ws.readReturn(route.bookId) : null;
		if (target && ws) {
			returnAnchor = {
				href: ws.href(target),
				text: target.workspace === "agent" ? "← 返回 Agent 台" : "← 返回写作页",
				target,
			};
		} else {
			let legacy = null;
			try {
				legacy = sessionStorage.getItem(`novel-editor-return:${route.bookId}`);
			} catch (_e) {
				legacy = null;
			}
			returnAnchor = {
				href: legacy || `#/book/${encodeURIComponent(route.bookId)}`,
				text: "← 返回写作页",
				target: null,
			};
		}
	}

	function showWorkbenchToast(model) {
		if (!document.getElementById("workbench-toast")) return;
		setNotify(model);
		setToastPhase("shown");
		setDotHidden(true);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			setToastPhase("closing");
			toastTimer = setTimeout(() => {
				setToastPhase("hidden");
				setDotHidden(false); // 收进铃铛：红点提示有条通知（legacy :124）
			}, 220);
		}, 5000);
	}

	async function renderTaskEntry(rt, loadedBook) {
		let latest = null;
		try {
			const data = await getApp().api(
				"GET",
				`/api/resources?type=task&bookId=${encodeURIComponent(rt.bookId)}&limit=1`,
			);
			latest = data?.items || [];
			latest = latest[0] || null;
		} catch (_e) {
			latest = null;
		}
		const bookTitle = loadedBook?.title || `#${rt.bookId}`;
		let model;
		if (latest) {
			const badge = runStatus?.taskBadge
				? runStatus.taskBadge({
						status: latest.status,
						reason: latest.meta?.reason,
					})
				: latest.status;
			model = {
				title: `${badge} · ${latest.title || latest.id}`,
				body: `《${bookTitle}》最近一次任务，更新于 ${fmtTime(latest.updatedAt)}。完整任务卡在写作页对话区上方。`,
			};
		} else {
			model = {
				title: "没有运行记录",
				body: `《${bookTitle}》还没有运行记录：这里不会臆造完成状态。`,
			};
		}
		setBellHidden(false);
		setNotify(model);
		// 下一步入口：有运行记录时给出可点链接（任务自带 route 优先，否则回写作页）（legacy :174-180）
		const target = latest ? latest.route || `#/book/${rt.bookId}` : "";
		setLink({ href: target || "#", hidden: !target });
		const key = `${rt.bookId}|${latest ? `${latest.id}|${latest.updatedAt}|${latest.status}` : "none"}`;
		if (key !== lastToastKey) {
			lastToastKey = key;
			showWorkbenchToast(model);
		}
		return model;
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: 等值旧 show(hash)——hash 变即整次重跑（route 由 hash 派生）
	useEffect(() => {
		if (!route) {
			window.location.hash = "#/";
			return;
		}
		let alive = true;
		getApp()
			.api("GET", `/api/books/${encodeURIComponent(route.bookId)}`)
			.then((data) => {
				if (!alive) return;
				getApp().state.currentBook = data.book;
				setBook(data.book);
				renderTaskEntry(route, data.book).catch(() => {});
			})
			.catch((err) => {
				if (!alive) return;
				setError(err.message);
			});
		return () => {
			alive = false;
		};
	}, [hash]);

	// 铃铛交互（legacy :129-145）：点击 toggle 弹层并清红点；文档点击外部关闭
	useEffect(() => {
		function onDocClick(ev) {
			const pop = popRef.current;
			const bell = bellRef.current;
			if (!pop || pop.classList.contains("hidden")) return;
			if (pop.contains(ev.target) || bell?.contains(ev.target)) return;
			setPopHidden(true);
		}
		document.addEventListener("click", onDocClick);
		return () => document.removeEventListener("click", onDocClick);
	}, []);

	function toggleBell(ev) {
		if (ev?.stopPropagation) ev.stopPropagation();
		setPopHidden((hidden) => !hidden);
		setDotHidden(true); // 看过即清红点（legacy :138）
	}

	const content = error ? (
		<div className="workbench-error">{error}</div>
	) : book ? (
		<WorkbenchPanel route={route} />
	) : (
		<div className="workbench-loading">正在打开工作台…</div>
	);

	return (
		<>
			<header className="topbar workbench-topbar">
				<div className="topbar-left">
					<a
						id="workbench-return"
						href={returnAnchor.href}
						className="btn btn-ghost"
						onClick={
							returnAnchor.target
								? (ev) => {
										if (ev?.preventDefault) ev.preventDefault();
										return getWorkspaceState().restore(returnAnchor.target); // 校验目标后还原同一章/同一会话
									}
								: undefined
						}
					>
						{returnAnchor.text}
					</a>
					<div>
						<span id="workbench-book-title" className="workbench-book-label">
							{book ? book.title : ""}
						</span>
						<h1 id="workbench-title" className="book-title">
							{route ? WORKBENCH_LABELS[route.module] : "创作工作台"}
						</h1>
					</div>
				</div>
				<nav
					id="workbench-nav"
					className="workbench-nav"
					aria-label="专项工作台导航"
				>
					{route
						? WORKBENCH_MODULES.map((module) => (
								<a
									key={module}
									className={`workbench-nav-link${module === route.module ? " active" : ""}`}
									href={href(route, module)}
								>
									{WORKBENCH_LABELS[module]}
								</a>
							))
						: null}
				</nav>
				<span className="notify-wrap">
					<button
						id="workbench-notify"
						type="button"
						ref={bellRef}
						className={`btn btn-ghost notify-bell${bellHidden ? " hidden" : ""}`}
						title="任务通知（最近一条运行记录）"
						onClick={toggleBell}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							width="15"
							height="15"
							aria-hidden="true"
						>
							<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
							<path d="M13.7 21a2 2 0 0 1-3.4 0" />
						</svg>
						<span
							id="workbench-notify-dot"
							className={`notify-dot${dotHidden ? " hidden" : ""}`}
						/>
					</button>
					<div
						id="workbench-notify-pop"
						ref={popRef}
						className={`notify-pop${popHidden ? " hidden" : ""}`}
					>
						<div id="workbench-notify-title" className="notify-pop-title">
							{notify.title}
						</div>
						<div id="workbench-notify-body" className="notify-pop-body">
							{notify.body}
						</div>
						<a
							id="workbench-notify-link"
							className={`notify-link${link.hidden ? " hidden" : ""}`}
							href={link.href}
						>
							查看完整任务卡 →
						</a>
					</div>
				</span>
			</header>
			<div
				id="workbench-toast"
				className={`wb-toast${toastPhase === "hidden" ? " hidden" : toastPhase === "closing" ? " closing" : ""}`}
				role="status"
			>
				<div className="wb-toast-title">{notify.title}</div>
				<div className="wb-toast-body">{notify.body}</div>
			</div>
			<main id="workbench-content" className="special-workbench">
				{content}
			</main>
		</>
	);
}

// 挂载（AppRouter.jsx:38 import／:73 直调 mountWorkbenchPage；P6-2 前经 window.WorkbenchShell 旧名桥）：
// 目标 #page-workbench 缺失即 no-op；root 缓存 el.__mozhenWorkbenchRoot（ReadPage
// el.__mozhenReadRoot 先例），key=visit++ 每次 show 重挂重拉——等值旧 show() 每次全量重渲染重拉。
export function mountWorkbenchPage(hash) {
	const el = document.getElementById("page-workbench");
	if (!el) return;
	let cached = el.__mozhenWorkbenchRoot;
	if (!cached) {
		cached = { el, root: createRoot(el) };
		el.__mozhenWorkbenchRoot = cached;
	}
	visit += 1;
	cached.root.render(<WorkbenchPage key={visit} hash={hash} />);
}
