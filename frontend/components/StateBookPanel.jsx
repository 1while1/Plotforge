// StateBookPanel（S3-1 D6）：book-state.js（37 行）的 React 化。
// 结构逐字镜像 index.html #tab-state pane 的静态标记（3 组 pane-head + 3 个
// outline-textarea + 保存按钮 pane-head，含两处 inline style margin-top:14px），
// 元素 id 保留旧契约：state-characters/-time、state-foreshadowing/-time、
// state-book-summary/-time（elId：下划线→连字符）、btn-save-state——静态标记段
// 已随本切片删除，id 归本组件独占。
// 行为等价旧 BookPage.loadState/bindStateEvents（book-state.js:14~36）：
// - loadSignal 变化（含挂载首次赋值）→ GET /api/books/:id/state 填 3 textarea + 时间戳
//   「更新于 ' + String(s.updated_at).slice(5, 16)」逐字口径，空则空串；
// - 保存 → PUT /api/books/:id/state payload 三 kind → showToast('状态簿已保存') → 重拉；
// - 失败 → showToast(e.message)（等价旧 A().toast）。
// bookId 取自 getApp().state.currentBook.id（等价旧 bid()），encodeURIComponent 包裹。
// 桥侧见 frontend/bridges/legacy-bridge.jsx 的 window.MozhenStateBook（loadSignal 哨兵
// LOAD_UNSET：bindEvents 挂载不拉数，book.js 的 load() 调用才拉——与旧「bind 不拉、
// loadState 拉」的每开书一次 GET 节奏一致）。
import { Fragment, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import { showToast } from "./toast.js";

export const LOAD_UNSET = -1;

const KINDS = ["characters", "foreshadowing", "book_summary"];
// book_summary 的元素 id 用连字符
function elId(kind) {
	return `state-${kind.replace(/_/g, "-")}`;
}
function A() {
	return getApp();
}
function bid() {
	return A().state?.currentBook?.id;
}

const TITLES = {
	characters: "人物当前状态",
	foreshadowing: "未回收伏笔",
	book_summary: "全书进展摘要",
};
const PLACEHOLDERS = { characters: "章总结后由 AI 自动维护，也可手动修改" };
const ROWS = { characters: 5, foreshadowing: 5, book_summary: 4 };

export default function StateBookPanel({ loadSignal }) {
	const [states, setStates] = useState(null);

	const load = useCallback(async () => {
		try {
			const res = await A().api(
				"GET",
				`/api/books/${encodeURIComponent(bid())}/state`,
			);
			const data = res.states || {};
			const next = {};
			for (const kind of KINDS) {
				next[kind] = data[kind] || { content: "", updated_at: null };
			}
			setStates(next);
		} catch (e) {
			showToast(e.message);
		}
	}, []);

	useEffect(() => {
		if (loadSignal !== undefined && loadSignal !== LOAD_UNSET) load();
	}, [loadSignal, load]);

	const setValue = (kind, value) => {
		setStates((prev) => ({
			...prev,
			[kind]: { ...prev[kind], content: value },
		}));
	};

	const onSave = async () => {
		try {
			const payload = {};
			for (const kind of KINDS) payload[kind] = states[kind].content;
			await A().api(
				"PUT",
				`/api/books/${encodeURIComponent(bid())}/state`,
				payload,
			);
			showToast("状态簿已保存");
			await load();
		} catch (e) {
			showToast(e.message);
		}
	};

	return (
		<>
			{KINDS.map((kind, index) => (
				<Fragment key={kind}>
					<div
						className="pane-head"
						style={index === 0 ? undefined : { marginTop: "14px" }}
					>
						<span className="pane-title">{TITLES[kind]}</span>
						<span id={`${elId(kind)}-time`} className="state-time">
							{states?.[kind]?.updated_at
								? `更新于 ${String(states[kind].updated_at).slice(5, 16)}`
								: ""}
						</span>
					</div>
					<textarea
						id={elId(kind)}
						className="outline-textarea"
						rows={ROWS[kind]}
						placeholder={PLACEHOLDERS[kind]}
						value={states ? states[kind].content : ""}
						onChange={(e) => setValue(kind, e.target.value)}
					/>
				</Fragment>
			))}
			<div className="pane-head" style={{ marginTop: "14px" }}>
				<span className="pane-title" />
				<button
					id="btn-save-state"
					className="btn btn-small"
					type="button"
					onClick={onSave}
				>
					保存状态簿
				</button>
			</div>
		</>
	);
}

// ---------- 面板接线（P6-2 §2.5-D5：自 legacy-bridge.jsx 的 window.MozhenStateBook 桥体逐字搬入） ----------
// 语义逐条不变：bindEvents＝幂等 mount（root 缓存 el.__mozhenStateBookRoot，LOAD_UNSET 哨兵不拉数）；
// load＝loadSeq++ 触发组件 GET——「bind 不拉、load 每开书一次 GET」节奏不变。
let loadSeq = LOAD_UNSET;

export function bindEvents() {
	const el = document.getElementById("state-book-mount");
	if (!el) return;
	let root = el.__mozhenStateBookRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenStateBookRoot = root;
	}
	root.render(<StateBookPanel loadSignal={loadSeq} />);
}

export function load() {
	loadSeq += 1;
	const el = document.getElementById("state-book-mount");
	if (!el?.__mozhenStateBookRoot) return;
	el.__mozhenStateBookRoot.render(<StateBookPanel loadSignal={loadSeq} />);
}
