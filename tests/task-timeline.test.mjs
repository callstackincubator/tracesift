import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree } from '../src/lib/call-tree.ts';
import { buildTaskTimeline } from '../src/lib/task-timeline.ts';

const node = (id, name, children = [], url = 'app/screen.js') => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: 0, columnNumber: 0 },
});

const profile = (nodes, samples) => ({
  nodes, samples, timeDeltas: samples.map(() => 1000), startTime: 0, endTime: samples.length * 1000,
});

/** Everything named in `app` is the product's; anything else is framework. */
const classes = (app) => ({
  classOf: (frame) => (app.has(frame.functionName) ? 'app' : 'framework'),
  degraded: false, resolvedByModel: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
});

const timelineOf = (nodes, samples, app) => timelineWith(nodes, samples, classes(new Set(app)));

/** The same, against a class table the case supplies frame by frame. */
const timelineWith = (nodes, samples, table) => {
  const raw = profile(nodes, samples);
  const tree = buildCallTree(raw, samples.length, { trackSamples: true });
  return buildTaskTimeline(tree.sampleNodes, samples.map(() => 1), table, samples.length);
};

/** A table reading its answers off a name → class map, defaulting to framework. */
const tableOf = (byName) => ({
  classOf: (frame) => byName[frame.functionName] ?? 'framework',
  degraded: false, resolvedByModel: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
});

test('a frame called twice is two boxes at the positions it ran', () => {
  // render, something else, render again. The merged call tree draws that as
  // one wide box because it has no horizontal axis; this view has one, and the
  // whole point of it is that the two calls are visibly apart.
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'Screen', [2, 3]),
    node(2, 'render', []), node(3, 'other', []),
  ];
  const timeline = timelineOf(nodes, [2, 2, 3, 3, 2], ['Screen', 'render', 'other']);
  const renders = timeline.boxes.filter((box) => box.name === 'render');
  assert.deepEqual(renders.map((box) => [box.startMs, box.durationMs]), [[0, 2], [4, 1]]);
  // Its parent never left the stack, so it is one box spanning the lot.
  const screen = timeline.boxes.filter((box) => box.name === 'Screen');
  assert.deepEqual(screen.map((box) => [box.startMs, box.durationMs]), [[0, 5]]);
});

test('framework frames are collapsed away and the app frame under them rises to the top row', () => {
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'performWorkOnRoot', [2]),
    node(2, 'beginWork', [3]), node(3, 'Search_Search', []),
  ];
  const timeline = timelineOf(nodes, [3, 3, 3], ['Search_Search']);
  assert.deepEqual(timeline.boxes.map((box) => [box.name, box.depth]), [['Search_Search', 0]]);
  assert.equal(timeline.rows, 1);
});

test('time with no application frame on the stack is left uncovered rather than filled in', () => {
  // A gap in this chart means the product was not on the stack, which is a
  // finding. Charging that time to a neighbouring box would hide it.
  const nodes = [
    node(0, '(root)', [1, 2], ''), node(1, 'Screen', []), node(2, 'scheduler', []),
  ];
  const timeline = timelineOf(nodes, [1, 2, 2, 1], ['Screen']);
  assert.equal(timeline.durationMs, 4);
  assert.equal(timeline.coveredMs, 2);
  assert.deepEqual(timeline.boxes.map((box) => [box.startMs, box.durationMs]), [[0, 1], [3, 1]]);
});

test('one application frame re-entered through two framework paths is one call', () => {
  // Collapsing is what makes the chart readable, so it has to be honest about
  // what it merged: the reconciler re-entering the same component between two
  // consecutive samples is not the component being called twice.
  const nodes = [
    node(0, '(root)', [1, 2], ''),
    node(1, 'beginWork', [3]), node(2, 'commitWork', [4]),
    node(3, 'Row', []), node(4, 'Row', []),
  ];
  const timeline = timelineOf(nodes, [3, 4, 3], ['Row']);
  assert.deepEqual(timeline.boxes.map((box) => [box.name, box.startMs, box.durationMs]), [['Row', 0, 3]]);
});

test('a collection pause does not split the call it interrupted, and its time stays inside it', () => {
  const nodes = [
    node(0, '(root)', [1, 2], ''), node(1, 'Screen', []), node(2, '(garbage collector)', [], ''),
  ];
  const timeline = timelineOf(nodes, [1, 2, 1], ['Screen']);
  assert.deepEqual(timeline.boxes.map((box) => [box.startMs, box.durationMs]), [[0, 3]]);
  // The pause is wall time this call spent, so the box covers it; it is not
  // credited as the frame's own work.
  assert.equal(timeline.boxes[0].selfMs, 2);
});

test('the chart carries the frames a reader clicks through to the tree', () => {
  const nodes = [node(0, '(root)', [1], ''), node(1, 'Screen', [2]), node(2, 'render', [])];
  const timeline = timelineOf(nodes, [2, 2], ['Screen', 'render']);
  assert.deepEqual(timeline.boxes.map((box) => box.nodeId), ['0.0', '0.0.0']);
  assert.deepEqual(timeline.kept, ['app', 'library', 'anonymous']);
});

test('a dependency is drawn beside the product, and only React is collapsed outright', () => {
  // The chart cannot rely on telling the two apart. In a bundled build most of
  // the product's own frames come back `library`, so keeping `app` alone drew
  // an empty chart over a task that was entirely the reader's own work.
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'beginWork', [2]),
    node(2, 'Search_Search', [3]), node(3, 'applyMerge', [4]),
    node(4, 'toLocaleString', []),
  ];
  const timeline = timelineWith(nodes, [4, 4, 4], tableOf({
    Search_Search: 'app', applyMerge: 'library', toLocaleString: 'native',
  }));
  // The built-in stays on the chart under the call that made it. It is engine
  // code and a reader cannot rewrite it, but `toLocaleString` is the whole
  // finding here — collapsed, this read `applyMerge, 3 ms of its own`, which
  // names nothing to change.
  assert.deepEqual(
    timeline.boxes.map((box) => [box.name, box.depth]),
    [['Search_Search', 0], ['applyMerge', 1], ['toLocaleString', 2]]
  );
  assert.equal(timeline.coveredMs, 3);
  // Self time follows the box: the built-in burned it, not its caller.
  const byName = Object.fromEntries(timeline.boxes.map((box) => [box.name, box.selfMs]));
  assert.deepEqual(byName, { Search_Search: 0, applyMerge: 0, toLocaleString: 3 });
});

test('an engine frame that names nothing is still collapsed away', () => {
  // The exception above is the name, not the class: `(program)` and an unnamed
  // built-in describe the engine's own state, so they say no more on a chart
  // than the gap they would leave.
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'Search_Search', [2, 3]),
    node(2, '(program)', [], ''), node(3, 't', [], ''),
  ];
  const timeline = timelineWith(nodes, [2, 2, 3, 3], tableOf({
    Search_Search: 'app', '(program)': 'native', t: 'native',
  }));
  assert.deepEqual(
    timeline.boxes.map((box) => [box.name, box.depth]),
    [['Search_Search', 0]]
  );
  // Their time is charged to the frame that delegated into them, as before.
  assert.equal(timeline.boxes[0].selfMs, 4);
});

test("V8's call wrappers keep their place rather than breaking the nesting under them", () => {
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'Function call', [2], ''),
    node(2, 'onPress', []),
  ];
  const timeline = timelineWith(nodes, [2, 2], tableOf({ 'Function call': 'anonymous', onPress: 'app' }));
  assert.deepEqual(
    timeline.boxes.map((box) => [box.name, box.depth]),
    [['Function call', 0], ['onPress', 1]]
  );
});
