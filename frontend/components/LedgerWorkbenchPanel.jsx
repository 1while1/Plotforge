// S4-4（charter §3，范式 A·判定 C 旧名桥，S4-3 CharacterWorkbenchPanel 同构）：LedgerWorkbenchPanel——
// 事件账本面板整体迁 React（总览/待审提案/事实事件/故事线/一致性问题五页签；AI 只能提案、
// 采纳才写 story_events 的展示侧，零服务端改动）。S5-4 面板契约笔：旧壳 workbench-shell.js 与
// 旧名桥（window.LedgerWorkbench）随 D-S4-9-01 迁移块整体退役，本组件由 WorkbenchPage.jsx 直接
// import 渲染（面板重挂＝外壳 key=<module|entityId|tab> 语义，等值旧 show() 全量重入重拉）。
// 逐字等值移植 public/legacy/ledger-workbench.js（305 行）活代码：
// - 守卫先注册后渲染加载（:302 注释「守卫先注册，离开保护不留空窗」逐字）；守卫跨模块存续——
//   unmount 不注销，仅下次 show 的 clearGuards(key==='ledger') 才清（:75）。
// - WorkspaceState 单向消费原样经 window 调用：dirtyTracker/registerGuard/clearGuards、
//   beforeNavigate（页签切换先过守卫，false 留原页签 :34-38）、beginRequest/isCurrent 竞态令牌。
// - 分页：proposals/events 服务端分页（limit=20&offset=(page-1)*20，total 取 res.page.total
//   兜底 items.length，:175-176/:234-235）；threads/issues 前端 slice（:268/:281）；末页清空
//   自动回退一页重拉（:178/:236）。ListPager＋slice 直接 import（等值旧 window.MozhenPager
//   经桥渲染同一组件；vm 死锚点仍走 window 回退，两环境互不干扰）。
// - 提案双轨对齐（:166-227）：accept 带 expected_revision；版本冲突 toast 逐字（isVersionConflict
//   正则 :169-172 逐字）；reject modal 必填理由，空理由 toast 逐字返回 false（弹窗保持）。
// - 事件撤销（:229-265）：modal 必填理由；SUPERSEDED 冲突 toast 逐字；成功 toast 逐字。
// - 回填（:117-155）：backfillText 四态文案逐字；running 时按钮 disabled＋即启轮询（:130）；
//   启动走 getApp().openModal 确认→POST /backfill；2500ms 轮询＋pollToken 世代失效（:28/:141/:146
//   ＝ref 世代＋effect cleanup 清 timer，等值旧 shell() pollToken++ 与双检）。
// - 人物名缓存（:156-165）：GET /characters?limit=200 建 id↔name 映射；show 重置＝重挂新 state。
// - 文案逐字：保存失败/保存期间新输入/已保存、拒绝/撤销必填理由、健康条六项标签与提示。
// - URL 形态：/api/books/ + bookId 无 encodeURIComponent（:22 逐字，vm stub 按解码值匹配）；
//   CSS 类名（ledger-* 系）原样保留以维持视觉等值。
// 已知等值差异（无行为回归，记录备审）：
// - 竞态令牌按次捕获（S4-3 character-workbench/world-workbench 同款）：晚到响应一律丢弃。旧实现
//   的模块级单 token（:17 activeLoadToken 共享、loadCurrent 读最新）在页签切换后对本 tab 晚到
//   响应不拦截（实现未达其自身 :17/:45 注释意图；无 vm 用例钉住该行为）；React 版按注释意图
//   收敛，行为面仅更严不更松。
// - 页签切换瞬间的旧页签内容残留：旧 shell() 整块重写先清空再加载，React 重渲即显示上次该页签
//   数据后刷新——数据同源同刷新，无行为断言依赖该瞬时空窗。
// - 接受/拒绝/翻页等面板内刷新统一走 runTabLoad（每次自取令牌）：失败路径旧版为未处理 rejection
//   静默，React 版收敛为错误态展示。

