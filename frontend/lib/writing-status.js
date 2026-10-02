// P6-2（Plan §2.5-D2）：写作状态条的模块级「渲染缝」——把「注册后才刷、未注册 no-op」的现守卫语义
//（workspace-state.js:606-607 的 `if (typeof page.renderWritingStatus === "function")`）从 window 桥
// 迁到 lib 层，避免 workspace-state → BookShell 与 run-status → BookShell 的 import 环。
//
// 语义等值（逐字对照现实现）：
//   · 未注册（BookShell 尚未首次 mount）：`renderWritingStatusIfBound()` 为 no-op 且返回 false
//     ——等值 `win()?.BookPage` 缺失/无该名时的早退；
//   · 注册后：每次调用恰转发 1 次（BookShell 首次 mount 注册 module-local `renderWritingStatus`）。
//
// 另承载编辑器脏标记供给缝：等值 run-status.js:238-239 读 `BookPage.hasUnsavedChanges?.()`；
// 绑定方＝ChapterEditorPanel.mountChapterEditor（挂载即绑），未绑定时恒 false
//（等值未挂载面 chapterEditorApi() 的 NULL_API.hasUnsavedChanges() === false）。
let renderer = null;
let editorDirtyProvider = null;

// 注册渲染器；返回解绑函数（**仅测试复位用**，生产零调用）
export function bindWritingStatusRenderer(fn) {
	renderer = typeof fn === "function" ? fn : null;
	return () => {
		if (renderer === fn) renderer = null;
	};
}

// 未注册 = no-op（返回 false，不抛）
export function renderWritingStatusIfBound() {
	if (typeof renderer !== "function") return false;
	renderer();
	return true;
}

// 编辑器脏标记供给缝（同款语义：未绑定恒 false）
export function bindEditorDirtyProvider(fn) {
	editorDirtyProvider = typeof fn === "function" ? fn : null;
	return () => {
		if (editorDirtyProvider === fn) editorDirtyProvider = null;
	};
}

export function isEditorDirty() {
	if (typeof editorDirtyProvider !== "function") return false;
	return !!editorDirtyProvider();
}
