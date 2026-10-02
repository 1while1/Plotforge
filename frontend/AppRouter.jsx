// S5-3（Plan §2.4.10）：React Router 移交本体——public/legacy/app.js:119-223 route() 的
// 显隐/委托语义 ＋ :698-730 hashchange 导航守卫，换成 HashRouter ＋ 受控 <Routes> ＋ 守卫门。
//
// 设计要点（与 legacy 逐字等值）：
// 1) 显隐：每次进入路由先对 10 个 #page-* 无守卫 classList.add('hidden')，再显示目标
//    （等值 :121-123）；兜底重定向用 `location.hash='#/'`（push 语义，禁 replace）。
// 2) 守卫门：commit 前跑 WorkspaceState.beforeNavigate({from,to,retry,discard})，
//    放行才 noteDeparture(from,to) 并提交渲染；失败回退 `location.hash=from`
//    （页面从未切换，目标路由从不渲染/委托从不被调，等值 :726-727）。
//    初次 mount 直接提交（等值 :730 route() 不带守卫）。
// 3) 竞态令牌：守卫异步期间 hash 再变时，迟到结果按序号丢弃——React 异步化后新增的
//    必要保护，不改对外可见行为。
// 4) 双事件订阅 hashchange＋popstate（双保险，避免依赖 HashRouter 对 location.hash 赋值的感知）。
// 5) 加载期副作用承接（等值 book.js:136/:168）：挂载时执行一次 bindShellEvents()
//    （内部含 updateAgentReturnLink），保证直接落在 Agent 台时返回写作页链接可见。
// 6) 一级路由表 /、/profile、/settings、/agent、/book/*、*；/book/* 内部经 resolveRoute
//    二级分支（workbench/timeline/cards/stylelab/read/book 本体）。
// 7) 壳内不渲染任何可见 UI（RouteEffect 恒 null）——#page-* 静态壳由命令式显隐治理，
//    React 子树只做判定与委托（行为零变化，P4 红线 5）。
import { useEffect, useMemo, useRef, useState } from "react";
import { HashRouter, Route, Routes } from "react-router";
// P6-2（Plan §2.5-D5）：10 条委托与守卫全部改**模块直取**（去 window.* 桥）——参数与调用序逐字；
// 「目标缺失 no-op」改由「模块恒在」承接（legacy `if (window.X)` 守卫的不可达差异，见台账备案）。
import { showAgentWorkspace } from "./components/AgentWorkspace.jsx";
import { mountTimelineFullPage } from "./components/CharacterTimelinePanel.jsx";
import { resolveRoute } from "./lib/resolve-route.js";
import { getWorkspaceState } from "./lib/workspace-state.js";
import {
	bindShellEvents,
	mount as mountBookShell,
} from "./pages/BookShell.jsx";
import { mount as mountCards } from "./pages/CardsPage.jsx";
import { mount as mountProfile } from "./pages/ProfilePage.jsx";
import { mount as mountReadPage } from "./pages/ReadPage.jsx";
import { mount as mountSettings } from "./pages/SettingsPage.jsx";
import { mount as mountShelf } from "./pages/ShelfPage.jsx";
import { mount as mountStyleLab } from "./pages/StyleLabPage.jsx";
import { mountWorkbenchPage } from "./pages/WorkbenchPage.jsx";

const PAGE_IDS = [
	"shelf",
	"book",
	"workbench",
	"settings",
	"agent",
	"timeline",
	"read",
	"stylelab",
	"cards",
	"profile",
];

function currentHash() {
	return window.location.hash || "#/";
}

function hideAllPages() {
	for (const p of PAGE_IDS) {
		const el = document.getElementById(`page-${p}`);
		if (el) el.classList.add("hidden");
	}
}

function showPage(id) {
	const el = document.getElementById(id);
	if (el) el.classList.remove("hidden");
}

// 委托面（Plan §2.1.D，逐字参数；P6-2 起为模块直取——挂载件自身对目标容器缺失仍 no-op）
function runDelegate(route) {
	switch (route.kind) {
		case "workbench":
			mountWorkbenchPage(route.rawHash);
			break;
		case "timeline":
			mountTimelineFullPage(route.bookId, route.characterId);
			break;
		case "cards":
			mountCards(route.bookId);
			break;
		case "stylelab":
			mountStyleLab(route.bookId);
			break;
		case "read":
			mountReadPage(route.bookId, route.chapterId);
			break;
		case "book":
			// S5-3 起 #/book/:id 由 React 写作页壳承接（legacy :195 BookPage.show 的等价替换）
			mountBookShell(route.bookId);
			break;
		case "profile":
			mountProfile();
			break;
		case "settings":
			mountSettings();
			break;
		case "agent":
			showAgentWorkspace();
			break;
		case "shelf":
			mountShelf();
			break;
		default:
			break;
	}
}

