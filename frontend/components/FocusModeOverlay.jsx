// 专注写作模式（UI 优化阶段 2d，样稿 B）：只留正文与底部一条 AI 输入栏。
// 本组件只负责两件事：顶栏的「专注模式」开关，以及编辑区顶部的卷／章面包屑；
// 底部输入栏与回复面板由聊天面（ChatPanel）按 lib/focus-state.js 的共享状态自己呈现。
//
// - 开关按钮落在 #btn-toggle-left-panel 之后（topbar 用 order 排序）；面包屑头落在
//   .panel-editor 第一个子节点——不放进 .panel-chat：那里整块由 ChatWorkspace 的 React 根
//   接管，挂进去的节点会被渲染清掉（阶段 1 报告记录的缺陷）。
// - body.focus-mode / body.focus-chat-open 两个类只由最新一次挂载的实例写，避免多次挂载串扰。
// - Esc：回复面板开着先收面板，否则退出专注；离开书主页（hash 不再是 #/book/<id>）自动退出。
// - focusModeSync()：切章后由编辑器调用，专注时重拉卷／章列表刷新面包屑。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import {
	getFocusState,
	setFocusActive,
	setFocusChatOpen,
	subscribeFocusState,
} from "../lib/focus-state.js";
import { chapterEditorApi } from "./ChapterEditorPanel.jsx";

const FOCUS_TITLE = "专注写作：只留正文和底部 AI 输入栏；Esc 退出";

function FocusModeOverlay({ mirror, hosts }) {
	const [active, setActive] = useState(false);
	const [vols, setVols] = useState([]);
	const [chapters, setChapters] = useState([]);
	const [volValue, setVolValue] = useState("");
	const [chValue, setChValue] = useState("");

	const bookId = () => {
		const app = getApp();
		return app?.state.currentBook ? app.state.currentBook.id : null;
	};
	const onBookHome = () => /^#\/book\/\d+$/.test(window.location.hash);

	function refreshData() {
		const bid = bookId();
		if (!bid) return;
		Promise.all([
			getApp().api("GET", `/api/books/${bid}/volumes`),
			getApp().api("GET", `/api/books/${bid}/chapters`),
		])
			.then((r) => {
				const nextChapters = r[1].chapters || [];
				setVols(r[0].volumes || []);
				setChapters(nextChapters);
				syncLabels(nextChapters);
			})
			.catch(() => {
				/* 面包屑拉取失败不打断写作，保留上一份选项 */
			});
	}

	function syncLabels(chapterList) {
		const cid = getApp().state.currentChapterId;
		const cur = (chapterList || []).filter((c) => c.id === cid)[0];
		const vid = cur?.volume_id ? cur.volume_id : getApp().state.currentVolumeId;
		if (vid != null) setVolValue(String(vid));
		setChValue(cid ? String(cid) : "");
	}

	function chaptersOf(volId) {
		return chapters.filter((c) => String(c.volume_id || "") === String(volId));
	}

	function toggle(force) {
		const next = typeof force === "boolean" ? force : !mirror.active;
		mirror.active = next; // 同拍连点也要逐次翻转，不能等 React 提交
		setActive(next);
		if (mirror === current) setFocusActive(next);
		if (next) refreshData();
	}

	useEffect(() => {
		mirror.active = active;
		mirror.refresh = refreshData;
	});

	useEffect(() => {
		if (mirror !== current) return undefined;
		const apply = (s) => {
			document.body.classList.toggle("focus-mode", s.active);
			document.body.classList.toggle("focus-chat-open", s.active && s.chatOpen);
		};
		apply(getFocusState());
		return subscribeFocusState(apply);
	}, [mirror]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 监听只读 mirror 与模块状态，挂载一次即可
	useEffect(() => {
		const onKeydown = (e) => {
			if (e.key !== "Escape" || !mirror.active) return;
			if (getFocusState().chatOpen) setFocusChatOpen(false);
			else toggle(false);
		};
		const onHashchange = () => {
			if (mirror.active && !onBookHome()) toggle(false);
		};
		document.addEventListener("keydown", onKeydown);
		window.addEventListener("hashchange", onHashchange);
		return () => {
			document.removeEventListener("keydown", onKeydown);
			window.removeEventListener("hashchange", onHashchange);
		};
	}, []);

	const list = chaptersOf(volValue);
	return (
		<>
			<button
				id="btn-focus-mode"
				className={active ? "btn btn-ghost mode-on" : "btn btn-ghost"}
				type="button"
				title={FOCUS_TITLE}
				aria-pressed={active}
				onClick={() => toggle()}
			>
				专注模式
			</button>
			{createPortal(
				<div className="focus-crumbs">
					<span className="crumb">
						<select
							aria-label="切换分卷"
							value={volValue}
							onChange={(e) => {
								const value = e.target.value;
								setVolValue(value);
								const hit = chapters.filter(
									(c) => String(c.volume_id || "") === String(value),
								);
								if (!hit.length) {
									getApp().toast("该卷还没有章节");
									syncLabels(chapters);
									return;
								}
								chapterEditorApi().selectChapter(hit[0].id);
							}}
						>
							{vols.map((v) => (
								<option key={v.id} value={v.id}>
									{v.title}
								</option>
							))}
						</select>
					</span>
					<span className="crumb-sep">/</span>
					<span className="crumb">
						<select
							aria-label="切换章节"
							value={chValue}
							onChange={(e) => {
								const value = e.target.value;
								setChValue(value);
								if (!value) return;
								chapterEditorApi().selectChapter(Number(value));
							}}
						>
							<option value="">
								{list.length ? "选择章节" : "（本卷暂无章节）"}
							</option>
							{list.map((c) => (
								<option key={c.id} value={c.id}>
									{c.title}
								</option>
							))}
						</select>
					</span>
				</div>,
				hosts.head,
			)}
		</>
	);
}

export default FocusModeOverlay;

// 每次挂载一份镜像；current 指向最新一次挂载，sync/isActive 读它
let current = null;

export function focusModeSync() {
	const c = current;
	if (c?.active && typeof c.refresh === "function") c.refresh();
}

export function focusModeIsActive() {
	return current ? current.active === true : false;
}

// 自挂载：#book-workbench 与 #btn-toggle-left-panel 任一缺失即不挂、返回 null；
// data-focus-mode-host 标记防重复挂载。
export function mountFocusMode() {
	if (document.querySelector("[data-focus-mode-host]")) return null;
	const workbench = document.getElementById("book-workbench");
	const anchor = document.getElementById("btn-toggle-left-panel");
	if (!workbench || !anchor) return null;

	const btnHost = document.createElement("div");
	anchor.after(btnHost);
	const headHost = document.createElement("div");
	headHost.className = "focus-head";
	const editorPanel = workbench.querySelector(".panel-editor");
	if (editorPanel) editorPanel.insertBefore(headHost, editorPanel.firstChild);
	for (const host of [btnHost, headHost]) {
		host.setAttribute("data-focus-mode-host", "");
	}

	const mirror = { active: false, refresh: null };
	current = mirror;
	setFocusActive(false);
	createRoot(btnHost).render(
		<FocusModeOverlay
			mirror={mirror}
			hosts={{ btn: btnHost, head: headHost }}
		/>,
	);
	mountedBridge = true;
	return { sync: focusModeSync, isActive: focusModeIsActive };
}

// 未挂载（守卫失败／重复挂载被拒）时返回 null，消费方据此跳过
let mountedBridge = false;

export function focusModeBridge() {
	if (!mountedBridge) return null;
	return { sync: focusModeSync, isActive: focusModeIsActive };
}
