import AppRouter from "./AppRouter.jsx";
import { AppRail } from "./shell/AppRail.jsx";
import { CommandPalette } from "./shell/CommandPalette.jsx";

// D6：App 壳必须不可见——构建产物经 /app/entry.js 注入存量巡检页面，
// 任何可见元素都会弄脏与 baseline 的截图对比（charter 红线 5「存量行为零变化」）。
// S5-3：React Router 移交后，路由壳（AppRouter）挂进隐藏壳内（HashRouter 渲染 null，
// 可见面仍全部由 #page-* 静态壳命令式显隐治理）。
// P6-2 §2.5-D8：旧 `window.__MOZHEN_REACT_SHELL__ = { mounted: true }` 挂载标记退役
//（全仓零读者：巡检脚本与页面均不消费，仅零残留名单登记）。
// 跳转面板平时不渲染可见元素，打开时经 portal 落到 body，故放在隐藏壳外。
// 全局导航栏（UI 优化阶段 4）是书外页面的可见件，同样放在隐藏壳外。
export default function App() {
	return (
		<>
			<div style={{ display: "none" }} id="app-shell">
				<AppRouter />
			</div>
			<AppRail />
			<CommandPalette />
		</>
	);
}
