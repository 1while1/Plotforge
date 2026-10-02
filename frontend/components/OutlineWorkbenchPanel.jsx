// S4-7（charter §3，范式 A·判定 C 旧名桥，S4-3 CharacterWorkbenchPanel/S4-4 LedgerWorkbenchPanel
// 同构）：OutlineWorkbenchPanel——大纲工作台整体迁 React（总纲/卷编辑器＋保存守卫＋夜览开关
// ＋卷总结生成），组合 OutlineTimelinePanel（脉络轴）与 OutlineAssistantPanel（页内小助手）。
// S5-4 面板契约笔：旧壳 workbench-shell.js（217 行）与旧名桥（window.OutlineWorkbench）随
// D-S4-9-01 迁移块整体退役，本组件由 WorkbenchPage.jsx 直接 import 渲染（面板重挂＝外壳
// key=<module|entityId|tab> 语义，等值旧 show() 全量重入重拉）。
// 逐字等值移植 public/legacy/outline-workbench.js（184 行）活代码：
// - show 语义（:114-121）：先 OutlineTimeline.reset()、OutlineAssistant.unmount()（React＝
//   key 重挂天然等价）；宿主 loading；beginRequest('outline', bookId) 令牌；
//   Promise.all([GET /api/books/:id, GET /api/books/:id/outline/timeline])；晚到响应按
//   「书 id 不等 或 token 非当前」丢弃（:126-127）。
// - 保存全部（:21-51）：①flushBeats() false → toast「有章节拍点未能保存（可能冲突），请先处理
//   红色提示再保存大纲」return false；②tracker.snapshot() → PUT {master_outline}；③卷卡锁定
//   选择器 .volume-outline-card[data-volume]（:32-33 注释：脉络轴节点也带 data-volume）→ 逐卷
//   PUT {title,intro,outline}，任一失败 break；④失败 toast「保存中断（保存失败）：<msg>（总纲与
//   其后部分卷可能未保存，草稿仍在，请重试）」return false；⑤tracker.settle(snapshot,true) false
//   → toast「保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库」return false；
//   ⑥toast「大纲已保存」return true。
// - 守卫（:53-73）：clearGuards(g => g.key==='outline') 后 registerGuard({key:'outline',
//   label:'大纲工作台', isDirty: tracker.isDirty() || hasDirtyBeats(), save: saveAll,
//   discard: tracker.clear()})；dirty 绑定字段 #workbench-master-outline,[data-volume-title],
//   [data-volume-intro],[data-volume-outline]（:56，input 即 tracker.mark()）；**unmount 不注销
//   守卫**（跨模块存续直到下次 clearGuards，:75 同款先例）；save/isDirty 经 ref 读最新态。
// - 重渲纪律（:79-96）：结构变化只重渲 [data-tl-slot] 插槽与 #outline-loose-chapters，
//   **不重渲卷编辑器**（正在输入的文本不丢——React 非受控 defaultValue 天然满足）；
//   onStructureChanged → refreshTimelines(true)（先 flushBeats）、onConflict →
//   refreshTimelines(false)；刷新失败 toast「脉络轴刷新失败：<msg>」（:144）。
// - 卷卡（:106-111）：序号「第 N 卷 · M 章」＋标题 input＋阶段目标/卷大纲 textarea＋卷总结
//   readonly textarea（placeholder「（尚未生成）」）＋按钮「生成并保存卷总结」/
//   「重新生成并保存卷总结」(data-gen-summary)＋.tl-slot 插槽；空卷态（:133）；未归卷块（:98-104）。
// - 夜览（:16-17/:151-156）：.outline-workspace 挂 outline-night 类；localStorage key
//   mozhen-outline-night（'1'/'0'）；按钮文案 ☀ 日间/☾ 夜览。
// - 卷总结生成（:164-178）：按钮 disabled＋「生成中…（依赖模型速度）」→ POST /volumes/:vid/summary
//   {} → toast「卷总结已生成并保存」→ 整页重渲（重新 show＝外壳 key 重挂重拉）；失败 toast
//   「卷总结生成失败：<msg>」＋按钮恢复「生成并保存卷总结」。
// - URL 形态（:29/:85）：/api/books/ + bookId 无 encodeURIComponent（:29 逐字，vm stub 按
//   解码值匹配）；escapeHtml 经 getApp().escapeHtml（:8 不转 null——esc 原样传）。

