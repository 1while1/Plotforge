// S2-2（charter §5 widget 范式）：ListPager 纯受控组件。
// 逐字等值移植 public/legacy/list-pager.js（39 行）：
// - pageCount/slice 为旧源码逐字移植；slice 的原地改写语义必须保留——
//   三个消费方（character/ledger/world-workbench）的分页状态依赖它。
// - 旧 html+bind 合一为 render 桥（见 bridges/legacy-bridge.jsx）：
//   meta 串拼接表达式与旧源码相同，保证逐字等值；total<=pageSize 渲染 null（等价旧 html()===''）。
// - 点击语义＝旧 bind 原文：改 st.page 后调 onChange()，边界不动且不触发。
// state 形如 { page, pageSize, total }；前端切片场景用 slice()；
// 服务端分页场景由调用方先按页拉取、只把 total 填进来。

export function pageCount(st) {
	return Math.max(1, Math.ceil((st.total || 0) / st.pageSize));
}

// 前端切片：越界页码自动收拢（删元素/过滤后总数变小的常见情况）
export function slice(items, st) {
	st.total = items.length;
	const pages = pageCount(st);
	if (st.page > pages) st.page = pages;
	if (st.page < 1) st.page = 1;
	const start = (st.page - 1) * st.pageSize;
	return items.slice(start, start + st.pageSize);
}

export default function ListPager({ st, onChange, unit }) {
	const pages = pageCount(st);
	// 总数不超一页时不渲染（不制造噪音）——等价旧 ListPager.html 返回 ''
	if ((st.total || 0) <= st.pageSize) return null;
	return (
		<div className="list-pager">
			<button
				className="btn btn-ghost btn-small"
				type="button"
				data-page-prev=""
				disabled={st.page <= 1}
				onClick={() => {
					if (st.page > 1) {
						st.page--;
						onChange();
					}
				}}
			>
				‹ 上一页
			</button>
			<span className="list-pager-meta">
				{"第 " +
					st.page +
					" / " +
					pages +
					" 页 · 共 " +
					st.total +
					" " +
					(unit || "条")}
			</span>
			<button
				className="btn btn-ghost btn-small"
				type="button"
				data-page-next=""
				disabled={st.page >= pages}
				onClick={() => {
					if (st.page < pageCount(st)) {
						st.page++;
						onChange();
					}
				}}
			>
				下一页 ›
			</button>
		</div>
	);
}
