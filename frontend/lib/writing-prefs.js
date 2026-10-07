// 写作页本机偏好：每章字数目标（按书）与 AI 续写呈现方式。和外观偏好一样只存 localStorage，不进服务端。

export const WRITING_PREFS_KEY = "mozhen.writing-prefs.v1";

export const DEFAULT_CHAPTER_TARGET = 3000;
export const CHAPTER_TARGET_PRESETS = [2000, 3000, 4000, 5000, 6000, 8000];

// card＝对话卡片＋「插入正文」；inline＝在正文末尾出预览块，确认后才写入
export const CONTINUE_STYLES = [
	{ id: "card", label: "对话卡片" },
	{ id: "inline", label: "正文内预览" },
];

const MAX_TARGET = 100000;

function normalizeTarget(value) {
	const n = Math.round(Number(value));
	return Number.isFinite(n) && n > 0 && n <= MAX_TARGET ? n : null;
}

export function normalizeWritingPrefs(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const targets = {};
	if (src.targets && typeof src.targets === "object") {
		for (const [bookId, value] of Object.entries(src.targets)) {
			const n = normalizeTarget(value);
			if (n) targets[bookId] = n;
		}
	}
	const continueStyle = CONTINUE_STYLES.some((o) => o.id === src.continueStyle)
		? src.continueStyle
		: "card";
	return { targets, continueStyle };
}

function storage() {
	try {
		return globalThis.localStorage || null;
	} catch {
		return null;
	}
}

let current = null;
const listeners = new Set();

export function getWritingPrefs() {
	if (current) return current;
	let parsed = null;
	try {
		const text = storage()?.getItem(WRITING_PREFS_KEY);
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}
	current = normalizeWritingPrefs(parsed);
	return current;
}

function commit(next) {
	current = normalizeWritingPrefs(next);
	try {
		storage()?.setItem(WRITING_PREFS_KEY, JSON.stringify(current));
	} catch {
		// 隐私模式或配额满：本次会话照常生效
	}
	for (const fn of Array.from(listeners)) fn(current);
	return current;
}

export function subscribeWritingPrefs(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function getChapterTarget(bookId, prefs = getWritingPrefs()) {
	return (
		(bookId != null && prefs.targets[String(bookId)]) || DEFAULT_CHAPTER_TARGET
	);
}

export function setChapterTarget(bookId, value) {
	const n = normalizeTarget(value);
	if (bookId == null || !n) return getWritingPrefs();
	const prefs = getWritingPrefs();
	return commit({
		...prefs,
		targets: { ...prefs.targets, [String(bookId)]: n },
	});
}

export function setContinueStyle(style) {
	return commit({ ...getWritingPrefs(), continueStyle: style });
}

export function resetWritingPrefsForTest() {
	current = null;
	listeners.clear();
}
