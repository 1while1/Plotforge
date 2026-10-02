// S4-7（charter §3，范式 A·判定 C 旧名桥，S4-3 CharacterWorkbenchPanel/S4-4 LedgerWorkbenchPanel
// 同构）：OutlineTimelinePanel——卷内脉络轴整体迁 React（节点卡/烈度着色/节奏条/缝隙填补/
// 拖拽排序/节拍自动保存），父组件 OutlineWorkbenchPanel 组合本件。逐字等值移植
// public/legacy/outline-timeline.js（374 行）活代码：
// - 数据契约 {volumes, chapters, intensity}；烈度档位 0/1-4（:25-30 逐字：无事件 0，
//   Math.max(1, Math.min(4, max_importance||1))；TIER_LABEL 五档）。
// - 节拍自动保存（:114-166）：值未变清状态位不发请求；PUT {beat, expected_revision}；
//   响应 chapter 为准刷新 revision；persistence.durable===false →「已保存（磁盘写入重试中）」；
//   冲突（code CHAPTER_CONFLICT / 409 / 428）→「冲突：内容已在别处更新」＋toast＋onConflict；
//   其他失败「保存失败：<msg>」；input → dirty「未保存」＋900ms 防抖；blur 有脏即立即保存；
//   flushBeats() 对全部 dirty 章清 timer 后逐章 await 保存、返回「是否全部已清」；
//   hasDirtyBeats()；effect cleanup 清全部 timer。
// - 拖拽（:174-241）：仅同卷（volumeOf(node) !== String(volume.id) 拒绝）；只有把手
//   mousedown/mouseup 置 card.draggable（整卡 draggable 会吃文本选择）；dragstart 记 dragId；
//   dragover 计算 before（上半/下半）＋drop-before/drop-after 类；drop → reorderVolume：
//   按渲染序算新 ids（from<to 修正）→ 只对 sort_order 变化的章逐个 PUT {sort_order,
//   expected_revision}（自 1 起）→ 成功 toast「章节顺序已调整」／失败 toast
//   「排序保存失败：<msg>（已恢复原顺序）」；两路径都调 onStructureChanged。
// - 缝隙（:58-62/:83-88/:245-263）：按钮文案「＋ 补卷首/补第一章/补衔接/补卷末」；
//   POST /outline/fill-gap {volume_id, before_chapter_id, after_chapter_id}；处理中
//   「AI 推演中…」＋disabled；失败 toast「缝隙填补失败：<msg>」。填缝弹窗（:266-278）：
//   openModal{title:'衔接章方案', okText:'关闭'}＋hint 逐字＋建议卡 .gap-suggestion。
// - 采纳（:280-315）：POST /chapters {volume_id,title,beat}；指定 before → 整卷按
//   sort_order 重排逐个 PUT；成功 toast「已采纳并建章：《<title>》」＋onStructureChanged；
//   失败 toast「采纳失败：<msg>」＋按钮恢复「采纳为章节」。
// - 节奏评语（:319-352）：POST /outline/tension-review {volume_id}；处理中「分析中…」
//   ＋disabled；弹窗 title「AI 节奏评语」okText「关闭」＋blockquote.tension-comment＋
//   ul.tension-scores（.tl-score-dot tier-clamp(t-1,1,4)「<标题> —— 张力 t/5」）；
//   chapter_scores 空 → hint「模型未给出逐章分数。」；失败 toast「节奏分析失败：<msg>」。
// - reset（:364-373）：清全部 timer＋state 归零。React 版由 key 重挂天然等价（父组件
//   每卷插槽 key 含 visit），未落库节拍由父组件守卫 save 的 flushBeats 兜底。
// - API 前缀（:20-22）：/api/books/ + encodeURIComponent(bookId)（与 vm stub 口径一致）；
//   escapeHtml 经 getApp().escapeHtml（null 归一：esc(v == null ? '' : String(v))）。
// 已知等值差异（无行为回归，记录备审）：旧模块级 state.chapters/intensity 跨 render 累积，
// React 每次重挂全新 state——脉络轴随父组件 visit 重挂整体重建，语义同旧 reset()+render()。

