import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree, preOrder } from '../src/lib/call-tree.ts';
import { attachMeasuredTasks, extractTasks, invocationShapes, runTaskIntervals, taskProfile } from '../src/lib/tasks.ts';
import { extractFromDurationTrace } from '../src/lib/hermes-duration-profile.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

/** Samples one millisecond apart, starting one interval after `startTime`. */
const profile = (nodes, samples, startTime = 1000) => ({
  nodes, samples,
  timeDeltas: samples.map(() => 1000),
  startTime,
  endTime: startTime + samples.length * 1000,
});

const nodes = [
  node(0, '(root)', [1, 4], ''),
  node(1, 'handlePress', [2]), node(2, 'compute', [3]), node(3, 'helper'),
  node(4, '(idle)', [], ''),
];

test('measured boundaries are taken from the tracer, and samples land in the right task', () => {
  // Six samples at 2000, 3000 … 7000 µs. Two tasks of three samples each.
  const raw = attachMeasuredTasks(profile(nodes, [1, 2, 3, 1, 2, 3]), [
    { ts: 2000, dur: 3000 },
    { ts: 5000, dur: 3000 },
  ]);
  const { tasks, boundaries } = extractTasks(raw);
  assert.equal(boundaries, 'measured');
  assert.deepEqual(tasks.map((task) => [task.startMs, task.durationMs]), [[1, 3], [4, 3]]);
  assert.deepEqual(tasks.map((task) => [task.firstSample, task.endSample]), [[0, 3], [3, 6]]);
});

test('a measured task that caught no sample is dropped rather than reported empty', () => {
  const raw = attachMeasuredTasks(profile(nodes, [1, 2]), [
    { ts: 2000, dur: 2000 },
    { ts: 90000, dur: 5000 },
  ]);
  assert.equal(extractTasks(raw).tasks.length, 1);
});

test('a trace with no RunTask falls back to idle gaps and says the boundaries are inferred', () => {
  const raw = profile(nodes, [1, 2, 4, 4, 3, 3]);
  const { tasks, boundaries } = extractTasks(raw);
  assert.equal(boundaries, 'inferred');
  assert.deepEqual(tasks.map((task) => [task.firstSample, task.endSample]), [[0, 2], [4, 6]]);
  // Never presented as measured: an idle gap is evidence the loop went quiet,
  // not a record of where the runtime drew a boundary.
  assert.notEqual(boundaries, 'measured');
});

test('one contiguous run of samples under a frame is one invocation', () => {
  const raw = profile(nodes, [3, 3, 3, 3]);
  const [task] = extractTasks(raw).tasks;
  const tree = buildCallTree(taskProfile(raw, task), task.durationMs, { trackSamples: true });
  const weights = tree.sampleNodes.map(() => task.durationMs / tree.sampleNodes.length);
  const shapes = invocationShapes(tree.sampleNodes, weights, (entry) => entry);
  const helper = preOrder(tree.root).find((entry) => entry.frame.functionName === 'helper');
  assert.equal(shapes.get(helper).invocations, 1);
  assert.equal(shapes.get(helper).longestCallMs, task.durationMs);
});

test('a frame re-entered after a sibling ran counts as two invocations', () => {
  // helper, then a sibling, then helper again: one block of work the frame left
  // and came back to, which is two calls however the inclusive total reads.
  const forked = [
    node(0, '(root)', [1], ''), node(1, 'compute', [2, 3]),
    node(2, 'helper', [], 'h.js'), node(3, 'other', [], 'o.js'),
  ];
  const raw = profile(forked, [2, 2, 3, 2]);
  const [task] = extractTasks(raw).tasks;
  const tree = buildCallTree(taskProfile(raw, task), 4, { trackSamples: true });
  const shapes = invocationShapes(tree.sampleNodes, tree.sampleNodes.map(() => 1), (entry) => entry);
  const byName = (name) => preOrder(tree.root).find((entry) => entry.frame.functionName === name);
  assert.deepEqual(
    [shapes.get(byName('helper')).invocations, shapes.get(byName('helper')).longestCallMs],
    [2, 2],
  );
  // The parent never left the stack, so it ran once however often its callees did.
  assert.equal(shapes.get(byName('compute')).invocations, 1);
});

test('a garbage collection pause does not end the call it interrupted', () => {
  // V8 parks `(garbage collector)` at the root rather than under the frame that
  // allocated, so it looks exactly like the whole JS stack returning. Counting
  // it as one would report a single render that collected twice as three calls
  // of a third the length — the opposite of the finding the row exists to make.
  const collected = [
    node(0, '(root)', [1, 3], ''), node(1, 'compute', [2]), node(2, 'helper', [], 'h.js'),
    node(3, '(garbage collector)', [], ''),
  ];
  const raw = profile(collected, [2, 3, 2, 3, 2]);
  const [task] = extractTasks(raw).tasks;
  const tree = buildCallTree(taskProfile(raw, task), 5, { trackSamples: true });
  const shapes = invocationShapes(tree.sampleNodes, tree.sampleNodes.map(() => 1), (entry) => entry.key);
  const helper = preOrder(tree.root).find((entry) => entry.frame.functionName === 'helper');
  assert.equal(shapes.get(helper.key).invocations, 1);
  // The pause is carried over, not credited: these figures have to keep summing
  // to the totals the call tree reports for the same frame.
  assert.equal(shapes.get(helper.key).totalMs, 3);
});

test('RunTask is read in both spellings, and kept per thread', () => {
  // Only the thread the profile was selected from matters: every other thread
  // ran its own tasks against a clock these samples know nothing about.
  const byThread = runTaskIntervals([
    { name: 'RunTask', ph: 'X', ts: 1000, dur: 5000, pid: 1, tid: 1 },
    { name: 'RunTask', ph: 'B', ts: 9000, pid: 1, tid: 1 },
    { name: 'RunTask', ph: 'E', ts: 12_000, pid: 1, tid: 1 },
    { name: 'RunTask', ph: 'X', ts: 1000, dur: 900_000, pid: 1, tid: 2 },
    { name: 'ProfileChunk', ph: 'P', ts: 1000, pid: 1, tid: 1 },
  ]);
  assert.deepEqual(byThread.get('1:1'), [{ ts: 1000, dur: 5000 }, { ts: 9000, dur: 3000 }]);
  assert.deepEqual(byThread.get('1:2'), [{ ts: 1000, dur: 900_000 }]);
});

test('each top-level pair of a Hermes duration trace is already a task', () => {
  const event = (ts, ph, name) => ({ ts, ph, name, pid: 10, tid: 20, cat: 'JavaScript', args: { url: '/app.js', line: 1, column: 0 } });
  const hermes = extractFromDurationTrace([
    event(1000, 'B', 'handlePress'), event(2000, 'B', 'compute'),
    event(5000, 'E', 'compute'), event(6000, 'E', 'handlePress'),
    event(9000, 'B', 'onScroll'), event(11_000, 'E', 'onScroll'),
  ]);
  const { tasks, boundaries } = extractTasks(hermes);
  assert.equal(boundaries, 'measured');
  assert.deepEqual(tasks.map((task) => Math.round(task.durationMs)), [5, 2]);
});
