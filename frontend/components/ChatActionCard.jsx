// S5-5（Plan §1.1 G2）：写操作确认卡——public/legacy/book-chat.js renderActionCard :475-646 逐字迁移。
// 两段式确认：卡上「同意执行」只开红色确认弹窗（window.App.openModal，bodyHTML 字符串契约，
// 先例 CharacterAdvisorPanel.jsx:105），弹窗内「确认执行」（onOk）才发
// POST /api/books/<bookId>/chat-actions/<id>/confirm（body {approve, relock}）。
// 纪律：零 fetch、零 window.* 赋值/注册（只读消费 legacy 运行时 App 的 api/openModal/toast/escapeHtml；
// S5-6/S5-7 可用 props.postConfirm 注入替换）。默认回调缺省＝no-op（legacy 缺省走 refreshAfterWrite/
// resumeAfterConfirm，属 S5-7 接线面）。
// 事实说明（与 Plan §4 T2-5 尾句不符，已记台账勘误）：legacy :619-641 的 onOk 成功路径**不**把卡
// 换成留痕行（replaceWith 只出现在 settle() :566/:571），故本组件在 onOk 成功后保留卡位并切只读 approved；
// 留痕行只出现在「拒绝成功」（:566）与刷新回放（:1638）。
import { useRef, useState } from "react";
import { getApp } from "../lib/app-runtime.js";
import {
	actionStatusMeta,
	buildConfirmBodyHTML,
	confirmNeedsRelock,
	normalizeActionStatus,
	PREVIEW_MAX,
	TOOL_LABELS,
} from "../lib/chat-render.js";
import { ChatActionLogRow } from "./ChatActionLogRow.jsx";

// P6-2 §2.5-D1：**调用期**取 App 单例（等值原 `window.App || {}`；getApp() 恒为对象，
// 原空对象兜底的 `?.`／`typeof` 分支成不可达差异——生产不可达，已备案）
function legacyApp() {
	return getApp();
}