import { useEffect, useReducer, useRef } from "react";
import { getApp } from "../lib/app-runtime.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import ListPager, { slice } from "./ListPager.jsx";

// 后端 threads 契约（domain/threads.js TYPES）：type 必须是这五个枚举值，说明字段叫 summary（:19 逐字）
const THREAD_TYPE_LABELS = {
	foreshadow: "伏笔",
	mystery: "悬念",
	promise: "承诺",
	debt: "亏欠",
	plan: "计划",
};

const TAB_KEYS = ["overview", "proposals", "events", "threads", "issues"];
const TAB_LABELS = {
	overview: "总览",
	proposals: "待审提案",
	events: "事实事件",
	threads: "故事线",
	issues: "一致性问题",
};

const PROPOSAL_SOURCES = {
	history_backfill: "回填",
	chapter_summary: "章总结",
	advisor: "顾问",
	manual: "手动",
};

function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

// 旧 fmtVal（:168 逐字）
function fmtVal(v) {
	if (v && typeof v === "object") return JSON.stringify(v);
	return v == null || v === "" ? "（空）" : String(v);
}

// 旧 isVersionConflict（:169-172 逐字）
function isVersionConflict(err) {
	const msg = String(err?.message || err || "");
	return /版本|VERSION|revision|并发/i.test(msg);
}

// 旧 backfillText（:117-124 逐字）
function backfillText(s) {
	if (!s) return "";
	if (s.running)
		return `回填中… ${s.processed}/${s.total} 章 · 已生成 ${s.created} 条提案`;
	if (s.phase === "done")
		return `上次回填：${s.total} 章 · 新增 ${s.created} 条待审提案 · 跳过 ${s.skipped_changes} 项已入库变化${s.errors?.length ? ` · ${s.errors.length} 条提示` : ""}`;
	if (s.phase === "aborted") return "上次回填已取消";
	if (s.phase === "interrupted")
		return "上次回填因服务重启中断，未再自动续跑；重新点「一键回填」即可续跑（已抽取章节会自动跳过）";
	return "";
}

