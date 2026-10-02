// P6-2（2026-09-29）：本文件自「legacy 全局桥」重构为**唯一运行时初始化函数**。
// 原 S2-2 起的 window.* 旧名桥全退役——生产面零 `window.<名单名>`（zero-global.test.js T1 见证），
// 全部消费方改模块直取：App／WorkspaceState／RunStatus 走 lib 单例（§2.5-D1/D2/D5），
// 编辑器与聊天走 `chapterEditorApi()`／`chatApi()` 名义入口（§2.5-D3/D4），
// 页面挂载件由 AppRouter／BookShell 静态 import（§2.5-D5）。
//
// 承接链变更（切换笔原子性）：index.html 三段 classic 内联承接桩（App 供给段 S5-3／
// 编辑器 bootstrap S5-2／聊天 11 名委托桩 S5-7）同笔删除 ⇒ 不存在「桩在桥亡／桥在桩亡」中间态。
// 文件名保留（P6-5 再论命名）；调用点唯一＝`frontend/entry.jsx`，且必须先于 `createRoot()`。
//
// 装载期副作用等价（逐条等值旧 registerLegacyBridges + registerAppBridges 尾段）：
//   ①`getApp()` 取得运行时单例（懒建；state 三字段单例，等值 index.html App 供给段 :758-759）；
//   ②`runStatus.observeApi()` 落盘观察猴补（等值 legacy run-status.js :126-150 装载期一次；
//     幂等 flag `App.__runStatusObserved`；包装的是单例 `api`，消费方调用期读取故恒生效）；
//   ③自挂载件四件（ChatJumpBottom／WorkbenchResizer／StyleHealth／ChapterEditor）——
//     等价旧文件 DOMContentLoaded 自初始化，module 执行序天然在 DOM 就绪后；
//   ④`mountFocusMode()` 沉浸写作自挂载（返回值不再挂 window.FocusMode；消费方
//     ChapterEditorPanel 经 `focusModeBridge()` 读模块态，`null` ⇒ no-op 语义保留）。

import { mountChapterEditor } from "../components/ChapterEditorPanel.jsx";
import { mount as mountChatJumpBottom } from "../components/ChatJumpBottom.jsx";
import { mountFocusMode } from "../components/FocusModeOverlay.jsx";
import { mountStyleHealth } from "../components/StyleHealthPanel.jsx";
import { mount as mountWorkbenchResizer } from "../components/WorkbenchResizer.jsx";
import { getApp } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";

export function initFrontendRuntime() {
	if (typeof document === "undefined") return;

	// ①取得 App 单例（懒建，state 单例；消费方调用期读取）
	getApp();
	// ②落盘观察猴补（幂等；等值原装载期一次猴补）
	runStatus.observeApi();
	// ③自挂载件（内部自守卫：目标缺失即 no-op）
	mountChatJumpBottom();
	mountWorkbenchResizer();
	mountStyleHealth();
	mountChapterEditor();
	// ④沉浸写作自挂载（守卫失败返回 null ⇒ 模块态未置位 ⇒ 消费方 focusModeBridge() 得 null）
	mountFocusMode();
}
