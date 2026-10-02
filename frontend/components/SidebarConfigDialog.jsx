// SidebarConfigDialog（S3-1 D7）：sidebar-config.js（115 行）的 React 化。
// 渲染行列表（受控 state 初始来自桥传入的 preferences）：行结构/class 逐字镜像旧
// rowHTML（sidebar-config.js:45~57）——sidebar-config-row[data-module] /
// sidebar-config-head / icon-btn move-up|move-down（index=0 ↑ disabled、末位 ↓
// disabled）/ visibility-toggle（chapters 恒 disabled）/ sidebar-field checkbox
// （data-field，勾选态回显）/ sidebar-fields；提示行 .field-hint 文案逐字。
// 上移/下移＝组件 state 内行序交换（等价旧 bindMoves 的 DOM 插入，sidebar-config.js:72~81）；
// 确定＝组装 {moduleOrder, hiddenModules, summaryFields}（等价旧 readModal 的数据形状
// sidebar-config.js:59~70，字段键序随 fields 定义键序＝DOM 序）交桥 onConfirm；
// 弹窗壳消费 <Modal>（title「调整写作侧栏」/okText「保存布局」，等价旧 openModal 调用）：
// onConfirm 返回 thenable → 成功 resolve 后 Modal 关、失败 reject 被 Modal 忽略保持
// 打开（等价旧 App.openModal + async onOk 的行为）；取消/遮罩点击关闭仅关壳
// （等价旧 closeModal）。旧 openModal 的 bodyHTML 字符串与 readModal 的 DOM 读取
// 在此消解为组件 state。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";
import Modal from "./Modal.jsx";
import { showToast } from "./toast.js";

export const LABELS = {
	chapters: "章节",
	outline: "大纲",
	ledger: "故事台账",
	world: "世界观",
	characters: "人物",
};
export const FIELDS = {
	chapters: { title: "标题", volume: "所属卷", locked: "定稿状态" },
	outline: { mainPlot: "主线摘要", currentVolume: "当前卷", drift: "偏离提醒" },
	ledger: {
		progress: "进展摘要",
		pendingCount: "待审提案",
		openThreadCount: "未结故事线",
		issueCount: "一致性问题",
	},
	world: { name: "名称", summary: "简介" },
	characters: {
		name: "姓名",
		role: "类型",
		intro: "简介",
		location: "位置",
		goal: "当前目标",
	},
};

export default function SidebarConfigDialog({ preferences, onConfirm }) {
	const [order, setOrder] = useState(preferences.moduleOrder.slice());
	const [hiddenModules, setHiddenModules] = useState(
		preferences.hiddenModules.slice(),
	);
	const [summaryFields, setSummaryFields] = useState(() => {
		const copy = {};
		for (const module of preferences.moduleOrder) {
			copy[module] = (preferences.summaryFields[module] || []).slice();
		}
		return copy;
	});

	const move = (index, delta) => {
		const next = order.slice();
		const target = index + delta;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		setOrder(next);
	};

	const toggleVisible = (module) => {
		setHiddenModules((prev) =>
			prev.indexOf(module) === -1
				? [...prev, module]
				: prev.filter((m) => m !== module),
		);
	};

	const toggleField = (module, key) => {
		setSummaryFields((prev) => {
			const current = prev[module] || [];
			return {
				...prev,
				[module]:
					current.indexOf(key) === -1
						? [...current, key]
						: current.filter((k) => k !== key),
			};
		});
	};

	// 等价旧 readModal：字段键序按 fields 定义键序（＝DOM 序）收集
	const collect = () => ({
		moduleOrder: order,
		hiddenModules,
		summaryFields: Object.fromEntries(
			order.map((module) => [
				module,
				Object.keys(FIELDS[module]).filter(
					(key) => (summaryFields[module] || []).indexOf(key) !== -1,
				),
			]),
		),
	});

	return (
		<Modal
			open
			title="调整写作侧栏"
			okText="保存布局"
			onOk={() => onConfirm(collect())}
		>
			<p className="field-hint">
				调整模块顺序、显隐和速览字段。章节入口始终保留。
			</p>
			<div className="sidebar-config-list">
				{order.map((module, index) => {
					const hidden = hiddenModules.indexOf(module) !== -1;
					return (
						<section
							className="sidebar-config-row"
							data-module={module}
							key={module}
						>
							<div className="sidebar-config-head">
								<strong>{LABELS[module]}</strong>
								<span>
									<button
										className="icon-btn move-up"
										type="button"
										disabled={index === 0}
										onClick={() => move(index, -1)}
									>
										↑
									</button>
									<button
										className="icon-btn move-down"
										type="button"
										disabled={index === order.length - 1}
										onClick={() => move(index, 1)}
									>
										↓
									</button>
									<label className="visibility-toggle">
										<input
											type="checkbox"
											data-visible
											checked={!hidden}
											disabled={module === "chapters"}
											onChange={() => toggleVisible(module)}
										/>{" "}
										显示
									</label>
								</span>
							</div>
							<div className="sidebar-fields">
								{Object.keys(FIELDS[module]).map((key) => (
									<label className="sidebar-field" key={key}>
										<input
											type="checkbox"
											data-field={key}
											checked={
												(summaryFields[module] || []).indexOf(key) !== -1
											}
											onChange={() => toggleField(module, key)}
										/>{" "}
										{FIELDS[module][key]}
									</label>
								))}
							</div>
						</section>
					);
				})}
			</div>
		</Modal>
	);
}

