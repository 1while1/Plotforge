// S5-7（Plan §1.1 G5）：人物列表 panel——public/legacy/book-chat.js loadCharacters :1736-1784 的
// 逐字迁移（li.item-row／div（item-name＋item-sub＝定位）／span.item-ops（✎ edit-char / × del-char））。
// 形式＝portal 进静态壳 `#character-list`（左栏 #tab-characters 内的 ul，index.html:130）；容器缺失即不渲染。
// 纪律：零 fetch、零 window.* 写、零 localStorage；删除/编辑/保存全部经 controller（S5-7 接线面）。
import { createPortal } from "react-dom";
import { characterItemModel } from "../lib/chat-side-lists.js";

export function CharacterListPanel({ items, controller }) {
	const host =
		typeof document === "undefined"
			? null
			: document.getElementById("character-list");
	if (!host) return null;
	const list = Array.isArray(items) ? items : [];
	return createPortal(
		list.map((ch) => {
			const m = characterItemModel(ch);
			return (
				<li className="item-row" key={String(m.id)}>
					<div>
						<span className="item-name">{m.name}</span>
						<span className="item-sub">{m.sub}</span>
					</div>
					<span className="item-ops">
						<button
							type="button"
							className="icon-btn edit-char"
							onClick={() => controller.characterModal(ch)}
						>
							✎
						</button>
						<button
							type="button"
							className="icon-btn del-char"
							onClick={() => controller.deleteCharacter(ch)}
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

export default CharacterListPanel;
