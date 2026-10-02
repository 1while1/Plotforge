// S4-5（charter §3，范式 P 路由页型，S2-2 profile/S4-2 cards 先例）：StyleLabPage 组件——
// #/book/:id/stylelab 错题库页渲染委托给 React（AppRouter 模块直取 mountStyleLab——AppRouter.jsx:37 import／:82 调用；S4-5 时点＝app.js:159 经 window.MozhenStyleLab.show(bookId)，旧名桥 P6-2 退役）。
// 逐字等值移植 public/legacy/style-lab.js（176 行，本片 git rm 全退役）：
// - JSX 镜像 index.html #page-stylelab 内被替换的两段静态壳（语料概况＋标本列表，
//   h3 与 field-hint 介绍文字逐字含 <strong> 形态；header 与改写工作台段仍是 index.html 静态壳）。
// - 统计栏/标本列表/复核/删除/导出/筛选/章节下拉逐字等值移植，走 getApp().api /
//   getApp().toast / window.confirm（legacy 运行时依赖原样保留）。
// - 导出下载走浏览器原生下载（style-lab.js:150-151 语义）：location.href 直接触发，不用
//   fetch。jsdom 对 location 是 Unforgeable（href 赋值不生效也无法拦截），红测 S7 经
//   setExportSink 注入捕获；真实浏览器用默认实现，行为零变化。
// - mount 后调 mountRewriteCurve(bookId)（等值 :174 的 window.RewriteCurvePanel.show 委托，
//   P6-2 §2.5-D5 改模块导出直取；真值守卫随之退役＝不可达差异备案：函数声明恒在）——改写工作台
//   由 React 面板 RewriteCurvePanel.jsx 接管（index.html curve-* 静态段已换
//   #curve-mount），本组件对该段零接触。
// - 每次 mount 以 key=visit++ 重挂重拉——等价旧 show(bookId) 每次进入重置重拉（:163-172）；
//   app.js 只切 #page-stylelab 显隐、从不重写 #stylelab-mount innerHTML → root 跨访问安全复用。
// - 旧 show() 的 back.href/title 两行对静态壳是 no-op（:165-169，静态默认即 #/profile／「错题库」），
//   React 版不复制；bind() 的 dataset.bound 幂等防重绑在 React 重挂模型下自然消解。

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { mountRewriteCurve } from "../components/RewriteCurvePanel.jsx";
import { getApp } from "../lib/app-runtime.js";

// 导出下载注入点（测试观察用，见头注）：默认真实导航。
let exportSink = (url) => {
	window.location.href = url;
};
export function setExportSink(fn) {
	exportSink = fn;
}

// 置信度分档（style-lab.js:16-21 逐字）。
function confCls(conf) {
	if (typeof conf !== "number") return "unknown";
	if (conf >= 0.7) return "high";
	if (conf >= 0.5) return "mid";
	return "low";
}

const VERDICT_TEXT = {
	pending: "待复核",
	ai: "确认 AI",
	human: "确认为人写",
	rejected: "已废弃",
};

// 统计栏：语料够不够用一眼可见（特征提取需要「已复核」的语料，不是原始标本数）。
// stats 缺失 no-op（:27）——保持「载入中…」或上次内容。
function StatsBox({ stats }) {
	if (!stats) {
		return (
			<div id="stylelab-stats" className="style-lab-stats">
				载入中…
			</div>
		);
	}
	const v = stats.byVerdict || {};
	const c = stats.byConfidence || {};
	return (
		<div id="stylelab-stats" className="style-lab-stats">
			共 <b>{stats.total || 0}</b> 条标本 · 待复核 <b>{v.pending || 0}</b> ·
			确认 AI <b>{v.ai || 0}</b> · 确认为人写 <b>{v.human || 0}</b> · 已废弃{" "}
			<b>{v.rejected || 0}</b>
			<span className="stylelab-tip" title="特征提取只用已复核且未废弃的语料">
				｜高置信(≥0.7) <b>{(c.veryHigh || 0) + (c.high || 0)}</b> · 中{" "}
				<b>{c.mid || 0}</b> · 低 <b>{c.low || 0}</b>
			</span>
		</div>
	);
}

