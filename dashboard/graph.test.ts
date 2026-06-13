import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from './graph.ts';

const n = (id: string, weight = 0.5) => ({ id, slug: id, type: 'note', title: id.toUpperCase(), emotional_weight: weight });

test('counts degree in both directions', () => {
  const g = buildGraph([n('a'), n('b'), n('c')], [
    { source: 'a', target: 'b', type: 'mentions' },
    { source: 'b', target: 'c', type: 'mentions' },
  ]);
  const deg = Object.fromEntries(g.nodes.map((x) => [x.id, x.degree]));
  assert.deepEqual(deg, { a: 1, b: 2, c: 1 });
  assert.equal(g.capped, false);
  assert.equal(g.total, 3);
});

test('orphan nodes get degree 0 and survive', () => {
  const g = buildGraph([n('a'), n('lonely')], [{ source: 'a', target: 'a', type: 'self' }]);
  assert.equal(g.nodes.find((x) => x.id === 'lonely')!.degree, 0);
  assert.equal(g.nodes.length, 2);
});

test('caps to top-N by weight and drops dangling links', () => {
  const nodes = [n('keep1', 0.9), n('keep2', 0.8), n('drop', 0.1)];
  const links = [
    { source: 'keep1', target: 'keep2', type: 'x' },
    { source: 'keep1', target: 'drop', type: 'x' },
  ];
  const g = buildGraph(nodes, links, 2);
  assert.equal(g.capped, true);
  assert.equal(g.total, 3);
  assert.deepEqual(g.nodes.map((x) => x.id).sort(), ['keep1', 'keep2']);
  assert.equal(g.links.length, 1);
});
