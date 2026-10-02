// S5-3 红测 R1（Plan §4）：resolveRoute 纯函数矩阵——逐字对位 public/legacy/app.js:119-223
// route() 的匹配顺序/正则/decode 容错/前缀语义/重定向形态。
// 断言锚点（legacy 行号）：:119-123 全 hidden 前置与 hash 取值、:125-129 workbench（传原串）、
// :131-139 timeline、:142-150 cards、:153-161 stylelab、:164-181 read（parseInt||null）、
// :183-197 book 本体（split('/')[2]）、:199-203 profile、:205-209 settings、:211-215 agent、
// :217-220 兜底重定向（location.hash='#/'，push 语义）。
import { describe, expect, it } from "vitest";
import { resolveRoute } from "./resolve-route.js";

describe("resolveRoute（legacy app.js route() 逐字对位）", () => {
	it("R1-1 书架与空 hash：''/#/'#/ 均落 page-shelf（:120 hash||'#/'、:221-222）；裸 '#' 走兜底重定向（:217-219）", () => {
		for (const h of ["", "#/", null, undefined]) {
			const r = resolveRoute(h);
			expect(r.kind, `hash=${JSON.stringify(h)}`).toBe("shelf");
			expect(r.pageId).toBe("page-shelf");
			expect(r.redirect).toBe(null);
		}
		// 真实浏览器中 location.hash 对裸 '#' 返回 ''（探针实证），'#' 仅作为纯函数输入存在：
		// legacy route() 会因其 !== '#/' 而兜底重定向
		const hashOnly = resolveRoute("#");
		expect(hashOnly.kind).toBe("redirect");
		expect(hashOnly.redirect).toBe("#/");
	});

	it("R1-2 workbench：前缀命中且 rawHash 原串（不解析不 decode）（:125-129）", () => {
		const r = resolveRoute("#/book/7/workbench/outline");
		expect(r.kind).toBe("workbench");
		expect(r.pageId).toBe("page-workbench");
		expect(r.rawHash).toBe("#/book/7/workbench/outline");
		const r2 = resolveRoute("#/book/7/workbench/");
		expect(r2.kind).toBe("workbench");
		expect(r2.rawHash).toBe("#/book/7/workbench/");
	});

	it("R1-3 workbench 优先于其余 #/book/ 分支（:125 分支在前）", () => {
		const r = resolveRoute("#/book/7/workbench/read");
		expect(r.kind).toBe("workbench");
		expect(r.redirect).toBe(null);
	});

	it("R1-4 timeline：双段参数＋前缀命中＋参数原样（:131-139）", () => {
		const r = resolveRoute("#/book/7/characters/5/timeline");
		expect(r.kind).toBe("timeline");
		expect(r.pageId).toBe("page-timeline");
		expect(r.bookId).toBe("7");
		expect(r.characterId).toBe("5");
	});

	it("R1-5 timeline decode 容错：%ZZ 抛错 → 空 → 重定向 #/（:133-135）", () => {
		const r = resolveRoute("#/book/%ZZ/characters/5/timeline");
		expect(r.kind).toBe("redirect");
		expect(r.redirect).toBe("#/");
		expect(r.pageId).toBe(null);
	});

	it("R1-6 timeline decode 成功：%E4%B8%AD（:134 decodeURIComponent）", () => {
		const r = resolveRoute("#/book/%E4%B8%AD/characters/5/timeline");
		expect(r.kind).toBe("timeline");
		expect(r.bookId).toBe("中");
	});

	it("R1-7 cards/stylelab：前缀命中＋decode 容错（:142-161）", () => {
		const cards = resolveRoute("#/book/7/cards");
		expect(cards.kind).toBe("cards");
		expect(cards.pageId).toBe("page-cards");
		expect(cards.bookId).toBe("7");
		const lab = resolveRoute("#/book/7/stylelab");
		expect(lab.kind).toBe("stylelab");
		expect(lab.pageId).toBe("page-stylelab");
		expect(lab.bookId).toBe("7");
		const bad = resolveRoute("#/book/%ZZ/cards");
		expect(bad.kind).toBe("redirect");
		expect(resolveRoute("#/book/%ZZ/stylelab").kind).toBe("redirect");
	});

	it("R1-8 cards 先于 stylelab（legacy :142 早于 :153 的分支序）", () => {
		const r = resolveRoute("#/book/7/cards/stylelab");
		expect(r.kind).toBe("cards");
	});

	it("R1-9 read：chapterId 数字/null 与 readxyz 前缀命中（:164-181）", () => {
		const r1 = resolveRoute("#/book/7/read/12");
		expect(r1.kind).toBe("read");
		expect(r1.pageId).toBe("page-read");
		expect(r1.bookId).toBe("7");
		expect(r1.chapterId).toBe(12);
		const r2 = resolveRoute("#/book/7/read");
		expect(r2.kind).toBe("read");
		expect(r2.chapterId).toBe(null);
		const r3 = resolveRoute("#/book/7/read/abc");
		expect(r3.kind).toBe("read");
		expect(r3.chapterId).toBe(null);
		const r4 = resolveRoute("#/book/7/readxyz");
		expect(r4.kind).toBe("read");
		expect(r4.bookId).toBe("7");
		expect(r4.chapterId).toBe(null);
	});

	it("R1-10 read decode 失败 → 重定向（:166-177）", () => {
		const r = resolveRoute("#/book/%ZZ/read/12");
		expect(r.kind).toBe("redirect");
		expect(r.redirect).toBe("#/");
	});

	it("R1-11 book 本体：split('/')[2]（含 query 形态不截断）（:183-197）", () => {
		const r = resolveRoute("#/book/7");
		expect(r.kind).toBe("book");
		expect(r.pageId).toBe("page-book");
		expect(r.bookId).toBe("7");
		expect(resolveRoute("#/book/7/x").kind).toBe("book");
		expect(resolveRoute("#/book/7/x").bookId).toBe("7");
		// legacy 逐字：hash.split('/')[2] 不切 query（'7?x=1' 整段成为 bookId）
		const q = resolveRoute("#/book/7?x=1");
		expect(q.kind).toBe("book");
		expect(q.bookId).toBe("7?x=1");
	});

	it("R1-12 book 分支边界：#/book、#/book/、#/book/%ZZ 均重定向（:190-192）", () => {
		for (const h of ["#/book", "#/book/", "#/book/%ZZ"]) {
			const r = resolveRoute(h);
			expect(r.kind, h).toBe("redirect");
			expect(r.redirect).toBe("#/");
		}
	});

	it("R1-13 read 先于 book 本体（:164 分支早于 :183）", () => {
		const r = resolveRoute("#/book/7/read/12");
		expect(r.kind).toBe("read");
	});

	it("R1-14 profile/settings/agent 精确匹配（:199-215）", () => {
		expect(resolveRoute("#/profile").kind).toBe("profile");
		expect(resolveRoute("#/profile").pageId).toBe("page-profile");
		expect(resolveRoute("#/settings").kind).toBe("settings");
		expect(resolveRoute("#/settings").pageId).toBe("page-settings");
		expect(resolveRoute("#/agent").kind).toBe("agent");
		expect(resolveRoute("#/agent").pageId).toBe("page-agent");
	});

	it("R1-15 兜底重定向：#foo/#/unknown/#/book（无尾斜杠）→ #/（:217-219 push）", () => {
		for (const h of ["#foo", "#/unknown", "#/book"]) {
			const r = resolveRoute(h);
			expect(r.kind, h).toBe("redirect");
			expect(r.redirect).toBe("#/");
			expect(r.pageId).toBe(null);
		}
	});
});
