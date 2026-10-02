// DiffOverlay（S3-2 D3）：public/legacy/diff.js 的 React 化渲染层。
// 静态 overlay 壳零改动（Plan 判定）：#diff-view/#diff-head/#diff-scope/#btn-diff-accept/
// #btn-diff-reject 留在 index.html:188~196，本组件只接管 #diff-body 的内容渲染与
// show/hide/bind 状态——「受控接管既有壳」范式（toast.js 同级）。
// show/hide/bind 与旧 diff.js:111~132 逐字等价：
// - show({scope, original, polished, onAccept})：宿主 #diff-view/#diff-body 缺失即 return；
//   #diff-scope.textContent = scope==='selection' ? '· 选中段落' : '· 整章'（旧 :115 无
//   守卫，同形）；createRoot(#diff-body) 幂等渲染 DiffBody；#diff-view 去 hidden；
//   模块级 acceptHandler = () => onAccept(polished)。
// - hide()：加 hidden + 清 handler；**不清 body**（与旧实现一致，hide 后内容仍在，再
//   show 覆盖）。
// - bind()：#btn-diff-accept.onclick = () => { const h = acceptHandler; hide(); if (h) h(); }、
//   #btn-diff-reject.onclick = hide（onclick 赋值防叠加，逐字等价旧 :127~132）。
// 旧全局 window.DiffView 零 shim；旧 API _renderDiff 不迁（判定 D：唯一消费方
// chapter-conflict.js 本片退役为 React 弹窗，直接消费结构化引擎）。桥见
// bridges/legacy-bridge.jsx 的 window.MozhenDiffView = { show, hide, bind }。
// DiffBody（导出，供冲突弹窗复用）：buildDiffBlocks → JSX 双视角，等价旧 renderInline
// （diff.js:69~76）：d-old 视角显 same 文本裸渲染 + del 部件（ins 部件不渲染）；d-new
// 视角显 ins 部件（del 部件不渲染）；剩余整行 del/ins 整行渲染。React 文本节点自动转义。
import { Fragment } from "react";
import { createRoot } from "react-dom/client";
import { buildDiffBlocks } from "../lib/diff-engine.js";

export function DiffBody({ oldText, newText }) {
	const blocks = buildDiffBlocks(oldText, newText);
	return (
		<>
			{blocks.map((block, index) => {
				if (block.type === "same") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff 分块为一次性静态渲染，无重排语义
						<p key={index} className="d-same">
							{block.text}
						</p>
					);
				}
				if (block.type === "pair") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff 分块为一次性静态渲染，无重排语义
						<Fragment key={index}>
							<p className="d-old">
								{block.old.map((part, k) =>
									part.kind === "same" ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: 字级部件静态渲染，无重排语义
										<Fragment key={k}>{part.text}</Fragment>
									) : part.kind === "del" ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: 字级部件静态渲染，无重排语义
										<span key={k} className="d-del">
											{part.text}
										</span>
									) : null,
								)}
							</p>
							<p className="d-new">
								{block.new.map((part, k) =>
									part.kind === "same" ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: 字级部件静态渲染，无重排语义
										<Fragment key={k}>{part.text}</Fragment>
									) : part.kind === "ins" ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: 字级部件静态渲染，无重排语义
										<span key={k} className="d-ins">
											{part.text}
										</span>
									) : null,
								)}
							</p>
						</Fragment>
					);
				}
				if (block.type === "del") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff 分块为一次性静态渲染，无重排语义
						<p key={index} className="d-old">
							{block.text}
						</p>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff 分块为一次性静态渲染，无重排语义
					<p key={index} className="d-new">
						{block.text}
					</p>
				);
			})}
		</>
	);
}

let acceptHandler = null;
let diffRoot = null;
let diffHostEl = null;

export function show({ scope, original, polished, onAccept }) {
	const view = document.getElementById("diff-view");
	const body = document.getElementById("diff-body");
	if (!view || !body) return;
	document.getElementById("diff-scope").textContent =
		scope === "selection" ? "· 选中段落" : "· 整章";
	if (!diffRoot || diffHostEl !== body) {
		diffRoot = createRoot(body);
		diffHostEl = body;
	}
	diffRoot.render(<DiffBody oldText={original} newText={polished} />);
	view.classList.remove("hidden");
	acceptHandler = () => onAccept(polished);
}

export function hide() {
	const view = document.getElementById("diff-view");
	if (view) view.classList.add("hidden");
	acceptHandler = null;
}

// P6-2（§2.5-D5）：原 `window.MozhenDiffView._bound` 幂等标志改模块级（桥退役后无宿主对象）。
let bound = false;

export function isBound() {
	return bound;
}

export function markBound() {
	bound = true;
}

export function bind() {
	const accept = document.getElementById("btn-diff-accept");
	const reject = document.getElementById("btn-diff-reject");
	if (accept) {
		accept.onclick = () => {
			const h = acceptHandler;
			hide();
			if (h) h();
		};
	}
	if (reject) reject.onclick = hide;
}
