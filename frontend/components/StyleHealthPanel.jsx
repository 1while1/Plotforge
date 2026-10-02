// S4-5（charter §3，范式 A·判定 C 旧名桥，S3-2 ChapterConflict/S4-3 CharacterWorkbench/
// S4-4 LedgerWorkbench 先例）：StyleHealthPanel——阅读页 AI 味体检旁路的 React 版。
// 逐字等值移植 public/legacy/style-health.js（267 行，S4-5 起退役为死锚点：index.html :818
// 标签删；文件随 S5-10 收官清点 git rm）。判定 C 动因＝唯一消费点 book-read.js:111 守卫调用
// `window.StyleHealth.render(...)` 不可触碰（book-read.js 不在 P4 任何切片）——React 桥以
// 旧名 window.StyleHealth 应答（legacy-bridge.jsx），真实浏览器由本组件应答，死锚点内
// 旧实现自洽（与三先例「vm 冻结所迫」同配方、不同动因，见桥注释）。
//
// 与旧实现的关键差异（React 化的实质面，Plan §1 点名）：
// - 报告弹窗与标本列表弹窗一律 React Modal（S3-1 基础件，portal 进既有 #modal-body），
//   **不走 App.openModal＋bodyHTML 字符串＋bindModal 命令式绑定的旧形态**——筛选/复制/
//   复核交互改 React 状态驱动；与 legacy openModal 同壳互斥靠「页面单弹窗」既有约束
//   （Modal.jsx 头注）。#modal-body id 契约坑（.modal-body class 属作家卡编辑器弹窗）
//   由 Modal.jsx 头注＋Modal.test.jsx T4＋本片红测 H3/H10 三侧钉住。
// - 复制降级 textarea（:124-129）同样走 React Modal 换内容，不用 App.openModal。
// - confLabel 阈值 0.9/0.7/0.5/0.2 逐档等值（test/rewrite-curve.test.js:85 文档性对齐锚点）。

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import { buildBrief, buildTextList, diagnose } from "../lib/segment-targets.js";
import Modal from "./Modal.jsx";

// 置信度 → 可读判读（style-health.js:21-28 逐字）。阈值只是展示分档，不是「达标线」——
// 分数只作参考维度，绝不设「必须低于 X」的目标（那会让作者为达标而生硬改写，反而产生新的 AI 味）。
function confLabel(conf) {
	if (typeof conf !== "number") return { text: "—", cls: "unknown" };
	if (conf >= 0.9) return { text: "AI 味很重", cls: "high" };
	if (conf >= 0.7) return { text: "AI 味较重", cls: "high" };
	if (conf >= 0.5) return { text: "疑似 AI", cls: "mid" };
	if (conf >= 0.2) return { text: "偏人工", cls: "low" };
	return { text: "很像人写的", cls: "low" };
}

// 段级标签（:33-34 逐字）。整篇分是篇章级聚合，「哪几段判 AI」才是逐段改写的定位信息。
const LABEL_TEXT = { 0: "人工", 1: "AI", 2: "疑似" };
const LABEL_CLS = { 0: "low", 1: "high", 2: "mid" };

// 参考区间不写成「达标线」（:38 逐字）。
const HUMAN_REF = "人类原文实测 0.0003~0.0159";

const VERDICT_TEXT = {
	pending: "待复核",
	ai: "确认 AI",
	human: "确认为人写",
	rejected: "已废弃",
};

