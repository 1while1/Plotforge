// S4-8（charter §3，范式 W 旧名桥全退役）：RewriteCurvePanel——改写工作台（#/book/:id/stylelab
// 页内）的 React 版，逐字等值移植 public/legacy/rewrite-curve-panel.js（313 行，本片 git rm 全退役：
// index.html :790 标签删、曲线静态段 :579-599 换 #curve-mount）。
// 判定 W（widget 型）：React 组件＋window 桥；消费方 StyleLabPage.jsx:356 单行守卫调用
// `window.RewriteCurvePanel.show(newBookId)`——旧名桥下产品代码零 diff（比「仅挂载点替换」更零）。
// 旧名桥动因（判定 C 命名裁量）：消费方是 S4-5 已验收交付物，旧名命中使其零改动；且 legacy 面板
// 已 git rm——window.RewriteCurvePanel 不再是「留给 legacy 消费方的兼容 shim」，而是 React 独占
// 实现对新消费方的既有契约名（CharacterWorkbench/LedgerWorkbench/OutlineWorkbench 三先例是 vm
// 冻结所迫、StyleHealth 是消费方文件越界不可改所迫，本片动因不同，见 legacy-bridge.jsx 注释）。
//
// 与旧实现的关键差异（React 化的实质面）：
// - markParaChanged（:119-138）的「只重画某一段防光标丢失」意图由 React 状态驱动天然达成
//   （稳定 key 下 textarea DOM 节点复用，局部 setState 不重建列表）；bind() 的 dataset.bound
//   幂等防重绑在重挂模型下自然消解。
// - escapeHtml 六处（:24/:43/:102/:112/:232/:251/:268）中五处随 JSX 文本节点自动转义消解；
//   仅 :268 的 App.openModal bodyHTML 需要 HTML 字符串，转义经 App 自带 escapeHtml 委托
//   （CharacterAdvisorPanel.jsx:23 同款，禁在 React 版手写转义函数）。
// - :11 的解析期 `var ST = window.SegmentTargets` 捕获随 legacy 文件退役自然消亡；S5-10 起改为
//   **静态 import**（segment-targets.js lib 化，D-S4-6-01 §7 口径）——「ST 缺失」态不复存在，
//   mount 守卫只留 getApp() 一臂（R15 首臂退役留案）。
// - 停笔/自动测量两个 setTimeout 在组件卸载时清理（React 重挂模型下的等价卫生，legacy 模块级
//   timer 永生的形态不复制）。
// - 静态壳文案（h3 与 field-hint 介绍段）逐字随迁自 index.html :579-599；#curve-status 初始文案取
//   show() 的 :310 文本（静态 HTML 的长文案在 show() 首行即被同一 setStatus 覆盖，用户不可见）。

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import {
	addPoint,
	assemble,
	bandOf,
	CONF_BANDS,
	createDraftStore,
	createItem,
	describeProgress,
	plotPoints,
	seriesPath,
	summarize,
} from "../lib/rewrite-curve.js";
import {
	buildBrief,
	diagnose,
	splitParagraphs,
} from "../lib/segment-targets.js";

const AUTOSAVE_MS = 400;
const AUTO_MEASURE_MS = 3000;
const MIN_MEASURE_GAP_MS = 5000;

// show() 完成后 status 的首屏文案（:310 逐字）
const INITIAL_STATUS =
	"选一章后点「载入本章」。草稿按书/章自动保存，刷新不丢。";

function chars(s) {
	return Array.from(String(s || "").replace(/\s+/g, "")).length;
}

// App.openModal 的 bodyHTML 必须是 HTML 字符串（app.js:80 innerHTML 赋值）——转义经 App 自带
// escapeHtml 委托；其余文本节点全部 JSX 自动转义。
function esc(value) {
	return getApp().escapeHtml(value == null ? "" : String(value));
}

// 曲线几何（:216-223 逐字）：W/H、四边 padding、humanY＝人类原文上界 0.016 的像素行。
const W = 360;
const H = 200;
const PAD_L = 38;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 26;
const HUMAN_Y =
	Math.round((PAD_T + (1 - 0.016) * (H - PAD_T - PAD_B)) * 10) / 10;
// 五档 grid（:218-222）：最后档 max>1 时贴 x 轴
const GRID = CONF_BANDS.map((b) => {
	const y = b.max > 1 ? H - PAD_B : PAD_T + (1 - b.max) * (H - PAD_T - PAD_B);
	return { y: Math.round(y * 10) / 10, label: b.label };
});

