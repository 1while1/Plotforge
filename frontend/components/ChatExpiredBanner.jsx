// S5-5（Plan §1.1 G5）：过期操作横幅（B3）——public/legacy/book-chat.js renderExpiredBanner :1461-1532
// 逐字迁移。标题行与降级（:1466-1482）、按工具名归组的 ×N 与明细行（:1484-1513）、尾行与关闭按钮
// （:1515-1529）、批键关闭记忆（:1453-1456、:1470-1472）逐条对应；宿主与 #chat-messages 平级
// （「放在消息容器内会被 loadChat 的 innerHTML='' 清掉，也无法保证出现在输入区上方」:1438-1441）
// 由 ChatPanel 的 .chat-banners 槽承接。
// 关闭仅隐藏本条：只写本组件状态、不发请求、不改后端状态（刷新后后端仍返回则再次显示）。
// 纯渲染：零 fetch、零 window 读写。
import { useState } from "react";
import {
	argsSummary,
	expiredBatchKey,
	fmtTs,
	toolLabel,
} from "../lib/chat-render.js";

export function ChatExpiredBanner({ bookId, expired, overflow }) {
	const [dismissedKey, setDismissedKey] = useState("");
	const [openNames, setOpenNames] = useState([]);
	const items = Array.isArray(expired) ? expired.filter(Boolean) : [];
	// overflow 契约降级：字段缺失/非正数 → 不显示附加文案，绝不报错（isFinite＋Math.floor，:1468-1469）
	const overflowNum = Number(overflow);
	const overflowN =
		Number.isFinite(overflowNum) && overflowNum > 0
			? Math.floor(overflowNum)
			: 0;
	const batchKey = expiredBatchKey(bookId, items);
	if (!items.length) return null; // 字段缺失/为空：不渲染横幅（:1467）
	if (batchKey === dismissedKey) return null; // 同批已关闭：本页会话内不再重复弹出（:1472）

	// 按工具名归组：同名操作共用一个可点击的名称，展开该组的参数摘要（:1484-1491）
	// rowKey＝归组期一次性分配的稳定键（legacy 逐条 append 无 key 概念；此处仅作 React 身份，
	// 不参与任何文案/DOM 属性，避免用数组下标充当 key）
	const byName = {};
	const order = [];
	let seq = 0;
	items.forEach((a) => {
		const name = a.name || "";
		if (!byName[name]) {
			byName[name] = [];
			order.push(name);
		}
		byName[name].push({ rowKey: `${a.id || ""}#${seq++}`, item: a });
	});

	return (
		<div className="expired-banner" role="status">
			<span className="expired-text">
				{`有 ${items.length} 个操作等待确认超时、从未执行：${
					overflowN ? `（另有 ${overflowN} 个未列出）` : ""
				}`}
			</span>
			{order.map((name) => {
				const list = byName[name] || [];
				const open = openNames.includes(name);
				return (
					<span className="expired-tool-group" key={name}>
						<button
							type="button"
							className="expired-tool"
							onClick={() =>
								setOpenNames((prev) =>
									prev.includes(name)
										? prev.filter((n) => n !== name)
										: [...prev, name],
								)
							}
						>
							{toolLabel(name) + (list.length > 1 ? ` ×${list.length}` : "")}
						</button>
						<div className={open ? "expired-detail" : "expired-detail hidden"}>
							{list.map((row) => (
								<div className="expired-detail-row" key={row.rowKey}>
									{toolLabel(row.item.name) +
										" · " +
										argsSummary(row.item.args) +
										(row.item.expiredAt
											? `（过期于 ${fmtTs(row.item.expiredAt)}）`
											: "")}
								</div>
							))}
						</div>
					</span>
				);
			})}
			<span className="expired-text">（AI 已被告知，不要当成已完成）</span>
			<button
				type="button"
				className="expired-close"
				title="关闭提示（仅隐藏本条，不改变操作状态）"
				onClick={() => setDismissedKey(batchKey)}
			>
				×
			</button>
		</div>
	);
}
