// S5-8（Plan §1.1 G5）：Agent 台「勾选结论」工具条 props 驱动叶组件（≙ legacy :704-716）。
// DOM 契约唯一事实源＝frontend/index.html:652-658（含 inline style 逐字）。计数文案由 props.countText
// 供给（lib pickCountText）；归档会话时两按钮 disabled（legacy :711-715）。
// props 契约＝本片冻结件（Plan §5）；S5-9 只填实现/传参，不改语义。纪律：零 fetch、零全局写入。
function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

export default function AgentPickBar({
	visible,
	countText,
	disabled,
	onSaveNote,
	onCreateHandoff,
	onClear,
}) {
	return (
		<div
			id="agent-pick-bar"
			className={visible ? "chat-hint" : "chat-hint hidden"}
			style={{
				padding: "6px 10px",
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap",
			}}
		>
			<span id="agent-pick-count" style={{ flex: 1, minWidth: 180 }}>
				{countText}
			</span>
			<button
				id="btn-agent-save-note"
				className="btn btn-small"
				type="button"
				title="把勾选的讨论结论存成规划笔记草稿：不写正文、不改大纲、不进事件账本"
				disabled={!!disabled}
				onClick={() => call(onSaveNote)}
			>
				存为规划笔记
			</button>
			<button
				id="btn-agent-create-handoff"
				className="btn btn-small btn-outline"
				type="button"
				title="创建一条交接到写作会话的草案：先在预览里核对材料与来源，接受后才写入"
				disabled={!!disabled}
				onClick={() => call(onCreateHandoff)}
			>
				创建交接到写作
			</button>
			<button
				id="btn-agent-pick-clear"
				className="btn btn-small btn-ghost"
				type="button"
				onClick={() => call(onClear)}
			>
				清空选择
			</button>
		</div>
	);
}
