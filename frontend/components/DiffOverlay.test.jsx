// @vitest-environment jsdom
// S3-2 红测（Plan §4 T4~T7）：DiffOverlay——消费既有静态 overlay 壳
// （#diff-view/#diff-scope/#btn-diff-accept/#btn-diff-reject/#diff-body，桩镜像
// index.html:188~196），show/hide/bind 与旧 diff.js:111~132 逐字等价：scope 文案映射、
// 去 hidden、acceptHandler（accept 点击=hide 后回调恰一次；reject 仅隐藏；hide 清 handler）、
// bind onclick 赋值防叠加、宿主缺失安全 return、hide 不清 body、连续 show 重渲。
// DiffBody：buildDiffBlocks → JSX 双视角（d-old 显 same/del、d-new 显 same/ins），
// 特殊字符按文本节点转义（无裸标签注入）。

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
	bind as bindOverlay,
	DiffBody,
	hide as hideOverlay,
	show as showOverlay,
} from "./DiffOverlay.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const $ = (id) => document.getElementById(id);

// 镜像 index.html:187~197 的静态 overlay 壳（位于 #editor-body 内）
function buildShell() {
	document.body.innerHTML = `<div id="editor-body"><div id="diff-view" class="diff-view hidden"><div class="diff-head"><span class="pane-title">润色对比 <span id="diff-scope" class="diff-scope"></span></span><span class="diff-actions"><button id="btn-diff-reject" class="btn btn-small btn-ghost">放弃</button><button id="btn-diff-accept" class="btn btn-small btn-primary">采纳润色</button></span></div><div id="diff-body" class="diff-body"></div></div></div>`;
}

// 与旧实现同构的最小 fixture：same 行 + 一对 del/ins 整行对
const FIX_OLD = "共同行\n只旧行\n";
const FIX_NEW = "共同行\n新行\n";
// 含 HTML 特殊字符的润色 fixture（同 D7 冒烟脚本）
const HTML_OLD =
	"夜色沉沉，<b>灯影</b>摇曳。\n他在纸上写下「覆水难收」。\n窗外雨声不歇。";
const HTML_NEW =
	"夜色深沉，灯影摇曳。\n他在纸上写下「<i>覆水难收</i>」& 转身。";

beforeEach(() => {
	buildShell();
	act(() => {
		hideOverlay();
	});
});

