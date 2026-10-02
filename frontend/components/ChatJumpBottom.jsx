// ChatJumpBottom（S3-1 D8，自挂载零消费）：chat-jump-bottom.js（53 行）的 React 化。
// 聊天栏「直达底部」悬浮箭头：上翻历史超过阈值时浮现，点击平滑回底。
// mount() 把 #chat-messages 包进 .chat-scroll-wrap 相对定位容器（命令式，等价旧
// chat-jump-bottom.js:14~17 的 insertBefore+appendChild），按钮由 React 经 portal
// 渲染为 wrap 的**直接子节点**（与旧 wrap.appendChild(btn) 的 DOM 结构逐字同形；
// class/title/aria-label「直达底部」与 svg 逐字照搬旧 :19~24）。
// show/hide 用 React state：rAF 节流 sync（距底 scrollHeight-scrollTop-clientHeight
// > SHOW_THRESHOLD=160 切 .show，等价旧 :28~37）；scroll passive + MutationObserver
// (childList) + ResizeObserver 三观察逐字保留（含 window.* 存在性守卫，旧 :42~45）；
// 点击 scrollTo({top, behavior:'smooth'})（旧 :39~41）。不干预流式期间的自动滚底
// （book-chat.js scrollBottom）语义；模块未加载时页面无任何痕迹——mount 无目标即
// return。旧全局 window.ChatJumpBottom 不留 shim（全仓零消费，Plan D1）。
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const SHOW_THRESHOLD = 160; // 距底超过该像素才浮现

// S5-7（Plan §5 纪律 8）：`JumpButton` 导出给 ChatPanel 在 React 树内渲染（wrap 由 React 渲染后，
// 命令式 mount() 的 insertBefore 参照会被移位 ⇒ 必须由 React 树自己产出 wrap）；
// `unmount()` 幂等拆除自挂载 root＋宿主（未挂载时静默），供 ChatWorkspace.ensureMounted() 在
// 建 root 前拆掉 registerLegacyBridges→mountChatJumpBottom 在静态壳上留下的悬挂 root。
export function JumpButton({ messages }) {
	const [show, setShow] = useState(false);
	const ticking = useRef(false);

	useEffect(() => {
		// 判定走 rAF 节流：流式期间滚动/内容事件密集，避免每 token 读布局（旧 :27~37）
		const sync = () => {
			if (ticking.current) return;
			ticking.current = true;
			requestAnimationFrame(() => {
				ticking.current = false;
				const dist =
					messages.scrollHeight - messages.scrollTop - messages.clientHeight;
				setShow(dist > SHOW_THRESHOLD);
			});
		};
		const onScroll = () => sync();
		messages.addEventListener("scroll", onScroll, { passive: true });
		// 换会话/重渲染整棵替换、窗口或分栏尺寸变化都要重判（旧 :43~45）
		let mutationObserver = null;
		if (window.MutationObserver) {
			mutationObserver = new MutationObserver(sync);
			mutationObserver.observe(messages, { childList: true });
		}
		let resizeObserver = null;
		if (window.ResizeObserver) {
			resizeObserver = new ResizeObserver(sync);
			resizeObserver.observe(messages);
		}
		sync();
		return () => {
			messages.removeEventListener("scroll", onScroll);
			if (mutationObserver) mutationObserver.disconnect();
			if (resizeObserver) resizeObserver.disconnect();
		};
	}, [messages]);

	const onJumpClick = () => {
		messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
	};

	return createPortal(
		<button
			type="button"
			className={show ? "chat-jump-bottom show" : "chat-jump-bottom"}
			title="直达底部"
			aria-label="直达底部"
			onClick={onJumpClick}
		>
			<svg
				aria-hidden="true"
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 4v14" />
				<path d="M6 12l6 6 6-6" />
			</svg>
		</button>,
		messages.parentNode,
	);
}

// 自挂载入口：幂等（#chat-messages 缺失/已在 wrap 内即 return，等价旧 :11~12 防御）。
// React root 挂在 body 末尾的空宿主 div（不可挂 wrap/grid 内——避免多出网格项或
// 被滚动区布局牵连）；按钮经 portal 直达 wrap。旧全局 window.ChatJumpBottom 不再暴露。
let mounted = null; // {root, host}：自挂载句柄（unmount() 拆除用）

export function unmount() {
	if (!mounted) return;
	const { root, host } = mounted;
	mounted = null;
	try {
		root.unmount();
	} catch (_e) {
		/* root 已随宿主脱离文档：容忍 */
	}
	if (host?.parentNode) host.parentNode.removeChild(host);
}

export function mount() {
	const messages = document.getElementById("chat-messages");
	if (!messages?.parentNode) return;
	// 等值旧 chat-jump-bottom.js:12 存在性守卫（classList 缺失即视为未包装）
	if (messages.parentNode.classList?.contains("chat-scroll-wrap")) return;

	const wrap = document.createElement("div");
	wrap.className = "chat-scroll-wrap";
	messages.parentNode.insertBefore(wrap, messages);
	wrap.appendChild(messages);

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted = { root, host };
	// flushSync：等值旧 chat-jump-bottom.js:17~22（命令式 appendChild 同拍可见），
	// 也让「先 mount() 再 ensureMounted()」的残留拆除顺序可断言
	flushSync(() => root.render(<JumpButton messages={messages} />));
}
