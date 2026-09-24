const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRadialLayout } = require('../public/character-relations');

function relation(focus, other) {
  return { endpoint_a: focus, endpoint_b: other };
}

test('character relation layout is deterministic, centered and collision-free for a large roster', () => {
  const focus = { id: 1, name: '中心人物' };
  const relations = Array.from({ length: 18 }, (_, index) => relation(focus, {
    id: index + 2,
    name: `人物${index + 2}`,
  })).reverse();
  const first = computeRadialLayout(focus, relations, 760, 460);
  const second = computeRadialLayout(focus, [...relations].reverse(), 760, 460);

  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes[0], { id: 1, name: '中心人物', x: 380, y: 230, focus: true });
  assert.equal(new Set(first.nodes.map(node => `${node.x.toFixed(3)},${node.y.toFixed(3)}`)).size, 19);
});

test('multiple relation dimensions share one satellite node', () => {
  const focus = { id: 1, name: '甲' };
  const other = { id: 2, name: '乙' };
  const layout = computeRadialLayout(focus, [relation(focus, other), relation(focus, other)]);
  assert.equal(layout.nodes.length, 2);
});
