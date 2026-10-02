// @vitest-environment jsdom
// T3（P6-2 Plan §4-T3）运行时单例与调用期取值——`getApp()`／`getWorkspaceState()`／刷新渲染缝。
// 红态成因：`getApp`／`setAppForTests`／`getWorkspaceState`／`frontend/lib/writing-status.js` 均未落地
//（模块或导出缺失 ⇒ 文件结构性红）。
//
// 断言要点（Plan §4-T3 逐条）：
//   · getApp() 两次同一对象；state 字段与 app-runtime 工厂缺省一致；setAppForTests 可换装且
//     getApp().api 调用期生效；runStatus.observeApi() 后 getApp().api 为包装函数且幂等（二次调用不变）；
//   · getWorkspaceState() 单例（guards 累积跨调用）＋21 名齐备；
//   · bindWritingStatusRenderer／renderWritingStatusIfBound 未绑定时 no-op、绑定后恰 1 次。
import { beforeEach, describe, expect, it } from "vitest";
import { getApp, setAppForTests } from "../lib/app-runtime.js";
import { runStatus } from "../lib/run-status.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import {
	bindWritingStatusRenderer,
	renderWritingStatusIfBound,
} from "../lib/writing-status.js";

// workspace-state.js 21 API 逐名（同 workbench-bridges.test.jsx:27-49 既有名单，S5-4 交付面）
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

function cleanup() {
	setAppForTests(null);
	delete window.App;
	delete window.BookPage;
}

beforeEach(cleanup);

describe("T3 运行时单例与调用期取值", () => {
	it("T3-1 getApp() 单例：两次同一对象、state 三字段、五方法齐备", () => {
		const a = getApp();
		const b = getApp();
		expect(a).toBe(b);
		expect(typeof a).toBe("object");
		expect(a.state).toEqual({
			currentBook: null,
			currentChapterId: null,
			currentVolumeId: null,
		});
		for (const m of ["api", "toast", "escapeHtml", "openModal", "closeModal"])
			expect(typeof a[m], m).toBe("function");
	});

	it("T3-2 setAppForTests 换装：getApp() 返回注入对象；api 在调用期取（非构造期缓存）", async () => {
		const calls = [];
		const fake = {
			state: { currentBook: { id: 7 } },
			api: async (method, url) => {
				calls.push(`${method} ${url}`);
				return { ok: true };
			},
		};
		setAppForTests(fake);
		expect(getApp()).toBe(fake);
		expect(await getApp().api("GET", "/api/x")).toEqual({ ok: true });
		expect(calls).toEqual(["GET /api/x"]);
		// 换回真实单例：注入对象不再被使用
		setAppForTests(null);
		expect(getApp()).not.toBe(fake);
	});

	it("T3-3 runStatus.observeApi() 猴补 getApp().api 且幂等（二次调用不变）", async () => {
		const inner = async () => ({ ok: "inner" });
		const fake = { state: {}, api: inner };
		setAppForTests(fake);
		delete fake.__runStatusObserved;
		expect(runStatus.observeApi()).toBe(true);
		const wrapped = getApp().api;
		expect(wrapped).not.toBe(inner);
		expect(getApp().__runStatusObserved).toBe(true);
		// 幂等：二次调用返回 false、包装函数身份不变（不得叠加两层包装）
		expect(runStatus.observeApi()).toBe(false);
		expect(getApp().api).toBe(wrapped);
		// 包装对象调用直达内层（只观察不干预）
		expect(await getApp().api("POST", "/api/y")).toEqual({ ok: "inner" });
	});

	it("T3-4 getWorkspaceState() 单例：两次同一对象、21 名齐备、guards 跨调用累积", () => {
		const s1 = getWorkspaceState();
		const s2 = getWorkspaceState();
		expect(s1).toBe(s2);
		for (const name of WS_API) expect(typeof s1[name], name).toBe("function");
		expect(Object.keys(s1).sort()).toEqual([...WS_API].sort());
		// 单例语义：注册的守卫跨调用累积（非每次新建）
		const before = s1.guards().length;
		s1.registerGuard({ key: "t3-a", isDirty: () => false });
		s1.registerGuard({ key: "t3-b", isDirty: () => false });
		expect(getWorkspaceState().guards().length).toBe(before + 2);
		expect(s1.clearGuards()).toBe(2);
		expect(getWorkspaceState().guards().length).toBe(before);
	});

	it("T3-5 刷新渲染缝：未注册时 no-op（零副作用），注册后恰 1 次", () => {
		// 未注册：no-op、不抛
		expect(() => renderWritingStatusIfBound()).not.toThrow();
		expect(renderWritingStatusIfBound()).toBe(false);
		let n = 0;
		const unbind = bindWritingStatusRenderer(() => {
			n += 1;
		});
		expect(renderWritingStatusIfBound()).toBe(true);
		expect(n).toBe(1);
		renderWritingStatusIfBound();
		expect(n).toBe(2);
		// 返回的复位函数解绑（测试复位用；生产零调用）
		expect(typeof unbind).toBe("function");
		unbind();
		expect(renderWritingStatusIfBound()).toBe(false);
		expect(n).toBe(2);
	});
});