// 曲线 SVG（renderChart :213-239 逐字）：五档 grid＋轴标签、人类原文实测区间线、x 轴、
// ≥2 点的 path.chart-line、带 <title> 的 chart-dot。id 契约 #curve-chart 由 style.css:2075 钉住。
function CurveChart({ series }) {
	const pts = plotPoints(series, {
		width: W,
		height: H,
		padLeft: PAD_L,
		padRight: PAD_R,
		padTop: PAD_T,
		padBottom: PAD_B,
	});
	return (
		<svg
			id="curve-chart"
			viewBox="0 0 360 200"
			role="img"
			aria-label="人改比例与检测分曲线"
		>
			{GRID.map((g) => (
				<Fragment key={g.label}>
					<line
						x1={PAD_L}
						y1={g.y}
						x2={W - PAD_R}
						y2={g.y}
						className="chart-grid"
					/>
					<text
						x={PAD_L - 4}
						y={g.y + 3}
						className="chart-axis"
						textAnchor="end"
					>
						{g.label}
					</text>
				</Fragment>
			))}
			<line
				x1={PAD_L}
				y1={HUMAN_Y}
				x2={W - PAD_R}
				y2={HUMAN_Y}
				className="chart-human"
			/>
			<text
				x={W - PAD_R}
				y={HUMAN_Y - 4}
				className="chart-axis chart-human-label"
				textAnchor="end"
			>
				人类原文实测区间 0.0003~0.0159
			</text>
			<line
				x1={PAD_L}
				y1={H - PAD_B}
				x2={W - PAD_R}
				y2={H - PAD_B}
				className="chart-grid"
			/>
			<text x={PAD_L} y={H - 8} className="chart-axis">
				人改 0%
			</text>
			<text x={W - PAD_R} y={H - 8} className="chart-axis" textAnchor="end">
				100%
			</text>
			{pts.length > 1 ? (
				<path d={seriesPath(pts)} className="chart-line" />
			) : null}
			{pts.map((p, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 测量点只追加不重排（addPoint 语义），坐标随序号稳定
				<circle key={i} cx={p.x} cy={p.y} r="3.5" className="chart-dot">
					<title>{p.label}</title>
				</circle>
			))}
		</svg>
	);
}

// 测量点列表（renderPoints :242-255 逐字）：行结构 #N／人改 X%／toFixed(4)／band／×N。
function PointsList({ series }) {
	if (!series.length) {
		return <p className="empty-hint">还没有测量点。改几段后点「测一次」。</p>;
	}
	return (
		<>
			{series.map((p, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 测量点只追加不重排，同比例重复只累加 n（addPoint 语义）
				<div className="curve-point" key={i}>
					<span className="curve-point-idx">#{i + 1}</span>
					<span>人改 {Math.round(p.ratio * 100)}%</span>
					<span className="curve-point-conf">
						{typeof p.conf === "number" ? p.conf.toFixed(4) : "—"}
					</span>
					<span className="curve-point-band">{bandOf(p.conf).label}</span>
					{p.n > 1 ? (
						<span className="curve-point-n" title="同一比例重复测量次数">
							×{p.n}
						</span>
					) : null}
				</div>
			))}
		</>
	);
}

// 段落行（renderParas :99-114 逐字）：idx/字数/已改写态/tags/还原按钮/textarea。
// 诊断标签按**原文**取（:100 的两个分支同值，legacy 形态如实保留）；textarea 值经 JSX
// 自动转义（旧实现 :112 的 esc 随迁消解，禁手写 escapeHtml）。
function ParaRow({ item, index, onInput, onReset }) {
	const tags = diagnose(item.original);
	return (
		<div
			className={`curve-para${item.changed ? " changed" : ""}`}
			data-i={index}
		>
			<div className="curve-para-head">
				<span className="curve-para-idx">{index + 1}</span>
				<span className="curve-para-chars">{item.newChars} 字</span>
				{item.changed ? <span className="curve-para-state">已改写</span> : null}
				<span className="curve-para-tags">
					{tags.map((t) => (
						<span
							className="curve-tag"
							key={`${t.label}|${t.count}|${t.hint}`}
							title={t.hint}
						>
							{t.label + (t.count > 1 ? ` ×${t.count}` : "")}
						</span>
					))}
				</span>
				{item.changed ? (
					<button
						className="btn btn-small btn-ghost"
						data-reset="1"
						type="button"
						onClick={() => onReset(index)}
					>
						还原
					</button>
				) : null}
			</div>
			<textarea
				className="curve-para-text"
				rows="2"
				spellCheck="false"
				value={item.changed ? item.rewritten : item.original}
				onChange={(e) => onInput(index, e.target.value)}
			/>
		</div>
	);
}