// segRow（:40-54）：label 文案/CLS、conf toFixed(3)（非数「—」）、diagnose tags
//（curve-tag，title=hint，count>1 加 ×N）、正文 JSX 自动转义。
function SegRow({ s }) {
	const lab = s.label === 0 || s.label === 1 || s.label === 2 ? s.label : null;
	const tags = diagnose(s.text);
	return (
		<div
			className={`health-seg ${confLabel(s.conf).cls}`}
			data-label={lab === null ? "" : lab}
		>
			<div className="health-seg-head">
				{lab === null ? null : (
					<span className={`health-seg-label label-${LABEL_CLS[lab]}`}>
						{LABEL_TEXT[lab]}
					</span>
				)}
				<span className="health-seg-conf">
					{typeof s.conf === "number" ? s.conf.toFixed(3) : "—"}
				</span>
				{tags.map((t) => (
					<span
						className="curve-tag"
						key={`${t.label}|${t.count}|${t.hint}`}
						title={t.hint}
					>
						{t.label + (t.count > 1 ? ` ×${t.count}` : "")}
					</span>
				))}
			</div>
			<div className="health-seg-text">{s.text}</div>
		</div>
	);
}

// 结果面板内容（:57-85 逐字）：整章分数＋逐段标签与靶点（可只筛「判 AI」的段，
// 并可无分数复制）。筛选不重新送检（不烧额度，:87 注释语义）。
function ReportBody({ data, onCopyFail }) {
	const segs = data.segments || [];
	const [onlyAi, setOnlyAi] = useState(false);
	const filtered = onlyAi ? segs.filter((s) => s.label === 1) : segs;
	const aiCount = segs.filter((s) => s.label === 1).length;

	// 两种无分数复制（:111-129 逐字）：空文本 toast；clipboard 拒绝 → onCopyFail 降级 textarea 弹窗。
	// S5-10：ST 由**静态 import** 供给（segment-targets.js lib 化，D-S4-6-01 §7 口径），
	// 原「SegmentTargets 缺失 → toast『诊断模块未加载』」臂不可达，随标签退役留案。
	async function copyBrief(kind) {
		const text =
			kind === "text"
				? buildTextList(segs, { onlyAi })
				: buildBrief(segs, { withText: true, onlyAi });
		if (!text.trim()) {
			getApp().toast("没有可复制的段落");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			getApp().toast(
				`已复制${onlyAi ? "（只含判 AI 的段）" : ""}——不含任何检测分数`,
			);
		} catch (_e) {
			onCopyFail(text);
		}
	}

	const overall = data.overall || {};
	const conf = overall.conf;
	const lab = confLabel(conf);
	return (
		<>
			<div className="health-summary">
				<span className={`health-score ${lab.cls}`}>
					{typeof conf === "number" ? conf.toFixed(4) : "—"}
				</span>
				<span className="health-label">{lab.text}</span>
				<span className="health-meta">
					{overall.char_count || 0} 字 ·{" "}
					{overall.usage_tokens ? `${overall.usage_tokens} tokens` : ""}
				</span>
			</div>
			<p className="field-hint">
				参考区间：{HUMAN_REF}。整篇分是<strong>篇章级聚合</strong>——同一章里
				~700 字的窗口通常只有 0.68~0.89，所以别只盯这一个数，看下面
				<strong>哪几段判 AI</strong>。
				<br />
				<strong>别把分数贴给模型让它改</strong>
				：实测贴了不降反更碎（0.9999 →
				0.9999，句子被拆成一句一段）；分数也不进模型上下文（项目铁律，Goodhart）。要改就用下面的「复制待改段
				/ 改稿目标」（都不含分数）。
			</p>
			{segs.length === 0 ? (
				<p className="empty-hint">
					本次未返回分段——朱雀只在长文本上分段，短文本只有整体分数。
				</p>
			) : (
				<>
					<div className="health-toolbar">
						<label className="health-only-ai">
							<input
								type="checkbox"
								id="health-only-ai"
								checked={onlyAi}
								onChange={(e) => setOnlyAi(e.target.checked)}
							/>{" "}
							只看判 AI 的段（{aiCount}）
						</label>
						<button
							className="btn btn-small btn-outline"
							type="button"
							id="health-copy-text"
							title="只复制段落正文，便于人改"
							onClick={() => copyBrief("text")}
						>
							复制待改段
						</button>
						<button
							className="btn btn-small btn-outline"
							type="button"
							id="health-copy-brief"
							title="段落 + 可指名的毛病标签，不含任何分数"
							onClick={() => copyBrief("brief")}
						>
							复制改稿目标
						</button>
						<span className="field-hint" id="health-seg-count">
							显示 {filtered.length} / {segs.length} 段
						</span>
					</div>
					<div id="health-segs" className="health-segs">
						{filtered.length ? (
							filtered.map((s) => (
								<SegRow key={`${s.label}|${s.conf}|${s.text}`} s={s} />
							))
						) : (
							<p className="empty-hint">
								没有判为「AI」的段——这章的分段里没有整段被判 AI 的。
							</p>
						)}
					</div>
					<p className="field-hint">
						判为 AI
						的语句已自动进错题库，可在「错题库」页复核——你的复核结论决定它是否进入特征提取语料。
					</p>
				</>
			)}
		</>
	);
}

