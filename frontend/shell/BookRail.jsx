// 写作页全局导航栏（样稿 B 最左一列）。挂在 index.html 的 #book-rail 上，由 BookShell.mount 渲染。
// 「写作/大纲/人物/世界/台账」是左栏标签的就地切换（经 onSelectTab 交给 BookShell），
// 其余项是整页跳转。当前高亮跟随左栏 .tab.active，用 MutationObserver 感知，
// 因为标签切换由 ChapterEditorPanel / SidebarConfigDialog 命令式改 class，不经 React。
import {
	BookOpen,
	CircleUser,
	Globe,
	ListTree,
	MessagesSquare,
	Palette,
	PenLine,
	Settings,
	Table2,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cn } from "../lib/cn.js";

// 书外页面（AppRail）复用同一份清单：tab 项在那里换成 workbench 整页链接，见 AppRail.jsx
export const TOP = [
	{ key: "shelf", label: "书架", icon: BookOpen, href: () => "#/" },
	{ key: "chapters", label: "写作", icon: PenLine, tab: "chapters" },
	{
		key: "agent",
		label: "助手",
		icon: MessagesSquare,
		href: () => "#/agent",
	},
];
export const MODULES = [
	{ key: "outline", label: "大纲", icon: ListTree, tab: "outline" },
	{ key: "characters", label: "人物", icon: Users, tab: "characters" },
	{ key: "world", label: "世界", icon: Globe, tab: "world" },
	{ key: "state", label: "台账", icon: Table2, tab: "state" },
	{
		key: "cards",
		label: "文风",
		icon: Palette,
		href: (bookId) => `#/book/${encodeURIComponent(bookId)}/cards`,
		title: "作家卡：文风、范文与本书用卡",
	},
];
export const BOTTOM = [
	{ key: "settings", label: "设置", icon: Settings, href: () => "#/settings" },
	{
		key: "profile",
		label: "个人",
		icon: CircleUser,
		href: () => "#/profile",
		title: "个人中心：本书提示词 / 作家卡 / 错题库",
	},
];

// 「调整侧栏」隐藏某模块时 SidebarConfigDialog 给对应 .tab 写 display:none，导航栏同步隐去该项
function readShellState() {
	const active = document.querySelector("#panel-left .tab.active");
	const bench = document.getElementById("book-workbench");
	const hidden = Array.from(
		document.querySelectorAll("#panel-left .tab[data-tab]"),
	)
		.filter((t) => t.style.display === "none")
		.map((t) => t.getAttribute("data-tab"))
		.join(",");
	return {
		tab: active ? active.getAttribute("data-tab") : null,
		leftCollapsed: !!bench && bench.classList.contains("left-collapsed"),
		hidden,
	};
}

function useShellState() {
	const [state, setState] = useState(readShellState);
	useEffect(() => {
		const sync = () => {
			const next = readShellState();
			setState((prev) =>
				prev.tab === next.tab &&
				prev.leftCollapsed === next.leftCollapsed &&
				prev.hidden === next.hidden
					? prev
					: next,
			);
		};
		const observer = new MutationObserver(sync);
		const tabs = document.querySelector("#panel-left .tabs");
		const bench = document.getElementById("book-workbench");
		if (tabs)
			observer.observe(tabs, {
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "style"],
			});
		if (bench)
			observer.observe(bench, { attributes: true, attributeFilter: ["class"] });
		sync();
		return () => observer.disconnect();
	}, []);
	return state;
}

export const itemClass =
	"flex w-11 flex-col items-center gap-0.5 rounded-[10px] pt-[7px] pb-[5px] text-[11px] leading-tight text-rail-foreground no-underline transition-colors hover:bg-rail-hover hover:text-[#e6eaee] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright";
export const activeClass =
	"bg-rail-active text-white shadow-[inset_2px_0_0_var(--mz-accent-bright)]";

function RailItem({ item, bookId, shell, onSelectTab }) {
	const Icon = item.icon;
	const body = (
		<>
			<Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
			<span>{item.label}</span>
		</>
	);
	if (item.tab) {
		if (shell.hidden.split(",").includes(item.tab)) return null;
		const on = shell.tab === item.tab;
		return (
			<button
				type="button"
				data-slot="rail-item"
				data-rail={item.key}
				className={cn(itemClass, on && activeClass)}
				aria-pressed={on}
				title={
					on && !shell.leftCollapsed
						? `${item.label}（再点一次收起侧栏）`
						: item.title || item.label
				}
				onClick={() => onSelectTab(item.tab)}
			>
				{body}
			</button>
		);
	}
	return (
		<a
			data-slot="rail-item"
			data-rail={item.key}
			className={itemClass}
			href={item.href(bookId)}
			title={item.title || item.label}
		>
			{body}
		</a>
	);
}

export function RailLogo() {
	return (
		<a
			href="#/"
			data-slot="rail-logo"
			className="mb-3.5 grid size-[34px] place-items-center rounded-[9px] bg-primary text-[15px] font-bold text-primary-foreground no-underline"
			title="墨砚 · 返回书架"
		>
			砚
		</a>
	);
}

export function BookRail({ bookId, onSelectTab }) {
	const shell = useShellState();
	const render = (item) => (
		<RailItem
			key={item.key}
			item={item}
			bookId={bookId}
			shell={shell}
			onSelectTab={onSelectTab}
		/>
	);
	return (
		<div
			data-slot="book-rail"
			className="flex h-full flex-col items-center gap-1 bg-rail py-3 font-ui"
		>
			<RailLogo />
			{TOP.map(render)}
			<div className="my-2 h-px w-7 bg-white/10" aria-hidden="true" />
			{MODULES.map(render)}
			<div className="mt-auto flex flex-col items-center gap-1">
				{BOTTOM.map(render)}
			</div>
		</div>
	);
}

// 幂等挂载：root 缓存在宿主元素上；每次进书重渲染（bookId 变化影响文风链接）。
export function mountBookRail({ bookId, onSelectTab }) {
	const host = document.getElementById("book-rail");
	if (!host) return false;
	let root = host.__mozhenRailRoot;
	if (!root) {
		root = createRoot(host);
		host.__mozhenRailRoot = root;
	}
	root.render(<BookRail bookId={bookId} onSelectTab={onSelectTab} />);
	return true;
}
