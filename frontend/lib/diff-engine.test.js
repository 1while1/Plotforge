// S3-2 红测（Plan §4 T1~T3）：diff 引擎——逐字移植 diff.js 的
// splitLines/lcsAlign/charDiff（纯函数语义不变）+ buildDiffBlocks 结构化分块
// （替代 renderDiff 的 HTML 拼装：same 行独立成块；连续 del/ins 收集配对
// min(dels,inss)；剩余整行；pair.parts 为合并后字级部件；输出纯数据无 HTML 字符串）。
import { describe, expect, it } from "vitest";
import {
	buildDiffBlocks,
	charDiff,
	lcsAlign,
	splitLines,
} from "./diff-engine.js";

describe("diff 引擎（diff.js 逐字移植 + buildDiffBlocks）", () => {
	it("T1 splitLines：\\n+ 切分、trim、滤空行；lcsAlign：same/del/ins 操作序列", () => {
		expect(splitLines("甲\n\n 乙 \n丙")).toEqual(["甲", "乙", "丙"]);
		expect(splitLines("")).toEqual([]);
		// String 强转语义逐字（String(null)→'null'，单行非空保留——与 diff.js:11~13 一致）
		expect(splitLines(null)).toEqual(["null"]);
		// a=[p,q] b=[q,r]：dp[i+1][j]>=dp[i][j+1] 偏向 del → del(p)、same(q)、尾部 ins(r)
		expect(lcsAlign(["p", "q"], ["q", "r"])).toEqual([
			{ type: "del", oldLine: "p" },
			{ type: "same", oldLine: "q", newLine: "q" },
			{ type: "ins", newLine: "r" },
		]);
		expect(lcsAlign(["同"], ["同"])).toEqual([
			{ type: "same", oldLine: "同", newLine: "同" },
		]);
	});

	it("T2 charDiff：相邻同类合并；m*n>40000 退化为整段 del+ins 两部件", () => {
		// 原始部件 del(a)、del(b)、ins(c) → 合并为 {ab,del}、{c,ins}
		expect(charDiff("ab", "c")).toEqual([
			{ text: "ab", kind: "del" },
			{ text: "c", kind: "ins" },
		]);
		expect(charDiff("同字", "同字")).toEqual([{ text: "同字", kind: "same" }]);
		const bigOld = "旧".repeat(300);
		const bigNew = "新".repeat(300);
		expect(charDiff(bigOld, bigNew)).toEqual([
			{ text: bigOld, kind: "del" },
			{ text: bigNew, kind: "ins" },
		]);
	});

	it("T3 buildDiffBlocks：same 独立块、2删3插→2 pair+1 ins 整行、剩余 del 整行、pair 为字级部件、纯数据无 HTML", () => {
		// same 行独立成块
		expect(buildDiffBlocks("甲\n乙", "甲\n乙")).toEqual([
			{ type: "same", text: "甲" },
			{ type: "same", text: "乙" },
		]);
		// 2 删 3 插：配对 2 组 pair + 剩余 1 条 ins 整行；首尾 same 独立块
		const blocks = buildDiffBlocks("A\nX1\nX2\nB", "A\nY1\nY2\nY3\nB");
		expect(blocks.map((b) => b.type)).toEqual([
			"same",
			"pair",
			"pair",
			"ins",
			"same",
		]);
		expect(blocks[0]).toEqual({ type: "same", text: "A" });
		expect(blocks[3]).toEqual({ type: "ins", text: "Y3" });
		expect(blocks[4]).toEqual({ type: "same", text: "B" });
		// pair.parts 为合并后字级部件（kind: same/del/ins）
		expect(blocks[1].old).toEqual(charDiff("X1", "Y1"));
		expect(blocks[1].new).toEqual(charDiff("X1", "Y1"));
		expect(blocks[2].old).toEqual(charDiff("X2", "Y2"));
		// 剩余整行 del 块（3 删 0 插 → 3 条 del）
		expect(
			buildDiffBlocks("A\nD1\nD2\nD3", "A").map((b) => ({
				type: b.type,
				text: b.text,
			})),
		).toEqual([
			{ type: "same", text: "A" },
			{ type: "del", text: "D1" },
			{ type: "del", text: "D2" },
			{ type: "del", text: "D3" },
		]);
		// 纯数据：只有 text/kind 或 type/text/old/new 键，无 HTML 字符串痕迹
		const withHtml = buildDiffBlocks("共<p>行\n只旧行", "共<p>行\n新行&");
		expect(JSON.stringify(withHtml)).not.toContain("<p class=");
		expect(JSON.stringify(withHtml)).not.toContain("d-old");
		for (const block of withHtml) {
			expect(["same", "pair", "del", "ins"]).toContain(block.type);
			if (
				block.type === "same" ||
				block.type === "del" ||
				block.type === "ins"
			) {
				expect(Object.keys(block).sort()).toEqual(["text", "type"]);
			} else {
				expect(Object.keys(block).sort()).toEqual(["new", "old", "type"]);
				for (const part of block.old) {
					expect(Object.keys(part).sort()).toEqual(["kind", "text"]);
					expect(["same", "del", "ins"]).toContain(part.kind);
				}
			}
		}
	});
});