describe("DiffOverlay（diff 迁移：静态壳 + React body）", () => {
	it("T4 show：去 hidden；scope 文案逐字映射；d-same/d-old/d-new/d-del/d-ins 结构；特殊字符按文本转义", () => {
		act(() => {
			showOverlay({
				scope: "selection",
				original: FIX_OLD,
				polished: FIX_NEW,
				onAccept: () => {},
			});
		});
		expect($("diff-view").classList.contains("hidden")).toBe(false);
		expect($("diff-scope").textContent).toBe("· 选中段落");
		const body = $("diff-body");
		expect(body.querySelectorAll(".d-same").length).toBe(1);
		expect(body.querySelector(".d-same").textContent).toBe("共同行");
		expect(body.querySelectorAll(".d-old").length).toBe(1);
		expect(body.querySelectorAll(".d-new").length).toBe(1);
		expect(body.querySelector(".d-del").textContent).toBe("只旧");
		// charDiff('只旧行','新行') → del(只旧)+ins(新)+same(行)：d-new 整行文本『新行』
		expect(body.querySelector(".d-ins").textContent).toBe("新");
		expect(body.querySelector(".d-new").textContent).toBe("新行");
		act(() => {
			showOverlay({
				scope: "chapter",
				original: HTML_OLD,
				polished: HTML_NEW,
				onAccept: () => {},
			});
		});
		expect($("diff-scope").textContent).toBe("· 整章");
		const firstP = body.querySelector("p");
		expect(firstP.className).toBe("d-old");
		// 文本节点转义：<b> 不是元素、字面出现在 textContent 中
		expect(firstP.textContent).toBe("夜色沉沉，<b>灯影</b>摇曳。");
		expect(firstP.querySelector("b")).toBeNull();
	});

	it("T5 accept 点击→onAccept(polished) 恰 1 次且加回 hidden；reject 仅隐藏；hide 后 handler 清空", () => {
		const seen = [];
		act(() => {
			showOverlay({
				scope: "chapter",
				original: FIX_OLD,
				polished: "采纳稿",
				onAccept: (p) => seen.push(p),
			});
		});
		bindOverlay();
		act(() => {
			$("btn-diff-accept").click();
		});
		expect(seen).toEqual(["采纳稿"]);
		expect($("diff-view").classList.contains("hidden")).toBe(true);
		// reject：仅隐藏、不回调
		act(() => {
			showOverlay({
				scope: "chapter",
				original: FIX_OLD,
				polished: "稿2",
				onAccept: (p) => seen.push(p),
			});
		});
		act(() => {
			$("btn-diff-reject").click();
		});
		expect(seen).toEqual(["采纳稿"]);
		expect($("diff-view").classList.contains("hidden")).toBe(true);
		// hide 后 handler 清空：再点 accept 不触发
		act(() => {
			showOverlay({
				scope: "chapter",
				original: FIX_OLD,
				polished: "稿3",
				onAccept: (p) => seen.push(p),
			});
		});
		act(() => {
			hideOverlay();
		});
		act(() => {
			$("btn-diff-accept").click();
		});
		expect(seen).toEqual(["采纳稿"]);
	});

	it("T6 bind 幂等：重复 bind 后点击只触发一次；宿主缺失时 show 安全 return", () => {
		let calls = 0;
		bindOverlay();
		bindOverlay();
		act(() => {
			showOverlay({
				scope: "chapter",
				original: FIX_OLD,
				polished: "幂等稿",
				onAccept: () => {
					calls += 1;
				},
			});
		});
		act(() => {
			$("btn-diff-accept").click();
		});
		expect(calls).toBe(1);
		// 缺 #diff-view：show 不抛错（宿主缺失守卫）
		$("diff-view").remove();
		expect(() => {
			act(() => {
				showOverlay({
					scope: "chapter",
					original: FIX_OLD,
					polished: "x",
					onAccept: () => {},
				});
			});
		}).not.toThrow();
	});

	it("T7 连续两次 show 用新内容重渲；hide 不清 body，再 show 覆盖", () => {
		act(() => {
			showOverlay({
				scope: "chapter",
				original: FIX_OLD,
				polished: FIX_NEW,
				onAccept: () => {},
			});
		});
		const body = $("diff-body");
		expect(body.textContent).toContain("共同行");
		act(() => {
			showOverlay({
				scope: "selection",
				original: "旧A",
				polished: "新B",
				onAccept: () => {},
			});
		});
		// 双视角：d-old 显旧稿部件、d-new 显新稿部件，textContent 为两行拼接
		expect(body.textContent).toBe("旧A新B");
		// hide 不清 body（与旧实现一致）：壳藏起但内容仍在
		act(() => {
			hideOverlay();
		});
		expect($("diff-view").classList.contains("hidden")).toBe(true);
		expect(body.textContent).toBe("旧A新B");
		act(() => {
			showOverlay({
				scope: "chapter",
				original: "旧C",
				polished: "新D",
				onAccept: () => {},
			});
		});
		expect(body.textContent).toBe("旧C新D");
	});

	it("T4b DiffBody 独立导出：same/del/ins 纯 JSX 渲染（供冲突弹窗复用）", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		act(() => {
			createRoot(container).render(
				<DiffBody oldText={"甲行\n乙行"} newText={"甲行\n丙行"} />,
			);
		});
		const ps = container.querySelectorAll("p");
		expect(ps.length).toBe(3);
		expect(ps[0].className).toBe("d-same");
		expect(ps[0].textContent).toBe("甲行");
		expect(ps[1].className).toBe("d-old");
		expect(ps[1].textContent).toBe("乙行");
		expect(ps[2].className).toBe("d-new");
		expect(ps[2].textContent).toBe("丙行");
	});
});
