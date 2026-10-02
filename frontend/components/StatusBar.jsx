// StatusBar 雏形（S3-1 D4，**不接线**）：镜像 index.html:73~79 的结构与 class
// （.writing-status-bar[role=status] + 4 × .ws-chip/.ws-label + 值 span），缺省值逐字
// 照 index.html:74~78。既有 #writing-status-bar 由 book.js renderWritingStatus 管理属
// 旧轨（S3-3 才迁），本组件不动它；值 span 故意**不带** writing-status-* id——双栈
// 过渡期若与旧轨同页渲染会产生重复 id，S3-3 接管时再由消费方决定 id 归属。
// 巡检工具断言的是旧轨 #writing-status-* 文本（system-browser-acceptance.cjs:539+），
// 本组件零接线零影响。
const CHIPS = [
	{ label: "书", key: "book", fallback: "—" },
	{ label: "当前章", key: "chapter", fallback: "未选择章节" },
	{ label: "写作会话", key: "conversation", fallback: "（默认：历史对话）" },
	{ label: "保存状态", key: "save", fallback: "已保存" },
];

export default function StatusBar(props) {
	return (
		<div className="writing-status-bar" role="status">
			{CHIPS.map((chip) => (
				<span className="ws-chip" key={chip.key}>
					<span className="ws-label">{chip.label}</span>
					<span>
						{props[chip.key] == null ? chip.fallback : props[chip.key]}
					</span>
				</span>
			))}
		</div>
	);
}
