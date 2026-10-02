// RelationMap（S3-2 D6）：public/legacy/character-relations.js renderSVG 的 JSX 镜像
// （character-relations.js:50~69）：布局引擎用 lib/character-relations.js 的逐字移植。
// - 边：g.relation-edge.polarity-{polarity} + line（端点坐标）+ 中点标签 text
//   （label_from_focus || forward_label，offset ((index%3)-1)*12）；端点缺失的边跳过
//   （等价旧 `if (!a||!b) return ''`；offset 的 index 仍按全部关系计数，与旧一致）；
// - 节点：g.relation-node[.focus] transform=translate(x,y) + circle r=35/27（focus/卫星）
//   + text text-anchor=middle dy=4；
// - 壳：svg.relation-map viewBox="0 0 w h" role="img" aria-label="人物关系图"。
// 名称含 <>&" 时 React 文本节点自动转义（旧 escape 的 JSX 等价物，不随迁）。
// 桥见 bridges/legacy-bridge.jsx 的 window.MozhenCharacterRelations =
// { computeRadialLayout, renderSVG }；消费点 character-workbench.js:273 单行替换（B7）。
import { computeRadialLayout } from "../lib/character-relations.js";

export default function RelationMap({ focus, relations }) {
	const layout = computeRadialLayout(focus, relations);
	const byId = new Map(layout.nodes.map((node) => [node.id, node]));
	const edges = (relations || []).map((relation, index) => {
		const a = byId.get(Number(relation.endpoint_a.id));
		const b = byId.get(Number(relation.endpoint_b.id));
		if (!a || !b) return null;
		const label =
			relation.relation_type.label_from_focus ||
			relation.relation_type.forward_label;
		const offset = ((index % 3) - 1) * 12;
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: 边按关系序号静态渲染（offset 依赖 index），无重排语义
			<g key={index} className={`relation-edge polarity-${relation.polarity}`}>
				<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
				<text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + offset}>
					{label}
				</text>
			</g>
		);
	});
	const nodes = layout.nodes.map((node) => (
		<g
			key={node.id}
			className={`relation-node${node.focus ? " focus" : ""}`}
			transform={`translate(${node.x},${node.y})`}
		>
			<circle r={node.focus ? 35 : 27} />
			<text textAnchor="middle" dy="4">
				{node.name}
			</text>
		</g>
	));
	return (
		<svg
			className="relation-map"
			viewBox={`0 0 ${layout.width} ${layout.height}`}
			role="img"
			aria-label="人物关系图"
		>
			{edges}
			{nodes}
		</svg>
	);
}
