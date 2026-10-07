// 聊天滚动区「贴底跟随」。
// 消息 .msg 带 content-visibility:auto（长会话性能，见 base.css），屏外消息按 200px 占位参与布局：
// 一旦置底，底部消息才渲染出真实高度，scrollHeight 在随后几帧里继续变化，滚动锚定还会把
// scrollTop 往回拉（实测 2467→3960，最终停在距底 1478px）。所以单次 scrollTop=scrollHeight
// 或 scrollTo({behavior:'smooth'}) 的终点会过期，表现为「没滚到底」「箭头停在半路」。
// 对策：置底后逐帧补滚直到高度稳定；挂了跟随器的容器在内容尺寸变化时持续贴底，
// 用户主动上翻（滚轮／触摸／键盘／拖滚动条）即脱离跟随，回到底部或调用 pin() 再恢复。

const STICK_PX = 40;
const INTENT_MS = 600;
const SETTLE_MAX_FRAMES = 90;
const SETTLE_STABLE_FRAMES = 3;
const NAV_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

const followers = new WeakMap();

function raf(cb) {
	return typeof requestAnimationFrame === "function"
		? requestAnimationFrame(cb)
		: setTimeout(cb, 16);
}

function cancelRaf(id) {
	if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
	else clearTimeout(id);
}

function distanceToBottom(el) {
	return el.scrollHeight - el.scrollTop - (el.clientHeight || 0);
}

function setBottom(el) {
	el.scrollTop = el.scrollHeight;
}

// 同步置底一次，再逐帧补滚到「高度不变且已在底部」连续数帧；shouldStop 为真即让位给用户
function settle(el, shouldStop) {
	setBottom(el);
	let frames = 0;
	let stable = 0;
	let lastHeight = el.scrollHeight;
	let id = null;
	let cancelled = false;
	const step = () => {
		id = null;
		if (cancelled || el.isConnected === false) return;
		if (shouldStop?.()) return;
		frames += 1;
		const h = el.scrollHeight;
		stable = h === lastHeight && distanceToBottom(el) <= 1 ? stable + 1 : 0;
		lastHeight = h;
		setBottom(el);
		if (stable >= SETTLE_STABLE_FRAMES || frames >= SETTLE_MAX_FRAMES) return;
		id = raf(step);
	};
	id = raf(step);
	return () => {
		cancelled = true;
		if (id != null) cancelRaf(id);
	};
}

export function attachBottomFollow(el) {
	if (!el) return () => {};
	const existing = followers.get(el);
	if (existing) return existing.dispose;

	const st = { stuck: true, intentAt: 0, cancelSettle: null };
	const userActive = () => Date.now() - st.intentAt < INTENT_MS;
	const stopSettle = () => {
		if (st.cancelSettle) st.cancelSettle();
		st.cancelSettle = null;
	};
	const markIntent = () => {
		st.intentAt = Date.now();
		stopSettle();
	};
	const onKey = (e) => {
		if (NAV_KEYS.has(e.key)) markIntent();
	};
	// 只有按在容器自身（滚动条/内边距）才算拖滚动条；点消息里的按钮不算
	const onPointerDown = (e) => {
		if (e.target === el) markIntent();
	};
	// 只在用户刚操作过时重判贴底：内容增长、滚动锚定等布局引起的 scroll 不改变跟随状态
	const onScroll = () => {
		if (userActive()) st.stuck = distanceToBottom(el) <= STICK_PX;
	};
	const onResize = () => {
		if (st.stuck && !userActive()) setBottom(el);
	};

	el.addEventListener("wheel", markIntent, { passive: true });
	el.addEventListener("touchstart", markIntent, { passive: true });
	el.addEventListener("touchmove", markIntent, { passive: true });
	el.addEventListener("keydown", onKey);
	el.addEventListener("pointerdown", onPointerDown);
	el.addEventListener("scroll", onScroll, { passive: true });

	// 容器内高度变化不会改变容器自身尺寸，必须逐个观察子节点（新增节点经 MutationObserver 补挂）
	let ro = null;
	let mo = null;
	if (typeof ResizeObserver === "function") {
		ro = new ResizeObserver(onResize);
		ro.observe(el);
		for (const child of el.children) ro.observe(child);
		if (typeof MutationObserver === "function") {
			mo = new MutationObserver((records) => {
				for (const r of records) {
					for (const n of r.addedNodes) {
						if (n.nodeType === 1) ro.observe(n);
					}
					for (const n of r.removedNodes) {
						if (n.nodeType === 1) ro.unobserve(n);
					}
				}
				onResize();
			});
			mo.observe(el, { childList: true });
		}
	}

	const dispose = () => {
		stopSettle();
		el.removeEventListener("wheel", markIntent);
		el.removeEventListener("touchstart", markIntent);
		el.removeEventListener("touchmove", markIntent);
		el.removeEventListener("keydown", onKey);
		el.removeEventListener("pointerdown", onPointerDown);
		el.removeEventListener("scroll", onScroll);
		if (ro) ro.disconnect();
		if (mo) mo.disconnect();
		if (followers.get(el)?.dispose === dispose) followers.delete(el);
	};
	const api = {
		pin() {
			st.stuck = true;
			st.intentAt = 0;
			stopSettle();
			st.cancelSettle = settle(el, userActive);
		},
		isStuck: () => st.stuck,
		dispose,
	};
	followers.set(el, api);
	return dispose;
}

// 主动置底（新消息、点「直达底部」）：有跟随器则恢复跟随，否则一次性置底并补滚到稳定
export function scrollToBottom(el) {
	if (!el) return;
	const f = followers.get(el);
	if (f) f.pin();
	else settle(el, null);
}

// 流式增量的节拍置底：用户已上翻离开底部时不打扰
export function followTick(el) {
	if (!el) return;
	const f = followers.get(el);
	if (f && !f.isStuck()) return;
	setBottom(el);
}

export function isFollowingBottom(el) {
	const f = el ? followers.get(el) : null;
	return f ? f.isStuck() : null;
}
