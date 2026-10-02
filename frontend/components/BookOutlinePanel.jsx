// BookOutlinePanel（S3-2 D5）：public/legacy/book-outline.js（58 行）的 React 化。
// 挂载点 #book-outline-mount（index.html :101 后新增，静态标记段 :102~112 已随本切片
// 删除，JSX 镜像其结构/class/placeholder/inline style margin-top:16px/文案**逐字**，
// 四 id 保留：btn-save-outline / master-outline / btn-drift-check / drift-results）。
// 行为等价旧 BookPage.loadOutline / bindOutlineEvents（book-outline.js:14~57）：
// - loadSignal 序号模式（S3-1 MozhenStateBook 先例，LOAD_UNSET 哨兵不动作）：loadSignal
//   变化 → 读 getApp().state.currentBook 填 textarea + 清 drift 行（等价旧 loadOutline
//   无 API 调用）；
// - 保存 → value.trim() → PUT /api/books/:id {master_outline}（经 getApp().api，
//   encodeURIComponent 包 id）→ getApp().state.currentBook.master_outline = trim 后值
//   （旧突变保留，:29）→ showToast('总纲已保存')；textarea 不重排（旧实现不同填）；
//   错误 showToast(e.message)；
// - 对齐检查 → disabled + 『检查中…』 → POST /api/books/:id/drift-check-all → 行渲染
//   （item-row drift-{status} / drift-badge {status} / DRIFT_LABEL 五映射逐字 / item-name
//   title 用 note（React 属性自动转义）/ note 尾注 ' — ' + note.slice(0,40) 仅
//   status!=='ok'&&note / drift-code 仅 r.code）→ chapterEditorApi().loadChapters()（直接
//   调用，等价旧 :50 桥名，P6-2 §2.5-D4 内化）→ finally 恢复『全书对齐检查』；错误 toast e.message。
// 桥见 bridges/legacy-bridge.jsx 的 window.MozhenBookOutline = { bindEvents, load }；
// book.js :185/:188 两行守卫替换（B5/B6）。
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import { chapterEditorApi } from "./ChapterEditorPanel.jsx";
import { LOAD_UNSET } from "./StateBookPanel.jsx";
import { showToast } from "./toast.js";

// 旧 DRIFT_LABEL 逐字移植（book-outline.js:12）
const DRIFT_LABEL = {
	ok: "符合",
	minor: "轻度偏离",
	major: "严重偏离",
	failed: "检测失败",
	error: "检测失败",
};

function A() {
	return getApp();
}
function bid() {
	return A().state?.currentBook?.id;
}

export default function BookOutlinePanel({ loadSignal }) {
	const [outline, setOutline] = useState(
		() => A().state?.currentBook?.master_outline || "",
	);
	const [rows, setRows] = useState([]);
	const [checking, setChecking] = useState(false);

	useEffect(() => {
		if (loadSignal === undefined || loadSignal === LOAD_UNSET) return;
		// 等价旧 loadOutline：只读 App.state.currentBook，无 API 调用
		setOutline(A().state?.currentBook?.master_outline || "");
		setRows([]);
	}, [loadSignal]);

	const onSave = async () => {
		try {
			const val = outline.trim();
			await A().api("PUT", `/api/books/${encodeURIComponent(bid())}`, {
				master_outline: val,
			});
			A().state.currentBook.master_outline = val;
			showToast("总纲已保存");
		} catch (e) {
			showToast(e.message);
		}
	};

	const onDriftCheck = async () => {
		setChecking(true);
		try {
			const res = await A().api(
				"POST",
				`/api/books/${encodeURIComponent(bid())}/drift-check-all`,
			);
			setRows(res.results || []);
			// 刷新章节列表上的偏离标记（等价旧 BookPage.loadChapters()；P6-2 §2.5-D4 经模块面直取）
			chapterEditorApi().loadChapters();
		} catch (e) {
			showToast(e.message);
		} finally {
			setChecking(false);
		}
	};

	return (
		<>
			<div className="pane-head">
				<span className="pane-title">全书总纲</span>
				<button
					id="btn-save-outline"
					className="btn btn-small"
					type="button"
					onClick={onSave}
				>
					保存
				</button>
			</div>
			<textarea
				id="master-outline"
				className="outline-textarea"
				rows={10}
				placeholder="全书的主线目标、阶段划分、核心冲突…（卷大纲在章节页各卷的 ✎ 里编辑）"
				value={outline}
				onChange={(e) => setOutline(e.target.value)}
			/>
			<div className="pane-head" style={{ marginTop: "16px" }}>
				<span className="pane-title">偏离监督</span>
				<button
					id="btn-drift-check"
					className="btn btn-small btn-outline"
					type="button"
					onClick={onDriftCheck}
					disabled={checking}
				>
					{checking ? "检查中…" : "全书对齐检查"}
				</button>
			</div>
			<p className="field-hint">
				每次生成章节总结时会自动检测；这里可手动批量检查当前卷。
			</p>
			<ul id="drift-results" className="item-list">
				{rows.map((r, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 检查结果行整体重渲，无重排语义
					<li key={index} className={`item-row drift-${r.status}`}>
						<span className={`drift-badge ${r.status}`}>
							{DRIFT_LABEL[r.status] || r.status}
						</span>
						<span className="item-name" title={r.note || ""}>
							{r.title}
							{r.status !== "ok" && r.note ? ` — ${r.note.slice(0, 40)}` : ""}
						</span>
						{r.code ? <span className="drift-code">{r.code}</span> : null}
					</li>
				))}
			</ul>
		</>
	);
}

// ---------- 面板接线（P6-2 §2.5-D5：自 legacy-bridge.jsx 的 window.MozhenBookOutline 桥体逐字搬入） ----------
// 语义逐条不变：bindEvents＝幂等 mount（root 缓存 el.__mozhenBookOutlineRoot，挂载用 LOAD_UNSET 哨兵不填值）；
// load＝loadSeq++ 触发组件读 App.state.currentBook 填 textarea——「bind 不拉、load 每开书一次」（无 API 调用）。
let loadSeq = LOAD_UNSET;

export function bindEvents() {
	const el = document.getElementById("book-outline-mount");
	if (!el) return;
	let root = el.__mozhenBookOutlineRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenBookOutlineRoot = root;
	}
	root.render(<BookOutlinePanel loadSignal={loadSeq} />);
}

export function load() {
	loadSeq += 1;
	const el = document.getElementById("book-outline-mount");
	if (!el?.__mozhenBookOutlineRoot) return;
	el.__mozhenBookOutlineRoot.render(<BookOutlinePanel loadSignal={loadSeq} />);
}
