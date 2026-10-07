// 章节栏（样稿 B）的目录外围：状态筛选、行尾字数＋进度条、卷字数、底部全书字数与每章目标。
// 目录行本身仍由 ChapterEditorPanel 渲染，这里只放与目录模型同源的纯展示件。

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.jsx";
import {
	CHAPTER_TARGET_PRESETS,
	setChapterTarget,
} from "../lib/writing-prefs.js";

export const CHAPTER_FILTERS = [
	{ id: "all", label: "全部" },
	{ id: "draft", label: "草稿" },
	{ id: "locked", label: "定稿" },
];

// 目录接口只给 content_length（含空白的字符数），与编辑器「去空白」计数略有出入，行尾只作约数展示
export function chapterWords(ch) {
	return Math.max(0, Number(ch?.content_length) || 0);
}

export function formatWordCount(n) {
	const v = Number(n) || 0;
	if (v <= 0) return "—";
	if (v < 1000) return String(v);
	return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}K`;
}

export function matchesChapterFilter(ch, filter) {
	if (filter === "draft") return !ch.locked;
	if (filter === "locked") return !!ch.locked;
	return true;
}

export function ChapterFilterBar({ chapters, filter, onChange }) {
	if (!chapters.length) return null;
	const locked = chapters.filter((c) => c.locked).length;
	const counts = {
		all: chapters.length,
		draft: chapters.length - locked,
		locked,
	};
	return CHAPTER_FILTERS.map((f) => (
		<button
			key={f.id}
			type="button"
			className={`chapter-filter-chip${filter === f.id ? " on" : ""}`}
			aria-pressed={filter === f.id}
			onClick={() => onChange(f.id)}
		>
			{f.label}
			{f.id === "all" ? null : <span className="n">{counts[f.id]}</span>}
		</button>
	));
}

export function ChapterRowMeta({ ch, target }) {
	const words = chapterWords(ch);
	const pct = ch.locked
		? 100
		: Math.min(100, Math.round((words / Math.max(1, target)) * 100));
	return (
		<span
			className={`ch-meta${ch.locked ? " done" : ""}`}
			title={`约 ${words.toLocaleString("zh-CN")} 字 / 目标 ${target.toLocaleString("zh-CN")} 字`}
		>
			<span className="ch-words">{formatWordCount(words)}</span>
			<span className="ch-progress" aria-hidden="true">
				<i className="ch-progress-fill" style={{ width: `${pct}%` }}></i>
			</span>
		</span>
	);
}

export function ChapterFoot({ chapters, bookId, target }) {
	const total = chapters.reduce((sum, ch) => sum + chapterWords(ch), 0);
	return (
		<>
			<span>全书约 {total.toLocaleString("zh-CN")} 字</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="chapter-target-btn"
						title="每章字数目标：决定章节行尾进度条与编辑区进度（只存本机）"
					>
						每章目标 {target.toLocaleString("zh-CN")}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" side="top">
					<DropdownMenuLabel>每章字数目标</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={String(target)}
						onValueChange={(v) => setChapterTarget(bookId, v)}
					>
						{CHAPTER_TARGET_PRESETS.map((n) => (
							<DropdownMenuRadioItem key={n} value={String(n)}>
								{n.toLocaleString("zh-CN")} 字
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
