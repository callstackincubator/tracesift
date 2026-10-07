import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundaryDrillSlices, taskBreakdownSlices, squarify, CHART_SLICES } from '../src/lib/contribution.ts';

const culprit = (name, selfMs, totalMs = selfMs) => ({
  name, selfMs, totalMs, frameClass: 'app', invocations: 1, longestCallMs: totalMs,
  shapeText: 'ran once inside this frame', nodeId: `culprit-${name}`, callers: [],
});

const boundary = (name, totalMs, culprits = []) => ({
  name, totalMs, selfMs: 0, nodeId: `boundary-${name}`, invocations: 1, longestCallMs: totalMs,
  shapeText: 'ran once in this task', culprits,
});

const card = (durationMs, boundaryFrames, rest = {}) => ({
  durationMs,
  boundaryFrames,
  boundaryTailCount: 0,
  boundaryTailMs: 0,
  outsideBoundariesMs: 0,
  tree: { id: 'root' },
  ...rest,
});

const shareSum = (slices) => slices.reduce((sum, slice) => sum + slice.share, 0);

test('the task divides into its features, the tail, and what never entered your code', () => {
  const slices = taskBreakdownSlices(card(
    1000,
    [boundary('Search_Search', 500), boundary('flushRecompute', 200)],
    { boundaryTailCount: 12, boundaryTailMs: 180, outsideBoundariesMs: 120 },
  ));

  assert.deepEqual(slices.map((slice) => slice.kind), ['boundary', 'boundary', 'tail', 'outside']);
  assert.deepEqual(slices.map((slice) => slice.name), [
    'Search_Search', 'flushRecompute', '12 smaller entry points', 'never entered your code',
  ]);
  assert.deepEqual(slices.map((slice) => slice.ms), [500, 200, 180, 120]);
  assert.ok(Math.abs(shareSum(slices) - 1) < 1e-9, `shares summed to ${shareSum(slices)}`);
  // Only the frames take a palette slot; the residuals are not series.
  assert.deepEqual(slices.map((slice) => slice.colorIndex), [0, 1, -1, -1]);
});

test('a task fully covered by one feature gets neither residual', () => {
  const slices = taskBreakdownSlices(card(655, [boundary('_onChange', 655)]));
  assert.deepEqual(slices.map((slice) => slice.kind), ['boundary']);
  assert.equal(slices[0].share, 1);
});

test('a feature too thin to draw joins the tail it would otherwise hide behind', () => {
  const slices = taskBreakdownSlices(card(
    10000,
    [boundary('big', 5000), boundary('sliver', 2), boundary('small', 2000)],
    { boundaryTailCount: 4, boundaryTailMs: 1000 },
  ));

  assert.deepEqual(slices.map((slice) => slice.name), ['big', 'small', '5 smaller entry points']);
  // `small` keeps slot 2 — the slot it holds in the ranking — rather than
  // sliding into the one the folded sliver vacated.
  assert.deepEqual(slices.map((slice) => slice.colorIndex), [0, 2, -1]);
  // The folded 2 ms is counted once, in the tail, and not twice.
  assert.equal(slices.at(-1).ms, 1002);
});

test('the tail is a count as well as a total, so the strip can say how many', () => {
  const [tail] = taskBreakdownSlices(card(1000, [], { boundaryTailCount: 1, boundaryTailMs: 900 }));
  assert.equal(tail.name, '1 smaller entry point');
  assert.equal(tail.tailCount, 1);
});

test('a task of zero measured duration has nothing to divide', () => {
  assert.deepEqual(taskBreakdownSlices(card(0, [boundary('x', 5)])), []);
});

test('opening a feature divides its own time, not the task', () => {
  const frame = boundary('Search_Search', 500, [culprit('getReportSections', 193, 473), culprit('isScanning', 140)]);
  const slices = boundaryDrillSlices(frame);

  assert.deepEqual(slices.map((slice) => slice.kind), ['culprit', 'culprit', 'rest']);
  // 193 of the frame's 500 ms, not of the task's.
  assert.ok(Math.abs(slices[0].share - 193 / 500) < 1e-9);
  assert.equal(slices.at(-1).ms, 167);
  assert.ok(Math.abs(shareSum(slices) - 1) < 1e-9, `shares summed to ${shareSum(slices)}`);
});

test('a feature whose culprits account for all of it gets no residual', () => {
  const slices = boundaryDrillSlices(boundary('f', 100, [culprit('a', 60), culprit('b', 40)]));
  assert.deepEqual(slices.map((slice) => slice.kind), ['culprit', 'culprit']);
});

test('a feature with nothing inside it big enough to draw is all residual', () => {
  const slices = boundaryDrillSlices(boundary('f', 100, []));
  assert.deepEqual(slices.map((slice) => slice.kind), ['rest']);
  assert.equal(slices[0].ms, 100);
});

test('the chart ships at most one slot per palette colour', () => {
  const many = Array.from({ length: CHART_SLICES + 4 }, (_, index) => boundary(`f${index}`, 50));
  const slices = taskBreakdownSlices(card(1000, many));
  assert.ok(slices.every((slice) => slice.colorIndex < CHART_SLICES));
});

const area = (rect) => rect.w * rect.h;

const overlaps = (a, b) =>
  a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

test('treemap tiles are area-proportional, in bounds and non-overlapping', () => {
  const values = [500, 220, 190, 60, 18, 7, 5];
  const aspect = 0.42;
  const rects = squarify(values, aspect);
  const total = values.reduce((sum, value) => sum + value, 0);

  for (const [index, rect] of rects.entries()) {
    const expected = values[index] / total;
    assert.ok(Math.abs(area(rect) - expected) < 1e-6, `tile ${index} covered ${area(rect)}, wanted ${expected}`);
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9, `tile ${index} started outside the container`);
    assert.ok(rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9, `tile ${index} ran past the container`);
  }

  const filled = rects.reduce((sum, rect) => sum + area(rect), 0);
  assert.ok(Math.abs(filled - 1) < 1e-6, `tiles covered ${filled} of the container`);

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlaps(rects[i], rects[j]), `tiles ${i} and ${j} overlap`);
    }
  }
});

test('treemap tiles stay roughly square rather than becoming slivers', () => {
  const rects = squarify([500, 220, 190, 60, 18, 7, 5], 0.42);
  // Slice-and-dice on the same values puts the 5 in a tile 100x narrower than
  // it is tall; squarified, nothing should be worse than a 6:1 strip.
  for (const [index, rect] of rects.entries()) {
    const ratio = Math.max(rect.w / rect.h, rect.h / rect.w);
    assert.ok(ratio < 6, `tile ${index} came out ${ratio.toFixed(1)}:1`);
  }
});

test('one value fills the container', () => {
  const [only] = squarify([42], 0.5);
  assert.deepEqual(only, { x: 0, y: 0, w: 1, h: 1 });
});

test('nothing to lay out is not a crash', () => {
  assert.deepEqual(squarify([], 0.5), []);
  assert.deepEqual(squarify([0, 0], 0.5), [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }]);
});
