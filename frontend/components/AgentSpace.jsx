// S5-8（Plan §1.1 G7）：Agent 空间页壳「静态装配」（≙ legacy :1-1185 的整页结构与静态文案）。
// 范式 A·判定 C 的「块一建设笔」，零生产切换：**只有 props、零网络、零全局写入、不注册任何
// window.*、不挂载**（挂载与旧名承接＝S5-9；public/index.html 本片零 diff——历史句，P6-3 后壳源＝frontend/index.html）。
// DOM 契约唯一事实源＝frontend/index.html:584-673：id/class/文案/title/placeholder 逐字；本组件与
// 四个叶组件在同一棵树内渲染，全部 id 恰一份（无双份 id）。
// props 契约＝本片冻结件（Plan §5）：topbar／scopeBar／sidePanel／preview／pickBar／messages／
// composer。落实时的两处最小扩展（已在自检登记）：① preview 增 onSwitchScope（Plan §5 括注
// 「model 含 onSwitchScope」按纯数据模型落地为 switchScopeValue＋本回调）；② sidePanel.conversations
// 项带 scope（供 .agent-conv-meta 的「书籍 / 全局」逐字）。
// 块二填充面（本片只渲染骨架，行为归 S5-9）：#agent-legacy-import 族静态 hidden、#agent-run-card
// 空叶容器（内容经 RunStatus 命令式写入，故 React 不管理其 children）、#agent-model 文本、
// 压缩/还原/新会话按钮回调。composer 的 sending→按钮 '执行中…'/disabled 与 stopVisible→停止按钮
// 显隐＝legacy :1892-1894／:1803-1813 命令式改写的声明式等价。
// S5-9（切换笔，两处最小扩展）：
//   ① 内层壳化：**不再渲染 #page-agent 包裹 div**（返回 fragment）——#page-agent 是静态壳自身，
//      类名归 AppRouter 的 hideAllPages/showPage，React 只填内层（ReadPage.jsx:1267-1285 同配方）；
//      pageClassName prop 随之退役（T5-1 机械转写 + 台账 §S5-9 记档）。
//   ② legacyBar 组：块二 :1215-1232 两态文案与 :2090-2093 两按钮回调接入（默认值＝静态壳现状：
//      条隐藏、导入按钮可见、清理按钮 hidden）。
import AgentMessageList from "./AgentMessageList.jsx";
import AgentPickBar from "./AgentPickBar.jsx";
import AgentResourcePreview from "./AgentResourcePreview.jsx";
import AgentScopeBar from "./AgentScopeBar.jsx";
import AgentSidePanel from "./AgentSidePanel.jsx";

function call(fn, ...args) {
	if (typeof fn === "function") fn(...args);
}

export default function AgentSpace({
	topbar,
	scopeBar,
	sidePanel,
	preview,
	pickBar,
	messages,
	composer,
	legacyBar,
}) {
	const t = topbar || {};
	const p = preview || {};
	const c = composer || {};
	const lb = legacyBar || {};
	return (
		<>
			<header className="topbar">
				<div className="topbar-left">
					<a href="#/" className="btn btn-ghost">
						书架
					</a>
					<a
						id="agent-return-writing"
						href={t.returnHref || "#/"}
						className={
							t.returnHidden ? "btn btn-ghost hidden" : "btn btn-ghost"
						}
						title="回到写作页：还原离开时的同一写作会话与同一章"
					>
						← 返回写作页
					</a>
					<h1 className="book-title">AI 助手</h1>
					<span id="agent-model" className="agent-model-tag">
						{t.modelText}
					</span>
				</div>
				<nav className="topbar-actions">
					<button
						id="btn-agent-compress"
						className="btn btn-ghost"
						type="button"
						title="把当前会话较早的对话压缩成存档摘要（原消息不删除，可还原）"
						onClick={() => call(t.onCompress)}
					>
						压缩
					</button>
					<button
						id="btn-agent-restore"
						className={
							t.restoreHidden ? "btn btn-ghost hidden" : "btn btn-ghost"
						}
						type="button"
						title="还原当前会话的全部归档对话"
						onClick={() => call(t.onRestore)}
					>
						还原
					</button>
					<button
						id="btn-agent-clear"
						className="btn btn-ghost"
						type="button"
						title="在「范围」内开始一个新的助手会话（原会话历史保留）"
						onClick={() => call(t.onNewConversation)}
					>
						新会话
					</button>
				</nav>
			</header>

			<AgentScopeBar {...(scopeBar || {})} />

			<main
				id="agent-main"
				className={p.open ? "agent-main with-preview" : "agent-main"}
			>
				<AgentSidePanel {...(sidePanel || {})} />

				<section className="panel agent-chat-panel">
					{/* S5-9 块二：legacy 本地历史条（:1215-1232 两态；:2090-2093 两按钮回调） */}
					<div
						id="agent-legacy-import"
						className={lb.visible ? "chat-hint" : "chat-hint hidden"}
						style={{
							padding: "6px 10px",
							display: "flex",
							gap: 8,
							alignItems: "center",
							flexWrap: "wrap",
						}}
					>
						<span id="agent-legacy-text" style={{ flex: 1, minWidth: 200 }}>
							{lb.text}
						</span>
						<button
							id="btn-agent-import"
							className={
								lb.importHidden ? "btn btn-small hidden" : "btn btn-small"
							}
							type="button"
							disabled={!!lb.importBusy}
							onClick={() => call(lb.onImport)}
						>
							导入到服务端
						</button>
						<button
							id="btn-agent-clean-local"
							className={
								lb.cleanHidden === false
									? "btn btn-small btn-ghost"
									: "btn btn-small btn-ghost hidden"
							}
							type="button"
							title="仅在成功导入后出现；清理浏览器本地旧副本，服务端历史不受影响"
							onClick={() => call(lb.onClean)}
						>
							清理本地副本
						</button>
					</div>
					{/* 叶容器：内容经 RunStatus 命令式写入（本片不管理其 children） */}
					<div id="agent-run-card" className="run-card hidden" role="status" />
					<AgentMessageList {...(messages || {})} />
					<AgentPickBar {...(pickBar || {})} />
					<form
						id="agent-form"
						className="chat-input"
						onSubmit={(e) => {
							e.preventDefault();
							call(c.onSubmit);
						}}
					>
						<textarea
							id="agent-text"
							rows={3}
							placeholder="例如：这本书埋了哪些伏笔？之前剧情里主角走到哪了？…（Ctrl+Enter 发送）"
							value={c.value == null ? "" : c.value}
							onChange={(e) => call(c.onChange, e.target.value)}
						/>
						<button
							type="button"
							id="btn-agent-stop"
							className={
								c.stopVisible
									? "btn btn-small btn-stop"
									: "btn btn-small btn-stop hidden"
							}
							title="中止当前生成（已生成的部分会保留）"
							onClick={() => call(c.onStop)}
						>
							停止
						</button>
						<button
							type="submit"
							id="btn-agent-send"
							className="btn btn-primary"
							disabled={!!c.sending}
						>
							{c.sending ? "执行中…" : "发送"}
						</button>
					</form>
				</section>

				<AgentResourcePreview {...p} />
			</main>
		</>
	);
}
