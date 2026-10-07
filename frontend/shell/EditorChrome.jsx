// 编辑区（样稿 B）的外围展示件：状态徽章＋字数进度、卷/章眉题、外观菜单（主题/主色/行宽/正文字体）。
// 都只读控制器镜像出来的数据；正文三输入仍是非受控节点，由 ChapterEditorPanel 命令式读写。
import { Type } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.jsx";
import { useAppearance } from "../hooks/use-appearance.js";
import { useWritingPrefs } from "../hooks/use-writing-prefs.js";
import { ACCENTS, READ_FONTS, READ_WIDTHS, THEMES } from "../lib/appearance.js";
import {
	getContinuePreview,
	subscribeContinuePreview,
} from "../lib/continue-preview.js";
import { getChapterTarget } from "../lib/writing-prefs.js";

function useEditorMeta(controller) {
	return useSyncExternalStore(
		controller.subscribeEditorMeta,
		controller.getEditorMeta,
		controller.getEditorMeta,
	);
}

export function chapterStatus(meta) {
	if (meta.relock) return { key: "relock", label: "待重定稿" };
	if (meta.locked) return { key: "locked", label: "定稿" };
	return { key: "draft", label: "草稿" };
}

export function EditorMeta({ controller }) {
	const meta = useEditorMeta(controller);
	const prefs = useWritingPrefs();
	const target = getChapterTarget(controller.bookId?.(), prefs);
	const status = chapterStatus(meta);
	const pct = Math.min(
		100,
		Math.round((meta.words / Math.max(1, target)) * 100),
	);
	return (
		<>
			<span className={`ed-status ed-status-${status.key}`}>
				{status.label}
			</span>
			<span
				className="ed-progress"
				title={`本章 ${meta.words.toLocaleString("zh-CN")} 字（去空白）/ 每章目标 ${target.toLocaleString("zh-CN")} 字`}
			>
				<span className="ed-progress-bar" aria-hidden="true">
					<i className="ed-progress-fill" style={{ width: `${pct}%` }}></i>
				</span>
				<span className="ed-progress-text">
					{meta.words.toLocaleString("zh-CN")} /{" "}
					{target.toLocaleString("zh-CN")} 字
				</span>
			</span>
		</>
	);
}

export function EditorEyebrow({ controller }) {
	const model = useSyncExternalStore(
		controller.subscribe,
		controller.getListModel,
		controller.getListModel,
	);
	const cid = controller.currentChapterId?.();
	const ch = model.chapters.find((c) => c.id === cid);
	if (!ch) return <div className="editor-eyebrow"></div>;
	const vol = ch.volume_title || "未归卷";
	return (
		<div className="editor-eyebrow">
			{ch.chapter_ordinal ? `${vol} · 第 ${ch.chapter_ordinal} 章` : vol}
		</div>
	);
}

// 「正文内预览」续写呈现：贴在正文末尾的浅色预览块，接受后才真正写入（textarea 不能嵌行内幽灵文本）
export function ContinuePreview({ controller }) {
	const preview = useSyncExternalStore(
		subscribeContinuePreview,
		getContinuePreview,
		getContinuePreview,
	);
	const meta = useEditorMeta(controller);
	if (!preview || preview.chapterId !== meta.chapterId) return null;
	const words = preview.content.replace(/\s/g, "").length;
	return (
		<section className="continue-preview" aria-label="AI 续写预览">
			<div className="continue-preview-label">
				AI 续写预览 · {words.toLocaleString("zh-CN")} 字 · 接受后接在正文末尾
			</div>
			<div className="continue-preview-text">{preview.content}</div>
			<div className="continue-preview-ops">
				<button
					type="button"
					className="btn btn-small continue-accept"
					onClick={() => preview.accept?.()}
				>
					接受续写
				</button>
				<button
					type="button"
					className="btn btn-small"
					title="让写作助手按同一走向换一种写法（会作为一条新消息发出）"
					onClick={() => preview.rewrite?.()}
				>
					重写
				</button>
				<button
					type="button"
					className="btn btn-small btn-ghost"
					onClick={() => preview.discard?.()}
				>
					丢弃
				</button>
			</div>
		</section>
	);
}

export function AppearanceMenu() {
	const [prefs, setPrefs] = useAppearance();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="btn btn-small ed-icon-btn"
					aria-label="外观"
					title="外观：主题、主色、正文行宽与字体（只存本机）"
				>
					<Type aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>主题</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={prefs.theme}
					onValueChange={(v) => setPrefs({ theme: v })}
				>
					{THEMES.map((o) => (
						<DropdownMenuRadioItem key={o.id} value={o.id}>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>主色</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={prefs.accent}
					onValueChange={(v) => setPrefs({ accent: v })}
				>
					{ACCENTS.map((o) => (
						<DropdownMenuRadioItem key={o.id} value={o.id}>
							<span
								className="inline-block size-2.5 rounded-full"
								style={{ background: o.swatch }}
								aria-hidden="true"
							/>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>正文行宽</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={prefs.readWidth}
					onValueChange={(v) => setPrefs({ readWidth: v })}
				>
					{READ_WIDTHS.map((o) => (
						<DropdownMenuRadioItem key={o.id} value={o.id}>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>正文字体</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={prefs.readFont}
					onValueChange={(v) => setPrefs({ readFont: v })}
				>
					{READ_FONTS.map((o) => (
						<DropdownMenuRadioItem key={o.id} value={o.id}>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
