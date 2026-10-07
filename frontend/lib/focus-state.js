// 专注写作的共享状态：开关在顶栏（FocusModeOverlay），底部输入栏与回复面板在聊天面（另一个 React 根）。
// chatOpen＝专注时是否展开输入栏上方的回复面板；退出专注一律收起。

let state = { active: false, chatOpen: false };
const listeners = new Set();

function set(next) {
	if (next.active === state.active && next.chatOpen === state.chatOpen) return;
	state = next;
	for (const fn of Array.from(listeners)) fn(state);
}

export function getFocusState() {
	return state;
}

export function subscribeFocusState(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function setFocusActive(active) {
	set({ active: !!active, chatOpen: active ? state.chatOpen : false });
}

export function setFocusChatOpen(open) {
	if (!state.active) return;
	set({ active: true, chatOpen: !!open });
}

export function resetFocusStateForTest() {
	state = { active: false, chatOpen: false };
	listeners.clear();
}
