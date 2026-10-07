// 键盘快捷键表：跳转面板、快捷键一览与按键分发共用这一份。Mac 上 ⌘ 视同 Ctrl。
// scope：global＝任何页面；book＝只在写作页生效。

export const SHORTCUTS = [
	{ id: "palette", keys: "Ctrl+K", label: "打开跳转面板", scope: "global" },
	{ id: "help", keys: "Ctrl+/", label: "快捷键一览", scope: "global" },
	{ id: "save", keys: "Ctrl+S", label: "保存本章", scope: "book" },
	{ id: "prevChapter", keys: "Alt+↑", label: "上一章", scope: "book" },
	{ id: "nextChapter", keys: "Alt+↓", label: "下一章", scope: "book" },
	{ id: "lock", keys: "Ctrl+Shift+L", label: "定稿本章", scope: "book" },
	{ id: "focus", keys: "Ctrl+Shift+F", label: "专注模式开/关", scope: "book" },
	{
		id: "send",
		keys: "Ctrl+Enter",
		label: "发送（在 AI 输入框里）",
		scope: "book",
		passive: true,
	},
	{
		id: "escape",
		keys: "Esc",
		label: "收起回复面板 / 退出专注",
		scope: "book",
		passive: true,
	},
];

export function shortcutKeys(id) {
	return SHORTCUTS.find((s) => s.id === id)?.keys || "";
}

// 只识别本表里由全局分发处理的组合（passive 项由各自的输入框/组件处理）
export function matchShortcut(e) {
	if (!e || e.isComposing) return null;
	const mod = e.ctrlKey || e.metaKey;
	const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
	if (mod && !e.shiftKey && !e.altKey) {
		if (key === "k") return "palette";
		if (key === "/") return "help";
		if (key === "s") return "save";
	}
	if (mod && e.shiftKey && !e.altKey) {
		if (key === "l") return "lock";
		if (key === "f") return "focus";
	}
	if (e.altKey && !mod && !e.shiftKey) {
		if (key === "arrowup") return "prevChapter";
		if (key === "arrowdown") return "nextChapter";
	}
	return null;
}