export function ChatActionCard({
	action,
	bookId,
	onSettled,
	resume,
	postConfirm,
}) {
	// bookId 缺省取 App.state.currentBook.id（:477）
	const bid = bookId != null ? bookId : legacyApp().state?.currentBook?.id;
	const confirmUrl = `/api/books/${bid}/chat-actions/${action.id}/confirm`;
	const initialMeta = actionStatusMeta(normalizeActionStatus(action.status));
	// 只读历史卡：一次判定（:484/:519-524）——不给任何可点的结算入口，只留状态行
	const readonly = initialMeta.readonly;
	const [statusKey, setStatusKey] = useState(
		normalizeActionStatus(action.status),
	);
	const [statusText, setStatusText] = useState(initialMeta.text);
	const [busy, setBusy] = useState(false);
	const [settledKey, setSettledKey] = useState(null); // 收编为留痕行后的状态键
	const relockRef = useRef(null);
	const a = action.args || {};

	const post =
		postConfirm || ((url, body) => legacyApp().api("POST", url, body));
	const toast = (msg) => legacyApp().toast?.(msg);
	const afterSettled = (name, args) => {
		if (typeof onSettled === "function") onSettled(name, args);
	};
	const resumeRun = (id) => {
		if (typeof resume === "function") resume(id);
	};

	// 结算过程中同步卡片视觉状态（执行中→只读、失败→可重试的 pending 外观，:550-555）
	function applyStatus(key) {
		setStatusKey(key);
		setStatusText(actionStatusMeta(key).text);
	}

	async function settle(approve) {
		setBusy(true);
		setStatusText(approve ? "执行中…" : "已拒绝");
		try {
			const data = await post(confirmUrl, {
				approve: approve,
				relock: !!(approve && relockRef.current?.checked),
			});
			if (!approve) {
				applyStatus("rejected");
				// 结算即刻收编为留痕行（原位 = 原消息正文下方），不再留卡片（:566）
				setSettledKey("rejected");
				resumeRun(action.id); // 拒绝也回灌：模型需要知道作者否决了它的请求并改道（:567）
				return;
			}
			applyStatus("approved");
			setSettledKey("approved");
			toast(
				data?.relocked
					? "写操作已执行，已重新定稿（后台重建索引中）"
					: "写操作已执行",
			);
			afterSettled(action.name, a);
			resumeRun(action.id); // 结果回灌续跑（:574）
		} catch (e) {
			// S2-02：执行中断（结果不确定）不得变成「可重试」——终态化为只读 interrupted 卡，
			// 作者核对目标内容后须重新发起（新卡、新确认），这里不给重放按钮（:576-583）
			if (
				e?.code === "ACTION_REQUIRES_REVIEW" ||
				e?.code === "CONFIRMATION_INTERRUPTED"
			) {
				applyStatus("interrupted");
				setStatusText("执行中断，可能已部分生效——请核对目标内容后重新发起");
				toast(e?.message || "执行中断，不能重放");
				return; // busy 保持 true：按钮不恢复＝不给重放
			}
			applyStatus("pending");
			setStatusText("执行失败，可重试");
			setBusy(false);
			toast(e.message);
		}
	}

	// 「同意执行」不直接执行，先弹出物理隔绝的红色确认弹窗（:592-618）
	function openConfirm() {
		const wantRelock = !!relockRef.current?.checked;
		const relockHtml = confirmNeedsRelock(action)
			? `<p class="relock-note"><label><input type="checkbox" id="modal-relock"${wantRelock ? " checked" : ""}> 写入后自动重新定稿（重建语义索引）</label></p>`
			: "";
		legacyApp().openModal?.({
			title: "确认写操作",
			okText: "确认执行",
			danger: true,
			bodyHTML:
				buildConfirmBodyHTML(action, legacyApp().escapeHtml) + relockHtml,
			onOk: async () => {
				const modalChk = document.getElementById("modal-relock");
				const relock = !!modalChk?.checked;
				if (modalChk && relockRef.current) relockRef.current.checked = relock;
				setBusy(true);
				applyStatus("executing");
				try {
					const data = await post(confirmUrl, {
						approve: true,
						relock: relock,
					});
					applyStatus("approved");
					if (data?.relocked) setStatusText("已执行 ✓（已重新定稿）");
					toast(
						data?.relocked
							? "写操作已执行，已重新定稿（后台重建索引中）"
							: "写操作已执行",
					);
					afterSettled(action.name, a);
					resumeRun(action.id); // 结果回灌续跑（:632）
				} catch (e) {
					applyStatus("pending");
					setStatusText("执行失败，可重试");
					setBusy(false);
					toast(e.message);
					return false; // 不关闭弹窗（:639）
				}
			},
		});
	}

	if (settledKey)
		return <ChatActionLogRow action={action} statusKey={settledKey} />;

	const head = `${readonly ? "写操作（历史）：" : "AI 请求写操作："}${TOOL_LABELS[action.name] || action.name}`;
	// 正文类参数重点预览，其余 JSON 折叠（:494-511）：text/content 超 800 截断加 '…'
	const rawPreview = a.text || a.content || "";
	const previewText =
		typeof rawPreview === "string" ? rawPreview : String(rawPreview);
	const rootClass = `msg-action status-${statusKey}${actionStatusMeta(statusKey).readonly ? " msg-action-readonly" : ""}`;
	const statusSpan = <span className="action-status">{statusText}</span>;
	return (
		<div className={rootClass}>
			<div className="action-head">{head}</div>
			{previewText ? (
				<pre className="action-preview">
					{previewText.length > PREVIEW_MAX
						? `${previewText.slice(0, PREVIEW_MAX)}…`
						: previewText}
				</pre>
			) : null}
			<details className="action-args">
				<summary>完整参数</summary>
				<pre>{JSON.stringify(a, null, 2)}</pre>
			</details>
			<div className="action-ops">
				{readonly ? null : (
					<>
						{confirmNeedsRelock(action) ? (
							<label className="action-relock">
								<input type="checkbox" ref={relockRef} />
								{" 写入后自动重新定稿（重建语义索引）"}
							</label>
						) : null}
						<button
							type="button"
							className="btn btn-small"
							disabled={busy}
							onClick={openConfirm}
						>
							同意执行
						</button>
						<button
							type="button"
							className="btn btn-small btn-ghost"
							disabled={busy}
							onClick={() => settle(false)}
						>
							拒绝
						</button>
					</>
				)}
				{statusSpan}
			</div>
		</div>
	);
}
