// @vitest-environment jsdom
// S3-2 红测（Plan §4 T15）：RelationMap——SVG JSX 镜像旧 renderSVG
// （character-relations.js:50~69）：svg.relation-map（viewBox/role/aria-label）、
// 边 g.relation-edge.polarity-{polarity}+line 坐标+中点标签（label_from_focus 优先、
// forward_label 兜底、offset=((index%3)-1)*12）、节点 g.relation-node[.focus]+
// circle r=35/27+text、端点缺失的边跳过、名称含 <>&" 时按文本转义。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import RelationMap from "./RelationMap.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FOCUS = { id: 9001, name: "沈砚<主角>" };
const P1 = { id: 9002, name: "顾清词" };
const P2 = { id: 9003, name: "周砚之&友" };
const P3 = { id: 9004, name: "陆\"离'" };
const GHOST = { id: 9999, name: "幽灵" };
const RELS = [
	{
		endpoint_a: FOCUS,
		endpoint_b: P1,
		polarity: "positive",
		relation_type: { label_from_focus: "挚友", forward_label: "挚友" },
	},
	{
		endpoint_a: FOCUS,
		endpoint_b: P2,
		polarity: "negative",
		relation_type: { label_from_focus: "宿敌", forward_label: "宿敌" },
	},
	{
		endpoint_a: FOCUS,
		endpoint_b: P3,
		polarity: "neutral",
		relation_type: { label_from_focus: null, forward_label: "旧识" },
	},
	{
		endpoint_a: P1,
		endpoint_b: GHOST,
		polarity: "positive",
		relation_type: { label_from_focus: "远亲", forward_label: "远亲" },
	},
];

let container = null;
beforeEach(() => {
	document.body.innerHTML = "";
	container = document.createElement("div");
	document.body.appendChild(container);
});

function renderMap(focus = FOCUS, relations = RELS) {
	act(() => {
		createRoot(container).render(
			<RelationMap focus={focus} relations={relations} />,
		);
	});
	return container.querySelector("svg");
}

describe("RelationMap（SVG JSX 镜像）", () => {
	it("T15 svg 壳/边/节点/标签/跳过/转义全链", () => {
		const svg = renderMap();
		expect(svg).not.toBeNull();
		expect(svg.getAttribute("class")).toBe("relation-map");
		expect(svg.getAttribute("viewBox")).toBe("0 0 760 460");
		expect(svg.getAttribute("role")).toBe("img");
		expect(svg.getAttribute("aria-label")).toBe("人物关系图");
		// 边：4 条关系里 GHOST 端点缺失 → 跳过，渲染 3 条
		const edges = svg.querySelectorAll("g.relation-edge");
		expect(edges.length).toBe(3);
		expect([...edges].map((e) => e.getAttribute("class"))).toEqual([
			"relation-edge polarity-positive",
			"relation-edge polarity-negative",
			"relation-edge polarity-neutral",
		]);
		// 节点：中心 + 3 卫星；focus 类与 r=35/27；标签中点 + offset
		const nodes = svg.querySelectorAll("g.relation-node");
		expect(nodes.length).toBe(4);
		expect(nodes[0].getAttribute("class")).toBe("relation-node focus");
		expect(nodes[0].getAttribute("transform")).toBe("translate(380,230)");
		expect(nodes[0].querySelector("circle").getAttribute("r")).toBe("35");
		expect(nodes[1].getAttribute("class")).toBe("relation-node");
		expect(nodes[1].querySelector("circle").getAttribute("r")).toBe("27");
		expect(nodes[0].querySelector("text").getAttribute("text-anchor")).toBe(
			"middle",
		);
		expect(nodes[0].querySelector("text").getAttribute("dy")).toBe("4");
		// 名称特殊字符按文本渲染（无元素注入）
		expect(nodes[0].querySelector("text").textContent).toBe("沈砚<主角>");
		expect(nodes[0].querySelector("text").children.length).toBe(0);
		expect(nodes[2].querySelector("text").textContent).toBe("周砚之&友");
		expect(nodes[3].querySelector("text").textContent).toBe("陆\"离'");
		// 标签：label_from_focus 优先、forward_label 兜底；offset 逐条验证
		const labels = [...svg.querySelectorAll("g.relation-edge text")];
		expect(labels.map((t) => t.textContent)).toEqual(["挚友", "宿敌", "旧识"]);
		const line0 = edges[0].querySelector("line");
		const x1 = Number(line0.getAttribute("x1"));
		const y1 = Number(line0.getAttribute("y1"));
		const x2 = Number(line0.getAttribute("x2"));
		const y2 = Number(line0.getAttribute("y2"));
		expect(Number(labels[0].getAttribute("x"))).toBe((x1 + x2) / 2);
		expect(Number(labels[0].getAttribute("y"))).toBe((y1 + y2) / 2 - 12);
		const line2 = edges[2].querySelector("line");
		const y2b = Number(line2.getAttribute("y2"));
		const y1b = Number(line2.getAttribute("y1"));
		expect(Number(labels[2].getAttribute("y"))).toBe((y1b + y2b) / 2 + 12);
	});

	it("T15b 空 relations：仅中心节点", () => {
		const svg = renderMap(FOCUS, []);
		expect(svg.querySelectorAll("g.relation-node").length).toBe(1);
		expect(svg.querySelectorAll("g.relation-edge").length).toBe(0);
	});
});