export default function RewriteCurvePanel({ bookId }) {
	const [chapters, setChapters] = useState(null); // null＝章节下拉载入中（暂无选项）
	const [chaptersFailed, setChaptersFailed] = useState(false);
	const [selected, setSelected] = useState(""); // 章节下拉当前值
	const [chapterId, setChapterId] = useState(null);
	const [items, setItems] = useState([]);
	const [series, setSeries] = useState([]);
	const [status, setStatus] = useState({ text: INITIAL_STATUS, cls: "" });
	const [measuring, setMeasuring] = useState(false);
	const [autoOn, setAutoOn] = useState(false);

	// 旧实现的模块级单例（S/store/timers/lastMeasureAt）在 React 侧的对应面：
	// items/series/chapterId/measuring 进 useState（渲染权威），定时器与 lastMeasureAt 进 useRef
	// （不进渲染），异步回调与 setTimeout 回调经 ref 读最新值。
	const itemsRef = useRef(items);
	const seriesRef = useRef(series);
	const chapterIdRef = useRef(chapterId);
	const bookIdRef = useRef(bookId);
	const measuringRef = useRef(measuring);
	const lastMeasureAtRef = useRef(0);
	const autoSaveTimerRef = useRef(null);
	const autoTimerRef = useRef(null);
	// storage 注入面保留（lib createDraftStore 的 options.storage），默认走 window.localStorage。
	const store = useMemo(() => createDraftStore(), []);

	// 每次渲染后把最新态同步进 ref（effect 内写，避免渲染期副作用）。
	useEffect(() => {
		itemsRef.current = items;
		seriesRef.current = series;
		chapterIdRef.current = chapterId;
		bookIdRef.current = bookId;
		measuringRef.current = measuring;
	});

	// 卸载时清理两个 setTimeout（legacy 模块级 timer 永生的形态不复制）。
	useEffect(
		() => () => {
			if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
			if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
		},
		[],
	);

	// ---------- 章节选择（loadChapterOptions :35-49 逐字） ----------
	useEffect(() => {
		(async () => {
			try {
				const res = await getApp().api("GET", `/api/books/${bookId}/chapters`);
				const list = res.chapters || [];
				setChaptersFailed(false);
				setChapters(list);
				// 默认选到最后一章（通常是最新写的）（:307-309）
				if (list.length) setSelected(String(list[list.length - 1].id));
			} catch (_e) {
				setChaptersFailed(true);
				setChapters([]);
			}
		})();
	}, [bookId]);

	// ---------- 载入 / 渲染（loadChapter :52-90 逐字） ----------
	async function loadChapter() {
		const cid = Number(selected);
		if (!bookId || !Number.isFinite(cid)) {
			setStatus({ text: "先选一章。", cls: "" });
			return;
		}
		setStatus({ text: "载入中…", cls: "" });
		try {
			const res = await getApp().api(
				"GET",
				`/api/style-lab/chapter-text?book_id=${bookId}&chapter_id=${cid}`,
			);
			const chapter = res.chapter || {};
			// 章节题只进 status 文案（旧实现 S.chapterTitle 的唯一消费点），无需独立 state
			const title = chapter.title || "";
			setChapterId(cid);

			const draft = store.load(bookId, cid);
			const paras = splitParagraphs(chapter.content || "");
			let loadedItems;
			let loadedSeries;
			if (draft?.items.length) {
				// 草稿优先，但正文被改动过（段数或原文不同）时以库里正文为准，避免改错版本
				const sameShape =
					draft.items.length === paras.length &&
					draft.items.every((it, i) => it.original === paras[i].text);
				if (sameShape) {
					loadedItems = draft.items;
					loadedSeries = draft.series || [];
				} else {
					loadedItems = paras.map((p) => createItem(p.text, p.text));
					loadedSeries = [];
					setStatus({
						text: "正文与上次草稿不一致（章节可能改过），已按最新正文重新载入，草稿未套用。",
						cls: "warn",
					});
				}
			} else {
				loadedItems = paras.map((p) => createItem(p.text, p.text));
				loadedSeries = [];
			}
			setItems(loadedItems);
			setSeries(loadedSeries);
			// legacy :85-86 的顺序：空正文提示后于草稿分路（不一致 warn 会被空正文文案覆盖，
			// 与旧实现一致）；草稿命中同 shape 时 status 停留在「载入中…」（旧实现未设新文案，
			// 如实保留该形态）。
			if (!loadedItems.length) {
				setStatus({ text: "这一章还没有正文，无法改写。", cls: "" });
			} else if (!draft) {
				setStatus({
					text: `已载入「${title}」共 ${loadedItems.length} 段。改完一段点「测一次」。`,
					cls: "",
				});
			}
		} catch (e) {
			setStatus({ text: `载入失败：${e.message}`, cls: "warn" });
		}
	}

	function onParaInput(idx, value) {
		setItems((prev) => {
			const next = prev.slice();
			next[idx] = createItem(prev[idx].original, value);
			return next;
		});
		scheduleAutosave();
		if (autoOn) scheduleAutoMeasure();
	}

	function resetPara(idx) {
		setItems((prev) => {
			const next = prev.slice();
			next[idx] = createItem(prev[idx].original, prev[idx].original);
			return next;
		});
		scheduleAutosave();
	}

	function scheduleAutosave() {
		if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
		autoSaveTimerRef.current = setTimeout(() => {
			autoSaveTimerRef.current = null;
			store.save(bookIdRef.current, chapterIdRef.current, {
				items: itemsRef.current,
				series: seriesRef.current,
			});
		}, AUTOSAVE_MS);
	}

	function scheduleAutoMeasure() {
		if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
		autoTimerRef.current = setTimeout(() => {
			autoTimerRef.current = null;
			measure(true);
		}, AUTO_MEASURE_MS);
	}

	// ---------- 测量（measure :182-210 逐字） ----------
	async function measure(auto) {
		if (measuringRef.current || !itemsRef.current.length) return;
		const text = assemble(itemsRef.current);
		if (!text.trim()) {
			setStatus({ text: "没有可送检的正文。", cls: "" });
			return;
		}
		const gap = Date.now() - lastMeasureAtRef.current;
		if (auto && gap < MIN_MEASURE_GAP_MS) {
			scheduleAutoMeasure();
			return;
		}
		setMeasuring(true);
		setStatus({ text: `送检中（${chars(text)} 字）…`, cls: "" });
		try {
			const res = await getApp().api("POST", "/api/style-lab/detect", {
				text,
				save: false,
			});
			const conf = res.overall?.conf;
			lastMeasureAtRef.current = Date.now();
			const nextSeries = addPoint(seriesRef.current, {
				ratio: summarize(itemsRef.current).ratioByChars,
				conf,
				chars: chars(text),
				at: new Date().toISOString(),
			});
			seriesRef.current = nextSeries;
			setSeries(nextSeries);
			store.save(bookIdRef.current, chapterIdRef.current, {
				items: itemsRef.current,
				series: nextSeries,
			});
			const band = bandOf(conf);
			setStatus({
				text: `最新读数 ${typeof conf === "number" ? conf.toFixed(4) : "—"}（${band.label}）· ${describeProgress(
					summarize(itemsRef.current),
				)}　（分数只作参考，不设达标线）`,
				cls: "",
			});
		} catch (e) {
			setStatus({
				text: `检测失败：${e.message}（额度/网络问题不影响改写与草稿）`,
				cls: "warn",
			});
		} finally {
			setMeasuring(false);
		}
	}

	// ---------- 复制待改段（copyTargets :258-272 逐字，不含分数） ----------
	async function copyTargets() {
		const pending = items
			.filter((it) => !it.changed)
			.map((it) => ({ index: 0, text: it.original }));
		if (!pending.length) {
			getApp().toast("所有段落都已改过一遍");
			return;
		}
		const brief = buildBrief(pending, { withText: true });
		try {
			await navigator.clipboard.writeText(brief);
			getApp().toast(`已复制 ${pending.length} 段（含毛病标签，不含任何分数）`);
		} catch (_e) {
			getApp().openModal({
				title: "手动复制（浏览器拒绝剪贴板）",
				bodyHTML: `<textarea class="curve-copy-fallback" rows="12">${esc(brief)}</textarea>`,
				okText: "知道了",
				onOk: () => true,
			});
		}
	}

	function resetDraft() {
		if (!chapterId) return;
		if (!window.confirm("清空本章的改写草稿与曲线？（不影响章节正文）")) return;
		store.clear(bookId, chapterId);
		setItems((prev) => prev.map((it) => createItem(it.original, it.original)));
		setSeries([]);
		setStatus({ text: "草稿已清空，章节正文未受影响。", cls: "" });
	}

	// 章节下拉选项（loadChapterOptions 的 innerHTML 三形态：载入中无选项／失败／空书／正常）
	function chapterOptions() {
		if (chapters === null) return null;
		if (chaptersFailed) return <option value="">章节载入失败</option>;
		if (!chapters.length) return <option value="">（本书还没有章节）</option>;
		return chapters.map((c) => (
			<option key={c.id} value={c.id}>
				{c.title}（{c.content_length || 0} 字）
			</option>
		));
	}

	const summary = summarize(items);
	return (
		<section className="settings-card">
			<h3>改写工作台（人改比例 → 检测分）</h3>
			<p className="field-hint">
				{"2026-09-14 实测："}
				<strong>事后修饰改不动检测分</strong>
				{
					"——删明喻/拟声/身体模板句、甚至一字不改只合并段落，整篇读数都不动（0.9999）；整章尺度上给不给作家卡也一样（三臂 6 章 0.92~1.00）。真正改变读数的是"
				}
				<strong>人写进去的字</strong>
				{
					"：人类原文 0.0003~0.0159（11/11 段判「人工」），人写 1,500 字 + AI 1,250 字混排 = 0.6082，且人写段被准确认出来。这个工作台按段改写、每改一部分测一次，把「改多少 → 降到哪」画成曲线。"
				}
				<strong>分数只作参考，不设达标线</strong>
				{"——为达标而生硬改写会生出新的 AI 味。"}
			</p>
			<div className="curve-bar">
				<select
					id="curve-chapter"
					title="选择要改写的章节"
					value={selected}
					onChange={(e) => setSelected(e.target.value)}
				>
					{chapterOptions()}
				</select>
				<button
					id="curve-load"
					className="btn btn-small btn-outline"
					type="button"
					onClick={() => {
						loadChapter();
					}}
				>
					载入本章
				</button>
				<button
					id="curve-measure"
					className="btn btn-small btn-primary"
					type="button"
					disabled={!items.length || measuring}
					onClick={() => {
						measure(false);
					}}
				>
					{measuring ? "检测中…" : "测一次（花 1 次朱雀额度）"}
				</button>
				<label
					className="curve-auto"
					title="停笔 3 秒后自动测一次；两次测量至少间隔 5 秒，避免白烧额度"
				>
					<input
						type="checkbox"
						id="curve-auto"
						checked={autoOn}
						onChange={(e) => setAutoOn(e.target.checked)}
					/>{" "}
					停笔自动测
				</label>
				<button
					id="curve-reset"
					className="btn btn-small btn-ghost"
					type="button"
					title="只清草稿与曲线，不动章节正文"
					onClick={resetDraft}
				>
					清空草稿
				</button>
			</div>
			<div
				id="curve-status"
				className={`field-hint${status.cls ? ` ${status.cls}` : ""}`}
			>
				{status.text}
			</div>
			<div className="curve-body">
				<div className="curve-chart-wrap">
					<CurveChart series={series} />
					<div id="curve-points" className="curve-points">
						<PointsList series={series} />
					</div>
				</div>
				<div id="curve-paras" className="curve-paras">
					<div className="curve-paras-head">
						{describeProgress(summary)}{" "}
						<button
							id="curve-copy-targets"
							className="btn btn-small btn-outline"
							type="button"
							title="复制还没改的段落 + 该段的毛病标签（不含任何分数）"
							onClick={() => {
								copyTargets();
							}}
						>
							复制待改段（不含分数）
						</button>
					</div>
					{items.map((it, i) => (
						<ParaRow
							// biome-ignore lint/suspicious/noArrayIndexKey: 段落按数组序渲染（data-i 契约），同文本段落可能重复不宜单独作 key；key 含文本会致编辑时行重挂丢光标
							key={i}
							item={it}
							index={i}
							onInput={onParaInput}
							onReset={resetPara}
						/>
					))}
				</div>
			</div>
		</section>
	);
}

// ---------- 挂载（legacy-bridge.jsx 的旧名桥 window.RewriteCurvePanel.show 委托至此） ----------
// 目标 #curve-mount（index.html 曲线静态段 :579-599 的替换容器）；取不到即返回（安全 no-op）。
// mount 守卫 getApp()（等值 legacy :12 的 !App||!RC||!ST 早退；S5-10 起 ST 由**静态 import**
// 供给（segment-targets.js 标签与文件一并退役，D-S4-6-01 §7 口径），ST 缺失态不复存在）。
// root 首次创建后复用（缓存 el.__mozhenRewriteCurveRoot），每次 mount 以 key=visit++ 重挂重拉——
// 等价旧 show(bookId) 每次进入重置重拉（:300-311）。
let visit = 0;

export function mountRewriteCurve(newBookId) {
	const el = document.getElementById("curve-mount");
	if (!el) return;
	// P6-2 §2.5-D1：原 `if (!window.App) return` 真值守卫移除＝不可达差异备案（getApp() 恒为对象）
	let root = el.__mozhenRewriteCurveRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenRewriteCurveRoot = root;
	}
	root.render(<RewriteCurvePanel key={visit++} bookId={newBookId} />);
}
