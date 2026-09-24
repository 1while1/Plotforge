(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CharacterRelations = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function uniquePeople(focus, relations) {
    var map = new Map();
    (relations || []).forEach(function (relation) {
      var a = relation.endpoint_a;
      var b = relation.endpoint_b;
      var other = Number(a.id) === Number(focus.id) ? b : a;
      map.set(Number(other.id), { id: Number(other.id), name: other.name });
    });
    return Array.from(map.values()).sort(function (left, right) { return left.id - right.id; });
  }

  function computeRadialLayout(focus, relations, width, height) {
    width = width || 760;
    height = height || 460;
    var people = uniquePeople(focus, relations);
    var cx = width / 2;
    var cy = height / 2;
    var nodes = [{ id: Number(focus.id), name: focus.name, x: cx, y: cy, focus: true }];
    people.forEach(function (person, index) {
      var ring = Math.floor(index / 8);
      var position = index % 8;
      var count = Math.min(8, people.length - ring * 8);
      var angle = (-Math.PI / 2) + (Math.PI * 2 * position / count) + (ring % 2 ? Math.PI / 8 : 0);
      var radiusX = Math.min(width * .34, 230) + ring * 62;
      var radiusY = Math.min(height * .34, 145) + ring * 48;
      nodes.push({
        id: person.id,
        name: person.name,
        x: cx + Math.cos(angle) * radiusX,
        y: cy + Math.sin(angle) * radiusY,
        focus: false
      });
    });
    return { width: width, height: height, nodes: nodes };
  }

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char];
    });
  }

  function renderSVG(container, focus, relations) {
    var layout = computeRadialLayout(focus, relations);
    var byId = new Map(layout.nodes.map(function (node) { return [node.id, node]; }));
    var lines = (relations || []).map(function (relation, index) {
      var a = byId.get(Number(relation.endpoint_a.id));
      var b = byId.get(Number(relation.endpoint_b.id));
      if (!a || !b) return '';
      var label = relation.relation_type.label_from_focus || relation.relation_type.forward_label;
      var offset = ((index % 3) - 1) * 12;
      return '<g class="relation-edge polarity-' + escape(relation.polarity) + '">' +
        '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>' +
        '<text x="' + ((a.x + b.x) / 2) + '" y="' + (((a.y + b.y) / 2) + offset) + '">' + escape(label) + '</text></g>';
    }).join('');
    var nodes = layout.nodes.map(function (node) {
      return '<g class="relation-node' + (node.focus ? ' focus' : '') + '" transform="translate(' + node.x + ',' + node.y + ')">' +
        '<circle r="' + (node.focus ? 35 : 27) + '"></circle><text text-anchor="middle" dy="4">' + escape(node.name) + '</text></g>';
    }).join('');
    container.innerHTML = '<svg class="relation-map" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" role="img" aria-label="人物关系图">' + lines + nodes + '</svg>';
    return layout;
  }

  return { computeRadialLayout: computeRadialLayout, renderSVG: renderSVG };
});
