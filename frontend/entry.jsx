import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { initFrontendRuntime } from "./bridges/legacy-bridge.jsx";

// P6-2（⑨ 切换笔）：旧名桥与 index.html 三段内联承接桩同笔退役，装载期副作用收敛为一处。
// 时序契约（boot-order.test.jsx T6-2 静态见证）：取得运行时单例 → runStatus.observeApi() →
// 自挂载件（ChatJumpBottom/WorkbenchResizer/StyleHealth/ChapterEditor/FocusMode）→ createRoot。
// module 脚本先于 DOMContentLoaded，与旧 registerLegacyBridges/registerAppBridges 同为解析后立即执行，
// 存量 app.js 的 route() 时序不变（其消费面已全改模块直取，AppRouter 承接）。
initFrontendRuntime();

// D6 挂载点逻辑：优先 #app-root（宿主页面自带则复用）；无则动态建 div append 到 body。
// P6-3（HTML 源迁入 Vite entry）：新壳 frontend/index.html 无静态 #app-root ⇒ 生产与 dev
// 统一走动态创建这一条路径；旧「5173/app/ 开发壳（内置 #app-root）」形态随 dev 壳退役消失。
function resolveMountPoint() {
	const existing = document.getElementById("app-root");
	if (existing) return existing;
	const created = document.createElement("div");
	created.id = "app-root";
	document.body.appendChild(created);
	return created;
}

createRoot(resolveMountPoint()).render(<App />);
