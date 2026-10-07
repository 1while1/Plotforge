// 书外页面的全局导航栏（书架/设置/个人中心/助手/专项工作台/时间线/作家卡/文风实验室/阅读精修）。
// 写作页（#/book/:id）有自己的 BookRail，这里不渲染。
// 栏是 fixed 定位；可见时给 body 加 has-app-rail，由 styles/app-pages.css 给页面让出左侧宽度。
// 只有路由带书 id 时才出现写作/大纲/人物/世界/台账/文风；不记「上次那本书」，避免指向已删的书。
import { useEffect, useState } from "react";
import { cn } from "../lib/cn.js";
import { resolveRoute } from "../lib/resolve-route.js";
import {
	activeClass,
	BOTTOM,
	itemClass,
	MODULES,
	RailLogo,
	TOP,
} from "./BookRail.jsx";

const WORKBENCH_SEG = {
	outline: "outline",
	characters: "characters",
	world: "world",
	state: "ledger",
};
const SEG_TO_KEY = Object.fromEntries(
	Object.entries(WORKBENCH_SEG).map(([k, v]) => [v, k]),
);
const KIND_TO_KEY = {
	timeline: "characters",
	cards: "cards",
	stylelab: "cards",
	read: "chapters",
};

function decode(s) {
	try {
		return decodeURIComponent(s);
	} catch (_e) {
		return "";
	}
}

// 纯函数：hash → { bookId, active } ；写作页与重定向返回 null（不显示本栏）
export function railContext(hash) {
	const h = hash || "#/";
	const route = resolveRoute(h);
	if (route.redirect || route.kind === "book") return null;
	const m = h.match(/^#\/book\/([^/?]+)/);
	const bookId = (m && decode(m[1])) || null;
	if (route.kind === "workbench") {
		const seg = h.match(/^#\/book\/[^/?]+\/workbench\/([^/?]+)/);
		return { bookId, active: (seg && SEG_TO_KEY[seg[1]]) || null };
	}
	return { bookId, active: KIND_TO_KEY[route.kind] || route.kind };
}

function hrefOf(item, bookId) {
	const id = encodeURIComponent(bookId);
	if (item.key === "chapters") return `#/book/${id}`;
	if (WORKBENCH_SEG[item.key])
		return `#/book/${id}/workbench/${WORKBENCH_SEG[item.key]}`;
	return item.href(bookId);
}

function needsBook(item) {
	return !!item.tab || item.key === "cards";
}

function useHash() {
	const [hash, setHash] = useState(() => window.location.hash || "#/");
	useEffect(() => {
		const sync = () => setHash(window.location.hash || "#/");
		window.addEventListener("hashchange", sync);
		window.addEventListener("popstate", sync);
		return () => {
			window.removeEventListener("hashchange", sync);
			window.removeEventListener("popstate", sync);
		};
	}, []);
	return hash;
}

export function AppRail() {
	const ctx = railContext(useHash());
	const visible = !!ctx;
	useEffect(() => {
		document.body.classList.toggle("has-app-rail", visible);
		return () => document.body.classList.remove("has-app-rail");
	}, [visible]);
	if (!ctx) return null;
	const render = (item) => {
		if (needsBook(item) && !ctx.bookId) return null;
		const Icon = item.icon;
		const on = ctx.active === item.key;
		return (
			<a
				key={item.key}
				data-slot="rail-item"
				data-rail={item.key}
				className={cn(itemClass, on && activeClass)}
				aria-current={on ? "page" : undefined}
				href={hrefOf(item, ctx.bookId)}
				title={item.title || item.label}
			>
				<Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
				<span>{item.label}</span>
			</a>
		);
	};
	const modules = MODULES.map(render).filter(Boolean);
	return (
		<nav id="app-rail" className="app-rail" aria-label="全局导航">
			<div
				data-slot="app-rail"
				className="flex h-full flex-col items-center gap-1 bg-rail py-3 font-ui"
			>
				<RailLogo />
				{TOP.map(render)}
				{modules.length > 0 && (
					<div className="my-2 h-px w-7 bg-white/10" aria-hidden="true" />
				)}
				{modules}
				<div className="mt-auto flex flex-col items-center gap-1">
					{BOTTOM.map(render)}
				</div>
			</div>
		</nav>
	);
}
