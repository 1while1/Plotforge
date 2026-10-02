// S5-10 转写（Plan §5.3；charter §2 豁免流程）：装载源由 `require('../public/legacy/character-relations')`
// 改为 data-URL import `frontend/lib/character-relations.js`（S3-2 逐字移植件），2 例标题与断言逐字保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'frontend/lib/character-relations.js');

function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

let modPromise = null;
function loadLib() {
  if (!modPromise) modPromise = import(dataUrl(fs.readFileSync(LIB, 'utf8')));
  return modPromise;
}

function relation(focus, other) {
  return { endpoint_a: focus, endpoint_b: other };
}

test('character relation layout is deterministic, centered and collision-free for a large roster', async () => {
  const { computeRadialLayout } = await loadLib();
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

test('multiple relation dimensions share one satellite node', async () => {
  const { computeRadialLayout } = await loadLib();
  const focus = { id: 1, name: '甲' };
  const other = { id: 2, name: '乙' };
  const layout = computeRadialLayout(focus, [relation(focus, other), relation(focus, other)]);
  assert.equal(layout.nodes.length, 2);
});
