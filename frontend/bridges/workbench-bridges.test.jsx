// @vitest-environment jsdom
// S5-4 红测 R14（Plan §4；P6-2 ⑨ 切换笔转写）：S5-4 供给面与退役见证——
//   ·（转写后）`getWorkspaceState()`（lib 单例）21 名齐备；`parseWorkbenchRoute` 与
//     `mountWorkbenchPage` 为模块导出；消费方（AppRouter／ChapterEditorPanel／三面板／
//     WorkbenchPage）直取模块面。
//   ·（退役）旧名 `window.WorkspaceState`／`window.WorkbenchShell` 零命中——守卫式注册与
//     「mock 不被覆盖」语义随**中介对象消失**收窄合并（去向＝T1 静态零残留见证＋本文件
//     「模块面唯一供给」断言）；`workspace-state.js` 21 API 名单逐名断言不缩水。
//   退役见证（§2.6 表一第 1 行）：三 legacy 文件不存在＋index.html 三标签零命中＋React 供给件存在。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getWorkspaceState,
	parseWorkbenchRoute,
} from "../lib/workspace-state.js";
import { mountWorkbenchPage } from "../pages/WorkbenchPage.jsx";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const INDEX_HTML = fs.readFileSync(
	path.join(REPO_ROOT, "frontend", "index.html"),
	"utf8",
);

// workspace-state.js 21 API 逐名（Plan §2.4.1；legacy :79/:98/:134/:151/:162/:165/:174/:194/
// :201/:210/:226/:232/:240/:241/:252/:271/:277/:300/:341/:343/:355/:368 赋值面全集）
const WS_API = [
	"parseHash",
	"capture",
	"href",
	"normalizeTarget",
	"rememberReturn",
	"readReturn",
	"forgetReturn",
	"noteDeparture",
	"dirtyTracker",
	"registerGuard",
	"clearGuards",
	"guards",
	"hasDirty",
	"beforeNavigate",
	"beginRequest",
	"isCurrent",
	"verify",
	"setHash",
	"navigate",
	"restore",
	"apply",
];

beforeEach(() => {
	window.WorkspaceState = undefined;
	window.WorkbenchShell = undefined;
	window.MozhenWorkbench = undefined;
});

describe("R14 模块面供给（P6-2 ⑨ 转写：WorkspaceState/WorkbenchShell 旧名桥退役）", () => {
	it("模块面供给 21/2 名：getWorkspaceState() 21 名全 function；parseWorkbenchRoute 解析工作台 hash；mountWorkbenchPage 为导出；两旧名／新名零命中", () => {
		const ws = getWorkspaceState();
		for (const name of WS_API) {
			expect(typeof ws[name], name).toBe("function");
		}
		expect(Object.keys(ws).sort()).toEqual([...WS_API].sort());
		expect(typeof mountWorkbenchPage).toBe("function");
		expect(
			parseWorkbenchRoute("#/book/7/workbench/outline/5?tab=proposals"),
		).toEqual({
			bookId: "7",
			module: "outline",
			entityId: "5",
			tab: "proposals",
		});
		expect(parseWorkbenchRoute("#/book/7")).toBeNull();
		// 反向见证：旧名与新名皆零命中（中介对象消失；静态零残留由 T1 承担）
		expect(window.WorkspaceState).toBeUndefined();
		expect(window.WorkbenchShell).toBeUndefined();
		expect(window.MozhenWorkbench).toBeUndefined();
	});

	it("单例唯一供给（守卫式注册 → 模块面）：逐次 getWorkspaceState() 同一对象（guards/epochs 跨调用累积，legacy IIFE 单例同款）", () => {
		// 收窄合并：旧「既有 mock 不被守卫式注册覆盖」断言的对象（window 名）已消失；
		// 等价语义＝单例身份稳定（同一实现、同一闭包态）。
		expect(getWorkspaceState()).toBe(getWorkspaceState());
		expect(typeof getWorkspaceState().registerGuard).toBe("function");
	});
});

describe("R14 退役见证：三件不存在＋三标签零命中＋React 供给件在位（§2.6 表一第 1 行）", () => {
	it("三 legacy 文件不存在（git rm 落地）", () => {
		for (const file of [
			"workspace-state.js",
			"workbench-shell.js",
			"world-workbench.js",
		]) {
			expect(
				fs.existsSync(path.join(REPO_ROOT, "public", "legacy", file)),
				file,
			).toBe(false);
		}
	});

	it("index.html 三处旧标签零命中（删 4 行后不插替代段）", () => {
		expect(INDEX_HTML).not.toMatch(/legacy\/workspace-state\.js/);
		expect(INDEX_HTML).not.toMatch(/legacy\/workbench-shell\.js/);
		expect(INDEX_HTML).not.toMatch(/legacy\/world-workbench\.js/);
	});

	it("React 供给件在位：lib/组件与模块面供给闭合", () => {
		for (const file of [
			"frontend/lib/workspace-state.js",
			"frontend/pages/WorkbenchPage.jsx",
			"frontend/components/WorldWorkbenchPanel.jsx",
		]) {
			expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
		}
		expect(typeof getWorkspaceState().navigate).toBe("function");
		expect(typeof mountWorkbenchPage).toBe("function");
		// 整改 F1/OBS-4 加固（Review-S5-4）：提交 6 退役的三面板旧名桥**反向钉**——三旧名不得
		// 再被供给（面板已由 WorkbenchPage 直接组合渲染，旧名桥无消费方）。
		for (const name of [
			"CharacterWorkbench",
			"LedgerWorkbench",
			"OutlineWorkbench",
		]) {
			expect(window[name], name).toBeUndefined();
		}
	});
});
