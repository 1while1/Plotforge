// S3-2（charter §5）：人物关系图布局引擎——public/legacy/character-relations.js 的
// 逐字移植（uniquePeople/computeRadialLayout 纯函数，一个字节都不改逻辑：默认
// 760/460、每环 8 卫星、ring%2 相位偏移、radiusX/Y 的 min() clamp——冻结测试
// test/character-relations-layout.test.js 的语义所在）。
// 渲染层见 components/RelationMap.jsx（SVG JSX 镜像旧 renderSVG）；escape 不随迁
// （React 文本节点自动转义）。

export function uniquePeople(focus, relations) {
	const map = new Map();
	(relations || []).forEach((relation) => {
		const a = relation.endpoint_a;
		const b = relation.endpoint_b;
		const other = Number(a.id) === Number(focus.id) ? b : a;
		map.set(Number(other.id), { id: Number(other.id), name: other.name });
	});
	return Array.from(map.values()).sort((left, right) => left.id - right.id);
}

export function computeRadialLayout(focus, relations, width, height) {
	width = width || 760;
	height = height || 460;
	const people = uniquePeople(focus, relations);
	const cx = width / 2;
	const cy = height / 2;
	const nodes = [
		{ id: Number(focus.id), name: focus.name, x: cx, y: cy, focus: true },
	];
	people.forEach((person, index) => {
		const ring = Math.floor(index / 8);
		const position = index % 8;
		const count = Math.min(8, people.length - ring * 8);
		const angle =
			-Math.PI / 2 +
			(Math.PI * 2 * position) / count +
			(ring % 2 ? Math.PI / 8 : 0);
		const radiusX = Math.min(width * 0.34, 230) + ring * 62;
		const radiusY = Math.min(height * 0.34, 145) + ring * 48;
		nodes.push({
			id: person.id,
			name: person.name,
			x: cx + Math.cos(angle) * radiusX,
			y: cy + Math.sin(angle) * radiusY,
			focus: false,
		});
	});
	return { width, height, nodes };
}
