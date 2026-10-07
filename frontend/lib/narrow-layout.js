// 写作页窄屏：窗口不够三栏时，左栏（≤1180px）与写作助手（≤760px）改成盖在编辑区上的抽屉。
// 抽屉开合只是这次浏览的临时状态，不碰按书记住的收起偏好（left-collapsed / chat-collapsed），
// 窗口拉宽回三栏后布局照旧。断点须与 book-shell.css 的两段 @media 一致。

export const NAV_DRAWER_QUERY = "(max-width: 1180px)";
export const CHAT_DRAWER_QUERY = "(max-width: 760px)";

const OPEN_CLASS = { nav: "nav-drawer-open", chat: "chat-drawer-open" };
const TOGGLE_ID = {
	nav: "btn-toggle-left-panel",
	chat: "btn-toggle-chat-panel",
};
const COLLAPSED_CLASS = { nav: "left-collapsed", chat: "chat-collapsed" };

function matches(query) {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia(query).matches
	);
}

function bench() {
	return document.getElementById("book-workbench");
}

export function isDrawer(side) {
	return matches(side === "chat" ? CHAT_DRAWER_QUERY : NAV_DRAWER_QUERY);
}

export function isDrawerOpen(side) {
	return !!bench()?.classList.contains(OPEN_CLASS[side]);
}

export function setDrawerOpen(side, open) {
	const b = bench();
	if (!b) return false;
	// 同一时间只开一个抽屉，免得两层叠在一起
	if (open) {
		for (const other of Object.keys(OPEN_CLASS)) {
			if (other !== side && b.classList.contains(OPEN_CLASS[other])) {
				setDrawerOpen(other, false);
			}
		}
	}
	b.classList.toggle(OPEN_CLASS[side], !!open);
	syncToggle(side);
	return !!open;
}

// 折叠按钮的 aria-expanded：抽屉模式看抽屉开没开，宽屏看收起偏好
function syncToggle(side) {
	const b = bench();
	const btn = document.getElementById(TOGGLE_ID[side]);
	if (!b || !btn) return;
	const expanded = isDrawer(side)
		? b.classList.contains(OPEN_CLASS[side])
		: !b.classList.contains(COLLAPSED_CLASS[side]);
	btn.setAttribute("aria-expanded", expanded ? "true" : "false");
}

export function syncDrawerToggles() {
	for (const side of Object.keys(OPEN_CLASS)) syncToggle(side);
}

export function toggleDrawer(side) {
	return setDrawerOpen(side, !isDrawerOpen(side));
}

export function closeDrawers() {
	let closed = false;
	for (const side of Object.keys(OPEN_CLASS)) {
		if (isDrawerOpen(side)) {
			setDrawerOpen(side, false);
			closed = true;
		}
	}
	return closed;
}

export function anyDrawerOpen() {
	return Object.keys(OPEN_CLASS).some(isDrawerOpen);
}
