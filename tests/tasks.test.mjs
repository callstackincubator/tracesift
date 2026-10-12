import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree, preOrder } from '../src/lib/call-tree.ts';
import { attachMeasuredTasks, attachProfilerOverhead, extractTasks, invocationShapes, profilerOverheadIntervals, runTaskIntervals, taskProfile } from '../src/lib/tasks.ts';
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

test('a negative time delta does not push every later task off the clock', () => {
  // V8's sampler clock steps backwards now and then: a real 13 s Chrome trace
  // carries 535 negative deltas summing to -69 ms. Clamping each to zero left
  // the reconstructed clock ahead of the real one by their total for the rest
  // of the recording, so a later task's window was cut around 64 ms early — it
  // took the tail of the task before it and lost its own.
  const deltas = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  deltas[2] = -1000; // sample 2 lands back on sample 1's timestamp
  deltas[3] = 2000; // and the clock makes it up on the next one
  const raw = attachMeasuredTasks(
    { ...profile(nodes, [1, 2, 3, 1, 2, 3, 1, 2]), timeDeltas: deltas },
    // Samples sit at 2000, 3000, 3000, 4000, 5000, 6000, 7000, 8000 µs.
    [{ ts: 2000, dur: 3000 }, { ts: 5000, dur: 4000 }],
  );
  const { tasks } = extractTasks(raw);
  assert.deepEqual(tasks.map((task) => [task.firstSample, task.endSample]), [[0, 4], [4, 8]]);
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

test('a RunTask still running when the trace stopped is recovered, not dropped', () => {
  // Chrome flushes a finished task as `X` with a duration and a task still on
  // the stack as a bare `B`. The local 16.7 s trace ends inside one: the
  // renderer's last RunTask opens at 11.4 s and never closes, and dropping it
  // left 5.2 s of application work — a third of the samples — in no task.
  const byThread = runTaskIntervals([
    { name: 'RunTask', ph: 'X', ts: 1000, dur: 1000, pid: 1, tid: 1 },
    { name: 'RunTask', ph: 'B', ts: 2000, pid: 1, tid: 1 },
    // Any later event on the thread bounds the open task, not just a RunTask.
    { name: 'FunctionCall', ph: 'X', ts: 7000, dur: 500, pid: 1, tid: 1 },
  ]);
  assert.deepEqual(byThread.get('1:1'), [
    { ts: 1000, dur: 1000 },
    { ts: 2000, dur: 5000, truncated: true },
  ]);
});

test('an open RunTask with nothing after it on its thread is left alone', () => {
  // There is no evidence of how long it ran, and a zero-length task is noise.
  const byThread = runTaskIntervals([{ name: 'RunTask', ph: 'B', ts: 2000, pid: 1, tid: 1 }]);
  assert.equal(byThread.get('1:1'), undefined);
});

test('a truncated task keeps its measured start but not the claim on its duration', () => {
  const raw = attachMeasuredTasks(profile(nodes, [1, 2, 3, 1, 2]), [
    { ts: 2000, dur: 2000 },
    { ts: 4000, dur: 3000, truncated: true },
  ]);
  const { tasks, boundaries } = extractTasks(raw);
  // The set still counts as measured: the tracer did supply real boundaries.
  assert.equal(boundaries, 'measured');
  assert.deepEqual(tasks.map((task) => task.boundaries), ['measured', 'inferred']);
});

test('samples the tracer stopped covering become an inferred task rather than vanishing', () => {
  // Eight samples, one measured task over the first three. Before this the
  // remaining five were read by nothing at all: every card is built from a
  // task, so a function's time was reported as whatever part of it happened to
  // land inside a measured window.
  const raw = attachMeasuredTasks(profile(nodes, [1, 2, 3, 1, 2, 3, 1, 2]), [{ ts: 2000, dur: 3000 }]);
  const { tasks } = extractTasks(raw);
  assert.deepEqual(tasks.map((task) => [task.boundaries, task.firstSample, task.endSample]), [
    ['measured', 0, 3],
    ['inferred', 3, 8],
  ]);
  // Indices are reassigned in time order, so `task-N` still addresses the Nth
  // block of the recording.
  assert.deepEqual(tasks.map((task) => task.index), [0, 1]);
});

test('a gap between two measured tasks is recovered, and idle inside it still splits', () => {
  const raw = attachMeasuredTasks(profile(nodes, [1, 1, 4, 1, 1, 1]), [
    { ts: 2000, dur: 1000 },
    { ts: 7000, dur: 1000 },
  ]);
  const { tasks } = extractTasks(raw);
  // Samples sit at 2000…7000 µs: task one takes sample 0, task two sample 5,
  // and samples 1–4 are the gap. Sample 2 is `(idle)`, so the gap yields one
  // run — samples 3–4 — because a single sample spans no time.
  assert.deepEqual(tasks.map((task) => [task.boundaries, task.firstSample, task.endSample]), [
    ['measured', 0, 1],
    ['inferred', 3, 5],
    ['measured', 5, 6],
  ]);
});

test('a sample landing between two measured tasks is a seam, not a task', () => {
  // The tracer's own boundaries leave microseconds unclaimed and samples fall
  // into them: the local trace has 203 such runs. Each spans no time, and
  // admitting them would bury the real gaps under zero-millisecond cards.
  // Samples sit at 2000, 3000, 4000, 5000 µs. The first task ends at 2500 and
  // the second opens at 4000, so the sample at 3000 belongs to neither.
  const raw = attachMeasuredTasks(profile(nodes, [1, 2, 3, 1]), [
    { ts: 2000, dur: 500 },
    { ts: 4000, dur: 2000 },
  ]);
  const { tasks } = extractTasks(raw);
  assert.deepEqual(tasks.map((task) => [task.boundaries, task.firstSample, task.endSample]), [
    ['measured', 0, 1],
    ['measured', 2, 4],
  ]);
});


test('the profiler starting itself is read off the trace, per thread', () => {
  const byThread = profilerOverheadIntervals([
    { name: 'CpuProfiler::StartProfiling', ph: 'X', ts: 1000, dur: 2000, pid: 1, tid: 1 },
    { name: 'CpuProfiler::StopProfiling', ph: 'X', ts: 9000, dur: 500, pid: 1, tid: 1 },
    { name: 'CpuProfiler::StartProfiling', ph: 'X', ts: 1000, dur: 7000, pid: 1, tid: 2 },
    // No duration to bill, so nothing to exclude.
    { name: 'CpuProfiler::StartProfiling', ph: 'X', ts: 1000, pid: 1, tid: 3 },
    { name: 'RunTask', ph: 'X', ts: 1000, dur: 2000, pid: 1, tid: 1 },
  ]);
  assert.deepEqual(byThread.get('1:1'), [{ ts: 1000, dur: 2000 }, { ts: 9000, dur: 500 }]);
  assert.deepEqual(byThread.get('1:2'), [{ ts: 1000, dur: 7000 }]);
  assert.equal(byThread.get('1:3'), undefined);
});

test('a task that was mostly the profiler starting up is marked as the tracer\'s own', () => {
  // Switching a CPU profiler on stops the world, and V8 bills the pause to
  // whichever task was running. On the local trace that is a 2908 ms block
  // holding 6 ms of real JS — the recording's third largest, and entirely an
  // artefact of measuring it.
  const raw = attachProfilerOverhead(
    attachMeasuredTasks(profile(nodes, [1, 2, 3, 1, 2, 3], 1000), [
      { ts: 2000, dur: 3000 },
      { ts: 5000, dur: 3000 },
    ]),
    [{ ts: 2000, dur: 2900 }],
  );
  const { tasks } = extractTasks(raw);
  assert.deepEqual(tasks.map((task) => Boolean(task.overhead)), [true, false]);
});

test('a task the profiler only clipped is still the app\'s work', () => {
  // The pause has to be most of the block before the block stops being about
  // the app: a task that merely overlaps one still ran the reader's code.
  const raw = attachProfilerOverhead(
    attachMeasuredTasks(profile(nodes, [1, 2, 3, 1, 2, 3], 1000), [{ ts: 2000, dur: 6000 }]),
    [{ ts: 2000, dur: 1000 }],
  );
  const { tasks } = extractTasks(raw);
  assert.deepEqual(tasks.map((task) => Boolean(task.overhead)), [false]);
});

test('a trace that never names the profiler leaves every task alone', () => {
  const raw = attachMeasuredTasks(profile(nodes, [1, 2, 3], 1000), [{ ts: 2000, dur: 3000 }]);
  assert.deepEqual(extractTasks(raw).tasks.map((task) => task.overhead), [undefined]);
});