export function LedgerWorkbenchPanel({ route }) {
	const [, bump] = useReducer((x) => x + 1, 0);
	// 等值移植旧闭包 state（:4-17）：show 重置语义（:298-304 全量重置）＝每次 mount（key=visit++）全新 state
	const st = useRef(null);
	if (!st.current) {
		st.current = {
			tab: route.tab || "overview",
			overview: null,
			proposalItems: [],
			eventItems: [],
			threadItems: [], // 故事线全量缓存：翻页不重拉（:12）
			issueItems: [],
			charNames: null, // 人物 id↔姓名缓存；show 重置＝重挂新 state（:14）
			pagers: {
				proposals: { page: 1, pageSize: 20, total: 0 },
				events: { page: 1, pageSize: 20, total: 0 },
				threads: { page: 1, pageSize: 20, total: 0 },
				issues: { page: 1, pageSize: 20, total: 0 },
			},
			backfillStatus: null,
			backfillStarting: false,
			error: null,
		};
	}
	const state = st.current;
	const trackerRef = useRef(null); // S4-03：进展摘要脏编辑（:16）
	const pollTokenRef = useRef(0); // 轮询世代：等值旧 pollToken（:15）
	const pollTimerRef = useRef(null);

	function api(method, path, body) {
		// :22 逐字——/api/books/ + bookId 无 encodeURIComponent（vm stub 按解码值匹配）
		return getApp().api(
			method,
			`/api/books/${route.bookId}/ledger${path}`,
			body,
		);
	}

	function ws() {
		return getWorkspaceState();
	}

	// 竞态令牌判定（:43-51 等值；token 按次捕获——见头注等值差异说明）
	function loadCurrent(token) {
		return !(token && ws() && !ws().isCurrent(token));
	}

	// 保存全书进展摘要（:53-70 逐字）：返回 true 仅当写入成功且期间没有新输入；失败保留 dirty 并明确提示
	async function saveProgress() {
		const tracker = trackerRef.current;
		if (!tracker) return true;
		const node = document.getElementById("ledger-progress");
		if (!node) return !tracker.isDirty();
		const snapshot = tracker.snapshot();
		try {
			await api("PUT", "/progress", { summary: node.value });
		} catch (err) {
			getApp().toast(
				`保存失败（进展摘要未保存）：${err.message}，修改仍留在表单里`,
			);
			return false;
		}
		if (!tracker.settle(snapshot, true)) {
			getApp().toast(
				"保存期间又有新输入：本次已保存的内容不含最新修改，仍需落库",
			);
			return false;
		}
		getApp().toast("进展摘要已保存");
		return true;
	}

	// 守卫（:72-83 逐字）：先 clearGuards(key==='ledger') 再注册；unmount 不注销（跨模块存续）
	function installGuard() {
		const w = ws();
		if (!w?.registerGuard) return;
		if (!trackerRef.current) trackerRef.current = w.dirtyTracker();
		w.clearGuards((g) => g.key === "ledger");
		w.registerGuard({
			key: "ledger",
			label: "故事台账",
			isDirty: () => !!trackerRef.current && trackerRef.current.isDirty(),
			save: saveProgress,
			discard: () => {
				if (trackerRef.current) trackerRef.current.clear();
			},
		});
	}

	// 统一面板加载（旧 load() :291-297 等值＋按次令牌）：beginRequest('ledger', bookId|tab)→
	// 派发对应加载器（非法 tab 回退 overview，:295 || overview 逐字）→异常渲染错误态（:296）
	function runTabLoad(tab) {
		const w = ws();
		const bookId = String(route.bookId);
		const token = w?.beginRequest
			? w.beginRequest("ledger", `${bookId}|${tab}`)
			: null;
		return (async () => {
			try {
				await (
					{
						overview,
						proposals: loadProposals,
						events: loadEvents,
						threads: loadThreads,
						issues: loadIssues,
					}[tab] || overview
				)(token);
			} catch (e) {
				if (loadCurrent(token)) {
					state.error = e;
					bump();
				}
			}
		})();
	}

	// 概览（:103-116）
	async function overview(token) {
		const result = await Promise.all([
			api("GET", "/progress"),
			api("GET", "/proposals?status=pending"),
			api("GET", "/threads?status=open"),
			api("GET", "/issues"),
			api("GET", "/backfill"),
			// /health 失败 catch 返 null → 空健康条不白屏（:105）
			getApp()
				.api("GET", `/api/books/${route.bookId}/health`)
				.catch(() => null),
		]);
		if (!loadCurrent(token)) return;
		state.overview = {
			progress: result[0],
			proposals: result[1],
			threads: result[2],
			issues: result[3],
			health: result[5],
		};
		state.backfillStatus = result[4].status;
		state.backfillStarting = false;
		state.error = null;
		bump();
		// running 时即启轮询（:130 bindBackfill running 分支逐字）
		if (result[4].status?.running) {
			pollBackfill(pollTokenRef.current);
		}
	}

	// 提案（:173-228）
	async function loadProposals(token) {
		const pg = state.pagers.proposals;
		const res = await api(
			"GET",
			`/proposals?status=pending&limit=${pg.pageSize}&offset=${(pg.page - 1) * pg.pageSize}`,
		);
		// total 取 res.page.total 兜底 items.length（:176）
		pg.total =
			res.page && res.page.total != null ? res.page.total : res.items.length;
		// 末页刚被清空（接受/拒绝完当页最后一条）：自动回退一页再拉，不留空白页（:178）
		if (!res.items.length && pg.page > 1) {
			pg.page -= 1;
			return loadProposals(token);
		}
		await loadCharNames();
		if (!loadCurrent(token)) return;
		state.proposalItems = res.items;
		state.error = null;
		bump();
	}

	// 人物名缓存（:156-165 逐字）
	async function loadCharNames() {
		if (state.charNames) return state.charNames;
		try {
			// 后端默认 limit=50，大书会把提案里的人物显示成 人物#id（:159 注释逐字）
			const res = await getApp().api(
				"GET",
				`/api/books/${route.bookId}/characters?limit=200`,
			);
			const list = res.characters || res.items || [];
			const names = {};
			list.forEach((c) => {
				names[String(c.id)] = c.name;
			});
			state.charNames = names;
		} catch {
			state.charNames = {};
		}
		return state.charNames;
	}

	async function acceptProposal(item) {
		try {
			await api("POST", `/proposals/${item.id}/accept`, {
				expected_revision: item.revision,
			});
		} catch (err) {
			getApp().toast(
				isVersionConflict(err)
					? "提案已被并发修改（版本冲突），已为你刷新列表"
					: `接受失败：${err.message}`,
			);
		}
		await runTabLoad("proposals");
	}

	function rejectProposal(item) {
		getApp().openModal({
			title: `拒绝提案：${item.title || ""}`,
			okText: "确认拒绝",
			bodyHTML:
				'<label>拒绝理由（必填，会随提案留档）<textarea id="reject-note" rows="3" placeholder="例如：与第 12 章剧情矛盾"></textarea></label>',
			onOk: async (body) => {
				const note = (body.querySelector("#reject-note").value || "").trim();
				if (!note) {
					getApp().toast(
						"拒绝必须填写理由：留档后作者/Agent 才能知道为什么被拒",
					);
					return false;
				}
				try {
					await api("POST", `/proposals/${item.id}/reject`, {
						review_note: note,
						expected_revision: item.revision,
					});
				} catch (err) {
					getApp().toast(
						isVersionConflict(err)
							? "提案已被并发修改（版本冲突），已为你刷新列表"
							: `拒绝失败：${err.message}`,
					);
					await runTabLoad("proposals");
					return false;
				}
				await runTabLoad("proposals");
			},
		});
	}

	// 事件（:232-265）
	async function loadEvents(token) {
		const pg = state.pagers.events;
		const res = await api(
			"GET",
			`/events?limit=${pg.pageSize}&offset=${(pg.page - 1) * pg.pageSize}`,
		);
		pg.total =
			res.page && res.page.total != null ? res.page.total : res.items.length;
		if (!res.items.length && pg.page > 1) {
			pg.page -= 1;
			return loadEvents(token);
		}
		if (!loadCurrent(token)) return;
		state.eventItems = res.items;
		state.error = null;
		bump();
	}

	function retractEvent(item) {
		getApp().openModal({
			title: `撤销事件：${item.title || ""}`,
			okText: "确认撤销",
			bodyHTML:
				`<p>将撤销事件 #${esc(item.id)}「${esc(item.title)}」：原记录保留可审计，但其 ${(item.changes || []).length} 项状态变化不再生效，人物当前状态与关系投影会全量重建。</p>` +
				'<label>撤销理由（必填，写入撤销事件留档）<textarea id="retract-reason" rows="3" placeholder="例如：该事件与正文不符，系误抽取"></textarea></label>',
			onOk: async (body) => {
				const reason = (
					body.querySelector("#retract-reason").value || ""
				).trim();
				if (!reason) {
					getApp().toast("撤销必须填写理由：撤销事件本身也会留档供审计");
					return false;
				}
				try {
					await api("POST", `/events/${item.id}/retraction`, { reason });
				} catch (err) {
					getApp().toast(
						/已被修正或撤销|SUPERSEDED/i.test(String(err?.message))
							? "该事件已被修正或撤销，已为你刷新列表"
							: `撤销失败：${err.message}`,
					);
					await runTabLoad("events");
					return false;
				}
				getApp().toast("已撤销，投影已重建");
				await runTabLoad("events");
			},
		});
	}

	// 故事线（:274-278）：GET 全量缓存，翻页前端 slice 不重拉（:268）
	async function loadThreads(token) {
		const res = await api("GET", "/threads");
		if (!loadCurrent(token)) return;
		state.threadItems = res.items || [];
		state.error = null;
		bump();
	}

	function openThreadModal() {
		getApp().openModal({
			title: "新建故事线",
			okText: "创建",
			bodyHTML: `<label>类型<select id="thread-type">${Object.keys(
				THREAD_TYPE_LABELS,
			)
				.map(
					(key) => `<option value="${key}">${THREAD_TYPE_LABELS[key]}</option>`,
				)
				.join(
					"",
				)}</select></label><label>标题<input id="thread-title"></label><label>说明<textarea id="thread-summary" rows="4"></textarea></label>`,
			onOk: async (body) => {
				await api("POST", "/threads", {
					title: body.querySelector("#thread-title").value,
					summary: body.querySelector("#thread-summary").value,
					type: body.querySelector("#thread-type").value,
					status: "open",
				});
				await runTabLoad("threads");
			},
		});
	}

	// 一致性问题（:286-290）
	async function loadIssues(token) {
		const res = await api("GET", "/issues");
		if (!loadCurrent(token)) return;
		state.issueItems = res.items || [];
		state.error = null;
		bump();
	}

	// 回填轮询（:140-155 逐字，pollToken 世代失效＝ref＋effect cleanup）
	async function pollBackfill(myToken) {
		// 世代失效（切页/切 tab/show 重入）→ 停止轮询，不打扰其它页面（:141 注释逐字）
		if (myToken !== pollTokenRef.current) return;
		let res;
		try {
			res = await api("GET", "/backfill");
		} catch (err) {
			getApp().toast(
				`回填状态查询失败：${err.message}（回填可能仍在后台进行）`,
			);
			return;
		}
		if (myToken !== pollTokenRef.current) return;
		const s = res.status;
		state.backfillStatus = s;
		state.backfillStarting = false;
		bump();
		if (s?.running) {
			pollTimerRef.current = setTimeout(() => {
				pollBackfill(myToken);
			}, 2500);
			return;
		}
		// 仅在真正跑完时报完成；aborted/异常终止不冒充成功（:153 注释逐字）
		if (!s || s.phase === "done") {
			getApp().toast(`回填完成：新增 ${s?.created || 0} 条待审提案`);
		}
	}

	function openBackfillModal() {
		getApp().openModal({
			title: "一键回填历史章节",
			okText: "开始回填",
			bodyHTML:
				"<p>将用 AI 重新抽取本书<strong>所有已定稿章节</strong>的人物事实，生成<strong>待审提案</strong>；已入库的字段会自动跳过，<strong>不会直接修改正典</strong>。</p><p>会消耗 AI 调用，章节多时可能耗时数分钟。完成后请到「待审提案」逐条核对采纳。</p>",
			onOk: async () => {
				// 等值旧 :136：按钮即禁用＋「正在启动回填…」；POST 失败恢复可点
				state.backfillStarting = true;
				bump();
				try {
					await api("POST", "/backfill", {});
				} catch (err) {
					getApp().toast(`回填启动失败：${err.message}`);
					state.backfillStarting = false;
					bump();
					return;
				}
				pollBackfill(pollTokenRef.current);
			},
		});
	}

	// 页签切换（:29-42 等值）：先过 beforeNavigate 守卫，false 留原页签；旧 shell() 的
	// pollToken++（:28）等价＝世代失效＋清 timer
	async function switchTab(next) {
		if (next === state.tab) return;
		const w = ws();
		if (w?.beforeNavigate) {
			const allowed = await w.beforeNavigate({
				from: `ledger:${state.tab}`,
				to: `ledger:${next}`,
			});
			if (!allowed) return;
		}
		pollTokenRef.current += 1;
		if (pollTimerRef.current) {
			clearTimeout(pollTimerRef.current);
			pollTimerRef.current = null;
		}
		state.tab = next;
		bump();
		runTabLoad(next);
	}

	// 旧 show（:298-304）：守卫先注册（:302 注释）→ shell 渲染（JSX 即首帧；pollToken 世代+1
	// 等值 :28）→ load。state 全量重置语义＝key=visit++ 重挂即全新 state。
	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重跑，等值旧 show(route) 每次全量
	useEffect(() => {
		installGuard();
		pollTokenRef.current += 1;
		runTabLoad(state.tab);
		return () => {
			// effect cleanup：世代失效＋清回填轮询 timer（等值旧 pollToken 世代失效 :141/:146）；
			// 守卫不注销——跨模块存续，下次 show 的 clearGuards 才清
			pollTokenRef.current += 1;
			if (pollTimerRef.current) {
				clearTimeout(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		};
	}, []);

	// ---------- 渲染（JSX 等值旧 nav/shell/panel 各 HTML 串） ----------
	const s = state;

	const health = s.overview ? s.overview.health : null;
	// 健康条六项（:87-101 逐字）：全 0 → 全绿；任一非 0 → warn
	const healthItems = health
		? [
				{
					n: health.index.locked_missing,
					label: "索引缺失",
					hint: "定稿章无语义索引，AI 检索不到；写作页章节列表可一键重建",
				},
				{
					n: health.extraction.locked_pending,
					label: "抽取待补",
					hint: "定稿章无成功抽取记录；下方「一键回填」可补",
				},
				{
					n: health.summary.locked_without_summary,
					label: "章总结缺",
					hint: "定稿章没有总结，跨章记忆压缩缺底料",
				},
				{
					n: health.summary.stale_volumes,
					label: "卷总结过期",
					hint: "卷内章总结已变化，卷总结基于旧内容（写作页卷行有标记）",
				},
				{
					n:
						health.ledger.stale_proposals +
						health.ledger.orphan_events +
						health.ledger.stale_events,
					label: "一致性问题",
					hint: "过期提案/孤儿事件/证据过期事件",
				},
				{
					n: health.llm_recent.errors,
					label: "近期调用失败",
					hint: `最近 ${health.llm_recent.window} 次 LLM 调用中的失败数`,
				},
			]
		: [];
	const healthWarn = healthItems.some((it) => it.n > 0);

	const overviewContent = s.overview ? (
		<>
			{health ? (
				<div className={`ledger-health${healthWarn ? " warn" : ""}`}>
					<span className="ledger-health-title">
						{healthWarn ? "⚠ 作品健康有待处理" : "✓ 作品健康"}
					</span>
					{healthItems.map((it) => (
						<span
							key={it.label}
							className={`ledger-health-item${it.n > 0 ? " bad" : ""}`}
							title={it.hint}
						>
							{it.label} <strong>{it.n}</strong>
						</span>
					))}
					<span className="ledger-health-meta">
						{`正典 ${health.canon.chapters} 章 / 定稿 ${health.canon.locked} / ${Math.round(health.canon.chars / 1000)}K 字`}
					</span>
				</div>
			) : null}
			{/* 指标卡（:107）：提案取 page.total 兜底 items.length，故事线/问题取 items.length */}
			<div className="ledger-metrics">
				<article>
					<strong>
						{s.overview.proposals.page &&
						s.overview.proposals.page.total != null
							? s.overview.proposals.page.total
							: s.overview.proposals.items.length}
					</strong>
					<span>待审提案</span>
				</article>
				<article>
					<strong>{s.overview.threads.items.length}</strong>
					<span>未结故事线</span>
				</article>
				<article>
					<strong>{s.overview.issues.items.length}</strong>
					<span>一致性问题</span>
				</article>
			</div>
			<div className="ledger-backfill-card">
				<div className="ledger-backfill-text">
					<h3>状态回填</h3>
					<p>
						用 AI 从所有<strong>已定稿</strong>章节重新抽取人物事实，生成
						<strong>待审提案</strong>
						；已入库的字段会自动跳过，<strong>绝不直接改正典</strong>
						。采纳后人物状态即推进到最新剧情。
					</p>
				</div>
				<div className="ledger-backfill-control">
					<button
						id="backfill-start"
						className="btn btn-primary"
						type="button"
						disabled={s.backfillStarting || !!s.backfillStatus?.running}
						onClick={openBackfillModal}
					>
						一键回填
					</button>
					<span id="backfill-progress" className="ledger-backfill-progress">
						{s.backfillStarting
							? "正在启动回填…"
							: backfillText(s.backfillStatus)}
					</span>
				</div>
			</div>
			<form
				id="progress-form"
				className="ledger-summary-card"
				onSubmit={(event) => {
					event.preventDefault();
					saveProgress();
				}}
			>
				<label>
					{"全书进展摘要"}
					{s.overview.progress.stale ? (
						<span
							className="vol-stale"
							title="保存后章/卷总结有更新，此摘要讲的可能是旧故事，建议重新生成"
						>
							底料已变化
						</span>
					) : null}
					<textarea
						id="ledger-progress"
						rows={10}
						defaultValue={s.overview.progress.summary || ""}
						onInput={() => {
							if (trackerRef.current) trackerRef.current.mark();
						}}
					/>
				</label>
				<button className="btn btn-primary" type="submit">
					保存进展摘要
				</button>
			</form>
		</>
	) : null;

	const proposalCards = s.proposalItems.map((item) => {
		const src =
			PROPOSAL_SOURCES[item.source_type] || item.source_type || "提案";
		const changes = (item.changes || []).map((c) => {
			const who =
				c.change_kind === "relation"
					? "关系"
					: s.charNames?.[String(c.subject_ref)] || `人物#${c.subject_ref}`;
			return (
				<li key={`${c.change_kind}:${c.subject_ref}:${c.field_key}`}>
					<span className="proposal-change-who">{who}</span> · {c.field_key}：
					<s>{fmtVal(c.old_value)}</s> → <strong>{fmtVal(c.new_value)}</strong>
				</li>
			);
		});
		return (
			<article key={item.id} className="proposal-card">
				<div>
					<span className="proposal-kind">
						{src}
						{item.chapter_title ? ` · ${item.chapter_title}` : ""}
						{` · v${item.revision || 1} · `}
						{item.supersedes_event_id ? (
							<span
								className="proposal-supersede"
								title="该提案用于替换一条既有事件"
							>
								{`修正事件 #${item.supersedes_event_id}`}
							</span>
						) : null}
						{item.supersedes_event_id ? " · " : ""}
						{item.importance || "normal"}
					</span>
					<h3>{item.title}</h3>
					{item.summary ? <p>{item.summary}</p> : null}
					{item.source_quote ? (
						<blockquote className="proposal-quote">
							{item.source_quote}
						</blockquote>
					) : null}
					<ul className="proposal-changes">{changes}</ul>
				</div>
				<div className="proposal-actions">
					<button
						className="btn btn-primary btn-small"
						type="button"
						data-accept={item.id}
						onClick={() => acceptProposal(item)}
					>
						接受
					</button>
					<button
						className="btn btn-ghost btn-small"
						type="button"
						data-reject={item.id}
						onClick={() => rejectProposal(item)}
					>
						拒绝
					</button>
				</div>
			</article>
		);
	});

	const proposalsContent = (
		<>
			<div className="ledger-list-head">
				<h3>待审事实提案</h3>
				<span>{s.pagers.proposals.total} 项</span>
			</div>
			<div className="ledger-card-list">
				{proposalCards.length ? (
					proposalCards
				) : (
					<div className="workbench-empty-card">收件箱已清空。</div>
				)}
			</div>
			<div id="ledger-pager-slot">
				<ListPager
					st={s.pagers.proposals}
					onChange={() => runTabLoad("proposals")}
				/>
			</div>
		</>
	);

	const eventCards = s.eventItems.map((item) => (
		<article key={item.id} className="ledger-event-card">
			<div>
				<span>
					{item.chapter_title || "未绑定章节"} · {item.importance}
				</span>
				<h3>{item.title}</h3>
				<p>
					{(item.changes || []).length} 项事实变化 · 来源 {item.origin}
				</p>
			</div>
			<div className="proposal-actions">
				<button
					className="btn btn-ghost btn-small"
					type="button"
					data-retract={item.id}
					onClick={() => retractEvent(item)}
				>
					撤销
				</button>
			</div>
		</article>
	));

	const eventsContent = (
		<>
			<div className="ledger-list-head">
				<h3>正式事实事件</h3>
				<span>{s.pagers.events.total} 项</span>
			</div>
			<div className="ledger-card-list">
				{eventCards.length ? (
					eventCards
				) : (
					<div className="workbench-empty-card">尚无正式事实事件。</div>
				)}
			</div>
			<div id="ledger-pager-slot">
				<ListPager st={s.pagers.events} onChange={() => runTabLoad("events")} />
			</div>
		</>
	);

	const threadPageItems = slice(s.threadItems, s.pagers.threads);
	const threadCards = threadPageItems.map((item, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: 故事线按数组序静态渲染，标题可能重复不宜单独作 key
		<article key={i} className="thread-card">
			<span>
				{THREAD_TYPE_LABELS[item.type] || item.type} · {item.status}
			</span>
			<h3>{item.title}</h3>
			<p>{item.summary || ""}</p>
		</article>
	));

	const threadsContent = (
		<>
			<div className="ledger-list-head">
				<h3>故事线与伏笔</h3>
				<button
					id="new-thread"
					className="btn btn-primary btn-small"
					type="button"
					onClick={openThreadModal}
				>
					+ 新建
				</button>
			</div>
			<div className="ledger-card-list">
				{threadCards.length ? (
					threadCards
				) : (
					<div className="workbench-empty-card">尚无故事线。</div>
				)}
			</div>
			<div id="ledger-pager-slot">
				<ListPager st={s.pagers.threads} onChange={bump} />
			</div>
		</>
	);

	const issuePageItems = slice(s.issueItems, s.pagers.issues);
	const issueCards = issuePageItems.map((item, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: 问题按数组序静态渲染，标题可能重复不宜单独作 key
		<article key={i} className="issue-card">
			<span>{item.type}</span>
			<h3>{item.title}</h3>
		</article>
	));

	const issuesContent = (
		<>
			<div className="ledger-list-head">
				<h3>一致性问题</h3>
				<span>{s.issueItems.length} 项</span>
			</div>
			<div className="ledger-card-list">
				{issueCards.length ? (
					issueCards
				) : (
					<div className="workbench-empty-card">当前没有检测到问题。</div>
				)}
			</div>
			<div id="ledger-pager-slot">
				<ListPager st={s.pagers.issues} onChange={bump} />
			</div>
		</>
	);

	let panelContent = null;
	if (s.error) {
		// 旧 :296 错误态
		panelContent = <div className="workbench-error">{s.error.message}</div>;
	} else if (s.tab === "overview") {
		panelContent = overviewContent;
	} else if (s.tab === "proposals") {
		panelContent = proposalsContent;
	} else if (s.tab === "events") {
		panelContent = eventsContent;
	} else if (s.tab === "threads") {
		panelContent = threadsContent;
	} else if (s.tab === "issues") {
		panelContent = issuesContent;
	} else {
		// 旧 load() 对非法 tab 回退 overview 加载器（:295 || overview）——面板内容随 overview
		panelContent = overviewContent;
	}

	return (
		<div className="ledger-workspace">
			<header className="workspace-heading">
				<div>
					<span className="workbench-kicker">CANONICAL STORY MEMORY</span>
					<h2>故事台账</h2>
					<p>提案先审阅，接受后才成为正式事实。</p>
				</div>
			</header>
			<nav className="ledger-tabs">
				{TAB_KEYS.map((key) => (
					<button
						key={key}
						type="button"
						data-ledger-tab={key}
						className={s.tab === key ? "active" : ""}
						onClick={() => switchTab(key)}
					>
						{TAB_LABELS[key]}
					</button>
				))}
			</nav>
			<section id="ledger-panel" className="ledger-panel">
				{panelContent}
			</section>
		</div>
	);
}
