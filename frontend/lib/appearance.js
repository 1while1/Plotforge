// 外观偏好：主题 / 主色 / 正文字体 / 正文行宽。存本机 localStorage（不进服务端），
// 生效方式＝写 <html> 的 data-* 属性，由 frontend/styles/tokens.css 按属性切换令牌。

export const APPEARANCE_KEY = "mozhen.appearance.v1";

export const THEMES = [
	{ id: "light", label: "亮色" },
	{ id: "dark", label: "暗色" },
	{ id: "system", label: "跟随系统" },
];

export const ACCENTS = [
	{ id: "teal", label: "青绿", swatch: "#0f766e" },
	{ id: "indigo", label: "黛蓝", swatch: "#3a506b" },
	{ id: "plum", label: "绛紫", swatch: "#6b4a8a" },
	{ id: "ochre", label: "赭石", swatch: "#9a5b25" },
];

export const READ_FONTS = [
	{ id: "dengxian", label: "等线" },
	{ id: "fangsong", label: "仿宋" },
	{ id: "songti", label: "宋体" },
	{ id: "kaiti", label: "楷体" },
	{ id: "yahei", label: "微软雅黑" },
];

export const READ_WIDTHS = [
	{ id: "narrow", label: "窄" },
	{ id: "medium", label: "中" },
	{ id: "wide", label: "宽" },
];

export const DEFAULT_APPEARANCE = Object.freeze({
	theme: "light",
	accent: "teal",
	readFont: "dengxian",
	readWidth: "medium",
});

const OPTIONS = {
	theme: THEMES,
	accent: ACCENTS,
	readFont: READ_FONTS,
	readWidth: READ_WIDTHS,
};

export function normalizeAppearance(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const out = {};
	for (const [key, list] of Object.entries(OPTIONS)) {
		const value = src[key];
		out[key] = list.some((o) => o.id === value)
			? value
			: DEFAULT_APPEARANCE[key];
	}
	return out;
}

function defaultStorage() {
	try {
		return globalThis.localStorage || null;
	} catch {
		return null;
	}
}

export function loadAppearance(storage = defaultStorage()) {
	if (!storage) return { ...DEFAULT_APPEARANCE };
	try {
		const text = storage.getItem(APPEARANCE_KEY);
		return normalizeAppearance(text ? JSON.parse(text) : null);
	} catch {
		return { ...DEFAULT_APPEARANCE };
	}
}

export function saveAppearance(prefs, storage = defaultStorage()) {
	const clean = normalizeAppearance(prefs);
	if (storage) {
		try {
			storage.setItem(APPEARANCE_KEY, JSON.stringify(clean));
		} catch {
			// 隐私模式或配额满时只放弃持久化，当前会话照常生效
		}
	}
	return clean;
}

export function resolveTheme(theme, matchMedia = globalThis.matchMedia) {
	if (theme !== "system") return theme;
	try {
		return matchMedia?.("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	} catch {
		return "light";
	}
}

export function applyAppearance(
	prefs,
	root = globalThis.document?.documentElement,
) {
	const clean = normalizeAppearance(prefs);
	if (!root) return clean;
	root.dataset.theme = resolveTheme(clean.theme);
	root.dataset.accent = clean.accent;
	root.dataset.readFont = clean.readFont;
	root.dataset.readWidth = clean.readWidth;
	return clean;
}

// 进程内单例：React 侧经 useSyncExternalStore 订阅
let current = null;
const listeners = new Set();

export function getAppearance() {
	if (!current) current = loadAppearance();
	return current;
}

export function setAppearance(patch) {
	current = saveAppearance({ ...getAppearance(), ...patch });
	applyAppearance(current);
	for (const fn of listeners) fn(current);
	return current;
}

export function subscribeAppearance(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

let systemWatch = null;

export function initAppearance() {
	applyAppearance(getAppearance());
	if (systemWatch || typeof globalThis.matchMedia !== "function") return;
	systemWatch = globalThis.matchMedia("(prefers-color-scheme: dark)");
	systemWatch.addEventListener?.("change", () => {
		if (getAppearance().theme === "system") applyAppearance(getAppearance());
	});
}

export function resetAppearanceForTest() {
	current = null;
	listeners.clear();
	systemWatch = null;
}
