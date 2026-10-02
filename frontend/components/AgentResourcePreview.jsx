// S5-8（Plan §1.1 G5）：Agent 台右侧「来源 / 资源预览」props 驱动叶组件（≙ legacy :424-510）。
// DOM 契约唯一事实源＝frontend/index.html:665-671；预览内容只用 textContent 语义（legacy :438 明载
// 「资源字段按不可信文本处理」，本组件不产 HTML、不 dangerouslySetInnerHTML）。
// props 契约＝本片冻结件（Plan §5）：open/onClose/loading/error/model/null；model 由 lib
// previewModel 产出（title/rows/link/noPageHint/isBook/switchScopeValue）。onSwitchScope 回调经
// preview props 注入（Plan §5 括注「model 含 onSwitchScope」按纯数据模型落地为
// switchScopeValue＋onSwitchScope 参数，已在自检登记）。S5-9 只填实现/传参，不改语义。
// 纪律：零 fetch、零全局写入。
import {
	RES_EMPTY_TEXT,
	RES_LOADING_TEXT,
	RES_NO_PAGE_HINT,
} from "../lib/agent-resources.js";

function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

export default function AgentResourcePreview({
	open,
	onClose,
	loading,
	error,
	model,
	onSwitchScope,
}) {
	let body = null;
	if (error) {
		body = <div className="agent-tools-hint">{error}</div>;
	} else if (loading) {
		body = <div className="agent-tools-hint">{RES_LOADING_TEXT}</div>;
	} else if (!model) {
		body = <div className="agent-tools-hint">{RES_EMPTY_TEXT}</div>;
	} else {
		body = (
			<>
				<div className="agent-preview-title">{model.title}</div>
				{(model.rows || []).map((row) => (
					<div className="agent-preview-row" key={`${row.key}:${row.value}`}>
						<span className="agent-preview-key">{row.key}</span>
						<span className="agent-preview-value">{row.value}</span>
					</div>
				))}
				{model.link ? (
					<a
						className="btn btn-small btn-outline agent-preview-link"
						href={model.link.href}
						title={model.link.title}
					>
						{model.link.text}
					</a>
				) : (
					<div className="agent-tools-hint">
						{model.noPageHint || RES_NO_PAGE_HINT}
					</div>
				)}
				{model.isBook ? (
					<button
						className="btn btn-small btn-ghost"
						type="button"
						onClick={() => call(onSwitchScope, model.switchScopeValue)}
					>
						把交流范围切到这本书
					</button>
				) : null}
			</>
		);
	}
	return (
		<aside
			id="agent-preview-panel"
			className={
				open ? "panel agent-preview-panel" : "panel agent-preview-panel hidden"
			}
		>
			<div className="pane-head">
				<span className="pane-title">来源 / 资源预览</span>
				<button
					id="btn-agent-preview-close"
					className="btn btn-ghost btn-small"
					type="button"
					onClick={() => call(onClose)}
				>
					收起
				</button>
			</div>
			<div id="agent-preview-body" className="agent-preview-body">
				{body}
			</div>
		</aside>
	);
}