export default function StyleLabPage({ bookId }) {
	const [data, setData] = useState(null);
	const [stats, setStats] = useState(null);
	const [chapters, setChapters] = useState(null); // null＝未取到（失败静默，下拉留空）
	const [filter, setFilter] = useState({
		verdict: "",
		chapterId: "",
		order: "conf",
	});

	// load（style-lab.js:112-128 逐字）：samples 与 stats 两个独立 GET，参数拼接顺序
	// book_id→limit=100→verdict→chapter_id→order（均 encodeURIComponent）；stats 失败静默。
	async function load(f) {
		if (!bookId) return;
		const params = [`book_id=${encodeURIComponent(bookId)}`, "limit=100"];
		if (f.verdict) params.push(`verdict=${encodeURIComponent(f.verdict)}`);
		if (f.chapterId)
			params.push(`chapter_id=${encodeURIComponent(f.chapterId)}`);
		if (f.order) params.push(`order=${encodeURIComponent(f.order)}`);
		try {
			const res = await getApp().api(
				"GET",
				`/api/style-lab/samples?${params.join("&")}`,
			);
			setData(res);
		} catch (e) {
			getApp().toast(e.message);
		}
		try {
			const st = await getApp().api(
				"GET",
				`/api/style-lab/stats?book_id=${encodeURIComponent(bookId)}`,
			);
			// renderStats 的 no-op 语义（:27）：stats 缺失时保持原内容，不清空
			if (st.stats) setStats(st.stats);
		} catch (_e) {
			/* ignore */
		}
	}

	// 章节下拉（:99-110）：失败静默——过滤是增强项，取不到就不显示章节选项。
	async function loadChapterOptions() {
		if (!bookId) return;
		try {
			const res = await getApp().api("GET", `/api/books/${bookId}/chapters`);
			setChapters(res.chapters || []);
		} catch (_e) {
			/* 过滤是增强项，取不到就不显示章节下拉 */
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重拉，等价旧 show() :171-172 的 await loadChapterOptions(); load()
	useEffect(() => {
		loadChapterOptions();
		load(filter);
		// eslint 不适用——biome ignore 见上；filter 初值恒定，仅首帧拉取
	}, [bookId]);

	function applyFilter(patch) {
		const next = { ...filter, ...patch };
		setFilter(next);
		load(next);
	}

	// 复核（:72-86）：PATCH → 行内 label 更新＋toast「已记录复核结论」＋load() 刷新统计。
	async function review(s, verdict) {
		try {
			const res = await getApp().api(
				"PATCH",
				`/api/style-lab/samples/${s.id}`,
				{ verdict },
			);
			setData((prev) =>
				prev
					? {
							...prev,
							samples: (prev.samples || []).map((x) =>
								x.id === s.id ? { ...x, verdict: res.sample.verdict } : x,
							),
						}
					: prev,
			);
			getApp().toast("已记录复核结论");
			load(filter); // 刷新统计
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	// 删除（:87-92）：confirm（取消不发 DELETE）→ DELETE → 行移除＋toast「已删除」＋刷新。
	async function del(s) {
		if (!window.confirm("删除这条标本？删除后无法找回。")) return;
		try {
			await getApp().api("DELETE", `/api/style-lab/samples/${s.id}`);
			setData((prev) =>
				prev
					? {
							...prev,
							samples: (prev.samples || []).filter((x) => x.id !== s.id),
						}
					: prev,
			);
			getApp().toast("已删除");
			load(filter);
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	// 导出（:146-159）：confirm 分路 include_pending，location.href 直接触发下载（不走 fetch）。
	function doExport() {
		let url = `/api/style-lab/samples-export?book_id=${encodeURIComponent(bookId)}`;
		if (filter.verdict) url += `&verdict=${encodeURIComponent(filter.verdict)}`;
		if (
			window.confirm(
				"导出已复核语料（确认 AI + 确认为人写）？\n\n点「取消」则导出含待复核的全部语料。",
			)
		) {
			exportSink(url);
		} else {
			exportSink(`${url}&include_pending=true`);
		}
	}

	// data 只可能是对象或 null：null?.samples→undefined、null&&x→null，与 [] 合并后两形态等值
	const list = data?.samples || [];
	const isEmpty = data && list.length === 0;
	return (
		<>
			<section className="settings-card">
				<h3>语料概况</h3>
				<p className="field-hint">
					这里是朱雀检测判为 AI 味的语句。复核结论决定它是否进入特征提取语料——
					<strong>确认 AI</strong> 的句子用来总结「AI 腔长什么样」，
					<strong>确认为人写</strong>{" "}
					的句子标出检测器的盲区（同样值钱）。未复核的标本不会进入导出，避免污染分析。
				</p>
				<StatsBox stats={stats} />
			</section>

			<section className="settings-card">
				<h3>标本列表</h3>
				<div className="style-lab-filters">
					<select
						id="stylelab-verdict"
						title="按复核状态筛选"
						value={filter.verdict}
						onChange={(e) => applyFilter({ verdict: e.target.value })}
					>
						<option value="">全部状态</option>
						<option value="pending">待复核</option>
						<option value="ai">确认 AI</option>
						<option value="human">确认为人写</option>
						<option value="rejected">已废弃</option>
					</select>
					<select
						id="stylelab-chapter"
						title="按章节筛选"
						value={filter.chapterId}
						onChange={(e) => applyFilter({ chapterId: e.target.value })}
					>
						{chapters === null ? null : <option value="">全部章节</option>}
						{(chapters || []).map((c) => (
							<option key={c.id} value={c.id}>
								{c.title}
							</option>
						))}
					</select>
					<select
						id="stylelab-order"
						title="排序方式"
						value={filter.order}
						onChange={(e) => applyFilter({ order: e.target.value })}
					>
						<option value="conf">按 AI 置信度（高→低）</option>
						<option value="recent">按时间（新→旧）</option>
						<option value="seen">按重复次数</option>
						<option value="oldest">按时间（旧→新）</option>
					</select>
					<button
						id="stylelab-export"
						className="btn btn-small btn-outline"
						type="button"
						title="导出 JSONL 语料，供特征提取"
						onClick={doExport}
					>
						导出语料
					</button>
					<span id="stylelab-count" className="field-hint">
						{data ? `显示 ${list.length} / ${data.total || 0} 条` : ""}
					</span>
				</div>
				<div id="stylelab-list" className="sample-list">
					{isEmpty ? (
						<p className="empty-hint">
							还没有标本。去阅读页点「AI 味体检」检测章节，判为 AI
							的语句会自动进这里。
						</p>
					) : (
						list.map((s) => (
							<div className="sample-item" data-id={s.id} key={s.id}>
								<div className="sample-head">
									<span
										className={`health-seg-conf ${confCls(s.detectorConf)}`}
									>
										{typeof s.detectorConf === "number"
											? s.detectorConf.toFixed(3)
											: "—"}
									</span>
									<span className={`sample-verdict verdict-${s.verdict}`}>
										{VERDICT_TEXT[s.verdict] || s.verdict}
									</span>
									{s.seenCount > 1 ? (
										<span
											className="sample-seen"
											title="同一句被反复检出，重复次数本身就是最强的特征证据"
										>
											×{s.seenCount}
										</span>
									) : null}
									<span className="sample-src">
										{s.chapterTitle || (s.bookId ? `书 #${s.bookId}` : "")}
									</span>
								</div>
								<div className="sample-text">{s.text}</div>
								{s.reviewNote ? (
									<div className="sample-note">复核备注：{s.reviewNote}</div>
								) : null}
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
									<button
										className="btn btn-small btn-ghost"
										type="button"
										data-del="1"
										onClick={() => del(s)}
									>
										删除
									</button>
								</div>
							</div>
						))
					)}
				</div>
			</section>
		</>
	);
}

// ---------- 挂载（AppRouter 模块直取 mountStyleLab 调用至此；S4-5 时点＝app.js:159 经 window.MozhenStyleLab.show(bookId) 委托，旧名桥 P6-2 退役） ----------
// 目标 #stylelab-mount；取不到即返回（安全 no-op）。root 首次创建后复用（缓存
// el.__mozhenStyleLabRoot），每次 mount 以 key=visit++ 重挂重拉。mount 完成后守卫调
// RewriteCurvePanel（等值 style-lab.js:174——改写工作台由 S4-8 的 legacy 面板接管）。
let visit = 0;

export function mount(newBookId) {
	const el = document.getElementById("stylelab-mount");
	if (!el) return;
	let root = el.__mozhenStyleLabRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenStyleLabRoot = root;
	}
	root.render(<StyleLabPage key={visit++} bookId={newBookId} />);
	mountRewriteCurve(newBookId);
}
