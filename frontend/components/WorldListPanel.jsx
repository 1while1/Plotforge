// S5-7（Plan §1.1 G5）：世界观列表 panel——public/legacy/book-chat.js loadWorld :1655-1703 的
// 逐字迁移（li.item-row／div（item-name＋item-sub 截 30 字）／span.item-ops（✎ edit-we / × del-we））。
// 形式＝portal 进静态壳 `#world-list`（左栏 #tab-world 内的 ul，index.html:121）；容器缺失即不渲染。
// 纪律：零 fetch、零 window.* 写、零 localStorage；删除/编辑/保存全部经 controller（S5-7 接线面）。
import { createPortal } from "react-dom";
import { worldItemModel } from "../lib/chat-side-lists.js";

export function WorldListPanel({ items, controller }) {
	const host =
		typeof document === "undefined"
			? null
			: document.getElementById("world-list");
	if (!host) return null;
	const list = Array.isArray(items) ? items : [];
	return createPortal(
		list.map((entry) => {
			const m = worldItemModel(entry);
			return (
				<li className="item-row" key={String(m.id)}>
					<div>
						<span className="item-name">{m.title}</span>
						<span className="item-sub">{m.sub}</span>
					</div>
					<span className="item-ops">
						<button
							type="button"
							className="icon-btn edit-we"
							onClick={() => controller.worldModal(entry)}
						>
							✎
						</button>
						<button
							type="button"
							className="icon-btn del-we"
							onClick={() => controller.deleteWorldEntry(entry)}
						>
							×
						</button>
					</span>
				</li>
			);
		}),
		host,
	);
}

export default WorldListPanel;
