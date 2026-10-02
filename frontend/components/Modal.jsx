// Modal 基础件（S3-1 D2）：受控接管既有 #modal-mask 五件套壳，协议与
// public/legacy/app.js:77~111 的 openModal 逐字等价。
//
// ── #modal-body 契约坑（charter §5 S3-1 点名，务必先读）────────────────────
// 通用弹窗的 body 是 **#modal-body（id，无类）**；`.modal-body` **class** 属作家卡
// 编辑器常驻弹窗 #card-editor（index.html:546/:552，页面上的第二个 .modal-mask）。
// 按 class 找弹窗 body 必绑错弹窗。全仓 8 处 `#modal-body` 选择器消费方
// （chapter-conflict.js:39、style-health.js:88-92/:223、app.js:488、agent.js:901/:1099、
// book-chapters.js:458、character-timeline.js:282）与 3 处 vm 测试桩
// （handoff-ui.test.js:274、workspace-navigation.test.js:400、writing-workspace-state.test.js:370）
// 都押在这个 id 契约上。本组件的 portal 渲染目标因此是**既有** #modal-body，
// 绝不自造 .modal-body class 容器；测试钉见 Modal.test.jsx T4。
// 与旧 App.openModal 共写同一壳，靠「页面单弹窗」既有约束互斥：本组件关闭时必须
// 把 portal children 卸载（#modal-body 恢复空），避免遗留 DOM 被后续 innerHTML
// 覆写后产生僵尸渲染（停止条件 9.30 的候选形态）。
//
// 行为逐字对照 app.js:77~111：
// - open=true：#modal-title.textContent=title、#modal-ok.textContent=okText||'确定'、
//   danger→okBtn 加 btn-danger（每次打开重置）、#modal-mask 去 hidden；
// - ok 点击：无 onOk 直接关；ret=onOk()，thenable→then(r => r!==false 才关，catch 忽略)；
//   同步返回 !==false 才关；
// - cancel 点击与 mask 点击（仅 e.target===mask）→ onCancel（缺省仅关闭）；
// - ok 成功路径的关闭不带 onCancel 语义（等价旧 closeModal 只藏壳）。
// 事件绑定沿用 onclick 赋值（防叠加），不用 addEventListener。
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function Modal({
	open,
	title,
	okText,
	danger,
	onOk,
	onCancel,
	children,
}) {
	const [selfOpen, setSelfOpen] = useState(open);

	useEffect(() => {
		setSelfOpen(open);
	}, [open]);

	const close = useCallback(
		(viaCancel) => {
			setSelfOpen(false);
			if (viaCancel && typeof onCancel === "function") onCancel();
		},
		[onCancel],
	);

	useEffect(() => {
		if (!selfOpen) return undefined;
		const mask = document.getElementById("modal-mask");
		const titleEl = document.getElementById("modal-title");
		const okBtn = document.getElementById("modal-ok");
		const cancelBtn = document.getElementById("modal-cancel");
		if (!mask || !titleEl || !okBtn || !cancelBtn) return undefined;
		titleEl.textContent = title == null ? "" : String(title);
		okBtn.textContent = okText || "确定";
		// 危险操作确认：红色按钮；每次打开都重置，避免状态残留（app.js:87~92）
		if (danger) {
			okBtn.classList.add("btn-danger");
		} else {
			okBtn.classList.remove("btn-danger");
		}
		mask.classList.remove("hidden");
		okBtn.onclick = () => {
			// 纯展示弹窗（不传 onOk）：直接关，不调用不存在的回调（app.js:96）
			if (typeof onOk !== "function") {
				close(false);
				return;
			}
			const ret = onOk();
			if (ret && typeof ret.then === "function") {
				ret
					.then((r) => {
						if (r !== false) close(false);
					})
					.catch(() => {
						/* ignore（app.js:101） */
					});
			} else if (ret !== false) {
				close(false);
			}
		};
		cancelBtn.onclick = () => close(true);
		mask.onclick = (e) => {
			if (e.target === mask) close(true);
		};
		return () => {
			// 关闭/卸载兜底：壳恢复 hidden（关闭本体由 selfOpen=false 的下一轮 effect 完成）
			mask.classList.add("hidden");
		};
	}, [selfOpen, title, okText, danger, onOk, close]);

	if (!selfOpen) return null;
	return createPortal(children, document.getElementById("modal-body"));
}