import { useEffect, useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";

// 烈度 → 档位名（着色与文案共用）：0 无事件 / 1 低 / 2 常 / 3 高 / 4 极（:24-30 逐字）
function intensityTier(chapterId, intensity) {
	const stat = intensity[chapterId];
	if (!stat?.event_count) return 0;
	return Math.max(1, Math.min(4, Number(stat.max_importance) || 1));
}
const TIER_LABEL = ["无台账事件", "低烈度", "常规推进", "高烈度", "关键爆发"];

function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

export function OutlineTimelinePanel({
	bookId,
	volume,
	chapters,
	intensity,
	dataVersion,
	registerApi,
	onStructureChanged,
	onConflict,
}) {
	// 旧 state（:9-17）逐字移植为 ref＋bump：异步闭包读最新态，避免 setState 过期
	const [, bump] = useState(0);
	const st = useRef(null);
	if (!st.current) {
		st.current = {
			chapters: null, // id -> 章（含 revision，保存成功后以响应为准刷新，:99）
			intensity: {}, // chapterId -> { event_count, max_importance }，:100
			beatTimers: {}, // chapterId -> 防抖定时器，:13
			beatDirty: {}, // chapterId -> true 有未落库输入，:14
			beatState: {}, // chapterId -> { text, cls } 状态位（旧 setBeatState 的 DOM 直写）
			dragId: null, // 正在拖拽的章 id，:16
			armedCard: null, // 把手按下中的卡（整卡 draggable 会吃文本选择，:178-183）
			gapBusy: "", // 缝隙按钮处理中键（volume|before|after）
			tensionBusy: false,
		};
	}
	const state = st.current;
	// render（:97-103）：chapters 建 id->章 映射（旧 state.chapters 为对象映射，:11 逐字）。
	// 两种「重渲」语义拆分（对齐 legacy 两条路径）：
	// - 父组件 show/整页重渲 → 本面板 key 变化重挂（＝旧 reset() 清空全部 state 后 render()）；
	// - 父组件 refreshTimelines → dataVersion++ 触发下方同步 effect（＝旧 render() 的合并语义：
	//   :99-100 以服务端数据覆盖 chapters/intensity，**保留** beatDirty/beatTimers——冲突刷新后
	//   守卫仍能拦住未落库输入，等值旧模块态跨 render 累积）。
	if (state.chapters === null) {
		const map = {};
		chapters.forEach((ch) => {
			map[ch.id] = ch;
		});
		state.chapters = map;
	}
	state.intensity = intensity || {};

	// 数据同步（等值旧 :99-100）：dataVersion 变化＝父组件重拉了 /outline/timeline
	// biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion 是重拉信号，chapters/intensity 随同批到达
	useEffect(() => {
		chapters.forEach((ch) => {
			state.chapters[ch.id] = ch;
		});
		state.intensity = intensity || {};
		bump((x) => x + 1);
	}, [dataVersion]);

	// 跨组件契约句柄：每次重渲换新闭包，父组件经稳定包装调用（避免注册首帧闭包读到过期 props）
	const apiRef = useRef(null);
	apiRef.current = { flushBeats, hasDirtyBeats };

	// effect cleanup：清全部节拍定时器（:365 reset 的 timer 清理部分；state 归零由 key
	// 重挂天然等价，未落库节拍由父守卫 save 的 flushBeats 兜底——Plan §2.4 reset 注）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载/卸载时注册与清定时器，state/apiRef 为稳定 ref
	useEffect(() => {
		// 跨组件契约：向父组件注册 flushBeats/hasDirtyBeats（旧 window.OutlineTimeline.flushBeats/
		// hasDirtyBeats 的 React 等价——workbench :22/:68 两处消费点）
		if (typeof registerApi === "function") {
			registerApi(volume.id, {
				flushBeats: () => apiRef.current.flushBeats(),
				hasDirtyBeats: () => apiRef.current.hasDirtyBeats(),
			});
		}
		return () => {
			Object.keys(state.beatTimers).forEach((k) => {
				clearTimeout(state.beatTimers[k]);
			});
			state.beatTimers = {};
			if (typeof registerApi === "function") registerApi(volume.id, null);
		};
	}, []);

	function api(method, path, body) {
		return getApp().api(
			method,
			`/api/books/${encodeURIComponent(bookId)}${path}`,
			body,
		);
	}

	function setBeatState(chapterId, text, cls) {
		state.beatState[chapterId] = { text, cls };
		bump((x) => x + 1);
	}

	async function saveBeat(chapterId) {
		const ch = state.chapters[chapterId];
		const input = document.querySelector(`[data-beat="${chapterId}"]`);
		if (!ch || !input) return;
		// 保存即清该章防抖定时器（等值旧 :146/:151/:161 的 clearTimeout 三处调用汇总）
		const timerId = state.beatTimers[chapterId];
		if (timerId != null) {
			clearTimeout(timerId);
			if (state.beatTimers[chapterId] === timerId)
				delete state.beatTimers[chapterId];
		}
		const value = input.value.trim();
		// 值未变 → 清 dirty 状态位，不发请求（:119 逐字）
		if (value === (ch.beat || "").trim()) {
			state.beatDirty[chapterId] = false;
			setBeatState(chapterId, "", "");
			return;
		}
		setBeatState(chapterId, "保存中…", "saving");
		try {
			const res = await api("PUT", `/chapters/${chapterId}`, {
				beat: value,
				expected_revision: ch.revision,
			});
			// 成功以响应 chapter 为准刷新（:124 Object.assign 逐字）
			if (res?.chapter)
				state.chapters[chapterId] = Object.assign({}, ch, res.chapter);
			state.beatDirty[chapterId] = false;
			setBeatState(
				chapterId,
				res?.persistence?.durable === false
					? "已保存（磁盘写入重试中）"
					: "已保存",
				"saved",
			);
		} catch (e) {
			if (
				e &&
				(e.code === "CHAPTER_CONFLICT" || e.status === 409 || e.status === 428)
			) {
				setBeatState(chapterId, "冲突：内容已在别处更新", "failed");
				getApp().toast("节拍保存冲突：该章已在别处更新，正在刷新脉络轴");
				if (typeof onConflict === "function") onConflict();
			} else {
				setBeatState(chapterId, `保存失败：${e.message}`, "failed");
			}
		}
	}

	function onBeatInput(chapterId) {
		state.beatDirty[chapterId] = true;
		setBeatState(chapterId, "未保存", "dirty");
		clearTimeout(state.beatTimers[chapterId]);
		state.beatTimers[chapterId] = setTimeout(() => {
			saveBeat(chapterId);
		}, 900);
	}

	function onBeatBlur(chapterId) {
		if (!state.beatDirty[chapterId]) return;
		clearTimeout(state.beatTimers[chapterId]);
		delete state.beatTimers[chapterId];
		saveBeat(chapterId);
	}

	// 离开保护接入：未落库节拍先强制落库（:158-168 逐字）
	async function flushBeats() {
		const ids = Object.keys(state.beatDirty).filter(
			(id) => state.beatDirty[id],
		);
		for (let i = 0; i < ids.length; i++) {
			clearTimeout(state.beatTimers[ids[i]]);
			delete state.beatTimers[ids[i]];
			await saveBeat(Number(ids[i]));
		}
		return !Object.keys(state.beatDirty).some((id) => state.beatDirty[id]);
	}
	function hasDirtyBeats() {
		return Object.keys(state.beatDirty).some((id) => state.beatDirty[id]);
	}

	// 拖拽（:172-241 逐字）
	function volumeOf(nodeEl) {
		return nodeEl.dataset.volume || "";
	}

	async function reorderVolume(dragId, targetId, insertBefore) {
		const ids = chapters.map((ch) => Number(ch.id));
		const from = ids.indexOf(dragId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		ids.splice(from, 1);
		ids.splice(
			insertBefore ? to - (from < to ? 1 : 0) : to + (from < to ? 0 : 1),
			0,
			dragId,
		);
		const changed = [];
		ids.forEach((id, i) => {
			const ch = state.chapters[id];
			const want = i + 1;
			if (ch && ch.sort_order !== want)
				changed.push({ chapter: ch, sort_order: want });
		});
		if (!changed.length) return;
		try {
			for (let i = 0; i < changed.length; i++) {
				const item = changed[i];
				const res = await api("PUT", `/chapters/${item.chapter.id}`, {
					sort_order: item.sort_order,
					expected_revision: item.chapter.revision,
				});
				if (res?.chapter)
					state.chapters[item.chapter.id] = Object.assign(
						{},
						item.chapter,
						res.chapter,
					);
			}
			getApp().toast("章节顺序已调整");
		} catch (e) {
			getApp().toast(`排序保存失败：${e.message}（已恢复原顺序）`);
		}
		if (typeof onStructureChanged === "function") onStructureChanged();
	}

	// 缝隙填补（:245-278）
	async function onGapClick(volumeId, beforeId, afterId) {
		state.gapBusy = `${volumeId}|${beforeId}|${afterId}`;
		bump((x) => x + 1);
		try {
			const res = await api("POST", "/outline/fill-gap", {
				volume_id: volumeId,
				before_chapter_id: beforeId,
				after_chapter_id: afterId,
			});
			openGapModal(volumeId, beforeId, afterId, res.suggestions || []);
		} catch (e) {
			getApp().toast(`缝隙填补失败：${e.message}`);
		} finally {
			state.gapBusy = "";
			bump((x) => x + 1);
		}
	}

	function openGapModal(volumeId, beforeId, afterId, suggestions) {
		const body =
			'<p class="field-hint">AI 只给方案，不写库。点「采纳为章节」才会在该位置建章（标题与节拍可再改）。</p>' +
			suggestions
				.map(
					(s, i) =>
						`<article class="gap-suggestion"><header><strong>${esc(s.title)}</strong></header>` +
						`<p class="gap-beat">${esc(s.beat)}</p>` +
						(s.rationale
							? `<p class="gap-rationale">${esc(s.rationale)}</p>`
							: "") +
						`<button class="btn btn-primary btn-small" data-adopt-gap="${i}">采纳为章节</button></article>`,
				)
				.join("");
		getApp().openModal({
			title: "衔接章方案",
			okText: "关闭",
			bodyHTML: body,
		});
		// 弹窗按钮绑定（:275-277 逐字：openModal 返回后 querySelectorAll 绑定 onclick）
		document.querySelectorAll("[data-adopt-gap]").forEach((btn) => {
			btn.onclick = () => {
				adoptGap(
					volumeId,
					beforeId,
					afterId,
					suggestions[Number(btn.dataset.adoptGap)],
					btn,
				);
			};
		});
	}

	async function adoptGap(volumeId, beforeId, _afterId, suggestion, btn) {
		btn.disabled = true;
		btn.textContent = "落章中…";
		try {
			const created = await api("POST", "/chapters", {
				volume_id: volumeId,
				title: suggestion.title,
				beat: suggestion.beat,
			});
			const chapter = created?.chapter;
			// 新建章落在卷尾；指定了 before 时把它提到 before 之后（整卷重排一次，:286-307）
			if (chapter && beforeId != null) {
				const chs = Object.keys(state.chapters)
					.map((k) => state.chapters[k])
					.filter((c) => Number(c.volume_id) === Number(volumeId))
					.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
				const ids = chs.map((c) => c.id);
				ids.push(chapter.id);
				const pos = ids.indexOf(beforeId);
				ids.splice(ids.indexOf(chapter.id), 1);
				ids.splice(pos + 1, 0, chapter.id);
				const all = Object.assign({}, state.chapters);
				all[chapter.id] = chapter;
				for (let i = 0; i < ids.length; i++) {
					const id = ids[i];
					const want = i + 1;
					const cur = all[id];
					if (cur && cur.sort_order !== want) {
						const res = await api("PUT", `/chapters/${id}`, {
							sort_order: want,
							expected_revision: cur.revision,
						});
						if (res?.chapter) all[id] = Object.assign({}, cur, res.chapter);
					}
				}
			}
			getApp().toast(`已采纳并建章：《${suggestion.title}》`);
			if (typeof onStructureChanged === "function") onStructureChanged();
		} catch (e) {
			getApp().toast(`采纳失败：${e.message}`);
			btn.disabled = false;
			btn.textContent = "采纳为章节";
		}
	}

	// 节奏评语（:319-352）
	async function onTensionReview(volumeId) {
		state.tensionBusy = true;
		bump((x) => x + 1);
		try {
			const res = await api("POST", "/outline/tension-review", {
				volume_id: volumeId,
			});
			openTensionModal(res);
		} catch (e) {
			getApp().toast(`节奏分析失败：${e.message}`);
		} finally {
			state.tensionBusy = false;
			bump((x) => x + 1);
		}
	}

	function openTensionModal(res) {
		const scores = res.chapter_scores || {};
		const ids = Object.keys(scores);
		const rows = ids
			.map((cid) => {
				const ch = state.chapters[cid];
				const t = scores[cid];
				return (
					`<li><span class="tl-score-dot tier-${Math.max(1, Math.min(4, t - 1))}"></span>` +
					`${esc(ch ? ch.title : `章节 ${cid}`)} —— 张力 ${t}/5</li>`
				);
			})
			.join("");
		getApp().openModal({
			title: "AI 节奏评语",
			okText: "关闭",
			bodyHTML:
				`<blockquote class="tension-comment">${esc(res.comment || "")}</blockquote>` +
				(rows
					? `<ul class="tension-scores">${rows}</ul>`
					: '<p class="field-hint">模型未给出逐章分数。</p>'),
		});
	}

	// ---------- 渲染（JSX 等值旧 nodeHTML/gapHTML/tensionStripHTML/timelineHTML） ----------
	function tensionStrip() {
		if (!chapters.length) return null;
		let maxLen = 1;
		chapters.forEach((ch) => {
			if ((ch.content_length || 0) > maxLen) maxLen = ch.content_length;
		});
		const bars = chapters.map((ch, i) => {
			const stat = state.intensity[ch.id] || {
				event_count: 0,
				max_importance: 0,
			};
			const tier = intensityTier(ch.id, state.intensity);
			const len = ch.content_length || 0;
			// 柱高=篇幅归一；不能用事件数做柱高——没事件的柱子会塌成 4px 虚线（:64-65 逐字）
			const h = len ? Math.max(8, Math.round((len / maxLen) * 40)) : 4;
			return (
				<span
					key={ch.id}
					className={`tl-bar tier-${tier}${len ? "" : " tl-bar-empty"}`}
					style={{ height: `${h}px` }}
					title={`第 ${i + 1} 章 ${esc(ch.title)}：${len ? `${len} 字` : "未写正文"}；台账 ${stat.event_count} 条，${TIER_LABEL[tier]}`}
				/>
			);
		});
		return (
			<div className="tl-strip">
				<span
					className="tl-strip-label"
					title="柱高=篇幅（字数），颜色=台账烈度（无事件为灰）"
				>
					节奏
				</span>
				<div className="tl-strip-bars">{bars}</div>
			</div>
		);
	}

	function gapRow(beforeId, afterId, label) {
		const key = `${beforeId == null ? "" : beforeId}|${afterId == null ? "" : afterId}`;
		const busy = state.gapBusy === `${volume.id}|${beforeId}|${afterId}`;
		return (
			<div className="tl-gap-row" key={`gap-${key}`}>
				<button
					className="tl-gap"
					type="button"
					data-gap-volume={volume.id}
					data-gap-before={beforeId == null ? "" : beforeId}
					data-gap-after={afterId == null ? "" : afterId}
					title="让 AI 给这个位置设计 2-3 个衔接章方案"
					disabled={busy}
					onClick={() => onGapClick(volume.id, beforeId, afterId)}
				>
					{busy ? "AI 推演中…" : `＋ ${label}`}
				</button>
			</div>
		);
	}

	function nodeCard(ch, index) {
		const tier = intensityTier(ch.id, state.intensity);
		const stat = state.intensity[ch.id] || {
			event_count: 0,
			max_importance: 0,
		};
		const meta = [];
		if (ch.content_length) meta.push(`${ch.content_length} 字`);
		if (stat.event_count)
			meta.push(`台账 ${stat.event_count} 条 · ${TIER_LABEL[tier]}`);
		if (ch.locked) meta.push("已定稿");
		if (ch.drift_status === "drifted") meta.push("偏离大纲");
		// 标题已带「第N章」前缀（建章时自动编号）就不重复序号称谓（:42-44 逐字）
		const hasOrdinal = /^第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*章/.test(
			ch.title || "",
		);
		const heading = hasOrdinal ? ch.title : `第 ${index + 1} 章 · ${ch.title}`;
		const beat = state.beatState[ch.id] || { text: "", cls: "" };
		const armed = state.armedCard === Number(ch.id);
		return (
			<div
				className="tl-node"
				key={ch.id}
				data-chapter={ch.id}
				data-volume={ch.volume_id || ""}
			>
				<span className={`tl-dot tier-${tier}`} title={TIER_LABEL[tier]} />
				<article
					className={`tl-card${state.dragId === Number(ch.id) ? " dragging" : ""}`}
					data-chapter={ch.id}
					draggable={armed}
					onDragStart={(e) => {
						state.dragId = Number(e.currentTarget.dataset.chapter);
						if (e.dataTransfer) {
							e.dataTransfer.effectAllowed = "move";
							e.dataTransfer.setData("text/plain", String(state.dragId));
						}
						bump((x) => x + 1);
					}}
					onDragEnd={(e) => {
						state.dragId = null;
						state.armedCard = null;
						// L3（S4-7 低危残项核销；S5-10-X4 域修正）：拖拽取消（Esc／拖到卡外松手）后清掉残留
						// 的 drop-before/drop-after 指示类——逐卷作用域（legacy bindDrag(root, volume) 的
						// dragend 清理域即本卷轴，outline-timeline.js:189-191）：closest 取源卡所在卷的
						// .tl-axis。单卷/首卷与文档首个轴同节点（等值旧态），多卷非首卷恢复 legacy 行为
						// （不再误清首卷、本卷残留清零），L18 用例钉住。
						const axis = e.currentTarget.closest(".tl-axis");
						if (axis) {
							axis.querySelectorAll(".drop-before,.drop-after").forEach((n) => {
								n.classList.remove("drop-before", "drop-after");
							});
						}
						bump((x) => x + 1);
					}}
					onDragOver={(e) => {
						if (state.dragId == null) return;
						// 跨卷不允许（:198 逐字）
						if (
							volumeOf(e.currentTarget.closest(".tl-node")) !==
							String(volume.id)
						)
							return;
						e.preventDefault();
						const rect = e.currentTarget.getBoundingClientRect();
						const before = e.clientY - rect.top < rect.height / 2;
						e.currentTarget.classList.toggle("drop-before", before);
						e.currentTarget.classList.toggle("drop-after", !before);
					}}
					onDrop={(e) => {
						e.preventDefault();
						const targetId = Number(e.currentTarget.dataset.chapter);
						const before = e.currentTarget.classList.contains("drop-before");
						e.currentTarget.classList.remove("drop-before", "drop-after");
						if (state.dragId != null && targetId !== state.dragId)
							reorderVolume(state.dragId, targetId, before);
					}}
				>
					<header className="tl-card-head">
						{/* biome-ignore lint/a11y/noStaticElementInteractions: 等值旧版把手 mousedown/mouseup 监听（outline-timeline.js :178-183），span 非交互元素原样保留 */}
						<span
							className="tl-drag"
							title="拖动调整本卷内顺序"
							onMouseDown={() => {
								state.armedCard = Number(ch.id);
								bump((x) => x + 1);
							}}
							onMouseUp={() => {
								state.armedCard = null;
								bump((x) => x + 1);
							}}
						>
							⠿
						</span>
						<span className="tl-title">{heading}</span>
						<span className="tl-meta">{meta.join(" · ") || "未写正文"}</span>
					</header>
					<textarea
						key={`beat-${ch.id}-${dataVersion}`}
						className="tl-beat"
						rows={2}
						data-beat={ch.id}
						placeholder="本章节拍：这一章必须完成的剧情节点（直接写在这里，自动保存）"
						defaultValue={ch.beat || ""}
						onInput={() => onBeatInput(Number(ch.id))}
						onBlur={() => onBeatBlur(Number(ch.id))}
					/>
					<div
						className={`tl-beat-state${beat.cls ? ` ${beat.cls}` : ""}`}
						data-beat-state={ch.id}
					>
						{beat.text}
					</div>
				</article>
			</div>
		);
	}

	// 一卷完整脉络轴：节奏条 + AI 评语入口 + 卷首缝隙 + 节点/缝隙交替 + 卷尾缝隙（:82-95）
	const rows = [];
	rows.push(
		gapRow(
			null,
			chapters.length ? chapters[0].id : null,
			chapters.length ? "补卷首" : "补第一章",
		),
	);
	chapters.forEach((ch, i) => {
		rows.push(nodeCard(ch, i));
		const after = chapters[i + 1];
		rows.push(
			gapRow(ch.id, after ? after.id : null, after ? "补衔接" : "补卷末"),
		);
	});

	return (
		<section className="tl-root" data-tl-volume={volume.id}>
			<div className="tl-toolbar">
				{tensionStrip()}
				<button
					className="btn btn-ghost btn-small"
					type="button"
					data-tension-review={volume.id}
					disabled={!chapters.length || state.tensionBusy}
					onClick={() => onTensionReview(volume.id)}
				>
					{state.tensionBusy ? "分析中…" : "AI 节奏评语"}
				</button>
			</div>
			<div className="tl-axis">{rows}</div>
		</section>
	);
}