function applyRoute(route) {
	hideAllPages();
	if (route.redirect) {
		window.location.hash = route.redirect; // push 语义（等值 :218）
		return;
	}
	if (route.pageId) showPage(route.pageId);
	runDelegate(route);
}

// committed hash → 受控 location 对象（HashRouter parsePath 语义：无前导斜杠补 '/'，
// query 进 search；pathname 保持编码原样供 /book/* splat 匹配）
function hashToLocation(hash) {
	const h = hash || "#/";
	const body = h.startsWith("#") ? h.slice(1) : h;
	const qIdx = body.indexOf("?");
	const pathPart = qIdx === -1 ? body : body.slice(0, qIdx);
	const search = qIdx === -1 ? "" : body.slice(qIdx);
	let pathname = pathPart === "" ? "/" : pathPart;
	if (!pathname.startsWith("/")) pathname = `/${pathname}`;
	return { pathname, search, hash: "", state: null, key: "s5-3-committed" };
}

function guardNavigation(to, from) {
	// P6-2：守卫单例直取（等值旧名桥——真实浏览器里该名恒由桥供给，故「恒被咨询」语义不变）
	return getWorkspaceState().beforeNavigate({
		from: from,
		to: to,
		retry: () => {
			window.location.hash = to;
		},
		discard: () => {
			window.location.hash = to;
		},
	});
}

function RouteEffect({ rawHash: h }) {
	useEffect(() => {
		applyRoute(resolveRoute(h));
	}, [h]);
	return null;
}

export default function AppRouter() {
	const [committed, setCommitted] = useState(currentHash);
	const committedRef = useRef(committed);
	const tokenRef = useRef(0);
	const pendingRef = useRef(null);

	useEffect(() => {
		const onChange = () => {
			const to = currentHash();
			const from = committedRef.current;
			if (from === to) {
				pendingRef.current = null;
				// 整改 R1（Review-S5-3 F1）：回退到已提交值＝作废在飞守卫（token 自增）。
				// 否则守卫 pending 中按后退回到 from 后，迟到的 canLeave=true 仍会提交旧目标 to，
				// 造成 URL 与可见页持久不一致；legacy `route()`（:714-724）每次重读 location.hash、
				// 页面恒随 URL，故此处丢弃迟到结果＝等值实现。
				tokenRef.current += 1;
				return; // 等值 :718 短路（同 hash 不重问守卫、不重复委托）
			}
			// 同一目标的重复事件（hashchange＋popstate 双订阅 / jsdom 双发）吸收：
			// 对外可见行为不变（legacy 同 hash 不重问守卫，只问一次）
			if (pendingRef.current === to) return;
			pendingRef.current = to;
			const token = tokenRef.current + 1;
			tokenRef.current = token;
			guardNavigation(to, from).then((canLeave) => {
				if (token !== tokenRef.current) return; // 竞态令牌：迟到结果丢弃
				pendingRef.current = null;
				if (canLeave) {
					getWorkspaceState().noteDeparture(from, to);
					committedRef.current = to;
					setCommitted(to);
					return;
				}
				window.location.hash = from; // 回退：页面从未切换（等值 :726-727）
			});
		};
		window.addEventListener("hashchange", onChange);
		window.addEventListener("popstate", onChange);
		// 加载期副作用承接：book.js:168 bindShellEvents()（含 updateAgentReturnLink）——P6-2 模块直取
		bindShellEvents();
		return () => {
			window.removeEventListener("hashchange", onChange);
			window.removeEventListener("popstate", onChange);
		};
	}, []);

	const location = useMemo(() => hashToLocation(committed), [committed]);

	return (
		<HashRouter>
			<Routes location={location}>
				<Route path="/" element={<RouteEffect rawHash={committed} />} />
				<Route path="/profile" element={<RouteEffect rawHash={committed} />} />
				<Route path="/settings" element={<RouteEffect rawHash={committed} />} />
				<Route path="/agent" element={<RouteEffect rawHash={committed} />} />
				<Route path="/book/*" element={<RouteEffect rawHash={committed} />} />
				<Route path="*" element={<RouteEffect rawHash={committed} />} />
			</Routes>
		</HashRouter>
	);
}
