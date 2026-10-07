// Ctrl K 跳转面板＋快捷键一览＋全局快捷键分发。挂在 App 根里（对话框经 portal 落到 body）。
// 写作页的动作一律复用现有入口（按钮点击、chapterEditorApi），不另写一套保存/切章/定稿逻辑。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	chapterEditorApi,
	getEditorListModel,
} from "../components/ChapterEditorPanel.jsx";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "../components/ui/command.jsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog.jsx";
import { getApp } from "../lib/app-runtime.js";
import {
	getAppearance,
	setAppearance,
	subscribeAppearance,
} from "../lib/appearance.js";
import { adjacentChapterId, orderedChapters } from "../lib/chapter-order.js";
import { matchShortcut, SHORTCUTS, shortcutKeys } from "../lib/shortcuts.js";

const WORKBENCHES = [
	{ module: "outline", label: "大纲工作台" },
	{ module: "characters", label: "人物工作台" },
	{ module: "world", label: "世界观工作台" },
	{ module: "ledger", label: "故事台账工作台" },
];

function onBookPage() {
	const page = document.getElementById("page-book");
	return !!page && !page.classList.contains("hidden");
}

// 旧式弹窗（#modal-mask 等）开着时不抢键：作者可能正在弹窗里输入
function legacyModalOpen() {
	return !!document.querySelector(".modal-mask:not(.hidden)");
}

function click(id) {
	const el = document.getElementById(id);
	if (el && !el.disabled) {
		el.click();
		return true;
	}
	return false;
}

function toast(text) {
	getApp()?.toast?.(text);
}

// 写作页动作：键盘与面板共用
export const bookActions = {
	save: () => chapterEditorApi().saveChapter(),
	prevChapter: () => stepChapter(-1),
	nextChapter: () => stepChapter(1),
	lock: () => {
		const btn = document.getElementById("btn-lock-chapter");
		if (!getApp()?.state.currentChapterId || !btn) {
			toast("先在左侧选择一个章节");
			return;
		}
		// 快捷键只负责定稿；解除定稿影响向量索引，留给工具条按钮，避免误触
		if (btn.classList.contains("mode-on")) {
			toast("本章已定稿；要解除请点工具条上的「解除定稿」");
			return;
		}
		btn.click();
	},
	focus: () => click("btn-focus-mode"),
};

function stepChapter(offset) {
	const cid = getApp()?.state.currentChapterId;
	const id = adjacentChapterId(getEditorListModel(), cid, offset);
	if (id == null) {
		toast(
			cid
				? offset < 0
					? "已经是第一章"
					: "已经是最后一章"
				: "先在左侧选择一个章节",
		);
		return;
	}
	chapterEditorApi().selectChapter(id);
}

function currentBook() {
	return onBookPage() ? getApp()?.state.currentBook || null : null;
}

export function buildPaletteGroups({ book, chapters, books, theme }) {
	const groups = [];
	if (book) {
		const bid = encodeURIComponent(book.id);
		groups.push({
			heading: "本书操作",
			items: [
				{ id: "save", label: "保存本章", run: bookActions.save },
				{ id: "prevChapter", label: "上一章", run: bookActions.prevChapter },
				{ id: "nextChapter", label: "下一章", run: bookActions.nextChapter },
				{
					id: "new-chapter",
					label: "新建章节",
					run: () => click("btn-add-chapter"),
				},
				{ id: "lock", label: "定稿本章", run: bookActions.lock },
				{ id: "focus", label: "专注模式开/关", run: bookActions.focus },
				{
					id: "toggle-left",
					label: "收起/展开左侧栏",
					run: () => click("btn-toggle-left-panel"),
				},
				{
					id: "toggle-chat",
					label: "收起/展开写作助手",
					run: () => click("btn-toggle-chat-panel"),
				},
				{
					id: "focus-ai",
					label: "跳到 AI 输入框",
					run: () => document.getElementById("chat-text")?.focus(),
				},
			],
		});
		if (chapters.length) {
			groups.push({
				heading: "跳到章节",
				items: chapters.map((c) => ({
					id: `chapter-${c.id}`,
					label: c.title || `章节 ${c.id}`,
					hint: c.volumeTitle,
					keywords: [c.volumeTitle].filter(Boolean),
					run: () => chapterEditorApi().selectChapter(c.id),
				})),
			});
		}
		groups.push({
			heading: "本书页面",
			items: [
				...WORKBENCHES.map((w) => ({
					id: `wb-${w.module}`,
					label: w.label,
					// 经左栏里的入口链接跳转：它会记下返回位置，从工作台回来时还原到当前章
					run: () => {
						const link = document.querySelector(
							`#page-book [data-workbench="${w.module}"]`,
						);
						if (link) link.click();
						else window.location.hash = `#/book/${bid}/workbench/${w.module}`;
					},
				})),
				{
					id: "read",
					label: "阅读 / 精修",
					run: () => click("btn-open-read"),
				},
				{
					id: "cards",
					label: "作家卡（文风）",
					run: () => {
						window.location.hash = `#/book/${bid}/cards`;
					},
				},
			],
		});
	}
	groups.push({
		heading: "前往",
		items: [
			{
				id: "go-shelf",
				label: "书架",
				run: () => (window.location.hash = "#/"),
			},
			{
				id: "go-agent",
				label: "AI 助手",
				run: () => (window.location.hash = "#/agent"),
			},
			{
				id: "go-settings",
				label: "设置",
				run: () => (window.location.hash = "#/settings"),
			},
			{
				id: "go-profile",
				label: "个人中心",
				run: () => (window.location.hash = "#/profile"),
			},
		],
	});
	const others = (books || []).filter((b) => !book || b.id !== book.id);
	if (others.length) {
		groups.push({
			heading: "打开作品",
			items: others.map((b) => ({
				id: `book-${b.id}`,
				label: b.title || `作品 ${b.id}`,
				run: () =>
					(window.location.hash = `#/book/${encodeURIComponent(b.id)}`),
			})),
		});
	}
	groups.push({
		heading: "外观",
		items: [
			{ id: "theme-light", label: "亮色主题", on: theme === "light" },
			{ id: "theme-dark", label: "暗色主题", on: theme === "dark" },
			{ id: "theme-system", label: "主题跟随系统", on: theme === "system" },
		].map((t) => ({
			...t,
			run: () => setAppearance({ theme: t.id.slice(6) }),
		})),
	});
	groups.push({
		heading: "帮助",
		items: [{ id: "help", label: "快捷键一览" }],
	});
	return groups;
}