// ---------- 侧栏配置接线（P6-2 §2.5-D5：自 legacy-bridge.jsx:213-306 桥体逐字搬入） ----------
// 语义逐条不变：open＝渲染 SidebarConfigDialog（root 容器首次 open 时创建 append 到 body，
// key=visit++ 重挂）；确定回调＝PUT → apply → toast「侧栏布局已保存」（弹窗关闭由 Modal 消费
// onConfirm 的 thenable 语义）；load＝GET sidebar-preferences → apply；bind＝#btn-sidebar-config
// 与全页 [data-workbench] 绑定。apply 副作用逐字等价旧 sidebar-config.js（tabs 重排 /
// pane.dataset.summaryFields / App.state.sidebarPreferences 写入 / 死事件
// sidebar-preferences-changed dispatch）——操作的是 index.html 静态页壳。
// 变化点仅一处：`window.App` 读名改 `getApp()` 单例（调用期）。
const moduleToTab = {
	chapters: "chapters",
	outline: "outline",
	ledger: "state",
	world: "world",
	characters: "characters",
};
let sidebarPreferences = null;
let sidebarDialogRoot = null;
let sidebarVisit = 0;
const sidebarBookId = () => getApp().state?.currentBook?.id;

function selectFirstVisible() {
	const active = document.querySelector(".panel-left .tab.active");
	if (active && active.style.display !== "none") return;
	const next = document.querySelector(
		'.panel-left .tab:not([style*="display: none"])',
	);
	if (next) next.click();
}

export function apply(value) {
	sidebarPreferences = value;
	getApp().state.sidebarPreferences = value;
	const tabs = document.querySelector(".panel-left .tabs");
	value.moduleOrder.forEach((module) => {
		const tabName = moduleToTab[module];
		const button = tabs.querySelector(`[data-tab="${tabName}"]`);
		const pane = document.getElementById(`tab-${tabName}`);
		const hidden = value.hiddenModules.indexOf(module) !== -1;
		if (button) {
			button.textContent = LABELS[module];
			button.style.display = hidden ? "none" : "";
			tabs.appendChild(button);
		}
		if (pane)
			pane.dataset.summaryFields = (value.summaryFields[module] || []).join(
				",",
			);
	});
	selectFirstVisible();
	document.dispatchEvent(
		new CustomEvent("sidebar-preferences-changed", { detail: value }),
	);
}

export function open() {
	if (!sidebarPreferences) return;
	if (!sidebarDialogRoot) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		sidebarDialogRoot = createRoot(container);
	}
	sidebarVisit += 1;
	sidebarDialogRoot.render(
		<SidebarConfigDialog
			key={sidebarVisit}
			preferences={sidebarPreferences}
			onConfirm={async (data) => {
				const resp = await getApp().api(
					"PUT",
					`/api/books/${encodeURIComponent(sidebarBookId())}/sidebar-preferences`,
					data,
				);
				apply(resp.preferences);
				showToast("侧栏布局已保存");
			}}
		/>,
	);
}

export async function load() {
	const data = await getApp().api(
		"GET",
		`/api/books/${encodeURIComponent(sidebarBookId())}/sidebar-preferences`,
	);
	apply(data.preferences);
}

export function bind() {
	const button = document.getElementById("btn-sidebar-config");
	if (button) button.onclick = open;
	document.querySelectorAll("[data-workbench]").forEach((link) => {
		link.onclick = () => {
			const module = link.dataset.workbench;
			const id = sidebarBookId();
			sessionStorage.setItem(
				`novel-editor-return:${id}`,
				location.hash || `#/book/${id}`,
			);
			location.hash = `#/book/${encodeURIComponent(id)}/workbench/${module}`;
		};
	});
}
