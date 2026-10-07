// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	APPEARANCE_KEY,
	applyAppearance,
	DEFAULT_APPEARANCE,
	getAppearance,
	loadAppearance,
	normalizeAppearance,
	resetAppearanceForTest,
	resolveTheme,
	saveAppearance,
	setAppearance,
	subscribeAppearance,
} from "./appearance.js";

function memoryStorage(initial = {}) {
	const data = { ...initial };
	return {
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = String(v);
		},
		data,
	};
}

afterEach(() => {
	resetAppearanceForTest();
	localStorage.clear();
	for (const k of ["theme", "accent", "readFont", "readWidth"])
		delete document.documentElement.dataset[k];
});

describe("外观偏好", () => {
	it("非法值逐项回落默认值，合法值保留", () => {
		expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
		expect(
			normalizeAppearance({ accent: "plum", readWidth: "huge", theme: 3 }),
		).toEqual({ ...DEFAULT_APPEARANCE, accent: "plum" });
	});

	it("存取往返；坏 JSON 与抛错存储都回落默认值", () => {
		const s = memoryStorage();
		saveAppearance({ accent: "ochre", readFont: "fangsong" }, s);
		expect(JSON.parse(s.data[APPEARANCE_KEY]).accent).toBe("ochre");
		expect(loadAppearance(s)).toEqual({
			...DEFAULT_APPEARANCE,
			accent: "ochre",
			readFont: "fangsong",
		});
		expect(
			loadAppearance(memoryStorage({ [APPEARANCE_KEY]: "{oops" })),
		).toEqual(DEFAULT_APPEARANCE);
		const throwing = {
			getItem() {
				throw new Error("denied");
			},
			setItem() {
				throw new Error("denied");
			},
		};
		expect(loadAppearance(throwing)).toEqual(DEFAULT_APPEARANCE);
		expect(saveAppearance({ accent: "plum" }, throwing).accent).toBe("plum");
	});

	it("写到根元素 data-*；system 主题按系统偏好解析", () => {
		const root = document.createElement("html");
		applyAppearance({ accent: "indigo", readWidth: "wide" }, root);
		expect(root.dataset).toMatchObject({
			theme: "light",
			accent: "indigo",
			readFont: "dengxian",
			readWidth: "wide",
		});
		const dark = () => ({ matches: true });
		expect(resolveTheme("system", dark)).toBe("dark");
		expect(resolveTheme("system", () => ({ matches: false }))).toBe("light");
		expect(resolveTheme("dark", dark)).toBe("dark");
	});

	it("setAppearance 持久化、生效并通知订阅者", () => {
		const seen = [];
		const off = subscribeAppearance((p) => seen.push(p.accent));
		setAppearance({ accent: "plum" });
		expect(document.documentElement.dataset.accent).toBe("plum");
		expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)).accent).toBe(
			"plum",
		);
		expect(getAppearance().accent).toBe("plum");
		off();
		setAppearance({ accent: "teal" });
		expect(seen).toEqual(["plum"]);
	});
});