// 报告弹窗（:159-165 逐字 title/okText）：剪贴板拒绝时整壳换降级 textarea
//（:124-129 等值——旧实现经 App.openModal 开新弹窗，单弹窗约束下等价于换内容）。
function ReportModal({ data }) {
	const [fallbackText, setFallbackText] = useState(null);
	return (
		<Modal
			open
			title={
				fallbackText == null ? "AI 味体检结果" : "手动复制（浏览器拒绝剪贴板）"
			}
			okText="知道了"
			onOk={() => true}
		>
			{fallbackText == null ? (
				<ReportBody data={data} onCopyFail={setFallbackText} />
			) : (
				<textarea
					className="curve-copy-fallback"
					rows={12}
					defaultValue={fallbackText}
				/>
			)}
		</Modal>
	);
}

// 标本列表弹窗（:188-243 逐字）：行结构＋复核三按钮（无删除）；复核 PATCH → 行内
// label 更新＋toast；空列表 → 空态弹窗。
function SampleListModal({ samples, title }) {
	const [list, setList] = useState(samples);

	async function review(s, verdict) {
		try {
			const res = await getApp().api(
				"PATCH",
				`/api/style-lab/samples/${s.id}`,
				{ verdict },
			);
			setList((prev) =>
				prev.map((x) =>
					x.id === s.id ? { ...x, verdict: res.sample.verdict } : x,
				),
			);
			getApp().toast("已记录复核结论");
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	if (!list.length) {
		return (
			<Modal open title={title} okText="知道了" onOk={() => true}>
				<p className="empty-hint">
					还没有标本。点「AI 味体检」检测本章后，判为 AI 的语句会自动进来。
				</p>
			</Modal>
		);
	}
	return (
		<Modal open title={title} okText="关闭" onOk={() => true}>
			<div className="sample-list">
				{list.map((s) => (
					<div className="sample-item" data-id={s.id} key={s.id}>
						<div className="sample-head">
							<span
								className={`health-seg-conf ${confLabel(s.detectorConf).cls}`}
							>
								{typeof s.detectorConf === "number"
									? s.detectorConf.toFixed(3)
									: "—"}
							</span>
							<span className={`sample-verdict verdict-${s.verdict}`}>
								{VERDICT_TEXT[s.verdict] || s.verdict}
							</span>
							{s.seenCount > 1 ? (
								<span className="sample-seen" title="同一句被反复检出">
									×{s.seenCount}
								</span>
							) : null}
							<span className="sample-src">{s.chapterTitle || ""}</span>
						</div>
						<div className="sample-text">{s.text}</div>
						<div className="sample-ops">
							<button
								className="btn btn-small btn-outline"
								type="button"
								data-review="ai"
								onClick={() => review(s, "ai")}
							>
								确认是 AI
							</button>
							<button
								className="btn btn-small btn-ghost"
								type="button"
								data-review="human"
								onClick={() => review(s, "human")}
							>
								这句是人写的
							</button>
							<button
								className="btn btn-small btn-ghost"
								type="button"
								data-review="rejected"
								onClick={() => review(s, "rejected")}
							>
								废弃
							</button>
						</div>
					</div>
				))}
			</div>
		</Modal>
	);
}

export default function StyleHealthPanel({ report, samples, title }) {
	if (samples) return <SampleListModal samples={samples} title={title} />;
	if (report) return <ReportModal data={report} />;
	return null;
}

// ---------- 桥实现（legacy-bridge.jsx 以旧名 window.StyleHealth 注册应答） ----------
// 模块态（等值 :14）：bookId/chapterId 由 render 记录；running＝busy 门。
const S = { bookId: null, chapterId: null, running: false };

let panelRoot = null;
let panelVisit = 0;

function openPanel(props) {
	if (!panelRoot) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		panelRoot = createRoot(container);
	}
	panelVisit += 1;
	panelRoot.render(<StyleHealthPanel key={panelVisit} {...props} />);
}

// 桥 API render（:246-253 逐字）：先记模块态再动按钮（:247-248 顺序）；按钮缺失 no-op。
export function renderStyleHealth(bookId, chapterId) {
	S.bookId = bookId;
	S.chapterId = chapterId;
	const btn = document.getElementById("read-health-btn");
	if (!btn) return;
	btn.classList.toggle("hidden", !chapterId);
	btn.title = chapterId
		? "用朱雀检测本章 AI 味（结果只作参考，不设达标线）"
		: "";
}

// 桥 API showSampleList（:188 定义名等值）：React 标本列表弹窗。
export function showStyleHealthSampleList(list, title) {
	openPanel({ samples: list, title: title });
}

function setBusy(busy, text) {
	S.running = busy;
	const btn = document.getElementById("read-health-btn");
	if (!btn) return;
	btn.disabled = busy;
	btn.textContent = busy ? text || "体检中…" : "AI 味体检";
}

// 体检主流程（:146-172 逐字）：busy 门 → #read-editor 未保存 confirm 门 →
// POST detect-chapter → React 报告弹窗；失败 toast（旁路定位）；finally busy 复位。
async function runCheck() {
	if (S.running || !S.bookId || !S.chapterId) return;
	const edited = document.getElementById("read-editor");
	if (edited && !edited.classList.contains("hidden")) {
		const cur = edited.value;
		const saved = getApp().state.currentChapter?.content || "";
		if (
			cur !== saved &&
			!window.confirm("精修区有未保存的改动，体检的是已保存的正文。继续？")
		) {
			return;
		}
	}
	setBusy(true);
	try {
		const data = await getApp().api("POST", "/api/style-lab/detect-chapter", {
			book_id: S.bookId,
			chapter_id: S.chapterId,
		});
		openPanel({ report: data });
	} catch (e) {
		// 体检是旁路：没配 key / 额度耗尽 / 网络不通都只提示，不影响任何写作功能
		getApp().toast(`体检未完成：${e.message}`);
	} finally {
		setBusy(false);
	}
}

// 本章历史标本（:175-185 逐字）：GET 参数无 encodeURIComponent（与旧实现一致），
// 空态标题由 showSampleList 内按 list 长度分路。
async function showSamples() {
	if (!S.bookId || !S.chapterId) return;
	try {
		const data = await getApp().api(
			"GET",
			`/api/style-lab/samples?book_id=${S.bookId}&chapter_id=${S.chapterId}&limit=100&order=conf`,
		);
		const list = data.samples || [];
		showStyleHealthSampleList(list, `本章错题库标本（${data.total || 0} 条）`);
	} catch (e) {
		getApp().toast(e.message);
	}
}

// 自挂载（等值 init :255-260）：绑两静态按钮 onclick（赋值防叠加）。两按钮是
// index.html 静态壳元素（read 页 topbar），markup 不删不改（随 book-read 页阶段五处置）。
export function mountStyleHealth() {
	const btn = document.getElementById("read-health-btn");
	if (btn) btn.onclick = runCheck;
	const sBtn = document.getElementById("read-samples-btn");
	if (sBtn) sBtn.onclick = showSamples;
}
