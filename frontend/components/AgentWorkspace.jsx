// S5-9（Plan §1.1 G9／§4 T5）：挂载件——#page-agent 内层壳原位接管（S5-7 挂载配方）。
// 与 ReadPage.jsx:1267-1285 同款：容器＝静态壳自身（#page-agent 的类名归 AppRouter 的
// hideAllPages/showPage，React 绝不重写它），root 缓存于 el.__mozhenAgentRoot，key＝visit++ 重挂
// （每次 show() 等价 legacy :2038-2130 的整段装载序列，且 hook state 随之重置）。
// legacy 直挂监听里只有 Ctrl/Cmd+Enter 没有被 props 承接（:2045-2050），由本件在挂载后对
// #agent-text 原生绑定；四个 select 的非冒泡 change 承接在叶组件（AgentScopeBar/AgentSidePanel）。
// 另承接两项**命令式写值兜底**（整改三 F1：改落本片新建允许面——挂载副作用、随 visit++ 挂/摘，
// S5-8 六组件零改）：
//   ① #agent-text 原生 input 监听——React 受控输入的 onChange 走 ChangeEventPlugin 的「值变化」判定，
//      脚本用实例 setter 直写 .value 后再派发 input 会被判「未变」而不触发（真实渠道巡检驱动
//      tools/system-browser-acceptance.cjs:854 即此写法）⇒ 元素级监听读 DOM 真值补报（ChatPanel.jsx:186-189
//      同款先例；真实键入时两路同值写入＝幂等）。
//   ② #agent-messages 委托 change 监听——同上，勾选框直写 .checked（驱动 :888/:914）后 React onChange
//      不触发 ⇒ 读 DOM 真值补报 onTogglePick；判定延到微任务＝React 对离散事件同步 flush 先有机会，
//      模型与 DOM 一致即视为已处理 ⇒ 两条路恰好一次（lib togglePick 是「按消息 id 置位」幂等）。
// 依赖注入面：getApp() 五方法／fetch／localStorage／runStatus／BookShell.readWritingReturn。

import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useAgentWorkspace } from "../hooks/use-agent-workspace.js";
import { getApp } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import { readWritingReturn } from "../pages/BookShell.jsx";
import AgentSpace from "./AgentSpace.jsx";

let visit = 0;

// 注入面（一次挂载一份，引用稳定；方法惰性转发，读到最新 App 单例/runStatus）
// P6-2：`getApp()` 恒为对象 ⇒ 原 `|| {}` 兜底成不可达差异（备案）
function buildDeps() {
	const app = () => getApp();
	return {
		api: (method, url, body) => app().api(method, url, body),
		fetchImpl: (url, init) => fetch(url, init),
		toast: (m) => app().toast(m),
		escapeHtml: (s) => app().escapeHtml(s),
		openModal: (opts) => app().openModal(opts),
		closeModal: () => app().closeModal(),
		confirm: (m) => window.confirm(m),
		storage: window.localStorage,
		runStatus: runStatus,
		readWritingReturn: () => readWritingReturn(),
	};
}

function AgentWorkspace({ deps, onReady }) {
	const ws = useAgentWorkspace(deps);
	const submitRef = useRef(ws.submit);
	submitRef.current = ws.submit;
	const showRef = useRef(ws.show);
	showRef.current = ws.show;
	// 命令式写值兜底读最新 props（每次渲染刷新引用，监听只在挂载期注册一次）
	const spRef = useRef(ws.spaceProps);
	spRef.current = ws.spaceProps;
	const startedRef = useRef(false);
	// :2045-2050 Ctrl/Cmd+Enter → send()（原生直挂；卸载即摘）
	useEffect(() => {
		const el = document.getElementById("agent-text");
		if (!el) return;
		const onKeyDown = (ev) => {
			if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
				ev.preventDefault();
				submitRef.current?.();
			}
		};
		el.addEventListener("keydown", onKeyDown);
		return () => el.removeEventListener("keydown", onKeyDown);
	}, []);
	// 命令式写值兜底（元素级原生监听，挂载期注册、卸载/重挂即摘）
	useEffect(() => {
		const ta = document.getElementById("agent-text");
		const onInput = () => {
			const c = spRef.current?.composer;
			if (c && typeof c.onChange === "function") c.onChange(ta.value);
		};
		if (ta) ta.addEventListener("input", onInput);
		const list = document.getElementById("agent-messages");
		const onNativeChange = (ev) => {
			const t = ev.target;
			if (t?.type !== "checkbox" || !t.dataset) return;
			const raw = t.dataset.messageId;
			if (raw === undefined || raw === null || raw === "") return;
			const id = Number(raw);
			const on = !!t.checked;
			queueMicrotask(() => {
				const sp = spRef.current || {};
				const msg = sp.messages || {};
				if ((msg.picks || []).includes(id) === on) return; // React 已处理
				const hit = (msg.items || []).find(
					(m) =>
						m && m.id !== undefined && m.id !== null && Number(m.id) === id,
				);
				if (!hit) return;
				if (typeof msg.onTogglePick === "function") msg.onTogglePick(hit, on);
			});
		};
		if (list) list.addEventListener("change", onNativeChange);
		return () => {
			if (ta) ta.removeEventListener("input", onInput);
			if (list) list.removeEventListener("change", onNativeChange);
		};
	}, []);
	// show 序列每次挂载只跑一次；onReady 让调用方（AppRouter 模块直取 showAgentWorkspace，AppRouter.jsx:98）能 await 整个装载序列（P6-2 前＝window.AgentPage.show() 旧名桥路径）
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		if (typeof onReady === "function") onReady(showRef.current());
	}, [onReady]);
	return <AgentSpace {...ws.spaceProps} />;
}

// 挂载（#page-agent 缺失即 no-op）；返回「本次 show 序列完成」的 promise
export function mountAgentWorkspace() {
	const host = document.getElementById("page-agent");
	if (!host) return Promise.resolve(null);
	let root = host.__mozhenAgentRoot;
	if (!root) {
		root = createRoot(host);
		host.__mozhenAgentRoot = root;
	}
	visit += 1;
	let resolveSequence;
	const sequence = new Promise((resolve) => {
		resolveSequence = resolve;
	});
	root.render(
		createElement(AgentWorkspace, {
			key: `agent-${visit}`,
			deps: buildDeps(),
			onReady: (p) => resolveSequence(p),
		}),
	);
	return sequence.then(() => null);
}

// 路由入口（AppRouter 模块直取 showAgentWorkspace——AppRouter.jsx:24 import／:98 调用；P6-2 前 legacy-bridge 的 window.AgentPage.show 委托至此，等值 :2132）
export async function showAgentWorkspace() {
	await mountAgentWorkspace();
}
