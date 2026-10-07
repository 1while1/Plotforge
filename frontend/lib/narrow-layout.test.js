// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	anyDrawerOpen,
	CHAT_DRAWER_QUERY,
	closeDrawers,
	isDrawer,
	isDrawerOpen,
	NAV_DRAWER_QUERY,
	setDrawerOpen,
	syncDrawerToggles,
	toggleDrawer,
} from "./narrow-layout.js";

const original = window.matchMedia;
let matching;

function useWidth(...queries) {
	matching = new Set(queries);
}

beforeEach(() => {
	matching = new Set();
	window.matchMedia = (q) => ({ matches: matching.has(q), media: q });
	document.body.innerHTML = `
		<button id="btn-toggle-left-panel" aria-expanded="true"></button>
		<button id="btn-toggle-chat-panel" aria-expanded="true"></button>
		<main id="book-workbench" class="workbench"></main>`;
});

afterEach(() => {
	window.matchMedia = original;
	document.body.innerHTML = "";
});

const bench = () => document.getElementById("book-workbench");
const aria = (id) => document.getElementById(id).getAttribute("aria-expanded");

describe("narrow-layout", () => {
	it("断点：≤1180 只有左栏是抽屉，≤760 两侧都是", () => {
		expect(isDrawer("nav")).toBe(false);
		useWidth(NAV_DRAWER_QUERY);
		expect([isDrawer("nav"), isDrawer("chat")]).toEqual([true, false]);
		useWidth(NAV_DRAWER_QUERY, CHAT_DRAWER_QUERY);
		expect([isDrawer("nav"), isDrawer("chat")]).toEqual([true, true]);
	});

	it("一次只开一个抽屉，按钮 aria-expanded 跟抽屉走", () => {
		useWidth(NAV_DRAWER_QUERY, CHAT_DRAWER_QUERY);
		syncDrawerToggles();
		expect(aria("btn-toggle-left-panel")).toBe("false");
		toggleDrawer("nav");
		expect(isDrawerOpen("nav")).toBe(true);
		expect(aria("btn-toggle-left-panel")).toBe("true");
		setDrawerOpen("chat", true);
		expect(isDrawerOpen("nav")).toBe(false);
		expect(isDrawerOpen("chat")).toBe(true);
		expect(aria("btn-toggle-left-panel")).toBe("false");
		expect(aria("btn-toggle-chat-panel")).toBe("true");
		expect(closeDrawers()).toBe(true);
		expect(anyDrawerOpen()).toBe(false);
		expect(closeDrawers()).toBe(false);
	});

	it("宽屏下 aria-expanded 按收起偏好还原，不被抽屉状态带偏", () => {
		useWidth(NAV_DRAWER_QUERY);
		setDrawerOpen("nav", true);
		useWidth();
		bench().classList.add("chat-collapsed");
		closeDrawers();
		syncDrawerToggles();
		expect(aria("btn-toggle-left-panel")).toBe("true");
		expect(aria("btn-toggle-chat-panel")).toBe("false");
	});

	it("没有工作台时安全返回", () => {
		document.body.innerHTML = "";
		expect(setDrawerOpen("nav", true)).toBe(false);
		expect(isDrawerOpen("nav")).toBe(false);
		expect(closeDrawers()).toBe(false);
	});
});
