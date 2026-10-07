// 「正文内预览」续写呈现的共享状态：聊天面产出预览，编辑区（另一个 React 根）订阅并渲染。
// 预览绑定产出时的书与章；切到别的章节时编辑区不显示它，避免把续写写进错误的章节。

let current = null;
const listeners = new Set();

function emit() {
	for (const fn of Array.from(listeners)) fn(current);
}

export function getContinuePreview() {
	return current;
}

export function subscribeContinuePreview(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

// preview: { id, bookId, chapterId, content, accept(), rewrite?() }
export function showContinuePreview(preview) {
	current = preview ? { ...preview } : null;
	emit();
}

export function clearContinuePreview(id) {
	if (!current) return;
	if (id != null && current.id !== id) return;
	current = null;
	emit();
}

// 写作助手的回复里只有「像正文」的才进预览：协作模式的确认提问和寒暄不算
export const CONTINUE_PREVIEW_MIN_CHARS = 80;

// 小说正文不会出现 Markdown 列表/标题行；出现两行以上基本是改稿说明或建议
const MARKDOWN_LINE = /^\s*(?:[-*•]\s|\d+[.、)]\s|#{1,6}\s)/;

// AI 汇报自己已完成的写操作（"已提交生效""revision 9"）——小说正文里不会这样写
const OPERATION_REPORT =
	/revision\s*\d+|已提交生效|已提交操作「|等待作者确认|已(?:写入|替换|追加|保存)(?:到)?(?:正文|章节|本章)/i;

// 回复是否像可以直接放进正文的小说文字（决定「插入到当前章节」是否出现）
export function looksLikeProse(msg) {
	if (msg?.role !== "assistant" || msg.compressed) return false;
	// 服务端按本轮事实（写工具/确认续跑/作者原话）标注的意图优先；prose/unknown/旧消息仍过格式兜底
	if (msg.intent === "operation" || msg.intent === "discussion") return false;
	// 本轮发起过写操作（流中 actions；回放时为锚定在本条下的 actionLogs）：正文已经经由
	// 确认卡写入，回复只是 AI 对操作的说明
	if (Array.isArray(msg.actions) && msg.actions.length > 0) return false;
	if (Array.isArray(msg.actionLogs) && msg.actionLogs.length > 0) return false;
	const text = String(msg.content || "").trim();
	if (!text) return false;
	if (/【需要确认】/.test(text)) return false;
	if (OPERATION_REPORT.test(text)) return false;
	const listLines = text
		.split("\n")
		.filter((line) => MARKDOWN_LINE.test(line)).length;
	return listLines < 2;
}

export function isContinuationCandidate(msg) {
	if (!looksLikeProse(msg)) return false;
	return String(msg.content).trim().length >= CONTINUE_PREVIEW_MIN_CHARS;
}

export function resetContinuePreviewForTest() {
	current = null;
	listeners.clear();
}