import { useEffect, useReducer, useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import OutlineAssistantPanel from "./OutlineAssistantPanel.jsx";
import { OutlineTimelinePanel } from "./OutlineTimelinePanel.jsx";

// P6-4（S5-4-X3）：本文件仅有的两处 esc() 文本节点用法（loose 标题/错误消息）已直投原始值，
// esc 死代码随之移除（S5-4 F1 WorldWorkbenchPanel 先例＝esc 全退役零命中）；
// :293-296/:391/:399/:427 等 HTML 串/属性位转义在 OutlineTimelinePanel.jsx 内保留。

const NIGHT_KEY = "mozhen-outline-night";
function nightOn() {
	try {
		return localStorage.getItem(NIGHT_KEY) === "1";
	} catch {
		return false;
	}
}

function looseHTML(chapters) {
	const loose = chapters.filter((ch) => ch.volume_id == null);
	if (!loose.length) return null;
	return (
		<section className="master-outline-card">
			<span className="workbench-kicker">未归卷章节</span>
			<p className="field-hint">
				这些章节不属于任何卷，不进脉络轴。到章节页把它们归卷后再回来排布。
			</p>
			<ul>
				{loose.map((ch) => (
					<li key={ch.id}>{ch.title}</li>
				))}
			</ul>
		</section>
	);
}

export function OutlineWorkbenchPanel({ route }) {
	const [, bump] = useReducer((x) => x + 1, 0);
	// 旧模块级闭包 state（:10-13）逐字移植：所有异步函数经 st.current 读写＋bump 重渲
	const st = useRef(null);
	if (!st.current) {
		st.current = {
			book: null,
			timelineData: null, // 最近一次 /outline/timeline 响应（刷新脉络轴用，:13）
			error: null,
			loading: true,
			genBusy: {}, // volumeId -> true（卷总结生成中）
			night: nightOn(), // :16-17 初始由 localStorage 决定
			reloadSeq: 0, // show/整页重渲 +1：脉络轴 key 变化＝等值旧 reset()+render() 重挂
			dataVersion: 0, // refreshTimelines +1：仅同步数据＝等值旧 render() 合并（保留节拍脏态）
		};
	}
	const state = st.current;
	const trackerRef = useRef(null); // S4-03：脏编辑追踪（:10）
	const [saving, setSaving] = useState(false);

	function api(method, path, body) {
		// :29/:85 逐字——/api/books/ + bookId 无 encodeURIComponent
		return getApp().api(method, `/api/books/${route.bookId}${path}`, body);
	}
	function ws() {
		return getWorkspaceState();
	}
	function chaptersOfVolume(volumeId) {
		return (state.timelineData ? state.timelineData.chapters : []).filter(
			(ch) => Number(ch.volume_id) === Number(volumeId),
		);
	}

	// 保存全部（:19-51 逐字）
	async function saveAll() {
		// ① 先落节拍（行内自动保存的兜底）——React 版经子组件 ref 暴露的 flushBeats
		if (!(await flushBeats())) {
			getApp().toast(
				"有章节拍点未能保存（可能冲突），请先处理红色提示再保存大纲",
			);
			return false;
		}
		const tracker = trackerRef.current;
		const snapshot = tracker ? tracker.snapshot() : 0;
		let failure = null;
		try {
			await api("PUT", "", {
				master_outline: document.getElementById("workbench-master-outline")
					.value,
			});
		} catch (e) {
			failure = e;
		}
		if (!failure) {
			// 必须锁定卷卡：脉络轴节点也带 data-volume 属性，裸选择器会把节点当卷卡（:32-33 逐字）
			const cards = document.querySelectorAll(
				".volume-outline-card[data-volume]",
			);
			for (let i = 0; i < cards.length; i++) {
				const card = cards[i];
				try {
					await api("PUT", `/volumes/${card.dataset.volume}`, {
						title: card.querySelector("[data-volume-title]").value,
						intro: card.querySelector("[data-volume-intro]").value,
						outline: card.querySelector("[data-volume-outline]").value,
					});
				} catch (e) {
					failure = e;
					break;
				}
			}
		}
		if (failure) {
			getApp().toast(
				`保存中断（保存失败）：${failure.message}（总纲与其后部分卷可能未保存，草稿仍在，请重试）`,
			);
			return false;
		}
		if (tracker && !tracker.settle(snapshot, true)) {
			getApp().toast(
				"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
			);
			return false;
		}
		getApp().toast("大纲已保存");
		return true;
	}

	// ---------- 跨组件契约：脉络轴 flushBeats/hasDirtyBeats（ref 注册表） ----------
	// 旧 OutlineTimeline 为模块级单例（workbench :22/:68/:84 直接调 window.OutlineTimeline）；
	// React 版每卷一个 OutlineTimelinePanel 实例，父组件经 ref 注册表汇总调用。
	const timelineApisRef = useRef(new Map());
	function registerTimelineApi(volumeId, apiObj) {
		if (apiObj) timelineApisRef.current.set(Number(volumeId), apiObj);
		else timelineApisRef.current.delete(Number(volumeId));
	}
	async function flushBeats() {
		const apis = Array.from(timelineApisRef.current.values());
		for (let i = 0; i < apis.length; i++) {
			if (!(await apis[i].flushBeats())) return false;
		}
		return true;
	}
	function hasDirtyBeats() {
		for (const apiObj of timelineApisRef.current.values()) {
			if (apiObj.hasDirtyBeats()) return true;
		}
		return false;
	}

	// 守卫（:53-73 逐字）：先 clearGuards(key==='outline') 再注册；unmount 不注销
	function installGuard() {
		const w = ws();
		if (!w?.registerGuard) return;
		if (!trackerRef.current) trackerRef.current = w.dirtyTracker();
		w.clearGuards((g) => g.key === "outline");
		w.registerGuard({
			key: "outline",
			label: "大纲工作台",
			isDirty: () =>
				(!!trackerRef.current && trackerRef.current.isDirty()) ||
				hasDirtyBeats(),
			save: () => saveAll(),
			discard: () => {
				if (trackerRef.current) trackerRef.current.clear();
			},
		});
	}

	// 只重渲脉络轴插槽（卷编辑器里的未保存文本不动）——:79-96 逐字
	// flushFirst：拖拽/采纳后重渲前先把未落库的节拍落库，避免输入被重渲吃掉；
	// 冲突场景调用方传 false（冲突保存重试只会再撞 409）。
	// L1（S4-7 低危残项核销，plans/S4-7-review-4.md §5）：refreshTimelines 不做 legacy
	// outline-workbench.js:86 的模块级 stale 检查——**不变量＝本实例经 key 恒递增与书绑定**
	// （调用方 WorkbenchPage.jsx:96 `<OutlineWorkbenchPanel key={key} …/>`，key 递增即整棵重挂，
	// WorkbenchPage.test.jsx W6 钉住）：一实例只可能属一书，过期响应只会写入已卸载实例的 ref，
	// 不产生可见状态串书，故与 loadAll 的 isCurrent 双检无需在此重复（净行为等值）。
	async function refreshTimelines(flushFirst) {
		if (!state.timelineData) return;
		if (flushFirst) await flushBeats();
		try {
			const res = await api("GET", "/outline/timeline");
			state.timelineData = res;
			state.dataVersion += 1; // 只同步数据＝等值旧 render() 合并语义（beatDirty 保留）
			bump((x) => x + 1);
		} catch (e) {
			if (flushFirst) getApp().toast(`脉络轴刷新失败：${e.message}`);
			// 冲突路径静默（:145 .catch(function () {}) 逐字）
		}
	}

	// 卷总结生成（:163-178 逐字）
	async function onGenSummary(volumeId) {
		state.genBusy[volumeId] = true;
		bump((x) => x + 1);
		try {
			await api("POST", `/volumes/${volumeId}/summary`, {});
			getApp().toast("卷总结已生成并保存");
			// :171 整页重渲＝重新 show（React 版：重拉数据＋reloadSeq++ 全量重挂）
			await loadAll();
		} catch (e) {
			getApp().toast(`卷总结生成失败：${e.message}`);
			state.genBusy[volumeId] = false;
			bump((x) => x + 1);
		}
	}

	// show 数据加载（:114-127 逐字）：两拉＋双绑过期丢弃
	async function loadAll() {
		const bookId = String(route.bookId);
		const token = ws()?.beginRequest
			? ws().beginRequest("outline", bookId)
			: null;
		try {
			const result = await Promise.all([
				api("GET", ""),
				api("GET", "/outline/timeline"),
			]);
			// 切书后晚到的响应：token 与书 id 双绑，过期即丢弃（不把 A 书结构写进 B 书）
			if (bookId !== String(route.bookId)) return;
			if (token && !ws().isCurrent(token, bookId)) return;
			state.book = result[0].book;
			state.timelineData = result[1];
			state.error = null;
			state.loading = false;
			state.reloadSeq += 1; // 整页重渲：脉络轴重挂＝等值旧 reset()+render()
			bump((x) => x + 1);
			// :180-181 bindDirty＋registerGuard 在渲染后（守卫 save 闭包经 ref 读最新态）
			installGuard();
		} catch (e) {
			state.error = e;
			state.loading = false;
			bump((x) => x + 1);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: key=reloadSeq/外层 visit++ 重挂即重跑，等值旧 show(route) 每次全量
	useEffect(() => {
		loadAll();
		// effect cleanup：脉络轴定时器由各 OutlineTimelinePanel 自身 cleanup 清（:365 等值）；
		// 守卫不注销——跨模块存续，下次 show 的 clearGuards 才清（LedgerWorkbenchPanel L15 同款）
	}, []);

	function onSaveAll() {
		// :158-162 逐字：保存期间按钮 disabled，finally 复原（React state 版）
		setSaving(true);
		(async () => {
			try {
				await saveAll();
			} finally {
				setSaving(false);
			}
		})();
	}

	function toggleNight() {
		const on = !state.night;
		state.night = on;
		try {
			localStorage.setItem(NIGHT_KEY, on ? "1" : "0");
		} catch {
			/* 忽略（:154 逐字） */
		}
		bump((x) => x + 1);
	}

	function markDirty() {
		if (trackerRef.current) trackerRef.current.mark(); // :14/:57 input 即脏
	}

	// ---------- 渲染 ----------
	if (state.error) {
		// :182 错误态
		return <div className="workbench-error">{state.error.message}</div>;
	}
	if (state.loading || !state.timelineData) {
		// :118 loading 态
		return <div className="workbench-loading">正在展开全书结构…</div>;
	}

	const volumes = state.timelineData.volumes || [];
	const night = state.night;
	const volumeCards = volumes.map((volume) => {
		const count = chaptersOfVolume(volume.id).length;
		const busy = !!state.genBusy[volume.id];
		return (
			<article
				className="volume-outline-card"
				data-volume={volume.id}
				key={`vol-${volume.id}`}
			>
				<div>
					<span>
						第 {volume.sort_order} 卷 · {count} 章
					</span>
					<input
						data-volume-title
						defaultValue={volume.title}
						onInput={markDirty}
					/>
				</div>
				<label>
					阶段目标与冲突
					<textarea
						data-volume-intro
						rows={3}
						defaultValue={volume.intro || ""}
						onInput={markDirty}
					/>
				</label>
				<label>
					卷大纲
					<textarea
						data-volume-outline
						rows={7}
						defaultValue={volume.outline || ""}
						onInput={markDirty}
					/>
				</label>
				<label>
					卷总结（写作上下文与卷末检视都会用到；由已定稿/已总结章节凝练）
					<textarea
						data-volume-summary
						rows={4}
						readOnly
						placeholder="（尚未生成）"
						defaultValue={volume.summary || ""}
					/>
				</label>
				<button
					className="btn btn-ghost btn-small"
					type="button"
					data-gen-summary={volume.id}
					disabled={busy}
					onClick={() => onGenSummary(volume.id)}
				>
					{busy
						? "生成中…（依赖模型速度）"
						: volume.summary
							? "重新生成并保存卷总结"
							: "生成并保存卷总结"}
				</button>
				{/* 脉络轴插槽（:137-142）：key 含 visit＝等值旧 render() 重挂重拉 */}
				<div className="tl-slot" data-tl-slot={volume.id}>
					<OutlineTimelinePanel
						key={`tl-${volume.id}-${state.reloadSeq}`}
						bookId={route.bookId}
						volume={volume}
						chapters={chaptersOfVolume(volume.id)}
						intensity={state.timelineData.intensity || {}}
						dataVersion={state.dataVersion}
						registerApi={registerTimelineApi}
						onStructureChanged={() =>
							refreshTimelines(true).catch((e) =>
								getApp().toast(`脉络轴刷新失败：${e.message}`),
							)
						}
						onConflict={() => refreshTimelines(false).catch(() => {})}
					/>
				</div>
			</article>
		);
	});

	return (
		<div className={`outline-workspace${night ? " outline-night" : ""}`}>
			<header className="workspace-heading">
				<div>
					<span className="workbench-kicker">STORY ARCHITECTURE</span>
					<h2>大纲工作台</h2>
					<p>总纲定方向，卷纲定阶段，脉络轴上排章节、写拍点、看节奏。</p>
				</div>
				<div className="workspace-actions">
					<button
						id="outline-night-toggle"
						className="btn btn-ghost"
						type="button"
						onClick={toggleNight}
					>
						{night ? "☀ 日间" : "☾ 夜览"}
					</button>
					<button
						id="save-outline-workbench"
						className="btn btn-primary"
						type="button"
						disabled={saving}
						onClick={onSaveAll}
					>
						保存全部大纲
					</button>
				</div>
			</header>
			<section className="master-outline-card">
				<label>
					全书总纲
					<textarea
						id="workbench-master-outline"
						rows={9}
						defaultValue={state.book?.master_outline || ""}
						onInput={markDirty}
					/>
				</label>
			</section>
			<div className="volume-outline-list">
				{volumes.length ? (
					volumeCards
				) : (
					<section className="workbench-empty-card">
						<h3>还没有分卷</h3>
						<p>到章节页创建第一卷后，这里会出现脉络轴。</p>
					</section>
				)}
			</div>
			<div id="outline-loose-chapters">
				{looseHTML(state.timelineData.chapters || [])}
			</div>
			{/* 小助手胶囊挂到工作台容器（:148 等值） */}
			<OutlineAssistantPanel bookId={route.bookId} />
		</div>
	);
}
