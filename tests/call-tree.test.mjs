import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree, postOrder, preOrder, sampleWeightsMs } from '../src/lib/call-tree.ts';
import { groupBottlenecks } from '../src/lib/bottlenecks.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});
const profile = (nodes, samples, timeDeltas) => ({ nodes, samples, timeDeltas, startTime: 0, endTime: 100000 });
const find = (tree, name) => preOrder(tree.root).find((entry) => entry.frame.functionName === name);

test('total time is self plus the children, at every node', () => {
  const tree = buildCallTree(profile([
    node(0, '(root)', [1], ''), node(1, 'load', [2, 3]),
    node(2, 'parse'), node(3, 'render', [4]), node(4, 'paint'),
  ], [1, 2, 2, 3, 4, 4, 4]), 700);
  for (const entry of postOrder(tree.root)) {
    const expected = entry.selfMs + entry.children.reduce((sum, child) => sum + child.totalMs, 0);
    assert.ok(Math.abs(entry.totalMs - expected) < 1e-9, `${entry.frame.functionName} total mismatch`);
  }
  assert.equal(find(tree, 'load').totalMs, 700);
  assert.equal(find(tree, 'load').selfMs, 100);
  assert.equal(find(tree, 'render').totalMs, 400);
  assert.equal(find(tree, 'paint').selfMs, 300);
});

test('recursion stays distinct nodes, so inclusive time is never double counted', () => {
  // walk -> visit -> walk: the inner `walk` is its own node at its own depth.
  const tree = buildCallTree(profile([
    node(0, '(root)', [1], ''), node(1, 'walk', [2]), node(2, 'visit', [3]),
    node(3, 'walk', [4]), node(4, 'visit'),
  ], [1, 2, 3, 4]), 400);
  const outer = find(tree, 'walk');
  assert.equal(outer.totalMs, 400);
  const inner = outer.children[0].children[0];
  assert.equal(inner.frame.functionName, 'walk');
  assert.equal(inner.totalMs, 200);
  assert.notEqual(inner, outer);
});

test('siblings sharing a frame identity merge, which is what Hermes needs', () => {
  // One node per invocation, the shape `extractFromDurationTrace` produces.
  const tree = buildCallTree(profile([
    node(0, '(root)', [1, 2, 3], ''), node(1, 'format'), node(2, 'format'), node(3, 'format'),
  ], [1, 2, 3]), 300, { callCountIsExact: true });
  const format = find(tree, 'format');
  assert.equal(tree.root.children.length, 1);
  assert.equal(format.callCount, 3);
  assert.equal(format.totalMs, 300);
  assert.equal(tree.callCountIsExact, true);
});

test('the same name at a different source position is a different function', () => {
  const tree = buildCallTree(profile([
    node(0, '(root)', [1, 2], ''), node(1, 'format', [], 'a.js', 4), node(2, 'format', [], 'b.js', 9),
  ], [1, 2]), 200);
  assert.equal(tree.root.children.length, 2);
});

test('idle time is excluded from the tree and reported separately', () => {
  const tree = buildCallTree(profile([
    node(0, '(root)', [1, 2], ''), node(1, 'work'), node(2, '(idle)', [], ''),
  ], [1, 2, 2]), 300);
  assert.equal(tree.idleMs, 200);
  assert.equal(find(tree, '(idle)'), undefined);
  assert.equal(tree.root.totalMs, 100);
});

test('garbage collection stays in the tree under the frame that triggered it', () => {
  const tree = buildCallTree(profile([
    node(0, '(root)', [1], ''), node(1, 'allocate', [2]), node(2, '(garbage collector)', [], ''),
  ], [1, 2, 2]), 300);
  const allocate = find(tree, 'allocate');
  assert.equal(allocate.totalMs, 300);
  assert.equal(allocate.children[0].frame.functionName, '(garbage collector)');
  assert.equal(allocate.children[0].totalMs, 200);
});

test('a cycle in the parent links is broken rather than hanging the build', () => {
  const nodes = [node(0, '(root)', [1], ''), node(1, 'a', [2]), node(2, 'b', [1])];
  const tree = buildCallTree(profile(nodes, [2]), 100);
  assert.ok(preOrder(tree.root).length > 1);
});

test('sample weights match the engine the cards are replacing', () => {
  const nodes = [node(0, '(root)', [1], ''), node(1, 'work', [2]), node(2, 'inner')];
  const raw = profile(nodes, [2, 2, 1], [1000, 3000, 1000]);
  const tree = buildCallTree(raw, 250);
  const [legacy] = groupBottlenecks(raw, 250);
  assert.equal(Math.round(sampleWeightsMs(raw, 250).reduce((a, b) => a + b, 0)), 250);
  assert.equal(Math.round(tree.root.totalMs), Math.round(legacy.combinedTimeMs));
});

test('children are ordered heaviest first and ids follow that order', () => {
  const tree = buildCallTree(profile([
    node(0, '(root)', [1, 2], ''), node(1, 'light'), node(2, 'heavy'),
  ], [1, 2, 2, 2]), 400);
  assert.deepEqual(tree.root.children.map((child) => [child.frame.functionName, child.id]), [['heavy', '0.0'], ['light', '0.1']]);
});

test('an empty profile produces an empty tree instead of throwing', () => {
  const tree = buildCallTree(profile([node(0, '(root)', [], '')], []), 0);
  assert.equal(tree.sampleCount, 0);
  assert.equal(tree.root.totalMs, 0);
});