export function ShortcutsDialog({ open, onOpenChange }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>快捷键</DialogTitle>
					<DialogDescription>
						写作页的快捷键只在写作页生效；Mac 上 ⌘ 等同 Ctrl。
					</DialogDescription>
				</DialogHeader>
				<ul className="grid gap-1 text-[13px]">
					{SHORTCUTS.map((s) => (
						<li
							key={s.id}
							className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 odd:bg-surface-2"
						>
							<span>{s.label}</span>
							<kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-subtle">
								{s.keys}
							</kbd>
						</li>
					))}
				</ul>
			</DialogContent>
		</Dialog>
	);
}

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [books, setBooks] = useState([]);
	const [snapshot, setSnapshot] = useState({ book: null, chapters: [] });
	const theme = useSyncExternalStore(
		subscribeAppearance,
		() => getAppearance().theme,
		() => "light",
	);
	const openRef = useRef(false);
	openRef.current = open || helpOpen;

	function openPalette() {
		const book = currentBook();
		setSnapshot({
			book,
			chapters: book ? orderedChapters(getEditorListModel()) : [],
		});
		setOpen(true);
		getApp()
			?.api?.("GET", "/api/books")
			.then((r) => setBooks(Array.isArray(r?.books) ? r.books : []))
			.catch(() => {
				/* 作品列表拉不到只少一组跳转项 */
			});
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: 监听挂一次，状态经 ref 与模块函数实时读取
	useEffect(() => {
		const onKeydown = (e) => {
			const id = matchShortcut(e);
			if (!id || openRef.current || legacyModalOpen()) return;
			if (id === "palette") {
				e.preventDefault();
				openPalette();
				return;
			}
			if (id === "help") {
				e.preventDefault();
				setHelpOpen(true);
				return;
			}
			if (!onBookPage()) return;
			e.preventDefault();
			bookActions[id]?.();
		};
		document.addEventListener("keydown", onKeydown);
		return () => document.removeEventListener("keydown", onKeydown);
	}, []);

	const groups = buildPaletteGroups({ ...snapshot, books, theme });
	const run = (item) => {
		setOpen(false);
		if (item.id === "help") {
			setHelpOpen(true);
			return;
		}
		// 等对话框关闭、焦点还回原处后再执行，避免动作里的 focus() 被抢回
		setTimeout(() => item.run?.(), 0);
	};
	return (
		<>
			<CommandDialog title="跳转" open={open} onOpenChange={setOpen}>
				<CommandInput placeholder="搜索章节、页面或操作…" />
				<CommandList>
					<CommandEmpty>没有匹配的结果</CommandEmpty>
					{groups.map((g) => (
						<CommandGroup key={g.heading} heading={g.heading}>
							{g.items.map((item) => (
								<CommandItem
									key={item.id}
									value={`${g.heading} ${item.label} ${item.id}`}
									keywords={item.keywords}
									onSelect={() => run(item)}
								>
									<span className="min-w-0 truncate">{item.label}</span>
									{item.hint ? (
										<span className="truncate text-[12px] text-faint">
											{item.hint}
										</span>
									) : null}
									{item.on ? (
										<span className="text-[12px] text-primary">当前</span>
									) : null}
									{shortcutKeys(item.id) ? (
										<CommandShortcut>{shortcutKeys(item.id)}</CommandShortcut>
									) : null}
								</CommandItem>
							))}
						</CommandGroup>
					))}
				</CommandList>
			</CommandDialog>
			<ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
		</>
	);
}
