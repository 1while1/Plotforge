// @vitest-environment jsdom
// 书外页面全局导航栏（UI 优化阶段 4a）：显隐、书内项按路由带书 id 出现、高亮与链接。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRail, railContext } from "./AppRail.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;

async function go(hash) {
	await act(async () => {
		window.location.hash = hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
}

const rail = () => document.getElementById("app-rail");
const keys = () =>
	[...rail().querySelectorAll("[data-rail]")].map((el) =>
		el.getAttribute("data-rail"),
	);
const item = (k) => rail().querySelector(`[data-rail="${k}"]`);

beforeEach(async () => {
	window.location.hash = "#/";
	document.body.innerHTML = '<div id="mount"></div>';
	root = createRoot(document.getElementById("mount"));
	await act(async () => root.render(<AppRail />));
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.className = "";
});

describe("railContext", () => {
	it("写作页与非法路由不显示；其余页面给出书 id 与高亮项", () => {
		expect(railContext("#/book/7")).toBeNull();
		expect(railContext("#/nope")).toBeNull();
		expect(railContext("#/")).toEqual({ bookId: null, active: "shelf" });
		expect(railContext("#/agent")).toEqual({ bookId: null, active: "agent" });
		expect(railContext("#/book/7/workbench/ledger?tab=proposals")).toEqual({
			bookId: "7",
			active: "state",
		});
		expect(railContext("#/book/7/characters/3/timeline").active).toBe(
			"characters",
		);
		expect(railContext("#/book/7/stylelab").active).toBe("cards");
		expect(railContext("#/book/7/read/12").active).toBe("chapters");
	});
});

describe("AppRail", () => {
	it("书架：只有全局项，书架高亮，body 让出左侧宽度", () => {
		expect(keys()).toEqual(["shelf", "agent", "settings", "profile"]);
		expect(item("shelf").getAttribute("aria-current")).toBe("page");
		expect(document.body.classList.contains("has-app-rail")).toBe(true);
	});

	it("书内页面：出现写作与四个模块和文风，链接指向本书整页", async () => {
		await go("#/book/B%201/workbench/world");
		expect(keys()).toEqual([
			"shelf",
			"chapters",
			"agent",
			"outline",
			"characters",
			"world",
			"state",
			"cards",
			"settings",
			"profile",
		]);
		expect(item("chapters").getAttribute("href")).toBe("#/book/B%201");
		expect(item("state").getAttribute("href")).toBe(
			"#/book/B%201/workbench/ledger",
		);
		expect(item("cards").getAttribute("href")).toBe("#/book/B%201/cards");
		expect(item("world").getAttribute("aria-current")).toBe("page");
		expect(item("shelf").hasAttribute("aria-current")).toBe(false);
	});

	it("进入写作页隐藏本栏并撤掉 body 标记，离开后恢复", async () => {
		await go("#/book/7");
		expect(rail()).toBeNull();
		expect(document.body.classList.contains("has-app-rail")).toBe(false);
		await go("#/settings");
		expect(item("settings").getAttribute("aria-current")).toBe("page");
		expect(document.body.classList.contains("has-app-rail")).toBe(true);
	});
});
