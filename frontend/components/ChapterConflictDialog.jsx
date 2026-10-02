// ChapterConflictDialog（S3-2 D4）：public/legacy/chapter-conflict.js 的 React 化。
// 消费 Modal 基础件（受控接管既有 #modal-mask 五件套壳，children 进 #modal-body——
// 契约坑见 Modal.jsx 头注释：#modal-body 是 id 无类名）+ showToast；children JSX
// 镜像旧 bodyHTML 文案/class 逐字（chapter-conflict.js:24~35）。旧 App.escapeHtml/
// App.toast 不再使用（React 文本节点自动转义 + showToast 等价）。
// 行为逐字等价旧 show(opts)（chapter-conflict.js:16~72）：
// - revText = server.revision != null ? String(server.revision) : '?'；
// - countChars = String(s==null?'':s).replace(/\s/g,'').length（去空白计数，逐字移植）；
// - 三按钮 data-act：copy「复制本地稿」/diff「查看差异（本地 vs 服务端）」/
//   reload「放弃本地稿，重载服务端版本」（class `btn btn-outline btn-small`、type=button）；
// - copy → navigator.clipboard.writeText(local.content||'')：成功 toast『本地稿已复制到
//   剪贴板』/失败『复制失败，请在编辑器中手动全选复制』/无 clipboard API『浏览器不支持
//   剪贴板，请在编辑器中手动全选复制』；
// - diff → 展开 conflict-diff 容器（初始 style display:none;max-height:40vh;overflow:auto;
//   margin-top:8px，展开=去掉 display:none）并渲染 DiffBody（本地=旧视角 d-old、服务端=
//   新视角 d-ins），diff 按钮 disabled；
// - reload → opts.onReload(server)（存在才调）+ 关闭弹窗；
// - ok（okText『继续编辑本地稿』）仅关闭——本地稿留在编辑器，稍后仍可保存（旧 :37 注释）。
// 命令式入口 showConflictDialog(opts)：模块级 root/容器（首次 show 时 createElement('div')
// append body + createRoot，容器失连即重建——beforeEach 清 body 后仍可用），key=visit++
// 重挂保证两次 show 状态不串。桥以旧名注册 window.ChapterConflict = { show }（判定 C：
// editor-vm.js:47 readFileSync 冻结 + editor-revision-guard.test.js 三处断言所迫，
// 消费点 book-chapters.js:584 / book-read.js:266 零改动）——真实浏览器中旧文件不再加载，
// show 由本模块应答；vm 中旧文件继续定义同名旧实现，两环境各自自洽。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DiffBody } from "./DiffOverlay.jsx";
import Modal from "./Modal.jsx";
import { showToast } from "./toast.js";

// 旧 countChars 逐字移植（chapter-conflict.js:7~9）
function countChars(s) {
	return String(s == null ? "" : s).replace(/\s/g, "").length;
}

export default function ChapterConflictDialog({ opts }) {
	const server = opts.server || {};
	const local = opts.local || {};
	const { onReload } = opts;
	const revText = server.revision != null ? String(server.revision) : "?";
	const [open, setOpen] = useState(true);
	const [diffOpen, setDiffOpen] = useState(false);

	const onCopy = () => {
		const text = local.content || "";
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 chapter-conflict.js:48 守卫形态
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(
				() => showToast("本地稿已复制到剪贴板"),
				() => showToast("复制失败，请在编辑器中手动全选复制"),
			);
		} else {
			showToast("浏览器不支持剪贴板，请在编辑器中手动全选复制");
		}
	};
	const onDiff = () => {
		setDiffOpen(true);
	};
	const onReloadClick = () => {
		if (typeof onReload === "function") onReload(server);
		setOpen(false);
	};

	return (
		<Modal
			open={open}
			title="章节已在别处被修改"
			okText="继续编辑本地稿"
			onOk={() => {}}
		>
			<p className="field-hint">
				服务端已是第 {revText} 版
				{server.updated_at ? `（${String(server.updated_at)} 保存）` : ""}
				，与编辑器里的本地稿不一致。本地稿已原样保留，两边内容都不会被自动覆盖或重发。
			</p>
			<p className="field-hint">
				本地稿约 {countChars(local.content)} 字 · 服务端约{" "}
				{countChars(server.content)}{" "}
				字。可先复制本地稿留底，再对照差异决定去留。
			</p>
			<div className="conflict-actions">
				<button
					className="btn btn-outline btn-small"
					type="button"
					data-act="copy"
					onClick={onCopy}
				>
					复制本地稿
				</button>{" "}
				<button
					className="btn btn-outline btn-small"
					type="button"
					data-act="diff"
					onClick={onDiff}
					disabled={diffOpen}
				>
					查看差异（本地 vs 服务端）
				</button>{" "}
				<button
					className="btn btn-outline btn-small"
					type="button"
					data-act="reload"
					onClick={onReloadClick}
				>
					放弃本地稿，重载服务端版本
				</button>
			</div>
			<div
				className="diff-body conflict-diff"
				id="conflict-diff"
				style={
					diffOpen
						? { maxHeight: "40vh", overflow: "auto", marginTop: "8px" }
						: {
								display: "none",
								maxHeight: "40vh",
								overflow: "auto",
								marginTop: "8px",
							}
				}
			>
				{diffOpen ? (
					<DiffBody
						oldText={local.content || ""}
						newText={server.content || ""}
					/>
				) : null}
			</div>
		</Modal>
	);
}

let dialogRoot = null;
let dialogContainer = null;
let dialogVisit = 0;

export function showConflictDialog(opts) {
	// biome-ignore lint/complexity/useOptionalChain: root/容器双状态守卫，链式化反降可读性
	if (!dialogRoot || !dialogContainer || !dialogContainer.isConnected) {
		dialogContainer = document.createElement("div");
		document.body.appendChild(dialogContainer);
		dialogRoot = createRoot(dialogContainer);
	}
	dialogVisit += 1;
	dialogRoot.render(<ChapterConflictDialog key={dialogVisit} opts={opts} />);
}
