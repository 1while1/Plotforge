import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUTS, shortcutKeys } from "./shortcuts.js";

const ev = (key, mods = {}) => ({
	key,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	isComposing: false,
	...mods,
});

describe("matchShortcut", () => {
	it("识别表内全部主动组合，Mac ⌘ 视同 Ctrl", () => {
		expect(matchShortcut(ev("k", { ctrlKey: true }))).toBe("palette");
		expect(matchShortcut(ev("K", { metaKey: true }))).toBe("palette");
		expect(matchShortcut(ev("/", { ctrlKey: true }))).toBe("help");
		expect(matchShortcut(ev("s", { ctrlKey: true }))).toBe("save");
		expect(matchShortcut(ev("L", { ctrlKey: true, shiftKey: true }))).toBe(
			"lock",
		);
		expect(matchShortcut(ev("F", { ctrlKey: true, shiftKey: true }))).toBe(
			"focus",
		);
		expect(matchShortcut(ev("ArrowUp", { altKey: true }))).toBe("prevChapter");
		expect(matchShortcut(ev("ArrowDown", { altKey: true }))).toBe(
			"nextChapter",
		);
	});

	it("修饰键不完全吻合、输入法组字中、无修饰键时不触发", () => {
		expect(matchShortcut(ev("k"))).toBeNull();
		expect(
			matchShortcut(ev("s", { ctrlKey: true, shiftKey: true })),
		).toBeNull();
		expect(matchShortcut(ev("l", { ctrlKey: true }))).toBeNull();
		expect(
			matchShortcut(ev("ArrowUp", { altKey: true, ctrlKey: true })),
		).toBeNull();
		expect(
			matchShortcut(ev("k", { ctrlKey: true, isComposing: true })),
		).toBeNull();
		expect(matchShortcut(ev("Enter", { ctrlKey: true }))).toBeNull();
		expect(matchShortcut(null)).toBeNull();
	});
});

describe("SHORTCUTS 表", () => {
	it("id 唯一，主动项都能被 matchShortcut 识别", () => {
		const ids = SHORTCUTS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		const active = SHORTCUTS.filter((s) => !s.passive).map((s) => s.id);
		expect(active).toEqual([
			"palette",
			"help",
			"save",
			"prevChapter",
			"nextChapter",
			"lock",
			"focus",
		]);
		expect(shortcutKeys("save")).toBe("Ctrl+S");
		expect(shortcutKeys("nope")).toBe("");
	});
});
